export function getGameRoom(gameId: string): string {
  return `game:${gameId}`;
}

export function getTeamRoom(gameId: string, teamId: string): string {
  return `${getGameRoom(gameId)}:team:${teamId}`;
}
