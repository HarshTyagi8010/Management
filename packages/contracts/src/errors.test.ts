import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, httpStatusFor } from './errors.js';

describe('error envelope', () => {
  it('accepts a well-formed envelope', () => {
    const parsed = errorEnvelopeSchema.safeParse({
      error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', requestId: 'abc12345' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown codes and extra properties', () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'OOPS', message: 'x', requestId: 'r' } }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({
        error: { code: 'INTERNAL', message: 'x', requestId: 'r', stack: 'at …' },
      }).success,
    ).toBe(false);
  });

  it('maps codes to HTTP statuses', () => {
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('IDEMPOTENCY_KEY_REUSED')).toBe(422);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });
});
