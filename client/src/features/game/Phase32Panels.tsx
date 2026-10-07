import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { GameEventRecord, Player, Team, TeamResourcesByTeam, Zone } from '@city-game/shared';

export interface FeedEntry {
  id: string;
  title: string;
  body: string | null;
  createdAt: string;
  accentColor?: string;
  zoneId?: string;
}

export interface ZoneScoreboardEntry {
  team: Team;
  zoneCount: number;
  rank: number;
  playerNames: string[];
  scoreLabel: string;
  scoreUnit: 'zones' | 'points';
}

interface MiniScoreboardCardProps {
  entries: ZoneScoreboardEntry[];
  teamId: string | null;
  onOpenScoreboard(): void;
  onOpenFeed(): void;
}

interface ScoreboardOverlayProps {
  entries: ZoneScoreboardEntry[];
  teamId?: string | null;
  onClose(): void;
}

interface FeedOverlayProps {
  entries: FeedEntry[];
  isLoading: boolean;
  errorMessage: string | null;
  onClose(): void;
  onFocusZone(zoneId: string): void;
}

export interface ZoneScoreboardInput {
  teams: Team[] | undefined;
  players: Player[] | undefined;
  zones: Zone[] | undefined;
  teamResources: TeamResourcesByTeam | undefined;
  modeKey: string | null;
}

export function buildZoneScoreboard({ teams, players, zones, teamResources, modeKey }: ZoneScoreboardInput): ZoneScoreboardEntry[] {
  if (!teams || !players || !zones || !teamResources) {
    return [];
  }

  const zoneCounts = new Map<string, number>();
  const playerNamesByTeamId = new Map<string, string[]>();

  for (const player of players) {
    if (!player.teamId) {
      continue;
    }

    const currentNames = playerNamesByTeamId.get(player.teamId) ?? [];
    currentNames.push(player.displayName);
    playerNamesByTeamId.set(player.teamId, currentNames);
  }
  for (const zone of zones) {
    if (!zone.ownerTeamId) {
      continue;
    }

    zoneCounts.set(zone.ownerTeamId, (zoneCounts.get(zone.ownerTeamId) ?? 0) + 1);
  }

  return [...teams]
    .map((team) => ({
      team,
      zoneCount: modeKey === 'point_challenge' ? (teamResources[team.id]?.points ?? 0) : (zoneCounts.get(team.id) ?? 0),
      rank: 0,
      playerNames: playerNamesByTeamId.get(team.id) ?? [],
      scoreUnit: modeKey === 'point_challenge' ? 'points' as const : 'zones' as const,
      scoreLabel: modeKey === 'point_challenge' ? ((teamResources[team.id]?.points ?? 0) + ' pts') : ((zoneCounts.get(team.id) ?? 0) + ' zones'),
    }))
    .sort((left, right) => {
      const zoneDelta = right.zoneCount - left.zoneCount;
      if (zoneDelta !== 0) {
        return zoneDelta;
      }

      const nameCompare = left.team.name.localeCompare(right.team.name);
      if (nameCompare !== 0) {
        return nameCompare;
      }

      return left.team.id.localeCompare(right.team.id);
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));
}

export function buildFeedEntriesForTeams(events: GameEventRecord[], teams: Team[]): FeedEntry[] {
  const teamNameById = new Map(teams.map((team) => [team.id, team.name]));
  const teamColorById = new Map(teams.map((team) => [team.id, team.color]));

  return events
    .map((event) => formatFeedEntry(event, teamNameById, teamColorById))
    .filter((entry): entry is FeedEntry => entry !== null);
}

// Standings and feed are scribbled on a scrap of notepaper: handwriting in ballpoint blue, a red pen
// for what matters, and the sheet unfolds from a crumpled ball when it opens.
const PEN = '#233a68';
const RED_PEN = '#c0392b';
const PENCIL = '#5d6271';

export function MiniScoreboardCard({ entries, teamId, onOpenScoreboard, onOpenFeed }: MiniScoreboardCardProps) {
  const leaders = entries.slice(0, 3);

  return (
    <div className="scrap-paper-wrap">
      <section className="scrap-paper px-4 pb-3 pt-3" style={{ clipPath: roughEdge(7) }}>
        <div className="flex items-center justify-between gap-3">
          <ScrawlTitle size="sm">Standings</ScrawlTitle>
          <div className="relative flex items-center gap-3 font-hand text-sm" style={{ color: PEN }}>
            <button className="underline decoration-[#233a68]/40 decoration-wavy underline-offset-4 hover:decoration-[#233a68]" onClick={onOpenFeed} type="button">feed</button>
            <button className="underline decoration-[#233a68]/40 decoration-wavy underline-offset-4 hover:decoration-[#233a68]" onClick={onOpenScoreboard} type="button">all teams</button>
          </div>
        </div>
        <ol className="relative mt-1.5 space-y-0.5">
          {leaders.map((entry) => (
            <li key={entry.team.id} className={['flex items-baseline gap-2 px-1.5', entry.team.id === teamId ? 'scrap-highlight' : ''].join(' ')}>
              <span className="w-4 font-scrawl text-xl leading-7" style={{ color: PEN }}>{entry.rank}.</span>
              <TeamMark color={entry.team.color} />
              <span className="min-w-0 flex-1 truncate font-scrawl text-xl leading-7" style={{ color: PEN }}>{entry.team.name}</span>
              <span className="font-scrawl text-xl leading-7" style={{ color: PEN }}>{entry.zoneCount}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function ScoreboardOverlay({ entries, teamId = null, onClose }: ScoreboardOverlayProps) {
  const topScore = entries[0]?.zoneCount ?? 0;
  return (
    <OverlayShell title="Standings" onClose={onClose}>
      {entries.length === 0 ? <PanelMessage tone="default" message="No teams yet." /> : null}
      <ol className="space-y-1.5 pb-1">
        {entries.map((entry) => {
          const isMine = entry.team.id === teamId;
          const isLeader = topScore > 0 && entry.zoneCount === topScore;
          return (
            <li key={entry.team.id} className={['relative px-2 py-1', isMine ? 'scrap-highlight' : ''].join(' ')}>
              <div className="flex items-baseline gap-2">
                <span className="w-7 shrink-0 font-scrawl text-[1.7rem] leading-9" style={{ color: PEN }}>{entry.rank}.</span>
                <TeamMark color={entry.team.color} />
                <span className="min-w-0 truncate font-scrawl text-[1.7rem] leading-9" style={{ color: PEN }}>{entry.team.name}</span>
                <span aria-hidden="true" className="min-w-4 flex-1 -translate-y-2 border-b-2 border-dotted" style={{ borderColor: 'rgba(35,58,104,0.3)' }} />
                <span className="relative shrink-0 px-1.5 font-scrawl text-[1.7rem] leading-9" style={{ color: isLeader ? RED_PEN : PEN }}>
                  {entry.zoneCount}
                  <span className="ml-1 font-hand text-sm">{entry.scoreUnit === 'points' ? (entry.zoneCount === 1 ? 'pt' : 'pts') : (entry.zoneCount === 1 ? 'zone' : 'zones')}</span>
                  {isLeader ? <ScribbleCircle /> : null}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 pl-9">
                <p className="min-w-0 truncate font-hand text-[13px] leading-5" style={{ color: PENCIL }}>{entry.playerNames.length ? entry.playerNames.join(', ') : 'nobody yet'}</p>
                {isMine ? <span className="shrink-0 -rotate-3 font-scrawl text-lg leading-5" style={{ color: RED_PEN }}>← us!</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </OverlayShell>
  );
}

export function FeedOverlay({ entries, isLoading, errorMessage, onClose, onFocusZone }: FeedOverlayProps) {
  return (
    <OverlayShell ruled title="Field notes" onClose={onClose}>
      {isLoading ? <PanelMessage tone="default" message="Flipping back through the notes…" /> : null}
      {errorMessage ? <PanelMessage tone="danger" message={errorMessage} /> : null}
      {!isLoading && !errorMessage && entries.length === 0 ? <PanelMessage tone="default" message="Nothing jotted down yet." /> : null}

      {entries.length ? (
        <ol>
          {entries.map((entry) => {
            const content = (
              <>
                <span className="block -rotate-2 truncate pr-2 text-right font-hand text-[11px] leading-7" style={{ color: PENCIL }}>{formatEventTime(entry.createdAt)}</span>
                <span className="block min-w-0 pl-2.5">
                  <span className="font-hand text-[15px] leading-7" style={{ color: PEN }}>
                    {entry.accentColor ? <TeamMark color={entry.accentColor} inline /> : null}
                    {entry.title}
                  </span>
                  {entry.body ? <span className="block font-hand text-[13px] leading-7" style={{ color: PENCIL }}>{entry.body}</span> : null}
                  {entry.zoneId ? <span className="block font-scrawl text-lg leading-7" style={{ color: RED_PEN }}>→ see it on the map</span> : null}
                </span>
              </>
            );
            const className = 'grid w-full grid-cols-[3.1rem_minmax(0,1fr)] text-left';
            return (
              <li key={entry.id}>
                {entry.zoneId ? (
                  <button className={className + ' transition hover:bg-[#233a68]/[0.04]'} onClick={() => onFocusZone(entry.zoneId!)} type="button">{content}</button>
                ) : (
                  <div className={className}>{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </OverlayShell>
  );
}

export function OverlayShell({ title, onClose, ruled = false, children }: { title: string; onClose(): void; ruled?: boolean; children: ReactNode }) {
  const dragRefs = useOverlayDragRefs();
  const closeTimerRef = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  // Each sheet sits a little crooked, like a note dropped on the map.
  const [tilt] = useState(() => (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.6));
  const [edge] = useState(() => roughEdge(Math.floor(Math.random() * 1000)));

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  const requestClose = () => {
    if (closeTimerRef.current !== null) return;
    setIsClosing(true);
    setIsDragging(false);
    // Scrunched back into a ball and tossed.
    closeTimerRef.current = window.setTimeout(onClose, 230);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (isClosing) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRefs.pointerId.current = event.pointerId;
    dragRefs.startY.current = event.clientY;
    dragRefs.startTime.current = Date.now();
    dragRefs.didDrag.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (isClosing || dragRefs.pointerId.current !== event.pointerId) {
      return;
    }

    const deltaY = event.clientY - dragRefs.startY.current;

    if (!dragRefs.didDrag.current && Math.abs(deltaY) < 8) {
      return;
    }

    dragRefs.didDrag.current = true;
    event.preventDefault();
    setIsDragging(true);
    setDragOffset(deltaY < 0 ? deltaY : Math.round(deltaY * 0.2));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (isClosing || dragRefs.pointerId.current !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const didDrag = dragRefs.didDrag.current;
    const deltaY = event.clientY - dragRefs.startY.current;
    const velocity = deltaY / Math.max(Date.now() - dragRefs.startTime.current, 1);
    clearOverlayDragRefs(dragRefs);
    setIsDragging(false);

    if (didDrag && (deltaY < -90 || (deltaY < -36 && velocity < -0.55))) {
      requestClose();
      return;
    }

    setDragOffset(0);
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center px-3 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] lg:items-center lg:p-6">
      <div
        className="pointer-events-auto w-full max-w-xl"
        style={{ transform: `translateY(${dragOffset}px)`, transition: isDragging ? 'none' : 'transform 0.26s cubic-bezier(0.22,1,0.36,1)' }}
      >
        <div className={'scrap-paper-wrap relative ' + (isClosing ? 'scrap-paper-exit' : 'scrap-paper-enter')} style={{ '--scrap-tilt': tilt.toFixed(2) + 'deg' } as CSSProperties}>
          <section className={'scrap-paper flex max-h-[76vh] flex-col ' + (ruled ? 'scrap-paper--ruled' : '')} style={{ clipPath: edge }}>
            <header className="relative z-[1] flex items-start justify-between gap-4 px-5 pb-1 pt-5">
              <ScrawlTitle>{title}</ScrawlTitle>
              <button aria-label="Close" className="relative -mr-1 -mt-1 grid h-11 w-11 shrink-0 place-items-center font-scrawl text-[1.6rem] leading-none" onClick={requestClose} style={{ color: PEN }} type="button">
                ✕
                <ScribbleCircle />
              </button>
            </header>
            <div className="scrap-paper__lines relative z-[1] overflow-y-auto overscroll-contain px-4 pb-3 pt-1 [touch-action:pan-y]">{children}</div>
            <div
              aria-hidden="true"
              className="relative z-[1] flex touch-none cursor-grab justify-center pb-3 pt-1 active:cursor-grabbing"
              onPointerCancel={handlePointerEnd}
              onPointerDown={(event) => { if (!isOverlayInteractiveTarget(event.target)) handlePointerDown(event); }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
            >
              <svg className="h-2 w-12" fill="none" viewBox="0 0 48 8"><path d="M2 5c6-3 10 2 16 0s10-3 16-1 8 2 12 0" stroke={PENCIL} strokeLinecap="round" strokeOpacity="0.45" strokeWidth="2" /></svg>
            </div>
          </section>
          <span aria-hidden="true" className="scrap-tape" />
        </div>
      </div>
    </div>
  );
}

function ScrawlTitle({ children, size = 'lg' }: { children: ReactNode; size?: 'sm' | 'lg' }) {
  return (
    <h2 className={'relative w-fit font-scrawl font-bold leading-none ' + (size === 'lg' ? 'text-[2.3rem]' : 'text-[1.6rem]')} style={{ color: PEN }}>
      {children}
      <svg aria-hidden="true" className="absolute -bottom-2 left-0 h-3 w-full" fill="none" preserveAspectRatio="none" viewBox="0 0 120 12">
        <path d="M2 8c14-4 26 2 40-1s24-5 38-2 26 3 38-2" stroke={RED_PEN} strokeLinecap="round" strokeWidth="2.4" />
      </svg>
    </h2>
  );
}

// A quick loop of red pen around something, never quite closed.
function ScribbleCircle() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute -inset-x-1 -inset-y-0.5 h-[calc(100%+0.25rem)] w-[calc(100%+0.5rem)]" fill="none" preserveAspectRatio="none" viewBox="0 0 100 60">
      <path d="M58 6C30 2 6 12 5 30s24 27 50 26 41-12 40-28S70 3 44 6" stroke={RED_PEN} strokeLinecap="round" strokeWidth="2.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// The team's colour as a hurried scribble of felt-tip.
function TeamMark({ color, inline = false }: { color: string; inline?: boolean }) {
  return (
    <svg aria-hidden="true" className={inline ? 'mr-1.5 inline-block h-3.5 w-3.5 -translate-y-px align-middle' : 'h-4 w-4 shrink-0 self-center'} fill="none" viewBox="0 0 20 20">
      <path d="M4 11c1-5 7-8 11-5s1 9-4 9-6-5-2-7 6 0 5 3" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.2" />
    </svg>
  );
}

// A torn, slightly uneven outline so the sheet never has perfectly straight edges.
function roughEdge(seed: number): string {
  let state = seed * 9301 + 49297;
  const next = () => { state = (state * 9301 + 49297) % 233280; return state / 233280; };
  const jitter = (max: number) => (next() * max).toFixed(1) + 'px';
  const points: string[] = [];
  for (let step = 0; step <= 10; step += 1) points.push(`${step * 10}% ${jitter(4)}`);
  for (let step = 1; step <= 10; step += 1) points.push(`calc(100% - ${jitter(4)}) ${step * 10}%`);
  for (let step = 9; step >= 0; step -= 1) points.push(`${step * 10}% calc(100% - ${jitter(6)})`);
  for (let step = 9; step >= 1; step -= 1) points.push(`${jitter(4)} ${step * 10}%`);
  return `polygon(${points.join(', ')})`;
}

interface OverlayDragRefs {
  pointerId: MutableRefObject<number | null>;
  startY: MutableRefObject<number>;
  startTime: MutableRefObject<number>;
  didDrag: MutableRefObject<boolean>;
}

function useOverlayDragRefs(): OverlayDragRefs {
  return {
    pointerId: useRef<number | null>(null),
    startY: useRef(0),
    startTime: useRef(0),
    didDrag: useRef(false),
  };
}

function clearOverlayDragRefs(dragRefs: OverlayDragRefs): void {
  dragRefs.pointerId.current = null;
  dragRefs.didDrag.current = false;
}

function PanelMessage({ message, tone }: { message: string; tone: 'default' | 'danger' }) {
  return <p className="font-hand text-[15px] leading-7" style={{ color: tone === 'danger' ? RED_PEN : PENCIL }}>{message}</p>;
}

function formatFeedEntry(
  event: GameEventRecord,
  teamNameById: Map<string, string>,
  teamColorById: Map<string, string>,
): FeedEntry | null {
  switch (event.eventType) {
    case 'ZONE_CAPTURED': {
      const zone = asNamedObject(event.meta.zone);
      const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'Unknown team' : 'Unknown team';
      return {
        id: event.id,
        title: `${teamName} captured ${zone?.name ?? 'a zone'}`,
        body: null,
        createdAt: event.createdAt,
        accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : undefined,
        zoneId: zone?.id,
      };
    }
    case 'CHALLENGE_CLAIMED': {
      const challenge = asNamedObject(event.meta.challenge);
      const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'A team' : 'A team';
      return { id: event.id, title: `${teamName} claimed ${challenge?.name ?? 'a challenge'}`, body: null, createdAt: event.createdAt, accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : undefined };
    }
    case 'CHALLENGE_RELEASED': {
      const challenge = asNamedObject(event.meta.challenge);
      const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'A team' : 'A team';
      return { id: event.id, title: `${teamName} released ${challenge?.name ?? 'a challenge'}`, body: null, createdAt: event.createdAt, accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : undefined };
    }
    case 'CHALLENGE_COMPLETED': {
      const challenge = asNamedObject(event.meta.challenge);
      const zone = asNamedObject(event.meta.zone);
      if (zone) return null;
      const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'A team' : 'A team';
      if (event.meta.judged === true) {
        return { id: event.id, title: `${teamName} completed ${challenge?.name ?? 'a challenge'}`, body: 'Judged bonus', createdAt: event.createdAt, accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : undefined };
      }
      const awardedPoints = asRecord(event.meta.resourcesAwarded)?.points;
      return { id: event.id, title: `${teamName} completed ${challenge?.name ?? 'a challenge'}`, body: typeof awardedPoints === 'number' && awardedPoints !== 0 ? '+' + awardedPoints + (Math.abs(awardedPoints) === 1 ? ' pt' : ' pts') : null, createdAt: event.createdAt, accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : undefined };
    }
    case 'CHALLENGE_REROLL_STATE_CHANGED': {
      const challenge = asNamedObject(event.meta.challenge);
      const didReroll = asRecord(event.afterState)?.didReroll === true;
      const teamName = event.actorTeamId ? teamNameById.get(event.actorTeamId) ?? 'A team' : 'A team';
      return { id: event.id, title: didReroll ? `${challenge?.name ?? 'A challenge'} was rerolled` : `${teamName} voted to reroll`, body: didReroll ? 'A replacement challenge entered the deck.' : challenge?.name ?? null, createdAt: event.createdAt, accentColor: event.actorTeamId ? teamColorById.get(event.actorTeamId) : '#c8a86b' };
    }
    case 'CHALLENGE_SPAWNED': {
      const challenge = asNamedObject(event.meta.challenge);
      return {
        id: event.id,
        title: `New challenge: ${challenge?.name ?? 'Untitled challenge'}`,
        body: null,
        createdAt: event.createdAt,
        accentColor: '#c8a86b',
      };
    }
    case 'GAME_STARTED':
      return { id: event.id, title: 'Game started', body: null, createdAt: event.createdAt };
    case 'GAME_PAUSED':
      return { id: event.id, title: 'Game paused', body: null, createdAt: event.createdAt };
    case 'GAME_RESUMED':
      return { id: event.id, title: 'Game resumed', body: null, createdAt: event.createdAt };
    case 'GAME_ENDED': {
      const winnerTeamId = asString(event.meta.winnerTeamId);
      const winnerName = winnerTeamId ? teamNameById.get(winnerTeamId) ?? null : null;
      return {
        id: event.id,
        title: winnerName ? `${winnerName} won the game` : 'Game ended',
        body: null,
        createdAt: event.createdAt,
        accentColor: winnerTeamId ? teamColorById.get(winnerTeamId) : undefined,
      };
    }
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNamedObject(value: unknown): { id?: string; name?: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as { id?: unknown; name?: unknown; title?: unknown };
  const name = typeof candidate.name === 'string' ? candidate.name : typeof candidate.title === 'string' ? candidate.title : undefined;
  const id = typeof candidate.id === 'string' ? candidate.id : undefined;
  if (!name && !id) {
    return null;
  }

  return { id, name };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function isOverlayInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, input, textarea, select, [data-overlay-interactive=\"true\"]'));
}
