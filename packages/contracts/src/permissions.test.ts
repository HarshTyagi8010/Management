import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emailSchema, passwordSchema } from './auth.js';
import { PERMISSIONS, STEP_UP_PERMISSIONS, SYSTEM_ROLE_KEYS, SYSTEM_ROLE_PERMISSIONS } from './permissions.js';
import { roleCreateRequestSchema } from './tenancy.js';

const MATRIX_DOC = path.resolve(import.meta.dirname, '../../../docs/security/permission-matrix.md');

/** Parses the matrix table: rows starting with "| `permission`". */
function parseMatrixDoc(): Map<string, boolean[]> {
  const rows = new Map<string, boolean[]>();
  for (const line of readFileSync(MATRIX_DOC, 'utf8').split(/\r?\n/)) {
    const match = /^\| `([a-z_.]+)`[^|]*\|(.*)\|\s*$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const cells = match[2].split('|').map((c) => c.trim());
    rows.set(
      match[1],
      cells.map((c) => {
        if (c === '●') return true;
        if (c === '○') return false;
        throw new Error(`Unexpected cell "${c}" for ${match[1]}`);
      }),
    );
  }
  return rows;
}

describe('permission matrix', () => {
  const doc = parseMatrixDoc();

  it('lists exactly the permissions defined in code', () => {
    expect([...doc.keys()].sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(PERMISSIONS)('%s: system role grants match the document', (permission) => {
    const expected = doc.get(permission);
    const actual = SYSTEM_ROLE_KEYS.map((role) => SYSTEM_ROLE_PERMISSIONS[role].includes(permission));
    expect(actual).toEqual(expected);
  });

  it('gives the owner every permission and reserves tenant.manage to the owner', () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
    for (const role of SYSTEM_ROLE_KEYS.filter((r) => r !== 'owner')) {
      expect(SYSTEM_ROLE_PERMISSIONS[role]).not.toContain('tenant.manage');
    }
  });

  it('only references known permissions and has no duplicates', () => {
    for (const role of SYSTEM_ROLE_KEYS) {
      const list = SYSTEM_ROLE_PERMISSIONS[role];
      expect(new Set(list).size).toBe(list.length);
      for (const p of list) expect(PERMISSIONS).toContain(p);
    }
    for (const p of STEP_UP_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });
});

describe('auth and role schemas', () => {
  it('normalises email', () => {
    expect(emailSchema.parse('  Asha@Example.COM ')).toBe('asha@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('counts password length in code points', () => {
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
    // 12 Devanagari characters are 12 code points.
    expect(passwordSchema.safeParse('नमस्ते'.repeat(2)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('rejects unknown and duplicate permissions in custom roles', () => {
    expect(roleCreateRequestSchema.safeParse({ name: 'Cashier', permissions: ['receipt.post'] }).success).toBe(true);
    expect(roleCreateRequestSchema.safeParse({ name: 'Cashier', permissions: ['root'] }).success).toBe(false);
    expect(roleCreateRequestSchema.safeParse({ name: 'Cashier', permissions: ['receipt.post', 'receipt.post'] }).success).toBe(false);
    expect(roleCreateRequestSchema.safeParse({ name: 'Cashier', permissions: [], system: true }).success).toBe(false);
  });
});
