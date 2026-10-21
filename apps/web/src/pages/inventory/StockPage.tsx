import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { integrityCheckSchema, RECONCILIATION_ISSUE_LABELS, reconciliationReportSchema, stockSummaryRowSchema, stockValuationSchema, type LegalEntity, type StockSummaryRow } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, StatusBadge, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, listOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { formatDateTimeIST } from '../../app/permissions';
import { useEntityChoice } from '../settings/EntityPicker';
import { usePageTitle } from '../usePageTitle';
import { qty, rupees, unitCost, useWarehouses, warehouseLabel } from './shared';

const tabTrigger = 'inline-flex h-10 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-text';

export function StockPage() {
  usePageTitle('Stock');
  const { can, tenantContext } = useSession();
  const { entity, picker, state } = useEntityChoice();
  const header = (
    <PageHeader
      title="Stock"
      description="What is on hand in each warehouse, what is on its way between them, and what it is worth."
      actions={
        <>
          {can('stock.move') && (
            <Button asChild variant="secondary">
              <Link to="/inventory/transfers/new">New transfer</Link>
            </Button>
          )}
          {can('stock.adjust') && (
            <Button asChild variant="secondary">
              <Link to="/inventory/adjustments/new">Adjust stock</Link>
            </Button>
          )}
        </>
      }
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('stock.view')) return <>{header}<Card className="mt-6"><PermissionDenied permission="stock.view" /></Card></>;
  return (
    <>
      {header}
      {state}
      {picker}
      {entity && <StockTabs key={entity.id} entity={entity} />}
    </>
  );
}

function StockTabs({ entity }: { entity: LegalEntity }) {
  const { can } = useSession();
  const showValuation = can('price.view_cost');
  const showReconcile = can('stock.adjust') || can('report.financial');
  return (
    <Tabs.Root defaultValue="stock" className="mt-6">
      <Tabs.List aria-label="Stock views" className="flex gap-1 overflow-x-auto border-b border-border">
        <Tabs.Trigger value="stock" className={tabTrigger}>
          On hand
        </Tabs.Trigger>
        {showValuation && (
          <Tabs.Trigger value="valuation" className={tabTrigger}>
            Valuation
          </Tabs.Trigger>
        )}
        {showReconcile && (
          <Tabs.Trigger value="check" className={tabTrigger}>
            Check records
          </Tabs.Trigger>
        )}
      </Tabs.List>
      <Tabs.Content value="stock" className="mt-4 focus:outline-none">
        <StockSummary entity={entity} />
      </Tabs.Content>
      {showValuation && (
        <Tabs.Content value="valuation" className="mt-4 focus:outline-none">
          <Valuation entity={entity} />
        </Tabs.Content>
      )}
      {showReconcile && (
        <Tabs.Content value="check" className="mt-4 focus:outline-none">
          <Reconciliation entity={entity} />
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}

function StockSummary({ entity }: { entity: LegalEntity }) {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const warehouseId = params.get('warehouse') ?? '';
  const warehouses = useWarehouses(entity.id);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const key = useTenantQueryKey('stock-summary', entity.id, warehouseId, search);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ legalEntityId: entity.id, limit: '50' });
      if (warehouseId) p.set('warehouseId', warehouseId);
      if (search) p.set('q', search);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/stock/summary?${p.toString()}`, { schema: pageSchemaOf(stockSummaryRowSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const showCost = can('price.view_cost');
  const ledgerLink = (r: StockSummaryRow) => `/inventory/ledger?entity=${entity.id}&item=${r.itemId}${warehouseId ? `&warehouse=${warehouseId}` : ''}`;
  const columns: Column<StockSummaryRow>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (r) => (
        <span className="flex flex-col">
          <Link to={ledgerLink(r)} className="font-medium text-accent underline-offset-2 hover:underline" aria-label={`${r.name}: stock ledger`}>
            {r.name}
          </Link>
          <span className="font-mono text-xs text-muted">{r.sku}</span>
        </span>
      ),
    },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'end',
      render: (r) => (
        <span className="tabular whitespace-nowrap">
          {qty(r.onHand)} <span className="text-xs text-muted">{r.unitCode}</span>
        </span>
      ),
    },
    { key: 'available', header: 'Available', align: 'end', render: (r) => <span className="tabular">{qty(r.available)}</span> },
    { key: 'transit', header: 'Arriving', align: 'end', render: (r) => <span className="tabular">{qty(r.inTransit)}</span> },
    {
      key: 'reorder',
      header: 'Reorder level',
      render: (r) => (r.reorderLevel === null ? '—' : r.belowReorder ? <StatusBadge tone="warning" label={`Low (≤ ${qty(r.reorderLevel)})`} /> : <span className="tabular">{qty(r.reorderLevel)}</span>),
    },
    ...(showCost
      ? [
          { key: 'avg', header: 'Average cost', align: 'end' as const, render: (r: StockSummaryRow) => <span className="tabular">{unitCost(r.avgCost)}</span> },
          { key: 'value', header: 'Value', align: 'end' as const, render: (r: StockSummaryRow) => <span className="tabular">{rupees(r.value)}</span> },
        ]
      : []),
  ];
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      <form
        role="search"
        className="flex flex-wrap items-end gap-3 px-5 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <FormField label="Warehouse" className="w-full sm:w-64">
          {(f) => (
            <Select
              {...f}
              value={warehouseId}
              onChange={(e) =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (e.target.value) next.set('warehouse', e.target.value);
                    else next.delete('warehouse');
                    return next;
                  },
                  { replace: true },
                )
              }
            >
              <option value="">All warehouses I can see</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseLabel(w)}
                  {w.archived ? ' (archived)' : ''}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Search by name or code" className="min-w-0 flex-1 sm:max-w-sm">
          {(f) => <Input {...f} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
        </FormField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {showCost && <p className="px-5 pt-3 text-xs text-muted">Value = on hand × moving average cost of the business entity.</p>}
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable
            caption={`Stock on hand${warehouseId ? '' : ' in all warehouses you can see'}`}
            hideCaption
            columns={columns}
            rows={data}
            rowKey={(r) => r.itemId}
            empty={<EmptyState title={search ? 'No matching stock items' : 'No stock items yet'} description={search ? 'Try another name or code.' : 'Add items of type “Stock goods”, then enter their opening stock.'} />}
          />
        )}
        {rows.hasNextPage && (
          <div className="px-5 pt-4">
            <Button variant="secondary" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
              {rows.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Valuation({ entity }: { entity: LegalEntity }) {
  const key = useTenantQueryKey('stock-valuation', entity.id);
  const valuation = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/stock/valuation?legalEntityId=${entity.id}`, { schema: stockValuationSchema, signal }) });
  type Row = (typeof stockValuationSchema)['_output']['rows'][number];
  const columns: Column<Row>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{r.name}</span>
          <span className="font-mono text-xs text-muted">{r.sku}</span>
        </span>
      ),
    },
    { key: 'qty', header: 'Quantity', align: 'end', render: (r) => <span className="tabular whitespace-nowrap">{qty(r.qty)} <span className="text-xs text-muted">{r.unitCode}</span></span> },
    { key: 'avg', header: 'Average cost', align: 'end', render: (r) => <span className="tabular">{unitCost(r.avgCost)}</span> },
    { key: 'value', header: 'Value', align: 'end', render: (r) => <span className="tabular">{rupees(r.value)}</span> },
  ];
  return (
    <Card>
      <CardHeader
        title={valuation.data ? `Inventory value ${rupees(valuation.data.totalValue)}` : 'Inventory value'}
        description={valuation.data ? `Moving weighted average, all warehouses and goods in transit, as of ${formatDateTimeIST(valuation.data.asOf)} IST.` : undefined}
      />
      <div className="pb-4">
        {valuation.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : valuation.isError ? (
          <ErrorState message={errorMessage(valuation.error)} onRetry={() => void valuation.refetch()} />
        ) : (
          <DataTable caption="Valuation by item" hideCaption columns={columns} rows={valuation.data.rows} rowKey={(r) => r.itemId} empty={<EmptyState title="Nothing in stock" description="Valued stock appears here once opening stock is posted." />} />
        )}
      </div>
    </Card>
  );
}

function Reconciliation({ entity }: { entity: LegalEntity }) {
  const warehouses = useWarehouses(entity.id);
  const check = useMutation({ mutationFn: () => api(`/stock/reconciliation?legalEntityId=${entity.id}`, { schema: reconciliationReportSchema }) });
  const warehouseName = (id: string | null) => (id ? (warehouses.data?.find((w) => w.id === id)?.code ?? '?') : 'All warehouses');
  const report = check.data;
  const checksKey = useTenantQueryKey('integrity-checks');
  const scheduled = useQuery({ queryKey: checksKey, queryFn: ({ signal }) => api('/integrity-checks', { schema: listOf(integrityCheckSchema), signal }).then((r) => r.data) });
  return (
    <Card>
      <CardHeader title="Check stock records" description="Recalculates every balance and value from the stock ledger and compares them with the running totals. It changes nothing." />
      <CardBody className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold">Automatic daily checks</h3>
          {scheduled.data && scheduled.data.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {scheduled.data.map((c) => (
                <li key={c.kind} className={c.ok ? '' : 'font-medium text-danger'}>
                  {c.kind === 'stock' ? 'Stock' : 'Accounting journals'}: {c.ok ? 'OK' : 'Differences found'} · {c.summary} · {formatDateTimeIST(c.checkedAt)} IST
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-muted">{scheduled.isPending ? 'Loading…' : 'Not run yet. The background worker runs them once a day.'}</p>
          )}
        </div>
        <div>
          <Button onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? 'Checking…' : 'Run the check'}
          </Button>
        </div>
        {check.isError && <InlineAlert>{errorMessage(check.error)}</InlineAlert>}
        {report &&
          (report.ok ? (
            <InlineAlert tone="success">
              All {report.balancesChecked} balances and {report.valuationsChecked} valuations agree with the ledger (checked {formatDateTimeIST(report.checkedAt)} IST).
            </InlineAlert>
          ) : (
            <>
              <InlineAlert>
                {report.issues.length} difference{report.issues.length === 1 ? '' : 's'} found. Don’t correct these by hand: report them to your administrator with the time of this check.
              </InlineAlert>
              <ul className="flex flex-col gap-2 text-sm">
                {report.issues.map((i, n) => (
                  <li key={n} className="rounded-md border border-border p-3">
                    <span className="font-medium">{RECONCILIATION_ISSUE_LABELS[i.kind]}</span>
                    <span className="block text-muted">
                      {i.sku} · {i.itemName} · {warehouseName(i.warehouseId)}
                      {i.expected !== undefined && ` · ledger ${i.expected}, recorded ${i.actual}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ))}
        {report && report.negativeBalances.length > 0 && (
          <InlineAlert tone="warning">
            Negative stock: {report.negativeBalances.map((n) => `${n.sku} ${qty(n.onHand)} in ${warehouseName(n.warehouseId)}`).join('; ')}. It is corrected at the next receipt.
          </InlineAlert>
        )}
      </CardBody>
    </Card>
  );
}
