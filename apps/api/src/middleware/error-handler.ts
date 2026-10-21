import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ErrorEnvelope } from '@bizmgmt/contracts';
import { ZodError } from 'zod';
import { AppError, notFound } from '../errors.js';

interface BodyParserError {
  type?: string;
  status?: number;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const type = (err as BodyParserError | null)?.type;
  if (type === 'entity.parse.failed') return new AppError('MALFORMED_JSON', 'Request body is not valid JSON');
  if (type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding');
  }
  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Route not found'));

/**
 * Maps errors to the public envelope. Unknown errors (including database errors)
 * are logged with full detail and returned as a generic INTERNAL error.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  const requestId = String(req.id ?? '');
  if (!appError) {
    req.log?.error({ err }, 'unhandled error');
  } else if (appError.status >= 500) {
    req.log?.error({ err }, appError.message);
  }
  const safe = appError ?? new AppError('INTERNAL', 'An unexpected error occurred');
  const body: ErrorEnvelope = {
    error: {
      code: safe.code,
      message: safe.message,
      requestId,
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
  if (safe.retryAfterSeconds) res.setHeader('Retry-After', String(safe.retryAfterSeconds));
  res.status(safe.status).json(body);
};
