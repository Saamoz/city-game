# Territory Platform — Implementation Plan

> References: SPEC.md
> Each phase ends with a testable milestone. Phases are sequential.

---

## Decisions Made Before Starting

**Idempotency policy:** Every POST/PATCH/DELETE endpoint requires an `Idempotency-Key` header. If absent → `400 VALIDATION_ERROR`. No exceptions, including location updates.

**Action receipt transaction boundary:** Receipt is written inside the same DB transaction as the mutation. Broadcasts happen after commit.

**Win condition shape:** Always an array. `[{ "type": "all_zones" }]`, never a bare object. Evaluator short-circuits on first met condition.

**Geometry validation authority:** PostGIS is authoritative. Turf.js may be used client-side for UX pre-validation only.

**Client version ordering rule:** Client ignores events with `state_version <= store.stateVersion`. Gap detected → request full sync.

**Timeout job locking:** `SELECT ... FOR UPDATE SKIP LOCKED`, verifies `status = 'active'` before expiring.

**GPS middleware vs. mode validation:** GPS middleware handles freshness, global error radius, velocity. Spatial containment and per-zone error thresholds are mode-specific (handled in Territory claim handler).

**Game ID discovery (V1):** `GET /api/v1/game/active` returns the one game with `status != 'completed'`.

**Pause/resume state machine:** `setup → active ↔ paused → completed`, plus `active → completed`.

**Claim expiry warning:** Timeout job handles both expiry and pre-expiry warnings (< 2 min remaining) in a single run. `warning_sent` boolean on `challenge_claims` prevents duplicates.

**Zone geometry:** `GEOMETRY(Geometry, 4326)` — supports Polygon (area zones), Point (station/landmark zones), MultiPolygon. `ST_Buffer` and `ST_Covers` work identically across all types. Point zones use `claim_radius_meters` as the capture circle radius.

**Resource types:** Mode-defined strings stored in `resource_ledger.resource_type`. The platform award loop iterates `challenge.scoring` keys — not a fixed enum. Territory V1 does not use a player-facing resource economy; future modes or variants may define their own resource strings without schema changes.

**Claim timeout:** `CLAIM_TIMEOUT_MINUTES` env var is the server-wide default. Per-game override via `game.settings.claim_timeout_minutes`.

---

## Phases 1–27: Backend Complete

All backend phases are implemented, tested, and passing. Summary of what exists:

- **Monorepo** (pnpm workspaces): `client/`, `server/`, `shared/`. Vitest test harness with DB-backed integration tests.
- **Schema & migrations**: All 12 tables with PostGIS, indexes, circular FK, partial unique indexes.
- **Shared types**: Error codes, event taxonomy, entity interfaces, win condition discriminated union.
- **Auth**: Cookie-based session auth, team requirement helper, admin bearer token middleware.
- **Game & Team CRUD**: Lifecycle endpoints (start/pause/resume/end), join codes, `GET /game/active`.
- **Player registration & team join**.
- **Zone CRUD & spatial service**: PostGIS validation, buffered `ST_Covers`, bulk import, OSM import.
- **Challenge CRUD**.
- **Resource ledger service**: `FOR UPDATE` concurrency safety, sequence monotonicity, initial balance seeding.
- **Event service**: Atomic `state_version` increment, delta sync, `fullSyncRequired` threshold.
- **Idempotency middleware**: Receipt stored in same transaction as mutation, request fingerprinting, conflict detection.
- **GPS validation middleware**: Freshness, global error radius, velocity warning.
- **Mode registry**: Loads handler by `mode_key`, registers routes, exposes decorator on Fastify app.
- **Game lifecycle**: Full state machine with `onGameStart`/`onGameEnd` hooks and resource initialization.
- **Socket.IO**: Cookie handshake auth, rooms, broadcaster with per-socket `filterStateForViewer`.
- **Map state & delta sync**: Full snapshot builder, reconnect sync (full vs. delta based on version gap).
- **Territory claim/complete/release**: Full flows with row locks, GPS containment, resource awards, events, receipts, broadcasts.
- **Claim timeout job**: `FOR UPDATE SKIP LOCKED`, startup recovery, pre-expiry push warnings.
- **Admin overrides**: force-complete, reset, assign-owner, move-team, rebroadcast-state, adjust-resources.
- **Win condition evaluation**: all_zones, zone_majority, score_threshold, time_limit. Backend support exists for all four; Territory V1 should use all_zones, zone_majority, and time_limit in product/UI flows.
- **Player location updates**: Optional tracking, retention cleanup job.
- **Annotation CRUD**: Player/admin permissions, visibility filtering, broadcasts.
- **Scoreboard**: Mode-delegated `computeScoreboard()`. Territory V1 should rank by zones owned only, with deterministic fallback by team name/id.
- **Web Push notifications**: VAPID, per-player subscriptions, rate limiting, Territory capture triggers.

---

## Phases 28–35: Frontend Complete ✅

All frontend phases shipped. Summary of what exists in the client:

- **Phase 28–29:** Mapbox map shell with team-colored zone polygons; Socket.IO live sync with version ordering, reconnect banner, and gap recovery.
- **Phase 30–31:** Portable challenge deck (horizontal card tray, swipe gestures, collapsible dock); full mobile-first UI overhaul; GPS-gated challenge completion; idempotent action hook; completed cards tray; `OUTSIDE_ZONE` / `GPS_TOO_OLD` error handling with optimistic rollback.
- **Phase 32:** Team control strip; mini scoreboard; full scoreboard page; live event feed; notification toast stack; rival zone capture toasts.
- **Phase 33:** Admin zone editor (`/admin/zones`) — draw, split, merge, snap, import GeoJSON/OSM, export.
- **Phase 34:** Challenge Keeper (`/admin/challenges`) — challenge set CRUD, item authoring, portable/zone/point placement, JSON import/export.
- **Phase 35:** Admin panel (`/admin`) — game lifecycle, team management, admin overrides, scoreboard view.

---

## Phase 36: Join Flow & Pre-Game Lobby ✅

**Done.** Zustand-backed `JoinFlow` with `home → team_picker → lobby → countdown` states, persisted to localStorage. Zero-knowledge team picker (join codes hidden from players). Lobby shows live rosters via `player_joined` socket, `Leave` support via `POST /players/me/leave-team`. Simultaneous animated countdown on `game_started`. `suppressAutoEnter` prevents auto-re-entry after leaving the live map.

---

## Phase 37: Active Challenge Window ✅

**Done.** Rolling N-challenge deck (`game.settings.active_challenge_count`, default 3). Migration 0005 adds `sort_order` + `is_deck_active` to `challenges`. Completing a challenge promotes the next queued one in the same DB transaction and emits `CHALLENGE_SPAWNED`. Queued challenges are hidden from player snapshots. Client animates newly activated cards; feed announces them. See LOG.md Phase 37 Notes for details.

---

## Phase 38: Push Notifications ✅

**Done.** Push-only service worker at `client/public/sw.js`. Soft-ask lobby banner; `Not now` persisted per game+player in localStorage. No manifest, no caching, no offline behaviour. See LOG.md Phase 38 Notes for details.

---

## Phase 39: Deployment

**Goal:** Production on Render (single Web Service).

### Stack

- **Database:** Render Postgres (PostgreSQL 16 + PostGIS via `CREATE EXTENSION postgis`). Run migrations as part of the build command.
- **Server + Client:** Single Render Web Service — Fastify serves the Vite build from `client/dist` via `@fastify/static`, with SPA fallback. One URL, no CORS.
- **WebSockets:** Socket.IO works on Render Web Services out of the box.

### Deploy checklist

1. Create Render Postgres database → connect to it via PSQL → run `CREATE EXTENSION postgis;`
2. Create Render Web Service → point to repo → set build/start commands + env vars
3. Verify HTTPS, WebSocket upgrade, and GPS (requires HTTPS on mobile)
4. Smoke-test: create game → join → capture zone → scoreboard
5. Set up Chicago authored map + challenge set for first real game
---

## Future Work

### Deferred Frontend — Distance Tool (formerly Phase 33)

**Goal:** Map ruler for measuring distances.

### Work

- Toggle button in desktop toolbar / ☰ menu on mobile
- `mapMode: 'play' | 'measure'` in Zustand
- Tap map → place waypoints; amber dashed polyline connects them
- Running distance label in km near last waypoint (League Mono font, cream pill)
- Tap last waypoint to undo. "Clear" button resets all.
- Measure mode suppresses zone tap and deck card selection
- Escape key exits measure mode

### Validation
- Measure works on desktop and mobile. Cumulative distance correct. Toggle clears. Deck still openable in measure mode.

