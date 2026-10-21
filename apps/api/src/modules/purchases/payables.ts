import { trusted, Types } from 'mongoose';
import type { PayablesSummary, PayableItem } from '@bizmgmt/contracts';
import { ageing, dec, money, type Dec } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { Models, SupplierBillDoc } from '../../models.js';
import { todayIST } from '../../platform/values.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';
import { visibleEntityFilter } from './core.js';

const LIMIT = 500;

export async function payables(
  models: Models,
  ctx: TenantContext,
  query: { legalEntityId?: string | undefined; supplierId?: string | undefined; asOf?: string | undefined },
  now: Date = new Date(),
): Promise<PayablesSummary> {
  const asOf = query.asOf ?? todayIST(now);

  const filter: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    status: 'posted',
    paymentStatus: trusted({ $ne: 'paid' }),
    ...visibleEntityFilter(ctx, 'report.financial', query.legalEntityId),
  };

  if (query.supplierId) {
    filter.supplierId = new Types.ObjectId(query.supplierId);
  }

  const rows = ((await models.SupplierBill.find(filter)
    .sort({ dueDate: 1, _id: 1 })
    .limit(LIMIT + 1)
    .lean()) as unknown) as SupplierBillDoc[];

  const zero = () => dec('0');
  const buckets: Record<'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'over_90', Dec> = {
    not_due: zero(),
    d1_30: zero(),
    d31_60: zero(),
    d61_90: zero(),
    over_90: zero(),
  };

  let totalOutstanding = zero();
  const bills: PayableItem[] = [];

  for (const r of rows.slice(0, LIMIT)) {
    const open = dec(r.outstanding?.toString() ?? '0');
    if (open.isZero() || !r.number) continue;
    if (r.docDate > asOf) continue;

    const due = r.dueDate ?? r.docDate;
    const age = ageing(due, asOf);

    buckets[age.bucket] = buckets[age.bucket].plus(open);
    totalOutstanding = totalOutstanding.plus(open);

    bills.push({
      id: r._id.toHexString(),
      billNumber: r.number,
      supplierInvoiceNumber: r.supplierInvoiceNumber,
      supplierInvoiceDate: r.supplierInvoiceDate,
      docDate: r.docDate,
      dueDate: due,
      supplierId: r.supplierId.toHexString(),
      supplierName: r.supplierName,
      grandTotal: r.totals?.grand?.toString() ?? '0.00',
      outstanding: money(open),
      daysOverdue: age.daysOverdue,
      ageingBucket: age.bucket,
    });
  }

  return {
    totalOutstanding: money(totalOutstanding),
    notDue: money(buckets.not_due),
    bucket1_30: money(buckets.d1_30),
    bucket31_60: money(buckets.d31_60),
    bucket61_90: money(buckets.d61_90),
    bucketOver90: money(buckets.over_90),
    bills,
  };
}
