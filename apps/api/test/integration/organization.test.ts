import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, address, createHarness, fakeGstin, fakePan, setupEntity, signUp, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('legal entities (FR-CO-01, FR-CO-06)', () => {
  it('creates an entity with default workflow, April financial year and the declared turnover band', async () => {
    const { client } = await signUp(h, 'entity');
    const pan = fakePan();
    const res = await client.post('/legal-entities', { legalName: 'Example Steel LLP (test)', pan: pan.toLowerCase(), constitution: 'llp', address: address(), turnoverBand: 'above_5cr_below_10cr' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      pan,
      fyStartMonth: 4,
      turnoverBand: 'above_5cr_below_10cr',
      workflow: { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true },
      bankAccounts: [],
      registrationCount: 0,
    });
    const dup = await client.post('/legal-entities', { legalName: 'Copy (test)', pan, constitution: 'llp', address: address(), turnoverBand: 'up_to_5cr' });
    expect(dup.body.error.code).toBe('DUPLICATE');
    const bad = await client.post('/legal-entities', { legalName: 'Bad (test)', pan: 'ABCXE1234F', constitution: 'llp', address: address(), turnoverBand: 'up_to_5cr' });
    expect(bad.status).toBe(400);
  });

  it('updates with optimistic concurrency and records changes in the audit log', async () => {
    const { client } = await signUp(h, 'entityedit');
    const e = await setupEntity(client);
    const ok = await client.patch(`/legal-entities/${e.entityId}`, { version: e.version, tradeName: 'Example Steel', turnoverBand: '10cr_or_more' });
    expect(ok.status).toBe(200);
    expect((await client.patch(`/legal-entities/${e.entityId}`, { version: e.version, tradeName: 'Stale' })).body.error.code).toBe('VERSION_CONFLICT');
    // The PAN is part of every GSTIN, so it can't change once registrations exist.
    expect((await client.patch(`/legal-entities/${e.entityId}`, { version: ok.body.version, pan: fakePan() })).body.error.code).toBe('BUSINESS_RULE');
    const audit = await client.get('/audit-events?action=legal_entity.updated');
    expect(audit.body.data[0].changes).toEqual(expect.arrayContaining([{ field: 'turnoverBand', from: 'up_to_5cr', to: '10cr_or_more' }]));
  });

  it('saves workflow settings and bank accounts without putting account numbers in the audit log', async () => {
    const { client } = await signUp(h, 'bank');
    const e = await setupEntity(client);
    const wf = await client.put(`/legal-entities/${e.entityId}/workflow`, { version: e.version, stockOutPoint: 'invoice', stockInPoint: 'supplier_bill', allowNegativeStock: false, roundOffTotal: true });
    expect(wf.body.workflow.stockOutPoint).toBe('invoice');
    const bank = await client.put(`/legal-entities/${e.entityId}/bank-accounts`, {
      version: wf.body.version,
      bankAccounts: [{ bankName: 'Example Bank', accountName: 'Example Steel', accountNumber: '001234567890', ifsc: 'exmp0001234', upiId: 'examplesteel@exmp' }],
    });
    expect(bank.status).toBe(200);
    expect(bank.body.bankAccounts[0]).toMatchObject({ ifsc: 'EXMP0001234', isDefault: true });
    const events = JSON.stringify((await client.get('/audit-events')).body);
    expect(events).not.toContain('001234567890');
    expect((await client.put(`/legal-entities/${e.entityId}/bank-accounts`, { version: bank.body.version, bankAccounts: [{ bankName: 'X', accountName: 'Y', accountNumber: '12', ifsc: 'BAD' }] })).status).toBe(400);
  });
});

describe('GST registrations (FR-CO-02)', () => {
  it('validates the GSTIN, its PAN and state, and uniqueness', async () => {
    const { client } = await signUp(h, 'gstin');
    const e = await setupEntity(client);
    const second = fakeGstin('29', e.pan);
    const ok = await client.post(`/legal-entities/${e.entityId}/registrations`, { gstin: second, registrationType: 'regular', effectiveFrom: '2018-04-01', address: address('29', '560001'), label: 'Bengaluru branch' });
    expect(ok.status).toBe(201);
    expect(ok.body.stateCode).toBe('29');

    const otherPan = await client.post(`/legal-entities/${e.entityId}/registrations`, { gstin: fakeGstin('24', fakePan()), registrationType: 'regular', effectiveFrom: '2018-04-01', address: address('24', '380001') });
    expect(otherPan.body.error.details[0]).toMatchObject({ path: 'gstin' });
    const wrongState = await client.post(`/legal-entities/${e.entityId}/registrations`, { gstin: fakeGstin('24', e.pan), registrationType: 'regular', effectiveFrom: '2018-04-01', address: address('27') });
    expect(wrongState.status).toBe(400);
    const badCheck = `${second.slice(0, 14)}${second.endsWith('A') ? 'B' : 'A'}`;
    expect((await client.post(`/legal-entities/${e.entityId}/registrations`, { gstin: badCheck, registrationType: 'regular', effectiveFrom: '2018-04-01', address: address('29', '560001') })).status).toBe(400);
    const dup = await client.post(`/legal-entities/${e.entityId}/registrations`, { gstin: second, registrationType: 'regular', effectiveFrom: '2018-04-01', address: address('29', '560001') });
    expect(dup.body.error.code).toBe('DUPLICATE');

    const list = await client.get(`/legal-entities/${e.entityId}/registrations`);
    expect(list.body.data.map((r: { gstin: string }) => r.gstin)).toEqual([e.gstin, second]);
    const update = await client.patch(`/gst-registrations/${ok.body.id}`, { version: 0, effectiveTo: '2026-03-31' });
    expect(update.body.effectiveTo).toBe('2026-03-31');
  });
});

describe('document series (FR-CO-03, GST-01)', () => {
  it('previews numbers, enforces 16 characters, prevents overlapping prefixes and keeps one default', async () => {
    const { client } = await signUp(h, 'series');
    const e = await setupEntity(client);
    const base = { legalEntityId: e.entityId, gstRegistrationId: e.registrationId, docType: 'tax_invoice', padding: 4 };
    const first = await client.post('/document-series', { ...base, name: 'Main invoices', prefix: 'INV/{FY}/' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ isDefault: true, locked: false, capacity: 999_999 });
    expect(first.body.example).toMatch(/^INV\/\d{2}-\d{2}\/0001$/);

    expect((await client.post('/document-series', { ...base, name: 'Too long', prefix: 'INVOICE/{FY}/AB' })).status).toBe(400);
    const overlap = await client.post('/document-series', { ...base, name: 'Overlap', prefix: 'INV/{FY}/C' });
    expect(overlap.body.error.message).toMatch(/same numbers/);
    const counter = await client.post('/document-series', { ...base, name: 'Counter sales', prefix: 'CS/{FY}/', isDefault: true });
    expect(counter.status).toBe(201);
    const all = (await client.get(`/document-series?legalEntityId=${e.entityId}`)).body.data as Array<{ name: string; isDefault: boolean }>;
    expect(all.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['Counter sales']);

    // Non-GST documents number per legal entity, not per registration.
    expect((await client.post('/document-series', { legalEntityId: e.entityId, docType: 'quotation', name: 'Quotes', prefix: 'QT-', padding: 5 })).status).toBe(201);
    expect((await client.post('/document-series', { legalEntityId: e.entityId, docType: 'tax_invoice', name: 'No reg', prefix: 'X-', padding: 4 })).status).toBe(400);
  });

  it('locks the format once a number has been issued', async () => {
    const { client, tenantId } = await signUp(h, 'serieslock');
    const e = await setupEntity(client);
    const s = await client.post('/document-series', { legalEntityId: e.entityId, gstRegistrationId: e.registrationId, docType: 'tax_invoice', name: 'Main', prefix: 'A-', padding: 4 });
    const { Types } = await import('mongoose');
    const { withTransaction } = await import('../../src/platform/transactions.js');
    const ids = [new Types.ObjectId(tenantId), new Types.ObjectId(s.body.id)] as const;
    // A prepared counter alone does not lock the series; an issued number does.
    await h.modules.numbering.prepare(...ids, '2026-10-20');
    expect((await client.get(`/document-series?legalEntityId=${e.entityId}`)).body.data[0].locked).toBe(false);
    await withTransaction(h.db.connection, (session) => h.modules.numbering.take(session, ...ids, '2026-10-20'));
    expect((await client.patch(`/document-series/${s.body.id}`, { version: s.body.version, prefix: 'B-' })).body.error.code).toBe('BUSINESS_RULE');
    const rename = await client.patch(`/document-series/${s.body.id}`, { version: s.body.version, name: 'Main invoices' });
    expect(rename.body).toMatchObject({ name: 'Main invoices', locked: true });
  });

  it('refuses tax invoice series on a composition registration', async () => {
    const { client } = await signUp(h, 'composition');
    const pan = fakePan('P');
    const entity = await client.post('/legal-entities', { legalName: 'Example Kirana (test)', pan, constitution: 'proprietorship', address: address(), turnoverBand: 'up_to_5cr' });
    const reg = await client.post(`/legal-entities/${entity.body.id}/registrations`, { gstin: fakeGstin('27', pan), registrationType: 'composition', effectiveFrom: '2019-04-01', address: address() });
    const res = await client.post('/document-series', { legalEntityId: entity.body.id, gstRegistrationId: reg.body.id, docType: 'tax_invoice', name: 'Invoices', prefix: 'TI-', padding: 4 });
    expect(res.body.error.code).toBe('BUSINESS_RULE');
    expect((await client.post('/document-series', { legalEntityId: entity.body.id, gstRegistrationId: reg.body.id, docType: 'bill_of_supply', name: 'Bills', prefix: 'BS-', padding: 4 })).status).toBe(201);
  });
});

describe('access limited to legal entities (FR-RBAC-03)', () => {
  it('limits a member to chosen entities, hides others and blocks wider grants', async () => {
    const owner = await signUp(h, 'scopeowner');
    const mumbai = await setupEntity(owner.client, { legalName: 'Mumbai Unit (test)' });
    const pune = await setupEntity(owner.client, { legalName: 'Pune Unit (test)', pincode: '411001' });
    const admin = await addMember(h, owner.client, 'Admin', 'scopedadmin');
    const members = (await owner.client.get('/members')).body.data as Array<{ id: string; userId: string; version: number }>;
    const adminMember = members.find((m) => m.userId === admin.userId);
    const scoped = await owner.client.patch(`/members/${adminMember?.id}`, { version: adminMember?.version, legalEntityIds: [mumbai.entityId] });
    expect(scoped.status).toBe(200);
    expect(scoped.body.legalEntityIds).toEqual([mumbai.entityId]);

    const context = await admin.client.get('/tenant/context');
    expect(context.body.entityScopes['settings.company']).toEqual([mumbai.entityId]);
    const visible = (await admin.client.get('/legal-entities')).body.data.map((e: { legalName: string }) => e.legalName);
    expect(visible).toEqual(['Mumbai Unit (test)']);
    expect((await admin.client.get(`/legal-entities/${pune.entityId}`)).status).toBe(404);
    expect((await admin.client.patch(`/legal-entities/${pune.entityId}`, { version: 0, tradeName: 'x' })).status).toBe(404);
    expect((await admin.client.patch(`/legal-entities/${mumbai.entityId}`, { version: mumbai.version, tradeName: 'Mumbai' })).status).toBe(200);
    // New entities are outside any limited scope.
    expect((await admin.client.post('/legal-entities', { legalName: 'New (test)', pan: fakePan(), constitution: 'llp', address: address(), turnoverBand: 'up_to_5cr' })).status).toBe(403);

    // A scoped admin can't grant access beyond their own scope.
    const sales = await addMember(h, owner.client, 'Sales', 'scopedsales');
    const all = (await owner.client.get('/members')).body.data as Array<{ id: string; userId: string; version: number }>;
    const salesMember = all.find((m) => m.userId === sales.userId);
    expect((await admin.client.patch(`/members/${salesMember?.id}`, { version: salesMember?.version, legalEntityIds: null })).status).toBe(403);
    expect((await admin.client.patch(`/members/${salesMember?.id}`, { version: salesMember?.version, legalEntityIds: [pune.entityId] })).status).toBe(403);
    expect((await admin.client.patch(`/members/${salesMember?.id}`, { version: salesMember?.version, legalEntityIds: [mumbai.entityId] })).status).toBe(403);
  });

  it('never limits the Owner role and rejects unknown entities', async () => {
    const owner = await signUp(h, 'scopeownerrole');
    const e = await setupEntity(owner.client);
    const roles = (await owner.client.get('/roles')).body.data as Array<{ id: string; name: string }>;
    const ownerRole = roles.find((r) => r.name === 'Owner')?.id;
    const invite = await owner.client.post('/invitations', { email: `scoped.owner.${Date.now()}@example.test`, roleIds: [ownerRole], legalEntityIds: [e.entityId] });
    expect(invite.status).toBe(400);
    const other = await signUp(h, 'scopeforeign');
    const foreign = await setupEntity(other.client);
    const salesRole = roles.find((r) => r.name === 'Sales')?.id;
    expect((await owner.client.post('/invitations', { email: `x.${Date.now()}@example.test`, roleIds: [salesRole], legalEntityIds: [foreign.entityId] })).status).toBe(400);
  });
});

describe('cross-tenant isolation for organization data (AC-TEN-1)', () => {
  it('answers 404 for another tenant’s entities, registrations and series', async () => {
    const a = await signUp(h, 'orga');
    const b = await signUp(h, 'orgb');
    const be = await setupEntity(b.client);
    const series = await b.client.post('/document-series', { legalEntityId: be.entityId, gstRegistrationId: be.registrationId, docType: 'tax_invoice', name: 'B invoices', prefix: 'B-', padding: 4 });
    expect(series.status).toBe(201);
    const results = await Promise.all([
      a.client.get(`/legal-entities/${be.entityId}`),
      a.client.patch(`/legal-entities/${be.entityId}`, { version: 0, tradeName: 'x' }),
      a.client.get(`/legal-entities/${be.entityId}/registrations`),
      a.client.patch(`/gst-registrations/${be.registrationId}`, { version: 0, label: 'x' }),
      a.client.get(`/document-series?legalEntityId=${be.entityId}`),
      a.client.patch(`/document-series/${series.body.id}`, { version: 0, name: 'Renamed' }),
    ]);
    for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(404);
    // Registering tenant B's GSTIN under a tenant A entity fails the PAN check, never revealing B.
    const ae = await setupEntity(a.client);
    expect((await a.client.post(`/legal-entities/${ae.entityId}/registrations`, { gstin: be.gstin, registrationType: 'regular', effectiveFrom: '2018-04-01', address: address() })).status).toBe(400);
    expect(JSON.stringify((await a.client.get('/legal-entities')).body)).not.toContain(be.entityId);
  });
});
