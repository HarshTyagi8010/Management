import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createHarness, setupEntity, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

interface Setup {
  client: Client;
  tenantId: string;
  entityId: string;
  w1: string;
  w2: string;
  bolt: string;
  steel: string;
}

/** A business with one entity, two warehouses and two stock items (NOS and KG). */
async function setup(label: string, opts: { allowNegative?: boolean } = {}): Promise<Setup> {
  const { client, tenantId } = await signUp(h, label);
  const { entityId, version } = await setupEntity(client);
  if (opts.allowNegative) {
    const wf = await client.put(`/legal-entities/${entityId}/workflow`, { version, stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: true, roundOffTotal: true });
    expect(wf.status).toBe(200);
  }
  const w1 = await client.post('/warehouses', { legalEntityId: entityId, code: 'main', name: 'Main godown (test)' });
  expect(w1.status, JSON.stringify(w1.body)).toBe(201);
  const w2 = await client.post('/warehouses', { legalEntityId: entityId, code: 'CITY', name: 'City shop (test)' });
  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const unit = (code: string) => units.find((u) => u.code === code)?.id;
  const taxClass = await client.post('/tax-classes', { name: 'Hardware (test)', kind: 'goods', treatment: 'taxable' });
  const item = async (sku: string, name: string, unitCode: string) => {
    const res = await client.post('/items', { sku, name, type: 'stock', baseUnitId: unit(unitCode), hsnSac: '7318', taxClassId: taxClass.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  return { client, tenantId, entityId, w1: w1.body.id, w2: w2.body.id, bolt: await item('BOLT-M8', 'Hex bolt M8 (test)', 'NOS'), steel: await item('STEEL-ROD', 'Steel rod (test)', 'KG') };
}

/** Stock commands carry an Idempotency-Key (Phase 6); each call here is a new attempt. */
async function post(client: Client, path: string, id: string, version: number, action: string) {
  return client.post(`${path}/${id}/${action}`, { version }, { 'Idempotency-Key': randomUUID() });
}

/** Creates and posts a stock adjustment or opening document; returns the posted document. */
async function adjust(s: Setup, warehouseId: string, lines: Array<{ itemId: string; qty: string; unitCost?: string | null }>, type: 'opening' | 'adjustment' = 'adjustment') {
  const draft = await s.client.post('/stock-adjustments', { warehouseId, type, reason: type === 'adjustment' ? 'correction' : null, docDate: TODAY(), lines: lines.map((l) => ({ unitCost: null, ...l })) });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return post(s.client, '/stock-adjustments', draft.body.id, draft.body.version, 'post');
}

async function summary(s: Setup, warehouseId?: string, client = s.client) {
  const res = await client.get(`/stock/summary?legalEntityId=${s.entityId}${warehouseId ? `&warehouseId=${warehouseId}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Array<{ itemId: string; sku: string; onHand: string; inTransit: string; avgCost?: string | null; value?: string; available: string }>;
}

async function reconcile(s: Setup) {
  const res = await s.client.get(`/stock/reconciliation?legalEntityId=${s.entityId}`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('warehouses (FR-INV-01)', () => {
  it('creates warehouses per entity with unique codes and an optional GST registration', async () => {
    const { client } = await signUp(h, 'wh');
    const a = await setupEntity(client);
    const b = await setupEntity(client, { legalName: 'Second Entity LLP (test)' });
    const created = await client.post('/warehouses', { legalEntityId: a.entityId, code: 'gdn-1', name: 'Godown 1 (test)', gstRegistrationId: a.registrationId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'GDN-1', gstRegistrationId: a.registrationId, archived: false });
    expect((await client.post('/warehouses', { legalEntityId: a.entityId, code: 'GDN-1', name: 'Again' })).body.error.details[0].path).toBe('code');
    // A registration of another entity is refused.
    expect((await client.post('/warehouses', { legalEntityId: a.entityId, code: 'GDN-2', name: 'X', gstRegistrationId: b.registrationId })).status).toBe(400);
    const list = await client.get(`/warehouses?legalEntityId=${a.entityId}`);
    expect(list.body.data.map((w: { code: string }) => w.code)).toEqual(['GDN-1']);
    const audit = await client.get('/audit-events?action=warehouse.created');
    expect(audit.body.data).toHaveLength(1);
  });

  it('refuses to archive a warehouse that holds stock', async () => {
    const s = await setup('wharchive');
    expect((await adjust(s, s.w1, [{ itemId: s.bolt, qty: '5', unitCost: '10' }], 'opening')).status).toBe(200);
    const wh = (await s.client.get(`/warehouses?legalEntityId=${s.entityId}`)).body.data.find((w: { id: string }) => w.id === s.w1);
    const res = await s.client.patch(`/warehouses/${s.w1}`, { version: wh.version, archived: true });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/still holds stock/);
    // The empty one can be archived; stock can then no longer go there.
    const empty = (await s.client.get(`/warehouses?legalEntityId=${s.entityId}`)).body.data.find((w: { id: string }) => w.id === s.w2);
    expect((await s.client.patch(`/warehouses/${s.w2}`, { version: empty.version, archived: true })).status).toBe(200);
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w2, type: 'opening', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1', unitCost: '1' }] })).status).toBe(400);
  });
});

describe('opening stock and adjustments (FR-INV-02/03/07/08)', () => {
  it('enters opening stock once per item and warehouse, valued at moving average', async () => {
    const s = await setup('opening');
    const opened = await adjust(s, s.w1, [{ itemId: s.bolt, qty: '100', unitCost: '2.5' }, { itemId: s.steel, qty: '12.5', unitCost: '64' }], 'opening');
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ status: 'posted', type: 'opening', totalValue: '1050.00' });
    expect(opened.body.number).toMatch(/^OPN-\d{6}$/);
    const rows = await summary(s, s.w1);
    expect(rows.find((r) => r.sku === 'BOLT-M8')).toMatchObject({ onHand: '100', avgCost: '2.500000', value: '250.00' });
    expect(rows.find((r) => r.sku === 'STEEL-ROD')).toMatchObject({ onHand: '12.500', value: '800.00' });

    const again = await adjust(s, s.w1, [{ itemId: s.bolt, qty: '1', unitCost: '1' }], 'opening');
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already has stock movements/);
    // Opening stock needs a cost and positive quantities.
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w2, type: 'opening', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '5' }] })).body.error.details[0].path).toBe('lines.0.unitCost');
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w2, type: 'opening', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '-5', unitCost: '1' }] })).status).toBe(400);
  });

  it('adjusts in and out with a reason, at the average cost, within unit decimals', async () => {
    const s = await setup('adjust');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '10', unitCost: '100' }], 'opening');
    // A reason is required (FR-INV-07).
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'adjustment', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '-1' }] })).body.error.details[0].path).toBe('reason');
    // NOS has no decimals.
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'adjustment', reason: 'damage', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '-1.5' }] })).body.error.details[0].path).toBe('lines.0.qty');
    // Future dates are refused.
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'adjustment', reason: 'damage', docDate: '2999-01-01', lines: [{ itemId: s.bolt, qty: '-1' }] })).body.error.details[0].path).toBe('docDate');

    const damaged = await adjust(s, s.w1, [{ itemId: s.bolt, qty: '-3' }]);
    expect(damaged.body.lines[0]).toMatchObject({ qty: '-3', unitCost: '100.000000', value: '-300.00' });
    const found = await adjust(s, s.w1, [{ itemId: s.bolt, qty: '7', unitCost: '130' }]);
    expect(found.body.lines[0]).toMatchObject({ value: '910.00' });
    // (700 + 910) / 14 = 115
    expect((await summary(s, s.w1)).find((r) => r.sku === 'BOLT-M8')).toMatchObject({ onHand: '14', avgCost: '115.000000', value: '1610.00' });
    // In without a cost uses the average; with no average at all a cost is required.
    expect((await adjust(s, s.w1, [{ itemId: s.bolt, qty: '1' }])).body.lines[0].unitCost).toBe('115.000000');
    const noCost = await adjust(s, s.w1, [{ itemId: s.steel, qty: '1' }]);
    expect(noCost.status).toBe(422);
    expect(noCost.body.error.message).toMatch(/no average cost/);
    expect((await reconcile(s)).ok).toBe(true);
  });

  it('blocks negative stock by default and never posts twice', async () => {
    const s = await setup('negative');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '2', unitCost: '10' }], 'opening');
    const tooMuch = await adjust(s, s.w1, [{ itemId: s.bolt, qty: '-3' }]);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');
    // The failed post left nothing behind: still a draft, still 2 on hand.
    const drafts = await s.client.get('/stock-adjustments?status=draft');
    expect(drafts.body.data).toHaveLength(1);
    expect((await summary(s, s.w1))[0]?.onHand).toBe('2');

    const draft = drafts.body.data[0];
    expect((await s.client.patch(`/stock-adjustments/${draft.id}`, { version: draft.version, lines: [{ itemId: s.bolt, qty: '-2' }] })).status).toBe(200);
    const ok = await post(s.client, '/stock-adjustments', draft.id, draft.version + 1, 'post');
    expect(ok.status).toBe(200);
    const replay = await post(s.client, '/stock-adjustments', draft.id, draft.version + 1, 'post');
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('INVALID_STATE');
    expect((await s.client.patch(`/stock-adjustments/${draft.id}`, { version: ok.body.version, note: 'late edit' })).body.error.code).toBe('INVALID_STATE');
    expect((await h.db.models.StockMovement.countDocuments({ tenantId: new Types.ObjectId(s.tenantId), sourceId: new Types.ObjectId(draft.id) }))).toBe(1);
  });

  it('refuses postings dated in a locked period', async () => {
    const s = await setup('periodlock');
    await h.db.models.LegalEntity.updateOne({ tenantId: new Types.ObjectId(s.tenantId), _id: new Types.ObjectId(s.entityId) }, { $set: { periodLockDate: '2026-03-31' } });
    const res = await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'opening', docDate: '2026-03-31', lines: [{ itemId: s.bolt, qty: '1', unitCost: '1' }] });
    expect(res.body.error.code).toBe('PERIOD_LOCKED');
  });

  it('with negative stock allowed, corrects the average on the next receipt with a revaluation', async () => {
    const s = await setup('negallowed', { allowNegative: true });
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '2', unitCost: '50' }], 'opening');
    expect((await adjust(s, s.w1, [{ itemId: s.bolt, qty: '-5' }])).status).toBe(200);
    let report = await reconcile(s);
    expect(report.ok).toBe(true);
    expect(report.negativeBalances).toEqual([expect.objectContaining({ sku: 'BOLT-M8', onHand: '-3' })]);
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '10', unitCost: '60' }]);
    expect((await summary(s, s.w1))[0]).toMatchObject({ onHand: '7', avgCost: '60.000000', value: '420.00' });
    const ledger = await s.client.get(`/stock/movements?legalEntityId=${s.entityId}&itemId=${s.bolt}`);
    expect(ledger.body.data[0]).toMatchObject({ kind: 'revalue', qty: '0', value: '-30.00' });
    report = await reconcile(s);
    expect(report).toMatchObject({ ok: true, negativeBalances: [] });
  });
});

describe('concurrent stock-outs (AC-INV-1)', () => {
  it('ten simultaneous transfers of the last 5 units: exactly one succeeds', async () => {
    const s = await setup('race');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '5', unitCost: '10' }], 'opening');
    const drafts = [];
    for (let i = 0; i < 10; i += 1) {
      const d = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '5' }] });
      expect(d.status).toBe(201);
      drafts.push(d.body as { id: string; version: number });
    }
    const results = await Promise.all(drafts.map((d) => post(s.client, '/stock-transfers', d.id, d.version, 'dispatch')));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((st) => st === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);
    const rows = await summary(s);
    expect(rows.find((r) => r.sku === 'BOLT-M8')).toMatchObject({ onHand: '0', inTransit: '5' });
    expect((await reconcile(s)).ok).toBe(true);
  }, 120_000);

  it('simultaneous adjustments never take stock below zero', async () => {
    const s = await setup('race2');
    await adjust(s, s.w1, [{ itemId: s.steel, qty: '3', unitCost: '10' }], 'opening');
    const drafts = [];
    for (let i = 0; i < 6; i += 1) {
      drafts.push((await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'adjustment', reason: 'loss', docDate: TODAY(), lines: [{ itemId: s.steel, qty: '-1' }] })).body as { id: string; version: number });
    }
    const results = await Promise.all(drafts.map((d) => post(s.client, '/stock-adjustments', d.id, d.version, 'post')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect((await summary(s, s.w1)).find((r) => r.sku === 'STEEL-ROD')).toMatchObject({ onHand: '0.000', value: '0.00' });
    expect((await reconcile(s)).ok).toBe(true);
  }, 120_000);
});

describe('transfers (FR-INV-06)', () => {
  it('dispatches into transit, receives at the same value, and keeps the entity valuation unchanged', async () => {
    const s = await setup('transfer');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '10', unitCost: '12.5' }], 'opening');
    const valuationBefore = (await s.client.get(`/stock/valuation?legalEntityId=${s.entityId}`)).body;
    expect(valuationBefore.totalValue).toBe('125.00');

    const draft = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '4' }] });
    expect(draft.body.number).toMatch(/^TRF-\d{6}$/);
    const dispatched = await post(s.client, '/stock-transfers', draft.body.id, draft.body.version, 'dispatch');
    expect(dispatched.body).toMatchObject({ status: 'dispatched', lines: [{ qty: '4', unitCost: '12.500000', value: '50.00' }] });
    expect((await summary(s, s.w1))[0]).toMatchObject({ onHand: '6', inTransit: '0' });
    expect((await summary(s, s.w2))[0]).toMatchObject({ onHand: '0', inTransit: '4' });
    // Goods in transit are still the entity's stock.
    expect((await s.client.get(`/stock/valuation?legalEntityId=${s.entityId}`)).body.rows[0]).toMatchObject({ qty: '10', value: '125.00' });
    expect((await reconcile(s)).ok).toBe(true);

    const received = await post(s.client, '/stock-transfers', draft.body.id, dispatched.body.version, 'receive');
    expect(received.body.status).toBe('received');
    expect((await summary(s, s.w2))[0]).toMatchObject({ onHand: '4', inTransit: '0', value: '50.00' });
    expect((await summary(s))[0]).toMatchObject({ onHand: '10' });
    expect((await post(s.client, '/stock-transfers', draft.body.id, received.body.version, 'cancel')).body.error.code).toBe('INVALID_STATE');

    const ledger = await s.client.get(`/stock/movements?legalEntityId=${s.entityId}&itemId=${s.bolt}`);
    expect(ledger.body.data.map((m: { kind: string; qty: string; warehouseCode: string }) => [m.kind, m.qty, m.warehouseCode])).toEqual([
      ['transfer_in', '4', 'CITY'],
      ['transfer_out', '-4', 'MAIN'],
      ['opening', '10', 'MAIN'],
    ]);
    expect((await reconcile(s)).ok).toBe(true);
  });

  it('cancelling a dispatched transfer returns the stock to the source with a reversal', async () => {
    const s = await setup('transfercancel');
    await adjust(s, s.w1, [{ itemId: s.steel, qty: '5.25', unitCost: '80' }], 'opening');
    const draft = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.steel, qty: '2.125' }] });
    const dispatched = await post(s.client, '/stock-transfers', draft.body.id, draft.body.version, 'dispatch');
    const cancelled = await post(s.client, '/stock-transfers', draft.body.id, dispatched.body.version, 'cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect((await summary(s, s.w1)).find((r) => r.sku === 'STEEL-ROD')).toMatchObject({ onHand: '5.250', value: '420.00' });
    expect((await summary(s, s.w2)).find((r) => r.sku === 'STEEL-ROD')).toMatchObject({ onHand: '0.000', inTransit: '0.000' });
    const ledger = (await s.client.get(`/stock/movements?legalEntityId=${s.entityId}`)).body.data;
    expect(ledger[0]).toMatchObject({ kind: 'transfer_out', qty: '2.125', reversal: true });
    expect((await reconcile(s)).ok).toBe(true);
  });

  it('keeps transfers inside one business entity', async () => {
    const s = await setup('transferentity');
    const other = await setupEntity(s.client, { legalName: 'Other Entity Pvt Ltd (test)' });
    const far = await s.client.post('/warehouses', { legalEntityId: other.entityId, code: 'FAR', name: 'Far godown (test)' });
    const res = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: far.body.id, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/same business entity/);
    expect((await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w1, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1' }] })).status).toBe(400);
  });
});

describe('stock counts (FR-INV-07, workflows §9)', () => {
  it('counts, refuses a stale count, and posts variances as adjustments; uncounted items are left alone', async () => {
    const s = await setup('count');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '20', unitCost: '5' }, { itemId: s.steel, qty: '10', unitCost: '40' }], 'opening');
    const created = await s.client.post('/stock-counts', { warehouseId: s.w1, scope: 'all' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', number: expect.stringMatching(/^CNT-/) });
    expect(created.body.lines).toHaveLength(2);
    // Quantities can't be entered before counting starts.
    expect((await s.client.patch(`/stock-counts/${created.body.id}`, { version: created.body.version, lines: [{ itemId: s.bolt, countedQty: '18' }] })).body.error.code).toBe('INVALID_STATE');

    const started = await post(s.client, '/stock-counts', created.body.id, created.body.version, 'start');
    expect(started.body.lines.find((l: { sku: string }) => l.sku === 'BOLT-M8')).toMatchObject({ expectedQty: '20', countedQty: null });
    const counted = await s.client.patch(`/stock-counts/${created.body.id}`, { version: started.body.version, lines: [{ itemId: s.bolt, countedQty: '18' }] });
    expect(counted.body.lines.find((l: { sku: string }) => l.sku === 'BOLT-M8')).toMatchObject({ countedQty: '18', variance: '-2' });
    const submitted = await post(s.client, '/stock-counts', created.body.id, counted.body.version, 'submit');
    expect(submitted.body).toMatchObject({ status: 'submitted', countedLines: 1 });

    // Stock moves after the snapshot: posting is refused until the count is refreshed.
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '-1' }]);
    const stale = await post(s.client, '/stock-counts', created.body.id, submitted.body.version, 'post');
    expect(stale.status).toBe(422);
    expect(stale.body.error.details[0].message).toBe('BOLT-M8');
    const reopened = await post(s.client, '/stock-counts', created.body.id, submitted.body.version, 'reopen');
    expect(reopened.body.lines.find((l: { sku: string }) => l.sku === 'BOLT-M8')).toMatchObject({ expectedQty: '19', countedQty: '18', variance: '-1' });
    const resubmitted = await post(s.client, '/stock-counts', created.body.id, reopened.body.version, 'submit');
    const posted = await post(s.client, '/stock-counts', created.body.id, resubmitted.body.version, 'post');
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.status).toBe('posted');

    const rows = await summary(s, s.w1);
    expect(rows.find((r) => r.sku === 'BOLT-M8')?.onHand).toBe('18');
    // Steel was not counted, so it is untouched (never treated as zero).
    expect(rows.find((r) => r.sku === 'STEEL-ROD')?.onHand).toBe('10.000');
    const ledger = (await s.client.get(`/stock/movements?legalEntityId=${s.entityId}`)).body.data;
    expect(ledger[0]).toMatchObject({ kind: 'adjust', qty: '-1', source: { type: 'stock_count', number: posted.body.number } });
    expect((await reconcile(s)).ok).toBe(true);
  });

  it('lets a storekeeper count but only someone with stock.count.post post it', async () => {
    const s = await setup('countroles');
    const keeper = await addMember(h, s.client, 'Storekeeper', 'countkeeper');
    keeper.client.tenantId = s.tenantId;
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '4', unitCost: '5' }], 'opening');
    const c = await keeper.client.post('/stock-counts', { warehouseId: s.w1, scope: 'items', itemIds: [s.bolt] });
    expect(c.status).toBe(201);
    const started = await post(keeper.client, '/stock-counts', c.body.id, c.body.version, 'start');
    // Costs are not theirs to enter.
    expect((await keeper.client.patch(`/stock-counts/${c.body.id}`, { version: started.body.version, lines: [{ itemId: s.bolt, countedQty: '6', unitCost: '1' }] })).status).toBe(403);
    const entered = await keeper.client.patch(`/stock-counts/${c.body.id}`, { version: started.body.version, lines: [{ itemId: s.bolt, countedQty: '6' }] });
    // Storekeepers don't see costs.
    expect(entered.body.lines[0]).not.toHaveProperty('unitCost');
    const submitted = await post(keeper.client, '/stock-counts', c.body.id, entered.body.version, 'submit');
    expect((await post(keeper.client, '/stock-counts', c.body.id, submitted.body.version, 'post')).status).toBe(403);
    const posted = await post(s.client, '/stock-counts', c.body.id, submitted.body.version, 'post');
    expect(posted.status).toBe(200);
    // Found stock enters at the current average cost.
    expect((await summary(s, s.w1))[0]).toMatchObject({ onHand: '6', avgCost: '5.000000', value: '30.00' });
  });
});

describe('warehouse scope (FR-RBAC-03)', () => {
  it('limits a storekeeper to chosen warehouses', async () => {
    const s = await setup('whscope');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '10', unitCost: '3' }], 'opening');
    await adjust(s, s.w2, [{ itemId: s.bolt, qty: '7', unitCost: '3' }], 'opening');
    const keeper = await addMember(h, s.client, 'Storekeeper', 'whkeeper');
    keeper.client.tenantId = s.tenantId;
    const member = ((await s.client.get('/members')).body.data as Array<{ id: string; userId: string; version: number }>).find((m) => m.userId === keeper.userId);
    const limited = await s.client.patch(`/members/${member?.id}`, { version: member?.version, warehouseIds: [s.w2] });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body.warehouseIds).toEqual([s.w2]);
    const context = await keeper.client.get('/tenant/context');
    expect(context.body.warehouseScopes['stock.move']).toEqual([s.w2]);

    // Sees only the city shop's stock, with no costs.
    const city = await summary(s, undefined, keeper.client);
    expect(city[0]).toMatchObject({ onHand: '7' });
    expect(city[0]).not.toHaveProperty('value');
    expect((await keeper.client.get(`/stock/summary?legalEntityId=${s.entityId}&warehouseId=${s.w1}`)).status).toBe(403);
    expect((await keeper.client.get(`/stock/movements?legalEntityId=${s.entityId}`)).body.data.every((m: { warehouseCode: string }) => m.warehouseCode === 'CITY')).toBe(true);

    // Can't send from the main godown, can send from the shop, and the owner's transfer into the shop can be received by them.
    expect((await keeper.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1' }] })).status).toBe(403);
    expect((await keeper.client.post('/stock-transfers', { fromWarehouseId: s.w2, toWarehouseId: s.w1, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1' }] })).status).toBe(201);
    const inbound = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '2' }] });
    const dispatched = await post(s.client, '/stock-transfers', inbound.body.id, inbound.body.version, 'dispatch');
    expect((await post(keeper.client, '/stock-transfers', inbound.body.id, dispatched.body.version, 'receive')).status).toBe(200);
    // Entity-wide valuation is not for them.
    expect((await keeper.client.get(`/stock/valuation?legalEntityId=${s.entityId}`)).status).toBe(403);
  });

  it('validates warehouse scopes and stops escalation through them', async () => {
    const s = await setup('whscope2');
    const other = await setupEntity(s.client, { legalName: 'Scope Other LLP (test)' });
    const far = await s.client.post('/warehouses', { legalEntityId: other.entityId, code: 'FAR', name: 'Far (test)' });
    const admin = await addMember(h, s.client, 'Admin', 'whadmin');
    admin.client.tenantId = s.tenantId;
    const members = (await s.client.get('/members')).body.data as Array<{ id: string; userId: string; version: number }>;
    const adminMember = members.find((m) => m.userId === admin.userId);
    // Warehouses must belong to the chosen entities.
    expect((await s.client.patch(`/members/${adminMember?.id}`, { version: adminMember?.version, legalEntityIds: [s.entityId], warehouseIds: [far.body.id] })).body.error.details[0].path).toBe('warehouseIds');
    const scoped = await s.client.patch(`/members/${adminMember?.id}`, { version: adminMember?.version, warehouseIds: [s.w1] });
    expect(scoped.status).toBe(200);
    // The warehouse-limited admin cannot invite someone with access to every warehouse.
    const roles = (await s.client.get('/roles')).body.data as Array<{ id: string; name: string }>;
    const keeperRole = roles.find((r) => r.name === 'Storekeeper')?.id;
    const wide = await admin.client.post('/invitations', { email: `wide.${Date.now()}@example.test`, roleIds: [keeperRole] });
    expect(wide.status).toBe(403);
    // Within their own warehouse they can.
    expect((await admin.client.post('/invitations', { email: `narrow.${Date.now()}@example.test`, roleIds: [keeperRole], warehouseIds: [s.w1] })).status).toBe(201);
    // The Owner role is never limited.
    const ownerRole = roles.find((r) => r.name === 'Owner')?.id;
    expect((await s.client.post('/invitations', { email: `own.${Date.now()}@example.test`, roleIds: [ownerRole], warehouseIds: [s.w1] })).status).toBe(400);
  });
});

describe('ledger integrity', () => {
  it('stock movements are append-only, also at the database level', async () => {
    const s = await setup('appendonly');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '1', unitCost: '1' }], 'opening');
    const tenantId = new Types.ObjectId(s.tenantId);
    await expect(h.db.models.StockMovement.updateOne({ tenantId }, { $set: { qty: Types.Decimal128.fromString('99') } })).rejects.toThrow(/append-only/);
    await expect(h.db.models.StockMovement.deleteMany({ tenantId })).rejects.toThrow(/append-only/);
    // The $jsonSchema validator refuses non-decimal quantities from any client.
    const raw = h.db.connection.db?.collection('stockMovements');
    const sample = await raw?.findOne({ tenantId });
    await expect(raw?.insertOne({ ...sample, _id: new Types.ObjectId(), qty: 5, sourceLineId: 'other' })).rejects.toThrow(/validation/i);
  });

  it('locks an item’s type and base unit once stock has moved, and refuses to archive it with stock', async () => {
    const s = await setup('itemlock');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '3', unitCost: '1' }], 'opening');
    const item = (await s.client.get(`/items/${s.bolt}`)).body;
    const units = (await s.client.get('/units')).body.data as Array<{ id: string; code: string }>;
    const changeUnit = await s.client.patch(`/items/${s.bolt}`, { version: item.version, baseUnitId: units.find((u) => u.code === 'PCS')?.id });
    expect(changeUnit.status).toBe(422);
    expect((await s.client.patch(`/items/${s.bolt}`, { version: item.version, archived: true })).body.error.message).toMatch(/still has stock/);
    expect((await s.client.patch(`/items/${s.bolt}`, { version: item.version, name: 'Hex bolt M8 zinc (test)' })).status).toBe(200);
  });
});

describe('reconciliation (FR-INV-09, AC-INV-2)', () => {
  it('reports zero drift after a random sequence of movements, then detects injected drift', async () => {
    const s = await setup('recon');
    await adjust(s, s.w1, [{ itemId: s.bolt, qty: '200', unitCost: '7.25' }, { itemId: s.steel, qty: '150.5', unitCost: '61.333' }], 'opening');
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 25; i += 1) {
      const item = rand(2) === 0 ? s.bolt : s.steel;
      const qty = item === s.bolt ? String(rand(9) + 1) : `${rand(9) + 1}.${rand(1000)}`;
      const action = rand(4);
      if (action === 0) await adjust(s, s.w1, [{ itemId: item, qty, unitCost: `${rand(90) + 1}.${rand(100)}` }]);
      else if (action === 1) await adjust(s, rand(2) ? s.w1 : s.w2, [{ itemId: item, qty: `-${qty}` }]);
      else {
        const [from, to] = rand(2) ? [s.w1, s.w2] : [s.w2, s.w1];
        const d = await s.client.post('/stock-transfers', { fromWarehouseId: from, toWarehouseId: to, docDate: TODAY(), lines: [{ itemId: item, qty }] });
        const sent = await post(s.client, '/stock-transfers', d.body.id, d.body.version, 'dispatch');
        if (sent.status === 200 && action === 2) await post(s.client, '/stock-transfers', d.body.id, sent.body.version, 'receive');
      }
    }
    const clean = await reconcile(s);
    expect(clean.issues).toEqual([]);
    expect(clean.ok).toBe(true);
    expect(clean.balancesChecked).toBeGreaterThanOrEqual(2);

    // Simulate corruption outside the application (e.g. a bad manual edit).
    const tenantId = new Types.ObjectId(s.tenantId);
    await h.db.models.StockBalance.updateOne({ tenantId, warehouseId: new Types.ObjectId(s.w1), itemId: new Types.ObjectId(s.bolt) }, { $inc: { onHand: Types.Decimal128.fromString('1') } });
    await h.db.models.ItemValuation.updateOne({ tenantId, itemId: new Types.ObjectId(s.steel) }, { $inc: { value: Types.Decimal128.fromString('0.01') } });
    const drift = await reconcile(s);
    expect(drift.ok).toBe(false);
    expect(drift.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'on_hand', sku: 'BOLT-M8', warehouseId: s.w1 }),
        expect.objectContaining({ kind: 'valuation_value', sku: 'STEEL-ROD' }),
      ]),
    );
    const onHand = drift.issues.find((i: { kind: string }) => i.kind === 'on_hand');
    expect(onHand.actual).not.toBe(onHand.expected);
  }, 120_000);
});
