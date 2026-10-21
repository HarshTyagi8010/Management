import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { partySchema, stateName, type Party } from '@bizmgmt/contracts';
import { Button, Card, DataTable, EmptyState, ErrorState, FormField, Input, PermissionDenied, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';

export function PartiesPage({ role }: { role: 'customer' | 'supplier' }) {
  const title = role === 'customer' ? 'Customers' : 'Suppliers';
  usePageTitle(title);
  const { can, tenantContext } = useSession();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const allowed = can('party.view') || can('party.view_basic');
  const key = useTenantQueryKey('parties', role, search, archived);
  const parties = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ role, limit: '50', archived: String(archived) });
      if (search) params.set('q', search);
      if (pageParam) params.set('cursor', pageParam);
      return api(`/parties?${params.toString()}`, { schema: pageSchemaOf(partySchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled: allowed,
  });

  const header = (
    <PageHeader
      title={title}
      description={role === 'customer' ? 'People and businesses you sell to.' : 'People and businesses you buy from.'}
      actions={
        can('party.edit') ? (
          <Button asChild>
            <Link to={`/parties/new?role=${role}`}>{role === 'customer' ? 'Add customer' : 'Add supplier'}</Link>
          </Button>
        ) : undefined
      }
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!allowed) return <>{header}<Card className="mt-6"><PermissionDenied permission="party.view" /></Card></>;

  const full = can('party.view');
  const columns: Column<Party>[] = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      render: (p) =>
        full ? (
          <Link to={`/parties/${p.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
            {p.name}
          </Link>
        ) : (
          <span className="font-medium">{p.name}</span>
        ),
    },
    { key: 'place', header: 'Place', render: (p) => (p.addresses[0] ? `${p.addresses[0].city}, ${stateName(p.addresses[0].stateCode) ?? ''}` : '—') },
    ...(full
      ? [
          { key: 'gstin', header: 'GSTIN', render: (p: Party) => (p.gstins?.length ? <span className="font-mono">{p.gstins[0]?.gstin}{p.gstins.length > 1 ? ` +${p.gstins.length - 1}` : ''}</span> : <StatusBadge tone="neutral" label="Unregistered" />) },
          { key: 'phone', header: 'Phone', render: (p: Party) => p.contacts?.find((c) => c.phone)?.phone ?? '—' },
        ]
      : []),
    { key: 'roles', header: 'Also', render: (p) => (role === 'customer' ? (p.isSupplier ? 'Supplier' : '') : p.isCustomer ? 'Customer' : '') },
  ];
  const rows = parties.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      {header}
      <Card className="mt-6">
        <form
          role="search"
          className="flex flex-wrap items-end gap-3 px-5 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
        >
          <FormField label={full ? 'Search by name, GSTIN or phone' : 'Search by name'} className="min-w-0 flex-1 sm:max-w-sm">
            {(f) => <Input {...f} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
          </FormField>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="size-4 accent-accent" />
            Show archived
          </label>
        </form>
        <div className="py-4">
          {parties.isPending ? (
            <Skeleton className="mx-5 h-40" />
          ) : parties.isError ? (
            <ErrorState message={errorMessage(parties.error)} onRetry={() => void parties.refetch()} />
          ) : (
            <DataTable caption={title} hideCaption columns={columns} rows={rows} rowKey={(p) => p.id} empty={<EmptyState title={search ? 'No matches' : `No ${title.toLowerCase()} yet`} />} />
          )}
        </div>
        {parties.hasNextPage && (
          <div className="flex justify-center px-5 pb-5">
            <Button variant="secondary" onClick={() => void parties.fetchNextPage()} disabled={parties.isFetchingNextPage}>
              {parties.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
