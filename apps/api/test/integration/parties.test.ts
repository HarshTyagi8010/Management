import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, address, createHarness, fakeGstin, fakePan, signUp, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

function customer(overrides: Record<string, unknown> = {}) {
  const pan = fakePan();
  return {
    name: `Example Buyers ${Math.random().toString(36).slice(2, 7)} (test)`,
    isCustomer: true,
    isSupplier: false,
    pan,
    gstins: [{ gstin: fakeGstin('27', pan), addressId: 'hq' }],
    addresses: [{ id: 'hq', label: 'Head office', isBilling: true, isShipping: true, ...address() }],
    contacts: [{ id: 'c1', name: 'Test Contact', phone: `+91 98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, email: 'contact@example.test' }],
    creditLimit: '250000.00',
    paymentTermsDays: 30,
    ...overrides,
  };
}

const create = (client: Client, body: Record<string, unknown>) => client.post('/parties', body);

describe('parties (FR-PTY-01/05)', () => {
  it('creates a party with GSTINs, addresses, contacts and terms, and archives instead of deleting', async () => {
    const { client } = await signUp(h, 'party');
    const body = customer({ isSupplier: true, tags: ['wholesale', 'wholesale'] });
    const res = await create(client, body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ isCustomer: true, isSupplier: true, creditLimit: '250000.00', paymentTermsDays: 30, tags: ['wholesale'] });
    expect(res.body.gstins[0]).toMatchObject({ gstin: body.gstins[0]?.gstin, stateCode: '27', addressId: 'hq' });

    const renamed = await client.patch(`/parties/${res.body.id}`, { version: 0, name: 'Renamed Buyers (test)' });
    // A partial update keeps everything it didn't mention.
    expect(renamed.body).toMatchObject({ name: 'Renamed Buyers (test)', creditLimit: '250000.00', gstins: res.body.gstins, contacts: res.body.contacts });

    const archived = await client.patch(`/parties/${res.body.id}`, { version: renamed.body.version, archived: true });
    expect(archived.body.archived).toBe(true);
    expect((await client.get('/parties')).body.data).toHaveLength(0);
    expect((await client.get('/parties?archived=true')).body.data).toHaveLength(1);
    expect((await client.send('delete', `/parties/${res.body.id}`)).status).toBe(404);
  });

  it('rejects inconsistent data', async () => {
    const { client } = await signUp(h, 'partybad');
    expect((await create(client, customer({ isCustomer: false }))).status).toBe(400);
    expect((await create(client, customer({ gstins: [{ gstin: fakeGstin('27', fakePan()), addressId: null }] }))).status).toBe(400);
    expect((await create(client, customer({ gstins: [{ gstin: fakeGstin('27', 'AAPFU0939F'), addressId: 'nowhere' }], pan: 'AAPFU0939F' }))).status).toBe(400);
    expect((await create(client, customer({ creditLimit: 1000 }))).status).toBe(400);
    expect((await create(client, customer({ addresses: [{ id: 'a', ...address('27', '012345') }], gstins: [] }))).status).toBe(400);
  });
});

describe('duplicate detection (FR-PTY-02)', () => {
  it('flags matching GSTIN, PAN or phone, and saves only after confirmation (audited)', async () => {
    const { client } = await signUp(h, 'dupes');
    const first = customer();
    const original = await create(client, first);
    const samePan = customer({ pan: first.pan, gstins: [{ gstin: fakeGstin('29', first.pan), addressId: null }], contacts: [] });
    const blocked = await create(client, samePan);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details[0].message).toMatch(/same PAN/);
    expect(blocked.body.error.details[0].path).toBe(`duplicate.${original.body.id}`);

    const samePhone = customer({ contacts: [{ id: 'x', name: 'Other', phone: (first.contacts[0]?.phone ?? '').replace('+91 ', '0') }] });
    expect((await create(client, samePhone)).body.error.details[0].message).toMatch(/same phone/);

    const confirmed = await create(client, { ...samePan, confirmDuplicates: true });
    expect(confirmed.status).toBe(201);
    const events = (await client.get('/audit-events?action=party.duplicate_confirmed')).body.data;
    expect(events).toHaveLength(1);
  });
});

describe('search and paging', () => {
  it('finds by name, GSTIN prefix and phone; treats search text literally', async () => {
    const { client } = await signUp(h, 'search');
    const a = customer({ name: 'Alpha Hardware (test)' });
    await create(client, a);
    await create(client, customer({ name: 'Beta Hardware (test)' }));
    await create(client, customer({ name: 'Gamma Tools (test)', isCustomer: false, isSupplier: true }));
    const names = async (q: string) => (await client.get(`/parties?${q}`)).body.data.map((p: { name: string }) => p.name);
    expect(await names('q=hardware')).toEqual(['Alpha Hardware (test)', 'Beta Hardware (test)']);
    expect(await names(`q=${a.gstins[0]?.gstin.slice(0, 10)}`)).toEqual(['Alpha Hardware (test)']);
    expect(await names(`q=${encodeURIComponent(a.contacts[0]?.phone ?? '')}`)).toEqual(['Alpha Hardware (test)']);
    expect(await names('role=supplier')).toEqual(['Gamma Tools (test)']);
    expect(await names('q=.*')).toEqual([]);
    const page = await client.get('/parties?limit=2');
    const next = await client.get(`/parties?limit=2&cursor=${page.body.page.nextCursor}`);
    expect([...page.body.data, ...next.body.data]).toHaveLength(3);
  });
});

describe('role-based visibility (permission matrix: party.view_basic)', () => {
  it('shows storekeepers only names and addresses, and hides identifiers from search', async () => {
    const owner = await signUp(h, 'basic');
    const body = customer();
    const party = await create(owner.client, body);
    const store = await addMember(h, owner.client, 'Storekeeper', 'basicstore');
    const seen = await store.client.get(`/parties/${party.body.id}`);
    expect(seen.status).toBe(200);
    expect(Object.keys(seen.body).sort()).toEqual(['addresses', 'archived', 'id', 'isCustomer', 'isSupplier', 'legalName', 'name', 'version']);
    expect(JSON.stringify((await store.client.get('/parties')).body)).not.toContain(body.pan);
    expect((await store.client.get(`/parties?q=${body.gstins[0]?.gstin}`)).body.data).toEqual([]);
    expect((await store.client.get(`/parties/${party.body.id}/timeline`)).status).toBe(403);
    expect((await store.client.patch(`/parties/${party.body.id}`, { version: 0, name: 'x' })).status).toBe(403);
  });
});

describe('CRM notes and follow-ups (FR-PTY-04)', () => {
  it('keeps a timeline, assigns follow-ups to members only, and lists my open follow-ups', async () => {
    const owner = await signUp(h, 'crm');
    const party = await create(owner.client, customer());
    const sales = await addMember(h, owner.client, 'Sales', 'crmsales');

    const note = await sales.client.post(`/parties/${party.body.id}/notes`, { body: 'Asked for a revised quotation (test note).' });
    expect(note.status).toBe(201);
    const task = await owner.client.post(`/parties/${party.body.id}/tasks`, { title: 'Call about the quotation', dueDate: '2026-10-21', assigneeId: sales.userId });
    expect(task.body).toMatchObject({ status: 'open', assignee: { name: sales.user.name }, partyName: party.body.name });

    const stranger = await signUp(h, 'crmstranger');
    expect((await owner.client.post(`/parties/${party.body.id}/tasks`, { title: 'Bad', dueDate: '2026-10-21', assigneeId: stranger.userId })).status).toBe(400);

    const mine = await sales.client.get('/crm-tasks');
    expect(mine.body.data.map((t: { title: string }) => t.title)).toEqual(['Call about the quotation']);
    expect((await owner.client.get('/crm-tasks')).body.data).toEqual([]);
    expect((await owner.client.get('/crm-tasks?assignee=anyone')).body.data).toHaveLength(1);

    const done = await sales.client.patch(`/crm-tasks/${task.body.id}`, { version: 0, status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).not.toBeNull();
    expect((await sales.client.get('/crm-tasks')).body.data).toEqual([]);

    const timeline = (await owner.client.get(`/parties/${party.body.id}/timeline`)).body.data as Array<{ kind: string }>;
    expect(timeline.map((e) => e.kind).sort()).toEqual(['note', 'task']);
    // Notes are append-only records.
    await expect(h.db.models.CrmNote.updateOne({ tenantId: party.body.tenantId ?? null }, { $set: { body: 'edited' } })).rejects.toThrow(/append-only/);
  });

  it('isolates CRM data between tenants', async () => {
    const a = await signUp(h, 'crma');
    const b = await signUp(h, 'crmb');
    const bParty = await create(b.client, customer());
    const bTask = await b.client.post(`/parties/${bParty.body.id}/tasks`, { title: 'B task', dueDate: '2026-10-22' });
    const results = await Promise.all([
      a.client.get(`/parties/${bParty.body.id}`),
      a.client.patch(`/parties/${bParty.body.id}`, { version: 0, name: 'Hijack' }),
      a.client.get(`/parties/${bParty.body.id}/timeline`),
      a.client.post(`/parties/${bParty.body.id}/notes`, { body: 'x' }),
      a.client.post(`/parties/${bParty.body.id}/tasks`, { title: 'x', dueDate: '2026-10-22' }),
      a.client.patch(`/crm-tasks/${bTask.body.id}`, { version: 0, status: 'done' }),
    ]);
    for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect((await a.client.get('/crm-tasks?assignee=anyone')).body.data).toEqual([]);
    // Duplicate detection never reveals another tenant's parties.
    const sameIds = { ...customer(), pan: bParty.body.pan, gstins: bParty.body.gstins.map((g: { gstin: string }) => ({ gstin: g.gstin, addressId: null })) };
    expect((await create(a.client, sameIds)).status).toBe(201);
  });
});
