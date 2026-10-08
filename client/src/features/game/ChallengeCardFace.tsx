import { useEffect, useState, type ReactNode } from 'react';
import { getBasePoints, getChallengeBonuses, isJudgedChallengeConfig, type Challenge } from '@city-game/shared';
import { formatDistance } from '../../lib/units';
import { EdgeLabel, Flourish, INK, RUST, SuitGlyph, type CardSuit } from './CardGlyphs';
import type { CompletionExtras } from './ChallengeScoring';

export interface CardReroll {
  voted: boolean;
  count: number;
  eligible: number;
  pending: boolean;
  onToggle(): void;
}

interface ChallengeCardFaceProps {
  gameName: string;
  challenge: Challenge;
  suit: CardSuit;
  distanceMeters: number | null;
  // Pinned and area challenges unlock only on location; anywhere ones are always in range.
  inRange: boolean;
  pending: boolean;
  onComplete(extras: CompletionExtras): void;
  onShowOnMap?(): void;
  reroll?: CardReroll | null;
}

// A challenge drawn as a playing card on old parchment: corner indices with the points and the suit,
// the short description up front, longer explanations behind (i) toggles, and bonus tasks to tick.
export function ChallengeCardFace({ gameName, challenge, suit, distanceMeters, inRange, pending, onComplete, onShowOnMap, reroll }: ChallengeCardFaceProps) {
  const base = getBasePoints(challenge.scoring);
  const bonuses = getChallengeBonuses(challenge.config);
  const judged = isJudgedChallengeConfig(challenge.config);
  const shortText = getText(challenge, 'short_description') ?? challenge.description;
  const longText = getText(challenge, 'long_description') ?? (challenge.description !== shortText ? challenge.description : null);
  const hint = getText(challenge, 'location_hint');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [openInfo, setOpenInfo] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const total = base + bonuses.filter((bonus) => selected.has(bonus.id)).reduce((sum, bonus) => sum + bonus.points, 0);

  // A tap arms the button; it disarms itself if not confirmed.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; };
  // The place name the author gave it ("Chinatown Library", "Any Costco"), else the kind of spot.
  const kindLine = hint ?? (suit === 'pin' ? 'Pinned spot' : suit === 'area' ? 'Area' : 'Anywhere');
  const where = suit === 'anywhere' || distanceMeters === null ? null : inRange ? (suit === 'area' ? "you're in it" : "you're here") : formatDistance(distanceMeters) + ' away';

  return (
    <article className="relative flex h-full w-full flex-col overflow-hidden rounded-[1.35rem] border border-[#a98c5a] bg-[radial-gradient(circle_at_28%_18%,#fbf6e8,#f2e8cf_62%,#e8d9b6)] text-[#2f2a20] shadow-[0_24px_60px_rgba(30,24,14,0.38)]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-[7px] rounded-[1rem] border border-[#c4a874]/70" />
      <EdgeLabel text={gameName} />
      <CornerIndex points={base} suit={suit} />
      <CornerIndex flipped points={base} suit={suit} />

      {/* Inset so the corner indices (top-left, bottom-right) never sit on top of content. */}
      <div className="relative flex min-h-0 flex-1 flex-col pb-[3.9rem] pl-6 pr-6 pt-6">
        <div className="pl-9 pr-1">
          <p className="flex flex-wrap items-center gap-x-1.5 text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: RUST }}>
            <span>{kindLine}</span>
            {where ? <span className={inRange ? 'text-[#4d6b4f]' : ''}>· {where}</span> : null}
            {judged ? <span className="text-[#6b5a86]">· Judged</span> : null}
          </p>
          <div className="mt-1 flex items-start justify-between gap-2">
            <h2 className="font-[Georgia,Times_New_Roman,serif] text-[1.55rem] font-semibold leading-[1.15]" style={{ color: INK }}>{challenge.title}</h2>
            {reroll ? <RerollButton reroll={reroll} /> : null}
          </div>
        </div>

        <div className="my-3"><Flourish /></div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1 [scrollbar-width:thin]">
          <p className="text-[15px] leading-6 text-[#3d362a]">{shortText}</p>
          {longText ? <InfoToggle open={openInfo.has('__long')} onToggle={() => setOpenInfo((current) => toggle(current, '__long'))} label="More info">{longText}</InfoToggle> : null}

          {bonuses.length ? (
            <section>
              <p className="mb-1.5 font-[Georgia,Times_New_Roman,serif] text-sm font-semibold italic" style={{ color: RUST }}>Bonus</p>
              <ul className="divide-y divide-[#d6c39a]/70 rounded-xl border border-[#d6c39a] bg-[#fbf5e5]/70">
                {bonuses.map((bonus) => {
                  const checked = selected.has(bonus.id);
                  return (
                    <li key={bonus.id} className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                          <input checked={checked} className="peer sr-only" onChange={() => setSelected((current) => toggle(current, bonus.id))} type="checkbox" />
                          <span aria-hidden="true" className={['grid h-5 w-5 shrink-0 place-items-center rounded-[4px] border-[1.5px] text-[12px] font-bold', checked ? 'border-[#4f3f2a] bg-[#4f3f2a] text-[#f5ecd6]' : 'border-[#9c8358] bg-[#fffaf0]'].join(' ')}>{checked ? '✓' : ''}</span>
                          <span className="min-w-0 text-sm leading-5 text-[#3d362a] peer-focus-visible:underline">{bonus.label}</span>
                        </label>
                        <span className="shrink-0 font-[Georgia,Times_New_Roman,serif] text-sm font-semibold" style={{ color: RUST }}>+{bonus.points}</span>
                        {bonus.description ? <InfoButton label={'About ' + bonus.label} open={openInfo.has(bonus.id)} onToggle={() => setOpenInfo((current) => toggle(current, bonus.id))} /> : null}
                      </div>
                      {bonus.description && openInfo.has(bonus.id) ? <p className="mt-1.5 pl-[1.9rem] text-[13px] italic leading-5 text-[#5c5240]">{bonus.description}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <span className="text-xs text-[#6d6150]">{judged ? 'Bonus · judges say yes or no' : bonuses.length ? base + ' + ' + (total - base) + ' bonus' : 'Points'}</span>
            {<span className="font-[Georgia,Times_New_Roman,serif] text-xl font-semibold" style={{ color: INK }}>{total} {total === 1 ? 'pt' : 'pts'}</span>}
          </div>
          <div className="flex gap-2">
            {onShowOnMap ? (
              <button aria-label="Show on map" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#a98c5a] bg-[#fbf5e5] text-[#4f3f2a]" onClick={onShowOnMap} type="button">
                <MapIcon />
              </button>
            ) : null}
            <button
              className={['h-12 flex-1 rounded-xl border px-4 text-sm font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed', confirming ? 'border-[#6e3b22] bg-[#7d4527] text-[#fbf1dc]' : 'border-[#3a3022] bg-[#3a3022] text-[#f5ecd6] disabled:border-[#b9ab8f] disabled:bg-[#cfc3a8] disabled:text-[#7a6f5c]'].join(' ')}
              disabled={pending || !inRange}
              onClick={() => {
                if (!confirming) { setConfirming(true); return; }
                setConfirming(false);
                onComplete({ bonusIds: [...selected] });
              }}
              type="button"
            >
              {pending ? 'Completing…' : !inRange ? (distanceMeters === null ? 'Locating…' : 'Get closer · ' + formatDistance(distanceMeters)) : confirming ? 'Tap again to confirm' : 'Complete · ' + total + (total === 1 ? ' pt' : ' pts')}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function CornerIndex({ points, suit, flipped = false }: { points: number; suit: CardSuit; flipped?: boolean }) {
  return (
    <div aria-hidden="true" className={['pointer-events-none absolute flex w-7 flex-col items-center leading-none', flipped ? 'bottom-3.5 right-3 rotate-180' : 'left-3 top-3.5'].join(' ')}>
      <span className="font-[Georgia,Times_New_Roman,serif] text-[1.35rem] font-bold" style={{ color: INK }}>{points}</span>
      <span className="mt-0.5"><SuitGlyph size={15} suit={suit} /></span>
    </div>
  );
}

function InfoButton({ open, onToggle, label }: { open: boolean; onToggle(): void; label: string }) {
  return (
    <button aria-expanded={open} aria-label={label} className={['grid h-6 w-6 shrink-0 place-items-center rounded-full border font-[Georgia,Times_New_Roman,serif] text-[13px] italic', open ? 'border-[#4f3f2a] bg-[#4f3f2a] text-[#f5ecd6]' : 'border-[#a98c5a] text-[#6d5a3c]'].join(' ')} onClick={onToggle} type="button">i</button>
  );
}

function InfoToggle({ open, onToggle, label, children }: { open: boolean; onToggle(): void; label: string; children: ReactNode }) {
  return (
    <div>
      <button aria-expanded={open} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#6d5a3c]" onClick={onToggle} type="button">
        <span className={['grid h-5 w-5 place-items-center rounded-full border font-[Georgia,Times_New_Roman,serif] text-[12px] normal-case italic', open ? 'border-[#4f3f2a] bg-[#4f3f2a] text-[#f5ecd6]' : 'border-[#a98c5a]'].join(' ')}>i</span>
        {open ? 'Less' : label}
      </button>
      {open ? <p className="mt-2 whitespace-pre-line border-l-2 border-[#c4a874] pl-3 text-[14px] italic leading-6 text-[#4d4435]">{children}</p> : null}
    </div>
  );
}

function RerollButton({ reroll }: { reroll: CardReroll }) {
  return (
    <button aria-label={reroll.voted ? 'Withdraw reroll vote' : 'Vote to reroll'} aria-pressed={reroll.voted} className={['inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-semibold tabular-nums', reroll.voted ? 'bg-[#e3d4b0] text-[#4f3f2a]' : 'text-[#7d6b4c]'].join(' ')} disabled={reroll.pending} onClick={reroll.onToggle} type="button">
      <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24"><path d="M19 8a8 8 0 1 0 1 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /><path d="M19 4v4h-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
      {reroll.count > 0 ? <span>{reroll.count}/{reroll.eligible}</span> : null}
    </button>
  );
}

function MapIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="M3.5 6.5 9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M9 4v13.5M15 6.5V20" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function getText(challenge: Challenge, key: string): string | null {
  const value = challenge.config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

