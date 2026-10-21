import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  itemSchema,
  partySchema,
  taxClassSchema,
  PURCHASE_STATUS_LABELS,
  type Permission,
  type PurchaseDocType,
  type PurchaseDocStatus,
  type PurchaseTotals,
  type PurchaseOrder,
  type GoodsReceipt,
  type SupplierBill,
} from '@bizmgmt/contracts';
import { Button, StatusBadge, formatINR, type StatusTone } from '@bizmgmt/ui';
import { api, downloadFile } from '../../lib/api';
import { errorMessage, listOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';

export interface PurchaseDocConfig {
  type: PurchaseDocType;
  api: string;
  route: string;
  one: string;
  many: string;
  editPermission: Permission;
  viewPermissions: Permission[];
}

export const PURCHASE_DOCS: Record<PurchaseDocType, PurchaseDocConfig> = {
  purchase_order: {
    type: 'purchase_order',
    api: '/purchase-orders',
    route: '/purchases/orders',
    one: 'Purchase order',
    many: 'Purchase orders',
    editPermission: 'purchase.edit',
    viewPermissions: ['purchase.edit', 'purchase.issue', 'receipt.post', 'report.financial'],
  },
  goods_receipt: {
    type: 'goods_receipt',
    api: '/goods-receipts',
    route: '/purchases/receipts',
    one: 'Goods receipt',
    many: 'Goods receipts',
    editPermission: 'receipt.post',
    viewPermissions: ['receipt.post', 'stock.view', 'purchase.edit'],
  },
  supplier_bill: {
    type: 'supplier_bill',
    api: '/supplier-bills',
    route: '/purchases/bills',
    one: 'Supplier bill',
    many: 'Supplier bills',
    editPermission: 'purchase.edit',
    viewPermissions: ['purchase.edit', 'bill.post', 'bill.cancel', 'report.financial'],
  },
};

export const docRoute = (type: PurchaseDocType, id: string) => `${PURCHASE_DOCS[type].route}/${id}`;

export const DocLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="font-mono text-accent underline-offset-2 hover:underline">
    {children}
  </Link>
);

const TONES: Record<PurchaseDocStatus, StatusTone> = {
  draft: 'neutral',
  issued: 'info',
  partially_received: 'warning',
  received: 'success',
  partially_billed: 'warning',
  billed: 'success',
  posted: 'success',
  closed: 'neutral',
  cancelled: 'danger',
};

export const PurchaseStatus = ({ status }: { status: PurchaseDocStatus }) => (
  <StatusBadge tone={TONES[status] ?? 'neutral'} label={PURCHASE_STATUS_LABELS[status] ?? status} />
);

export const BillPaymentStatus = ({ bill }: { bill: SupplierBill }) => {
  if (bill.status !== 'posted') return null;
  const tone: StatusTone = bill.paymentStatus === 'paid' ? 'success' : bill.paymentStatus === 'partially_paid' ? 'warning' : 'neutral';
  const label = bill.paymentStatus === 'paid' ? 'Paid' : bill.paymentStatus === 'partially_paid' ? 'Part-paid' : 'Unpaid';
  return <StatusBadge tone={tone} label={label} />;
};

export const rupees = (amount: string | null | undefined) => (amount ? formatINR(amount) : '—');
export const qty = (q: string | null | undefined) => q ?? '0';

export function todayIST(): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}

export function TotalsPanel({ totals }: { totals: PurchaseTotals }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
      <dt className="text-muted">Gross amount</dt>
      <dd className="tabular text-right">{rupees(totals.gross)}</dd>
      {totals.discount !== '0.00' && (
        <>
          <dt className="text-muted">Line discount</dt>
          <dd className="tabular text-right text-success">-{rupees(totals.discount)}</dd>
        </>
      )}
      <dt className="text-muted">Taxable value</dt>
      <dd className="tabular text-right">{rupees(totals.taxable)}</dd>
      {totals.cgst !== '0.00' && (
        <>
          <dt className="text-muted">CGST</dt>
          <dd className="tabular text-right">{rupees(totals.cgst)}</dd>
        </>
      )}
      {totals.sgst !== '0.00' && (
        <>
          <dt className="text-muted">SGST</dt>
          <dd className="tabular text-right">{rupees(totals.sgst)}</dd>
        </>
      )}
      {totals.igst !== '0.00' && (
        <>
          <dt className="text-muted">IGST</dt>
          <dd className="tabular text-right">{rupees(totals.igst)}</dd>
        </>
      )}
      {totals.cess !== '0.00' && (
        <>
          <dt className="text-muted">CESS</dt>
          <dd className="tabular text-right">{rupees(totals.cess)}</dd>
        </>
      )}
      <dt className="text-muted">Subtotal</dt>
      <dd className="tabular text-right">{rupees(totals.subtotal)}</dd>
      {totals.roundOff !== '0.00' && (
        <>
          <dt className="text-muted">Round off</dt>
          <dd className="tabular text-right">{rupees(totals.roundOff)}</dd>
        </>
      )}
      <dt className="border-t border-border pt-2 text-base font-semibold">Total</dt>
      <dd className="border-t border-border pt-2 tabular text-right text-base font-semibold">{rupees(totals.grand)}</dd>
    </dl>
  );
}

export function PurchaseOrderPdfControl({ po }: { po: PurchaseOrder }) {
  const download = useMutation({
    mutationFn: async () => {
      await downloadFile(`/purchase-orders/${po.id}/pdf`, `Purchase_Order_${po.number ?? po.id}.pdf`);
    },
  });
  if (po.status === 'draft') return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => download.mutate()}
      disabled={download.isPending}
    >
      {download.isPending ? 'Downloading…' : 'Download PDF'}
    </Button>
  );
}

export function useSuppliers(search: string = '') {
  const key = useTenantQueryKey('suppliers', search);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ role: 'supplier', limit: '100' });
      if (search) p.set('q', search);
      return api(`/parties?${p.toString()}`, { schema: pageSchemaOf(partySchema), signal }).then((r) => r.data);
    },
  });
}

export function usePurchaseItems(search: string = '') {
  const key = useTenantQueryKey('purchase-items', search);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ limit: '100' });
      if (search) p.set('q', search);
      return api(`/items?${p.toString()}`, { schema: pageSchemaOf(itemSchema), signal }).then((r) => r.data);
    },
  });
}

export function useTaxClasses() {
  const key = useTenantQueryKey('tax-classes');
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api('/tax-classes', { schema: listOf(taxClassSchema), signal }).then((r) => r.data),
  });
}

