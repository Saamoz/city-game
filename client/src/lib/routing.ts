export interface ParsedRoute {
  kind: 'landing' | 'game' | 'admin-zones' | 'admin-challenges' | 'admin';
  gameId: string | null;
  mapId: string | null;
  challengeSetId: string | null;
}

const GAME_PATH_PATTERN = /^\/game\/([0-9a-fA-F-]+)$/;
const ADMIN_ZONES_PATH = '/admin/zones';
const ADMIN_CHALLENGES_PATH = '/admin/challenges';
const ADMIN_PATH = '/admin';
const SUPPRESS_AUTO_ENTER_KEY = 'city-game:suppress-auto-enter';

export function parseRoute(pathname: string): ParsedRoute {
  const normalizedPathname = normalizePathname(pathname);
  const match = normalizedPathname.match(GAME_PATH_PATTERN);

  if (match) {
    return {
      kind: 'game',
      gameId: match[1] ?? null,
      mapId: null,
      challengeSetId: null,
    };
  }

  if (normalizedPathname === ADMIN_ZONES_PATH) {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      kind: 'admin-zones',
      gameId: null,
      mapId: searchParams.get('mapId'),
      challengeSetId: null,
    };
  }

  if (normalizedPathname === ADMIN_CHALLENGES_PATH) {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      kind: 'admin-challenges',
      gameId: null,
      mapId: null,
      challengeSetId: searchParams.get('setId'),
    };
  }

  if (normalizedPathname === ADMIN_PATH) {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      kind: 'admin',
      gameId: searchParams.get('gameId'),
      mapId: null,
      challengeSetId: null,
    };
  }

  const searchParams = new URLSearchParams(window.location.search);
  return {
    kind: 'landing',
    gameId: searchParams.get('gameId'),
    mapId: null,
    challengeSetId: null,
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
  window.history.pushState({}, '', '/game/' + gameId);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function navigateToLanding(options: { suppressAutoEnter?: boolean; gameId?: string | null } = {}): void {
  setSuppressAutoEnter(Boolean(options.suppressAutoEnter));
  const searchParams = new URLSearchParams();
  if (options.gameId) {
    searchParams.set('gameId', options.gameId);
  }
  const targetPath = searchParams.size ? '/?' + searchParams.toString() : '/';
  window.history.pushState({}, '', targetPath);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.replace(/\/+$/, '');
  }

  return pathname;
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
