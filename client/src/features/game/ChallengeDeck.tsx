import { useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import type { Challenge } from '@city-game/shared';
import type { GeolocationStatus } from './useGeolocation';

interface CompletedChallengeCard {
  challenge: Challenge;
  teamName: string | null;
  teamColor: string | null;
}

interface ChallengeDeckProps {
  challenges: Challenge[];
  completedCards: CompletedChallengeCard[];
  currentZoneName: string | null;
  locationStatus: GeolocationStatus;
  locationMessage: string | null;
  selectedChallengeId: string | null;
  onSelectChallenge(challengeId: string): void;
  onCaptureChallenge(challengeId: string): void;
  onFocusCompletedCard(challengeId: string): void;
  isActionPending(actionKey: string): boolean;
}

interface DragStateRefs {
  pointerId: MutableRefObject<number | null>;
  startX: MutableRefObject<number>;
  startY: MutableRefObject<number>;
  startScrollLeft: MutableRefObject<number>;
  didDrag: MutableRefObject<boolean>;
  suppressClick: MutableRefObject<boolean>;
}

export function ChallengeDeck({
  challenges,
  completedCards,
  currentZoneName,
  locationStatus,
  locationMessage,
  selectedChallengeId,
  onSelectChallenge,
  onCaptureChallenge,
  onFocusCompletedCard,
  isActionPending,
}: ChallengeDeckProps) {
  const availableChallenges = [...challenges]
    .filter((challenge) => challenge.status === 'available')
    .sort(compareChallengeTitle);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRefs = useDragRefs();
  const [detailChallengeId, setDetailChallengeId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [confirmChallengeId, setConfirmChallengeId] = useState<string | null>(null);

  const detailChallenge = challenges.find((challenge) => challenge.id === detailChallengeId) ?? null;

  return (
    <>
      <div className="hidden lg:flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-[#6d7c82]">
            {availableChallenges.length} ready
          </p>
          <span className={locationPillClassName(locationStatus)}>
            {currentZoneName
              ? currentZoneName
              : locationStatus === 'live'
                ? 'Zone unresolved'
                : locationStatus === 'requesting'
                  ? 'Reading GPS'
                  : locationStatus === 'unsupported'
                    ? 'GPS unavailable'
                    : locationStatus === 'error'
                      ? 'GPS blocked'
                      : 'GPS idle'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
            data-deck-interactive="true"
            onClick={() => scrollDeck(scrollRef.current, -320)}
            type="button"
          >
            Prev
          </button>
          <button
            className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
            data-deck-interactive="true"
            onClick={() => scrollDeck(scrollRef.current, 320)}
            type="button"
          >
            Next
          </button>
        </div>
      </div>

      {locationStatus === 'error' && locationMessage ? (
        <p className="mt-3 text-xs leading-5 text-[#8a3c2d]">{locationMessage}</p>
      ) : null}

      {availableChallenges.length ? (
        <div
          ref={scrollRef}
          className="-mx-3 cursor-grab overflow-x-auto px-3 py-4 select-none [scrollbar-width:none] [touch-action:pan-x] active:cursor-grabbing [&::-webkit-scrollbar]:hidden"
          onPointerCancel={(event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
          onPointerDown={(event) => handlePointerDown(event, scrollRef.current, dragRefs)}
          onPointerMove={(event) => handlePointerMove(event, scrollRef.current, dragRefs)}
          onPointerUp={(event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
        >
          <div className="flex w-max gap-4 pr-6">
            {availableChallenges.map((challenge, index) => {
              const isSelected = challenge.id === selectedChallengeId;
              const isConfirming = confirmChallengeId === challenge.id;
              const capturePending = isActionPending(`capture:${challenge.id}`);
              const shortDescription = getShortDescription(challenge);

              return (
                <article
                  key={challenge.id}
                  className={[
                    'relative snap-start min-w-[13rem] max-w-[13rem] lg:min-w-[17rem] lg:max-w-[17rem] flex-none rounded-[1.8rem] border p-4 lg:p-5 text-[#1f2a2f] shadow-[0_18px_40px_rgba(24,32,36,0.14)] transition duration-150',
                    isSelected
                      ? 'z-10 border-[#24343a] bg-[#fff8eb] shadow-[0_22px_48px_rgba(24,32,36,0.22)]'
                      : 'z-0 border-[#c8b48a]/55 bg-[#f8f1df] hover:-translate-y-0.5 hover:bg-[#fbf4e4]',
                  ].join(' ')}
                  onClick={(event) => {
                    if (consumeSuppressedClick(dragRefs)) {
                      return;
                    }

                    if (isInteractiveTarget(event.target)) {
                      return;
                    }

                    setConfirmChallengeId(null);
                    onSelectChallenge(challenge.id);
                  }}
                  style={{ transform: `rotate(${(index % 2 === 0 ? -1 : 1) * Math.min(index, 2) * 0.35}deg)` }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <h3
                      className="font-[Georgia,Times_New_Roman,serif] text-lg lg:text-xl font-semibold text-[#1f2a2f]"
                      title={challenge.title}
                    >
                      {getDisplayTitle(challenge.title)}
                    </h3>
                  </div>

                  <p className="mt-3 lg:mt-4 overflow-hidden text-sm leading-6 text-[#4f6168] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] lg:[-webkit-line-clamp:4]">
                    {shortDescription}
                  </p>


                  <div className="mt-3 lg:mt-5 border-t border-[#d8c8a3]/55 pt-3 lg:pt-4">
                    <p className="hidden lg:block text-[11px] uppercase tracking-[0.18em] text-[#7d6f55]">
                      {currentZoneName ?? 'No zone'}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="rounded-full border border-[#c8b48a]/55 bg-[#efe5cf] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#e7dbc0]"
                        data-deck-interactive="true"
                        onClick={() => openDetails(challenge.id, dragRefs, setDetailChallengeId)}
                        type="button"
                      >
                        Details
                      </button>
                    </div>

                    {isSelected ? (
                      <div className="mt-4 space-y-2">
                        {isConfirming ? (
                          <>
                            <button
                              className="w-full rounded-2xl border border-[#8d2727] bg-[#b83a31] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#fff6ef] transition hover:bg-[#9e3028] disabled:cursor-not-allowed disabled:opacity-60"
                              data-deck-interactive="true"
                              disabled={capturePending || locationStatus === 'unsupported' || locationStatus === 'requesting'}
                              onClick={() => {
                                onCaptureChallenge(challenge.id);
                                setConfirmChallengeId(null);
                              }}
                              type="button"
                            >
                              {capturePending ? 'Claiming…' : 'Confirm Claim'}
                            </button>
                            <button
                              className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#efe5cf] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#5d4d33] transition hover:bg-[#e6d8bc]"
                              data-deck-interactive="true"
                              onClick={() => setConfirmChallengeId(null)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="w-full rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] transition hover:bg-[#1d2b30] disabled:cursor-not-allowed disabled:border-[#8aa1a8] disabled:bg-[#8ea2a7] disabled:text-[#eef4f5]"
                            data-deck-interactive="true"
                            disabled={capturePending || locationStatus === 'unsupported' || locationStatus === 'requesting'}
                            onClick={() => setConfirmChallengeId(challenge.id)}
                            type="button"
                          >
                            Claim
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-[1.5rem] border border-dashed border-[#bda370]/55 bg-[#fff8eb] p-5 text-sm leading-6 text-[#51646b]">
          No ready cards remain.
        </div>
      )}

      {completedCards.length ? (
        <section className="hidden lg:block mt-3 rounded-[1.4rem] border border-[#c8b48a]/40 bg-[#ede4cf]/72 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-[#7a6a48]">
              Completed {completedCards.length}
            </p>
            <button
              className="rounded-full border border-[#c8b48a]/45 bg-[#f7efdc] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#efe3c8]"
              data-deck-interactive="true"
              onClick={() => setShowCompleted((value) => !value)}
              type="button"
            >
              {showCompleted ? 'Hide' : 'Show'}
            </button>
          </div>

          {showCompleted ? (
            <div className="-mx-4 mt-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex w-max gap-3 pr-4">
                {completedCards.map(({ challenge, teamName, teamColor }) => (
                  <button
                    key={challenge.id}
                    className="min-w-[14rem] max-w-[14rem] flex-none rounded-[1.2rem] border border-[#c8b48a]/45 bg-[#f7efdc] p-4 text-left text-[#24343a] shadow-[0_10px_24px_rgba(24,32,36,0.08)] transition hover:bg-[#fbf3e2]"
                    data-deck-interactive="true"
                    onClick={() => onFocusCompletedCard(challenge.id)}
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-[#f8f1df]"
                        style={{ backgroundColor: teamColor ?? '#a28f67' }}
                      />
                      <p className="truncate text-[11px] uppercase tracking-[0.18em] text-[#7a6a48]">
                        {teamName ?? 'Unknown team'}
                      </p>
                    </div>
                    <h3
                      className="mt-2 line-clamp-2 font-[Georgia,Times_New_Roman,serif] text-lg font-semibold text-[#24343a]"
                      title={challenge.title}
                    >
                      {getDisplayTitle(challenge.title)}
                    </h3>
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-[#55646b]">
                      {getShortDescription(challenge)}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {detailChallenge ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-[#162126]/38 p-4 lg:items-center"
          data-deck-interactive="true"
          onClick={() => setDetailChallengeId(null)}
        >
          <div
            className="w-full max-w-xl rounded-[2rem] border border-[#c8b48a]/55 bg-[#f8f1df] p-6 text-[#1f2a2f] shadow-[0_24px_70px_rgba(20,28,32,0.3)]"
            data-deck-interactive="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#1f2a2f]">
                  {detailChallenge.title}
                </h3>
              </div>
              <button
                className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#24343a] transition hover:bg-[#f2ead6]"
                data-deck-interactive="true"
                onClick={() => setDetailChallengeId(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <p className="mt-5 text-sm leading-7 text-[#44545c]">{getLongDescription(detailChallenge)}</p>

          </div>
        </div>
      ) : null}
    </>
  );
}

function useDragRefs(): DragStateRefs {
  return {
    pointerId: useRef<number | null>(null),
    startX: useRef(0),
    startY: useRef(0),
    startScrollLeft: useRef(0),
    didDrag: useRef(false),
    suppressClick: useRef(false),
  };
}

function handlePointerDown(
  event: ReactPointerEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  dragRefs: DragStateRefs,
): void {
  if (isInteractiveTarget(event.target) || !container) {
    return;
  }

  dragRefs.pointerId.current = event.pointerId;
  dragRefs.startX.current = event.clientX;
  dragRefs.startY.current = event.clientY;
  dragRefs.startScrollLeft.current = container.scrollLeft;
  dragRefs.didDrag.current = false;
  // Do NOT capture here — capturing before confirming a drag redirects pointerup to the
  // scroll container, which causes click events to fire on it instead of the card article.
}

function handlePointerMove(
  event: ReactPointerEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  dragRefs: DragStateRefs,
): void {
  if (!container || dragRefs.pointerId.current !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - dragRefs.startX.current;
  const deltaY = event.clientY - dragRefs.startY.current;

  if (!dragRefs.didDrag.current && Math.abs(deltaX) < 6) {
    return;
  }

  if (!dragRefs.didDrag.current && Math.abs(deltaY) > Math.abs(deltaX)) {
    clearDragState(dragRefs);
    return;
  }

  if (!dragRefs.didDrag.current) {
    // First confirmed drag movement — capture now so subsequent pointermove/pointerup
    // events route to the scroll container even if the pointer leaves its bounds.
    container.setPointerCapture(event.pointerId);
  }
  dragRefs.didDrag.current = true;
  dragRefs.suppressClick.current = true;
  container.scrollLeft = dragRefs.startScrollLeft.current - deltaX;
  event.preventDefault();
}

function handlePointerEnd(
  event: ReactPointerEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  dragRefs: DragStateRefs,
): void {
  if (!container || dragRefs.pointerId.current !== event.pointerId) {
    return;
  }

  if (container.hasPointerCapture(event.pointerId)) {
    container.releasePointerCapture(event.pointerId);
  }

  const didDrag = dragRefs.didDrag.current;
  clearDragState(dragRefs);

  if (!didDrag) {
    return;
  }

  window.setTimeout(() => {
    dragRefs.suppressClick.current = false;
  }, 0);
}

function clearDragState(dragRefs: DragStateRefs): void {
  dragRefs.pointerId.current = null;
  dragRefs.didDrag.current = false;
}

function consumeSuppressedClick(dragRefs: DragStateRefs): boolean {
  if (!dragRefs.suppressClick.current) {
    return false;
  }

  dragRefs.suppressClick.current = false;
  return true;
}

function openDetails(
  challengeId: string,
  dragRefs: DragStateRefs,
  setDetailChallengeId: (challengeId: string) => void,
): void {
  if (consumeSuppressedClick(dragRefs)) {
    return;
  }

  setDetailChallengeId(challengeId);
}

function scrollDeck(container: HTMLDivElement | null, delta: number): void {
  container?.scrollBy({ left: delta, behavior: 'smooth' });
}

function compareChallengeTitle(left: Challenge, right: Challenge): number {
  return left.title.localeCompare(right.title);
}

function getDisplayTitle(title: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle.length <= 100) {
    return normalizedTitle;
  }

  return normalizedTitle.slice(0, 97).trimEnd() + '...';
}

function locationPillClassName(status: GeolocationStatus): string {
  const tone = status === 'live'
    ? 'border-[#7b9a73]/45 bg-[#dfeadb] text-[#254028]'
    : status === 'error' || status === 'unsupported'
      ? 'border-[#c07f6d]/45 bg-[#f3ddd7] text-[#7a3427]'
      : 'border-[#8fa2aa]/45 bg-[#e8eff1] text-[#29414b]';

  return 'rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ' + tone;
}


function getShortDescription(challenge: Challenge): string {
  const configured = getConfigString(challenge, 'short_description');
  return configured ?? challenge.description;
}

function getLongDescription(challenge: Challenge): string {
  const configured = getConfigString(challenge, 'long_description');
  return configured ?? challenge.description;
}

function getConfigString(challenge: Challenge, key: string): string | null {
  const value = challenge.config?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-deck-interactive="true"]') !== null;
}
