import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { GameEventRecord, GameStateSnapshot, ScoreboardEntry } from '@city-game/shared';

export interface FeedEntry {
  id: string;
  title: string;
  body: string | null;
  createdAt: string;
  accentColor?: string;
  zoneId?: string;
}

interface MiniScoreboardCardProps {
  entries: ScoreboardEntry[];
  teamId: string | null;
  onOpenScoreboard(): void;
  onOpenFeed(): void;
}

interface ScoreboardOverlayProps {
  entries: ScoreboardEntry[];
  onClose(): void;
}

interface FeedOverlayProps {
  entries: FeedEntry[];
  isLoading: boolean;
  errorMessage: string | null;
  onClose(): void;
  onFocusZone(zoneId: string): void;
}

export function buildZoneScoreboard(snapshot: GameStateSnapshot | null): ScoreboardEntry[] {
  if (!snapshot) {
    return [];
  }

  const zoneCounts = new Map<string, number>();
  for (const zone of snapshot.zones) {
    if (!zone.ownerTeamId) {
      continue;
    }

    zoneCounts.set(zone.ownerTeamId, (zoneCounts.get(zone.ownerTeamId) ?? 0) + 1);
  }

  return [...snapshot.teams]
    .map((team) => ({
      team,
      zoneCount: zoneCounts.get(team.id) ?? 0,
      resources: snapshot.teamResources[team.id] ?? {},
      rank: 0,
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

export function buildFeedEntries(events: GameEventRecord[], snapshot: GameStateSnapshot | null): FeedEntry[] {
  const teamNameById = new Map(snapshot?.teams.map((team) => [team.id, team.name]) ?? []);
  const teamColorById = new Map(snapshot?.teams.map((team) => [team.id, team.color]) ?? []);

  return events
    .map((event) => formatFeedEntry(event, teamNameById, teamColorById))
    .filter((entry): entry is FeedEntry => entry !== null);
}

export function MiniScoreboardCard({ entries, teamId, onOpenScoreboard, onOpenFeed }: MiniScoreboardCardProps) {
  const leaders = entries.slice(0, 3);

  return (
    <section className="rounded-[1.55rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] px-4 py-4 shadow-[0_20px_60px_rgba(46,58,62,0.18)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-[#936718]">Standings</p>
        </div>
        <button
          className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
          onClick={onOpenScoreboard}
          type="button"
        >
          Open
        </button>
      </div>

      <div className="mt-4 space-y-2.5">
        {leaders.map((entry) => {
          const isCurrentTeam = entry.team.id === teamId;
          return (
            <div
              key={entry.team.id}
              className={[
                'flex items-center justify-between rounded-[1.1rem] border px-3 py-3',
                isCurrentTeam ? 'border-[#24343a]/25 bg-[#fff8eb]' : 'border-[#d6c59d]/55 bg-[#f7efdc]',
              ].join(' ')}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-5 text-sm font-semibold text-[#7a5e2d]">{entry.rank}</span>
                <span
                  className="h-3.5 w-3.5 shrink-0 rounded-full border border-[#f8f1df]"
                  style={{ backgroundColor: entry.team.color }}
                />
                <p className="truncate text-sm font-medium text-[#24343a]">{entry.team.name}</p>
              </div>
              <p className="text-sm font-semibold text-[#24343a]">{entry.zoneCount}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
          onClick={onOpenScoreboard}
          type="button"
        >
          Full Standings
        </button>
        <button
          className="rounded-full border border-[#c8b48a]/55 bg-[#efe5cf] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#e7dbc0]"
          onClick={onOpenFeed}
          type="button"
        >
          Feed
        </button>
      </div>
    </section>
  );
}

export function ScoreboardOverlay({ entries, onClose }: ScoreboardOverlayProps) {
  return (
    <OverlayShell title="Standings" onClose={onClose}>
      <div className="space-y-2.5">
        {entries.map((entry) => (
          <article
            key={entry.team.id}
            className="flex items-center justify-between gap-4 rounded-[1.2rem] border border-[#d6c59d]/55 bg-[#f7efdc] px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <p className="w-7 text-center text-base font-semibold text-[#7a5e2d]">{entry.rank}</p>
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-full border border-[#f8f1df] shadow-sm"
                style={{ backgroundColor: entry.team.color }}
              />
              <h3 className="truncate font-[Georgia,Times_New_Roman,serif] text-lg font-semibold text-[#24343a]">
                {entry.team.name}
              </h3>
            </div>
            <p className="shrink-0 text-sm font-semibold uppercase tracking-[0.12em] text-[#24343a]">
              Zones {entry.zoneCount}
            </p>
          </article>
        ))}
      </div>
    </OverlayShell>
  );
}

export function FeedOverlay({ entries, isLoading, errorMessage, onClose, onFocusZone }: FeedOverlayProps) {
  return (
    <OverlayShell title="Field Feed" onClose={onClose}>
      {isLoading ? <PanelMessage tone="default" message="Loading recent events." /> : null}
      {errorMessage ? <PanelMessage tone="danger" message={errorMessage} /> : null}
      {!isLoading && !errorMessage && entries.length === 0 ? <PanelMessage tone="default" message="No visible events yet." /> : null}

      {entries.length ? (
        <div className="space-y-1.5">
          {entries.map((entry) => {
            const isZoneLinked = Boolean(entry.zoneId);
            const articleClassName = [
              'w-full rounded-[1rem] border border-[#d6c59d]/55 bg-[#f7efdc] px-3 py-2.5 text-left transition',
              isZoneLinked ? 'hover:bg-[#fbf3e2]' : '',
            ].join(' ').trim();

            const content = (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {entry.accentColor ? (
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-[#f8f1df]" style={{ backgroundColor: entry.accentColor }} />
                    ) : null}
                    <h3 className="text-[13px] font-semibold leading-5 text-[#24343a]">{entry.title}</h3>
                  </div>
                  {entry.body ? <p className="mt-1 text-xs leading-5 text-[#55656c]">{entry.body}</p> : null}
                </div>
                <p className="shrink-0 pt-0.5 text-[10px] uppercase tracking-[0.16em] text-[#7a6a48]">{formatEventTime(entry.createdAt)}</p>
              </div>
            );

            if (isZoneLinked && entry.zoneId) {
              return (
                <button
                  key={entry.id}
                  className={articleClassName}
                  onClick={() => onFocusZone(entry.zoneId!)}
                  type="button"
                >
                  {content}
                </button>
              );
            }

            return (
              <article key={entry.id} className={articleClassName}>
                {content}
              </article>
            );
          })}
        </div>
      ) : null}
    </OverlayShell>
  );
}

function OverlayShell({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dragRefs = useOverlayDragRefs();
  const closeTimerRef = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  const requestClose = (animated: boolean) => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (!animated) {
      onClose();
      return;
    }

    setIsClosing(true);
    setIsDragging(false);
    setDragOffset(window.innerHeight);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, 220);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isClosing) {
      return;
    }

    dragRefs.pointerId.current = event.pointerId;
    dragRefs.startY.current = event.clientY;
    dragRefs.startTime.current = Date.now();
    dragRefs.didDrag.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isClosing || dragRefs.pointerId.current !== event.pointerId) {
      return;
    }

    const deltaY = event.clientY - dragRefs.startY.current;

    if (!dragRefs.didDrag.current && Math.abs(deltaY) < 8) {
      return;
    }

    if (!dragRefs.didDrag.current) {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRefs.didDrag.current = true;
    }

    event.preventDefault();
    setIsDragging(true);
    setDragOffset(deltaY > 0 ? deltaY : Math.round(deltaY * 0.2));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
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

    if (didDrag && (deltaY > 90 || (deltaY > 36 && velocity > 0.55))) {
      requestClose(true);
      return;
    }

    setDragOffset(0);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#162126]/42 p-0 [touch-action:none] lg:items-center lg:p-6" onClick={() => requestClose(false)}>
      <section
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-[1.9rem] border border-[#c9ae6d]/55 bg-[#f3ecd8] shadow-[0_30px_80px_rgba(24,32,36,0.28)] lg:rounded-[2rem]"
        onClick={(event) => event.stopPropagation()}
        style={{
          transform: `translateY(${dragOffset}px)`,
          transition: isDragging ? 'none' : 'transform 0.24s ease',
        }}
      >
        <header className="border-b border-[#d6c59d]/55 px-5 py-4 lg:px-6">
          <div
            className="mb-3 flex cursor-grab touch-none justify-center active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            <div className="h-1 w-10 rounded-full bg-[#c8b48a]/70" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <h2 className="truncate font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#24343a] lg:text-[2rem]">{title}</h2>
            <button
              className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
              onClick={() => requestClose(true)}
              type="button"
            >
              Close
            </button>
          </div>
        </header>
        <div className="overflow-y-auto px-5 py-5 lg:px-6">{children}</div>
      </section>
    </div>
  );
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
  const className = tone === 'danger'
    ? 'border-[#bb4d4d]/35 bg-[#f7d9d4] text-[#6c2626]'
    : 'border-[#d6c59d]/55 bg-[#fff8eb] text-[#55656c]';

  return <div className={'mb-3 rounded-[1.1rem] border px-4 py-3 text-sm ' + className}>{message}</div>;
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
