import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { calcPreviewSchema, INDIAN_STATES, salesDocumentSchema, stateName, type Item, type Permission, type SalesDocument } from '@bizmgmt/contracts';
import { Button, Card, CardBody, CardHeader, FormField, IconButton, InlineAlert, Input, PermissionDenied, Select, Skeleton } from '@bizmgmt/ui';
import { Trash2 } from 'lucide-react';
import { useSession } from '../../auth/session';
import { PageHeader } from '../../components/forms';
import { api } from '../../lib/api';
import { errorMessage, fieldErrorsOf, useLegalEntities, useTenantQueryKey } from '../../lib/queries';
import { useWarehouses, warehouseLabel } from '../inventory/shared';
import { docTitle, SALES_QUERIES, TotalsPanel, todayIST, useCustomers, useParty, useRegistrations, useSaleItems, type DocConfig } from './shared';

interface EditLine {
  key: string;
  itemId: string;
  qty: string;
  unitPrice: string;
  discountType: '' | 'percent' | 'amount';
  discountValue: string;
  sourceLineId: string | null;
}

let counter = 0;
const newLine = (partial: Partial<EditLine> = {}): EditLine => {
  counter += 1;
  return { key: `s${counter}`, itemId: '', qty: '', unitPrice: '', discountType: '', discountValue: '', sourceLineId: null, ...partial };
};

const STATES = INDIAN_STATES.filter((s) => !s.legacy);
const PRICE_EDITORS: Permission[] = ['quotation.edit', 'salesorder.edit', 'invoice.edit'];

/** Waits until a value has stopped changing (server previews while typing). */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Draft editor for quotations, orders, dispatches and invoices. Figures shown
 * while editing come from the server's calculation preview; saving stores the
 * draft and the server computes it again. Lines made from another document
 * (an order or a dispatch) keep their link and item.
 */
export function SalesEditor({ config, doc, actions }: { config: DocConfig; doc: SalesDocument | null; actions?: (saving: boolean) => React.ReactNode }) {
  const { can, canIn, canInWarehouse } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tenantKey = useTenantQueryKey();
  const entities = useLegalEntities();
  const isDispatch = config.type === 'dispatch';
  const [entityId, setEntityId] = useState(doc?.legalEntityId ?? '');
  const chosenEntity = entityId || entities.data?.find((e) => canIn(config.editPermission, e.id))?.id || '';
  const regs = useRegistrations(chosenEntity);
  const [registrationId, setRegistrationId] = useState(doc?.gstRegistrationId ?? '');
  const chosenReg = registrationId || regs.data?.[0]?.id || '';
  const [customerSearch, setCustomerSearch] = useState('');
  const customers = useCustomers(useSettled(customerSearch));
  const [partyId, setPartyId] = useState(doc?.partyId ?? '');
  const party = useParty(partyId);
  const [billingId, setBillingId] = useState(doc?.billingAddressId ?? '');
  const [shippingId, setShippingId] = useState(doc?.shippingAddressId ?? '');
  const [placeOfSupply, setPlaceOfSupply] = useState(doc?.placeOfSupplyOverridden ? doc.placeOfSupply : '');
  const [docDate, setDocDate] = useState(doc?.docDate ?? todayIST());
  const [kind, setKind] = useState<'quotation' | 'proforma'>(doc?.documentKind === 'proforma_invoice' ? 'proforma' : 'quotation');
  const [validUntil, setValidUntil] = useState(doc?.validUntil ?? '');
  const [expectedDate, setExpectedDate] = useState(doc?.expectedDate ?? '');
  const [dueDate, setDueDate] = useState(doc?.dueDate ?? '');
  const [warehouseId, setWarehouseId] = useState(doc?.warehouseId ?? '');
  const [transport, setTransport] = useState(doc?.transport ?? { vehicleNumber: '', transporterName: '', ewayBillNumber: '' });
  const [documentDiscount, setDocumentDiscount] = useState(doc?.documentDiscount && doc.documentDiscount !== '0.00' ? doc.documentDiscount : '');
  const [customerReference, setCustomerReference] = useState(doc?.customerReference ?? '');
  const [notes, setNotes] = useState(doc?.notes ?? '');
  const [terms, setTerms] = useState(doc?.terms ?? '');
  const [lines, setLines] = useState<EditLine[]>(
    doc
      ? doc.lines.map((l) => newLine({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice ?? '', discountType: l.discount?.type ?? '', discountValue: l.discount?.value ?? '', sourceLineId: l.sourceLineId }))
      : [newLine()],
  );
  const [itemSearch, setItemSearch] = useState('');
  const items = useSaleItems(useSettled(itemSearch));
  const warehouses = useWarehouses(chosenEntity || undefined);

  // Prices are entered by people who sell; someone who only dispatches goods sees quantities.
  const showPrices = PRICE_EDITORS.some((p) => can(p));
  const known = new Map<string, Pick<Item, 'id' | 'sku' | 'name' | 'baseUnitCode' | 'salePrice' | 'type'>>();
  for (const l of doc?.lines ?? []) known.set(l.itemId, { id: l.itemId, sku: l.sku, name: l.itemName, baseUnitCode: l.unitCode, salePrice: l.unitPrice ?? null, type: l.itemType });
  for (const i of items.data ?? []) if (!isDispatch || i.type === 'stock') known.set(i.id, i);

  const addresses = party.data?.addresses ?? [];
  const billing = addresses.find((a) => a.id === billingId) ?? addresses.find((a) => a.isBilling) ?? addresses[0];
  const shipping = addresses.find((a) => a.id === shippingId) ?? addresses.find((a) => a.isShipping) ?? billing;
  const registration = regs.data?.find((r) => r.id === chosenReg);
  const derivedPos = shipping?.stateCode ?? billing?.stateCode ?? registration?.stateCode ?? '';
  const pos = placeOfSupply || derivedPos;

  const lineBody = (l: EditLine) => ({
    itemId: l.itemId,
    qty: l.qty,
    ...(showPrices || !isDispatch ? { unitPrice: l.unitPrice, discount: l.discountType && l.discountValue ? { type: l.discountType, value: l.discountValue } : null } : {}),
    sourceLineId: l.sourceLineId,
  });
  const complete = chosenEntity && chosenReg && partyId && pos && lines.length > 0 && lines.every((l) => l.itemId && l.qty && (l.unitPrice || !showPrices));
  const previewInput = complete && showPrices ? JSON.stringify({ legalEntityId: chosenEntity, gstRegistrationId: chosenReg, partyId, docDate, placeOfSupply: pos, documentDiscount: documentDiscount || '0', lines: lines.map((l) => { const { sourceLineId: _s, ...rest } = lineBody(l); return rest; }) }) : null;
  const settledPreview = useSettled(previewInput);
  const previewKey = useTenantQueryKey('calc-preview', settledPreview);
  const preview = useQuery({
    queryKey: previewKey,
    queryFn: ({ signal }) => api('/calc/preview', { method: 'POST', body: JSON.parse(settledPreview ?? '{}'), schema: calcPreviewSchema, signal }),
    enabled: settledPreview !== null,
    retry: false,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: () => {
      const common = {
        gstRegistrationId: chosenReg,
        partyId,
        docDate,
        billingAddressId: billingId || null,
        shippingAddressId: shippingId || null,
        placeOfSupply: placeOfSupply || null,
        documentDiscount: documentDiscount || '0',
        customerReference,
        notes,
        terms,
        lines: lines.map(lineBody),
      };
      const specific =
        config.type === 'quotation'
          ? { validUntil: validUntil || null }
          : config.type === 'sales_order'
            ? { warehouseId: warehouseId || null, expectedDate: expectedDate || null }
            : config.type === 'dispatch'
              ? { warehouseId, transport }
              : { warehouseId: warehouseId || null, dueDate: dueDate || null };
      const body = { ...common, ...specific };
      return doc
        ? api(`${config.api}/${doc.id}`, { method: 'PATCH', body: { ...body, version: doc.version }, schema: salesDocumentSchema })
        : api(config.api, { method: 'POST', body: { ...body, legalEntityId: chosenEntity, ...(config.type === 'quotation' ? { kind } : {}) }, schema: salesDocumentSchema });
    },
    onSuccess: (saved) => {
      // The page shows the saved version at once, so a command right after saving carries the new version.
      queryClient.setQueryData([...tenantKey, 'sales-doc', saved.id], saved);
      void queryClient.invalidateQueries({ predicate: (q) => SALES_QUERIES.includes(String(q.queryKey[2])) && !(q.queryKey[2] === 'sales-doc' && q.queryKey[3] === saved.id) });
      navigate(`${config.route}/${saved.id}`, { replace: true });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const set = (key: string, patch: Partial<EditLine>) => setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const title = doc ? docTitle(doc) : `New ${config.one.toLowerCase()}`;
  const header = <PageHeader title={title} description={doc ? 'Draft: nothing is numbered or posted until you act on it below.' : undefined} />;
  if (entities.isPending) return <>{header}<Skeleton className="mt-6 h-64" /></>;
  const editable = chosenEntity ? canIn(config.editPermission, chosenEntity) : false;
  if (!editable) return <>{header}<Card className="mt-6"><PermissionDenied permission={config.editPermission} /></Card></>;
  const linkedSource = doc?.source && doc.source.type !== 'quotation';
  const warehouseOptions = (warehouses.data ?? []).filter((w) => !w.archived && (!isDispatch || canInWarehouse('dispatch.post', w)));
  const totals = preview.data?.totals ?? (doc && !preview.isFetching ? doc.totals : undefined);
  const warnings = preview.data?.warnings ?? doc?.warnings ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <>
      {header}
      <form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-6">
        {save.isError && <InlineAlert>{errorMessage(save.error)}</InlineAlert>}
        {doc?.source && (
          <InlineAlert tone="info">
            Made from {doc.source.type.replace('_', ' ')} {doc.source.number ?? ''}. {linkedSource ? 'Linked lines keep their item; you can lower quantities or remove lines.' : ''}
          </InlineAlert>
        )}
        <Card>
          <CardHeader title="Customer and details" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {!doc && (entities.data?.length ?? 0) > 1 && (
              <FormField label="Business entity" required>
                {(f) => (
                  <Select {...f} value={chosenEntity} onChange={(e) => { setEntityId(e.target.value); setRegistrationId(''); setWarehouseId(''); }}>
                    {entities.data?.filter((e) => canIn(config.editPermission, e.id)).map((e) => (
                      <option key={e.id} value={e.id}>{e.legalName}</option>
                    ))}
                  </Select>
                )}
              </FormField>
            )}
            <FormField label="Your GSTIN" required error={errors.gstRegistrationId} hint="The registration this document is issued under">
              {(f) => (
                <Select {...f} value={chosenReg} onChange={(e) => setRegistrationId(e.target.value)} disabled={Boolean(linkedSource)}>
                  {(regs.data ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{r.gstin} · {stateName(r.stateCode)}</option>
                  ))}
                </Select>
              )}
            </FormField>
            {config.type === 'quotation' && !doc && (
              <FormField label="Document">
                {(f) => (
                  <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as 'quotation' | 'proforma')}>
                    <option value="quotation">Quotation</option>
                    <option value="proforma">Proforma invoice</option>
                  </Select>
                )}
              </FormField>
            )}
            <FormField label="Date" required error={errors.docDate}>
              {(f) => <Input {...f} type="date" max={todayIST()} value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </FormField>
            {!linkedSource && (
              <FormField label="Find a customer" hint="Search by name, then choose below" className="sm:col-span-2 lg:col-span-1">
                {(f) => <Input {...f} type="search" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />}
              </FormField>
            )}
            <FormField label="Customer" required error={errors.partyId}>
              {(f) => (
                <Select {...f} value={partyId} onChange={(e) => { setPartyId(e.target.value); setBillingId(''); setShippingId(''); }} disabled={Boolean(linkedSource)}>
                  <option value="">Choose a customer</option>
                  {doc && !customers.data?.some((c) => c.id === doc.partyId) && <option value={doc.partyId}>{doc.partyName}</option>}
                  {(customers.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Billing address" error={errors.billingAddressId}>
              {(f) => (
                <Select {...f} value={billingId} onChange={(e) => setBillingId(e.target.value)} disabled={!addresses.length}>
                  <option value="">{addresses.length ? 'The customer’s billing address' : 'No address on file'}</option>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>{a.label || a.line1}, {a.city}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Shipping address" error={errors.shippingAddressId}>
              {(f) => (
                <Select {...f} value={shippingId} onChange={(e) => setShippingId(e.target.value)} disabled={!addresses.length}>
                  <option value="">{addresses.length ? 'The customer’s shipping address' : 'No address on file'}</option>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.id}>{a.label || a.line1}, {a.city}</option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Place of supply" error={errors.placeOfSupply} hint={placeOfSupply ? 'Chosen by you: recorded in the audit log' : 'From the shipping (else billing) address'}>
              {(f) => (
                <Select {...f} value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)}>
                  <option value="">{derivedPos ? `${derivedPos} · ${stateName(derivedPos) ?? ''} (from address)` : 'From the address'}</option>
                  {STATES.map((s) => (
                    <option key={s.code} value={s.code}>{s.code} · {s.name}</option>
                  ))}
                </Select>
              )}
            </FormField>
            {config.type !== 'quotation' && (
              <FormField label="Warehouse" required={isDispatch} error={errors.warehouseId} hint={config.type === 'sales_order' ? 'Stock is reserved here when you confirm' : config.type === 'sales_invoice' ? 'Where goods leave from, if the invoice is your stock-out point' : undefined}>
                {(f) => (
                  <Select {...f} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} disabled={Boolean(linkedSource)}>
                    <option value="">Choose a warehouse</option>
                    {warehouseOptions.map((w) => (
                      <option key={w.id} value={w.id}>{warehouseLabel(w)}</option>
                    ))}
                  </Select>
                )}
              </FormField>
            )}
            {config.type === 'quotation' && (
              <FormField label="Valid until" error={errors.validUntil}>
                {(f) => <Input {...f} type="date" min={docDate} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}
              </FormField>
            )}
            {config.type === 'sales_order' && (
              <FormField label="Expected delivery" error={errors.expectedDate}>
                {(f) => <Input {...f} type="date" min={docDate} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />}
              </FormField>
            )}
            {config.type === 'sales_invoice' && (
              <FormField label="Due date" error={errors.dueDate} hint="Empty: from the customer’s payment terms">
                {(f) => <Input {...f} type="date" min={docDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
              </FormField>
            )}
            <FormField label="Customer’s reference" error={errors.customerReference} hint="Their PO number, if any">
              {(f) => <Input {...f} maxLength={60} value={customerReference} onChange={(e) => setCustomerReference(e.target.value)} />}
            </FormField>
          </CardBody>
        </Card>

        {isDispatch && (
          <Card>
            <CardHeader title="Transport" description="Printed on the delivery challan. This system does not generate e-way bills; record the number if you have one." />
            <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormField label="Vehicle number" error={errors['transport.vehicleNumber']}>
                {(f) => <Input {...f} maxLength={20} value={transport.vehicleNumber} onChange={(e) => setTransport({ ...transport, vehicleNumber: e.target.value })} />}
              </FormField>
              <FormField label="Transporter" error={errors['transport.transporterName']}>
                {(f) => <Input {...f} maxLength={80} value={transport.transporterName} onChange={(e) => setTransport({ ...transport, transporterName: e.target.value })} />}
              </FormField>
              <FormField label="E-way bill number" error={errors['transport.ewayBillNumber']} hint="12 digits, generated elsewhere">
                {(f) => <Input {...f} inputMode="numeric" maxLength={12} value={transport.ewayBillNumber} onChange={(e) => setTransport({ ...transport, ewayBillNumber: e.target.value.trim() })} />}
              </FormField>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Lines" />
          <CardBody className="flex flex-col gap-4">
            {!linkedSource && (
              <FormField label={isDispatch ? 'Find stock items' : 'Find items'} hint="Search by name or code, then choose them below." className="sm:max-w-sm">
                {(f) => <Input {...f} type="search" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} />}
              </FormField>
            )}
            {errors.lines && <p className="text-xs font-medium text-danger">{errors.lines}</p>}
            <ol className="flex flex-col gap-3">
              {lines.map((line, index) => {
                const n = index + 1;
                const item = known.get(line.itemId);
                const computed = preview.data?.lines[index];
                return (
                  <li key={line.key} className="grid grid-cols-1 items-start gap-3 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_7rem_8rem_7rem_7rem_auto]">
                    <FormField label={`Item ${n}`} required error={errors[`lines.${index}.itemId`] ?? errors[`lines.${index}.sourceLineId`]}>
                      {(f) => (
                        <Select
                          {...f}
                          value={line.itemId}
                          disabled={line.sourceLineId !== null}
                          onChange={(e) => {
                            const chosen = known.get(e.target.value);
                            set(line.key, { itemId: e.target.value, unitPrice: line.unitPrice || chosen?.salePrice || '' });
                          }}
                        >
                          <option value="">Choose an item</option>
                          {[...known.values()].map((i) => (
                            <option key={i.id} value={i.id}>{i.sku} · {i.name}</option>
                          ))}
                        </Select>
                      )}
                    </FormField>
                    <FormField label={`Quantity ${n}${item ? ` (${item.baseUnitCode})` : ''}`} required error={errors[`lines.${index}.qty`]}>
                      {(f) => <Input {...f} inputMode="decimal" className="tabular" value={line.qty} onChange={(e) => set(line.key, { qty: e.target.value.trim() })} />}
                    </FormField>
                    {showPrices && (
                      <>
                        <FormField label={`Price ${n}`} required error={errors[`lines.${index}.unitPrice`]}>
                          {(f) => <Input {...f} inputMode="decimal" className="tabular" value={line.unitPrice} onChange={(e) => set(line.key, { unitPrice: e.target.value.trim() })} />}
                        </FormField>
                        <FormField label={`Discount ${n}`}>
                          {(f) => (
                            <Select {...f} value={line.discountType} onChange={(e) => set(line.key, { discountType: e.target.value as EditLine['discountType'] })}>
                              <option value="">None</option>
                              <option value="percent">Percent</option>
                              <option value="amount">Amount (₹)</option>
                            </Select>
                          )}
                        </FormField>
                        <FormField label={`Discount value ${n}`} error={errors[`lines.${index}.discount`]}>
                          {(f) => <Input {...f} inputMode="decimal" className="tabular" disabled={!line.discountType} value={line.discountValue} onChange={(e) => set(line.key, { discountValue: e.target.value.trim() })} />}
                        </FormField>
                      </>
                    )}
                    <div className="flex items-center gap-3 sm:pt-6">
                      {computed && (
                        <span className="tabular text-sm whitespace-nowrap">
                          <span className="sr-only">Line {n} total </span>₹{computed.total}
                        </span>
                      )}
                      <IconButton label={`Remove line ${n}`} icon={<Trash2 size={16} />} onClick={() => setLines(lines.filter((l) => l.key !== line.key))} disabled={lines.length === 1} />
                    </div>
                  </li>
                );
              })}
            </ol>
            {!linkedSource && (
              <div>
                <Button variant="secondary" onClick={() => setLines([...lines, newLine()])} disabled={lines.length >= 200}>
                  Add a line
                </Button>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Notes and terms" />
            <CardBody className="flex flex-col gap-4">
              {showPrices && (
                <FormField label="Discount on the whole document (₹)" error={errors.documentDiscount} hint="Shared across lines before tax">
                  {(f) => <Input {...f} inputMode="decimal" className="tabular" value={documentDiscount} onChange={(e) => setDocumentDiscount(e.target.value.trim())} />}
                </FormField>
              )}
              <FormField label="Notes" error={errors.notes}>
                {(f) => <Input {...f} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
              </FormField>
              <FormField label="Terms" error={errors.terms}>
                {(f) => <Input {...f} maxLength={2000} value={terms} onChange={(e) => setTerms(e.target.value)} />}
              </FormField>
            </CardBody>
          </Card>
          {showPrices && (
            <Card>
              <CardHeader title="Totals" description="Calculated by the server from your GST rates" />
              <CardBody>
                {preview.isError ? (
                  <InlineAlert>{errorMessage(preview.error)}</InlineAlert>
                ) : totals ? (
                  <div aria-busy={preview.isFetching}>
                    <TotalsPanel totals={totals} supply={preview.data?.supply ?? doc?.supply ?? 'intra'} />
                  </div>
                ) : (
                  <p className="text-sm text-muted">Choose a customer and complete the lines to see the totals.</p>
                )}
                {warnings.length > 0 && (
                  <ul className="mt-4 flex flex-col gap-2">
                    {warnings.map((w) => (
                      <li key={w}>
                        <InlineAlert tone="warning">{w}</InlineAlert>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : doc ? 'Save draft' : 'Save as draft'}
          </Button>
          {actions?.(save.isPending)}
        </div>
        {doc && <p className="text-xs text-muted">Save your changes before {config.type === 'quotation' ? 'sending' : config.type === 'sales_order' ? 'confirming' : config.type === 'dispatch' ? 'dispatching' : 'issuing'}.</p>}
      </form>
    </>
  );
}
