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

## Phase 36: Join Flow & Pre-Game Lobby

**Goal:** Replace the current join-code home screen with a clean mobile-first join experience and a live pre-game lobby that transitions smoothly into the game.

### Why

The current `Landing.tsx` requires players to know a team join code, is not mobile-optimized, and drops players directly into the game view with no sense of anticipation or group formation. The new flow is zero-knowledge for players (no codes to share), socially engaging (see who's joining each team), and builds excitement through a shared countdown.

### Flow State Machine

```
home → name_entry → team_picker → lobby → countdown → game
```

Each state is a full-screen view. Transitions are smooth slides/fades. State is stored in Zustand and persisted to `localStorage` so a page refresh returns to the correct step (lobby if already joined, game if already started).

### Detailed UI Design

**Home Screen (`home` state)**
- Full-height layout. Background: warm cream `#f5f0e8`. No map visible yet — keep it clean.
- App wordmark at top (League Mono, small, muted) — e.g. "TERRITORY".
- Game name displayed large in Georgia serif, centered vertically in the upper half.
- Optional: city/subtitle in a smaller muted serif below the game name.
- Single text input: placeholder "Your name", large font, centered, max-width ~320px on desktop.
- Submit button: full-width on mobile, amber background `#c8a86b`, Georgia serif label "Join Game →". Disabled until name ≥ 2 chars.
- If game status is not `setup`: show "No game is currently accepting players." in muted text with no form. Poll every 10s.
- No join code field anywhere.

**Team Picker (`team_picker` state)**
- Appears after name is submitted and player is registered via `POST /game/:id/players`.
- Header: "Choose your team" in Georgia serif, centered.
- Vertical scrollable list of team cards. Each card:
  - Left accent bar (4px wide, full card height) in the team's hex color.
  - Team name in Georgia serif, lg weight.
  - Member count pill (right-aligned): "4 players" in League Mono, muted.
  - Below the name: horizontal row of player name chips (small rounded pills, cream bg with color-tinted border). Show up to 5; "+N more" chip if overflow. Empty teams show "No players yet" in muted italic.
  - Card has a subtle warm shadow on hover/focus; scales 1.02 on press.
- Tapping a card immediately calls `POST /game/:id/teams/join` with that team's `join_code` (player never sees the code). Loading spinner on the tapped card while in-flight.
- Back chevron at top-left to re-enter name if needed.
- Team list is fetched on mount and also polled every 5s so member counts stay fresh while the picker is open.

**Lobby Screen (`lobby` state)**
- Map is mounted and fills the entire screen as a background. Zones rendered in neutral warm grey (no team colors — game hasn't started). Map is non-interactive: pointer events disabled, no controls.
- Over the map: a semi-transparent warm overlay `rgba(245, 240, 232, 0.72)` covers the full screen.
- Centered panel (warm paper card, same `#f0ebe0` bg + subtle border as the challenge deck):
  - **Top:** Game name in Georgia serif, medium.
  - **Below:** A pulsing amber dot + "Waiting for the game to start…" in muted serif.
  - **Team rosters section:** Each team rendered as a column (or row if ≥ 4 teams: grid). Per team:
    - Color swatch circle + team name in Georgia serif.
    - Player name list, one per line, small text. Your own name is rendered in the team color with a subtle "You" badge.
    - Empty slots shown as "—" placeholders if team has < expected player count (optional — only if count is configured).
  - Panel scrolls if too tall on small screens.
- Socket is connected here (`join_game` emitted). Listen for `player_joined` events — update the roster live (smooth fade-in of new names, no full refresh).
- Listen for `game_started` event → trigger countdown.

**Countdown Overlay (`countdown` state)**
- Full-screen overlay fades in over the lobby in 200ms. Background: `rgba(31, 42, 47, 0.92)` (near-black, same dark tone as game HUD).
- Countdown sequence: 3 → 2 → 1 → GO!
- Each number fills ~60vw height, centered, Georgia serif, cream `#f5f0e8`.
- Animation per beat: number appears at scale 1.4 + opacity 0 → snaps to scale 1.0 + opacity 1 in 100ms (pop-in) → holds 600ms → scale 0.8 + opacity 0 over 300ms (shrink-out). Total per beat: 1000ms.
- "GO!" text: amber `#c8a86b`, same scale animation but holds 600ms then the entire overlay fades out over 400ms.
- After overlay fades: map becomes interactive, zones take team colors, challenge deck pill appears. Full `GameView` is now live.
- No audio in V1.

### Components

- `client/src/features/join/JoinFlow.tsx` — top-level state machine; manages `home | team_picker | lobby | countdown` states; persists to localStorage
- `client/src/features/join/TeamPicker.tsx` — team card list with live polling
- `client/src/features/join/LobbyScreen.tsx` — map background + centered roster panel; socket listener
- `client/src/features/join/CountdownOverlay.tsx` — animated countdown; framer-motion or pure CSS keyframes
- `client/src/App.tsx` — route `/` now renders `JoinFlow` instead of `Landing`; existing `Landing.tsx` retired

### Backend

No new endpoints required. All needed APIs already exist:
- `GET /api/v1/game/active` — discover the setup game on home screen
- `GET /api/v1/game/:id/teams` — team list for picker (with player counts from join)
- `GET /api/v1/game/:id/players` — roster for lobby panel
- `POST /api/v1/game/:id/players` — register name
- `POST /api/v1/game/:id/teams/join` — join chosen team
- Socket `player_joined` — already broadcast on join; lobby uses it for live updates
- Socket `game_started` — already emitted; triggers countdown

### Validation
- Name entry → team picker shows live member counts (update while open) → join → lobby appears with your name highlighted → second player joins different team → their name appears live → admin starts → all clients see simultaneous countdown → game screen with live zones and deck.

---

## Phase 37: Active Challenge Window

**Goal:** Show only a configurable window of N challenges at a time in the deck. Completing one removes it and promotes the next from the queue for all players simultaneously, with a slide-in animation and a feed announcement.

### Why

Showing all 20–30 challenges at once is overwhelming and removes the strategic element of not knowing what's coming next. A rolling active window creates tension, pacing, and a shared event ("new card!") when a challenge slots in.

### Concept

The challenge deck is a window into a sorted queue. At game start the first N challenges (by `sort_order`) are `is_deck_active = true`; the rest are queued (`is_deck_active = false`, invisible to clients). When any player completes a challenge, the server atomically: marks it completed, finds the next queued challenge by `sort_order`, sets its `is_deck_active = true`, emits `challenge_activated`, and broadcasts the updated state. All players see the change simultaneously via the existing socket broadcast.

### Backend Changes

**Migration 0005:**
```sql
ALTER TABLE challenges
  ADD COLUMN sort_order     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN is_deck_active BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_challenges_game_active
  ON challenges (game_id, is_deck_active, sort_order)
  WHERE status = 'available';
```

**`game.settings`:** Add `active_challenge_count` (integer, default 3). Validated as ≥ 1 on game create/update.

**`onGameStart` clone logic** (`challenge-set-service.ts`):
- Clone items ordered by `sort_order ASC`.
- After insert, set `is_deck_active = true` on the first `active_challenge_count` rows via a single `UPDATE ... WHERE id = ANY($1)`.

**Challenge complete handler** (`territory/complete.ts`):
- Inside the same transaction, after marking the challenge completed:
  ```sql
  UPDATE challenges SET is_deck_active = TRUE, updated_at = NOW()
  WHERE id = (
    SELECT id FROM challenges
    WHERE game_id = $1
      AND status = 'available'
      AND is_deck_active = FALSE
    ORDER BY sort_order ASC
    LIMIT 1
  )
  RETURNING id, title;
  ```
- If a row is returned, emit a `CHALLENGE_ACTIVATED` `game_event` record (entity_type = `challenge`, entity_id = new challenge id, meta = `{ title: "..." }`).
- This event increments `state_version` alongside the completion event in the same transaction.

**Map-state snapshot builder** (`game-service.ts`):
- Filter returned challenges: `WHERE is_deck_active = TRUE OR status != 'available'`. Queued challenges (`is_deck_active = FALSE AND status = 'available'`) are never sent to clients.

**New socket event:** `challenge_activated` is included in the delta broadcast after a completion (it's part of the state update; no separate socket event type needed — the `game_state_delta` carries the new challenge data).

**Feed endpoint (`GET /game/:id/events`):**
- `CHALLENGE_ACTIVATED` events render in the feed as: "A new challenge is available: [title]".

### Frontend Changes

**`ChallengeDeck.tsx`:**
- Define `getDisplayTitle(title: string): string` — truncates at 38 characters with `…` for card headers. Full title in `title` attribute (already partially in the uncommitted diff; complete the implementation).
- Available challenge cards displayed are exactly those returned by the server (already filtered to active window). No client-side N-limit logic needed.
- **New card entry animation:** When the store gains a new challenge that wasn't previously in the deck (detected by comparing previous vs. new challenge IDs), apply a mount animation to that card: slide in from the right + fade (`translateX(40px) opacity:0` → `translateX(0) opacity:1`, 350ms ease-out). Use a React `key`-based animation trigger or a `useRef` to track "new" IDs.
- **Progress indicator:** Below the deck (or on the deck dock button), show "X remaining" or "X / Y done" in small muted text so players have a sense of progress without seeing the full queue.

**Feed (`Phase32Panels.tsx` or feed component):**
- Add a case for `CHALLENGE_ACTIVATED` event type: renders with a card-draw icon (e.g. ✦ or a simple card outline), amber accent, text: "New challenge: [title]". Slightly more prominent than a plain info entry — use a warm amber left border.

**`gameStore.ts`:**
- Track previous challenge IDs to detect newly activated ones for the entry animation. Store a `Set<string>` of seen challenge IDs; new arrivals trigger the animation flag.

### Admin Panel Integration

- The admin panel runtime snapshot should show both active and queued challenges (all challenges), with an `is_deck_active` badge or "Queued" label so the admin can see the full deck state.
- `active_challenge_count` is surfaced as a setting field in the New Game wizard (number input, default 3, min 1).

### Validation
- Game starts with 3 active challenges visible in deck. Complete one → it disappears for all players simultaneously → new card slides in from the right → feed shows "New challenge: [title]" with amber styling. Admin panel still shows queued challenges. If fewer than N total challenges in the set, deck shows all without error. Completing the last active challenge when no queued ones remain: deck shows 0 available cards gracefully (no crash).

---

## Phase 38: PWA & Service Worker

**Goal:** Installable, offline-capable, push-enabled.

### Work

- `manifest.json`: name "Territory", `display: standalone`, theme `#c8b48a`, bg `#f5f0e8`, 192/512px icons
- Service worker: cache-first for app shell, network-first for API; offline fallback screen
- Push: `POST /players/me/push-subscribe` stores VAPID subscription; server pushes on rival zone capture
- Zustand persistence: game ID, player ID, team ID in `localStorage` to skip re-join on return (note: Phase 36 lobby already adds game/player/team persistence for the join flow; Phase 38 extends this with push + service worker)

### Validation
- Add to Home Screen works. Offline loads cached shell. Push arrives on rival capture. Return visit skips join flow.

---

## Phase 39: Rate Limiting

**Goal:** Prevent abuse.

### Work

- `@fastify/rate-limit` with per-endpoint limits. 429 with Retry-After

### Validation

- Vitest: limits enforced, different IPs unaffected

---

## Phase 40: End-to-End Integration Test

**Goal:** Full game scenario automated.

### Work

- Script: create game (with map + challenge set) → start → teams join → complete challenges → zone captures → admin override → scoreboard → end
- Socket.IO broadcast verification, idempotency replay, delta sync, receipt atomicity

### Validation

- All assertions pass. Zones cloned from authored map. Challenges cloned from challenge set. Events and ownership correct.

---

## Phase 41: Mobile Testing & Polish

**Goal:** Works on real phones.

### Work

- iOS Safari + Android Chrome testing. Touch fixes. GPS on mobile. Poor network. Performance. Accessibility

### Validation

- All flows work on mobile. Lighthouse ≥ 80

---

## Phase 42: Deployment

**Goal:** Production on Proxmox.

### Work

- LXC, PostgreSQL + PostGIS, Node.js, Caddy, pm2, env vars, DNS
- Integration test against production

### Validation

- HTTPS works. WebSocket works. GPS works. Integration test passes

---

## Phase 43: Playtest Prep

**Goal:** Game configured for real play.

### Work

- Chicago zones in authored map, challenge set with 20-30 challenges, GPS tuning, 4 teams, mobile flow test, join instructions

### Validation

- Full flow works on mobile. Instructions clear

---

## Phase 44: Playtest & Post-Mortem

**Goal:** Real game, real data, real learning.

### Work

- 4 teams × 3-5 players, 2-3 hours. Location tracking enabled
- Post-game: events, samples, receipts, overrides, player survey
- Document issues, priorities for next iteration

### Validation

- Game ran. Players could play. Issues documented. Post-mortem completed

---

*Ship V1 by completing all phases. Each phase is independently testable.*
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

