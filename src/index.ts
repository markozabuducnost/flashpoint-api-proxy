export interface Env {
  API_FOOTBALL_KEY: string;
  CLIENT_TOKEN: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// API-Football's `errors` field is `[]` on success but an object (or non-empty array) with
// keys like `rateLimit`/`token` when the request itself failed — still delivered as HTTP 200.
function hasUpstreamErrors(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    const errors = parsed.errors;
    if (Array.isArray(errors)) return errors.length > 0;
    if (errors && typeof errors === "object") return Object.keys(errors).length > 0;
    return false;
  } catch {
    return true;
  }
}

// Single-purpose proxy: forwards whitelisted upstream paths/queries verbatim and injects
// the secret key. No rate limiting (Workers' free tier has no cheap always-consistent
// counter — Durable Objects are a paid feature), no business logic — that lives in the
// app. If abuse becomes a real problem, add a Cloudflare dashboard Rate Limiting Rule
// rather than code here.
//
// Edge-cached per fixture/date via the Cache API: many devices watching the same match
// poll for events with identical params, so without this every poll became its own
// upstream call — cost scaled with concurrent viewers instead of concurrent matches. The
// cache is per data center, not global, so this coalesces viewers landing on the same PoP
// rather than guaranteeing one call worldwide; going further needs a Durable Object per
// fixture.
//
// Two different Cache-Control headers are in play: the stored (edge-cached) response
// carries max-age so the Cache API knows the TTL, while the response actually sent to the
// client stays no-store, since URLSession must never serve a stale response from a prior
// launch itself.
async function forward(
  path: string,
  params: Record<string, string>,
  env: Env,
  ctx: ExecutionContext,
  cacheTtlSeconds: number
): Promise<Response> {
  const upstream = new URL(`https://v3.football.api-sports.io${path}`);
  for (const [key, value] of Object.entries(params)) {
    upstream.searchParams.set(key, value);
  }

  const cache = caches.default;
  const cacheKey = new Request(upstream.toString(), { method: "GET" });

  const cached = await cache.match(cacheKey);

  let responseBody: string;
  let responseStatus: number;

  if (cached) {
    responseBody = await cached.text();
    responseStatus = cached.status;
  } else {
    const response = await fetch(upstream, { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } });
    responseBody = await response.text();
    responseStatus = response.status;

    // API-Football reports its own errors (rate limit, bad key, etc.) as HTTP 200 with a
    // non-empty `errors` field rather than a 4xx/5xx — `response.ok` alone doesn't catch
    // that. Caching one of these would serve the failure to every device hitting this PoP
    // for the full TTL instead of just the request that got rate-limited.
    if (response.ok && !hasUpstreamErrors(responseBody)) {
      const toCache = new Response(responseBody, {
        status: responseStatus,
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${cacheTtlSeconds}` },
      });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
  }

  // Fixtures/events are live data (scores, status, elapsed minute) — without an explicit
  // no-store, URLSession's default cache policy will happily serve a stale response from a
  // prior launch since there's no Cache-Control/ETag/Last-Modified telling it otherwise.
  return new Response(responseBody, {
    status: responseStatus,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("x-flashpoint-client") !== env.CLIENT_TOKEN) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (url.pathname === "/fixtures") {
      const date = url.searchParams.get("date");
      if (!date || !DATE_PATTERN.test(date)) {
        return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
      }
      // Schedules for a given date barely change intraday — cache generously.
      return forward("/fixtures", { date }, env, ctx, 300);
    }

    if (url.pathname === "/events") {
      const fixture = url.searchParams.get("fixture");
      if (!fixture || !/^\d+$/.test(fixture)) {
        return Response.json({ error: "fixture must be a numeric id" }, { status: 400 });
      }
      // Kept well under LiveEventPoller's 15s client poll interval: a TTL at or above the
      // interval would hand most polls the previous poll's data and add up to a full TTL of
      // latency to every goal. 10s still coalesces viewers of the same match on one PoP.
      return forward("/fixtures/events", { fixture }, env, ctx, 10);
    }

    return new Response("Not found", { status: 404 });
  },
};
