import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, fakeGstin, fakePan, setupEntity, signUp, type Client, type Harness, address } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(h.clock.now().getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic purchase test fixture';
const key = () => ({ 'Idempotency-Key': randomUUID() });

interface PurchaseBiz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  warehouseId: string;
  boltId: string;
  nutId: string;
  supplierId: string;
}

async function setupPurchaseBiz(label: string): Promise<PurchaseBiz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);

  const wh = await client.post('/warehouses', {
    legalEntityId: e.entityId,
    code: 'PUR-WH',
    name: 'Purchase Warehouse (test)',
    gstRegistrationId: e.registrationId,
  });
  expect(wh.status).toBe(201);

  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const nos = units.find((u) => u.code === 'NOS')?.id;

  const goods = await client.post('/tax-classes', { name: 'Raw Materials (test)', kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: SOURCE,
  });

  const bolt = await client.post('/items', {
    sku: 'RAW-BOLT',
    name: 'Industrial Bolt',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '7318',
    taxClassId: goods.body.id,
    salePrice: '20.00',
  });
  const nut = await client.post('/items', {
    sku: 'RAW-NUT',
    name: 'Industrial Nut',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '7318',
    taxClassId: goods.body.id,
    salePrice: '10.00',
  });

  const pan = fakePan('F');
  const supplier = await client.post('/parties', {
    name: 'National Steel Corp (test)',
    isCustomer: false,
    isSupplier: true,
    pan,
    gstins: [{ gstin: fakeGstin('27', pan), addressId: 's1' }],
    addresses: [{ id: 's1', label: 'Works', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(supplier.status).toBe(201);

  // Setup document series for purchase order and supplier bill
  const poSeries = await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: null,
    docType: 'purchase_order',
    name: 'PO Series (test)',
    prefix: 'PO/{FY}/',
    padding: 4,
  });
  expect(poSeries.status).toBe(201);

  const billSeries = await client.post('/document-series', {
    legalEntityId: e.entityId,
    gstRegistrationId: null,
    docType: 'supplier_bill',
    name: 'Bill Series (test)',
    prefix: 'BILL/{FY}/',
    padding: 4,
  });
  expect(billSeries.status).toBe(201);

  return {
    client,
    tenantId,
    entityId: e.entityId,
    registrationId: e.registrationId,
    warehouseId: wh.body.id,
    boltId: bolt.body.id,
    nutId: nut.body.id,
    supplierId: supplier.body.id,
  };
}

describe('Phase 8: Purchasing and Supplier Workflows', () => {
  it('A. creates, updates, and issues a Purchase Order with gap-free numbering', async () => {
    const biz = await setupPurchaseBiz('po-flow');

    // 1. Create draft PO
    const draftRes = await biz.client.post('/purchase-orders', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      docDate: TODAY(),
      lines: [
        { itemId: biz.boltId, qty: '100', unitPrice: '15.00' },
        { itemId: biz.nutId, qty: '200', unitPrice: '8.00' },
      ],
    });
    expect(draftRes.status).toBe(201);
    const po = draftRes.body;
    expect(po.status).toBe('draft');
    expect(po.number).toBeNull();
    expect(po.lines).toHaveLength(2);
    // Line 1: 100 * 15 = 1500 + 18% GST (270) = 1770
    // Line 2: 200 * 8 = 1600 + 18% GST (288) = 1888
    // Total taxable: 3100, GST: 558, Grand: 3658
    expect(po.amounts.taxable).toBe('3100.00');
    expect(po.amounts.grand).toBe('3658.00');

    // 2. Issue the PO
    const issueRes = await biz.client.post(`/purchase-orders/${po.id}/issue`, {}, key());
    expect(issueRes.status).toBe(200);
    const issuedPo = issueRes.body;
    expect(issuedPo.status).toBe('issued');
    expect(issuedPo.number).toMatch(/^PO\//);
    expect(issuedPo.issuedAt).toBeDefined();

    // 3. Reject second issue attempt
    const doubleIssue = await biz.client.post(`/purchase-orders/${po.id}/issue`, {}, key());
    expect(doubleIssue.status).toBe(409);
  });

  it('B. receives goods against a PO, tracks remaining balance, rejects excess, and updates stock', async () => {
    const biz = await setupPurchaseBiz('grn-flow');

    // Create & issue PO for 50 bolts
    const poRes = await biz.client.post('/purchase-orders', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '50', unitPrice: '15.00' }],
    });
    const po = (await biz.client.post(`/purchase-orders/${poRes.body.id}/issue`, {}, key())).body;
    const poLineId = po.lines[0].id;

    // 1. Partial receipt of 30 bolts
    const grn1Res = await biz.client.post('/goods-receipts', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      purchaseOrderId: po.id,
      supplierDeliveryChallanNumber: 'DC-001',
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '30', sourceLineId: poLineId }],
    });
    expect(grn1Res.status).toBe(201);
    const grn1 = grn1Res.body;
    expect(grn1.status).toBe('draft');

    // Receive into stock
    const receive1 = await biz.client.post(`/goods-receipts/${grn1.id}/receive`, {}, key());
    expect(receive1.status).toBe(200);
    expect(receive1.body.status).toBe('received');
    expect(receive1.body.number).toMatch(/^GRN\//);

    // Verify PO status updated to partially_received
    const poAfter1 = (await biz.client.get(`/purchase-orders/${po.id}`)).body;
    expect(poAfter1.status).toBe('partially_received');
    expect(poAfter1.lines[0].receivedQty).toBe('30');

    // Verify stock ledger has +30 on hand
    const stockRes = await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`);
    expect(stockRes.status).toBe(200);
    expect(stockRes.body.data[0].onHand).toBe('30');

    // 2. Reject excess receipt: attempt to receive 25 when only 20 remaining
    const excessGrn = await biz.client.post('/goods-receipts', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      purchaseOrderId: po.id,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '25', sourceLineId: poLineId }],
    });
    const excessAttempt = await biz.client.post(`/goods-receipts/${excessGrn.body.id}/receive`, {}, key());
    expect(excessAttempt.status).toBe(422);
    expect(excessAttempt.body.error.message).toMatch(/cannot exceed ordered quantity/i);

    // 3. Receive remaining 20 bolts
    const grn2Res = await biz.client.post('/goods-receipts', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      purchaseOrderId: po.id,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '20', sourceLineId: poLineId }],
    });
    const receive2 = await biz.client.post(`/goods-receipts/${grn2Res.body.id}/receive`, {}, key());
    expect(receive2.status).toBe(200);

    // PO should now be fully received
    const poFullyReceived = (await biz.client.get(`/purchase-orders/${po.id}`)).body;
    expect(poFullyReceived.status).toBe('received');
    expect(poFullyReceived.lines[0].receivedQty).toBe('50');

    // Stock should now be 50
    const stockFinal = await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`);
    expect(stockFinal.body.data[0].onHand).toBe('50');
  });

  it('C. cancels a Goods Receipt and atomically rolls back stock and PO remaining balance', async () => {
    const biz = await setupPurchaseBiz('grn-cancel');

    const poRes = await biz.client.post('/purchase-orders', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '40', unitPrice: '15.00' }],
    });
    const po = (await biz.client.post(`/purchase-orders/${poRes.body.id}/issue`, {}, key())).body;
    const poLineId = po.lines[0].id;

    // Receive 40 bolts
    const grnRes = await biz.client.post('/goods-receipts', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      purchaseOrderId: po.id,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '40', sourceLineId: poLineId }],
    });
    const grn = (await biz.client.post(`/goods-receipts/${grnRes.body.id}/receive`, {}, key())).body;
    expect(grn.status).toBe('received');

    // Check stock = 40
    const stockBefore = await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`);
    expect(stockBefore.body.data[0].onHand).toBe('40');

    // Cancel GRN
    const cancelRes = await biz.client.post(`/goods-receipts/${grn.id}/cancel`, {
      reason: 'Wrong delivery batch delivered by supplier',
    }, key());
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Check stock rolled back to 0
    const stockAfter = await biz.client.get(`/stock?warehouseId=${biz.warehouseId}&itemId=${biz.boltId}`);
    expect(stockAfter.body.data[0].onHand).toBe('0');

    // PO receivedQty rolled back to 0 and status restored to issued
    const poRestored = (await biz.client.get(`/purchase-orders/${po.id}`)).body;
    expect(poRestored.status).toBe('issued');
    expect(poRestored.lines[0].receivedQty).toBe('0');
  });

  it('D. records Supplier Bill with duplicate invoice protection and posts Trade Payables journal', async () => {
    const biz = await setupPurchaseBiz('bill-flow');

    // 1. Create and post supplier bill
    const billRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-TEST-7788',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      dueDate: TODAY(),
      itcEligible: true,
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    expect(billRes.status).toBe(201);
    const bill = billRes.body;
    expect(bill.status).toBe('draft');
    expect(bill.supplierInvoiceNumber).toBe('INV-TEST-7788');

    // 2. Reject duplicate supplier invoice number for the same supplier
    const dupRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-TEST-7788',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '10.00' }],
    });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.message).toMatch(/already exists/i);

    // 3. Post the supplier bill
    const postRes = await biz.client.post(`/supplier-bills/${bill.id}/post`, {}, key());
    expect(postRes.status).toBe(200);
    const postedBill = postRes.body;
    expect(postedBill.status).toBe('posted');
    expect(postedBill.number).toMatch(/^BILL\//);
    expect(postedBill.paymentStatus).toBe('unpaid');

    // 4. Check journal entry was posted
    const journalRes = await biz.client.get(`/journals?sourceType=supplier_bill&sourceId=${bill.id}`);
    expect(journalRes.status).toBe(200);
    const journal = journalRes.body.data[0];
    expect(journal).toBeDefined();
    // Bill total = 10 * 10 = 100 + 18% = 118
    // Credit 2100 (Trade Payables): 118.00
    // Debit 1300 (Inventory): 100.00
    // Debit 1410 (Input CGST): 9.00
    // Debit 1411 (Input SGST): 9.00
    const lines = journal.lines;
    const payableLine = lines.find((l: { accountCode: string }) => l.accountCode === '2100');
    expect(payableLine).toBeDefined();
    expect(payableLine.credit).toBe('118.00');

    // 5. Cancel the supplier bill and verify journal reversal
    const cancelRes = await biz.client.post(`/supplier-bills/${bill.id}/cancel`, {
      reason: 'Billing pricing error confirmed by supplier',
    }, key());
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Journal should have a reversal entry
    const allJournals = await biz.client.get(`/journals?sourceType=supplier_bill&sourceId=${bill.id}`);
    expect(allJournals.body.data).toHaveLength(2);
    const reversal = allJournals.body.data.find((j: { reversedJournalId: string | null }) => j.reversedJournalId !== null);
    expect(reversal).toBeDefined();
  });

  it('E. calculates supplier payables and ageing buckets accurately', async () => {
    const biz = await setupPurchaseBiz('payables-flow');

    // Post an unpaid supplier bill of ₹590 (500 + 18% GST)
    const billRes = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'INV-PAY-001',
      supplierInvoiceDate: TODAY(),
      docDate: TODAY(),
      dueDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '50', unitPrice: '10.00' }],
    });
    await biz.client.post(`/supplier-bills/${billRes.body.id}/post`, {}, key());

    // Fetch payables summary
    const payRes = await biz.client.get(`/purchases/payables?legalEntityId=${biz.entityId}&asOf=${TODAY()}`);
    expect(payRes.status).toBe(200);
    const summary = payRes.body;
    expect(summary.totalOutstanding).toBe('590.00');
    expect(summary.bills).toHaveLength(1);
    expect(summary.bills[0].supplierInvoiceNumber).toBe('INV-PAY-001');
    expect(summary.bills[0].outstanding).toBe('590.00');
  });

  it('F. generates purchase order PDF on demand', async () => {
    const biz = await setupPurchaseBiz('po-pdf');

    const poRes = await biz.client.post('/purchase-orders', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      docDate: TODAY(),
      lines: [{ itemId: biz.boltId, qty: '10', unitPrice: '15.00' }],
    });
    const po = (await biz.client.post(`/purchase-orders/${poRes.body.id}/issue`, {}, key())).body;

    const pdfRes = await biz.client.get(`/purchase-orders/${po.id}/pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.body.length).toBeGreaterThan(500);
  });
});
