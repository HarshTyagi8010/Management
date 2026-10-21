import { Types } from 'mongoose';
import { AppError } from '../errors.js';

/**
 * Decimal strings (validated by the contracts) ↔ Decimal128. No JavaScript
 * number is ever involved, so values keep their exact digits (NFR-DAT-01).
 */
export const toDecimal = (value: string): Types.Decimal128 => Types.Decimal128.fromString(value);
export const toDecimalOrNull = (value: string | null | undefined): Types.Decimal128 | null => (value === null || value === undefined ? null : toDecimal(value));
export const fromDecimal = (value: Types.Decimal128 | null | undefined): string | null => (value === null || value === undefined ? null : value.toString());

/** Escapes user text for use inside a MongoDB $regex (search boxes). */
export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lower-cased, whitespace-collapsed key used for sorting and case-insensitive uniqueness. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Opaque keyset cursor over (sortKey, _id). */
export function encodeCursor(sortKey: string, id: Types.ObjectId): string {
  return Buffer.from(JSON.stringify([sortKey, id.toHexString()]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: Types.ObjectId } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string' && /^[0-9a-f]{24}$/.test(parsed[1])) {
      return { sortKey: parsed[0], id: new Types.ObjectId(parsed[1]) };
    }
  } catch {
    // fall through
  }
  throw new AppError('BAD_REQUEST', 'Invalid cursor');
}

/** Today's business date in IST (YYYY-MM-DD). */
export function todayIST(now = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

export const versionConflict = (what: string) => new AppError('VERSION_CONFLICT', `This ${what} was changed by someone else. Reload and try again.`);

export const isDuplicateKey = (err: unknown) => (err as { code?: number } | null)?.code === 11000;
