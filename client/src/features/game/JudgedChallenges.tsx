import { useState } from 'react';
import { getChallengeBonuses, getJudgedMaxPoints, isJudgedChallengeConfig, type Challenge, type ChallengeClaim, type Team } from '@city-game/shared';
import { BonusChecklist, BonusList, useBonusSelection, type CompletionExtras } from './ChallengeScoring';
import { OverlayShell } from './Phase32Panels';
import { getPointLocation, getPointRadius } from './PointChallenges';

// Judged challenges stay open all game. Each team submits once; judges score them after the game.

export function isJudgedChallenge(challenge: Challenge): boolean {
  return isJudgedChallengeConfig(challenge.config);
}

export function getJudgedSubmissions(claims: ChallengeClaim[], challengeId: string): ChallengeClaim[] {
  return claims.filter((claim) => claim.challengeId === challengeId && claim.status === 'submitted');
}

export function formatJudgedReward(challenge: Challenge): string {
  const maxPoints = getJudgedMaxPoints(challenge.config);
  return maxPoints ? 'Up to ' + maxPoints + ' pts' : 'Points from judges';
}

interface SubmittedTeamsProps { submissions: ChallengeClaim[]; teams: Team[] }

export function SubmittedTeams({ submissions, teams }: SubmittedTeamsProps) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#5a6a70]">
      <span className="font-semibold uppercase tracking-[0.14em] text-[#7a6a48]">{submissions.length} of {teams.length} teams in</span>
      {submissions.map((claim) => {
        const team = teamById.get(claim.teamId);
        return (
          <span key={claim.id} className="inline-flex items-center gap-1 rounded-full border border-[#d6c59d]/60 bg-[#fff8eb] px-2 py-0.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: team?.color ?? '#a28f67' }} />
            {team?.name ?? 'Team'}
          </span>
        );
      })}
    </div>
  );
}

interface SubmitFormProps {
  challenge: Challenge;
  pending: boolean;
  disabledReason: string | null;
  onSubmit(extras: CompletionExtras): void;
}

// Two steps, because a team only gets one submission.
export function JudgedSubmitForm({ challenge, pending, disabledReason, onSubmit }: SubmitFormProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [note, setNote] = useState('');
  const bonuses = getChallengeBonuses(challenge.config);
  const { selected, toggle } = useBonusSelection();
  const buttonClassName = 'w-full rounded-2xl border border-[#4a3a6b] bg-[#3f3360] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#f4ead7] transition hover:bg-[#33294f] disabled:cursor-not-allowed disabled:border-[#a7a1b5] disabled:bg-[#b3adc0]';

  if (disabledReason) {
    return <button className={buttonClassName} disabled type="button">{disabledReason}</button>;
  }
  if (!isOpen) {
    return <button className={buttonClassName} disabled={pending} onClick={() => setIsOpen(true)} type="button">Submit for judging</button>;
  }
  return (
    <div className="space-y-2">
      <textarea
        className="h-20 w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 text-sm text-[#24343a] outline-none focus:border-[#8f7446]"
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note for the judges (optional): your answer, or where you posted the photo"
        value={note}
      />
      {bonuses.length ? <BonusChecklist bonuses={bonuses} onToggle={toggle} selected={selected} /> : null}
      <p className="text-[11px] leading-4 text-[#6b777b]">Your team can submit this once. Judges award the points after the game{bonuses.length ? ', and see which bonuses you ticked' : ''}.</p>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <button className={buttonClassName} disabled={pending} onClick={() => onSubmit({ note: note.trim() || undefined, bonusIds: [...selected] })} type="button">{pending ? 'Submitting…' : 'Confirm submission'}</button>
        <button className="rounded-2xl border border-[#c8b48a]/55 bg-[#efe5cf] px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#5d4d33]" onClick={() => setIsOpen(false)} type="button">Cancel</button>
      </div>
    </div>
  );
}

export function SubmittedBadge({ claim }: { claim: ChallengeClaim }) {
  const at = new Date(claim.completedAt ?? claim.claimedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="rounded-2xl border border-[#7b9a73]/45 bg-[#e1ebdd] px-4 py-3 text-sm text-[#244028]">
      <p className="font-semibold">✓ Your team submitted at {at}</p>
      <p className="mt-0.5 text-xs text-[#3f5a43]">The judges score it after the game.</p>
    </div>
  );
}

export function JudgedTag({ challenge }: { challenge: Challenge }) {
  return (
    <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-[#5b4a86]">
      <span aria-hidden="true">★</span>
      <span>Judged</span>
      <span className="text-[#936718]">· {formatJudgedReward(challenge)}</span>
    </p>
  );
}

interface OverlayProps {
  challenges: Challenge[];
  claims: ChallengeClaim[];
  teams: Team[];
  teamId: string | null;
  distanceTo(challenge: Challenge): number | null;
  isPending(challengeId: string): boolean;
  onSubmit(challengeId: string, extras: CompletionExtras): void;
  onLocate(challengeId: string): void;
  onClose(): void;
}

export function JudgedChallengesOverlay({ challenges, claims, teams, teamId, distanceTo, isPending, onSubmit, onLocate, onClose }: OverlayProps) {
  const sorted = [...challenges].sort((left, right) => {
    const leftDone = getJudgedSubmissions(claims, left.id).some((claim) => claim.teamId === teamId);
    const rightDone = getJudgedSubmissions(claims, right.id).some((claim) => claim.teamId === teamId);
    return Number(leftDone) - Number(rightDone) || left.sortOrder - right.sortOrder;
  });

  return (
    <OverlayShell title="Judged Challenges" onClose={onClose}>
      <p className="mb-3 text-xs leading-5 text-[#55656c]">Every team can do these, once each. Nothing is scored now: the judges award points after the game.</p>
      <div className="space-y-3">
        {sorted.map((challenge) => {
          const submissions = getJudgedSubmissions(claims, challenge.id);
          const ownClaim = submissions.find((claim) => claim.teamId === teamId) ?? null;
          const isPinned = getPointLocation(challenge) !== null;
          const distance = isPinned ? distanceTo(challenge) : null;
          const radius = isPinned ? getPointRadius(challenge) : null;
          const outOfRange = isPinned && (distance === null || distance > (radius ?? 0));
          const hint = typeof challenge.config?.location_hint === 'string' && challenge.config.location_hint.trim() ? challenge.config.location_hint : null;
          const longDescription = typeof challenge.config?.long_description === 'string' && challenge.config.long_description.trim() ? challenge.config.long_description : challenge.description;

          return (
            <article key={challenge.id} className={['rounded-[1.2rem] border p-4', ownClaim ? 'border-[#c8b48a]/40 bg-[#efe7d4]' : 'border-[#b9add3]/70 bg-[#fbf7ee]'].join(' ')}>
              <JudgedTag challenge={challenge} />
              <h3 className="mt-1.5 font-[Georgia,Times_New_Roman,serif] text-lg font-semibold leading-snug text-[#1f2a2f]">{challenge.title}</h3>
              <p className="mt-1 text-sm leading-6 text-[#4f6168]">{longDescription}</p>
              <div className="mt-3"><BonusList challenge={challenge} /></div>
              <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#647d74]">
                {isPinned ? '📍 At a pinned spot' + (distance !== null ? ' · ' + Math.round(distance) + ' m away' : '') : hint ?? 'Anywhere'}
              </p>
              <div className="mt-3"><SubmittedTeams submissions={submissions} teams={teams} /></div>
              <div className="mt-3">
                {ownClaim ? <SubmittedBadge claim={ownClaim} /> : (
                  <div className="space-y-2">
                    {isPinned ? (
                      <button className="w-full rounded-2xl border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.16em] text-[#24343a]" onClick={() => onLocate(challenge.id)} type="button">Show on map</button>
                    ) : null}
                    <JudgedSubmitForm
                      disabledReason={!teamId ? 'Join a team to submit' : outOfRange ? 'Get within ' + Math.round(radius ?? 0) + ' m to submit' : null}
                      challenge={challenge}
                      onSubmit={(extras) => onSubmit(challenge.id, extras)}
                      pending={isPending(challenge.id)}
                    />
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </OverlayShell>
  );
}
