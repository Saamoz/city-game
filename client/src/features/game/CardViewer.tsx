import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Challenge } from '@city-game/shared';
import { ChallengeCardFace, type CardReroll } from './ChallengeCardFace';
import type { CardSuit } from './CardGlyphs';
import type { CompletionExtras } from './ChallengeScoring';

export interface CardContext {
  suit: CardSuit;
  distanceMeters: number | null;
  inRange: boolean;
  onShowOnMap?(): void;
  reroll?: CardReroll | null;
}

interface CardViewerProps {
  gameName: string;
  challenges: Challenge[];
  startId: string;
  getContext(challenge: Challenge): CardContext;
  isPending(challengeId: string): boolean;
  onComplete(challengeId: string, extras: CompletionExtras): void;
  onClose(): void;
}

const SWIPE_THRESHOLD_PX = 60;

// Full-screen deck: one fixed-size card at a time, swipe sideways to flip through the others.
export function CardViewer({ gameName, challenges, startId, getContext, isPending, onComplete, onClose }: CardViewerProps) {
  const [currentId, setCurrentId] = useState(startId);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef({ pointerId: -1, startX: 0, startY: 0, startTime: 0, horizontal: false, decided: false });
  const lastIndexRef = useRef(0);
  // A swipe ends with a click on the captured backdrop; it must not count as "tap outside to close".
  const justSwipedRef = useRef(false);

  const foundIndex = challenges.findIndex((challenge) => challenge.id === currentId);
  // If the current card left the deck (completed), stay at the same position in the list.
  const index = foundIndex >= 0 ? foundIndex : Math.min(lastIndexRef.current, challenges.length - 1);
  lastIndexRef.current = index;
  const current = challenges[index] ?? null;

  useEffect(() => {
    if (!challenges.length) onClose();
    else if (foundIndex < 0 && current) setCurrentId(current.id);
  }, [challenges.length, foundIndex, current, onClose]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  const go = (step: number) => {
    const next = challenges[index + step];
    if (next) setCurrentId(next.id);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startTime: Date.now(), horizontal: false, decided: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      state.decided = true;
      state.horizontal = Math.abs(dx) > Math.abs(dy);
      if (state.horizontal) { event.currentTarget.setPointerCapture(event.pointerId); setIsDragging(true); }
    }
    if (!state.horizontal) return;
    // Resist at the ends of the deck.
    const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === challenges.length - 1);
    setDragX(atEdge ? dx * 0.3 : dx);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (state.pointerId !== event.pointerId) return;
    drag.current.pointerId = -1;
    if (state.horizontal) {
      justSwipedRef.current = true;
      window.setTimeout(() => { justSwipedRef.current = false; }, 0);
      const dx = event.clientX - state.startX;
      const velocity = dx / Math.max(Date.now() - state.startTime, 1);
      if (dx < -SWIPE_THRESHOLD_PX || velocity < -0.5) go(1);
      else if (dx > SWIPE_THRESHOLD_PX || velocity > 0.5) go(-1);
    }
    setIsDragging(false);
    setDragX(0);
  };

  if (!current) return null;
  const slides = [index - 1, index, index + 1].filter((position) => position >= 0 && position < challenges.length);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#1d1810]/30" role="dialog" aria-modal="true" aria-label={current.title}>
      <div className="flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] text-[#f3e8cf]">
        <span className="rounded-full bg-[#2a2217]/75 px-3 py-1 font-[Georgia,Times_New_Roman,serif] text-sm italic tabular-nums">{index + 1} of {challenges.length}</span>
        <button aria-label="Close card" className="grid h-10 w-10 place-items-center rounded-full border border-[#f3e8cf]/40 bg-[#2a2217]/80 text-lg" onClick={onClose} type="button">×</button>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden [touch-action:pan-y]"
        onClick={(event) => { if (event.target === event.currentTarget && !justSwipedRef.current) onClose(); }}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
      >
        {slides.map((position) => {
          const challenge = challenges[position]!;
          const context = getContext(challenge);
          const offset = (position - index) * 100;
          return (
            <div
              key={challenge.id}
              className="pointer-events-none absolute inset-0 flex items-center justify-center px-4"
              style={{ transform: `translateX(calc(${offset}% + ${dragX}px))`, transition: isDragging ? 'none' : 'transform 0.32s cubic-bezier(0.22,1,0.36,1)' }}
            >
              <div className="pointer-events-auto h-[min(74dvh,640px)] w-[min(92vw,400px)]">
                <ChallengeCardFace
                  gameName={gameName}
                  key={challenge.id}
                  challenge={challenge}
                  distanceMeters={context.distanceMeters}
                  inRange={context.inRange}
                  onComplete={(extras) => onComplete(challenge.id, extras)}
                  onShowOnMap={context.onShowOnMap}
                  pending={isPending(challenge.id)}
                  reroll={context.reroll}
                  suit={context.suit}
                />
              </div>
            </div>
          );
        })}

        <button aria-label="Previous card" className="absolute left-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-[#2a2217]/70 text-xl text-[#f3e8cf] disabled:opacity-30 lg:grid" disabled={index === 0} onClick={() => go(-1)} type="button">‹</button>
        <button aria-label="Next card" className="absolute right-3 top-1/2 hidden h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-[#2a2217]/70 text-xl text-[#f3e8cf] disabled:opacity-30 lg:grid" disabled={index === challenges.length - 1} onClick={() => go(1)} type="button">›</button>
      </div>

      <div className="mx-auto mb-[calc(env(safe-area-inset-bottom,0px)+1rem)] mt-3 flex flex-wrap justify-center gap-1.5 rounded-full bg-[#2a2217]/70 px-3 py-1.5">
        {challenges.length <= 30 ? challenges.map((challenge, position) => (
          <span key={challenge.id} className={['h-1.5 rounded-full transition-all', position === index ? 'w-4 bg-[#f3e8cf]' : 'w-1.5 bg-[#f3e8cf]/35'].join(' ')} />
        )) : <span className="text-xs text-[#f3e8cf]/70">Swipe for more</span>}
      </div>
    </div>
  );
}
