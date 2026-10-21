import type { Query, Schema } from 'mongoose';

/** Query option that marks a deliberate cross-tenant read (e.g. listing a user's own memberships). */
export const CROSS_TENANT = 'crossTenantReason';

const QUERY_OPS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

/**
 * Defence in depth for tenant isolation (security.md §3): every query on a
 * tenant-owned model must filter on tenantId, and every aggregation must start
 * with a $match on tenantId. Repositories add the filter; this catches omissions.
 */
export function tenantScoped(schema: Schema): void {
  schema.pre([...QUERY_OPS], function (this: Query<unknown, unknown>) {
    const filter = this.getFilter();
    if (Object.hasOwn(filter, 'tenantId')) return;
    const reason = (this.getOptions() as Record<string, unknown>)[CROSS_TENANT];
    if (typeof reason === 'string' && reason.length > 0) return;
    throw new Error(`Unscoped query on tenant-owned model ${this.model.modelName}`);
  });
  schema.pre('aggregate', function () {
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!first?.$match || !Object.hasOwn(first.$match, 'tenantId')) {
      throw new Error('Aggregation on a tenant-owned model must start with $match on tenantId');
    }
  });
}

/** Append-only collections: updates and deletes through the model are refused. */
export function appendOnly(schema: Schema): void {
  const refuse = () => {
    throw new Error('This collection is append-only');
  };
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], refuse);
  schema.pre('save', function () {
    if (!this.isNew) refuse();
  });
}
