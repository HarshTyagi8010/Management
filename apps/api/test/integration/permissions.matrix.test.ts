import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLE_NAMES, SYSTEM_ROLE_PERMISSIONS, type Permission, type SystemRoleKey } from '@bizmgmt/contracts';
import { addMember, createHarness, fakeUser, setupEntity, signUp, type Client, type Harness } from './harness.js';

/**
 * AC-RBAC-1: every implemented endpoint × every system role. A role without the
 * permission gets 403 regardless of anything the UI does; a role with it does not.
 * Endpoints of later modules join this table when they are built.
 */
interface Probe {
  name: string;
  /** Any one of these permissions grants access. */
  permissions: Permission[];
  call: (client: Client, fixtures: Fixtures) => ReturnType<Client['get']>;
}

interface Fixtures {
  auditorRoleId: string;
  entityId: string;
  taxClassId: string;
  partyId: string;
  warehouseId: string;
  /** A member who is not one of the probing clients (revoking their sessions must not sign out a prober). */
  targetMemberId: string;
}

const PROBES: Probe[] = [
  { name: 'GET /members', permissions: ['users.manage'], call: (c) => c.get('/members') },
  { name: 'GET /invitations', permissions: ['users.manage'], call: (c) => c.get('/invitations') },
  { name: 'POST /invitations', permissions: ['users.manage'], call: (c, f) => c.post('/invitations', { email: fakeUser('probe').email, roleIds: [f.auditorRoleId] }) },
  { name: 'PATCH /members/:id', permissions: ['users.manage'], call: (c, f) => c.patch(`/members/${f.targetMemberId}`, { version: 999 }) },
  { name: 'POST /members/:id/revoke-sessions', permissions: ['users.manage'], call: (c, f) => c.post(`/members/${f.targetMemberId}/revoke-sessions`) },
  { name: 'GET /roles', permissions: ['roles.manage', 'users.manage'], call: (c) => c.get('/roles') },
  { name: 'POST /roles', permissions: ['roles.manage'], call: (c) => c.post('/roles', { name: `Probe ${Math.random()}`, permissions: [] }) },
  { name: 'PATCH /roles/:id', permissions: ['roles.manage'], call: (c, f) => c.patch(`/roles/${f.auditorRoleId}`, { version: 0 }) },
  { name: 'DELETE /roles/:id', permissions: ['roles.manage'], call: (c, f) => c.delete(`/roles/${f.auditorRoleId}`) },
  { name: 'PATCH /tenant', permissions: ['tenant.manage'], call: (c) => c.patch('/tenant', { name: 'Matrix Traders (test)' }) },
  { name: 'GET /audit-events', permissions: ['audit.view'], call: (c) => c.get('/audit-events') },
  // Phase 4. Bodies are empty: permitted roles get a validation error (no side effects), others 403.
  { name: 'POST /legal-entities', permissions: ['settings.company'], call: (c) => c.post('/legal-entities', {}) },
  { name: 'PATCH /legal-entities/:id', permissions: ['settings.company'], call: (c, f) => c.patch(`/legal-entities/${f.entityId}`, {}) },
  { name: 'PUT /legal-entities/:id/workflow', permissions: ['settings.workflow'], call: (c, f) => c.put(`/legal-entities/${f.entityId}/workflow`, {}) },
  { name: 'PUT /legal-entities/:id/bank-accounts', permissions: ['settings.company'], call: (c, f) => c.put(`/legal-entities/${f.entityId}/bank-accounts`, {}) },
  { name: 'POST /legal-entities/:id/registrations', permissions: ['settings.company'], call: (c, f) => c.post(`/legal-entities/${f.entityId}/registrations`, {}) },
  { name: 'GET /document-series', permissions: ['settings.view', 'settings.company'], call: (c, f) => c.get(`/document-series?legalEntityId=${f.entityId}`) },
  { name: 'POST /document-series', permissions: ['settings.company'], call: (c) => c.post('/document-series', {}) },
  { name: 'GET /items', permissions: ['item.view'], call: (c) => c.get('/items') },
  { name: 'POST /items', permissions: ['item.edit'], call: (c) => c.post('/items', {}) },
  { name: 'GET /units', permissions: ['item.view'], call: (c) => c.get('/units') },
  { name: 'POST /units', permissions: ['item.edit'], call: (c) => c.post('/units', {}) },
  { name: 'POST /categories', permissions: ['item.edit'], call: (c) => c.post('/categories', {}) },
  // Reading tax classes is also allowed to item.edit (to pick a class): see permission-matrix.md.
  { name: 'GET /tax-classes', permissions: ['tax.view', 'tax.manage', 'item.edit'], call: (c) => c.get('/tax-classes') },
  { name: 'POST /tax-classes', permissions: ['tax.manage'], call: (c) => c.post('/tax-classes', {}) },
  { name: 'POST /tax-classes/:id/schedules', permissions: ['tax.manage'], call: (c, f) => c.post(`/tax-classes/${f.taxClassId}/schedules`, {}) },
  { name: 'GET /parties', permissions: ['party.view', 'party.view_basic'], call: (c) => c.get('/parties') },
  { name: 'POST /parties', permissions: ['party.edit'], call: (c) => c.post('/parties', {}) },
  { name: 'GET /parties/:id/timeline', permissions: ['party.view'], call: (c, f) => c.get(`/parties/${f.partyId}/timeline`) },
  { name: 'POST /parties/:id/notes', permissions: ['crm.tasks'], call: (c, f) => c.post(`/parties/${f.partyId}/notes`, {}) },
  { name: 'GET /crm-tasks', permissions: ['crm.tasks'], call: (c) => c.get('/crm-tasks') },
  // Phase 5. Route guards are checked here; warehouse scope is covered in inventory.test.ts.
  { name: 'GET /warehouses', permissions: ['stock.view', 'stock.move', 'stock.adjust', 'stock.count.post', 'settings.view', 'settings.company'], call: (c) => c.get('/warehouses') },
  { name: 'POST /warehouses', permissions: ['settings.company'], call: (c) => c.post('/warehouses', {}) },
  { name: 'PATCH /warehouses/:id', permissions: ['settings.company'], call: (c, f) => c.patch(`/warehouses/${f.warehouseId}`, {}) },
  { name: 'GET /stock/summary', permissions: ['stock.view'], call: (c, f) => c.get(`/stock/summary?legalEntityId=${f.entityId}`) },
  // Valuation is also refused without cost access (FR-RBAC-04); every system role holds stock.view.
  { name: 'GET /stock/valuation', permissions: ['price.view_cost'], call: (c, f) => c.get(`/stock/valuation?legalEntityId=${f.entityId}`) },
  { name: 'GET /stock/movements', permissions: ['stock.view'], call: (c, f) => c.get(`/stock/movements?legalEntityId=${f.entityId}`) },
  { name: 'GET /stock/reconciliation', permissions: ['stock.adjust', 'report.financial'], call: (c) => c.get('/stock/reconciliation') },
  { name: 'GET /stock-adjustments', permissions: ['stock.view'], call: (c) => c.get('/stock-adjustments') },
  { name: 'POST /stock-adjustments', permissions: ['stock.adjust'], call: (c) => c.post('/stock-adjustments', {}) },
  { name: 'POST /stock-adjustments/:id/post', permissions: ['stock.adjust'], call: (c) => c.post(`/stock-adjustments/${UNKNOWN_ID}/post`, { version: 0 }) },
  { name: 'GET /stock-transfers', permissions: ['stock.view'], call: (c) => c.get('/stock-transfers') },
  { name: 'POST /stock-transfers', permissions: ['stock.move'], call: (c) => c.post('/stock-transfers', {}) },
  { name: 'POST /stock-transfers/:id/dispatch', permissions: ['stock.move'], call: (c) => c.post(`/stock-transfers/${UNKNOWN_ID}/dispatch`, { version: 0 }) },
  { name: 'POST /stock-transfers/:id/receive', permissions: ['stock.move'], call: (c) => c.post(`/stock-transfers/${UNKNOWN_ID}/receive`, { version: 0 }) },
  { name: 'GET /stock-counts', permissions: ['stock.view'], call: (c) => c.get('/stock-counts') },
  { name: 'POST /stock-counts', permissions: ['stock.move', 'stock.count.post'], call: (c) => c.post('/stock-counts', {}) },
  { name: 'PATCH /stock-counts/:id', permissions: ['stock.move', 'stock.count.post'], call: (c) => c.patch(`/stock-counts/${UNKNOWN_ID}`, { version: 0 }) },
  { name: 'POST /stock-counts/:id/post', permissions: ['stock.count.post'], call: (c) => c.post(`/stock-counts/${UNKNOWN_ID}/post`, { version: 0 }) },
  // Phase 6
  { name: 'GET /stock-transfers/:id/pdf', permissions: ['document.download'], call: (c) => c.get(`/stock-transfers/${UNKNOWN_ID}/pdf`) },
  { name: 'POST /calc/preview', permissions: ['invoice.edit', 'quotation.edit', 'salesorder.edit', 'purchase.edit'], call: (c) => c.post('/calc/preview', {}) },
  { name: 'GET /accounts', permissions: ['report.financial'], call: (c, f) => c.get(`/accounts?legalEntityId=${f.entityId}`) },
  { name: 'GET /journals', permissions: ['report.financial'], call: (c, f) => c.get(`/journals?legalEntityId=${f.entityId}`) },
  { name: 'GET /reports/trial-balance', permissions: ['report.financial'], call: (c, f) => c.get(`/reports/trial-balance?legalEntityId=${f.entityId}`) },
  { name: 'GET /integrity-checks', permissions: ['stock.adjust', 'report.financial'], call: (c) => c.get('/integrity-checks') },
  { name: 'PUT /legal-entities/:id/period-lock', permissions: ['period.lock', 'period.unlock'], call: (c, f) => c.put(`/legal-entities/${f.entityId}/period-lock`, {}) },
  // Phase 7. Commands without an Idempotency-Key get 400 when permitted; entity and warehouse scope are covered in sales.test.ts.
  { name: 'PUT /legal-entities/:id/logo', permissions: ['settings.company'], call: (c, f) => c.put(`/legal-entities/${f.entityId}/logo`, {}) },
  { name: 'GET /quotations', permissions: ['quotation.edit', 'quotation.issue', 'report.sales', 'report.financial'], call: (c) => c.get('/quotations') },
  { name: 'POST /quotations', permissions: ['quotation.edit'], call: (c) => c.post('/quotations', {}) },
  { name: 'POST /quotations/:id/send', permissions: ['quotation.issue'], call: (c) => c.post(`/quotations/${UNKNOWN_ID}/send`, { version: 0 }) },
  { name: 'POST /quotations/:id/convert', permissions: ['quotation.edit'], call: (c) => c.post(`/quotations/${UNKNOWN_ID}/convert`, { version: 0, to: 'sales_order' }) },
  { name: 'GET /sales-orders', permissions: ['salesorder.edit', 'salesorder.confirm', 'salesorder.cancel', 'dispatch.post', 'invoice.edit', 'report.sales', 'report.financial'], call: (c) => c.get('/sales-orders') },
  { name: 'POST /sales-orders', permissions: ['salesorder.edit'], call: (c) => c.post('/sales-orders', {}) },
  { name: 'POST /sales-orders/:id/confirm', permissions: ['salesorder.confirm'], call: (c) => c.post(`/sales-orders/${UNKNOWN_ID}/confirm`, { version: 0 }) },
  { name: 'POST /sales-orders/:id/cancel', permissions: ['salesorder.cancel'], call: (c) => c.post(`/sales-orders/${UNKNOWN_ID}/cancel`, { version: 0, reason: 'Matrix probe' }) },
  { name: 'POST /sales-orders/:id/dispatches', permissions: ['dispatch.post'], call: (c) => c.post(`/sales-orders/${UNKNOWN_ID}/dispatches`) },
  { name: 'POST /sales-orders/:id/invoices', permissions: ['invoice.edit'], call: (c) => c.post(`/sales-orders/${UNKNOWN_ID}/invoices`) },
  { name: 'GET /dispatches', permissions: ['dispatch.post', 'salesorder.edit', 'invoice.edit', 'report.sales', 'report.financial'], call: (c) => c.get('/dispatches') },
  { name: 'POST /dispatches', permissions: ['dispatch.post'], call: (c) => c.post('/dispatches', {}) },
  { name: 'POST /dispatches/:id/dispatch', permissions: ['dispatch.post'], call: (c) => c.post(`/dispatches/${UNKNOWN_ID}/dispatch`, { version: 0 }) },
  { name: 'GET /dispatches/:id/pdf', permissions: ['document.download'], call: (c) => c.get(`/dispatches/${UNKNOWN_ID}/pdf`) },
  { name: 'GET /sales-invoices', permissions: ['invoice.edit', 'invoice.issue', 'invoice.cancel', 'report.sales', 'report.financial'], call: (c) => c.get('/sales-invoices') },
  { name: 'POST /sales-invoices', permissions: ['invoice.edit'], call: (c) => c.post('/sales-invoices', {}) },
  { name: 'POST /sales-invoices/:id/issue', permissions: ['invoice.issue'], call: (c) => c.post(`/sales-invoices/${UNKNOWN_ID}/issue`, { version: 0 }) },
  { name: 'POST /sales-invoices/:id/cancel', permissions: ['invoice.cancel'], call: (c) => c.post(`/sales-invoices/${UNKNOWN_ID}/cancel`, { version: 0, reason: 'Matrix probe' }) },
  { name: 'GET /sales-invoices/:id/pdf', permissions: ['document.download'], call: (c) => c.get(`/sales-invoices/${UNKNOWN_ID}/pdf`) },
  { name: 'GET /receivables', permissions: ['report.sales', 'report.financial'], call: (c, f) => c.get(`/receivables?legalEntityId=${f.entityId}`) },

  // Phase 8: Purchases & Payables
  { name: 'GET /purchase-orders', permissions: ['purchase.edit', 'purchase.issue'], call: (c) => c.get('/purchase-orders') },
  { name: 'POST /purchase-orders', permissions: ['purchase.edit'], call: (c) => c.post('/purchase-orders', {}) },
  { name: 'POST /purchase-orders/:id/issue', permissions: ['purchase.issue'], call: (c) => c.post(`/purchase-orders/${UNKNOWN_ID}/issue`, {}) },
  { name: 'POST /purchase-orders/:id/cancel', permissions: ['purchase.issue'], call: (c) => c.post(`/purchase-orders/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /purchase-orders/:id/pdf', permissions: ['document.download', 'purchase.edit', 'purchase.issue'], call: (c) => c.get(`/purchase-orders/${UNKNOWN_ID}/pdf`) },
  { name: 'GET /goods-receipts', permissions: ['receipt.post', 'purchase.edit', 'stock.view'], call: (c) => c.get('/goods-receipts') },
  { name: 'POST /goods-receipts', permissions: ['receipt.post', 'stock.move', 'purchase.edit'], call: (c) => c.post('/goods-receipts', {}) },
  { name: 'POST /goods-receipts/:id/receive', permissions: ['receipt.post'], call: (c) => c.post(`/goods-receipts/${UNKNOWN_ID}/receive`, {}) },
  { name: 'POST /goods-receipts/:id/cancel', permissions: ['receipt.post'], call: (c) => c.post(`/goods-receipts/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /supplier-bills', permissions: ['bill.post', 'bill.cancel', 'report.financial', 'purchase.edit'], call: (c) => c.get('/supplier-bills') },
  { name: 'POST /supplier-bills', permissions: ['bill.post', 'purchase.edit'], call: (c) => c.post('/supplier-bills', {}) },
  { name: 'POST /supplier-bills/:id/post', permissions: ['bill.post'], call: (c) => c.post(`/supplier-bills/${UNKNOWN_ID}/post`, {}) },
  { name: 'POST /supplier-bills/:id/cancel', permissions: ['bill.cancel'], call: (c) => c.post(`/supplier-bills/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /payables', permissions: ['report.financial'], call: (c, f) => c.get(`/payables?legalEntityId=${f.entityId}`) },

  // Phase 9: Payments, Notes, Refunds, Expenses, Statements
  { name: 'GET /payments', permissions: ['payment.post', 'receipt.post', 'report.financial'], call: (c) => c.get('/payments') },
  { name: 'POST /payments', permissions: ['payment.post', 'receipt.post'], call: (c) => c.post('/payments', {}) },
  { name: 'POST /payments/:id/post', permissions: ['payment.post', 'receipt.post'], call: (c) => c.post(`/payments/${UNKNOWN_ID}/post`, {}) },
  { name: 'POST /payments/:id/allocate', permissions: ['allocation.manage'], call: (c) => c.post(`/payments/${UNKNOWN_ID}/allocate`, {}) },
  { name: 'POST /payments/:id/fifo-allocate', permissions: ['allocation.manage'], call: (c) => c.post(`/payments/${UNKNOWN_ID}/fifo-allocate`, {}) },
  { name: 'POST /payments/:id/reverse', permissions: ['payment.post', 'receipt.post'], call: (c) => c.post(`/payments/${UNKNOWN_ID}/reverse`, { reason: 'Matrix probe' }) },
  { name: 'POST /refunds', permissions: ['payment.post'], call: (c) => c.post('/refunds', {}) },
  { name: 'GET /refunds', permissions: ['payment.post', 'report.financial'], call: (c) => c.get('/refunds') },
  { name: 'GET /expenses', permissions: ['expense.post', 'report.financial'], call: (c) => c.get('/expenses') },
  { name: 'POST /expenses', permissions: ['expense.post'], call: (c) => c.post('/expenses', {}) },
  { name: 'POST /expenses/:id/post', permissions: ['expense.post'], call: (c) => c.post(`/expenses/${UNKNOWN_ID}/post`, {}) },
  { name: 'POST /expenses/:id/cancel', permissions: ['expense.post'], call: (c) => c.post(`/expenses/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /credit-notes', permissions: ['note.issue', 'report.financial'], call: (c) => c.get('/credit-notes') },
  { name: 'POST /credit-notes', permissions: ['note.issue'], call: (c) => c.post('/credit-notes', {}) },
  { name: 'POST /credit-notes/:id/issue', permissions: ['note.issue'], call: (c) => c.post(`/credit-notes/${UNKNOWN_ID}/issue`, {}) },
  { name: 'POST /credit-notes/:id/cancel', permissions: ['note.issue'], call: (c) => c.post(`/credit-notes/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /debit-notes', permissions: ['note.issue', 'report.financial'], call: (c) => c.get('/debit-notes') },
  { name: 'POST /debit-notes', permissions: ['note.issue'], call: (c) => c.post('/debit-notes', {}) },
  { name: 'POST /debit-notes/:id/issue', permissions: ['note.issue'], call: (c) => c.post(`/debit-notes/${UNKNOWN_ID}/issue`, {}) },
  { name: 'POST /debit-notes/:id/cancel', permissions: ['note.issue'], call: (c) => c.post(`/debit-notes/${UNKNOWN_ID}/cancel`, { reason: 'Matrix probe' }) },
  { name: 'GET /parties/:id/statement', permissions: ['report.financial'], call: (c, f) => c.get(`/parties/${f.partyId}/statement?legalEntityId=${f.entityId}&from=2026-01-01&to=2026-01-31`) },
];

/** Permitted roles get 404 for this id (no side effects); others get 403 from the route guard first. */
const UNKNOWN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

let h: Harness;
const clients = new Map<SystemRoleKey, Client>();
let fixtures: Fixtures;

beforeAll(async () => {
  h = await createHarness();
  const owner = await signUp(h, 'matrixowner', 'Matrix Traders (test)');
  clients.set('owner', owner.client);
  for (const key of SYSTEM_ROLE_KEYS.filter((k) => k !== 'owner')) {
    clients.set(key, (await addMember(h, owner.client, SYSTEM_ROLE_NAMES[key], `matrix${key}`)).client);
  }
  const target = await addMember(h, owner.client, 'Sales', 'matrixtarget');
  const roles = (await owner.client.get('/roles')).body.data as Array<{ id: string; name: string }>;
  const members = (await owner.client.get('/members')).body.data as Array<{ id: string; userId: string }>;
  const entity = await setupEntity(owner.client);
  const taxClass = await owner.client.post('/tax-classes', { name: 'Matrix class (test)', kind: 'goods', treatment: 'taxable' });
  const party = await owner.client.post('/parties', { name: 'Matrix customer (test)', isCustomer: true, isSupplier: false });
  const warehouse = await owner.client.post('/warehouses', { legalEntityId: entity.entityId, code: 'MTX', name: 'Matrix godown (test)' });
  fixtures = {
    auditorRoleId: roles.find((r) => r.name === 'Auditor')?.id ?? '',
    entityId: entity.entityId,
    taxClassId: taxClass.body.id,
    partyId: party.body.id,
    warehouseId: warehouse.body.id,
    targetMemberId: members.find((m) => m.userId === target.userId)?.id ?? '',
  };
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('permission matrix over HTTP (AC-RBAC-1)', () => {
  const cases = PROBES.flatMap((probe) => SYSTEM_ROLE_KEYS.map((role) => ({ probe, role, allowed: probe.permissions.some((p) => SYSTEM_ROLE_PERMISSIONS[role].includes(p)) })));

  it.each(cases.map((c) => [`${c.probe.name} as ${c.role} → ${c.allowed ? 'allowed' : '403'}`, c] as const))('%s', async (_label, { probe, role, allowed }) => {
    const client = clients.get(role);
    if (!client) throw new Error(`no client for ${role}`);
    const res = await probe.call(client, fixtures);
    if (allowed) {
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('covers every probe for every role', () => {
    expect(cases).toHaveLength(PROBES.length * SYSTEM_ROLE_KEYS.length);
  });
});
