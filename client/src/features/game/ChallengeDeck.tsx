import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { CHALLENGE_AREA_EDGE_TOLERANCE_METERS, getBasePoints, getChallengeBonuses, getMaxBonusPoints, isJudgedChallengeConfig, type Challenge, type ChallengeRerollState, type Zone } from '@city-game/shared';
import {
  CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH,
  CHALLENGE_CARD_TITLE_MAX_LENGTH,
  clampChallengeCardText,
} from '../../lib/challenge-card-limits';
import { formatDistance } from '../../lib/units';
import { EdgeLabel, FlagGlyph, Flourish, INK, RUST } from './CardGlyphs';
import { JudgedMark } from './JudgedChallenges';
import { BonusList, CompleteChallengeSheet, ScoreChips, formatPoints, type CompletionExtras } from './ChallengeScoring';
import type { GeolocationStatus } from './useGeolocation';

interface CompletedChallengeCard {
  challenge: Challenge;
  teamName: string | null;
  teamColor: string | null;
  pointsEarned?: number | null;
}

interface ExitingChallengeCard {
  challenge: Challenge;
  index: number;
}

interface RenderedChallengeCard extends ExitingChallengeCard {
  isExiting: boolean;
}

interface ChallengeDeckProps {
  // Printed on the card edge, like the Challenge Hunt cards.
  gameName: string;
  challenges: Challenge[];
  rerollState: ChallengeRerollState;
  teamId: string | null;
  completedCards: CompletedChallengeCard[];
  animatedChallengeIds: string[];
  currentZoneId: string | null;
  currentZoneName: string | null;
  progressLabel: string;
  zones: Zone[];
  allowReclaimZones: boolean;
  locationStatus: GeolocationStatus;
  locationMessage: string | null;
  selectedChallengeId: string | null;
  onSelectChallenge(challengeId: string): void;
  onCaptureChallenge(challengeId: string, targetZoneId: string | null, extras?: CompletionExtras): void;
  onToggleRerollVote(challengeId: string): void;
  onFocusCompletedCard(challengeId: string): void;
  isActionPending(actionKey: string): boolean;
  isPeeking: boolean;
  onOpen(): void;
  // 'anywhere' = Challenge Hunt games: every challenge is a card. Anywhere cards complete in place;
  // pinned cards hand off to the map pin. Judged cards behave the same, with a small marker.
  variant?: 'zones' | 'anywhere';
  getCardKind?(challenge: Challenge): CardKind;
  distanceTo?(challenge: Challenge): number | null;
  onLocateChallenge?(challengeId: string): void;
}

export type CardKind = 'anywhere' | 'pin' | 'area';
type DeckFilter = 'all' | 'pin' | 'anywhere';

interface DragStateRefs {
  pointerId: MutableRefObject<number | null>;
  startX: MutableRefObject<number>;
  startY: MutableRefObject<number>;
  startScrollLeft: MutableRefObject<number>;
  didDrag: MutableRefObject<boolean>;
  suppressClick: MutableRefObject<boolean>;
}

export function ChallengeDeck({
  gameName,
  challenges,
  rerollState,
  teamId,
  completedCards,
  animatedChallengeIds,
  currentZoneId,
  currentZoneName,
  locationStatus,
  progressLabel,
  zones,
  allowReclaimZones,
  locationMessage,
  selectedChallengeId,
  onSelectChallenge,
  onCaptureChallenge,
  onToggleRerollVote,
  onFocusCompletedCard,
  isActionPending,
  isPeeking,
  onOpen,
  variant = 'zones',
  getCardKind = () => 'anywhere',
  distanceTo = () => null,
  onLocateChallenge,
}: ChallengeDeckProps) {
  const isAnywhere = variant === 'anywhere';
  const [filter, setFilter] = useState<DeckFilter>('all');
  const allAvailable = challenges.filter((challenge) => challenge.status === 'available');
  const filterCounts = countByFilter(allAvailable, getCardKind);
  const showFilters = isAnywhere && filterCounts.pin > 0 && filterCounts.anywhere > 0;
  const activeFilter = showFilters ? filter : 'all';
  // On the map filter, nearest pins lead.
  const availableChallenges = allAvailable
    .filter((challenge) => activeFilter === 'all' || (activeFilter === 'pin' ? getCardKind(challenge) !== 'anywhere' : getCardKind(challenge) === 'anywhere'))
    .sort((left, right) => (activeFilter === 'pin' ? (distanceTo(left) ?? Infinity) - (distanceTo(right) ?? Infinity) : 0)
      || compareChallengesForDeck(left, right));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRefs = useDragRefs();
  const peekPointerRef = useRef({ active: false, startY: 0, startTime: 0, moved: false });
  const previousAvailableChallengesRef = useRef<Challenge[]>([]);
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const [detailChallengeId, setDetailChallengeId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [confirmChallengeId, setConfirmChallengeId] = useState<string | null>(null);
  const [bonusSheetChallengeId, setBonusSheetChallengeId] = useState<string | null>(null);
  const bonusSheetChallenge = challenges.find((challenge) => challenge.id === bonusSheetChallengeId) ?? null;
  const [exitingChallenges, setExitingChallenges] = useState<ExitingChallengeCard[]>([]);

  const currentZone = currentZoneId ? zones.find((zone) => zone.id === currentZoneId) ?? null : null;
  const isZoneClaimBlocked = !isAnywhere && !allowReclaimZones && Boolean(currentZone?.ownerTeamId);
  const detailChallenge = challenges.find((challenge) => challenge.id === detailChallengeId) ?? null;
  const availableChallengeKey = availableChallenges.map((challenge) => challenge.id).join('|');
  const renderedChallenges = buildRenderedChallengeCards(availableChallenges, exitingChallenges);

  const previousFilterRef = useRef(activeFilter);
  useEffect(() => {
    // A filter switch is not a card leaving play, so skip the exit animation.
    if (previousFilterRef.current !== activeFilter) {
      previousFilterRef.current = activeFilter;
      previousAvailableChallengesRef.current = availableChallenges;
      setExitingChallenges([]);
      return;
    }
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
  }, [availableChallengeKey, activeFilter]);

  useEffect(() => () => {
    for (const timer of exitTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    exitTimersRef.current.clear();
  }, []);

  return (
    <>
      <div className="hidden lg:flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs uppercase tracking-[0.22em] text-[#6d7c82]">
            {progressLabel}
          </p>
          <span className={locationPillClassName(locationStatus)}>
            {isAnywhere
              ? (locationStatus === 'live' ? 'GPS live' : locationStatus === 'requesting' ? 'Reading GPS' : 'GPS off · still playable')
              : currentZoneName
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

      {showFilters && !isPeeking ? (
        <div className="mt-1 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-deck-interactive="true">
          {(['all', 'pin', 'anywhere'] as const).map((key) => (
            <button
              key={key}
              className={['shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition', activeFilter === key ? 'border-[#24343a] bg-[#24343a] text-[#f4ead7]' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#24343a]'].join(' ')}
              data-deck-interactive="true"
              onClick={() => { setFilter(key); scrollRef.current?.scrollTo({ left: 0 }); }}
              type="button"
            >
              {FILTER_LABELS[key]} {filterCounts[key]}
            </button>
          ))}
        </div>
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
              const rerollVote = rerollState.votes.find((vote) => vote.challengeId === challenge.id);
              const rerollVoteCount = rerollVote?.teamIds.length ?? 0;
              const hasRerollVote = Boolean(teamId && rerollVote?.teamIds.includes(teamId));
              const rerollPending = !isExiting && isActionPending('reroll:' + challenge.id);
              const cardKind = getCardKind(challenge);
              const showReroll = !isExiting && rerollState.isAvailable && Boolean(teamId) && cardKind === 'anywhere' && !isJudgedChallengeConfig(challenge.config);
              const shortDescription = getShortDescription(challenge);

              return (
                <div
                  key={challenge.id}
                  className={getCardAnimationClassName(isPeeking, isExiting, animatedChallengeIds.includes(challenge.id))}
                  style={getCardWrapperStyle(index, isPeeking)}
                  onClick={isPeeking ? () => onOpen() : undefined}
                >
                <article
                  className={[
                    'relative flex min-h-[15.5rem] min-w-[13.5rem] max-w-[13.5rem] flex-none snap-start flex-col overflow-hidden rounded-[1.1rem] border bg-[radial-gradient(circle_at_28%_18%,#fbf6e8,#f2e8cf_62%,#e8d9b6)] px-4 pb-4 pt-5 text-[#2f2a20] transition duration-150 lg:min-h-[17rem] lg:min-w-[17rem] lg:max-w-[17rem]',
                    isSelected
                      ? 'z-10 -translate-y-1 border-[#4f3f2a] shadow-[0_22px_48px_rgba(30,24,14,0.32)]'
                      : 'z-0 border-[#a98c5a] shadow-[0_14px_34px_rgba(30,24,14,0.2)] hover:-translate-y-0.5',
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
                  <div aria-hidden="true" className="pointer-events-none absolute inset-[6px] rounded-[0.8rem] border border-[#c4a874]/70" />
                  <EdgeLabel text={gameName} />
                  {isPeeking && index === 0 ? (
                    <div className="relative flex w-full flex-col items-center">
                      <h3 className="flex items-center gap-1.5 whitespace-nowrap font-[Georgia,Times_New_Roman,serif] text-xl font-semibold" style={{ color: INK }}>
                        <FlagGlyph size={18} />
                        {isAnywhere ? (showFilters ? 'Challenges' : 'Anywhere Cards') : 'Challenge Deck'}
                      </h3>
                      <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: RUST }}>{allAvailable.length} {allAvailable.length === 1 ? 'card' : 'cards'}</p>
                    </div>
                  ) : (
                    <>
                      <CardCorner points={getBasePoints(challenge.scoring)} />
                      <CardCorner flipped points={getBasePoints(challenge.scoring)} />
                      <div className="relative pl-8">
                        {isAnywhere ? <CardTag challenge={challenge} kind={getCardKind(challenge)} distance={distanceTo(challenge)} /> : (
                          <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: RUST }} title={currentZoneName ?? undefined}>
                            {currentZoneName ?? 'Stand in a zone'}
                          </p>
                        )}
                        <div className="mt-0.5 flex items-start justify-between gap-1">
                          <h3
                            className="min-w-0 font-[Georgia,Times_New_Roman,serif] text-[1.15rem] font-semibold leading-[1.2] lg:text-xl"
                            style={{ color: INK }}
                            title={challenge.title}
                          >
                            {getDisplayTitle(challenge.title)}
                          </h3>
                          {showReroll ? (
                            <button
                              aria-label={hasRerollVote ? 'Withdraw reroll vote' : 'Vote to reroll challenge'}
                              aria-pressed={hasRerollVote}
                              className={[
                                '-mr-1 -mt-1 inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-full px-1.5 text-[10px] font-semibold tabular-nums transition disabled:cursor-wait disabled:opacity-50',
                                hasRerollVote ? 'bg-[#e3d4b0] text-[#4f3f2a]' : 'text-[#7d6b4c] hover:bg-[#efe3c6]',
                              ].join(' ')}
                              data-deck-interactive="true"
                              disabled={rerollPending}
                              onClick={() => onToggleRerollVote(challenge.id)}
                              title={hasRerollVote ? 'Withdraw reroll vote' : 'Vote to reroll'}
                              type="button"
                            >
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <path d="M19 8a8 8 0 1 0 1 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
                                <path d="M19 4v4h-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
                              </svg>
                              {rerollVoteCount > 0 ? (
                                <span>{rerollVoteCount}/{rerollState.eligibleTeamCount}</span>
                              ) : null}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      <div className="relative my-2.5"><Flourish /></div>

                      <p className="relative overflow-hidden text-[13px] leading-5 text-[#3d362a] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4]">
                        {shortDescription}
                      </p>
                      <div className="relative mt-2 flex flex-wrap items-center gap-2">
                        {/* Details sit with the description, apart from the Claim button. */}
                        <button
                          className="-my-1.5 flex items-center gap-1.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6d5a3c]"
                          data-deck-interactive="true"
                          onClick={() => openDetails(challenge.id, dragRefs, setDetailChallengeId)}
                          type="button"
                        >
                          <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full border border-[#a98c5a] font-[Georgia,Times_New_Roman,serif] text-[12px] normal-case italic">i</span>
                          More info
                        </button>
                        {getMaxBonusPoints(challenge.config) ? (
                          <span className="rounded-full border border-[#c4a874] px-2 py-px font-[Georgia,Times_New_Roman,serif] text-[11px] font-semibold italic" style={{ color: RUST }}>
                            +{getMaxBonusPoints(challenge.config)} bonus
                          </span>
                        ) : null}
                      </div>

                      <div className="relative mt-auto space-y-2 pb-1 pt-3">
                        {/* Right inset keeps the buttons clear of the upside-down corner index. */}
                        <div className="flex gap-2 pr-6">
                          {isAnywhere && cardKind !== 'anywhere' ? (
                            <button
                              className={['h-11 flex-1 rounded-xl border border-[#3a3022] bg-[#3a3022] px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#f5ecd6] transition', isSelected ? '' : 'invisible pointer-events-none'].join(' ')}
                              data-deck-interactive="true"
                              onClick={() => onLocateChallenge?.(challenge.id)}
                              type="button"
                            >
                              Show on map
                            </button>
                          ) : isZoneClaimBlocked ? (
                            <button
                              className="h-11 flex-1 rounded-xl border border-[#b9ab8f] bg-[#cfc3a8] px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#7a6f5c] disabled:cursor-not-allowed"
                              data-deck-interactive="true"
                              disabled
                              type="button"
                            >
                              Zone held
                            </button>
                          ) : isConfirming ? (
                            <button
                              className="h-11 flex-1 rounded-xl border border-[#6e3b22] bg-[#7d4527] px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#fbf1dc] transition hover:bg-[#6e3b22] disabled:cursor-not-allowed disabled:opacity-60"
                              data-deck-interactive="true"
                              disabled={capturePending || (!isAnywhere && (locationStatus === 'unsupported' || locationStatus === 'requesting'))}
                              onClick={() => {
                                onCaptureChallenge(challenge.id, null);
                                setConfirmChallengeId(null);
                              }}
                              type="button"
                            >
                              {capturePending ? (isAnywhere ? 'Completing…' : 'Claiming…') : (isAnywhere ? 'We did it' : 'Confirm')}
                            </button>
                          ) : (
                            <button
                              className={[
                                'h-11 flex-1 rounded-xl border border-[#3a3022] bg-[#3a3022] px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[#f5ecd6] transition hover:bg-[#2c2419] disabled:cursor-not-allowed disabled:border-[#b9ab8f] disabled:bg-[#cfc3a8] disabled:text-[#7a6f5c]',
                                isSelected ? '' : 'invisible pointer-events-none',
                              ].join(' ')}
                              data-deck-interactive="true"
                              disabled={capturePending || (!isAnywhere && (locationStatus === 'unsupported' || locationStatus === 'requesting'))}
                              onClick={() => getChallengeBonuses(challenge.config).length ? setBonusSheetChallengeId(challenge.id) : setConfirmChallengeId(challenge.id)}
                              type="button"
                            >
                              {isAnywhere ? 'Complete' : 'Claim'}
                            </button>
                          )}
                        </div>
                        {isConfirming ? (
                          <button
                            className="w-full text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6d5a3c] underline-offset-4 hover:underline"
                            data-deck-interactive="true"
                            onClick={() => setConfirmChallengeId(null)}
                            type="button"
                          >
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </>
                  )}
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
                {completedCards.map(({ challenge, teamName, teamColor, pointsEarned }) => (
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
                      {pointsEarned ? <span className="ml-auto shrink-0 text-[11px] font-bold text-[#7a5413]">+{formatPoints(pointsEarned)}</span> : null}
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

      {bonusSheetChallenge ? (
        <CompleteChallengeSheet
          challenge={bonusSheetChallenge}
          confirmLabel={isAnywhere ? 'We did it' : 'Confirm claim'}
          onCancel={() => setBonusSheetChallengeId(null)}
          onConfirm={(extras) => { onCaptureChallenge(bonusSheetChallenge.id, null, extras); setBonusSheetChallengeId(null); }}
          pending={isActionPending('capture:' + bonusSheetChallenge.id)}
        />
      ) : null}

      {detailChallenge ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-[#162126]/38 p-4 lg:items-center"
          data-deck-interactive="true"
          onClick={() => setDetailChallengeId(null)}
        >
          <div
            className="relative w-full max-w-xl overflow-hidden rounded-[1.35rem] border border-[#a98c5a] bg-[radial-gradient(circle_at_28%_18%,#fbf6e8,#f2e8cf_62%,#e8d9b6)] px-6 pb-7 pt-7 text-[#2f2a20] shadow-[0_24px_60px_rgba(30,24,14,0.38)]"
            data-deck-interactive="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-[7px] rounded-[1rem] border border-[#c4a874]/70" />
            <EdgeLabel text={gameName} />
            <div className="flex items-start justify-between gap-4">
              <div>
                {isAnywhere ? <AnywhereTag challenge={detailChallenge} /> : null}
                <h3 className="font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold" style={{ color: INK }}>
                  {detailChallenge.title}
                </h3>
              </div>
              <button
                className="relative rounded-xl border border-[#a98c5a] bg-[#fbf5e5] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#4f3f2a] transition hover:bg-[#f5ead0]"
                data-deck-interactive="true"
                onClick={() => setDetailChallengeId(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2"><ScoreChips challenge={detailChallenge} />{isJudgedChallengeConfig(detailChallenge.config) ? <JudgedMark challenge={detailChallenge} /> : null}</div>
            {isJudgedChallengeConfig(detailChallenge.config) ? <p className="mt-2 text-xs text-[#6b777b]">Judged bonus: complete it like any challenge. The judges decide yes or no, and a yes earns the points.</p> : null}
            <div className="mt-3"><Flourish /></div>
            <p className="relative mt-3 text-[15px] leading-7 text-[#3d362a]">{getLongDescription(detailChallenge)}</p>
            <div className="mt-4"><BonusList challenge={detailChallenge} /></div>

          </div>
        </div>
      ) : null}
    </>
  );
}

export function useDragRefs(): DragStateRefs {
  return {
    pointerId: useRef<number | null>(null),
    startX: useRef(0),
    startY: useRef(0),
    startScrollLeft: useRef(0),
    didDrag: useRef(false),
    suppressClick: useRef(false),
  };
}

export function handlePointerDown(
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

export function handlePointerMove(
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

export function handlePointerEnd(
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

export function consumeSuppressedClick(dragRefs: DragStateRefs): boolean {
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


const FILTER_LABELS: Record<DeckFilter, string> = { all: 'All', pin: 'On map', anywhere: 'Anywhere' };

function countByFilter(challenges: Challenge[], getCardKind: (challenge: Challenge) => CardKind): Record<DeckFilter, number> {
  const kinds = challenges.map(getCardKind);
  return { all: kinds.length, pin: kinds.filter((kind) => kind !== 'anywhere').length, anywhere: kinds.filter((kind) => kind === 'anywhere').length };
}

function CardTag({ challenge, kind, distance }: { challenge: Challenge; kind: CardKind; distance: number | null }) {
  const judged = isJudgedChallengeConfig(challenge.config) ? <JudgedMark challenge={challenge} compact /> : null;
  if (kind === 'anywhere') return <div className="flex items-center justify-between gap-2"><AnywhereTag challenge={challenge} />{judged}</div>;
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <p className="flex min-w-0 items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#b4602a]">
        <span aria-hidden="true">{kind === 'area' ? '▧' : '📍'}</span>
        <span className="truncate">{kind === 'area' ? 'Area' : 'On map'}{distance === null ? '' : kind === 'area' && distance <= CHALLENGE_AREA_EDGE_TOLERANCE_METERS ? " · you're in it" : ' · ' + formatDistance(distance)}</span>
      </p>
      {judged}
    </div>
  );
}

function AnywhereTag({ challenge }: { challenge: Challenge }) {
  const hint = getConfigString(challenge, 'location_hint');
  return (
    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-[#647d74]">
      <svg aria-hidden="true" className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
        <path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" stroke="currentColor" strokeWidth="1.6" />
      </svg>
      <span className="truncate">{hint ?? 'Anywhere'}</span>
    </p>
  );
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

// Corner index like a playing card: the points and Turf War's flag suit.
function CardCorner({ points, flipped = false }: { points: number; flipped?: boolean }) {
  return (
    <div aria-hidden="true" className={['pointer-events-none absolute flex w-6 flex-col items-center leading-none', flipped ? 'bottom-3 right-2.5 rotate-180' : 'left-2.5 top-4'].join(' ')}>
      <span className="font-[Georgia,Times_New_Roman,serif] text-lg font-bold" style={{ color: INK }}>{points}</span>
      <span className="mt-0.5"><FlagGlyph size={13} /></span>
    </div>
  );
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
