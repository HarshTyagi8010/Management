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

async function setupPaymentBiz(label: string): Promise<PaymentBiz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);

  // Set stockOutPoint to 'invoice' for direct invoice creation
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
    sku: 'BOLT-P9',
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
    addresses: [{ id: 's1', label: 'Works', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(supplier.status).toBe(201);

  // Setup document series for tax invoice (scoped to registration)
  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'tax_invoice',
    name: 'Invoice Series (test)',
    prefix: 'INV/{FY}/',
    padding: 4,
  });

  // Setup document series for entity-scoped documents
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

describe('Phase 9: Payments, Allocations, Reversals, Refunds, Expenses, Returns, and Notes', () => {
  it('A. records incoming customer receipt as unallocated advance, verifies double-entry journals', async () => {
    const biz = await setupPaymentBiz('receipt-adv');

    // 1. Create draft receipt
    const draftRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      amount: '1000.00',
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
      reference: 'NEFT-12345',
      bankAccountName: 'HDFC Current',
      notes: 'Advance from customer',
    });
    expect(draftRes.status, JSON.stringify(draftRes.body)).toBe(201);
    const draft = draftRes.body;
    expect(draft.status).toBe('draft');
    expect(draft.unallocatedAmount).toBe('1000.00');

    // 2. Post receipt
    const postRes = await biz.client.post(`/payments/${draft.id}/post`, {}, key());
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);
    const posted = postRes.body;
    expect(posted.status).toBe('posted');
    expect(posted.number).toMatch(/^REC\//);
    expect(posted.unallocatedAmount).toBe('1000.00');

    // 3. Verify balanced journal entry (Bank 1110 Dr 1000, Customer Advance 2300 Cr 1000)
    const jrnRes = await biz.client.get(`/journals?sourceType=payment&sourceId=${posted.id}`);
    expect(jrnRes.status).toBe(200);
    const journal = jrnRes.body.data[0];
    expect(journal).toBeDefined();
    expect(journal.totalDebit).toBe('1000.00');
    expect(journal.totalCredit).toBe('1000.00');
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '1110', debit: '1000.00' }),
        expect.objectContaining({ accountCode: '2300', credit: '1000.00' }),
      ]),
    );
  });

  it('B. records outgoing supplier disbursement as unallocated advance, verifies double-entry journals', async () => {
    const biz = await setupPaymentBiz('supp-pmt');

    // 1. Create draft supplier payment
    const draftRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      direction: 'outgoing',
      amount: '500.00',
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
      reference: 'RTGS-98765',
    });
    expect(draftRes.status, JSON.stringify(draftRes.body)).toBe(201);

    // 2. Post payment
    const postRes = await biz.client.post(`/payments/${draftRes.body.id}/post`, {}, key());
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);
    const posted = postRes.body;
    expect(posted.status).toBe('posted');
    expect(posted.number).toMatch(/^PMT\//);
    expect(posted.unallocatedAmount).toBe('500.00');

    // 3. Verify journal entry (Trade payables 2100 Dr 500, Bank 1110 Cr 500)
    const jrnRes = await biz.client.get(`/journals?sourceType=payment&sourceId=${posted.id}`);
    expect(jrnRes.status).toBe(200);
    const journal = jrnRes.body.data[0];
    expect(journal).toBeDefined();
    expect(journal.totalDebit).toBe('500.00');
    expect(journal.totalCredit).toBe('500.00');
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '2100', debit: '500.00' }),
        expect.objectContaining({ accountCode: '1110', credit: '500.00' }),
      ]),
    );
  });

  it('C. creates sales invoice, allocates payment manually, validates over-allocation guard', async () => {
    const biz = await setupPaymentBiz('manual-alloc');

    // 1. Post customer receipt of 1000
    const pmtRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      amount: '1000.00',
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
    });
    const pmt = (await biz.client.post(`/payments/${pmtRes.body.id}/post`, {}, key())).body;

    // 2. Create and issue sales invoice for 10 bolts @ 10 = 100 + 18% = 118
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);
    const invoice = invRes.body;
    const issueRes = await biz.client.post(
      `/sales-invoices/${invoice.id}/issue`,
      { version: invoice.version, expectedTotal: invoice.totals.grand },
      key(),
    );
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    const issuedInv = issueRes.body;
    expect(issuedInv.status).toBe('issued');
    expect(issuedInv.outstanding).toBe('118.00');

    // 3. Reject over-allocation (> invoice balance 118.00)
    const overAlloc = await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      {
        allocations: [{ targetId: issuedInv.id, targetType: 'sales_invoice', amount: '200.00' }],
      },
      key(),
    );
    expect(overAlloc.status).toBe(422);

    // 4. Allocate 118.00
    const allocRes = await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      {
        allocations: [{ targetId: issuedInv.id, targetType: 'sales_invoice', amount: '118.00' }],
      },
      key(),
    );
    expect(allocRes.status, JSON.stringify(allocRes.body)).toBe(200);
    const afterAlloc = allocRes.body;
    expect(afterAlloc.unallocatedAmount).toBe('882.00');
    expect(afterAlloc.allocations).toHaveLength(1);
    expect(afterAlloc.allocations[0].amount).toBe('118.00');

    // 5. Verify invoice status is updated to 'paid' and outstanding is '0.00'
    const invAfter = (await biz.client.get(`/sales-invoices/${issuedInv.id}`)).body;
    expect(invAfter.paymentStatus).toBe('paid');
    expect(invAfter.outstanding).toBe('0.00');

    // 6. Verify payment journal was posted on receipt (Dr 1110 Bank, Cr 2300 Customer Advances)
    const pmtJournal = (await biz.client.get(`/journals?sourceType=payment&sourceId=${pmt.id}`)).body.data[0];
    expect(pmtJournal).toBeDefined();
    expect(pmtJournal.totalDebit).toBe('1000.00');
    expect(pmtJournal.totalCredit).toBe('1000.00');
    expect(pmtJournal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '1110' }),
        expect.objectContaining({ accountCode: '2300' }),
      ]),
    );
  });

  it('D. performs FIFO allocation deterministically across multiple supplier bills', async () => {
    const biz = await setupPaymentBiz('fifo-flow');

    // 1. Post two supplier bills: Bill 1 = 100, Bill 2 = 200
    const b1 = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-FIFO-1',
      supplierInvoiceDate: TODAY(),
      docDate: '2026-04-01',
      dueDate: '2026-04-10',
      itcEligible: true,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '8.474576' }],
    });
    expect(b1.status, JSON.stringify(b1.body)).toBe(201);
    const bill1 = (await biz.client.post(`/supplier-bills/${b1.body.id}/post`, {}, key())).body;

    const b2 = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-FIFO-2',
      supplierInvoiceDate: TODAY(),
      docDate: '2026-04-05',
      dueDate: '2026-04-20',
      itcEligible: true,
      lines: [{ itemId: biz.boltId, qty: '20', unitPrice: '8.474576' }],
    });
    expect(b2.status, JSON.stringify(b2.body)).toBe(201);
    const bill2 = (await biz.client.post(`/supplier-bills/${b2.body.id}/post`, {}, key())).body;

    const b1Total = bill1.amounts.grand;
    const b2Total = bill2.amounts.grand;

    // 2. Create supplier payment for b1Total + 50 (covers Bill 1 fully, partial on Bill 2)
    const pmtAmount = (Number(b1Total) + 50).toFixed(2);
    const pmtRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      direction: 'outgoing',
      amount: pmtAmount,
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
    });
    const pmt = (await biz.client.post(`/payments/${pmtRes.body.id}/post`, {}, key())).body;

    // 3. Execute FIFO allocation
    const fifoRes = await biz.client.post(`/payments/${pmt.id}/fifo-allocate`, {}, key());
    expect(fifoRes.status, JSON.stringify(fifoRes.body)).toBe(200);
    const fifoPmt = fifoRes.body;
    expect(fifoPmt.unallocatedAmount).toBe('0.00');
    expect(fifoPmt.allocations).toHaveLength(2);

    // Bill 1 fully paid
    const updatedB1 = (await biz.client.get(`/supplier-bills/${bill1.id}`)).body;
    expect(updatedB1.paymentStatus).toBe('paid');
    expect(updatedB1.outstanding).toBe('0.00');

    // Bill 2 partially paid
    const updatedB2 = (await biz.client.get(`/supplier-bills/${bill2.id}`)).body;
    expect(updatedB2.paymentStatus).toBe('partially_paid');
    expect(Number(updatedB2.outstanding)).toBeCloseTo(Number(b2Total) - 50, 2);
  });

  it('E. reverses a payment, unrolls allocations, restores obligation balances, and posts mirror journal', async () => {
    const biz = await setupPaymentBiz('reverse-flow');

    // 1. Create and post supplier bill of 100
    const bRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-REV-01',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      itcEligible: true,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '8.474576' }],
    });
    const bill = (await biz.client.post(`/supplier-bills/${bRes.body.id}/post`, {}, key())).body;

    // 2. Post payment of 100 and allocate to bill
    const pmtRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      direction: 'outgoing',
      amount: bill.amounts.grand,
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
    });
    const pmt = (await biz.client.post(`/payments/${pmtRes.body.id}/post`, {}, key())).body;
    const allocRes = await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      {
        allocations: [{ targetId: bill.id, targetType: 'supplier_bill', amount: bill.amounts.grand }],
      },
      key(),
    );
    expect(allocRes.status, JSON.stringify(allocRes.body)).toBe(200);

    const billPaid = (await biz.client.get(`/supplier-bills/${bill.id}`)).body;
    expect(billPaid.paymentStatus).toBe('paid');

    // 3. Reverse the payment
    const revRes = await biz.client.post(
      `/payments/${pmt.id}/reverse`,
      {
        reason: 'Entered payment against incorrect bank account',
      },
      key(),
    );
    expect(revRes.status, JSON.stringify(revRes.body)).toBe(200);
    const reversed = revRes.body;
    expect(reversed.status).toBe('reversed');
    expect(reversed.allocations).toHaveLength(0);

    // 4. Verify bill balance and payment status are fully restored
    const billRestored = (await biz.client.get(`/supplier-bills/${bill.id}`)).body;
    expect(billRestored.paymentStatus).toBe('unpaid');
    expect(billRestored.outstanding).toBe(bill.amounts.grand);

    // 5. Verify reversing journal was posted
    const revJournal = (await biz.client.get(`/journals?sourceType=payment&sourceId=${pmt.id}`)).body.data.find(
      (j: any) => j.reversal || j.reversedJournalId != null,
    );
    expect(revJournal).toBeDefined();
    expect(revJournal.narration).toMatch(/Reversal of payment/i);
  });

  it('F. processes advance refund with strict limits against unallocated balance', async () => {
    const biz = await setupPaymentBiz('refund-flow');

    // 1. Post customer receipt of 500
    const pmtRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      amount: '500.00',
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
    });
    const pmt = (await biz.client.post(`/payments/${pmtRes.body.id}/post`, {}, key())).body;

    // 2. Reject refund exceeding unallocated amount (600 > 500)
    const excessRefund = await biz.client.post(
      '/refunds',
      {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: pmt.id,
        amount: '600.00',
        refundDate: TODAY(),
        paymentMethod: 'bank_transfer',
        reason: 'Full advance refund requested',
      },
      key(),
    );
    expect(excessRefund.status).toBe(422);

    // 3. Issue partial refund of 200
    const refundRes = await biz.client.post(
      '/refunds',
      {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: pmt.id,
        amount: '200.00',
        refundDate: TODAY(),
        paymentMethod: 'bank_transfer',
        reason: 'Partial cancellation of booking',
      },
      key(),
    );
    expect(refundRes.status, JSON.stringify(refundRes.body)).toBe(201);
    expect(refundRes.body.amount).toBe('200.00');
    expect(refundRes.body.status).toBe('posted');

    // 4. Verify payment unallocated amount decreased to 300
    const pmtAfter = (await biz.client.get(`/payments/${pmt.id}`)).body;
    expect(pmtAfter.unallocatedAmount).toBe('300.00');

    // 5. Reject second refund exceeding remaining 300 (400 > 300)
    const excess2 = await biz.client.post(
      '/refunds',
      {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: pmt.id,
        amount: '400.00',
        refundDate: TODAY(),
        paymentMethod: 'bank_transfer',
        reason: 'Another refund attempt',
      },
      key(),
    );
    expect(excess2.status).toBe(422);

    // 6. Verify refund journal was posted (Dr 2300 Customer Advance 200, Cr 1110 Bank 200)
    const refJrn = await biz.client.get(`/journals?sourceType=refund&sourceId=${refundRes.body.id}`);
    expect(refJrn.status).toBe(200);
    const rJournal = refJrn.body.data[0];
    expect(rJournal.totalDebit).toBe('200.00');
    expect(rJournal.totalCredit).toBe('200.00');
    expect(rJournal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '2300', debit: '200.00' }),
        expect.objectContaining({ accountCode: '1110', credit: '200.00' }),
      ]),
    );
  });

  it('G. creates direct expense with GST, prevents duplicate reference, posts balanced journal, cancels cleanly', async () => {
    const biz = await setupPaymentBiz('expense-flow');

    // 1. Create and post direct operating expense (₹590 inclusive: ₹500 taxable + ₹90 tax)
    const expRes = await biz.client.post('/expenses', {
      legalEntityId: biz.entityId,
      category: 'Office Supplies',
      description: 'Printer cartridges and stationery',
      amount: '590.00',
      docDate: TODAY(),
      paymentMode: 'bank_transfer',
      taxRate: '18',
      itcEligible: true,
      reference: 'EXP-STAT-001',
    });
    expect(expRes.status, JSON.stringify(expRes.body)).toBe(201);
    const draft = expRes.body;
    expect(draft.taxableAmount).toBe('500.00');
    expect(draft.taxAmount).toBe('90.00');
    expect(draft.amount).toBe('590.00');

    // 2. Reject duplicate reference under same entity
    const dupRes = await biz.client.post('/expenses', {
      legalEntityId: biz.entityId,
      category: 'Office Supplies',
      description: 'Duplicate attempt',
      amount: '590.00',
      docDate: TODAY(),
      paymentMode: 'bank_transfer',
      reference: 'EXP-STAT-001',
    });
    expect(dupRes.status).toBe(409);

    // 3. Post expense
    const postRes = await biz.client.post(`/expenses/${draft.id}/post`, {}, key());
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);
    const posted = postRes.body;
    expect(posted.status).toBe('posted');

    // 4. Verify balanced journal: Dr 5400 Operating Exp 500, Dr 1410 45, Dr 1411 45, Cr 1110 Bank 590
    const jrnRes = await biz.client.get(`/journals?sourceType=expense&sourceId=${posted.id}`);
    expect(jrnRes.status).toBe(200);
    const journal = jrnRes.body.data[0];
    expect(journal.totalDebit).toBe('590.00');
    expect(journal.totalCredit).toBe('590.00');
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '5400', debit: '500.00' }),
        expect.objectContaining({ accountCode: '1410', debit: '45.00' }),
        expect.objectContaining({ accountCode: '1411', debit: '45.00' }),
        expect.objectContaining({ accountCode: '1110', credit: '590.00' }),
      ]),
    );

    // 5. Cancel expense: posts reversal journal and marks cancelled
    const cancelRes = await biz.client.post(
      `/expenses/${posted.id}/cancel`,
      {
        reason: 'Entered under incorrect category',
      },
      key(),
    );
    expect(cancelRes.status, JSON.stringify(cancelRes.body)).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    const revJrn = (await biz.client.get(`/journals?sourceType=expense&sourceId=${posted.id}`)).body.data.find(
      (j: any) => j.reversal || j.reversedJournalId != null,
    );
    expect(revJrn).toBeDefined();
  });

  it('H. issues Sales Return Credit Note, restores inventory, adjusts invoice balance, posts journal', async () => {
    const biz = await setupPaymentBiz('sales-ret-cn');

    // 1. Issue sales invoice for 10 bolts @ 10 = 100 + 18% = 118
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);
    const invoice = (
      await biz.client.post(
        `/sales-invoices/${invRes.body.id}/issue`,
        { version: invRes.body.version, expectedTotal: invRes.body.totals.grand },
        key(),
      )
    ).body;
    expect(invoice.outstanding).toBe('118.00');

    // Initial stock before return (100 opening - 10 invoiced = 90)
    const stockBefore = (await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`)).body.data[0].onHand;
    expect(stockBefore).toBe('90');

    // 2. Create Credit Note for return of 2 bolts
    const cnRes = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      salesInvoiceId: invoice.id,
      kind: 'sales_return',
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      reason: 'Defective goods returned by customer',
      lines: [
        {
          sourceLineId: invoice.lines[0].lineId,
          itemId: biz.boltId,
          qty: '2',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    expect(cnRes.status, JSON.stringify(cnRes.body)).toBe(201);
    const cn = cnRes.body;
    expect(cn.amounts.taxable).toBe('20.00');
    expect(cn.amounts.grand).toBe('24.00');

    // 3. Issue the credit note
    const issueRes = await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key());
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    const issuedCn = issueRes.body;
    expect(issuedCn.status).toBe('issued');
    expect(issuedCn.number).toMatch(/^CN\//);

    // 4. Verify stock restored (+2 on hand)
    const stockAfter = (await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`)).body.data[0].onHand;
    expect(stockAfter).toBe('92');

    // 5. Verify invoice outstanding balance is adjusted (118.00 - 24.00 = 94.00)
    const invAfter = (await biz.client.get(`/sales-invoices/${invoice.id}`)).body;
    expect(invAfter.outstanding).toBe('94.00');

    // 6. Verify balanced journal posted (Dr 4100 Sales Return, Dr 2210/2211 Output GST, Cr 1200 Trade Receivables)
    const jrnRes = await biz.client.get(`/journals?sourceType=credit_note&sourceId=${cn.id}`);
    expect(jrnRes.status).toBe(200);
    const journal = jrnRes.body.data[0];
    expect(journal).toBeDefined();
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '4100' }),
        expect.objectContaining({ accountCode: '1200' }),
      ]),
    );
  });

  it('I. issues Purchase Return Debit Note, reduces inventory, adjusts bill balance, posts journal', async () => {
    const biz = await setupPaymentBiz('pur-ret-dn');

    // 1. Post supplier bill for 10 bolts @ 10 = 100 + 18% = 118
    const bRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-DN-01',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      itcEligible: true,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    const bill = (await biz.client.post(`/supplier-bills/${bRes.body.id}/post`, {}, key())).body;
    expect(bill.outstanding).toBe('118.00');

    // Stock before return = 100 opening
    const stockBefore = (await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`)).body.data[0].onHand;
    expect(stockBefore).toBe('100');

    // 2. Create Debit Note for return of 3 bolts
    const dnRes = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      supplierBillId: bill.id,
      kind: 'purchase_return',
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      reason: 'Substandard material returned to vendor',
      lines: [
        {
          sourceLineId: bill.lines[0].lineId,
          itemId: biz.boltId,
          qty: '3',
          unitPrice: '10.00',
          taxRate: '18',
        },
      ],
    });
    expect(dnRes.status, JSON.stringify(dnRes.body)).toBe(201);
    const dn = dnRes.body;
    expect(dn.amounts.taxable).toBe('30.00');
    expect(dn.amounts.grand).toBe('35.00');

    // 3. Issue the debit note
    const issueRes = await biz.client.post(`/debit-notes/${dn.id}/issue`, {}, key());
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);
    const issuedDn = issueRes.body;
    expect(issuedDn.status).toBe('issued');
    expect(issuedDn.number).toMatch(/^DN\//);

    // 4. Verify inventory reduced (-3 on hand -> 97)
    const stockAfter = (await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`)).body.data[0].onHand;
    expect(stockAfter).toBe('97');

    // 5. Verify supplier bill outstanding balance is adjusted (118.00 - 35.00 = 83.00)
    const billAfter = (await biz.client.get(`/supplier-bills/${bill.id}`)).body;
    expect(billAfter.outstanding).toBe('83.00');

    // 6. Verify balanced journal posted (Dr 2100 Trade Payables, Cr 1300 Inventory, Cr 1410/1411 Input GST)
    const jrnRes = await biz.client.get(`/journals?sourceType=debit_note&sourceId=${dn.id}`);
    expect(jrnRes.status).toBe(200);
    const journal = jrnRes.body.data[0];
    expect(journal).toBeDefined();
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: '2100' }),
        expect.objectContaining({ accountCode: '1300' }),
      ]),
    );
  });

  it('J. generates accurate Party Statement with running balances across invoices, payments, notes', async () => {
    const biz = await setupPaymentBiz('statement-flow');

    // 1. Issue sales invoice for 100 + 18% = 118
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: '2026-04-01',
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    expect(invRes.status, JSON.stringify(invRes.body)).toBe(201);
    const issueRes = await biz.client.post(
      `/sales-invoices/${invRes.body.id}/issue`,
      { version: invRes.body.version, expectedTotal: invRes.body.totals.grand },
      key(),
    );
    expect(issueRes.status, JSON.stringify(issueRes.body)).toBe(200);

    // 2. Post customer receipt of 50
    const pmtRes = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      amount: '50.00',
      paymentMethod: 'bank_transfer',
      docDate: '2026-04-05',
    });
    const postRes = await biz.client.post(`/payments/${pmtRes.body.id}/post`, {}, key());
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);

    // 3. Query statement from 2026-04-01 to 2026-04-30
    const stmtRes = await biz.client.get(
      `/parties/${biz.customerId}/statement?legalEntityId=${biz.entityId}&from=2026-04-01&to=2026-04-30`,
    );
    expect(stmtRes.status, JSON.stringify(stmtRes.body)).toBe(200);
    const stmt = stmtRes.body;
    expect(stmt.partyId).toBe(biz.customerId);
    expect(stmt.openingBalance).toBe('0.00');
    expect(stmt.totalDebit).toBe('118.00'); // Invoice
    expect(stmt.totalCredit).toBe('50.00'); // Payment
    expect(stmt.closingBalance).toBe('68.00'); // 118 - 50 = 68
    expect(stmt.entries.length).toBeGreaterThanOrEqual(2);
  });
});
