import { Types } from 'mongoose';

/**
 * Diagnostic logic to audit database records for financial and stock inconsistencies:
 * - Negative payment/refund balances
 * - Missing COGS/Inventory return journals
 * - Excess return quantities
 * - Unlinked excess credit records
 */
export async function runFinancialDiagnostic(db) {
  const cutoff = new Date().toISOString();

  // Tenancy & entity scope
  const tenants = await db.collection('tenants').find({}).toArray();
  const legalEntities = await db.collection('legalentities').find({}).toArray();

  // Document counts
  const invoicesCount = await db.collection('salesinvoices').countDocuments({});
  const billsCount = await db.collection('supplierbills').countDocuments({});
  const paymentsCount = await db.collection('payments').countDocuments({});
  const creditNotesCount = await db.collection('creditnotes').countDocuments({});
  const debitNotesCount = await db.collection('debitnotes').countDocuments({});
  const refundsCount = await db.collection('refunds').countDocuments({});
  const journalsCount = await db.collection('journals').countDocuments({});

  const issues = [];

  // 1. Negative refundable / unallocated balances
  const negativePayments = await db.collection('payments').find({
    $expr: { $lt: [{ $toDouble: '$unallocatedAmount' }, 0] },
  }).toArray();
  for (const p of negativePayments) {
    issues.push({
      kind: 'negative_payment_balance',
      id: p._id.toString(),
      detail: `Payment ${p.number} has negative unallocatedAmount: ${p.unallocatedAmount}`,
    });
  }

  // 2. Missing COGS/Inventory journal lines on sales return credit notes
  const creditNotes = await db.collection('creditnotes').find({
    kind: 'sales_return',
    status: 'issued',
  }).toArray();
  for (const cn of creditNotes) {
    if (cn.lines?.some((l) => l.itemId)) {
      const journal = await db.collection('journals').findOne({
        sourceType: 'credit_note',
        sourceId: cn._id,
      });
      const has1300 = journal?.lines?.some((l) => l.accountCode === '1300');
      const has5200 = journal?.lines?.some((l) => l.accountCode === '5200');
      if (!has1300 || !has5200) {
        issues.push({
          kind: 'missing_cogs_return_journal',
          id: cn._id.toString(),
          detail: `Credit Note ${cn.number} missing 1300 or 5200 lines in journal ${journal?._id}`,
        });
      }
    }
  }

  // 3. Excess return quantities (credit/debit notes exceeding invoice/bill line quantities)
  for (const cn of creditNotes) {
    if (!cn.salesInvoiceId) continue;
    const inv = await db.collection('salesinvoices').findOne({ _id: cn.salesInvoiceId });
    if (!inv) continue;
    for (const l of cn.lines) {
      if (!l.qty) continue;
      const invLine = inv.lines?.find((il) => il.lineId === l.sourceLineId || (il.itemId && l.itemId && il.itemId.toString() === l.itemId.toString()));
      if (invLine && Number(l.qty?.toString?.() ?? l.qty) > Number(invLine.qty?.toString?.() ?? invLine.qty)) {
        issues.push({
          kind: 'excess_return_qty',
          id: cn._id.toString(),
          detail: `Credit Note ${cn.number} returns ${l.qty} which exceeds invoice line qty ${invLine.qty}`,
        });
      }
    }
  }

  // 4. Inconsistent unallocated credit records
  const excessCredits = await db.collection('payments').find({
    recordKind: { $in: ['credit_note_excess', 'debit_note_excess'] },
  }).toArray();
  for (const ec of excessCredits) {
    if (!ec.sourceNoteId) {
      issues.push({
        kind: 'unlinked_excess_credit',
        id: ec._id.toString(),
        detail: `Excess credit ${ec.number} has no sourceNoteId linkage`,
      });
    }
  }

  return {
    cutoff,
    scope: {
      tenantsCount: tenants.length,
      legalEntitiesCount: legalEntities.length,
      invoicesCount,
      billsCount,
      paymentsCount,
      creditNotesCount,
      debitNotesCount,
      refundsCount,
      journalsCount,
    },
    issuesCount: issues.length,
    issues,
  };
}
