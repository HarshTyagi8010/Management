import argon2 from 'argon2';

/**
 * Argon2id (ADR-007). "standard" was benchmarked on the development machine at
 * ~125 ms per verification (m=64 MiB, t=2, p=1); re-benchmark on production hardware.
 * "test" is a fast profile that config only allows when NODE_ENV=test.
 */
const PROFILES = {
  standard: { memoryCost: 65_536, timeCost: 2, parallelism: 1 },
  test: { memoryCost: 4_096, timeCost: 1, parallelism: 1 },
} as const;

/** Each hash holds 64 MiB; capping concurrency bounds memory under a login flood. */
const MAX_CONCURRENT_HASHES = 4;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** Spends the same work as a real verification; used when the account does not exist. */
  verifyDummy(password: string): Promise<void>;
  needsRehash(hash: string): boolean;
}

function semaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finishing task hands its slot directly to the next waiter, so `active` never exceeds `limit`.
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export async function createPasswordHasher(profile: keyof typeof PROFILES): Promise<PasswordHasher> {
  const options = { type: argon2.argon2id as 2, ...PROFILES[profile] };
  const limit = semaphore(MAX_CONCURRENT_HASHES);
  const dummyHash = await argon2.hash('dummy password for timing equalisation', options);
  return {
    hash: (password) => limit(() => argon2.hash(password, options)),
    verify: (hash, password) => limit(() => argon2.verify(hash, password).catch(() => false)),
    verifyDummy: async (password) => {
      await limit(() => argon2.verify(dummyHash, password).catch(() => false));
    },
    needsRehash: (hash) => argon2.needsRehash(hash, options),
  };
}

/**
 * Passwords that meet the length rule but appear in public breach and "most common"
 * lists. Short passwords are already rejected by length. Compared case-insensitively.
 */
const COMMON_LONG_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789123',
  '111111111111',
  '000000000000',
  '123123123123',
  '987654321098',
  'qwertyuiop12',
  'qwertyuiop123',
  'qwertyuiopasdfgh',
  '1q2w3e4r5t6y',
  '1qaz2wsx3edc',
  'qazwsxedcrfv',
  'zaq12wsxcde3',
  'asdfghjkl123',
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'password@1234',
  'password@123',
  'p@ssw0rd1234',
  'p@ssword1234',
  'iloveyou1234',
  'welcome12345',
  'welcome@1234',
  'administrator',
  'admin1234567',
  'admin@123456',
  'letmein12345',
  'changeme1234',
  'abcdefghijkl',
  'abcd12345678',
  'abc123456789',
  'india1234567',
  'india@123456',
  'bharat123456',
  'qwerty123456',
  'qwerty@12345',
  'superman1234',
  'football1234',
  'baseball1234',
  'monkey123456',
  'sunshine1234',
  'princess1234',
  'starwars1234',
  'whatever1234',
  'trustno11234',
  'correcthorsebatterystaple',
]);

/** Returns a user-facing reason the password is unacceptable, or undefined. Length is checked by the schema. */
export function passwordProblem(password: string, context: { email: string; name?: string }): string | undefined {
  const lower = password.toLowerCase();
  if (COMMON_LONG_PASSWORDS.has(lower)) return 'This password is too common. Choose something harder to guess.';
  if (/^(.)\1+$/u.test(password)) return 'Do not repeat a single character.';
  const local = context.email.split('@')[0] ?? '';
  if (lower === context.email || (local.length >= 4 && lower.includes(local))) return 'Do not use your email address in your password.';
  if (context.name && context.name.trim().length >= 4 && lower === context.name.trim().toLowerCase()) return 'Do not use your name as your password.';
  return undefined;
}
