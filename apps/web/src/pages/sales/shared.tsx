import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  gstRegistrationSchema,
  itemSchema,
  partySchema,
  SALES_STATUS_LABELS,
  type Permission,
  type SalesDocStatus,
  type SalesDocType,
  type SalesDocument,
  type SalesTotals,
} from '@bizmgmt/contracts';
import { Button, StatusBadge, formatINR, type StatusTone } from '@bizmgmt/ui';
import { api, downloadFile } from '../../lib/api';
import { errorMessage, listOf, pageSchemaOf, useTenantQueryKey } from '../../lib/queries';

export interface DocConfig {
  type: SalesDocType;
  /** API collection path. */
  api: string;
  /** Web route base. */
  route: string;
  one: string;
  many: string;
  editPermission: Permission;
  viewPermissions: Permission[];
  statuses: SalesDocStatus[];
}

/** Matches the API's view permissions (permission-matrix.md, Phase 7 notes). */
export const DOCS: Record<SalesDocType, DocConfig> = {
  quotation: {
    type: 'quotation',
    api: '/quotations',
    route: '/sales/quotations',
    one: 'Quotation',
    many: 'Quotations',
    editPermission: 'quotation.edit',
    viewPermissions: ['quotation.edit', 'quotation.issue', 'report.sales', 'report.financial'],
    statuses: ['draft', 'sent', 'accepted', 'rejected', 'expired', 'revised', 'converted', 'discarded'],
  },
  sales_order: {
    type: 'sales_order',
    api: '/sales-orders',
    route: '/sales/orders',
    one: 'Sales order',
    many: 'Sales orders',
    editPermission: 'salesorder.edit',
    viewPermissions: ['salesorder.edit', 'salesorder.confirm', 'salesorder.cancel', 'dispatch.post', 'invoice.edit', 'report.sales', 'report.financial'],
    statuses: ['draft', 'confirmed', 'partially_fulfilled', 'fulfilled', 'closed', 'cancelled', 'discarded'],
  },
  dispatch: {
    type: 'dispatch',
    api: '/dispatches',
    route: '/sales/dispatches',
    one: 'Dispatch',
    many: 'Dispatches',
    editPermission: 'dispatch.post',
    viewPermissions: ['dispatch.post', 'salesorder.edit', 'invoice.edit', 'report.sales', 'report.financial'],
    statuses: ['draft', 'dispatched', 'partially_invoiced', 'invoiced', 'cancelled', 'discarded'],
  },
  sales_invoice: {
    type: 'sales_invoice',
    api: '/sales-invoices',
    route: '/sales/invoices',
    one: 'Invoice',
    many: 'Invoices',
    editPermission: 'invoice.edit',
    viewPermissions: ['invoice.edit', 'invoice.issue', 'invoice.cancel', 'report.sales', 'report.financial'],
    statuses: ['draft', 'issued', 'cancelled', 'discarded'],
  },
};

/** Printed titles (the document kind decides it: a quotation can be a proforma, an invoice a bill of supply). */
export const KIND_TITLES: Record<SalesDocument['documentKind'], string> = {
  quotation: 'Quotation',
  proforma_invoice: 'Proforma invoice',
  sales_order: 'Sales order',
  delivery_challan: 'Delivery challan',
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
};

export const docTitle = (d: Pick<SalesDocument, 'documentKind' | 'number'>) => `${KIND_TITLES[d.documentKind]} ${d.number ?? '(draft)'}`;

const TONES: Record<SalesDocStatus, StatusTone> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  rejected: 'danger',
  expired: 'warning',
  revised: 'neutral',
  converted: 'success',
  discarded: 'neutral',
  confirmed: 'info',
  partially_fulfilled: 'warning',
  fulfilled: 'success',
  closed: 'neutral',
  cancelled: 'danger',
  dispatched: 'info',
  partially_invoiced: 'warning',
  invoiced: 'success',
  issued: 'success',
};

export function SalesStatus({ status }: { status: SalesDocStatus }) {
  return <StatusBadge tone={TONES[status] ?? 'neutral'} label={SALES_STATUS_LABELS[status] ?? status} />;
}

export function PaymentStatus({ doc }: { doc: Pick<SalesDocument, 'paymentStatus' | 'status'> }) {
  if (doc.status !== 'issued' || !doc.paymentStatus) return null;
  const label = { unpaid: 'Unpaid', partially_paid: 'Partly paid', paid: 'Paid' }[doc.paymentStatus];
  return <StatusBadge tone={doc.paymentStatus === 'paid' ? 'success' : 'warning'} label={label} />;
}

/** "Not submitted to IRP" where e-invoicing applies (design-system §8: never show regulatory success that did not happen). */
export function EinvoiceBadge({ doc }: { doc: Pick<SalesDocument, 'einvoiceStatus'> }) {
  return doc.einvoiceStatus === 'not_submitted' ? <StatusBadge tone="warning" label="Not submitted to IRP" /> : null;
}

export const rupees = (v: string | null | undefined) => (v === null || v === undefined ? '—' : formatINR(v));

export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-mono font-medium text-accent underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

export const docRoute = (type: SalesDocType, id: string) => `${DOCS[type].route}/${id}`;

/** Query-key names (third part of the tenant-scoped key) that sales changes can affect. */
export const SALES_QUERIES = ['sales-docs', 'sales-doc', 'stock-summary', 'stock-ledger', 'receivables'];

// ---------------------------------------------------------------- data

export function useCustomers(search: string) {
  const key = useTenantQueryKey('customers', search);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ role: 'customer', limit: '100' });
      if (search) p.set('q', search);
      return api(`/parties?${p.toString()}`, { schema: pageSchemaOf(partySchema), signal }).then((r) => r.data);
    },
  });
}

export function useParty(id: string) {
  const key = useTenantQueryKey('party', id);
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/parties/${id}`, { schema: partySchema, signal }), enabled: id !== '' });
}

/** Items of any type for sales lines (first 100, alphabetical; search narrows). */
export function useSaleItems(search: string) {
  const key = useTenantQueryKey('sale-items', search);
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ limit: '100' });
      if (search) p.set('q', search);
      return api(`/items?${p.toString()}`, { schema: pageSchemaOf(itemSchema), signal }).then((r) => r.data);
    },
  });
}

export function useRegistrations(entityId: string) {
  const key = useTenantQueryKey('legal-entities', entityId, 'registrations');
  return useQuery({ queryKey: key, queryFn: ({ signal }) => api(`/legal-entities/${entityId}/registrations`, { schema: listOf(gstRegistrationSchema), signal }).then((r) => r.data), enabled: entityId !== '' });
}

// ------------------------------------------------------------- totals

/** Server-computed figures (the browser never computes authoritative totals: financial-policy §5). */
export function TotalsPanel({ totals, supply, caption }: { totals: SalesTotals; supply: 'intra' | 'inter'; caption?: string }) {
  const rows: Array<[string, string, boolean?]> = [['Gross value', totals.gross]];
  if (totals.discount !== '0.00') rows.push(['Discount', `−${formatINR(totals.discount)}`, true]);
  rows.push(['Taxable value', totals.taxable]);
  if (supply === 'intra') {
    rows.push(['CGST', totals.cgst]);
    if (totals.utgst !== '0.00') rows.push(['UTGST', totals.utgst]);
    else rows.push(['SGST', totals.sgst]);
  } else {
    rows.push(['IGST', totals.igst]);
  }
  if (totals.cess !== '0.00') rows.push(['Cess', totals.cess]);
  if (totals.reverseChargeTax !== '0.00') rows.push(['Tax payable by the customer (reverse charge, not included)', totals.reverseChargeTax]);
  if (totals.roundOff !== '0.00') rows.push(['Round off', totals.roundOff]);
  return (
    <div role="group" aria-label={caption ?? 'Totals'}>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([label, value, formatted]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular text-right">{formatted ? value : formatINR(value)}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="border-t border-border pt-1.5 font-semibold">Total</dt>
          <dd className="tabular border-t border-border pt-1.5 text-right text-base font-semibold">{formatINR(totals.grand)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- PDF

/** Download button for a numbered document's PDF, or its preparation state. */
export function PdfControl({ doc, config }: { doc: SalesDocument; config: DocConfig }) {
  const download = useMutation({ mutationFn: () => downloadFile(`${config.api}/${doc.id}/pdf`, `${(doc.number ?? 'document').replace(/[^A-Za-z0-9-]/g, '_')}.pdf`) });
  if (!doc.number || doc.docType === 'sales_order') return null;
  if (doc.pdf?.status === 'ready') {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" onClick={() => download.mutate()} disabled={download.isPending}>
          {download.isPending ? 'Downloading…' : `Download ${KIND_TITLES[doc.documentKind].toLowerCase()} (PDF)`}
        </Button>
        {download.isError && (
          <p role="alert" className="text-xs text-danger">
            {errorMessage(download.error)}
          </p>
        )}
      </div>
    );
  }
  if (doc.pdf?.status === 'failed') return <span className="text-sm text-danger">The PDF could not be made.</span>;
  return (
    <span className="text-sm text-muted" role="status">
      Preparing the PDF…
    </span>
  );
}

/** Today in IST as YYYY-MM-DD (the server refuses future dates). */
export const todayIST = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
