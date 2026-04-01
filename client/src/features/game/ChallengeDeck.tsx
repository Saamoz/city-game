import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Challenge } from '@city-game/shared';

interface ChallengeDeckProps {
  challenges: Challenge[];
  selectedChallengeId: string | null;
  onSelectChallenge(challengeId: string): void;
}

export function ChallengeDeck({ challenges, selectedChallengeId, onSelectChallenge }: ChallengeDeckProps) {
  const orderedChallenges = [...challenges].sort(compareChallengePriority);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartYRef = useRef(0);
  const dragStartScrollLeftRef = useRef(0);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [detailChallengeId, setDetailChallengeId] = useState<string | null>(null);
  const detailChallenge = orderedChallenges.find((challenge) => challenge.id === detailChallengeId) ?? null;

  if (!orderedChallenges.length) {
    return (
      <div className="rounded-[1.5rem] border border-dashed border-[#bda370]/55 bg-[#fff8eb] p-5 text-sm leading-6 text-[#51646b]">
        No challenge cards are loaded yet.
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.22em] text-[#6d7c82]">
          {orderedChallenges.length} cards
        </p>
        <div className="flex items-center gap-2">
          <button
            className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
            onClick={() => scrollDeck(scrollRef.current, -320)}
            type="button"
          >
            Prev
          </button>
          <button
            className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
            onClick={() => scrollDeck(scrollRef.current, 320)}
            type="button"
          >
            Next
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="-mx-3 cursor-grab overflow-x-auto overflow-y-visible px-3 py-4 select-none [scrollbar-width:none] [touch-action:pan-x] active:cursor-grabbing [&::-webkit-scrollbar]:hidden"
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
      >
        <div className="flex w-max gap-4 pr-6">
          {orderedChallenges.map((challenge, index) => {
            const isSelected = challenge.id === selectedChallengeId;

            return (
              <article
                key={challenge.id}
                className={[
                  'snap-start min-w-[16.5rem] max-w-[16.5rem] flex-none rounded-[1.8rem] border p-5 text-[#1f2a2f] shadow-[0_18px_40px_rgba(24,32,36,0.14)] transition duration-150',
                  isSelected
                    ? 'border-[#24343a] bg-[#fff8eb] shadow-[0_22px_48px_rgba(24,32,36,0.22)]'
                    : 'border-[#c8b48a]/55 bg-[#f8f1df] hover:-translate-y-0.5 hover:bg-[#fbf4e4]',
                ].join(' ')}
                style={{ transform: 'rotate(' + ((index % 2 === 0 ? -1 : 1) * Math.min(index, 2) * 0.35) + 'deg)' }}
              >
                <button className="block w-full text-left" onClick={() => handleSelectChallenge(challenge.id)} type="button">
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="font-[Georgia,Times_New_Roman,serif] text-xl font-semibold text-[#1f2a2f]">
                      {challenge.title}
                    </h3>
                    {challenge.status === 'available' ? null : (
                      <span className={badgeClassName(challenge.status)}>{challenge.status}</span>
                    )}
                  </div>

                  <p className="mt-4 overflow-hidden text-sm leading-6 text-[#4f6168] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4]">
                    {challenge.description}
                  </p>

                  {Object.keys(challenge.scoring).length ? (
                    <div className="mt-5 flex flex-wrap gap-2">
                      {Object.entries(challenge.scoring).map(([resourceType, value]) => (
                        <span
                          key={resourceType}
                          className="rounded-full border border-[#c8b48a]/45 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a]"
                        >
                          {resourceType} {formatReward(typeof value === 'number' ? value : 0)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </button>

                <div className="mt-5 flex items-center justify-between border-t border-[#d8c8a3]/55 pt-4">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-[#7d6f55]">
                    {isSelected ? 'Selected' : 'Ready'}
                  </span>
                  <button
                    className="rounded-full border border-[#c8b48a]/55 bg-[#efe5cf] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#e7dbc0]"
                    onClick={() => handleOpenDetails(challenge.id)}
                    type="button"
                  >
                    Details
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {detailChallenge ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#162126]/38 p-4 sm:items-center" onClick={() => setDetailChallengeId(null)}>
          <div
            className="w-full max-w-xl rounded-[2rem] border border-[#c8b48a]/55 bg-[#f8f1df] p-6 text-[#1f2a2f] shadow-[0_24px_70px_rgba(20,28,32,0.3)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-[#8c6924]">Challenge Details</p>
                <h3 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#1f2a2f]">
                  {detailChallenge.title}
                </h3>
              </div>
              <button
                className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
                onClick={() => setDetailChallengeId(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <p className="mt-5 text-sm leading-7 text-[#44545c]">{detailChallenge.description}</p>

            {Object.keys(detailChallenge.scoring).length ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {Object.entries(detailChallenge.scoring).map(([resourceType, value]) => (
                  <span
                    key={resourceType}
                    className="rounded-full border border-[#c8b48a]/45 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a]"
                  >
                    {resourceType} {formatReward(typeof value === 'number' ? value : 0)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );

  function handleSelectChallenge(challengeId: string): void {
    if (consumeSuppressedClick()) {
      return;
    }

    onSelectChallenge(challengeId);
  }

  function handleOpenDetails(challengeId: string): void {
    if (consumeSuppressedClick()) {
      return;
    }

    setDetailChallengeId(challengeId);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    dragPointerIdRef.current = event.pointerId;
    dragStartXRef.current = event.clientX;
    dragStartYRef.current = event.clientY;
    dragStartScrollLeftRef.current = container.scrollLeft;
    didDragRef.current = false;
    container.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = scrollRef.current;
    if (!container || dragPointerIdRef.current !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragStartXRef.current;
    const deltaY = event.clientY - dragStartYRef.current;

    if (!didDragRef.current && Math.abs(deltaX) < 6) {
      return;
    }

    if (!didDragRef.current && Math.abs(deltaY) > Math.abs(deltaX)) {
      clearDragState();
      return;
    }

    didDragRef.current = true;
    suppressClickRef.current = true;
    container.scrollLeft = dragStartScrollLeftRef.current - deltaX;
    event.preventDefault();
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = scrollRef.current;
    if (!container || dragPointerIdRef.current !== event.pointerId) {
      return;
    }

    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    const didDrag = didDragRef.current;
    clearDragState();

    if (didDrag) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  function clearDragState(): void {
    dragPointerIdRef.current = null;
    didDragRef.current = false;
  }

  function consumeSuppressedClick(): boolean {
    if (!suppressClickRef.current) {
      return false;
    }

    suppressClickRef.current = false;
    return true;
  }
}

function scrollDeck(container: HTMLDivElement | null, delta: number): void {
  container?.scrollBy({ left: delta, behavior: 'smooth' });
}

function compareChallengePriority(left: Challenge, right: Challenge): number {
  const statusOrder = { available: 0, claimed: 1, completed: 2 } as const;
  const byStatus = statusOrder[left.status] - statusOrder[right.status];

  if (byStatus !== 0) {
    return byStatus;
  }

  return left.title.localeCompare(right.title);
}

function badgeClassName(status: Challenge['status']): string {
  const tone = status === 'claimed'
    ? 'border-[#bf8d2f]/45 bg-[#f8e8c2] text-[#6f5214]'
    : status === 'completed'
      ? 'border-[#7b9a73]/45 bg-[#dfeadb] text-[#254028]'
      : 'border-[#8fa2aa]/45 bg-[#e8eff1] text-[#29414b]';

  return 'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ' + tone;
}

function formatReward(value: number): string {
  return value > 0 ? '+' + String(value) : String(value);
}
