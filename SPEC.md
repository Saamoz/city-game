# Territory Platform — Technical Specification

> Location-based multiplayer game platform. Territory is the first game mode.
> V6 Spec (Final) — Single instance, single game, extensible architecture.

---

## 1. What This Is

A platform for location-based multiplayer games played across a real city. The platform provides shared infrastructure — maps, teams, GPS validation, objectives, resources, real-time sync — and individual **game modes** define rules, scoring, and win conditions on top of it.

**Territory**, the first mode: teams physically travel to city zones, complete challenges, and capture territory. A live map updates in real time for all players.

**First playable draft:** challenges are presented as a shared portable deck rather than pinned to map locations. Players move into a zone, choose a card, and the completed card applies to the zone they are currently standing in. Location-bound challenge markers can return later as a more advanced variant.

The architecture supports future modes (scavenger hunt, hide-and-seek, tag, currency bidding) without changes to platform tables or services. Each mode is a pluggable handler.

### Gameplay Loop (Territory)

Admin creates a game → draws/imports zones → creates a limited challenge deck → creates teams. Players join via code, open the app, travel to zones, choose a challenge card, and complete it to capture the zone they are currently in. Challenges are consumed on completion. Game ends when a win condition is met.

### Future Modes (Not Built in V1)

- **Scavenger Hunt** — challenges for points, first team to finish gets the most.
- **Currency Territory** — challenges award coins, coins bid on zones, outbidding steals control.
- **Hide and Seek** — asymmetric visibility: seekers see hiders, not vice versa. Requires visibility filter.
- **Tag** — chaser sees runners, transit costs currency from movement. Requires visibility + server-side resource computation.

---

## 2. Architecture

### Three Layers

**Platform Core** (mode-agnostic): games, teams, players, zones, challenges, resources, events, annotations, GPS validation, real-time sync, notifications. Knows nothing about Territory.

**Mode Handler** (game-specific): valid actions, objective lifecycle, zone state behavior, scoring, events, win conditions, visibility filtering. Territory is the first handler.

**UI** (presentation): shared shell (map, HUD, scoreboard) plus mode-specific components.

In V1 there's one mode and no mode-switching UI. The separation is a code organization principle — Territory logic lives in `modes/territory/`.

### Mutation Strategy

- **REST** for all state-changing actions. Schema-validated by Fastify. `Idempotency-Key` header on every mutation.
- **Socket.IO** for broadcasts only. Pushes events after REST commits.
- **Client → server Socket.IO** limited to `join_game` and `leave_game`.

---

## 3. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18+ / Vite / Tailwind / Zustand | Fast DX, mobile-friendly, lightweight state |
| Map | Mapbox GL JS v3 | Turnkey vector tiles, geocoder, great mobile UX |
| Drawing | Terra Draw | Adapter-based, works with Mapbox, superior polygon editing |
| Geometry | Turf.js (client) / PostGIS (server) | Preview vs. authoritative validation |
| Real-time | Socket.IO 4.x | Room broadcasting, auto-reconnect, long-polling fallback |
| Backend | Node.js 20 LTS / Fastify 4.x | Schema validation, fast, TypeScript-native |
| Database | PostgreSQL 16 / PostGIS 3.4 / Drizzle ORM | Spatial indexes, polygon containment in µs |
| Notifications | Web Push (`web-push` npm) | Mobile + desktop, no native app |
| Auth (V1) | Team join codes + httpOnly session cookies | Simple, secure |
| Hosting | Proxmox LXC + Caddy | Self-hosted, auto HTTPS, WebSocket |

---

## 4. Data Model

All tables are platform core (mode-agnostic) unless noted.

### Referential Integrity Note

**Same-game consistency** (e.g., a player's team belongs to the same game as the player) is enforced in application services, not by composite foreign keys, to keep the schema simpler in V1. Every service method that crosses entity boundaries validates game_id consistency before writing. If multi-game support is added in V2, composite constraints should be evaluated as a hardening step.

### Migration Note: Circular FK

`challenges.current_claim_id` references `challenge_claims`, while `challenge_claims.challenge_id` references `challenges`. This circular dependency requires a two-step migration:

1. Create `challenges` without the `current_claim_id` FK.
2. Create `challenge_claims` with its FK to `challenges`.
3. `ALTER TABLE challenges ADD CONSTRAINT fk_current_claim FOREIGN KEY (current_claim_id) REFERENCES challenge_claims(id);`

### `games`

```sql
CREATE TABLE games (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255) NOT NULL,
  mode_key         VARCHAR(50) NOT NULL,       -- 'territory', 'scavenger_hunt', etc.
  city             VARCHAR(255),
  center_lat       DECIMAL(10,7) NOT NULL,
  center_lng       DECIMAL(10,7) NOT NULL,
  default_zoom     INTEGER NOT NULL,
  boundary         GEOMETRY(Polygon, 4326),
  status           VARCHAR(20) NOT NULL DEFAULT 'setup',
                                                -- 'setup' | 'active' | 'paused' | 'completed'
  state_version    BIGINT NOT NULL DEFAULT 0,   -- Incremented atomically with every state
                                                -- change. Included in every broadcast.
  win_condition    JSONB NOT NULL DEFAULT '{}',
  settings         JSONB NOT NULL DEFAULT '{}', -- Platform: location_tracking_enabled,
                                                --   location_retention_hours, notification_config,
                                                --   claim_timeout_minutes (overrides env default),
                                                --   max_concurrent_claims,
                                                --   require_gps_accuracy (default false)
                                                -- Mode keys are mode-defined.
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `teams`

```sql
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID NOT NULL REFERENCES games(id),
  name        VARCHAR(255) NOT NULL,
  color       VARCHAR(7) NOT NULL,         -- Hex, e.g. '#FF4444'.
  icon        VARCHAR(50),
  join_code   VARCHAR(8) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}', -- Mode-specific. Tag: {"role":"chaser"}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (game_id, join_code)              -- Unique per game, not globally.
);
```

### `players`

```sql
CREATE TABLE players (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id           UUID NOT NULL REFERENCES games(id),
  team_id           UUID REFERENCES teams(id),  -- NULLABLE. Set via POST /game/:id/teams/join.
                                                 -- NULL = registered, not yet on a team.
  display_name      VARCHAR(100) NOT NULL,
  session_token     VARCHAR(255) NOT NULL UNIQUE, -- UUIDv4 in httpOnly cookie.
  push_subscription JSONB,
  last_lat          DECIMAL(10,7),
  last_lng          DECIMAL(10,7),
  last_gps_error    REAL,
  last_seen_at      TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `zones`

```sql
CREATE TABLE zones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               UUID NOT NULL REFERENCES games(id),
  name                  VARCHAR(255) NOT NULL,
  geometry              GEOMETRY(Geometry, 4326) NOT NULL,
                                                        -- Polygon for area-based modes.
                                                        -- Point for station/landmark modes (buffer = capture radius circle).
                                                        -- MultiPolygon for complex areas.
                                                        -- ST_Buffer and ST_Covers work identically across all types.
  centroid              GEOMETRY(Point, 4326),
  owner_team_id         UUID REFERENCES teams(id),   -- NULL = unclaimed.
  captured_at           TIMESTAMPTZ,
  point_value           INTEGER NOT NULL DEFAULT 1,
  claim_radius_meters   INTEGER,       -- Per-zone GPS buffer override. NULL = global.
  max_gps_error_meters  INTEGER,       -- Per-zone max tolerated GPS error. NULL = global.
                                       -- Higher = more permissive.
  is_disabled           BOOLEAN NOT NULL DEFAULT FALSE,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `challenges`

```sql
CREATE TABLE challenges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id          UUID NOT NULL REFERENCES games(id),
  zone_id          UUID REFERENCES zones(id),
  title            VARCHAR(255) NOT NULL,
  description      TEXT NOT NULL,
  kind             VARCHAR(50) NOT NULL,        -- 'visit','text','photo','quiz','multi_step','custom'
  config           JSONB NOT NULL DEFAULT '{}',
  completion_mode  VARCHAR(20) NOT NULL DEFAULT 'self_report',
  scoring          JSONB NOT NULL DEFAULT '{"points":10}',
  difficulty       VARCHAR(10),
  status           VARCHAR(20) NOT NULL DEFAULT 'available',
  current_claim_id UUID,                        -- FK added via ALTER TABLE (see migration note).
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- After challenge_claims table exists:
-- ALTER TABLE challenges ADD CONSTRAINT fk_current_claim
--   FOREIGN KEY (current_claim_id) REFERENCES challenge_claims(id);
```

### `challenge_claims`

```sql
CREATE TABLE challenge_claims (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id      UUID NOT NULL REFERENCES challenges(id),
  game_id           UUID NOT NULL REFERENCES games(id),
  team_id           UUID NOT NULL REFERENCES teams(id),
  player_id         UUID NOT NULL REFERENCES players(id),
  status            VARCHAR(20) NOT NULL,   -- 'active' | 'completed' | 'released' | 'expired'
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  submission        JSONB,
  location_at_claim GEOMETRY(Point, 4326),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active claim per challenge, enforced at DB level.
CREATE UNIQUE INDEX idx_one_active_claim_per_challenge
  ON challenge_claims (challenge_id)
  WHERE status = 'active';
```

### `resource_ledger`

```sql
CREATE TABLE resource_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         UUID NOT NULL REFERENCES games(id),
  team_id         UUID NOT NULL REFERENCES teams(id),
  player_id       UUID REFERENCES players(id),   -- NULL = team-level.
  resource_type   VARCHAR(50) NOT NULL,          -- Free-form string. Territory uses 'points'/'coins'.
                                                -- Other modes define their own resource type keys.
                                                -- The award loop processes whatever keys appear in
                                                -- challenge.scoring — not a fixed enum.
  delta           INTEGER NOT NULL,
  balance_after   INTEGER NOT NULL,
  sequence        BIGINT NOT NULL,                -- Monotonic per balance scope. Immune
                                                  -- to clock granularity. Incremented
                                                  -- in-transaction by application code.
  reason          VARCHAR(100) NOT NULL,
  reference_id    UUID,
  reference_type  VARCHAR(50),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sequence uniqueness per balance scope.
-- Two partial indexes because PostgreSQL treats NULLs as distinct in unique indexes.

-- Team-level resources (player_id IS NULL):
CREATE UNIQUE INDEX idx_resource_sequence_team
  ON resource_ledger (game_id, team_id, resource_type, sequence)
  WHERE player_id IS NULL;

-- Player-level resources (player_id IS NOT NULL):
CREATE UNIQUE INDEX idx_resource_sequence_player
  ON resource_ledger (game_id, team_id, player_id, resource_type, sequence)
  WHERE player_id IS NOT NULL;
```

**Reading balance:** `SELECT balance_after FROM resource_ledger WHERE game_id=$1 AND team_id=$2 AND resource_type=$3 AND player_id IS NULL ORDER BY sequence DESC LIMIT 1`. No rows = 0.

**Writing (inside DB transaction):** Lock latest row with `FOR UPDATE`, compute `new_balance = prev + delta`, `new_sequence = prev_sequence + 1`, validate (reject if negative and mode disallows debt), insert. The unique index guarantees no duplicate sequences.

### `game_events`

```sql
CREATE TABLE game_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         UUID NOT NULL REFERENCES games(id),
  state_version   BIGINT NOT NULL,
  event_type      VARCHAR(50) NOT NULL,
  entity_type     VARCHAR(50) NOT NULL,
  entity_id       UUID NOT NULL,
  actor_type      VARCHAR(20) NOT NULL,
  actor_id        UUID,
  actor_team_id   UUID,
  before_state    JSONB,
  after_state     JSONB,
  meta            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Engine events: `GAME_STARTED`, `GAME_PAUSED`, `GAME_ENDED`, `PLAYER_JOINED`, `OBJECTIVE_STATE_CHANGED`, `RESOURCE_CHANGED`, `CONTROL_STATE_CHANGED`, `ANNOTATION_ADDED`, `ANNOTATION_REMOVED`, `ADMIN_OVERRIDE`.

Mode events (Territory): `ZONE_CAPTURED`, `CHALLENGE_CLAIMED`, `CHALLENGE_RELEASED`, `CHALLENGE_COMPLETED`.

### `action_receipts`

```sql
CREATE TABLE action_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id),
  player_id     UUID NOT NULL REFERENCES players(id),
  action_type   VARCHAR(50) NOT NULL,
  action_id     VARCHAR(100) NOT NULL,
  request_hash  VARCHAR(128) NOT NULL,
  response      JSONB NOT NULL,
  status_code   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, action_type, action_id)
);
```

### `annotations`

```sql
CREATE TABLE annotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id     UUID NOT NULL REFERENCES games(id),
  created_by  UUID REFERENCES players(id),
  type        VARCHAR(20) NOT NULL,
  geometry    GEOMETRY(Geometry, 4326) NOT NULL,
  label       VARCHAR(255),
  style       JSONB NOT NULL DEFAULT '{}',
  visibility  VARCHAR(20) NOT NULL DEFAULT 'all',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `player_location_samples`

```sql
CREATE TABLE player_location_samples (
  id               BIGSERIAL PRIMARY KEY,
  game_id          UUID NOT NULL REFERENCES games(id),
  player_id        UUID NOT NULL REFERENCES players(id),
  recorded_at      TIMESTAMPTZ NOT NULL,
  location         GEOMETRY(Point, 4326) NOT NULL,
  gps_error_meters REAL,
  speed_mps        REAL,
  heading_degrees  REAL,
  source           VARCHAR(20) NOT NULL DEFAULT 'browser'
);
```

### Indexes

```sql
CREATE INDEX idx_zones_geometry ON zones USING GIST (geometry);
CREATE INDEX idx_location_samples_geo ON player_location_samples USING GIST (location);
CREATE INDEX idx_zones_game ON zones (game_id);
CREATE INDEX idx_zones_game_owner ON zones (game_id, owner_team_id);
CREATE INDEX idx_challenges_game_status ON challenges (game_id, status);
CREATE INDEX idx_challenges_zone ON challenges (zone_id);
CREATE INDEX idx_claims_challenge ON challenge_claims (challenge_id, status);
CREATE INDEX idx_claims_team ON challenge_claims (team_id, status);
CREATE INDEX idx_resource_balance ON resource_ledger
  (game_id, team_id, resource_type, sequence DESC) WHERE player_id IS NULL;
CREATE INDEX idx_resource_player_balance ON resource_ledger
  (game_id, player_id, resource_type, sequence DESC) WHERE player_id IS NOT NULL;
CREATE INDEX idx_events_version ON game_events (game_id, state_version);
CREATE INDEX idx_events_type ON game_events (game_id, event_type, created_at);
CREATE INDEX idx_players_session ON players (session_token);
CREATE INDEX idx_players_game_team ON players (game_id, team_id);
CREATE INDEX idx_receipts_lookup ON action_receipts (player_id, action_type, action_id);
CREATE INDEX idx_annotations_game ON annotations (game_id, visibility);
CREATE INDEX idx_location_cleanup ON player_location_samples (game_id, recorded_at);
```

### Key Spatial Queries

```sql
-- Player inside zone? (buffered ST_Covers — works for Polygon and Point geometry alike)
-- For Point zones, ST_Buffer produces a circle; claim_radius_meters sets its radius.
SELECT z.id, z.name FROM zones z
WHERE z.game_id = $1 AND z.is_disabled = FALSE
  AND ST_Covers(
    ST_Buffer(z.geometry::geography, COALESCE(z.claim_radius_meters, $2))::geometry,
    ST_SetSRID(ST_MakePoint($3, $4), 4326));

-- Distance to centroids
SELECT z.id, z.name,
  ST_Distance(z.centroid::geography,
    ST_SetSRID(ST_MakePoint($2,$3), 4326)::geography) AS distance_meters
FROM zones z WHERE z.game_id = $1 AND z.is_disabled = FALSE
ORDER BY distance_meters;
```

---

## 5. Authentication

1. **Registration:** `POST /game/:id/players` with `{ display_name }`. Creates a player in the game. Response sets `session_token` as an `httpOnly; Secure; SameSite=Strict` cookie. Client JS never sees the token.

2. **Team join:** `POST /game/:id/teams/join` with `{ join_code }`. Requires existing session cookie. Sets `player.team_id`. Returns updated player + team.

3. **REST auth:** Browser attaches cookie automatically. Fastify middleware reads it, looks up player, attaches `request.player`. Team-requiring endpoints check `player.team_id IS NOT NULL` → `403 NOT_ON_TEAM` if null.

4. **Socket.IO auth:** Handshake includes cookies automatically. Server extracts and validates session during `connection` event. Invalid → reject connection.

5. **`join_game`:** Auth already validated at connection time. Payload: `{ game_id, last_state_version }`. No token.

```
Register:    POST /game/:id/players { display_name }
             → Set-Cookie: session=<uuid>; HttpOnly; Secure; SameSite=Strict
             → 201 { player }

Join team:   POST /game/:id/teams/join { join_code }
             → Cookie attached automatically
             → 200 { player (with team_id set), team }

REST:        Cookie → middleware → request.player
Socket.IO:   Handshake cookie → validated on connection
join_game:   { game_id, last_state_version }
```

---

## 6. Mode System

### Mode Handler Interface

```typescript
interface ModeHandler {
  readonly modeKey: string;

  onGameStart(game: Game): Promise<void>;
  onGameEnd(game: Game): Promise<void>;
  handleAction(action: ModeAction): Promise<ModeActionResult>;
  checkWinCondition(game: Game): Promise<WinCheckResult>;
  registerRoutes(fastify: FastifyInstance): void;
  getInitialResources(): ResourceDefinition[];
  computeScoreboard(game: Game): Promise<ScoreboardEntry[]>;

  // Visibility seam. Called before every map-state response and broadcast.
  // Territory: identity function. Future asymmetric modes: real filtering.
  filterStateForViewer(
    fullState: GameStateSnapshot,
    viewer: { playerId: string; teamId: string; role?: string }
  ): GameStateSnapshot;
}
```

### Platform vs. Mode (Claim Example)

| Step | Owner |
|---|---|
| Parse + schema validate | Platform (Fastify) |
| Auth (cookie → player) | Platform middleware |
| Team membership check | Platform middleware |
| Idempotency check | Platform middleware |
| GPS freshness + error check | Platform middleware |
| Verify game active | Platform |
| Dispatch to mode | Platform calls `handler.handleAction(...)` |
| Lock challenge, verify available | Territory handler |
| Spatial containment | Territory (via platform spatial service) |
| Create claim, update challenge | Territory handler |
| Increment state_version | Platform (atomic, same transaction) |
| Log events (engine + mode) | Platform |
| Commit | Platform |
| Store action receipt | Platform |
| Filter state per viewer | Platform calls `handler.filterStateForViewer()` |
| Broadcast | Platform (broadcaster) |
| Schedule claim timeout | Territory handler |
| Return HTTP response | Platform |

Note: Resources are NOT awarded during claim. Territory awards resources on completion only. Other modes could define different behavior via their handler.

---

## 7. API Design

All routes prefixed `/api/v1`. Mutating endpoints accept `Idempotency-Key`. Responses include `X-State-Version`.

### Platform Endpoints

```
Game (admin):
  POST   /game                           Create game
  GET    /game/:id                       Get game state
  PATCH  /game/:id                       Update config
  POST   /game/:id/start|pause|end       Lifecycle

Teams:
  POST   /game/:id/teams                 Create team (admin)
  GET    /game/:id/teams                 List teams
  POST   /game/:id/teams/join            Join. Body: { join_code }
                                         Requires session cookie.
                                         Sets player.team_id.

Zones (admin):
  POST   /game/:id/zones                 Create (GeoJSON polygon)
  POST   /game/:id/zones/import          Bulk import (FeatureCollection)
  GET    /game/:id/zones                 List
  GET    /zones/:id                      Detail
  PATCH  /zones/:id                      Update
  DELETE /zones/:id                      Delete

Challenges (admin):
  POST   /game/:id/challenges            Create
  GET    /game/:id/challenges            List
  PATCH  /challenges/:id                 Update
  DELETE /challenges/:id                 Delete

Players:
  POST   /game/:id/players               Register. Body: { display_name }
                                         Sets session cookie.
  GET    /players/me                     Current player
  POST   /players/me/location            Update GPS (idempotent)
  POST   /players/me/push-subscribe      Web Push subscription

Map & Annotations:
  GET    /game/:id/map-state             Full snapshot (filtered via filterStateForViewer)
  POST   /game/:id/annotations           Create
  GET    /game/:id/annotations           List (visibility-filtered)
  DELETE /annotations/:id                Delete

Events & Sync:
  GET    /game/:id/events                Paginated
  GET    /game/:id/events/since/:version Delta sync
  GET    /game/:id/scoreboard            Standings

Resources:
  GET    /game/:id/resources             All team-level balances (V1: team only.
                                         Ledger supports player-level too for future modes.)
  GET    /game/:id/resources/:team_id    Single team's balances
  GET    /game/:id/resources/:team_id/history  Transactions
```

### Territory Mode Endpoints

```
POST   /challenges/:id/claim      Claim. Requires GPS payload.
POST   /challenges/:id/complete   Complete. Captures zone, awards resources.
POST   /challenges/:id/release    Release a claim.
```

### Admin Overrides

Every override logs `ADMIN_OVERRIDE`.

```
POST   /admin/challenges/:id/force-complete
POST   /admin/challenges/:id/reset
POST   /admin/zones/:id/assign-owner
POST   /admin/players/:id/move-team
POST   /admin/game/:id/rebroadcast-state
POST   /admin/resources/adjust
```

### Error Codes

`{ "error": { "code": "...", "message": "...", "details": {...} } }`. Client reacts to `code`.

| Code | Status | When |
|---|---|---|
| `GPS_TOO_OLD` | 422 | Reading older than `GPS_MAX_AGE_SECONDS` |
| `GPS_ERROR_TOO_HIGH` | 422 | Exceeds zone/global `max_gps_error_meters` |
| `OUTSIDE_ZONE` | 422 | Not within buffer. Details: `distance_meters`, `required_meters` |
| `CHALLENGE_ALREADY_CLAIMED` | 409 | Another team has active claim |
| `CHALLENGE_NOT_AVAILABLE` | 409 | Not 'available' |
| `CLAIM_EXPIRED` | 409 | Claim timed out |
| `CLAIM_NOT_YOURS` | 403 | Wrong team's claim |
| `NO_ACTIVE_CLAIM` | 404 | No active claim exists |
| `GAME_NOT_ACTIVE` | 403 | Game not 'active' |
| `NOT_ON_TEAM` | 403 | `player.team_id` is NULL |
| `TEAM_NOT_FOUND` | 404 | Invalid join code for this game |
| `ZONE_DISABLED` | 403 | Zone temporarily removed |
| `INSUFFICIENT_RESOURCES` | 422 | Not enough resource |
| `IDEMPOTENCY_CONFLICT` | 409 | Same key, different body |
| `RATE_LIMITED` | 429 | Too many requests |
| `UNAUTHORIZED` | 401 | Bad/missing session |
| `ADMIN_REQUIRED` | 403 | Needs admin token |
| `VALIDATION_ERROR` | 400 | Schema failed |

---

## 8. Real-Time Sync

### State Version

Every state change increments `games.state_version` atomically. Every broadcast and response includes it.

### Reconnection

```
Client emits join_game { game_id, last_state_version }

gap == 0        → up to date
0 < gap ≤ 1000  → game_state_delta (missing events)
gap > 1000      → game_state_sync (full snapshot)
no version      → full snapshot
```

All payloads pass through `filterStateForViewer`.

### Socket.IO Events (Server → Client)

Every broadcast includes `state_version` and `server_time`.

**Engine:** `game_state_sync`, `game_state_delta`, `game_started`, `game_paused`, `game_ended`, `player_joined`, `annotation_added`, `annotation_removed`, `resource_changed`.

**Territory:** `zone_captured`, `challenge_claimed`, `challenge_completed`, `challenge_released`, `challenge_spawned` (future: dynamic/timed challenge creation during active game; V1 uses static pre-created challenges only).

### Broadcaster

```typescript
class Broadcaster {
  send(gameId: string, event: string, data: any, options?: { teamId?: string }) {
    // Calls modeHandler.filterStateForViewer() before emitting.
    // V1 Territory: identity function.
    // Future: per-connection filtering for asymmetric modes.
  }
}
```

### Optimistic UI

Client updates Zustand immediately. Success → apply authoritative state. Error → rollback + toast. Timeout → retry with same `Idempotency-Key`.

---

## 9. Design Language

### Principles

1. **Cartographic warmth.** The visual language of navigation, expedition, and discovery. Warm earthy tones, typographic confidence, and a couple of steps toward skeuomorphism — without full material simulation. Think field guide or expedition manual, not fantasy RPG.

2. **Information density over negative space.** Closer to a well-designed reference book or game manual than a tech product landing page. Players mid-game want data, not hero images. Denser layouts, confident hierarchy, comfortable with text.

3. **Functionality first, motifs where they fit.** The map stays a map. Forms stay forms. The adventure aesthetic enhances panels, cards, and chrome but never compromises usability — especially on mobile.

4. **Playful.** Warm expressive typography, satisfying micro-interactions (bounce on zone capture, pulse on active claim, celebration on completion), visual personality in icons and challenge cards. This is a game; it should feel like one.

### Map

Custom Mapbox Standard derivative: faded theme, muted blue-gray roads, minimal labels (no road names, no POI, no admin boundaries), League Mono typeface. Designed as a quiet backdrop so game elements — zone polygons, deck chrome, team colors — own the visual foreground.

Style: `mapbox://styles/saamoz/cmng3j80c004001s831aw5e3b/draft`

### Palette

- **UI chrome**: warm and earthy — cream, aged-paper off-whites, amber accents, deep navy or forest green for contrast.
- **Team colors**: vivid and user-defined (red, blue, gold, etc.). The UI steps back to let them dominate zone fills and scoreboards.
- **Map base**: cool and faded. Provides spatial context without competing for attention.

### Typography

Typographic warmth and color over texture. Serif or semi-serif for display and headers to carry heritage character; clean readable type for body and UI controls. The map itself uses League Mono.

### Admin Panel

Utilitarian. The admin panel prioritizes speed and clarity over visual personality. Standard clean UI patterns — the cartographic aesthetic is not required here.

---

## 10. Frontend

### Pages

```
/                      Landing / register / join team
/game/:id              Main game view
/game/:id/challenges   Challenge list
/game/:id/feed         Event feed
/game/:id/scores       Scoreboard
/admin                 Admin panel
/admin/zones           Zone editor
/admin/challenges      Challenge manager
```

### Main Game View

```
<GameView>
├── <MapContainer>              Mapbox GL JS
│   ├── <ZoneLayer>             Colored polygons only
│   ├── <PlayerLocationMarker>  Pulsing blue dot
│   ├── <AnnotationLayer>       Team + all annotations
│   └── <DistanceTool>          Tap → distance in mi/km
├── <GameHUD>
│   ├── <TeamBanner>            Name, color, resources
│   ├── <ChallengeDeck>         Card tray for portable objectives
│   ├── <SelectedChallenge>     Detail + actions for the chosen card
│   └── <MiniScoreboard>
├── <LiveFeed>
└── <NotificationToast>
```

### Zustand Store

```typescript
interface GameStore {
  connected: boolean;
  socket: Socket | null;
  stateVersion: number;
  player: Player | null;       // player.teamId may be null
  team: Team | null;
  game: Game | null;
  zones: Map<string, Zone>;
  challenges: Map<string, Challenge>;
  claims: Map<string, ChallengeClaim>;
  teams: Map<string, Team>;
  annotations: Map<string, Annotation>;
  teamResources: Map<string, Map<string, number>>;
  selectedZoneId: string | null;
  activeChallengeId: string | null;
  playerLocation: GpsPayload | null;
  mapMode: 'play' | 'measure';
  pendingActions: Map<string, PendingAction>;
}
```

### GPS Payload

```typescript
interface GpsPayload {
  lat: number;
  lng: number;
  gpsErrorMeters: number;        // Error radius from coords.accuracy.
  speedMps: number | null;
  headingDegrees: number | null;
  capturedAt: string;            // ISO from Position.timestamp.
}
```

### Mobile-First

Full-screen map, bottom sheets, 48px min touch targets (56px for claim/complete), adaptive GPS (10s/30s/60s), Zustand persistence, PWA manifest.

---

## 11. GPS Validation

Trust-based. The platform assumes players are honest; validation catches technical issues (stale fix, impossible jump) rather than policing behaviour.

**Middleware** (applies to all GPS endpoints — always enforced):

1. **Freshness:** `capturedAt` within `GPS_MAX_AGE_SECONDS` (30s). A stale fix is technically unreliable regardless of trust. → `GPS_TOO_OLD`
2. **Velocity (log only):** > `GPS_MAX_VELOCITY_KMH` (200) → log warning, do not block.

**Claim handler** (applies to `POST /challenges/:id/claim`):

3. **Proximity:** `ST_Covers(ST_Buffer(zone.geometry, buffer), point)`. Buffer = zone `claim_radius_meters` or global `GPS_BUFFER_METERS` (40m). Always enforced — physically reaching the zone is the core game mechanic. → `OUTSIDE_ZONE`
4. **Error radius** *(opt-in)*: Enforced only when `game.settings.require_gps_accuracy = true`. Checks `gpsErrorMeters` against zone's `max_gps_error_meters`, then global `GPS_MAX_ERROR_METERS` (100m). Default is `false` — players in urban canyons with poor reported accuracy are not blocked if they are physically present. → `GPS_ERROR_TOO_HIGH`

---

## 12. Territory Mode

### Rules

First playable draft: challenges come from a shared portable deck. Players physically enter a zone, choose a card, and complete it against their current zone. Location-pinned challenges can return later as an advanced variant. Completion captures zone, awards resources, consumes challenge. Claims auto-expire after timeout. Max concurrent claims: configurable (default 1).

### Resources

Territory defines two resource types: `points` (team-level, primary scoring) and `coins` (team-level, reserved for future shop mechanics). Both initialize to 0 per team on game start.

Resource types are mode-defined strings stored in `resource_ledger.resource_type`. Future modes may define their own types (e.g. `energy`, `influence`) without schema changes. The platform resource award loop processes whatever keys appear in `challenge.scoring` — it does not validate against a fixed enum.

### Win Conditions

| Type | Config | Trigger |
|---|---|---|
| `all_zones` | `{}` | One team owns all non-disabled zones |
| `zone_majority` | `{"threshold":0.6}` | ≥60% zones |
| `time_limit` | `{"duration_minutes":120}` | Clock expires. Most zones (tiebreak: points) |
| `score_threshold` | `{"target":500}` | Team reaches target |

### Claim Flow

```
1. Player taps "Claim" → client captures GPS, generates actionId
2. Optimistic UI: mark challenge as claimed in Zustand
3. POST /challenges/:id/claim with Idempotency-Key + GPS body
4. Server (single DB transaction):
   a. Idempotency check → replay if duplicate
   b. Validate: game active, player on team
   c. GPS: freshness, error radius
   d. SELECT challenge FOR UPDATE → verify status = 'available'
   e. ST_Covers → verify player within zone buffer
   f. INSERT challenge_claims (active, expires_at)
      — partial unique index rejects if another active claim exists
   g. UPDATE challenge (claimed, current_claim_id)
   h. INCREMENT state_version
   i. INSERT game_events (OBJECTIVE_STATE_CHANGED + CHALLENGE_CLAIMED)
   j. COMMIT
5. Store action receipt
6. filterStateForViewer (no-op)
7. Broadcast challenge_claimed
8. Schedule timeout → on expiry: release claim, broadcast
9. Return 200 { claim, challenge, state_version }
10. Client: resolve pending action, apply authoritative state
```

### Complete Flow

```
1. Player taps "Complete" → client generates actionId
   Optionally captures submission (text, photo, quiz answer)
2. Optimistic UI: challenge completed, zone captured
3. POST /challenges/:id/complete with Idempotency-Key + { submission? }
4. Server (single DB transaction):
   a. Idempotency check → replay if duplicate
   b. Validate: game active, player on team
   c. Load challenge + current claim via current_claim_id
   d. Verify claim exists and status = 'active'
   e. Verify claim.team_id matches player's team
   f. Check claim expiry: if expires_at < NOW():
      — UPDATE claim: status = 'expired', released_at = NOW()
      — UPDATE challenge: status = 'available', current_claim_id = NULL
      — INCREMENT state_version
      — INSERT game_events (OBJECTIVE_STATE_CHANGED + CHALLENGE_RELEASED)
      — COMMIT (persist the expiry cleanup)
      — Broadcast challenge_released
      — Return 409 CLAIM_EXPIRED
      — STOP (do not proceed to completion)
   g. UPDATE claim: status = 'completed', completed_at = NOW(),
      submission = request body
   h. UPDATE challenge: status = 'completed', current_claim_id = NULL
   i. Load zone via challenge.zone_id
   j. Record zone before_state: { owner_team_id, captured_at }
   k. UPDATE zone: owner_team_id = player's team, captured_at = NOW()
   l. Write resource transactions:
      — Read scoring from challenge (e.g. {"points":10,"coins":5})
      — For each resource type:
        Lock latest ledger row (FOR UPDATE)
        Compute new_balance = prev_balance + delta, new_sequence = prev_sequence + 1
        INSERT resource_ledger row
        — Sequence uniqueness index prevents corruption
   m. INCREMENT state_version
   n. INSERT game_events:
      — OBJECTIVE_STATE_CHANGED (engine): challenge claimed → completed
      — CONTROL_STATE_CHANGED (engine): zone owner change
      — RESOURCE_CHANGED (engine): one per resource type
      — CHALLENGE_COMPLETED (mode)
      — ZONE_CAPTURED (mode)
   o. COMMIT
5. Store action receipt
6. filterStateForViewer (no-op)
7. Broadcast: challenge_completed, zone_captured, resource_changed
8. Evaluate win condition → if met: end game, broadcast game_ended
9. Push notifications to rival teams + own team
10. Return 200 { claim, challenge, zone, resources_awarded, state_version }
11. Client: resolve pending action, apply authoritative state
```

### Release Flow

```
1. Player taps "Release" → client generates actionId
2. POST /challenges/:id/release with Idempotency-Key
3. Server (single DB transaction):
   a. Idempotency check
   b. Validate: game active, player on team
   c. Load challenge + current claim
   d. Verify claim exists, status = 'active', team matches
   e. UPDATE claim: status = 'released', released_at = NOW()
   f. UPDATE challenge: status = 'available', current_claim_id = NULL
   g. INCREMENT state_version
   h. INSERT game_events (OBJECTIVE_STATE_CHANGED + CHALLENGE_RELEASED)
   i. COMMIT
4. Store receipt, filterStateForViewer, broadcast, return 200
```

---

## 13. Zone Management

**Auto-import:** Overpass API for admin boundaries (level 9/10). Preview → select → import.

**Manual:** Terra Draw with Mapbox adapter. Draw, edit, delete, split. Configure per-zone thresholds.

**Chicago:** Import 77 areas → split large → disable impractical → align streets → tune GPS after playtesting.

---

## 14. Notifications

Web Push via `web-push`. Requires HTTPS (Caddy).

Territory triggers: zone captured by rival (high), challenge nearby (high), claim expiring 2 min (high), game lifecycle (high), milestone (medium), teammate completed (low).

Max 1 push/player/60s. Players can mute individual categories.

---

## 15. Deployment

```
Proxmox LXC (Ubuntu 24.04, 2GB RAM, 2 cores)
├── Caddy (:443) → auto HTTPS, WebSocket, static files
├── Fastify + Socket.IO (:3000)
└── PostgreSQL 16 + PostGIS 3.4 (:5432)
```

Create LXC → install deps → create DB + PostGIS → clone → install → migrate → build frontend → pm2 → Caddy → DNS.

---

## 16. Project Structure

```
territory/
├── client/
│   ├── public/                    manifest.json, sw.js
│   └── src/
│       ├── components/
│       │   ├── map/               MapContainer, ZoneLayer, ChallengeMarkers,
│       │   │                      PlayerMarker, AnnotationLayer, DistanceTool
│       │   ├── hud/               GameHUD, TeamBanner, ZoneInfoPanel,
│       │   │                      ChallengeCard, MiniScoreboard
│       │   ├── admin/             AdminLayout, ZoneEditor, ChallengeManager,
│       │   │                      GameSettings
│       │   ├── feed/              LiveFeed, EventCard
│       │   └── common/            BottomSheet, NotificationToast, LoadingSpinner
│       ├── hooks/                 useSocket, useGeolocation, useGameState,
│       │                          useIdempotentAction, useMapTools
│       ├── store/                 gameStore.ts
│       ├── lib/                   api, socket, mapbox, terraDraw, geo
│       └── pages/                 Landing, GameView, Scoreboard, AdminPanel
├── server/
│   └── src/
│       ├── routes/                game, teams, zones, challenges, players,
│       │                          annotations, events, resources, admin
│       ├── services/              gameService, spatialService, challengeService,
│       │                          claimService, resourceService, idempotencyService,
│       │                          notificationService, eventService, osmImportService
│       ├── modes/
│       │   ├── index.ts           Registry + loader
│       │   └── territory/
│       │       ├── handler.ts     TerritoryModeHandler
│       │       ├── routes.ts      claim, complete, release
│       │       ├── rules.ts       Claim lifecycle, zone capture
│       │       ├── scoring.ts     Awards, scoreboard
│       │       └── winConditions.ts
│       ├── socket/                handlers, rooms, broadcaster
│       ├── db/                    schema, migrations, connection
│       ├── middleware/            auth, admin, idempotency, gpsValidation
│       ├── lib/                   push, overpass, errors
│       └── jobs/                  claimTimeout, locationCleanup
├── shared/                        types, events, errors, resources, constants
├── Caddyfile
└── README.md
```

---

## 17. Build Phases

### Phase 1 — Foundation (Week 1–2)
- Monorepo, Drizzle schema (with circular FK migration), all indexes
- Error codes, cookie-based auth middleware, admin middleware
- Game/zone/team CRUD
- Mapbox map + ZoneLayer, Terra Draw zone editor
- OSM import, resource ledger service
- Mode registry, stub Territory handler

### Phase 2 — Core Gameplay (Week 3–4)
- Registration (`POST /game/:id/players`), team join (`POST /game/:id/teams/join`)
- Idempotency middleware, GPS validation middleware
- Socket.IO: cookie-handshake auth, rooms, broadcaster + filterStateForViewer
- Events + state_version + delta sync
- Challenge CRUD, Territory claim/complete/release (full flows)
- Claim timeout job, win conditions
- Map updates, feed, Zustand sync, optimistic UI

### Phase 3 — Polish (Week 5–6)
- Distance tool, annotations, scoreboard
- Web Push + Territory triggers
- PWA, bottom sheets, mobile UI
- Admin panel + overrides
- Performance

### Phase 4 — Playtest (Week 7–8)
- Deploy, load test, reconnection test
- Chicago zones, 20–30 challenges
- 4 teams × 3–5 players, 2–3 hours
- Review events, samples, receipts, overrides
- Iterate

---

## 18. Environment Variables

```bash
DATABASE_URL=postgresql://territory:password@localhost:5432/territory
MAPBOX_ACCESS_TOKEN=pk.xxxxx
VAPID_PUBLIC_KEY=BNxxxxx
VAPID_PRIVATE_KEY=xxxxx
VAPID_SUBJECT=mailto:admin@yourdomain.com
ADMIN_TOKEN=xxxxx
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
CORS_ORIGIN=https://territory.yourdomain.com
GPS_BUFFER_METERS=40
GPS_MAX_ERROR_METERS=100
GPS_MAX_AGE_SECONDS=30
GPS_MAX_VELOCITY_KMH=200
CLAIM_TIMEOUT_MINUTES=10          # Server-wide default. Override per game via game.settings.claim_timeout_minutes
LOCATION_RETENTION_HOURS=48
```

---

## 19. Technical Risks

| Risk | Mitigation |
|---|---|
| GPS urban canyons | Buffered ST_Covers + per-zone overrides + admin override |
| Battery drain | Adaptive GPS (10s/30s/60s) + long-polling fallback |
| Claim races | Row locks + partial unique index + idempotent actions |
| Mapbox free tier | <50 players ≈ 1-2K loads/day |
| Reconnection storms | Exponential backoff + delta sync |
| Internet loss | Zustand persistence + auto-reconnect + idempotent retry |
| Double-tap | Idempotency-Key + action_receipts |
| Resource races | FOR UPDATE + monotonic sequence + uniqueness indexes |
| Claim timeout after restart | Startup scan: expire stale active claims |
| Cross-game data leaks (V2) | App-layer enforcement now; composite FKs evaluated in V2 |

---

*Single source of truth for Territory Platform V1.*