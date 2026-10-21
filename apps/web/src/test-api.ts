import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type Permission, type SessionResponse } from '@bizmgmt/contracts';
import { vi } from 'vitest';

/** Test doubles for the API. Fixtures are synthetic. */
export const TENANT_ID = 'a'.repeat(24);
export const USER_ID = 'b'.repeat(24);
export const CSRF = 'csrf-token-for-tests';

export const authenticatedSession = (overrides: Partial<Extract<SessionResponse, { status: 'authenticated' }>> = {}): SessionResponse => ({
  status: 'authenticated',
  csrfToken: CSRF,
  user: { id: USER_ID, name: 'Asha Verma', email: 'asha@example.test', mfaEnabled: false, preferences: { theme: 'system' } },
  tenants: [{ id: TENANT_ID, name: 'Example Traders (test)' }],
  activeTenantId: TENANT_ID,
  ...overrides,
});

export const tenantContext = (permissions: readonly Permission[] = PERMISSIONS) => ({
  tenant: { id: TENANT_ID, name: 'Example Traders (test)' },
  roles: [{ id: 'c'.repeat(24), name: 'Owner' }],
  permissions: [...permissions],
  entityScopes: Object.fromEntries(permissions.map((p) => [p, 'all' as const])),
  warehouseScopes: Object.fromEntries(permissions.map((p) => [p, 'all' as const])),
  mfaEnrolmentRequired: false,
});

export const ownerPermissions = SYSTEM_ROLE_PERMISSIONS.owner;

export interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

export const error = (status: number, code: string, message: string, details?: Array<{ path: string; message: string }>) =>
  Response.json({ error: { code, message, requestId: 'req-test-1', ...(details ? { details } : {}) } }, { status });

/**
 * Stubs fetch with handlers keyed by "METHOD /path" (path relative to /api/v1, without the query).
 * Defaults: a signed-in owner and a healthy API. Returns the list of calls for assertions.
 */
export function mockApi(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, Handler> = {
    'GET /auth/session': () => Response.json(authenticatedSession()),
    'GET /tenant/context': () => Response.json(tenantContext()),
    'GET /health': () => Response.json({ status: 'ok', service: 'api', version: '0.1.0', time: new Date().toISOString() }),
  };
  const all = { ...defaults, ...handlers };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const call: Call = { method, path, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handler = all[`${method} ${path}`];
    return handler ? handler(call) : error(404, 'NOT_FOUND', 'Route not found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}
