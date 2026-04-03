# Project Log

## Purpose

Running handoff log. Keep short, high-signal notes here: environment quirks, implementation decisions, blockers, current status. Update SPEC.md and PLAN.md directly for anything product or architecture related.

---

## Current Snapshot

- Repo: `E:\city game` / WSL: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Branch: `master`
- Date: 2026-04-03
- Stage: **Phase 31 complete. Mobile-first UI live: floating card deck, swipe gestures, hamburger menu, GPS-driven portable completion flow. Phase 32 next: team control HUD, zone-only scoreboard, live feed, toasts.**

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

## Phases 28–30 Notes (Summary)

- **Phase 28:** Landing auto-discovers active game. Registration + team join hit real backend. Full-screen Mapbox with team-colored zone polygons. Dev proxy fix (Vite was stripping `/api` prefix). `ZoneLayer` fixed to use React state for map instance (ref-only wiring didn't mount). `VITE_MAPBOX_ACCESS_TOKEN` read from repo-root `.env`.
- **Phase 29:** Socket.IO client wired with cookie auth. Reconnect re-emits `join_game`. Version ordering: ignore stale, gap → full sync. Per-version dedupe handles same-version sibling events. Reconnect banner in UI.
- **Phase 30:** Pivoted to portable challenge deck (no map pins, no zone detail sheet). Deck is horizontal card tray with drag-scroll, collapsible dock. Fixed three bugs in `ChallengeDeck.tsx`: hooks naming violation (`createDragRefs` → `useDragRefs`), click bubbling resetting confirm state, `setPointerCapture` timing. City seed scripts added: `db:seed:toronto`, `db:seed:chicago` (destructive — each truncates live data).

Dev seed join codes: Winnipeg `RED12345`/`BLUE1234`/`GOLD1234`, Chicago `CHIBLUE1`/`CHIGOLD1`/`CHIRED01`.

---

## Phase 31 Notes

**Backend additions:**
- `POST /challenges/:id/complete` now accepts optional nested `gps` body. When challenge is `available` + `config.portable = true`, Territory complete service resolves the player's current zone from GPS and completes atomically in one transaction — no separate `challenge_claimed` event emitted (rival teams don't see an in-progress state for portable cards).
- Portable claim timeout job and release both clear `zoneId` on the challenge when a portable claim ends.
- `/claim` and `/release` still exist for platform completeness and tests; not used by the primary frontend.

**Frontend completion flow:**
- `useIdempotentAction` deduplicates in-flight calls by key; callers always get back the same promise while a request is in flight.
- `useGeolocation` runs `watchPosition` continuously; `refresh()` calls `getCurrentPosition` on demand before a claim if no fix is cached.
- `GPS_TOO_OLD` → confirm dialog → retry with overridden `capturedAt: new Date().toISOString()`. Error in retry is wrapped in its own try/catch so toast fires rather than being silently swallowed.
- Optimistic Zustand update on action start; socket arrival reconciles the authoritative state.
- Deck shows only `available` challenges. Completed cards move to archived tray below the deck.

**Mobile-first UI overhaul:**
- Full-screen map on mobile; no fixed chrome columns.
- Mobile top bar (`sm:hidden`): current zone pill + ☰ hamburger. Menu overlay: fixed bottom sheet with game name, player, team, Back to Lobby.
- Desktop HUD (`hidden sm:flex`): left column with Field Brief card, GPS status pill, full deck with Prev/Next + counts, always-visible completed section, Back to Lobby.
- Mobile deck: pill button (`sm:hidden`) when closed → tapping slides deck up from bottom (400ms spring). Drag handle at top. Swipe-down to close, swipe-up to reveal completed tray.
- `touch-action: none` on deck wrapper + `e.preventDefault()` on committed drag prevents viewport pan competing with custom swipe gesture detection.
- Completed tray uses `max-height` + `opacity` CSS transition (500ms spring) — chosen over translate-based because the deck is bottom-anchored and content below it naturally expands toward the bottom edge.
- Deck close is two-stage: `setDeckDragY(500)` immediately (spring eject), then `setIsDeckOpen(false)` after 400ms so pill button reappears only after animation completes.
- Removed Mapbox `NavigationControl` (zoom buttons) — map is a backdrop.
- Removed scoring/reward pills from all cards and modals (V1 does not display points/coins to players).
- Card selection: amber outline ring only; no "Selected" badge.

**Swipe thresholds:**
- Close: deltaY > 80px, or deltaY > 30px + velocity > 0.5 px/ms
- Show completed: deltaY < −50px, or deltaY < −20px + velocity < −0.4 px/ms
- Resistance factor on upward overscroll: 0.25×

**Validation:**
- `pnpm -r typecheck && pnpm -r build && pnpm --filter @city-game/server test`
- Manual: Chicago seed → join → open deck → swipe → claim challenge → zone captures → completed tray appears correctly.
- Current seed: `Chicago Territory Demo` — join codes `CHIBLUE1` / `CHIGOLD1` / `CHIRED01`

## Phase 32 Notes

**Territory V1 control HUD:**
- Scoreboard presentation is now zone-only. Backend Territory standings sort by `zoneCount desc`, then team name/id for deterministic ties. Resource balances remain in platform data but are intentionally ignored by V1 ranking and UI.
- New client-side panels in `client/src/features/game/Phase32Panels.tsx`: `TeamControlStrip`, `MiniScoreboardCard`, full standings overlay, and live feed overlay.
- Mobile HUD keeps the map clear: top bar shows current zone + menu, and a compact team control strip sits below it. Menu now opens `Standings` and `Feed` instead of forcing those onto the map surface.
- Desktop HUD keeps the existing field brief and status cards, with a standings card added as a second warm-paper module rather than a separate app-like pane.

**Live feed / toast behavior:**
- Feed overlay fetches `GET /game/:id/events?limit=40` on demand and renders the recent visible control history.
- Realtime direct socket events synthesize lightweight `GameEventRecord` entries client-side for immediate feed updates while the overlay is open or cached. Only event types already surfaced in Phase 32 are synthesized: zone capture, challenge complete, game lifecycle, and player join.
- Rival `zone_captured` and `game_ended` socket events now trigger neutral info toasts. Toasts support `success`, `error`, and `info`, plus optional team-color accent dots.

**Design constraints kept in this pass:**
- No points / coins / resource counters in the player-facing HUD.
- Overlays use the same cartographic warm-paper treatment as the deck instead of introducing bright app-chrome panels.
- Phase 31 deck interactions, map behavior, and mobile sheet layout were preserved; this phase only adds control/status surfaces around them.

**Validation:**
- `pnpm --filter @city-game/server exec vitest run src/routes/scoreboard-routes.test.ts`
- `pnpm --filter @city-game/client exec tsc -b --pretty false`
- `pnpm --filter @city-game/client build`
- `pnpm -r typecheck`
- `pnpm -r build`

**Phase 32 compactness follow-up:**
- Mobile top bar now uses three compact pills only: team, zone count, current zone. The separate collapsible control strip was removed.
- Standings overlay was compressed: no game title, no duplicate sublabel under each team, just rank/name on the left and `Zones N` on the right.
- Feed now suppresses per-player / per-challenge duplicate narration for captures. Territory V1 feed shows the team control outcome (`Team captured Zone`) plus lifecycle events.
- Standings, feed, and the mobile hamburger sheet all support swipe-down-to-close from their sheet header / grab area.
- Completed cards now show a team-color dot and clicking a completed card pans the map to the captured zone.

