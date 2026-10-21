import { trusted, Types } from 'mongoose';
import type {
  CreatePurchaseOrderInput,
  Page,
  PurchaseOrderResponse,
} from '@bizmgmt/contracts';
import { calculate, dec, money, type CalcLine, type CalcLineInput, type CalcResult } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { RateScheduleDoc } from '../../models-business.js';
import type {
  AmountsDoc,
  HsnRowDoc,
  LineItemDoc,
  Models,
  PurchaseLineDoc,
  PurchaseOrderDoc,
  TotalsDoc,
} from '../../models.js';
import { fromDecimal, toDecimal, todayIST, versionConflict } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import { enqueue } from '../../platform/outbox.js';
import type { ObjectStorage } from '../../platform/storage.js';
import { renderPdf } from '../../pdf/render.js';
import { purchaseOrderPrint } from '../../pdf/purchases-print.js';
import { PURCHASE_ORDER_TEMPLATE, purchaseOrderDocument } from '../../pdf/templates/purchase-order.js';
import type { AuditLog } from '../audit/audit.js';
import type { NumberingService } from '../finance/numbering.js';
import type { RequestMeta } from '../identity/identity.js';
import { canInEntity, canInWarehouse, type TenantContext } from '../tenancy/tenancy.js';
import {
  buildBuyerSnapshot,
  buildSupplierSnapshot,
  canViewCost,
  forbidden,
  invalidState,
  mapPurchaseOrderResponse,
  newLineId,
  notFound,
  preparePurchaseSeries,
  recordAudit,
  rule,
  takePurchaseNumber,
  visibleEntityFilter,
} from './core.js';

export class PurchaseOrderService {
  constructor(
    private readonly models: Models,
    private readonly audit: AuditLog,
    private readonly numbering: NumberingService,
    private readonly storage?: ObjectStorage,
  ) {}

  private async calculateLines(
    tenantId: Types.ObjectId,
    docDate: string,
    supplierStateCode: string,
    linesInput: CreatePurchaseOrderInput['lines'],
    documentDiscountInput?: string,
  ) {
    const itemIds = linesInput.map((l) => new Types.ObjectId(l.itemId));
    const items = await this.models.Item.find({ tenantId, _id: trusted({ $in: itemIds }) }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    const unitIds = items.map((i) => i.baseUnitId);
    const units = await this.models.Unit.find({ tenantId, _id: trusted({ $in: unitIds }) }).lean();
    const unitMap = new Map(units.map((u) => [u._id.toString(), u]));

    const calcLines: CalcLineInput[] = [];
    const lineDocs: PurchaseLineDoc[] = [];

    for (const l of linesInput) {
      const item = itemMap.get(l.itemId);
      if (!item) throw notFound(`Item ${l.itemId}`);
      const unit = unitMap.get(item.baseUnitId.toString());
      if (!unit) throw notFound(`Unit for item ${item.sku}`);

      let ratePercent: string | null = null;
      let reverseCharge = false;

      if (item.taxClassId) {
        const tc = await this.models.TaxClass.findOne({ tenantId, _id: item.taxClassId }).lean();
        if (tc) {
          reverseCharge = tc.reverseCharge;
          const schedule = tc.schedules?.find((s: RateScheduleDoc) => s.effectiveFrom <= docDate && (!s.effectiveTo || s.effectiveTo >= docDate));
          if (schedule) ratePercent = fromDecimal(schedule.gstRate);
        }
      }

      calcLines.push({
        qty: l.qty,
        unitPrice: l.unitPrice,
        discount: l.discountPercent ? { type: 'percent', value: l.discountPercent } : l.discountAmount ? { type: 'amount', value: l.discountAmount } : null,
        hsnSac: item.hsnSac || '',
        taxRate: ratePercent,
        cessRate: null,
        reverseCharge,
      });

      const lineItem: LineItemDoc = {
        sku: item.sku,
        name: item.name,
        type: item.type === 'stock' ? 'stock' : item.type === 'service' ? 'service' : 'non_stock',
        hsnSac: item.hsnSac,
        unitCode: unit.code,
        uqc: unit.uqc,
        decimals: unit.decimals,
      };

      lineDocs.push({
        lineId: l.id ?? newLineId(),
        itemId: item._id,
        description: l.description ?? '',
        qty: toDecimal(l.qty),
        unitPrice: toDecimal(l.unitPrice),
        discount: l.discountPercent ? { type: 'percent', value: toDecimal(l.discountPercent) } : l.discountAmount ? { type: 'amount', value: toDecimal(l.discountAmount) } : null,
        sourceLineId: l.sourceLineId ?? null,
        item: lineItem,
        taxRate: ratePercent ? toDecimal(ratePercent) : null,
        cessRate: null,
        reverseCharge,
        amounts: {} as AmountsDoc, // populated below
        receivedQty: toDecimal('0'),
        billedQty: toDecimal('0'),
        unitCost: toDecimal(l.unitPrice),
      });
    }

    const calculated = calculate({
      supply: 'intra',
      utgst: false,
      noTax: false,
      documentDiscount: documentDiscountInput ?? '0.00',
      roundOff: true,
      lines: calcLines,
    });

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
      roundOff: toDecimal(calculated.totals.roundOff),
      grand: toDecimal(calculated.totals.grand),
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

  async createDraft(ctx: TenantContext, input: CreatePurchaseOrderInput, meta: RequestMeta): Promise<PurchaseOrderResponse> {
    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    if (!canInEntity(ctx, 'purchase.edit', entity._id)) throw forbidden();

    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');

    const warehouse = await this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: input.warehouseId, archivedAt: null }).lean();
    if (!warehouse) throw notFound('Warehouse');
    if (!canInWarehouse(ctx, 'purchase.edit', { _id: warehouse._id, legalEntityId: entity._id })) throw forbidden();

    const { lineDocs, totalsDoc, hsnSummary } = await this.calculateLines(
      ctx.tenantId,
      input.docDate,
      supplier.gstins?.[0]?.stateCode ?? entity.address.stateCode,
      input.lines,
      input.documentDiscount,
    );

    const po = await this.models.PurchaseOrder.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      supplierId: supplier._id,
      supplierName: supplier.name,
      warehouseId: warehouse._id,
      docType: 'purchase_order',
      status: 'draft',
      seriesId: input.seriesId ? new Types.ObjectId(input.seriesId) : null,
      series: null,
      number: null,
      docDate: input.docDate,
      expectedDeliveryDate: input.expectedDeliveryDate ?? null,
      documentDiscount: toDecimal(input.documentDiscount ?? '0.00'),
      notes: input.notes ?? '',
      terms: input.terms ?? '',
      lines: lineDocs,
      totals: totalsDoc,
      hsnSummary,
      calcVersion: 'calc-1',
      supplier: buildSupplierSnapshot(supplier),
      buyer: buildBuyerSnapshot(entity),
      pdfReady: false,
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: po._id.toHexString(),
      summary: `Created purchase order draft for ${supplier.name}`,
    });

    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async updateDraft(ctx: TenantContext, id: string, input: CreatePurchaseOrderInput, meta: RequestMeta): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'draft') throw invalidState('Only draft purchase orders can be updated');
    if (!canInEntity(ctx, 'purchase.edit', po.legalEntityId)) throw forbidden();
    if (!canInWarehouse(ctx, 'purchase.edit', { _id: po.warehouseId, legalEntityId: po.legalEntityId })) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');
    const warehouse = await this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: input.warehouseId, archivedAt: null }).lean();
    if (!warehouse) throw notFound('Warehouse');

    const { lineDocs, totalsDoc, hsnSummary } = await this.calculateLines(
      ctx.tenantId,
      input.docDate,
      supplier.gstins?.[0]?.stateCode ?? entity.address.stateCode,
      input.lines,
      input.documentDiscount,
    );

    po.legalEntityId = entity._id;
    po.supplierId = supplier._id;
    po.supplierName = supplier.name;
    po.warehouseId = warehouse._id;
    po.seriesId = input.seriesId ? new Types.ObjectId(input.seriesId) : null;
    po.docDate = input.docDate;
    po.expectedDeliveryDate = input.expectedDeliveryDate ?? null;
    po.documentDiscount = toDecimal(input.documentDiscount ?? '0.00');
    po.notes = input.notes ?? '';
    po.terms = input.terms ?? '';
    po.lines = lineDocs;
    po.totals = totalsDoc;
    po.hsnSummary = hsnSummary;
    po.supplier = buildSupplierSnapshot(supplier);
    po.buyer = buildBuyerSnapshot(entity);
    po.version += 1;

    await po.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'purchase_order.updated',
      entityType: 'purchase_order',
      entityId: po._id.toHexString(),
      summary: `Updated purchase order draft for ${supplier.name}`,
    });

    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async getById(ctx: TenantContext, id: string): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (!canInEntity(ctx, 'purchase.edit', po.legalEntityId) && !canInEntity(ctx, 'report.financial', po.legalEntityId)) {
      throw notFound('Purchase order');
    }
    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async list(ctx: TenantContext, query: { legalEntityId?: string | undefined; warehouseId?: string | undefined; supplierId?: string | undefined; status?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<Page<PurchaseOrderResponse>> {
    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      ...visibleEntityFilter(ctx, 'purchase.edit', query.legalEntityId),
    };
    if (query.warehouseId) filter.warehouseId = new Types.ObjectId(query.warehouseId);
    if (query.supplierId) filter.supplierId = new Types.ObjectId(query.supplierId);
    if (query.status) filter.status = query.status;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 50, 100);
    const docs = await this.models.PurchaseOrder.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toString() ?? null : null;

    const hasCost = canViewCost(ctx);
    return {
      data: pageDocs.map((d) => mapPurchaseOrderResponse(d, hasCost)),
      page: { nextCursor, limit },
    };
  }

  async issue(ctx: TenantContext, id: string, meta: RequestMeta, seriesId?: string): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'draft') throw invalidState('Only draft purchase orders can be issued');
    if (!canInEntity(ctx, 'purchase.issue', po.legalEntityId)) throw forbidden();
    if (!canInWarehouse(ctx, 'purchase.issue', { _id: po.warehouseId, legalEntityId: po.legalEntityId })) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: po.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: po.supplierId }).lean();
    if (!supplier) throw notFound('Supplier');

    const issueSeriesId = seriesId ? new Types.ObjectId(seriesId) : po.seriesId;
    const series = await preparePurchaseSeries(this.models, this.numbering, ctx, 'purchase_order', po.legalEntityId, issueSeriesId, po.docDate);

    return await withTransaction(this.models.PurchaseOrder.db, async (session) => {
      const allocated = await takePurchaseNumber(session, this.numbering, ctx, series, po.docDate);

      po.status = 'issued';
      po.number = allocated.number;
      po.series = {
        seriesId: allocated.series.seriesId,
        scopeId: po.legalEntityId,
        fy: allocated.series.fy,
        sequence: allocated.series.sequence,
      };
      po.issuedBy = ctx.userId;
      po.issuedAt = new Date();
      po.pdfReady = true;
      po.version += 1;

      await po.save({ session });

      await enqueue(this.models, session, {
        tenantId: ctx.tenantId,
        type: 'document.render',
        aggregateId: po._id,
        payload: {
          docType: 'purchase_order',
          docId: po._id.toHexString(),
          templateVersion: PURCHASE_ORDER_TEMPLATE,
        },
        now: po.issuedAt,
      });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'purchase_order.issued',
          entityType: 'purchase_order',
          entityId: po._id.toHexString(),
          summary: `Issued purchase order ${po.number} to ${po.supplierName}`,
        },
        session,
      );

      return mapPurchaseOrderResponse(po, canViewCost(ctx));
    });
  }

  async discard(ctx: TenantContext, id: string, meta: RequestMeta): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'draft') throw invalidState('Only draft purchase orders can be discarded');
    if (!canInEntity(ctx, 'purchase.edit', po.legalEntityId)) throw forbidden();

    po.status = 'discarded';
    po.version += 1;
    await po.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'purchase_order.discarded',
      entityType: 'purchase_order',
      entityId: po._id.toHexString(),
      summary: `Discarded purchase order draft`,
    });

    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async cancel(ctx: TenantContext, id: string, reason: string, meta: RequestMeta): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'issued') throw invalidState('Only issued purchase orders can be cancelled');
    if (!canInEntity(ctx, 'purchase.issue', po.legalEntityId) && !canInEntity(ctx, 'purchase.edit', po.legalEntityId)) {
      throw forbidden();
    }

    const hasReceipts = po.lines.some((l: PurchaseLineDoc) => !dec(l.receivedQty.toString()).isZero());
    if (hasReceipts) throw rule('Cannot cancel a purchase order that has received goods. Use close instead.');

    po.status = 'cancelled';
    po.cancelledBy = ctx.userId;
    po.cancelledAt = new Date();
    po.cancelReason = reason;
    po.version += 1;
    await po.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'purchase_order.cancelled',
      entityType: 'purchase_order',
      entityId: po._id.toHexString(),
      summary: `Cancelled purchase order ${po.number}: ${reason}`,
    });

    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async close(ctx: TenantContext, id: string, reason: string, meta: RequestMeta): Promise<PurchaseOrderResponse> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (po.status !== 'partially_received') throw invalidState('Only partially received purchase orders can be closed');
    if (!canInEntity(ctx, 'purchase.issue', po.legalEntityId) && !canInEntity(ctx, 'purchase.edit', po.legalEntityId)) {
      throw forbidden();
    }

    po.status = 'closed';
    po.cancelReason = reason;
    po.version += 1;
    await po.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'purchase_order.closed',
      entityType: 'purchase_order',
      entityId: po._id.toHexString(),
      summary: `Short-closed purchase order ${po.number}: ${reason}`,
    });

    return mapPurchaseOrderResponse(po, canViewCost(ctx));
  }

  async pdf(ctx: TenantContext, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!po) throw notFound('Purchase order');
    if (!canInEntity(ctx, 'document.download', po.legalEntityId) && !canInEntity(ctx, 'purchase.edit', po.legalEntityId)) {
      throw forbidden();
    }
    if (!po.number) throw invalidState('Only issued purchase orders have a PDF');

    if (this.storage) {
      const artifact = await this.models.DocumentArtifact.findOne({
        tenantId: ctx.tenantId,
        docType: 'purchase_order',
        docId: po._id,
        templateVersion: PURCHASE_ORDER_TEMPLATE,
      }).lean();

      if (artifact?.status === 'ready' && artifact.fileId) {
        const file = await this.models.File.findOne({ tenantId: ctx.tenantId, _id: artifact.fileId }).lean();
        if (file) {
          return {
            bytes: await this.storage.get(file.storageKey),
            filename: `${po.number.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`,
          };
        }
      }
    }

    const [entity, warehouse] = await Promise.all([
      this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: po.legalEntityId }).lean(),
      this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: po.warehouseId }).lean(),
    ]);
    if (!entity || !warehouse) throw notFound('Entity or warehouse');

    const print = purchaseOrderPrint(po, entity, warehouse, null);
    const bytes = await renderPdf(purchaseOrderDocument(print), {
      title: `Purchase Order ${po.number}`,
      createdAt: po.issuedAt ?? po.createdAt,
    });
    return {
      bytes,
      filename: `${po.number.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`,
    };
  }
}
