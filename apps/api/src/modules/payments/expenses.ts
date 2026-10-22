import { Types, trusted } from 'mongoose';
import type {
  CreateExpenseInput,
  ExpenseListQuery,
  ExpenseResponse,
} from '@bizmgmt/contracts';
import { dec, money } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { ExpenseDoc } from '../../models.js';
import { fromDecimal, toDecimal, todayIST } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';
import {
  forbidden,
  invalidState,
  mapExpenseResponse,
  notFound,
  recordAudit,
  rule,
  type PaymentServices,
} from './core.js';
import { expenseJournalLines } from '../finance/journals.js';

export class ExpenseService {
  constructor(private readonly deps: PaymentServices) {}

  private get models() {
    return this.deps.models;
  }
  private get audit() {
    return this.deps.audit;
  }
  private get journals() {
    return this.deps.journals;
  }

  async createDraft(ctx: TenantContext, input: CreateExpenseInput, meta: any): Promise<ExpenseResponse> {
    if (!ctx.permissions.has('expense.post') && !canInEntity(ctx, 'expense.post', input.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    // Duplicate check if reference is provided
    if (input.reference) {
      const existing = await this.models.Expense.findOne({
        tenantId: ctx.tenantId,
        legalEntityId: entity._id,
        reference: input.reference,
        status: trusted({ $in: ['draft', 'posted'] }),
      }).lean();
      if (existing) {
        throw new AppError('DUPLICATE', `Expense with reference "${input.reference}" already exists`, [
          { path: 'reference', message: 'Duplicate reference' },
        ]);
      }
    }

    let taxableAmt = dec(input.amount);
    let taxAmt = dec('0');
    if (input.taxRate && !dec(input.taxRate).isZero()) {
      const rate = dec(input.taxRate);
      // Tax-inclusive breakdown: taxable = amount / (1 + rate/100)
      const factor = dec('1').plus(rate.dividedBy(100));
      taxableAmt = dec(input.amount).dividedBy(factor);
      taxAmt = dec(input.amount).minus(taxableAmt);
    }

    const expense = await this.models.Expense.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      number: null,
      category: input.category,
      description: input.description,
      docDate: input.docDate,
      amount: toDecimal(input.amount),
      taxableAmount: toDecimal(money(taxableAmt)),
      taxAmount: toDecimal(money(taxAmt)),
      taxRate: input.taxRate ? toDecimal(input.taxRate) : null,
      itcEligible: input.itcEligible ?? false,
      payeeName: input.payeeName ?? null,
      paymentMode: input.paymentMode,
      reference: input.reference ?? null,
      notes: input.notes ?? '',
      status: 'draft',
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'expense.created',
      entityType: 'expense',
      entityId: expense._id.toHexString(),
      summary: `Created expense draft for ${input.category}: ₹${input.amount}`,
    });

    return mapExpenseResponse(expense);
  }

  async get(ctx: TenantContext, id: string): Promise<ExpenseResponse> {
    const expense = await this.models.Expense.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!expense) throw notFound('Expense');
    return mapExpenseResponse(expense);
  }

  async list(ctx: TenantContext, query: ExpenseListQuery): Promise<{ data: ExpenseResponse[]; page: { nextCursor: string | null; limit: number } }> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.category) filter.category = query.category;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      filter.docDate = {};
      if (query.from) (filter.docDate as any).$gte = query.from;
      if (query.to) (filter.docDate as any).$lte = query.to;
    }
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 25, 100);
    const docs = await this.models.Expense.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toHexString() ?? null : null;

    return {
      data: pageDocs.map(mapExpenseResponse),
      page: { nextCursor, limit },
    };
  }

  async post(ctx: TenantContext, id: string, meta: any): Promise<ExpenseResponse> {
    const expense = await this.models.Expense.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!expense) throw notFound('Expense');
    if (expense.status !== 'draft') throw invalidState('Only draft expenses can be posted');

    if (!ctx.permissions.has('expense.post') && !canInEntity(ctx, 'expense.post', expense.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: expense.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && expense.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    return await withTransaction(this.models.Expense.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: expense.legalEntityId, docDate: expense.docDate, models: this.models });
      const count = await this.models.Expense.countDocuments({ tenantId: ctx.tenantId }, { session });
      const expenseNumber = `EXP/${expense.docDate.slice(0, 4)}/${String(count + 1).padStart(4, '0')}`;
      expense.number = expenseNumber;

      const amt = fromDecimal(expense.amount) ?? '0.00';
      const taxable = fromDecimal(expense.taxableAmount) ?? amt;
      const tax = fromDecimal(expense.taxAmount) ?? '0.00';

      const lines = expenseJournalLines({
        amount: amt,
        taxable,
        tax,
        itcEligible: expense.itcEligible,
        paymentMode: expense.paymentMode,
      });

      await this.journals.ensureAccounts(ctx.tenantId, expense.legalEntityId, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: expense.legalEntityId,
        docDate: expense.docDate,
        sourceType: 'expense',
        sourceId: expense._id,
        sourceNumber: expenseNumber,
        narration: `Expense ${expenseNumber} (${expense.category}): ${expense.description}`,
        lines,
        actorId: ctx.userId,
        now: new Date(),
      });

      expense.status = 'posted';
      expense.postedAt = new Date();
      expense.postedBy = ctx.userId;
      expense.version += 1;

      await expense.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'expense.posted',
          entityType: 'expense',
          entityId: expense._id.toHexString(),
          summary: `Posted expense ${expenseNumber} for ${expense.category}: ₹${amt}`,
        },
        session,
      );

      return mapExpenseResponse(expense);
    });
  }

  async cancel(ctx: TenantContext, id: string, reason: string, meta: any): Promise<ExpenseResponse> {
    const expense = await this.models.Expense.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!expense) throw notFound('Expense');
    if (expense.status !== 'posted') throw invalidState('Only posted expenses can be cancelled');

    if (!ctx.permissions.has('expense.post') && !canInEntity(ctx, 'expense.post', expense.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: expense.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && expense.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    return await withTransaction(this.models.Expense.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: expense.legalEntityId, docDate: expense.docDate, models: this.models });
      await this.journals.reverse(session, {
        tenantId: ctx.tenantId,
        sourceType: 'expense',
        sourceId: expense._id,
        docDate: todayIST(),
        narration: `Cancellation of expense ${expense.number}: ${reason}`,
        actorId: ctx.userId,
        now: new Date(),
      });

      expense.status = 'cancelled';
      expense.cancelledAt = new Date();
      expense.cancelledBy = ctx.userId;
      expense.cancelReason = reason;
      expense.version += 1;

      await expense.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'expense.cancelled',
          entityType: 'expense',
          entityId: expense._id.toHexString(),
          summary: `Cancelled expense ${expense.number}: ${reason}`,
        },
        session,
      );

      return mapExpenseResponse(expense);
    });
  }
}
