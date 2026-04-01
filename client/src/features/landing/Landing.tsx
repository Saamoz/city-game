import { useEffect, useState } from 'react';
import type { Game, Player } from '@city-game/shared';
import { ApiError, getActiveGame, getCurrentPlayer, getGame, joinTeam, registerPlayer } from '../../lib/api';

interface LandingProps {
  initialGameId: string | null;
  onEnterGame(gameId: string): void;
  suppressAutoEnter: boolean;
}

export function Landing({ initialGameId, onEnterGame, suppressAutoEnter }: LandingProps) {
  const [game, setGame] = useState<Game | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [registrationName, setRegistrationName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [submitting, setSubmitting] = useState<'register' | 'join' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setStatus('loading');
      setMessage(null);

      try {
        const resolvedGame = initialGameId
          ? await getGame(initialGameId, controller.signal)
          : await getActiveGame(controller.signal);

        if (cancelled) {
          return;
        }

        setGame(resolvedGame);

        try {
          const currentPlayer = await getCurrentPlayer(controller.signal);

          if (cancelled) {
            return;
          }

          if (currentPlayer.gameId === resolvedGame.id) {
            setPlayer(currentPlayer);

            if (currentPlayer.teamId && !suppressAutoEnter) {
              onEnterGame(resolvedGame.id);
              return;
            }

            if (currentPlayer.teamId && suppressAutoEnter) {
              setMessage('This session is already on a team. Use Return to Map when you want to re-enter the live view.');
            }
          } else {
            setPlayer(null);
            setMessage('Current session belongs to a different game. Open a new private window to join this one.');
          }
        } catch (error) {
          if (!isApiError(error) || error.statusCode !== 401) {
            throw error;
          }

          if (!cancelled) {
            setPlayer(null);
          }
        }

        if (!cancelled) {
          setStatus('ready');
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (isApiError(error) && error.statusCode === 404) {
          setStatus('empty');
          setGame(null);
          setPlayer(null);
          setMessage('No active game is running right now.');
          return;
        }

        setStatus('error');
        setMessage(getErrorMessage(error, 'Failed to load the active game.'));
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialGameId, onEnterGame, suppressAutoEnter]);

  async function handleRegister(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!game || !registrationName.trim()) {
      return;
    }

    setSubmitting('register');
    setMessage(null);

    try {
      const nextPlayer = await registerPlayer(game.id, registrationName.trim());
      setPlayer(nextPlayer);
      setRegistrationName('');
      setMessage('Player registered. Join a team to enter the map.');
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to register right now.'));
    } finally {
      setSubmitting(null);
    }
  }

  async function handleJoin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!game || !player || !joinCode.trim()) {
      return;
    }

    setSubmitting('join');
    setMessage(null);

    try {
      const result = await joinTeam(game.id, joinCode.trim().toUpperCase());
      setPlayer(result.player);
      setJoinCode('');
      onEnterGame(game.id);
    } catch (error) {
      setMessage(getErrorMessage(error, 'Unable to join that team.'));
    } finally {
      setSubmitting(null);
    }
  }

  const hasJoinedTeam = Boolean(player?.teamId);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#d9e2e1] px-5 py-6 text-[#1f2a2f] sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(247,237,215,0.9),transparent_30%),radial-gradient(circle_at_90%_15%,rgba(165,187,191,0.32),transparent_24%),linear-gradient(180deg,#dbe3e2_0%,#cdd7d6_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 border-b border-[#c8b48a]/35 bg-[linear-gradient(180deg,rgba(243,236,220,0.96),rgba(243,236,220,0.4),transparent)]" />

      <section className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="flex flex-col justify-between rounded-[2rem] border border-[#c8b48a]/55 bg-[#f3ecd8]/92 p-6 shadow-[0_30px_80px_rgba(45,58,62,0.16)] backdrop-blur sm:p-8 lg:p-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.45em] text-[#9b741f]">Territory Field Guide</p>
            <h1 className="mt-5 max-w-3xl font-[Georgia,Times_New_Roman,serif] text-4xl font-semibold leading-tight text-[#1f2a2f] sm:text-5xl lg:text-6xl">
              Active operations, team entry, and city control.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#415057] sm:text-lg">
              The app discovers the live match, issues the browser session, and moves a player from briefing into the shared field map. The UI should feel like a field manual, not a landing page.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <InfoTile label="Match" value={game?.name ?? (status === 'loading' ? 'Checking active game' : 'No active game')} />
            <InfoTile label="City" value={game?.city ?? 'Unspecified'} />
            <InfoTile label="Status" value={game?.status ?? (status === 'empty' ? 'Idle' : 'Pending')} />
          </div>
        </div>

        <div className="rounded-[2rem] border border-[#c8b48a]/55 bg-[#24343a]/94 p-6 text-[#f4ead7] shadow-[0_30px_80px_rgba(45,58,62,0.24)] backdrop-blur sm:p-8">
          {status === 'loading' ? (
            <Panel title="Preparing entry" subtitle="Checking the active game, current route, and browser session." />
          ) : null}

          {status === 'empty' ? (
            <Panel title="No active game" subtitle={message ?? 'Start a game from the admin tools, then refresh this page.'} tone="muted" />
          ) : null}

          {status === 'error' ? (
            <Panel title="Unable to load the game" subtitle={message ?? 'The frontend could not reach the backend.'} tone="danger" />
          ) : null}

          {status === 'ready' && game ? (
            <div>
              <div className="rounded-[1.75rem] border border-[#d1b26f]/30 bg-[#31464e]/80 p-5">
                <p className="text-xs uppercase tracking-[0.3em] text-[#d7b35f]">Current Brief</p>
                <h2 className="mt-3 font-[Georgia,Times_New_Roman,serif] text-3xl font-semibold text-[#f4ead7]">
                  {game.name}
                </h2>
                <p className="mt-3 text-sm leading-6 text-[#d9d1c0]">
                  {game.city ? `${game.city} · ` : ''}
                  {initialGameId ? 'Opened from a direct game link.' : 'Discovered automatically from /game/active.'}
                </p>
              </div>

              <div className="mt-6 space-y-4">
                {!player ? (
                  <form className="space-y-4" onSubmit={handleRegister}>
                    <SectionTitle title="Register player" subtitle="Creates the session cookie used by the REST and realtime APIs." />
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-[#f4ead7]">Display name</span>
                      <input
                        className="w-full rounded-2xl border border-[#d1b26f]/25 bg-[#1d2b30] px-4 py-3 text-base text-[#f4ead7] outline-none transition placeholder:text-[#9ca4a4] focus:border-[#d1b26f]/65 focus:bg-[#23353b]"
                        value={registrationName}
                        onChange={(event) => setRegistrationName(event.target.value)}
                        placeholder="Saad"
                        maxLength={100}
                        autoComplete="nickname"
                      />
                    </label>
                    <button
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-[#d7b35f] px-4 py-3 text-sm font-semibold text-[#1f2a2f] transition hover:bg-[#e0bf74] disabled:cursor-not-allowed disabled:bg-[#516066] disabled:text-[#d0d5d5]"
                      disabled={submitting !== null || registrationName.trim().length === 0}
                      type="submit"
                    >
                      {submitting === 'register' ? 'Registering…' : 'Register Player'}
                    </button>
                  </form>
                ) : (
                  <div className="rounded-[1.75rem] border border-[#d1b26f]/25 bg-[#31464e]/70 p-5">
                    <SectionTitle title="Player ready" subtitle="This browser has an active session in the current game." />
                    <p className="mt-3 text-lg font-semibold text-[#f4ead7]">{player.displayName}</p>
                    <p className="mt-2 text-sm text-[#d9d1c0]">
                      {hasJoinedTeam ? 'This session is already assigned to a team.' : 'Join a team to enter the live map.'}
                    </p>
                    {hasJoinedTeam ? (
                      <button
                        className="mt-4 inline-flex items-center justify-center rounded-2xl bg-[#d7b35f] px-4 py-3 text-sm font-semibold text-[#1f2a2f] transition hover:bg-[#e0bf74]"
                        onClick={() => onEnterGame(game.id)}
                        type="button"
                      >
                        Return to Map
                      </button>
                    ) : null}
                  </div>
                )}

                {player && !hasJoinedTeam ? (
                  <form className="space-y-4" onSubmit={handleJoin}>
                    <SectionTitle title="Join team" subtitle="Use a fixed join code from the current game setup." />
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-[#f4ead7]">Join code</span>
                      <input
                        className="w-full rounded-2xl border border-[#d1b26f]/25 bg-[#1d2b30] px-4 py-3 text-base uppercase tracking-[0.25em] text-[#f4ead7] outline-none transition placeholder:text-[#9ca4a4] focus:border-[#d1b26f]/65 focus:bg-[#23353b]"
                        value={joinCode}
                        onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                        placeholder="TEAM1234"
                        maxLength={8}
                        autoComplete="off"
                      />
                    </label>
                    <button
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-[#7ca3b1] px-4 py-3 text-sm font-semibold text-[#162229] transition hover:bg-[#91b6c2] disabled:cursor-not-allowed disabled:bg-[#516066] disabled:text-[#d0d5d5]"
                      disabled={submitting !== null || joinCode.trim().length === 0}
                      type="submit"
                    >
                      {submitting === 'join' ? 'Joining…' : 'Join Team'}
                    </button>
                  </form>
                ) : null}

                {message ? (
                  <div className="rounded-2xl border border-[#d1b26f]/30 bg-[#1d2b30]/78 px-4 py-3 text-sm text-[#f4ead7] shadow-[0_12px_30px_rgba(17,24,28,0.18)]">
                    {message}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.5rem] border border-[#c8b48a]/45 bg-[#fff8eb]/65 p-4">
      <p className="text-xs uppercase tracking-[0.28em] text-[#7a5e2d]">{label}</p>
      <p className="mt-3 text-lg font-medium text-[#1f2a2f]">{value}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  tone = 'default',
}: {
  title: string;
  subtitle: string;
  tone?: 'default' | 'muted' | 'danger';
}) {
  const toneClassName = tone === 'danger'
    ? 'border-[#bb4d4d]/30 bg-[#642f33]/40'
    : tone === 'muted'
      ? 'border-[#9aa6a5]/20 bg-[#374b51]/45'
      : 'border-[#d1b26f]/25 bg-[#31464e]/60';

  return (
    <div className={`rounded-[1.75rem] border p-6 ${toneClassName}`}>
      <h2 className="font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#f4ead7]">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-[#d9d1c0]">{subtitle}</p>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="font-[Georgia,Times_New_Roman,serif] text-xl font-semibold text-[#f4ead7]">{title}</h3>
      <p className="mt-1 text-sm text-[#cbbfa8]">{subtitle}</p>
    </div>
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
