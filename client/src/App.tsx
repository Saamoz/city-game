import { sharedConstants } from '@city-game/shared';

export function App() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-3xl rounded-3xl border border-white/10 bg-white/5 p-10 shadow-2xl backdrop-blur">
        <p className="text-sm uppercase tracking-[0.4em] text-signal">
          Phase 1 Scaffold
        </p>
        <h1 className="mt-4 text-5xl font-semibold text-white">Territory</h1>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-200">
          Location-based multiplayer game platform scaffolded with React, Vite,
          Tailwind, Fastify, and shared TypeScript packages.
        </p>
        <p className="mt-6 text-sm text-slate-300">
          Shared constant loaded from workspace package:{' '}
          <span className="font-mono text-mist">
            {sharedConstants.platformName}
          </span>
        </p>
      </section>
    </main>
  );
}
