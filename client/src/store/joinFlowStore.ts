import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type JoinFlowStep = 'home' | 'team_picker' | 'lobby' | 'countdown';

interface JoinFlowSessionState {
  step: JoinFlowStep;
  gameId: string | null;
  playerId: string | null;
  teamId: string | null;
  displayName: string;
  setSession(input: {
    step?: JoinFlowStep;
    gameId?: string | null;
    playerId?: string | null;
    teamId?: string | null;
    displayName?: string;
  }): void;
  reset(): void;
}

const initialState = {
  step: 'home' as JoinFlowStep,
  gameId: null,
  playerId: null,
  teamId: null,
  displayName: '',
};

export const useJoinFlowStore = create<JoinFlowSessionState>()(
  persist(
    (set) => ({
      ...initialState,
      setSession: (input) =>
        set((state) => ({
          step: input.step ?? state.step,
          gameId: input.gameId === undefined ? state.gameId : input.gameId,
          playerId: input.playerId === undefined ? state.playerId : input.playerId,
          teamId: input.teamId === undefined ? state.teamId : input.teamId,
          displayName: input.displayName === undefined ? state.displayName : input.displayName,
        })),
      reset: () => set(initialState),
    }),
    {
      name: 'city-game:join-flow',
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        step: state.step,
        gameId: state.gameId,
        playerId: state.playerId,
        teamId: state.teamId,
        displayName: state.displayName,
      }),
    },
  ),
);
