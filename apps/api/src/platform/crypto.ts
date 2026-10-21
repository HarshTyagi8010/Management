import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url (43 characters): session ids, CSRF seeds, single-use links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Unkeyed hash for high-entropy random tokens (session tokens, reset links, recovery codes). */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function hmac(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Purpose-specific keys derived from APP_SECRET with HKDF, so one leaked derived key
 * does not expose the others. Rotating APP_SECRET invalidates CSRF tokens, IP hashes
 * (they stop correlating) and MFA secrets (users must re-enrol) — see operations runbook.
 */
export interface Keyring {
  csrf: Buffer;
  /** Keyed hash for IP addresses and throttle keys stored in the database. */
  lookup: Buffer;
  /** AES-256-GCM key for secrets at rest (TOTP seeds). */
  data: Buffer;
}

export function deriveKeyring(secret: string): Keyring {
  const ikm = Buffer.from(secret, 'utf8');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', ikm, 'bizmgmt/v1', info, 32));
  return { csrf: derive('csrf'), lookup: derive('lookup'), data: derive('data-encryption') };
}

const CIPHER_VERSION = 'v1';

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url). `aad` binds the ciphertext to its owner. */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [CIPHER_VERSION, iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(key: Buffer, encoded: string, aad: string): Buffer {
  const [version, iv, tag, ciphertext] = encoded.split('.');
  if (version !== CIPHER_VERSION || !iv || !tag || ciphertext === undefined) throw new Error('Unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
}
