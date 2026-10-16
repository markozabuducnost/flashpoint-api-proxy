// flashpoint-api-proxy — VM edition.
//
// Same contract as the Cloudflare Worker (src/index.ts): two whitelisted routes, the
// x-flashpoint-client check, the secret API-Football key injected server-side, short-lived
// caching, and API-Football's HTTP-200-with-`errors` failures never cached. It exists because
// API-Football rate-limits/blocks by source IP and Cloudflare's egress IPs are shared with
// every other Workers customer calling it; this server runs on a VM with its own public IP.
//
// No npm dependencies: Node 22's built-in http + fetch only, so the VM installs nothing but
// Node itself. Listens on 127.0.0.1 only — Caddy terminates HTTPS in front of it.
//
// Differences from the Worker, both improvements a single long-lived process makes cheap:
//  - The cache is now global, not per Cloudflare PoP, and identical concurrent requests are
//    coalesced into one upstream call (every viewer of a match shares one /events poll).
//  - A per-IP rate limit replaces the Cloudflare dashboard rule the Worker never had, so a
//    client token pulled out of the app binary can't be used to burn the daily quota.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? "";
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM_BASE = process.env.UPSTREAM_BASE ?? "https://v3.football.api-sports.io";
// One device polls /events every ~15s and loads /fixtures a couple of times per launch, so
// 60/min per IP is ~15x normal use while still capping abuse from one address.
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 1_000;

if (!API_FOOTBALL_KEY || !CLIENT_TOKEN) {
  console.error("API_FOOTBALL_KEY and CLIENT_TOKEN must both be set");
  process.exit(1);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIXTURE_PATTERN = /^\d{1,12}$/;

// ---------------------------------------------------------------------------------------
// Auth: compare SHA-256 digests so timingSafeEqual always gets equal-length buffers and the
// comparison time doesn't depend on how much of the token an attacker guessed right.
const expectedTokenDigest = createHash("sha256").update(CLIENT_TOKEN).digest();
function isAuthorized(req) {
  const provided = req.headers["x-flashpoint-client"];
  if (typeof provided !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), expectedTokenDigest);
}

// ---------------------------------------------------------------------------------------
// Client IP. Caddy is the only thing that can reach us (we bind to 127.0.0.1) and it sets
// X-Forwarded-For, appending the real peer address last — so the LAST entry is the one a
// client can't spoof. Anything earlier in the header came from the client itself.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const parts = xff.split(",");
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

// Fixed one-minute window per IP. Simple and plenty for one small server.
const rateWindows = new Map(); // ip -> { start, count }
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateWindows.get(ip);
  if (!entry || now - entry.start >= 60_000) {
    rateWindows.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MIN;
}

// ---------------------------------------------------------------------------------------
// API-Football's `errors` field is `[]` on success but an object (or non-empty array) with
// keys like `rateLimit`/`token` when the request itself failed — still delivered as HTTP 200.
function hasUpstreamErrors(body) {
  try {
    const errors = JSON.parse(body).errors;
    if (Array.isArray(errors)) return errors.length > 0;
    if (errors && typeof errors === "object") return Object.keys(errors).length > 0;
    return false;
  } catch {
    return true;
  }
}

const cache = new Map(); // upstream URL -> { status, body, expires }
const inFlight = new Map(); // upstream URL -> Promise<{ status, body }>

async function fetchUpstream(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = await response.text();
    const failed = !response.ok || hasUpstreamErrors(body);
    // Never logs the key — only the path, outcome and timing.
    console.log(`upstream ${new URL(url).pathname}${new URL(url).search} -> ${response.status}${failed ? " (error)" : ""} ${Date.now() - started}ms`);
    return { status: response.status, body, failed };
  } catch (err) {
    console.error(`upstream ${new URL(url).pathname} failed: ${err?.name ?? "Error"}`);
    return {
      status: 502,
      body: JSON.stringify({ error: "upstream unavailable" }),
      failed: true,
    };
  }
}

async function forward(path, params, ttlSeconds) {
  const upstream = new URL(path, UPSTREAM_BASE);
  for (const [key, value] of Object.entries(params)) upstream.searchParams.set(key, value);
  const cacheKey = upstream.toString();

  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached;

  // Coalesce: if the same upstream call is already in flight, wait for it instead of
  // sending a duplicate. This is what keeps N viewers of one match at one call per TTL.
  let pending = inFlight.get(cacheKey);
  if (!pending) {
    pending = fetchUpstream(cacheKey).finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
  }
  const result = await pending;

  // Caching a rate-limit or bad-key response would serve that failure to every device for
  // the full TTL, so only clean successes are stored.
  if (!result.failed) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { status: result.status, body: result.body, expires: Date.now() + ttlSeconds * 1000 });
  }
  return result;
}

// Sweep expired cache entries and stale rate-limit windows once a minute.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  for (const [ip, entry] of rateWindows) if (now - entry.start >= 60_000) rateWindows.delete(ip);
}, 60_000).unref();

// ---------------------------------------------------------------------------------------
function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    // Live data: URLSession must never serve a stale response from a prior launch.
    "cache-control": "no-store",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Unauthenticated liveness check for the setup script and uptime monitors. Reveals nothing.
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

  if (isRateLimited(clientIp(req))) return send(res, 429, { error: "too many requests" });

  if (!isAuthorized(req)) return send(res, 401, { error: "unauthorized" });

  if (url.pathname === "/fixtures") {
    const date = url.searchParams.get("date");
    if (!date || !DATE_PATTERN.test(date)) return send(res, 400, { error: "date must be YYYY-MM-DD" });
    // Schedules for a given date barely change intraday — cache generously.
    const r = await forward("/fixtures", { date }, 300);
    return send(res, r.status, r.body);
  }

  if (url.pathname === "/events") {
    const fixture = url.searchParams.get("fixture");
    if (!fixture || !FIXTURE_PATTERN.test(fixture)) return send(res, 400, { error: "fixture must be a numeric id" });
    // Kept under the app's poll interval so goals aren't delayed by a stale cache entry,
    // while still collapsing every viewer of the same match into one upstream call.
    const r = await forward("/fixtures/events", { fixture }, 10);
    return send(res, r.status, r.body);
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("unhandled", err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => console.log(`flashpoint-api-proxy listening on ${HOST}:${PORT}`));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
