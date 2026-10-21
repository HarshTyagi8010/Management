import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { MOVEMENT_KIND_LABELS, stockMovementSchema, type LegalEntity, type StockMovement } from '@bizmgmt/contracts';
import { Button, Card, DataTable, EmptyState, ErrorState, FormField, PermissionDenied, Select, Skeleton, formatBusinessDate, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { useEntityChoice } from '../settings/EntityPicker';
import { usePageTitle } from '../usePageTitle';
import { qty, rupees, unitCost, useWarehouses, warehouseLabel } from './shared';

const SOURCE_PATHS = {
  stock_adjustment: '/inventory/adjustments',
  stock_transfer: '/inventory/transfers',
  stock_count: '/inventory/counts',
  dispatch: '/sales/dispatches',
  sales_invoice: '/sales/invoices',
  goods_receipt: '/purchases/receipts',
  supplier_bill: '/purchases/bills',
  sales_return: '/credit-debit-notes',
  purchase_return: '/credit-debit-notes',
} as const;

export function LedgerPage() {
  usePageTitle('Stock ledger');
  const { can, tenantContext } = useSession();
  const { entity, picker, state } = useEntityChoice();
  const header = <PageHeader title="Stock ledger" description="Every stock movement, newest first. Entries are never changed or deleted; corrections appear as new entries." />;
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('stock.view')) return <>{header}<Card className="mt-6"><PermissionDenied permission="stock.view" /></Card></>;
  return (
    <>
      {header}
      {state}
      {picker}
      {entity && <Ledger key={entity.id} entity={entity} />}
    </>
  );
}

function Ledger({ entity }: { entity: LegalEntity }) {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const warehouseId = params.get('warehouse') ?? '';
  const itemId = params.get('item') ?? '';
  const warehouses = useWarehouses(entity.id);
  const key = useTenantQueryKey('stock-ledger', entity.id, warehouseId, itemId);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ legalEntityId: entity.id, limit: '50' });
      if (warehouseId) p.set('warehouseId', warehouseId);
      if (itemId) p.set('itemId', itemId);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/stock/movements?${p.toString()}`, { schema: pageSchemaOf(stockMovementSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const showCost = can('price.view_cost');
  const update = (name: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  const filteredItem = itemId ? data.find((m) => m.itemId === itemId) : undefined;
  const columns: Column<StockMovement>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (m) => (
        <span className="flex flex-col">
          <span className="font-medium">{m.itemName}</span>
          <span className="font-mono text-xs text-muted">{m.sku}</span>
        </span>
      ),
    },
    { key: 'date', header: 'Date', render: (m) => <span className="tabular whitespace-nowrap">{formatBusinessDate(m.docDate)}</span> },
    { key: 'kind', header: 'Movement', render: (m) => `${MOVEMENT_KIND_LABELS[m.kind]}${m.reversal ? ' (reversal)' : ''}` },
    { key: 'where', header: 'Warehouse', render: (m) => <span className="font-mono">{m.warehouseCode}</span> },
    {
      key: 'qty',
      header: 'Quantity',
      align: 'end',
      render: (m) => (
        <span className="tabular whitespace-nowrap">
          {m.qty.startsWith('-') ? '' : '+'}
          {qty(m.qty)} <span className="text-xs text-muted">{m.unitCode}</span>
        </span>
      ),
    },
    { key: 'after', header: 'On hand after', align: 'end', render: (m) => <span className="tabular">{qty(m.onHandAfter)}</span> },
    ...(showCost
      ? [
          { key: 'cost', header: 'Unit cost', align: 'end' as const, render: (m: StockMovement) => <span className="tabular">{unitCost(m.unitCost)}</span> },
          { key: 'value', header: 'Value', align: 'end' as const, render: (m: StockMovement) => <span className="tabular">{rupees(m.value)}</span> },
        ]
      : []),
    {
      key: 'source',
      header: 'Document',
      render: (m) => (
        <Link to={`${SOURCE_PATHS[m.source.type]}/${m.source.id}`} className="font-mono text-accent underline-offset-2 hover:underline">
          {m.source.number}
        </Link>
      ),
    },
  ];
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-end gap-3 px-5 pt-5">
        <FormField label="Warehouse" className="w-full sm:w-64">
          {(f) => (
            <Select {...f} value={warehouseId} onChange={(e) => update('warehouse', e.target.value)}>
              <option value="">All warehouses I can see</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseLabel(w)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {itemId && (
          <p className="flex min-h-10 items-center gap-2 text-sm">
            Showing {filteredItem ? `${filteredItem.sku} · ${filteredItem.itemName}` : 'one item'}
            <Button size="sm" variant="ghost" onClick={() => update('item', '')}>
              Show all items
            </Button>
          </p>
        )}
      </div>
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable caption="Stock movements" hideCaption columns={columns} rows={data} rowKey={(m) => m.id} empty={<EmptyState title="No movements yet" description="Opening stock, transfers, adjustments and counts appear here once posted." />} />
        )}
        {rows.hasNextPage && (
          <div className="px-5 pt-4">
            <Button variant="secondary" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
              {rows.isFetchingNextPage ? 'Loading…' : 'Show older'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
