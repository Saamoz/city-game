import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import type { Challenge, Zone } from '@city-game/shared';
import {
  CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH,
  CHALLENGE_CARD_TITLE_MAX_LENGTH,
  clampChallengeCardText,
} from '../../lib/challenge-card-limits';
import type { GeolocationStatus } from './useGeolocation';

interface CompletedChallengeCard {
  challenge: Challenge;
  teamName: string | null;
  teamColor: string | null;
}

interface ExitingChallengeCard {
  challenge: Challenge;
  index: number;
}

interface RenderedChallengeCard extends ExitingChallengeCard {
  isExiting: boolean;
}

interface ChallengeDeckProps {
  challenges: Challenge[];
  completedCards: CompletedChallengeCard[];
  animatedChallengeIds: string[];
  currentZoneId: string | null;
  currentZoneName: string | null;
  progressLabel: string;
  zones: Zone[];
  locationStatus: GeolocationStatus;
  locationMessage: string | null;
  selectedChallengeId: string | null;
  onSelectChallenge(challengeId: string): void;
  onCaptureChallenge(challengeId: string, targetZoneId: string | null): void;
  onFocusCompletedCard(challengeId: string): void;
  isActionPending(actionKey: string): boolean;
  isPeeking: boolean;
  onOpen(): void;
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
  animatedChallengeIds,
  currentZoneId,
  currentZoneName,
  locationStatus,
  progressLabel,
  zones,
  locationMessage,
  selectedChallengeId,
  onSelectChallenge,
  onCaptureChallenge,
  onFocusCompletedCard,
  isActionPending,
  isPeeking,
  onOpen,
}: ChallengeDeckProps) {
  const availableChallenges = [...challenges]
    .filter((challenge) => challenge.status === 'available')
    .sort(compareChallengesForDeck);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRefs = useDragRefs();
  const peekPointerRef = useRef({ active: false, startY: 0, startTime: 0, moved: false });
  const previousAvailableChallengesRef = useRef<Challenge[]>([]);
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const zonePickerRootRef = useRef<HTMLDivElement | null>(null);
  const [detailChallengeId, setDetailChallengeId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [confirmChallengeId, setConfirmChallengeId] = useState<string | null>(null);
  const [zonePickerChallengeId, setZonePickerChallengeId] = useState<string | null>(null);
  const [targetZoneIdByChallengeId, setTargetZoneIdByChallengeId] = useState<Record<string, string>>({});
  const [exitingChallenges, setExitingChallenges] = useState<ExitingChallengeCard[]>([]);

  const selectableZones = zones.filter((zone) => !zone.isDisabled).sort((left, right) => left.name.localeCompare(right.name));
  const detailChallenge = challenges.find((challenge) => challenge.id === detailChallengeId) ?? null;
  const availableChallengeKey = availableChallenges.map((challenge) => challenge.id).join('|');
  const renderedChallenges = buildRenderedChallengeCards(availableChallenges, exitingChallenges);

  useEffect(() => {
    const previousAvailableChallenges = previousAvailableChallengesRef.current;
    const currentIds = new Set(availableChallenges.map((challenge) => challenge.id));
    const removedChallenges = previousAvailableChallenges
      .map((challenge, index) => ({ challenge, index }))
      .filter(({ challenge }) => !currentIds.has(challenge.id));

    if (removedChallenges.length > 0) {
      setExitingChallenges((current) => {
        const existingIds = new Set(current.map((entry) => entry.challenge.id));
        return [
          ...current.filter((entry) => !currentIds.has(entry.challenge.id)),
          ...removedChallenges.filter(({ challenge }) => !existingIds.has(challenge.id)),
        ];
      });

      for (const { challenge } of removedChallenges) {
        const existingTimer = exitTimersRef.current.get(challenge.id);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
        }

        const timer = window.setTimeout(() => {
          setExitingChallenges((current) => current.filter((entry) => entry.challenge.id !== challenge.id));
          exitTimersRef.current.delete(challenge.id);
        }, 380);
        exitTimersRef.current.set(challenge.id, timer);
      }
    }

    previousAvailableChallengesRef.current = availableChallenges;
  }, [availableChallengeKey]);

  useEffect(() => () => {
    for (const timer of exitTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    exitTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!zonePickerChallengeId) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (zonePickerRootRef.current?.contains(event.target as Node)) {
        return;
      }
      setZonePickerChallengeId(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [zonePickerChallengeId]);

  return (
    <>
      <div className="hidden lg:flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-[#6d7c82]">
            {progressLabel}
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

      {renderedChallenges.length ? (
        <div
          ref={scrollRef}
          className={isPeeking
            ? 'pointer-events-auto w-fit overflow-visible [touch-action:none]'
            : '-mx-3 cursor-grab overflow-x-auto px-3 py-4 select-none [scrollbar-width:none] [touch-action:pan-x] active:cursor-grabbing [&::-webkit-scrollbar]:hidden'}
          onPointerCancel={isPeeking
            ? () => { peekPointerRef.current.active = false; }
            : (event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
          onPointerDown={isPeeking
            ? (e) => { peekPointerRef.current = { active: true, startY: e.clientY, startTime: Date.now(), moved: false }; }
            : (event) => handlePointerDown(event, scrollRef.current, dragRefs)}
          onPointerMove={isPeeking
            ? (e) => { if (peekPointerRef.current.active && Math.abs(e.clientY - peekPointerRef.current.startY) > 8) peekPointerRef.current.moved = true; }
            : (event) => handlePointerMove(event, scrollRef.current, dragRefs)}
          onPointerUp={isPeeking
            ? (e) => {
                if (!peekPointerRef.current.active) return;
                peekPointerRef.current.active = false;
                const dy = e.clientY - peekPointerRef.current.startY;
                const vel = dy / Math.max(Date.now() - peekPointerRef.current.startTime, 1);
                if (!peekPointerRef.current.moved || dy < -20 || (dy < -8 && vel < -0.25)) onOpen();
              }
            : (event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
        >
          <div className="flex w-max pr-6">
            {renderedChallenges.map(({ challenge, index, isExiting }) => {
              const isSelected = !isExiting && challenge.id === selectedChallengeId;
              const isConfirming = !isExiting && confirmChallengeId === challenge.id;
              const capturePending = !isExiting && isActionPending(`capture:${challenge.id}`);
              const shortDescription = getShortDescription(challenge);
              const selectedTargetZoneId = targetZoneIdByChallengeId[challenge.id] ?? currentZoneId ?? selectableZones[0]?.id ?? '';

              return (
                <div
                  key={challenge.id}
                  className={getCardAnimationClassName(isPeeking, isExiting, animatedChallengeIds.includes(challenge.id))}
                  style={getCardWrapperStyle(index, isPeeking)}
                  onClick={isPeeking ? () => onOpen() : undefined}
                >
                <article
                  className={[
                    'relative snap-start min-w-[13.5rem] max-w-[13.5rem] lg:min-w-[17rem] lg:max-w-[17rem] flex-none rounded-[1.65rem] border p-3.5 lg:p-4 text-[#1f2a2f] shadow-[0_16px_80px_rgba(24,32,36,0.10)] transition duration-150',
                    isSelected
                      ? 'z-10 border-[#24343a] bg-[#fff8eb] shadow-[0_20px_80px_rgba(24,32,36,0.16)]'
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
                  style={{
                    transform: `rotate(${(index % 2 === 0 ? -1 : 1) * Math.min(index, 2) * 0.35}deg)`,
                    pointerEvents: isPeeking || isExiting ? 'none' : undefined,
                  }}
                >
                  {isPeeking && index === 0 ? (
                    <div className="flex w-full items-center justify-center">
                      <h3 className="font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#1f2a2f]">
                        Challenge Deck
                      </h3>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-4">
                        <h3
                          className="font-[Georgia,Times_New_Roman,serif] text-base lg:text-lg font-semibold leading-snug text-[#1f2a2f]"
                          title={challenge.title}
                        >
                          {getDisplayTitle(challenge.title)}
                        </h3>
                      </div>

                      <p className="mt-2 overflow-hidden text-xs leading-5 text-[#4f6168] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4]">
                        {shortDescription}
                      </p>
                    </>
                  )}


                  <div className="mt-3 border-t border-[#d8c8a3]/55 pt-3">
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

                    <div className="mt-3 space-y-2">
                      {isConfirming ? (
                        <>
                          <div className="flex gap-2">
                            <button
                              className="min-w-0 flex-1 rounded-2xl border border-[#8d2727] bg-[#b83a31] px-3 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#fff6ef] transition hover:bg-[#9e3028] disabled:cursor-not-allowed disabled:opacity-60"
                              data-deck-interactive="true"
                              disabled={capturePending || locationStatus === 'unsupported' || locationStatus === 'requesting' || !selectedTargetZoneId}
                              onClick={() => {
                                onCaptureChallenge(challenge.id, selectedTargetZoneId || null);
                                setConfirmChallengeId(null);
                                setZonePickerChallengeId(null);
                              }}
                              type="button"
                            >
                              {capturePending ? 'Claiming…' : 'Confirm'}
                            </button>
                            <div ref={zonePickerChallengeId === challenge.id ? zonePickerRootRef : undefined} className="relative">
                              <button
                                aria-expanded={zonePickerChallengeId === challenge.id}
                                aria-label="Choose zone to claim"
                                className="flex h-full min-h-[2.75rem] w-11 items-center justify-center rounded-2xl border border-[#c8b48a]/70 bg-[#fff8eb] text-[#24343a] transition hover:bg-[#f2ead6] disabled:cursor-not-allowed disabled:opacity-60"
                                data-deck-interactive="true"
                                disabled={capturePending || selectableZones.length === 0}
                                onClick={() => setZonePickerChallengeId((current) => current === challenge.id ? null : challenge.id)}
                                title={selectableZones.find((zone) => zone.id === selectedTargetZoneId)?.name ?? 'Choose zone'}
                                type="button"
                              >
                                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
                                  <path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z" />
                                  <path d="M9 3v15" />
                                  <path d="M15 6v15" />
                                </svg>
                              </button>
                              {zonePickerChallengeId === challenge.id ? (
                                <div className="absolute right-0 top-full z-20 mt-2 max-h-48 w-56 overflow-y-auto rounded-2xl border border-[#c8b48a]/70 bg-[#fff8eb] p-1 shadow-[0_14px_34px_rgba(24,32,36,0.18)]" data-deck-interactive="true">
                                  {selectableZones.map((zone) => {
                                    const isSelectedZone = zone.id === selectedTargetZoneId;
                                    return (
                                      <button
                                        key={zone.id}
                                        className={[
                                          'w-full rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#24343a] transition hover:bg-[#efe5cf]',
                                          isSelectedZone ? 'bg-[#e3d4b4]' : '',
                                        ].join(' ')}
                                        onClick={() => {
                                          setTargetZoneIdByChallengeId((current) => ({ ...current, [challenge.id]: zone.id }));
                                          setZonePickerChallengeId(null);
                                        }}
                                        type="button"
                                      >
                                        {zone.name}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <button
                            className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#efe5cf] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#5d4d33] transition hover:bg-[#e6d8bc]"
                            data-deck-interactive="true"
                            onClick={() => {
                              setConfirmChallengeId(null);
                              setZonePickerChallengeId(null);
                            }}
                            type="button"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className={[
                            'w-full rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] transition hover:bg-[#1d2b30] disabled:cursor-not-allowed disabled:border-[#8aa1a8] disabled:bg-[#8ea2a7] disabled:text-[#eef4f5]',
                            isSelected ? '' : 'invisible pointer-events-none',
                          ].join(' ')}
                          data-deck-interactive="true"
                          disabled={capturePending || locationStatus === 'unsupported' || locationStatus === 'requesting'}
                          onClick={() => {
                            setTargetZoneIdByChallengeId((current) => ({ ...current, [challenge.id]: current[challenge.id] ?? currentZoneId ?? selectableZones[0]?.id ?? '' }));
                            setZonePickerChallengeId(null);
                            setConfirmChallengeId(challenge.id);
                          }}
                          type="button"
                        >
                          Claim
                        </button>
                      )}
                    </div>
                  </div>
                </article>
                </div>
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

function compareChallengesForDeck(left: Challenge, right: Challenge): number {
  return left.sortOrder - right.sortOrder || left.title.localeCompare(right.title);
}

function buildRenderedChallengeCards(
  availableChallenges: Challenge[],
  exitingChallenges: ExitingChallengeCard[],
): RenderedChallengeCard[] {
  const rendered: RenderedChallengeCard[] = availableChallenges.map((challenge, index) => ({
    challenge,
    index,
    isExiting: false,
  }));

  for (const exitingChallenge of [...exitingChallenges].sort((left, right) => left.index - right.index)) {
    rendered.splice(Math.min(exitingChallenge.index, rendered.length), 0, {
      ...exitingChallenge,
      isExiting: true,
    });
  }

  return rendered;
}

function getCardAnimationClassName(isPeeking: boolean, isExiting: boolean, isNew: boolean): string {
  if (isPeeking) {
    return '';
  }

  if (isExiting) {
    return 'pointer-events-none animate-[deck-card-out_380ms_cubic-bezier(0.55,0.06,0.68,0.19)_forwards]';
  }

  return isNew ? 'animate-[deck-card-in_350ms_cubic-bezier(0.22,1,0.36,1)]' : '';
}

function getDisplayTitle(title: string): string {
  return clampChallengeCardText(title, CHALLENGE_CARD_TITLE_MAX_LENGTH);
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
  return clampChallengeCardText(configured ?? challenge.description, CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH);
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

// Card width in px (13rem @ 16px base) and normal open-deck gap (gap-4 = 16px).
const CARD_WIDTH_PX = 208;
const CARD_GAP_PX = 16;

function getCardWrapperStyle(index: number, isPeeking: boolean): CSSProperties {
  const TRANSITION = 'transform 0.44s cubic-bezier(0.22,1,0.36,1), margin-left 0.44s cubic-bezier(0.22,1,0.36,1), opacity 0.28s ease';

  const FAN = [
    { rotate:  4, ty: 0, z: 3 },
    { rotate: -1, ty: 3, z: 2 },
    { rotate: -6, ty: 7, z: 1 },
  ];

  if (isPeeking) {
    const f = FAN[Math.min(index, 2)];
    return {
      flexShrink: 0,
      marginLeft: index === 0 ? 0 : -CARD_WIDTH_PX,
      zIndex: f.z,
      transform: `rotate(${f.rotate}deg) translateY(${f.ty}px)`,
      opacity: index < 3 ? 1 : 0,
      transition: TRANSITION,
    };
  }

  return {
    flexShrink: 0,
    marginLeft: index === 0 ? 0 : CARD_GAP_PX,
    zIndex: 'auto',
    opacity: 1,
    transition: TRANSITION,
  };
}
