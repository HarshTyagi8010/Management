import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { ErrorState, Skeleton } from '@bizmgmt/ui';
import { sessionResponseSchema, tenantContextSchema, type Permission, type SessionResponse, type TenantContext } from '@bizmgmt/contracts';
import { applyTheme } from '../app/theme';
import { api, apiState } from '../lib/api';

export const SESSION_KEY = ['session'] as const;

interface SessionValue {
  session: SessionResponse;
  /** Replaces the cached session after a sign-in step (the response carries a new CSRF token). */
  setSession(next: SessionResponse): void;
  refresh(): Promise<void>;
  tenantId: string | null;
  tenantContext: TenantContext | undefined;
  switchTenant(id: string): Promise<void>;
  /** UI convenience only; every action is authorised again on the server (NFR-SEC-02). */
  can(permission: Permission): boolean;
  /** Whether the permission applies to this legal entity (FR-RBAC-03). UI only; the server re-checks. */
  canIn(permission: Permission, legalEntityId: string): boolean;
  /** Whether the permission applies in this warehouse (its entity and the warehouse scope). UI only; the server re-checks. */
  canInWarehouse(permission: Permission, warehouse: { id: string; legalEntityId: string }): boolean;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

const fetchSession = (signal?: AbortSignal) => api('/auth/session', { schema: sessionResponseSchema, signal });

/** Keeps the in-memory CSRF token and tenant id in step with the session. */
function syncRequestState(session: SessionResponse) {
  apiState.setCsrfToken(session.csrfToken);
  if (session.status !== 'authenticated') {
    apiState.setTenantId(null);
    return;
  }
  const current = apiState.tenantId;
  if (!current || !session.tenants.some((t) => t.id === current)) apiState.setTenantId(session.activeTenantId);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: async ({ signal }) => {
      const session = await fetchSession(signal);
      syncRequestState(session);
      return session;
    },
    staleTime: Infinity,
    retry: 1,
  });

  const setSession = useCallback(
    (next: SessionResponse) => {
      syncRequestState(next);
      queryClient.setQueryData(SESSION_KEY, next);
    },
    [queryClient],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
  }, [queryClient]);

  // The server ended the session (expiry, sign-out elsewhere): drop cached data and re-read the session.
  useEffect(
    () =>
      apiState.onUnauthenticated(() => {
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
        void refresh();
      }),
    [queryClient, refresh],
  );

  const session = query.data;
  const authenticated = session?.status === 'authenticated';
  const tenantId = authenticated ? apiState.tenantId : null;

  useEffect(() => {
    applyTheme(session?.status === 'authenticated' ? session.user.preferences.theme : 'system');
  }, [session]);

  const contextQuery = useQuery({
    queryKey: ['tenant', tenantId, 'context'],
    queryFn: ({ signal }) => api('/tenant/context', { schema: tenantContextSchema, signal }),
    enabled: authenticated && !!tenantId,
    staleTime: 60_000,
  });

  const value = useMemo<SessionValue | null>(() => {
    if (!session) return null;
    const permissions = new Set(contextQuery.data?.permissions ?? []);
    return {
      session,
      setSession,
      refresh,
      tenantId,
      tenantContext: contextQuery.data,
      async switchTenant(id: string) {
        await api('/auth/active-tenant', { method: 'PUT', body: { tenantId: id } });
        apiState.setTenantId(id);
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] === 'tenant' });
        await refresh();
      },
      can: (permission) => permissions.has(permission),
      canIn: (permission, legalEntityId) => {
        const scope = contextQuery.data?.entityScopes[permission];
        return scope === 'all' || (Array.isArray(scope) && scope.includes(legalEntityId));
      },
      canInWarehouse: (permission, warehouse) => {
        const entities = contextQuery.data?.entityScopes[permission];
        const warehouses = contextQuery.data?.warehouseScopes[permission];
        const inEntity = entities === 'all' || (Array.isArray(entities) && entities.includes(warehouse.legalEntityId));
        return inEntity && (warehouses === 'all' || (Array.isArray(warehouses) && warehouses.includes(warehouse.id)));
      },
      async signOut() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        apiState.setTenantId(null);
        // Drop every cached business query, but keep the session entry the provider is subscribed to.
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
        setSession(await fetchSession());
      },
    };
  }, [session, setSession, refresh, tenantId, contextQuery.data, queryClient]);

  if (!value) {
    return (
      <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
        {query.isError ? (
          <ErrorState title="Can’t reach BizMgmt" message="We couldn’t check whether you are signed in. Check your connection and try again." onRetry={() => void query.refetch()} />
        ) : (
          <div role="status" aria-label="Loading">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="mt-6 h-48 w-full" />
          </div>
        )}
      </main>
    );
  }
  return <SessionContext value={value}>{children}</SessionContext>;
}
