import { Suspense, lazy, useEffect, useState } from 'react';
import { JoinFlow } from './features/join/JoinFlow';
import { registerPushServiceWorker } from './lib/push-notifications';
import { navigateToGame, navigateToLanding, parseRoute, shouldSuppressAutoEnter } from './lib/routing';

const GameView = lazy(async () => {
  const module = await import('./features/game/GameView');
  return { default: module.GameView };
});

const AdminZoneEditor = lazy(async () => {
  const module = await import('./features/admin-zones/AdminZoneEditor');
  return { default: module.AdminZoneEditor };
});

const AdminChallenges = lazy(async () => {
  const module = await import('./features/admin-challenges/AdminChallenges');
  return { default: module.AdminChallenges };
});

const AdminPanel = lazy(async () => {
  const module = await import('./features/admin/AdminPanel');
  return { default: module.AdminPanel };
});

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [suppressAutoEnter, setSuppressAutoEnter] = useState(() => shouldSuppressAutoEnter());

  useEffect(() => {
    void registerPushServiceWorker();
  }, []);

  useEffect(() => {
    const handleLocationChange = () => {
      const nextRoute = parseRoute(window.location.pathname);
      setRoute(nextRoute);
      setSuppressAutoEnter(shouldSuppressAutoEnter());
      setActiveGameId((currentGameId) =>
        nextRoute.kind === 'game' && currentGameId === nextRoute.gameId ? currentGameId : null,
      );
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  const handleEnterGame = (gameId: string) => {
    setSuppressAutoEnter(false);
    setActiveGameId(gameId);

    if (route.kind !== 'game' || route.gameId !== gameId) {
      navigateToGame(gameId);
      return;
    }

    setRoute({ kind: 'game', gameId, mapId: null, challengeSetId: null });
  };

  const handleLeaveMap = () => {
    const currentGameId = route.kind === 'game' ? route.gameId : activeGameId;
    setSuppressAutoEnter(true);
    setActiveGameId(null);
    setRoute({ kind: 'landing', gameId: currentGameId, mapId: null, challengeSetId: null });
    navigateToLanding({ suppressAutoEnter: true, gameId: currentGameId });
  };

  if (route.kind === 'admin-zones') {
    return (
      <Suspense fallback={<MapViewLoading />}>
        <AdminZoneEditor initialMapId={route.mapId} />
      </Suspense>
    );
  }

  if (route.kind === 'admin-challenges') {
    return (
      <Suspense fallback={<MapViewLoading />}>
        <AdminChallenges initialChallengeSetId={route.challengeSetId} />
      </Suspense>
    );
  }

  if (route.kind === 'admin') {
    return (
      <Suspense fallback={<MapViewLoading />}>
        <AdminPanel initialGameId={route.gameId} />
      </Suspense>
    );
  }

  if (route.kind === 'game' && route.gameId && activeGameId === route.gameId) {
    return (
      <Suspense fallback={<MapViewLoading />}>
        <GameView gameId={route.gameId} onLeaveMap={handleLeaveMap} />
      </Suspense>
    );
  }

  return (
    <JoinFlow
      initialGameId={route.gameId}
      onEnterGame={handleEnterGame}
      suppressAutoEnter={suppressAutoEnter}
    />
  );
}

function MapViewLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#20333a] px-6 text-[#f4ead7]">
      <div className="rounded-[1.75rem] border border-[#d1b26f]/45 bg-[#24343a]/90 px-6 py-5 text-center shadow-[0_24px_60px_rgba(20,26,29,0.3)] backdrop-blur">
        <p className="text-xs uppercase tracking-[0.35em] text-[#d7b35f]">Loading Map</p>
        <p className="mt-3 text-sm text-[#f4ead7]/86">Preparing the expedition view.</p>
      </div>
    </main>
  );
}
