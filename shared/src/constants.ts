export const PLATFORM_NAME = 'Territory';
export const API_PREFIX = '/api/v1';
export const SESSION_COOKIE_NAME = 'session_token';
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const STATE_VERSION_HEADER = 'X-State-Version';
export const ADMIN_AUTH_HEADER = 'Authorization';

export const DEFAULT_GPS_BUFFER_METERS = 40;
export const DEFAULT_GPS_MAX_ERROR_METERS = 100;
export const DEFAULT_GPS_MAX_AGE_SECONDS = 30;
export const DEFAULT_GPS_MAX_VELOCITY_KMH = 200;
export const DEFAULT_CLAIM_TIMEOUT_MINUTES = 10;
export const DEFAULT_LOCATION_RETENTION_HOURS = 48;
export const MAX_DELTA_SYNC_GAP = 1000;

export const GAME_MODE_KEYS = ['territory'] as const;
export const GAME_STATUS_VALUES = ['setup', 'active', 'paused', 'completed'] as const;
export const CHALLENGE_KIND_VALUES = ['visit', 'text', 'photo', 'quiz', 'multi_step', 'custom'] as const;
export const CHALLENGE_STATUS_VALUES = ['available', 'claimed', 'completed'] as const;
export const CLAIM_STATUS_VALUES = ['active', 'completed', 'released', 'expired'] as const;
export const ANNOTATION_VISIBILITY_VALUES = ['all', 'team'] as const;
export const PLAYER_LOCATION_SOURCE_VALUES = ['browser'] as const;
