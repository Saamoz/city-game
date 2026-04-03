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

## Phase 28: Frontend — Map Shell & Zone Rendering ✅

**Done.** Mapbox map with zones from API.

- `Landing.tsx`: auto-discovers `GET /game/active`, registration form, team join form, direct `/game/:id` routing
- `GameView.tsx`: full-screen Mapbox map
- `ZoneLayer.tsx`: zones from map-state, team-colored polygons
- `gameStore.ts`: Zustand store from map-state
- Dev proxy fix: Vite forwards `/api/v1` unchanged to Fastify on port 3000
- `VITE_MAPBOX_ACCESS_TOKEN` read from repo-root `.env`

---

## Phase 29: Frontend — Socket.IO & Live State ✅

**Done.** Real-time sync with version ordering.

- Socket.IO client connects after initial map-state, re-emits `join_game` on every reconnect
- Version ordering: ignore events ≤ current version; gap → full sync
- Per-version dedupe map handles same-version sibling events correctly
- Reconnect banner surfaced in UI

---

## Phase 30: Frontend — Portable Challenge Deck ✅

**Done.** Card-style challenge deck over the map.

- Removed challenge pins and zone detail sheet
- Horizontal card tray with drag-scroll and tap-to-select
- Deck is a collapsible dock; challenge details in a modal
- Fixed three bugs before stabilization: hooks naming violation (`createDragRefs` → `useDragRefs`), click bubbling resetting confirm state, `setPointerCapture` timing (moved to first drag movement)

---

## Phase 31: Frontend — Portable Completion UI + Mobile-First UI ✅

**Done.** Full mobile-first redesign + complete challenge flow.

### What was built

**Challenge flow:**
- `POST /challenges/:id/complete` with GPS — no claim/release step for portable deck
- `useIdempotentAction` deduplicates in-flight requests
- `useGeolocation` watches position continuously; `refresh()` for on-demand fix
- Optimistic Zustand update on action start; socket arrival reconciles
- `GPS_TOO_OLD` → confirm dialog → retry with overridden `capturedAt`
- `OUTSIDE_ZONE` → toast with clear message

**Mobile-first UI:**
- Map is full-screen on mobile; no permanent chrome overlapping it
- Mobile top bar: zone pill + ☰ hamburger → menu overlay with Back to Lobby
- Desktop: left-column HUD with Field Brief, GPS pill, full deck chrome, and zone-control summary
- Mobile deck: floating overlay that slides up from bottom; pill button when closed
- Swipe-down to close (spring animation, 400ms); pill reappears only after animation
- Swipe-up to reveal completed cards tray from below
- Completed tray: `max-height` + `opacity` CSS transition, 500ms spring
- Removed Mapbox NavigationControl (zoom buttons)
- No scoring/reward pills on cards in V1

### Validation
- Selecting and completing a card captures current zone. Errors toast + rollback. Double-tap idempotent. GPS adaptive. Swipe gestures work on real devices.

---

## Phase 32: Frontend — HUD, Scoreboard & Feed

**Goal:** Team control strip, mini scoreboard, full scoreboard page, live event feed, notification toasts.

### Work

**Team Control Strip (mobile):**
- Compact row below the top bar: team color swatch + team name + zones owned
- Auto-hides when deck is open to preserve map visibility
- Tap to collapse/expand

**Desktop HUD expansion:**
- Field Brief card gains live controlled-zone count and concise standings context
- No points or currency counters in V1 Territory

**MiniScoreboard:**
- Accessible from ☰ menu on mobile (Standings item)
- Desktop: compact 2-3 row leaderboard below the control summary in left column
- Shows: rank, color swatch, team name, zones owned
- Tap → full Scoreboard page

**Full Scoreboard (`/game/:id/scores`):**
- Full-page view: game name, time elapsed/remaining
- Table: rank, team color bar, team name, zones owned
- Territory ranking: zones owned descending, then deterministic team name/id fallback
- Rows animate in on mount
- "Live" badge pulses when connected

**Live Feed (`/game/:id/feed`):**
- Chronological `EventCard` list
- Zone captured: team color indicator + "Team X captured Zone Y"
- Challenge completed: player + challenge title
- Game lifecycle: banner entries
- Loads recent events on mount, appends via socket
- Infinite scroll upward for history
- Mobile: full page. Desktop: TBD collapsible panel.

**NotificationToast:**
- Bottom-center stack (max 3 visible)
- Types: success (green-tinted amber), error (red), info (neutral cream)
- Auto-dismiss 4s, tap to dismiss early
- Rival zone capture → toast with team color

### Validation
- Zone-control counts match server ownership. Scoreboard matches Territory V1 ranking. Events animate live. Toasts fire for rival captures and GPS warnings.

---

## Phase 33: Frontend — Distance Tool

**Goal:** Map ruler for measuring distances.

### Work

- Toggle button in desktop toolbar / ☰ menu on mobile
- `mapMode: ‘play’ | ‘measure’` in Zustand
- Tap map → place waypoints; amber dashed polyline connects them
- Running distance label in km near last waypoint (League Mono font, cream pill)
- Tap last waypoint to undo. "Clear" button resets all.
- Measure mode suppresses zone tap and deck card selection
- Escape key exits measure mode

### Validation
- Measure works on desktop and mobile. Cumulative distance correct. Toggle clears. Deck still openable in measure mode.

---

## Phase 34: Frontend — Admin Zone Editor (`/admin/zones`)

**Goal:** Terra Draw zone editing interface.

### Work

- Full-screen Mapbox (same style) + left tool panel (desktop) / bottom sheet (mobile)
- Tool modes: Select, Draw Polygon, Edit Vertices, Delete, Import OSM, Import File
- Select → sidebar with zone name, point value, claim radius; edit + save (PATCH)
- Draw → click vertices, double-click to close → POST `/zones`
- Edit → drag vertices of selected polygon → PATCH
- Delete → confirm modal → DELETE `/zones/:id`
- Import OSM → place name / OSM relation ID → preview → confirm bulk import
- Import File → drag-drop GeoJSON FeatureCollection → preview → `/zones/import`
- Buffer visualization: translucent ring showing claim radius on selected zone
- Zone name labels always visible in editor mode

### Validation
- All CRUD operations work and persist. Import (OSM + file) works. Buffer ring renders. Mobile editing functional.

---

## Phase 35: Frontend — Admin Panel (`/admin`)

**Goal:** Game management and overrides UI.

### Work

Clean sidebar navigation (no cartographic chrome). Sections:

- **Game Settings**: name, city, win condition picker + config, claim timeout, max concurrent claims, GPS accuracy toggle, location tracking toggle
- **Lifecycle**: Start / Pause / Resume / End with confirm modals + status badge
- **Teams**: list with join codes + player counts; create team form; edit name/color inline
- **Challenges**: table (title, kind, status, zone); create/edit form; delete with confirm; filter by status
- **Overrides**: force-complete, reset, assign zone owner, adjust resources (team + type + delta + reason), rebroadcast state
- **Scoreboard**: read-only live view

### Validation
- All lifecycle controls work. Challenge CRUD persists. Overrides apply and broadcast. Scoreboard live.

---

## Phase 36: PWA & Service Worker

**Goal:** Installable, offline-capable, push-enabled.

### Work

- `manifest.json`: name "Territory", `display: standalone`, theme `#c8b48a`, bg `#f5f0e8`, 192/512px icons
- Service worker: cache-first for app shell, network-first for API; offline fallback screen
- Push: `POST /players/me/push-subscribe` stores VAPID subscription; server pushes on rival zone capture
- Zustand persistence: game ID, player ID, team ID in `localStorage` to skip re-join on return

### Validation
- Add to Home Screen works. Offline loads cached shell. Push arrives on rival capture. Return visit skips join flow.

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

- All assertions pass. Events and ownership are correct; Territory V1 does not depend on separate points/coins balances.

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
