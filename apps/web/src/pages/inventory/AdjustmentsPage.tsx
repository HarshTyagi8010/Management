import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'radix-ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ADJUSTMENT_REASON_LABELS, ADJUSTMENT_REASONS, stockAdjustmentSchema, type AdjustmentReason, type StockAdjustment } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, formatBusinessDate, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, newIdempotencyKey } from '../../lib/api';
import { errorMessage, fieldErrorsOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';
import { JournalCard } from './JournalCard';
import { formatDateTimeIST } from '../../app/permissions';
import { usePageTitle } from '../usePageTitle';
import { CountList } from './CountsPage';
import { DocLink, DocStatus, LinesEditor, newLine, qty, rupees, todayIST, unitCost, useWarehouses, warehouseLabel, type EditLine } from './shared';

const tabTrigger = 'inline-flex h-10 cursor-pointer items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted data-[state=active]:border-accent data-[state=active]:text-text';

export function AdjustmentsPage() {
  usePageTitle('Adjustments & counts');
  const { can, tenantContext } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'counts' ? 'counts' : 'adjustments';
  const header = (
    <PageHeader
      title="Adjustments & counts"
      description="Opening stock, corrections for damage or loss, and physical stock counts."
      actions={
        <>
          {can('stock.adjust') && (
            <>
              <Button asChild variant="secondary">
                <Link to="/inventory/adjustments/new?type=opening">Enter opening stock</Link>
              </Button>
              <Button asChild>
                <Link to="/inventory/adjustments/new">New adjustment</Link>
              </Button>
            </>
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
      <Tabs.Root value={tab} onValueChange={(v) => setParams(v === 'counts' ? { tab: 'counts' } : {}, { replace: true })} className="mt-6">
        <Tabs.List aria-label="Stock corrections" className="flex gap-1 overflow-x-auto border-b border-border">
          <Tabs.Trigger value="adjustments" className={tabTrigger}>
            Adjustments & opening stock
          </Tabs.Trigger>
          <Tabs.Trigger value="counts" className={tabTrigger}>
            Stock counts
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="adjustments" className="mt-4 focus:outline-none">
          <AdjustmentList />
        </Tabs.Content>
        <Tabs.Content value="counts" className="mt-4 focus:outline-none">
          <CountList />
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}

function AdjustmentList() {
  const key = useTenantQueryKey('stock-adjustments');
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => api(`/stock-adjustments?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`, { schema: pageSchemaOf(stockAdjustmentSchema), signal }),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const columns: Column<StockAdjustment>[] = [
    { key: 'number', header: 'Document', primary: true, render: (a) => <DocLink to={`/inventory/adjustments/${a.id}`}>{a.number}</DocLink> },
    { key: 'type', header: 'Type', render: (a) => (a.type === 'opening' ? 'Opening stock' : a.reason ? ADJUSTMENT_REASON_LABELS[a.reason] : 'Adjustment') },
    { key: 'date', header: 'Date', render: (a) => <span className="tabular whitespace-nowrap">{formatBusinessDate(a.docDate)}</span> },
    { key: 'where', header: 'Warehouse', render: (a) => a.warehouseName },
    { key: 'lines', header: 'Items', align: 'end', render: (a) => <span className="tabular">{a.lines.length}</span> },
    { key: 'status', header: 'Status', render: (a) => <DocStatus status={a.status} /> },
  ];
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card>
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable caption="Stock adjustments and opening stock" hideCaption columns={columns} rows={data} rowKey={(a) => a.id} empty={<EmptyState title="Nothing here yet" description="Start by entering opening stock for each warehouse." />} />
        )}
        {rows.hasNextPage && (
          <div className="px-5 pt-4">
            <Button variant="secondary" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
              Show older
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function AdjustmentPage() {
  const { id = 'new' } = useParams();
  const key = useTenantQueryKey('stock-adjustment', id);
  const doc = useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/stock-adjustments/${id}`, { schema: stockAdjustmentSchema, signal }), enabled: id !== 'new' });
  usePageTitle(id === 'new' ? 'New stock adjustment' : (doc.data?.number ?? 'Stock adjustment'));
  if (id === 'new') return <AdjustmentEditor doc={null} />;
  if (doc.isPending) return <Skeleton className="h-64" />;
  if (doc.isError) return <ErrorState message={errorMessage(doc.error)} onRetry={() => void doc.refetch()} />;
  return doc.data.status === 'draft' ? <AdjustmentEditor key={doc.data.version} doc={doc.data} /> : <AdjustmentView doc={doc.data} />;
}

function AdjustmentEditor({ doc }: { doc: StockAdjustment | null }) {
  const { canInWarehouse } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const type = doc?.type ?? (params.get('type') === 'opening' ? 'opening' : 'adjustment');
  const opening = type === 'opening';
  const warehouses = useWarehouses();
  const choices = (warehouses.data ?? []).filter((w) => !w.archived && canInWarehouse('stock.adjust', w));
  const [warehouseId, setWarehouseId] = useState(doc?.warehouseId ?? '');
  const [reason, setReason] = useState<AdjustmentReason | ''>(doc?.reason ?? '');
  const [docDate, setDocDate] = useState(doc?.docDate ?? todayIST());
  const [note, setNote] = useState(doc?.note ?? '');
  const [lines, setLines] = useState<EditLine[]>(doc ? doc.lines.map((l) => newLine({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost ?? '' })) : [newLine()]);
  const target = warehouseId || choices[0]?.id || '';
  const invalidate = () => void queryClient.invalidateQueries({ predicate: (q) => ['stock-adjustments', 'stock-adjustment', 'stock-summary', 'stock-ledger', 'stock-valuation'].includes(String(q.queryKey[2])) });
  const body = () => ({ reason: opening ? null : reason || null, docDate, note, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost || null })) });
  const save = useMutation({
    mutationFn: () =>
      doc
        ? api(`/stock-adjustments/${doc.id}`, { method: 'PATCH', body: { ...body(), version: doc.version }, schema: stockAdjustmentSchema })
        : api('/stock-adjustments', { method: 'POST', body: { ...body(), warehouseId: target, type }, schema: stockAdjustmentSchema }),
    onSuccess: (saved) => {
      invalidate();
      navigate(`/inventory/adjustments/${saved.id}`, { replace: true });
    },
  });
  const command = useMutation({
    mutationFn: (action: 'post' | 'cancel') => api(`/stock-adjustments/${doc?.id}/${action}`, { method: 'POST', body: { version: doc?.version }, schema: stockAdjustmentSchema, ...(action === 'post' ? { idempotencyKey: newIdempotencyKey() } : {}) }),
    onSuccess: (next) => {
      invalidate();
      navigate(`/inventory/adjustments/${next.id}`, { replace: true });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const title = doc ? `${opening ? 'Opening stock' : 'Adjustment'} ${doc.number}` : opening ? 'Enter opening stock' : 'New stock adjustment';
  const header = (
    <PageHeader
      title={title}
      description={opening ? 'Stock you already had when you started using BizMgmt, with what it cost. Enter it once per item and warehouse.' : 'Correct stock for damage, loss, finds or errors. Stock out is valued at the average cost.'}
    />
  );
  if (warehouses.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!doc && choices.length === 0) {
    return (
      <>
        {header}
        <Card className="mt-6">
          <EmptyState title="No warehouse to adjust" description="Add a warehouse first, or ask for stock adjustment access to one." action={<Link className="font-medium text-accent underline-offset-2 hover:underline" to="/inventory/warehouses">Go to Warehouses</Link>} />
        </Card>
      </>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <>
      {header}
      <form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-6">
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {command.isError && <InlineAlert>{errorMessage(command.error)}</InlineAlert>}
        <Card>
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Warehouse" required error={errors.warehouseId}>
              {(f) => (
                <Select {...f} value={doc ? doc.warehouseId : target} onChange={(e) => setWarehouseId(e.target.value)} disabled={doc !== null}>
                  {doc && <option value={doc.warehouseId}>{doc.warehouseName}</option>}
                  {!doc &&
                    choices.map((w) => (
                      <option key={w.id} value={w.id}>
                        {warehouseLabel(w)}
                      </option>
                    ))}
                </Select>
              )}
            </FormField>
            {!opening && (
              <FormField label="Reason" required error={errors.reason}>
                {(f) => (
                  <Select {...f} value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                    <option value="">Choose a reason</option>
                    {ADJUSTMENT_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {ADJUSTMENT_REASON_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            )}
            <FormField label={opening ? 'Go-live date' : 'Date'} required error={errors.docDate}>
              {(f) => <Input {...f} type="date" max={todayIST()} value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            <FormField label="Note" error={errors.note}>
              {(f) => <Input {...f} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
            </FormField>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <LinesEditor
              lines={lines}
              onChange={setLines}
              errors={errors}
              qtyLabel={opening ? 'Quantity' : 'Change'}
              qtyHint={opening ? undefined : 'Use a minus sign to take stock out, e.g. -3'}
              costLabel={opening ? 'Cost per unit (₹)' : 'Cost per unit for stock in (₹)'}
              known={doc?.lines.map((l) => ({ id: l.itemId, sku: l.sku, name: l.itemName, baseUnitCode: l.unitCode })) ?? []}
            />
            {!opening && <p className="mt-3 text-xs text-muted">Leave the cost empty to bring stock in at the current average cost.</p>}
          </CardBody>
        </Card>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save draft'}
          </Button>
          {doc && (
            <>
              <Button variant="secondary" onClick={() => command.mutate('post')} disabled={command.isPending}>
                Post to stock
              </Button>
              <Button variant="ghost" onClick={() => command.mutate('cancel')} disabled={command.isPending}>
                Cancel draft
              </Button>
            </>
          )}
        </div>
        {doc && <p className="text-xs text-muted">Save your changes before posting. Posted documents can’t be edited; correct them with a new adjustment.</p>}
      </form>
    </>
  );
}

function AdjustmentView({ doc }: { doc: StockAdjustment }) {
  const { can } = useSession();
  const showCost = can('price.view_cost');
  type Line = StockAdjustment['lines'][number];
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
    { key: 'qty', header: 'Quantity', align: 'end', render: (l) => <span className="tabular whitespace-nowrap">{qty(l.qty)} <span className="text-xs text-muted">{l.unitCode}</span></span> },
    ...(showCost
      ? [
          { key: 'cost', header: 'Unit cost', align: 'end' as const, render: (l: Line) => <span className="tabular">{unitCost(l.unitCost)}</span> },
          { key: 'value', header: 'Value', align: 'end' as const, render: (l: Line) => <span className="tabular">{rupees(l.value)}</span> },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title={`${doc.type === 'opening' ? 'Opening stock' : 'Adjustment'} ${doc.number}`} description={`${doc.warehouseName} · ${formatBusinessDate(doc.docDate)}${doc.reason ? ` · ${ADJUSTMENT_REASON_LABELS[doc.reason]}` : ''}`} />
      <Card className="mt-6">
        <CardHeader
          title="Status"
          description={doc.postedAt ? `Posted ${formatDateTimeIST(doc.postedAt)}${doc.postedBy ? ` by ${doc.postedBy.name}` : ''}` : undefined}
          action={<DocStatus status={doc.status} />}
        />
        {doc.note && <CardBody className="text-sm">{doc.note}</CardBody>}
      </Card>
      <Card className="mt-6">
        <div className="py-4">
          <DataTable caption={showCost && doc.totalValue ? `Items (total ${rupees(doc.totalValue)})` : 'Items'} columns={columns} rows={doc.lines} rowKey={(l) => l.lineId} />
        </div>
      </Card>
      {doc.status === 'posted' && <JournalCard legalEntityId={doc.legalEntityId} sourceId={doc.id} />}
    </>
  );
}
