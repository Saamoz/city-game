import { type GameStateSnapshot } from '@city-game/shared';
import { create } from 'zustand';

interface GameStoreState {
  gameId: string | null;
  snapshot: GameStateSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  errorMessage: string | null;
  setLoading(gameId: string): void;
  initializeSnapshot(gameId: string, snapshot: GameStateSnapshot): void;
  setError(gameId: string, errorMessage: string): void;
  reset(): void;
}

export const useGameStore = create<GameStoreState>((set) => ({
  gameId: null,
  snapshot: null,
  status: 'idle',
  errorMessage: null,
  setLoading: (gameId) =>
    set({
      gameId,
      snapshot: null,
      status: 'loading',
      errorMessage: null,
    }),
  initializeSnapshot: (gameId, snapshot) =>
    set({
      gameId,
      snapshot,
      status: 'ready',
      errorMessage: null,
    }),
  setError: (gameId, errorMessage) =>
    set({
      gameId,
      snapshot: null,
      status: 'error',
      errorMessage,
    }),
  reset: () =>
    set({
      gameId: null,
      snapshot: null,
      status: 'idle',
      errorMessage: null,
    }),
}));
