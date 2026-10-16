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

## Deploy (VM with its own IP — current)

API-Football rate-limits and blocks by source IP, and Cloudflare Workers' outbound IPs are
shared with every other Workers customer calling it. Confirmed 2026-10-12: the same key
worked from a home IP while the Worker got `{"get":"","errors":{"rateLimit":…}}` with 0
requests used that day. So production runs `vps/server.mjs` (same routes, auth and caching,
plus a global cache, request coalescing and a per-IP rate limit) on a VM with its own IP.

```
scp vps/server.mjs vps/setup.sh ubuntu@<VM_IP>:~
ssh -t ubuntu@<VM_IP> 'sudo bash setup.sh'   # -t: the script prompts for secrets
```

`setup.sh` installs Node 22 + Caddy, prompts for both secrets (stored root-only in
`/etc/flashpoint-api-proxy.env`), runs a hardened systemd service, and serves HTTPS at
`https://<ip-with-dashes>.sslip.io`. Re-run it to change the API key or ship a new
`server.mjs`. Logs: `sudo journalctl -u flashpoint-api-proxy -f`.
