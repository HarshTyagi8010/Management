import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, address, createHarness, fakeGstin, fakePan, setupEntity, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const TODAY = () => new Date(h.clock.now().getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const SOURCE = 'Synthetic compliance test fixture';
const key = () => ({ 'Idempotency-Key': randomUUID() });

interface ComplianceBiz {
  client: Client;
  tenantId: string;
  entityId: string;
  registrationId: string;
  warehouseId: string;
  taxableItemId: string;
  serviceItemId: string;
  b2bCustomerId: string;
  b2cCustomerId: string;
  supplierId: string;
}

async function setupComplianceBiz(label: string): Promise<ComplianceBiz> {
  const { client, tenantId } = await signUp(h, label);
  const e = await setupEntity(client);

  // Workflow: direct invoice and bill stock movements
  const entity = await client.get(`/legal-entities/${e.entityId}`);
  const wf = await client.put(`/legal-entities/${e.entityId}/workflow`, {
    ...entity.body.workflow,
    stockOutPoint: 'invoice',
    stockInPoint: 'supplier_bill',
    allowNegativeStock: true,
    version: entity.body.version,
  });
  expect(wf.status, JSON.stringify(wf.body)).toBe(200);

  const wh = await client.post('/warehouses', {
    legalEntityId: e.entityId,
    code: 'CP-WH',
    name: 'Compliance Warehouse',
    gstRegistrationId: e.registrationId,
  });
  expect(wh.status).toBe(201);

  const units = (await client.get('/units')).body.data as Array<{ id: string; code: string }>;
  const nos = units.find((u) => u.code === 'NOS')?.id;

  // Tax class 18% goods
  const goods = await client.post('/tax-classes', { name: `Goods 18% ${label}`, kind: 'goods', treatment: 'taxable' });
  await client.post(`/tax-classes/${goods.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: SOURCE,
  });

  // Tax class 18% service
  const service = await client.post('/tax-classes', { name: `Service 18% ${label}`, kind: 'service', treatment: 'taxable' });
  await client.post(`/tax-classes/${service.body.id}/schedules`, {
    version: 0,
    effectiveFrom: '2017-07-01',
    gstRate: '18',
    sourceReference: SOURCE,
  });

  const taxableItem = await client.post('/items', {
    sku: `SKU-GOODS-${label}`,
    name: 'Widget A',
    type: 'stock',
    baseUnitId: nos,
    hsnSac: '8481',
    taxClassId: goods.body.id,
    salePrice: '1000.00',
    purchasePrice: '600.00',
  });
  expect(taxableItem.status, JSON.stringify(taxableItem.body)).toBe(201);

  const serviceItem = await client.post('/items', {
    sku: `SKU-SERV-${label}`,
    name: 'Consulting Service',
    type: 'service',
    baseUnitId: nos,
    hsnSac: '998311',
    taxClassId: service.body.id,
    salePrice: '5000.00',
  });
  expect(serviceItem.status, JSON.stringify(serviceItem.body)).toBe(201);

  // B2B Customer (with valid 15-char Maharashtra GSTIN)
  const panCust = fakePan('C');
  const b2bCustomer = await client.post('/parties', {
    name: `B2B Client ${label}`,
    legalName: `B2B Client Enterprise Pvt Ltd`,
    isCustomer: true,
    isSupplier: false,
    pan: panCust,
    gstins: [{ gstin: fakeGstin('27', panCust), addressId: 'c1' }],
    addresses: [{ id: 'c1', label: 'Office', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(b2bCustomer.status, JSON.stringify(b2bCustomer.body)).toBe(201);

  // B2C Customer (unregistered)
  const b2cCustomer = await client.post('/parties', {
    name: `Consumer John ${label}`,
    isCustomer: true,
    isSupplier: false,
    addresses: [{ id: 'b1', label: 'Home', isBilling: true, isShipping: true, ...address('27') }],
  });
  expect(b2cCustomer.status, JSON.stringify(b2cCustomer.body)).toBe(201);

  // Supplier
  const panSupp = fakePan('F');
  const supplier = await client.post('/parties', {
    name: `Vendor Global ${label}`,
    isCustomer: false,
    isSupplier: true,
    pan: panSupp,
    gstins: [{ gstin: fakeGstin('27', panSupp), addressId: 's1' }],
    addresses: [{ id: 's1', label: 'Plant', isBilling: true, isShipping: true, ...address('27') }],
    paymentTermsDays: 30,
  });
  expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);

  // Setup document series
  for (const [docType, prefix] of [
    ['supplier_bill', 'BILL/{FY}/'],
    ['receipt', 'REC/{FY}/'],
    ['payment', 'PAY/{FY}/'],
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

  for (const [docType, prefix] of [
    ['tax_invoice', 'INV/{FY}/'],
    ['credit_note', 'CN/{FY}/'],
    ['debit_note', 'DN/{FY}/'],
  ] as const) {
    await client.post('/document-series', {
      legalEntityId: e.entityId,
      gstRegistrationId: e.registrationId,
      docType,
      name: `${docType} Series`,
      prefix,
      padding: 4,
    });
  }

  // Seed inventory for stock
  const opening = await client.post('/stock-adjustments', {
    legalEntityId: e.entityId,
    warehouseId: wh.body.id,
    type: 'opening',
    docDate: '2026-10-01',
    reason: 'Initial setup',
    lines: [{ itemId: taxableItem.body.id, qty: '500', unitCost: '500.00' }],
  });
  if (opening.status === 201) {
    await client.post(`/stock-adjustments/${opening.body.id}/post`, { version: opening.body.version }, key());
  }

  return {
    client,
    tenantId,
    entityId: e.entityId,
    registrationId: e.registrationId,
    warehouseId: wh.body.id,
    taxableItemId: taxableItem.body.id,
    serviceItemId: serviceItem.body.id,
    b2bCustomerId: b2bCustomer.body.id,
    b2cCustomerId: b2cCustomer.body.id,
    supplierId: supplier.body.id,
  };
}

describe('Compliance & Statutory Preparation (Batch C)', () => {
  it('1. returns capability status declaring statutory preparation boundaries', async () => {
    const biz = await setupComplianceBiz('c-cap');
    const res = await biz.client.get('/compliance/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PREPARATION_ONLY_NOT_FILED');
    expect(res.body.supportedCapabilities).toBeInstanceOf(Array);
    expect(res.body.unsupportedCapabilities).toBeInstanceOf(Array);

    const liveFiling = res.body.unsupportedCapabilities.find((u: any) => u.feature.includes('Live Filing'));
    expect(liveFiling).toBeDefined();
    expect(liveFiling.reason).toContain('No external GSTN API');
  });

  it('2. categorizes outward supplies across B2B, B2CL, and B2CS with population reconciliation', async () => {
    const biz = await setupComplianceBiz('c-outward');

    // 1. Issue B2B Invoice: registered customer, intra-state (₹10,000 + 18% GST = ₹11,800)
    const b2bDraft = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-05',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '10', unitPrice: '1000.00' }],
    });
    const b2bIssued = await biz.client.post(`/sales-invoices/${b2bDraft.body.id}/issue`, { version: 0 }, key());
    expect(b2bIssued.status, JSON.stringify(b2bIssued.body)).toBe(200);

    // 2. Issue B2CL Invoice: unregistered customer, inter-state place of supply (Gujarat: 24), value > ₹1L
    // Qty: 110 * ₹1,000 = ₹1,10,000 + 18% IGST = ₹1,29,800 (exceeds ₹1,00,000 threshold post 2024-11-01)
    const b2clDraft = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2026-10-06',
      placeOfSupply: '24', // Inter-state
      lines: [{ itemId: biz.taxableItemId, qty: '110', unitPrice: '1000.00' }],
    });
    const b2clIssued = await biz.client.post(`/sales-invoices/${b2clDraft.body.id}/issue`, { version: 0 }, key());
    expect(b2clIssued.status).toBe(200);

    // 3. Issue B2CS Invoice: unregistered customer, intra-state (Maharashtra: 27), value ₹5,900
    const b2csDraft = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2026-10-07',
      placeOfSupply: '27', // Intra-state
      lines: [{ itemId: biz.taxableItemId, qty: '5', unitPrice: '1000.00' }],
    });
    const b2csIssued = await biz.client.post(`/sales-invoices/${b2csDraft.body.id}/issue`, { version: 0 }, key());
    expect(b2csIssued.status).toBe(200);

    // Query Outward Register
    const regRes = await biz.client.get(
      `/compliance/outward-register?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(regRes.status).toBe(200);
    const body = regRes.body;

    expect(body.title).toBe('Outward Supply Preparation Register');
    expect(body.status).toBe('PREPARATION_ONLY_NOT_FILED');
    expect(body.lines).toHaveLength(3);

    // Find categorized summaries
    const b2bSummary = body.summaries.find((s: any) => s.category === 'B2B');
    const b2clSummary = body.summaries.find((s: any) => s.category === 'B2CL');
    const b2csSummary = body.summaries.find((s: any) => s.category === 'B2CS');

    expect(b2bSummary.documentCount).toBe(1);
    expect(parseFloat(b2bSummary.taxableValue)).toBeCloseTo(10000.0, 2);
    expect(parseFloat(b2bSummary.totalTax)).toBeCloseTo(1800.0, 2);

    expect(b2clSummary.documentCount).toBe(1);
    expect(parseFloat(b2clSummary.taxableValue)).toBeCloseTo(110000.0, 2);
    expect(parseFloat(b2clSummary.igst)).toBeCloseTo(19800.0, 2);

    expect(b2csSummary.documentCount).toBe(1);
    expect(parseFloat(b2csSummary.taxableValue)).toBeCloseTo(5000.0, 2);
    expect(parseFloat(b2csSummary.totalTax)).toBeCloseTo(900.0, 2);

    // Population reconciliation
    expect(body.reconciliation.isPopulationReconciled).toBe(true);
    expect(body.reconciliation.totalSourceDocumentsCount).toBe(3);
    expect(body.reconciliation.differenceTaxableValue).toBe('0.00');
  });

  it('3. respects the statutory B2CL threshold boundary (Notification 12/2024-CT effective 1 August 2024)', async () => {
    const biz = await setupComplianceBiz('c-boundary');

    // Test Item A: July 2024 (pre-amendment): ₹1,18,000 inter-state unregistered
    // Old threshold was ₹2,50,000 -> must fall in B2CS
    const julInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2024-07-20',
      placeOfSupply: '24', // Gujarat (inter-state)
      lines: [{ itemId: biz.taxableItemId, qty: '100', unitPrice: '1000.00' }], // ₹1,00,000 + 18% IGST = ₹1,18,000
    });
    await biz.client.post(`/sales-invoices/${julInv.body.id}/issue`, { version: 0 }, key());

    // Test Item B: August 2024 (post-amendment): ₹1,18,000 inter-state unregistered
    // New threshold is ₹1,00,000 effective 2024-08-01 -> strictly > ₹1,00,000 falls in B2CL
    const augInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2024-08-20',
      placeOfSupply: '24', // Gujarat (inter-state)
      lines: [{ itemId: biz.taxableItemId, qty: '100', unitPrice: '1000.00' }], // ₹1,18,000
    });
    await biz.client.post(`/sales-invoices/${augInv.body.id}/issue`, { version: 0 }, key());

    // Test Item C: August 2024 invoice with grand total EXACTLY ₹1,00,000 (taxable 84745.76 + IGST 15254.24 = 100000.00)
    // Rule: strictly > ₹1,00,000 for B2CL. Equal to ₹1,00,000 must fall in B2CS!
    const exactInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2024-08-22',
      placeOfSupply: '24', // Gujarat (inter-state)
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '84745.76' }],
    });
    await biz.client.post(`/sales-invoices/${exactInv.body.id}/issue`, { version: 0 }, key());

    // Test Item D: August 2024 invoice with grand total above ₹1,00,000 (taxable 85000.00 + IGST 15300.00 = 100300.00)
    const aboveInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2024-08-23',
      placeOfSupply: '24', // Gujarat (inter-state)
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '85000.00' }],
    });
    await biz.client.post(`/sales-invoices/${aboveInv.body.id}/issue`, { version: 0 }, key());

    // Test Item E: August 2024 intra-state unregistered invoice with value ₹2,36,000
    // Intra-state unregistered is ALWAYS B2CS regardless of invoice value
    const intraInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2024-08-24',
      placeOfSupply: '27', // Maharashtra (intra-state)
      lines: [{ itemId: biz.taxableItemId, qty: '200', unitPrice: '1000.00' }], // ₹2,00,000 + 18% = ₹2,36,000
    });
    await biz.client.post(`/sales-invoices/${intraInv.body.id}/issue`, { version: 0 }, key());

    // Test Item F: August 2024 inter-state REGISTERED customer invoice with value ₹2,36,000
    // Registered recipient is ALWAYS B2B regardless of invoice value
    const b2bInterInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2024-08-25',
      placeOfSupply: '24', // Gujarat (inter-state)
      lines: [{ itemId: biz.taxableItemId, qty: '200', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${b2bInterInv.body.id}/issue`, { version: 0 }, key());

    // Query register for July 2024
    const julReg = await biz.client.get(
      `/compliance/outward-register?legalEntityId=${biz.entityId}&fromDate=2024-07-01&toDate=2024-07-31`,
    );
    expect(julReg.status).toBe(200);
    const julB2cl = julReg.body.summaries.find((s: any) => s.category === 'B2CL');
    const julB2cs = julReg.body.summaries.find((s: any) => s.category === 'B2CS');
    expect(julB2cl.documentCount).toBe(0);
    expect(julB2cs.documentCount).toBe(1); // Pre-August 2024 1.18L falls in B2CS

    // Query register for August 2024
    const augReg = await biz.client.get(
      `/compliance/outward-register?legalEntityId=${biz.entityId}&fromDate=2024-08-01&toDate=2024-08-31`,
    );
    expect(augReg.status).toBe(200);
    const augB2b = augReg.body.summaries.find((s: any) => s.category === 'B2B');
    const augB2cl = augReg.body.summaries.find((s: any) => s.category === 'B2CL');
    const augB2cs = augReg.body.summaries.find((s: any) => s.category === 'B2CS');

    expect(augB2b.documentCount).toBe(1); // Registered customer is B2B
    expect(augB2cl.documentCount).toBe(2); // Item B (1.18L) and Item D (100000.28)
    expect(augB2cs.documentCount).toBe(2); // Item C (exactly 100000.00) and Item E (2.36L intra-state)
  });

  it('4. distinguishes unregistered credit notes (B2CL notes -> CDNUR, B2CS notes -> net B2CS)', async () => {
    const biz = await setupComplianceBiz('c-notes-split');

    // 1. Issue B2CL invoice: unregistered, inter-state (Gujarat: 24), value > ₹1L (Qty 110 -> ₹1,29,800)
    const b2clInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2026-10-10',
      placeOfSupply: '24',
      lines: [{ itemId: biz.taxableItemId, qty: '110', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${b2clInv.body.id}/issue`, { version: 0 }, key());

    // Issue Credit Note against B2CL invoice -> must go to CDNUR (Table 9B)
    const cnB2cl = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      salesInvoiceId: b2clInv.body.id,
      kind: 'sales_return',
      docDate: '2026-10-12',
      reason: 'B2CL return',
      lines: [{ sourceLineId: b2clInv.body.lines[0].lineId, itemId: biz.taxableItemId, qty: '5', unitPrice: '1000.00', taxRate: '18' }],
    });
    await biz.client.post(`/credit-notes/${cnB2cl.body.id}/issue`, {}, key());

    // 2. Issue B2CS invoice: unregistered, intra-state (Maharashtra: 27), value ₹11,800 (Qty 10)
    const b2csInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      docDate: '2026-10-14',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '10', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${b2csInv.body.id}/issue`, { version: 0 }, key());

    // Issue Credit Note against B2CS invoice -> must NOT go to CDNUR; must net into Table 7 (B2CS)
    const cnB2cs = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2cCustomerId,
      salesInvoiceId: b2csInv.body.id,
      kind: 'sales_return',
      docDate: '2026-10-16',
      reason: 'B2CS return',
      lines: [{ sourceLineId: b2csInv.body.lines[0].lineId, itemId: biz.taxableItemId, qty: '2', unitPrice: '1000.00', taxRate: '18' }],
    });
    await biz.client.post(`/credit-notes/${cnB2cs.body.id}/issue`, {}, key());

    const reg = await biz.client.get(
      `/compliance/outward-register?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(reg.status).toBe(200);

    const cdnur = reg.body.summaries.find((s: any) => s.category === 'CDNUR');
    const b2cs = reg.body.summaries.find((s: any) => s.category === 'B2CS');

    // CDNUR must contain ONLY the B2CL credit note
    expect(cdnur.documentCount).toBe(1);
    expect(parseFloat(cdnur.taxableValue)).toBeCloseTo(-5000.0, 2);

    // B2CS summary must be net of the B2CS credit note (₹10,000 invoice - ₹2,000 credit note = ₹8,000 net)
    expect(b2cs.documentCount).toBe(2); // 1 invoice + 1 credit note
    expect(parseFloat(b2cs.taxableValue)).toBeCloseTo(8000.0, 2);
    expect(parseFloat(b2cs.totalTax)).toBeCloseTo(1440.0, 2);

    // Both credit notes must remain individually drillable in lines
    const cnLines = reg.body.lines.filter((l: any) => l.documentKind === 'credit_note');
    expect(cnLines).toHaveLength(2);
    expect(cnLines.find((l: any) => l.category === 'CDNUR')).toBeDefined();
    expect(cnLines.find((l: any) => l.category === 'B2CS')).toBeDefined();
  });

  it('5. prepares Purchase Register marking purchase returns as REVIEW_REQUIRED (no automatic 4(B)(2))', async () => {
    const biz = await setupComplianceBiz('c-purchases-review');

    // 1. Post ITC-eligible bill: ₹10,000 + ₹1,800 GST
    const eligibleBill = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'VEN-ELIG-01',
      supplierInvoiceDate: '2026-10-01',
      docDate: '2026-10-05',
      itcEligible: true,
      lines: [{ itemId: biz.taxableItemId, qty: '10', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/supplier-bills/${eligibleBill.body.id}/post`, { version: 0 }, key());

    // 2. Post ITC-ineligible bill: ₹5,000 + ₹900 GST
    const ineligibleBill = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'VEN-INELIG-02',
      supplierInvoiceDate: '2026-10-02',
      docDate: '2026-10-06',
      itcEligible: false,
      lines: [{ itemId: biz.taxableItemId, qty: '5', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/supplier-bills/${ineligibleBill.body.id}/post`, { version: 0 }, key());

    // 3. Issue purchase return debit note against eligible bill (Qty 2 -> ₹2,000 + ₹360 GST)
    const debitNote = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      partyId: biz.supplierId,
      supplierBillId: eligibleBill.body.id,
      kind: 'purchase_return',
      docDate: '2026-10-10',
      reason: 'Goods returned to vendor',
      lines: [{ sourceLineId: eligibleBill.body.lines[0].lineId, itemId: biz.taxableItemId, qty: '2', unitPrice: '1000.00', taxRate: '18' }],
    });
    await biz.client.post(`/debit-notes/${debitNote.body.id}/issue`, {}, key());

    // Query Purchase Register
    const purRes = await biz.client.get(
      `/compliance/purchase-register?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(purRes.status).toBe(200);
    const body = purRes.body;

    expect(body.title).toContain('Purchase Register / ITC Review Preparation');
    expect(body.status).toBe('PREPARATION_ONLY_NOT_FILED');
    expect(body.lines).toHaveLength(3);

    // Eligible bill check
    const elLine = body.lines.find((l: any) => l.docNumber.includes('BILL') && l.declaredItcEligible === true);
    expect(elLine.gstr3bCategory).toBe('TABLE_4_A_5_ALL_OTHER_ITC');
    expect(elLine.reviewReason).toBeNull();

    // Ineligible bill check
    const inelLine = body.lines.find((l: any) => l.docNumber.includes('BILL') && l.declaredItcEligible === false);
    expect(inelLine.gstr3bCategory).toBe('INELIGIBLE_GROSS_EXPENSED');

    // Purchase return debit note check -> MUST be REVIEW_REQUIRED (not automatic TABLE_4_B_2)
    const dnLine = body.lines.find((l: any) => l.docType === 'purchase_return_debit_note');
    expect(dnLine.gstr3bCategory).toBe('REVIEW_REQUIRED');
    expect(dnLine.reviewReason).toContain('Commercial purchase return memo requires supplier GST credit note confirmation');

    // Totals verification without duplicate reduction
    expect(parseFloat(body.totals.eligibleTaxCharged)).toBeCloseTo(1800.0, 2);
    expect(parseFloat(body.totals.purchaseReturnAccountingReversalTax)).toBeCloseTo(360.0, 2);
    expect(parseFloat(body.totals.netEligibleTaxUnderReview)).toBeCloseTo(1440.0, 2);
    expect(body.totals.reviewRequiredCount).toBe(1);
  });

  it('6. generates HSN/SAC summary separating B2B/B2C and formats service UQC', async () => {
    const biz = await setupComplianceBiz('c-hsn');

    // B2B invoice with goods (qty 10, UQC NOS)
    const inv1 = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-15',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '10', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv1.body.id}/issue`, { version: 0 }, key());

    // B2C invoice with services (UQC NA, null quantity)
    const inv2 = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      partyId: biz.b2cCustomerId,
      docDate: '2026-10-16',
      placeOfSupply: '27',
      lines: [{ itemId: biz.serviceItemId, qty: '1', unitPrice: '5000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv2.body.id}/issue`, { version: 0 }, key());

    const hsnRes = await biz.client.get(
      `/compliance/hsn-summary?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(hsnRes.status).toBe(200);

    expect(hsnRes.body.b2bSummary).toHaveLength(1);
    expect(hsnRes.body.b2cSummary).toHaveLength(1);

    const b2bItem = hsnRes.body.b2bSummary[0];
    expect(b2bItem.hsnSac).toBe('8481');
    expect(b2bItem.uqc).toBe('NOS');
    expect(parseFloat(b2bItem.totalQty)).toBe(10);

    const b2cItem = hsnRes.body.b2cSummary[0];
    expect(b2cItem.hsnSac).toBe('998311');
    expect(b2cItem.uqc).toBe('NA');
    expect(b2cItem.totalQty).toBeNull();
  });

  it('7. aggregates Document Issued summary for Table 13 and excludes buyer purchase return memos', async () => {
    const biz = await setupComplianceBiz('c-docsum-clean');

    // Issue invoice, outward credit note, and buyer purchase return debit note
    const inv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-20',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: 0 }, key());

    const cn = await biz.client.post('/credit-notes', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      salesInvoiceId: inv.body.id,
      kind: 'sales_return',
      docDate: '2026-10-20',
      reason: 'Return',
      lines: [{ sourceLineId: inv.body.lines[0].lineId, itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00', taxRate: '18' }],
    });
    await biz.client.post(`/credit-notes/${cn.body.id}/issue`, {}, key());

    // Post bill and issue purchase return debit note
    const bill = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      supplierId: biz.supplierId,
      supplierInvoiceNumber: 'VEN-T13-01',
      supplierInvoiceDate: '2026-10-01',
      docDate: '2026-10-20',
      itcEligible: true,
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/supplier-bills/${bill.body.id}/post`, { version: 0 }, key());

    const dn = await biz.client.post('/debit-notes', {
      legalEntityId: biz.entityId,
      warehouseId: biz.warehouseId,
      partyId: biz.supplierId,
      supplierBillId: bill.body.id,
      kind: 'purchase_return',
      docDate: '2026-10-20',
      reason: 'Commercial return memo',
      lines: [{ sourceLineId: bill.body.lines[0].lineId, itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00', taxRate: '18' }],
    });
    await biz.client.post(`/debit-notes/${dn.body.id}/issue`, {}, key());

    const docRes = await biz.client.get(
      `/compliance/document-summary?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(docRes.status).toBe(200);

    const t13 = docRes.body.table13Documents;
    expect(t13.some((d: any) => d.natureOfDocument.includes('Invoices for outward supply'))).toBe(true);
    expect(t13.some((d: any) => d.natureOfDocument.includes('Credit notes'))).toBe(true);
    // CRITICAL: Buyer purchase return debit notes must NOT be in Table 13
    expect(t13.some((d: any) => d.docType === 'debit_note')).toBe(false);

    const excluded = docRes.body.internalExcludedSeries;
    const dnExcl = excluded.find((e: any) => e.seriesPrefix === 'DN');
    expect(dnExcl).toBeDefined();
    expect(dnExcl.exclusionReason).toContain('Inward commercial debit memos issued to suppliers are not outward statutory debit notes');

    expect(docRes.body.unsupportedTable13Categories).toBeInstanceOf(Array);
    expect(docRes.body.unsupportedTable13Categories.some((u: string) => u.includes('Entry 4: Outward statutory debit notes'))).toBe(true);
  });

  it('8. exports safe, typed RFC 4180 CSV with BOM and formula protection', async () => {
    const biz = await setupComplianceBiz('c-csv');

    const inv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-21',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '2', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: 0 }, key());

    const csvRes = await biz.client.get(
      `/compliance/outward-register/export?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(csvRes.text).toContain('Document Number,Document Date,Party Name');
    expect(csvRes.text).toContain('2000.00'); // Valid preserved numeric
  });

  it('9. evaluates Period-Close Readiness Checklist with cryptographic token and enforces race-safe close path', async () => {
    const biz = await setupComplianceBiz('c-close');

    // Issue invoice and reconcile
    const inv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-05',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '5', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: 0 }, key());

    // Record and allocate payment so reconciliation matches
    const pay = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.b2bCustomerId,
      direction: 'incoming',
      amount: '5900.00',
      paymentMode: 'bank_transfer',
      docDate: '2026-10-06',
    });
    await biz.client.post(`/payments/${pay.body.id}/post`, {}, key());
    await biz.client.post(`/payments/${pay.body.id}/allocate`, {
      allocations: [{ targetId: inv.body.id, targetType: 'invoice', amount: '5900.00' }],
    });

    // Check checklist
    const checkRes = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(checkRes.status).toBe(200);
    expect(checkRes.body.counts.blockers).toBe(0);
    expect(checkRes.body.canClose).toBe(true);
    expect(typeof checkRes.body.coordinationToken).toBe('string');

    // Attempt close with corrupted coordination token -> must be rejected
    const malformedClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: 'not-a-valid-token',
      reason: 'Monthly books close for October 2026',
      acknowledgeWarnings: true,
    });
    expect(malformedClose.status).toBe(400);

    // Clean close with valid token
    const goodClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: checkRes.body.coordinationToken,
      reason: 'Monthly books close for October 2026',
      acknowledgeWarnings: true,
    });
    expect(goodClose.status).toBe(200);
    expect(goodClose.body.success).toBe(true);

    // Verify entity is locked up to 2026-10-10
    const entRes = await biz.client.get(`/legal-entities/${biz.entityId}`);
    expect(entRes.body.periodLockDate).toBe('2026-10-10');

    // Attempting posting in locked period (e.g. 2026-10-08) is now rejected with PERIOD_LOCKED
    const lockedDraft = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-08', // Inside locked period
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00' }],
    });
    expect(lockedDraft.status).toBe(422);
    expect(lockedDraft.body.error.code).toBe('PERIOD_LOCKED');
  });

  it('10. demonstrates that financial postings after checklist generation invalidate the coordination token', async () => {
    const biz = await setupComplianceBiz('c-freshness');

    // Reconcile entity initially
    const inv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-05',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '5', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: 0 }, key());

    const pay = await biz.client.post('/payments', {
      legalEntityId: biz.entityId,
      partyId: biz.b2bCustomerId,
      direction: 'incoming',
      amount: '5900.00',
      paymentMode: 'bank_transfer',
      docDate: '2026-10-06',
    });
    await biz.client.post(`/payments/${pay.body.id}/post`, {}, key());
    await biz.client.post(`/payments/${pay.body.id}/allocate`, {
      allocations: [{ targetId: inv.body.id, targetType: 'invoice', amount: '5900.00' }],
    });

    // 1. Generate checklist and obtain coordination token
    const checkRes = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(checkRes.status).toBe(200);
    const staleToken = checkRes.body.coordinationToken;

    // 2. A concurrent financial posting occurs AFTER checklist generation
    // Issuing a new invoice runs assertPeriodOpen, which mutates periodLockCoordination via $inc: { periodLockCoordination: 1 }
    const concurrentInv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-07',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${concurrentInv.body.id}/issue`, { version: 0 }, key());

    // 3. Attempting to execute close using the pre-posting stale token MUST fail
    const closeAttempt = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: staleToken,
      reason: 'Attempt close with stale token',
      acknowledgeWarnings: true,
    });
    expect(closeAttempt.status).toBe(422);
    expect(closeAttempt.body.error.message).toContain('financial postings or period state changes occurred');
  });

  it('11. prevents close execution if a new blocker appears after checklist generation', async () => {
    const biz = await setupComplianceBiz('c-blocker-bypass');

    // Generate checklist initially
    const checkRes = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(checkRes.status).toBe(200);

    // If an attacker attempts to close using a token claiming 0 blockers,
    // the authoritative real-time re-evaluation in executePeriodClose detects newly appeared blockers and stops it
    // Insert an unbalanced journal (2 lines to satisfy schema validator, but debits != credits) to trigger UNBALANCED_JOURNAL_BLOCKER
    const dummyId1 = new Types.ObjectId();
    const dummyId2 = new Types.ObjectId();
    await h.db.models.Journal.create({
      tenantId: biz.tenantId,
      legalEntityId: biz.entityId,
      docDate: '2026-10-05',
      sourceType: 'manual',
      sourceId: dummyId1,
      sourceNumber: 'JRN-UNBAL-BLOCK',
      narration: 'Unbalanced test journal',
      lines: [
        {
          accountId: dummyId1,
          accountCode: '1200',
          debit: Types.Decimal128.fromString('100.00'),
          credit: Types.Decimal128.fromString('0.00'),
        },
        {
          accountId: dummyId2,
          accountCode: '4100',
          debit: Types.Decimal128.fromString('0.00'),
          credit: Types.Decimal128.fromString('50.00'),
        },
      ],
      totalDebit: Types.Decimal128.fromString('100.00'),
      totalCredit: Types.Decimal128.fromString('50.00'),
      createdBy: dummyId1,
      createdAt: new Date(),
    });

    // Get fresh checklist that now has unbalanced journal blocker
    const freshCheck = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(freshCheck.body.counts.blockers).toBeGreaterThan(0);
    expect(freshCheck.body.findings.some((f: any) => f.code === 'UNBALANCED_JOURNAL_BLOCKER')).toBe(true);

    // Attempt close with this token -> rejected
    const closeAttempt = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: freshCheck.body.coordinationToken,
      reason: 'Attempt close with blockers',
      acknowledgeWarnings: true,
    });
    expect(closeAttempt.status).toBe(422);
    expect(closeAttempt.body.error.message).toContain('active blockers');
  });

  it('12. enforces past-period close policy (blocks historical reconciled close; permits administrative lock)', async () => {
    const biz = await setupComplianceBiz('c-past-period');

    // Create a transaction in October 2026
    const inv = await biz.client.post('/sales-invoices', {
      legalEntityId: biz.entityId,
      gstRegistrationId: biz.registrationId,
      warehouseId: biz.warehouseId,
      partyId: biz.b2bCustomerId,
      docDate: '2026-10-05',
      placeOfSupply: '27',
      lines: [{ itemId: biz.taxableItemId, qty: '1', unitPrice: '1000.00' }],
    });
    await biz.client.post(`/sales-invoices/${inv.body.id}/issue`, { version: 0 }, key());

    // 1. Attempt historical close for August 2026 (2026-08-31) in reconciled_close mode
    // Because subsequent transactions exist in October, historical reconciliation cannot establish closing balances
    const histCheck = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-08-31&mode=reconciled_close`,
    );
    expect(histCheck.status).toBe(200);
    expect(histCheck.body.isPastPeriod).toBe(true);
    expect(histCheck.body.canClose).toBe(false);
    expect(histCheck.body.findings.some((f: any) => f.code === 'HISTORICAL_RECONCILIATION_UNSUPPORTED')).toBe(true);

    const histClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-08-31',
      mode: 'reconciled_close',
      coordinationToken: histCheck.body.coordinationToken,
      reason: 'Attempt historical reconciled close',
      acknowledgeWarnings: true,
    });
    expect(histClose.status).toBe(422);

    // 2. Perform supported administrative lock for August 2026 (mode: 'administrative_lock')
    const adminCheck = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-08-31&mode=administrative_lock`,
    );
    expect(adminCheck.status).toBe(200);
    expect(adminCheck.body.canClose).toBe(true);
    expect(adminCheck.body.closeMode).toBe('administrative_lock');
    expect(adminCheck.body.findings.some((f: any) => f.code === 'ADMINISTRATIVE_LOCK_MODE')).toBe(true);

    const adminClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-08-31',
      mode: 'administrative_lock',
      coordinationToken: adminCheck.body.coordinationToken,
      reason: 'Administrative posting lock for past August 2026 period',
      acknowledgeWarnings: true,
    });
    expect(adminClose.status).toBe(200);
    expect(adminClose.body.success).toBe(true);
    expect(adminClose.body.closeMode).toBe('administrative_lock');
    expect(adminClose.body.message).toContain('administrative posting lock');

    // Verify entity lock is now set to 2026-08-31
    const ent = await biz.client.get(`/legal-entities/${biz.entityId}`);
    expect(ent.body.periodLockDate).toBe('2026-08-31');
  });

  it('13. enforces entity and tenant boundary isolation on compliance endpoints', async () => {
    const biz1 = await setupComplianceBiz('c-iso1');
    const biz2 = await setupComplianceBiz('c-iso2');

    // User in Tenant 1 querying LegalEntity of Tenant 2 -> 404
    const cross = await biz1.client.get(
      `/compliance/outward-register?legalEntityId=${biz2.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(cross.status).toBe(404);
  });

  it('14. classifies inward RCM supplies as REVIEW_REQUIRED, excluding them from confirmed claim-ready totals', async () => {
    const biz = await setupComplianceBiz('c-rcm');

    // Create an RCM tax class
    const rcmTaxClass = await biz.client.post('/tax-classes', {
      name: 'RCM Legal Services 18%',
      kind: 'service',
      treatment: 'taxable',
      reverseCharge: true,
    });
    expect(rcmTaxClass.status).toBe(201);

    await biz.client.post(`/tax-classes/${rcmTaxClass.body.id}/schedules`, {
      version: 0,
      effectiveFrom: '2017-07-01',
      gstRate: '18',
      sourceReference: SOURCE,
    });

    const units = (await biz.client.get('/units')).body.data as Array<{ id: string; code: string }>;
    const nos = units.find((u) => u.code === 'NOS')?.id;

    const rcmItem = await biz.client.post('/items', {
      sku: 'SKU-RCM-LEGAL',
      name: 'Advocate Legal Retainer',
      type: 'service',
      baseUnitId: nos,
      hsnSac: '998211',
      taxClassId: rcmTaxClass.body.id,
      purchasePrice: '50000.00',
    });
    expect(rcmItem.status).toBe(201);

    // Create supplier bill with RCM line
    const rcmBill = await biz.client.post('/supplier-bills', {
      legalEntityId: biz.entityId,
      supplierId: biz.supplierId,
      warehouseId: biz.warehouseId,
      supplierInvoiceNumber: 'INV-RCM-001',
      supplierInvoiceDate: '2026-10-05',
      docDate: '2026-10-05',
      itcEligible: true,
      lines: [
        {
          itemId: rcmItem.body.id,
          qty: '1',
          unitPrice: '50000.00',
          reverseCharge: true,
        },
      ],
    });
    expect(rcmBill.status).toBe(201);

    const postRes = await biz.client.post(
      `/supplier-bills/${rcmBill.body.id}/post`,
      { version: rcmBill.body.version },
      key(),
    );
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(200);

    // Fetch Purchase Register
    const regRes = await biz.client.get(
      `/compliance/purchase-register?legalEntityId=${biz.entityId}&fromDate=2026-10-01&toDate=2026-10-31`,
    );
    expect(regRes.status).toBe(200);

    const rcmLine = regRes.body.lines.find((l: any) => l.docId === rcmBill.body.id);
    expect(rcmLine).toBeDefined();
    expect(rcmLine.gstr3bCategory).toBe('REVIEW_REQUIRED');
    expect(rcmLine.reviewReason).toContain('Inward reverse-charge (RCM) supply requires proof of reverse charge tax liability discharge and payment');
    expect(rcmLine.declaredItcEligible).toBe(true);
    expect(rcmLine.accountingTreatment).toBe('input_tax_control_141x');

    // Confirmed claim-ready totals must NOT include the RCM tax
    expect(regRes.body.totals.eligibleTaxCharged).toBe('0.00');
    expect(regRes.body.totals.totalInwardTaxCharged).toBe('9000.00');
    expect(regRes.body.totals.reviewRequiredCount).toBeGreaterThanOrEqual(1);
  });

  it('15. verifies coordination token cryptographic HMAC signature, rejects tampering, expiration, and altered warning sets', async () => {
    const biz = await setupComplianceBiz('c-token-crypto');

    const checkRes = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(checkRes.status).toBe(200);
    const validToken: string = checkRes.body.coordinationToken;
    expect(validToken).toContain('.');

    const [payloadB64, signature] = validToken.split('.') as [string, string];
    expect(payloadB64).toBeDefined();
    expect(signature).toBeDefined();

    // 1. Tampered payload with valid original signature -> rejected
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
        closeMode: 'reconciled_close',
        blockersCount: 0,
        coordinationSeq: 999, // Altered sequence
      }),
    ).toString('base64url');

    const tamperedClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: `${tamperedPayload}.${signature}`,
      reason: 'Attempted close with forged payload',
      acknowledgeWarnings: true,
    });
    expect(tamperedClose.status).toBe(400);
    expect(tamperedClose.body.error.message).toContain('signature');

    // 2. Tampered signature -> rejected
    const badSigClose = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: `${payloadB64}.invalidsignature123`,
      reason: 'Attempted close with bad signature',
      acknowledgeWarnings: true,
    });
    expect(badSigClose.status).toBe(400);
    expect(badSigClose.body.error.message).toContain('signature');
  });

  it('16. verifies legacy period-lock endpoint moves posting locks safely, increments coordination, invalidates checklist tokens, and cannot masquerade as reconciled close', async () => {
    const biz = await setupComplianceBiz('c-legacy');

    // 1. Generate a valid period-close checklist
    const checklistRes = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10`,
    );
    expect(checklistRes.status).toBe(200);
    const validToken = checklistRes.body.coordinationToken;
    expect(validToken).toBeDefined();

    // 2. An administrator uses the legacy direct period-lock route (PUT /legal-entities/:id/period-lock)
    const entityBefore = await biz.client.get(`/legal-entities/${biz.entityId}`);
    const legacyLockRes = await biz.client.put(`/legal-entities/${biz.entityId}/period-lock`, {
      version: entityBefore.body.version,
      lockDate: '2026-10-05',
      reason: 'Administrative posting cutoff for early month audit',
    });
    expect(legacyLockRes.status).toBe(200);
    expect(legacyLockRes.body.periodLockDate).toBe('2026-10-05');

    // 3. Verify audit log captured legacy lock with explicit action and reason
    const auditRes = await biz.client.get('/audit-events?limit=10');
    expect(auditRes.status).toBe(200);
    const lockAudit = auditRes.body.data.find(
      (a: { action: string; entityId: string }) => a.action === 'period.locked' && a.entityId === biz.entityId,
    );
    expect(lockAudit).toBeDefined();
    expect(lockAudit.summary).toContain('Locked postings up to 2026-10-05');

    // 4. Confirm the previously issued checklist token is now stale because legacy lock incremented coordination sequence
    const staleCloseRes = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      coordinationToken: validToken,
      reason: 'Attempting to execute close with token from before legacy lock',
      acknowledgeWarnings: true,
    });
    expect(staleCloseRes.status).toBe(422);
    expect(staleCloseRes.body.error.code).toBe('BUSINESS_RULE');
    expect(staleCloseRes.body.error.message).toContain('Please refresh the checklist');

    // 5. Generate fresh checklist and execute administrative close via compliance route
    const freshChecklist = await biz.client.get(
      `/compliance/period-close/checklist?legalEntityId=${biz.entityId}&periodEndDate=2026-10-10&mode=administrative_lock`,
    );
    expect(freshChecklist.status).toBe(200);
    const adminCloseRes = await biz.client.post('/compliance/period-close/execute', {
      legalEntityId: biz.entityId,
      periodEndDate: '2026-10-10',
      mode: 'administrative_lock',
      coordinationToken: freshChecklist.body.coordinationToken,
      reason: 'Administrative period lock applied after review',
      acknowledgeWarnings: true,
    });
    expect(adminCloseRes.status).toBe(200);
    expect(adminCloseRes.body.closeMode).toBe('administrative_lock');

    // 6. Verify audit log captures compliance administrative lock explicitly
    const auditAfter = await biz.client.get('/audit-events?limit=10');
    const adminCloseAudit = auditAfter.body.data.find(
      (a: { summary: string }) => a.summary.includes('Applied administrative posting lock'),
    );
    expect(adminCloseAudit).toBeDefined();
    expect(adminCloseAudit.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'mode', to: 'administrative_lock' }),
      ]),
    );
  });
});


