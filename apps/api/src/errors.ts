import { httpStatusFor, type ErrorCode, type ErrorDetail } from '@bizmgmt/contracts';

/**
 * An error whose code and message are safe to show to the client.
 * Anything that is not an AppError is reported as INTERNAL.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;
  /** Sent as Retry-After with RATE_LIMITED responses. */
  retryAfterSeconds?: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.status = httpStatusFor(code);
  }
}

export const notFound = (message = 'Resource not found') => new AppError('NOT_FOUND', message);
