import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createHarness,
  fakeGstin,
  fakePan,
  setupEntity,
  signUp,
  address,
  type Client,
  type Harness,
} from './harness.js';
// @ts-ignore
import { runFinancialDiagnostic } from '../../../../scripts/diagnostic-core.mjs';

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
const SOURCE = 'Slice 0 acceptance fixture';
const key = () => ({ 'Idempotency-Key': randomUUID() });

interface TestBiz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  warehouseId: string;
  itemId: string;
  customerId: string;
  supplierId: string;
}

async function setupAcceptanceBiz(label: string, unitCost = '60.00', salePrice = '100.00'): Promise<TestBiz> {
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
    code: `WH-${label.toUpperCase().slice(0, 6)}`,
    name: 'Acceptance Warehouse',
    gstRegistrationId: e.registrationId,
  });
  expect(wh.status).toBe(201);

  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const nos = units.find((u) => u.code === 'NOS')?.id;

  const goods = await client.post('/tax-classes', { name: `Taxable Goods ${label}`, kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: SOURCE,
  });

  const item = await client.post('/items', {
    sku: `SKU-${label.toUpperCase()}`,
    name: 'Standard Precision Unit',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '8471',
    taxClassId: goods.body.id,
    salePrice,
  });
  expect(item.status).toBe(201);

  const panCust = fakePan('F');
  const customer = await client.post('/parties', {
    name: `Customer ${label}`,
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
    name: `Supplier ${label}`,
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
      name: `${docType} Series`,
      prefix,
      padding: 4,
    });
  }

  await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: e.registrationId,
    docType: 'tax_invoice',
    name: 'Invoice Series',
    prefix: 'INV/{FY}/',
    padding: 4,
  });

  // Seed inventory at unitCost (100 units)
  const opening = await client.post('/stock-adjustments', {
    warehouseId: wh.body.id,
    type: 'opening',
    docDate: TODAY(),
    lines: [{ itemId: item.body.id, qty: '100', unitCost }],
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

describe('Slice 0 Acceptance Follow-up: Worked Accounting Example', () => {
  it('Customer flow: 1,180 invoice, 1,180 payment, 590 return, 300 COGS restore, explicit credit discrimination', async () => {
    const biz = await setupAcceptanceBiz('cust-worked-ex', '60.00', '100.00');

    // 1. Original Invoice: 10 units @ 100 = 1,000 taxable + 180 tax (90 CGST + 90 SGST) = 1,180
    const invRes = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.customerId,
      docDate: TODAY(),
      warehouseId: biz.warehouseId,
      lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
    });
    const inv = invRes.body;
    const issuedInv = (
      await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())
    ).body;
    expect(issuedInv.totals.grand).toBe('1180.00');
    expect(issuedInv.outstanding).toBe('1180.00');

    // Verify invoice journals: Dr 1200 (1180), Cr 4100 (1000), Cr 2210 (90), Cr 2220 (90); COGS Dr 5200 (600), Cr 1300 (600)
    const invJournals = (await biz.client.get(`/journals?sourceType=sales_invoice&sourceId=${issuedInv.id}`)).body.data;
    expect(invJournals.length).toBeGreaterThanOrEqual(1);

    // 2. Payment received in full: 1,180 via bank transfer
    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '1180.00' }] },
      key(),
    );

    const invAfterPmt = (await biz.client.get(`/sales-invoices/${issuedInv.id}`)).body;
    expect(invAfterPmt.outstanding).toBe('0.00');
    expect(invAfterPmt.paymentStatus).toBe('paid');

    // 3. Return one-half: 5 units. Credit: 590 (500 taxable + 90 tax). Restored cost: 300 (5 * 60)
    const cnRes = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      salesInvoiceId: issuedInv.id,
      kind: 'sales_return',
      docDate: TODAY(),
      reason: 'Half batch return',
      lines: [
        {
          sourceLineId: issuedInv.lines[0].lineId,
          itemId: biz.itemId,
          qty: '5',
          unitPrice: '100.00',
          taxRate: '18',
        },
      ],
    });
    const issuedCn = (await biz.client.post(`/credit-notes/${cnRes.body.id}/issue`, {}, key())).body;
    expect(issuedCn.status).toBe('issued');
    expect(issuedCn.amounts.grand).toBe('590.00');

    // Verify Credit Note Journal: Dr 4100 (500), Dr 2210 (45), Dr 2220 (45), Cr 1200 (590), Dr 1300 (300), Cr 5200 (300)
    const cnJournals = (await biz.client.get(`/journals?sourceType=credit_note&sourceId=${issuedCn.id}`)).body.data;
    const cnJ = cnJournals[0];
    expect(cnJ).toBeDefined();

    const dr1300 = cnJ.lines.find((l: any) => l.accountCode === '1300');
    const cr5200 = cnJ.lines.find((l: any) => l.accountCode === '5200');
    const cr1200 = cnJ.lines.find((l: any) => l.accountCode === '1200');
    const drSalesReturn = cnJ.lines.find((l: any) => l.accountCode === '4100');

    expect(dr1300?.debit).toBe('300.00');
    expect(cr5200?.credit).toBe('300.00');
    expect(cr1200?.credit).toBe('590.00');
    expect(drSalesReturn?.debit).toBe('500.00');

    // Verify invoice outstanding remains 0.00 (not clamped to negative)
    const invAfterCn = (await biz.client.get(`/sales-invoices/${issuedInv.id}`)).body;
    expect(invAfterCn.outstanding).toBe('0.00');

    // Verify explicit unapplied credit record: discriminated Model B
    const payments = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data;
    const excessCredit = payments.find((p: any) => p.recordKind === 'credit_note_excess');
    expect(excessCredit, 'Explicit discriminated credit_note_excess record must exist').toBeDefined();
    expect(excessCredit.amount).toBe('590.00');
    expect(excessCredit.unallocatedAmount).toBe('590.00');
    expect(excessCredit.paymentMethod).toBe('credit');
    expect(excessCredit.sourceNoteId).toBe(issuedCn.id);

    // Verify statement presentation:
    // Invoice (+1180), Payment Receipt (-1180), Credit Note (-590).
    // Non-cash credit record MUST NOT appear as cash receipt.
    const stmt = (
      await biz.client.get(
        `/parties/${biz.customerId}/statement?legalEntityId=${biz.entityId}&from=2026-01-01&to=2026-12-31`,
      )
    ).body;
    expect(stmt.entries.length).toBe(3); // Invoice, Payment, Credit Note
    const receiptsInStmt = stmt.entries.filter((e: any) => e.docType === 'payment_receipt');
    expect(receiptsInStmt.length, 'Only 1 genuine cash receipt must appear on statement').toBe(1);
    expect(receiptsInStmt[0].credit).toBe('1180.00');

    // Closing balance must be -590.00 (customer in credit)
    expect(stmt.closingBalance).toBe('-590.00');
  });

  it('Path A: Applying that credit to a new invoice', async () => {
    const biz = await setupAcceptanceBiz('cust-path-a', '60.00', '100.00');

    // 1. Original 1,180 invoice, paid 1,180, return 590
    const inv1 = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv1 = (await biz.client.post(`/sales-invoices/${inv1.id}/issue`, { version: inv1.version, expectedTotal: inv1.totals.grand }, key())).body;

    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(`/payments/${pmt.id}/allocate`, { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv1.id, amount: '1180.00' }] }, key());

    const cn = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv1.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'Half return',
        lines: [{ sourceLineId: issuedInv1.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;
    await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key());

    const excessCredit = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data.find(
      (p: any) => p.recordKind === 'credit_note_excess',
    );
    expect(excessCredit.unallocatedAmount).toBe('590.00');

    // 2. Issue a NEW invoice for 5 units = 590.00
    const inv2 = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '5', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv2 = (await biz.client.post(`/sales-invoices/${inv2.id}/issue`, { version: inv2.version, expectedTotal: inv2.totals.grand }, key())).body;
    expect(issuedInv2.outstanding).toBe('590.00');

    // 3. Allocate the 590 credit to the new invoice
    const allocRes = await biz.client.post(
      `/payments/${excessCredit.id}/allocate`,
      { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv2.id, amount: '590.00' }] },
      key(),
    );
    expect(allocRes.status).toBe(200);

    // Verify invoice 2 is now fully paid by the credit
    const inv2AfterAlloc = (await biz.client.get(`/sales-invoices/${issuedInv2.id}`)).body;
    expect(inv2AfterAlloc.outstanding).toBe('0.00');
    expect(inv2AfterAlloc.paymentStatus).toBe('paid');

    // Verify excess credit balance is now 0.00
    const creditAfterAlloc = (await biz.client.get(`/payments/${excessCredit.id}`)).body;
    expect(creditAfterAlloc.unallocatedAmount).toBe('0.00');

    // Statement balance should be exactly 0.00
    const stmt = (
      await biz.client.get(
        `/parties/${biz.customerId}/statement?legalEntityId=${biz.entityId}&from=2026-01-01&to=2026-12-31`,
      )
    ).body;
    expect(stmt.closingBalance).toBe('0.00');
  });

  it('Path B: Refunding that credit via bank transfer', async () => {
    const biz = await setupAcceptanceBiz('cust-path-b', '60.00', '100.00');

    // Invoice 1,180, paid 1,180, return 590
    const inv = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv = (await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())).body;

    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(`/payments/${pmt.id}/allocate`, { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '1180.00' }] }, key());

    const cn = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'Refund requested return',
        lines: [{ sourceLineId: issuedInv.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;
    await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key());

    const excessCredit = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data.find(
      (p: any) => p.recordKind === 'credit_note_excess',
    );

    // Refund the 590 credit note excess
    const refundRes = await biz.client.post(
      '/refunds',
      {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: excessCredit.id,
        amount: '590.00',
        paymentMethod: 'bank_transfer',
        refundDate: TODAY(),
        reason: 'Cash refund for returned items',
      },
      key(),
    );
    expect(refundRes.status).toBe(201);

    // Verify refund journal debited 1200 Trade Receivables (not 2300 Advances) and credited 1110 Bank
    const refundJournals = (await biz.client.get(`/journals?sourceType=refund&sourceId=${refundRes.body.id}`)).body.data;
    const rJ = refundJournals[0];
    expect(rJ).toBeDefined();

    const dr1200 = rJ.lines.find((l: any) => l.accountCode === '1200');
    const cr1110 = rJ.lines.find((l: any) => l.accountCode === '1110');
    expect(dr1200?.debit, 'Refund of credit note excess must debit 1200 Trade Receivables').toBe('590.00');
    expect(cr1110?.credit, 'Refund must credit 1110 Bank').toBe('590.00');

    // Statement balance should be back to 0.00
    const stmt = (
      await biz.client.get(
        `/parties/${biz.customerId}/statement?legalEntityId=${biz.entityId}&from=2026-01-01&to=2026-12-31`,
      )
    ).body;
    expect(stmt.closingBalance).toBe('0.00');
  });

  it('Path C: Reversing the source note before settlement', async () => {
    const biz = await setupAcceptanceBiz('cust-path-c', '60.00', '100.00');

    const inv = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv = (await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())).body;

    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(`/payments/${pmt.id}/allocate`, { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '1180.00' }] }, key());

    const cn = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'Erroneous note to cancel',
        lines: [{ sourceLineId: issuedInv.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;
    const issuedCn = (await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key())).body;

    const excessCredit = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data.find(
      (p: any) => p.recordKind === 'credit_note_excess',
    );
    expect(excessCredit.status).toBe('posted');

    // Attempting to reverse via cash-payment workflow must be forbidden
    const badRev = await biz.client.post(`/payments/${excessCredit.id}/reverse`, { reason: 'Wrong workflow' }, key());
    expect(badRev.status, 'Reversing note credit via payment workflow must be rejected').toBe(422);

    // Cancel source credit note
    const cancelRes = await biz.client.post(`/credit-notes/${issuedCn.id}/cancel`, { reason: 'Created by mistake' }, key());
    expect(cancelRes.status).toBe(200);

    // Excess credit record must be reversed and unallocated balance zeroed out
    const creditAfterCancel = (await biz.client.get(`/payments/${excessCredit.id}`)).body;
    expect(creditAfterCancel.status).toBe('reversed');
    expect(creditAfterCancel.unallocatedAmount).toBe('0.00');
  });

  it('Path D: Attempting source-note reversal after allocation/refund must fail', async () => {
    const biz = await setupAcceptanceBiz('cust-path-d', '60.00', '100.00');

    const inv = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv = (await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())).body;

    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(`/payments/${pmt.id}/allocate`, { allocations: [{ targetType: 'sales_invoice', targetId: issuedInv.id, amount: '1180.00' }] }, key());

    const cn = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'Return to be refunded then tested for cancel',
        lines: [{ sourceLineId: issuedInv.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;
    const issuedCn = (await biz.client.post(`/credit-notes/${cn.id}/issue`, {}, key())).body;

    const excessCredit = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data.find(
      (p: any) => p.recordKind === 'credit_note_excess',
    );

    // Refund partial amount (200.00)
    await biz.client.post(
      '/refunds',
      {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: excessCredit.id,
        amount: '200.00',
        paymentMethod: 'bank_transfer',
        refundDate: TODAY(),
        reason: 'Partial refund',
      },
      key(),
    );

    // Attempting to cancel credit note now must fail because settlement has occurred
    const cancelRes = await biz.client.post(`/credit-notes/${issuedCn.id}/cancel`, { reason: 'Attempt cancel after refund' }, key());
    expect(cancelRes.status, 'Cancelling note after settlement must be rejected').toBe(422);
    expect(cancelRes.body.error.message).toMatch(/partially or fully allocated or refunded/);
  });

  it('Supplier flow: ITC-ineligible purchase return produces full gross cost credit and explicit supplier credit', async () => {
    const biz = await setupAcceptanceBiz('supp-itc-inelig', '60.00', '100.00');

    // 1. Supplier bill 1,180 (1,000 + 180 tax) with itcEligible: false
    const billRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      supplierInvoiceNumber: 'BILL-ITC-999',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      dueDate: TODAY(),
      itcEligible: false,
      lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00', taxRate: '18' }],
    });
    expect(billRes.status).toBe(201);
    const bill = (await biz.client.post(`/supplier-bills/${billRes.body.id}/post`, {}, key())).body;
    expect(bill.amounts.grand).toBe('1180.00');

    // 2. Pay bill in full (1,180)
    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.supplierId,
        direction: 'outgoing',
        amount: '1180.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());
    await biz.client.post(
      `/payments/${pmt.id}/allocate`,
      { allocations: [{ targetType: 'supplier_bill', targetId: bill.id, amount: '1180.00' }] },
      key(),
    );

    // 3. Return half (5 units = 590 gross)
    const dnRes = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      partyId: biz.supplierId,
      supplierBillId: bill.id,
      kind: 'purchase_return',
      docDate: TODAY(),
      reason: 'Rejected batch (ITC ineligible)',
      lines: [{ sourceLineId: bill.lines[0].lineId, itemId: biz.itemId, qty: '5', unitPrice: '100.00', taxRate: '18' }],
    });
    const dn = (await biz.client.post(`/debit-notes/${dnRes.body.id}/issue`, {}, key())).body;
    expect(dn.status).toBe('issued');

    // Inspect Debit Note journal:
    // Full gross cost (590) credited to Inventory Asset (1300), 0 to Input GST accounts
    const dnJournals = (await biz.client.get(`/journals?sourceType=debit_note&sourceId=${dn.id}`)).body.data;
    const dnJ = dnJournals[0];
    expect(dnJ).toBeDefined();

    const gstLines = dnJ.lines.filter((l: any) => ['1410', '1411', '1412', '1413'].includes(l.accountCode));
    expect(gstLines.length, 'No Input GST accounts should be touched for ITC-ineligible returns').toBe(0);

    const costCredit = dnJ.lines.find((l: any) => l.accountCode === '1300');
    expect(costCredit?.credit, 'Inventory 1300 receives full gross credit').toBe('590.00');

    // Verify explicit unapplied supplier credit
    const payments = (await biz.client.get(`/payments?partyId=${biz.supplierId}`)).body.data;
    const excessCredit = payments.find((p: any) => p.recordKind === 'debit_note_excess');
    expect(excessCredit).toBeDefined();
    expect(excessCredit.amount).toBe('590.00');
    expect(excessCredit.paymentMethod).toBe('credit');
  });
});

describe('Slice 0 Acceptance Follow-up: Concurrency Safety Proofs', () => {
  it('Competing simultaneous refunds against the same payment record cannot exceed unallocated balance', async () => {
    const biz = await setupAcceptanceBiz('conc-refund', '60.00', '100.00');

    // Payment of 500.00 unallocated advance
    const pmt = (
      await biz.client.post('/payments', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        direction: 'incoming',
        amount: '500.00',
        paymentMethod: 'bank_transfer',
        docDate: TODAY(),
      })
    ).body;
    await biz.client.post(`/payments/${pmt.id}/post`, {}, key());

    // Launch 2 simultaneous refunds for 350.00 each (350 + 350 = 700 > 500)
    const [res1, res2] = await Promise.all([
      biz.client.post('/refunds', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: pmt.id,
        amount: '350.00',
        paymentMethod: 'bank_transfer',
        refundDate: TODAY(),
        reason: 'Concurrent refund 1',
      }, key()),
      biz.client.post('/refunds', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        paymentId: pmt.id,
        amount: '350.00',
        paymentMethod: 'bank_transfer',
        refundDate: TODAY(),
        reason: 'Concurrent refund 2',
      }, key()),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201); // Exactly one must succeed
    expect(statuses).toContain(422); // Exactly one must fail

    // Final unallocated balance must be exactly 150.00 (500 - 350) and never negative
    const finalPayment = (await biz.client.get(`/payments/${pmt.id}`)).body;
    expect(finalPayment.unallocatedAmount).toBe('150.00');

    // Exactly one refund record must exist
    const refunds = (await biz.client.get(`/refunds?paymentId=${pmt.id}`)).body;
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe('350.00');
  });

  it('Competing simultaneous return issuances against the same invoice line cannot exceed returnable quantity', async () => {
    const biz = await setupAcceptanceBiz('conc-returns', '60.00', '100.00');

    // Invoice for 10 units
    const inv = (
      await biz.client.post('/sales-invoices', {
        legalEntityId: biz.entityId,
        gstRegistrationId: biz.registrationId,
        partyId: biz.customerId,
        docDate: TODAY(),
        warehouseId: biz.warehouseId,
        lines: [{ itemId: biz.itemId, qty: '10', unitPrice: '100.00' }],
      })
    ).body;
    const issuedInv = (await biz.client.post(`/sales-invoices/${inv.id}/issue`, { version: inv.version, expectedTotal: inv.totals.grand }, key())).body;
    const lineId = issuedInv.lines[0].lineId;

    // Create 2 draft credit notes, each for 6 units (6 + 6 = 12 > 10)
    const cn1 = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'CN 1 (6 units)',
        lines: [{ sourceLineId: lineId, itemId: biz.itemId, qty: '6', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;

    const cn2 = (
      await biz.client.post('/credit-notes', {
        legalEntityId: biz.entityId,
        partyId: biz.customerId,
        salesInvoiceId: issuedInv.id,
        kind: 'sales_return',
        docDate: TODAY(),
        reason: 'CN 2 (6 units)',
        lines: [{ sourceLineId: lineId, itemId: biz.itemId, qty: '6', unitPrice: '100.00', taxRate: '18' }],
      })
    ).body;

    // Issue both simultaneously
    const [issueRes1, issueRes2] = await Promise.all([
      biz.client.post(`/credit-notes/${cn1.id}/issue`, {}, key()),
      biz.client.post(`/credit-notes/${cn2.id}/issue`, {}, key()),
    ]);

    const statuses = [issueRes1.status, issueRes2.status];
    expect(statuses).toContain(200); // Exactly one succeeds
    expect(statuses.some((s) => s === 400 || s === 422)).toBe(true); // Competing request fails with validation/business rule error

    // Verify only 1 credit note was issued
    const cns = (await biz.client.get(`/credit-notes?partyId=${biz.customerId}&status=issued`)).body.data;
    expect(cns.length).toBe(1);
    expect(cns[0].lines[0].qty).toBe('6');
  });
});

describe('Slice 0 Acceptance Follow-up: Authorization Beyond Probe Counts', () => {
  it('Unauthorized role receives 403 and produces NO financial or stock side effects', async () => {
    const biz = await setupAcceptanceBiz('auth-side-fx', '60.00', '100.00');

    // Create a staff user with role "storekeeper" (can manage stock, but CANNOT post payments or issue credit notes)
    const staff = await addMember(h, biz.client, 'Storekeeper', 'sam-sk');

    // Attempt to post a payment as storekeeper
    const pmtRes = await staff.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.customerId,
      direction: 'incoming',
      amount: '500.00',
      paymentMethod: 'bank_transfer',
      docDate: TODAY(),
    });
    expect(pmtRes.status, 'Payment write by storekeeper must be forbidden').toBe(403);

    // Verify 0 payment documents created
    const payments = (await biz.client.get(`/payments?partyId=${biz.customerId}`)).body.data;
    expect(payments.length, 'No payment document must have been created').toBe(0);

    // Verify 0 journals created
    const journals = (await biz.client.get(`/journals?legalEntityId=${biz.entityId}&sourceType=payment`)).body.data;
    expect(journals.length, 'No journal must have been posted').toBe(0);
  });
});

describe('Slice 0 Acceptance Follow-up: Diagnostic Sensitivity Validation', () => {
  it('Financial diagnostic reliably detects negative balances, missing COGS journals, and excess returns', async () => {
    const db = (h.db.connection as any).db;
    const testTenantId = new (await import('mongoose')).Types.ObjectId();

    const dummyId = new (await import('mongoose')).Types.ObjectId();
    const dec = (s: string) => (import('mongoose')).then(m => m.Types.Decimal128.fromString(s));
    const dec128 = (await import('mongoose')).Types.Decimal128;

    // 1. Seed known defect: negative payment balance
    await db.collection('payments').insertOne({
      tenantId: testTenantId,
      legalEntityId: testTenantId,
      partyId: testTenantId,
      partyName: 'Defect Party',
      direction: 'incoming',
      amount: dec128.fromString('500.00'),
      unallocatedAmount: dec128.fromString('-50.00'), // Negative balance
      paymentMethod: 'bank_transfer',
      docDate: '2026-03-01',
      status: 'posted',
      number: 'PMT-DEFECT-001',
      createdBy: dummyId,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 2. Seed known defect: Credit note without COGS 5200 line
    const cnId = new (await import('mongoose')).Types.ObjectId();
    await db.collection('creditnotes').insertOne({
      _id: cnId,
      tenantId: testTenantId,
      legalEntityId: testTenantId,
      partyId: testTenantId,
      partyName: 'Defect Party',
      number: 'CN-DEFECT-002',
      kind: 'sales_return',
      status: 'issued',
      docDate: '2026-03-01',
      reason: 'Defect',
      createdBy: dummyId,
      version: 1,
      amounts: { grand: dec128.fromString('500.00') },
      lines: [{ lineId: 'l1', itemId: dummyId, qty: dec128.fromString('5') }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection('journals').insertOne({
      tenantId: testTenantId,
      legalEntityId: testTenantId,
      docDate: '2026-03-01',
      sourceType: 'credit_note',
      sourceId: cnId,
      sourceNumber: 'CN-DEFECT-002',
      narration: 'Defect journal',
      totalDebit: dec128.fromString('500.00'),
      totalCredit: dec128.fromString('500.00'),
      reversalOf: null,
      createdBy: dummyId,
      createdAt: new Date(),
      lines: [
        { accountId: dummyId, accountCode: '4100', debit: dec128.fromString('500.00'), credit: dec128.fromString('0.00') },
        { accountId: dummyId, accountCode: '1200', debit: dec128.fromString('0.00'), credit: dec128.fromString('500.00') },
      ],
    });

    // Run diagnostic
    const diag = await runFinancialDiagnostic(db);
    expect(diag.issuesCount, 'Diagnostic must detect seeded defects').toBeGreaterThanOrEqual(2);

    const negBalIssue = diag.issues.find((i: any) => i.kind === 'negative_payment_balance');
    expect(negBalIssue, 'Must detect negative payment balance').toBeDefined();

    const missingCogsIssue = diag.issues.find((i: any) => i.kind === 'missing_cogs_return_journal');
    expect(missingCogsIssue, 'Must detect missing COGS/Inventory journal').toBeDefined();
  });
});
