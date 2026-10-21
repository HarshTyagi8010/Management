import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  supplierBillSchema,
  type SupplierBill,
  type SupplierBillLine,
  type CreateSupplierBillInput,
} from '@bizmgmt/contracts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
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
  StatusBadge,
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
  BillPaymentStatus,
  DocLink,
  PurchaseStatus,
  rupees,
  todayIST,
  TotalsPanel,
  usePurchaseItems,
  useSuppliers,
  useTaxClasses,
} from './shared';

export function SupplierBillsListPage() {
  usePageTitle('Supplier bills');
  const { can, tenantContext } = useSession();
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  const key = useTenantQueryKey('supplier-bills', status, paymentStatus, search);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '25' });
      if (status) p.set('status', status);
      if (paymentStatus) p.set('paymentStatus', paymentStatus);
      if (search) p.set('q', search);
      if (pageParam) p.set('cursor', pageParam);
      return api(`/supplier-bills?${p.toString()}`, { schema: pageSchemaOf(supplierBillSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });

  const header = (
    <PageHeader
      title="Supplier bills"
      description="Record purchase invoices from suppliers, match against receipts, capture ITC, and post to trade payables."
      actions={
        can('purchase.edit') ? (
          <Button asChild>
            <Link to="/purchases/bills/new">New supplier bill</Link>
          </Button>
        ) : undefined
      }
    />
  );

  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!can('purchase.edit') && !can('bill.post') && !can('report.financial')) {
    return <>{header}<Card className="mt-6"><PermissionDenied permission="purchase.edit" /></Card></>;
  }

  const columns: Column<SupplierBill>[] = [
    {
      key: 'number',
      header: 'Bill',
      primary: true,
      render: (d) => <DocLink to={`/purchases/bills/${d.id}`}>{d.number ?? 'Draft'}</DocLink>,
    },
    { key: 'date', header: 'Date', render: (d) => <span className="tabular whitespace-nowrap">{formatBusinessDate(d.docDate)}</span> },
    { key: 'supplier', header: 'Supplier', render: (d) => d.supplier?.name ?? '—' },
    {
      key: 'invoiceRef',
      header: 'Supplier invoice',
      render: (d) => (
        <span className="font-mono text-xs">
          {d.supplierInvoiceNumber}
          {d.supplierInvoiceDate ? ` (${formatBusinessDate(d.supplierInvoiceDate)})` : ''}
        </span>
      ),
    },
    { key: 'total', header: 'Total', align: 'end', render: (d) => <span className="tabular">{d.amounts ? rupees(d.amounts.grand) : '—'}</span> },
    {
      key: 'itc',
      header: 'ITC',
      render: (d) => (d.itcEligible ? <StatusBadge tone="success" label="Eligible" /> : <StatusBadge tone="neutral" label="Ineligible" />),
    },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <span className="flex flex-wrap gap-1">
          <PurchaseStatus status={d.status} />
          <BillPaymentStatus bill={d} />
        </span>
      ),
    },
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
          <FormField label="Status" className="w-40">
            {(f) => (
              <Select {...f} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            )}
          </FormField>
          <FormField label="Payment" className="w-40">
            {(f) => (
              <Select {...f} value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
                <option value="">All payment states</option>
                <option value="unpaid">Unpaid</option>
                <option value="partially_paid">Part-paid</option>
                <option value="paid">Paid</option>
              </Select>
            )}
          </FormField>
          <FormField label="Search" className="w-64">
            {(f) => <Input {...f} placeholder="Bill #, invoice # or supplier…" value={q} onChange={(e) => setQ(e.target.value)} />}
          </FormField>
          <Button type="submit" variant="secondary">Filter</Button>
          {(status || paymentStatus || search) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStatus('');
                setPaymentStatus('');
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
            title="No supplier bills"
            description={status || paymentStatus || search ? 'Try resetting filters.' : 'Record your first supplier bill to establish payable obligations.'}
          />
        ) : (
          <div className="py-4">
            <DataTable
              caption="Supplier bills"
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

export function SupplierBillDocPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const [searchParams] = useSearchParams();
  const grnIdParam = searchParams.get('grnId');
  const poIdParam = searchParams.get('poId');
  const { can, canIn, tenantContext } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const key = useTenantQueryKey('supplier-bills', 'detail', id ?? 'new');
  const billQuery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`/supplier-bills/${id}`, { schema: supplierBillSchema, signal }),
    enabled: !isNew && !!id,
  });

  const entities = useLegalEntities();
  const allowedEntities = (entities.data ?? []).filter((e) => canIn('purchase.edit', e.id) || canIn('bill.post', e.id));

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const bill = billQuery.data;
  usePageTitle(isNew ? 'New supplier bill' : bill ? `Bill ${bill.number ?? '(draft)'}` : 'Supplier bill');

  const postMutation = useMutation({
    mutationFn: async () => {
      if (!bill) return;
      return api(`/supplier-bills/${bill.id}/post`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        schema: supplierBillSchema,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['supplier-bills'] });
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!bill) return;
      return api(`/supplier-bills/${bill.id}/cancel`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { reason: cancelReason },
        schema: supplierBillSchema,
      });
    },
    onSuccess: (updated) => {
      setCancelOpen(false);
      queryClient.setQueryData(key, updated);
      void queryClient.invalidateQueries({ queryKey: ['supplier-bills'] });
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  if (!tenantContext || entities.isPending) return <Skeleton className="h-64" />;
  if (!isNew && billQuery.isPending) return <Skeleton className="h-64" />;
  if (!isNew && billQuery.isError) return <Card className="mt-6"><ErrorState title="Error" message={errorMessage(billQuery.error)} /></Card>;

  if (isNew || (bill && bill.status === 'draft')) {
    return <SupplierBillEditor bill={bill ?? null} grnIdPreset={grnIdParam} poIdPreset={poIdParam} allowedEntities={allowedEntities} />;
  }

  if (!bill) return null;

  const lineColumns: Column<SupplierBillLine>[] = [
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
    { key: 'qty', header: 'Quantity', align: 'end', render: (l) => <span className="tabular">{l.qty} {l.unitCode}</span> },
    { key: 'price', header: 'Rate', align: 'end', render: (l) => <span className="tabular">{rupees(l.unitPrice)}</span> },
    { key: 'tax', header: 'Tax %', align: 'end', render: (l) => <span className="tabular">{l.taxRatePercent ? `${l.taxRatePercent}%` : '0%'}</span> },
    { key: 'total', header: 'Total', align: 'end', render: (l) => <span className="tabular font-semibold">{rupees(l.lineTotal)}</span> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link to="/purchases/bills" className="text-accent underline-offset-2 hover:underline">
              ← Supplier bills
            </Link>
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Supplier bill {bill.number ?? '(draft)'}</h1>
            <PurchaseStatus status={bill.status} />
            <BillPaymentStatus bill={bill} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bill.status === 'posted' && bill.paymentStatus === 'unpaid' && canIn('bill.cancel', bill.legalEntityId) && (
            <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel bill</Button>
          )}
        </div>
      </div>

      {actionError && <InlineAlert tone="danger" className="mt-4">{actionError}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Bill metadata" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-muted">Supplier</p>
              <p className="font-semibold">{bill.supplier?.name ?? '—'}</p>
              {bill.supplier?.gstin && <p className="font-mono text-xs text-muted">GSTIN: {bill.supplier.gstin}</p>}
            </div>
            <div>
              <p className="text-muted">Supplier Invoice Reference</p>
              <p className="font-semibold">{bill.supplierInvoiceNumber}</p>
              {bill.supplierInvoiceDate && <p className="tabular text-xs text-muted">Date: {formatBusinessDate(bill.supplierInvoiceDate)}</p>}
            </div>
            <div>
              <p className="text-muted">Posting Date</p>
              <p className="tabular font-medium">{formatBusinessDate(bill.docDate)}</p>
            </div>
            <div>
              <p className="text-muted">Due Date</p>
              <p className="tabular font-medium">{bill.dueDate ? formatBusinessDate(bill.dueDate) : 'Immediate'}</p>
            </div>
            <div>
              <p className="text-muted">Input Tax Credit (ITC)</p>
              <p className="font-medium">{bill.itcEligible ? 'Eligible for credit' : 'Ineligible (costs capitalized)'}</p>
            </div>
            <div>
              <p className="text-muted">Warehouse</p>
              <p className="font-medium">{bill.warehouseId ? 'Stock tracked' : 'No warehouse (services/direct)'}</p>
            </div>
            {bill.purchaseOrderId && (
              <div>
                <p className="text-muted">Purchase Order</p>
                <DocLink to={`/purchases/orders/${bill.purchaseOrderId}`}>View PO</DocLink>
              </div>
            )}
            {bill.goodsReceiptId && (
              <div>
                <p className="text-muted">Goods Receipt</p>
                <DocLink to={`/purchases/receipts/${bill.goodsReceiptId}`}>View GRN</DocLink>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bill Totals" />
          <CardBody>
            {bill.amounts ? <TotalsPanel totals={bill.amounts} /> : <p className="text-sm text-muted">No totals</p>}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Billed items" />
        <DataTable caption="Billed items" hideCaption columns={lineColumns} rows={bill.lines} rowKey={(l) => l.id} />
      </Card>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel supplier bill">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Cancelling will reverse the Trade Payables journal and undo inventory cost effects. Only unpaid bills can be cancelled.
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

interface EditableBillLine {
  itemId: string;
  description: string;
  qty: string;
  unitPrice: string;
  discountPercent?: string | undefined;
  discountAmount?: string | undefined;
  taxClassId?: string | undefined;
  sourceLineId?: string | undefined;
  goodsReceiptLineId?: string | undefined;
}

function SupplierBillEditor({
  bill,
  grnIdPreset,
  poIdPreset,
  allowedEntities,
}: {
  bill: SupplierBill | null;
  grnIdPreset: string | null;
  poIdPreset: string | null;
  allowedEntities: Array<{ id: string; legalName: string }>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [entityId, setEntityId] = useState(bill?.legalEntityId ?? allowedEntities[0]?.id ?? '');
  const [supplierId, setSupplierId] = useState(bill?.supplierId ?? '');
  const [warehouseId, setWarehouseId] = useState(bill?.warehouseId ?? '');
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState(bill?.supplierInvoiceNumber ?? '');
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState(bill?.supplierInvoiceDate ?? todayIST());
  const [docDate, setDocDate] = useState(bill?.docDate ?? todayIST());
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? '');
  const [itcEligible, setItcEligible] = useState(bill?.itcEligible ?? true);
  const [purchaseOrderId, setPurchaseOrderId] = useState(bill?.purchaseOrderId ?? poIdPreset ?? '');
  const [goodsReceiptId, setGoodsReceiptId] = useState(bill?.goodsReceiptId ?? grnIdPreset ?? '');
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const [lines, setLines] = useState<EditableBillLine[]>(
    bill?.lines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice ?? '0.00',
      discountPercent: l.discountPercent ?? undefined,
      discountAmount: l.discountAmount ?? undefined,
      sourceLineId: l.sourceLineId ?? undefined,
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
    mutationFn: async (postNow: boolean) => {
      setError(null);
      const payload: CreateSupplierBillInput = {
        legalEntityId: entityId,
        supplierId,
        warehouseId: warehouseId || undefined,
        purchaseOrderId: purchaseOrderId || undefined,
        goodsReceiptId: goodsReceiptId || undefined,
        supplierInvoiceNumber,
        supplierInvoiceDate,
        docDate,
        dueDate: dueDate || undefined,
        itcEligible,
        notes: notes || undefined,
        lines: lines.map((l) => ({
          itemId: l.itemId,
          description: l.description || '',
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent || undefined,
          discountAmount: l.discountAmount || undefined,
          taxClassId: l.taxClassId || undefined,
          sourceLineId: l.sourceLineId || undefined,
          goodsReceiptLineId: l.goodsReceiptLineId || undefined,
        })),
      };

      let resultBill: SupplierBill;
      if (bill) {
        resultBill = await api(`/supplier-bills/${bill.id}`, {
          method: 'PATCH',
          body: payload,
          schema: supplierBillSchema,
        });
      } else {
        resultBill = await api('/supplier-bills', {
          method: 'POST',
          body: payload,
          schema: supplierBillSchema,
        });
      }

      if (postNow) {
        resultBill = await api(`/supplier-bills/${resultBill.id}/post`, {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          schema: supplierBillSchema,
        });
      }
      return resultBill;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['supplier-bills'] });
      void queryClient.invalidateQueries({ queryKey: ['payables'] });
      navigate(`/purchases/bills/${saved.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const discardMutation = useMutation({
    mutationFn: async () => {
      if (!bill) return;
      return api(`/supplier-bills/${bill.id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['supplier-bills'] });
      navigate('/purchases/bills');
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const updateLine = (index: number, patch: Partial<EditableBillLine>) => {
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
            <Link to="/purchases/bills" className="text-accent underline-offset-2 hover:underline">
              ← Supplier bills
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            {bill ? `Edit draft supplier bill ${bill.number ?? ''}` : 'New supplier bill'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {bill && (
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
            Post bill (create payable)
          </Button>
        </div>
      </div>

      {error && <InlineAlert tone="danger" className="mt-4">{error}</InlineAlert>}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Bill header" />
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
            <FormField label="Supplier invoice number" required>
              {(f) => <Input {...f} placeholder="e.g. INV-2024-001" value={supplierInvoiceNumber} onChange={(e) => setSupplierInvoiceNumber(e.target.value)} />}
            </FormField>
            <FormField label="Supplier invoice date" required>
              {(f) => <Input {...f} type="date" value={supplierInvoiceDate} onChange={(e) => setSupplierInvoiceDate(e.target.value)} />}
            </FormField>
            <FormField label="Posting date" required>
              {(f) => <Input {...f} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            <FormField label="Due date">
              {(f) => <Input {...f} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
            </FormField>
            <FormField label="Destination warehouse">
              {(f) => (
                <Select {...f} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">No stock (expense / service)</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.code})</option>
                  ))}
                </Select>
              )}
            </FormField>
            <div className="flex items-center pt-6">
              <Checkbox
                label="Eligible for GST Input Tax Credit (ITC)"
                checked={itcEligible}
                onChange={(e) => setItcEligible(e.target.checked)}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Estimated Totals" />
          <CardBody>
            {bill?.amounts ? (
              <TotalsPanel totals={bill.amounts} />
            ) : (
              <p className="text-sm text-muted">Totals will calculate when saved.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Bill line items" />
        <CardBody className="flex flex-col gap-4">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-1 gap-3 rounded-md border border-border p-4 sm:grid-cols-6 items-end">
              <div className="sm:col-span-2">
                <FormField label="Item / Service" required>
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
                      <option value="">Select item…</option>
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
              + Add bill line
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
