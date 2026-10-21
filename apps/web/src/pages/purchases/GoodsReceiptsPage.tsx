import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  goodsReceiptSchema,
  purchaseOrderSchema,
  type GoodsReceipt,
  type GoodsReceiptLine,
  type CreateGoodsReceiptInput,
  type PurchaseOrder,
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
import { DocLink, PurchaseStatus, todayIST, usePurchaseItems, useSuppliers } from './shared';

export function GoodsReceiptsListPage() {
  usePageTitle('Goods receipts');
  const { can, tenantContext } = useSession();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  const key = useTenantQueryKey('goods-receipts', status, search);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '25' });
      if (status) p.set('status', status);
      if (search) p.set('q', search);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/goods-receipts?${p.toString()}`, { schema: pageSchemaOf(goodsReceiptSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const header = (
    <PageHeader
      title="Goods receipts"
      description="Record arrival of goods into warehouses against purchase orders and update physical stock."
      actions={
        can('receipt.post') ? (
          <Button asChild>
            <Link to="/purchases/receipts/new">New goods receipt</Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('receipt.post') && !can('stock.view') && !can('purchase.edit')) {
    return <>{header}<Card className="mt-6"><PermissionDenied permission="receipt.post" /></Card></>;
  }

  const columns: Column<GoodsReceipt>[] = [
    {
      key: 'number',
      header: 'Receipt',
      primary: true,
      render: (d) => <DocLink to={`/purchases/receipts/${d.id}`}>{d.number ?? 'Draft'}</DocLink>,
    },
    { key: 'date', header: 'Date', render: (d) => <span className="tabular whitespace-nowrap">{formatBusinessDate(d.docDate)}</span> },
    { key: 'supplier', header: 'Supplier', render: (d) => d.supplier?.name ?? '—' },
    { key: 'warehouse', header: 'Warehouse', render: (d) => d.warehouseName ?? 'Warehouse' },
    {
      key: 'po',
      header: 'PO',
      render: (d) => (d.purchaseOrderId ? (
        <DocLink to={`/purchases/orders/${d.purchaseOrderId}`}>View PO</DocLink>
      ) : '—'),
    },
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
                <option value="received">Received</option>
                <option value="partially_billed">Partially billed</option>
                <option value="billed">Billed</option>
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
            title="No goods receipts"
            description={status || search ? 'Try resetting filters.' : 'Receive goods against purchase orders to increase stock balances.'}
          />
        ) : (
          <div className="py-4">
            <DataTable
              caption="Goods receipts"
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

export function GoodsReceiptDocPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isNew = id === 'new';
  const poIdParam = searchParams.get('poId');
  const { can, canIn, tenantContext } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const key = useTenantQueryKey('goods-receipts', 'detail', id ?? 'new');
  const grnQuery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/goods-receipts/${id}`, { schema: goodsReceiptSchema, signal }),
    enabled: !isNew && !!id,
  });

  const entities = useLegalEntities();
  const allowedEntities = (entities.data ?? []).filter((e) => canIn('receipt.post', e.id) || canIn('purchase.edit', e.id));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const grn = grnQuery.data;
  usePageTitle(isNew ? 'New goods receipt' : grn ? `GRN ${grn.number ?? '(draft)'}` : 'Goods receipt');

  const receiveMutation = useMutation({
    mutationFn: async () => {
      if (!grn) return;
      return api(`/goods-receipts/${grn.id}/receive`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        schema: goodsReceiptSchema,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
      void queryClient.invalidateQueries({ queryKey: ['stock-ledger'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!grn) return;
      return api(`/goods-receipts/${grn.id}/cancel`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: cancelReason },
        schema: goodsReceiptSchema,
      });
    },
    onSuccess: (updated) => {
      setCancelOpen(false);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
      void queryClient.invalidateQueries({ queryKey: ['stock-ledger'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  if (!tenantContext || entities.isPending) return <Skeleton className="h-64" />;
  if (!isNew && grnQuery.isPending) return <Skeleton className="h-64" />;
  if (!isNew && grnQuery.isError) return <Card className="mt-6"><ErrorState title="Error" message={errorMessage(grnQuery.error)} /></Card>;

  if (isNew || (grn && grn.status === 'draft')) {
    return <GoodsReceiptEditor grn={grn ?? null} poIdPreset={poIdParam} allowedEntities={allowedEntities} />;
  }

  if (!grn) return null;

  const lineColumns: Column<GoodsReceiptLine>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (l) => (
        <span className="flex flex-col">
          <span className="font-medium">{l.itemName}</span>
          <span className="font-mono text-xs text-muted">{l.itemSku}</span>
        </span>
      ),
    },
    { key: 'qty', header: 'Received', align: 'end', render: (l) => <span className="tabular font-semibold">{l.qty} {l.unitCode}</span> },
    { key: 'billed', header: 'Billed', align: 'end', render: (l) => <span className="tabular">{l.billedQty ?? '0'} {l.unitCode}</span> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link to="/purchases/receipts" className="text-accent underline-offset-2 hover:underline">
              ← Goods receipts
            </Link>
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Goods receipt {grn.number ?? '(draft)'}</h1>
            <PurchaseStatus status={grn.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {grn.status === 'received' && can('purchase.edit') && (
            <Button asChild>
              <Link to={`/purchases/bills/new?grnId=${grn.id}`}>Record supplier bill</Link>
            </Button>
          )}
          {grn.status === 'received' && canIn('receipt.post', grn.legalEntityId) && (
            <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel receipt</Button>
          )}
        </div>
      </div>

      {actionError && <InlineAlert tone="danger" className="mt-4">{actionError}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader title="Receipt details" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-muted">Supplier</p>
              <p className="font-semibold">{grn.supplier?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-muted">Destination Warehouse</p>
              <p className="font-semibold">{grn.warehouseName ?? 'Warehouse'}</p>
            </div>
            <div>
              <p className="text-muted">Receipt Date</p>
              <p className="tabular font-medium">{formatBusinessDate(grn.docDate)}</p>
            </div>
            <div>
              <p className="text-muted">Linked Purchase Order</p>
              {grn.purchaseOrderId ? (
                <DocLink to={`/purchases/orders/${grn.purchaseOrderId}`}>View PO</DocLink>
              ) : (
                <p className="text-muted">Direct receipt</p>
              )}
            </div>
            {grn.supplierDeliveryChallanNumber && (
              <div>
                <p className="text-muted">Supplier Challan / Ref</p>
                <p className="font-medium">{grn.supplierDeliveryChallanNumber}</p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Received lines (stock posted)" />
        <DataTable caption="Received lines" hideCaption columns={lineColumns} rows={grn.lines} rowKey={(l) => l.id} />
      </Card>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel goods receipt">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Cancelling will post reversal stock movements at the original receipt cost and update the purchase order remaining balance.
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
    </>
  );
}

interface EditableReceiptLine {
  itemId: string;
  description: string;
  qty: string;
  sourceLineId?: string | undefined;
}

function GoodsReceiptEditor({
  grn,
  poIdPreset,
  allowedEntities,
}: {
  grn: GoodsReceipt | null;
  poIdPreset: string | null;
  allowedEntities: Array<{ id: string; legalName: string }>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [entityId, setEntityId] = useState(grn?.legalEntityId ?? allowedEntities[0]?.id ?? '');
  const [supplierId, setSupplierId] = useState(grn?.supplierId ?? '');
  const [warehouseId, setWarehouseId] = useState(grn?.warehouseId ?? '');
  const [purchaseOrderId, setPurchaseOrderId] = useState(grn?.purchaseOrderId ?? poIdPreset ?? '');
  const [supplierDeliveryChallanNumber, setSupplierDeliveryChallanNumber] = useState(grn?.supplierDeliveryChallanNumber ?? '');
  const [docDate, setDocDate] = useState(grn?.docDate ?? todayIST());
  const [notes, setNotes] = useState(grn?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  // Fetch PO detail if selected to pre-fill lines
  const poQuery = useQuery({
    queryKey: ['purchase-orders', 'detail', purchaseOrderId],
    queryFn: ({ signal }) => api(`/purchase-orders/${purchaseOrderId}`, { schema: purchaseOrderSchema, signal }),
    enabled: !!purchaseOrderId,
  });

  const [lines, setLines] = useState<EditableReceiptLine[]>(
    grn?.lines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      qty: l.qty,
      sourceLineId: l.sourceLineId ?? undefined,
    })) ?? [{ itemId: '', description: '', qty: '1' }]
  );

  const suppliersQuery = useSuppliers();
  const warehousesQuery = useWarehouses(entityId);
  const itemsQuery = usePurchaseItems();

  const suppliers = suppliersQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];
  const items = itemsQuery.data ?? [];

  const saveMutation = useMutation({
    mutationFn: async (receiveNow: boolean) => {
      setError(null);
      const payload: CreateGoodsReceiptInput = {
        legalEntityId: entityId,
        supplierId,
        warehouseId,
        purchaseOrderId: purchaseOrderId || undefined,
        supplierDeliveryChallanNumber: supplierDeliveryChallanNumber || undefined,
        docDate,
        notes: notes || undefined,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          qty: l.qty,
          sourceLineId: l.sourceLineId || undefined,
        })),
      };

      let resultGrn: GoodsReceipt;
      if (grn) {
        resultGrn = await api(`/goods-receipts/${grn.id}`, {
          method: 'PATCH',
          body: payload,
          schema: goodsReceiptSchema,
        });
      } else {
        resultGrn = await api('/goods-receipts', {
          method: 'POST',
          body: payload,
          schema: goodsReceiptSchema,
        });
      }

      if (receiveNow) {
        resultGrn = await api(`/goods-receipts/${resultGrn.id}/receive`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          schema: goodsReceiptSchema,
        });
      }
      return resultGrn;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
      void queryClient.invalidateQueries({ queryKey: ['stock-ledger'] });
      navigate(`/purchases/receipts/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      if (!grn) return;
      return api(`/goods-receipts/${grn.id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
      navigate('/purchases/receipts');
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const updateLine = (index: number, patch: Partial<EditableReceiptLine>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setLines((prev) => [...prev, { itemId: '', description: '', qty: '1' }]);
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
            <Link to="/purchases/receipts" className="text-accent underline-offset-2 hover:underline">
              ← Goods receipts
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            {grn ? `Edit draft receipt ${grn.number ?? ''}` : 'New goods receipt'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {grn && (
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
            Post receipt (add to stock)
          </Button>
        </div>
      </div>

      {error && <InlineAlert tone="danger" className="mt-4">{error}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Card className="sm:col-span-2">
          <CardHeader title="Receipt headers" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            <FormField label="Receipt date" required>
              {(f) => <Input {...f} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            <FormField label="Supplier Delivery Challan #">
              {(f) => <Input {...f} placeholder="e.g. DC-9812" value={supplierDeliveryChallanNumber} onChange={(e) => setSupplierDeliveryChallanNumber(e.target.value)} />}
            </FormField>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Items received" />
        <CardBody className="flex flex-col gap-4">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-1 gap-3 rounded-md border border-border p-4 sm:grid-cols-4 items-end">
              <div className="sm:col-span-2">
                <FormField label="Item / Product" required>
                  {(f) => (
                    <Select {...f} value={line.itemId} onChange={(e) => updateLine(idx, { itemId: e.target.value })}>
                      <option value="">Select product…</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>
                      ))}
                    </Select>
                  )}
                </FormField>
              </div>
              <div>
                <FormField label="Received quantity" required>
                  {(f) => <Input {...f} type="number" step="any" min="0.001" value={line.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} />}
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
              + Add received item
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
