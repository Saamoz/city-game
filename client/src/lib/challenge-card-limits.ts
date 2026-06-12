export const CHALLENGE_CARD_TITLE_MAX_LENGTH = 38;
export const CHALLENGE_CARD_SHORT_DESCRIPTION_MAX_LENGTH = 96;

export function normalizeChallengeCardText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function clampChallengeCardText(value: string, maxLength: number): string {
  const normalized = normalizeChallengeCardText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}
