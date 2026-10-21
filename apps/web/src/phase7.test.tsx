import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_PERMISSIONS, type SalesDocument } from '@bizmgmt/contracts';
import { TestApp } from './App';
import { apiState } from './lib/api';
import { error, mockApi, tenantContext } from './test-api';

/** Phase 7 screens: order to cash. Synthetic fixtures only. */
const ID = (c: string) => c.repeat(24);
const SLOW = { timeout: 5000 };
const address = { line1: '1 Sample Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
const actor = { id: ID('b'), name: 'Asha Verma' };
const entity = {
  id: ID('e'),
  legalName: 'Demo Traders Private Limited (sample)',
  tradeName: '',
  pan: 'ZZZCD0001Z',
  constitution: 'private_limited',
  address,
  email: '',
  phone: '',
  fyStartMonth: 4,
  turnoverBand: 'up_to_5cr',
  workflow: { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true },
  periodLockDate: null,
  bankAccounts: [],
  logo: null,
  registrationCount: 1,
  archived: false,
  version: 4,
};
const registration = { id: ID('1'), legalEntityId: ID('e'), gstin: '27ZZZCD0001Z1Z5', stateCode: '27', registrationType: 'regular', effectiveFrom: '2017-07-01', effectiveTo: null, address, label: '', version: 0 };
const party = { id: ID('7'), name: 'Test Buyers (sample)', legalName: '', isCustomer: true, isSupplier: false, addresses: [{ ...address, id: 'a1', label: 'Office', isBilling: true, isShipping: true }], pan: '', gstins: [], contacts: [], creditLimit: null, paymentTermsDays: 30, tags: [], archived: false, version: 1 };
const item = { id: ID('9'), sku: 'FIT', name: 'Fitting service (sample)', description: '', type: 'service', categoryId: null, categoryName: null, baseUnitId: ID('6'), baseUnitCode: 'NOS', altUnits: [], hsnSac: '998713', taxClassId: ID('8'), taxClassName: 'Services', salePrice: '100.00', reorderLevel: null, archived: false, version: 0 };
const totals = { gross: '100.00', discount: '0.00', taxable: '100.00', cgst: '9.00', sgst: '9.00', utgst: '0.00', igst: '0.00', cess: '0.00', taxCharged: '18.00', reverseChargeTax: '0.00', subtotal: '118.00', roundOff: '0.00', grand: '118.00' };
const amounts = { gross: '100.00', discountAmount: '0.00', net: '100.00', documentDiscount: '0.00', taxable: '100.00', cgst: '9.00', sgst: '9.00', utgst: '0.00', igst: '0.00', cess: '0.00', taxCharged: '18.00', total: '118.00' };

function doc(over: Partial<SalesDocument> = {}): SalesDocument {
  return {
    id: ID('d'),
    docType: 'sales_invoice',
    documentKind: 'tax_invoice',
    number: null,
    status: 'draft',
    legalEntityId: ID('e'),
    gstRegistrationId: ID('1'),
    seriesId: null,
    docDate: '2026-10-20',
    partyId: ID('7'),
    partyName: 'Test Buyers (sample)',
    billingAddressId: 'a1',
    shippingAddressId: 'a1',
    seller: { legalEntityId: ID('e'), legalName: entity.legalName, tradeName: '', pan: entity.pan, gstin: registration.gstin, stateCode: '27', registrationType: 'regular', address },
    buyer: { partyId: ID('7'), name: 'Test Buyers (sample)', legalName: '', gstin: '27ZZZPB1234Z1Z0', stateCode: '27', billingAddress: address, shippingAddress: address },
    placeOfSupply: '27',
    placeOfSupplyOverridden: false,
    supply: 'intra',
    warehouseId: null,
    warehouseName: null,
    customerReference: '',
    notes: '',
    terms: '',
    validUntil: null,
    dueDate: '2026-11-19',
    expectedDate: null,
    transport: null,
    lines: [{ lineId: 'aaaaaaaaaaaa', itemId: ID('9'), sku: 'FIT', itemName: 'Fitting service (sample)', itemType: 'service', hsnSac: '998713', unitCode: 'NOS', uqc: 'OTH', qty: '1', sourceLineId: null, reverseCharge: false, taxRate: '18', cessRate: null, unitPrice: '100.00', discount: null, ...amounts }],
    documentDiscount: '0.00',
    totals,
    hsnSummary: [{ hsnSac: '998713', rate: '18', reverseCharge: false, taxable: '100.00', cgst: '9.00', sgst: '9.00', utgst: '0.00', igst: '0.00', cess: '0.00' }],
    calcVersion: 'calc-1',
    warnings: [],
    source: null,
    related: [],
    revision: 0,
    revisionOf: null,
    outstanding: null,
    paymentStatus: null,
    einvoiceStatus: null,
    pdf: null,
    createdBy: actor,
    createdAt: '2026-10-20T06:00:00.000Z',
    issuedBy: null,
    issuedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    version: 2,
    ...over,
  };
}
const issued = (over: Partial<SalesDocument> = {}) => doc({ status: 'issued', number: 'INV/26-27/0001', issuedBy: actor, issuedAt: '2026-10-20T06:05:00.000Z', outstanding: '118.00', paymentStatus: 'unpaid', einvoiceStatus: 'not_applicable', version: 3, ...over });

/** Master data the editor loads. */
const editorApi = {
  'GET /legal-entities': () => Response.json({ data: [entity] }),
  [`GET /legal-entities/${ID('e')}/registrations`]: () => Response.json({ data: [registration] }),
  'GET /parties': () => Response.json({ data: [party], page: { nextCursor: null, limit: 100 } }),
  [`GET /parties/${ID('7')}`]: () => Response.json(party),
  'GET /items': () => Response.json({ data: [item], page: { nextCursor: null, limit: 100 } }),
  'GET /warehouses': () => Response.json({ data: [] }),
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestApp path={path} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiState.setCsrfToken(null);
  apiState.setTenantId(null);
});

describe('invoices (FR-SAL-05)', () => {
  it('lists invoices with number, customer, total and status', async () => {
    const calls = mockApi({ 'GET /sales-invoices': () => Response.json({ data: [issued(), doc({ id: ID('c') })], page: { nextCursor: null, limit: 25 } }) });
    renderAt('/sales/invoices');
    expect(await screen.findAllByText('INV/26-27/0001', {}, SLOW)).not.toHaveLength(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'issued');
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/sales-invoices' && c.method === 'GET' && calls.indexOf(c) > 0)).toBe(true));
  });

  it('prepares a new invoice with server-computed totals and saves the draft', async () => {
    const calls = mockApi({
      ...editorApi,
      'POST /calc/preview': (c) => Response.json({ calcVersion: 'calc-1', documentKind: 'tax_invoice', supply: 'intra', placeOfSupply: (c.body as { placeOfSupply: string }).placeOfSupply, seller: { legalEntityId: ID('e'), legalName: entity.legalName, tradeName: '', gstin: registration.gstin, stateCode: '27', registrationType: 'regular' }, buyer: null, lines: [{ itemId: ID('9'), item: { sku: 'FIT', name: item.name, type: 'service', hsnSac: '998713', unitCode: 'NOS', uqc: 'OTH' }, qty: '1', unitPrice: '100.00', taxRate: '18', cessRate: null, gross: '100.00', discount: '0.00', net: '100.00', documentDiscount: '0.00', taxable: '100.00', cgst: '9.00', sgst: '9.00', utgst: '0.00', igst: '0.00', cess: '0.00', taxCharged: '18.00', total: '118.00', reverseCharge: false }], totals, hsnSummary: [], warnings: ['Check the HSN code (sample warning)'] }),
      'POST /sales-invoices': () => Response.json(doc(), { status: 201 }),
      [`GET /sales-invoices/${ID('d')}`]: () => Response.json(doc()),
    });
    renderAt('/sales/invoices/new');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /^Customer/ }, SLOW), ID('7'));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /^Item 1/ }), ID('9'));
    // The item's sale price is filled in.
    expect(screen.getByRole('textbox', { name: /^Price 1/ })).toHaveProperty('value', '100.00');
    await userEvent.type(screen.getByRole('textbox', { name: /^Quantity 1/ }), '1');
    expect((await screen.findAllByText('₹118.00', {}, SLOW)).length).toBeGreaterThan(0);
    expect(screen.getByText('Check the HSN code (sample warning)')).toBeTruthy();
    const preview = calls.find((c) => c.path === '/calc/preview');
    // The place of supply comes from the customer's shipping address.
    expect(preview?.body).toMatchObject({ placeOfSupply: '27', partyId: ID('7'), lines: [{ itemId: ID('9'), qty: '1', unitPrice: '100.00', discount: null }] });
    await userEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/sales-invoices')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/sales-invoices')?.body).toMatchObject({ legalEntityId: ID('e'), gstRegistrationId: ID('1'), partyId: ID('7'), placeOfSupply: null, warehouseId: null, dueDate: null, lines: [{ itemId: ID('9'), qty: '1', unitPrice: '100.00', discount: null, sourceLineId: null }] });
    expect(await screen.findByRole('heading', { level: 1, name: 'Tax invoice (draft)' }, SLOW)).toBeTruthy();
  });

  it('issues a draft with an idempotency key and the total the user saw', async () => {
    let current = doc();
    const calls = mockApi({
      ...editorApi,
      [`GET /sales-invoices/${ID('d')}`]: () => Response.json(current),
      'POST /calc/preview': () => error(403, 'FORBIDDEN', 'not in this test'),
      [`POST /sales-invoices/${ID('d')}/issue`]: () => Response.json((current = issued())),
    });
    renderAt(`/sales/invoices/${ID('d')}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }, SLOW));
    expect(await screen.findByRole('heading', { level: 1, name: 'Tax invoice INV/26-27/0001' }, SLOW)).toBeTruthy();
    const issue = calls.find((c) => c.path.endsWith('/issue'));
    expect(issue?.body).toEqual({ version: 2, expectedTotal: '118.00' });
    expect(issue?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByText('Preparing the PDF…')).toBeTruthy();
  });

  it('offers to approve going over the credit limit to someone with credit.override (FR-SAL-08)', async () => {
    let attempts = 0;
    let current = doc();
    const calls = mockApi({
      ...editorApi,
      [`GET /sales-invoices/${ID('d')}`]: () => Response.json(current),
      'POST /calc/preview': () => error(403, 'FORBIDDEN', 'not in this test'),
      [`POST /sales-invoices/${ID('d')}/issue`]: () => {
        attempts += 1;
        return attempts === 1 ? error(422, 'BUSINESS_RULE', 'This takes Test Buyers (sample) to ₹218.00 owed, over their credit limit of ₹200.00.', [{ path: 'creditLimit', message: 'Over the credit limit' }]) : Response.json((current = issued()));
      },
    });
    renderAt(`/sales/invoices/${ID('d')}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }, SLOW));
    expect(await screen.findByText(/over their credit limit/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve over the credit limit and issue invoice' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Tax invoice INV/26-27/0001' }, SLOW)).toBeTruthy();
    expect(calls.filter((c) => c.path.endsWith('/issue')).at(-1)?.body).toEqual({ version: 2, expectedTotal: '118.00', overrideCreditLimit: true });
  });

  it('shows an issued invoice read-only, says it is not on the IRP, and cancels only with a reason', async () => {
    const pdf = { status: 'ready' as const, templateVersion: 'sales-invoice-1', sizeBytes: 24000, createdAt: '2026-10-20T06:05:02.000Z' };
    let current = issued({ einvoiceStatus: 'not_submitted', pdf });
    const calls = mockApi({
      'GET /legal-entities': () => Response.json({ data: [entity] }),
      [`GET /sales-invoices/${ID('d')}`]: () => Response.json(current),
      [`POST /sales-invoices/${ID('d')}/cancel`]: () => Response.json((current = issued({ status: 'cancelled', pdf, cancelledAt: '2026-10-20T07:00:00.000Z', cancelledBy: actor, cancelReason: 'Raised in error', outstanding: '0.00', version: 4 }))),
    });
    renderAt(`/sales/invoices/${ID('d')}`);
    expect(await screen.findByText('Not submitted to IRP', {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download tax invoice (PDF)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel invoice' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Cancel invoice' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Raised in error');
    await userEvent.click(confirm);
    expect(await screen.findByText(/Cancelled .* by Asha Verma: Raised in error/, {}, SLOW)).toBeTruthy();
    const cancel = calls.find((c) => c.path.endsWith('/cancel'));
    expect(cancel?.body).toEqual({ version: 3, reason: 'Raised in error' });
    expect(cancel?.headers.get('Idempotency-Key')).toBeTruthy();
  });
});

describe('orders and dispatches', () => {
  it('a confirmed order offers a dispatch (dispatch stock-out point) and opens it', async () => {
    const order = doc({ id: ID('3'), docType: 'sales_order', documentKind: 'sales_order', status: 'confirmed', number: 'SO/26-27/0001', warehouseId: ID('4'), warehouseName: 'MAIN · Main (sample)', issuedAt: '2026-10-20T06:05:00.000Z', lines: [{ ...doc().lines[0]!, itemType: 'stock', sku: 'BOLT', itemName: 'Bolt (sample)', qty: '6', reservedQty: '6', fulfilledQty: '0', invoicedQty: '0' }] });
    const dispatch = doc({ id: ID('5'), docType: 'dispatch', documentKind: 'delivery_challan', status: 'draft', warehouseId: ID('4'), transport: { vehicleNumber: '', transporterName: '', ewayBillNumber: '' }, source: { type: 'sales_order', id: ID('3'), number: 'SO/26-27/0001', status: 'confirmed' } });
    mockApi({
      ...editorApi,
      'POST /calc/preview': () => error(403, 'FORBIDDEN', 'not in this test'),
      [`GET /sales-orders/${ID('3')}`]: () => Response.json(order),
      [`POST /sales-orders/${ID('3')}/dispatches`]: () => Response.json(dispatch, { status: 201 }),
      [`GET /dispatches/${ID('5')}`]: () => Response.json(dispatch),
    });
    renderAt(`/sales/orders/${ID('3')}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales order SO/26-27/0001' }, SLOW)).toBeTruthy();
    expect(screen.getAllByText('6 NOS').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Create dispatch' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Delivery challan (draft)' }, SLOW)).toBeTruthy();
    expect(screen.getByText(/Made from sales order SO\/26-27\/0001/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dispatch now' })).toBeTruthy();
  });

  it('a storekeeper sees a dispatch without prices and cannot create invoices', async () => {
    mockApi({
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)),
      'GET /legal-entities': () => Response.json({ data: [entity] }),
      [`GET /dispatches/${ID('5')}`]: () => {
        const { totals: _t, hsnSummary: _h, documentDiscount: _d, ...rest } = doc({ id: ID('5'), docType: 'dispatch', documentKind: 'delivery_challan', status: 'dispatched', number: 'DC/26-27/0001', warehouseName: 'MAIN · Main (sample)', transport: { vehicleNumber: 'MH01AB1234', transporterName: '', ewayBillNumber: '' } });
        return Response.json({ ...rest, lines: rest.lines.map(({ unitPrice: _u, discount: _x, gross: _g, discountAmount: _a, net: _n, documentDiscount: _dd, taxable: _tx, cgst: _c, sgst: _s, utgst: _ut, igst: _i, cess: _ce, taxCharged: _tc, total: _to, ...l }) => ({ ...l, invoicedQty: '0' })) });
      },
    });
    renderAt(`/sales/dispatches/${ID('5')}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Delivery challan DC/26-27/0001' }, SLOW)).toBeTruthy();
    expect(screen.getByText('MH01AB1234')).toBeTruthy();
    expect(screen.getByText('Not generated by this system')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Price' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel dispatch' })).toBeTruthy();
  });
});

describe('receivables (FR-SAL-09)', () => {
  it('shows outstanding by ageing bucket, customer and invoice', async () => {
    mockApi({
      'GET /legal-entities': () => Response.json({ data: [entity] }),
      'GET /receivables': () =>
        Response.json({
          legalEntityId: ID('e'),
          asOf: '2026-12-30',
          total: '130.00',
          overdue: '130.00',
          buckets: { not_due: '0.00', d1_30: '118.00', d31_60: '12.00', d61_90: '0.00', over_90: '0.00' },
          invoices: [{ invoiceId: ID('d'), number: 'INV/26-27/0001', docDate: '2026-10-20', dueDate: '2026-11-19', partyId: ID('7'), partyName: 'Test Buyers (sample)', grand: '118.00', outstanding: '118.00', daysOverdue: 41, bucket: 'd31_60' }],
          parties: [{ partyId: ID('7'), partyName: 'Test Buyers (sample)', invoices: 1, outstanding: '118.00', overdue: '118.00' }],
          truncated: false,
        }),
    });
    renderAt('/reports/ageing');
    expect(await screen.findByText('31–60 days overdue', {}, SLOW)).toBeTruthy();
    expect(screen.getAllByText('₹130.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('41 days overdue').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'INV/26-27/0001' })[0]?.getAttribute('href')).toBe(`/sales/invoices/${ID('d')}`);
  });

  it('is not offered to someone without sales or financial reports', async () => {
    mockApi({ 'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)), 'GET /legal-entities': () => Response.json({ data: [entity] }) });
    renderAt('/reports/ageing');
    expect(await screen.findByText(/report\.sales|View sales and outstanding reports/, {}, SLOW)).toBeTruthy();
  });
});
