import { useRef, useState } from 'react';
import { getBasePoints, getMaxBonusPoints, type Challenge } from '@city-game/shared';
import { INK, RUST, SuitGlyph, type CardSuit } from './CardGlyphs';
import { consumeSuppressedClick, handlePointerDown, handlePointerEnd, handlePointerMove, useDragRefs } from './ChallengeDeck';
import { formatDistance } from './ChallengeCardFace';

type DeckFilter = 'all' | 'pin' | 'anywhere';

interface PointDeckProps {
  challenges: Challenge[];
  getSuit(challenge: Challenge): CardSuit;
  distanceTo(challenge: Challenge): number | null;
  isInRange(challenge: Challenge): boolean;
  isPeeking: boolean;
  onOpen(): void;
  onOpenCard(challengeId: string, ordered: Challenge[]): void;
}

// Point Challenge deck: a centred fan of small cards when closed, a row of dense mini cards when
// open. Tapping a mini card opens the full-screen card viewer.
export function PointDeck({ challenges, getSuit, distanceTo, isInRange, isPeeking, onOpen, onOpenCard }: PointDeckProps) {
  const [filter, setFilter] = useState<DeckFilter>('all');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRefs = useDragRefs();
  const available = challenges.filter((challenge) => challenge.status === 'available');
  const counts = {
    all: available.length,
    pin: available.filter((challenge) => getSuit(challenge) !== 'anywhere').length,
    anywhere: available.filter((challenge) => getSuit(challenge) === 'anywhere').length,
  };
  const showFilters = counts.pin > 0 && counts.anywhere > 0;
  const activeFilter = showFilters ? filter : 'all';
  // On the map filter, nearest first.
  const visible = available
    .filter((challenge) => activeFilter === 'all' || (activeFilter === 'pin' ? getSuit(challenge) !== 'anywhere' : getSuit(challenge) === 'anywhere'))
    .sort((left, right) => (activeFilter === 'pin' ? (distanceTo(left) ?? Infinity) - (distanceTo(right) ?? Infinity) : 0) || left.sortOrder - right.sortOrder || left.title.localeCompare(right.title));

  if (isPeeking) {
    const fan = visible.slice(0, 3);
    return (
      <button aria-label={'Open challenges, ' + available.length + ' left'} className="pointer-events-auto relative mx-auto block h-[7.5rem] w-[11rem]" onClick={onOpen} type="button">
        {fan.slice(1).reverse().map((challenge, position) => (
          <span key={challenge.id} className="absolute inset-x-0 top-0 h-full rounded-[0.9rem] border border-[#a98c5a] bg-[#efe3c6] shadow-[0_6px_16px_rgba(40,30,15,0.18)]" style={{ transform: `rotate(${position === 0 ? -7 : -3.5}deg) translateY(${position === 0 ? 6 : 3}px)` }} />
        ))}
        <span className="absolute inset-x-0 top-0 flex h-full flex-col items-center rounded-[0.9rem] border border-[#a98c5a] bg-[radial-gradient(circle_at_30%_20%,#fbf6e8,#f1e6cc)] pt-3 shadow-[0_10px_24px_rgba(40,30,15,0.22)]" style={{ transform: 'rotate(2deg)' }}>
          <span aria-hidden="true" className="pointer-events-none absolute inset-[5px] rounded-[0.7rem] border border-[#c4a874]/70" />
          <span className="font-[Georgia,Times_New_Roman,serif] text-xl font-semibold" style={{ color: INK }}>Challenges</span>
          <span className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: RUST }}>{available.length} left</span>
        </span>
      </button>
    );
  }

  return (
    <div>
      {showFilters ? (
        <div className="mb-1 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-deck-interactive="true">
          {(['all', 'pin', 'anywhere'] as const).map((key) => (
            <button
              key={key}
              className={['shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition', activeFilter === key ? 'border-[#3a3022] bg-[#3a3022] text-[#f5ecd6]' : 'border-[#c4a874] bg-[#fbf5e5] text-[#4f3f2a]'].join(' ')}
              data-deck-interactive="true"
              onClick={() => { setFilter(key); scrollRef.current?.scrollTo({ left: 0 }); }}
              type="button"
            >
              {key === 'all' ? 'All' : key === 'pin' ? 'On map' : 'Anywhere'} {counts[key]}
            </button>
          ))}
        </div>
      ) : null}

      {visible.length ? (
        <div
          ref={scrollRef}
          className="-mx-4 cursor-grab overflow-x-auto px-4 py-3 select-none [scrollbar-width:none] active:cursor-grabbing [&::-webkit-scrollbar]:hidden"
          onPointerCancel={(event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
          onPointerDown={(event) => handlePointerDown(event, scrollRef.current, dragRefs)}
          onPointerMove={(event) => handlePointerMove(event, scrollRef.current, dragRefs)}
          onPointerUp={(event) => handlePointerEnd(event, scrollRef.current, dragRefs)}
        >
          <div className="flex w-max gap-2.5 pr-4">
            {visible.map((challenge, position) => (
              <MiniCard
                key={challenge.id}
                challenge={challenge}
                distance={distanceTo(challenge)}
                inRange={isInRange(challenge)}
                onOpen={() => { if (!consumeSuppressedClick(dragRefs)) onOpenCard(challenge.id, visible); }}
                suit={getSuit(challenge)}
                tilt={(position % 3) - 1}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="my-3 rounded-2xl border border-dashed border-[#bda370]/55 bg-[#fbf5e5] p-4 text-sm text-[#5c5240]">No challenges left here.</p>
      )}
    </div>
  );
}

function MiniCard({ challenge, suit, distance, inRange, tilt, onOpen }: { challenge: Challenge; suit: CardSuit; distance: number | null; inRange: boolean; tilt: number; onOpen(): void }) {
  const base = getBasePoints(challenge.scoring);
  const maxBonus = getMaxBonusPoints(challenge.config);
  const hint = typeof challenge.config?.location_hint === 'string' && challenge.config.location_hint.trim() ? challenge.config.location_hint : null;
  const short = typeof challenge.config?.short_description === 'string' && challenge.config.short_description.trim() ? challenge.config.short_description : challenge.description;
  const where = suit === 'anywhere' ? (hint ?? 'Anywhere') : distance === null ? (suit === 'area' ? 'Area' : 'On map') : inRange ? (suit === 'area' ? 'In the area' : 'You are here') : formatDistance(distance);
  return (
    <button
      className="relative flex h-[12.25rem] w-[8.75rem] shrink-0 flex-col rounded-[0.9rem] border border-[#a98c5a] bg-[radial-gradient(circle_at_30%_18%,#fbf6e8,#f1e6cc_70%,#eadcbc)] px-2.5 pb-2.5 pt-2 text-left shadow-[0_8px_20px_rgba(40,30,15,0.16)] transition active:scale-[0.98]"
      data-deck-interactive="true"
      onClick={onOpen}
      style={{ transform: `rotate(${tilt * 0.6}deg)` }}
      type="button"
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-[4px] rounded-[0.65rem] border border-[#c4a874]/60" />
      <span className="flex items-start justify-between">
        <span className="flex flex-col items-center leading-none">
          <span className="font-[Georgia,Times_New_Roman,serif] text-lg font-bold" style={{ color: INK }}>{base}</span>
          <SuitGlyph size={12} suit={suit} />
        </span>
        {maxBonus ? <span className="mt-0.5 rounded-full border border-[#c4a874] px-1.5 py-px font-[Georgia,Times_New_Roman,serif] text-[10px] font-semibold italic" style={{ color: RUST }}>+{maxBonus}</span> : null}
      </span>
      <span className="mt-1.5 line-clamp-3 font-[Georgia,Times_New_Roman,serif] text-[15px] font-semibold leading-[1.15]" style={{ color: INK }}>{challenge.title}</span>
      <span className={['mt-1 truncate text-[9px] font-bold uppercase tracking-[0.16em]', inRange && suit !== 'anywhere' ? 'text-[#4d6b4f]' : ''].join(' ')} style={inRange && suit !== 'anywhere' ? undefined : { color: RUST }}>{where}</span>
      <span className="mt-1 line-clamp-4 text-[11px] leading-[1.35] text-[#4d4435]">{short}</span>
    </button>
  );
}
