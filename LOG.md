# Project Log

## Purpose

Running handoff log. Keep short, high-signal notes here: environment quirks, implementation decisions, blockers, current status. Update SPEC.md and PLAN.md directly for anything product or architecture related.

---

## Current Snapshot

- Repo: `E:\city game` / WSL: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Branch: `master`
- Date: 2026-04-04
- Stage: **Phases 36–38 complete locally. Join flow + pre-game lobby + countdown live. Active challenge window live. Optional push notifications are wired from the lobby soft-ask through to `/players/me/push-subscribe`. Phase 39 next: Rate Limiting.**

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
- Stale-GPS override uses `window.confirm` — should move to an in-app modal (Phase 39 polish at latest).
- Territory V1 scoring clarification: zones owned is the only player-facing score. Older references to points/coins in frontend planning are deprecated; those remain platform seams for future modes or later Territory variants.

---

## Phases 28–35 Notes (Summary)

- **Phase 28–29:** Mapbox map shell + Socket.IO live sync. Dev proxy fix (`/api` prefix). `ZoneLayer` uses React state for map instance. Version ordering, gap recovery, reconnect banner.
- **Phase 30:** Portable challenge deck; fixed hooks naming, click bubbling, setPointerCapture timing. City seed scripts: `db:seed:toronto`, `db:seed:chicago` (destructive).
- **Phase 31:** GPS-gated completion flow; `useIdempotentAction`; mobile-first UI overhaul; swipe-up/down deck gestures; completed cards tray.
- **Phase 32:** Team control strip; mini/full scoreboard; live feed overlay; toast stack; rival capture toasts.
- **Phase 33:** Admin zone editor (`/admin/zones`) — draw-split, snap, merge, GeoJSON/OSM import. Migration 0003.
- **Phase 34:** Challenge Keeper (`/admin/challenges`) — authored challenge sets, portable/zone/point items, runtime cloning. Migration 0004. Point-linked authored items. split-route compatibility fix.
- **Phase 35:** Admin panel (`/admin`) — game lifecycle, team management, overrides, scoreboard view.

Dev seed join codes: Winnipeg `RED12345`/`BLUE1234`/`GOLD1234`, Chicago `CHIBLUE1`/`CHIGOLD1`/`CHIRED01`.

---

## Phase 31–35 Notes

See the Phases 28–35 summary block above and the git log for full detail. Key decisions worth keeping:

- **Phase 31:** `useIdempotentAction` deduplicates in-flight calls by key. Swipe thresholds: close deltaY > 80px or deltaY > 30px + velocity > 0.5 px/ms; reveal-completed deltaY < −50px or deltaY < −20px + velocity < −0.4 px/ms. Resistance factor on upward overscroll: 0.25×. Deck close is two-stage (spring eject then pill reappear after 400ms).
- **Phase 32:** Feed suppresses per-player / per-challenge duplicate narration for captures — shows team control outcome only. Standings/feed/hamburger sheet all support swipe-down-to-close. Completed cards pan map to captured zone on click.
- **Phase 33:** `sanitizeFeatureCollection()` strips `id`/`crs` fields rejected by Fastify strict schema. Fastify body limit raised to 50 MB. Authored-map routes bypass idempotency middleware (no `game_id` FK on `action_receipts`). Distance tool deferred to Future Work.
- **Phase 34:** Point-linked authored items store GeoJSON point in `challenge_set_items.config.map_point`. Admin UI no longer exposes `kind` or `completionMode` — backend defaults to `text` / `self_report`. Full server suite has nondeterministic test-DB contamination on reruns (pre-existing, unrelated to Phase 34 code).
- **Phase 35:** `requireAdmin` is a no-op; admin routes are intentionally unauthenticated for local V1. `GET /games` and `PATCH /teams/:id` added to backend in this phase.


## Phase 36 Notes

- `Landing.tsx` is replaced by a persisted Zustand-backed `JoinFlow` with `home -> team_picker -> lobby -> countdown` states. Root `/` is now the join flow.
- Team picker is zero-knowledge: players never see join codes; the client uses existing team data and submits the hidden `join_code` for the selected team.
- Lobby uses authored map geometry (`map_definitions` + `map_zones`), not runtime game zones, so it works before `start` clones runtime zones.
- Added the missing `player_joined` socket broadcast on team join. Phase 36 depends on that event for live roster updates in the lobby.
- `suppressAutoEnter` behavior is preserved: leaving the live map returns to `/` without immediately re-entering active gameplay; the home screen offers `Return to Game` instead.

## Phase 37 Notes

- Runtime `challenges` now carry `sort_order` and `is_deck_active`. Migration `0005_flaky_infant_terrible.sql` adds the fields and index.
- `game.settings.active_challenge_count` is normalized on create/update with a default of `3`. On `start`, the first N cloned runtime challenges are activated and `game.settings.challenge_total_count` is stored for client progress text.
- Player snapshots now hide queued runtime challenges. Admin/runtime challenge lists still show all challenges, with queued vs active visible in `/admin`.
- Completing a challenge now promotes the next queued one inside the same DB transaction and appends `CHALLENGE_SPAWNED` in the same `state_version`.
- Client deck now follows server sort order, truncates headers to 38 chars, shows deck progress, and animates newly activated cards. Feed now renders `CHALLENGE_SPAWNED` as `New challenge: ...`.
- Pre-game lobby now supports `Leave` before start via `POST /players/me/leave-team`, with a `player_joined` broadcast carrying `team: null` so other lobby clients update immediately.
- Validation that passed: `pnpm db:generate`, `pnpm db:migrate`, `pnpm --filter @city-game/server exec vitest run src/routes/challenge-set-routes.test.ts src/modes/territory/complete-routes.test.ts`, `pnpm --filter @city-game/server exec vitest run src/routes/game-routes.test.ts`, `pnpm -r typecheck`, `pnpm -r build`.
- Full server suite still has the known auth expectation failure in `src/lib/auth.test.ts` because local V1 keeps admin auth disabled. That is pre-existing and outside Phase 37.

## Phase 38 Notes

- Phase 38 is frontend-only. Backend push support was already present (`web-push`, VAPID config, `/players/me/push-subscribe`, rival-capture trigger).
- Added a minimal push-only service worker at `client/public/sw.js`. It handles `push` and `notificationclick` only; no fetch interception, caching, manifest, or install UX.
- App now registers the service worker on mount. Lobby shows a soft-ask banner after team join when push is supported, permission is not denied, and the current player has no stored subscription.
- `Not now` is persisted per `gameId + playerId` in local storage. `Enable` requests browser permission, subscribes with `VITE_VAPID_PUBLIC_KEY`, and posts the serialized `PushSubscription` to `/players/me/push-subscribe`.
- If permission is denied or the browser lacks Push/ServiceWorker support, the lobby proceeds silently with no blocking UI.
- Validation that passed: `pnpm --filter @city-game/client exec tsc -b --pretty false`, `pnpm --filter @city-game/client build`, `pnpm -r typecheck`, `pnpm -r build`.
