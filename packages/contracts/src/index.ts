export * from './errors.js';
export * from './primitives.js';
export * from './patch.js';
export * from './health.js';
export * from './permissions.js';
export * from './auth.js';
export * from './tenancy.js';
export * from './audit.js';
export * from './india.js';
export * from './organization.js';
export * from './catalogue.js';
export * from './parties.js';
export * from './inventory.js';
export * from './finance.js';
export * from './sales.js';
export * from './purchases.js';
export * from './payments.js';
export * from './compliance.js';

/** Paginated list envelope (docs/api/api-conventions.md "Lists"). */
export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; limit: number };
}

