import { Types } from 'mongoose';
import { AGEING_BUCKETS, type AgeingBucket, type Receivables } from '@bizmgmt/contracts';
import { ageing, dec, money, type Dec } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { Models } from '../../models.js';
import { todayIST } from '../../platform/values.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';

const LIMIT = 500;

/**
 * Receivables (FR-SAL-09): outstanding per issued invoice, with ageing buckets
 * by due date, and per customer. Until receipts and allocations exist
 * (Phase 9) an invoice's outstanding is its grand total.
 */
export async function receivables(models: Models, ctx: TenantContext, query: { legalEntityId: string; asOf?: string | undefined; partyId?: string | undefined }, now: Date): Promise<Receivables> {
  if (!canInEntity(ctx, 'report.sales', query.legalEntityId) && !canInEntity(ctx, 'report.financial', query.legalEntityId)) throw new AppError('NOT_FOUND', 'Business entity not found');
  const legalEntityId = new Types.ObjectId(query.legalEntityId);
  if (!(await models.LegalEntity.exists({ tenantId: ctx.tenantId, _id: legalEntityId }))) throw new AppError('NOT_FOUND', 'Business entity not found');
  const asOf = query.asOf ?? todayIST(now);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId, legalEntityId, status: 'issued' };
  if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
  const rows = await models.SalesInvoice.find(filter, { number: 1, docDate: 1, dueDate: 1, partyId: 1, partyName: 1, totals: 1, outstanding: 1 })
    .sort({ dueDate: 1, _id: 1 })
    .limit(LIMIT + 1)
    .lean();

  const zero = () => dec('0');
  const buckets = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, zero()])) as Record<AgeingBucket, Dec>;
  const parties = new Map<string, { partyName: string; invoices: number; outstanding: Dec; overdue: Dec }>();
  let total = zero();
  let overdue = zero();
  const invoices: Receivables['invoices'] = [];
  for (const r of rows.slice(0, LIMIT)) {
    const open = dec(r.outstanding?.toString() ?? '0');
    if (open.isZero() || !r.number) continue;
    // Invoices issued after the as-of date are not yet receivable on that date.
    if (r.docDate > asOf) continue;
    const due = r.dueDate ?? r.docDate;
    const age = ageing(due, asOf);
    buckets[age.bucket] = buckets[age.bucket].plus(open);
    total = total.plus(open);
    if (age.bucket !== 'not_due') overdue = overdue.plus(open);
    const key = r.partyId.toHexString();
    const p = parties.get(key) ?? { partyName: r.partyName, invoices: 0, outstanding: zero(), overdue: zero() };
    p.invoices += 1;
    p.outstanding = p.outstanding.plus(open);
    if (age.bucket !== 'not_due') p.overdue = p.overdue.plus(open);
    parties.set(key, p);
    invoices.push({ invoiceId: r._id.toHexString(), number: r.number, docDate: r.docDate, dueDate: due, partyId: key, partyName: r.partyName, grand: r.totals.grand.toString(), outstanding: money(open), daysOverdue: age.daysOverdue, bucket: age.bucket });
  }
  return {
    legalEntityId: query.legalEntityId,
    asOf,
    total: money(total),
    overdue: money(overdue),
    buckets: Object.fromEntries(AGEING_BUCKETS.map((b) => [b, money(buckets[b])])) as Receivables['buckets'],
    invoices,
    parties: [...parties.entries()]
      .map(([partyId, p]) => ({ partyId, partyName: p.partyName, invoices: p.invoices, outstanding: money(p.outstanding), overdue: money(p.overdue) }))
      .sort((a, b) => dec(b.outstanding).comparedTo(dec(a.outstanding)) || a.partyName.localeCompare(b.partyName)),
    truncated: rows.length > LIMIT,
  };
}
