import { type HydratedDocument, trusted, Types } from 'mongoose';
import type { CreateGoodsReceiptInput, GoodsReceiptResponse, Page } from '@bizmgmt/contracts';
import { dec, purchaseOrderProgress } from '@bizmgmt/domain';
import type { GoodsReceiptDoc, GoodsReceiptLineDoc, Models, PurchaseOrderDoc } from '../../models.js';
import { fromDecimal, toDecimal } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import type { AuditLog } from '../audit/audit.js';
import type { NumberingService } from '../finance/numbering.js';
import type { RequestMeta } from '../identity/identity.js';
import type { PostLine, StockLedger } from '../inventory/ledger.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import { canInEntity, canInWarehouse, type TenantContext } from '../tenancy/tenancy.js';
import {
  buildSupplierSnapshot,
  canViewCost,
  forbidden,
  invalidState,
  mapGoodsReceiptResponse,
  newLineId,
  notFound,
  preparePurchaseSeries,
  recordAudit,
  rule,
  takePurchaseNumber,
  visibleEntityFilter,
} from './core.js';

export class GoodsReceiptService {
  constructor(
    private readonly models: Models,
    private readonly audit: AuditLog,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedger,
  ) {}

  private async prepareLines(tenantId: Types.ObjectId, linesInput: CreateGoodsReceiptInput['lines'], poDoc?: PurchaseOrderDoc | null) {
    const itemIds = linesInput.map((l) => new Types.ObjectId(l.itemId));
    const items = await this.models.Item.find({ tenantId, _id: trusted({ $in: itemIds }) }).lean();
    const itemMap = new Map(items.map((i) => [i._id.toString(), i]));

    const unitIds = items.map((i) => i.baseUnitId);
    const units = await this.models.Unit.find({ tenantId, _id: trusted({ $in: unitIds }) }).lean();
    const unitMap = new Map(units.map((u) => [u._id.toString(), u]));

    const lineDocs: GoodsReceiptLineDoc[] = [];

    for (const l of linesInput) {
      const item = itemMap.get(l.itemId);
      if (!item) throw notFound(`Item ${l.itemId}`);
      const unit = unitMap.get(item.baseUnitId.toString());
      if (!unit) throw notFound(`Unit for item ${item.sku}`);

      let unitPrice = l.unitPrice ? toDecimal(l.unitPrice) : toDecimal('0.00');
      let sourceLineId: string | null = l.sourceLineId ?? null;

      // If linked to PO, validate receivable quantity
      if (poDoc) {
        let poLine = sourceLineId ? poDoc.lines.find((pl) => pl.lineId === sourceLineId) : undefined;
        if (!poLine) {
          poLine = poDoc.lines.find((pl) => pl.itemId.toString() === l.itemId);
        }
        if (!poLine) throw rule(`Item ${item.sku} is not on purchase order ${poDoc.number}`);
        sourceLineId = poLine.lineId;
        unitPrice = poLine.unitPrice;
      }

      lineDocs.push({
        lineId: newLineId(),
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
        description: l.notes ?? '',
        qty: toDecimal(l.qty),
        unitPrice,
        provisionalValue: toDecimal(dec(l.qty).times(dec(unitPrice.toString())).toFixed(2)),
        billedQty: toDecimal('0'),
        billedValue: toDecimal('0'),
        sourceLineId,
      });
    }

    return lineDocs;
  }

  async createDraft(ctx: TenantContext, input: CreateGoodsReceiptInput, meta: RequestMeta): Promise<GoodsReceiptResponse> {
    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    if (!canInEntity(ctx, 'stock.move', entity._id)) throw forbidden();

    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');
    const warehouse = await this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: input.warehouseId, archivedAt: null }).lean();
    if (!warehouse) throw notFound('Warehouse');
    if (!canInWarehouse(ctx, 'stock.move', { _id: warehouse._id, legalEntityId: entity._id })) throw forbidden();

    let po: PurchaseOrderDoc | null = null;
    if (input.purchaseOrderId) {
      po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: input.purchaseOrderId });
      if (!po) throw notFound('Purchase order');
      if (po.status !== 'issued' && po.status !== 'partially_received') {
        throw invalidState('Can only receive against issued or partially received purchase orders');
      }
    }

    const lines = await this.prepareLines(ctx.tenantId, input.lines, po);

    const grn = await this.models.GoodsReceipt.create({
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      supplierId: supplier._id,
      supplierName: supplier.name,
      warehouseId: warehouse._id,
      purchaseOrderId: po?._id ?? null,
      supplierDeliveryChallanNumber: input.supplierDeliveryChallanNumber ?? null,
      docType: 'goods_receipt',
      status: 'draft',
      number: null,
      docDate: input.docDate,
      notes: input.notes ?? '',
      lines,
      supplier: buildSupplierSnapshot(supplier),
      createdBy: ctx.userId,
      version: 0,
    });

    await recordAudit(this.audit, ctx, meta, {
      action: 'goods_receipt.created',
      entityType: 'goods_receipt',
      entityId: grn._id.toHexString(),
      summary: `Created goods receipt draft for ${supplier.name}`,
    });

    return mapGoodsReceiptResponse(grn, canViewCost(ctx));
  }

  async updateDraft(ctx: TenantContext, id: string, input: CreateGoodsReceiptInput, meta: RequestMeta): Promise<GoodsReceiptResponse> {
    const grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!grn) throw notFound('Goods receipt');
    if (grn.status !== 'draft') throw invalidState('Only draft goods receipts can be updated');
    if (!canInEntity(ctx, 'stock.move', grn.legalEntityId)) throw forbidden();
    if (!canInWarehouse(ctx, 'stock.move', { _id: grn.warehouseId, legalEntityId: grn.legalEntityId })) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: input.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');
    const supplier = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: input.supplierId, isSupplier: true, archivedAt: null }).lean();
    if (!supplier) throw notFound('Supplier');
    const warehouse = await this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: input.warehouseId, archivedAt: null }).lean();
    if (!warehouse) throw notFound('Warehouse');

    let po: PurchaseOrderDoc | null = null;
    if (input.purchaseOrderId) {
      po = await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: input.purchaseOrderId });
    }

    const lines = await this.prepareLines(ctx.tenantId, input.lines, po);

    grn.legalEntityId = entity._id;
    grn.supplierId = supplier._id;
    grn.supplierName = supplier.name;
    grn.warehouseId = warehouse._id;
    grn.purchaseOrderId = po?._id ?? null;
    grn.supplierDeliveryChallanNumber = input.supplierDeliveryChallanNumber ?? null;
    grn.docDate = input.docDate;
    grn.notes = input.notes ?? '';
    grn.lines = lines;
    grn.supplier = buildSupplierSnapshot(supplier);
    grn.version += 1;

    await grn.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'goods_receipt.updated',
      entityType: 'goods_receipt',
      entityId: grn._id.toHexString(),
      summary: `Updated goods receipt draft for ${supplier.name}`,
    });

    return mapGoodsReceiptResponse(grn, canViewCost(ctx));
  }

  async getById(ctx: TenantContext, id: string): Promise<GoodsReceiptResponse> {
    const grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!grn) throw notFound('Goods receipt');
    if (!canInEntity(ctx, 'stock.move', grn.legalEntityId) && !canInEntity(ctx, 'report.financial', grn.legalEntityId)) {
      throw notFound('Goods receipt');
    }
    return mapGoodsReceiptResponse(grn, canViewCost(ctx));
  }

  async list(ctx: TenantContext, query: { legalEntityId?: string | undefined; warehouseId?: string | undefined; supplierId?: string | undefined; purchaseOrderId?: string | undefined; status?: string | undefined; limit?: number | undefined; cursor?: string | undefined }): Promise<Page<GoodsReceiptResponse>> {
    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      ...visibleEntityFilter(ctx, 'stock.move', query.legalEntityId),
    };
    if (query.warehouseId) filter.warehouseId = new Types.ObjectId(query.warehouseId);
    if (query.supplierId) filter.supplierId = new Types.ObjectId(query.supplierId);
    if (query.purchaseOrderId) filter.purchaseOrderId = new Types.ObjectId(query.purchaseOrderId);
    if (query.status) filter.status = query.status;
    if (query.cursor) filter._id = { $lt: new Types.ObjectId(query.cursor) };

    const limit = Math.min(query.limit ?? 50, 100);
    const docs = await this.models.GoodsReceipt.find(filter).sort({ _id: -1 }).limit(limit + 1);
    const hasMore = docs.length > limit;
    const pageDocs = docs.slice(0, limit);
    const nextCursor = hasMore ? pageDocs[pageDocs.length - 1]?._id.toString() ?? null : null;

    const hasCost = canViewCost(ctx);
    return {
      data: pageDocs.map((d) => mapGoodsReceiptResponse(d, hasCost)),
      page: { nextCursor, limit },
    };
  }

  async receive(ctx: TenantContext, id: string, meta: RequestMeta): Promise<GoodsReceiptResponse> {
    const grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!grn) throw notFound('Goods receipt');
    if (grn.status !== 'draft') throw invalidState('Only draft goods receipts can be received');
    if (!canInEntity(ctx, 'receipt.post', grn.legalEntityId) && !canInEntity(ctx, 'stock.move', grn.legalEntityId)) throw forbidden();
    if (!canInWarehouse(ctx, 'stock.move', { _id: grn.warehouseId, legalEntityId: grn.legalEntityId })) throw forbidden();

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: grn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const stockLines = grn.lines.filter((gl: GoodsReceiptLineDoc) => gl.item.type === 'stock');
    if (stockLines.length > 0) {
      await this.ledger.ensureRows(
        ctx.tenantId,
        grn.legalEntityId,
        stockLines.map((l: GoodsReceiptLineDoc) => ({ warehouseId: grn.warehouseId, itemId: l.itemId })),
      );
    }

    const series = await preparePurchaseSeries(this.models, this.numbering, ctx, 'goods_receipt', grn.legalEntityId, null, grn.docDate);

    return await withTransaction(this.models.GoodsReceipt.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: grn.legalEntityId, docDate: grn.docDate, models: this.models });
      // 1. Assign gap-free number
      const allocated = await takePurchaseNumber(session, this.numbering, ctx, series, grn.docDate);
      grn.number = allocated.number;

      // 2. If linked to PO, update PO line received quantities atomically
      if (grn.purchaseOrderId) {
        const po = (await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: grn.purchaseOrderId }).session(session)) as HydratedDocument<PurchaseOrderDoc> | null;
        if (po) {
          for (const gl of grn.lines) {
            const poLine = gl.sourceLineId ? po.lines.find((pl) => pl.lineId === gl.sourceLineId) : undefined;
            if (poLine) {
              const currentRec = dec(poLine.receivedQty.toString());
              const addQty = dec(gl.qty.toString());
              const ordered = dec(poLine.qty.toString());
              const remaining = ordered.minus(currentRec);
              if (addQty.greaterThan(remaining)) {
                throw rule(`Quantity ${addQty.toString()} cannot exceed ordered quantity (remaining ${remaining.toString()}) on PO line for ${gl.item.name}`);
              }
              poLine.receivedQty = toDecimal(currentRec.plus(addQty).toString());
            }
          }
          const poLinesMapped = po.lines.map((l) => ({ qty: l.qty.toString(), received: l.receivedQty.toString() }));
          po.status = purchaseOrderProgress(poLinesMapped);
          po.version += 1;
          await po.save({ session });
        }
      }

      // 3. Post stock IN movements for stock items
      const postLines: PostLine[] = [];
      for (const gl of grn.lines) {
        if (gl.item.type === 'stock') {
          postLines.push({
            warehouseId: grn.warehouseId,
            itemId: gl.itemId,
            label: gl.item.name,
            qty: gl.qty.toString(),
            kind: 'receipt',
            sourceLineId: gl.lineId,
            effect: {
              type: 'receive',
              unitCost: fromDecimal(gl.unitPrice) ?? '0.00',
            },
          });
        }
      }

      if (postLines.length > 0) {
        await this.ledger.post(
          {
            session,
            tenantId: ctx.tenantId,
            legalEntityId: grn.legalEntityId,
            allowNegative: entity.workflow?.allowNegativeStock ?? false,
            docDate: grn.docDate,
            sourceType: 'goods_receipt',
            sourceId: grn._id,
            sourceNumber: grn.number,
            actorId: ctx.userId,
            now: new Date(),
          },
          postLines,
        );
      }

      grn.status = 'received';
      grn.receivedBy = ctx.userId;
      grn.receivedAt = new Date();
      grn.version += 1;

      await grn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'goods_receipt.received',
          entityType: 'goods_receipt',
          entityId: grn._id.toHexString(),
          summary: `Received goods receipt ${grn.number} from ${grn.supplierName}`,
        },
        session,
      );

      return mapGoodsReceiptResponse(grn, canViewCost(ctx));
    });
  }

  async cancel(ctx: TenantContext, id: string, reason: string, meta: RequestMeta): Promise<GoodsReceiptResponse> {
    const grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!grn) throw notFound('Goods receipt');
    if (grn.status !== 'received') throw invalidState('Only received goods receipts can be cancelled');
    if (!canInEntity(ctx, 'stock.move', grn.legalEntityId)) throw forbidden();
    if (!canInWarehouse(ctx, 'stock.move', { _id: grn.warehouseId, legalEntityId: grn.legalEntityId })) throw forbidden();

    const hasBilled = grn.lines.some((l: GoodsReceiptLineDoc) => !dec(l.billedQty.toString()).isZero());
    if (hasBilled) throw rule('Cannot cancel a goods receipt that has already been billed');

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: grn.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const stockLines = grn.lines.filter((gl: GoodsReceiptLineDoc) => gl.item.type === 'stock');
    if (stockLines.length > 0) {
      await this.ledger.ensureRows(
        ctx.tenantId,
        grn.legalEntityId,
        stockLines.map((l: GoodsReceiptLineDoc) => ({ warehouseId: grn.warehouseId, itemId: l.itemId })),
      );
    }

    return await withTransaction(this.models.GoodsReceipt.db, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: grn.legalEntityId, docDate: grn.docDate, models: this.models });
      // 1. Restore/reverse PO received quantities
      if (grn.purchaseOrderId) {
        const po = (await this.models.PurchaseOrder.findOne({ tenantId: ctx.tenantId, _id: grn.purchaseOrderId }).session(session)) as HydratedDocument<PurchaseOrderDoc> | null;
        if (po) {
          for (const gl of grn.lines) {
            const poLine = gl.sourceLineId ? po.lines.find((pl) => pl.lineId === gl.sourceLineId) : undefined;
            if (poLine) {
              const currentRec = dec(poLine.receivedQty.toString());
              const subQty = dec(gl.qty.toString());
              const updatedRec = currentRec.minus(subQty);
              poLine.receivedQty = toDecimal(updatedRec.isNegative() ? '0' : updatedRec.toString());
            }
          }
          const poLinesMapped = po.lines.map((l) => ({ qty: l.qty.toString(), received: l.receivedQty.toString() }));
          po.status = purchaseOrderProgress(poLinesMapped);
          po.version += 1;
          await po.save({ session });
        }
      }

      // 2. Issue stock back out (reversal of receipt)
      const originalMovements = await this.models.StockMovement.find(
        { tenantId: ctx.tenantId, sourceType: 'goods_receipt', sourceId: grn._id, reversalOf: null },
        null,
        { session },
      ).lean();
      const origMap = new Map(originalMovements.map((m) => [m.sourceLineId, m]));

      const postLines: PostLine[] = [];
      for (const gl of grn.lines) {
        if (gl.item.type === 'stock') {
          const orig = origMap.get(gl.lineId);
          postLines.push({
            warehouseId: grn.warehouseId,
            itemId: gl.itemId,
            label: gl.item.name,
            qty: gl.qty.toString(),
            kind: 'return_out',
            sourceLineId: gl.lineId,
            effect: orig
              ? { type: 'receipt_return', value: orig.value.toString(), reversalOf: orig._id }
              : { type: 'issue' },
          });
        }
      }

      if (postLines.length > 0) {
        await this.ledger.post(
          {
            session,
            tenantId: ctx.tenantId,
            legalEntityId: grn.legalEntityId,
            allowNegative: entity.workflow?.allowNegativeStock ?? false,
            docDate: grn.docDate,
            sourceType: 'goods_receipt',
            sourceId: grn._id,
            sourceNumber: `${grn.number}-REV`,
            actorId: ctx.userId,
            now: new Date(),
          },
          postLines,
        );
      }

      grn.status = 'cancelled';
      grn.cancelledBy = ctx.userId;
      grn.cancelledAt = new Date();
      grn.cancelReason = reason;
      grn.version += 1;

      await grn.save({ session });

      await recordAudit(
        this.audit,
        ctx,
        meta,
        {
          action: 'goods_receipt.cancelled',
          entityType: 'goods_receipt',
          entityId: grn._id.toHexString(),
          summary: `Cancelled goods receipt ${grn.number}: ${reason}`,
        },
        session,
      );

      return mapGoodsReceiptResponse(grn, canViewCost(ctx));
    });
  }

  async discard(ctx: TenantContext, id: string, meta: RequestMeta): Promise<GoodsReceiptResponse> {
    const grn = await this.models.GoodsReceipt.findOne({ tenantId: ctx.tenantId, _id: id });
    if (!grn) throw notFound('Goods receipt');
    if (grn.status !== 'draft') throw invalidState('Only draft goods receipts can be discarded');
    if (!canInEntity(ctx, 'stock.move', grn.legalEntityId)) throw forbidden();

    grn.status = 'discarded';
    grn.version += 1;
    await grn.save();

    await recordAudit(this.audit, ctx, meta, {
      action: 'goods_receipt.discarded',
      entityType: 'goods_receipt',
      entityId: grn._id.toHexString(),
      summary: `Discarded goods receipt draft`,
    });

    return mapGoodsReceiptResponse(grn, canViewCost(ctx));
  }
}
