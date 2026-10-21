import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  purchaseOrderSchema,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type CreatePurchaseOrderInput,
} from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PermissionDenied,
  Select,
  Skeleton,
  formatBusinessDate,
  type Column,
} from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api, newIdempotencyKey } from '../../lib/api';
import { errorMessage, pageSchemaOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { useWarehouses } from '../inventory/shared';
import { usePageTitle } from '../usePageTitle';
import {
  DocLink,
  PurchaseOrderPdfControl,
  PurchaseStatus,
  rupees,
  todayIST,
  TotalsPanel,
  usePurchaseItems,
  useSuppliers,
  useTaxClasses,
} from './shared';

export function PurchaseOrdersListPage() {
  usePageTitle('Purchase orders');
  const { can, tenantContext } = useSession();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  const key = useTenantQueryKey('purchase-orders', status, search);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '25' });
      if (status) p.set('status', status);
      if (search) p.set('q', search);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/purchase-orders?${p.toString()}`, { schema: pageSchemaOf(purchaseOrderSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const header = (
    <PageHeader
      title="Purchase orders"
      description="Create drafts, agree pricing and terms with suppliers, and track goods receipt progress."
      actions={
        can('purchase.edit') ? (
          <Button asChild>
            <Link to="/purchases/orders/new">New purchase order</Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('purchase.edit') && !can('purchase.issue') && !can('report.financial')) {
    return <>{header}<Card className="mt-6"><PermissionDenied permission="purchase.edit" /></Card></>;
  }

  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'number',
      header: 'Order',
      primary: true,
      render: (d) => <DocLink to={`/purchases/orders/${d.id}`}>{d.number ?? 'Draft'}</DocLink>,
    },
    { key: 'date', header: 'Date', render: (d) => <span className="tabular whitespace-nowrap">{formatBusinessDate(d.docDate)}</span> },
    { key: 'supplier', header: 'Supplier', render: (d) => d.supplier?.name ?? '—' },
    {
      key: 'delivery',
      header: 'Delivery',
      render: (d) => (d.expectedDeliveryDate ? <span className="tabular whitespace-nowrap">{formatBusinessDate(d.expectedDeliveryDate)}</span> : '—'),
    },
    { key: 'total', header: 'Total', align: 'end', render: (d) => <span className="tabular">{d.amounts ? rupees(d.amounts.grand) : '—'}</span> },
    { key: 'status', header: 'Status', render: (d) => <PurchaseStatus status={d.status} /> },
  ];

  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      {header}
      <Card className="mt-6">
        <form
          className="flex flex-wrap items-end gap-3 px-5 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
          }}
        >
          <FormField label="Status" className="w-44">
            {(f) => (
              <Select {...f} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="issued">Issued</option>
                <option value="partially_received">Partially received</option>
                <option value="received">Received</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            )}
          </FormField>
          <FormField label="Search" className="w-64">
            {(f) => <Input {...f} placeholder="Number or supplier…" value={q} onChange={(e) => setQ(e.target.value)} />}
          </FormField>
          <Button type="submit" variant="secondary">Filter</Button>
          {(status || search) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStatus('');
                setQ('');
                setSearch('');
              }}
            >
              Reset
            </Button>
          )}
        </form>
        {rows.isPending ? (
          <Skeleton className="m-5 h-48" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : data.length === 0 ? (
          <EmptyState
            title="No purchase orders"
            description={status || search ? 'Try resetting filters.' : 'Raise your first purchase order to start tracking procurement.'}
          />
        ) : (
          <div className="py-4">
            <DataTable
              caption="Purchase orders"
              hideCaption
              columns={columns}
              rows={data}
              rowKey={(d) => d.id}
            />
            {rows.hasNextPage && (
              <div className="flex justify-center p-3">
                <Button variant="ghost" size="sm" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
                  {rows.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}

export function PurchaseOrderDocPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const { can, canIn, tenantContext } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const key = useTenantQueryKey('purchase-orders', 'detail', id ?? 'new');
  const poQuery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/purchase-orders/${id}`, { schema: purchaseOrderSchema, signal }),
    enabled: !isNew && !!id,
  });

  const entities = useLegalEntities();
  const allowedEntities = (entities.data ?? []).filter((e) => canIn('purchase.edit', e.id) || canIn('purchase.issue', e.id));

  // Cancel dialog state
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const po = poQuery.data;
  usePageTitle(isNew ? 'New purchase order' : po ? `PO ${po.number ?? '(draft)'}` : 'Purchase order');

  const issueMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      return api(`/purchase-orders/${po.id}/issue`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        schema: purchaseOrderSchema,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      return api(`/purchase-orders/${po.id}/cancel`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: cancelReason },
        schema: purchaseOrderSchema,
      });
    },
    onSuccess: (updated) => {
      setCancelOpen(false);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const closeMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      return api(`/purchase-orders/${po.id}/close`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: closeReason },
        schema: purchaseOrderSchema,
      });
    },
    onSuccess: (updated) => {
      setCloseOpen(false);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      return api(`/purchase-orders/${po.id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      navigate('/purchases/orders');
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  if (!tenantContext || entities.isPending) return <Skeleton className="h-64" />;
  if (!isNew && poQuery.isPending) return <Skeleton className="h-64" />;
  if (!isNew && poQuery.isError) return <Card className="mt-6"><ErrorState title="Error" message={errorMessage(poQuery.error)} /></Card>;

  if (isNew || (po && po.status === 'draft')) {
    return <PurchaseOrderEditor po={po ?? null} allowedEntities={allowedEntities} />;
  }

  if (!po) return null;

  const lineColumns: Column<PurchaseOrderLine>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (l) => (
        <span className="flex flex-col">
          <span className="font-medium">{l.itemName}</span>
          <span className="font-mono text-xs text-muted">{l.itemSku} {l.hsnSac ? `· HSN ${l.hsnSac}` : ''}</span>
        </span>
      ),
    },
    { key: 'qty', header: 'Ordered', align: 'end', render: (l) => <span className="tabular">{l.qty} {l.unitCode}</span> },
    { key: 'received', header: 'Received', align: 'end', render: (l) => <span className="tabular">{l.receivedQty ?? '0'} {l.unitCode}</span> },
    { key: 'billed', header: 'Billed', align: 'end', render: (l) => <span className="tabular">{l.billedQty ?? '0'} {l.unitCode}</span> },
    { key: 'price', header: 'Rate', align: 'end', render: (l) => <span className="tabular">{rupees(l.unitPrice)}</span> },
    { key: 'tax', header: 'Tax %', align: 'end', render: (l) => <span className="tabular">{l.taxRatePercent ? `${l.taxRatePercent}%` : '0%'}</span> },
    { key: 'total', header: 'Total', align: 'end', render: (l) => <span className="tabular">{rupees(l.lineTotal)}</span> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link to="/purchases/orders" className="text-accent underline-offset-2 hover:underline">
              ← Purchase orders
            </Link>
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Purchase order {po.number ?? '(draft)'}</h1>
            <PurchaseStatus status={po.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PurchaseOrderPdfControl po={po} />
          {(po.status === 'issued' || po.status === 'partially_received') && can('receipt.post') && (
            <Button asChild>
              <Link to={`/purchases/receipts/new?poId=${po.id}`}>Receive goods</Link>
            </Button>
          )}
          {(po.status === 'issued' || po.status === 'partially_received') && canIn('purchase.issue', po.legalEntityId) && (
            <>
              <Button variant="secondary" onClick={() => setCloseOpen(true)}>Close</Button>
              <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel</Button>
            </>
          )}
        </div>
      </div>

      {actionError && <InlineAlert tone="danger" className="mt-4">{actionError}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Supplier & Delivery" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-muted">Supplier</p>
              <p className="font-semibold">{po.supplier?.name ?? '—'}</p>
              {po.supplier?.gstin && <p className="font-mono text-xs text-muted">GSTIN: {po.supplier.gstin}</p>}
            </div>
            <div>
              <p className="text-muted">Destination Warehouse</p>
              <p className="font-semibold">{po.warehouseName ?? 'Default warehouse'}</p>
            </div>
            <div>
              <p className="text-muted">PO Date</p>
              <p className="tabular font-medium">{formatBusinessDate(po.docDate)}</p>
            </div>
            <div>
              <p className="text-muted">Expected Delivery</p>
              <p className="tabular font-medium">{po.expectedDeliveryDate ? formatBusinessDate(po.expectedDeliveryDate) : 'Not specified'}</p>
            </div>
            {po.notes && (
              <div className="sm:col-span-2">
                <p className="text-muted">Notes / Terms</p>
                <p className="whitespace-pre-wrap">{po.notes}</p>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Totals" />
          <CardBody>
            {po.amounts ? <TotalsPanel totals={po.amounts} /> : <p className="text-sm text-muted">No totals</p>}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Line items" />
        <DataTable caption="Line items" hideCaption columns={lineColumns} rows={po.lines} rowKey={(l) => l.id} />
      </Card>

      {/* Cancel Dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel purchase order">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Cancelling this order stops any further goods receipts. This cannot be undone.
          </p>
          <FormField label="Reason for cancellation" required>
            {(f) => <Input {...f} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />}
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>Back</Button>
            <Button
              variant="danger"
              disabled={!cancelReason.trim() || cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Confirm cancellation'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Close Dialog */}
      <Dialog open={closeOpen} onOpenChange={setCloseOpen} title="Close purchase order">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Closing this order indicates fulfillment is complete or remaining balance is short-closed.
          </p>
          <FormField label="Reason for closure" required>
            {(f) => <Input {...f} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} />}
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCloseOpen(false)}>Back</Button>
            <Button
              variant="secondary"
              disabled={!closeReason.trim() || closeMutation.isPending}
              onClick={() => closeMutation.mutate()}
            >
              {closeMutation.isPending ? 'Closing…' : 'Confirm closure'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

interface EditableLine {
  id?: string | undefined;
  itemId: string;
  description: string;
  qty: string;
  unitPrice: string;
  discountPercent?: string | undefined;
  discountAmount?: string | undefined;
  taxClassId?: string | undefined;
}

function PurchaseOrderEditor({
  po,
  allowedEntities,
}: {
  po: PurchaseOrder | null;
  allowedEntities: Array<{ id: string; legalName: string }>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [entityId, setEntityId] = useState(po?.legalEntityId ?? allowedEntities[0]?.id ?? '');
  const [supplierId, setSupplierId] = useState(po?.supplierId ?? '');
  const [warehouseId, setWarehouseId] = useState(po?.warehouseId ?? '');
  const [docDate, setDocDate] = useState(po?.docDate ?? todayIST());
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(po?.expectedDeliveryDate ?? '');
  const [notes, setNotes] = useState(po?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const [lines, setLines] = useState<EditableLine[]>(
    po?.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice ?? '0.00',
      discountPercent: l.discountPercent ?? undefined,
      discountAmount: l.discountAmount ?? undefined,
    })) ?? [{ itemId: '', description: '', qty: '1', unitPrice: '0.00' }]
  );

  const suppliersQuery = useSuppliers();
  const warehousesQuery = useWarehouses(entityId);
  const itemsQuery = usePurchaseItems();
  const taxClassesQuery = useTaxClasses();

  const suppliers = suppliersQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];
  const items = itemsQuery.data ?? [];
  const taxClasses = taxClassesQuery.data ?? [];

  const saveMutation = useMutation({
    mutationFn: async (issueAfter: boolean) => {
      setError(null);
      const payload: CreatePurchaseOrderInput = {
        legalEntityId: entityId,
        supplierId,
        warehouseId,
        docDate,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
        notes: notes || undefined,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          description: l.description || '',
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent || undefined,
          discountAmount: l.discountAmount || undefined,
          taxClassId: l.taxClassId || undefined,
        })),
      };

      let resultPo: PurchaseOrder;
      if (po) {
        resultPo = await api(`/purchase-orders/${po.id}`, {
          method: 'PATCH',
          body: payload,
          schema: purchaseOrderSchema,
        });
      } else {
        resultPo = await api('/purchase-orders', {
          method: 'POST',
          body: payload,
          schema: purchaseOrderSchema,
        });
      }

      if (issueAfter) {
        resultPo = await api(`/purchase-orders/${resultPo.id}/issue`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          schema: purchaseOrderSchema,
        });
      }
      return resultPo;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      navigate(`/purchases/orders/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      if (!po) return;
      return api(`/purchase-orders/${po.id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      navigate('/purchases/orders');
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const updateLine = (index: number, patch: Partial<EditableLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setLines((prev) => [...prev, { itemId: '', description: '', qty: '1', unitPrice: '0.00' }]);
  };

  const removeLine = (index: number) => {
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        saveMutation.mutate(false);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link to="/purchases/orders" className="text-accent underline-offset-2 hover:underline">
              ← Purchase orders
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            {po ? `Edit draft purchase order ${po.number ?? ''}` : 'New purchase order'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {po && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={discardMutation.isPending}
              onClick={() => discardMutation.mutate()}
            >
              Discard draft
            </Button>
          )}
          <Button type="submit" variant="secondary" disabled={saveMutation.isPending}>
            Save draft
          </Button>
          <Button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(true)}
          >
            Issue order
          </Button>
        </div>
      </div>

      {error && <InlineAlert tone="danger" className="mt-4">{error}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Order details" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Business entity" required>
              {(f) => (
                <Select {...f} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                  {allowedEntities.map((e) => (
                    <option key={e.id} value={e.id}>{e.legalName}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Supplier" required>
              {(f) => (
                <Select {...f} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  <option value="">Select supplier…</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Destination warehouse" required>
              {(f) => (
                <Select {...f} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">Select warehouse…</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Order date" required>
              {(f) => <Input {...f} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            <FormField label="Expected delivery date">
              {(f) => <Input {...f} type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} />}
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Notes & terms">
                {(f) => <Input {...f} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Terms of supply, payment terms, or instructions…" />}
              </FormField>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Estimated Totals" />
          <CardBody>
            {po?.amounts ? (
              <TotalsPanel totals={po.amounts} />
            ) : (
              <p className="text-sm text-muted">Totals will calculate when saved.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Line items" />
        <CardBody className="flex flex-col gap-4">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-1 gap-3 rounded-md border border-border p-4 sm:grid-cols-6 items-end">
              <div className="sm:col-span-2">
                <FormField label="Item / Product" required>
                  {(f) => (
                    <Select
                      {...f}
                      value={line.itemId}
                      onChange={(e) => {
                        const sel = items.find((i) => i.id === e.target.value);
                        updateLine(idx, {
                          itemId: e.target.value,
                          taxClassId: sel?.taxClassId ?? undefined,
                        });
                      }}
                    >
                      <option value="">Select product…</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>
                      ))}
                    </Select>
                  )}
                </FormField>
              </div>
              <div>
                <FormField label="Quantity" required>
                  {(f) => <Input {...f} type="number" step="any" min="0.001" value={line.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} />}
                </FormField>
              </div>
              <div>
                <FormField label="Unit rate (₹)" required>
                  {(f) => <Input {...f} type="number" step="0.01" min="0" value={line.unitPrice} onChange={(e) => updateLine(idx, { unitPrice: e.target.value })} />}
                </FormField>
              </div>
              <div>
                <FormField label="Tax class">
                  {(f) => (
                    <Select {...f} value={line.taxClassId ?? ''} onChange={(e) => updateLine(idx, { taxClassId: e.target.value || undefined })}>
                      <option value="">Default GST</option>
                      {taxClasses.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </Select>
                  )}
                </FormField>
              </div>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={lines.length === 1}
                  onClick={() => removeLine(idx)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button type="button" variant="secondary" size="sm" onClick={addLine}>
              + Add item line
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
