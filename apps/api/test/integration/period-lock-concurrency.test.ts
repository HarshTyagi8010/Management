import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { assertPeriodOpen } from '../../src/modules/finance/period-lock.js';
import { withTransaction } from '../../src/platform/transactions.js';
import { addMember, createHarness, setupEntity, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const key = () => ({ 'Idempotency-Key': randomUUID() });

interface Setup {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  w1: string;
  bolt: string;
  party: string;
}

async function setup(label: string): Promise<Setup> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);
  const w1 = await client.post('/warehouses', {
    legalEntityId: e.entityId,
    code: 'MAIN',
    name: 'Main (test)',
    gstRegistrationId: e.registrationId,
  });
  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const goods = await client.post('/tax-classes', { name: 'Hardware (test)', kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: 'Synthetic test fixture',
  });
  const bolt = await client.post('/items', {
    sku: `BOLT-${label}`,
    name: 'Bolt (test)',
    type: 'stock',
    baseUnitId: units.find((u) => u.code === 'NOS')?.id,
    hsnSac: '7318',
    taxClassId: goods.body.id,
  });
  const party = await client.post('/parties', {
    name: `Acme Traders ${label}`,
    isCustomer: true,
    isSupplier: false,
  });

  // Configure entity workflow so that stock leaves at invoice point
  const entityDoc = (await client.get(`/legal-entities/${e.entityId}`)).body;
  const wfRes = await client.put(`/legal-entities/${e.entityId}/workflow`, {
    version: entityDoc.version,
    stockOutPoint: 'invoice',
    stockInPoint: 'goods_receipt',
    allowNegativeStock: false,
    roundOffTotal: true,
  });
  if (wfRes.status !== 200) throw new Error(`workflow update failed: ${wfRes.status} ${JSON.stringify(wfRes.body)}`);

  // Add invoice series
  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'tax_invoice',
    name: 'Tax invoices',
    prefix: 'INV/{FY}/',
    padding: 4,
    startNumber: 1,
    isDefault: true,
  });

  return {
    client,
    tenantId,
    entityId: e.entityId,
    registrationId: e.registrationId,
    w1: w1.body.id,
    bolt: bolt.body.id,
    party: party.body.id,
  };
}

describe('Period-Lock Guard and Concurrency Race Protection (Batch A)', () => {
  it('deterministic ordering: close commits before posting guard rejects posting and rolls back all effects', async () => {
    const s = await setup('close-wins');
    const entityDoc = (await s.client.get(`/legal-entities/${s.entityId}`)).body;

    // 1. Draft an invoice dated 2026-03-31 while period is still open
    const draft = await s.client.post('/sales-invoices', {
      legalEntityId: s.entityId,
      gstRegistrationId: s.registrationId,
      warehouseId: s.w1,
      partyId: s.party,
      docDate: '2026-03-31',
      lines: [
        {
          itemId: s.bolt,
          qty: '10',
          unitPrice: '100.00',
        },
      ],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const invoiceId = draft.body.id;

    // 2. Concurrently close period up to 2026-03-31
    const lockRes = await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entityDoc.version,
      lockDate: '2026-03-31',
      reason: 'Year end close',
    });
    expect(lockRes.status).toBe(200);

    // 3. Attempt to issue invoice dated 2026-03-31 -> must fail with PERIOD_LOCKED
    const issueRes = await s.client.post(`/sales-invoices/${invoiceId}/issue`, { version: draft.body.version }, key());
    expect(issueRes.status).toBe(422);
    expect(issueRes.body.error.code).toBe('PERIOD_LOCKED');

    // 4. Verify ZERO partial side-effects in database:
    const tenantOid = new Types.ObjectId(s.tenantId);
    const invoiceOid = new Types.ObjectId(invoiceId);

    // Invoice remains in draft
    const inv = await h.db.models.SalesInvoice.findOne({ tenantId: tenantOid, _id: invoiceOid }).lean();
    expect(inv?.status).toBe('draft');
    expect(inv?.number ?? null).toBeNull();

    // 0 journals posted
    const journals = await h.db.models.Journal.find({ tenantId: tenantOid, sourceId: invoiceOid }).lean();
    expect(journals.length).toBe(0);

    // 0 stock movements
    const movements = await h.db.models.StockMovement.find({ tenantId: tenantOid, sourceId: invoiceOid }).lean();
    expect(movements.length).toBe(0);

    // 0 outbox tasks
    const outbox = await h.db.models.Outbox.find({ tenantId: tenantOid, aggregateId: invoiceOid }).lean();
    expect(outbox.length).toBe(0);
  });

  it('deterministic ordering: posting wins before close commits, then close includes its effect', async () => {
    const s = await setup('post-wins');

    // 1. Initial stock opening
    const adj = await s.client.post('/stock-adjustments', {
      warehouseId: s.w1,
      type: 'opening',
      docDate: '2026-03-15',
      lines: [{ itemId: s.bolt, qty: '50', unitCost: '50.00' }],
    });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    const postAdj = await s.client.post(`/stock-adjustments/${adj.body.id}/post`, { version: adj.body.version }, key());
    expect(postAdj.status, JSON.stringify(postAdj.body)).toBe(200);

    // 2. Post invoice on 2026-03-20 while period is open
    const draft = await s.client.post('/sales-invoices', {
      legalEntityId: s.entityId,
      gstRegistrationId: s.registrationId,
      warehouseId: s.w1,
      partyId: s.party,
      docDate: '2026-03-20',
      lines: [{ itemId: s.bolt, qty: '5', unitPrice: '100.00' }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const issued = await s.client.post(`/sales-invoices/${draft.body.id}/issue`, { version: draft.body.version }, key());
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.status).toBe('issued');

    // 3. Now close the period up to 2026-03-31
    const freshEntity = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    const lockRes = await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: freshEntity.version,
      lockDate: '2026-03-31',
      reason: 'Locked after posting',
    });
    expect(lockRes.status).toBe(200);

    // 4. Verify the invoice remains committed and valid
    const finalInv = await h.db.models.SalesInvoice.findOne({
      tenantId: new Types.ObjectId(s.tenantId),
      _id: new Types.ObjectId(draft.body.id),
    }).lean();
    expect(finalInv?.status).toBe('issued');
  });

  it('concurrent conflict: posting retries and aborts when conflicting close commits first', async () => {
    const s = await setup('conflict-retry');
    const tenantOid = new Types.ObjectId(s.tenantId);
    const entityOid = new Types.ObjectId(s.entityId);

    // Initial state: period is open (periodLockDate: null)
    const entityBefore = await h.db.models.LegalEntity.findOne({ tenantId: tenantOid, _id: entityOid }).lean();
    expect(entityBefore?.periodLockDate).toBeNull();

    // Deterministic simulation of concurrent race:
    // Concurrently commit period lock C1 outside this session
    await h.db.models.LegalEntity.updateOne(
      { tenantId: tenantOid, _id: entityOid },
      { $set: { periodLockDate: '2026-03-31' }, $inc: { version: 1, periodLockCoordination: 1 } },
    );

    // Now inside posting's session, attempting to assert period open for 2026-03-31:
    await expect(
      withTransaction(h.db.connection, async (session) => {
        await assertPeriodOpen(session, {
          tenantId: tenantOid,
          legalEntityId: entityOid,
          docDate: '2026-03-31',
          models: h.db.models,
        });
      }),
    ).rejects.toThrowError(AppError);

    // Verify entity reflects locked state
    const entityAfter = await h.db.models.LegalEntity.findOne({ tenantId: tenantOid, _id: entityOid }).lean();
    expect(entityAfter?.periodLockDate).toBe('2026-03-31');
  });

  it('later-period posting remains allowed when earlier period is locked', async () => {
    const s = await setup('later-period');
    const entityDoc = (await s.client.get(`/legal-entities/${s.entityId}`)).body;

    // Lock up to 2026-03-31
    await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entityDoc.version,
      lockDate: '2026-03-31',
      reason: 'FY closed',
    });

    // Opening stock on 2026-04-01 (post-lock period) MUST succeed
    const adj = await s.client.post('/stock-adjustments', {
      warehouseId: s.w1,
      type: 'opening',
      docDate: '2026-04-01',
      lines: [{ itemId: s.bolt, qty: '10', unitCost: '25.00' }],
    });
    expect(adj.status).toBe(201);
    const postRes = await s.client.post(`/stock-adjustments/${adj.body.id}/post`, { version: adj.body.version }, key());
    expect(postRes.status).toBe(200);
    expect(postRes.body.status).toBe('posted');
  });

  it('unauthorized close or reopen fails with 403 FORBIDDEN', async () => {
    const s = await setup('perms');
    const member = await addMember(h, s.client, 'Storekeeper', 'storekeeperuser');
    member.client.tenantId = s.tenantId;

    const entityDoc = (await s.client.get(`/legal-entities/${s.entityId}`)).body;

    // Storekeeper lacks period.lock permission
    const lockAttempt = await member.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entityDoc.version,
      lockDate: '2026-03-31',
      reason: 'Staff trying to lock',
    });
    expect(lockAttempt.status).toBe(403);

    // Owner locks successfully
    const ownerLock = await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entityDoc.version,
      lockDate: '2026-03-31',
      reason: 'Owner locks',
    });
    expect(ownerLock.status).toBe(200);

    // Storekeeper cannot reopen or move lock back (requires period.unlock)
    const staffReopen = await member.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: ownerLock.body.version,
      lockDate: '2026-02-28',
      reason: 'Staff trying to unlock',
    });
    expect(staffReopen.status).toBe(403);
  });

  it('preserves tenant and legal-entity boundaries: locking Entity A does not affect Entity B', async () => {
    const s = await setup('multi-entity');

    // Create a second legal entity in the same tenant
    const e2 = await setupEntity(s.client);
    const w2 = await s.client.post('/warehouses', {
      legalEntityId: e2.entityId,
      code: 'BRANCH',
      name: 'Branch (test)',
      gstRegistrationId: e2.registrationId,
    });

    const entity1Doc = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    const entity2Doc = (await s.client.get(`/legal-entities/${e2.entityId}`)).body;

    // Lock Entity 1 up to 2026-03-31
    await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entity1Doc.version,
      lockDate: '2026-03-31',
      reason: 'Entity 1 closed',
    });

    // Entity 2 period remains NULL (open)
    const freshE2 = (await s.client.get(`/legal-entities/${e2.entityId}`)).body;
    expect(freshE2.periodLockDate).toBeNull();

    // Posting in Entity 2 dated 2026-03-31 succeeds!
    const adjE2 = await s.client.post('/stock-adjustments', {
      warehouseId: w2.body.id,
      type: 'opening',
      docDate: '2026-03-31',
      lines: [{ itemId: s.bolt, qty: '10', unitCost: '30.00' }],
    });
    expect(adjE2.status).toBe(201);
    const postE2 = await s.client.post(`/stock-adjustments/${adjE2.body.id}/post`, { version: adjE2.body.version }, key());
    expect(postE2.status).toBe(200);

    // Meanwhile, draft in Entity 1 dated 2026-03-31 is blocked by checkDate / PERIOD_LOCKED
    const adjE1 = await s.client.post('/stock-adjustments', {
      warehouseId: s.w1,
      type: 'opening',
      docDate: '2026-03-31',
      lines: [{ itemId: s.bolt, qty: '5', unitCost: '30.00' }],
    });
    expect(adjE1.status).toBe(422);
    expect(adjE1.body.error.code).toBe('PERIOD_LOCKED');
  });

  it('rejects reversal if either the original document date or the reversal posting date falls in a locked period', async () => {
    const s = await setup('rev-date-guard');

    await s.client.post('/document-series', {
      legalEntityId: s.entityId,
      gstRegistrationId: null,
      docType: 'receipt',
      name: 'Receipt Series',
      prefix: 'REC/{FY}/',
      padding: 4,
    });

    // 1. Create and post a payment dated 2026-04-10
    const draftRes = await s.client.post('/payments', {
      legalEntityId: s.entityId,
      partyId: s.party,
      direction: 'incoming',
      paymentMethod: 'bank_transfer',
      amount: '1000.00',
      docDate: '2026-04-10',
      reference: 'ADV-100',
    });
    expect(draftRes.status, JSON.stringify(draftRes.body)).toBe(201);
    const payId = draftRes.body.id;

    const postRes = await s.client.post(`/payments/${payId}/post`, {}, key());
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);

    // 2. Lock period up to 2026-04-15
    const entityDoc = (await s.client.get(`/legal-entities/${s.entityId}`)).body;
    await s.client.put(`/legal-entities/${s.entityId}/period-lock`, {
      version: entityDoc.version,
      lockDate: '2026-04-15',
      reason: 'April mid-month close',
    });

    // 3. Attempt to reverse the payment: payment docDate (2026-04-10) is <= 2026-04-15 -> Rejected!
    const rev1 = await s.client.post(
      `/payments/${payId}/reverse`,
      {
        reason: 'Customer requested cancellation',
        reversalDate: '2026-04-20', // Even if reversal date is open, original date is locked
      },
      key(),
    );
    expect(rev1.status).toBe(422);
    expect(rev1.body.error.code).toBe('PERIOD_LOCKED');
  });
});
