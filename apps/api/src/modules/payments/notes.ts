import { Types, trusted, type HydratedDocument } from 'mongoose';
import type {
  CreateCreditNoteInput,
  CreateDebitNoteInput,
  CreditNoteResponse,
  DebitNoteResponse,
  NoteListQuery,
} from '@bizmgmt/contracts';
import {
  calculateNoteLineAmounts,
  dec,
  money,
  obligationPaymentStatus,
} from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type {
  CreditNoteDoc,
  DebitNoteDoc,
  NoteAmountsDoc,
  NoteLineDoc,
  PaymentDoc,
  SalesDocDoc,
  SupplierBillDoc,
} from '../../models.js';
import { fromDecimal, toDecimal, todayIST } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import { canInEntity, canInWarehouse, type TenantContext } from '../tenancy/tenancy.js';
import {
  forbidden,
  invalidState,
  mapCreditNoteResponse,
  mapDebitNoteResponse,
  newLineId,
  notFound,
  recordAudit,
  rule,
  type PaymentServices,
} from './core.js';
import {
  cogsReturnJournalLines,
  creditNoteJournalLines,
  debitNoteJournalLines,
} from '../finance/journals.js';
import type { PostLine } from '../inventory/ledger.js';

export class NoteService {
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
  private get ledger() {
    return this.deps.ledger;
  }

  // ---------------------------------------------------------------- Credit Notes
  async createCreditNote(ctx: TenantContext, input: CreateCreditNoteInput, meta: any): Promise<CreditNoteResponse> {
    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', input.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const party = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.partyId, archivedAt: null }).lean();
    if (!party) throw notFound('Party');

    const invoice = await this.models.SalesInvoice.findOne({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      partyId: party._id,
      _id: input.salesInvoiceId,
      status: 'issued',
    }).lean();
    if (!invoice) throw notFound('Sales invoice');

    // Intra vs Inter state comparison
    const isInterState = invoice.supply === 'inter';

    // Validate cumulative return quantities against original invoice
    const existingCNs = await this.models.CreditNote.find({
      tenantId: ctx.tenantId,
      salesInvoiceId: invoice._id,
      status: trusted({ $in: ['draft', 'issued'] }),
    }).lean();

    for (const l of input.lines) {
      if (!l.qty) continue;
      const invLine = l.sourceLineId
        ? invoice.lines.find((il) => il.lineId === l.sourceLineId)
        : l.itemId
          ? invoice.lines.find((il) => il.itemId?.toString() === l.itemId)
          : null;

      if (invLine && invLine.qty) {
        const origQty = dec(fromDecimal(invLine.qty) ?? '0');
        let priorReturnedQty = dec('0');
        for (const ecn of existingCNs) {
          for (const el of ecn.lines) {
            const matches = el.sourceLineId
              ? el.sourceLineId === invLine.lineId
              : el.itemId && invLine.itemId && el.itemId.toString() === invLine.itemId.toString();
            if (matches && el.qty) {
              priorReturnedQty = priorReturnedQty.plus(dec(fromDecimal(el.qty) ?? '0'));
            }
          }
        }
        const requestedQty = dec(l.qty);
        if (priorReturnedQty.plus(requestedQty).gt(origQty)) {
          const maxAvail = origQty.minus(priorReturnedQty);
          throw rule(`Cannot return quantity ${l.qty}; only ${maxAvail.isNegative() ? '0' : maxAvail.toString()} available to return for ${invLine.item?.name ?? 'item'}`);
        }
      }
    }

    // Calculate line amounts
    let sumTaxable = dec('0');
    let sumCgst = dec('0');
    let sumSgst = dec('0');
    let sumUtgst = dec('0');
    let sumIgst = dec('0');
    let sumCess = dec('0');

    const lineDocs: NoteLineDoc[] = [];

    for (const l of input.lines) {
      let itemName: string | null = null;
      let sku: string | null = null;
      let itemObjId: Types.ObjectId | null = null;

      if (l.itemId) {
        const item = await this.models.Item.findOne({ tenantId: ctx.tenantId, _id: l.itemId }).lean();
        if (item) {
          itemName = item.name;
          sku = item.sku;
          itemObjId = item._id;
        }
      } else if (l.sourceLineId) {
        const invLine = invoice.lines.find((il) => il.lineId === l.sourceLineId);
        if (invLine) {
          itemName = invLine.item.name;
          sku = invLine.item.sku;
          itemObjId = invLine.itemId;
        }
      }

      const taxable = l.qty ? dec(l.qty).times(dec(l.unitPrice)) : dec(l.unitPrice);
      const calculated = calculateNoteLineAmounts(money(taxable), l.taxRate ?? null, isInterState);

      sumTaxable = sumTaxable.plus(dec(calculated.taxable));
      sumCgst = sumCgst.plus(dec(calculated.cgst));
      sumSgst = sumSgst.plus(dec(calculated.sgst));
      sumUtgst = sumUtgst.plus(dec(calculated.utgst));
      sumIgst = sumIgst.plus(dec(calculated.igst));
      sumCess = sumCess.plus(dec(calculated.cess));

      lineDocs.push({
        lineId: newLineId(),
        sourceLineId: l.sourceLineId ?? null,
        itemId: itemObjId,
        itemName,
        sku,
        qty: l.qty ? toDecimal(l.qty) : null,
        unitPrice: toDecimal(l.unitPrice),
        taxRate: l.taxRate ? toDecimal(l.taxRate) : null,
        taxable: toDecimal(calculated.taxable),
        cgst: toDecimal(calculated.cgst),
        sgst: toDecimal(calculated.sgst),
        utgst: toDecimal(calculated.utgst),
        igst: toDecimal(calculated.igst),
        cess: toDecimal(calculated.cess),
        total: toDecimal(calculated.total),
        reason: l.reason ?? null,
      });
    }

    const subtotal = sumTaxable.plus(sumCgst).plus(sumSgst).plus(sumUtgst).plus(sumIgst).plus(sumCess);
    // Nearest rupee round-off
    const grandRounded = subtotal.round();
    const roundOff = grandRounded.minus(subtotal);

    const amounts: NoteAmountsDoc = {
      taxable: toDecimal(money(sumTaxable)),
      cgst: toDecimal(money(sumCgst)),
      sgst: toDecimal(money(sumSgst)),
      utgst: toDecimal(money(sumUtgst)),
      igst: toDecimal(money(sumIgst)),
      cess: toDecimal(money(sumCess)),
      roundOff: toDecimal(money(roundOff)),
      grand: toDecimal(money(grandRounded)),
    };

    const cn = await this.models.CreditNote.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      partyId: party._id,
      partyName: party.name,
      salesInvoiceId: invoice._id,
      salesInvoiceNumber: invoice.number ?? '',
      number: null,
      kind: input.kind,
      status: 'draft',
      docDate: input.docDate,
      reason: input.reason,
      warehouseId: input.warehouseId ? new Types.ObjectId(input.warehouseId) : (invoice.warehouseId ?? null),
      lines: lineDocs,
      amounts,
      notes: input.notes ?? '',
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'credit_note.created',
      entityType: 'credit_note',
      entityId: cn._id.toHexString(),
      summary: `Created credit note draft for ${party.name} against invoice ${invoice.number}`,
    });

    return mapCreditNoteResponse(cn);
  }

  async issueCreditNote(ctx: TenantContext, id: string, meta: any): Promise<CreditNoteResponse> {
    const cn = await this.models.CreditNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!cn) throw notFound('Credit note');
    if (cn.status !== 'draft') throw invalidState('Only draft credit notes can be issued');

    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', cn.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: cn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && cn.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    const invoice = await this.models.SalesInvoice.findOne({ tenantId: ctx.tenantId, _id: cn.salesInvoiceId }).lean();
    if (!invoice) throw notFound('Sales invoice');

    return await withTransaction(this.models.CreditNote.db, async (session) => {
      // 0. Immediate write lock on SalesInvoice to serialize concurrent note issuances
      const invDoc = (await this.models.SalesInvoice.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: invoice._id },
        { $inc: { version: 1 } },
        { session, new: true },
      )) as HydratedDocument<SalesDocDoc> | null;
      if (!invDoc) throw notFound('Sales invoice');

      // 1. Assign number
      const count = await this.models.CreditNote.countDocuments({ tenantId: ctx.tenantId }, { session });
      const cnNumber = `CN/${cn.docDate.slice(0, 4)}/${String(count + 1).padStart(4, '0')}`;
      cn.number = cnNumber;

      // 1b. Concurrency check: Re-validate cumulative return quantities inside transaction
      const issuedCNs = await this.models.CreditNote.find({
        tenantId: ctx.tenantId,
        salesInvoiceId: invoice._id,
        status: 'issued',
        _id: trusted({ $ne: cn._id }),
      }).session(session).lean();

      for (const l of cn.lines) {
        if (!l.qty) continue;
        const invLine = l.sourceLineId
          ? invoice.lines.find((il) => il.lineId === l.sourceLineId)
          : l.itemId
            ? invoice.lines.find((il) => il.itemId?.toString() === l.itemId?.toString())
            : null;

        if (invLine && invLine.qty) {
          const origQty = dec(fromDecimal(invLine.qty) ?? '0');
          let priorReturnedQty = dec('0');
          for (const ecn of issuedCNs) {
            for (const el of ecn.lines) {
              const matches = el.sourceLineId
                ? el.sourceLineId === invLine.lineId
                : el.itemId && invLine.itemId && el.itemId.toString() === invLine.itemId.toString();
              if (matches && el.qty) {
                priorReturnedQty = priorReturnedQty.plus(dec(fromDecimal(el.qty) ?? '0'));
              }
            }
          }
          const requestedQty = dec(fromDecimal(l.qty) ?? '0');
          if (priorReturnedQty.plus(requestedQty).gt(origQty)) {
            const maxAvail = origQty.minus(priorReturnedQty);
            throw rule(`Cannot return quantity ${requestedQty}; only ${maxAvail.isNegative() ? '0' : maxAvail.toString()} available to return`);
          }
        }
      }

      let totalRestoredCost = dec('0');

      // 2. Physical stock return if sales_return
      if (cn.kind === 'sales_return' && cn.warehouseId) {
        const stockLines = cn.lines.filter((l) => l.itemId && l.qty);
        if (stockLines.length > 0) {
          await this.ledger.ensureRows(
            ctx.tenantId,
            cn.legalEntityId,
            stockLines.map((l) => ({ warehouseId: cn.warehouseId!, itemId: l.itemId! })),
          );

          const postLines: PostLine[] = [];
          for (const l of stockLines) {
            // Find original issue movement to restore at exact issue cost
            const origMovement = await this.models.StockMovement.findOne({
              tenantId: ctx.tenantId,
              sourceType: 'sales_invoice',
              sourceId: invoice._id,
              itemId: l.itemId,
              kind: 'issue',
              reversalOf: null,
            }).session(session);

            const restoreUnitCost = origMovement?.unitCost ? fromDecimal(origMovement.unitCost) ?? '0.00' : '0.00';
            const restoreQty = fromDecimal(l.qty!) ?? '1';
            const restoreVal = money(dec(restoreQty).times(dec(restoreUnitCost)));
            totalRestoredCost = totalRestoredCost.plus(dec(restoreVal));

            postLines.push({
              warehouseId: cn.warehouseId!,
              itemId: l.itemId!,
              label: l.itemName ?? 'Returned Item',
              qty: restoreQty,
              kind: 'return_in',
              sourceLineId: l.lineId,
              effect: {
                type: 'restore',
                value: restoreVal,
                reversalOf: origMovement?._id ?? null,
              },
            });
          }

          if (postLines.length > 0) {
            await this.ledger.post(
              {
                session,
                tenantId: ctx.tenantId,
                legalEntityId: cn.legalEntityId,
                allowNegative: true,
                docDate: cn.docDate,
                sourceType: 'sales_return',
                sourceId: cn._id,
                sourceNumber: cn.number,
                actorId: ctx.userId,
                now: new Date(),
              },
              postLines,
            );
          }
        }
      }

      // 3. Update invoice outstanding balance
      if (invDoc) {
        const curOut = dec(invDoc.outstanding?.toString() ?? '0');
        const cnGrand = dec(fromDecimal(cn.amounts.grand) ?? '0.00');
        const newOut = curOut.minus(cnGrand);
        const finalOut = newOut.isNegative() ? '0.00' : money(newOut);
        invDoc.outstanding = toDecimal(finalOut);
        invDoc.paymentStatus = obligationPaymentStatus(fromDecimal(invDoc.totals.grand) ?? '0.00', finalOut);
        await invDoc.save({ session });

        // Defect C: If excess credit note amount beyond outstanding, preserve as unallocated customer credit
        if (newOut.isNegative()) {
          const excess = newOut.abs();
          if (excess.gt(0)) {
            const excessPayment = new this.models.Payment({
              tenantId: ctx.tenantId,
              legalEntityId: cn.legalEntityId,
              partyId: invoice.partyId,
              partyName: cn.partyName,
              direction: 'incoming',
              recordKind: 'credit_note_excess',
              sourceNoteId: cn._id,
              sourceNoteNumber: cn.number,
              amount: toDecimal(money(excess)),
              unallocatedAmount: toDecimal(money(excess)),
              paymentMethod: 'credit',
              docDate: cn.docDate,
              reference: cn.number,
              status: 'posted',
              number: `CR-CN-${cn.number.replace(/\//g, '-')}`,
              notes: `Unallocated credit from Credit Note ${cn.number} for Invoice #${invoice.number}`,
              postedAt: new Date(),
              postedBy: ctx.userId,
              createdBy: ctx.userId,
            });
            await excessPayment.save({ session });
          }
        }
      }

      // 4. Double-entry journal
      const jLines = creditNoteJournalLines({
        grand: fromDecimal(cn.amounts.grand) ?? '0.00',
        taxable: fromDecimal(cn.amounts.taxable) ?? '0.00',
        cgst: fromDecimal(cn.amounts.cgst) ?? '0.00',
        sgst: fromDecimal(cn.amounts.sgst) ?? '0.00',
        utgst: fromDecimal(cn.amounts.utgst) ?? '0.00',
        igst: fromDecimal(cn.amounts.igst) ?? '0.00',
        cess: fromDecimal(cn.amounts.cess) ?? '0.00',
        roundOff: fromDecimal(cn.amounts.roundOff) ?? '0.00',
      });

      // Defect A: Include COGS reversal and Inventory asset restoration
      if (totalRestoredCost.gt(0)) {
        jLines.push(...cogsReturnJournalLines(money(totalRestoredCost)));
      }

      await this.journals.ensureAccounts(ctx.tenantId, cn.legalEntityId, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: cn.legalEntityId,
        docDate: cn.docDate,
        sourceType: 'credit_note',
        sourceId: cn._id,
        sourceNumber: cn.number,
        narration: `Credit Note ${cn.number} to ${cn.partyName} (Inv #${cn.salesInvoiceNumber}): ${cn.reason}`,
        lines: jLines,
        actorId: ctx.userId,
        now: new Date(),
      });

      cn.status = 'issued';
      cn.issuedAt = new Date();
      cn.issuedBy = ctx.userId;
      cn.version += 1;

      await cn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'credit_note.issued',
          entityType: 'credit_note',
          entityId: cn._id.toHexString(),
          summary: `Issued credit note ${cn.number} for ₹${fromDecimal(cn.amounts.grand)} to ${cn.partyName}`,
        },
        session,
      );

      return mapCreditNoteResponse(cn);
    });
  }

  async cancelCreditNote(ctx: TenantContext, id: string, reason: string, meta: any): Promise<CreditNoteResponse> {
    const cn = await this.models.CreditNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!cn) throw notFound('Credit note');
    if (cn.status !== 'issued') throw invalidState('Only issued credit notes can be cancelled');

    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', cn.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: cn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && cn.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    return await withTransaction(this.models.CreditNote.db, async (session) => {
      // 1. Reverse journal
      await this.journals.reverse(session, {
        tenantId: ctx.tenantId,
        sourceType: 'credit_note',
        sourceId: cn._id,
        docDate: todayIST(),
        narration: `Cancellation of credit note ${cn.number}: ${reason}`,
        actorId: ctx.userId,
        now: new Date(),
      });

      // 2. Restore invoice outstanding
      const invDoc = (await this.models.SalesInvoice.findOne({ tenantId: ctx.tenantId, _id: cn.salesInvoiceId }).session(session)) as HydratedDocument<SalesDocDoc> | null;
      if (invDoc) {
        const curOut = dec(invDoc.outstanding?.toString() ?? '0');
        const cnGrand = dec(fromDecimal(cn.amounts.grand) ?? '0.00');
        const restoredOut = money(curOut.plus(cnGrand));
        invDoc.outstanding = toDecimal(restoredOut);
        invDoc.paymentStatus = obligationPaymentStatus(fromDecimal(invDoc.totals.grand) ?? '0.00', restoredOut);
        invDoc.version += 1;
        await invDoc.save({ session });
      }

      // 2b. Check and reverse linked unallocated excess credit if any
      const excessRecord = (await this.models.Payment.findOne({
        tenantId: ctx.tenantId,
        sourceNoteId: cn._id,
        status: 'posted',
      }).session(session)) as HydratedDocument<PaymentDoc> | null;

      if (excessRecord) {
        const unalloc = dec(excessRecord.unallocatedAmount.toString());
        const origAmt = dec(excessRecord.amount.toString());
        if (unalloc.lessThan(origAmt)) {
          throw rule(`Cannot cancel credit note ${cn.number}: unallocated credit has already been partially or fully allocated or refunded. Rollback settlements first.`);
        }
        excessRecord.status = 'reversed';
        excessRecord.unallocatedAmount = toDecimal('0.00');
        excessRecord.reversedAt = new Date();
        excessRecord.reversedBy = ctx.userId;
        excessRecord.reversedReason = `Source credit note ${cn.number} cancelled`;
        excessRecord.version += 1;
        await excessRecord.save({ session });
      }

      // 3. Rollback returned stock if sales_return
      if (cn.kind === 'sales_return' && cn.warehouseId) {
        const stockLines = cn.lines.filter((l) => l.itemId && l.qty);
        if (stockLines.length > 0) {
          const postLines: PostLine[] = stockLines.map((l) => ({
            warehouseId: cn.warehouseId!,
            itemId: l.itemId!,
            label: l.itemName ?? 'Returned Item Reversal',
            qty: fromDecimal(l.qty!) ?? '1',
            kind: 'issue',
            sourceLineId: l.lineId,
            effect: { type: 'issue' },
          }));

          await this.ledger.post(
            {
              session,
              tenantId: ctx.tenantId,
              legalEntityId: cn.legalEntityId,
              allowNegative: true,
              docDate: todayIST(),
              sourceType: 'sales_return',
              sourceId: cn._id,
              sourceNumber: cn.number ?? '',
              actorId: ctx.userId,
              now: new Date(),
            },
            postLines,
          );
        }
      }

      cn.status = 'cancelled';
      cn.cancelledAt = new Date();
      cn.cancelledBy = ctx.userId;
      cn.cancelReason = reason;
      cn.version += 1;

      await cn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'credit_note.cancelled',
          entityType: 'credit_note',
          entityId: cn._id.toHexString(),
          summary: `Cancelled credit note ${cn.number}: ${reason}`,
        },
        session,
      );

      return mapCreditNoteResponse(cn);
    });
  }

  // ---------------------------------------------------------------- Debit Notes
  async createDebitNote(ctx: TenantContext, input: CreateDebitNoteInput, meta: any): Promise<DebitNoteResponse> {
    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', input.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const party = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.partyId, archivedAt: null }).lean();
    if (!party) throw notFound('Party');

    const bill = await this.models.SupplierBill.findOne({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      supplierId: party._id,
      _id: input.supplierBillId,
      status: 'posted',
    }).lean();
    if (!bill) throw notFound('Supplier bill');

    const isInterState = party.gstins?.[0]?.stateCode !== entity.address.stateCode;

    // Validate cumulative return quantities against original bill
    const existingDNs = await this.models.DebitNote.find({
      tenantId: ctx.tenantId,
      supplierBillId: bill._id,
      status: trusted({ $in: ['draft', 'issued'] }),
    }).lean();

    for (const l of input.lines) {
      if (!l.qty) continue;
      const billLine = l.sourceLineId
        ? bill.lines.find((bl) => bl.lineId === l.sourceLineId)
        : l.itemId
          ? bill.lines.find((bl) => bl.itemId?.toString() === l.itemId)
          : null;

      if (billLine && billLine.qty) {
        const origQty = dec(fromDecimal(billLine.qty) ?? '0');
        let priorReturnedQty = dec('0');
        for (const edn of existingDNs) {
          for (const el of edn.lines) {
            const matches = el.sourceLineId
              ? el.sourceLineId === billLine.lineId
              : el.itemId && billLine.itemId && el.itemId.toString() === billLine.itemId.toString();
            if (matches && el.qty) {
              priorReturnedQty = priorReturnedQty.plus(dec(fromDecimal(el.qty) ?? '0'));
            }
          }
        }
        const requestedQty = dec(l.qty);
        if (priorReturnedQty.plus(requestedQty).gt(origQty)) {
          const maxAvail = origQty.minus(priorReturnedQty);
          throw rule(`Cannot return quantity ${l.qty}; only ${maxAvail.isNegative() ? '0' : maxAvail.toString()} available to return for ${billLine.item?.name ?? 'item'}`);
        }
      }
    }

    let sumTaxable = dec('0');
    let sumCgst = dec('0');
    let sumSgst = dec('0');
    let sumUtgst = dec('0');
    let sumIgst = dec('0');
    let sumCess = dec('0');

    const lineDocs: NoteLineDoc[] = [];

    for (const l of input.lines) {
      let itemName: string | null = null;
      let sku: string | null = null;
      let itemObjId: Types.ObjectId | null = null;

      if (l.itemId) {
        const item = await this.models.Item.findOne({ tenantId: ctx.tenantId, _id: l.itemId }).lean();
        if (item) {
          itemName = item.name;
          sku = item.sku;
          itemObjId = item._id;
        }
      } else if (l.sourceLineId) {
        const billLine = bill.lines.find((bl) => bl.lineId === l.sourceLineId);
        if (billLine) {
          itemName = billLine.item.name;
          sku = billLine.item.sku;
          itemObjId = billLine.itemId;
        }
      }

      const taxable = l.qty ? dec(l.qty).times(dec(l.unitPrice)) : dec(l.unitPrice);
      const calculated = calculateNoteLineAmounts(money(taxable), l.taxRate ?? null, isInterState);

      sumTaxable = sumTaxable.plus(dec(calculated.taxable));
      sumCgst = sumCgst.plus(dec(calculated.cgst));
      sumSgst = sumSgst.plus(dec(calculated.sgst));
      sumUtgst = sumUtgst.plus(dec(calculated.utgst));
      sumIgst = sumIgst.plus(dec(calculated.igst));
      sumCess = sumCess.plus(dec(calculated.cess));

      lineDocs.push({
        lineId: newLineId(),
        sourceLineId: l.sourceLineId ?? null,
        itemId: itemObjId,
        itemName,
        sku,
        qty: l.qty ? toDecimal(l.qty) : null,
        unitPrice: toDecimal(l.unitPrice),
        taxRate: l.taxRate ? toDecimal(l.taxRate) : null,
        taxable: toDecimal(calculated.taxable),
        cgst: toDecimal(calculated.cgst),
        sgst: toDecimal(calculated.sgst),
        utgst: toDecimal(calculated.utgst),
        igst: toDecimal(calculated.igst),
        cess: toDecimal(calculated.cess),
        total: toDecimal(calculated.total),
        reason: l.reason ?? null,
      });
    }

    const subtotal = sumTaxable.plus(sumCgst).plus(sumSgst).plus(sumUtgst).plus(sumIgst).plus(sumCess);
    const grandRounded = subtotal.round();
    const roundOff = grandRounded.minus(subtotal);

    const amounts: NoteAmountsDoc = {
      taxable: toDecimal(money(sumTaxable)),
      cgst: toDecimal(money(sumCgst)),
      sgst: toDecimal(money(sumSgst)),
      utgst: toDecimal(money(sumUtgst)),
      igst: toDecimal(money(sumIgst)),
      cess: toDecimal(money(sumCess)),
      roundOff: toDecimal(money(roundOff)),
      grand: toDecimal(money(grandRounded)),
    };

    const dn = await this.models.DebitNote.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      partyId: party._id,
      partyName: party.name,
      supplierBillId: bill._id,
      supplierBillNumber: bill.number ?? bill.supplierInvoiceNumber,
      number: null,
      kind: input.kind,
      status: 'draft',
      docDate: input.docDate,
      reason: input.reason,
      warehouseId: input.warehouseId ? new Types.ObjectId(input.warehouseId) : (bill.warehouseId ?? null),
      lines: lineDocs,
      amounts,
      notes: input.notes ?? '',
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'debit_note.created',
      entityType: 'debit_note',
      entityId: dn._id.toHexString(),
      summary: `Created debit note draft for ${party.name} against bill ${bill.number}`,
    });

    return mapDebitNoteResponse(dn);
  }

  async issueDebitNote(ctx: TenantContext, id: string, meta: any): Promise<DebitNoteResponse> {
    const dn = await this.models.DebitNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!dn) throw notFound('Debit note');
    if (dn.status !== 'draft') throw invalidState('Only draft debit notes can be issued');

    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', dn.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: dn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && dn.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: dn.supplierBillId }).lean();
    if (!bill) throw notFound('Supplier bill');

    return await withTransaction(this.models.DebitNote.db, async (session) => {
      // 0. Immediate write lock on SupplierBill to serialize concurrent note issuances
      const billDoc = (await this.models.SupplierBill.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: bill._id },
        { $inc: { version: 1 } },
        { session, new: true },
      )) as HydratedDocument<SupplierBillDoc> | null;
      if (!billDoc) throw notFound('Supplier bill');

      // 1. Assign number
      const count = await this.models.DebitNote.countDocuments({ tenantId: ctx.tenantId }, { session });
      const dnNumber = `DN/${dn.docDate.slice(0, 4)}/${String(count + 1).padStart(4, '0')}`;
      dn.number = dnNumber;

      // 1b. Concurrency check: Re-validate cumulative return quantities inside transaction
      const issuedDNs = await this.models.DebitNote.find({
        tenantId: ctx.tenantId,
        supplierBillId: bill._id,
        status: 'issued',
        _id: trusted({ $ne: dn._id }),
      }).session(session).lean();

      for (const l of dn.lines) {
        if (!l.qty) continue;
        const billLine = l.sourceLineId
          ? bill.lines.find((bl) => bl.lineId === l.sourceLineId)
          : l.itemId
            ? bill.lines.find((bl) => bl.itemId?.toString() === l.itemId?.toString())
            : null;

        if (billLine && billLine.qty) {
          const origQty = dec(fromDecimal(billLine.qty) ?? '0');
          let priorReturnedQty = dec('0');
          for (const edn of issuedDNs) {
            for (const el of edn.lines) {
              const matches = el.sourceLineId
                ? el.sourceLineId === billLine.lineId
                : el.itemId && billLine.itemId && el.itemId.toString() === billLine.itemId.toString();
              if (matches && el.qty) {
                priorReturnedQty = priorReturnedQty.plus(dec(fromDecimal(el.qty) ?? '0'));
              }
            }
          }
          const requestedQty = dec(fromDecimal(l.qty) ?? '0');
          if (priorReturnedQty.plus(requestedQty).gt(origQty)) {
            const maxAvail = origQty.minus(priorReturnedQty);
            throw rule(`Cannot return quantity ${requestedQty}; only ${maxAvail.isNegative() ? '0' : maxAvail.toString()} available to return`);
          }
        }
      }

      // 2. Physical stock deduction if purchase_return
      if (dn.kind === 'purchase_return' && dn.warehouseId) {
        const stockLines = dn.lines.filter((l) => l.itemId && l.qty);
        if (stockLines.length > 0) {
          await this.ledger.ensureRows(
            ctx.tenantId,
            dn.legalEntityId,
            stockLines.map((l) => ({ warehouseId: dn.warehouseId!, itemId: l.itemId! })),
          );

          const postLines: PostLine[] = stockLines.map((l) => {
            const billLine = bill.lines.find((bl) => bl.itemId.equals(l.itemId!));
            const returnCost = billLine ? fromDecimal(billLine.unitPrice) ?? '0.00' : '0.00';
            const returnQty = fromDecimal(l.qty!) ?? '1';
            const returnVal = money(dec(returnCost).times(dec(returnQty)));

            return {
              warehouseId: dn.warehouseId!,
              itemId: l.itemId!,
              label: l.itemName ?? 'Returned Stock Item',
              qty: returnQty,
              kind: 'return_out',
              sourceLineId: l.lineId,
              effect: {
                type: 'receipt_return',
                value: returnVal,
                reversalOf: null,
              },
            };
          });

          await this.ledger.post(
            {
              session,
              tenantId: ctx.tenantId,
              legalEntityId: dn.legalEntityId,
              allowNegative: false,
              docDate: dn.docDate,
              sourceType: 'purchase_return',
              sourceId: dn._id,
              sourceNumber: dn.number,
              actorId: ctx.userId,
              now: new Date(),
            },
            postLines,
          );
        }
      }

      // 3. Update bill outstanding balance
      if (billDoc) {
        const curOut = dec(billDoc.outstanding.toString());
        const dnGrand = dec(fromDecimal(dn.amounts.grand) ?? '0.00');
        const newOut = curOut.minus(dnGrand);
        const finalOut = newOut.isNegative() ? '0.00' : money(newOut);
        billDoc.outstanding = toDecimal(finalOut);
        billDoc.paymentStatus = obligationPaymentStatus(fromDecimal(billDoc.totals.grand) ?? '0.00', finalOut);
        await billDoc.save({ session });

        // Defect C: If excess debit note amount beyond outstanding, preserve as unallocated supplier credit
        if (newOut.isNegative()) {
          const excess = newOut.abs();
          if (excess.gt(0)) {
            const excessPayment = new this.models.Payment({
              tenantId: ctx.tenantId,
              legalEntityId: dn.legalEntityId,
              partyId: bill.supplierId,
              partyName: dn.partyName,
              direction: 'outgoing',
              recordKind: 'debit_note_excess',
              sourceNoteId: dn._id,
              sourceNoteNumber: dn.number,
              amount: toDecimal(money(excess)),
              unallocatedAmount: toDecimal(money(excess)),
              paymentMethod: 'credit',
              docDate: dn.docDate,
              reference: dn.number,
              status: 'posted',
              number: `CR-DN-${dn.number.replace(/\//g, '-')}`,
              notes: `Unallocated supplier credit from Debit Note ${dn.number} for Bill #${bill.number ?? bill.supplierInvoiceNumber}`,
              postedAt: new Date(),
              postedBy: ctx.userId,
              createdBy: ctx.userId,
            });
            await excessPayment.save({ session });
          }
        }
      }

      // 4. Double-entry journal
      const jLines = debitNoteJournalLines({
        grand: fromDecimal(dn.amounts.grand) ?? '0.00',
        taxable: fromDecimal(dn.amounts.taxable) ?? '0.00',
        cgst: fromDecimal(dn.amounts.cgst) ?? '0.00',
        sgst: fromDecimal(dn.amounts.sgst) ?? '0.00',
        utgst: fromDecimal(dn.amounts.utgst) ?? '0.00',
        igst: fromDecimal(dn.amounts.igst) ?? '0.00',
        cess: fromDecimal(dn.amounts.cess) ?? '0.00',
        roundOff: fromDecimal(dn.amounts.roundOff) ?? '0.00',
        isStock: dn.lines.some((l) => Boolean(l.itemId)),
        itcEligible: bill.itcEligible ?? true,
      });

      await this.journals.ensureAccounts(ctx.tenantId, dn.legalEntityId, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: dn.legalEntityId,
        docDate: dn.docDate,
        sourceType: 'debit_note',
        sourceId: dn._id,
        sourceNumber: dn.number,
        narration: `Debit Note ${dn.number} to ${dn.partyName} (Bill #${dn.supplierBillNumber}): ${dn.reason}`,
        lines: jLines,
        actorId: ctx.userId,
        now: new Date(),
      });

      dn.status = 'issued';
      dn.issuedAt = new Date();
      dn.issuedBy = ctx.userId;
      dn.version += 1;

      await dn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'debit_note.issued',
          entityType: 'debit_note',
          entityId: dn._id.toHexString(),
          summary: `Issued debit note ${dn.number} for ₹${fromDecimal(dn.amounts.grand)} to ${dn.partyName}`,
        },
        session,
      );

      return mapDebitNoteResponse(dn);
    });
  }

  async cancelDebitNote(ctx: TenantContext, id: string, reason: string, meta: any): Promise<DebitNoteResponse> {
    const dn = await this.models.DebitNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!dn) throw notFound('Debit note');
    if (dn.status !== 'issued') throw invalidState('Only issued debit notes can be cancelled');

    if (!ctx.permissions.has('note.issue') && !canInEntity(ctx, 'note.issue', dn.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: dn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    if (entity.periodLockDate && dn.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    return await withTransaction(this.models.DebitNote.db, async (session) => {
      // 1. Reverse journal
      await this.journals.reverse(session, {
        tenantId: ctx.tenantId,
        sourceType: 'debit_note',
        sourceId: dn._id,
        docDate: todayIST(),
        narration: `Cancellation of debit note ${dn.number}: ${reason}`,
        actorId: ctx.userId,
        now: new Date(),
      });

      // 2. Restore bill outstanding
      const billDoc = (await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: dn.supplierBillId }).session(session)) as HydratedDocument<SupplierBillDoc> | null;
      if (billDoc) {
        const curOut = dec(billDoc.outstanding.toString());
        const dnGrand = dec(fromDecimal(dn.amounts.grand) ?? '0.00');
        const restoredOut = money(curOut.plus(dnGrand));
        billDoc.outstanding = toDecimal(restoredOut);
        billDoc.paymentStatus = obligationPaymentStatus(fromDecimal(billDoc.totals.grand) ?? '0.00', restoredOut);
        billDoc.version += 1;
        await billDoc.save({ session });
      }

      // 2b. Check and reverse linked unallocated excess supplier credit if any
      const excessRecord = (await this.models.Payment.findOne({
        tenantId: ctx.tenantId,
        sourceNoteId: dn._id,
        status: 'posted',
      }).session(session)) as HydratedDocument<PaymentDoc> | null;

      if (excessRecord) {
        const unalloc = dec(excessRecord.unallocatedAmount.toString());
        const origAmt = dec(excessRecord.amount.toString());
        if (unalloc.lessThan(origAmt)) {
          throw rule(`Cannot cancel debit note ${dn.number}: unallocated supplier credit has already been partially or fully allocated or refunded. Rollback settlements first.`);
        }
        excessRecord.status = 'reversed';
        excessRecord.unallocatedAmount = toDecimal('0.00');
        excessRecord.reversedAt = new Date();
        excessRecord.reversedBy = ctx.userId;
        excessRecord.reversedReason = `Source debit note ${dn.number} cancelled`;
        excessRecord.version += 1;
        await excessRecord.save({ session });
      }

      // 3. Rollback returned stock if purchase_return
      if (dn.kind === 'purchase_return' && dn.warehouseId) {
        const stockLines = dn.lines.filter((l) => l.itemId && l.qty);
        if (stockLines.length > 0) {
          const postLines: PostLine[] = stockLines.map((l) => ({
            warehouseId: dn.warehouseId!,
            itemId: l.itemId!,
            label: l.itemName ?? 'Purchase Return Reversal',
            qty: fromDecimal(l.qty!) ?? '1',
            kind: 'receipt',
            sourceLineId: l.lineId,
            effect: { type: 'receive', unitCost: fromDecimal(l.unitPrice) ?? '0.00' },
          }));

          await this.ledger.post(
            {
              session,
              tenantId: ctx.tenantId,
              legalEntityId: dn.legalEntityId,
              allowNegative: true,
              docDate: todayIST(),
              sourceType: 'purchase_return',
              sourceId: dn._id,
              sourceNumber: dn.number ?? '',
              actorId: ctx.userId,
              now: new Date(),
            },
            postLines,
          );
        }
      }

      dn.status = 'cancelled';
      dn.cancelledAt = new Date();
      dn.cancelledBy = ctx.userId;
      dn.cancelReason = reason;
      dn.version += 1;

      await dn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'debit_note.cancelled',
          entityType: 'debit_note',
          entityId: dn._id.toHexString(),
          summary: `Cancelled debit note ${dn.number}: ${reason}`,
        },
        session,
      );

      return mapDebitNoteResponse(dn);
    });
  }

  // ---------------------------------------------------------------- Lists and Gets
  async getCreditNote(ctx: TenantContext, id: string): Promise<CreditNoteResponse> {
    const cn = await this.models.CreditNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!cn) throw notFound('Credit note');
    return mapCreditNoteResponse(cn);
  }

  async listCreditNotes(ctx: TenantContext, query: NoteListQuery): Promise<{ data: CreditNoteResponse[]; page: { nextCursor: string | null; limit: number } }> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.kind) filter.kind = query.kind;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      filter.docDate = {};
      if (query.from) (filter.docDate as any).$gte = query.from;
      if (query.to) (filter.docDate as any).$lte = query.to;
    }
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 25, 100);
    const docs = await this.models.CreditNote.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toHexString() ?? null : null;

    return {
      data: pageDocs.map(mapCreditNoteResponse),
      page: { nextCursor, limit },
    };
  }

  async getDebitNote(ctx: TenantContext, id: string): Promise<DebitNoteResponse> {
    const dn = await this.models.DebitNote.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!dn) throw notFound('Debit note');
    return mapDebitNoteResponse(dn);
  }

  async listDebitNotes(ctx: TenantContext, query: NoteListQuery): Promise<{ data: DebitNoteResponse[]; page: { nextCursor: string | null; limit: number } }> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.kind) filter.kind = query.kind;
    if (query.status) filter.status = query.status;
    if (query.from || query.to) {
      filter.docDate = {};
      if (query.from) (filter.docDate as any).$gte = query.from;
      if (query.to) (filter.docDate as any).$lte = query.to;
    }
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 25, 100);
    const docs = await this.models.DebitNote.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toHexString() ?? null : null;

    return {
      data: pageDocs.map(mapDebitNoteResponse),
      page: { nextCursor, limit },
    };
  }
}
