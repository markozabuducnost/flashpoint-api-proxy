# flashpoint-api-proxy

Minimal stateless proxy in front of API-Football, so the Flashpoint iOS app never embeds
an API-Football key. No accounts, no database, no clip/video data — it forwards one
whitelisted request and injects the secret. Runs on Cloudflare Workers (free tier: 100k
requests/day, no card required, no cold starts).

## Local development

```
npm install
cp .dev.vars.example .dev.vars   # fill in API_FOOTBALL_KEY and CLIENT_TOKEN
npm run dev
```

```
curl "http://localhost:8787/fixtures?date=2026-07-28" -H "x-flashpoint-client: <CLIENT_TOKEN>"
```

## Deploy (Cloudflare Workers)

```
npx wrangler login
npx wrangler secret put API_FOOTBALL_KEY
npx wrangler secret put CLIENT_TOKEN
npm run deploy
```

The deploy command prints your live `*.workers.dev` URL. Point the iOS app's
`BackendConfig.baseURL` at it.
