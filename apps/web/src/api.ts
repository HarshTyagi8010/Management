import { healthResponseSchema, type HealthResponse } from '@bizmgmt/contracts';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1';

/** Same-origin fetch with cookies; responses are validated against the shared contract. */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, { credentials: 'same-origin', ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  return healthResponseSchema.parse(await res.json());
}
