import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { AUDIT_ACTIONS, auditEventSchema, type AuditAction, type AuditEvent } from '@bizmgmt/contracts';
import { Button, Card, DataTable, EmptyState, ErrorState, FormField, PermissionDenied, Select, Skeleton, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { AUDIT_ACTION_LABELS, formatDateTimeIST } from '../../app/permissions';
import { api, ApiError } from '../../lib/api';
import { usePageTitle } from '../usePageTitle';
import { useTenantQueryKey } from '../../lib/queries';

const pageSchema = z.object({ data: z.array(auditEventSchema), page: z.object({ nextCursor: z.string().nullable(), limit: z.number() }) });

const TENANT_ACTIONS = AUDIT_ACTIONS.filter((a) => !a.startsWith('auth.'));

function describeChange(change: AuditEvent['changes'][number]): string {
  const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === undefined ? '' : String(v));
  if (change.field === 'permissions' && (change.from !== undefined || change.to !== undefined)) {
    const added = show(change.to);
    const removed = show(change.from);
    return [added && added !== 'none' ? `added ${added}` : '', removed && removed !== 'none' ? `removed ${removed}` : ''].filter(Boolean).join('; ') || 'permissions';
  }
  if (change.from === undefined && change.to === undefined) return `${change.field} changed`;
  if (change.from === undefined) return `${change.field}: ${show(change.to)}`;
  return `${change.field}: ${show(change.from)} → ${show(change.to)}`;
}

export function AuditPage() {
  usePageTitle('Audit log');
  const { can, tenantContext } = useSession();
  const [action, setAction] = useState<AuditAction | ''>('');
  const key = useTenantQueryKey('audit', action);
  const allowed = can('audit.view');

  const events = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (pageParam) params.set('cursor', pageParam);
      if (action) params.set('action', action);
      return api(`/audit-events?${params.toString()}`, { schema: pageSchema, signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: allowed,
  });

  const columns: Column<AuditEvent>[] = [
    { key: 'at', header: 'When (IST)', render: (e) => <span className="tabular whitespace-nowrap">{formatDateTimeIST(e.at)}</span> },
    { key: 'action', header: 'What', primary: true, render: (e) => <span className="font-medium">{AUDIT_ACTION_LABELS[e.action]}</span> },
    { key: 'actor', header: 'By', render: (e) => e.actor?.name ?? 'System' },
    {
      key: 'details',
      header: 'Details',
      render: (e) => (
        <span className="flex flex-col gap-0.5">
          <span>{e.summary}</span>
          {e.changes.map((c, i) => (
            <span key={i} className="text-xs text-muted">
              {describeChange(c)}
            </span>
          ))}
        </span>
      ),
    },
  ];

  const header = (
    <>
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="mt-1 text-sm text-muted">A permanent record of sensitive changes{tenantContext ? ` in ${tenantContext.tenant.name}` : ''}. Entries can’t be edited or deleted.</p>
    </>
  );

  if (!tenantContext) {
    return (
      <>
        {header}
        <Skeleton className="mt-6 h-64 w-full" />
      </>
    );
  }
  if (!allowed) {
    return (
      <>
        {header}
        <Card className="mt-6">
          <PermissionDenied permission="audit.view" />
        </Card>
      </>
    );
  }

  const rows = events.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      {header}
      <Card className="mt-6">
        <div className="px-5 pt-5 sm:max-w-xs">
          <FormField label="Show">
            {(f) => (
              <Select {...f} value={action} onChange={(e) => setAction(e.target.value as AuditAction | '')}>
                <option value="">All changes</option>
                {TENANT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AUDIT_ACTION_LABELS[a]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        <div className="py-4">
          {events.isPending ? (
            <Skeleton className="mx-5 h-48" />
          ) : events.isError ? (
            <ErrorState message={events.error instanceof ApiError ? events.error.message : undefined} onRetry={() => void events.refetch()} />
          ) : (
            <DataTable caption="Audit events, newest first" hideCaption columns={columns} rows={rows} rowKey={(e) => e.id} empty={<EmptyState title="Nothing recorded yet" />} />
          )}
        </div>
        {events.hasNextPage && (
          <div className="flex justify-center px-5 pb-5">
            <Button variant="secondary" onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage}>
              {events.isFetchingNextPage ? 'Loading…' : 'Show older entries'}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
