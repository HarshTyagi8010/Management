import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, timeStep } from '../../src/modules/identity/totp.js';
import { addMember, createHarness, fakeUser, MINUTE, signUp, tokenFromMail, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const roleId = async (client: Awaited<ReturnType<typeof signUp>>['client'], name: string) => {
  const roles = (await client.get('/roles')).body.data as Array<{ id: string; name: string }>;
  const role = roles.find((r) => r.name === name);
  if (!role) throw new Error(`no role ${name}`);
  return role.id;
};

describe('tenant isolation (FR-TEN-02/03, AC-TEN-1)', () => {
  it('answers 404 for another tenant and for its resource ids, and never lists its data', async () => {
    const a = await signUp(h, 'tenanta', 'Alpha Traders (test)');
    const b = await signUp(h, 'tenantb', 'Beta Traders (test)');
    const bMember = await addMember(h, b.client, 'Sales');
    await b.client.post('/roles', { name: 'Beta only role', permissions: ['party.view'] });
    await b.client.post('/invitations', { email: fakeUser('pending').email, roleIds: [await roleId(b.client, 'Auditor')] });

    const bRoles = (await b.client.get('/roles')).body.data as Array<{ id: string; name: string }>;
    const bInvitations = (await b.client.get('/invitations')).body.data as Array<{ id: string }>;
    const bMembers = (await b.client.get('/members')).body.data as Array<{ id: string; email: string }>;
    const bRole = bRoles.find((r) => r.name === 'Beta only role');
    const bSalesMember = bMembers.find((m) => m.email === bMember.user.email);
    expect(bRole && bSalesMember && bInvitations[0]).toBeTruthy();

    // A forged X-Tenant-Id naming tenant B: not found, not forbidden.
    const forged = await a.client.get('/tenant/context', { 'X-Tenant-Id': b.tenantId });
    expect(forged.status).toBe(404);
    expect(JSON.stringify(forged.body)).not.toContain('Beta');
    const forgedWrite = await a.client.send('patch', '/tenant', { name: 'Hijacked' }, { 'X-Tenant-Id': b.tenantId });
    expect(forgedWrite.status).toBe(404);
    // A tenant id that does not exist looks the same.
    expect((await a.client.get('/tenant/context', { 'X-Tenant-Id': new Types.ObjectId().toHexString() })).status).toBe(404);

    // Tenant B's ids used inside tenant A's context.
    const attempts = [
      a.client.patch(`/roles/${bRole?.id}`, { version: 0, name: 'Renamed' }),
      a.client.delete(`/roles/${bRole?.id}`),
      a.client.patch(`/members/${bSalesMember?.id}`, { version: 0, status: 'disabled' }),
      a.client.post(`/members/${bSalesMember?.id}/revoke-sessions`),
      a.client.delete(`/invitations/${bInvitations[0]?.id}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    // Assigning tenant B's role inside tenant A is a validation failure, not a cross-tenant grant.
    const invite = await a.client.post('/invitations', { email: fakeUser('cross').email, roleIds: [bRole?.id] });
    expect(invite.status).toBe(400);

    // Lists in tenant A contain nothing from tenant B.
    const aLists = JSON.stringify([
      (await a.client.get('/roles')).body,
      (await a.client.get('/members')).body,
      (await a.client.get('/invitations')).body,
      (await a.client.get('/audit-events')).body,
    ]);
    expect(aLists).not.toContain('Beta');
    expect(aLists).not.toContain(bMember.user.email);
    for (const id of [bRole?.id, bSalesMember?.id, bInvitations[0]?.id, b.tenantId]) expect(aLists).not.toContain(id);

    // Tenant B is untouched.
    expect((await b.client.get('/tenant/context')).body.tenant.name).toBe('Beta Traders (test)');
    expect((await b.client.get('/roles')).body.data.map((r: { name: string }) => r.name)).toContain('Beta only role');
    expect((await bMember.client.get('/tenant/context')).status).toBe(200);
  });

  it('rejects malformed tenant and resource ids before any query', async () => {
    const { client } = await signUp(h, 'malformed');
    expect((await client.get('/tenant/context', { 'X-Tenant-Id': '{"$ne":null}' })).status).toBe(400);
    expect((await client.patch('/roles/not-an-id', { version: 0 })).status).toBe(400);
    expect((await client.get('/audit-events?cursor[$gt]=a')).status).toBe(400);
  });

  it('guards tenant-owned models against unscoped queries', async () => {
    await expect(h.db.models.Role.find({ name: 'Owner' }).lean()).rejects.toThrow(/Unscoped query/);
    await expect(h.db.models.Membership.aggregate([{ $match: { status: 'active' } }])).rejects.toThrow(/must start with \$match on tenantId/);
    const id = new Types.ObjectId();
    await expect(h.db.models.AuditEvent.updateOne({ tenantId: id }, { $set: { summary: 'edited' } })).rejects.toThrow(/append-only/);
    await expect(h.db.models.AuditEvent.deleteMany({ tenantId: id })).rejects.toThrow(/append-only/);
  });

  it('lets a user belong to several businesses and switch between them', async () => {
    const a = await signUp(h, 'multia', 'Gamma Traders (test)');
    const b = await signUp(h, 'multib', 'Delta Traders (test)');
    const invited = await b.client.post('/invitations', { email: a.user.email, roleIds: [await roleId(b.client, 'Accountant')] });
    expect(invited.status).toBe(201);
    const token = await tokenFromMail(h, a.user.email, 'accept-invite');

    const stranger = await h.client().init();
    expect((await stranger.post('/auth/invitations/accept', { token })).status).toBe(401);
    const inspect = await stranger.post('/auth/invitations/inspect', { token });
    expect(inspect.body).toEqual({ tenantName: 'Delta Traders (test)', email: a.user.email, accountExists: true });

    const accepted = await a.client.post('/auth/invitations/accept', { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.tenants.map((t: { name: string }) => t.name).sort()).toEqual(['Delta Traders (test)', 'Gamma Traders (test)']);
    expect((await a.client.get('/tenant/context', { 'X-Tenant-Id': b.tenantId })).body.roles).toEqual([expect.objectContaining({ name: 'Accountant' })]);
    expect((await a.client.put('/auth/active-tenant', { tenantId: b.tenantId })).status).toBe(204);
    expect((await a.client.get('/auth/session')).body.activeTenantId).toBe(b.tenantId);
    expect((await a.client.put('/auth/active-tenant', { tenantId: new Types.ObjectId().toHexString() })).status).toBe(404);
  });
});

describe('invitations (FR-AUTH-08)', () => {
  it('creates an account from a single-use, expiring invitation', async () => {
    const owner = await signUp(h, 'inviter');
    const user = fakeUser('invitee');
    const res = await owner.client.post('/invitations', { email: user.email, roleIds: [await roleId(owner.client, 'Storekeeper')] });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    const token = await tokenFromMail(h, user.email, 'accept-invite');

    const anon = await h.client().init();
    const missing = await anon.post('/auth/invitations/accept', { token });
    expect(missing.status).toBe(400);
    const joined = await anon.post('/auth/invitations/accept', { token, name: user.name, password: user.password });
    expect(joined.status).toBe(201);
    expect((await anon.get('/tenant/context')).body.roles).toEqual([expect.objectContaining({ name: 'Storekeeper' })]);

    const again = await h.client().init();
    expect((await again.post('/auth/invitations/accept', { token, name: 'X', password: 'Another-passphrase' })).status).toBe(404);

    const late = fakeUser('late');
    await owner.client.post('/invitations', { email: late.email, roleIds: [await roleId(owner.client, 'Sales')] });
    const lateToken = await tokenFromMail(h, late.email, 'accept-invite');
    h.clock.advance(7 * 24 * 60 * MINUTE + MINUTE);
    expect((await again.post('/auth/invitations/inspect', { token: lateToken })).status).toBe(404);
  });

  it('refuses inviting an existing member and lets a new invitation replace a pending one', async () => {
    const owner = await signUp(h, 'reinvite');
    const member = await addMember(h, owner.client, 'Sales');
    const dup = await owner.client.post('/invitations', { email: member.user.email, roleIds: [member.roleId] });
    expect(dup.body.error.code).toBe('DUPLICATE');

    const user = fakeUser('twice');
    await owner.client.post('/invitations', { email: user.email, roleIds: [member.roleId] });
    const first = await tokenFromMail(h, user.email, 'accept-invite');
    h.mailer.sent.length = 0;
    await owner.client.post('/invitations', { email: user.email, roleIds: [member.roleId] });
    const second = await tokenFromMail(h, user.email, 'accept-invite');
    const anon = await h.client().init();
    expect((await anon.post('/auth/invitations/inspect', { token: first })).status).toBe(404);
    expect((await anon.post('/auth/invitations/inspect', { token: second })).status).toBe(200);
    expect((await owner.client.get('/invitations')).body.data.filter((i: { email: string }) => i.email === user.email)).toHaveLength(1);
  });
});

describe('roles and members (FR-RBAC-01/02, escalation guards)', () => {
  it('seeds the seven system roles, which cannot be edited but can be copied', async () => {
    const { client } = await signUp(h, 'roles');
    const roles = (await client.get('/roles')).body.data as Array<{ id: string; name: string; system: boolean; permissions: string[]; version: number }>;
    expect(roles.map((r) => r.name)).toEqual(['Owner', 'Admin', 'Accountant', 'Sales', 'Storekeeper', 'Purchase', 'Auditor']);
    const sales = roles.find((r) => r.name === 'Sales');
    expect((await client.patch(`/roles/${sales?.id}`, { version: 0, permissions: ['invoice.issue'] })).body.error.code).toBe('BUSINESS_RULE');

    const copy = await client.post('/roles', { name: 'Sales with invoicing', permissions: [...(sales?.permissions ?? []), 'invoice.issue'] });
    expect(copy.status).toBe(201);
    expect(copy.body.permissions).toContain('invoice.issue');
    expect((await client.post('/roles', { name: 'sales WITH invoicing', permissions: [] })).body.error.code).toBe('DUPLICATE');

    const updated = await client.patch(`/roles/${copy.body.id}`, { version: 0, permissions: ['party.view'] });
    expect(updated.body.permissions).toEqual(['party.view']);
    expect((await client.patch(`/roles/${copy.body.id}`, { version: 0, name: 'Stale edit' })).body.error.code).toBe('VERSION_CONFLICT');
    expect((await client.delete(`/roles/${copy.body.id}`)).status).toBe(204);
    expect((await client.get('/roles')).body.data.map((r: { name: string }) => r.name)).not.toContain('Sales with invoicing');
  });

  it('stops admins from granting what they do not have or managing owners', async () => {
    const owner = await signUp(h, 'escalate');
    const admin = await addMember(h, owner.client, 'Admin');
    const ownerRole = await roleId(owner.client, 'Owner');
    const sales = await addMember(h, owner.client, 'Sales');
    const members = (await owner.client.get('/members')).body.data as Array<{ id: string; email: string; version: number }>;
    const salesMember = members.find((m) => m.email === sales.user.email);
    const ownerMember = members.find((m) => m.email === owner.user.email);

    const promote = await admin.client.patch(`/members/${salesMember?.id}`, { version: salesMember?.version, roleIds: [ownerRole] });
    expect(promote.status).toBe(403);
    expect((await admin.client.post('/roles', { name: 'Sneaky', permissions: ['tenant.manage'] })).status).toBe(403);
    expect((await admin.client.post('/invitations', { email: fakeUser('x').email, roleIds: [ownerRole] })).status).toBe(403);
    expect((await admin.client.patch(`/members/${ownerMember?.id}`, { version: ownerMember?.version, status: 'disabled' })).status).toBe(403);

    // Within their own permissions an admin can manage staff.
    const auditor = await roleId(owner.client, 'Auditor');
    const ok = await admin.client.patch(`/members/${salesMember?.id}`, { version: salesMember?.version, roleIds: [auditor] });
    expect(ok.status).toBe(200);
    expect(ok.body.roles).toEqual([expect.objectContaining({ name: 'Auditor' })]);
    expect((await sales.client.get('/tenant/context')).body.permissions).toContain('audit.view');
  });

  it('keeps at least one owner and stops people changing their own access', async () => {
    const owner = await signUp(h, 'lastowner');
    const members = (await owner.client.get('/members')).body.data as Array<{ id: string; version: number; isSelf: boolean }>;
    const self = members.find((m) => m.isSelf);
    const res = await owner.client.patch(`/members/${self?.id}`, { version: self?.version, status: 'disabled' });
    expect(res.body.error.code).toBe('BUSINESS_RULE');

    const second = await addMember(h, owner.client, 'Owner', 'coowner');
    const all = (await owner.client.get('/members')).body.data as Array<{ id: string; email: string; version: number }>;
    const target = all.find((m) => m.email === second.user.email);
    const otherRole = await roleId(owner.client, 'Admin');
    // Two owners demoting each other at the same moment: at most one succeeds.
    const firstSelf = all.find((m) => m.email === owner.user.email);
    const results = await Promise.all([
      owner.client.patch(`/members/${target?.id}`, { version: target?.version, roleIds: [otherRole] }),
      second.client.patch(`/members/${firstSelf?.id}`, { version: firstSelf?.version, roleIds: [otherRole] }),
    ]);
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBeLessThanOrEqual(1);
    const tenantId = new Types.ObjectId(owner.tenantId);
    const ownerRole = await h.db.models.Role.findOne({ tenantId, systemKey: 'owner' }).lean();
    if (!ownerRole) throw new Error('owner role missing');
    const owners = await h.db.models.Membership.countDocuments({ tenantId, status: 'active', 'roleAssignments.roleId': ownerRole._id });
    expect(owners).toBeGreaterThanOrEqual(1);
  });

  it('disabling a member removes their access to the business immediately', async () => {
    const owner = await signUp(h, 'disable');
    const member = await addMember(h, owner.client, 'Purchase');
    const list = (await owner.client.get('/members')).body.data as Array<{ id: string; email: string; version: number }>;
    const target = list.find((m) => m.email === member.user.email);
    expect((await owner.client.patch(`/members/${target?.id}`, { version: target?.version, status: 'disabled' })).status).toBe(200);
    expect((await member.client.get('/tenant/context')).status).toBe(404);
    expect((await owner.client.post(`/members/${target?.id}/revoke-sessions`)).body.revoked).toBeGreaterThanOrEqual(1);
    expect((await member.client.get('/auth/session')).body.status).toBe('anonymous');
  });
});

describe('step-up MFA for privileged actions', () => {
  it('requires enrolment and a recent code when MFA_ENFORCEMENT=privileged', async () => {
    const strict = await createHarness({ MFA_ENFORCEMENT: 'privileged' });
    try {
      const owner = await signUp(strict, 'stepup');
      const context = await owner.client.get('/tenant/context');
      expect(context.body.mfaEnrolmentRequired).toBe(true);
      const blocked = await owner.client.post('/roles', { name: 'Needs MFA', permissions: [] });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: [{ path: 'mfa', message: 'enrolment_required' }] });
      // Reading the member list does not need step-up.
      expect((await owner.client.get('/members')).status).toBe(200);

      const setup = await owner.client.post('/auth/mfa/totp/setup');
      const secret = base32Decode(setup.body.secret);
      await owner.client.post('/auth/mfa/totp/confirm', { code: hotp(secret, timeStep(strict.clock.now())) });
      expect((await owner.client.post('/roles', { name: 'Fresh MFA', permissions: [] })).status).toBe(201);

      strict.clock.advance(16 * MINUTE);
      const stale = await owner.client.post('/roles', { name: 'Stale MFA', permissions: [] });
      expect(stale.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: [{ path: 'mfa', message: 'step_up' }] });
      const stepped = await owner.client.post('/auth/mfa/step-up', { code: hotp(secret, timeStep(strict.clock.now())) });
      expect(stepped.status).toBe(200);
      expect((await owner.client.post('/roles', { name: 'Stale MFA', permissions: [] })).status).toBe(201);
    } finally {
      await strict.close();
    }
  });
});

describe('audit log (FR-AUD-01)', () => {
  it('records who changed what, pages newest first, and hides other tenants', async () => {
    const owner = await signUp(h, 'audit');
    await owner.client.post('/roles', { name: 'Cashier', permissions: ['receipt.post'] });
    await owner.client.patch('/tenant', { name: 'Audited Traders (test)' });
    const page1 = await owner.client.get('/audit-events?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.data.map((e: { action: string }) => e.action)).toEqual(['tenant.updated', 'role.created']);
    expect(page1.body.data[0]).toMatchObject({ actor: { name: owner.user.name }, changes: [{ field: 'name', to: 'Audited Traders (test)' }] });
    const page2 = await owner.client.get(`/audit-events?limit=2&cursor=${page1.body.page.nextCursor}`);
    expect(page2.body.data.map((e: { action: string }) => e.action)).toContain('tenant.created');
    const filtered = await owner.client.get('/audit-events?action=role.created');
    expect(filtered.body.data).toHaveLength(1);
  });
});
