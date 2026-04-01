import { useEffect, useState } from 'react';
import type { Game, Player } from '@city-game/shared';
import { ApiError, getActiveGame, getCurrentPlayer, getGame, joinTeam, registerPlayer } from '../../lib/api';

interface LandingProps {
  initialGameId: string | null;
  onEnterGame(gameId: string): void;
}

export function Landing({ initialGameId, onEnterGame }: LandingProps) {
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

            if (currentPlayer.teamId) {
              onEnterGame(resolvedGame.id);
              return;
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
  }, [initialGameId, onEnterGame]);

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

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink px-5 py-6 text-slate-50 sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.18),transparent_35%),radial-gradient(circle_at_80%_20%,rgba(56,189,248,0.14),transparent_28%),linear-gradient(180deg,#08111f_0%,#030712_100%)]" />
      <div className="pointer-events-none absolute inset-y-0 right-[-10%] w-[36rem] bg-[linear-gradient(135deg,rgba(248,250,252,0.08),rgba(248,250,252,0.01))] blur-3xl" />

      <section className="relative mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col justify-between rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-[0_32px_80px_rgba(0,0,0,0.35)] backdrop-blur sm:p-8 lg:p-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.45em] text-amber-300/90">
              Territory
            </p>
            <h1 className="mt-5 max-w-3xl font-['Space_Grotesk',system-ui,sans-serif] text-4xl font-semibold leading-tight text-white sm:text-5xl lg:text-6xl">
              Live city control, built around the game already running.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-slate-200 sm:text-lg">
              Discover the active match, register your player, join a team by code, and move straight into the shared map.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <InfoTile label="Discovery" value={game?.name ?? (status === 'loading' ? 'Looking up game' : 'No active game')} />
            <InfoTile label="City" value={game?.city ?? 'Unspecified'} />
            <InfoTile label="Status" value={game?.status ?? (status === 'empty' ? 'Idle' : 'Pending')} />
          </div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-slate-950/80 p-6 shadow-[0_32px_80px_rgba(0,0,0,0.35)] backdrop-blur sm:p-8">
          {status === 'loading' ? (
            <Panel title="Preparing game access" subtitle="Checking the route, active game, and current session." />
          ) : null}

          {status === 'empty' ? (
            <Panel title="No active game" subtitle={message ?? 'Start a game from the admin tools, then refresh this page.'} tone="muted" />
          ) : null}

          {status === 'error' ? (
            <Panel title="Unable to load the game" subtitle={message ?? 'The frontend could not reach the backend.'} tone="danger" />
          ) : null}

          {status === 'ready' && game ? (
            <div>
              <div className="rounded-3xl border border-cyan-300/15 bg-cyan-300/8 p-5">
                <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/85">Current Game</p>
                <h2 className="mt-3 font-['Space_Grotesk',system-ui,sans-serif] text-3xl font-semibold text-white">
                  {game.name}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  {game.city ? `${game.city} · ` : ''}
                  {initialGameId ? 'Opened from a direct game link.' : 'Discovered automatically from /game/active.'}
                </p>
              </div>

              <div className="mt-6 space-y-4">
                {!player ? (
                  <form className="space-y-4" onSubmit={handleRegister}>
                    <SectionTitle title="Register player" subtitle="Creates the session cookie used by the REST and realtime APIs." />
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-slate-200">Display name</span>
                      <input
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-amber-300/60 focus:bg-white/10"
                        value={registrationName}
                        onChange={(event) => setRegistrationName(event.target.value)}
                        placeholder="Saad"
                        maxLength={100}
                        autoComplete="nickname"
                      />
                    </label>
                    <button
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
                      disabled={submitting !== null || registrationName.trim().length === 0}
                      type="submit"
                    >
                      {submitting === 'register' ? 'Registering…' : 'Register Player'}
                    </button>
                  </form>
                ) : (
                  <div className="rounded-3xl border border-emerald-300/20 bg-emerald-300/8 p-5">
                    <SectionTitle title="Player ready" subtitle="Your session cookie is active in this browser." />
                    <p className="mt-3 text-lg font-semibold text-white">{player.displayName}</p>
                    <p className="mt-2 text-sm text-slate-300">
                      {player.teamId ? 'Team already joined. Opening the game view.' : 'Join a team to enter the live map.'}
                    </p>
                  </div>
                )}

                {player ? (
                  <form className="space-y-4" onSubmit={handleJoin}>
                    <SectionTitle title="Join team" subtitle="Uses the join code created in the admin game setup flow." />
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-slate-200">Join code</span>
                      <input
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-base uppercase tracking-[0.25em] text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/60 focus:bg-white/10"
                        value={joinCode}
                        onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                        placeholder="TEAM1234"
                        maxLength={8}
                        autoComplete="off"
                      />
                    </label>
                    <button
                      className="inline-flex w-full items-center justify-center rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
                      disabled={submitting !== null || joinCode.trim().length === 0}
                      type="submit"
                    >
                      {submitting === 'join' ? 'Joining…' : 'Join Team'}
                    </button>
                  </form>
                ) : null}

                {message ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
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
    <div className="rounded-3xl border border-white/10 bg-slate-950/45 p-4">
      <p className="text-xs uppercase tracking-[0.28em] text-slate-400">{label}</p>
      <p className="mt-3 text-lg font-medium text-white">{value}</p>
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
    ? 'border-rose-400/25 bg-rose-400/10'
    : tone === 'muted'
      ? 'border-slate-400/20 bg-slate-400/10'
      : 'border-cyan-300/20 bg-cyan-300/10';

  return (
    <div className={`rounded-3xl border p-6 ${toneClassName}`}>
      <h2 className="font-['Space_Grotesk',system-ui,sans-serif] text-2xl font-semibold text-white">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-slate-300">{subtitle}</p>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="font-['Space_Grotesk',system-ui,sans-serif] text-xl font-semibold text-white">{title}</h3>
      <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
    </div>
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
