import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { trusted, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ACCOUNTS } from '@bizmgmt/contracts';
import { buildWorkerTasks, outboxConsumer, scheduler, integrityJobs } from '../../src/jobs/index.js';
import { MIGRATIONS } from '../../src/migrations/index.js';
import { reconcileJournals } from '../../src/modules/finance/journals.js';
import { withTransaction } from '../../src/platform/transactions.js';
import { addMember, address, createHarness, fakeGstin, setupEntity, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic test fixture (not a real notification)';
const key = () => ({ 'Idempotency-Key': randomUUID() });
const silent = pino({ level: 'silent' });

interface Setup {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  pan: string;
  w1: string;
  w2: string;
  bolt: string;
  goodsClass: string;
}

async function setup(label: string): Promise<Setup> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);
  const w1 = await client.post('/warehouses', { legalEntityId: e.entityId, code: 'MAIN', name: 'Main (test)', gstRegistrationId: e.registrationId });
  const w2 = await client.post('/warehouses', { legalEntityId: e.entityId, code: 'CITY', name: 'City (test)', gstRegistrationId: e.registrationId });
  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const goods = await client.post('/tax-classes', { name: 'Hardware (test)', kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '18', sourceReference: SOURCE });
  const bolt = await client.post('/items', { sku: 'BOLT', name: 'Bolt (test)', type: 'stock', baseUnitId: units.find((u) => u.code === 'NOS')?.id, hsnSac: '7318', taxClassId: goods.body.id });
  return { client, tenantId, entityId: e.entityId, registrationId: e.registrationId, pan: e.pan, w1: w1.body.id, w2: w2.body.id, bolt: bolt.body.id, goodsClass: goods.body.id };
}

async function adjust(s: Setup, lines: Array<{ itemId: string; qty: string; unitCost?: string | null }>, type: 'opening' | 'adjustment' = 'adjustment', warehouseId = s.w1) {
  const draft = await s.client.post('/stock-adjustments', { warehouseId, type, reason: type === 'adjustment' ? 'correction' : null, docDate: TODAY(), lines: lines.map((l) => ({ unitCost: null, ...l })) });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  return s.client.post(`/stock-adjustments/${draft.body.id}/post`, { version: draft.body.version }, key());
}

describe('document numbering (AC-NUM-1)', () => {
  it('100 concurrent issues on one series give 100 distinct, gap-free numbers; failed issues use none', async () => {
    const s = await setup('numbering');
    const series = await s.client.post('/document-series', { legalEntityId: s.entityId, gstRegistrationId: s.registrationId, docType: 'tax_invoice', name: 'Invoices', prefix: 'INV/{FY}/', padding: 4 });
    expect(series.status).toBe(201);
    const tenantId = new Types.ObjectId(s.tenantId);
    const seriesId = new Types.ObjectId(series.body.id);
    const numbering = h.modules.numbering;
    await numbering.prepare(tenantId, seriesId, TODAY());
    // Preparing the counter does not lock the series; issuing does.
    expect((await s.client.get(`/document-series?legalEntityId=${s.entityId}`)).body.data[0].locked).toBe(false);

    const results = await Promise.allSettled(
      Array.from({ length: 133 }, (_, i) =>
        withTransaction(h.db.connection, async (session) => {
          const issued = await numbering.take(session, tenantId, seriesId, TODAY());
          // Every fourth attempt fails after taking a number: its transaction rolls back.
          if (i % 4 === 3) throw new Error('simulated failure after taking a number');
          return issued.number;
        }),
      ),
    );
    const numbers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(33);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);
    const fy = (() => {
      const [y = 0, m = 0] = TODAY().split('-').map(Number);
      const start = m >= 4 ? y : y - 1;
      return `${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, '0')}`;
    })();
    const expected = Array.from({ length: 100 }, (_, i) => `INV/${fy}/${String(i + 1).padStart(4, '0')}`);
    expect([...numbers].sort()).toEqual(expected);
    expect(numbers.every((n) => n.length <= 16)).toBe(true);
    // The series format is now locked.
    const listed = (await s.client.get(`/document-series?legalEntityId=${s.entityId}`)).body.data[0];
    expect(listed.locked).toBe(true);
    expect((await s.client.patch(`/document-series/${series.body.id}`, { version: listed.version, prefix: 'X/' })).status).toBe(422);
  }, 120_000);
});

describe('idempotency keys (AC-IDEM-1)', () => {
  it('replays a repeated command, refuses a reused key, and records nothing for failed commands', async () => {
    const s = await setup('idem');
    const draft = await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'opening', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '10', unitCost: '5' }] });
    const path = `/stock-adjustments/${draft.body.id}/post`;
    expect((await s.client.post(path, { version: 0 })).body.error).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/Idempotency-Key/) });

    const k = { 'Idempotency-Key': randomUUID() };
    const first = await s.client.post(path, { version: 0 }, k);
    expect(first.status).toBe(200);
    const replay = await s.client.post(path, { version: 0 }, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const tenantId = new Types.ObjectId(s.tenantId);
    expect(await h.db.models.StockMovement.countDocuments({ tenantId, sourceId: new Types.ObjectId(draft.body.id) })).toBe(1);
    // Same key, different request.
    expect((await s.client.post(path, { version: 1 }, k)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Another user may not use someone else's key.
    const accountant = await addMember(h, s.client, 'Accountant', 'idemacct');
    accountant.client.tenantId = s.tenantId;
    expect((await accountant.client.post(path, { version: 0 }, k)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A failed command leaves no record: the same key works once the problem is fixed.
    const out = await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'adjustment', reason: 'loss', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '-11' }] });
    const k2 = { 'Idempotency-Key': randomUUID() };
    expect((await s.client.post(`/stock-adjustments/${out.body.id}/post`, { version: 0 }, k2)).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await h.db.models.IdempotencyKey.countDocuments({ tenantId, key: k2['Idempotency-Key'] })).toBe(0);
    await s.client.patch(`/stock-adjustments/${out.body.id}`, { version: 0, lines: [{ itemId: s.bolt, qty: '-4' }] });
    // The body changed (new version), so this is a new request under the same unused key.
    expect((await s.client.post(`/stock-adjustments/${out.body.id}/post`, { version: 1 }, k2)).status).toBe(200);
  });

  it('runs a command once when the same key arrives twice at the same moment', async () => {
    const s = await setup('idemrace');
    const draft = await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'opening', docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '3', unitCost: '5' }] });
    const k = { 'Idempotency-Key': randomUUID() };
    const results = await Promise.all(Array.from({ length: 5 }, () => s.client.post(`/stock-adjustments/${draft.body.id}/post`, { version: 0 }, k)));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 200 || (r.status === 409 && ['IDEMPOTENCY_IN_PROGRESS', 'INVALID_STATE', 'VERSION_CONFLICT'].includes(r.body.error.code)))).toBe(true);
    expect(await h.db.models.StockMovement.countDocuments({ tenantId: new Types.ObjectId(s.tenantId), sourceId: new Types.ObjectId(draft.body.id) })).toBe(1);
  });
});

describe('journals (AC-JRN-1, ADR-011)', () => {
  it('gives every new business entity its system accounts', async () => {
    const s = await setup('accounts');
    const accounts = await s.client.get(`/accounts?legalEntityId=${s.entityId}`);
    expect(accounts.body.data).toHaveLength(SYSTEM_ACCOUNTS.length);
    expect(accounts.body.data.find((a: { code: string }) => a.code === '1300')).toMatchObject({ name: 'Inventory', type: 'asset' });
  });

  it('posts a balanced journal for each stock posting; the inventory account equals the stock valuation', async () => {
    const s = await setup('journals');
    await adjust(s, [{ itemId: s.bolt, qty: '10', unitCost: '12.5' }], 'opening');
    await adjust(s, [{ itemId: s.bolt, qty: '-2' }]);
    await adjust(s, [{ itemId: s.bolt, qty: '4', unitCost: '20' }]);
    // A transfer between warehouses of the entity changes nothing in the books.
    const t = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '3' }] });
    await s.client.post(`/stock-transfers/${t.body.id}/dispatch`, { version: t.body.version }, key());

    const journals = (await s.client.get(`/journals?legalEntityId=${s.entityId}`)).body.data as Array<{ narration: string; sourceType: string; lines: Array<{ accountCode: string; debit: string; credit: string }>; totalDebit: string; totalCredit: string }>;
    expect(journals).toHaveLength(3);
    const [found, damaged, opening] = journals;
    expect(opening?.lines).toEqual([
      { accountCode: '1300', accountName: 'Inventory', debit: '125.00', credit: '0.00' },
      { accountCode: '3100', accountName: 'Opening balances', debit: '0.00', credit: '125.00' },
    ]);
    expect(damaged?.lines).toEqual([
      { accountCode: '5300', accountName: 'Inventory adjustments', debit: '25.00', credit: '0.00' },
      { accountCode: '1300', accountName: 'Inventory', debit: '0.00', credit: '25.00' },
    ]);
    expect(found).toMatchObject({ totalDebit: '80.00', totalCredit: '80.00' });
    expect(journals.every((j) => j.totalDebit === j.totalCredit)).toBe(true);

    const tb = (await s.client.get(`/reports/trial-balance?legalEntityId=${s.entityId}`)).body;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.rows.find((r: { code: string }) => r.code === '1300')).toMatchObject({ debit: '180.00' });
    const valuation = (await s.client.get(`/stock/valuation?legalEntityId=${s.entityId}`)).body;
    expect(valuation.totalValue).toBe('180.00');
    expect(await reconcileJournals(h.db.models, new Types.ObjectId(s.tenantId))).toMatchObject({ journalsChecked: 3, issues: [] });
  });

  it('posts the negative-stock correction to cost of goods sold, and counts as adjustments', async () => {
    const s = await setup('journalsneg');
    const entity = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    await s.client.put(`/legal-entities/${s.entityId}/workflow`, { ...entity.workflow, allowNegativeStock: true, version: entity.version });
    await adjust(s, [{ itemId: s.bolt, qty: '2', unitCost: '50' }], 'opening');
    await adjust(s, [{ itemId: s.bolt, qty: '-5' }]);
    await adjust(s, [{ itemId: s.bolt, qty: '10', unitCost: '60' }]);
    const latest = (await s.client.get(`/journals?legalEntityId=${s.entityId}`)).body.data[0];
    // In 600 at receipt cost, then −30 revaluation to COGS: inventory net +570.
    expect(latest.lines).toEqual(
      expect.arrayContaining([
        { accountCode: '1300', accountName: 'Inventory', debit: '570.00', credit: '0.00' },
        { accountCode: '5300', accountName: 'Inventory adjustments', debit: '0.00', credit: '600.00' },
        { accountCode: '5200', accountName: 'Cost of goods sold', debit: '30.00', credit: '0.00' },
      ]),
    );
    const count = await s.client.post('/stock-counts', { warehouseId: s.w1, scope: 'items', itemIds: [s.bolt] });
    const started = await s.client.post(`/stock-counts/${count.body.id}/start`, { version: count.body.version });
    const entered = await s.client.patch(`/stock-counts/${count.body.id}`, { version: started.body.version, lines: [{ itemId: s.bolt, countedQty: '6' }] });
    const submitted = await s.client.post(`/stock-counts/${count.body.id}/submit`, { version: entered.body.version });
    expect((await s.client.post(`/stock-counts/${count.body.id}/post`, { version: submitted.body.version }, key())).status).toBe(200);
    const countJournal = (await s.client.get(`/journals?legalEntityId=${s.entityId}&sourceId=${count.body.id}`)).body.data;
    expect(countJournal[0]).toMatchObject({ sourceType: 'stock_count', totalDebit: '60.00' });
    expect(await reconcileJournals(h.db.models, new Types.ObjectId(s.tenantId))).toMatchObject({ issues: [] });
  });

  it('detects unbalanced journals and a books-versus-stock mismatch; journals are append-only', async () => {
    const s = await setup('journaldrift');
    await adjust(s, [{ itemId: s.bolt, qty: '1', unitCost: '10' }], 'opening');
    const tenantId = new Types.ObjectId(s.tenantId);
    await expect(h.db.models.Journal.updateOne({ tenantId }, { $set: { narration: 'x' } })).rejects.toThrow(/append-only/);
    const journal = await h.db.models.Journal.findOne({ tenantId }).lean();
    if (!journal) throw new Error('no journal');
    // Simulate a bad write from outside the application.
    await h.db.connection.db?.collection('journals').insertOne({ ...journal, _id: new Types.ObjectId(), sourceId: new Types.ObjectId(), lines: [journal.lines[0], { ...journal.lines[1], credit: Types.Decimal128.fromString('9.99') }] });
    await h.db.models.ItemValuation.updateOne({ tenantId }, { $inc: { value: Types.Decimal128.fromString('1') } });
    const r = await reconcileJournals(h.db.models, tenantId);
    expect(r.issues.map((i) => i.kind).sort()).toEqual(['inventory_mismatch', 'totals_mismatch', 'unbalanced']);
  });

  it('migration 004 posts journals for stock posted before journals existed', async () => {
    const s = await setup('backfill');
    await adjust(s, [{ itemId: s.bolt, qty: '7', unitCost: '3' }], 'opening');
    const tenantId = new Types.ObjectId(s.tenantId);
    await h.db.connection.db?.collection('journals').deleteMany({ tenantId });
    const migration = MIGRATIONS.find((m) => m.id === '004-financial-engine');
    await migration?.up({ connection: h.db.connection, models: h.db.models });
    const journals = await h.db.models.Journal.find({ tenantId }).lean();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.totalDebit.toString()).toBe('21.00');
    // Running it again adds nothing.
    await migration?.up({ connection: h.db.connection, models: h.db.models });
    expect(await h.db.models.Journal.countDocuments({ tenantId })).toBe(1);
  });
});

describe('calculation preview (financial-policy §2–5)', () => {
  it('splits CGST/SGST within the state and IGST across states, at the rate in force on the date', async () => {
    const s = await setup('preview');
    const party = await s.client.post('/parties', { name: 'Buyer (test)', isCustomer: true, isSupplier: false });
    const body = { legalEntityId: s.entityId, gstRegistrationId: s.registrationId, partyId: party.body.id, docDate: TODAY(), placeOfSupply: '27', documentDiscount: '10', lines: [{ itemId: s.bolt, qty: '3', unitPrice: '33.33', discount: null }] };
    const intra = await s.client.post('/calc/preview', body);
    expect(intra.status, JSON.stringify(intra.body)).toBe(200);
    expect(intra.body).toMatchObject({ calcVersion: 'calc-1', documentKind: 'tax_invoice', supply: 'intra', buyer: { name: 'Buyer (test)' }, seller: { gstin: expect.any(String), stateCode: '27' } });
    // 99.99 − 10.00 = 89.99; 9% of 89.99 = 8.0991 → 8.10 each; 106.19 rounds to 106.00.
    expect(intra.body.totals).toMatchObject({ taxable: '89.99', cgst: '8.10', sgst: '8.10', igst: '0.00', subtotal: '106.19', roundOff: '-0.19', grand: '106.00' });
    expect(intra.body.lines[0]).toMatchObject({ item: { sku: 'BOLT', hsnSac: '7318', uqc: 'NOS' }, taxRate: '18' });
    const inter = await s.client.post('/calc/preview', { ...body, placeOfSupply: '29' });
    expect(inter.body.totals).toMatchObject({ igst: '16.20', cgst: '0.00' });
    // Chandigarh (04) is a UT without legislature, but intra-state needs the seller there too; inter-state stays IGST.
    expect((await s.client.post('/calc/preview', { ...body, placeOfSupply: '04' })).body.totals.igst).toBe('16.20');
    // Before the rate starts there is no rate: refused, with the reason.
    const early = await s.client.post('/calc/preview', { ...body, docDate: '2017-06-30' });
    expect(early.status).toBe(400);
    expect((await s.client.post('/calc/preview', { ...body, lines: [{ itemId: s.bolt, qty: '1', unitPrice: '0', discount: null }] })).body.error.details[0].path).toBe('lines.0.unitPrice');
    expect((await s.client.post('/calc/preview', { ...body, lines: [{ itemId: s.bolt, qty: '1.5', unitPrice: '1', discount: null }] })).body.error.details[0].path).toBe('lines.0.qty');
  });

  it('uses UTGST in a Union Territory, bills of supply for composition, and no tax for exempt items', async () => {
    const { client } = await signUp(h, 'previewut');
    const pan = (await setupEntity(client, { stateCode: '04', pincode: '160001' })).pan;
    const entities = (await client.get('/legal-entities')).body.data;
    const entityId = entities[0].id as string;
    const regs = (await client.get(`/legal-entities/${entityId}/registrations`)).body.data;
    const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
    const goods = await client.post('/tax-classes', { name: 'Goods (test)', kind: 'goods', treatment: 'taxable' });
    await client.post(`/tax-classes/${goods.body.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '5', sourceReference: SOURCE });
    const exempt = await client.post('/tax-classes', { name: 'Exempt (test)', kind: 'goods', treatment: 'exempt' });
    const unit = units.find((u) => u.code === 'NOS')?.id;
    const a = await client.post('/items', { sku: 'A', name: 'A (test)', type: 'stock', baseUnitId: unit, hsnSac: '1001', taxClassId: goods.body.id });
    const b = await client.post('/items', { sku: 'B', name: 'B (test)', type: 'stock', baseUnitId: unit, hsnSac: '1002', taxClassId: exempt.body.id });
    const body = { legalEntityId: entityId, gstRegistrationId: regs[0].id, docDate: TODAY(), placeOfSupply: '04', lines: [{ itemId: a.body.id, qty: '1', unitPrice: '100' }, { itemId: b.body.id, qty: '1', unitPrice: '50' }] };
    const ut = await client.post('/calc/preview', body);
    expect(ut.body.totals).toMatchObject({ cgst: '2.50', utgst: '2.50', sgst: '0.00', taxable: '150.00', grand: '155.00' });
    expect(ut.body.lines[1]).toMatchObject({ taxRate: null, total: '50.00' });
    // A composition registration issues a bill of supply without tax.
    const comp = await client.post(`/legal-entities/${entityId}/registrations`, { gstin: fakeGstin('29', pan), registrationType: 'composition', effectiveFrom: '2017-07-01', address: address('29', '560001') });
    const bos = await client.post('/calc/preview', { ...body, gstRegistrationId: comp.body.id, placeOfSupply: '29' });
    expect(bos.body).toMatchObject({ documentKind: 'bill_of_supply', totals: { cgst: '0.00', sgst: '0.00', grand: '150.00' } });
  });
});

describe('period locks (FR-CO-05)', () => {
  it('lets the accountant lock but not unlock, refuses postings in the locked period, and audits the reason', async () => {
    const s = await setup('periodlock');
    const accountant = await addMember(h, s.client, 'Accountant', 'lockacct');
    accountant.client.tenantId = s.tenantId;
    let entity = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    expect(entity.periodLockDate).toBeNull();
    expect((await accountant.client.put(`/legal-entities/${s.entityId}/period-lock`, { version: entity.version, lockDate: '2999-01-01', reason: 'Too far ahead' })).status).toBe(400);
    const locked = await accountant.client.put(`/legal-entities/${s.entityId}/period-lock`, { version: entity.version, lockDate: '2026-03-31', reason: 'FY 2025-26 closed' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.periodLockDate).toBe('2026-03-31');
    expect((await s.client.post('/stock-adjustments', { warehouseId: s.w1, type: 'opening', docDate: '2026-03-31', lines: [{ itemId: s.bolt, qty: '1', unitCost: '1' }] })).body.error.code).toBe('PERIOD_LOCKED');
    // Moving it back needs period.unlock (Owner only by default).
    expect((await accountant.client.put(`/legal-entities/${s.entityId}/period-lock`, { version: locked.body.version, lockDate: null, reason: 'Need to correct March' })).status).toBe(403);
    const unlocked = await s.client.put(`/legal-entities/${s.entityId}/period-lock`, { version: locked.body.version, lockDate: '2026-02-28', reason: 'Correcting a March entry' });
    expect(unlocked.body.periodLockDate).toBe('2026-02-28');
    const audit = (await s.client.get('/audit-events?action=period.unlocked')).body.data[0];
    expect(audit.changes).toEqual(expect.arrayContaining([{ field: 'reason', to: 'Correcting a March entry' }, { field: 'periodLockDate', from: '2026-03-31', to: '2026-02-28' }]));
    entity = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    expect(entity.version).toBe(unlocked.body.version);
  });
});

describe('outbox, worker and generated documents (ADR-005, ADR-006)', () => {
  it('renders the transfer note after dispatch; downloads return the stored original', async () => {
    const s = await setup('outbox');
    await adjust(s, [{ itemId: s.bolt, qty: '5', unitCost: '2' }], 'opening');
    const t = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: s.w2, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '2' }] });
    expect((await s.client.get(`/stock-transfers/${t.body.id}/pdf`)).body.error.code).toBe('INVALID_STATE');
    const dispatched = await s.client.post(`/stock-transfers/${t.body.id}/dispatch`, { version: t.body.version }, key());
    expect(dispatched.body.pdf).toBeNull();
    const tenantId = new Types.ObjectId(s.tenantId);
    expect(await h.db.models.Outbox.countDocuments({ tenantId, aggregateId: new Types.ObjectId(t.body.id), status: 'pending' })).toBe(1);

    const tasks = buildWorkerTasks({ config: h.config, db: h.db, logger: silent, now: h.clock.now });
    const consumer = tasks.find((task) => task.name === 'outbox');
    const signal = new AbortController().signal;
    while (await consumer?.runOnce(signal)) {
      // drain
    }
    expect(await h.db.models.Outbox.countDocuments({ tenantId, aggregateId: new Types.ObjectId(t.body.id), status: 'done' })).toBe(1);
    const shown = await s.client.get(`/stock-transfers/${t.body.id}`);
    expect(shown.body.pdf).toMatchObject({ status: 'ready', templateVersion: 'stock-transfer-1' });
    const pdf = await s.client.download(`/stock-transfers/${t.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/TRF-000001\.pdf/);
    const bytes = pdf.body;
    expect((await s.client.download(`/stock-transfers/${t.body.id}/pdf`)).body.equals(bytes)).toBe(true);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBe(shown.body.pdf.sizeBytes);
    // A second event for the same document does not regenerate the original.
    await h.db.models.Outbox.create([{ tenantId, type: 'document.render', aggregateId: new Types.ObjectId(t.body.id), payload: { docType: 'stock_transfer', docId: t.body.id, templateVersion: 'stock-transfer-1' }, status: 'pending', attempts: 0, availableAt: new Date(0), createdAt: new Date() }]);
    await consumer?.runOnce(signal);
    expect(await h.db.models.File.countDocuments({ tenantId })).toBe(1);
    // A storekeeper (document.download) can download it too.
    const keeper = await addMember(h, s.client, 'Storekeeper', 'pdfkeeper');
    keeper.client.tenantId = s.tenantId;
    expect((await keeper.client.download(`/stock-transfers/${t.body.id}/pdf`)).status).toBe(200);
  });

  it('retries a failing event with backoff and marks it dead after the last attempt', async () => {
    const tenantId = new Types.ObjectId();
    const id = new Types.ObjectId();
    await h.db.models.Outbox.create([{ tenantId, type: 'unknown.event', aggregateId: id, payload: {}, status: 'pending', attempts: 0, availableAt: new Date(0), createdAt: new Date() }]);
    let now = new Date('2030-01-01T00:00:00Z');
    const consumer = outboxConsumer({ models: h.db.models, logger: silent, handlers: {}, now: () => now });
    const signal = new AbortController().signal;
    expect(await consumer.runOnce(signal)).toBe(true);
    let row = await h.db.models.Outbox.findOne({ tenantId, aggregateId: id }).lean();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, lastError: expect.stringMatching(/No handler/) });
    expect(row?.availableAt.getTime()).toBe(now.getTime() + 5_000);
    // Not yet due: nothing to do.
    expect(await consumer.runOnce(signal)).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      now = new Date(now.getTime() + 2 * 3_600_000);
      await consumer.runOnce(signal);
    }
    row = await h.db.models.Outbox.findOne({ tenantId, aggregateId: id }).lean();
    expect(row).toMatchObject({ status: 'dead', attempts: 8 });
  });
});

describe('scheduled integrity checks (FR-INV-09, AC-JRN-1)', () => {
  it('runs each job once per interval across worker instances and saves the results', async () => {
    const s = await setup('scheduler');
    await adjust(s, [{ itemId: s.bolt, qty: '4', unitCost: '2' }], 'opening');
    let now = new Date('2031-01-01T00:00:00Z');
    const clock = () => now;
    const jobs = () => integrityJobs({ models: h.db.models, logger: silent, intervalMs: 3_600_000, now: clock });
    // Two worker instances share the lock.
    const a = scheduler({ models: h.db.models, logger: silent, jobs: jobs(), now: clock, owner: 'a' });
    const b = scheduler({ models: h.db.models, logger: silent, jobs: jobs(), now: clock, owner: 'b' });
    const signal = new AbortController().signal;
    const ran = await Promise.all([a.runOnce(signal), b.runOnce(signal)]);
    expect(ran.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const locks = await h.db.models.JobLock.find({ _id: trusted({ $in: ['stock-reconciliation', 'journal-reconciliation'] }) }).lean();
    expect(locks.every((l) => l.owner === null && l.lockedUntil.getTime() === now.getTime() + 3_600_000)).toBe(true);
    // Not due again until the interval has passed.
    expect(await a.runOnce(signal)).toBe(false);
    const checks = (await s.client.get('/integrity-checks')).body.data;
    expect(checks).toEqual([expect.objectContaining({ kind: 'journals', ok: true }), expect.objectContaining({ kind: 'stock', ok: true })]);
    // Drift appears in the next run.
    await h.db.models.StockBalance.updateOne({ tenantId: new Types.ObjectId(s.tenantId) }, { $inc: { onHand: Types.Decimal128.fromString('1') } });
    now = new Date(now.getTime() + 3_600_001);
    expect(await b.runOnce(signal)).toBe(true);
    const after = (await s.client.get('/integrity-checks')).body.data;
    expect(after.find((c: { kind: string }) => c.kind === 'stock')).toMatchObject({ ok: false, issueCount: 1 });
  });
});

describe('transfers and GST registrations', () => {
  it('refuses a stock transfer between warehouses under different GSTINs (that is a supply)', async () => {
    const s = await setup('gstintransfer');
    const reg2 = await s.client.post(`/legal-entities/${s.entityId}/registrations`, { gstin: fakeGstin('29', s.pan), registrationType: 'regular', effectiveFrom: '2017-07-01', address: address('29', '560001') });
    const blr = await s.client.post('/warehouses', { legalEntityId: s.entityId, code: 'BLR', name: 'Bengaluru (test)', gstRegistrationId: reg2.body.id });
    const res = await s.client.post('/stock-transfers', { fromWarehouseId: s.w1, toWarehouseId: blr.body.id, docDate: TODAY(), lines: [{ itemId: s.bolt, qty: '1' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/different GSTINs/);
  });
});
