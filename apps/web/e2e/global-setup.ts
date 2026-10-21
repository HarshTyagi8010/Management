import { randomBytes, randomUUID } from 'node:crypto';
import { gstinCheckCharacter } from '@bizmgmt/contracts';

/**
 * Creates the synthetic owner account the suite signs in with (one sign-up per
 * run keeps well under the per-IP sign-up limit) and a small synthetic business
 * for the Phase 4 screens. Workers inherit the E2E_* environment variables.
 */
const BASE = 'http://127.0.0.1:4173/api/v1';

export default async function globalSetup() {
  const cookies = new Map<string, string>();
  let csrf = '';
  let tenantId = '';
  const keep = (res: Response) => {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const i = pair.indexOf('=');
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        Origin: 'http://127.0.0.1:4173',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
        // Stock commands need one; other routes ignore it.
        ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    keep(res);
    const json = (await res.json().catch(() => ({}))) as T & { csrfToken?: string };
    if (!res.ok) throw new Error(`E2E setup ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
    if (json.csrfToken) csrf = json.csrfToken;
    return json;
  }

  await call('GET', '/auth/session');
  const owner = {
    name: 'Asha Verma (test)',
    email: `e2e.owner.${randomBytes(4).toString('hex')}@example.test`,
    password: `E2e-passphrase-${randomBytes(6).toString('hex')}`,
    businessName: 'Example Traders (test)',
  };
  const session = await call<{ activeTenantId: string }>('POST', '/auth/signup', owner);
  tenantId = session.activeTenantId;

  // Synthetic identifiers (well formed, not issued to anyone).
  const pan = 'ZZZCE2001Z';
  const gstinBody = `27${pan}1Z`;
  const address = { line1: '1 Test Industrial Estate', city: 'Mumbai', stateCode: '27', pincode: '400001' };
  const entity = await call<{ id: string }>('POST', '/legal-entities', { legalName: 'Example Traders Private Limited (test)', pan, constitution: 'private_limited', address, turnoverBand: 'up_to_5cr' });
  const reg = await call<{ id: string }>('POST', `/legal-entities/${entity.id}/registrations`, { gstin: gstinBody + gstinCheckCharacter(gstinBody), registrationType: 'regular', effectiveFrom: '2017-07-01', address });
  await call('POST', '/document-series', { legalEntityId: entity.id, gstRegistrationId: reg.id, docType: 'tax_invoice', name: 'Tax invoices', prefix: 'INV/{FY}/', padding: 4 });
  const units = await call<{ data: Array<{ id: string; code: string }> }>('GET', '/units');
  const taxClass = await call<{ id: string }>('POST', '/tax-classes', { name: 'Test goods (no rate)', kind: 'goods', treatment: 'taxable' });
  const item = await call<{ id: string }>('POST', '/items', { sku: 'E2E-BOLT', name: 'Test hex bolt (e2e)', type: 'stock', baseUnitId: units.data.find((u) => u.code === 'PCS')?.id, hsnSac: '7318', taxClassId: taxClass.id, salePrice: '4.50', purchasePrice: '3.10' });
  const party = await call<{ id: string }>('POST', '/parties', {
    name: 'Test Buyers (e2e)',
    isCustomer: true,
    isSupplier: false,
    addresses: [{ id: 'a1', label: 'Main', isBilling: true, isShipping: true, ...address }],
    contacts: [{ id: 'c1', name: 'Test Contact', phone: '+91 90000 00001' }],
  });
  await call('POST', `/parties/${party.id}/tasks`, { title: 'Call about the test order', dueDate: '2026-10-21' });

  // Phase 5: two warehouses, posted opening stock, a draft transfer and a count in progress.
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const main = await call<{ id: string }>('POST', '/warehouses', { legalEntityId: entity.id, code: 'MAIN', name: 'Main godown (e2e)', gstRegistrationId: reg.id, address });
  const city = await call<{ id: string }>('POST', '/warehouses', { legalEntityId: entity.id, code: 'CITY', name: 'City shop (e2e)' });
  const opening = await call<{ id: string; version: number }>('POST', '/stock-adjustments', { warehouseId: main.id, type: 'opening', docDate: today, lines: [{ itemId: item.id, qty: '50', unitCost: '3.10' }] });
  await call('POST', `/stock-adjustments/${opening.id}/post`, { version: opening.version });
  const transfer = await call<{ id: string }>('POST', '/stock-transfers', { fromWarehouseId: main.id, toWarehouseId: city.id, docDate: today, note: 'Weekly top-up (e2e)', lines: [{ itemId: item.id, qty: '10' }] });
  const count = await call<{ id: string; version: number }>('POST', '/stock-counts', { warehouseId: main.id, scope: 'all' });
  await call('POST', `/stock-counts/${count.id}/start`, { version: count.version });

  // Phase 7: numbering series, a rated item with stock, a sent quotation, and an order that was dispatched and invoiced.
  for (const [docType, name, prefix, scoped] of [
    ['quotation', 'Quotations', 'QT/{FY}/', false],
    ['sales_order', 'Sales orders', 'SO/{FY}/', false],
    ['delivery_challan', 'Delivery challans', 'DC/{FY}/', true],
  ] as const) {
    await call('POST', '/document-series', { legalEntityId: entity.id, gstRegistrationId: scoped ? reg.id : null, docType, name, prefix, padding: 4 });
  }
  const rated = await call<{ id: string }>('POST', '/tax-classes', { name: 'Test hardware 18% (e2e)', kind: 'goods', treatment: 'taxable' });
  await call('POST', `/tax-classes/${rated.id}/schedules`, { version: 0, effectiveFrom: '2017-07-01', gstRate: '18', sourceReference: 'Synthetic test fixture (not a real notification)' });
  const nut = await call<{ id: string }>('POST', '/items', { sku: 'E2E-NUT', name: 'Test hex nut (e2e)', type: 'stock', baseUnitId: units.data.find((u) => u.code === 'PCS')?.id, hsnSac: '7318', taxClassId: rated.id, salePrice: '12.50', purchasePrice: '8.00' });
  const nutOpening = await call<{ id: string; version: number }>('POST', '/stock-adjustments', { warehouseId: main.id, type: 'opening', docDate: today, lines: [{ itemId: nut.id, qty: '40', unitCost: '8.00' }] });
  await call('POST', `/stock-adjustments/${nutOpening.id}/post`, { version: nutOpening.version });
  const sale = { legalEntityId: entity.id, gstRegistrationId: reg.id, partyId: party.id, docDate: today, lines: [{ itemId: nut.id, qty: '3', unitPrice: '12.50' }] };
  const quotation = await call<{ id: string; version: number }>('POST', '/quotations', { ...sale, validUntil: today, terms: 'Prices valid for today (e2e)' });
  await call('POST', `/quotations/${quotation.id}/send`, { version: quotation.version });
  const order = await call<{ id: string; version: number }>('POST', '/sales-orders', { ...sale, warehouseId: main.id });
  await call('POST', `/sales-orders/${order.id}/confirm`, { version: order.version });
  const dispatch = await call<{ id: string; version: number }>('POST', `/sales-orders/${order.id}/dispatches`);
  await call('POST', `/dispatches/${dispatch.id}/dispatch`, { version: dispatch.version });
  const invoice = await call<{ id: string; version: number }>('POST', `/dispatches/${dispatch.id}/invoices`);
  await call('POST', `/sales-invoices/${invoice.id}/issue`, { version: invoice.version });

  process.env.E2E_QUOTATION_ID = quotation.id;
  process.env.E2E_ORDER_ID = order.id;
  process.env.E2E_DISPATCH_ID = dispatch.id;
  process.env.E2E_INVOICE_ID = invoice.id;
  process.env.E2E_OWNER_EMAIL = owner.email;
  process.env.E2E_OWNER_PASSWORD = owner.password;
  process.env.E2E_OWNER_NAME = owner.name;
  process.env.E2E_ENTITY_ID = entity.id;
  process.env.E2E_ITEM_ID = item.id;
  process.env.E2E_PARTY_ID = party.id;
  process.env.E2E_OPENING_ID = opening.id;
  process.env.E2E_TRANSFER_ID = transfer.id;
  process.env.E2E_COUNT_ID = count.id;
}
