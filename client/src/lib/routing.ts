export interface ParsedRoute {
  kind: 'landing' | 'game';
  gameId: string | null;
}

const GAME_PATH_PATTERN = /^\/game\/([0-9a-fA-F-]+)$/;
const SUPPRESS_AUTO_ENTER_KEY = 'city-game:suppress-auto-enter';

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

export function shouldSuppressAutoEnter(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.sessionStorage.getItem(SUPPRESS_AUTO_ENTER_KEY) === '1';
}

export function navigateToGame(gameId: string): void {
  setSuppressAutoEnter(false);
  window.history.pushState({}, '', `/game/${gameId}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateToLanding(options: { suppressAutoEnter?: boolean } = {}): void {
  setSuppressAutoEnter(Boolean(options.suppressAutoEnter));
  window.history.pushState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function setSuppressAutoEnter(value: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (value) {
    window.sessionStorage.setItem(SUPPRESS_AUTO_ENTER_KEY, '1');
    return;
  }

  window.sessionStorage.removeItem(SUPPRESS_AUTO_ENTER_KEY);
}
