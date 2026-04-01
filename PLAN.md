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

**Resource types:** Mode-defined strings stored in `resource_ledger.resource_type`. The platform award loop iterates `challenge.scoring` keys — not a fixed enum. Territory uses `points` and `coins`; other modes may define their own without schema changes.

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
- **Win condition evaluation**: all_zones, zone_majority, score_threshold, time_limit. Triggered post-completion and by periodic job.
- **Player location updates**: Optional tracking, retention cleanup job.
- **Annotation CRUD**: Player/admin permissions, visibility filtering, broadcasts.
- **Scoreboard**: Mode-delegated `computeScoreboard()`, Territory ranks by points → zones → coins → name.
- **Web Push notifications**: VAPID, per-player subscriptions, rate limiting, Territory capture triggers.

---

## Phase 28: Frontend — Map Shell & Zone Rendering

**Goal:** Mapbox map with zones from API.

### Work

- Mapbox init, REST client with cookie handling and Idempotency-Key generation
- `Landing.tsx`:
    - On mount: calls `GET /api/v1/game/active` to discover the current game ID. If 404 → show "No active game" message
    - Registration form: display_name → `POST /game/:id/players` → session cookie set
    - Team join form: join_code → `POST /game/:id/teams/join` → redirect to game view
    - If URL already includes `/game/:id`, use that ID directly (supports shareable join links)
- `GameView.tsx`: full-screen Mapbox map
- `ZoneLayer.tsx`: zones from `GET /map-state`, team-colored polygons
- `gameStore.ts`: Zustand store initialized from map-state

### Validation

- Browser: open `/` → game discovered automatically, registration + join works
- Open `/game/:id` directly → uses that ID
- No active game → helpful message
- Zones rendered with correct colors. Mobile works

---

## Phase 29: Frontend — Socket.IO & Live State

**Goal:** Real-time sync with version ordering.

### Work

- Socket.IO client with cookie auth, Zustand sync handlers
- **Version rule**: ignore events ≤ current version. Gap → full sync
- Reconnect banner

### Validation

- State changes reflected live. Disconnect/reconnect works. Out-of-order ignored. Gap → full sync

---

## Phase 30: Frontend — Challenge Markers & Zone Info

**Goal:** Challenge markers, zone info bottom sheet.

### Work

- ChallengeMarkers, ZoneInfoPanel, BottomSheet, distance display

### Validation

- Markers visible. Tap zone → info. Distance shown. Real-time updates

---

## Phase 31: Frontend — Claim & Complete UI

**Goal:** Gameplay actions with optimistic UI.

### Work

- ChallengeCard with claim/complete/release, countdown timer, submission forms
- useIdempotentAction, useGeolocation (adaptive intervals)
- Optimistic updates with rollback

### Validation

- Claim/complete/release work. Errors show toast + rollback. Double-tap idempotent. GPS adaptive

---

## Phase 32: Frontend — HUD, Scoreboard, & Feed

**Goal:** Team banner, scoreboard, live feed, toasts.

### Work

- TeamBanner, MiniScoreboard, Scoreboard page, LiveFeed, EventCard, NotificationToast

### Validation

- Resources animate. Scoreboard matches. Events animate. Toasts for rival captures

---

## Phase 33: Frontend — Distance Tool

**Goal:** Measure distances on map.

### Work

- DistanceTool toggle, waypoints, dashed line, distance label, useMapTools

### Validation

- Measure works. Cumulative. Toggle clears. Zone tap suppressed in measure mode

---

## Phase 34: Frontend — Admin Zone Editor

**Goal:** Terra Draw zone editing.

### Work

- Terra Draw setup, draw/edit/delete modes, import (OSM or file), config panel, buffer visualization

### Validation

- Draw/edit/delete zones. Import works. Config persisted. Buffer shown

---

## Phase 35: Frontend — Admin Panel

**Goal:** Game management and overrides UI.

### Work

- GameSettings, ChallengeManager, resource/zone override UIs

### Validation

- Lifecycle controls, challenge CRUD, overrides work through UI

---

## Phase 36: PWA & Service Worker

**Goal:** Installable, offline capable, push handler.

### Work

- manifest.json, sw.js (cache + push), Zustand persistence, push subscription flow

### Validation

- Add to Home Screen. Offline loads cached. Push notifications work

---

## Phase 37: Rate Limiting

**Goal:** Prevent abuse.

### Work

- `@fastify/rate-limit` with per-endpoint limits. 429 with Retry-After

### Validation

- Vitest: limits enforced, different IPs unaffected

---

## Phase 38: End-to-End Integration Test

**Goal:** Full game scenario automated.

### Work

- Script: create game → zones → challenges → teams → register → join → start → claim → complete → expire → admin override → scoreboard → end
- Socket.IO broadcast verification, idempotency replay, delta sync, receipt atomicity

### Validation

- All assertions pass. Events, resources, ownership correct

---

## Phase 39: Mobile Testing & Polish

**Goal:** Works on real phones.

### Work

- iOS Safari + Android Chrome testing. Touch fixes. GPS on mobile. Poor network. Performance. Accessibility

### Validation

- All flows work on mobile. Lighthouse ≥ 80

---

## Phase 40: Deployment

**Goal:** Production on Proxmox.

### Work

- LXC, PostgreSQL + PostGIS, Node.js, Caddy, pm2, env vars, DNS
- Integration test against production

### Validation

- HTTPS works. WebSocket works. GPS works. Integration test passes

---

## Phase 41: Playtest Prep

**Goal:** Game configured for real play.

### Work

- Chicago zones, GPS tuning, 20-30 challenges, 4 teams, mobile flow test, join instructions

### Validation

- Full flow works on mobile. Instructions clear

---

## Phase 42: Playtest & Post-Mortem

**Goal:** Real game, real data, real learning.

### Work

- 4 teams × 3-5 players, 2-3 hours. Location tracking enabled
- Post-game: events, samples, receipts, overrides, player survey
- Document issues, priorities for next iteration

### Validation

- Game ran. Players could play. Issues documented. Post-mortem completed

---

*Ship V1 by completing all phases. Each phase is independently testable.*
