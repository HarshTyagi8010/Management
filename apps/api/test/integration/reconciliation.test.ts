import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDecimal } from '../../src/platform/values.js';
import { addMember, createHarness, setupEntity, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(h.clock.now().getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic test fixture';
const key = () => ({ 'Idempotency-Key': randomUUID() });

interface ReconBiz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  warehouseId: string;
  itemId: string;
  customerId: string;
  supplierId: string;
}

async function setupReconBiz(label: string): Promise<ReconBiz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);

  // Workflow: direct invoice and bill stock movements
  const entity = await client.get(`/legal-entities/${e.entityId}`);
  const wf = await client.put(`/legal-entities/${e.entityId}/workflow`, {
    ...entity.body.workflow,
    stockOutPoint: 'invoice',
    stockInPoint: 'supplier_bill',
    version: entity.body.version,
  });
  expect(wf.status, JSON.stringify(wf.body)).toBe(200);

  const wh = await client.post('/warehouses', {
    legalEntityId: e.entityId,
    code: 'RC-WH',
    name: 'Reconciliation Warehouse (test)',
    gstRegistrationId: e.registrationId,
  });
  expect(wh.status).toBe(201);

  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const nos = units.find((u) => u.code === 'NOS')?.id;

  const goods = await client.post('/tax-classes', { name: 'Hardware (test)', kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: SOURCE,
  });

  const item = await client.post('/items', {
    sku: `SKU-${label}`,
    name: 'M10 Bolt',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '7318',
    taxClassId: goods.body.id,
  });

  const customer = await client.post('/parties', {
    name: `Customer ${label}`,
    isCustomer: true,
    isSupplier: false,
  });

  const supplier = await client.post('/parties', {
    name: `Supplier ${label}`,
    isCustomer: false,
    isSupplier: true,
  });

  // Setup document series for all document kinds
  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'tax_invoice',
    name: 'Invoice Series',
    prefix: 'INV/{FY}/',
    padding: 4,
  });

  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'credit_note',
    name: 'Credit Note Series',
    prefix: 'CN/{FY}/',
    padding: 4,
  });

  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'debit_note',
    name: 'Debit Note Series',
    prefix: 'DN/{FY}/',
    padding: 4,
  });

  for (const [docType, prefix] of [
    ['supplier_bill', 'BILL/{FY}/'],
    ['receipt', 'REC/{FY}/'],
    ['payment', 'PMT/{FY}/'],
    ['expense', 'EXP/{FY}/'],
  ] as const) {
    await client.post('/document-series', {
      legalEntityId: e.entityId,
      gstRegistrationId: null,
      docType,
      name: `${docType} Series`,
      prefix,
      padding: 4,
    });
  }

  // Opening stock: 100 @ 10.00
  const opening = await client.post('/stock-adjustments', {
    warehouseId: wh.body.id,
    type: 'opening',
    docDate: TODAY(),
    lines: [{ itemId: item.body.id, qty: '100', unitCost: '10.00' }],
  });
  await client.post(`/stock-adjustments/${opening.body.id}/post`, { version: opening.body.version }, key());

  return {
    client,
    tenantId,
    entityId: e.entityId,
    registrationId: e.registrationId,
    warehouseId: wh.body.id,
    itemId: item.body.id,
    customerId: customer.body.id,
    supplierId: supplier.body.id,
  };
}

describe('Authoritative Financial Reconciliation (Batch B)', () => {
  it('1. correctly identifies an empty dataset as INCOMPLETE rather than falsely matched', async () => {
    const { client } = await signUp(h, 'empty-recon');
    const e = await setupEntity(client);

    const res = await client.get(`/reconciliation/financial?legalEntityId=${e.entityId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('INCOMPLETE');
    expect(res.body.summary.emptyDataset).toBe(true);
    expect(res.body.summary.matchedSections).toBe(0);
    expect(res.body.unsupportedConditions[0]).toMatch(/EMPTY_DATASET/);
  });

  it('2. rejects historical retrospective mode as UNSUPPORTED when point-in-time mutable balances cannot be rewound', async () => {
    const biz = await setupReconBiz('unsupp-hist');

    const res = await clientGet(biz.client, `/reconciliation/financial?legalEntityId=${biz.entityId}&mode=historical`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UNSUPPORTED');
    expect(res.body.unsupportedConditions[0]).toMatch(/HISTORICAL_RECONSTRUCTION_UNSUPPORTED/);

    const pastDateRes = await clientGet(biz.client, `/reconciliation/financial?legalEntityId=${biz.entityId}&asOfDate=2025-01-01`);
    expect(pastDateRes.status).toBe(200);
    expect(pastDateRes.body.status).toBe('UNSUPPORTED');
  });

  it('3. validates comprehensive posted business workflows across all 6 sections (Happy Path)', async () => {
    const biz = await setupReconBiz('happy-path');

    // A. Create & issue Sales Invoice 1 (10 units @ 20.00 = 200 + 18% = 236.00)
    const invRes1 = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '20.00' }],
    });
    expect(invRes1.status, JSON.stringify(invRes1.body)).toBe(201);
    const inv1 = invRes1.body;
    const issueRes1 = await biz.client.post(`/sales-invoices/${inv1.id}/issue`, { version: inv1.version, expectedTotal: inv1.totals.grand }, key());
    expect(issueRes1.status, JSON.stringify(issueRes1.body)).toBe(200);

    // B. Post Supplier Bill 1 (20 units @ 10.00 = 200 + 18% = 236.00, ITC eligible)
    const billRes1 = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      supplierInvoiceNumber: `SUPP-INV-${randomUUID().slice(0, 8)}`,
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      dueDate: TODAY(),
      itcEligible: true,
      lines: [{ itemId: biz.itemId, qty: '20', unitPrice: '10.00' }],
    });
    expect(billRes1.status, JSON.stringify(billRes1.body)).toBe(201);
    const bill1 = billRes1.body;
    const billPostRes = await biz.client.post(`/supplier-bills/${bill1.id}/post`, { version: bill1.version }, key());
    expect(billPostRes.status, JSON.stringify(billPostRes.body)).toBe(200);

    // C. Record Customer Cash Receipt (1000.00 advance)
    const rDraft = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      paymentMethod: 'bank_transfer',
      amount: '1000.00',
      docDate: TODAY(),
      reference: 'ADV-CUST-1',
    });
    expect(rDraft.status, JSON.stringify(rDraft.body)).toBe(201);
    const receipt = (await biz.client.post(`/payments/${rDraft.body.id}/post`, {}, key())).body;

    // D. Allocate 100.00 of receipt to Invoice 1 (partially paid, leaving 136.00 outstanding)
    const allocRes1 = await biz.client.post(
      `/payments/${receipt.id}/allocate`,
      {
        allocations: [{ targetId: inv1.id, targetType: 'sales_invoice', amount: '100.00' }],
      },
      key(),
    );
    expect(allocRes1.status, JSON.stringify(allocRes1.body)).toBe(200);

    // E. Record Supplier Disbursement (236.00) and allocate full bill balance
    const pDraft = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      direction: 'outgoing',
      paymentMethod: 'bank_transfer',
      amount: '236.00',
      docDate: TODAY(),
      reference: 'DISB-SUPP-1',
    });
    expect(pDraft.status, JSON.stringify(pDraft.body)).toBe(201);
    const payment = (await biz.client.post(`/payments/${pDraft.body.id}/post`, {}, key())).body;

    const allocRes2 = await biz.client.post(
      `/payments/${payment.id}/allocate`,
      {
        allocations: [{ targetId: bill1.id, targetType: 'supplier_bill', amount: '236.00' }],
      },
      key(),
    );
    expect(allocRes2.status, JSON.stringify(allocRes2.body)).toBe(200);

    // F. Direct Expense with ITC (118.00 = 100.00 taxable + 18.00 GST)
    const expRes = await biz.client.post(
      '/expenses',
      {
        legalEntityId: biz.entityId,
        category: 'Office Supplies',
        description: 'Printer ink',
        amount: '118.00',
        docDate: TODAY(),
        paymentMode: 'bank_transfer',
        taxRate: '18',
        itcEligible: true,
        reference: `EXP-INK-${randomUUID().slice(0, 8)}`,
      },
      key(),
    );
    expect(expRes.status, JSON.stringify(expRes.body)).toBe(201);
    const exp = expRes.body;
    const expPostRes = await biz.client.post(`/expenses/${exp.id}/post`, {}, key());
    expect(expPostRes.status, JSON.stringify(expPostRes.body)).toBe(200);

    // G. Run Financial Reconciliation and request drillDown
    const reconRes = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}&drillDown=true`);
    expect(reconRes.status, JSON.stringify(reconRes.body)).toBe(200);

    const body = reconRes.body;
    expect(body.status).toBe('MATCHED');
    expect(body.summary.matchedSections).toBe(6);
    expect(body.summary.mismatchedSections).toBe(0);

    // Verify sections individually
    expect(body.sections.journalIntegrity.status).toBe('MATCHED');
    expect(body.sections.journalIntegrity.unbalancedJournals).toBe(0);
    expect(body.sections.journalIntegrity.missingPostings).toBe(0);

    expect(body.sections.tradeReceivables.status).toBe('MATCHED');
    expect(body.sections.tradeReceivables.difference).toBe('0.00');

    expect(body.sections.tradePayables.status).toBe('MATCHED');
    expect(body.sections.tradePayables.difference).toBe('0.00');

    expect(body.sections.customerAdvances.status).toBe('MATCHED');
    expect(body.sections.customerAdvances.difference).toBe('0.00');

    expect(body.sections.inventoryValuation.status).toBe('MATCHED');
    expect(body.sections.inventoryValuation.difference).toBe('0.00');

    expect(body.sections.taxAccounts.status).toBe('MATCHED');
    expect(body.sections.taxAccounts.difference).toBe('0.00');

    // Verify drill-down structures
    expect(body.drillDown).toBeDefined();
    expect(body.drillDown.receivables.length).toBeGreaterThan(0);
    expect(body.drillDown.advances.length).toBeGreaterThan(0);
  });

  it('4. detects a seeded missing posting defect in journal integrity', async () => {
    const biz = await setupReconBiz('seed-missing');

    // Create draft invoice and force status to 'issued' in MongoDB without creating a journal
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '1', unitPrice: '50.00' }],
    });
    expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);
    const invId = invRes.body.id;

    // Tamper directly in DB: set status='issued' with no journal, with tenantId scoped
    await h.db.models.SalesInvoice.updateOne(
      { tenantId: biz.tenantId, _id: invId },
      { $set: { status: 'issued', number: 'INV/TEST/9999' } },
    );

    const reconRes = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(reconRes.status, JSON.stringify(reconRes.body)).toBe(200);
    expect(reconRes.body.status).toBe('MISMATCH');
    expect(reconRes.body.sections.journalIntegrity.status).toBe('MISMATCH');
    expect(reconRes.body.sections.journalIntegrity.missingPostings).toBeGreaterThan(0);
    expect(
      reconRes.body.sections.journalIntegrity.issues.some((i: any) => i.kind === 'missing_posting'),
    ).toBe(true);
  });

  it('5. detects an unbalanced journal defect seeded directly into the database', async () => {
    const biz = await setupReconBiz('seed-unbalanced');

    // Insert deliberately unbalanced journal
    const badDoc = {
      tenantId: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.tenantId),
      legalEntityId: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.entityId),
      docDate: TODAY(),
      sourceType: 'payment',
      sourceId: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.customerId),
      sourceNumber: 'UNBAL-001',
      narration: 'Deliberately corrupted unbalanced entry',
      lines: [
        {
          accountId: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.entityId),
          accountCode: '1100',
          debit: toDecimal('500.00'),
          credit: toDecimal('0.00'),
        },
        {
          accountId: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.entityId),
          accountCode: '1200',
          debit: toDecimal('0.00'),
          credit: toDecimal('450.00'), // Mismatch: 500 != 450
        },
      ],
      totalDebit: toDecimal('500.00'),
      totalCredit: toDecimal('450.00'),
      reversalOf: null,
      createdBy: h.db.models.Journal.base.Types.ObjectId.createFromHexString(biz.customerId),
      createdAt: new Date(),
    };
    await h.db.models.Journal.collection.insertOne(badDoc as any);

    const reconRes = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(reconRes.status, JSON.stringify(reconRes.body)).toBe(200);
    expect(reconRes.body.status).toBe('MISMATCH');
    expect(reconRes.body.sections.journalIntegrity.status).toBe('MISMATCH');
    expect(reconRes.body.sections.journalIntegrity.unbalancedJournals).toBeGreaterThan(0);
  });

  it('6. detects an AR subledger discrepancy seeded by tampering with outstanding obligation', async () => {
    const biz = await setupReconBiz('seed-ar-drift');

    // Create and issue an invoice
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '5', unitPrice: '10.00' }],
    });
    expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);
    const inv = invRes.body;
    const issueRes = await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key());
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);

    // Tamper with invoice outstanding in DB (+ ₹50 phantom receivable)
    await h.db.models.SalesInvoice.updateOne(
      { tenantId: biz.tenantId, _id: inv.id },
      { $set: { outstanding: toDecimal('109.00') } }, // was 59.00 (50 + 18%)
    );

    const reconRes = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(reconRes.status, JSON.stringify(reconRes.body)).toBe(200);
    expect(reconRes.body.sections.tradeReceivables.status).toBe('MISMATCH');
    expect(reconRes.body.sections.tradeReceivables.difference).toBe('50.00');
    expect(reconRes.body.sections.tradeReceivables.diagnostics.length).toBeGreaterThan(0);
  });

  it('7. detects an inventory valuation discrepancy seeded between stock valuation and GL', async () => {
    const biz = await setupReconBiz('seed-stock-drift');

    // Tamper with ItemValuation value
    await h.db.models.ItemValuation.updateOne(
      { tenantId: biz.tenantId, legalEntityId: biz.entityId },
      { $set: { value: toDecimal('9999.00') } },
    );

    const reconRes = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(reconRes.status, JSON.stringify(reconRes.body)).toBe(200);
    expect(reconRes.body.sections.inventoryValuation.status).toBe('MISMATCH');
    expect(reconRes.body.sections.inventoryValuation.difference).not.toBe('0.00');
  });

  it('8. enforces RBAC: unauthorized users without report.financial are rejected', async () => {
    const biz = await setupReconBiz('rbac-recon');

    // Add member with 'Sales' role (which lacks report.financial)
    const staff = await addMember(h, biz.client, 'Sales', 'sales_recon_user');

    const forbiddenRes = await staff.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(forbiddenRes.status).toBe(403);
  });

  it('9. preserves tenant and entity boundaries: reconciliation of Entity A ignores Entity B', async () => {
    const biz = await setupReconBiz('entity-isolation');

    // Create a second legal entity in the same tenant
    const e2 = await setupEntity(biz.client);

    // Entity 2 has no documents -> should return INCOMPLETE (empty dataset)
    const e2Res = await biz.client.get(`/reconciliation/financial?legalEntityId=${e2.entityId}`);
    expect(e2Res.status).toBe(200);
    expect(e2Res.body.summary.emptyDataset).toBe(true);

    // Entity 1 has opening stock -> totalSections is 6, emptyDataset is false
    const e1Res = await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`);
    expect(e1Res.status).toBe(200);
    expect(e1Res.body.summary.emptyDataset).toBe(false);
  });

  it('10. independently specified worked example: Invoice 1180, Receipt 1180, full allocation reclassification', async () => {
    const biz = await setupReconBiz('alloc-recon-1180');

    // 1. Issue Invoice: 1,180.00 (100 units @ 10.00 = 1000 + 18% = 1180.00)
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '100', unitPrice: '10.00' }],
    });
    expect(invRes.status).toBe(201);
    const inv = (await biz.client.post(`/sales-invoices/${invRes.body.id}/issue`, { version: invRes.body.version, expectedTotal: '1180.00' }, key())).body;
    expect(inv.outstanding).toBe('1180.00');

    // 2. Post Customer Cash Receipt: 1,180.00 (advance)
    const rDraft = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      paymentMethod: 'bank_transfer',
      amount: '1180.00',
      docDate: TODAY(),
      reference: 'ADV-1180',
    });
    const receipt = (await biz.client.post(`/payments/${rDraft.body.id}/post`, {}, key())).body;
    expect(receipt.unallocatedAmount).toBe('1180.00');

    // Pre-allocation reconciliation check:
    // GL 1200 = Dr 1180.00, Subledger AR = 1180.00 (MATCHED)
    // GL 2300 = Cr 1180.00, Subledger Advances = 1180.00 (MATCHED)
    let recon = (await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`)).body;
    expect(recon.sections.tradeReceivables.glBalance).toBe('1180.00');
    expect(recon.sections.tradeReceivables.subledgerBalance).toBe('1180.00');
    expect(recon.sections.tradeReceivables.status).toBe('MATCHED');
    expect(recon.sections.customerAdvances.glBalance).toBe('1180.00');
    expect(recon.sections.customerAdvances.subledgerBalance).toBe('1180.00');
    expect(recon.sections.customerAdvances.status).toBe('MATCHED');

    // 3. Allocate full 1,180.00
    const allocRes = await biz.client.post(
      `/payments/${receipt.id}/allocate`,
      {
        allocations: [{ targetId: inv.id, targetType: 'sales_invoice', amount: '1180.00' }],
      },
      key(),
    );
    expect(allocRes.status).toBe(200);

    // Verify expected operational outstanding:
    const invAfter = (await biz.client.get(`/sales-invoices/${inv.id}`)).body;
    expect(invAfter.outstanding).toBe('0.00');
    expect(invAfter.paymentStatus).toBe('paid');

    const receiptAfter = (await biz.client.get(`/payments/${receipt.id}`)).body;
    expect(receiptAfter.unallocatedAmount).toBe('0.00');

    // Verify allocation reclassification journal exists: Dr 2300 (1180.00), Cr 1200 (1180.00)
    const allocJournalRes = await biz.client.get(`/journals?legalEntityId=${biz.entityId}&sourceType=allocation`);
    expect(allocJournalRes.status, JSON.stringify(allocJournalRes.body)).toBe(200);
    const allocJournal = allocJournalRes.body.data[0];
    expect(allocJournal).toBeDefined();
    expect(allocJournal.totalDebit).toBe('1180.00');
    expect(allocJournal.totalCredit).toBe('1180.00');
    expect(allocJournal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '2300', debit: '1180.00' }),
        expect.objectContaining({ accountCode: '1200', credit: '1180.00' }),
      ]),
    );

    // Post-allocation reconciliation check:
    // GL 1200 = 0.00 (Dr 1180 - Cr 1180)
    // GL 2300 = 0.00 (Cr 1180 - Dr 1180)
    // Expected AR balance = 0.00, Expected unapplied advance balance = 0.00
    recon = (await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`)).body;
    expect(recon.sections.tradeReceivables.glBalance).toBe('0.00');
    expect(recon.sections.tradeReceivables.subledgerBalance).toBe('0.00');
    expect(recon.sections.tradeReceivables.difference).toBe('0.00');
    expect(recon.sections.tradeReceivables.status).toBe('MATCHED');

    expect(recon.sections.customerAdvances.glBalance).toBe('0.00');
    expect(recon.sections.customerAdvances.subledgerBalance).toBe('0.00');
    expect(recon.sections.customerAdvances.difference).toBe('0.00');
    expect(recon.sections.customerAdvances.status).toBe('MATCHED');
  });

  it('11. handles partial allocation and multi-invoice FIFO allocation with reclassification', async () => {
    const biz = await setupReconBiz('multi-alloc-recon');

    // 1. Post advance receipt of 1,000.00
    const rDraft = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      paymentMethod: 'bank_transfer',
      amount: '1000.00',
      docDate: TODAY(),
    });
    const receipt = (await biz.client.post(`/payments/${rDraft.body.id}/post`, {}, key())).body;

    // 2. Post two invoices: Inv A = 354.00 (300 + 54), Inv B = 472.00 (400 + 72), total 70 units <= 100 stock
    const invResA = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '30', unitPrice: '10.00' }],
    });
    expect(invResA.status).toBe(201);
    const invA = (await biz.client.post(`/sales-invoices/${invResA.body.id}/issue`, { version: invResA.body.version, expectedTotal: '354.00' }, key())).body;

    const invResB = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '40', unitPrice: '10.00' }],
    });
    expect(invResB.status).toBe(201);
    const invB = (await biz.client.post(`/sales-invoices/${invResB.body.id}/issue`, { version: invResB.body.version, expectedTotal: '472.00' }, key())).body;

    // 3. FIFO allocate 826.00 across both invoices
    const fifoRes = await biz.client.post(`/payments/${receipt.id}/fifo-allocate`, { maxAmount: '826.00' }, key());
    expect(fifoRes.status).toBe(200);
    expect(fifoRes.body.unallocatedAmount).toBe('174.00');

    // Inv A and Inv B both paid
    expect((await biz.client.get(`/sales-invoices/${invA.id}`)).body.outstanding).toBe('0.00');
    expect((await biz.client.get(`/sales-invoices/${invB.id}`)).body.outstanding).toBe('0.00');

    // Reconciliation check:
    // GL 1200 = 0.00 (354 + 472 - 826)
    // GL 2300 = 174.00 Cr (1000 - 826)
    const recon = (await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`)).body;
    expect(recon.sections.tradeReceivables.glBalance).toBe('0.00');
    expect(recon.sections.tradeReceivables.subledgerBalance).toBe('0.00');
    expect(recon.sections.tradeReceivables.status).toBe('MATCHED');

    expect(recon.sections.customerAdvances.glBalance).toBe('174.00');
    expect(recon.sections.customerAdvances.subledgerBalance).toBe('174.00');
    expect(recon.sections.customerAdvances.status).toBe('MATCHED');
  });

  it('12. reverses allocation reclassification journal on payment reversal', async () => {
    const biz = await setupReconBiz('reversal-recon');

    // Issue invoice 590
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '50', unitPrice: '10.00' }],
    });
    const inv = (await biz.client.post(`/sales-invoices/${invRes.body.id}/issue`, { version: invRes.body.version, expectedTotal: '590.00' }, key())).body;

    // Post receipt 590 and allocate
    const rDraft = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      paymentMethod: 'bank_transfer',
      amount: '590.00',
      docDate: TODAY(),
    });
    const receipt = (await biz.client.post(`/payments/${rDraft.body.id}/post`, {}, key())).body;
    await biz.client.post(`/payments/${receipt.id}/allocate`, { allocations: [{ targetId: inv.id, targetType: 'sales_invoice', amount: '590.00' }] }, key());

    // Both are 0.00
    expect((await biz.client.get(`/sales-invoices/${inv.id}`)).body.outstanding).toBe('0.00');

    // Reverse payment
    const revRes = await biz.client.post(`/payments/${receipt.id}/reverse`, { reason: 'Returned cheque' }, key());
    expect(revRes.status).toBe(200);

    // Invoice outstanding restored
    const invRestored = (await biz.client.get(`/sales-invoices/${inv.id}`)).body;
    expect(invRestored.outstanding).toBe('590.00');
    expect(invRestored.paymentStatus).toBe('unpaid');

    // Reconciliation check after reversal:
    // GL 1200 = 590.00 Dr (restored via allocation reversal journal)
    // GL 2300 = 0.00 (advance removed via payment reversal journal)
    // Subledger AR = 590.00 (invoice outstanding restored)
    // Subledger Advances = 0.00
    const recon = (await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`)).body;
    expect(recon.sections.tradeReceivables.glBalance).toBe('590.00');
    expect(recon.sections.tradeReceivables.subledgerBalance).toBe('590.00');
    expect(recon.sections.tradeReceivables.difference).toBe('0.00');
    expect(recon.sections.tradeReceivables.status).toBe('MATCHED');

    expect(recon.sections.customerAdvances.glBalance).toBe('0.00');
    expect(recon.sections.customerAdvances.subledgerBalance).toBe('0.00');
    expect(recon.sections.customerAdvances.status).toBe('MATCHED');
  });

  it('13. reconciles accrued expenses in AP and handles ITC-ineligible purchase returns', async () => {
    const biz = await setupReconBiz('ap-accrual-recon');

    // 1. Post direct expense with paymentMode 'payable' (500.00 + 90 tax = 590.00, ITC eligible)
    const expRes = await biz.client.post('/expenses', {
      legalEntityId: biz.entityId,
      category: 'Utilities',
      description: 'Electricity bill accrued',
      amount: '590.00',
      docDate: TODAY(),
      paymentMode: 'payable',
      taxRate: '18',
      itcEligible: true,
      reference: 'EXP-ELEC-001',
    }, key());
    expect(expRes.status).toBe(201);
    await biz.client.post(`/expenses/${expRes.body.id}/post`, {}, key());

    // 2. Post ITC-ineligible supplier bill (100.00 + 18 tax = 118.00 gross cost to inventory)
    const billRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      supplierInvoiceNumber: `SUPP-NOITC-${randomUUID().slice(0, 8)}`,
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      dueDate: TODAY(),
      itcEligible: false,
      lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '10.00' }],
    });
    expect(billRes.status).toBe(201);
    const bill = billRes.body;
    await biz.client.post(`/supplier-bills/${bill.id}/post`, { version: bill.version }, key());

    // 3. Issue purchase return debit note against the ITC-ineligible bill
    const dnDraft = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      supplierBillId: bill.id,
      kind: 'purchase_return',
      docDate: TODAY(),
      reason: 'Defective parts returned',
      warehouseId: biz.warehouseId,
      lines: [{ sourceLineId: bill.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '10.00', taxRate: '18', reason: 'Defective' }],
    });
    expect(dnDraft.status, JSON.stringify(dnDraft.body)).toBe(201);
    const dn = (await biz.client.post(`/debit-notes/${dnDraft.body.id}/issue`, { version: dnDraft.body.version }, key())).body;

    // Check AP and Tax Reconciliation:
    // AP includes bill outstanding + accrued expense 590.00
    // Tax does NOT subtract tax from the ineligible debit note
    const recon = (await biz.client.get(`/reconciliation/financial?legalEntityId=${biz.entityId}`)).body;
    expect(recon.sections.tradePayables.status).toBe('MATCHED');
    expect(recon.sections.tradePayables.difference).toBe('0.00');
    expect(recon.sections.tradePayables.breakdown.accruedExpenses).toBe('590.00');

    expect(recon.sections.taxAccounts.status).toBe('MATCHED');
    expect(recon.sections.taxAccounts.difference).toBe('0.00');
  });
});

async function clientGet(client: Client, path: string) {
  return client.get(path);
}
