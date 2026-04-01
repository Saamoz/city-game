export interface ParsedRoute {
  kind: 'landing' | 'game';
  gameId: string | null;
}

const GAME_PATH_PATTERN = /^\/game\/([0-9a-fA-F-]+)$/;

export function parseRoute(pathname: string): ParsedRoute {
  const match = pathname.match(GAME_PATH_PATTERN);

  if (match) {
    return {
      kind: 'game',
      gameId: match[1] ?? null,
    };
  }

  return {
    kind: 'landing',
    gameId: null,
  };
}

export function navigateToGame(gameId: string): void {
  window.history.pushState({}, '', `/game/${gameId}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateToLanding(): void {
  window.history.pushState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}
