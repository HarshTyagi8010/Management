import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, hotp, timeStep } from '../../src/modules/identity/totp.js';
import { createHarness, fakeUser, MINUTE, signUp, tokenFromMail, type Client, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const totpNow = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), timeStep(h.clock.now()) + offsetSteps);

describe('sign-up and session cookie (FR-AUTH-01/02, AC-AUTH-2)', () => {
  it('creates the account, business and owner membership, and sets a hardened cookie', async () => {
    const client = await h.client().init();
    const user = fakeUser('signup');
    const res = await client.post('/auth/signup', { ...user, businessName: 'Example Traders (test)' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'authenticated', user: { email: user.email, name: user.name, mfaEnabled: false } });
    expect(res.body.tenants).toEqual([{ id: res.body.activeTenantId, name: 'Example Traders (test)' }]);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-sid='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; SameSite=Strict/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
    // The token never appears in a response body (nothing for JS to store).
    expect(JSON.stringify(res.body)).not.toContain(client.sessionCookie);

    const ctx = await client.get('/tenant/context');
    expect(ctx.status).toBe(200);
    expect(ctx.body.roles).toEqual([expect.objectContaining({ name: 'Owner' })]);
    expect(ctx.body.permissions).toContain('tenant.manage');
  });

  it('stores passwords only as Argon2id hashes and session tokens only as hashes', async () => {
    const { user, client } = await signUp(h, 'hash');
    const doc = await h.db.models.User.findOne({ email: user.email }).lean();
    expect(doc?.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(JSON.stringify(doc)).not.toContain(user.password);
    if (!doc) throw new Error('user missing');
    const sessions = await h.db.models.Session.find({ userId: doc._id }).lean();
    expect(JSON.stringify(sessions)).not.toContain(client.sessionCookie);
  });

  it('rejects duplicate emails, weak passwords and unknown fields', async () => {
    const { user } = await signUp(h, 'dupe');
    const client = await h.client().init();
    expect((await client.post('/auth/signup', { ...user, businessName: 'Another (test)' })).body.error.code).toBe('DUPLICATE');
    const weak = await client.post('/auth/signup', { ...fakeUser('weak'), password: 'password1234', businessName: 'Weak (test)' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toMatch(/too common/);
    const extra = await client.post('/auth/signup', { ...fakeUser('extra'), businessName: 'Extra (test)', role: 'owner' });
    expect(extra.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses sign-up when it is turned off', async () => {
    const closed = await createHarness({ SIGNUP_ENABLED: 'false' });
    try {
      const client = await closed.client().init();
      const res = await client.post('/auth/signup', { ...fakeUser('closed'), businessName: 'Closed (test)' });
      expect(res.status).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe('CSRF protection (AC-AUTH-3)', () => {
  it('rejects unsafe requests without a valid token, before and after sign-in', async () => {
    const anon = await h.client().init();
    const token = anon.csrf;
    anon.csrf = undefined;
    const noToken = await anon.post('/auth/login', { email: 'nobody@example.test', password: 'x' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');
    anon.csrf = `${token?.slice(0, -2)}xx`;
    expect((await anon.post('/auth/login', { email: 'nobody@example.test', password: 'x' })).body.error.code).toBe('CSRF_INVALID');

    const { client } = await signUp(h, 'csrf');
    const valid = client.csrf;
    client.csrf = undefined;
    expect((await client.post('/auth/logout')).body.error.code).toBe('CSRF_INVALID');
    // An anonymous token is not accepted for a signed-in session.
    client.csrf = token;
    expect((await client.patch('/auth/preferences', { theme: 'dark' })).body.error.code).toBe('CSRF_INVALID');
    client.csrf = valid;
    expect((await client.patch('/auth/preferences', { theme: 'dark' })).status).toBe(204);
  });

  it('rejects cross-site requests even with a token', async () => {
    const { client } = await signUp(h, 'origin');
    // A foreign Origin is refused by the CORS allowlist before the CSRF check runs.
    const foreign = await client.post('/auth/logout', {}, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(['FORBIDDEN', 'CSRF_INVALID']).toContain(foreign.body.error.code);
    expect((await client.post('/auth/logout', {}, { 'Sec-Fetch-Site': 'cross-site' })).body.error.code).toBe('CSRF_INVALID');
    // Neither request signed the user out.
    expect((await client.get('/tenant/context')).status).toBe(200);
    expect((await client.post('/auth/logout', {}, { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(204);
  });
});

describe('sign-in, throttling and sign-out (FR-AUTH-03/04/05, AC-AUTH-1)', () => {
  it('signs in, rotates the session and signs out server-side', async () => {
    const { user, client: first } = await signUp(h, 'login');
    const before = first.sessionCookie;
    const res = await first.post('/auth/login', { email: user.email.toUpperCase(), password: user.password });
    expect(res.status).toBe(200);
    expect(first.sessionCookie).toBeDefined();
    expect(first.sessionCookie).not.toBe(before);

    // The pre-login token is dead.
    const stale = h.client();
    stale.cookies.set('__Host-sid', before ?? '');
    expect((await stale.get('/tenant/context')).status).toBe(401);

    const token = first.sessionCookie;
    expect((await first.post('/auth/logout')).status).toBe(204);
    const replay = h.client();
    replay.cookies.set('__Host-sid', token ?? '');
    expect((await replay.get('/auth/session')).body.status).toBe('anonymous');
  });

  it('gives the same answer for unknown emails and wrong passwords', async () => {
    const { user } = await signUp(h, 'enum');
    const client = await h.client().init();
    const wrong = await client.post('/auth/login', { email: user.email, password: 'definitely-wrong-123' });
    const unknown = await client.post('/auth/login', { email: 'no-such-user@example.test', password: 'definitely-wrong-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('blocks the 6th attempt after 5 failures, indistinguishably, then recovers', async () => {
    const { user } = await signUp(h, 'throttle');
    const client = await h.client().init();
    for (let i = 0; i < 5; i += 1) {
      expect((await client.post('/auth/login', { email: user.email, password: `wrong-password-${i}` })).status).toBe(401);
    }
    const wrong = await client.post('/auth/login', { email: user.email, password: 'wrong-password-x' });
    const sixthCorrect = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(sixthCorrect.status).toBe(401);
    expect(sixthCorrect.body.error.code).toBe(wrong.body.error.code);
    expect(sixthCorrect.body.error.message).toBe(wrong.body.error.message);
    expect(client.sessionCookie).toBeUndefined();

    h.clock.advance(2 * MINUTE);
    expect((await client.post('/auth/login', { email: user.email, password: user.password })).status).toBe(200);
  });

  it('expires idle sessions and enforces the absolute lifetime', async () => {
    const { client } = await signUp(h, 'expiry');
    h.clock.advance(29 * MINUTE);
    expect((await client.get('/tenant/context')).status).toBe(200);
    h.clock.advance(31 * MINUTE);
    expect((await client.get('/tenant/context')).status).toBe(401);

    const { client: busy } = await signUp(h, 'absolute');
    for (let elapsed = 0; elapsed < 12 * 60; elapsed += 25) {
      h.clock.advance(25 * MINUTE);
      const status = (await busy.get('/tenant/context')).status;
      if (elapsed + 25 >= 12 * 60) expect(status).toBe(401);
      else expect(status).toBe(200);
    }
  });

  it('signs out everywhere', async () => {
    const { user, client: a } = await signUp(h, 'everywhere');
    const b = await h.client().init();
    await b.post('/auth/login', { email: user.email, password: user.password });
    expect((await a.get('/auth/sessions')).body.data).toHaveLength(2);
    expect((await a.post('/auth/logout-all')).status).toBe(204);
    expect((await b.get('/tenant/context')).status).toBe(401);
  });
});

describe('two-step verification (FR-AUTH-06)', () => {
  async function enrol(client: Client) {
    const setup = await client.post('/auth/mfa/totp/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/BizMgmt:/);
    const confirm = await client.post('/auth/mfa/totp/confirm', { code: totpNow(setup.body.secret) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    return { secret: setup.body.secret as string, recoveryCodes: confirm.body.recoveryCodes as string[] };
  }

  it('requires a code after the password, refuses replays and accepts a recovery code once', async () => {
    const { user, client } = await signUp(h, 'mfa');
    const { secret, recoveryCodes } = await enrol(client);
    const stored = await h.db.models.MfaFactor.findOne({}).sort({ _id: -1 }).lean();
    expect(stored?.secretEnc).not.toContain(secret);

    const other = await h.client().init();
    const login = await other.post('/auth/login', { email: user.email, password: user.password });
    expect(login.body.status).toBe('mfa_required');
    const blocked = await other.get('/tenant/context');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');

    h.clock.advance(31_000);
    const code = totpNow(secret);
    expect((await other.post('/auth/mfa/verify', { code })).body.status).toBe('authenticated');
    expect((await other.get('/tenant/context')).status).toBe(200);

    // The same code cannot complete a second sign-in.
    const third = await h.client().init();
    await third.post('/auth/login', { email: user.email, password: user.password });
    expect((await third.post('/auth/mfa/verify', { code })).status).toBe(400);
    expect((await third.post('/auth/mfa/verify', { code: recoveryCodes[0] })).body.status).toBe('authenticated');

    const fourth = await h.client().init();
    await fourth.post('/auth/login', { email: user.email, password: user.password });
    expect((await fourth.post('/auth/mfa/verify', { code: recoveryCodes[0] })).status).toBe(400);
  });

  it('throttles wrong codes', async () => {
    const { user, client } = await signUp(h, 'mfathrottle');
    await enrol(client);
    const other = await h.client().init();
    await other.post('/auth/login', { email: user.email, password: user.password });
    for (let i = 0; i < 5; i += 1) await other.post('/auth/mfa/verify', { code: '000000' });
    const res = await other.post('/auth/mfa/verify', { code: '000000' });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('can be turned off with a valid code', async () => {
    const { client } = await signUp(h, 'mfaoff');
    const { secret } = await enrol(client);
    h.clock.advance(31_000);
    const res = await client.post('/auth/mfa/disable', { code: totpNow(secret) });
    expect(res.status).toBe(200);
    expect(res.body.user.mfaEnabled).toBe(false);
  });
});

describe('passwords (FR-AUTH-07)', () => {
  it('changing the password signs out other sessions', async () => {
    const { user, client } = await signUp(h, 'change');
    const other = await h.client().init();
    await other.post('/auth/login', { email: user.email, password: user.password });
    const wrong = await client.post('/auth/password/change', { currentPassword: 'not-my-password', newPassword: 'A-brand-new-passphrase' });
    expect(wrong.status).toBe(400);
    const res = await client.post('/auth/password/change', { currentPassword: user.password, newPassword: 'A-brand-new-passphrase' });
    expect(res.status).toBe(200);
    expect((await client.get('/tenant/context')).status).toBe(200);
    expect((await other.get('/tenant/context')).status).toBe(401);
  });

  it('resets by single-use email link and revokes every session', async () => {
    const { user, client } = await signUp(h, 'reset');
    const anon = await h.client().init();
    const requested = await anon.post('/auth/password/forgot', { email: user.email });
    const unknown = await anon.post('/auth/password/forgot', { email: 'nobody-here@example.test' });
    expect(requested.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(requested.body);

    const token = await tokenFromMail(h, user.email, 'reset-password');
    expect(h.mailer.sent.filter((m) => m.to === 'nobody-here@example.test')).toHaveLength(0);
    expect((await anon.post('/auth/password/reset', { token, newPassword: 'Another-new-passphrase' })).status).toBe(204);
    expect((await anon.post('/auth/password/reset', { token, newPassword: 'Yet-another-passphrase' })).status).toBe(404);
    expect((await client.get('/tenant/context')).status).toBe(401);

    const login = await anon.post('/auth/login', { email: user.email, password: 'Another-new-passphrase' });
    expect(login.status).toBe(200);
  });

  it('expires reset links after 30 minutes', async () => {
    const { user } = await signUp(h, 'resetexpiry');
    const anon = await h.client().init();
    await anon.post('/auth/password/forgot', { email: user.email });
    const token = await tokenFromMail(h, user.email, 'reset-password');
    h.clock.advance(31 * MINUTE);
    expect((await anon.post('/auth/password/reset', { token, newPassword: 'Another-new-passphrase' })).status).toBe(404);
  });
});

describe('logging (NFR, security.md §6)', () => {
  it('never logs passwords, session tokens, CSRF tokens or MFA secrets', async () => {
    const { user, client } = await signUp(h, 'logs');
    await client.post('/auth/login', { email: user.email, password: user.password });
    const setup = await client.post('/auth/mfa/totp/setup');
    const logs = h.logs();
    expect(logs).not.toContain(user.password);
    expect(logs).not.toContain(client.sessionCookie);
    expect(logs).not.toContain(client.csrf);
    expect(logs).not.toContain(setup.body.secret);
    expect(logs).not.toContain(user.email);
  });
});

describe('audit of security events (FR-AUD-01)', () => {
  it('records sign-in events against the user without secrets', async () => {
    const { user, userId } = await signUp(h, 'auditauth');
    const client = await h.client().init();
    await client.post('/auth/login', { email: user.email, password: 'wrong-password-1' });
    await client.post('/auth/login', { email: user.email, password: user.password });
    const events = await h.db.models.AuditEvent.find({ tenantId: null, subjectUserId: userId }).lean();
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['auth.login_failed', 'auth.login']));
    expect(JSON.stringify(events)).not.toContain(user.password);
    expect(events.every((e) => e.ipHash.length > 20 && !e.ipHash.includes('127.0.0.1'))).toBe(true);
  });
});
