import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { parseCookies, stepUpSatisfied } from './middleware/auth.js';
import type { Authenticated } from './modules/identity/identity.js';
import { passwordProblem } from './modules/identity/passwords.js';
import { base32Decode, base32Encode, generateRecoveryCodes, hotp, otpauthUri, verifyTotp } from './modules/identity/totp.js';
import { decrypt, deriveKeyring, encrypt, safeEqual } from './platform/crypto.js';

describe('TOTP (RFC 6238 Appendix B test vectors)', () => {
  // The RFC uses 8 digits and per-algorithm ASCII seeds.
  const seeds = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(vectors)('T=%i', (seconds, sha1, sha256, sha512) => {
    const counter = Math.floor(seconds / 30);
    expect(hotp(seeds.sha1, counter, 8, 'sha1')).toBe(sha1);
    expect(hotp(seeds.sha256, counter, 8, 'sha256')).toBe(sha256);
    expect(hotp(seeds.sha512, counter, 8, 'sha512')).toBe(sha512);
  });

  it('accepts ±1 step of drift and rejects replays', () => {
    const secret = seeds.sha1;
    const at = new Date(1_111_111_111_000);
    const step = Math.floor(1_111_111_111 / 30);
    expect(verifyTotp(secret, hotp(secret, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), at)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step + 2), at)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step), at, step)).toBeNull();
    expect(verifyTotp(secret, '12345', at)).toBeNull();
  });

  it('round-trips base32 (RFC 4648) and builds an otpauth URI', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(otpauthUri(Buffer.from('foobar'), 'a@example.test', 'BizMgmt')).toBe(
      'otpauth://totp/BizMgmt:a%40example.test?secret=MZXW6YTBOI&issuer=BizMgmt&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('generates ten distinct recovery codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  });
});

describe('encryption at rest', () => {
  const keys = deriveKeyring('unit-test-secret-0123456789abcdefghij');

  it('derives distinct purpose keys', () => {
    expect(keys.csrf.equals(keys.lookup)).toBe(false);
    expect(keys.data.equals(keys.csrf)).toBe(false);
  });

  it('round-trips and detects tampering or a different owner', () => {
    const sealed = encrypt(keys.data, Buffer.from('totp seed'), 'totp:user1');
    expect(decrypt(keys.data, sealed, 'totp:user1').toString()).toBe('totp seed');
    expect(() => decrypt(keys.data, sealed, 'totp:user2')).toThrow();
    const [v, iv, tag, ct] = sealed.split('.');
    const flipped = `${v}.${iv}.${tag}.${ct?.startsWith('A') ? `B${ct.slice(1)}` : `A${ct?.slice(1)}`}`;
    expect(() => decrypt(keys.data, flipped, 'totp:user1')).toThrow();
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('password policy', () => {
  const ctx = { email: 'asha.verma@example.test', name: 'Asha Verma' };
  it.each([
    ['password1234', /too common/],
    ['aaaaaaaaaaaaaa', /repeat/],
    ['my-asha.verma-pass', /email/],
    ['asha verma', /name/],
  ])('rejects %s', (password, reason) => {
    expect(passwordProblem(password, ctx)).toMatch(reason);
  });
  it('accepts a passphrase', () => {
    expect(passwordProblem('tea-garden-monsoon-42', ctx)).toBeUndefined();
  });
});

describe('cookies and step-up', () => {
  it('parses cookies and keeps the first of duplicate names', () => {
    const cookies = parseCookies('__Host-sid=abc; theme=dark; __Host-sid=evil; broken');
    expect(cookies.get('__Host-sid')).toBe('abc');
    expect(cookies.get('theme')).toBe('dark');
    expect(cookies.has('broken')).toBe(false);
  });

  const auth = (mfaEnabled: boolean, verifiedMinutesAgo: number | null): Authenticated =>
    ({
      user: { mfaEnabled },
      session: { mfaVerifiedAt: verifiedMinutesAgo === null ? null : new Date(Date.now() - verifiedMinutesAgo * 60_000), _id: new Types.ObjectId() },
    }) as unknown as Authenticated;

  it('requires a recent code for MFA users and enrolment when enforced', () => {
    expect(stepUpSatisfied(auth(true, 5), 'off')).toBe('ok');
    expect(stepUpSatisfied(auth(true, 16), 'off')).toBe('verify');
    expect(stepUpSatisfied(auth(true, null), 'privileged')).toBe('verify');
    expect(stepUpSatisfied(auth(false, null), 'privileged')).toBe('enrol');
    expect(stepUpSatisfied(auth(false, null), 'off')).toBe('ok');
  });
});
