# Project Log

## Purpose

Running handoff log. Keep short, high-signal notes here: environment quirks, implementation decisions, blockers, current status. Update SPEC.md and PLAN.md directly for anything product or architecture related.

---

## Current Snapshot

- Repo: `E:\city game` / WSL: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Branch: `master`
- Date: 2026-04-01
- Stage: **Phase 30 in progress. Frontend map view is being simplified around a portable challenge deck instead of map markers and zone detail.**

---

## Environment

### WSL / Node / Package Manager

- Development is **WSL-first**. Use `pnpm` from WSL (`Ubuntu`, WSL 2).
- Linux Node installed via `nvm` at `/home/saamo/.nvm` — `node v20.20.2`, `pnpm v10.33.0`.
- WebStorm run configs call into WSL directly (see `.idea/runConfigurations/`).
- Do **not** use the Windows `npm`/`pnpm` path for this repo.
- `nvm` loads automatically in login shells via `~/.profile` and `~/.bashrc`.

### Docker / Database

- Docker Desktop (Windows, v24.0.2) is the daemon; reachable from WSL via `docker.exe`.
- WSL-native `docker` is not installed. Repo scripts use `scripts/docker-compose.sh` which prefers Linux `docker compose` and falls back to `docker.exe compose`.
- `psql` available on Windows (PostgreSQL 10.18).
- `pnpm db:up` → local PostGIS container. `pnpm db:migrate` → migrations. `pnpm db:test:create` → test DB.

### Vitest

- `fileParallelism: false` and `maxWorkers: 1` / `minWorkers: 1` in `server/vitest.config.ts` — DB-backed suites share one test database; parallel workers cause truncation races.
- To run a single test file: `pnpm --filter @city-game/server exec vitest run <path>` (the `test` script wrapper always runs the full suite).

### Misc

- One-off `tsx` scripts use `node --import tsx` to avoid ENOTSUP IPC errors in this WSL/filesystem setup.
- Phase 8 uses the public Overpass API by default; set `OVERPASS_API_URL` env var for a private endpoint if rate limits become an issue.
- There is a leftover top-level `src/` directory from the original stub (empty, harmless).

---

## Key Implementation Decisions

These are non-obvious choices made during development that aren't in the spec.

- **Idempotency for 204 responses:** Stores `{}` (not `null`) in the `response` jsonb column; replays still send an empty 204.
- **action_receipts schema extension:** `player_id` is nullable, `scope_key` was added (`player:<id>`, `admin`, `public`), `response_headers` was added for `Set-Cookie` replay. Request fingerprinting hashes `params + query + body` (not just body) to prevent key reuse across different routes.
- **OSM preview endpoint:** Marked `config.skipIdempotency = true` — it's a POST with no state mutation.
- **Zero-balance resource seeding:** `seedInitialBalances()` supports `includeZeroBalances: true` so game start writes explicit seed rows rather than relying on implicit empty-balance reads. Makes resource initialization observable in tests.
- **Socket viewer filtering:** Cannot use a single room-level emit because each socket may need a different filtered snapshot. Broadcaster resolves room membership and emits per-socket.
- **Win condition evaluator:** Originally used `Promise.all()` on a single transaction client, which triggered pg deprecation warnings. Final version runs reads sequentially.
- **Team-only annotation visibility:** Derived from the creator player's current `teamId` (not a stored team owner on the annotation). Admin annotations are forced to `visibility: 'all'` since they have no player/team owner.
- **Resource lock target:** `FOR UPDATE` is taken on the scope row (`teams` or `players`) to serialize concurrent ledger writes even when no prior ledger row exists for that resource type.

---

## Architectural Decisions Made at Phase 27 Checkpoint

These were identified as flexibility improvements before frontend work begins:

- **Zone geometry changed from `GEOMETRY(Polygon, 4326)` to `GEOMETRY(Geometry, 4326)`** — supports Point zones (stations, landmarks), Polygon zones (areas), and MultiPolygon. `ST_Buffer` and `ST_Covers` work identically across all types. Point zones use `claim_radius_meters` as the capture circle radius. Shared `Zone.geometry` type updated to `GeoJsonGeometry`.
- **Resource award loop iterates `challenge.scoring` keys, not a global enum** — modes may define their own resource type strings without changing shared constants. `ResourceAwardMap` relaxed accordingly.
- **Claim timeout is now per-game configurable** — `game.settings.claim_timeout_minutes` overrides the `CLAIM_TIMEOUT_MINUTES` env default. Matches the pattern already used by `max_concurrent_claims`.

---

## Known Gaps

- No monorepo README.
- `challenge.kind`, `challenge.config`, and `completionMode` are stored but not dispatched on — all challenges complete identically in V1 (self-report). Branching on completion mode is post-V1.
- `filterStateForViewer` is an identity function in Territory. The seam is in place for asymmetric visibility modes (hide-and-seek, tag).
- `.DS_Store` is tracked in git.

---

## Phase 28 Notes

- Frontend Phase 28 is now live in `client/`:
  - landing flow auto-discovers `GET /api/v1/game/active`
  - direct `/game/:id` routing is supported without adding a router dependency yet
  - player registration and team join hit the real backend with cookie auth and generated `Idempotency-Key` headers
  - map view initializes from `GET /api/v1/game/:id/map-state`
  - zones render from authoritative snapshot data with owner-team colors
- `VITE_MAPBOX_ACCESS_TOKEN` is read from the repo-root `.env` via `client/vite.config.ts` (`envDir: '..'`).
- Mapbox is intentionally split into its own Rollup chunk. The vendor payload is still large, but it is now isolated from the app shell and lazy-loaded behind the game route.
- Added `@types/geojson` on the client because `mapbox-gl` layer typing pulls `geojson` module types during TypeScript build.
- Manual local test loop for frontend work:
  - `pnpm db:up`
  - `pnpm db:migrate`
  - `pnpm dev`
  - open `http://localhost:5173`
- Useful WebStorm configs remain: `DB Up`, `DB Migrate`, `Dev All`, `Validate`.

---

## Dev Seed

- Added `pnpm db:seed:dev` and `DB Seed Dev` WebStorm run config.
- The seed script creates or reuses a single dev Territory game and avoids creating a second active game if one already exists.
- Seed data includes:
  - 1 active game centered on Winnipeg
  - 3 teams with fixed join codes
  - 5 zones (mix of polygon and point zones)
  - 5 available challenges
- Current seeded game: created or reused on demand by `pnpm db:seed:dev`; the game id is intentionally not fixed anymore because completed seeds are replaced with a fresh active game.
  - join codes: `RED12345`, `BLUE1234`, `GOLD1234`
- Implementation note: zone creation in the seed script is intentionally sequential inside the transaction to avoid the `pg` deprecation warning triggered by concurrent queries on a single transaction client.
- Fixed a Phase 28 dev proxy bug: Vite was stripping `/api` before forwarding, which turned `/api/v1/...` into `/v1/...` and made the frontend look like there was no active game. The client proxy now forwards `/api/v1` unchanged to the Fastify server on port 3000.
- Phase 28 follow-up fixes:
  - `ZoneLayer` now receives a real map instance via React state. The previous ref-only wiring meant the layer never mounted against a live `mapbox-gl` instance, so zones were not rendered even though the snapshot loaded.
  - `Leave Map` now suppresses automatic re-entry on the landing screen for the current browser session. The prior behavior immediately re-opened the map because the existing player session already had a team.
  - Vite proxy bug and map-instance bug together were the two blockers behind the initial frontend test failures.
- Frontend visual direction is now explicitly pivoting toward the updated spec: warmer parchment/expedition chrome, serif headers, denser information layout, and quieter map backdrop. This is a starting point, not the final visual system.

---

## Phase 29 Notes

- Frontend realtime sync is now wired through `socket.io-client` in the game view:
  - client connects only after the initial `/game/:id/map-state` snapshot succeeds
  - every socket `connect` re-emits `join_game` with the latest known `stateVersion`
  - reconnects therefore restore room membership correctly instead of silently staying unsubscribed
- Client-side sync behavior now follows the platform rule with one important nuance:
  - delta batches ignore events older than the current version and request a full sync on a version gap
  - direct socket payloads also force a full sync on a version gap
  - exact same-version direct payloads are still allowed once per event key because the server may emit multiple sibling realtime events with the same `stateVersion` for a single transaction (for example `challenge_completed` + `zone_captured` + multiple `resource_changed` payloads)
- The client keeps a small per-version dedupe map for direct realtime payloads. This prevents duplicate processing during reconnect jitter without dropping legitimate same-version sibling events.
- Connection state is surfaced in the map UI with explicit `connecting`, `reconnecting`, and `error` banners so manual testing does not depend on browser devtools.
- `socket.io-client` was added to the client workspace for Phase 29.

---

## Phase 30 Notes

- Product direction changed before Phase 30 stabilized: the first playable Territory draft now uses a **portable challenge deck** instead of challenge markers tied to map locations.
- Main map view requirements now are:
  - colored ownership zones only
  - no challenge pins
  - no zone detail bottom sheet
  - compact card-style challenge deck over the map chrome
- The deck is selectable in the client so Phase 31 can attach completion actions to the chosen card without reintroducing map marker selection.
- Spec and plan were updated at the same time as the client so future phases build against the new loop rather than the earlier marker-based design.
- Live state sync remains in place; the Phase 30 pivot is a gameplay/UI change, not a realtime architecture change.
- Phase 30 follow-up polish: zone fills were desaturated, the separate selected-card summary was removed, the deck became a collapsible dock, explicit Prev/Next deck controls were added, and challenge details moved into a modal instead of permanent inline chrome.
- WebStorm shared run configs now use native npm run configurations with the WSL Node interpreter instead of shell scripts. The example `dev.xml` is the template; other configs point at root scripts such as `build`, `typecheck`, `db:migrate`, and `validate`.
- Added city seed scripts for `db:seed:toronto` and `db:seed:chicago`, with matching WebStorm npm run configs. These two scripts are destructive by design: each truncates live game data before seeding its city demo, so run them one at a time.

---

## Phase 31 Notes

- Portable challenge flow is now live end to end:
  - seeded city demos create portable deck cards with `config.portable = true` and no fixed `zoneId`
  - claiming a portable card resolves the player’s current zone from GPS on the server and binds the challenge to that zone for the duration of the claim
  - releasing or expiring a portable claim clears that temporary `zoneId` again so the card returns to the shared deck cleanly
- Frontend card actions are now active in the deck itself:
  - selected cards can `Claim Here`, `Complete`, and `Release`
  - claimed cards show a live countdown driven from `challenge.expiresAt`
  - completion accepts an optional short note and sends it as self-report submission payload
  - long descriptions come from `challenge.config.long_description`; short card copy comes from `challenge.config.short_description`
- Client-side deck flow is intentionally immediate:
  - `useIdempotentAction` collapses repeated clicks on the same action while a request is in flight
  - successful HTTP mutation responses are applied to the Zustand snapshot immediately via the same reducers used by realtime events
  - socket updates still arrive and remain authoritative, but the UI no longer waits on the round-trip to reflect the action
- Added browser geolocation hook for the live game view:
  - watches location continuously with more aggressive options while the tab is visible
  - supports on-demand refresh before a claim if there is no fresh fix yet
  - current zone is inferred client-side from the latest GPS point and rendered in the deck/header as advisory context only; the server remains authoritative for actual claim resolution
- Added portable regression coverage:
  - claim route assigns `zoneId` when claiming a portable card
  - release route clears `zoneId` when a portable claim is released
  - claim-timeout job clears `zoneId` when a portable claim expires
- Current local test loop for Phase 31:
  - `pnpm db:up`
  - `pnpm db:migrate`
  - `pnpm db:seed:dev` or `pnpm db:seed:toronto` or `pnpm db:seed:chicago`
  - `pnpm dev`
  - open the seeded game and test claim/complete/release from the deck while standing inside a visible zone
- Phase 31 follow-up changed the playable loop again before commit:
  - the first draft no longer exposes a visible `claimed` in-progress state in the frontend
  - the main deck now shows only `available` cards
  - completed cards move into a separate, low-priority archive tray that still uses the card motif and shows the team that finished each card
- Portable direct completion is now supported on the backend:
  - `POST /api/v1/challenges/:id/complete` accepts optional nested `gps`
  - when a challenge is `available` and `config.portable = true`, the Territory complete service resolves the player's current zone from GPS and completes the card atomically in one transaction
  - this path emits completion/capture/resource events only; it does not emit a separate `challenge_claimed` event, so rival teams do not see an in-progress claim state for portable cards
- The old `/claim` and `/release` endpoints still exist for platform completeness and tests, but the primary frontend no longer uses them for the portable deck loop.
- GPS stale-reading handling changed at the UX layer:
  - stale GPS still returns `GPS_TOO_OLD` from the server validation middleware
  - the frontend now offers an override confirm and retries the same capture request with a fresh `capturedAt` timestamp if the player accepts
  - this keeps the strict server validation behavior intact for other routes while allowing the specific game override the user requested
- Map interaction changes:
  - the live view now shows the browser's current location as a marker on the map when geolocation is available
  - card drag-scroll now works over static reward chips/text because only actual buttons are marked as interactive targets
- Card copy/UI changes:
  - zone labels now render as just the zone name instead of `Zone <name>`
  - the selected-card action area is reduced to a single `Claim` action plus `Details`
  - generic claim/release explanatory copy was removed to keep the deck terse for experienced players
- Seed scripts changed again:
  - Winnipeg/Toronto/Chicago sample seeds no longer create point zones
  - all current sample zones are polygon areas so the first manual playtest matches the intended city-control look
- Validation after the follow-up changes:
  - `pnpm --filter @city-game/client exec tsc -b --pretty false`
  - `pnpm --filter @city-game/server exec tsc -b --pretty false`
  - `pnpm --filter @city-game/server exec vitest run src/modes/territory/complete-routes.test.ts src/modes/territory/routes.test.ts`
  - `pnpm --filter @city-game/server test`
  - `pnpm -r typecheck`
  - `pnpm -r build`
  - `pnpm db:seed:chicago`
- Current manual test state after reseed:
  - active game: `Chicago Territory Demo`
  - game id: `c85e9bf1-3c31-45dd-a2db-ba01ba46269f`
  - join codes: `CHIBLUE1`, `CHIGOLD1`, `CHIRED01`

- Phase 31 UI follow-up: fixed challenge selection by making the card itself select reliably, removed the normal browser confirm from the claim flow, and replaced the completed-card tray with a plain readable vertical archive. The stale-GPS override still uses a browser confirm and should move to an in-app warning/modal later.
