import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueService } from '../../src/modules/catalogue/catalogue.js';
import { addMember, createHarness, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

/** Rates below are synthetic fixtures for exercising the schedule logic, not statements of current law. */
const SOURCE = 'Synthetic test fixture (not a real notification)';

async function basics(client: Client) {
  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const unit = (code: string) => units.find((u) => u.code === code)?.id ?? '';
  const goods = await client.post('/tax-classes', { name: 'Fasteners (test)', kind: 'goods', treatment: 'taxable' });
  const service = await client.post('/tax-classes', { name: 'Repair services (test)', kind: 'service', treatment: 'taxable' });
  return { unit, goodsClass: goods.body.id as string, serviceClass: service.body.id as string };
}

describe('units (GST-19)', () => {
  it('seeds default units mapped to UQCs for a new business', async () => {
    const { client } = await signUp(h, 'units');
    const units = (await client.get('/units')).body.data as Array<{ code: string; uqc: string; decimals: number }>;
    expect(units.find((u) => u.code === 'KG')).toMatchObject({ uqc: 'KGS', decimals: 3 });
    expect(units.find((u) => u.code === 'PCS')).toMatchObject({ uqc: 'PCS', decimals: 0 });
    const created = await client.post('/units', { code: 'roll', name: 'Roll', uqc: 'ROL', decimals: 0 });
    expect(created.body.code).toBe('ROLL');
    expect((await client.post('/units', { code: 'ROLL', name: 'Again', uqc: 'ROL', decimals: 0 })).status).toBe(400);
    expect((await client.post('/units', { code: 'XYZ', name: 'Bad', uqc: 'XYZ', decimals: 0 })).status).toBe(400);
  });
});

describe('tax classes and effective-dated rates (FR-CAT-03, GST-11)', () => {
  it('ships no rates, requires a source and rejects overlapping periods', async () => {
    const { client, tenantId } = await signUp(h, 'rates');
    const created = await client.post('/tax-classes', { name: 'Test goods class', kind: 'goods', treatment: 'taxable' });
    expect(created.body).toMatchObject({ schedules: [], currentRate: null });
    const id = created.body.id as string;

    const first = await client.post(`/tax-classes/${id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', effectiveTo: '2025-09-21', gstRate: '12', sourceReference: SOURCE });
    expect(first.status).toBe(201);
    const second = await client.post(`/tax-classes/${id}/schedules`, { version: 1, effectiveFrom: '2025-09-22', gstRate: '5', sourceReference: SOURCE });
    expect(second.status).toBe(201);
    expect(second.body.currentRate).toBe('5');
    expect(second.body.schedules[0]).toMatchObject({ effectiveFrom: '2025-09-22', gstRate: '5', sourceReference: SOURCE });

    const overlap = await client.post(`/tax-classes/${id}/schedules`, { version: 2, effectiveFrom: '2026-01-01', gstRate: '18', sourceReference: SOURCE });
    expect(overlap.body.error.message).toMatch(/Overlaps/);
    expect((await client.post(`/tax-classes/${id}/schedules`, { version: 2, effectiveFrom: '2026-01-01', gstRate: '18' })).status).toBe(400);

    // Close the open period, then a new rate can start.
    const current = second.body.schedules[0].id as string;
    const closed = await client.patch(`/tax-classes/${id}/schedules/${current}`, { version: 2, effectiveTo: '2026-12-31' });
    expect(closed.status).toBe(200);
    // A stale version is refused even when the dates are fine.
    expect((await client.post(`/tax-classes/${id}/schedules`, { version: 2, effectiveFrom: '2027-01-01', gstRate: '18', sourceReference: SOURCE })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await client.post(`/tax-classes/${id}/schedules`, { version: 3, effectiveFrom: '2027-01-01', gstRate: '18', sourceReference: SOURCE })).status).toBe(201);

    // The lookup used when documents are calculated.
    const doc = await h.db.models.TaxClass.findOne({ tenantId: new Types.ObjectId(tenantId), _id: new Types.ObjectId(id) }).lean();
    expect(doc && CatalogueService.scheduleOn(doc, '2025-09-21')?.gstRate.toString()).toBe('12');
    expect(doc && CatalogueService.scheduleOn(doc, '2025-09-22')?.gstRate.toString()).toBe('5');
    expect(doc && CatalogueService.scheduleOn(doc, '2017-06-30')).toBeNull();

    const audit = await client.get('/audit-events?action=tax_rate.added');
    expect(audit.body.data[0].changes).toEqual(expect.arrayContaining([{ field: 'sourceReference', to: SOURCE }]));
  });

  it('keeps non-taxable classes free of rates and reverse charge explicit', async () => {
    const { client } = await signUp(h, 'exempt');
    const exempt = await client.post('/tax-classes', { name: 'Exempt goods (test)', kind: 'goods', treatment: 'exempt' });
    expect((await client.post(`/tax-classes/${exempt.body.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '0', sourceReference: SOURCE })).body.error.code).toBe('BUSINESS_RULE');
    expect((await client.post('/tax-classes', { name: 'Odd (test)', kind: 'goods', treatment: 'nil_rated', reverseCharge: true })).status).toBe(400);
    const rcm = await client.post('/tax-classes', { name: 'Notified RCM service (test)', kind: 'service', treatment: 'taxable', reverseCharge: true });
    expect(rcm.body.reverseCharge).toBe(true);
  });
});

describe('items (FR-CAT-01/02, FR-RBAC-04)', () => {
  it('creates goods and services with consistent HSN/SAC, units and tax classes', async () => {
    const { client } = await signUp(h, 'items');
    const b = await basics(client);
    const bolt = await client.post('/items', {
      sku: 'bolt-m8',
      name: 'Hex bolt M8 (test)',
      type: 'stock',
      baseUnitId: b.unit('PCS'),
      altUnits: [{ unitId: b.unit('BOX'), factor: '100' }],
      hsnSac: '7318',
      taxClassId: b.goodsClass,
      salePrice: '4.50',
      purchasePrice: '3.125',
      reorderLevel: '500',
    });
    expect(bolt.status).toBe(201);
    expect(bolt.body).toMatchObject({ sku: 'BOLT-M8', baseUnitCode: 'PCS', altUnits: [{ unitCode: 'BOX', factor: '100' }], salePrice: '4.50', purchasePrice: '3.125', taxClassName: 'Fasteners (test)' });

    const cases = [
      [{ type: 'service', hsnSac: '998729', taxClassId: b.goodsClass }, 'taxClassId'],
      [{ type: 'service', hsnSac: '7318', taxClassId: b.serviceClass }, 'hsnSac'],
      [{ type: 'stock', hsnSac: '998729', taxClassId: b.goodsClass }, 'hsnSac'],
      [{ type: 'non_stock', hsnSac: '7318', taxClassId: b.goodsClass, reorderLevel: '5' }, 'reorderLevel'],
      [{ type: 'stock', hsnSac: '7318', taxClassId: b.goodsClass, reorderLevel: '1.5' }, 'reorderLevel'],
      [{ type: 'stock', hsnSac: '7318', taxClassId: b.goodsClass, altUnits: [{ unitId: b.unit('PCS'), factor: '2' }] }, 'altUnits.0.unitId'],
    ] as const;
    for (const [overrides, path] of cases) {
      const res = await client.post('/items', { sku: `X-${Math.random().toString(36).slice(2, 8)}`, name: 'Bad (test)', baseUnitId: b.unit('PCS'), ...overrides });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.body.error.details[0].path).toBe(path);
    }
    expect((await client.post('/items', { sku: 'BOLT-M8', name: 'Dup', type: 'stock', baseUnitId: b.unit('PCS'), hsnSac: '7318', taxClassId: b.goodsClass })).body.error.details[0].path).toBe('sku');
    expect((await client.post('/items', { sku: 'NUM', name: 'Float price', type: 'stock', baseUnitId: b.unit('PCS'), hsnSac: '7318', taxClassId: b.goodsClass, salePrice: 4.5 })).status).toBe(400);

    const svc = await client.post('/items', { sku: 'REPAIR-HR', name: 'Repair labour (test)', type: 'service', baseUnitId: b.unit('HRS'), hsnSac: '998729', taxClassId: b.serviceClass });
    expect(svc.status).toBe(201);
  });

  it('searches with keyset paging and treats search text literally', async () => {
    const { client } = await signUp(h, 'itemsearch');
    const b = await basics(client);
    for (const name of ['Washer A (test)', 'Washer B (test)', 'Washer C (test)', 'Nut (test)', 'Bracket [x] (test)']) {
      await client.post('/items', { sku: name.replace(/\W+/g, '-').slice(0, 20), name, type: 'stock', baseUnitId: b.unit('PCS'), hsnSac: '7318', taxClassId: b.goodsClass });
    }
    const page1 = await client.get('/items?q=washer&limit=2');
    expect(page1.body.data.map((i: { name: string }) => i.name)).toEqual(['Washer A (test)', 'Washer B (test)']);
    const page2 = await client.get(`/items?q=washer&limit=2&cursor=${page1.body.page.nextCursor}`);
    expect(page2.body.data.map((i: { name: string }) => i.name)).toEqual(['Washer C (test)']);
    expect(page2.body.page.nextCursor).toBeNull();
    expect((await client.get('/items?q=%5Bx%5D')).body.data.map((i: { name: string }) => i.name)).toEqual(['Bracket [x] (test)']);
    expect((await client.get('/items?q=.*')).body.data).toEqual([]);
    expect((await client.get('/items?cursor=not-a-cursor')).status).toBe(400);
    expect((await client.get('/items?q[$ne]=x')).status).toBe(400);
  });

  it('hides cost prices without price.view_cost and requires price.edit to change prices', async () => {
    const owner = await signUp(h, 'cost');
    const b = await basics(owner.client);
    const item = await owner.client.post('/items', { sku: 'NUT-M8', name: 'Nut M8 (test)', type: 'stock', baseUnitId: b.unit('PCS'), hsnSac: '7318', taxClassId: b.goodsClass, salePrice: '1.20', purchasePrice: '0.80' });

    const sales = await addMember(h, owner.client, 'Sales', 'costsales');
    const seen = await sales.client.get(`/items/${item.body.id}`);
    expect(seen.body.salePrice).toBe('1.20');
    expect(seen.body).not.toHaveProperty('purchasePrice');
    expect(JSON.stringify((await sales.client.get('/items')).body)).not.toContain('0.80');

    // The Purchase role edits items and sees cost, but can't change prices.
    const purchase = await addMember(h, owner.client, 'Purchase', 'costpurchase');
    expect((await purchase.client.get(`/items/${item.body.id}`)).body.purchasePrice).toBe('0.80');
    expect((await purchase.client.patch(`/items/${item.body.id}`, { version: item.body.version, salePrice: '1.50' })).status).toBe(403);
    const renamed = await purchase.client.patch(`/items/${item.body.id}`, { version: item.body.version, name: 'Nut M8 zinc (test)' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    const priced = await owner.client.patch(`/items/${item.body.id}`, { version: renamed.body.version, salePrice: '1.35' });
    expect(priced.body.salePrice).toBe('1.35');
    const audit = await owner.client.get('/audit-events?action=item.updated');
    expect(audit.body.data[0].changes).toEqual([{ field: 'salePrice', from: '1.20', to: '1.35' }]);
  });

  it('archives instead of deleting, and units in use cannot be archived', async () => {
    const { client } = await signUp(h, 'archive');
    const b = await basics(client);
    const item = await client.post('/items', { sku: 'ARC-1', name: 'Archived thing (test)', type: 'stock', baseUnitId: b.unit('PCS'), hsnSac: '7318', taxClassId: b.goodsClass });
    const units = (await client.get('/units')).body.data as Array<{ id: string; code: string; version: number }>;
    const pcs = units.find((u) => u.code === 'PCS');
    expect((await client.patch(`/units/${pcs?.id}`, { version: pcs?.version, archived: true })).body.error.code).toBe('BUSINESS_RULE');
    await client.patch(`/items/${item.body.id}`, { version: item.body.version, archived: true });
    expect((await client.get('/items')).body.data).toHaveLength(0);
    expect((await client.get('/items?archived=true')).body.data).toHaveLength(1);
  });
});

describe('cross-tenant isolation for the catalogue (AC-TEN-1)', () => {
  it('answers 404 for other tenants’ records and rejects their ids as references', async () => {
    const a = await signUp(h, 'cata');
    const b = await signUp(h, 'catb');
    const bb = await basics(b.client);
    const bItem = await b.client.post('/items', { sku: 'B-1', name: 'B item (test)', type: 'stock', baseUnitId: bb.unit('PCS'), hsnSac: '7318', taxClassId: bb.goodsClass });
    const bCategory = await b.client.post('/categories', { name: 'B category' });
    expect((await a.client.get(`/items/${bItem.body.id}`)).status).toBe(404);
    expect((await a.client.patch(`/items/${bItem.body.id}`, { version: 0, name: 'Hijack' })).status).toBe(404);
    expect((await a.client.patch(`/tax-classes/${bb.goodsClass}`, { version: 0, name: 'Hijack' })).status).toBe(404);
    expect((await a.client.post(`/tax-classes/${bb.goodsClass}/schedules`, { version: 0, effectiveFrom: '2025-01-01', gstRate: '5', sourceReference: SOURCE })).status).toBe(404);
    expect((await a.client.patch(`/categories/${bCategory.body.id}`, { version: 0, name: 'Hijack' })).status).toBe(404);
    const ab = await basics(a.client);
    const cross = await a.client.post('/items', { sku: 'A-1', name: 'Uses B refs (test)', type: 'stock', baseUnitId: bb.unit('PCS'), hsnSac: '7318', taxClassId: ab.goodsClass, categoryId: bCategory.body.id });
    expect(cross.status).toBe(400);
    expect(JSON.stringify((await a.client.get('/items')).body)).not.toContain('B item');
  });
});
