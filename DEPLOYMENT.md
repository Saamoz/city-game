# Deployment Guide — Render
 
## Overview
 
The app deploys as a single **Render Web Service** backed by a **Render Managed Postgres** instance. The Node server serves the compiled React client as static files from `client/dist/`, so no separate static hosting is needed.
 
```
Browser → Render Web Service (Node/Fastify)
                   │
                   ├── REST API  (/api/v1/*)
                   ├── Socket.IO (/socket.io/*)
                   ├── Static SPA (client/dist/)
                   └── Render Managed Postgres (PostGIS)
```
 
---
 
## Components
 
### Web Service
 
- **Runtime:** Node 20
- **Build command:** `pnpm install --frozen-lockfile && pnpm build`
  - `pnpm build` runs `tsc` on both `server` and `client` packages; the client Vite build outputs to `client/dist/`
- **Start command:** `pnpm db:migrate && node server/dist/index.js`
  - `pnpm db:migrate` runs Drizzle migrations and ensures `pgcrypto` + `postgis` extensions exist before the server starts
- **Health check path:** `GET /health` → `{"status":"ok"}`
- **Background jobs** (run in-process, no separate workers needed):
  - `claim-timeout` — expires stale zone claims
  - `win-condition` — polls for game-over state
  - `player-location-cleanup` — purges old GPS records
 
### Managed Postgres
 
Render's managed Postgres must have the **PostGIS extension available** (Render supports this on all plans). The migration script enables it automatically via `CREATE EXTENSION IF NOT EXISTS postgis`.
 
The `DATABASE_URL` provided by Render is used directly. `TEST_DATABASE_URL` is only required for running tests and can be set to the same value as `DATABASE_URL` in production if the variable is required at startup (or omit by patching `env.ts` — see note below).
 
> **Note:** `env.ts` currently calls `requireEnv('TEST_DATABASE_URL')` at import time, which will crash the server if the variable is absent. Either set `TEST_DATABASE_URL` to the same value as `DATABASE_URL`, or patch the guard to make it optional in production.
 
---
 
## Environment Variables
 
Set these in the Render Web Service **Environment** tab.
 
### Required
 
| Variable | Description |
|---|---|
| `DATABASE_URL` | Provided automatically by Render when you link the Managed Postgres. Format: `postgresql://user:pass@host/dbname` |
| `TEST_DATABASE_URL` | Set to the same value as `DATABASE_URL` (only used by tests; required at startup due to current `env.ts` guard) |
| `NODE_ENV` | Set to `production` |
| `VITE_MAPBOX_ACCESS_TOKEN` | Mapbox public token — embedded into the client bundle at build time |
| `VAPID_PUBLIC_KEY` | VAPID public key for Web Push notifications |
| `VAPID_PRIVATE_KEY` | VAPID private key for Web Push notifications |
| `VAPID_SUBJECT` | Contact URI for VAPID, e.g. `mailto:admin@yourdomain.com` |
| `VITE_VAPID_PUBLIC_KEY` | Same value as `VAPID_PUBLIC_KEY` — embedded into the client bundle at build time |
 
### Optional / Tuning
 
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Render injects this automatically; no need to set manually |
| `HOST` | `0.0.0.0` | Bind address — leave at default |
| `ADMIN_TOKEN` | `replace-me` | Bearer token for admin API routes. Set to a strong random string in production |
| `CLAIM_TIMEOUT_MINUTES` | `10` | How long a zone claim stays open before timing out. Can also be overridden per-game via `game.settings.claim_timeout_minutes` |
| `GPS_MAX_ERROR_METERS` | `100` | Maximum accepted GPS accuracy radius |
| `GPS_MAX_AGE_SECONDS` | `30` | Maximum accepted GPS fix age |
| `GPS_MAX_VELOCITY_KMH` | `200` | Maximum plausible player speed (anti-cheat) |
| `PUSH_RATE_LIMIT_MS` | `60000` | Minimum interval between push notifications per player |
| `LOCATION_RETENTION_HOURS` | `24` | How long raw GPS fixes are kept in the database |
| `OVERPASS_API_URL` | `https://overpass-api.de/api/interpreter` | Overpass endpoint used by the OSM import tool in the admin zone editor |
| `OVERPASS_MIN_INTERVAL_MS` | `1000` | Throttle between Overpass requests |
| `OVERPASS_TIMEOUT_MS` | `15000` | Overpass request timeout |
 
### Build-time Variables (VITE_*)
 
`VITE_*` and `MAPBOX_*` variables are baked into the client bundle at build time by Vite. They must be present in the Render environment **before the build runs**, not just at runtime.
 
| Variable | Notes |
|---|---|
| `VITE_MAPBOX_ACCESS_TOKEN` | Required. Public Mapbox token |
| `VITE_VAPID_PUBLIC_KEY` | Required if using push notifications |
 
---
 
## Generating VAPID Keys
 
Run once locally (requires `web-push` installed):
 
```sh
npx web-push generate-vapid-keys
```
 
Copy the public key to both `VAPID_PUBLIC_KEY` and `VITE_VAPID_PUBLIC_KEY`. Copy the private key to `VAPID_PRIVATE_KEY`.
 
---
 
## First Deploy Checklist
 
1. Create the Render Managed Postgres and link it to the Web Service — Render injects `DATABASE_URL` automatically.
2. Set all **Required** env vars in the Web Service environment, including both `VITE_*` build-time vars.
3. Set `TEST_DATABASE_URL` to the same value as `DATABASE_URL`.
4. Set `NODE_ENV=production`.
5. Set `ADMIN_TOKEN` to a strong random string.
6. Deploy. The start command runs migrations automatically before the server boots.
7. Verify the health check at `GET /health`.
8. Seed a city map if needed: `pnpm db:seed:toronto` or `pnpm db:seed:chicago` (run via Render Shell or locally against the prod DB).
