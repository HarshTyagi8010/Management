import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { SalesDocDoc, SalesLineDoc } from '../models.js';
import { inspectImage } from '../platform/images.js';
import { tinyPng } from '../test-utils.js';
import { renderPdf } from './render.js';
import { inr, salesPrint } from './sales-print.js';
import { salesDocument } from './templates/sales.js';

/**
 * Printed sales documents (FR-DOC-01/05, AC-DOC-1 at the template level):
 * particulars present, copies, repeated headers on long documents, Indian
 * number formatting without Intl, and byte-identical output from one snapshot.
 * Synthetic data only.
 */
const D = (v: string) => Types.Decimal128.fromString(v);
const address = { line1: '1 Test Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };

function line(i: number, overrides: Partial<SalesLineDoc> = {}): SalesLineDoc {
  return {
    lineId: `00000000000${i % 10}`.slice(-12),
    itemId: new Types.ObjectId(),
    qty: D('2'),
    unitPrice: D('50.00'),
    discount: null,
    sourceLineId: null,
    item: { sku: `SKU-${i}`, name: `Synthetic item ${i}`, type: 'stock', hsnSac: '7318', unitCode: 'NOS', uqc: 'NOS', decimals: 0 },
    taxRate: D('18'),
    cessRate: null,
    reverseCharge: false,
    amounts: { gross: D('100.00'), discount: D('0.00'), net: D('100.00'), documentDiscount: D('0.00'), taxable: D('100.00'), cgst: D('9.00'), sgst: D('9.00'), utgst: D('0.00'), igst: D('0.00'), cess: D('0.00'), taxCharged: D('18.00'), total: D('118.00') },
    reservedQty: D('0'),
    fulfilledQty: D('0'),
    invoicedQty: D('0'),
    unitCost: null,
    costValue: null,
    ...overrides,
  };
}

function invoice(lines: number, overrides: Partial<SalesDocDoc> = {}): SalesDocDoc {
  const total = (n: string) => D((Number(n) * lines).toFixed(2));
  return {
    _id: new Types.ObjectId(),
    tenantId: new Types.ObjectId(),
    legalEntityId: new Types.ObjectId(),
    gstRegistrationId: new Types.ObjectId(),
    docType: 'sales_invoice',
    documentKind: 'tax_invoice',
    status: 'issued',
    seriesId: null,
    series: null,
    number: 'INV/26-27/0001',
    docDate: '2026-10-20',
    partyId: new Types.ObjectId(),
    partyName: 'Test Buyers (test)',
    billingAddressId: 'a1',
    shippingAddressId: 'a1',
    placeOfSupply: '27',
    placeOfSupplyOverridden: false,
    supply: 'intra',
    warehouseId: null,
    documentDiscount: D('0'),
    customerReference: 'PO-77',
    notes: 'Synthetic note',
    terms: 'Payment within 30 days',
    validUntil: null,
    dueDate: '2026-11-19',
    expectedDate: null,
    transport: null,
    lines: Array.from({ length: lines }, (_, i) => line(i + 1)),
    totals: { gross: total('100'), discount: D('0.00'), taxable: total('100'), cgst: total('9'), sgst: total('9'), utgst: D('0.00'), igst: D('0.00'), cess: D('0.00'), taxCharged: total('18'), reverseChargeTax: D('0.00'), subtotal: total('118'), roundOff: D('0.00'), grand: total('118') },
    hsnSummary: [{ hsnSac: '7318', rate: D('18'), reverseCharge: false, taxable: total('100'), cgst: total('9'), sgst: total('9'), utgst: D('0.00'), igst: D('0.00'), cess: D('0.00') }],
    calcVersion: 'calc-1',
    warnings: [],
    seller: { legalEntityId: 'x', legalName: 'Example Traders Private Limited (test)', tradeName: 'Example Traders', pan: 'ZZZCE2001Z', gstin: '27ZZZCE2001Z1Z5', stateCode: '27', registrationType: 'regular', address, email: 'accounts@example.test', phone: '' },
    buyer: { partyId: 'y', name: 'Test Buyers (test)', legalName: '', gstin: '27ZZZPB1234Z1Z0', stateCode: '27', billingAddress: address, shippingAddress: address },
    logoFileId: null,
    bankAccount: { id: 'b1', bankName: 'Test Bank', accountName: 'Example Traders', accountNumber: '000123456789', ifsc: 'TEST0000001', branch: '', upiId: '', isDefault: true },
    templateVersion: 'sales-invoice-1',
    source: null,
    revision: 0,
    revisionOf: null,
    outstanding: total('118'),
    paymentStatus: 'unpaid',
    einvoiceStatus: 'not_applicable',
    createdBy: new Types.ObjectId(),
    issuedBy: new Types.ObjectId(),
    issuedAt: new Date('2026-10-20T06:00:00Z'),
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    createdAt: new Date('2026-10-20T05:00:00Z'),
    updatedAt: new Date('2026-10-20T06:00:00Z'),
    ...overrides,
  };
}

const meta = { title: 'Tax invoice', createdAt: new Date('2026-10-20T06:00:00Z') };
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe('Indian amount formatting (no Intl)', () => {
  it.each([
    ['0', '0.00'],
    ['5', '5.00'],
    ['999.5', '999.50'],
    ['1000', '1,000.00'],
    ['123456.78', '1,23,456.78'],
    ['1234567.89', '12,34,567.89'],
    ['100000000', '10,00,00,000.00'],
    ['-1500', '−1,500.00'],
  ])('%s → %s', (value, expected) => {
    expect(inr(value)).toBe(expected);
  });
});

describe('printed tax invoice', () => {
  it('has the Rule 46 particulars and three copies for goods (Rule 48)', () => {
    const p = salesPrint(invoice(2), null, { einvoiceApplicable: false });
    expect(p).toMatchObject({ title: 'Tax invoice', number: 'INV/26-27/0001', docDate: '20-10-2026', placeOfSupply: 'Maharashtra (27)', reverseCharge: 'No', taxColumns: true, stateTaxLabel: 'SGST', grand: '₹236.00' });
    expect(p.seller).toMatchObject({ gstin: '27ZZZCE2001Z1Z5', pan: 'ZZZCE2001Z', state: 'Maharashtra (27)' });
    expect(p.billTo).toMatchObject({ gstin: '27ZZZPB1234Z1Z0', state: 'Maharashtra (27)' });
    expect(p.shipTo).toBeNull();
    expect(p.copies).toEqual(['Original for recipient', 'Duplicate for transporter', 'Triplicate for supplier']);
    expect(p.amountInWords).toBe('Rupees Two Hundred Thirty-Six Only');
    expect(p.facts).toContainEqual(['Due date', '19-11-2026']);
    expect(p.hsnSummary).toEqual([{ hsnSac: '7318', taxable: '200.00', rate: '18%', cgst: '18.00', sgst: '18.00', igst: '0.00', cess: '0.00', tax: '36.00' }]);
    expect(p.footer).not.toMatch(/IRN/);
  });

  it('prints services in duplicate, says when no IRN exists, and keeps 6-decimal prices', () => {
    const doc = invoice(1, { einvoiceStatus: 'not_submitted' });
    doc.lines = [line(1, { unitPrice: D('0.125000'), item: { sku: 'SVC', name: 'Synthetic service', type: 'service', hsnSac: '998713', unitCode: 'NOS', uqc: 'OTH', decimals: 0 } })];
    const p = salesPrint(doc, null, { einvoiceApplicable: true });
    expect(p.copies).toEqual(['Original for recipient', 'Duplicate for supplier']);
    expect(p.footer).toMatch(/Not an e-invoice: no IRN/);
    expect(p.lines[0]?.unitPrice).toBe('0.125');
  });

  it('a bill of supply of a composition taxpayer has no tax columns and says why', () => {
    const doc = invoice(1, { documentKind: 'bill_of_supply' });
    doc.seller.registrationType = 'composition';
    const p = salesPrint(doc, null, { einvoiceApplicable: false });
    expect(p).toMatchObject({ title: 'Bill of supply', taxColumns: false, reverseCharge: null });
    expect(p.declarations).toContain('Composition taxable person, not eligible to collect tax on supplies.');
  });

  it('quotations and challans say they are not tax invoices', () => {
    const q = salesPrint(invoice(1, { docType: 'quotation', documentKind: 'proforma_invoice', validUntil: '2026-11-01', templateVersion: 'quotation-1' }), null, { einvoiceApplicable: false });
    expect(q.title).toBe('Proforma invoice');
    expect(q.copies).toEqual(['Copy for the customer']);
    expect(q.declarations.join(' ')).toMatch(/not a tax invoice/);
    const c = salesPrint(invoice(1, { docType: 'dispatch', documentKind: 'delivery_challan', transport: { vehicleNumber: 'MH01AB1234', transporterName: '', ewayBillNumber: '' }, templateVersion: 'delivery-challan-1' }), null, { einvoiceApplicable: false });
    expect(c.title).toBe('Delivery challan');
    expect(c.copies).toHaveLength(3);
    expect(c.facts).toContainEqual(['E-way bill', 'Not generated by this system']);
    expect(c.bank).toBeNull();
  });

  it('refuses to print an unnumbered document', () => {
    expect(() => salesPrint(invoice(1, { number: null }), null, { einvoiceApplicable: false })).toThrow();
  });

  it('renders deterministically, with a logo, and breaks long invoices into pages', async () => {
    const png = await tinyPng(32, 16);
    expect(inspectImage(png)).toEqual({ contentType: 'image/png', width: 32, height: 16 });
    const logo = { dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    const doc = invoice(1);
    const a = await renderPdf(salesDocument(salesPrint(doc, logo, { einvoiceApplicable: false })), meta);
    const b = await renderPdf(salesDocument(salesPrint(doc, logo, { einvoiceApplicable: false })), meta);
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
    expect(a.toString('latin1')).toMatch(/\/Subtype \/Image/);
    // One page per copy for a short invoice; a long one repeats its table over several pages per copy.
    expect(pageCount(a)).toBe(3);
    const long = await renderPdf(salesDocument(salesPrint(invoice(120), null, { einvoiceApplicable: false })), meta);
    expect(pageCount(long)).toBeGreaterThanOrEqual(9);
  }, 30_000);
});

describe('image inspection (uploads)', () => {
  it('recognises PNG and JPEG by their bytes and refuses everything else', async () => {
    const png = await tinyPng(20, 30);
    expect(inspectImage(png)).toEqual({ contentType: 'image/png', width: 20, height: 30 });
    // A minimal JPEG: SOI, an SOF0 frame header (height 40, width 50), EOI.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x28, 0x00, 0x32, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
    expect(inspectImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 50, height: 40 });
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(inspectImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(inspectImage(Buffer.from('GIF89a'))).toBeNull();
    // A PNG signature in front of something else is not a PNG.
    expect(inspectImage(Buffer.concat([png.subarray(0, 40), Buffer.from('<script>')]))).toBeNull();
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
  });
});
