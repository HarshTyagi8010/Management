import { z } from 'zod';

/**
 * Stable machine-readable error codes. See docs/api/api-conventions.md.
 * Adding a code is non-breaking; renaming or removing one is breaking.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  MALFORMED_JSON: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  MFA_REQUIRED: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  DUPLICATE: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BUSINESS_RULE: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  PERIOD_LOCKED: 422,
  INSUFFICIENT_STOCK: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_READY: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const errorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const errorDetailSchema = z.strictObject({
  path: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.array(errorDetailSchema).optional(),
  }),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}
