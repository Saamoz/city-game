import { Suspense, lazy, useEffect, useState } from 'react';
import { Landing } from './features/landing/Landing';
import { navigateToGame, parseRoute } from './lib/routing';

const GameView = lazy(async () => {
  const module = await import('./features/game/GameView');
  return { default: module.GameView };
});

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

  useEffect(() => {
    const handleLocationChange = () => {
      const nextRoute = parseRoute(window.location.pathname);
      setRoute(nextRoute);
      setActiveGameId((currentGameId) => (nextRoute.kind === 'game' && currentGameId === nextRoute.gameId ? currentGameId : null));
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => {
      window.removeEventListener('popstate', handleLocationChange);
    };
  }, []);

  const handleEnterGame = (gameId: string) => {
    setActiveGameId(gameId);
    if (route.kind !== 'game' || route.gameId !== gameId) {
      navigateToGame(gameId);
      return;
    }

    setRoute({ kind: 'game', gameId });
  };

  if (route.kind === 'game' && route.gameId && activeGameId === route.gameId) {
    return (
      <Suspense fallback={<MapViewLoading />}>
        <GameView gameId={route.gameId} />
      </Suspense>
    );
  }

  return <Landing initialGameId={route.gameId} onEnterGame={handleEnterGame} />;
}

function MapViewLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <div className="rounded-3xl border border-white/10 bg-white/5 px-6 py-5 text-center shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
        <p className="text-xs uppercase tracking-[0.35em] text-cyan-200/80">Loading Map</p>
        <p className="mt-3 text-sm text-slate-200">Preparing the game view bundle.</p>
      </div>
    </main>
  );
}
