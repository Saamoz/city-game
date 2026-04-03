import { useCallback, useRef, useState } from 'react';

export interface PendingActionState {
  key: string;
  startedAt: number;
}

export function useIdempotentAction() {
  const inFlightRef = useRef(new Map<string, Promise<unknown>>());
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);

  const runAction = useCallback(<T,>(key: string, action: (idempotencyKey: string) => Promise<T>): Promise<T> => {
    const existing = inFlightRef.current.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const idempotencyKey = crypto.randomUUID();
    setPendingKeys((current) => (current.includes(key) ? current : [...current, key]));

    const promise = action(idempotencyKey).finally(() => {
      inFlightRef.current.delete(key);
      setPendingKeys((current) => current.filter((entry) => entry !== key));
    });

    inFlightRef.current.set(key, promise);
    return promise;
  }, []);

  const isPending = useCallback((key: string) => pendingKeys.includes(key), [pendingKeys]);

  return {
    runAction,
    isPending,
    pendingKeys,
  };
}
