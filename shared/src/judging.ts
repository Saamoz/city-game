// A judged challenge stays open all game: each team may submit once, and judges award points afterwards.
export function isJudgedChallengeConfig(config: unknown): boolean {
  return Boolean(config && typeof config === 'object' && !Array.isArray(config) && (config as { judged?: unknown }).judged === true);
}

export function getJudgedMaxPoints(config: unknown): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as { judged_max_points?: unknown }).judged_max_points;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// How judges decide a judged challenge:
// - pass_fail: each submitting team gets the points or not (judges can also approve claimed bonuses).
// - best_wins: judges pick the best team(s); only they get the points.
// - points: judges set any number of points per team (older judged challenges, which had a max).
export const JUDGING_TYPES = ['pass_fail', 'best_wins', 'points'] as const;
export type JudgingType = (typeof JUDGING_TYPES)[number];

export function getJudgingType(config: unknown): JudgingType {
  const value = config && typeof config === 'object' && !Array.isArray(config) ? (config as { judging_type?: unknown }).judging_type : null;
  if (value === 'pass_fail' || value === 'best_wins' || value === 'points') return value;
  return getJudgedMaxPoints(config) !== null ? 'points' : 'pass_fail';
}

export type JudgingVerdict = 'pass' | 'fail' | 'winner' | 'points';

export interface JudgingDecision {
  verdict: JudgingVerdict;
  bonusIds?: string[];
  points?: number;
}

export const JUDGING_TYPE_LABELS: Record<JudgingType, string> = {
  pass_fail: 'Yes / no',
  best_wins: 'Best team wins',
  points: 'Judge sets points',
};
