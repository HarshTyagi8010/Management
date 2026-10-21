import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { inject, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { connectDatabase } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { runMigrations } from '../../src/migrations/index.js';
import { buildModules } from '../../src/modules/index.js';
import { MemoryMailer } from '../../src/platform/mailer.js';
import { gstinCheckCharacter } from '@bizmgmt/contracts';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** A controllable clock shared by the services under test. */
export class TestClock {
  private offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  advance(ms: number) {
    this.offsetMs += ms;
  }
}

export const MINUTE = 60_000;

/** Builds the real app on a fresh, uniquely named database in the test replica set. */
export async function createHarness(env: Record<string, string> = {}) {
  const uri = inject('mongoUri');
  const dbName = `bizmgmt_test_${randomBytes(5).toString('hex')}`;
  // Generated documents go to a per-file directory inside the project, removed on close.
  const storageDir = path.resolve(import.meta.dirname, '../../../../.tmp', `storage-${dbName}`);
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    PASSWORD_HASH_PROFILE: 'test',
    CORS_ORIGINS: 'http://localhost:5173',
    MONGODB_URI: uri,
    MONGODB_DB_NAME: dbName,
    APP_SECRET: 'integration-test-secret-0123456789abcdef',
    // Each test client presents its own address via X-Forwarded-For, as behind the load balancer.
    TRUST_PROXY: '1',
    STORAGE_DIR: storageDir,
    ...env,
  });
  const logger = createLogger({ level: 'info', service: 'api-int', destination: sink });
  const db = await connectDatabase(uri, dbName, logger);
  await runMigrations(db.connection, db.models);
  const clock = new TestClock();
  const mailer = new MemoryMailer();
  const modules = await buildModules({ config, logger, db, mailer, now: clock.now });
  const app = createApp({ config, logger, readinessChecks: { database: () => db.check() }, routers: modules.routers });
  return {
    app,
    db,
    config,
    clock,
    mailer,
    modules,
    logs: () => lines.join(''),
    client: () => new Client(app),
    async close() {
      if (!dbName.startsWith('bizmgmt_test_')) throw new Error('Refusing to drop a non-test database');
      await db.connection.dropDatabase();
      await db.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

const UNSAFE = new Set(['post', 'put', 'patch', 'delete']);

/**
 * A browser-like client: keeps cookies (including Secure ones, which supertest's
 * agent would drop over plain HTTP), the CSRF token and the selected tenant.
 */
export class Client {
  readonly cookies = new Map<string, string>();
  csrf: string | undefined;
  tenantId: string | undefined;
  /** Client address seen by the API (through the trusted proxy hop). */
  ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  constructor(private readonly app: Express) {}

  async send(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    let req = request(this.app)[method](`/api/v1${path}`);
    if (this.cookies.size) req = req.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (UNSAFE.has(method) && this.csrf) req = req.set('X-CSRF-Token', this.csrf);
    if (this.tenantId) req = req.set('X-Tenant-Id', this.tenantId);
    req = req.set('X-Forwarded-For', this.ip);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    const res = body === undefined ? await req : await req.send(body as object);
    this.store(res);
    const session = (res.body?.session ?? res.body) as { csrfToken?: unknown; activeTenantId?: unknown } | undefined;
    if (typeof session?.csrfToken === 'string') this.csrf = session.csrfToken;
    if (typeof session?.activeTenantId === 'string' && !this.tenantId) this.tenantId = session.activeTenantId;
    return res;
  }

  private store(res: Response) {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const cookie of header ?? []) {
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /expires=thu, 01 jan 1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get = (path: string, headers?: Record<string, string>) => this.send('get', path, undefined, headers);
  post = (path: string, body: unknown = {}, headers?: Record<string, string>) => this.send('post', path, body, headers);
  put = (path: string, body: unknown = {}) => this.send('put', path, body);
  patch = (path: string, body: unknown = {}) => this.send('patch', path, body);
  delete = (path: string) => this.send('delete', path);

  /** GET for a binary response (e.g. a PDF); the body is a Buffer. */
  async download(path: string): Promise<Response & { body: Buffer }> {
    let req = request(this.app).get(`/api/v1${path}`);
    if (this.cookies.size) req = req.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (this.tenantId) req = req.set('X-Tenant-Id', this.tenantId);
    req = req.set('X-Forwarded-For', this.ip);
    return (await req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    })) as Response & { body: Buffer };
  }

  /** Fetches the anonymous CSRF token, as the web app does on load. */
  async init() {
    await this.get('/auth/session');
    return this;
  }

  get sessionCookie() {
    return this.cookies.get('__Host-sid');
  }
}

let counter = 0;
/** Synthetic, clearly fake identities (testing-strategy §3: no real customer data). */
export function fakeUser(label = 'user') {
  counter += 1;
  return {
    name: `Test ${label} ${counter}`,
    email: `${label}${counter}.${randomBytes(3).toString('hex')}@example.test`,
    password: `Correct-horse-${randomBytes(4).toString('hex')}`,
  };
}

export async function signUp(h: Harness, label = 'owner', businessName = 'Example Traders (test)') {
  const user = fakeUser(label);
  const client = await h.client().init();
  const res = await client.post('/auth/signup', { ...user, businessName });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, user, tenantId: res.body.activeTenantId as string, userId: res.body.user.id as string };
}

/** Extracts the single-use token from the most recent email to `to`. */
export function tokenFromMail(h: Harness, to: string, pathName: string): Promise<string> {
  return vi.waitFor(() => {
    const message = [...h.mailer.sent].reverse().find((m) => m.to === to);
    const match = message ? new RegExp(`/${pathName}#token=([A-Za-z0-9_-]{43})`).exec(message.text) : null;
    if (!match?.[1]) throw new Error('no mail yet');
    return match[1];
  });
}

/** Invites `email` with the given system role and accepts as a new account; returns a signed-in client. */
export async function addMember(h: Harness, owner: Client, roleName: string, label = roleName.toLowerCase()) {
  const roles = await owner.get('/roles');
  const role = (roles.body.data as Array<{ id: string; name: string }>).find((r) => r.name === roleName);
  if (!role) throw new Error(`role ${roleName} not found`);
  const user = fakeUser(label);
  const invited = await owner.post('/invitations', { email: user.email, roleIds: [role.id] });
  if (invited.status !== 201) throw new Error(`invite failed: ${invited.status} ${JSON.stringify(invited.body)}`);
  const token = await tokenFromMail(h, user.email, 'accept-invite');
  const client = await h.client().init();
  const accepted = await client.post('/auth/invitations/accept', { token, name: user.name, password: user.password });
  if (accepted.status !== 201) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return { client, user, userId: accepted.body.user.id as string, roleId: role.id };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pick = (alphabet: string) => alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'A';

/** A random, well-formed synthetic PAN (holder type C = company by default). Not a real identifier. */
export function fakePan(holder = 'C'): string {
  const letters = (n: number) => Array.from({ length: n }, () => pick(LETTERS)).join('');
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
  return `${letters(3)}${holder}${letters(1)}${digits}${letters(1)}`;
}

/** A synthetic GSTIN with a correct check character for the given state and PAN. */
export function fakeGstin(stateCode: string, pan: string, entity = '1'): string {
  const body = `${stateCode}${pan}${entity}Z`;
  return body + gstinCheckCharacter(body);
}

export const address = (stateCode = '27', pincode = '400001') => ({ line1: '12 Example Industrial Estate', city: 'Mumbai', stateCode, pincode });

/** Creates a legal entity with one GST registration for an owner client. */
export async function setupEntity(owner: Client, opts: { stateCode?: string; pincode?: string; legalName?: string } = {}) {
  const pan = fakePan();
  const entity = await owner.post('/legal-entities', {
    legalName: opts.legalName ?? 'Example Traders Private Limited (test)',
    pan,
    constitution: 'private_limited',
    address: address(opts.stateCode, opts.pincode),
    turnoverBand: 'up_to_5cr',
  });
  if (entity.status !== 201) throw new Error(`entity: ${entity.status} ${JSON.stringify(entity.body)}`);
  const gstin = fakeGstin(opts.stateCode ?? '27', pan);
  const reg = await owner.post(`/legal-entities/${entity.body.id}/registrations`, { gstin, registrationType: 'regular', effectiveFrom: '2017-07-01', address: address(opts.stateCode, opts.pincode) });
  if (reg.status !== 201) throw new Error(`registration: ${reg.status} ${JSON.stringify(reg.body)}`);
  return { entityId: entity.body.id as string, pan, gstin, registrationId: reg.body.id as string, version: entity.body.version as number };
}
