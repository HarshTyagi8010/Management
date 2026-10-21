import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { legalEntitySchema, pageSchemaOf, unitSchema } from './schemas';
import { useSession } from '../auth/session';
import { api, ApiError } from './api';

export const listOf = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

/** Query keys are scoped by tenant so that switching business never shows another business's data. */
export function useTenantQueryKey(...parts: Array<string | number | boolean | null | undefined>) {
  const { tenantId } = useSession();
  return ['tenant', tenantId, ...parts] as const;
}

export const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Field errors from a failed save, keyed by path (e.g. "address.pincode"). */
export const fieldErrorsOf = (err: unknown): Record<string, string> => (err instanceof ApiError ? err.fieldErrors() : {});

export function useLegalEntities() {
  const key = useTenantQueryKey('legal-entities');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/legal-entities', { schema: listOf(legalEntitySchema), signal }).then((r) => r.data) });
}

export function useUnits(enabled = true) {
  const key = useTenantQueryKey('units');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api('/units', { schema: listOf(unitSchema), signal }).then((r) => r.data), enabled });
}

export { pageSchemaOf };
