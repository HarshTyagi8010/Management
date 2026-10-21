import { errorEnvelopeSchema, type ErrorCode, type ErrorDetail } from '@bizmgmt/contracts';
import type { z } from 'zod';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';

/** A failed API call with the server's safe error envelope (never raw server text). */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details: ErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** Field errors keyed by path, for forms. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.details.map((d) => [d.path, d.message]));
  }
}

/**
 * Request state held in memory only — never in localStorage (security.md §4).
 * The CSRF token comes from the session endpoint; the tenant id from the user's choice.
 */
const state: { csrfToken: string | null; tenantId: string | null } = { csrfToken: null, tenantId: null };
const unauthenticatedListeners = new Set<() => void>();

export const apiState = {
  setCsrfToken(token: string | null) {
    state.csrfToken = token;
  },
  setTenantId(id: string | null) {
    state.tenantId = id;
  },
  get tenantId() {
    return state.tenantId;
  },
  /** Called when the server says the session is gone, so the app can return to sign-in. */
  onUnauthenticated(listener: () => void): () => void {
    unauthenticatedListeners.add(listener);
    return () => {
      unauthenticatedListeners.delete(listener);
    };
  },
};

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Validates the response body against the shared contract. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal | undefined;
  /**
   * Sends an Idempotency-Key, required by commands that move stock or money:
   * if the response is lost and the request is retried with the same key, the
   * server replays the first result instead of acting twice.
   */
  idempotencyKey?: string;
}

/** A fresh key for one user action (one click = one key). */
export const newIdempotencyKey = () => crypto.randomUUID();

export async function api<T = void>(path: string, { method = 'GET', body, schema, signal, idempotencyKey }: RequestOptions<T> = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  if (state.tenantId) headers['X-Tenant-Id'] = state.tenantId;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }

  if (!res.ok) {
    const parsed = errorEnvelopeSchema.safeParse(await res.json().catch(() => null));
    const error = parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details, parsed.data.error.requestId)
      : new ApiError(res.status, 'INTERNAL', 'Something went wrong. Please try again.');
    if (error.code === 'UNAUTHENTICATED' && !path.startsWith('/auth/login')) unauthenticatedListeners.forEach((l) => l());
    throw error;
  }
  if (res.status === 204 || !schema) return undefined as T;
  return schema.parse(await res.json());
}

/**
 * Downloads a file the API serves (e.g. a PDF) and saves it under `filename`.
 * Uses fetch rather than a plain link because every request must carry the
 * business id header.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (state.tenantId) headers['X-Tenant-Id'] = state.tenantId;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const parsed = errorEnvelopeSchema.safeParse(await res.json().catch(() => null));
    throw parsed.success ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message) : new ApiError(res.status, 'INTERNAL', 'The file could not be downloaded.');
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
