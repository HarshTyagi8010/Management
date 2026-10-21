import { type HydratedDocument, trusted, Types } from 'mongoose';
import type {
  CreateSupplierBillInput,
  Page,
  PostSupplierBillCommand,
  SupplierBillResponse,
} from '@bizmgmt/contracts';
import {
  billLineCost,
  calculate,
  dec,
  goodsReceiptProgress,
  money,
  purchaseOrderProgress,
  supplierRoundOff,
  type CalcLine,
  type CalcLineInput,
  type CalcResult,
} from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { RateScheduleDoc } from '../../models-business.js';
import type {
  AmountsDoc,
  HsnRowDoc,
  Models,
  PurchaseOrderDoc,
  GoodsReceiptDoc,
  SupplierBillDoc,
  SupplierBillLineDoc,
  TotalsDoc,
} from '../../models.js';
import { fromDecimal, toDecimal, todayIST } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import type { AuditLog } from '../audit/audit.js';
import type { JournalService } from '../finance/journals.js';
import { supplierBillJournalLines } from '../finance/journals.js';
import type { NumberingService } from '../finance/numbering.js';
import type { RequestMeta } from '../identity/identity.js';
import type { PostLine, StockLedger } from '../inventory/ledger.js';
import { canInEntity, canInWarehouse, type TenantContext } from '../tenancy/tenancy.js';
import {
  buildBuyerSnapshot,
  buildSupplierSnapshot,
  canViewCost,
  forbidden,
  invalidState,
  mapSupplierBillResponse,
  newLineId,
  notFound,
  preparePurchaseSeries,
  recordAudit,
  rule,
  takePurchaseNumber,
  visibleEntityFilter,
} from './core.js';

export class SupplierBillService {
  constructor(
    private readonly models: Models,
    private readonly audit: AuditLog,
    private readonly numbering: NumberingService,
    private readonly journals: JournalService,
    private readonly ledger: StockLedger,
  ) {}

  private async calculateLines(
    tenantId: Types.ObjectId,
    docDate: string,
    placeOfSupply: string,
    linesInput: CreateSupplierBillInput['lines'],
    documentDiscount?: string,
    supplierTotal?: string,
  ) {
    const itemIds = linesInput.map((l) => new Types.ObjectId(l.itemId));
    const items = await this.models.Item.find({ tenantId, _id: trusted({ $in: itemIds }) }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    const unitIds = items.map((i) => i.baseUnitId);
    const units = await this.models.Unit.find({ tenantId, _id: trusted({ $in: unitIds }) }).lean();
    const unitMap = new Map(units.map((u) => [u._id.toString(), u]));

    const taxClassIds = [
      ...linesInput.map((l) => l.taxClassId).filter(Boolean),
      ...items.map((i) => i.taxClassId?.toString()).filter(Boolean),
    ] as string[];
    const taxClasses = taxClassIds.length > 0 ? await this.models.TaxClass.find({ tenantId, _id: trusted({ $in: taxClassIds.map((id) => new Types.ObjectId(id)) }) }).lean() : [];
    const taxClassMap = new Map(taxClasses.map((t) => [t._id.toString(), t]));

    const calcLines: CalcLineInput[] = [];
    const lineDocs: SupplierBillLineDoc[] = [];

    for (const l of linesInput) {
      const item = itemMap.get(l.itemId);
      if (!item) throw notFound(`Item ${l.itemId}`);
      const unit = unitMap.get(item.baseUnitId.toString());
      if (!unit) throw notFound(`Unit for item ${item.sku}`);

      let taxRate: string | null = null;
      let cessRate: string | null = null;

      const targetTaxClassId = l.taxClassId ?? item.taxClassId?.toString();
      if (targetTaxClassId) {
        const tc = taxClassMap.get(targetTaxClassId);
        if (tc) {
          const schedule = tc.schedules?.find((s: RateScheduleDoc) => s.effectiveFrom <= docDate && (!s.effectiveTo || s.effectiveTo >= docDate));
          if (schedule) {
            taxRate = fromDecimal(schedule.gstRate);
            cessRate = schedule.cessRate ? fromDecimal(schedule.cessRate) : null;
          }
        }
      }

      calcLines.push({
        qty: l.qty,
        unitPrice: l.unitPrice,
        discount: l.discountPercent ? { type: 'percent', value: l.discountPercent } : l.discountAmount ? { type: 'amount', value: l.discountAmount } : null,
        hsnSac: item.hsnSac || '',
        taxRate,
        cessRate,
        reverseCharge: false,
      });

      lineDocs.push({
        lineId: l.id ?? newLineId(),
        itemId: item._id,
        item: {
          sku: item.sku,
          name: item.name,
          type: item.type,
          hsnSac: item.hsnSac,
          unitCode: unit.code,
          uqc: unit.uqc,
          decimals: unit.decimals,
        },
        description: l.description || '',
        qty: toDecimal(l.qty),
        unitPrice: toDecimal(l.unitPrice),
        discount: l.discountPercent ? { type: 'percent', value: toDecimal(l.discountPercent) } : l.discountAmount ? { type: 'amount', value: toDecimal(l.discountAmount) } : null,
        taxRate: taxRate ? toDecimal(taxRate) : null,
        cessRate: cessRate ? toDecimal(cessRate) : null,
        reverseCharge: false,
        amounts: {} as AmountsDoc,
        sourceLineId: l.sourceLineId ?? null,
        goodsReceiptLineId: l.goodsReceiptLineId ?? null,
      });
    }

    const calculated = calculate({
      supply: 'intra',
      utgst: false,
      noTax: false,
      documentDiscount: documentDiscount ?? '0.00',
      roundOff: true,
      lines: calcLines,
    });

    let roundOff = calculated.totals.roundOff;
    let grand = calculated.totals.grand;

    if (supplierTotal) {
      const computedRoundOff = supplierRoundOff(calculated.totals.subtotal, supplierTotal);
      if (computedRoundOff === null) {
        throw rule('The supplier invoice total differs from the calculated total by more than ₹1.00', 'supplierTotal');
      }
      roundOff = computedRoundOff;
      grand = supplierTotal;
    }

    calculated.lines.forEach((cl: CalcLine, idx: number) => {
      const ld = lineDocs[idx]!;
      ld.amounts = {
        gross: toDecimal(cl.gross),
        discount: toDecimal(cl.discount),
        net: toDecimal(cl.net),
        documentDiscount: toDecimal(cl.documentDiscount),
        taxable: toDecimal(cl.taxable),
        cgst: toDecimal(cl.cgst),
        sgst: toDecimal(cl.sgst),
        utgst: toDecimal(cl.utgst),
        igst: toDecimal(cl.igst),
        cess: toDecimal(cl.cess),
        taxCharged: toDecimal(cl.taxCharged),
        total: toDecimal(cl.total),
      };
    });

    const totalsDoc: TotalsDoc = {
      gross: toDecimal(calculated.totals.gross),
      discount: toDecimal(calculated.totals.discount),
      taxable: toDecimal(calculated.totals.taxable),
      cgst: toDecimal(calculated.totals.cgst),
      sgst: toDecimal(calculated.totals.sgst),
      utgst: toDecimal(calculated.totals.utgst),
      igst: toDecimal(calculated.totals.igst),
      cess: toDecimal(calculated.totals.cess),
      taxCharged: toDecimal(calculated.totals.taxCharged),
      reverseChargeTax: toDecimal(calculated.totals.reverseChargeTax),
      subtotal: toDecimal(calculated.totals.subtotal),
      roundOff: toDecimal(roundOff),
      grand: toDecimal(grand),
    };

    const hsnSummary: HsnRowDoc[] = calculated.hsnSummary.map((h: CalcResult['hsnSummary'][number]) => ({
      hsnSac: h.hsnSac,
      rate: h.rate ? toDecimal(h.rate) : null,
      reverseCharge: h.reverseCharge,
      taxable: toDecimal(h.taxable),
      cgst: toDecimal(h.cgst),
      sgst: toDecimal(h.sgst),
      utgst: toDecimal(h.utgst),
      igst: toDecimal(h.igst),
      cess: toDecimal(h.cess),
    }));

    return { lineDocs, totalsDoc, hsnSummary };
  }

  async createDraft(ctx: TenantContext, input: CreateSupplierBillInput, meta: RequestMeta): Promise<SupplierBillResponse> {
    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    if (!canInEntity(ctx, 'purchase.edit', entity._id)) throw forbidden();

    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');

    // Duplicate supplier invoice check
    const existing = await this.models.SupplierBill.findOne({
      tenantId: ctx.tenantId,
      supplierId: supplier._id,
      supplierInvoiceNumber: input.supplierInvoiceNumber,
      status: trusted({ $in: ['draft', 'posted'] }),
    }).lean();
    if (existing) {
      throw new AppError('DUPLICATE', `Supplier invoice number "${input.supplierInvoiceNumber}" already exists for this supplier`, [
        { path: 'supplierInvoiceNumber', message: 'Supplier invoice number already exists' },
      ]);
    }

    let po: PurchaseOrderDoc | null = null;
    if (input.purchaseOrderId) {
      po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: input.purchaseOrderId }).lean();
      if (!po) throw notFound('Purchase order');
    }

    let grn: GoodsReceiptDoc | null = null;
    if (input.goodsReceiptId) {
      grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: input.goodsReceiptId }).lean();
      if (!grn) throw notFound('Goods receipt');
    }

    const { lineDocs, totalsDoc, hsnSummary } = await this.calculateLines(
      ctx.tenantId,
      input.docDate,
      supplier.gstins?.[0]?.stateCode ?? entity.address.stateCode,
      input.lines,
      input.documentDiscount,
      input.supplierTotal,
    );

    const bill = await this.models.SupplierBill.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      supplierId: supplier._id,
      supplierName: supplier.name,
      warehouseId: input.warehouseId ? new Types.ObjectId(input.warehouseId) : (grn?.warehouseId ?? po?.warehouseId ?? null),
      purchaseOrderId: po?._id ?? null,
      goodsReceiptId: grn?._id ?? null,
      docType: 'supplier_bill',
      status: 'draft',
      paymentStatus: 'unpaid',
      number: null,
      supplierInvoiceNumber: input.supplierInvoiceNumber,
      supplierInvoiceDate: input.supplierInvoiceDate,
      docDate: input.docDate,
      dueDate: input.dueDate ?? null,
      itcEligible: input.itcEligible ?? true,
      documentDiscount: toDecimal(input.documentDiscount ?? '0.00'),
      supplierTotal: input.supplierTotal ? toDecimal(input.supplierTotal) : null,
      notes: input.notes ?? '',
      lines: lineDocs,
      totals: totalsDoc,
      hsnSummary,
      calcVersion: '1',
      outstanding: totalsDoc.grand,
      supplier: buildSupplierSnapshot(supplier),
      buyer: buildBuyerSnapshot(entity),
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'supplier_bill.created',
      entityType: 'supplier_bill',
      entityId: bill._id.toHexString(),
      summary: `Created supplier bill draft for ${supplier.name} (Inv #${input.supplierInvoiceNumber})`,
    });

    return mapSupplierBillResponse(bill, canViewCost(ctx));
  }

  async updateDraft(ctx: TenantContext, id: string, input: CreateSupplierBillInput, meta: RequestMeta): Promise<SupplierBillResponse> {
    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!bill) throw notFound('Supplier bill');
    if (bill.status !== 'draft') throw invalidState('Only draft supplier bills can be updated');
    if (!canInEntity(ctx, 'purchase.edit', bill.legalEntityId)) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');

    // Duplicate check if invoice number or supplier changed
    if (bill.supplierInvoiceNumber !== input.supplierInvoiceNumber || !bill.supplierId.equals(supplier._id)) {
      const existing = await this.models.SupplierBill.findOne({
        tenantId: ctx.tenantId,
        supplierId: supplier._id,
        supplierInvoiceNumber: input.supplierInvoiceNumber,
        status: trusted({ $in: ['draft', 'posted'] }),
        _id: trusted({ $ne: bill._id }),
      }).lean();
      if (existing) {
        throw new AppError('DUPLICATE', `Supplier invoice number "${input.supplierInvoiceNumber}" already exists for this supplier`, [
          { path: 'supplierInvoiceNumber', message: 'Supplier invoice number already exists' },
        ]);
      }
    }

    let po: PurchaseOrderDoc | null = null;
    if (input.purchaseOrderId) {
      po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: input.purchaseOrderId }).lean();
    }

    let grn: GoodsReceiptDoc | null = null;
    if (input.goodsReceiptId) {
      grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: input.goodsReceiptId }).lean();
    }

    const { lineDocs, totalsDoc, hsnSummary } = await this.calculateLines(
      ctx.tenantId,
      input.docDate,
      supplier.gstins?.[0]?.stateCode ?? entity.address.stateCode,
      input.lines,
      input.documentDiscount,
      input.supplierTotal,
    );

    bill.legalEntityId = entity._id;
    bill.supplierId = supplier._id;
    bill.supplierName = supplier.name;
    bill.warehouseId = input.warehouseId ? new Types.ObjectId(input.warehouseId) : (grn?.warehouseId ?? po?.warehouseId ?? null);
    bill.purchaseOrderId = po?._id ?? null;
    bill.goodsReceiptId = grn?._id ?? null;
    bill.supplierInvoiceNumber = input.supplierInvoiceNumber;
    bill.supplierInvoiceDate = input.supplierInvoiceDate;
    bill.docDate = input.docDate;
    bill.dueDate = input.dueDate ?? null;
    bill.itcEligible = input.itcEligible ?? true;
    bill.documentDiscount = toDecimal(input.documentDiscount ?? '0.00');
    bill.supplierTotal = input.supplierTotal ? toDecimal(input.supplierTotal) : null;
    bill.notes = input.notes ?? '';
    bill.lines = lineDocs;
    bill.totals = totalsDoc;
    bill.hsnSummary = hsnSummary;
    bill.calcVersion = '1';
    bill.outstanding = totalsDoc.grand;
    bill.supplier = buildSupplierSnapshot(supplier);
    bill.buyer = buildBuyerSnapshot(entity);
    bill.version += 1;

    await bill.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'supplier_bill.updated',
      entityType: 'supplier_bill',
      entityId: bill._id.toHexString(),
      summary: `Updated supplier bill draft for ${supplier.name} (Inv #${input.supplierInvoiceNumber})`,
    });

    return mapSupplierBillResponse(bill, canViewCost(ctx));
  }

  async getById(ctx: TenantContext, id: string): Promise<SupplierBillResponse> {
    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!bill) throw notFound('Supplier bill');
    if (!canInEntity(ctx, 'purchase.edit', bill.legalEntityId) && !canInEntity(ctx, 'report.financial', bill.legalEntityId)) {
      throw notFound('Supplier bill');
    }
    return mapSupplierBillResponse(bill, canViewCost(ctx));
  }

  async list(
    ctx: TenantContext,
    query: {
      legalEntityId?: string | undefined;
      supplierId?: string | undefined;
      purchaseOrderId?: string | undefined;
      goodsReceiptId?: string | undefined;
      status?: string | undefined;
      paymentStatus?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ): Promise<Page<SupplierBillResponse>> {
    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      ...visibleEntityFilter(ctx, 'purchase.edit', query.legalEntityId),
    };
    if (query.supplierId) filter.supplierId = new Types.ObjectId(query.supplierId);
    if (query.purchaseOrderId) filter.purchaseOrderId = new Types.ObjectId(query.purchaseOrderId);
    if (query.goodsReceiptId) filter.goodsReceiptId = new Types.ObjectId(query.goodsReceiptId);
    if (query.status) filter.status = query.status;
    if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 50, 100);
    const docs = await this.models.SupplierBill.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toString() ?? null : null;

    const hasCost = canViewCost(ctx);
    return {
      data: pageDocs.map((d) => mapSupplierBillResponse(d, hasCost)),
      page: { nextCursor, limit },
    };
  }

  async post(ctx: TenantContext, id: string, meta: RequestMeta, _cmd?: PostSupplierBillCommand): Promise<SupplierBillResponse> {
    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!bill) throw notFound('Supplier bill');
    if (bill.status !== 'draft') throw invalidState('Only draft supplier bills can be posted');
    if (!canInEntity(ctx, 'bill.post', bill.legalEntityId)) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: bill.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    // Period lock check
    if (entity.periodLockDate && bill.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked for this business entity`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    const stockInPoint = entity.workflow?.stockInPoint ?? 'goods_receipt';

    // Ensure rows for stock if direct supplier bill
    const stockLines = bill.lines.filter((bl) => bl.item.type === 'stock');
    if (stockInPoint === 'supplier_bill' && bill.warehouseId && stockLines.length > 0) {
      await this.ledger.ensureRows(
        ctx.tenantId,
        bill.legalEntityId,
        stockLines.map((l) => ({ warehouseId: bill.warehouseId!, itemId: l.itemId })),
      );
    }

    const series = await preparePurchaseSeries(this.models, this.numbering, ctx, 'supplier_bill', bill.legalEntityId, null, bill.docDate);

    return await withTransaction(this.models.SupplierBill.db, async (session) => {
      // 1. Assign gap-free number
      const allocated = await takePurchaseNumber(session, this.numbering, ctx, series, bill.docDate);
      bill.number = allocated.number;

      // 2. If linked to PO, track billed quantities
      if (bill.purchaseOrderId) {
        const po = (await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: bill.purchaseOrderId }).session(session)) as HydratedDocument<PurchaseOrderDoc> | null;
        if (po) {
          for (const bl of bill.lines) {
            const poLine = bl.sourceLineId ? po.lines.find((pl) => pl.lineId === bl.sourceLineId) : undefined;
            if (poLine) {
              const currentBilled = dec(poLine.billedQty?.toString() ?? '0');
              const addQty = dec(bl.qty.toString());
              poLine.billedQty = toDecimal(currentBilled.plus(addQty).toString());
            }
          }
          po.version += 1;
          await po.save({ session });
        }
      }

      // 3. If linked to GRN, track billed quantities
      if (bill.goodsReceiptId) {
        const grn = (await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: bill.goodsReceiptId }).session(session)) as HydratedDocument<GoodsReceiptDoc> | null;
        if (grn) {
          for (const bl of bill.lines) {
            const grLine = bl.goodsReceiptLineId ? grn.lines.find((gl) => gl.lineId === bl.goodsReceiptLineId) : undefined;
            if (grLine) {
              const currentBilled = dec(grLine.billedQty.toString());
              const addQty = dec(bl.qty.toString());
              grLine.billedQty = toDecimal(currentBilled.plus(addQty).toString());
            }
          }
          const grnLinesMapped = grn.lines.map((l) => ({ qty: l.qty.toString(), billed: l.billedQty.toString() }));
          grn.status = goodsReceiptProgress(grnLinesMapped);
          grn.version += 1;
          await grn.save({ session });
        }
      }

      // 4. Stock movement if direct bill
      if (stockInPoint === 'supplier_bill' && bill.warehouseId && stockLines.length > 0) {
        const postLines: PostLine[] = stockLines.map((bl) => ({
          warehouseId: bill.warehouseId!,
          itemId: bl.itemId,
          label: bl.item.name,
          qty: bl.qty.toString(),
          kind: 'receipt',
          sourceLineId: bl.lineId,
          effect: {
            type: 'receive',
            unitCost: fromDecimal(bl.unitPrice) ?? '0.00',
          },
        }));

        await this.ledger.post(
          {
            session,
            tenantId: ctx.tenantId,
            legalEntityId: bill.legalEntityId,
            allowNegative: entity.workflow?.allowNegativeStock ?? false,
            docDate: bill.docDate,
            sourceType: 'supplier_bill',
            sourceId: bill._id,
            sourceNumber: bill.number,
            actorId: ctx.userId,
            now: new Date(),
          },
          postLines,
        );
      }

      // 5. Post double-entry Trade Payable journal
      let stockCost = dec('0');
      let nonStockCost = dec('0');

      for (const l of bill.lines) {
        const costVal = billLineCost(
          {
            taxable: l.amounts.taxable.toString(),
            cgst: l.amounts.cgst.toString(),
            sgst: l.amounts.sgst.toString(),
            utgst: l.amounts.utgst.toString(),
            igst: l.amounts.igst.toString(),
            cess: l.amounts.cess.toString(),
          },
          bill.itcEligible,
        );

        if (l.item.type === 'stock') {
          stockCost = stockCost.plus(dec(costVal));
        } else {
          nonStockCost = nonStockCost.plus(dec(costVal));
        }
      }

      const journalLines = supplierBillJournalLines({
        grand: fromDecimal(bill.totals.grand) ?? '0.00',
        stockCost: money(stockCost),
        nonStockCost: money(nonStockCost),
        cgst: bill.itcEligible ? (fromDecimal(bill.totals.cgst) ?? '0.00') : '0.00',
        sgst: bill.itcEligible ? (fromDecimal(bill.totals.sgst) ?? '0.00') : '0.00',
        utgst: bill.itcEligible ? (fromDecimal(bill.totals.utgst) ?? '0.00') : '0.00',
        igst: bill.itcEligible ? (fromDecimal(bill.totals.igst) ?? '0.00') : '0.00',
        cess: bill.itcEligible ? (fromDecimal(bill.totals.cess) ?? '0.00') : '0.00',
        roundOff: fromDecimal(bill.totals.roundOff) ?? '0.00',
      });

      await this.journals.ensureAccounts(ctx.tenantId, bill.legalEntityId, session);
      await this.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: bill.legalEntityId,
        docDate: bill.docDate,
        sourceType: 'supplier_bill',
        sourceId: bill._id,
        sourceNumber: bill.number,
        narration: `Supplier bill ${bill.number} from ${bill.supplierName} (Inv #${bill.supplierInvoiceNumber})`,
        lines: journalLines,
        actorId: ctx.userId,
        now: new Date(),
      });

      // 6. Update bill status
      bill.status = 'posted';
      bill.paymentStatus = 'unpaid';
      bill.outstanding = bill.totals.grand;
      bill.postedBy = ctx.userId;
      bill.postedAt = new Date();
      bill.version += 1;

      await bill.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'supplier_bill.posted',
          entityType: 'supplier_bill',
          entityId: bill._id.toHexString(),
          summary: `Posted supplier bill ${bill.number} for ${bill.supplierName}`,
        },
        session,
      );

      return mapSupplierBillResponse(bill, canViewCost(ctx));
    });
  }

  async cancel(ctx: TenantContext, id: string, reason: string, meta: RequestMeta): Promise<SupplierBillResponse> {
    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!bill) throw notFound('Supplier bill');
    if (bill.status !== 'posted') throw invalidState('Only posted supplier bills can be cancelled');
    if (!canInEntity(ctx, 'bill.cancel', bill.legalEntityId)) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: bill.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    // Period lock check
    if (entity.periodLockDate && bill.docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked for this business entity`, [
        { path: 'docDate', message: 'Locked period' },
      ]);
    }

    if (bill.paymentStatus !== 'unpaid') {
      throw rule('Cannot cancel a supplier bill with recorded payments');
    }

    const stockInPoint = entity.workflow?.stockInPoint ?? 'goods_receipt';

    return await withTransaction(this.models.SupplierBill.db, async (session) => {
      // 1. Reverse journal
      await this.journals.reverse(session, {
        tenantId: ctx.tenantId,
        sourceType: 'supplier_bill',
        sourceId: bill._id,
        docDate: todayIST(),
        narration: `Cancellation of supplier bill ${bill.number}: ${reason}`,
        actorId: ctx.userId,
        now: new Date(),
      });

      // 2. Revert PO line billed quantities
      if (bill.purchaseOrderId) {
        const po = (await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: bill.purchaseOrderId }).session(session)) as HydratedDocument<PurchaseOrderDoc> | null;
        if (po) {
          for (const bl of bill.lines) {
            const poLine = bl.sourceLineId ? po.lines.find((pl) => pl.lineId === bl.sourceLineId) : undefined;
            if (poLine) {
              const currentBilled = dec(poLine.billedQty?.toString() ?? '0');
              const subQty = dec(bl.qty.toString());
              const updatedBilled = currentBilled.minus(subQty);
              poLine.billedQty = toDecimal(updatedBilled.isNegative() ? '0' : updatedBilled.toString());
            }
          }
          po.version += 1;
          await po.save({ session });
        }
      }

      // 3. Revert GRN line billed quantities
      if (bill.goodsReceiptId) {
        const grn = (await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: bill.goodsReceiptId }).session(session)) as HydratedDocument<GoodsReceiptDoc> | null;
        if (grn) {
          for (const bl of bill.lines) {
            const grLine = bl.goodsReceiptLineId ? grn.lines.find((gl) => gl.lineId === bl.goodsReceiptLineId) : undefined;
            if (grLine) {
              const currentBilled = dec(grLine.billedQty.toString());
              const subQty = dec(bl.qty.toString());
              const updatedBilled = currentBilled.minus(subQty);
              grLine.billedQty = toDecimal(updatedBilled.isNegative() ? '0' : updatedBilled.toString());
            }
          }
          const grnLinesMapped = grn.lines.map((l) => ({ qty: l.qty.toString(), billed: l.billedQty.toString() }));
          grn.status = goodsReceiptProgress(grnLinesMapped);
          grn.version += 1;
          await grn.save({ session });
        }
      }

      // 4. Revert stock movements if direct bill
      const stockLines = bill.lines.filter((bl) => bl.item.type === 'stock');
      if (stockInPoint === 'supplier_bill' && bill.warehouseId && stockLines.length > 0) {
        const originalMovements = await this.models.StockMovement.find(
          { tenantId: ctx.tenantId, sourceType: 'supplier_bill', sourceId: bill._id, reversalOf: null },
          null,
          { session },
        ).lean();
        const origMap = new Map(originalMovements.map((m) => [m.sourceLineId, m]));

        const postLines: PostLine[] = [];
        for (const bl of stockLines) {
          const orig = origMap.get(bl.lineId);
          postLines.push({
            warehouseId: bill.warehouseId!,
            itemId: bl.itemId,
            label: bl.item.name,
            qty: bl.qty.toString(),
            kind: 'return_out',
            sourceLineId: bl.lineId,
            effect: orig
              ? { type: 'receipt_return', value: orig.value.toString(), reversalOf: orig._id }
              : { type: 'issue' },
          });
        }

        if (postLines.length > 0) {
          await this.ledger.post(
            {
              session,
              tenantId: ctx.tenantId,
              legalEntityId: bill.legalEntityId,
              allowNegative: entity.workflow?.allowNegativeStock ?? false,
              docDate: bill.docDate,
              sourceType: 'supplier_bill',
              sourceId: bill._id,
              sourceNumber: `${bill.number}-REV`,
              actorId: ctx.userId,
              now: new Date(),
            },
            postLines,
          );
        }
      }

      bill.status = 'cancelled';
      bill.cancelledBy = ctx.userId;
      bill.cancelledAt = new Date();
      bill.cancelReason = reason;
      bill.version += 1;

      await bill.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'supplier_bill.cancelled',
          entityType: 'supplier_bill',
          entityId: bill._id.toHexString(),
          summary: `Cancelled supplier bill ${bill.number}: ${reason}`,
        },
        session,
      );

      return mapSupplierBillResponse(bill, canViewCost(ctx));
    });
  }

  async discard(ctx: TenantContext, id: string, meta: RequestMeta): Promise<SupplierBillResponse> {
    const bill = await this.models.SupplierBill.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!bill) throw notFound('Supplier bill');
    if (bill.status !== 'draft') throw invalidState('Only draft supplier bills can be discarded');
    if (!canInEntity(ctx, 'purchase.edit', bill.legalEntityId)) throw forbidden();

    bill.status = 'discarded';
    bill.version += 1;
    await bill.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'supplier_bill.discarded',
      entityType: 'supplier_bill',
      entityId: bill._id.toHexString(),
      summary: `Discarded supplier bill draft`,
    });

    return mapSupplierBillResponse(bill, canViewCost(ctx));
  }
}
