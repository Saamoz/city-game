import { getJudgingType, isJudgedChallengeConfig, type Challenge } from '@city-game/shared';

// Judged challenges play like normal ones: completing submits them for judging and they disappear
// from that team's view. They stay open for other teams until each has done them.

export function isJudgedChallenge(challenge: Challenge): boolean {
  return isJudgedChallengeConfig(challenge.config);
}

// Small marker so players know the points are awarded by judges after the game.
export function JudgedMark({ challenge, compact = false }: { challenge: Challenge; compact?: boolean }) {
  const type = compact ? 'pass_fail' : getJudgingType(challenge.config);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#8f80b8]/50 bg-[#ece6f6] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[#4a3b70]" title="Points awarded by the judges after the game">
      <span aria-hidden="true">★</span>{type === 'best_wins' ? 'Judged · best wins' : 'Judged'}
    </span>
  );
}
