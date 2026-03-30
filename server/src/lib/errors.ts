import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import {
  errorCodes,
  getErrorDefinition,
  type ErrorCode,
  type ErrorResponse,
} from '@city-game/shared';

export interface AppErrorOptions<TDetails = unknown> {
  message?: string;
  details?: TDetails;
  cause?: unknown;
}

export class AppError<TCode extends ErrorCode = ErrorCode, TDetails = unknown> extends Error {
  readonly code: TCode;
  readonly statusCode: number;
  readonly details?: TDetails;

  constructor(code: TCode, options: AppErrorOptions<TDetails> = {}) {
    const definition = getErrorDefinition(code);

    super(options.message ?? definition.defaultMessage, {
      cause: options.cause,
    });

    this.name = 'AppError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.details = options.details;
  }

  toResponse(): ErrorResponse<TCode, TDetails> {
    return buildErrorResponse(this.code, {
      message: this.message,
      details: this.details,
    });
  }
}

export function buildErrorResponse<TCode extends ErrorCode, TDetails = unknown>(
  code: TCode,
  options: {
    message?: string;
    details?: TDetails;
  } = {},
): ErrorResponse<TCode, TDetails> {
  const definition = getErrorDefinition(code);

  return {
    error: {
      code,
      message: options.message ?? definition.defaultMessage,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

export function registerAppErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(error.toResponse());
      return;
    }

    if (isFastifyValidationError(error)) {
      reply.status(getErrorDefinition(errorCodes.validationError).statusCode).send(
        buildErrorResponse(errorCodes.validationError, {
          message: error.message,
          details: {
            context: error.validationContext,
            issues: error.validation.map((issue) => serializeValidationIssue(issue)),
          },
        }),
      );
      return;
    }

    request.log.error({ err: error }, 'request failed');

    reply.status(getErrorDefinition(errorCodes.internalServerError).statusCode).send(
      buildErrorResponse(errorCodes.internalServerError),
    );
  });
}

function isFastifyValidationError(
  error: unknown,
): error is Error & {
  validation: FastifySchemaValidationError[];
  validationContext?: string;
} {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'validation' in error &&
      Array.isArray((error as { validation?: unknown }).validation),
  );
}

function serializeValidationIssue(issue: FastifySchemaValidationError) {
  return {
    instancePath: issue.instancePath,
    schemaPath: issue.schemaPath,
    keyword: issue.keyword,
    message: issue.message,
    params: issue.params,
  };
}
