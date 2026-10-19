import { useEffect, useMemo, useRef, useState } from 'react';
import { getClueFragmentRects, type GameStateSnapshot, type TeamClue } from '@city-game/shared';
import { getTeamClue } from '../../lib/api';
import { OverlayShell } from './Phase32Panels';

const PENCIL = '#5d6271';

export interface TeamClueState {
  clue: TeamClue | null;
  // Bumps when the team gains fragments or the clue is revealed, so the view can react.
  news: { kind: 'found'; count: number } | { kind: 'revealed' } | null;
}

// Loads the team's clue fragments, and loads them again whenever the team completes a challenge
// or the admin reveals or hides the clue. Both show up in the live snapshot.
export function useTeamClue(gameId: string, snapshot: GameStateSnapshot | null): TeamClueState {
  const [state, setState] = useState<TeamClueState>({ clue: null, news: null });
  const previousRef = useRef<TeamClue | null>(null);
  const teamId = snapshot?.team?.id ?? null;
  const foundClaimCount = snapshot?.claims.filter((claim) => claim.teamId === teamId && (claim.status === 'completed' || claim.status === 'submitted')).length ?? 0;
  const revealedAt = snapshot?.game.clueRevealedAt ?? null;
  const isStarted = Boolean(snapshot && snapshot.game.status !== 'setup');

  useEffect(() => {
    if (!isStarted) return;
    const controller = new AbortController();
    getTeamClue(gameId, controller.signal)
      .then((clue) => {
        const previous = previousRef.current;
        previousRef.current = clue;
        let news: TeamClueState['news'] = null;
        if (previous && clue) {
          if (clue.revealedAt && !previous.revealedAt) news = { kind: 'revealed' };
          else if (!clue.revealedAt && clue.fragments.length > previous.fragments.length) news = { kind: 'found', count: clue.fragments.length };
        }
        setState({ clue, news });
      })
      .catch(() => {
        // The board keeps what it had; the next completion or reveal tries again.
      });
    return () => controller.abort();
  }, [gameId, teamId, foundClaimCount, revealedAt, isStarted]);

  return state;
}

export function ClueButton({ clue, onOpen, className = '' }: { clue: TeamClue; onOpen(): void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Clue fragments: ${clue.fragments.length} of ${clue.fragmentCount}`}
      className={'inline-flex items-center gap-1.5 rounded-full border border-[#c9ae6d]/55 bg-[#f3ecd8] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#fff8eb] ' + className}
    >
      <span aria-hidden="true">🧩</span>
      {clue.fragments.length}/{clue.fragmentCount}
    </button>
  );
}

export function ClueOverlay({ clue, snapshot, onClose }: { clue: TeamClue; snapshot: GameStateSnapshot | null; onClose(): void }) {
  const teamColors = useMemo(() => new Map((snapshot?.teams ?? []).map((team) => [team.id, team.color])), [snapshot?.teams]);
  const isRevealed = Boolean(clue.revealedAt);

  return (
    <OverlayShell title="The big clue" onClose={onClose}>
      <p className="font-hand text-[15px] leading-5" style={{ color: PENCIL }}>
        {isRevealed
          ? `Every team's fragments, together: ${clue.fragments.length} of ${clue.fragmentCount}. Work out what it shows!`
          : clue.fragments.length
            ? `Your team has ${clue.fragments.length} of ${clue.fragmentCount} fragments. Every challenge you complete uncovers another.`
            : `Complete challenges to uncover fragments of a secret picture. There are ${clue.fragmentCount} to find.`}
      </p>
      <div className="mt-3">
        <ClueMosaic clue={clue} teamColors={isRevealed ? teamColors : null} />
      </div>
    </OverlayShell>
  );
}

// The whole picture's outline with the found fragments in place and blank paper where the rest go.
function ClueMosaic({ clue, teamColors }: { clue: TeamClue; teamColors: Map<string, string> | null }) {
  const rects = useMemo(() => getClueFragmentRects(clue.width, clue.height, clue.fragmentCount), [clue.width, clue.height, clue.fragmentCount]);
  const fragments = useMemo(() => new Map(clue.fragments.map((fragment) => [fragment.index, fragment])), [clue.fragments]);

  return (
    <div className="relative w-full" style={{ aspectRatio: `${clue.width} / ${clue.height}` }}>
      {rects.map((rect) => {
        const fragment = fragments.get(rect.index);
        return (
          <div
            key={rect.index}
            className="absolute p-px"
            style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
          >
            {fragment ? (
              <div className="relative h-full w-full" title={fragment.challengeTitle ?? undefined}>
                <img src={fragment.url} alt="" draggable={false} className="block h-full w-full select-none" />
                {teamColors && fragment.teamIds.length ? (
                  <span className="absolute bottom-0.5 right-0.5 flex gap-px">
                    {fragment.teamIds.map((teamId) => (
                      <span key={teamId} className="h-2 w-2 rounded-full border border-white/80" style={{ backgroundColor: teamColors.get(teamId) ?? '#888' }} />
                    ))}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="h-full w-full border border-dashed border-[#b9a67b]/60 bg-[#e9dcbd]/50" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function pct(value: number): string {
  return `${value * 100}%`;
}
