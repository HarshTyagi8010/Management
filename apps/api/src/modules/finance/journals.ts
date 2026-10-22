import { trusted, Types, type ClientSession } from 'mongoose';
import { JOURNAL_SOURCE_TYPES, SYSTEM_ACCOUNTS, type Account, type Journal, type SystemAccountCode, type TrialBalance } from '@bizmgmt/contracts';
import { balanceJournal, consolidate, dec, money, pair, type JournalLineInput } from '@bizmgmt/domain';
import type { AccountDoc, JournalDoc, Models } from '../../models.js';
import { isDuplicateKey, toDecimal } from '../../platform/values.js';

export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];
type Lines = JournalPosting['lines'];
const debit = (account: SystemAccountCode, amount: string): Lines[number] => ({ account, debit: amount, credit: '0.00' });
const credit = (account: SystemAccountCode, amount: string): Lines[number] => ({ account, debit: '0.00', credit: amount });

export interface JournalPosting {
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  docDate: string;
  sourceType: JournalSourceType;
  sourceId: Types.ObjectId;
  sourceNumber: string;
  narration: string;
  lines: Array<JournalLineInput & { account: SystemAccountCode }>;
  actorId: Types.ObjectId;
  now: Date;
}

/**
 * Journal lines for stock movements (financial-policy §6, ADR-011). Values are
 * the signed changes in stock value; transfers between warehouses of one
 * entity change nothing in the books.
 */
export function stockJournalLines(movements: ReadonlyArray<{ kind: string; value: string }>): JournalPosting['lines'] {
  const lines: JournalPosting['lines'] = [];
  for (const m of movements) {
    if (m.kind === 'opening') lines.push(...(pair(m.value, '1300', '3100') as JournalPosting['lines']));
    else if (m.kind === 'adjust') lines.push(...(pair(m.value, '1300', '5300') as JournalPosting['lines']));
    // Negative-stock correction on the next receipt: the difference belongs to cost of goods sold.
    else if (m.kind === 'revalue') lines.push(...(pair(m.value, '1300', '5200') as JournalPosting['lines']));
  }
  return lines;
}

/** Cost of goods that left stock on a sale: cost of goods sold against inventory (financial-policy §6.3). */
export function cogsJournalLines(cost: string): Lines {
  return pair(cost, '5200', '1300') as Lines;
}

/**
 * A sales invoice (financial-policy §6.3, ADR-011): the customer owes the grand
 * total; sales are the taxable value; output tax is the tax charged on the
 * invoice (tax under reverse charge is the customer's to pay, so it is not
 * output tax here); the round-off goes to Rounding.
 */
export function salesInvoiceJournalLines(t: { grand: string; taxable: string; cgst: string; sgst: string; utgst: string; igst: string; cess: string; roundOff: string }): Lines {
  const round = dec(t.roundOff);
  return [
    debit('1200', t.grand),
    credit('4100', t.taxable),
    credit('2210', t.cgst),
    credit('2211', money(dec(t.sgst).plus(dec(t.utgst)))),
    credit('2212', t.igst),
    credit('2213', t.cess),
    ...(round.isPositive() ? [credit('4900', money(round))] : [debit('4900', money(round.abs()))]),
  ];
}

/**
 * A supplier bill (financial-policy §6.4, ADR-011): the business owes the supplier
 * the grand total (credit 2100 Trade payables); lines add to inventory (1300) or
 * expenses (5100); if eligible for ITC, input taxes go to 1410-1413; the round-off
 * goes to 4900 Rounding.
 */
export function supplierBillJournalLines(p: {
  grand: string;
  stockCost: string;
  nonStockCost: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  roundOff: string;
}): Lines {
  const round = dec(p.roundOff);
  return [
    credit('2100', p.grand),
    debit('1300', p.stockCost),
    debit('5100', p.nonStockCost),
    debit('1410', p.cgst),
    debit('1411', money(dec(p.sgst).plus(dec(p.utgst)))),
    debit('1412', p.igst),
    debit('1413', p.cess),
    ...(round.isPositive() ? [debit('4900', money(round))] : [credit('4900', money(round.abs()))]),
  ];
}

/**
 * Customer receipt (financial-policy §6.5): Dr 1100 Cash / 1110 Bank,
 * Cr 1200 Trade receivables (allocated), Cr 2300 Customer advances (unallocated).
 */
export function customerReceiptJournalLines(amount: string, method: string, allocated: string, advance: string): Lines {
  const cashOrBank = method === 'cash' ? '1100' : '1110';
  const lines: Lines = [debit(cashOrBank, amount)];
  if (!dec(allocated).isZero()) lines.push(credit('1200', allocated));
  if (!dec(advance).isZero()) lines.push(credit('2300', advance));
  return lines;
}

/**
 * Customer advance allocation to invoice (financial-policy §6.5):
 * Reclassifies advance liability to reduce trade receivables:
 * Dr 2300 Customer advances, Cr 1200 Trade receivables.
 */
export function customerAllocationJournalLines(amount: string): Lines {
  return [debit('2300', amount), credit('1200', amount)];
}

/**
 * Supplier disbursement (financial-policy §6.5): Dr 2100 Trade payables,
 * Cr 1100 Cash / 1110 Bank.
 */
export function supplierDisbursementJournalLines(amount: string, method: string): Lines {
  const cashOrBank = method === 'cash' ? '1100' : '1110';
  return [debit('2100', amount), credit(cashOrBank, amount)];
}

/**
 * Customer refund (financial-policy §6.5): Dr 2300 Customer advances,
 * Cr 1100 Cash / 1110 Bank.
 */
export function customerRefundJournalLines(amount: string, method: string): Lines {
  const cashOrBank = method === 'cash' ? '1100' : '1110';
  return [debit('2300', amount), credit(cashOrBank, amount)];
}

/**
 * Customer refund from Credit Note excess (financial-policy §6.5): Dr 1200 Trade receivables,
 * Cr 1100 Cash / 1110 Bank.
 */
export function creditNoteRefundJournalLines(amount: string, method: string): Lines {
  const cashOrBank = method === 'cash' ? '1100' : '1110';
  return [debit('1200', amount), credit(cashOrBank, amount)];
}

/**
 * Supplier refund from Debit Note excess (financial-policy §6.5): Dr 1100 Cash / 1110 Bank,
 * Cr 2100 Trade payables.
 */
export function debitNoteRefundJournalLines(amount: string, method: string): Lines {
  const cashOrBank = method === 'cash' ? '1100' : '1110';
  return [debit(cashOrBank, amount), credit('2100', amount)];
}

/**
 * Expense posting (financial-policy §6.5):
 * Dr 5400 Expenses, Dr 1410-1413 Input GST (if ITC eligible),
 * Cr 1100/1110 (if cash/bank) or Cr 2100 (if payable).
 */
export function expenseJournalLines(p: {
  amount: string;
  taxable: string;
  tax: string;
  itcEligible: boolean;
  paymentMode: string;
}): Lines {
  const crAccount = p.paymentMode === 'cash' ? '1100' : p.paymentMode === 'bank_transfer' ? '1110' : '2100';
  const lines: Lines = [credit(crAccount, p.amount)];
  if (p.itcEligible && !dec(p.tax).isZero()) {
    lines.push(debit('5400', p.taxable));
    // For general expenses without state breakdown, place ITC under Input CGST & SGST (split equally)
    const halfTax = money(dec(p.tax).dividedBy(2));
    lines.push(debit('1410', halfTax));
    lines.push(debit('1411', money(dec(p.tax).minus(dec(halfTax)))));
  } else {
    // If not ITC eligible, total amount capitalized into expense
    lines.push(debit('5400', p.amount));
  }
  return lines;
}

/**
 * Sales Credit Note (financial-policy §6.5):
 * Reverses sales revenue and output GST; reduces Trade receivables.
 */
export function creditNoteJournalLines(p: {
  grand: string;
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  roundOff: string;
}): Lines {
  const round = dec(p.roundOff);
  return [
    credit('1200', p.grand),
    debit('4100', p.taxable),
    debit('2210', p.cgst),
    debit('2211', money(dec(p.sgst).plus(dec(p.utgst)))),
    debit('2212', p.igst),
    debit('2213', p.cess),
    ...(round.isPositive() ? [debit('4900', money(round))] : [credit('4900', money(round.abs()))]),
  ];
}

/**
 * Sales return inventory effect:
 * Restores inventory asset and reverses Cost of Goods Sold.
 */
export function cogsReturnJournalLines(cost: string): Lines {
  return pair(cost, '1300', '5200') as Lines;
}

/**
 * Purchase Debit Note (financial-policy §6.5):
 * Reverses trade payables, inventory/purchases, and input GST.
 * If the original bill was ITC-ineligible (taxes capitalized), credits costAccount for full gross with zero tax lines.
 */
export function debitNoteJournalLines(p: {
  grand: string;
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  roundOff: string;
  isStock: boolean;
  itcEligible?: boolean;
}): Lines {
  const round = dec(p.roundOff);
  const costAccount = p.isStock ? '1300' : '5100';
  const itc = p.itcEligible ?? true;

  if (!itc) {
    const grossCost = money(dec(p.grand).minus(round));
    return [
      debit('2100', p.grand),
      credit(costAccount, grossCost),
      ...(round.isPositive() ? [credit('4900', money(round))] : [debit('4900', money(round.abs()))]),
    ];
  }

  return [
    debit('2100', p.grand),
    credit(costAccount, p.taxable),
    credit('1410', p.cgst),
    credit('1411', money(dec(p.sgst).plus(dec(p.utgst)))),
    credit('1412', p.igst),
    credit('1413', p.cess),
    ...(round.isPositive() ? [credit('4900', money(round))] : [debit('4900', money(round.abs()))]),
  ];
}


/** Chart of accounts and append-only, balanced journals (financial-policy §8, AC-JRN-1). */
export class JournalService {
  constructor(private readonly models: Models) {}

  /** Creates the system accounts of a business entity (idempotent). */
  async ensureAccounts(tenantId: Types.ObjectId, legalEntityId: Types.ObjectId, session?: ClientSession) {
    const existing = await this.models.Account.countDocuments({ tenantId, legalEntityId, system: true }, session ? { session } : {});
    if (existing >= SYSTEM_ACCOUNTS.length) return;
    const now = new Date();
    const docs = SYSTEM_ACCOUNTS.map(([code, name, type]) => ({ tenantId, legalEntityId, code, name, type, system: true, createdAt: now }));
    await this.models.Account.insertMany(docs, { ordered: false, ...(session ? { session } : {}) }).catch((err: unknown) => {
      if (!isDuplicateKey(err) && !(err as { writeErrors?: unknown[] }).writeErrors) throw err;
    });
  }

  /**
   * Posts one journal inside the caller's transaction. Lines are netted per
   * account and must balance (domain check); a posting with no amounts is skipped.
   */
  async post(session: ClientSession, p: JournalPosting): Promise<JournalDoc | null> {
    const balanced = balanceJournal(consolidate(p.lines));
    if (balanced.lines.length === 0) return null;
    const codes = balanced.lines.map((l) => l.account);
    const accounts = await this.models.Account.find({ tenantId: p.tenantId, legalEntityId: p.legalEntityId, code: trusted({ $in: codes }) }, { code: 1 }, { session }).lean();
    const idByCode = new Map(accounts.map((a) => [a.code, a._id]));
    const missing = codes.filter((c) => !idByCode.has(c));
    if (missing.length) throw new Error(`Accounts ${missing.join(', ')} are missing for this business entity; run ensureAccounts`);
    const doc: Omit<JournalDoc, '_id'> = {
      tenantId: p.tenantId,
      legalEntityId: p.legalEntityId,
      docDate: p.docDate,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      sourceNumber: p.sourceNumber,
      narration: p.narration,
      lines: balanced.lines.map((l) => ({ accountId: idByCode.get(l.account) as Types.ObjectId, accountCode: l.account, debit: toDecimal(l.debit), credit: toDecimal(l.credit) })),
      totalDebit: toDecimal(balanced.totalDebit),
      totalCredit: toDecimal(balanced.totalCredit),
      reversalOf: null,
      createdBy: p.actorId,
      createdAt: p.now,
    };
    const [created] = await this.models.Journal.create([doc], { session });
    return created ? (created.toObject() as JournalDoc) : null;
  }

  /**
   * Reverses the journal a document posted, inside the caller's transaction: a
   * mirror journal (debits and credits swapped) that points at the original.
   * Nothing is deleted (financial-policy §8). Returns null if the document
   * posted nothing.
   */
  async reverse(session: ClientSession, p: { tenantId: Types.ObjectId; sourceType: JournalSourceType; sourceId: Types.ObjectId; docDate: string; narration: string; actorId: Types.ObjectId; now: Date }): Promise<JournalDoc | null> {
    const original = await this.models.Journal.findOne({ tenantId: p.tenantId, sourceType: p.sourceType, sourceId: p.sourceId, reversalOf: null }, null, { session }).lean();
    if (!original) return null;
    const doc: Omit<JournalDoc, '_id'> = {
      tenantId: original.tenantId,
      legalEntityId: original.legalEntityId,
      docDate: p.docDate,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      sourceNumber: original.sourceNumber,
      narration: p.narration,
      lines: original.lines.map((l) => ({ accountId: l.accountId, accountCode: l.accountCode, debit: l.credit, credit: l.debit })),
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      reversalOf: original._id,
      createdBy: p.actorId,
      createdAt: p.now,
    };
    try {
      const [created] = await this.models.Journal.create([doc], { session });
      return created ? (created.toObject() as JournalDoc) : null;
    } catch (err) {
      // The unique source key: this journal was already reversed.
      if (isDuplicateKey(err)) throw new Error(`Journal ${original._id.toHexString()} is already reversed`, { cause: err });
      throw err;
    }
  }

  private async accountsOf(tenantId: Types.ObjectId, legalEntityId: Types.ObjectId): Promise<AccountDoc[]> {
    return this.models.Account.find({ tenantId, legalEntityId }).sort({ code: 1 }).lean();
  }

  async listAccounts(tenantId: Types.ObjectId, legalEntityId: Types.ObjectId): Promise<Account[]> {
    return (await this.accountsOf(tenantId, legalEntityId)).map((a) => ({ id: a._id.toHexString(), legalEntityId: a.legalEntityId.toHexString(), code: a.code, name: a.name, type: a.type, system: a.system }));
  }

  async listJournals(tenantId: Types.ObjectId, query: { legalEntityId: string; sourceId?: string | undefined; sourceType?: string | undefined; limit: number; cursor?: string | undefined }) {
    const legalEntityId = new Types.ObjectId(query.legalEntityId);
    const filter: Record<string, unknown> = { tenantId, legalEntityId };
    if (query.sourceId) filter.sourceId = new Types.ObjectId(query.sourceId);
    if (query.sourceType) filter.sourceType = query.sourceType;
    if (query.cursor) filter._id = trusted({ $lt: new Types.ObjectId(query.cursor) });
    const found = await this.models.Journal.find(filter).sort({ _id: -1 }).limit(query.limit + 1).lean();
    const rows = found.slice(0, query.limit);
    const names = new Map((await this.accountsOf(tenantId, legalEntityId)).map((a) => [a.code, a.name]));
    const data: Journal[] = rows.map((j) => ({
      id: j._id.toHexString(),
      legalEntityId: j.legalEntityId.toHexString(),
      docDate: j.docDate,
      sourceType: j.sourceType as Journal['sourceType'],
      sourceId: j.sourceId.toHexString(),
      sourceNumber: j.sourceNumber,
      narration: j.narration,
      lines: j.lines.map((l) => ({ accountCode: l.accountCode, accountName: names.get(l.accountCode) ?? l.accountCode, debit: l.debit.toString(), credit: l.credit.toString() })),
      totalDebit: j.totalDebit.toString(),
      totalCredit: j.totalCredit.toString(),
      reversal: j.reversalOf !== null,
      reversedJournalId: j.reversalOf ? j.reversalOf.toHexString() : null,
      createdAt: j.createdAt.toISOString(),
    }));
    return { data, page: { nextCursor: found.length > query.limit ? (rows.at(-1)?._id.toHexString() ?? null) : null, limit: query.limit } };
  }

  /** Balances per account up to a date (internal books; not a statutory statement: ADR-011). */
  async trialBalance(tenantId: Types.ObjectId, legalEntityId: Types.ObjectId, asOf: string): Promise<TrialBalance> {
    const rows = await this.models.Journal.aggregate<{ _id: string; debit: unknown; credit: unknown }>([
      { $match: { tenantId, legalEntityId, docDate: { $lte: asOf } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.accountCode', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const sums = new Map(rows.map((r) => [r._id, dec(String(r.debit ?? '0')).minus(dec(String(r.credit ?? '0')))]));
    let totalDebit = dec('0');
    let totalCredit = dec('0');
    const out = (await this.accountsOf(tenantId, legalEntityId)).flatMap((a) => {
      const net = sums.get(a.code);
      if (!net || net.isZero()) return [];
      const debit = net.isPositive() ? net : dec('0');
      const credit = net.isNegative() ? net.abs() : dec('0');
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);
      return [{ code: a.code, name: a.name, type: a.type, debit: money(debit), credit: money(credit) }];
    });
    return { legalEntityId: legalEntityId.toHexString(), asOf, rows: out, totalDebit: money(totalDebit), totalCredit: money(totalCredit) };
  }
}

export interface JournalIssue {
  kind: 'unbalanced' | 'totals_mismatch' | 'bad_line' | 'inventory_mismatch';
  legalEntityId: Types.ObjectId;
  journalId: Types.ObjectId | null;
  detail: string;
}

/**
 * AC-JRN-1 reconciliation: every journal balances and matches its stored
 * totals, every line is one-sided and non-negative, and the inventory control
 * account equals the stock valuation of each business entity.
 */
export async function reconcileJournals(models: Models, tenantId: Types.ObjectId): Promise<{ journalsChecked: number; issues: JournalIssue[] }> {
  const issues: JournalIssue[] = [];
  let journalsChecked = 0;
  const inventoryByEntity = new Map<string, ReturnType<typeof dec>>();
  const cursor = models.Journal.find({ tenantId }, { legalEntityId: 1, lines: 1, totalDebit: 1, totalCredit: 1 }).lean().cursor();
  for await (const j of cursor) {
    journalsChecked += 1;
    let debit = dec('0');
    let credit = dec('0');
    for (const l of j.lines) {
      const d = dec(l.debit.toString());
      const c = dec(l.credit.toString());
      if (d.isNegative() || c.isNegative() || (!d.isZero() && !c.isZero())) issues.push({ kind: 'bad_line', legalEntityId: j.legalEntityId, journalId: j._id, detail: `Line on ${l.accountCode} is negative or two-sided` });
      debit = debit.plus(d);
      credit = credit.plus(c);
      if (l.accountCode === '1300') {
        const k = j.legalEntityId.toHexString();
        inventoryByEntity.set(k, (inventoryByEntity.get(k) ?? dec('0')).plus(d).minus(c));
      }
    }
    if (!debit.eq(credit)) issues.push({ kind: 'unbalanced', legalEntityId: j.legalEntityId, journalId: j._id, detail: `Debit ${money(debit)} ≠ credit ${money(credit)}` });
    if (!debit.eq(dec(j.totalDebit.toString())) || !credit.eq(dec(j.totalCredit.toString()))) issues.push({ kind: 'totals_mismatch', legalEntityId: j.legalEntityId, journalId: j._id, detail: 'Stored totals differ from the lines' });
  }
  const valuations = await models.ItemValuation.aggregate<{ _id: Types.ObjectId; value: unknown }>([{ $match: { tenantId } }, { $group: { _id: '$legalEntityId', value: { $sum: '$value' } } }]);
  const entities = new Set([...inventoryByEntity.keys(), ...valuations.map((v) => v._id.toHexString())]);
  for (const id of entities) {
    const books = inventoryByEntity.get(id) ?? dec('0');
    const stock = dec(String(valuations.find((v) => v._id.toHexString() === id)?.value ?? '0'));
    if (!books.eq(stock)) issues.push({ kind: 'inventory_mismatch', legalEntityId: new Types.ObjectId(id), journalId: null, detail: `Inventory account ${money(books)} ≠ stock valuation ${money(stock)}` });
  }
  return { journalsChecked, issues };
}
