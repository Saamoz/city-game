export interface ErrorDefinition {
  statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
  defaultMessage: string;
}

export const errorDefinitions = {
  GPS_TOO_OLD: {
    statusCode: 422,
    defaultMessage: 'GPS reading is too old.',
  },
  GPS_ERROR_TOO_HIGH: {
    statusCode: 422,
    defaultMessage: 'GPS accuracy is too low for this action.',
  },
  OUTSIDE_ZONE: {
    statusCode: 422,
    defaultMessage: 'Player is outside the required zone.',
  },
  CHALLENGE_ALREADY_CLAIMED: {
    statusCode: 409,
    defaultMessage: 'Challenge is already claimed by another team.',
  },
  CHALLENGE_NOT_AVAILABLE: {
    statusCode: 409,
    defaultMessage: 'Challenge is not available.',
  },
  CLAIM_EXPIRED: {
    statusCode: 409,
    defaultMessage: 'Claim has expired.',
  },
  CLAIM_NOT_YOURS: {
    statusCode: 403,
    defaultMessage: 'Claim belongs to another team.',
  },
  NO_ACTIVE_CLAIM: {
    statusCode: 404,
    defaultMessage: 'No active claim exists for this challenge.',
  },
  GAME_NOT_ACTIVE: {
    statusCode: 403,
    defaultMessage: 'Game is not active.',
  },
  GAME_NOT_FOUND: {
    statusCode: 404,
    defaultMessage: 'Game not found.',
  },
  NOT_ON_TEAM: {
    statusCode: 403,
    defaultMessage: 'Player must join a team first.',
  },
  TEAM_NOT_FOUND: {
    statusCode: 404,
    defaultMessage: 'Team was not found for this game.',
  },
  ZONE_DISABLED: {
    statusCode: 403,
    defaultMessage: 'Zone is disabled.',
  },
  INSUFFICIENT_RESOURCES: {
    statusCode: 422,
    defaultMessage: 'Insufficient resources.',
  },
  IDEMPOTENCY_CONFLICT: {
    statusCode: 409,
    defaultMessage: 'Idempotency key was reused with a different request.',
  },
  RATE_LIMITED: {
    statusCode: 429,
    defaultMessage: 'Too many requests.',
  },
  UNAUTHORIZED: {
    statusCode: 401,
    defaultMessage: 'Authentication required.',
  },
  ADMIN_REQUIRED: {
    statusCode: 403,
    defaultMessage: 'Admin token required.',
  },
  VALIDATION_ERROR: {
    statusCode: 400,
    defaultMessage: 'Request validation failed.',
  },
  INTERNAL_SERVER_ERROR: {
    statusCode: 500,
    defaultMessage: 'Internal server error.',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof errorDefinitions;

export const errorCodes = {
  gpsTooOld: 'GPS_TOO_OLD',
  gpsErrorTooHigh: 'GPS_ERROR_TOO_HIGH',
  outsideZone: 'OUTSIDE_ZONE',
  challengeAlreadyClaimed: 'CHALLENGE_ALREADY_CLAIMED',
  challengeNotAvailable: 'CHALLENGE_NOT_AVAILABLE',
  claimExpired: 'CLAIM_EXPIRED',
  claimNotYours: 'CLAIM_NOT_YOURS',
  noActiveClaim: 'NO_ACTIVE_CLAIM',
  gameNotActive: 'GAME_NOT_ACTIVE',
  gameNotFound: 'GAME_NOT_FOUND',
  notOnTeam: 'NOT_ON_TEAM',
  teamNotFound: 'TEAM_NOT_FOUND',
  zoneDisabled: 'ZONE_DISABLED',
  insufficientResources: 'INSUFFICIENT_RESOURCES',
  idempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  rateLimited: 'RATE_LIMITED',
  unauthorized: 'UNAUTHORIZED',
  adminRequired: 'ADMIN_REQUIRED',
  validationError: 'VALIDATION_ERROR',
  internalServerError: 'INTERNAL_SERVER_ERROR',
} as const satisfies Record<string, ErrorCode>;

export interface ErrorBody<TCode extends ErrorCode = ErrorCode, TDetails = unknown> {
  code: TCode;
  message: string;
  details?: TDetails;
}

export interface ErrorResponse<TCode extends ErrorCode = ErrorCode, TDetails = unknown> {
  error: ErrorBody<TCode, TDetails>;
}

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return errorDefinitions[code];
}

export function isErrorCode(value: string): value is ErrorCode {
  return value in errorDefinitions;
}
