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
- Date of latest update: 2026-03-30
- Product goal: location-based multiplayer game platform, with Territory as the first mode
- Current implementation stage: Phase 15 game lifecycle complete

---

## What Has Been Done

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
- Server tests passed, including AppError, validation-error, auth middleware, game/team route coverage, player route coverage, zone route coverage, challenge route coverage, resource route coverage, event route coverage, resource-service coverage, event-service coverage, spatial-service coverage, OSM preview route coverage, and OSM import service coverage
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

1. Proceed to Phase 16 Socket.IO server and connection auth.
2. Reuse the new lifecycle service and `X-State-Version` header pattern for future mutating gameplay routes.
3. Keep expanding route-level schemas so request validation stays centralized through the Fastify error handler.

---

## Handoff Notes For The Next Agent

- Read `SPEC.md`, `PLAN.md`, and this file first.
- The monorepo scaffold is already in place and healthy in WSL.
- Use WSL as the source of truth for repo work.
- Use the Linux Node install from `nvm`, not the Windows Node install.
- If a shell does not see the Linux Node install, check `~/.profile` and `~/.bashrc`.
- The next highest-value work is Phase 16 Socket.IO server and connection auth.

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
