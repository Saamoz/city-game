// Challenge scoring: a base award in `scoring.points` plus optional bonus tasks in `config.bonuses`.
// Teams self-report which bonuses they did when they complete; the server only counts bonus ids
// that exist on the challenge.

export interface ChallengeBonus {
  id: string;
  label: string;
  points: number;
}

export function getChallengeBonuses(config: unknown): ChallengeBonus[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const raw = (config as { bonuses?: unknown }).bonuses;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ChallengeBonus[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, label, points } = entry as { id?: unknown; label?: unknown; points?: unknown };
    if (typeof id !== 'string' || !id || typeof label !== 'string' || !label.trim()) return [];
    return [{ id, label: label.trim(), points: typeof points === 'number' && Number.isFinite(points) ? Math.round(points) : 0 }];
  });
}

export function getBasePoints(scoring: unknown): number {
  const value = scoring && typeof scoring === 'object' ? (scoring as { points?: unknown }).points : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function getMaxBonusPoints(config: unknown): number {
  return getChallengeBonuses(config).reduce((total, bonus) => total + Math.max(0, bonus.points), 0);
}

// Bonus ids a submission claims, limited to bonuses the challenge actually has.
export function getClaimedBonuses(config: unknown, submission: unknown): ChallengeBonus[] {
  const raw = submission && typeof submission === 'object' && !Array.isArray(submission) ? (submission as { bonusIds?: unknown }).bonusIds : null;
  if (!Array.isArray(raw)) return [];
  const claimed = new Set(raw.filter((id): id is string => typeof id === 'string'));
  return getChallengeBonuses(config).filter((bonus) => claimed.has(bonus.id));
}

export function sumBonusPoints(bonuses: ChallengeBonus[]): number {
  return bonuses.reduce((total, bonus) => total + bonus.points, 0);
}
