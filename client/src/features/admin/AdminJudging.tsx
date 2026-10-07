import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  JUDGING_TYPE_LABELS,
  type Game,
  type GameJudgingSheet,
  type JudgingChallenge,
  type JudgingDecision,
  type JudgingSubmission,
  type Team,
} from '@city-game/shared';
import { ApiError, getJudgingSheet, getTeams, listGames, publishJudgedScores, setJudgingDecision } from '../../lib/api';

interface AdminJudgingProps {
  initialGameId: string | null;
}

type Section = 'todo' | 'done';

const REFRESH_MS = 15_000;

// Judging page: every judged challenge with the teams that completed it. Judged challenges are
// yes/no: each team gets a verdict (plus approval of the bonuses it claimed). Older challenge sets
// may still have best-team or set-points challenges, so those keep their controls. Decisions can be
// made any time; once the game is over, players wait on a holding screen until "Show results".
export function AdminJudging({ initialGameId }: AdminJudgingProps) {
  const [games, setGames] = useState<Game[]>([]);
  const [gameId, setGameId] = useState<string | null>(initialGameId);
  const [sheet, setSheet] = useState<GameJudgingSheet | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [section, setSection] = useState<Section>('todo');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingClaimIds, setSavingClaimIds] = useState<Set<string>>(new Set());
  const [isPublishing, setIsPublishing] = useState(false);
  // Cards you judge stay where they are until you switch tabs, so a tap never makes them jump away.
  const [keepVisible, setKeepVisible] = useState<Set<string>>(new Set());
  const switchSection = (next: Section) => { setSection(next); setKeepVisible(new Set()); };

  const game = games.find((entry) => entry.id === gameId) ?? null;

  useEffect(() => {
    void listGames().then((list) => {
      setGames(list);
      if (!gameId) {
        const pick = list.find((entry) => entry.status === 'completed' && entry.modeKey === 'point_challenge')
          ?? list.find((entry) => entry.modeKey === 'point_challenge') ?? list[0];
        if (pick) setGameId(pick.id);
      }
    }).catch((reason) => setError(getErrorMessage(reason)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (targetGameId: string) => {
    try {
      const [nextSheet, nextTeams] = await Promise.all([getJudgingSheet(targetGameId), getTeams(targetGameId)]);
      setSheet(nextSheet);
      setTeams(nextTeams);
      setError(null);
    } catch (reason) {
      setError(getErrorMessage(reason));
    }
  }, []);

  useEffect(() => {
    if (!gameId) return;
    window.history.replaceState({}, '', '/admin/judging?gameId=' + encodeURIComponent(gameId));
    setSheet(null);
    void load(gameId);
    // New submissions keep arriving while the game runs.
    const timer = window.setInterval(() => { void load(gameId); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [gameId, load]);

  const decide = async (challengeId: string, submission: JudgingSubmission, decision: JudgingDecision | null) => {
    setKeepVisible((current) => new Set(current).add(challengeId));
    setSavingClaimIds((current) => new Set(current).add(submission.claimId));
    // Optimistic: show the choice right away, then take the server's computed points.
    setSheet((current) => current && patchSubmission(current, submission.claimId, { decision, points: null }));
    try {
      const points = await setJudgingDecision(submission.claimId, decision);
      setSheet((current) => current && patchSubmission(current, submission.claimId, { decision, points }));
    } catch (reason) {
      setError(getErrorMessage(reason));
      if (gameId) void load(gameId);
    } finally {
      setSavingClaimIds((current) => { const next = new Set(current); next.delete(submission.claimId); return next; });
    }
  };

  const publish = async () => {
    if (!gameId || !sheet) return;
    const openCount = sheet.challenges.filter((entry) => !isChallengeJudged(entry)).length;
    if (openCount > 0 && !window.confirm(openCount + (openCount === 1 ? ' challenge is' : ' challenges are') + ' not fully judged. Teams without a decision get no points. Show results anyway?')) return;
    setIsPublishing(true);
    try {
      setSheet(await publishJudgedScores(gameId));
      setNotice('Results are out. Players now see the final standings.');
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setIsPublishing(false);
    }
  };

  const withSubmissions = useMemo(() => sheet?.challenges.filter((entry) => entry.submissions.length > 0) ?? [], [sheet]);
  const todo = withSubmissions.filter((entry) => !isChallengeJudged(entry));
  const done = withSubmissions.filter(isChallengeJudged);
  const shownTodo = withSubmissions.filter((entry) => !isChallengeJudged(entry) || keepVisible.has(entry.challenge.id));
  const shownDone = withSubmissions.filter((entry) => isChallengeJudged(entry) || keepVisible.has(entry.challenge.id));
  const waiting = sheet?.challenges.filter((entry) => entry.submissions.length === 0) ?? [];
  const shown = section === 'todo' ? shownTodo : shownDone;
  const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const canPublish = game?.status === 'completed';

  return (
    <main className="min-h-screen bg-[#ece6d6] pb-28 text-[#24343a]">
      <header className="sticky top-0 z-20 border-b border-[#c9ae6d]/40 bg-[#f3ecd8]/95 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] backdrop-blur lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#5b4a86]">★ Judging</p>
            <select
              aria-label="Game"
              className="mt-1 max-w-full rounded-xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2 font-[Georgia,Times_New_Roman,serif] text-lg font-semibold text-[#24343a]"
              onChange={(event) => setGameId(event.target.value)}
              value={gameId ?? ''}
            >
              {games.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.status}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            {gameId ? <a className="rounded-full border border-[#c8b48a]/55 bg-[#fff8eb] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em]" href={'/admin?gameId=' + gameId}>Admin</a> : null}
          </div>
        </div>
        {sheet ? (
          <div className="mx-auto mt-3 flex max-w-5xl gap-2">
            <SectionTab active={section === 'todo'} count={todo.length} label="To judge" onClick={() => switchSection('todo')} />
            <SectionTab active={section === 'done'} count={done.length} label="Judged" onClick={() => switchSection('done')} />
          </div>
        ) : null}
      </header>

      <div className="mx-auto max-w-5xl space-y-4 px-4 pt-4 lg:px-8">
        {error ? <Banner tone="error">{error}</Banner> : null}
        {notice ? <Banner tone="success">{notice}</Banner> : null}
        {!sheet && !error ? <Banner tone="info">Loading…</Banner> : null}
        {sheet && sheet.challenges.length === 0 ? <Banner tone="info">This game has no judged challenges.</Banner> : null}
        {sheet && sheet.challenges.length > 0 && shown.length === 0 ? (
          <Banner tone="info">{section === 'todo' ? (done.length ? 'Everything submitted so far is judged.' : 'No team has completed a judged challenge yet.') : 'Nothing judged yet.'}</Banner>
        ) : null}

        {shown.map((entry) => (
          <ChallengeCard
            key={entry.challenge.id}
            entry={entry}
            onDecide={(submission, decision) => decide(entry.challenge.id, submission, decision)}
            savingClaimIds={savingClaimIds}
            teamById={teamById}
            teams={teams}
          />
        ))}

        {section === 'todo' && waiting.length ? (
          <section className="rounded-[1.4rem] border border-dashed border-[#bda370]/60 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#7a6a48]">No submissions yet</p>
            <p className="mt-1 text-sm text-[#5a6a70]">{waiting.map((entry) => entry.challenge.title).join(' · ')}</p>
          </section>
        ) : null}
      </div>

      {sheet && sheet.challenges.length ? (
        <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-[#c9ae6d]/40 bg-[#f3ecd8]/95 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] pt-3 backdrop-blur lg:px-8">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <p className="text-xs leading-5 text-[#5a6a70]">
              {sheet.publishedAt ? 'Results shown ' + formatTime(sheet.publishedAt) + '. Changes need republishing.' : canPublish ? 'Players are waiting for the results. Show them once judging is done.' : 'Judge any time. Results can be shown once the game ends.'}
            </p>
            <button
              className="shrink-0 rounded-full bg-[#3f3360] px-5 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-white disabled:bg-[#b5aec4]"
              disabled={!canPublish || isPublishing}
              onClick={() => { void publish(); }}
              type="button"
            >
              {isPublishing ? 'Publishing…' : sheet.publishedAt ? 'Republish' : 'Show results'}
            </button>
          </div>
        </footer>
      ) : null}
    </main>
  );
}

interface ChallengeCardProps {
  entry: JudgingChallenge;
  teams: Team[];
  teamById: Map<string, Team>;
  savingClaimIds: Set<string>;
  onDecide(submission: JudgingSubmission, decision: JudgingDecision | null): void;
}

function ChallengeCard({ entry, teams, teamById, savingClaimIds, onDecide }: ChallengeCardProps) {
  const { challenge, judgingType, basePoints, bonuses, submissions } = entry;
  const missing = teams.filter((team) => !submissions.some((submission) => submission.teamId === team.id));
  const description = typeof challenge.config?.short_description === 'string' ? challenge.config.short_description : challenge.description;
  return (
    <article className="overflow-hidden rounded-[1.6rem] border border-[#c9ae6d]/50 bg-[#fbf6ea] shadow-[0_14px_40px_rgba(46,58,62,0.10)]">
      <div className="border-b border-[#e3d6b6] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[#3f3360] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white">{JUDGING_TYPE_LABELS[judgingType]}</span>
          {judgingType !== 'points' ? <span className="rounded-full bg-[#24343a] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#f4ead7]">{basePoints} {basePoints === 1 ? 'pt' : 'pts'}{judgingType === 'best_wins' ? ' to the best' : ''}</span> : null}
          {entry.maxPoints && judgingType === 'points' ? <span className="rounded-full bg-[#24343a] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#f4ead7]">Up to {entry.maxPoints} pts</span> : null}
          {isChallengeJudged(entry) ? <span className="ml-auto rounded-full bg-[#e1ebdd] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#2e6f57]">✓ Judged</span> : null}
        </div>
        <h2 className="mt-2 font-[Georgia,Times_New_Roman,serif] text-xl font-semibold leading-tight">{challenge.title}</h2>
        <p className="mt-1 text-sm leading-6 text-[#55656c]">{description}</p>
        {bonuses.length ? (
          <p className="mt-2 flex flex-wrap gap-1.5 text-xs text-[#7a5413]">
            {bonuses.map((bonus) => <span key={bonus.id} className="rounded-full bg-[#fbecc8] px-2 py-0.5">{bonus.label} +{bonus.points}</span>)}
          </p>
        ) : null}
      </div>

      {judgingType === 'best_wins' ? (
        <BestWins entry={entry} onDecide={onDecide} savingClaimIds={savingClaimIds} teamById={teamById} />
      ) : (
        <div className="divide-y divide-[#e8dcc0]">
          {submissions.map((submission) => (
            <SubmissionRow key={submission.claimId} saving={savingClaimIds.has(submission.claimId)} submission={submission} team={teamById.get(submission.teamId)}>
              {judgingType === 'pass_fail'
                ? <PassFail basePoints={basePoints} bonuses={bonuses} onDecide={(decision) => onDecide(submission, decision)} submission={submission} />
                : <PointsInput maxPoints={entry.maxPoints} onDecide={(decision) => onDecide(submission, decision)} submission={submission} />}
            </SubmissionRow>
          ))}
        </div>
      )}

      {missing.length ? <p className="border-t border-[#e8dcc0] px-4 py-2.5 text-xs text-[#6b777b] sm:px-5">Didn't do it: {missing.map((team) => team.name).join(', ')}</p> : null}
    </article>
  );
}

function SubmissionRow({ submission, team, saving, children }: { submission: JudgingSubmission; team: Team | undefined; saving: boolean; children: ReactNode }) {
  return (
    <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        <TeamName team={team} />
        <p className="mt-0.5 text-xs text-[#6b777b]">{formatTime(submission.submittedAt)}{saving ? ' · saving…' : ''}</p>
        {submission.note ? <p className="mt-1.5 whitespace-pre-wrap rounded-xl bg-white/70 px-3 py-2 text-sm text-[#3f4d52]">“{submission.note}”</p> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function PassFail({ submission, basePoints, bonuses, onDecide }: { submission: JudgingSubmission; basePoints: number; bonuses: JudgingChallenge['bonuses']; onDecide(decision: JudgingDecision | null): void }) {
  const verdict = submission.decision?.verdict ?? null;
  const claimedIds = submission.bonuses.map((bonus) => bonus.id);
  // A "yes" approves the bonuses the team claimed; the judge can untick any.
  const approved = new Set(verdict === 'pass' ? submission.decision?.bonusIds ?? [] : claimedIds);
  const total = basePoints + bonuses.filter((bonus) => approved.has(bonus.id)).reduce((sum, bonus) => sum + bonus.points, 0);
  const choice = 'flex-1 rounded-2xl border px-4 py-3 text-sm font-semibold uppercase tracking-[0.12em] transition sm:flex-none sm:min-w-[6.5rem]';
  return (
    <div className="space-y-2 sm:min-w-[16rem]">
      <div className="flex gap-2">
        <button className={[choice, verdict === 'pass' ? 'border-[#2e6f57] bg-[#2e6f57] text-white' : 'border-[#9fc1b2] bg-white text-[#2e6f57]'].join(' ')} onClick={() => onDecide(verdict === 'pass' ? null : { verdict: 'pass', bonusIds: claimedIds })} type="button">✓ Yes</button>
        <button className={[choice, verdict === 'fail' ? 'border-[#9f3f31] bg-[#9f3f31] text-white' : 'border-[#d8aaa1] bg-white text-[#9f3f31]'].join(' ')} onClick={() => onDecide(verdict === 'fail' ? null : { verdict: 'fail' })} type="button">✗ No</button>
      </div>
      {submission.bonuses.length ? (
        <div className="flex flex-wrap gap-1.5">
          {submission.bonuses.map((bonus) => {
            const on = approved.has(bonus.id);
            return (
              <button
                key={bonus.id}
                className={['rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50', on ? 'border-[#c9973a] bg-[#fbecc8] text-[#7a5413]' : 'border-[#d6cdb8] bg-white text-[#8a8f8c] line-through'].join(' ')}
                disabled={verdict !== 'pass'}
                onClick={() => onDecide({ verdict: 'pass', bonusIds: on ? [...approved].filter((id) => id !== bonus.id) : [...approved, bonus.id] })}
                title={verdict === 'pass' ? (on ? 'Tap to reject this bonus' : 'Tap to approve this bonus') : 'Mark Yes first'}
                type="button"
              >
                {on ? '✓ ' : ''}{bonus.label} +{bonus.points}
              </button>
            );
          })}
        </div>
      ) : null}
      <p className="text-right text-xs font-semibold text-[#55656c]">{verdict === 'pass' ? '+' + total + ' pts' : verdict === 'fail' ? '0 pts' : 'Not judged'}</p>
    </div>
  );
}

function PointsInput({ submission, maxPoints, onDecide }: { submission: JudgingSubmission; maxPoints: number | null; onDecide(decision: JudgingDecision | null): void }) {
  const [value, setValue] = useState(submission.points === null ? '' : String(submission.points));
  useEffect(() => { setValue(submission.points === null ? '' : String(submission.points)); }, [submission.points]);
  const commit = () => {
    const trimmed = value.trim();
    const next = trimmed === '' ? null : Math.round(Number(trimmed));
    if (next !== null && !Number.isFinite(next)) return;
    if (next === submission.points) return;
    onDecide(next === null ? null : { verdict: 'points', points: next });
  };
  return (
    <label className="flex items-center gap-2">
      <input
        className="w-24 rounded-xl border border-[#c8b48a]/70 bg-white px-3 py-2.5 text-right text-base font-semibold outline-none focus:border-[#3f3360]"
        inputMode="numeric"
        max={maxPoints ?? undefined}
        min={0}
        onBlur={commit}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
        placeholder="pts"
        type="number"
        value={value}
      />
      <span className="text-xs text-[#6b777b]">pts</span>
    </label>
  );
}

function BestWins({ entry, teamById, savingClaimIds, onDecide }: { entry: JudgingChallenge; teamById: Map<string, Team>; savingClaimIds: Set<string>; onDecide(submission: JudgingSubmission, decision: JudgingDecision | null): void }) {
  const winners = entry.submissions.filter((submission) => submission.decision?.verdict === 'winner');
  return (
    <div className="px-4 py-4 sm:px-5">
      <p className="mb-3 text-xs text-[#6b777b]">{winners.length ? (winners.length > 1 ? 'Tied winners each get ' + entry.basePoints + ' pts.' : 'Tap another team to add a tie, or tap the winner to undo.') : 'Tap the team that did it best.'}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {entry.submissions.map((submission) => {
          const isWinner = submission.decision?.verdict === 'winner';
          const team = teamById.get(submission.teamId);
          return (
            <button
              key={submission.claimId}
              className={['rounded-[1.2rem] border-2 px-4 py-3 text-left transition', isWinner ? 'border-[#c9973a] bg-[#fbecc8] shadow-[0_8px_24px_rgba(201,151,58,0.25)]' : 'border-[#e3d6b6] bg-white hover:border-[#c8b48a]'].join(' ')}
              disabled={savingClaimIds.has(submission.claimId)}
              onClick={() => onDecide(submission, isWinner ? null : { verdict: 'winner' })}
              type="button"
            >
              <div className="flex items-center justify-between gap-2">
                <TeamName team={team} />
                <span className={['text-sm font-bold', isWinner ? 'text-[#7a5413]' : 'text-[#b9b2a0]'].join(' ')}>{isWinner ? '👑 +' + entry.basePoints : '—'}</span>
              </div>
              <p className="mt-0.5 text-xs text-[#6b777b]">{formatTime(submission.submittedAt)}</p>
              {submission.note ? <p className="mt-1.5 text-sm text-[#3f4d52]">“{submission.note}”</p> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TeamName({ team }: { team: Team | undefined }) {
  return (
    <p className="flex items-center gap-2 font-semibold text-[#24343a]">
      <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: team?.color ?? '#a28f67' }} />
      <span className="truncate">{team?.name ?? 'Unknown team'}</span>
    </p>
  );
}

function SectionTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick(): void }) {
  return (
    <button className={['rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition', active ? 'border-[#3f3360] bg-[#3f3360] text-white' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#24343a]'].join(' ')} onClick={onClick} type="button">
      {label} <span className={active ? 'text-[#d9d1ee]' : 'text-[#8a7a58]'}>{count}</span>
    </button>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  const className = tone === 'error' ? 'border-[#c07f6d]/45 bg-[#f3ddd7] text-[#7a3427]' : tone === 'success' ? 'border-[#7b9a73]/45 bg-[#e1ebdd] text-[#244028]' : 'border-[#c8b48a]/55 bg-[#fff8eb] text-[#4e5e65]';
  return <div className={'rounded-[1.2rem] border px-4 py-3 text-sm ' + className}>{children}</div>;
}

// Best-team challenges are judged once a winner is picked; the others once every team has a decision.
export function isChallengeJudged(entry: JudgingChallenge): boolean {
  if (!entry.submissions.length) return false;
  if (entry.judgingType === 'best_wins') return entry.submissions.some((submission) => submission.decision?.verdict === 'winner');
  return entry.submissions.every((submission) => submission.decision !== null);
}

function patchSubmission(sheet: GameJudgingSheet, claimId: string, patch: Partial<JudgingSubmission>): GameJudgingSheet {
  return {
    ...sheet,
    challenges: sheet.challenges.map((entry) => ({
      ...entry,
      submissions: entry.submissions.map((submission) => submission.claimId === claimId ? { ...submission, ...patch } : submission),
    })),
  };
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Request failed.';
}
