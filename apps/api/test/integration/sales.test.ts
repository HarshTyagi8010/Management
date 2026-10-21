import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkerTasks } from '../../src/jobs/index.js';
import { reconcileJournals } from '../../src/modules/finance/journals.js';
import { reconcileStock } from '../../src/modules/inventory/reconciliation.js';
import { QuotationService } from '../../src/modules/sales/quotations.js';
import { tinyPng } from '../../src/test-utils.js';
import { addMember, address, createHarness, fakeGstin, fakePan, setupEntity, signUp, type Client, type Harness } from './harness.js';

/**
 * Order to cash (Phase 7) on a real replica set: quotations, orders with
 * reservations (FR-INV-05), dispatches and invoices at either stock-out point
 * (FR-INV-10), cancellations, PDFs (AC-DOC-1), receivables, credit limits,
 * GST particulars at issue, and the re-runs of AC-INV-1, AC-NUM-1, AC-IDEM-1
 * and AC-JRN-1 with real documents. Synthetic data only.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(h.clock.now().getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic test fixture (not a real notification)';
const key = () => ({ 'Idempotency-Key': randomUUID() });
const silent = pino({ level: 'silent' });
const DAY = 86_400_000;

interface Biz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  main: string;
  bolt: string;
  nut: string;
  svc: string;
  exempt: string;
  customer: string;
  b2c: string;
  karnataka: string;
}

async function business(label: string, opts: { stockOut?: 'dispatch' | 'invoice'; band?: 'up_to_5cr' | 'above_5cr_below_10cr'; opening?: string } = {}): Promise<Biz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);
  if (opts.band) await client.patch(`/legal-entities/${e.entityId}`, { version: e.version, turnoverBand: opts.band });
  if (opts.stockOut === 'invoice') {
    const entity = await client.get(`/legal-entities/${e.entityId}`);
    const wf = await client.put(`/legal-entities/${e.entityId}/workflow`, { ...entity.body.workflow, stockOutPoint: 'invoice', version: entity.body.version });
    expect(wf.status, JSON.stringify(wf.body)).toBe(200);
  }
  const main = await client.post('/warehouses', { legalEntityId: e.entityId, code: 'MAIN', name: 'Main (test)', gstRegistrationId: e.registrationId });
  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const nos = units.find((u) => u.code === 'NOS')?.id;
  const goods = await client.post('/tax-classes', { name: 'Hardware (test)', kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '18', sourceReference: SOURCE });
  const services = await client.post('/tax-classes', { name: 'Services (test)', kind: 'service', treatment: 'taxable' });
  await client.post(`/tax-classes/${services.body.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '18', sourceReference: SOURCE });
  const exemptClass = await client.post('/tax-classes', { name: 'Exempt goods (test)', kind: 'goods', treatment: 'exempt' });
  const item = async (sku: string, type: string, hsnSac: string, taxClassId: string) => (await client.post('/items', { sku, name: `${sku} (test)`, type, baseUnitId: nos, hsnSac, taxClassId, salePrice: '10.00' })).body.id as string;
  const bolt = await item('BOLT', 'stock', '7318', goods.body.id);
  const nut = await item('NUT', 'stock', '7318', goods.body.id);
  const svc = await item('FIT', 'service', '998713', services.body.id);
  const exempt = await item('GRAIN', 'non_stock', '1001', exemptClass.body.id);
  const pan = fakePan('F');
  const customer = await client.post('/parties', {
    name: 'Buyer Traders (test)',
    isCustomer: true,
    isSupplier: false,
    pan,
    gstins: [{ gstin: fakeGstin('27', pan), addressId: 'a1' }],
    addresses: [{ id: 'a1', label: 'Office', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const b2c = await client.post('/parties', { name: 'Walk-in buyer (test)', isCustomer: true, isSupplier: false });
  const kpan = fakePan('F');
  const karnataka = await client.post('/parties', { name: 'Bengaluru Buyer (test)', isCustomer: true, isSupplier: false, pan: kpan, gstins: [{ gstin: fakeGstin('29', kpan), addressId: 'k1' }], addresses: [{ id: 'k1', isBilling: true, isShipping: true, line1: '5 Test Road', city: 'Bengaluru', stateCode: '29', pincode: '560001' }] });
  for (const [docType, prefix, scoped] of [
    ['quotation', 'QT/{FY}/', false],
    ['proforma_invoice', 'PI/{FY}/', false],
    ['sales_order', 'SO/{FY}/', false],
    ['delivery_challan', 'DC/{FY}/', true],
    ['tax_invoice', 'INV/{FY}/', true],
    ['bill_of_supply', 'BOS/{FY}/', true],
  ] as const) {
    const s = await client.post('/document-series', { legalEntityId: e.entityId, gstRegistrationId: scoped ? e.registrationId : null, docType, name: `${docType} (test)`, prefix, padding: 4 });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
  }
  const b: Biz = { client, tenantId, entityId: e.entityId, registrationId: e.registrationId, main: main.body.id, bolt, nut, svc, exempt, customer: customer.body.id, b2c: b2c.body.id, karnataka: karnataka.body.id };
  if (opts.opening !== '0') {
    const opening = await client.post('/stock-adjustments', { warehouseId: b.main, type: 'opening', docDate: TODAY(), lines: [{ itemId: bolt, qty: opts.opening ?? '10', unitCost: '3.00' }, { itemId: nut, qty: '100', unitCost: '0.50' }] });
    expect((await client.post(`/stock-adjustments/${opening.body.id}/post`, { version: opening.body.version }, key())).status).toBe(200);
  }
  return b;
}

type Line = { itemId: string; qty: string; unitPrice?: string };
const body = (b: Biz, lines: Line[], extra: Record<string, unknown> = {}) => ({ legalEntityId: b.entityId, gstRegistrationId: b.registrationId, partyId: b.customer, docDate: TODAY(), lines: lines.map((l) => ({ unitPrice: '10.00', ...l })), ...extra });

async function stock(b: Biz, itemId: string) {
  const res = await b.client.get(`/stock/summary?legalEntityId=${b.entityId}&warehouseId=${b.main}`);
  return (res.body.data as Array<{ itemId: string; onHand: string; reserved: string; available: string }>).find((r) => r.itemId === itemId);
}

async function drain() {
  const consumer = buildWorkerTasks({ config: h.config, db: h.db, logger: silent, now: h.clock.now }).find((t) => t.name === 'outbox');
  const signal = new AbortController().signal;
  while (await consumer?.runOnce(signal)) {
    // drain
  }
}

async function books(b: Biz) {
  const tenantId = new Types.ObjectId(b.tenantId);
  const [s, j] = await Promise.all([reconcileStock(h.db.models, tenantId, 'all'), reconcileJournals(h.db.models, tenantId)]);
  return { stock: s.issues, journals: j.issues };
}

const confirmOrder = async (b: Biz, lines: Line[], extra: Record<string, unknown> = {}) => {
  const draft = await b.client.post('/sales-orders', body(b, lines, { warehouseId: b.main, ...extra }));
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const confirmed = await b.client.post(`/sales-orders/${draft.body.id}/confirm`, { version: draft.body.version }, key());
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return confirmed.body;
};

describe('quotations and proforma invoices (FR-SAL-01/02)', () => {
  it('drafts with server figures, numbers on send, then accept → convert to an order', async () => {
    const b = await business('quote');
    const draft = await b.client.post('/quotations', body(b, [{ itemId: b.bolt, qty: '3', unitPrice: '100' }, { itemId: b.svc, qty: '1', unitPrice: '50' }], { validUntil: TODAY(), documentDiscount: '15.00' }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', number: null, documentKind: 'quotation', placeOfSupply: '27', supply: 'intra', placeOfSupplyOverridden: false });
    // 350 − 15 discount (largest remainder: 12.86 / 2.14) = 335 taxable; 18% intra = 30.15 + 30.15.
    expect(draft.body.totals).toMatchObject({ gross: '350.00', discount: '15.00', taxable: '335.00', cgst: '30.15', sgst: '30.15', grand: '395.00', roundOff: '-0.30' });
    expect(draft.body.buyer).toMatchObject({ name: 'Buyer Traders (test)', gstin: expect.stringMatching(/^27/) });

    const sent = await b.client.post(`/quotations/${draft.body.id}/send`, { version: draft.body.version }, key());
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent', number: expect.stringMatching(/^QT\/\d\d-\d\d\/0001$/), warnings: [] });
    // No edits once sent; it can be revised instead.
    expect((await b.client.patch(`/quotations/${draft.body.id}`, { version: sent.body.version, notes: 'x' })).body.error.code).toBe('INVALID_STATE');
    expect((await b.client.post(`/quotations/${draft.body.id}/convert`, { version: sent.body.version, to: 'sales_order' })).body.error.code).toBe('INVALID_STATE');
    const accepted = await b.client.post(`/quotations/${draft.body.id}/accept`, { version: sent.body.version });
    expect(accepted.body.status).toBe('accepted');
    const order = await b.client.post(`/quotations/${draft.body.id}/convert`, { version: accepted.body.version, to: 'sales_order' });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body).toMatchObject({ docType: 'sales_order', status: 'draft', source: { type: 'quotation', number: sent.body.number, status: 'converted' } });
    expect(order.body.totals.grand).toBe('395.00');
    const shown = await b.client.get(`/quotations/${draft.body.id}`);
    expect(shown.body.related).toEqual([expect.objectContaining({ type: 'sales_order', id: order.body.id })]);

    // The PDF is rendered by the worker after sending; it says it is not a tax invoice.
    await drain();
    const pdf = await b.client.download(`/quotations/${draft.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('revises a sent quotation (the sent one is kept), rejects, discards and expires', async () => {
    const b = await business('revise', { opening: '0' });
    const make = async () => {
      const d = await b.client.post('/quotations', body(b, [{ itemId: b.svc, qty: '1' }], { kind: 'proforma', validUntil: TODAY() }));
      return b.client.post(`/quotations/${d.body.id}/send`, { version: d.body.version }, key());
    };
    const first = await make();
    expect(first.body).toMatchObject({ documentKind: 'proforma_invoice', number: expect.stringMatching(/^PI\//) });
    const revised = await b.client.post(`/quotations/${first.body.id}/revise`, { version: first.body.version });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect(revised.body).toMatchObject({ status: 'draft', revision: 1, revisionOf: { id: first.body.id, number: first.body.number } });
    expect((await b.client.get(`/quotations/${first.body.id}`)).body).toMatchObject({ status: 'revised', number: first.body.number });

    const second = await make();
    expect((await b.client.post(`/quotations/${second.body.id}/reject`, { version: second.body.version })).body.status).toBe('rejected');
    expect((await b.client.post(`/quotations/${revised.body.id}/discard`, { version: revised.body.version })).body.status).toBe('discarded');

    const third = await make();
    const tenantId = new Types.ObjectId(b.tenantId);
    // Still valid today; expired once its last valid day has passed (the worker's daily job).
    expect(await QuotationService.expire(h.db.models, tenantId, TODAY())).toBe(0);
    expect(await QuotationService.expire(h.db.models, tenantId, new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10))).toBe(1);
    expect((await b.client.get(`/quotations/${third.body.id}`)).body.status).toBe('expired');
  });

  it('refuses to number without a series and explains where to add one', async () => {
    const b = await business('noseries', { opening: '0' });
    const series = (await b.client.get(`/document-series?legalEntityId=${b.entityId}`)).body.data as Array<{ id: string; docType: string; version: number }>;
    const qt = series.find((s) => s.docType === 'quotation');
    await b.client.patch(`/document-series/${qt?.id}`, { version: qt?.version, active: false });
    const d = await b.client.post('/quotations', body(b, [{ itemId: b.svc, qty: '1' }]));
    const sent = await b.client.post(`/quotations/${d.body.id}/send`, { version: d.body.version }, key());
    expect(sent.status).toBe(422);
    expect(sent.body.error.message).toMatch(/Add a quotation series/);
    // Nothing was numbered.
    expect((await b.client.get(`/quotations/${d.body.id}`)).body).toMatchObject({ status: 'draft', number: null });
  });
});

describe('sales orders and reservations (FR-SAL-03, FR-INV-05)', () => {
  it('confirming reserves available stock (not on hand); cancelling releases it', async () => {
    const b = await business('reserve');
    const order = await confirmOrder(b, [{ itemId: b.bolt, qty: '4' }, { itemId: b.svc, qty: '1' }]);
    expect(order).toMatchObject({ status: 'confirmed', number: expect.stringMatching(/^SO\//) });
    expect(order.lines[0]).toMatchObject({ reservedQty: '4', fulfilledQty: '0' });
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '10', reserved: '4', available: '6' });
    // More than is available cannot be reserved, and nothing is numbered or held by the failed attempt.
    const big = await b.client.post('/sales-orders', body(b, [{ itemId: b.bolt, qty: '7' }], { warehouseId: b.main }));
    const refused = await b.client.post(`/sales-orders/${big.body.id}/confirm`, { version: big.body.version }, key());
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(refused.body.error.message).toMatch(/4 of them reserved/);
    // Other stock-outs can only take what is not reserved.
    const adj = await b.client.post('/stock-adjustments', { warehouseId: b.main, type: 'adjustment', reason: 'damage', docDate: TODAY(), lines: [{ itemId: b.bolt, qty: '-7' }] });
    expect((await b.client.post(`/stock-adjustments/${adj.body.id}/post`, { version: adj.body.version }, key())).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await books(b)).stock).toEqual([]);

    // A confirmed order with nothing fulfilled can be cancelled; reservations are released.
    expect((await b.client.post(`/sales-orders/${order.id}/close`, { version: order.version, reason: 'Customer changed plans (test)' }, key())).body.error.code).toBe('INVALID_STATE');
    const cancelled = await b.client.post(`/sales-orders/${order.id}/cancel`, { version: order.version, reason: 'Customer changed plans (test)' }, key());
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Customer changed plans (test)' });
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '10', reserved: '0', available: '10' });
    expect((await books(b)).stock).toEqual([]);
  });

  it('needs a warehouse for stock lines, and reconciliation catches reservation drift', async () => {
    const b = await business('drift');
    const draft = await b.client.post('/sales-orders', body(b, [{ itemId: b.bolt, qty: '2' }]));
    expect((await b.client.post(`/sales-orders/${draft.body.id}/confirm`, { version: draft.body.version }, key())).body.error.message).toMatch(/Choose the warehouse/);
    await confirmOrder(b, [{ itemId: b.bolt, qty: '2' }]);
    expect((await books(b)).stock).toEqual([]);
    await h.db.models.StockBalance.updateOne({ tenantId: new Types.ObjectId(b.tenantId), itemId: new Types.ObjectId(b.bolt) }, { $inc: { reserved: Types.Decimal128.fromString('1') } });
    expect((await books(b)).stock).toEqual([expect.objectContaining({ kind: 'reserved', expected: '2', actual: '3' })]);
  });
});

describe('stock-out at dispatch (FR-SAL-04, FR-INV-10)', () => {
  it('order → dispatch (stock out, reservation used) → invoice (no second stock-out) → cancellations', async () => {
    const b = await business('dispatchflow');
    const order = await confirmOrder(b, [{ itemId: b.bolt, qty: '6', unitPrice: '20' }, { itemId: b.svc, qty: '1', unitPrice: '100' }]);
    const dispatchDraft = await b.client.post(`/sales-orders/${order.id}/dispatches`);
    expect(dispatchDraft.status, JSON.stringify(dispatchDraft.body)).toBe(201);
    // Only the stock line is dispatched; take 4 of the 6 now.
    expect(dispatchDraft.body.lines).toHaveLength(1);
    const line = dispatchDraft.body.lines[0];
    const edited = await b.client.patch(`/dispatches/${dispatchDraft.body.id}`, { version: dispatchDraft.body.version, lines: [{ itemId: b.bolt, qty: '4', unitPrice: '20', sourceLineId: line.sourceLineId }], transport: { vehicleNumber: 'mh01ab1234' } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.transport).toEqual({ vehicleNumber: 'MH01AB1234', transporterName: '', ewayBillNumber: '' });
    // More than the order still needs is refused.
    const tooMany = await b.client.patch(`/dispatches/${dispatchDraft.body.id}`, { version: edited.body.version, lines: [{ itemId: b.bolt, qty: '7', unitPrice: '20', sourceLineId: line.sourceLineId }] });
    expect(tooMany.status).toBe(422);

    const dispatched = await b.client.post(`/dispatches/${dispatchDraft.body.id}/dispatch`, { version: edited.body.version }, key());
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body).toMatchObject({ status: 'dispatched', number: expect.stringMatching(/^DC\//), documentKind: 'delivery_challan' });
    expect(dispatched.body.lines[0]).toMatchObject({ unitCost: '3.000000', costValue: '12.00', invoicedQty: '0' });
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '6', reserved: '2', available: '4' });
    const afterDispatch = await b.client.get(`/sales-orders/${order.id}`);
    expect(afterDispatch.body).toMatchObject({ status: 'partially_fulfilled' });
    expect(afterDispatch.body.lines[0]).toMatchObject({ reservedQty: '2', fulfilledQty: '4' });
    const journals = await b.client.get(`/journals?legalEntityId=${b.entityId}&sourceId=${dispatchDraft.body.id}`);
    expect(journals.body.data[0].lines).toEqual([expect.objectContaining({ accountCode: '5200', debit: '12.00' }), expect.objectContaining({ accountCode: '1300', credit: '12.00' })]);

    // Invoice the dispatch: sales journal only, no stock movement.
    const invDraft = await b.client.post(`/dispatches/${dispatchDraft.body.id}/invoices`);
    expect(invDraft.status, JSON.stringify(invDraft.body)).toBe(201);
    const issued = await b.client.post(`/sales-invoices/${invDraft.body.id}/issue`, { version: invDraft.body.version, expectedTotal: invDraft.body.totals.grand }, key());
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: 'issued', documentKind: 'tax_invoice', number: expect.stringMatching(/^INV\//), paymentStatus: 'unpaid', outstanding: '94.00', einvoiceStatus: 'not_applicable' });
    expect(issued.body.totals).toMatchObject({ taxable: '80.00', cgst: '7.20', sgst: '7.20', roundOff: '-0.40', grand: '94.00' });
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '6' });
    expect((await b.client.get(`/dispatches/${dispatchDraft.body.id}`)).body).toMatchObject({ status: 'invoiced' });
    const invJournal = await b.client.get(`/journals?legalEntityId=${b.entityId}&sourceId=${invDraft.body.id}`);
    expect(invJournal.body.data[0]).toMatchObject({ totalDebit: '94.40', totalCredit: '94.40' });
    expect(invJournal.body.data[0].lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '1200', debit: '94.00' }),
        expect.objectContaining({ accountCode: '4100', credit: '80.00' }),
        expect.objectContaining({ accountCode: '2210', credit: '7.20' }),
        expect.objectContaining({ accountCode: '2211', credit: '7.20' }),
        expect.objectContaining({ accountCode: '4900', debit: '0.40' }),
      ]),
    );
    // The order's service line is invoiced from the order; the bolts can't be (they leave with dispatches).
    const fromOrder = await b.client.post(`/sales-orders/${order.id}/invoices`);
    expect(fromOrder.status, JSON.stringify(fromOrder.body)).toBe(201);
    expect(fromOrder.body.lines).toEqual([expect.objectContaining({ itemId: b.svc, qty: '1' })]);
    const withBolt = await b.client.patch(`/sales-invoices/${fromOrder.body.id}`, { version: fromOrder.body.version, lines: [...fromOrder.body.lines.map((l: { itemId: string; qty: string; sourceLineId: string }) => ({ itemId: l.itemId, qty: l.qty, unitPrice: '100', sourceLineId: l.sourceLineId })), { itemId: b.bolt, qty: '1', unitPrice: '20', sourceLineId: order.lines[0].lineId }] });
    expect(withBolt.status).toBe(400);
    expect(withBolt.body.error.message).toMatch(/invoice the dispatch/);
    // A stock line without a dispatch is refused at this stock-out point.
    const direct = await b.client.post('/sales-invoices', body(b, [{ itemId: b.bolt, qty: '1' }]));
    expect(direct.status).toBe(400);
    expect(direct.body.error.message).toMatch(/dispatch BOLT first/);

    // A dispatch with invoiced goods can't be cancelled; cancel the invoice first (its number is kept).
    expect((await b.client.post(`/dispatches/${dispatchDraft.body.id}/cancel`, { version: dispatched.body.version + 1, reason: 'Wrong goods (test)' }, key())).body.error.code).toBe('INVALID_STATE');
    const cancelledInv = await b.client.post(`/sales-invoices/${invDraft.body.id}/cancel`, { version: issued.body.version, reason: 'Raised in error (test)' }, key());
    expect(cancelledInv.status, JSON.stringify(cancelledInv.body)).toBe(200);
    expect(cancelledInv.body).toMatchObject({ status: 'cancelled', number: issued.body.number, outstanding: '0.00' });
    expect((await b.client.patch(`/sales-invoices/${invDraft.body.id}`, { version: cancelledInv.body.version, notes: 'x' })).body.error.code).toBe('INVALID_STATE');
    const reopened = await b.client.get(`/dispatches/${dispatchDraft.body.id}`);
    expect(reopened.body).toMatchObject({ status: 'dispatched' });
    const cancelledDispatch = await b.client.post(`/dispatches/${dispatchDraft.body.id}/cancel`, { version: reopened.body.version, reason: 'Wrong goods (test)' }, key());
    expect(cancelledDispatch.status, JSON.stringify(cancelledDispatch.body)).toBe(200);
    // Goods are back at the cost they left with, and held for the order again.
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '10', reserved: '6' });
    const backOrder = await b.client.get(`/sales-orders/${order.id}`);
    expect(backOrder.body).toMatchObject({ status: 'confirmed' });
    expect(backOrder.body.lines[0]).toMatchObject({ reservedQty: '6', fulfilledQty: '0', invoicedQty: '0' });
    const ledger = await b.client.get(`/stock/movements?legalEntityId=${b.entityId}&itemId=${b.bolt}`);
    expect(ledger.body.data[0]).toMatchObject({ kind: 'issue', qty: '4', value: '12.00', reversal: true, source: { type: 'dispatch' } });
    expect(await books(b)).toEqual({ stock: [], journals: [] });
    const tb = await b.client.get(`/reports/trial-balance?legalEntityId=${b.entityId}`);
    expect(tb.body.totalDebit).toBe(tb.body.totalCredit);
    expect(tb.body.rows.find((r: { code: string }) => r.code === '1200')).toBeUndefined();

    // Short-close the rest: reservations released.
    const part = await b.client.post(`/sales-orders/${order.id}/dispatches`);
    const p2 = await b.client.patch(`/dispatches/${part.body.id}`, { version: part.body.version, lines: [{ itemId: b.bolt, qty: '1', unitPrice: '20', sourceLineId: part.body.lines[0].sourceLineId }] });
    await b.client.post(`/dispatches/${part.body.id}/dispatch`, { version: p2.body.version }, key());
    const latest = await b.client.get(`/sales-orders/${order.id}`);
    const closed = await b.client.post(`/sales-orders/${order.id}/close`, { version: latest.body.version, reason: 'Rest not needed (test)' }, key());
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '9', reserved: '0' });
    expect(await books(b)).toEqual({ stock: [], journals: [] });
  });

  it('AC-INV-1: concurrent dispatches of the last 5 units, each of 5: exactly one succeeds', async () => {
    const b = await business('lastunits', { opening: '5' });
    const drafts = await Promise.all(Array.from({ length: 6 }, () => b.client.post('/dispatches', body(b, [{ itemId: b.bolt, qty: '5' }], { warehouseId: b.main }))));
    expect(drafts.every((d) => d.status === 201)).toBe(true);
    const results = await Promise.all(drafts.map((d) => b.client.post(`/dispatches/${d.body.id}/dispatch`, { version: d.body.version }, key())));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '0' });
    // Failed dispatches took no challan number: the next one is 0002.
    const next = await b.client.post('/dispatches', body(b, [{ itemId: b.nut, qty: '1' }], { warehouseId: b.main }));
    const ok = await b.client.post(`/dispatches/${next.body.id}/dispatch`, { version: next.body.version }, key());
    expect(ok.body.number).toMatch(/\/0002$/);
    expect(await books(b)).toEqual({ stock: [], journals: [] });
  });
});

describe('stock-out at invoice', () => {
  it('direct and order invoices move stock once, with cost of goods sold; cancelling restores and re-reserves', async () => {
    const b = await business('invoicemode', { stockOut: 'invoice' });
    expect((await b.client.post('/dispatches', body(b, [{ itemId: b.bolt, qty: '1' }], { warehouseId: b.main }))).body.error.message).toMatch(/no dispatches/);
    const draft = await b.client.post('/sales-invoices', body(b, [{ itemId: b.bolt, qty: '2', unitPrice: '25' }, { itemId: b.svc, qty: '1', unitPrice: '40' }]));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await b.client.post(`/sales-invoices/${draft.body.id}/issue`, { version: draft.body.version }, key())).body.error.message).toMatch(/Choose the warehouse/);
    const withWh = await b.client.patch(`/sales-invoices/${draft.body.id}`, { version: draft.body.version, warehouseId: b.main });
    const issued = await b.client.post(`/sales-invoices/${draft.body.id}/issue`, { version: withWh.body.version }, key());
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.lines[0]).toMatchObject({ unitCost: '3.000000', costValue: '6.00' });
    expect(issued.body.dueDate).toBe(new Date(Date.parse(`${TODAY()}T00:00:00Z`) + 30 * DAY).toISOString().slice(0, 10));
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '8' });
    const j = await b.client.get(`/journals?legalEntityId=${b.entityId}&sourceId=${draft.body.id}`);
    expect(j.body.data[0].lines).toEqual(expect.arrayContaining([expect.objectContaining({ accountCode: '5200', debit: '6.00' }), expect.objectContaining({ accountCode: '1300', credit: '6.00' })]));

    const order = await confirmOrder(b, [{ itemId: b.bolt, qty: '5', unitPrice: '25' }]);
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '8', reserved: '5', available: '3' });
    const fromOrder = await b.client.post(`/sales-orders/${order.id}/invoices`);
    expect(fromOrder.body).toMatchObject({ warehouseId: b.main, source: { type: 'sales_order', id: order.id } });
    const orderInv = await b.client.post(`/sales-invoices/${fromOrder.body.id}/issue`, { version: fromOrder.body.version }, key());
    expect(orderInv.status, JSON.stringify(orderInv.body)).toBe(200);
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '3', reserved: '0', available: '3' });
    expect((await b.client.get(`/sales-orders/${order.id}`)).body).toMatchObject({ status: 'fulfilled' });

    const cancelled = await b.client.post(`/sales-invoices/${fromOrder.body.id}/cancel`, { version: orderInv.body.version, reason: 'Wrong customer (test)' }, key());
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(await stock(b, b.bolt)).toMatchObject({ onHand: '8', reserved: '5' });
    expect((await b.client.get(`/sales-orders/${order.id}`)).body).toMatchObject({ status: 'confirmed' });
    expect(await books(b)).toEqual({ stock: [], journals: [] });
  });

  it('AC-NUM-1 with real invoices: 100 concurrent issues are 1…100; failed issues take no number', async () => {
    const b = await business('numbering100', { stockOut: 'invoice', opening: '0' });
    const ok = await Promise.all(Array.from({ length: 100 }, () => b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1' }]))));
    // These fail after taking a number: no bolts are in stock.
    const bad = await Promise.all(Array.from({ length: 20 }, () => b.client.post('/sales-invoices', body(b, [{ itemId: b.bolt, qty: '1' }], { warehouseId: b.main }))));
    expect([...ok, ...bad].every((d) => d.status === 201)).toBe(true);
    const results = await Promise.all([...ok, ...bad].map((d) => b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version }, key())));
    const issued = results.filter((r) => r.status === 200);
    expect(issued).toHaveLength(100);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    const seq = issued.map((r) => Number(String(r.body.number).split('/').at(-1))).sort((x, y) => x - y);
    expect(seq).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(await books(b)).toEqual({ stock: [], journals: [] });
  }, 300_000);
});

describe('issuing invoices: rules and guarantees', () => {
  it('AC-IDEM-1 on issue: a replay returns the first result; the same key for another request is refused', async () => {
    const b = await business('idem', { opening: '0' });
    const d = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1' }]));
    const k = key();
    const first = await b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version }, k);
    const replay = await b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.number).toBe(first.body.number);
    const other = await b.client.post(`/sales-invoices/${d.body.id}/cancel`, { version: first.body.version, reason: 'Testing key reuse' }, k);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version })).status).toBe(400);
  });

  it('refuses a stale total, a locked period, short HSN codes and missing recipient details', async () => {
    const b = await business('rules', { band: 'above_5cr_below_10cr', opening: '0' });
    const d = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1' }]));
    const stale = await b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version, expectedTotal: '1.00' }, key());
    expect(stale.status).toBe(409);
    expect(stale.body.error.details[0]).toEqual({ path: 'expectedTotal', message: d.body.totals.grand });
    // Above ₹5 crore, HSN needs 6 digits on every tax invoice (GST-04), exempt lines included: GRAIN has 4.
    const nut = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1' }, { itemId: b.exempt, qty: '1' }]));
    expect((await b.client.post(`/sales-invoices/${nut.body.id}/issue`, { version: nut.body.version }, key())).body.error.message).toMatch(/at least 6 digits.*GRAIN/);

    // B2C of ₹50,000 or more needs the buyer's address and the delivery address (Rule 46).
    const small = await business('rules2', { opening: '0' });
    const b2c = await small.client.post('/sales-invoices', body(small, [{ itemId: small.svc, qty: '5000' }], { partyId: small.b2c }));
    expect(b2c.status, JSON.stringify(b2c.body)).toBe(201);
    expect(b2c.body.buyer).toMatchObject({ gstin: null, billingAddress: null });
    expect((await small.client.post(`/sales-invoices/${b2c.body.id}/issue`, { version: b2c.body.version }, key())).body.error.message).toMatch(/₹50,000 or more/);
    // Below it, an unregistered buyer needs nothing more.
    const b2cSmall = await small.client.post('/sales-invoices', body(small, [{ itemId: small.svc, qty: '1' }], { partyId: small.b2c }));
    expect((await small.client.post(`/sales-invoices/${b2cSmall.body.id}/issue`, { version: b2cSmall.body.version }, key())).status).toBe(200);

    // Only exempt lines: a bill of supply, numbered from its own series.
    const bos = await small.client.post('/sales-invoices', body(small, [{ itemId: small.exempt, qty: '3' }]));
    expect(bos.body.documentKind).toBe('bill_of_supply');
    const bosIssued = await small.client.post(`/sales-invoices/${bos.body.id}/issue`, { version: bos.body.version }, key());
    expect(bosIssued.body).toMatchObject({ documentKind: 'bill_of_supply', number: expect.stringMatching(/^BOS\//), totals: { cgst: '0.00', grand: '30.00' } });

    // Inter-state supply: IGST, from the customer's address; an overridden place of supply is recorded.
    const igst = await small.client.post('/sales-invoices', body(small, [{ itemId: small.svc, qty: '1', unitPrice: '100' }], { partyId: small.karnataka }));
    expect(igst.body).toMatchObject({ placeOfSupply: '29', supply: 'inter', totals: { igst: '18.00', cgst: '0.00' } });
    const override = await small.client.patch(`/sales-invoices/${igst.body.id}`, { version: igst.body.version, placeOfSupply: '27' });
    expect(override.body).toMatchObject({ placeOfSupply: '27', placeOfSupplyOverridden: true, supply: 'intra' });
    expect(override.body.warnings.join(' ')).toMatch(/recorded in the audit log/);
    const issuedOverride = await small.client.post(`/sales-invoices/${igst.body.id}/issue`, { version: override.body.version }, key());
    expect(issuedOverride.status).toBe(200);
    const audit = await small.client.get('/audit-events?action=sales_invoice.issued');
    expect(audit.body.data.find((e: { entityId: string }) => e.entityId === igst.body.id).changes).toEqual(expect.arrayContaining([{ field: 'placeOfSupply', to: '27' }]));

    // A draft dated in a period locked since it was saved can't be issued.
    const yesterday = new Date(Date.parse(`${TODAY()}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    const lockDraft = await small.client.post('/sales-invoices', body(small, [{ itemId: small.svc, qty: '1' }], { docDate: yesterday }));
    const entity = await small.client.get(`/legal-entities/${small.entityId}`);
    expect((await small.client.put(`/legal-entities/${small.entityId}/period-lock`, { version: entity.body.version, lockDate: yesterday, reason: 'Day closed (test)' })).status).toBe(200);
    const locked = await small.client.post(`/sales-invoices/${lockDraft.body.id}/issue`, { version: lockDraft.body.version }, key());
    expect(locked.body.error.code).toBe('PERIOD_LOCKED');
  });

  it('credit limits: over the limit is refused unless someone with credit.override confirms (FR-SAL-08)', async () => {
    const b = await business('credit', { opening: '0' });
    const party = await b.client.get(`/parties/${b.customer}`);
    await b.client.patch(`/parties/${b.customer}`, { version: party.body.version, creditLimit: '100.00' });
    const first = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '8' }]));
    expect((await b.client.post(`/sales-invoices/${first.body.id}/issue`, { version: first.body.version }, key())).status).toBe(200);
    const second = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '2' }]));
    const refused = await b.client.post(`/sales-invoices/${second.body.id}/issue`, { version: second.body.version }, key());
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/over their credit limit of ₹100\.00 \(₹94\.00 already outstanding\)/);
    // An accountant can issue invoices but not approve going over the limit.
    const accountant = await addMember(h, b.client, 'Accountant', 'creditacct');
    accountant.client.tenantId = b.tenantId;
    expect((await accountant.client.post(`/sales-invoices/${second.body.id}/issue`, { version: second.body.version, overrideCreditLimit: true }, key())).status).toBe(403);
    const overridden = await b.client.post(`/sales-invoices/${second.body.id}/issue`, { version: second.body.version, overrideCreditLimit: true }, key());
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(200);
    const audit = await b.client.get('/audit-events?action=sales_invoice.issued');
    expect(audit.body.data[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'creditLimit', from: '100.00' })]));
  });

  it('AC-DOC-1: the invoice PDF (with logo) is stored once and re-downloads byte-identical after master data changes', async () => {
    const b = await business('pdf', { opening: '0' });
    const entity = await b.client.get(`/legal-entities/${b.entityId}`);
    const png = await tinyPng(64, 32);
    // Uploads are checked by their bytes.
    expect((await b.client.put(`/legal-entities/${b.entityId}/logo`, { version: entity.body.version, image: { contentType: 'image/png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') } })).status).toBe(400);
    expect((await b.client.put(`/legal-entities/${b.entityId}/logo`, { version: entity.body.version, image: { contentType: 'image/jpeg', data: png.toString('base64') } })).body.error.message).toMatch(/not the type it claims/);
    expect((await b.client.put(`/legal-entities/${b.entityId}/logo`, { version: entity.body.version, image: { contentType: 'image/png', data: (await tinyPng(8, 8)).toString('base64') } })).body.error.message).toMatch(/between 16 and 2000 pixels/);
    const logo = await b.client.put(`/legal-entities/${b.entityId}/logo`, { version: entity.body.version, image: { contentType: 'image/png', data: png.toString('base64') } });
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
    expect(logo.body.logo).toEqual({ contentType: 'image/png', sizeBytes: png.length, width: 64, height: 32 });

    const d = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1', unitPrice: '1234.50' }]));
    expect((await b.client.get(`/sales-invoices/${d.body.id}/pdf`)).body.error.code).toBe('INVALID_STATE');
    const issued = await b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version }, key());
    expect(issued.body.pdf).toBeNull();
    await drain();
    const shown = await b.client.get(`/sales-invoices/${d.body.id}`);
    expect(shown.body.pdf).toMatchObject({ status: 'ready', templateVersion: 'sales-invoice-1' });
    const first = await b.client.download(`/sales-invoices/${d.body.id}/pdf`);
    expect(first.status).toBe(200);
    expect(first.headers['content-disposition']).toMatch(/INV_\d\d-\d\d_0001\.pdf/);
    expect(first.body.toString('latin1')).toMatch(/\/Subtype \/Image/);

    // Master data changes after issue do not touch the issued document or its PDF.
    const party = await b.client.get(`/parties/${b.customer}`);
    await b.client.patch(`/parties/${b.customer}`, { version: party.body.version, name: 'Renamed Buyer (test)' });
    const after = await b.client.get(`/legal-entities/${b.entityId}`);
    await b.client.patch(`/legal-entities/${b.entityId}`, { version: after.body.version, tradeName: 'Renamed Traders (test)' });
    await b.client.put(`/legal-entities/${b.entityId}/logo`, { version: after.body.version + 1, image: null });
    await drain();
    const again = await b.client.download(`/sales-invoices/${d.body.id}/pdf`);
    expect(again.body.equals(first.body)).toBe(true);
    expect((await b.client.get(`/sales-invoices/${d.body.id}`)).body.buyer.name).toBe('Buyer Traders (test)');
    // The worker also renders every PDF queued by earlier tests in this file (about 120 invoices).
  }, 180_000);
});

describe('access (AC-TEN-1, FR-RBAC-03/04)', () => {
  it('other businesses see nothing; storekeepers see dispatches without prices; sales staff cannot issue', async () => {
    const b = await business('access');
    const inv = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty: '1' }]));
    const other = await signUp(h, 'intruder', 'Other Traders (test)');
    expect((await other.client.get(`/sales-invoices/${inv.body.id}`)).status).toBe(404);
    expect((await other.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: inv.body.version }, key())).status).toBe(404);
    expect((await other.client.get('/sales-invoices')).body.data).toEqual([]);

    const sales = await addMember(h, b.client, 'Sales', 'salesrep');
    sales.client.tenantId = b.tenantId;
    expect((await sales.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: inv.body.version }, key())).status).toBe(403);
    expect((await sales.client.get(`/sales-invoices/${inv.body.id}`)).body.totals).toBeDefined();

    const d = await b.client.post('/dispatches', body(b, [{ itemId: b.bolt, qty: '1', unitPrice: '99' }], { warehouseId: b.main }));
    const keeper = await addMember(h, b.client, 'Storekeeper', 'salekeeper');
    keeper.client.tenantId = b.tenantId;
    const seen = await keeper.client.get(`/dispatches/${d.body.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.totals).toBeUndefined();
    expect(seen.body.lines[0].unitPrice).toBeUndefined();
    // A storekeeper changes quantities without seeing prices: the draft's price is kept.
    const fewer = await keeper.client.patch(`/dispatches/${d.body.id}`, { version: d.body.version, lines: [{ itemId: b.bolt, qty: '1' }] });
    expect(fewer.status, JSON.stringify(fewer.body)).toBe(200);
    expect((await b.client.get(`/dispatches/${d.body.id}`)).body.lines[0]).toMatchObject({ qty: '1', unitPrice: '99' });
    const posted = await keeper.client.post(`/dispatches/${d.body.id}/dispatch`, { version: fewer.body.version }, key());
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    // Without a draft line or order to take it from, the item's sale price is used.
    const direct = await keeper.client.post('/dispatches', { legalEntityId: b.entityId, gstRegistrationId: b.registrationId, partyId: b.customer, docDate: TODAY(), warehouseId: b.main, lines: [{ itemId: b.nut, qty: '2' }] });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    expect((await b.client.get(`/dispatches/${direct.body.id}`)).body.lines[0]).toMatchObject({ unitPrice: '10.00', total: '23.60' });
    expect((await keeper.client.get(`/sales-invoices/${inv.body.id}`)).status).toBe(403);
  });
});

describe('workflow and receivables', () => {
  it('the stock-out point cannot change while sales documents depend on it (FR-CO-04)', async () => {
    const b = await business('workflow');
    const draft = await b.client.post('/sales-orders', body(b, [{ itemId: b.bolt, qty: '1' }], { warehouseId: b.main }));
    const entity = await b.client.get(`/legal-entities/${b.entityId}`);
    const refused = await b.client.put(`/legal-entities/${b.entityId}/workflow`, { ...entity.body.workflow, stockOutPoint: 'invoice', version: entity.body.version });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/1 open sales order/);
    await b.client.post(`/sales-orders/${draft.body.id}/discard`, { version: draft.body.version });
    expect((await b.client.put(`/legal-entities/${b.entityId}/workflow`, { ...entity.body.workflow, stockOutPoint: 'invoice', version: entity.body.version })).status).toBe(200);
  });

  it('lists outstanding invoices with ageing buckets by due date (FR-SAL-09)', async () => {
    const b = await business('ageing', { opening: '0' });
    const issue = async (party: string, qty: string) => {
      const d = await b.client.post('/sales-invoices', body(b, [{ itemId: b.svc, qty }], { partyId: party }));
      return b.client.post(`/sales-invoices/${d.body.id}/issue`, { version: d.body.version }, key());
    };
    await issue(b.customer, '10'); // 118.00, due in 30 days
    await issue(b.b2c, '1'); // 11.80 → 12.00, due today (no payment terms)
    const now = await b.client.get(`/receivables?legalEntityId=${b.entityId}`);
    expect(now.body).toMatchObject({ total: '130.00', overdue: '0.00', truncated: false });
    expect(now.body.buckets).toMatchObject({ not_due: '130.00', d1_30: '0.00' });
    const later = await b.client.get(`/receivables?legalEntityId=${b.entityId}&asOf=${new Date(Date.parse(`${TODAY()}T00:00:00Z`) + 40 * DAY).toISOString().slice(0, 10)}`);
    expect(later.body).toMatchObject({ total: '130.00', overdue: '130.00' });
    expect(later.body.buckets).toMatchObject({ d1_30: '118.00', d31_60: '12.00' });
    expect(later.body.parties[0]).toMatchObject({ partyName: 'Buyer Traders (test)', outstanding: '118.00', invoices: 1 });
    const keeper = await addMember(h, b.client, 'Storekeeper', 'ageingkeeper');
    keeper.client.tenantId = b.tenantId;
    expect((await keeper.client.get(`/receivables?legalEntityId=${b.entityId}`)).status).toBe(403);
  });
});
