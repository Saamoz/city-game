# Territory Platform — Implementation Plan

> References: territory-platform-spec-v6-final.md (the spec)
> Each phase ends with a testable milestone. Phases are sequential.

---

## Decisions Made Before Starting

These decisions were left open or ambiguous in earlier drafts. They are now locked.

**Idempotency policy:** Every POST/PATCH/DELETE endpoint that changes game state requires an `Idempotency-Key` header. If absent, the server returns `400 VALIDATION_ERROR` with message "Idempotency-Key header required." No exceptions — including location updates (prevents duplicate location samples when tracking is enabled).

**Action receipt transaction boundary:** The action receipt is written inside the same database transaction as the mutation it guards. The response payload is generated inside the transaction, the receipt row is inserted, and then the transaction commits once. Broadcasts happen after commit. This eliminates the crash window between mutation and receipt that would defeat idempotency.

**Win condition shape:** Always an array, even for a single condition. `[{ "type": "all_zones" }]`, never a bare object. The evaluator iterates the array and short-circuits on the first met condition. This is simpler than branching on type.

**Geometry validation authority:** PostGIS is the authoritative geometry validator. Turf.js may be used for client-side pre-validation (fast UX feedback), but the server always validates with `ST_IsValid()` before persisting. Invalid geometry is rejected with `VALIDATION_ERROR` including `ST_IsValidReason()` output.

**Client version ordering rule:** The client ignores any Socket.IO event with `state_version <= store.stateVersion`. If the client detects a version gap (received N+3 but only has N), it requests a full sync rather than attempting partial application.

**Timeout job locking:** The claim timeout job uses `SELECT ... FOR UPDATE SKIP LOCKED` and verifies `status = 'active'` before expiring. This prevents races with concurrent releases, completions, admin resets, and future multi-worker scaling.

**GPS middleware vs. mode validation:** The platform GPS middleware handles freshness, global error radius, and velocity — concerns that apply to any GPS payload regardless of context. Spatial containment (`ST_Covers`) and per-zone error thresholds are mode-specific and handled by the Territory claim handler, which has zone context. Location update endpoints use the middleware without any containment check.

**Game ID discovery (V1):** `GET /api/v1/game/active` returns the one game with `status != 'completed'`. The frontend landing page calls this on mount. Join links can optionally include `/game/:id`. No deploy-time config injection needed.

**Pause/resume state machine:** `setup → active ↔ paused → completed`, plus `active → completed`. `POST /game/:id/resume` transitions `paused → active`. Resume does not re-initialize resources. `GAME_RESUMED` added to engine event taxonomy.

**Claim expiry warning:** The timeout job handles both expiry and pre-expiry warnings in a single scheduled run. Claims approaching expiry (< 2 minutes remaining) trigger a push notification to the claiming team. A `warning_sent` boolean on `challenge_claims` prevents duplicate notifications. This is a spec addendum: add `warning_sent BOOLEAN NOT NULL DEFAULT FALSE` to the `challenge_claims` schema.

---

## Phase 1: Project Scaffolding & Test Infrastructure

**Goal:** Monorepo compiles, runs, and has a working test harness.

### Work

- Initialize monorepo root with shared TypeScript config
- `client/`: Vite + React + TypeScript + Tailwind. Renders a blank page with "Territory" heading
- `server/`: Fastify + TypeScript. Single `GET /health` endpoint returning `{ status: "ok" }`
- `shared/`: TypeScript package with placeholder exports for `types.ts`, `errors.ts`, `events.ts`, `resources.ts`, `constants.ts`
- Configure path aliases so client and server import from `shared/`
- `npm run dev` scripts for both client and server
- `.env.example` with all environment variables from spec Section 17
- **Vite dev proxy**: configure `vite.config.ts` with `server.proxy` pointing `/api/*` and `/socket.io/*` at Fastify's port. Browser sees one origin during dev, eliminating CORS/cookie issues
- **Test infrastructure**:
    - Install Vitest as test runner for server
    - Test database: script to create/drop a `territory_test` database with PostGIS
    - Fastify test helper: function that creates a Fastify app instance with routes registered, injects requests, and tears down after each test
    - Socket.IO test client factory: creates connected test clients with configurable auth
    - Seed/factory utilities: `createTestGame()`, `createTestTeam()`, `createTestPlayer()`, `createTestZone()`, `createTestChallenge()` — insert rows with sensible defaults, return the created entities
    - One example integration test: `GET /health` returns 200

### Validation

- `npm run dev` in `server/` → `curl localhost:3000/health` returns `{ "status": "ok" }`
- `npm run dev` in `client/` → browser at `localhost:5173` shows page. Requests to `/api/health` are proxied to Fastify
- `npx tsc --noEmit` passes across all packages
- `npm test` in `server/` → Vitest runs, health check test passes
- Test database is created and destroyed cleanly

---

## Phase 2: Database Schema & Migrations

**Goal:** All tables from spec Section 4 exist with indexes and constraints.

### Work

- Configure Drizzle ORM in `server/src/db/`
- Write Drizzle schema for all tables in migration order:
    1. `games`
    2. `teams` (with `UNIQUE (game_id, join_code)`)
    3. `players` (with nullable `team_id`)
    4. `zones`
    5. `challenges` (without `current_claim_id` FK — circular dependency)
    6. `challenge_claims`
    7. `ALTER TABLE challenges ADD CONSTRAINT fk_current_claim FOREIGN KEY (current_claim_id) REFERENCES challenge_claims(id)`
    8. `resource_ledger`
    9. `game_events`
    10. `action_receipts`
    11. `annotations`
    12. `player_location_samples`
- Create all indexes from spec Section 4, including:
    - Partial unique index `idx_one_active_claim_per_challenge` on `challenge_claims`
    - Sequence uniqueness indexes on `resource_ledger` (team-level and player-level partials)
- Write `db/index.ts` with connection pool
- Update test infrastructure: test database setup runs migrations automatically

### Validation

- `npx drizzle-kit push` succeeds
- All 12 tables exist. `SELECT PostGIS_Version()` works
- Circular FK works: `\d challenges` shows FK to `challenge_claims` and vice versa
- Insert a test zone with GeoJSON → query with `ST_Covers` → correct result
- Insert two active claims for same challenge → rejected by partial unique index
- Insert two resource_ledger rows with same scope + sequence → rejected
- Drop and recreate → repeatable
- Vitest: migration test creates and queries all tables

---

## Phase 3: Error System & Shared Types

**Goal:** All error codes, event types, resource constants, and entity types defined.

### Work

- `shared/errors.ts`: all error codes with HTTP status mapping and default messages
- `shared/events.ts`: engine + Territory event types with payload shapes
- `shared/resources.ts`: resource type constants
- `shared/types.ts`: interfaces for all entities
- `server/src/lib/errors.ts`: `AppError` class and Fastify error handler
- Win condition type: `WinCondition[]` (always array) with discriminated union

### Validation

- `npx tsc --noEmit` passes
- Vitest: thrown `AppError` → correct error response shape
- Every spec error/event has a corresponding entry
- Win condition typed as array

---

## Phase 4: Auth Middleware

**Goal:** Cookie-based session auth per spec Section 5.

### Work

- Auth middleware: cookie → player lookup → `request.player`
- Team-requirement helper: `team_id IS NOT NULL` check
- Admin middleware: bearer token check
- Cookie utility: UUIDv4 token, httpOnly/Secure/SameSite
- Verify Vite proxy passes cookies correctly

### Validation

- Vitest: no cookie → 401. Valid cookie → player attached. Admin without token → 403. Null team_id → 403 `NOT_ON_TEAM`
- Dev proxy: cookies work through Vite

---

## Phase 5: Game & Team CRUD

**Goal:** Admin creates games and teams.

### Work

- Game CRUD + lifecycle stubs. `win_condition` validated as array
- Team CRUD with auto-generated join_code. `UNIQUE (game_id, join_code)` enforced
- **Active game discovery**: `GET /api/v1/game/active` — returns the one game with `status != 'completed'`, or 404 if none exists. This is how the frontend learns the game ID for V1 single-game. Join links can optionally include `/game/:id` as a convenience, but the landing page does not require it

### Validation

- Vitest: CRUD operations, admin auth, join_code uniqueness, win_condition array validation
- `GET /game/active` with one active game → returns it. No active game → 404

---

## Phase 6: Player Registration & Team Join

**Goal:** Registration + team join per spec Section 5.

### Work

- `POST /game/:id/players { display_name }` → session cookie, `team_id: null`
- `POST /game/:id/teams/join { join_code }` → sets team_id
- `GET /players/me`

### Validation

- Vitest: register → null team. Join → team set. Bad code → 404. No cookie → 401

---

## Phase 7: Zone CRUD & Spatial Service

**Goal:** Zones with PostGIS validation and spatial queries.

### Work

- Zone CRUD with `ST_IsValid()` validation (reject invalid with `ST_IsValidReason()`)
- Bulk import from FeatureCollection
- spatialService: buffered ST_Covers, distances, containing zones
- Same-game consistency checks

### Validation

- Vitest: create zone → centroid computed. Self-intersecting → 400 with reason. Spatial queries correct. Buffer works. Disabled excluded

---

## Phase 8: OSM Import Service *(Deferrable)*

**Goal:** Auto-import from OpenStreetMap. **Defer if schedule pressure appears** — manual import via `/zones/import` with a static GeoJSON file is sufficient for playtesting.

### Work

- Overpass API client, rate limiting
- `POST /game/:id/zones/import-osm { city }` → preview FeatureCollection

### Validation

- Chicago query → ~77 features. Importable via existing endpoint

---

## Phase 9: Challenge CRUD

**Goal:** Flexible challenge creation with kind/config/scoring.

### Work

- Challenge CRUD with filters. Same-game zone_id validation. completion_mode validation

### Validation

- Vitest: create various kinds, cross-game rejected, filters work

---

## Phase 10: Resource Ledger Service

**Goal:** Concurrency-safe resource transactions.

### Work

- `resourceService`: getBalance, getAllBalances, transact (FOR UPDATE + sequence), getHistory
- Resource REST endpoints
- Initial balance seeding on game start

### Validation

- Vitest: transactions, balance reads, negative rejection, concurrency test (parallel writes → correct sequences), unique index enforcement

---

## Phase 11: Event Service & State Version

**Goal:** Event logging with atomic state_version increment and delta queries.

### Work

- `gameService.incrementVersion()` — atomic inside transaction
- `eventService`: logEvent, getEventsSince, getRecentEvents

### Validation

- Vitest: version increment, event query, delta since version, fullSyncRequired threshold

---

## Phase 12: Idempotency Middleware

**Goal:** Idempotency-Key prevents duplicates. Receipt in same transaction as mutation.

### Work

- Middleware: require key on all mutating endpoints (400 if missing), check receipts, detect conflicts
- idempotencyService: check + store (store called inside mutation transaction)
- Every handler: begin tx → mutate → generate response → store receipt → commit → broadcast

### Validation

- Vitest: replay → same response (verify no re-execution). Conflict → 409. Missing key → 400. **Rollback test**: verify receipt and mutation are atomic

---

## Phase 13: GPS Validation Middleware

**Goal:** Platform-level GPS validation: freshness, error radius, velocity. Spatial containment is NOT in this middleware — it is a mode-specific concern handled by the Territory claim handler (Phase 18).

### Work

- `server/src/middleware/gpsValidation.ts`:
    - Parses `GpsPayload` from request body
    - Freshness: `capturedAt` within `GPS_MAX_AGE_SECONDS` → `GPS_TOO_OLD`
    - Error radius: `gpsErrorMeters` below global `GPS_MAX_ERROR_METERS` → `GPS_ERROR_TOO_HIGH`. Note: per-zone overrides are checked in the claim handler, not here, because this middleware has no zone context
    - Velocity (log only): warn if impossible jump since last update
    - Attaches validated GPS payload to request context for downstream handlers
- This middleware applies to: `/challenges/:id/claim`, `/players/me/location`
- Spatial containment (`ST_Covers`) is called by the Territory claim handler after this middleware runs, where zone context is available

### Validation

- Vitest: stale GPS → 422 `GPS_TOO_OLD`
- High error (above global threshold) → 422 `GPS_ERROR_TOO_HIGH`
- Valid GPS → passes, payload attached to request
- Location update endpoint uses this middleware without any zone/containment check
- Velocity warning logged but not blocking

---

## Phase 14: Mode Registry & Territory Handler Skeleton

**Goal:** Mode system loads handler by mode_key.

### Work

- Mode registry with loader
- Territory handler: identity filterStateForViewer, resource definitions, stub methods, route registration
- Wire into server startup, `onGameStart` initializes resources

### Validation

- Vitest: handler loads, unknown mode errors gracefully, resources initialized

---

## Phase 15: Game Lifecycle

**Goal:** Start, pause, resume, and end with events and resource initialization.

### Work

- State machine: `setup → active ↔ paused → completed`, plus `active → completed`
- `POST /game/:id/start` — 'setup' → 'active'. Calls `onGameStart()` (initializes resources). Logs `GAME_STARTED`
- `POST /game/:id/pause` — 'active' → 'paused'. Logs `GAME_PAUSED`
- `POST /game/:id/resume` — 'paused' → 'active'. Logs `GAME_RESUMED` (add to engine event taxonomy)
- `POST /game/:id/end` — 'active' or 'paused' → 'completed'. Calls `onGameEnd()`. Logs `GAME_ENDED`
- Invalid transitions → 409 with descriptive error

### Validation

- Vitest: full lifecycle including pause → resume → end
- Invalid transitions rejected (start from active, pause from setup, resume from active, etc.)
- Resources initialized after start
- Events logged for each transition
- Resume does NOT re-initialize resources

---

## Phase 16: Socket.IO Server & Connection Auth

**Goal:** Cookie-handshake auth, rooms, broadcaster.

### Work

- Handshake cookie validation, `join_game`/`leave_game`, room management
- Broadcaster with `filterStateForViewer` call, `server_time` appending

### Validation

- Vitest (Socket.IO test client): auth, rooms, broadcasting, team sub-rooms

---

## Phase 17: Map State & Delta Sync

**Goal:** Full snapshots and delta sync.

### Work

- `GET /map-state` with visibility filtering
- `GET /events/since/:version` with delta/fullSync logic
- Socket reconnect handling in `join_game`

### Validation

- Vitest: snapshot complete, delta correct, reconnect flows, annotation visibility filtering

---

## Phase 18: Territory Claim Action

**Goal:** Full claim flow from spec Section 11.

### Work

- `POST /challenges/:id/claim` with middleware chain: auth → team → idempotency → GPS (platform: freshness + global error check)
- Territory handler (after middleware passes):
    - Row lock: `SELECT challenge ... FOR UPDATE`
    - Verify `status = 'available'`
    - **Per-zone GPS error check**: if zone has `max_gps_error_meters`, check `gpsErrorMeters` against it (stricter or looser than global). Return `GPS_ERROR_TOO_HIGH` with zone-specific threshold in details if exceeded
    - **Spatial containment**: call `spatialService.isPlayerInZone()` with zone's `claim_radius_meters` buffer. Return `OUTSIDE_ZONE` with distance if outside. This check lives here, not in the GPS middleware, because it requires zone context
    - Check max concurrent claims per team (from settings)
    - Insert `challenge_claims` (partial unique index enforces one active)
    - Update challenge: `status = 'claimed'`, `current_claim_id`
    - Increment state_version
    - Log events (engine + mode)
    - **Store action receipt inside transaction**
    - Commit
    - Broadcast after commit

### Validation

- Vitest: success, idempotent replay, already claimed, outside zone, GPS errors (both global and per-zone), game not active, no team, max claims, partial unique index enforcement

---

## Phase 19: Claim Timeout Job

**Goal:** Auto-expiry with `FOR UPDATE SKIP LOCKED`. Pre-expiry warning notifications.

### Work

- `server/src/jobs/claimTimeout.ts` — periodic interval (every 30s), handles two concerns:
    1. **Expire stale claims**: `SELECT ... FROM challenge_claims WHERE status = 'active' AND expires_at < NOW() FOR UPDATE SKIP LOCKED`. Verify status still active, verify `current_claim_id` matches before clearing. Update claim (expired), challenge (available), increment version, log events, broadcast
    2. **Pre-expiry warnings**: `SELECT ... FROM challenge_claims WHERE status = 'active' AND expires_at - NOW() < INTERVAL '2 minutes' AND warning_sent = FALSE`. For each: send push notification to the claiming team ("Your claim is about to expire!"), set `warning_sent = TRUE` on the claim row. This is a lightweight update, not a state change — no state_version increment or event needed
- Add `warning_sent BOOLEAN NOT NULL DEFAULT FALSE` to `challenge_claims` table (add to Phase 2 schema)
- Startup recovery: run expiry scan immediately on server start

### Validation

- Vitest: claim with short timeout → auto-expires, events logged, broadcast sent
- Challenge returns to 'available'
- Pre-expiry: claim with 1.5 min remaining → warning push sent, `warning_sent` set to true
- Warning only sent once (second job run doesn't re-send)
- Claim completed before warning → no warning sent
- Startup recovery catches already-expired claims
- Concurrent race with manual release → handled cleanly (SKIP LOCKED)

---

## Phase 20: Territory Complete Action

**Goal:** Full completion flow from spec Section 11.

### Work

- `POST /challenges/:id/complete`
- Expired claim branch: cleanup committed, 409 returned
- Happy path: claim completed → challenge completed → zone captured → resources awarded → events → receipt in transaction → commit → broadcast

### Validation

- Vitest: zone captured, resources match scoring, expired claim cleanup committed, wrong team 403, no claim 404, idempotent replay

---

## Phase 21: Territory Release Action

**Goal:** Voluntary claim release.

### Work

- `POST /challenges/:id/release` — verify, update, events, receipt in transaction, commit, broadcast

### Validation

- Vitest: challenge available after release, events logged, another team can claim

---

## Phase 22: Admin Override Endpoints

**Goal:** Overrides available early for debugging during development.

### Work

- force-complete, reset, assign-owner, move-team, rebroadcast-state, adjust-resources
- All log `ADMIN_OVERRIDE`, all require admin token

### Validation

- Vitest: each override works, events with `actor_type: 'admin'`, without token → 403

---

## Phase 23: Win Condition Evaluation

**Goal:** Auto-end game when condition met.

### Work

- Evaluator iterates `win_condition` array, short-circuits on first met
- `all_zones`, `zone_majority`, `score_threshold`: checked after every completion
- `time_limit`: periodic job
- On win → end game, GAME_ENDED, broadcast

### Validation

- Vitest: each condition type, not-met continues, multiple conditions (first triggers)

---

## Phase 24: Player Location Updates

**Goal:** GPS updates with optional tracking.

### Work

- `POST /players/me/location` with Idempotency-Key
- Update player, optionally write sample, velocity warning
- Cleanup job

### Validation

- Vitest: player updated, tracking on/off, cleanup, idempotent

---

## Phase 25: Annotation CRUD

**Goal:** Player markers, admin full toolkit, visibility filtering.

### Work

- Create/list/delete with player restrictions enforced, visibility filtering, broadcasts

### Validation

- Vitest: player marker only, visibility filtering, admin any type, delete permissions

---

## Phase 26: Scoreboard

**Goal:** Team rankings.

### Work

- Zone counts + resource balances, ranked
- `GET /scoreboard`

### Validation

- Vitest: ranking correct, tiebreaks, empty game

---

## Phase 27: Web Push Notifications

**Goal:** Push notifications for Territory events.

### Work

- VAPID, subscription storage, rate-limited delivery, Territory event triggers

### Validation

- Subscription stored, push sent, rate limited, invalid subscription handled

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