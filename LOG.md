# Project Log

## Purpose

Running handoff log. Keep short, high-signal notes here: environment quirks, implementation decisions, blockers, current status. Update SPEC.md and PLAN.md directly for anything product or architecture related.

---

## Current Snapshot

- Repo: `E:\city game` / WSL: `/mnt/e/city game`
- Remote: `origin -> https://github.com/Saamoz/city-game.git`
- Branch: `master`
- Date: 2026-04-08
- Stage: **Phases 36–38 complete. Overlay UX overhaul + card fan deck complete (see Phase 39 UX Notes below). Phase 39 backend next: Rate Limiting.**

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

- **Phase 31:** `useIdempotentAction` deduplicates in-flight calls by key. Original deck used a pill button toggle; swipe gestures and thresholds established here (close >80px, reveal-completed <−50px). See Phase 39 UX Notes for the card fan overhaul that superseded the pill button.
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

## Lobby Start Notes

- Non-admin game start is now available from the pre-game lobby. `POST /players/me/ready` stores readiness in `players.metadata.lobby_ready`; `POST /players/me/start-game` validates that every teamed player is ready, then reuses the existing lifecycle start transition.
- Team join, leave, and admin-driven team moves all force `lobby_ready` back to `false` so a stale ready flag cannot carry across team changes.
- Lobby realtime still uses the existing `player_joined` event for roster refresh. Ready toggles broadcast through that same event, which keeps the client changes small and avoids adding another socket event for one lobby-only concern.

## Phase 39 UX Notes

Significant mobile game view UX overhaul shipped before backend Phase 39 (rate limiting).

**Overlay fixes (commit c53ff14):**
- Scoreboard, Feed, and hamburger menu bottom sheets could not be swiped to close. Root cause: `setPointerCapture` was called lazily in `pointermove` instead of `pointerdown`, and `onPointerMoveCapture` on the container was intercepting events in React's capture phase before they reached the drag handle. Fixed both.
- All three overlays now use `pointer-events-none` on the backdrop wrapper — map stays fully interactive behind open overlays.
- Removed `onPointerMoveCapture` / `onTouchMoveCapture` stop-propagation calls (never affected Mapbox, which uses native DOM events).
- Tightened UI density throughout: smaller padding, reduced max-height (88vh → 72vh), smaller type.

**Card fan deck (commit 80266ba):**
- Replaced the "Field Deck ▲" pill button with a persistent card fan that peeks 72px above the screen bottom.
- Three cards stack using negative `marginLeft` with fan rotations. Front card shows "Challenge Deck" centered; other cards hidden beneath.
- Tap or swipe up → cards spread to full open deck. `marginLeft` and wrapper `translateY` animate simultaneously on the same 0.44s spring, producing a diagonal motion.
- Swipe down when open → collapses to fan, deselects selected card.
- Outer wrapper `pointer-events-none`; peek container `pointer-events-none`; only the `w-fit` card stack is interactive — map fully usable beside and below the fan.
- Claim button always rendered (invisible when not selected) to prevent card resize on selection.


## Spectator + Team Location Notes (2026-04-16)

- Spectator home view no longer uses the large centered copy block once a game is closed to joining. It now leaves the map interactive and only overlays a small `Spectator View` badge plus `Return to Game` when the same browser session is on a team.
- Spectator map now remains pannable / zoomable; the overlay shell uses `pointer-events-none` so the map takes drag and wheel input directly.
- Added aggregated `teamLocations` to shared state. Runtime players never receive raw per-player coordinates in `/map-state` or public roster responses; the client only renders per-team latest positions.
- Player location uploads are now used as a lightweight heartbeat during active games. The client keeps sending the latest GPS sample on an 8s best-effort loop instead of posting every geolocation watcher update.
- Admin game setup now includes `broadcast_team_locations`. When enabled, active players receive live team markers; spectator view still fetches team locations from the public spectator route by design.
- Validation completed: server TypeScript, client TypeScript, and client production build all passed.
- DB-backed realtime test remains environment-gated in WSL until Postgres is reachable on `127.0.0.1:5432`.

## Zone Editor Rework Notes (2026-07-16)

The admin map editor's geometry editing was rebuilt around a **shared-node topology session** instead of per-zone polygon editing with diff-based propagation.

**Why:** `propagateSharedBoundaryEdit` inferred edits by diffing old/new polygons and re-finding shared vertices by exact coordinate match — fragile (one vertex per edit, wrong alignments on symmetric rings, missed near-identical coordinates → gaps → gap-healing machinery). T-junctions were unrepresentable, and the deferred `map_zones_connected` constraint rejected edits at COMMIT with an opaque error; a dirty map blocked all writes including fixes.

**New model:**
- `shared/src/zone-graph.ts` — builds a shared-node graph from all zone polygons: vertices within 10cm weld into single nodes; vertices lying on another zone's segment become true shared T-junction nodes. Rings are node-id sequences, so shared boundaries are shared by construction; extraction rebuilds polygons. Ops: move/delete/insert-on-edge/weld-node/weld-into-edge. Pure + unit-tested (`server/src/services/zone-graph.test.ts`).
- `client .../zoneGraphEditor.ts` — map-wide "Edit Boundaries" mode: every corner is a draggable dot (dragging a T-junction reshapes all 3 zones), shift+drag marquee, group drag, midpoint dots insert vertices on both sides of an edge, drag-onto-node/edge welds boundaries, Delete/undo/redo. Replaces mapbox-draw `direct_select` + the custom edge-drag mode (`edgeDirectSelectMode.ts` deleted; edge-drag dropped intentionally).
- Save is atomic: `POST /maps/:id/zones/geometries` writes every changed zone in one transaction (`updateMapZoneGeometries`).
- Drawing a zone now **carves**: the new zone keeps its drawn shape and takes the overlapped ground from existing zones (`POST /maps/:id/zones` with `carve: true` → `createMapZoneCarve`; refuses to swallow a zone whole). Client-side auto-clip removed.
- All map-zone writes (create/update/delete/split/merge/import/bulk) now go through `runMapZoneWrite`: constraint enforced when the map was clean before the edit, suspended when it was already dirty — so a dirty map no longer bricks the editor. Violations return actionable messages (`assertMapPartitionValid` names the overlapping zone pairs) instead of the raw trigger error.
- `PATCH /map-zones/:id` with geometry (and its server-side propagation) is kept for API compatibility; the editor no longer sends geometry through it.

## Zone Edit Repro Logging Rule (2026-07-17)

**Rule: every zone-geometry write from the map editor is logged on the server with enough detail to reproduce it exactly — always on, no flag.**

- `server/src/lib/zone-edit-repro.ts` (`recordZoneEdit`) writes a self-contained JSON file per edit to `server/zone-edit-logs/` (gitignored, capped at 200 newest). Each file has the exact `updates` (zoneId, name, the written geometry, and the previous geometry) plus the outcome. Both successes (`-ok-`) and failures (`-FAIL-`) are recorded.
- A one-line summary prints to the server console on every save: `console.log` for OK, `console.error` for FAIL. The FAIL line includes the failing zone, the PostGIS `ST_IsValidReason`, and the ready-to-run replay command.
- `server/src/db/scripts/replay-zone-edit.ts <file> [--apply]` replays a logged edit: by default it re-runs `ST_IsValid`/`ST_IsValidReason` on each written geometry (deterministic, no side effects); `--apply` re-runs the full `updateMapZoneGeometries` transaction against the still-existing map.
- Wired into `updateMapZoneGeometries` (boundary "move" saves) and `createMapZoneCarve` (draw). `validateGeometry` now takes an optional `{ id, name }` and puts the zone name + reason into both the client-facing message ("Zone \"X\" has an invalid shape after this edit: Self-intersection[…]. Nothing was saved.") and the repro `details`.
- Note: free-hand node dragging can still produce a self-intersecting ring (dragging a corner across the polygon's own edges) — PostGIS rejects it and nothing is saved. The logging rule exists so any such failing move can be handed over and reproduced deterministically rather than re-enacted by hand.

## Zone Partition Tolerance + Playable Seeds (2026-10-01)

**Why:** the exact-geometry partition rules rejected real maps over centimetre slivers (prod "Toronto Fixed": a 0.35 m² overlap, and a zone whose border crosses its neighbour's at a shallow angle so they share only points). Every sample seed was isolated squares, so none could start a game.

- Migration `0013_zone_partition_tolerance.sql`: `zone_overlap_is_significant` ignores overlaps that vanish when shrunk by 0.5 m; `zones_are_adjacent` accepts an exact shared edge or ≥5 m of boundary within 0.5 m. Map and runtime connectivity/overlap functions use both; `getMapPlayability` and `checkMapZonePartition` call the overlap helper too. Player location checks already buffer zones by 40 m, so slivers this thin have no gameplay effect.
- Seeds: Chicago and Toronto load real neighbourhood boundaries from prod (`server/src/db/scripts/fixtures/`); the Winnipeg dev seed tiles a grid (`gridCellPolygon`).
- Tests: fixtures that inserted unconnected runtime zones now tile; the admin-auth test now asserts the intentional V1 no-op.
- The intermittent TRUNCATE deadlock in tests was post-commit hooks (win checks, broadcasts) still running after the response was sent. `executeIdempotentMutation` now tracks them and the app's `onClose` waits for them (`waitForPostCommitWork`).

## Point Challenges: Pinned + Anywhere (2026-10-02)

**Why:** point-linked sets required every item to have a map point, so a Point Challenge game couldn't include tasks that work anywhere (or at any place of a kind, e.g. "any café").

- Point-linked sets now accept pinned items (map point) and anywhere items (no placement). Zone items are still rejected. Anywhere items can carry an optional `config.location_hint` ("Any café") shown on the card; it is a label only, not GPS-checked.
- Runtime: pins all start active and show as map markers; anywhere items form the deck (`active_challenge_count` cards dealt, refilled on completion). Completing a pin no longer deals an extra deck card.
- In `point_challenge` games, anywhere cards complete without a zone (`completeAnywhereChallengeDirectly`); GPS is recorded when available but not required, and the client doesn't block on a GPS failure.
- UI: admin item editor has a Pinned point / Anywhere toggle; game HUD shows "N on map · N anywhere"; the deck is titled "Anywhere Cards" and hidden entirely for pin-only sets.

## Judged Challenges (2026-10-02)

**Why:** some challenges (best photo, funniest video) should be open to every team and scored by judges after the game, not won by the first team to finish.

- Authoring: in point-linked sets an item's Scoring is "Instant points" or "Judged after game" (`config.judged`, optional `config.judged_max_points`, empty `scoring`). Judged items can be pinned or anywhere.
- Runtime: judged challenges are active from the start (like pins), outside the deck. Completing one inserts a `challenge_claims` row with status `submitted` and never completes the challenge; a partial unique index (`idx_one_judged_submission_per_team`, migration 0014) allows one per team. Notes in `submission.note` are stripped from snapshots, broadcasts and events (judges only).
- Win check (point mode): judged challenges count as done once every team has submitted. A game with judged challenges ends with `winnerTeamId: null` / reason `awaiting_judging`.
- Judging: `GET /game/:id/judging`, `PUT /judging/submissions/:claimId {points}` (draft, stored in `judged_points`), `POST /game/:id/judging/publish` (completed games only). Publish writes `judged_award` ledger deltas against what was already awarded, so republishing corrects scores; it sets `settings.judging_published_at`.
- Recap carries `judging: { status: none|pending|published }`. The results screen shows "Judges are scoring" with standings-before-judging while pending and polls every 20 s.
- Also fixed: `/challenges/:id/complete` rejected `gps: null`, which broke completing anywhere cards without a GPS fix.

## Challenge Points + Bonus Tasks (2026-10-02)

- Every challenge can carry base points (`scoring.points`; the admin field now shows for all set types) and optional bonus tasks in `config.bonuses: [{ id, label, points }]` (shared helpers in `shared/src/scoring.ts`).
- Teams self-report bonuses when completing: `submission.bonusIds`. `finishChallengeCompletion` adds the points of claimed bonuses that exist on the challenge (unknown ids are ignored) to the `points` award, so it covers every completion path (zone claims, pins, anywhere cards).
- Judged challenges: teams tick bonuses when submitting; judges see them in the Judging panel. They are not auto-added: the judge's score is the total.
- UI: cards show "5 pts" / "+5 bonus" chips; completing a deck card with bonuses opens a checklist sheet with a running total; the pin card shows the checklist inline ("Complete · 7 pts"); details list the bonus tasks; completed cards, the toast and the feed show points earned.

## All Challenges as Cards, 1-Point Default, 3-Bonus Cap (2026-10-03)

- Game setting `deal_all_challenges` (admin: "Show every challenge from the start") puts every challenge in play at start; `active_challenge_count` is then stored as the total.
- Point games show every challenge as a card: anywhere cards complete in place; pinned cards have "Show on map" (opens the pin card, which keeps the radius check); judged cards open the judged sheet or their pin. Filter chips (All / On map / Anywhere / Judged) partition the cards; "On map" sorts nearest first; cards your team has submitted sort last. Fixed: the deck auto-select only knew anywhere cards, so pinned cards could never stay selected.
- A challenge with no points set is worth 1 (`DEFAULT_CHALLENGE_POINTS`); an explicit 0 stays 0, and the admin now always saves the points field.
- At most 3 bonus tasks per challenge (`MAX_CHALLENGE_BONUSES`), enforced in the admin editor and the challenge-set API.

## Judging Page + Judging Types (2026-10-03)

- Judged challenges have `config.judging_type`: `pass_fail` (yes/no per team; judges also approve each claimed bonus), `best_wins` (judges pick the winner or tied winners; they get the points), or `points` (judge enters any number; the earlier judged challenges, which had `judged_max_points`, map to this). The editor offers the three; the challenge's points are what a yes / the winner earns.
- Migration 0015 adds `challenge_claims.judged_decision` ({ verdict, bonusIds?, points? }). `PUT /judging/submissions/:id` takes a decision (or `{ decision: null }` to clear; `{ points }` still works) and the server computes `judged_points` from it.
- New page `/admin/judging?gameId=` (linked from the admin panel): To judge / Judged tabs, per-type controls, auto-refresh every 15 s while the game runs, sticky Publish bar. Cards you judge stay put until you switch tabs. The old inline Judging section in the admin panel is now a link.
- Players: judged challenges play exactly like normal ones (same card and pin UI, same Complete flow) with a small "★ Judged" marker; once a team submits, the challenge disappears from that team's cards and map. The separate judged sheet, purple pins and "judged to do" chip are gone.

## Challenge Areas (2026-10-03)

- In point-linked sets a challenge can be tied to a custom area drawn in the editor (Where: Pinned point / Area / Anywhere). Stored as `config.area` (GeoJSON Polygon/MultiPolygon) with `metadata.sourceMapId`; validated with `ST_IsValid` (self-crossing shapes are rejected) and only allowed without a point or zone. Shared helpers in `shared/src/challenge-area.ts`.
- Runtime: area challenges are always active (like pins), `portable: false`, `location_mode: 'area'`. Completing (and judged submissions) require GPS within `CHALLENGE_AREA_EDGE_TOLERANCE_METERS` (20 m) of the area, checked with PostGIS geography distance. Completing one doesn't deal a deck card.
- Game map: `ChallengeAreaLayer` draws dashed, shaded areas with name labels; tapping one opens the location card ("Anywhere in the shaded area · You're in it / 120 m away"). Cards show "▧ Area · you're in it"; the "On map" filter includes areas. The layer retries until the style accepts it (the map can already be idle when it mounts, so neither 'load' nor 'idle' fires again).
- Editor: `ChallengeAreaPicker` uses mapbox-gl-draw (Draw area / Redraw / Clear, drag corners to adjust, shows the area size).

## Prod Test Game (2026-10-07)

- New game setting `hide_from_home`: `/game/active` skips such games, so a live test game doesn't replace the featured results or the real game. Open it with `/?gameId=<id>`. Admin checkbox: "Test game (hide from homepage)".
- Prod test game "TEST · Point Challenge Preview" (`2e9effd0-6e4a-4d2d-a863-0b9efc62dec8`, set `4215d2f4-3046-4568-b61d-bfc23faf143b`): 15 Chicago challenges (6 pins, 4 areas, 5 anywhere; 3 judged), all in play, teams Test Foxes / Test Owls. A "Claude (test)" player is on Test Owls.
- Found on prod: `.point-challenge-marker` set `position: relative`, overriding Mapbox's absolute marker positioning, so pins stacked away from their locations once there were several. Fixed in d51b7d8.
- Admin routes are unauthenticated on prod (V1 no-op `requireAdmin`), which is how the test game was created via the API.

## Card UI Redesign (2026-10-07)

- Point games use `PointDeck`: closed, a centred fan of three cards ("Challenges · N left"); open, a row of dense mini playing cards (points + suit in the corner, title, where, short description) with All / On map / Anywhere filters. Tapping a mini card, a pin or an area opens `CardViewer`: one fixed-size full-screen card (`ChallengeCardFace`) with swipe left/right between cards.
- `ChallengeCardFace`: parchment playing card with corner indices (points + suit: compass star = pin, hatched plot = area, wind rose = anywhere), short description, "More info" toggle for the long description, a "Bonus" list with (i) toggles for each bonus's `description`, map button for located challenges, and a two-tap Complete. No radius bubble; distance/"you're here" sits in the type line and the button.
- Bonuses have an optional `description` (editor: Details field).
- Map: pins are small parchment cards on an ink stem (same for judged and regular); areas are a subdued rust fill with no labels. Area taps are handled by a map-level click + `queryRenderedFeatures` (layer-scoped listeners added before the layer exists never fire). Area layers are added without waiting for `isStyleLoaded()`, which stays false while tiles load.
- Fixed: the closed deck was off-centre (each hidden card in the fan added ~8 px of width) and dropped too far (its height was measured once, while open; now a ResizeObserver keeps it current). A swipe in the viewer no longer counts as a backdrop tap.
- Territory games keep the old `ChallengeDeck`.

## Card UI Polish (2026-10-07)

- Open deck: swiping down from on top of a mini card now closes it (mini cards are no longer `data-deck-interactive`, a press that travelled doesn't open the card, and the deck captures the pointer once a vertical swipe starts so the release isn't lost when the finger ends below the deck).
- Card viewer backdrop is much lighter (map visible); counter and dots sit on dark pills.
- The game's name runs along the top and bottom edges of every card (`EdgeLabel`), full-size and mini.
- Area challenges get a card marker fixed at the area's centroid (or `pointOnFeature` when the centroid falls outside). Fixed: a selected marker drifted as the map zoomed, because the CSS `scale`/`translate` properties on the marker element compose with Mapbox's positioning transform and scale its screen offset. Only the inner card is transformed now. Also fixed: pin click handlers kept the `onSelect` from when the pin was created.
- Distances are shown in feet / miles (`client/src/lib/units.ts`); the editor shows area size in acres.
- Standings and feed panels drop down from the top (swipe up to close) since the deck owns the bottom.

## Realtime Performance Pass (2026-10-07)

- Client store: `cloneSnapshot` is now a shallow copy. Every update already swaps in new arrays for the slices it touches, so untouched slices (zones, challenges, …) keep their identity. Team-location updates no longer replace `game` when the state version is unchanged.
- `ZoneLayer` takes `zones` and `teams` instead of the snapshot, so location and resource updates don't rebuild the zone GeoJSON. `GameView` memos depend on the slices they read (and `currentPoint` is memoized), so the deck, scoreboard and completed cards only recompute when their data changes.
- `POST /players/me/location` reads the player and game in one query and only broadcasts `team_locations_updated` when the updating player is the team's representative, built from that row (no game-wide `listTeamLocationsByGame`).
- New hourly job (`jobs/receipt-pruning.ts`) deletes `action_receipts` older than 24 h; migration 0016 indexes `created_at`.
- `broadcastFullStateToGame` loads game state once (`loadGameState`) and shapes it per socket (`buildViewerSnapshot`) instead of rebuilding the full snapshot for every connected player.

## Rename: Saadventure, Turf War, Challenge Hunt (2026-10-07)

- The app is now called Saadventure (`PLATFORM_NAME`): page title, home-screen name, push notification fallback title, join and loading screens, admin subtitle. Favicon is a compass.
- Modes have player-facing names from `GAME_MODE_LABELS` in `shared/src/constants.ts`: `territory` → Turf War, `point_challenge` → Challenge Hunt. The stored `mode_key` values are unchanged, so existing games keep working. The join screen header shows "Saadventure · <mode>".
- Seed demo games are named "<City> Turf War Demo".

## Logo and Skyline Branding (2026-10-07)

- New mark `client/public/logo.svg`: parchment map badge with a muted city skyline, a dotted trail and a rust destination pin with a gold star. It replaces `favicon.svg` and is the favicon, manifest icon and source of the PNGs (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, full-bleed and maskable-safe). Push notifications use `icon-192.png`.
- `manifest.webmanifest` and `theme-color` added so the home-screen install shows Saadventure with the logo.
- `BrandMark` (`client/src/components`) shows the logo on the join header, loading/empty/error screens and admin sidebar. `SkylineBackdrop` lays a faint two-layer skyline (`client/public/skyline.svg`, a seamless tile) along the bottom of the join and status screens; not on the spectator map or in-game.
- PNGs were rendered from the SVG with headless Chromium; regenerate them if the SVG changes.

## Push Notifications Fixed (2026-10-07)

- Root cause: `import * as webPush from 'web-push'` gives a namespace without `setVapidDetails` under Node ESM (web-push is CommonJS), so `createNotificationService` threw during setup, swallowed it, and disabled push. No push was ever sent in production. Now a default import, with a test against the real client.
- A failing push (any status except 404/410) is logged and skipped instead of thrown, so it no longer aborts the rest of the team, the post-capture win check, or the claim-timeout sweep. Startup logs say why push is disabled when it is.
- `sw.js` skips waiting and claims clients on activate (installed apps are rarely fully closed), and a notification tap focuses the app even when `navigate()` is refused.
- The lobby prompt only shows in Turf War (the only mode that sends pushes). Players who skip the lobby can turn alerts on from the in-game menu (`NotificationMenuItem`). iPhone Safari shows an Add to Home Screen hint, since iOS only offers push to installed web apps.
- Other players' `pushSubscription` is no longer sent in snapshots or public player payloads.
- Verified locally: the service worker shows a delivered push (CDP `deliverPushMessage`) with the logo icon; the server sends a VAPID-signed aes128gcm push to a local fake push service, which decrypts to the expected payload. Real subscription needs a phone (headless Chromium has no push service).
- Logo: the trail now runs along the ground in front of the skyline, ending at the pin.

## Challenge Hunt Push Notifications (2026-10-07)

- Completing a Challenge Hunt challenge now pushes to teammates ("Challenge completed": "Sam completed "X" (+20 pts).", not to the player who did it) and to rival teams ("Rival completed a challenge": "Gold Team completed "X". It's off the board.").
- A judged submission only tells teammates ("Submitted for judging"); the challenge stays open for other teams until judging.
- `TeamNotificationInput.excludePlayerId` skips the acting player.
- The lobby prompt and in-game menu item now appear in both modes, with "Challenge Alerts" wording in Challenge Hunt.

## Batched Pushes, Rivals-Only Challenge Hunt Alerts (2026-10-07)

- The notification service no longer drops pushes inside a player's rate-limit window (`PUSH_RATE_LIMIT_MS`, 60 s). The first push goes out immediately; later ones are held and sent as one when the window ends: "{count} challenges completed" / "{count} zone captures" (from `batchTitle`), or "{count} game updates" for mixed batches, with up to three bodies and "+N more". Held pushes live in memory and are lost if the server restarts mid-window.
- Challenge Hunt completions only notify rival teams, titled "Challenge completed" for judged and regular challenges alike. Regular ones add "It's off the board."; judged ones don't, since they stay open for other teams until judged.

## Judged Challenges: Yes/No Bonuses, Wait for Judges (2026-10-07)

- Judged challenges are yes/no bonuses. The challenge editor no longer offers "best team wins" or "judge sets points" (always saves `judging_type: 'pass_fail'`); the judging page still handles those types for older challenge sets.
- Players complete them like any challenge: toast and feed say "Challenge completed", with a small "Judged" marker; the "submitted for judging" wording is gone.
- The admin can judge any time (during or after the game) at `/admin/judging`.
- Game end: if every judged submission already has a decision (or there were none), the point-challenge `onGameEnd` publishes straight away (`publishJudgingIfDecided`). Otherwise players see a "Waiting for the judges" screen instead of the results; it refreshes on state-version change and every 10 s, and turns into the results once the admin presses "Show results" (the old "Publish scores").
- `getJudgingSummary` reports `none` when no team submitted a judged challenge, so such games never wait.
- Win condition: a Challenge Hunt game now ends once the regular challenges are done, even if some teams skipped judged bonuses. A set made only of judged challenges still ends once every team has done each one.

## Paper Cards for Turf War, Scrap-Paper Standings and Feed (2026-10-07)

- Turf War deck cards now use Challenge Hunt's parchment card language (inner frame, game name on the edge, corner index with points and a flag suit, flourish divider, ink/rust buttons) while keeping the peeking, swipeable deck and Claim → Confirm flow. Details opens a parchment card too.
- Standings and feed (both modes, plus the results-screen timeline) are a crumpled scrap of notepaper: crease shading, torn edges, tape, handwriting (Caveat + Kalam, self-hosted in `client/public/fonts`), ballpoint-blue ink, the leader's score circled in red pen, your team highlighted, and a ruled notepad with time in the margin for the feed. The sheet unfolds from a ball when opened and crumples away when closed.

## Sagnik Offerings Judged Separately; Faster Admin Load (2026-10-08)

- Sagnik bday set: Costco chicken, Ethiopian food, Metra balloon and La Fournette are regular challenges again and score live. Each "offer it to Sagnik" part is its own judged challenge ("Chicken / Ethiopian / Birthday balloon / Pastry for Sagnik", anywhere, "At the party"). Imported to production; games already running keep their old copy.
- `/maps/playability` took ~16 s in production because every admin load re-ran the overlap and connectivity checks for every map. Results are now cached in memory per map against an md5 fingerprint of zone ids + geometries (the checks' only inputs), so they recompute only after a zone edit and stay correct across instances.
- The admin panel no longer waits for playability before showing (only the map picker uses it), and a game id in the URL loads alongside the game, map and set lists.

## Challenge Sets Belong to a Map (2026-10-08)

- `challenge_sets.map_id` (nullable, `ON DELETE SET NULL`, migration 0017). Null means a generic "any city" set. The migration fills it in from each set's first placed challenge (zone's map or `metadata.sourceMapId`).
- Server rules: placed items (pin, area, zone) must sit on the set's map; their `sourceMapId` is filled in from it. A set without a map takes the map of its first placed item, so older import scripts keep working. A set's map can't change or clear while placed items sit on another map. Games (create, and map/set edits in setup) reject a set written for another map (`assertChallengeSetFitsMap`); generic sets fit any map.
- Challenge editor: a Map picker on the set (saved like placement; items stay locked until it's saved), the set list shows each set's map, and items show the set's map instead of their own picker. Import/export carry `mapId`; importing into an existing set deletes the old items before switching the map.
- Game form: the set dropdown lists the chosen map's sets, then generic ones marked "(any city)". Changing the map clears a set that no longer fits.

## Denser Challenge Editor; Place Names on Cards (2026-10-08)

- Challenge editor: the sets and item-editor columns are sticky, viewport-tall and scroll on their own (no blank stretched column when scrolling a long list); set name / map / placement / description are a compact strip, and the challenges fill the middle as a dense list: number, title, full short description, long-description preview, bonus chips, where (kind, radius or zone, place name), points and bonus total, judged and difficulty badges. Search (title, descriptions, place, bonuses) and filters (All / Pinned / Area / Anywhere / Judged) with counts, plus a points total for the set. Rows stack the place and points under the title below 2xl. Item editor inputs are tighter; points and difficulty share a row.
- `config.location_hint` is now the place name for every placement, not just "anywhere" ones ("Place Name" field). Cards show it instead of "Pinned spot" / "Area" / "On map": "Chinatown Library · 1.2 mi away" on the Challenge Hunt card face and deck, and on Turf War point cards.
- The Sagnik bday set's pins and areas got place names on production (`build-sagnik-bday.py` passes them; `import.mjs` sends `location_hint` for any placement).

## Judged Bonuses on Regular Challenges (2026-10-08)

- A bonus can be marked `judged: true` (editor: "★ Judged after the game" per bonus; not offered on whole judged challenges, whose bonuses are already judged). Teams can't tick it: cards show it with "Judged after the game", and the server ignores it in live scoring (`complete-service` only sums non-judged claimed bonuses).
- Judging: a regular challenge with judged bonuses appears on the judging page as "Judged bonus" with the team that completed it (its `completed` claim) and a yes/no per judged bonus. Decisions use `bonusIds` (yes) and the new `rejectedBonusIds` (no); a claim is decided once every judged bonus is in one list (`isJudgedBonusDecisionComplete`). Its `judgedPoints` is just the approved judged bonuses, since the base already scored.
- Game end treats these like judged challenges: players wait for the judges if any are undecided, it auto-publishes when all are decided, and no winner is named until published. Publishing includes claims with `judgedPoints` or earlier judged awards, so clearing a decision and republishing takes the points back.
- Sagnik bday set: the four separate "… for Sagnik" judged challenges are gone; Costco, Ethiopian, Metra balloon and La Fournette carry an "offer it to Sagnik" judged bonus instead (27 challenges).

## Map Runs to the Top; Deck Follows the Finger (2026-10-08)

- Game screen: no beige fade behind the top pills, and the pills (team, points, legend, zone, menu) are solid with no backdrop blur or shadow. On the map the page background and `theme-color` are the map's land colour (`#f5f3ef`, `game-map-active` class), so the strip Safari paints under the status bar blends into the map instead of reading as a beige band. The lobby/countdown keep the beige.
- Mobile deck: the bottom shelf gradient is gone and Challenge Hunt card shadows are tight (no shadow band running to the bottom of the screen).
- The deck drag is continuous: dragging the closed fan up swaps in the open row at the peek position and it follows the finger; dragging the open deck down slides it away under the finger. On release it settles by velocity (±0.3 px/ms), else by whether it's past halfway. Tap on the fan still opens; pushing an open deck up still reveals the completed tray. Gesture lives on the deck wrapper in `GameView` (`getDeckOffset`); PointDeck's own swipe handler is gone.
