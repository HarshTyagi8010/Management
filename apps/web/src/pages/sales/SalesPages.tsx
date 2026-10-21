import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { salesDocumentSchema, SALES_STATUS_LABELS, stateName, type Address, type SalesDocType, type SalesDocument, type SalesLine } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, ErrorState, FormField, InlineAlert, Input, PermissionDenied, Select, Skeleton, formatBusinessDate, formatQuantity, type Column } from '@bizmgmt/ui';
import { useSession } from '../../auth/session';
import { formatDateTimeIST } from '../../app/permissions';
import { PageHeader } from '../../components/forms';
import { api, ApiError, newIdempotencyKey } from '../../lib/api';
import { errorMessage, pageSchemaOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { usePageTitle } from '../usePageTitle';
import { SalesEditor } from './SalesEditor';
import { DocLink, docRoute, docTitle, DOCS, EinvoiceBadge, PaymentStatus, PdfControl, rupees, SALES_QUERIES, SalesStatus, TotalsPanel, type DocConfig } from './shared';

const HINTS: Record<SalesDocType, string> = {
  quotation: 'Quotations and proforma invoices. Neither is a tax invoice; they are numbered when sent.',
  sales_order: 'Confirming an order numbers it and reserves its goods in the order’s warehouse.',
  dispatch: 'Goods leave the warehouse with a dispatch when that is your stock-out point. Each prints as a delivery challan.',
  sales_invoice: 'Tax invoices and bills of supply. Issuing numbers the invoice and posts it; an issued invoice can only be cancelled.',
};

export function SalesListPage({ type }: { type: SalesDocType }) {
  const config = DOCS[type];
  usePageTitle(config.many);
  const { can, tenantContext } = useSession();
  const header = (
    <PageHeader
      title={config.many}
      description={HINTS[type]}
      actions={
        can(config.editPermission) ? (
          <Button asChild>
            <Link to={`${config.route}/new`}>New {config.one.toLowerCase()}</Link>
          </Button>
        ) : undefined
      }
    />
  );
  if (!tenantContext) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  if (!config.viewPermissions.some((p) => can(p))) return <>{header}<Card className="mt-6"><PermissionDenied permission={config.viewPermissions[0] ?? 'report.sales'} /></Card></>;
  return (
    <>
      {header}
      <DocList config={config} />
    </>
  );
}

function DocList({ config }: { config: DocConfig }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const key = useTenantQueryKey('sales-docs', config.type, status, search);
  const rows = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ limit: '25' });
      if (status) p.set('status', status);
      if (search) p.set('q', search);
      if (pageParam) p.set('cursor', pageParam);
      return api(`${config.api}?${p.toString()}`, { schema: pageSchemaOf(salesDocumentSchema), signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const columns: Column<SalesDocument>[] = [
    { key: 'number', header: config.one, primary: true, render: (d) => <DocLink to={`${config.route}/${d.id}`}>{d.number ?? 'Draft'}</DocLink> },
    { key: 'date', header: 'Date', render: (d) => <span className="tabular whitespace-nowrap">{formatBusinessDate(d.docDate)}</span> },
    { key: 'party', header: 'Customer', render: (d) => d.partyName },
    { key: 'total', header: 'Total', align: 'end', render: (d) => <span className="tabular">{d.totals ? rupees(d.totals.grand) : '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <span className="flex flex-wrap gap-1">
          <SalesStatus status={d.status} />
          <PaymentStatus doc={d} />
        </span>
      ),
    },
  ];
  const data = rows.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card className="mt-6">
      <form
        className="flex flex-wrap items-end gap-3 px-5 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <FormField label="Status" className="w-full sm:w-48">
          {(f) => (
            <Select {...f} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {config.statuses.map((s) => (
                <option key={s} value={s}>{SALES_STATUS_LABELS[s]}</option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Number or customer" className="min-w-0 flex-1 sm:max-w-xs">
          {(f) => <Input {...f} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}
        </FormField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <div className="py-4">
        {rows.isPending ? (
          <Skeleton className="mx-5 h-40" />
        ) : rows.isError ? (
          <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />
        ) : (
          <DataTable caption={config.many} hideCaption columns={columns} rows={data} rowKey={(d) => d.id} empty={<EmptyState title={`No ${config.many.toLowerCase()}`} description={search || status ? 'Nothing matches these filters.' : `${config.many} you create appear here.`} />} />
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

export function SalesDocPage({ type }: { type: SalesDocType }) {
  const config = DOCS[type];
  const { id = 'new' } = useParams();
  const key = useTenantQueryKey('sales-doc', id);
  const doc = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api(`${config.api}/${id}`, { schema: salesDocumentSchema, signal }),
    enabled: id !== 'new',
    // PDFs are made by the worker shortly after numbering: check back for a while.
    refetchInterval: (q) => {
      const d = q.state.data;
      const waiting = d && d.number && d.docType !== 'sales_order' && !['discarded'].includes(d.status) && (!d.pdf || d.pdf.status === 'pending');
      return waiting && q.state.dataUpdateCount < 40 ? 3000 : false;
    },
  });
  usePageTitle(id === 'new' ? `New ${config.one.toLowerCase()}` : doc.data ? docTitle(doc.data) : config.one);
  if (id === 'new') return <SalesEditor config={config} doc={null} />;
  if (doc.isPending) return <Skeleton className="h-64" />;
  if (doc.isError) return <ErrorState message={errorMessage(doc.error)} onRetry={() => void doc.refetch()} />;
  if (doc.data.status === 'draft') return <SalesEditor key={doc.data.version} config={config} doc={doc.data} actions={(saving) => <DraftActions config={config} doc={doc.data} saving={saving} />} />;
  return <SalesView config={config} doc={doc.data} />;
}

interface Command {
  path: string;
  body?: Record<string, unknown>;
  /** Commands that number a document or move stock need an Idempotency-Key. */
  once?: boolean;
}

function useCommand(config: DocConfig, doc: SalesDocument) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = useTenantQueryKey('sales-doc', doc.id);
  return useMutation({
    mutationFn: (c: Command) => api(`${config.api}/${doc.id}/${c.path}`, { method: 'POST', body: { version: doc.version, ...c.body }, schema: salesDocumentSchema, ...(c.once ? { idempotencyKey: newIdempotencyKey() } : {}) }),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ predicate: (q) => SALES_QUERIES.includes(String(q.queryKey[2])) });
      if (next.id !== doc.id) navigate(docRoute(next.docType, next.id));
      else queryClient.setQueryData(key, next);
    },
  });
}

const overLimit = (err: unknown) => err instanceof ApiError && err.details.some((d) => d.path === 'creditLimit');

/** Commands on a draft; they wait while the draft is being saved (they act on the saved version). */
function DraftActions({ config, doc, saving }: { config: DocConfig; doc: SalesDocument; saving: boolean }) {
  const { canIn } = useSession();
  const command = useCommand(config, doc);
  const primary = {
    quotation: { label: 'Send (number it)', path: 'send', permission: 'quotation.issue' as const, body: {} },
    sales_order: { label: 'Confirm order', path: 'confirm', permission: 'salesorder.confirm' as const, body: {} },
    dispatch: { label: 'Dispatch now', path: 'dispatch', permission: 'dispatch.post' as const, body: {} },
    sales_invoice: { label: 'Issue invoice', path: 'issue', permission: 'invoice.issue' as const, body: doc.totals ? { expectedTotal: doc.totals.grand } : {} },
  }[config.type];
  const canOverride = canIn('credit.override', doc.legalEntityId);
  return (
    <>
      {canIn(primary.permission, doc.legalEntityId) && (
        <Button variant="secondary" onClick={() => command.mutate({ path: primary.path, body: primary.body, once: true })} disabled={command.isPending || saving}>
          {primary.label}
        </Button>
      )}
      <Button variant="ghost" onClick={() => command.mutate({ path: 'discard' })} disabled={command.isPending || saving}>
        Discard draft
      </Button>
      {command.isError && (
        <div className="flex w-full flex-col gap-2">
          <InlineAlert>{errorMessage(command.error)}</InlineAlert>
          {overLimit(command.error) && canOverride && (
            <div>
              <Button variant="danger" onClick={() => command.mutate({ path: primary.path, body: { ...primary.body, overrideCreditLimit: true }, once: true })} disabled={command.isPending}>
                Approve over the credit limit and {primary.label.toLowerCase()}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ReasonDialog({ title, description, confirm, onConfirm, onClose, pending, error }: { title: string; description: string; confirm: string; onConfirm: (reason: string) => void; onClose: () => void; pending: boolean; error: unknown }) {
  const [reason, setReason] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onConfirm(reason);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {Boolean(error) && <InlineAlert>{errorMessage(error)}</InlineAlert>}
        <FormField label="Reason" required hint="Kept in the audit log">
          {(f) => <Input {...f} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="danger" disabled={pending || reason.trim().length < 5}>
            {confirm}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ViewActions({ config, doc }: { config: DocConfig; doc: SalesDocument }) {
  const { canIn } = useSession();
  const entities = useLegalEntities();
  const command = useCommand(config, doc);
  const [ending, setEnding] = useState<null | { path: 'cancel' | 'close'; title: string; description: string; confirm: string }>(null);
  const atDispatch = entities.data?.find((e) => e.id === doc.legalEntityId)?.workflow.stockOutPoint !== 'invoice';
  const e = doc.legalEntityId;
  const buttons: Array<{ label: string; run: () => void; variant?: 'secondary' | 'ghost' | 'danger' }> = [];
  if (doc.docType === 'quotation' && canIn('quotation.edit', e)) {
    if (doc.status === 'sent') {
      buttons.push({ label: 'Mark accepted', run: () => command.mutate({ path: 'accept' }) });
      buttons.push({ label: 'Mark rejected', run: () => command.mutate({ path: 'reject' }), variant: 'ghost' });
      buttons.push({ label: 'Revise', run: () => command.mutate({ path: 'revise' }), variant: 'ghost' });
    }
    if (doc.status === 'accepted') {
      if (canIn('salesorder.edit', e)) buttons.push({ label: 'Convert to sales order', run: () => command.mutate({ path: 'convert', body: { to: 'sales_order' } }) });
      if (canIn('invoice.edit', e)) buttons.push({ label: 'Convert to invoice', run: () => command.mutate({ path: 'convert', body: { to: 'sales_invoice' } }), variant: 'secondary' });
    }
  }
  if (doc.docType === 'sales_order' && (doc.status === 'confirmed' || doc.status === 'partially_fulfilled')) {
    if (atDispatch && canIn('dispatch.post', e)) buttons.push({ label: 'Create dispatch', run: () => command.mutate({ path: 'dispatches' }) });
    if (canIn('invoice.edit', e)) buttons.push({ label: 'Create invoice', run: () => command.mutate({ path: 'invoices' }), variant: 'secondary' });
    if (canIn('salesorder.cancel', e)) {
      buttons.push(
        doc.status === 'confirmed'
          ? { label: 'Cancel order', variant: 'ghost', run: () => setEnding({ path: 'cancel', title: 'Cancel this order?', description: 'Its reservations are released. The number is kept.', confirm: 'Cancel order' }) }
          : { label: 'Close the rest', variant: 'ghost', run: () => setEnding({ path: 'close', title: 'Close the rest of this order?', description: 'What is not yet fulfilled will not be delivered; its reservations are released.', confirm: 'Close order' }) },
      );
    }
  }
  if (doc.docType === 'dispatch' && (doc.status === 'dispatched' || doc.status === 'partially_invoiced')) {
    if (canIn('invoice.edit', e)) buttons.push({ label: 'Create invoice', run: () => command.mutate({ path: 'invoices' }) });
    if (doc.status === 'dispatched' && canIn('dispatch.post', e)) buttons.push({ label: 'Cancel dispatch', variant: 'ghost', run: () => setEnding({ path: 'cancel', title: 'Cancel this dispatch?', description: 'The goods return to the warehouse at the cost they left with, and the order gets the quantities back.', confirm: 'Cancel dispatch' }) });
  }
  if (doc.docType === 'sales_invoice' && doc.status === 'issued' && canIn('invoice.cancel', e)) {
    buttons.push({ label: 'Cancel invoice', variant: 'ghost', run: () => setEnding({ path: 'cancel', title: `Cancel ${doc.number}?`, description: 'The number is kept and marked cancelled; its accounting entry is reversed and any goods it took out come back.', confirm: 'Cancel invoice' }) });
  }
  return (
    <>
      {buttons.map((b) => (
        <Button key={b.label} variant={b.variant ?? 'primary'} onClick={b.run} disabled={command.isPending}>
          {b.label}
        </Button>
      ))}
      {command.isError && !ending && <InlineAlert className="w-full">{errorMessage(command.error)}</InlineAlert>}
      {ending && (
        <ReasonDialog
          {...ending}
          pending={command.isPending}
          error={command.error}
          onClose={() => {
            setEnding(null);
            command.reset();
          }}
          onConfirm={(reason) => command.mutate({ path: ending.path, body: { reason }, once: true }, { onSuccess: () => setEnding(null) })}
        />
      )}
    </>
  );
}

const addressText = (a: Address | null) => (a ? [a.line1, a.line2, a.city, `${stateName(a.stateCode) ?? a.stateCode} ${a.pincode}`].filter(Boolean).join(', ') : 'No address');
const qty = (l: SalesLine, v: string | undefined) => (v === undefined ? '—' : `${formatQuantity(v)} ${l.unitCode}`);

function SalesView({ config, doc }: { config: DocConfig; doc: SalesDocument }) {
  const prices = doc.totals !== undefined;
  const columns: Column<SalesLine>[] = [
    {
      key: 'item',
      header: 'Item',
      primary: true,
      render: (l) => (
        <span className="flex flex-col">
          <span className="font-medium">{l.itemName}</span>
          <span className="font-mono text-xs text-muted">
            {l.sku} · HSN/SAC {l.hsnSac}
            {l.reverseCharge ? ' · reverse charge' : ''}
          </span>
        </span>
      ),
    },
    { key: 'qty', header: 'Quantity', align: 'end', render: (l) => <span className="whitespace-nowrap">{qty(l, l.qty)}</span> },
    ...(prices
      ? [
          { key: 'price', header: 'Price', align: 'end' as const, render: (l: SalesLine) => rupees(l.unitPrice) },
          { key: 'taxable', header: 'Taxable value', align: 'end' as const, render: (l: SalesLine) => rupees(l.taxable) },
          { key: 'rate', header: 'GST', align: 'end' as const, render: (l: SalesLine) => (l.taxRate === null ? 'No tax' : `${l.taxRate}%`) },
          { key: 'total', header: 'Total', align: 'end' as const, render: (l: SalesLine) => rupees(l.total) },
        ]
      : []),
    ...(doc.docType === 'sales_order'
      ? [
          { key: 'reserved', header: 'Reserved', align: 'end' as const, render: (l: SalesLine) => <span className="whitespace-nowrap">{qty(l, l.reservedQty)}</span> },
          { key: 'fulfilled', header: 'Fulfilled', align: 'end' as const, render: (l: SalesLine) => <span className="whitespace-nowrap">{qty(l, l.fulfilledQty)}</span> },
        ]
      : []),
    ...(doc.docType === 'sales_order' || doc.docType === 'dispatch' ? [{ key: 'invoiced', header: 'Invoiced', align: 'end' as const, render: (l: SalesLine) => <span className="whitespace-nowrap">{qty(l, l.invoicedQty)}</span> }] : []),
  ];
  const events = [
    `Created ${formatDateTimeIST(doc.createdAt)}${doc.createdBy ? ` by ${doc.createdBy.name}` : ''}`,
    doc.issuedAt && `Numbered ${formatDateTimeIST(doc.issuedAt)}${doc.issuedBy ? ` by ${doc.issuedBy.name}` : ''}`,
    doc.cancelledAt && `${doc.status === 'closed' ? 'Closed' : 'Cancelled'} ${formatDateTimeIST(doc.cancelledAt)}${doc.cancelledBy ? ` by ${doc.cancelledBy.name}` : ''}${doc.cancelReason ? `: ${doc.cancelReason}` : ''}`,
  ].filter(Boolean);
  const facts: Array<[string, string]> = [
    ['Date', formatBusinessDate(doc.docDate)],
    ['Place of supply', `${stateName(doc.placeOfSupply) ?? doc.placeOfSupply} (${doc.placeOfSupply})${doc.placeOfSupplyOverridden ? ', chosen' : ''}`],
    ['Supply', doc.supply === 'intra' ? 'Within the state (CGST + SGST)' : 'Between states (IGST)'],
  ];
  if (doc.validUntil) facts.push(['Valid until', formatBusinessDate(doc.validUntil)]);
  if (doc.dueDate && doc.docType === 'sales_invoice') facts.push(['Due', formatBusinessDate(doc.dueDate)]);
  if (doc.expectedDate) facts.push(['Expected delivery', formatBusinessDate(doc.expectedDate)]);
  if (doc.warehouseName) facts.push(['Warehouse', doc.warehouseName]);
  if (doc.customerReference) facts.push(['Customer’s reference', doc.customerReference]);
  if (doc.transport?.vehicleNumber) facts.push(['Vehicle', doc.transport.vehicleNumber]);
  if (doc.docType === 'dispatch') facts.push(['E-way bill', doc.transport?.ewayBillNumber ? `${doc.transport.ewayBillNumber} (recorded)` : 'Not generated by this system']);
  if (doc.outstanding !== undefined && doc.outstanding !== null && doc.status === 'issued') facts.push(['Outstanding', rupees(doc.outstanding)]);

  return (
    <>
      <p className="text-sm">
        <Link to={config.route} className="text-accent underline-offset-2 hover:underline">
          {config.many}
        </Link>
      </p>
      <PageHeader title={docTitle(doc)} description={`${doc.partyName} · ${formatBusinessDate(doc.docDate)}`} actions={<ViewActions config={config} doc={doc} />} />
      <Card className="mt-6">
        <CardHeader
          title="Status"
          description={events.join(' · ')}
          action={
            <span className="flex flex-wrap gap-1">
              <SalesStatus status={doc.status} />
              <PaymentStatus doc={doc} />
              <EinvoiceBadge doc={doc} />
            </span>
          }
        />
        <CardBody className="flex flex-col gap-3 pt-3">
          <PdfControl doc={doc} config={config} />
          {(doc.source || doc.related.length > 0 || doc.revisionOf) && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {doc.source && (
                <li>
                  From {DOCS[doc.source.type].one.toLowerCase()} <DocLink to={docRoute(doc.source.type, doc.source.id)}>{doc.source.number ?? 'draft'}</DocLink>
                </li>
              )}
              {doc.revisionOf && (
                <li>
                  Revision {doc.revision} of <DocLink to={docRoute('quotation', doc.revisionOf.id)}>{doc.revisionOf.number ?? 'draft'}</DocLink>
                </li>
              )}
              {doc.related.map((r) => (
                <li key={r.id}>
                  {DOCS[r.type].one} <DocLink to={docRoute(r.type, r.id)}>{r.number ?? 'draft'}</DocLink> ({SALES_STATUS_LABELS[r.status as keyof typeof SALES_STATUS_LABELS]?.toLowerCase() ?? r.status})
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Customer" />
          <CardBody className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{doc.buyer.name}</p>
            <p>{doc.buyer.gstin ? `GSTIN ${doc.buyer.gstin}` : 'Unregistered (no GSTIN)'}</p>
            <p>
              <span className="text-muted">Billing: </span>
              {addressText(doc.buyer.billingAddress)}
            </p>
            {JSON.stringify(doc.buyer.shippingAddress) !== JSON.stringify(doc.buyer.billingAddress) && (
              <p>
                <span className="text-muted">Shipping: </span>
                {addressText(doc.buyer.shippingAddress)}
              </p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Details" description={`Issued under GSTIN ${doc.seller.gstin}`} />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-6">
        <div className="py-4">
          <DataTable caption="Lines" columns={columns} rows={doc.lines} rowKey={(l) => l.lineId} />
        </div>
      </Card>
      {prices && doc.totals && (
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Tax by HSN/SAC" />
            <div className="py-4">
              <DataTable
                caption="Tax by HSN/SAC"
                hideCaption
                columns={[
                  { key: 'hsn', header: 'HSN/SAC', primary: true, render: (r) => <span className="font-mono">{r.hsnSac}</span> },
                  { key: 'rate', header: 'Rate', align: 'end', render: (r) => (r.rate === null ? 'No tax' : `${r.rate}%`) },
                  { key: 'taxable', header: 'Taxable', align: 'end', render: (r) => rupees(r.taxable) },
                  { key: 'tax', header: 'Tax', align: 'end', render: (r) => rupees(sumMoney([r.cgst, r.sgst, r.utgst, r.igst, r.cess])) },
                ]}
                rows={doc.hsnSummary ?? []}
                rowKey={(r) => `${r.hsnSac}-${r.rate}-${r.reverseCharge}`}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Totals" />
            <CardBody>
              <TotalsPanel totals={doc.totals} supply={doc.supply} />
            </CardBody>
          </Card>
        </div>
      )}
      {doc.notes && <p className="mt-6 text-sm"><span className="text-muted">Notes: </span>{doc.notes}</p>}
      {doc.terms && <p className="mt-2 text-sm"><span className="text-muted">Terms: </span>{doc.terms}</p>}
    </>
  );
}

/** Adds money strings exactly (paise as BigInt): display only, the figures themselves come from the server. */
function sumMoney(values: string[]): string {
  const paise = values.reduce((acc, v) => {
    const [whole = '0', frac = ''] = v.replace('-', '').split('.');
    const p = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
    return acc + (v.startsWith('-') ? -p : p);
  }, 0n);
  const abs = paise < 0n ? -paise : paise;
  return `${paise < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
