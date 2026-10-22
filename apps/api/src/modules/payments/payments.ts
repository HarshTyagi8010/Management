import { randomBytes } from 'node:crypto';
import { trusted, Types, type HydratedDocument } from 'mongoose';
import type {
  AllocatePaymentInput,
  CreatePaymentInput,
  CreateRefundInput,
  FifoAllocateInput,
  PaymentListQuery,
  PaymentResponse,
  RefundResponse,
  ReversePaymentInput,
} from '@bizmgmt/contracts';
import {
  computeFifoAllocations,
  dec,
  money,
  obligationPaymentStatus,
  type ObligationCandidate,
} from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type {
  AllocationDoc,
  DocumentSeriesDoc,
  LegalEntityDoc,
  PartyDoc,
  PaymentDoc,
  RefundDoc,
  SalesDocDoc,
  SupplierBillDoc,
} from '../../models.js';
import { fromDecimal, toDecimal, todayIST } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';
import {
  forbidden,
  invalid,
  invalidState,
  mapAllocationResponse,
  mapPaymentResponse,
  mapRefundResponse,
  notFound,
  recordAudit,
  rule,
  versionConflict,
  type PaymentServices,
} from './core.js';
import {
  creditNoteRefundJournalLines,
  customerAllocationJournalLines,
  customerReceiptJournalLines,
  customerRefundJournalLines,
  debitNoteRefundJournalLines,
  supplierDisbursementJournalLines,
} from '../finance/journals.js';

export class PaymentService {
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
  private get numbering() {
    return this.deps.numbering;
  }

  async createDraft(ctx: TenantContext, input: CreatePaymentInput, meta: any): Promise<PaymentResponse> {
    const requiredPermission = input.direction === 'incoming' ? 'receipt.post' : 'payment.post';
    if (!canInEntity(ctx, requiredPermission, input.legalEntityId) && !ctx.permissions.has(requiredPermission)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const party = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.partyId, archivedAt: null }).lean();
    if (!party) throw notFound('Party');

    if (input.direction === 'incoming' && !party.isCustomer) {
      throw rule('Incoming receipts must be from a customer party');
    }
    if (input.direction === 'outgoing' && !party.isSupplier) {
      throw rule('Outgoing disbursements must be to a supplier party');
    }

    let allocSum = dec('0');
    if (input.allocations && input.allocations.length > 0) {
      for (const a of input.allocations) {
        allocSum = allocSum.plus(dec(a.amount));
        if (input.direction === 'incoming' && a.targetType !== 'sales_invoice') {
          throw rule('Customer receipts can only be allocated to sales invoices');
        }
        if (input.direction === 'outgoing' && a.targetType !== 'supplier_bill') {
          throw rule('Supplier payments can only be allocated to supplier bills');
        }
      }
      if (allocSum.greaterThan(dec(input.amount))) {
        throw rule('Total allocations cannot exceed the payment amount');
      }
    }

    const unallocated = dec(input.amount).minus(allocSum);

    const payment = await this.models.Payment.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      partyId: party._id,
      partyName: party.name,
      direction: input.direction,
      amount: toDecimal(input.amount),
      unallocatedAmount: toDecimal(unallocated.toString()),
      paymentMethod: input.paymentMethod,
      docDate: input.docDate,
      reference: input.reference ?? null,
      bankAccountName: input.bankAccountName ?? null,
      notes: input.notes ?? '',
      status: 'draft',
      number: null,
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'payment.created',
      entityType: 'payment',
      entityId: payment._id.toHexString(),
      summary: `Created ${input.direction} payment draft of ₹${input.amount} for ${party.name}`,
    });

    return mapPaymentResponse(payment);
  }

  async get(ctx: TenantContext, id: string): Promise<PaymentResponse> {
    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!payment) throw notFound('Payment');
    const allocations = await this.models.Allocation.find({ tenantId: ctx.tenantId, paymentId: payment._id, status: 'active' });
    return mapPaymentResponse(payment, allocations);
  }

  async list(ctx: TenantContext, query: PaymentListQuery): Promise<{ data: PaymentResponse[]; page: { nextCursor: string | null; limit: number } }> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.direction) filter.direction = query.direction;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      filter.docDate = {};
      if (query.from) (filter.docDate as any).$gte = query.from;
      if (query.to) (filter.docDate as any).$lte = query.to;
    }
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 25, 100);
    const docs = await this.models.Payment.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toHexString() ?? null : null;

    const paymentIds = pageDocs.map((p) => p._id);
    const allAllocations = await this.models.Allocation.find({
      tenantId: ctx.tenantId,
      paymentId: trusted({ $in: paymentIds }),
      status: 'active',
    });

    const allocMap = new Map<string, AllocationDoc[]>();
    for (const a of allAllocations) {
      const pid = a.paymentId.toHexString();
      const list = allocMap.get(pid) ?? [];
      list.push(a);
      allocMap.set(pid, list);
    }

    return {
      data: pageDocs.map((p) => mapPaymentResponse(p, allocMap.get(p._id.toHexString()) ?? [])),
      page: { nextCursor, limit },
    };
  }

  async post(ctx: TenantContext, id: string, meta: any): Promise<PaymentResponse> {
    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'draft') throw invalidState('Only draft payments can be posted');

    const requiredPermission = payment.direction === 'incoming' ? 'receipt.post' : 'payment.post';
    if (!canInEntity(ctx, requiredPermission, payment.legalEntityId) && !ctx.permissions.has(requiredPermission)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: payment.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && payment.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    const docTypeKind = payment.direction === 'incoming' ? 'receipt' : 'payment';
    const prefix = payment.direction === 'incoming' ? 'REC' : 'PMT';
    const series = await this.models.DocumentSeries.findOne({
      tenantId: ctx.tenantId,
      legalEntityId: payment.legalEntityId,
      active: true,
      docType: docTypeKind,
    }).lean();

    if (series) {
      await this.numbering.prepare(ctx.tenantId, series._id, payment.docDate);
    }

    return await withTransaction(this.models.Payment.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: payment.legalEntityId, docDate: payment.docDate, models: this.models });
      // 1. Assign number
      if (series) {
        const allocated = await this.numbering.take(session, ctx.tenantId, series._id, payment.docDate);
        payment.number = allocated.number;
      } else {
        const count = await this.models.Payment.countDocuments({ tenantId: ctx.tenantId, direction: payment.direction }, { session });
        payment.number = `${prefix}/${payment.docDate.slice(0, 4)}/${String(count + 1).padStart(4, '0')}`;
      }

      // 2. Double-entry journal
      const pAmount = fromDecimal(payment.amount) ?? '0.00';
      const pUnallocated = fromDecimal(payment.unallocatedAmount) ?? pAmount;
      const pAllocated = money(dec(pAmount).minus(dec(pUnallocated)));

      const lines =
        payment.direction === 'incoming'
          ? customerReceiptJournalLines(pAmount, payment.paymentMethod, pAllocated, pUnallocated)
          : supplierDisbursementJournalLines(pAmount, payment.paymentMethod);

      await this.journals.ensureAccounts(ctx.tenantId, payment.legalEntityId, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: payment.legalEntityId,
        docDate: payment.docDate,
        sourceType: 'payment',
        sourceId: payment._id,
        sourceNumber: payment.number,
        narration: `${payment.direction === 'incoming' ? 'Receipt' : 'Payment'} ${payment.number} - ${payment.partyName} (Ref: ${payment.reference ?? 'N/A'})`,
        lines,
        actorId: ctx.userId,
        now: new Date(),
      });

      payment.status = 'posted';
      payment.postedAt = new Date();
      payment.postedBy = ctx.userId;
      payment.version += 1;

      await payment.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'payment.posted',
          entityType: 'payment',
          entityId: payment._id.toHexString(),
          summary: `Posted ${payment.direction} payment ${payment.number} of ₹${pAmount} for ${payment.partyName}`,
        },
        session,
      );

      return mapPaymentResponse(payment);
    });
  }

  async allocate(ctx: TenantContext, id: string, input: AllocatePaymentInput, meta: any): Promise<PaymentResponse> {
    if (!ctx.permissions.has('allocation.manage')) throw forbidden();

    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'posted') throw invalidState('Only posted payments can be allocated');

    return await withTransaction(this.models.Payment.db, async (session) => {
      const lockedPayment = (await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: payment._id }).session(session)) as HydratedDocument<PaymentDoc>;
      let currentUnallocated = dec(lockedPayment.unallocatedAmount.toString());

      const createdAllocations: AllocationDoc[] = [];

      for (const item of input.allocations) {
        const allocAmt = dec(item.amount);
        if (allocAmt.greaterThan(currentUnallocated)) {
          throw rule(`Allocation amount ₹${item.amount} exceeds remaining unallocated payment balance ₹${money(currentUnallocated)}`);
        }

        if (lockedPayment.direction === 'incoming') {
          const inv = (await this.models.SalesInvoice.findOne({
            tenantId: ctx.tenantId,
            legalEntityId: lockedPayment.legalEntityId,
            partyId: lockedPayment.partyId,
            _id: item.targetId,
            status: 'issued',
          }).session(session)) as HydratedDocument<SalesDocDoc> | null;

          if (!inv) throw notFound('Sales invoice');
          const currentOut = dec(inv.outstanding?.toString() ?? '0');
          if (allocAmt.greaterThan(currentOut)) {
            throw rule(`Cannot allocate ₹${item.amount} to invoice ${inv.number} with outstanding ₹${money(currentOut)}`);
          }

          const newOut = currentOut.minus(allocAmt);
          inv.outstanding = toDecimal(money(newOut));
          inv.paymentStatus = obligationPaymentStatus(fromDecimal(inv.totals.grand) ?? '0.00', money(newOut));
          inv.version += 1;
          await inv.save({ session });

          const [allocation] = await this.models.Allocation.create(
            [
              {
                tenantId: ctx.tenantId,
                legalEntityId: lockedPayment.legalEntityId,
                partyId: lockedPayment.partyId,
                paymentId: lockedPayment._id,
                targetType: 'sales_invoice',
                targetId: inv._id,
                targetNumber: inv.number ?? '',
                amount: toDecimal(item.amount),
                allocatedAt: new Date(),
                allocatedBy: ctx.userId,
                status: 'active',
              },
            ],
            { session },
          );
          if (allocation) {
            createdAllocations.push(allocation);
            if (lockedPayment.recordKind === 'payment') {
              await this.journals.ensureAccounts(ctx.tenantId, lockedPayment.legalEntityId, session);
              await this.journals.post(session, {
                tenantId: ctx.tenantId,
                legalEntityId: lockedPayment.legalEntityId,
                docDate: todayIST(),
                sourceType: 'allocation',
                sourceId: allocation._id,
                sourceNumber: `ALLOC/${lockedPayment.number ?? 'REC'}/${inv.number ?? 'INV'}`,
                narration: `Allocation of Receipt ${lockedPayment.number} to Invoice #${inv.number}`,
                lines: customerAllocationJournalLines(item.amount),
                actorId: ctx.userId,
                now: new Date(),
              });
            }
          }
        } else {
          const bill = (await this.models.SupplierBill.findOne({
            tenantId: ctx.tenantId,
            legalEntityId: lockedPayment.legalEntityId,
            supplierId: lockedPayment.partyId,
            _id: item.targetId,
            status: 'posted',
          }).session(session)) as HydratedDocument<SupplierBillDoc> | null;

          if (!bill) throw notFound('Supplier bill');
          const currentOut = dec(bill.outstanding.toString());
          if (allocAmt.greaterThan(currentOut)) {
            throw rule(`Cannot allocate ₹${item.amount} to bill ${bill.number} with outstanding ₹${money(currentOut)}`);
          }

          const newOut = currentOut.minus(allocAmt);
          bill.outstanding = toDecimal(money(newOut));
          bill.paymentStatus = obligationPaymentStatus(fromDecimal(bill.totals.grand) ?? '0.00', money(newOut));
          bill.version += 1;
          await bill.save({ session });

          const [allocation] = await this.models.Allocation.create(
            [
              {
                tenantId: ctx.tenantId,
                legalEntityId: lockedPayment.legalEntityId,
                partyId: lockedPayment.partyId,
                paymentId: lockedPayment._id,
                targetType: 'supplier_bill',
                targetId: bill._id,
                targetNumber: bill.number ?? '',
                amount: toDecimal(item.amount),
                allocatedAt: new Date(),
                allocatedBy: ctx.userId,
                status: 'active',
              },
            ],
            { session },
          );
          if (allocation) createdAllocations.push(allocation);
        }

        currentUnallocated = currentUnallocated.minus(allocAmt);
      }

      lockedPayment.unallocatedAmount = toDecimal(currentUnallocated.toString());
      lockedPayment.version += 1;
      await lockedPayment.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'payment.allocated',
          entityType: 'payment',
          entityId: lockedPayment._id.toHexString(),
          summary: `Allocated ₹${money(dec(fromDecimal(lockedPayment.amount) ?? '0').minus(currentUnallocated))} across ${input.allocations.length} obligation(s)`,
        },
        session,
      );

      const allActive = await this.models.Allocation.find({ tenantId: ctx.tenantId, paymentId: lockedPayment._id, status: 'active' }, null, { session });
      return mapPaymentResponse(lockedPayment, allActive);
    });
  }

  async fifoAllocate(ctx: TenantContext, id: string, input: FifoAllocateInput, meta: any): Promise<PaymentResponse> {
    if (!ctx.permissions.has('allocation.manage')) throw forbidden();

    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'posted') throw invalidState('Only posted payments can be allocated');

    return await withTransaction(this.models.Payment.db, async (session) => {
      const lockedPayment = (await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: payment._id }).session(session)) as HydratedDocument<PaymentDoc>;
      const unalloc = dec(lockedPayment.unallocatedAmount.toString());
      if (unalloc.isZero() || unalloc.isNegative()) {
        throw rule('Payment has no unallocated balance remaining for allocation');
      }

      const maxToAlloc = input.maxAmount ? dec(input.maxAmount) : unalloc;
      const budget = maxToAlloc.lessThan(unalloc) ? maxToAlloc : unalloc;

      const candidates: ObligationCandidate[] = [];

      if (lockedPayment.direction === 'incoming') {
        const invoices = await this.models.SalesInvoice.find(
          {
            tenantId: ctx.tenantId,
            legalEntityId: lockedPayment.legalEntityId,
            partyId: lockedPayment.partyId,
            status: 'issued',
            paymentStatus: trusted({ $in: ['unpaid', 'partially_paid'] }),
          },
          null,
          { session },
        ).lean();

        for (const inv of invoices) {
          const out = dec(inv.outstanding?.toString() ?? '0');
          if (out.isPositive()) {
            candidates.push({
              id: inv._id.toHexString(),
              docNumber: inv.number ?? '',
              docDate: inv.docDate,
              dueDate: inv.dueDate,
              outstanding: money(out),
            });
          }
        }
      } else {
        const bills = await this.models.SupplierBill.find(
          {
            tenantId: ctx.tenantId,
            legalEntityId: lockedPayment.legalEntityId,
            supplierId: lockedPayment.partyId,
            status: 'posted',
            paymentStatus: trusted({ $in: ['unpaid', 'partially_paid'] }),
          },
          null,
          { session },
        ).lean();

        for (const bill of bills) {
          const out = dec(bill.outstanding.toString());
          if (out.isPositive()) {
            candidates.push({
              id: bill._id.toHexString(),
              docNumber: bill.number ?? '',
              docDate: bill.docDate,
              dueDate: bill.dueDate,
              outstanding: money(out),
            });
          }
        }
      }

      const fifoRes = computeFifoAllocations(money(budget), candidates);
      if (fifoRes.allocations.length === 0) {
        const allActive = await this.models.Allocation.find({ tenantId: ctx.tenantId, paymentId: lockedPayment._id, status: 'active' }, null, { session });
        return mapPaymentResponse(lockedPayment, allActive);
      }

      for (const a of fifoRes.allocations) {
        if (lockedPayment.direction === 'incoming') {
          const inv = (await this.models.SalesInvoice.findOne({ tenantId: ctx.tenantId, _id: a.targetId }).session(session)) as HydratedDocument<SalesDocDoc>;
          inv.outstanding = toDecimal(a.newOutstanding);
          inv.paymentStatus = obligationPaymentStatus(fromDecimal(inv.totals.grand) ?? '0.00', a.newOutstanding);
          inv.version += 1;
          await inv.save({ session });

          const [allocation] = await this.models.Allocation.create(
            [
              {
                tenantId: ctx.tenantId,
                legalEntityId: lockedPayment.legalEntityId,
                partyId: lockedPayment.partyId,
                paymentId: lockedPayment._id,
                targetType: 'sales_invoice',
                targetId: inv._id,
                targetNumber: a.targetNumber,
                amount: toDecimal(a.amount),
                allocatedAt: new Date(),
                allocatedBy: ctx.userId,
                status: 'active',
              },
            ],
            { session },
          );
          if (allocation && lockedPayment.recordKind === 'payment') {
            await this.journals.ensureAccounts(ctx.tenantId, lockedPayment.legalEntityId, session);
            await this.journals.post(session, {
              tenantId: ctx.tenantId,
              legalEntityId: lockedPayment.legalEntityId,
              docDate: todayIST(),
              sourceType: 'allocation',
              sourceId: allocation._id,
              sourceNumber: `ALLOC/${lockedPayment.number ?? 'REC'}/${inv.number ?? 'INV'}`,
              narration: `FIFO allocation of Receipt ${lockedPayment.number} to Invoice #${inv.number}`,
              lines: customerAllocationJournalLines(a.amount),
              actorId: ctx.userId,
              now: new Date(),
            });
          }
        } else {
          const bill = (await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: a.targetId }).session(session)) as HydratedDocument<SupplierBillDoc>;
          bill.outstanding = toDecimal(a.newOutstanding);
          bill.paymentStatus = obligationPaymentStatus(fromDecimal(bill.totals.grand) ?? '0.00', a.newOutstanding);
          bill.version += 1;
          await bill.save({ session });

          await this.models.Allocation.create(
            [
              {
                tenantId: ctx.tenantId,
                legalEntityId: lockedPayment.legalEntityId,
                partyId: lockedPayment.partyId,
                paymentId: lockedPayment._id,
                targetType: 'supplier_bill',
                targetId: bill._id,
                targetNumber: a.targetNumber,
                amount: toDecimal(a.amount),
                allocatedAt: new Date(),
                allocatedBy: ctx.userId,
                status: 'active',
              },
            ],
            { session },
          );
        }
      }

      const totalAllocDec = dec(fifoRes.totalAllocated);
      lockedPayment.unallocatedAmount = toDecimal(unalloc.minus(totalAllocDec).toString());
      lockedPayment.version += 1;
      await lockedPayment.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'payment.allocated',
          entityType: 'payment',
          entityId: lockedPayment._id.toHexString(),
          summary: `FIFO allocated ₹${fifoRes.totalAllocated} across ${fifoRes.allocations.length} obligation(s)`,
        },
        session,
      );

      const allActive = await this.models.Allocation.find({ tenantId: ctx.tenantId, paymentId: lockedPayment._id, status: 'active' }, null, { session });
      return mapPaymentResponse(lockedPayment, allActive);
    });
  }

  async reverse(ctx: TenantContext, id: string, input: ReversePaymentInput, meta: any): Promise<PaymentResponse> {
    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'posted') throw invalidState('Only posted payments can be reversed');

    if (payment.recordKind !== 'payment') {
      throw rule(
        `Cannot reverse a note-origin credit record via payment reversal. Cancel the source ${payment.recordKind === 'credit_note_excess' ? 'credit note' : 'debit note'} instead.`,
      );
    }

    const requiredPermission = payment.direction === 'incoming' ? 'receipt.post' : 'payment.post';
    if (!canInEntity(ctx, requiredPermission, payment.legalEntityId) && !ctx.permissions.has(requiredPermission)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: payment.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && payment.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    // Guard: Prevent reversal if active refund records exist
    const hasRefunds = await this.models.Refund.exists({ tenantId: ctx.tenantId, paymentId: payment._id, status: 'posted' });
    if (hasRefunds) {
      throw rule('Cannot reverse a payment that has active refunds recorded against it');
    }

    return await withTransaction(this.models.Payment.db, async (session) => {
      const revDate = input.reversalDate ?? todayIST();
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: payment.legalEntityId, docDate: payment.docDate, models: this.models });
      if (revDate !== payment.docDate) {
        await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: payment.legalEntityId, docDate: revDate, models: this.models });
      }
      // 1. Reverse journal
      await this.journals.reverse(session, {
        tenantId: ctx.tenantId,
        sourceType: 'payment',
        sourceId: payment._id,
        docDate: revDate,
        narration: `Reversal of payment ${payment.number}: ${input.reason}`,
        actorId: ctx.userId,
        now: new Date(),
      });

      // 2. Restore all active allocations
      const activeAllocs = await this.models.Allocation.find({ tenantId: ctx.tenantId, paymentId: payment._id, status: 'active' }, null, { session });
      for (const a of activeAllocs) {
        const amt = dec(a.amount.toString());
        if (a.targetType === 'sales_invoice') {
          const inv = (await this.models.SalesInvoice.findOne({ tenantId: ctx.tenantId, _id: a.targetId }).session(session)) as HydratedDocument<SalesDocDoc> | null;
          if (inv) {
            const currentOut = dec(inv.outstanding?.toString() ?? '0');
            const restoredOut = money(currentOut.plus(amt));
            inv.outstanding = toDecimal(restoredOut);
            inv.paymentStatus = obligationPaymentStatus(fromDecimal(inv.totals.grand) ?? '0.00', restoredOut);
            inv.version += 1;
            await inv.save({ session });
          }
        } else {
          const bill = (await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: a.targetId }).session(session)) as HydratedDocument<SupplierBillDoc> | null;
          if (bill) {
            const currentOut = dec(bill.outstanding.toString());
            const restoredOut = money(currentOut.plus(amt));
            bill.outstanding = toDecimal(restoredOut);
            bill.paymentStatus = obligationPaymentStatus(fromDecimal(bill.totals.grand) ?? '0.00', restoredOut);
            bill.version += 1;
            await bill.save({ session });
          }
        }
        if (payment.direction === 'incoming' && payment.recordKind === 'payment') {
          await this.journals.reverse(session, {
            tenantId: ctx.tenantId,
            sourceType: 'allocation',
            sourceId: a._id,
            docDate: revDate,
            narration: `Reversal of allocation for reversed receipt ${payment.number}`,
            actorId: ctx.userId,
            now: new Date(),
          });
        }
        a.status = 'cancelled';
        await a.save({ session });
      }

      payment.status = 'reversed';
      payment.reversedAt = input.reversalDate ? new Date(`${input.reversalDate}T12:00:00Z`) : new Date();
      payment.reversedBy = ctx.userId;
      payment.reversedReason = input.reason;
      payment.version += 1;
      await payment.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'payment.reversed',
          entityType: 'payment',
          entityId: payment._id.toHexString(),
          summary: `Reversed payment ${payment.number}: ${input.reason}`,
        },
        session,
      );

      return mapPaymentResponse(payment);
    });
  }

  async createRefund(ctx: TenantContext, input: CreateRefundInput, meta: any): Promise<RefundResponse> {
    if (!ctx.permissions.has('payment.post')) throw forbidden();

    const payment = await this.models.Payment.findOne({ tenantId: ctx.tenantId, _id: input.paymentId });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'posted') throw invalidState('Can only refund against posted payments');

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && input.refundDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'refundDate', message: 'Locked period' },
      ]);
    }

    const currentUnalloc = dec(payment.unallocatedAmount.toString());
    const refundAmt = dec(input.amount);
    if (refundAmt.greaterThan(currentUnalloc)) {
      throw rule(`Refund amount ₹${input.amount} cannot exceed unallocated payment balance ₹${money(currentUnalloc)}`);
    }

    return await withTransaction(this.models.Payment.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: payment.legalEntityId, docDate: input.refundDate, models: this.models });
      // Guarded write-lock on the shared Payment document to serialize concurrent refunds
      const lockedPayment = (await this.models.Payment.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: payment._id, status: 'posted' },
        { $inc: { version: 1 } },
        { session, new: true },
      )) as HydratedDocument<PaymentDoc> | null;

      if (!lockedPayment) throw notFound('Payment');

      const curInside = dec(lockedPayment.unallocatedAmount.toString());
      if (refundAmt.greaterThan(curInside)) {
        throw rule(`Refund amount ₹${input.amount} cannot exceed unallocated payment balance ₹${money(curInside)}`);
      }
      const newUnalloc = curInside.minus(refundAmt);
      lockedPayment.unallocatedAmount = toDecimal(newUnalloc.toString());
      await lockedPayment.save({ session });

      const refundNumber = `REF/${input.refundDate.slice(0, 4)}/${randomBytes(3).toString('hex').toUpperCase()}`;

      const refund = await this.models.Refund.create(
        [
          {
            tenantId: ctx.tenantId,
            legalEntityId: entity._id,
            partyId: lockedPayment.partyId,
            partyName: lockedPayment.partyName,
            paymentId: lockedPayment._id,
            number: refundNumber,
            amount: toDecimal(input.amount),
            refundDate: input.refundDate,
            paymentMethod: input.paymentMethod,
            reference: input.reference ?? null,
            reason: input.reason,
            status: 'posted',
            postedAt: new Date(),
            postedBy: ctx.userId,
          },
        ],
        { session },
      );

      const refundDoc = refund[0]!;

      // Post refund journal matching exact source credit kind
      const lines =
        lockedPayment.recordKind === 'credit_note_excess'
          ? creditNoteRefundJournalLines(input.amount, input.paymentMethod)
          : lockedPayment.recordKind === 'debit_note_excess'
            ? debitNoteRefundJournalLines(input.amount, input.paymentMethod)
            : customerRefundJournalLines(input.amount, input.paymentMethod);
      await this.journals.ensureAccounts(ctx.tenantId, entity._id, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: entity._id,
        docDate: input.refundDate,
        sourceType: 'refund',
        sourceId: refundDoc._id,
        sourceNumber: refundNumber,
        narration: `Refund ${refundNumber} for ${lockedPayment.partyName} against payment ${lockedPayment.number}: ${input.reason}`,
        lines,
        actorId: ctx.userId,
        now: new Date(),
      });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'refund.posted',
          entityType: 'refund',
          entityId: refundDoc._id.toHexString(),
          summary: `Posted refund of ₹${input.amount} to ${lockedPayment.partyName}`,
        },
        session,
      );

      return mapRefundResponse(refundDoc);
    });
  }

  async listRefunds(ctx: TenantContext, query: { legalEntityId?: string | undefined; paymentId?: string | undefined; partyId?: string | undefined }): Promise<RefundResponse[]> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.paymentId) filter.paymentId = new Types.ObjectId(query.paymentId);
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);

    const docs = await this.models.Refund.find(filter).sort({ _id: -1 }).limit(100);
    return docs.map(mapRefundResponse);
  }
}
