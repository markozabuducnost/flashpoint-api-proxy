# flashpoint-api-proxy

Minimal stateless proxy in front of API-Football, so the Flashpoint iOS app never embeds
an API-Football key. No accounts, no database, no clip/video data — it forwards one
whitelisted request and injects the secret.

## Local development

```
npm install
cp .env.example .env   # fill in API_FOOTBALL_KEY and CLIENT_TOKEN
npm run dev
```

```
curl "http://localhost:3000/fixtures?date=2026-07-28" -H "x-flashpoint-client: <CLIENT_TOKEN>"
```

## Deploy (Railway)

```
railway init
railway up
```

Then set `API_FOOTBALL_KEY` and `CLIENT_TOKEN` in the Railway dashboard's Variables tab
(`PORT` is provided automatically). Point the iOS app's `BackendConfig.baseURL` at the
resulting Railway URL.
