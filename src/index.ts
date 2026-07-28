export interface Env {
  API_FOOTBALL_KEY: string;
  CLIENT_TOKEN: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Dumb, single-purpose proxy: forwards one whitelisted upstream path/query verbatim
// and injects the secret key. No caching, no rate limiting (Workers' free tier has no
// cheap always-consistent counter — Durable Objects are a paid feature), no business
// logic — that lives in the app. If abuse becomes a real problem, add a Cloudflare
// dashboard Rate Limiting Rule rather than code here.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/fixtures") {
      return new Response("Not found", { status: 404 });
    }

    if (request.headers.get("x-flashpoint-client") !== env.CLIENT_TOKEN) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const date = url.searchParams.get("date");
    if (!date || !DATE_PATTERN.test(date)) {
      return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }

    const upstream = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(date)}`,
      { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } }
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  },
};
