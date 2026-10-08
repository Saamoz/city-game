import { useState } from 'react';
import { getBasePoints, getChallengeBonuses, getMaxBonusPoints, type Challenge, type ChallengeBonus } from '@city-game/shared';

export interface CompletionExtras {
  note?: string;
  bonusIds?: string[];
}

export function formatPoints(points: number): string {
  return points + ' ' + (Math.abs(points) === 1 ? 'pt' : 'pts');
}

// "3 pts" and "+5 bonus" chips. Judged challenges show their own reward label instead of a base.
export function ScoreChips({ challenge, showBase = true, size = 'sm' }: { challenge: Challenge; showBase?: boolean; size?: 'sm' | 'xs' }) {
  const base = getBasePoints(challenge.scoring);
  const maxBonus = getMaxBonusPoints(challenge.config);
  const text = size === 'xs' ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5';
  if (!(showBase && base) && !maxBonus) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {showBase && base ? <span className={'rounded-full bg-[#24343a] font-bold uppercase tracking-[0.12em] text-[#f4ead7] ' + text}>{formatPoints(base)}</span> : null}
      {maxBonus ? <span className={'rounded-full border border-[#c9973a]/60 bg-[#fbecc8] font-bold uppercase tracking-[0.12em] text-[#7a5413] ' + text}>+{maxBonus} bonus</span> : null}
    </span>
  );
}

// Read-only list of a challenge's bonus tasks, for detail views.
export function BonusList({ challenge }: { challenge: Challenge }) {
  const bonuses = getChallengeBonuses(challenge.config);
  if (!bonuses.length) return null;
  return (
    <div className="rounded-2xl border border-[#e0c88f]/70 bg-[#fdf5e1] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#7a5413]">Bonus tasks</p>
      <ul className="mt-2 space-y-1.5">
        {bonuses.map((bonus) => (
          <li key={bonus.id} className="flex items-start justify-between gap-3 text-sm text-[#3f4d52]">
            <span>{bonus.judged ? '★ ' : ''}{bonus.label}{bonus.judged ? <span className="block text-[11px] italic text-[#6b5a86]">Judged after the game</span> : null}</span>
            <span className="shrink-0 font-semibold text-[#7a5413]">+{formatPoints(bonus.points)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ChecklistProps {
  bonuses: ChallengeBonus[];
  selected: Set<string>;
  onToggle(id: string): void;
}

export function BonusChecklist({ bonuses, selected, onToggle }: ChecklistProps) {
  return (
    <fieldset className="rounded-2xl border border-[#e0c88f]/70 bg-[#fdf5e1] px-3 py-2.5">
      <legend className="px-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[#7a5413]">Bonus tasks you did</legend>
      <div className="space-y-1">
        {bonuses.map((bonus) => {
          const checked = selected.has(bonus.id);
          // Judged after the game, so there is nothing to tick now.
          if (bonus.judged) {
            return (
              <div key={bonus.id} className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm text-[#4f5b5f]">
                <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center text-[#6b5a86]">★</span>
                <span className="min-w-0 flex-1">{bonus.label}<span className="block text-[11px] italic text-[#6b5a86]">Judged after the game</span></span>
                <span className="shrink-0 font-semibold text-[#7a5413]">+{bonus.points}</span>
              </div>
            );
          }
          return (
            <label key={bonus.id} className={['flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-sm transition', checked ? 'bg-[#f6e3b4] text-[#2c2a20]' : 'text-[#4f5b5f] hover:bg-[#f9ecca]'].join(' ')}>
              <input checked={checked} className="h-5 w-5 shrink-0 accent-[#9b6b16]" onChange={() => onToggle(bonus.id)} type="checkbox" />
              <span className="min-w-0 flex-1">{bonus.label}</span>
              <span className="shrink-0 font-semibold text-[#7a5413]">+{bonus.points}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function useBonusSelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return { selected, toggle, reset: () => setSelected(new Set()) };
}

// "3 base + 4 bonus = 7 pts"
export function PointsTotal({ base, bonuses, selected }: { base: number; bonuses: ChallengeBonus[]; selected: Set<string> }) {
  const bonus = bonuses.filter((entry) => selected.has(entry.id)).reduce((total, entry) => total + entry.points, 0);
  return (
    <div className="flex items-baseline justify-between gap-3 px-1 text-sm text-[#4f5b5f]">
      <span>{base} base{bonuses.length ? ' + ' + bonus + ' bonus' : ''}</span>
      <span className="font-[Georgia,Times_New_Roman,serif] text-xl font-semibold text-[#1f2a2f]">{formatPoints(base + bonus)}</span>
    </div>
  );
}

interface CompleteSheetProps {
  challenge: Challenge;
  pending: boolean;
  confirmLabel: string;
  onConfirm(extras: CompletionExtras): void;
  onCancel(): void;
}

// Full-screen confirm for challenges with bonus tasks: the deck cards are too small for a checklist.
export function CompleteChallengeSheet({ challenge, pending, confirmLabel, onConfirm, onCancel }: CompleteSheetProps) {
  const bonuses = getChallengeBonuses(challenge.config);
  const { selected, toggle } = useBonusSelection();
  const base = getBasePoints(challenge.scoring);
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-[#162126]/45 p-3 lg:items-center" data-deck-interactive="true" onClick={onCancel}>
      <div className="w-full max-w-md rounded-[1.8rem] border border-[#c8b48a]/55 bg-[#f8f1df] p-5 text-[#1f2a2f] shadow-[0_24px_70px_rgba(20,28,32,0.3)]" data-deck-interactive="true" onClick={(event) => event.stopPropagation()}>
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#936718]">Complete challenge</p>
        <h3 className="mt-1.5 font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold leading-tight">{challenge.title}</h3>
        <div className="mt-4 space-y-3">
          <BonusChecklist bonuses={bonuses} onToggle={toggle} selected={selected} />
          <PointsTotal base={base} bonuses={bonuses} selected={selected} />
          <p className="px-1 text-[11px] leading-4 text-[#6b777b]">Only tick bonuses your team really did. You can't change this after confirming.</p>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button className="rounded-2xl border border-[#29414b] bg-[#24343a] px-4 py-3.5 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] disabled:opacity-60" disabled={pending} onClick={() => onConfirm({ bonusIds: [...selected] })} type="button">
              {pending ? 'Completing…' : confirmLabel}
            </button>
            <button className="rounded-2xl border border-[#c8b48a]/55 bg-[#efe5cf] px-4 py-3.5 text-sm font-semibold uppercase tracking-[0.12em] text-[#5d4d33]" onClick={onCancel} type="button">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
