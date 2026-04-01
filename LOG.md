# Project Log

## Purpose

This file is the running handoff log for the repo. Keep short, high-signal notes here:

- local environment quirks
- decisions made during implementation
- small plan adjustments
- blockers and workarounds
- current status and next steps

If the product direction or implementation plan changes in a major way, update [SPEC.md](E:/city game/SPEC.md) and/or [PLAN.md](E:/city game/PLAN.md) directly as the source of truth.

---

## Current Snapshot

- Repo: `E:\city game`
- WSL repo path: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Current local branch: `master`
- Date of latest update: 2026-03-31
- Product goal: location-based multiplayer game platform, with Territory as the first mode
- Current implementation stage: Phase 24 player location updates complete

---

## What Has Been Done

## Phase 24 Progress

- Updated server/src/routes/player-routes.ts so POST /players/me/location still updates the player record but now also reports tracking metadata in the response
- Added server/src/services/player-location-service.ts to centralize location updates, optional player_location_samples inserts, tracking settings parsing, and retention cleanup logic
- Added server/src/jobs/player-location-cleanup.ts and started it from server/src/index.ts so retained samples are pruned in the background
- Extended server/src/routes/player-routes.test.ts with tracking-off, tracking-on, and idempotent replay coverage for location updates
- Added server/src/jobs/player-location-cleanup.test.ts to verify retention cleanup deletes stale samples and keeps recent ones
- Implementation note: location tracking is controlled by game.settings.location_tracking_enabled, while retention defaults to 24 hours when location_retention_hours is missing or invalid

---


## Phase 23 Progress

- Added Territory win-condition evaluation in server/src/modes/territory/win-conditions.ts for all_zones, zone_majority, score_threshold, and time_limit, with array-order short-circuiting
- Added server/src/services/win-condition-service.ts so completion flows and background jobs can evaluate and end games through the same lifecycle path
- Extended server/src/services/game-service.ts with reusable locked lifecycle helpers and system-authored GAME_ENDED events for win-condition endings
- Updated server/src/modes/territory/routes.ts so successful completions now trigger post-commit win evaluation and game_ended broadcasts when a condition is met
- Added server/src/jobs/win-condition.ts and started it from server/src/index.ts for periodic time_limit evaluation
- Added DB-backed coverage in server/src/services/win-condition-service.test.ts, server/src/jobs/win-condition.test.ts, and server/src/modes/territory/win-condition-routes.test.ts
- Important implementation note: the evaluator originally used Promise.all() on a single transaction client, which triggered pg deprecation warnings for concurrent queries on one connection; the final version runs those reads sequentially
- Test note: Fastify inject can observe the HTTP response before the post-commit win-evaluation callback finishes, so route-level assertions should poll the DB for the follow-up game end state rather than assuming it is visible immediately after the 200 response

---


## Phase 22 Progress

- Added admin override routes in `server/src/routes/admin-routes.ts` for force-complete, reset, assign-owner, move-team, rebroadcast-state, and resource adjustments
- Added `server/src/services/admin-override-service.ts` to centralize override mutations and ensure every override logs `ADMIN_OVERRIDE` with `actor_type = 'admin'`
- Added full-state rebroadcast helpers in `server/src/socket/admin-sync.ts` so admin overrides can push authoritative `game_state_sync` snapshots after commit
- Registered the admin route module in `server/src/app.ts` and covered all override endpoints in `server/src/routes/admin-routes.test.ts`

---

## Phase 21 Progress

- Implemented the voluntary release flow in `server/src/modes/territory/release-service.ts` with one transaction for claim release, challenge reset, event logging, receipt storage, and post-commit broadcast
- `POST /challenges/:id/release` is now live in `server/src/modes/territory/routes.ts` and uses the same idempotent mutation path as claim and complete
- Updated `server/src/modes/territory/handler.ts` so Territory now supports all three player actions: claim, complete, and release
- Added route coverage in `server/src/modes/territory/release-routes.test.ts` for successful release, immediate re-claim by another team, and idempotent replay

---

## Phase 20 Progress

- Implemented the Territory completion flow in `server/src/modes/territory/complete-service.ts` with one transaction for claim completion, challenge completion, zone capture, resource awards, and event logging
- `POST /challenges/:id/complete` is now live in `server/src/modes/territory/routes.ts` and supports `{ submission? }` bodies plus idempotent replay
- Expired claims are cleaned up inline during completion attempts: the action commits the release, returns `CLAIM_EXPIRED`, increments `stateVersion`, and broadcasts `challenge_released` after commit
- Added `transactInTransaction()` to `server/src/services/resource-service.ts` so resource awards can be applied safely inside larger mode transactions without opening nested top-level flows
- Added route coverage in `server/src/modes/territory/complete-routes.test.ts` for success, expiry cleanup, wrong-team rejection, missing-claim rejection, and idempotent replay

---

## Phase 11 Progress

- Added `server/src/services/game-service.ts` with atomic `stateVersion` increment support for future mutating flows
- Added `server/src/services/event-service.ts` with event logging, recent-event queries, and delta-sync queries that return `fullSyncRequired` when the version gap exceeds `MAX_DELTA_SYNC_GAP`
- Added public event endpoints in `server/src/routes/event-routes.ts` for recent events and delta sync (`/game/:id/events` and `/game/:id/events/since/:version`)
- Added `EVENT_TYPE_VALUES` to `shared/src/events.ts` so route-level validation uses the shared event taxonomy
- Added direct service coverage in `server/src/services/event-service.test.ts` for version increment, event insert/query behavior, and delta threshold handling
- Added route coverage in `server/src/routes/event-routes.test.ts` for event filtering, delta reads, and `fullSyncRequired` responses

---

## Phase 10 Progress

- Added `server/src/services/resource-service.ts` with balance reads, per-team snapshots, history queries, concurrency-safe transactions, and reusable initial-balance seeding helpers
- Resource transactions serialize same-scope writes by locking the team or player scope row with `FOR UPDATE` before computing the next sequence and balance
- Added public resource endpoints in `server/src/routes/resource-routes.ts` for all team balances, a single team snapshot, and filtered history
- Added direct service coverage in `server/src/services/resource-service.test.ts` for sequential writes, negative-balance rejection, concurrent writes, initial seeding, and unique-index enforcement
- Added route coverage in `server/src/routes/resource-routes.test.ts` for zero-default responses, single-team history reads, and cross-game team rejection
- Initial balance seeding is implemented as a helper for future lifecycle wiring; game start remains deferred because `/game/:id/start` is still intentionally stubbed until Phase 15

---

## Phase 9 Progress

- Added `server/src/routes/challenge-routes.ts` with admin-gated challenge create/update/delete endpoints plus public challenge listing by game
- Added request validation for `kind`, `status`, and `completionMode`, with same-game `zoneId` enforcement before insert/update
- Added integration coverage in `server/src/routes/challenge-routes.test.ts` for create, cross-game zone rejection, list filtering, update/delete, and completion-mode validation
- Registered challenge routes in `buildApp()` so the Phase 9 API is live under `/api/v1`
- Challenge route tests must use the actual zone IDs returned by `createZone()`; the spatial service generates zone IDs rather than honoring extra fixture keys

---

## Phase 8 Progress

- Added `server/src/services/osm-import-service.ts` with a rate-limited Overpass client, relation-first preview fetch, way fallback, and normalized GeoJSON output that the admin UI can preview directly
- Added admin-gated `POST /game/:id/zones/import-osm { city }` preview support through the existing zone route module
- Added injection support for the OSM preview service in `buildApp()` so network-dependent behavior can be tested without stubbing globals
- Added isolated coverage in `server/src/services/osm-import-service.test.ts` for query construction, relation-to-way fallback, and rate limiting
- Added route coverage in `server/src/routes/osm-import-routes.test.ts` for admin auth, game existence, and preview responses
- Added Overpass env defaults to `.env.example`

---

## Phase 7 Progress

- Added `server/src/services/spatial-service.ts` for PostGIS geometry validation, centroid generation, buffered `ST_Covers` checks, distance queries, bulk import, and same-game owner-team validation
- Added `server/src/routes/zone-routes.ts` with admin-gated zone create/import/update/delete endpoints plus public list/detail lookups
- Added integration coverage in `server/src/routes/zone-routes.test.ts` for zone CRUD, centroid computation, FeatureCollection import, invalid geometry rejection, and cross-game owner rejection
- Added direct service coverage in `server/src/services/spatial-service.test.ts` for containing-zone queries, buffered coverage, and distance calculations

---

## Phase 6 Progress

- Added `server/src/routes/player-routes.ts` with player registration, team join-by-code, and `GET /players/me`
- Registration now creates a player with `teamId: null`, generates a session token, and sets the auth cookie in the same response
- Team join now reuses the Phase 4 cookie session to attach the current player to a game team by join code
- Added integration coverage in `server/src/routes/player-routes.test.ts` for register, join, invalid codes, unauthenticated `GET /players/me`, and authenticated `GET /players/me`

---

## Phase 5 Progress

- Added first real `/api/v1` route module in `server/src/routes/game-routes.ts`
- Implemented admin-gated game creation and update, game detail lookup, active game discovery, team creation, and team listing
- Added lifecycle route stubs for `start`, `pause`, and `end` that return 501 until Phase 15
- Added deterministic win-condition validation for create/update so `winCondition` stays array-shaped and semantically valid
- Added `server/src/lib/join-code.ts` for 8-character team join code generation with DB-backed retry on uniqueness collisions
- Added `GAME_NOT_FOUND` to the shared error catalog for missing game lookups
- Added integration coverage in `server/src/routes/game-routes.test.ts` for admin auth, CRUD, join-code generation, win-condition validation, and active game discovery

---

## Phase 4 Progress

- Added cookie-based REST auth in `server/src/lib/auth.ts` backed by real `players.session_token` lookups
- Added `authenticate`, `requireTeam`, and `requireAdmin` Fastify decorations on the root app instance
- Added session cookie helpers and UUIDv4 token generation for later player registration work
- Added DB injection support to `buildApp()` so integration tests can run against the test database without mutating the dev database
- Added `server/src/test/test-db.ts` for migration-aware test DB reuse and cleanup
- Upgraded the test factories to use valid UUIDs and realistic insertable defaults
- Added `@fastify/cookie` and integration tests covering missing cookie, valid session, null-team rejection, missing admin token, and cookie serialization

---

## Phase 3 Progress

- Replaced placeholder shared exports with spec-aligned constants, error codes, event taxonomies, resource definitions, and entity interfaces
- Added typed win conditions as an array-only discriminated union in `shared/src/types.ts`
- Added `server/src/lib/errors.ts` with a shared-code-backed `AppError` class and centralized error response builder
- Wired the Fastify error handler in `server/src/app.ts` so application and schema validation failures now return the spec error shape
- Added server tests covering thrown `AppError` responses and normalized Fastify validation errors
- Updated the client scaffold to consume the new shared constant exports

---

## Phase 2 Progress

- Added native PostgreSQL ORM support with Drizzle in `server/`
- Added `compose.yml` with a `postgis/postgis:16-3.4` database service
- Added `server/drizzle.config.ts` and database scripts for generate/migrate/test-db lifecycle
- Implemented the Phase 2 schema in `server/src/db/schema.ts`
- Generated the initial SQL migration in `server/src/db/migrations/`
- Added a real `create-test-db` / `drop-test-db` flow using `pg`
- Verified the server package typechecks with the new ORM code
- Brought up the local PostGIS container successfully and verified the live databases

---

- Replaced the original single-package TypeScript stub with an npm workspace monorepo
- Created workspace packages:
  - `client/` for React + Vite + Tailwind
  - `server/` for Fastify + Vitest
  - `shared/` for common TypeScript exports
- Added root workspace config:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - root `tsconfig.json` with project references
- Added `.env.example` based on spec env vars
- Added minimal Phase 1 implementations:
  - client renders a Territory scaffold page
  - server exposes `GET /health`
  - server has a working Vitest test for `/health`
  - shared exports placeholder constants/types/errors/events/resources
- Installed workspace dependencies and generated `pnpm-lock.yaml`
- Converted the repo to a WSL-first workflow:
  - installed Linux `nvm`
  - installed Linux `node v20.20.2`
  - enabled `pnpm v10.33.0`
  - reinstalled workspace dependencies from WSL
  - updated WebStorm run configs to launch via `wsl.exe` into the `Ubuntu` distro
- Added shared WebStorm run configurations under `.idea/runConfigurations/` for:
  - `Dev All`
  - `Dev Client`
  - `Dev Server`
  - `Typecheck`
  - `Server Tests`
  - `Build`
  - `Validate`
  - `DB Up`
  - `DB Down`
  - `DB Logs`
  - `DB Migrate`
  - `DB Test Create`
  - `DB Generate`

---

## Validation Completed

Verified successfully from WSL:

```bash
pnpm -r typecheck
pnpm --filter @city-game/server test
pnpm -r build
```

Results:

- Workspace typecheck passed
- Server tests passed, including AppError, validation-error, auth middleware, game/team route coverage, player route coverage, Territory claim and complete route coverage, zone route coverage, challenge route coverage, resource route coverage, event route coverage, resource-service coverage, event-service coverage, spatial-service coverage, OSM preview route coverage, and OSM import service coverage
- Full workspace build passed
- `pnpm db:up` works against the Docker-backed local database
- `pnpm db:migrate` completed successfully
- `pnpm db:test:create` completed successfully
- `postgis_version()` verified in both `territory` and `territory_test`

---

## Environment Quirks

### WSL / Node / Package Manager

- Development should now be treated as WSL-first, not Windows-first
- `Ubuntu` is now running as **WSL 2**
- The original Linux `node` on this distro was unusable (`Exec format error`)
- Installed `nvm` in `/home/saamo/.nvm`
- Installed Linux `node v20.20.2`
- Installed `npm v10.8.2`
- Enabled `pnpm v10.33.0` through Corepack
- Updated shell startup so login shells load `nvm` automatically
- WebStorm run configurations now call into WSL directly and no longer depend on PowerShell or the Windows Node install
- In this Codex desktop session, the reported cwd for the patch tool was malformed; file edits had to be done through explicit WSL shell paths instead of `apply_patch`

Practical rule for now:

- from WSL, use plain `pnpm ...`
- from WebStorm on Windows, use the shared WSL-backed run configurations
- avoid using the old Windows `npm` / `pnpm` path for this repo

### Tooling Available

- Docker is installed on Windows: `Docker version 24.0.2`
- Docker Desktop daemon is now reachable from this environment through `docker.exe`
- WSL-native `docker` is still not installed in this distro, so repo scripts use a wrapper that falls back to `docker.exe` when needed
- `psql` is installed on Windows: `PostgreSQL 10.18`
- Phase 8 uses the public Overpass API by default; if rate limits or reliability become an issue, set `OVERPASS_API_URL` to a private endpoint before heavy preview usage

### Repo / Workspace Notes

- There is still a top-level `src/` directory left over from the original stub, but the old `src/index.ts` file was removed
- `.DS_Store` exists in the repo and is currently tracked in git status
- local IDE files under `.idea/` also exist from earlier setup

---

## Small Plan Adjustments / Decisions

- One-off `tsx` scripts hit an ENOTSUP IPC error in this WSL/filesystem setup; using `node --import tsx` for DB scripts avoids that issue
- Root Docker scripts now use `scripts/docker-compose.sh`, which prefers Linux `docker compose` and falls back to `docker.exe compose` when Docker Desktop is available
- Chose `pnpm` for workspace management
- Added `concurrently` so root `dev` can run client and server together
- Added a Vite proxy rewrite so `/api/*` maps to server routes correctly during development
- Kept Phase 1 database scripts as placeholders rather than faking database setup before Phase 2
- Moved the preferred development environment from Windows PowerShell to WSL
- Added `GAME_RESUMED` and `game_resumed` to the shared event taxonomy to match the earlier plan decision around pause/resume lifecycle
- Cookie utility keeps `Secure` enabled in production and disables it in development/test so local HTTP + Vite proxy auth remains usable
- Vitest file parallelism is disabled in `server/vitest.config.ts` because the current DB-backed integration suites share one migrated test database
- When running a single Vitest file in this repo, use `pnpm --filter @city-game/server exec vitest run <path>` instead of `pnpm --filter @city-game/server test -- <path>`; the script wrapper still runs the full suite
- Phase 10 uses `FOR UPDATE` on the scope row (`teams` for team balances, `players` for player balances) to serialize concurrent ledger writes even when no prior ledger row exists
- Phase 11 delta sync marks `fullSyncRequired` when `game.stateVersion - sinceVersion > MAX_DELTA_SYNC_GAP`; otherwise it returns events ordered by ascending `stateVersion`

These are implementation-level decisions, not product/spec changes.

---

## Known Gaps

- No monorepo README yet
- Local branch is still `master`; rename to `main` later if desired

---

## Recommended Next Steps

1. Proceed to Phase 20 Territory complete action.
2. Reuse the Phase 18 claim service serializers and the Phase 19 timeout job event/broadcast seams for complete/release flows instead of forking challenge state transitions.
3. Keep expanding route-level schemas so request validation stays centralized through the Fastify error handler.

---

## Handoff Notes For The Next Agent

- Read `SPEC.md`, `PLAN.md`, and this file first.
- The monorepo scaffold is already in place and healthy in WSL.
- Use WSL as the source of truth for repo work.
- Use the Linux Node install from `nvm`, not the Windows Node install.
- If a shell does not see the Linux Node install, check `~/.profile` and `~/.bashrc`.
- The next highest-value work is Phase 20 Territory complete action.

## Phase 12 Notes

- Phase 12 is complete: mutating POST/PATCH/DELETE routes now require `Idempotency-Key`, stored receipts are checked before execution, and receipts are written inside the same transaction as the guarded mutation.
- Added `server/src/middleware/idempotency.ts` and `server/src/services/idempotency-service.ts`.
- `action_receipts` was expanded to support non-player scopes:
  - `player_id` is now nullable
  - `scope_key` was added for `player:<id>`, `admin`, and `public`
  - `response_headers` was added so replay can restore headers like `Set-Cookie`
- Request fingerprinting now hashes `params`, `query`, and `body`, not just `body`. This prevents a reused key on a different route target from replaying the wrong response.
- OSM preview is explicitly marked with `config.skipIdempotency = true` because it is a POST preview endpoint with no state mutation.
- Player registration now persists the exact serialized session cookie in the receipt and replays it correctly.

### Phase 12 Learnings

- For 204 responses, storing a JavaScript `null` into a `jsonb not null` receipt field caused delete routes to fail. The helper now stores `{}` for 204 receipts and still sends an empty 204 response.
- Fastify cookie state was not reliably discoverable through generic reply header inspection during replay capture. The registration route now passes an explicit serialized `Set-Cookie` header into the idempotency helper.
- `fileParallelism: false` was not enough for the DB-backed Vitest suite. The shared Postgres test database needed `maxWorkers: 1` and `minWorkers: 1` in `server/vitest.config.ts` to eliminate cross-file truncation races.
- Drizzle generated a migration that added `scope_key` as `NOT NULL` immediately. That was manually adjusted to add the column nullable first, backfill existing rows, then set `NOT NULL`.

## Phase 13 Notes

- Phase 13 is complete: added `server/src/middleware/gps-validation.ts` with freshness checks, max-error enforcement, non-blocking velocity warnings, and request-scoped validated GPS payload attachment.
- Exported GPS env configuration from `server/src/db/env.ts` using shared defaults for age, accuracy, and velocity thresholds.
- Added `POST /players/me/location` in `server/src/routes/player-routes.ts` and wired it through auth, GPS validation, and idempotent mutation handling.
- `/players/me/location` now updates `players.last_lat`, `last_lng`, `last_gps_error`, and `last_seen_at` and returns both the safe player payload and normalized GPS payload.
- Added `server/src/middleware/gps-validation.test.ts` for stale/error/success coverage and velocity warning behavior.
- Extended `server/src/routes/player-routes.test.ts` with DB-backed coverage for successful location updates plus `GPS_TOO_OLD` and `GPS_ERROR_TOO_HIGH` failures.

### Phase 13 Learnings

- Shared `GpsPayload` requires `speedMps` and `headingDegrees`; the middleware now normalizes missing optional request fields to `null` so runtime payloads match the shared contract.
- Fake timers caused Fastify inject and DB-backed route tests to hang under Vitest. The GPS suites now use real timestamps relative to `Date.now()` instead of freezing the clock.
- In this Codex desktop session, `apply_patch` still resolves paths against the malformed app-resource cwd rather than `/mnt/e/city game`. Shell-based file writes remain the reliable fallback until that tool path issue is resolved.

## Phase 14 Notes

- Phase 14 is complete: added a mode registry in `server/src/modes/index.ts` that loads handlers by `modeKey`, throws a typed validation error for unknown modes, and registers mode-specific routes during app startup.
- Added `server/src/modes/types.ts` to define the server-local handler contract, viewer filtering seam, mode resource definitions, and the future action/win-check interfaces.
- Added `server/src/modes/territory/handler.ts` as the first concrete mode handler with identity `filterStateForViewer`, Territory resource definitions, stubbed action/win-check/scoreboard hooks, and `onGameStart()` resource initialization.
- Added `server/src/modes/territory/routes.ts` to register skeleton `claim`, `complete`, and `release` endpoints under `/api/v1/challenges/:id/*`.
- Wired the registry into `buildApp()` via a Fastify decoration so later lifecycle and realtime work can resolve handlers from the app context instead of re-instantiating them ad hoc.
- Added `server/src/modes/index.test.ts` covering handler loading, graceful unknown-mode failure, zero-balance resource initialization on game start, and route registration through app startup.

### Phase 14 Learnings

- The mode contract is cleaner as a server-local interface than a shared one right now, because the handler needs direct DB access and server-only hooks such as route registration.
- The spec says Territory resources initialize to zero on game start. To make that observable and testable, `seedInitialBalances()` now supports `includeZeroBalances: true`, which writes explicit zero-balance ledger rows only when the caller opts in.
- Registering mode routes through the app-level registry now creates the seam Phase 15 will need for `POST /game/:id/start` without requiring later route-file refactors.


## Phase 15 Notes

- Phase 15 is complete: added a reusable lifecycle service in `server/src/services/game-service.ts` that validates transitions, updates game status/timestamps, increments `stateVersion`, and writes lifecycle events atomically.
- `POST /game/:id/start`, `pause`, `resume`, and `end` are now live in `server/src/routes/game-routes.ts` and replace the earlier stubs.
- `start` resolves the mode handler through the registry and calls `onGameStart()` inside the lifecycle transaction; `end` calls `onGameEnd()` the same way.
- Lifecycle mutation responses now set `X-State-Version` and return the serialized game payload for the new authoritative state.
- Added DB-backed route coverage in `server/src/routes/game-routes.test.ts` for the full start/pause/resume/end flow, resource seeding on start, event logging, and invalid transition conflicts.
- Added `INVALID_GAME_STATE_TRANSITION` to the shared error catalog in `shared/src/errors.ts`.

### Phase 15 Learnings

- Zero-balance resource initialization is easier to observe and verify when game start writes explicit seed rows rather than relying on implicit empty-balance reads.
- Modeling lifecycle transitions in a reusable service is cleaner than embedding status rules directly in route handlers; later gameplay flows can reuse the same game lookup and versioning seam.
- Invalid lifecycle requests should fail as `409 INVALID_GAME_STATE_TRANSITION`, not generic validation errors, because the request shape is valid and only the current game state is wrong.


## Phase 16 Notes

- Phase 16 is complete: added Socket.IO server wiring in `server/src/socket/server.ts` with cookie-handshake auth backed by the existing player session cookie.
- Added `join_game` / `leave_game` room management plus game-room and team-room helpers in `server/src/socket/rooms.ts`.
- Added `server/src/socket/broadcaster.ts` for realtime emits that append `serverTime`, carry `stateVersion`, and call `filterStateForViewer()` before per-socket delivery when a payload contains `snapshot`.
- Lifecycle routes now use the idempotent post-commit hook to broadcast `game_started`, `game_paused`, `game_resumed`, and `game_ended` only after the REST transaction and receipt write succeed.
- Exposed the realtime server and broadcaster as Fastify decorations so later phases can publish authoritative updates without rebuilding the socket layer.
- Added `server/src/socket/realtime.test.ts` covering handshake auth failure, join/leave room behavior with lifecycle broadcasts, and team sub-room broadcasting with viewer filtering.
- Moved `socket.io` into `server/package.json` runtime dependencies and refreshed `pnpm-lock.yaml`.

### Phase 16 Learnings

- Viewer filtering cannot be implemented with a single room-level emit because each socket may need a different filtered snapshot. The broadcaster now resolves room membership first and emits per socket.
- Refreshing the player from the database during `join_game` is the simplest way to keep team-room membership correct after REST-side team changes.
- Fastify shutdown can call the Socket.IO close hook after the underlying HTTP server is already stopped. The realtime hook now tolerates `ERR_SERVER_NOT_RUNNING` during test and app shutdown.
## Phase 17 Notes

- Phase 17 is complete: added `server/src/services/state-service.ts` to build authoritative game snapshots for both REST and socket sync flows.
- Added `GET /game/:id/map-state` in `server/src/routes/state-routes.ts` and registered it in `server/src/app.ts`.
- Snapshot responses now include game, teams, players, zones, challenges, active claims, annotations, and team resource balances for the requested game.
- Annotation visibility is now filtered per viewer: `all` annotations are always visible, and `team` annotations are only visible when the viewer shares the creator's current team.
- `join_game` in `server/src/socket/server.ts` now supports reconnect sync: it emits `game_state_sync` for first join or large gaps, and `game_state_delta` when `lastStateVersion` is still within `MAX_DELTA_SYNC_GAP`.
- Added route coverage in `server/src/routes/state-routes.test.ts` and reconnect coverage in `server/src/socket/realtime.test.ts` for full sync, delta sync, and full-sync fallback behavior.

### Phase 17 Learnings

- REST snapshot assembly and socket reconnect sync need to share the same builder; otherwise visibility and payload shape drift quickly.
- Socket room membership should track the joined team separately from the refreshed player object so a team change can leave the old team room correctly during reconnect.
- Drizzle's PostGIS insert typing is still awkward in tests; geometry-heavy fixture inserts may need explicit casts until a cleaner helper layer exists.

## Phase 18 Notes

- Phase 18 is complete: `POST /challenges/:id/claim` now runs through auth, team check, idempotency, platform GPS validation, and the Territory handler.
- Added `server/src/modes/territory/claim-service.ts` for the transactional claim flow: challenge row lock, game-active check, per-zone GPS override, spatial containment, max-concurrent-claims enforcement, claim insert, challenge update, single state-version increment, and dual event logging.
- `server/src/modes/territory/routes.ts` now dispatches claim actions through `getModeHandlerForGame()` and broadcasts `challenge_claimed` after commit.
- Added `appendEvents()` in `server/src/services/event-service.ts` so one gameplay action can emit multiple events under the same authoritative `stateVersion`.
- Added `CLAIM_TIMEOUT_MINUTES` parsing in `server/src/db/env.ts` and started using it to compute `challenge_claims.expires_at` / `challenges.expires_at` on claim.
- Added `MAX_CONCURRENT_CLAIMS_REACHED` to `shared/src/errors.ts` for the team-claim-cap conflict path.
- Added DB-backed claim coverage in `server/src/modes/territory/routes.test.ts` for success, replay, already claimed, stale GPS, per-zone GPS overrides, outside-zone distance reporting, inactive game, missing team, max claims, and unique-index conflict normalization.

### Phase 18 Learnings

- Gameplay actions need an event helper that can append multiple rows under one `stateVersion`; the old one-event-per-increment helper was not sufficient once Territory flows started emitting both engine and mode events.
- Idempotency tests must reuse the exact same payload, including timestamps, or they will correctly trip request-hash conflicts instead of replaying.
- Drizzle/Postgres unique-constraint failures can arrive wrapped under `cause`; conflict normalization helpers need to inspect nested error objects, not just the top-level exception.

## Phase 19 Notes

- Phase 19 is complete: added `server/src/jobs/claim-timeout.ts` with a periodic claim sweep, immediate startup recovery run, and explicit `stop()` / `runNow()` control for tests and future ops hooks.
- Expiry handling now locks active current claims with `FOR UPDATE SKIP LOCKED`, marks them `expired`, clears the linked challenge back to `available`, increments `stateVersion` once per expired claim, writes `OBJECTIVE_STATE_CHANGED` + `CHALLENGE_RELEASED`, and broadcasts `challenge_released` after commit.
- Pre-expiry handling now scans active current claims inside the warning window, sets `warning_sent = TRUE`, and emits a team notification through the new notification service seam without changing authoritative game state.
- Added `server/src/services/notification-service.ts` as the first notification abstraction and decorated it in `buildApp()` so later push work has a stable integration point.
- `server/src/index.ts` now starts the timeout job on server boot, which gives startup recovery for already-expired claims.
- Added DB-backed coverage in `server/src/jobs/claim-timeout.test.ts` for expiry, warning delivery, and immediate startup recovery.

### Phase 19 Learnings

- Raw `db.execute(sql...)` result rows do not reliably preserve `Date` instances; timeout-job queries need explicit timestamp normalization before building event metadata or notification payloads.
- Startup/background jobs are easier to test when they accept a controllable clock and expose `runNow()` / `stop()` handles instead of burying timing entirely inside `setInterval`.
- The same challenge/claim serializers used by HTTP routes are worth reusing in background jobs; otherwise broadcast payloads and event metadata drift from the authoritative API shape.
