import { useCallback, useEffect, useState } from 'react';
import type { Game, GameJudgingSheet, Team } from '@city-game/shared';
import { ApiError, getJudgingSheet, publishJudgedScores, setJudgedSubmissionPoints } from '../../lib/api';

interface JudgingPanelProps {
  game: Game;
  teams: Team[];
  onPublished(): void;
}

type SaveState = 'saving' | 'saved' | 'error';

// Judges score each team's submission whenever they like; nothing reaches players until Publish,
// which is only possible after the game has ended. Publishing again applies corrections.
export function JudgingPanel({ game, teams, onPublished }: JudgingPanelProps) {
  const [sheet, setSheet] = useState<GameJudgingSheet | null>(null);
  const [draftPoints, setDraftPoints] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getJudgingSheet(game.id);
      setSheet(next);
      setDraftPoints(Object.fromEntries(next.challenges.flatMap((entry) => entry.submissions.map((submission) => [submission.claimId, submission.points === null ? '' : String(submission.points)]))));
    } catch (error) {
      setMessage({ tone: 'error', text: getErrorMessage(error) });
    }
  }, [game.id]);

  // Reload when the game changes state so new submissions show up.
  useEffect(() => { void load(); }, [load, game.stateVersion]);

  if (!sheet || sheet.challenges.length === 0) return null;

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const allSubmissions = sheet.challenges.flatMap((entry) => entry.submissions);
  const unscoredCount = allSubmissions.filter((submission) => (draftPoints[submission.claimId] ?? '') === '').length;
  const canPublish = game.status === 'completed';

  const savePoints = async (claimId: string, original: number | null) => {
    const raw = (draftPoints[claimId] ?? '').trim();
    const points = raw === '' ? null : Math.round(Number(raw));
    if (raw !== '' && !Number.isFinite(points)) return;
    if (points === original) return;
    setSaveState((current) => ({ ...current, [claimId]: 'saving' }));
    try {
      await setJudgedSubmissionPoints(claimId, points);
      setSaveState((current) => ({ ...current, [claimId]: 'saved' }));
      setSheet((current) => current && ({
        ...current,
        challenges: current.challenges.map((entry) => ({ ...entry, submissions: entry.submissions.map((submission) => submission.claimId === claimId ? { ...submission, points } : submission) })),
      }));
    } catch (error) {
      setSaveState((current) => ({ ...current, [claimId]: 'error' }));
      setMessage({ tone: 'error', text: getErrorMessage(error) });
    }
  };

  const publish = async () => {
    if (unscoredCount > 0 && !window.confirm(unscoredCount + (unscoredCount === 1 ? ' submission has' : ' submissions have') + ' no score and will count as 0. Publish anyway?')) return;
    setIsPublishing(true);
    try {
      await publishJudgedScores(game.id);
      await load();
      setMessage({ tone: 'success', text: 'Judged scores published. Players now see the final standings.' });
      onPublished();
    } catch (error) {
      setMessage({ tone: 'error', text: getErrorMessage(error) });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <section className="rounded-[1.75rem] border border-[#cbc3dc] bg-white p-5 shadow-[0_20px_50px_rgba(21,31,37,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#182126]">★ Judging</h2>
          <p className="mt-1 max-w-2xl text-sm text-[#5d6a72]">
            Score each team's submission any time; scores stay hidden until you publish. Publishing unlocks when the game ends, and you can correct a score and publish again.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#5b4a86]">
            {sheet.publishedAt ? 'Published ' + new Date(sheet.publishedAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : 'Not published'}
          </p>
          <p className="mt-1 text-xs text-[#64727a]">{allSubmissions.length - unscoredCount} of {allSubmissions.length} submissions scored</p>
        </div>
      </div>

      {message ? <p className={['mt-3 rounded-xl px-3 py-2 text-sm', message.tone === 'error' ? 'bg-[#f3ddd7] text-[#7a3427]' : 'bg-[#e1ebdd] text-[#244028]'].join(' ')}>{message.text}</p> : null}

      <div className="mt-4 space-y-4">
        {sheet.challenges.map(({ challenge, maxPoints, submissions }) => {
          const missingTeams = teams.filter((team) => !submissions.some((submission) => submission.teamId === team.id));
          return (
            <article key={challenge.id} className="rounded-2xl border border-[#dbe2e7] bg-[#fbfcfc] p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold text-[#182126]">{challenge.title}</h3>
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#5b4a86]">{maxPoints ? 'Up to ' + maxPoints + ' pts' : 'No max set'}</span>
              </div>
              <div className="mt-3 space-y-2">
                {submissions.map((submission) => {
                  const team = teamById.get(submission.teamId);
                  const state = saveState[submission.claimId];
                  return (
                    <div key={submission.claimId} className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-3 rounded-xl border border-[#e3e8eb] bg-white px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-semibold text-[#182126]">
                          <span className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: team?.color ?? '#a28f67' }} />
                          {team?.name ?? 'Unknown team'}
                          <span className="text-xs font-normal text-[#64727a]">{new Date(submission.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-[#44535a]">{submission.note ?? <span className="italic text-[#8a979d]">No note</span>}</p>
                        {submission.bonuses.length ? (
                          <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                            <span className="font-semibold uppercase tracking-[0.12em] text-[#7a5413]">Bonuses claimed:</span>
                            {submission.bonuses.map((bonus) => <span key={bonus.id} className="rounded-full bg-[#fbecc8] px-2 py-0.5 text-[#7a5413]">{bonus.label} (+{bonus.points})</span>)}
                          </p>
                        ) : null}
                      </div>
                      <label className="block">
                        <input
                          aria-label={'Points for ' + (team?.name ?? 'team')}
                          className="w-full rounded-xl border border-[#cfd9de] px-3 py-2 text-right text-sm font-semibold text-[#182126] outline-none focus:border-[#8094a1] focus:ring-2 focus:ring-[#c9d5dc]"
                          inputMode="numeric"
                          max={maxPoints ?? undefined}
                          min={0}
                          onBlur={() => { void savePoints(submission.claimId, submission.points); }}
                          onChange={(event) => setDraftPoints((current) => ({ ...current, [submission.claimId]: event.target.value }))}
                          placeholder="pts"
                          type="number"
                          value={draftPoints[submission.claimId] ?? ''}
                        />
                        <span className={['mt-1 block text-right text-[10px] uppercase tracking-[0.12em]', state === 'error' ? 'text-[#9f3f31]' : 'text-[#7a8a91]'].join(' ')}>
                          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'error' ? 'Not saved' : ' '}
                        </span>
                      </label>
                    </div>
                  );
                })}
                {submissions.length === 0 ? <p className="text-sm text-[#64727a]">No submissions yet.</p> : null}
                {missingTeams.length && submissions.length ? <p className="text-xs text-[#64727a]">Not submitted: {missingTeams.map((team) => team.name).join(', ')}</p> : null}
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {!canPublish ? <p className="text-xs text-[#64727a]">Publishing unlocks when the game ends.</p> : null}
        <button
          className="rounded-full border border-[#3f3360] bg-[#3f3360] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:border-[#b5c0c6] disabled:bg-[#b5c0c6]"
          disabled={!canPublish || isPublishing}
          onClick={() => { void publish(); }}
          type="button"
        >
          {isPublishing ? 'Publishing…' : sheet.publishedAt ? 'Republish Scores' : 'Publish Scores'}
        </button>
      </div>
    </section>
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Request failed.';
}
