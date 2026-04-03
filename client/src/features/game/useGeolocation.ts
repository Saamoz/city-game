import { useCallback, useEffect, useRef, useState } from 'react';
import type { GpsPayload } from '@city-game/shared';

export type GeolocationStatus = 'idle' | 'requesting' | 'live' | 'error' | 'unsupported';

interface GeolocationState {
  status: GeolocationStatus;
  gpsPayload: GpsPayload | null;
  errorMessage: string | null;
}

export function useGeolocation() {
  const watchIdRef = useRef<number | null>(null);
  const [state, setState] = useState<GeolocationState>({
    status: typeof navigator === 'undefined' || !('geolocation' in navigator) ? 'unsupported' : 'idle',
    gpsPayload: null,
    errorMessage: null,
  });

  const applySuccess = useCallback((position: GeolocationPosition) => {
    setState({
      status: 'live',
      errorMessage: null,
      gpsPayload: {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        gpsErrorMeters: position.coords.accuracy,
        speedMps: position.coords.speed ?? null,
        headingDegrees: position.coords.heading ?? null,
        capturedAt: new Date(position.timestamp).toISOString(),
      },
    });
  }, []);

  const applyError = useCallback((error: GeolocationPositionError) => {
    setState((current) => ({
      ...current,
      status: 'error',
      errorMessage: error.message || 'Unable to read browser location.',
    }));
  }, []);

  const clearWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const startWatch = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setState((current) => ({
        ...current,
        status: 'unsupported',
        errorMessage: 'Browser geolocation is unavailable.',
      }));
      return;
    }

    clearWatch();
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    watchIdRef.current = navigator.geolocation.watchPosition(
      applySuccess,
      applyError,
      {
        enableHighAccuracy: visible,
        maximumAge: visible ? 5_000 : 30_000,
        timeout: visible ? 12_000 : 20_000,
      },
    );
  }, [applyError, applySuccess, clearWatch]);

  const refresh = useCallback(async (): Promise<GpsPayload> => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      throw new Error('Browser geolocation is unavailable.');
    }

    setState((current) => ({
      ...current,
      status: current.gpsPayload ? current.status : 'requesting',
      errorMessage: null,
    }));

    return new Promise<GpsPayload>((resolve, reject) => {
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const gpsPayload: GpsPayload = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            gpsErrorMeters: position.coords.accuracy,
            speedMps: position.coords.speed ?? null,
            headingDegrees: position.coords.heading ?? null,
            capturedAt: new Date(position.timestamp).toISOString(),
          };
          setState({
            status: 'live',
            gpsPayload,
            errorMessage: null,
          });
          resolve(gpsPayload);
        },
        (error) => {
          applyError(error);
          reject(new Error(error.message || 'Unable to read browser location.'));
        },
        {
          enableHighAccuracy: visible,
          maximumAge: visible ? 5_000 : 30_000,
          timeout: visible ? 12_000 : 20_000,
        },
      );
    });
  }, [applyError]);

  useEffect(() => {
    if (state.status === 'unsupported') {
      return;
    }

    startWatch();
    const handleVisibilityChange = () => startWatch();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearWatch();
    };
  }, [clearWatch, startWatch, state.status]);

  return {
    ...state,
    refresh,
  };
}
