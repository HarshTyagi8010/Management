import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { stockCountSchema, type StockCount } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, Select, Skeleton, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, newIdempotencyKey } from '../../lib/api';
import { errorMessage, fieldErrorsOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { formatDateTimeIST } from '../../app/permissions';
import { usePageTitle } from '../usePageTitle';
import { DocLink, DocStatus, qty, unitCost, useStockItems, useWarehouses, warehouseLabel } from './shared';

const invalidateStock = (q: { queryKey: readonly unknown[] }) => ['stock-counts', 'stock-count', 'stock-summary', 'stock-ledger', 'stock-valuation'].includes(String(q.queryKey[2]));

export function CountList() {
  const { can } = useSession();
  const [planning, setPlanning] = useState(false);
  const key = useTenantQueryKey('stock-counts');
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => api(`/stock-counts?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`, { schema: pageSchemaOf(stockCountSchema), signal }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const columns: Column<StockCount>[] = [
    { key: 'number', header: 'Count', primary: true, render: (c) => <DocLink to={`/inventory/counts/${c.id}`}>{c.number}</DocLink> },
    { key: 'where', header: 'Warehouse', render: (c) => c.warehouseName },
    { key: 'progress', header: 'Counted', align: 'end', render: (c) => <span className="tabular">{`${c.countedLines} of ${c.lines.length}`}</span> },
    { key: 'started', header: 'Started', render: (c) => (c.snapshotAt ? <span className="tabular whitespace-nowrap">{formatDateTimeIST(c.snapshotAt)}</span> : '—') },
    { key: 'status', header: 'Status', render: (c) => <DocStatus status={c.status} /> },
  ];
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      {(can('stock.move') || can('stock.count.post')) && (
        <div className="flex justify-end px-5 pt-5">
          <Button onClick={() => setPlanning(true)}>Plan a stock count</Button>
        </div>
      )}
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable caption="Stock counts" hideCaption columns={columns} rows={data} rowKey={(c) => c.id} empty={<EmptyState title="No stock counts" description="Count what is physically in a warehouse; differences become adjustments when posted." />} />
        )}
      </div>
      {planning && <PlanCountDialog onClose={() => setPlanning(false)} />}
    </Card>
  );
}

function PlanCountDialog({ onClose }: { onClose: () => void }) {
  const { canInWarehouse } = useSession();
  const navigate = useNavigate();
  const warehouses = useWarehouses();
  const choices = (warehouses.data ?? []).filter((w) => !w.archived && (canInWarehouse('stock.move', w) || canInWarehouse('stock.count.post', w)));
  const [warehouseId, setWarehouseId] = useState('');
  const [scope, setScope] = useState<'all' | 'items'>('all');
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const items = useStockItems(search);
  const target = warehouseId || choices[0]?.id || '';
  const create = useMutation({
    mutationFn: () => api('/stock-counts', { method: 'POST', body: { warehouseId: target, scope, itemIds: scope === 'items' ? itemIds : [] }, schema: stockCountSchema }),
    onSuccess: (count) => navigate(`/inventory/counts/${count.id}`),
  });
  const errors = fieldErrorsOf(create.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Plan a stock count" description="Expected quantities are taken when you start counting.">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {create.isError && <InlineAlert>{errorMessage(create.error)}</InlineAlert>}
        <FormField label="Warehouse" required error={errors.warehouseId}>
          {(f) => (
            <Select {...f} value={target} onChange={(e) => setWarehouseId(e.target.value)}>
              {choices.map((w) => (
                <option key={w.id} value={w.id}>
                  {warehouseLabel(w)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="What to count">
          {(f) => (
            <Select {...f} value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'items')}>
              <option value="all">Every stock item</option>
              <option value="items">Only the items I choose</option>
            </Select>
          )}
        </FormField>
        {scope === 'items' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[0.8125rem] font-medium">Items {itemIds.length > 0 && `(${itemIds.length} chosen)`}</legend>
            <div className="flex items-end gap-2">
              <FormField label="Find items" className="min-w-0 flex-1">
                {(f) => (
                  <Input
                    {...f}
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        setSearch(q.trim());
                      }
                    }}
                  />
                )}
              </FormField>
              <Button variant="secondary" onClick={() => setSearch(q.trim())}>
                Search
              </Button>
            </div>
            {errors.itemIds && <p className="text-xs font-medium text-danger">{errors.itemIds}</p>}
            <div className="max-h-56 overflow-y-auto rounded-md border border-border p-3">
              {(items.data ?? []).map((i) => (
                <Checkbox key={i.id} label={`${i.sku} · ${i.name}`} checked={itemIds.includes(i.id)} onChange={(e) => setItemIds(e.target.checked ? [...itemIds, i.id] : itemIds.filter((x) => x !== i.id))} className="py-1" />
              ))}
              {items.data?.length === 0 && <p className="text-sm text-muted">No stock items match.</p>}
            </div>
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !target || (scope === 'items' && itemIds.length === 0)}>
            {create.isPending ? 'Creating…' : 'Create count sheet'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CountPage() {
  const { id = '' } = useParams();
  const key = useTenantQueryKey('stock-count', id);
  const count = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/stock-counts/${id}`, { schema: stockCountSchema, signal }) });
  usePageTitle(count.data ? `Stock count ${count.data.number}` : 'Stock count');
  if (count.isPending) return <Skeleton className="h-64" />;
  if (count.isError) return <ErrorState message={errorMessage(count.error)} onRetry={() => void count.refetch()} />;
  return <CountSheet key={count.data.version} count={count.data} />;
}

function CountSheet({ count }: { count: StockCount }) {
  const { can, canInWarehouse } = useSession();
  const queryClient = useQueryClient();
  const key = useTenantQueryKey('stock-count', count.id);
  const where = { id: count.warehouseId, legalEntityId: count.legalEntityId };
  const canCount = canInWarehouse('stock.move', where) || canInWarehouse('stock.count.post', where);
  const canPost = canInWarehouse('stock.count.post', where);
  const showCost = can('price.view_cost');
  const counting = count.status === 'counting' && canCount;
  const [entries, setEntries] = useState<Record<string, { counted: string; cost: string }>>(() =>
    Object.fromEntries(count.lines.map((l) => [l.itemId, { counted: l.countedQty ?? '', cost: l.unitCost ?? '' }])),
  );
  const done = (next: StockCount) => {
    queryClient.setQueryData(key, next);
    void queryClient.invalidateQueries({ predicate: invalidateStock });
  };
  const command = useMutation({
    mutationFn: (action: 'start' | 'submit' | 'reopen' | 'post' | 'cancel') =>
      api(`/stock-counts/${count.id}/${action}`, { method: 'POST', body: { version: count.version }, schema: stockCountSchema, ...(action === 'post' ? { idempotencyKey: newIdempotencyKey() } : {}) }),
    onSuccess: done,
  });
  const changed = count.lines.filter((l) => (entries[l.itemId]?.counted ?? '') !== (l.countedQty ?? '') || (showCost && (entries[l.itemId]?.cost ?? '') !== (l.unitCost ?? '')));
  const save = useMutation({
    mutationFn: () =>
      api(`/stock-counts/${count.id}`, {
        method: 'PATCH',
        body: {
          version: count.version,
          lines: changed.map((l) => ({ itemId: l.itemId, countedQty: entries[l.itemId]?.counted || null, ...(showCost ? { unitCost: entries[l.itemId]?.cost || null } : {}) })),
        },
        schema: stockCountSchema,
      }),
    onSuccess: done,
  });
  type Line = StockCount['lines'][number];
  const columns: Column<Line>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (l) => (
        <span className="flex flex-col">
          <span className="font-medium">{l.itemName}</span>
          <span className="font-mono text-xs text-muted">{l.sku}</span>
        </span>
      ),
    },
    { key: 'expected', header: 'Expected', align: 'end', render: (l) => (l.expectedQty === null ? '—' : <span className="tabular whitespace-nowrap">{qty(l.expectedQty)} <span className="text-xs text-muted">{l.unitCode}</span></span>) },
    {
      key: 'counted',
      header: 'Counted',
      align: 'end',
      render: (l) =>
        counting ? (
          <Input
            aria-label={`Counted quantity of ${l.sku}`}
            inputMode="decimal"
            className="tabular ml-auto w-28 text-right"
            value={entries[l.itemId]?.counted ?? ''}
            onChange={(e) => setEntries({ ...entries, [l.itemId]: { counted: e.target.value.trim(), cost: entries[l.itemId]?.cost ?? '' } })}
          />
        ) : l.countedQty === null ? (
          <span className="text-muted">Not counted</span>
        ) : (
          <span className="tabular">{qty(l.countedQty)}</span>
        ),
    },
    { key: 'variance', header: 'Difference', align: 'end', render: (l) => (l.variance === null ? '—' : <span className="tabular">{/^-|^0(\.0+)?$/.test(l.variance) ? '' : '+'}{qty(l.variance)}</span>) },
    ...(showCost
      ? [
          {
            key: 'cost',
            header: 'Cost if no average',
            align: 'end' as const,
            render: (l: Line) =>
              counting ? (
                <Input
                  aria-label={`Unit cost of ${l.sku} if it has no average cost`}
                  inputMode="decimal"
                  className="tabular ml-auto w-28 text-right"
                  value={entries[l.itemId]?.cost ?? ''}
                  onChange={(e) => setEntries({ ...entries, [l.itemId]: { counted: entries[l.itemId]?.counted ?? '', cost: e.target.value.trim() } })}
                />
              ) : (
                <span className="tabular">{unitCost(l.unitCost)}</span>
              ),
          },
        ]
      : []),
  ];
  const error = command.error ?? save.error;
  // A refused post lists the items whose stock moved after counting started.
  const staleItems = Object.values(fieldErrorsOf(command.error));
  return (
    <>
      <PageHeader
        title={`Stock count ${count.number}`}
        description={`${count.warehouseName}${count.snapshotAt ? ` · expected quantities as of ${formatDateTimeIST(count.snapshotAt)} IST` : ''}`}
        actions={
          <>
            {count.status === 'draft' && canCount && (
              <Button onClick={() => command.mutate('start')} disabled={command.isPending}>
                Start counting
              </Button>
            )}
            {counting && (
              <Button variant="secondary" onClick={() => command.mutate('submit')} disabled={command.isPending || changed.length > 0}>
                Submit count
              </Button>
            )}
            {count.status === 'submitted' && canPost && (
              <Button onClick={() => command.mutate('post')} disabled={command.isPending}>
                Post differences to stock
              </Button>
            )}
            {count.status === 'submitted' && canCount && (
              <Button variant="secondary" onClick={() => command.mutate('reopen')} disabled={command.isPending}>
                Reopen and refresh
              </Button>
            )}
            {['draft', 'counting', 'submitted'].includes(count.status) && canCount && (
              <Button variant="ghost" onClick={() => command.mutate('cancel')} disabled={command.isPending}>
                Cancel count
              </Button>
            )}
          </>
        }
      />
      {error && (
        <InlineAlert className="mt-4">
          {errorMessage(error)}
          {staleItems.length > 0 && ` Items: ${staleItems.join(', ')}.`}
        </InlineAlert>
      )}
      <Card className="mt-6">
        <CardHeader
          title="Status"
          description={
            count.status === 'counting'
              ? 'Enter what you find on the shelves. Items you leave blank are not changed.'
              : count.status === 'submitted'
                ? 'Posting turns each difference into an adjustment at the current average cost.'
                : count.postedAt
                  ? `Posted ${formatDateTimeIST(count.postedAt)}${count.postedBy ? ` by ${count.postedBy.name}` : ''}`
                  : undefined
          }
          action={<DocStatus status={count.status} />}
        />
        {count.note && <CardBody className="text-sm">{count.note}</CardBody>}
      </Card>
      <Card className="mt-6">
        <div className="py-4">
          <DataTable caption={`Count sheet: ${count.countedLines} of ${count.lines.length} counted`} columns={columns} rows={count.lines} rowKey={(l) => l.lineId} />
        </div>
        {counting && (
          <div className="flex flex-wrap items-center gap-3 px-5 pb-5">
            <Button onClick={() => save.mutate()} disabled={save.isPending || changed.length === 0}>
              {save.isPending ? 'Saving…' : 'Save counts'}
            </Button>
            {changed.length > 0 && <span className="text-xs text-muted">{changed.length} unsaved</span>}
          </div>
        )}
      </Card>
    </>
  );
}
