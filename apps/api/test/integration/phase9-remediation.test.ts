import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarness,
  fakeGstin,
  fakePan,
  setupEntity,
  signUp,
  address,
  type Client,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
afterEach((testContext) => {
  if (testContext.task.result?.state === 'fail') {
    const lines = h.logs().split('\n');
    console.error('--- SERVER LOGS FOR FAILED TEST ---');
    console.error(lines.slice(-30).join('\n'));
    console.error('-----------------------------------');
  }
});

const TODAY = () => new Date(h.clock.now().getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic test fixture';
const key = () => ({ 'Idempotency-Key': randomUUID() });

interface PaymentBiz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  warehouseId: string;
  boltId: string;
  customerId: string;
  supplierId: string;
}

async function setupBiz(label: string): Promise<PaymentBiz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);

  const entity = await client.get(`/legal-entities/${e.entityId}`);
  await client.put(`/legal-entities/${e.entityId}/workflow`, {
    ...entity.body.workflow,
    stockOutPoint: 'invoice',
    version: entity.body.version,
  });

  const wh = await client.post('/warehouses', {
    legalEntityId: e.entityId,
    code: 'PMT-WH',
    name: 'Payment Warehouse (test)',
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

  const bolt = await client.post('/items', {
    sku: `BOLT-${label.toUpperCase()}`,
    name: 'M8 Bolt',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '7318',
    taxClassId: goods.body.id,
    salePrice: '10.00',
  });

  const panCust = fakePan('F');
  const customer = await client.post('/parties', {
    name: 'Acme Traders (test)',
    isCustomer: true,
    isSupplier: false,
    pan: panCust,
    gstins: [{ gstin: fakeGstin('27', panCust), addressId: 'c1' }],
    addresses: [{ id: 'c1', label: 'Office', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(customer.status).toBe(201);

  const panSupp = fakePan('F');
  const supplier = await client.post('/parties', {
    name: 'Prime Metals (test)',
    isCustomer: false,
    isSupplier: true,
    pan: panSupp,
    gstins: [{ gstin: fakeGstin('27', panSupp), addressId: 's1' }],
    addresses: [{ id: 's1', label: 'Factory', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(supplier.status).toBe(201);

  for (const [docType, prefix] of [
    ['supplier_bill', 'BILL/{FY}/'],
    ['receipt', 'REC/{FY}/'],
    ['payment', 'PMT/{FY}/'],
  ] as const) {
    await client.post('/document-series', {
      legalEntityId: e.entityId,
      gstRegistrationId: null,
      docType,
      name: `${docType} Series (test)`,
      prefix,
      padding: 4,
    });
  }

  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'tax_invoice',
    name: 'Invoice Series (test)',
    prefix: 'INV/{FY}/',
    padding: 4,
  });

  // Opening stock for bolt: 100 @ 5.00
  const opening = await client.post('/stock-adjustments', {
    warehouseId: wh.body.id,
    type: 'opening',
    docDate: TODAY(),
    lines: [{ itemId: bolt.body.id, qty: '100', unitCost: '5.00' }],
  });
  await client.post(`/stock-adjustments/${opening.body.id}/post`, { version: opening.body.version }, key());

  return {
    client,
    tenantId,
    entityId: e.entityId,
    registrationId: e.registrationId,
    warehouseId: wh.body.id,
    boltId: bolt.body.id,
    customerId: customer.body.id,
    supplierId: supplier.body.id,
  };
}

describe('Phase 9 Defect Reproductions', () => {
  it('Defect A: Sales return omits Dr 1300 Inventory / Cr 5200 COGS in journal', async () => {
    const biz = await setupBiz('defect-a');

    // 1. Issue invoice for 10 bolts @ 10 = 100 + 18% = 118
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    const inv = invRes.body;
    const issuedInv = (
      await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())
    ).body;
    expect(issuedInv.status).toBe('issued');

    // 2. Issue credit note (sales_return) for 4 bolts
    const cnRes = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      salesInvoiceId: issuedInv.id,
      kind: 'sales_return',
      docDate: TODAY(),
      reason: 'Defective units returned',
      lines: [
        {
          sourceLineId: issuedInv.lines[0].lineId,
          itemId: biz.boltId,
          qty: '4',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    const cn = cnRes.body;
    const issuedCn = (await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key())).body;
    expect(issuedCn.status).toBe('issued');

    // 3. Inspect journal for credit note
    const journals = await biz.client.get(`/journals?sourceType=credit_note&sourceId=${cn.id}`);
    const cnJournal = journals.body.data[0];
    expect(cnJournal).toBeDefined();

    // EXPECTATION: Inventory Asset (1300) must be debited and COGS (5200) credited for 4 * 5.00 = 20.00
    const invDebit = cnJournal.lines.find((l: any) => l.accountCode === '1300');
    const cogsCredit = cnJournal.lines.find((l: any) => l.accountCode === '5200');

    expect(invDebit, 'Inventory 1300 must be debited on sales return').toBeDefined();
    expect(invDebit?.debit).toBe('20.00');
    expect(cogsCredit, 'COGS 5200 must be credited on sales return').toBeDefined();
    expect(cogsCredit?.credit).toBe('20.00');
  });

  it('Defect B: Purchase return on ITC-ineligible bill incorrectly credits Input GST', async () => {
    const biz = await setupBiz('defect-b');

    // 1. Post supplier bill with itcEligible: false
    const billRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      supplierInvoiceNumber: 'INV-ITC-001',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      itcEligible: false,
      lines: [
        {
          itemId: biz.boltId,
          qty: '5',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    const postedBill = (await biz.client.post(`/supplier-bills/${billRes.body.id}/post`, { version: 0 }, key())).body;
    expect(postedBill.status).toBe('posted');

    // 2. Issue debit note for 5 bolts
    const dnRes = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      supplierBillId: postedBill.id,
      kind: 'purchase_return',
      docDate: TODAY(),
      reason: 'Rejected batch',
      lines: [
        {
          sourceLineId: postedBill.lines[0].lineId,
          itemId: biz.boltId,
          qty: '5',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    const issuedDn = (await biz.client.post(`/debit-notes/${dnRes.body.id}/issue`, {}, key())).body;
    expect(issuedDn.status).toBe('issued');

    // 3. Inspect journal
    const journals = await biz.client.get(`/journals?sourceType=debit_note&sourceId=${dnRes.body.id}`);
    const dnJournal = journals.body.data[0];
    expect(dnJournal).toBeDefined();

    // EXPECTATION: Input GST (1410-1413) must NOT be credited
    const gstLines = dnJournal.lines.filter((l: any) => ['1410', '1411', '1412', '1413'].includes(l.accountCode));
    expect(gstLines.length, 'Input GST must not be credited when bill was ITC-ineligible').toBe(0);
    // Cost account (1300) must receive full gross credit (59.00)
    const costCredit = dnJournal.lines.find((l: any) => l.accountCode === '1300');
    expect(costCredit?.credit).toBe('59.00');
  });

  it('Defect C: Credit note against fully paid invoice drops customer credit', async () => {
    const biz = await setupBiz('defect-c');

    // 1. Invoice 10 bolts = 118.00
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    const invoice = invRes.body;
    const issuedInv = (
      await biz.client.post(`/sales-invoices/${invoice.id}/issue`, { version: invoice.version, expectedTotal: invoice.totals.grand }, key())
    ).body;

    // 2. Customer pays in full (118.00)
    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '118.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '118.00' }] },
      key(),
    );

    const invAfterPmt = (await biz.client.get(`/sales-invoices/${issuedInv.id}`)).body;
    expect(invAfterPmt.outstanding).toBe('0.00');

    // 3. Issue credit note for full invoice (118.00)
    const cnRes = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      salesInvoiceId: issuedInv.id,
      kind: 'sales_return',
      docDate: TODAY(),
      reason: 'Full return after settlement',
      lines: [
        {
          sourceLineId: issuedInv.lines[0].lineId,
          itemId: biz.boltId,
          qty: '10',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    const issuedCn = (await biz.client.post(`/credit-notes/${cnRes.body.id}/issue`, {}, key())).body;
    expect(issuedCn.status).toBe('issued');

    // EXPECTATION: Customer must have an explicit unallocated credit balance of 118.00
    const payments = await biz.client.get(`/payments?partyId=${biz.customerId}`);
    const unallocatedCredit = payments.body.data.find(
      (p: any) => p.direction === 'incoming' && Number(p.unallocatedAmount) > 0,
    );
    expect(unallocatedCredit, 'Customer must have an unallocated credit balance document').toBeDefined();
    expect(unallocatedCredit?.unallocatedAmount).toBe('118.00');
  });

  it('Defect D: Payment reversal corrupts prior period opening balance on statement', async () => {
    const biz = await setupBiz('defect-d');

    // Invoice and payment on Jan 10
    const jan10 = '2026-01-10';
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: jan10,
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    const inv = invRes.body;
    const issuedInv = (
      await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())
    ).body;

    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '118.00',
        paymentMethod: 'bank_transfer',
        docDate: jan10,
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '118.00' }] },
      key(),
    );

    // In Feb, payment is reversed
    const rev = await biz.client.post(`/payments/${pmt.id}/reverse`, { reason: 'Bounced cheque', reversalDate: '2026-02-10' }, key());
    expect(rev.status).toBe(200);

    // Fetch statement for Feb
    const stmtFeb = (
      await biz.client.get(
        `/parties/${biz.customerId}/statement?legalEntityId=${biz.entityId}&from=2026-02-01&to=2026-02-28`,
      )
    ).body;

    // EXPECTATION: Feb 1 opening balance was 0.00 (settled in Jan)
    expect(stmtFeb.openingBalance, 'Opening balance on Feb 1 must be 0.00').toBe('0.00');

    // Reversal must be an entry in Feb
    const revEntry = stmtFeb.entries.find((e: any) => e.docType === 'payment_reversal');
    expect(revEntry, 'Reversal entry must exist in Feb').toBeDefined();
    expect(stmtFeb.closingBalance, 'Closing balance after Feb reversal must be 118.00').toBe('118.00');
  });

  it('Defect E: Cumulative return quantities cannot exceed sold quantities', async () => {
    const biz = await setupBiz('defect-e');

    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    const inv = invRes.body;
    const issuedInv = (
      await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())
    ).body;
    const lineId = issuedInv.lines[0].lineId;

    // First credit note returns 8 units (valid)
    const cn1 = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'Return 8 units',
        lines: [{ sourceLineId: lineId, itemId: biz.boltId, qty: '8', unitPrice: '10.00', taxRate: '18' }],
      })
    ).body;
    await biz.client.post(`/credit-notes/${cn1.id}/issue`, {}, key());

    // Second credit note tries to return 5 units (8 + 5 = 13 > 10 sold)
    const cn2Res = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      salesInvoiceId: issuedInv.id,
      kind: 'sales_return',
      docDate: TODAY(),
      reason: 'Return 5 more units',
      lines: [{ sourceLineId: lineId, itemId: biz.boltId, qty: '5', unitPrice: '10.00', taxRate: '18' }],
    });
    // EXPECTATION: Exceeding returnable quantity must be rejected
    expect(cn2Res.status, 'Exceeding returnable quantity must be rejected').toBe(422);
  });
});
