// A judged challenge stays open all game: each team may submit once, and judges award points afterwards.
export function isJudgedChallengeConfig(config: unknown): boolean {
  return Boolean(config && typeof config === 'object' && !Array.isArray(config) && (config as { judged?: unknown }).judged === true);
}

export function getJudgedMaxPoints(config: unknown): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as { judged_max_points?: unknown }).judged_max_points;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
