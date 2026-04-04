import type { Player, Team } from '@city-game/shared';

interface TeamPickerProps {
  teams: Team[];
  players: Player[];
  joiningTeamId: string | null;
  onBack(): void;
  onJoin(team: Team): void;
}

export function TeamPicker({ teams, players, joiningTeamId, onBack, onJoin }: TeamPickerProps) {
  const playersByTeamId = new Map<string, Player[]>();

  for (const team of teams) {
    playersByTeamId.set(team.id, []);
  }

  for (const player of players) {
    if (!player.teamId) {
      continue;
    }

    const teamPlayers = playersByTeamId.get(player.teamId) ?? [];
    teamPlayers.push(player);
    playersByTeamId.set(player.teamId, teamPlayers);
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-5 pb-8 pt-6 sm:px-8">
      <div className="flex items-center justify-between gap-4">
        <button
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[#cfbf97] bg-[#fbf6ea] text-lg text-[#23343a] shadow-[0_10px_24px_rgba(35,52,58,0.08)] transition hover:bg-[#fffaf1]"
          onClick={onBack}
          type="button"
        >
          ←
        </button>
        <p className="text-[11px] uppercase tracking-[0.32em] text-[#8b7a57]">Choose Your Team</p>
        <div className="w-11" />
      </div>

      <header className="mt-8 text-center">
        <h1 className="font-[Georgia,Times_New_Roman,serif] text-4xl font-semibold text-[#223238] sm:text-5xl">
          Choose your team
        </h1>
      </header>

      <div className="mt-8 flex-1 space-y-4 overflow-y-auto pb-8">
        {teams.map((team) => {
          const teamPlayers = playersByTeamId.get(team.id) ?? [];
          const visiblePlayers = teamPlayers.slice(0, 5);
          const overflowCount = Math.max(teamPlayers.length - visiblePlayers.length, 0);
          const isJoining = joiningTeamId === team.id;

          return (
            <button
              key={team.id}
              className="group relative block w-full overflow-hidden rounded-[1.6rem] border border-[#d3c4a0] bg-[#f7f0de] text-left shadow-[0_18px_42px_rgba(42,56,60,0.12)] transition duration-150 hover:-translate-y-0.5 hover:shadow-[0_22px_48px_rgba(42,56,60,0.16)] active:scale-[1.02]"
              onClick={() => onJoin(team)}
              type="button"
            >
              <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: team.color }} />
              <div className="flex items-start justify-between gap-4 px-6 py-5 pl-8">
                <div className="min-w-0">
                  <h2 className="truncate font-[Georgia,Times_New_Roman,serif] text-2xl font-semibold text-[#223238]">
                    {team.name}
                  </h2>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {visiblePlayers.length ? (
                      visiblePlayers.map((player) => (
                        <span
                          key={player.id}
                          className="rounded-full border bg-[#fff9ee] px-3 py-1 text-xs text-[#304148]"
                          style={{ borderColor: `${team.color}66` }}
                        >
                          {player.displayName}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm italic text-[#7f7357]">No players yet</span>
                    )}
                    {overflowCount ? (
                      <span className="rounded-full border border-[#d6c8a7] bg-[#efe5cd] px-3 py-1 text-xs text-[#5d5647]">
                        +{overflowCount} more
                      </span>
                    ) : null}
                  </div>
                </div>
                <span className="shrink-0 rounded-full border border-[#d1c09a] bg-[#fff8ea] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[#6b624f]">
                  {teamPlayers.length} {teamPlayers.length === 1 ? 'player' : 'players'}
                </span>
              </div>
              {isJoining ? (
                <div className="border-t border-[#ded0b1] bg-[#f0e3c0] px-6 py-3 pl-8 text-[11px] uppercase tracking-[0.22em] text-[#5d5030]">
                  Joining…
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
