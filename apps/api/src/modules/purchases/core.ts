import { randomBytes } from 'node:crypto';
import { trusted, Types } from 'mongoose';
import {
  stateName,
  type AuditAction,
  type AuditChange,
  type Permission,
  type PurchaseDocType,
  type PurchaseLineResponse,
  type PurchaseOrderResponse,
  type GoodsReceiptResponse,
  type SupplierBillResponse,
} from '@bizmgmt/contracts';
import { dec, money } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { ClientSession } from 'mongoose';
import type {
  AmountsDoc,
  BuyerSnapshotDoc,
  DocumentSeriesDoc,
  GoodsReceiptDoc,
  GoodsReceiptLineDoc,
  LegalEntityDoc,
  LineItemDoc,
  Models,
  PartyDoc,
  PurchaseLineDoc,
  PurchaseOrderDoc,
  SellerSnapshotDoc,
  SupplierBillDoc,
  SupplierBillLineDoc,
  TotalsDoc,
  WarehouseDoc,
} from '../../models.js';
import { fromDecimal, toDecimal, todayIST } from '../../platform/values.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { JournalService } from '../finance/journals.js';
import type { NumberingService } from '../finance/numbering.js';
import type { RequestMeta } from '../identity/identity.js';
import type { StockLedger } from '../inventory/ledger.js';
import { canInEntity, canInWarehouse, visibleEntities, type TenantContext } from '../tenancy/tenancy.js';

export async function recordAudit(
  audit: AuditLog,
  ctx: TenantContext,
  meta: RequestMeta,
  input: { action: AuditAction; entityType: string; entityId: string; summary: string; changes?: AuditChange[] },
  session?: ClientSession,
) {
  return audit.record(
    {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary,
      ...(input.changes !== undefined ? { changes: input.changes } : {}),
      requestId: meta.requestId,
      ipHash: meta.ipHash,
    },
    session,
  );
}

export function visibleEntityFilter(ctx: TenantContext, permission: Permission, explicitLegalEntityId?: string): Record<string, unknown> {
  if (explicitLegalEntityId) {
    if (!canInEntity(ctx, permission, explicitLegalEntityId)) throw forbidden();
    return { legalEntityId: new Types.ObjectId(explicitLegalEntityId) };
  }
  const scope = visibleEntities(ctx, [permission]);
  if (scope === 'all') return {};
  return { legalEntityId: trusted({ $in: [...scope].map((id) => new Types.ObjectId(id)) }) };
}

export async function preparePurchaseSeries(
  models: Models,
  numbering: NumberingService,
  ctx: TenantContext,
  kind: 'purchase_order' | 'goods_receipt' | 'supplier_bill',
  legalEntityId: Types.ObjectId,
  seriesId?: Types.ObjectId | null,
  docDate: string = todayIST(),
): Promise<DocumentSeriesDoc> {
  const scopeId = legalEntityId;
  const { DocumentSeries } = models;
  let series: DocumentSeriesDoc | null = null;
  if (seriesId) {
    series = await DocumentSeries.findOne({ tenantId: ctx.tenantId, _id: seriesId, scopeId, docType: kind, active: true }).lean();
  }
  if (!series) {
    const candidates = await DocumentSeries.find({ tenantId: ctx.tenantId, scopeId, docType: kind, active: true }).lean();
    series = candidates.find((s) => s.isDefault) ?? (candidates.length > 0 ? (candidates[0] ?? null) : null);
  }
  if (!series) {
    const prefixes: Record<string, string> = { purchase_order: 'PO/', goods_receipt: 'GRN/', supplier_bill: 'BILL/' };
    const prefix = prefixes[kind] ?? `${kind.toUpperCase()}/`;
    const defaultDoc = {
      tenantId: ctx.tenantId,
      legalEntityId,
      gstRegistrationId: null,
      scopeId,
      docType: kind,
      name: `Default ${kind.replace('_', ' ')}`,
      prefix,
      padding: 4,
      startNumber: 1,
      isDefault: true,
      active: true,
      version: 0,
    };
    try {
      const [created] = await DocumentSeries.create([defaultDoc]);
      series = created ? (created.toObject() as DocumentSeriesDoc) : null;
    } catch {
      series = await DocumentSeries.findOne({ tenantId: ctx.tenantId, scopeId, docType: kind, active: true }).lean();
    }
  }
  if (!series) throw rule(`Add a ${kind.replace('_', ' ')} series under Settings first`, 'seriesId');
  await numbering.prepare(ctx.tenantId, series._id, docDate);
  return series;
}

export async function takePurchaseNumber(
  session: ClientSession,
  numbering: NumberingService,
  ctx: TenantContext,
  series: DocumentSeriesDoc,
  docDate: string,
) {
  const issued = await numbering.take(session, ctx.tenantId, series._id, docDate);
  return {
    number: issued.number,
    series: { seriesId: issued.seriesId, scopeId: issued.scopeId, fy: issued.fy, sequence: issued.sequence },
  };
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = () => new AppError('FORBIDDEN', "You don't have permission to do this");
export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);
export const invalidState = (message: string) => new AppError('INVALID_STATE', message);
export const rule = (message: string, path?: string) => new AppError('BUSINESS_RULE', message, path ? [{ path, message }] : undefined);

export const newLineId = () => randomBytes(6).toString('hex');
const ZERO = () => toDecimal('0');

export interface PurchaseServices {
  models: Models;
  audit: AuditLog;
  numbering: NumberingService;
  journals: JournalService;
  ledger: StockLedger;
}

export function canViewCost(ctx: TenantContext): boolean {
  return ctx.permissions.has('price.view_cost');
}

export function buildBuyerSnapshot(entity: LegalEntityDoc): SellerSnapshotDoc {
  return {
    legalEntityId: entity._id.toString(),
    legalName: entity.legalName,
    tradeName: entity.tradeName || entity.legalName,
    pan: entity.pan,
    gstin: '',
    stateCode: entity.address.stateCode,
    registrationType: 'regular',
    address: entity.address,
    email: entity.email || '',
    phone: entity.phone || '',
  };
}

export function buildSupplierSnapshot(supplier: PartyDoc): BuyerSnapshotDoc {
  const gstinObj = supplier.gstins?.[0];
  const addr = supplier.addresses?.[0] ?? null;
  return {
    partyId: supplier._id.toString(),
    name: supplier.name,
    legalName: supplier.legalName || supplier.name,
    gstin: gstinObj?.gstin ?? null,
    stateCode: gstinObj?.stateCode ?? addr?.stateCode ?? null,
    billingAddress: addr,
    shippingAddress: addr,
  };
}

export function mapAmountsDoc(amounts: AmountsDoc) {
  return {
    gross: fromDecimal(amounts.gross) ?? '0.00',
    discount: fromDecimal(amounts.discount) ?? '0.00',
    taxable: fromDecimal(amounts.taxable) ?? '0.00',
    cgst: fromDecimal(amounts.cgst) ?? '0.00',
    sgst: fromDecimal(amounts.sgst) ?? '0.00',
    utgst: fromDecimal(amounts.utgst) ?? '0.00',
    igst: fromDecimal(amounts.igst) ?? '0.00',
    cess: fromDecimal(amounts.cess) ?? '0.00',
    taxCharged: fromDecimal(amounts.taxCharged) ?? '0.00',
    reverseChargeTax: '0.00',
    subtotal: fromDecimal(amounts.total) ?? '0.00',
    roundOff: '0.00',
    grand: fromDecimal(amounts.total) ?? '0.00',
  };
}

export function mapTotalsDoc(totals: TotalsDoc) {
  return {
    gross: fromDecimal(totals.gross) ?? '0.00',
    discount: fromDecimal(totals.discount) ?? '0.00',
    taxable: fromDecimal(totals.taxable) ?? '0.00',
    cgst: fromDecimal(totals.cgst) ?? '0.00',
    sgst: fromDecimal(totals.sgst) ?? '0.00',
    utgst: fromDecimal(totals.utgst) ?? '0.00',
    igst: fromDecimal(totals.igst) ?? '0.00',
    cess: fromDecimal(totals.cess) ?? '0.00',
    taxCharged: fromDecimal(totals.taxCharged) ?? '0.00',
    reverseChargeTax: fromDecimal(totals.reverseChargeTax) ?? '0.00',
    subtotal: fromDecimal(totals.subtotal) ?? '0.00',
    roundOff: fromDecimal(totals.roundOff) ?? '0.00',
    grand: fromDecimal(totals.grand) ?? '0.00',
  };
}

export function mapPurchaseLine(l: PurchaseLineDoc | GoodsReceiptLineDoc | SupplierBillLineDoc, hasCostAccess: boolean): PurchaseLineResponse {
  const isGRN = 'provisionalValue' in l;
  const isPO = 'receivedQty' in l;
  const isBill = 'amounts' in l && !('receivedQty' in l);

  const res: PurchaseLineResponse = {
    id: l.lineId,
    itemId: l.itemId.toString(),
    itemSku: l.item.sku,
    itemName: l.item.name,
    itemType: l.item.type === 'stock' ? 'goods' : 'service',
    hsnSac: l.item.hsnSac,
    unitCode: l.item.unitCode,
    unitName: l.item.unitCode,
    uqc: l.item.uqc,
    description: l.description ?? '',
    qty: fromDecimal(l.qty) ?? '0',
    sourceLineId: l.sourceLineId ?? undefined,
  };

  if (hasCostAccess) {
    res.unitPrice = fromDecimal(l.unitPrice) ?? '0.00';
    if ('amounts' in l) {
      res.taxableAmount = fromDecimal(l.amounts.taxable) ?? '0.00';
      res.cgst = fromDecimal(l.amounts.cgst) ?? '0.00';
      res.sgst = fromDecimal(l.amounts.sgst) ?? '0.00';
      res.utgst = fromDecimal(l.amounts.utgst) ?? '0.00';
      res.igst = fromDecimal(l.amounts.igst) ?? '0.00';
      res.cess = fromDecimal(l.amounts.cess) ?? '0.00';
      res.lineTotal = fromDecimal(l.amounts.total) ?? '0.00';
    }
  }

  if (isPO) {
    const poLine = l as PurchaseLineDoc;
    res.receivedQty = fromDecimal(poLine.receivedQty) ?? '0';
    res.billedQty = fromDecimal(poLine.billedQty) ?? '0';
  } else if (isGRN) {
    const grnLine = l as GoodsReceiptLineDoc;
    res.billedQty = fromDecimal(grnLine.billedQty) ?? '0';
  }

  return res;
}

export function mapPurchaseOrderResponse(doc: PurchaseOrderDoc, hasCostAccess: boolean): PurchaseOrderResponse {
  return {
    id: doc._id.toString(),
    docType: 'purchase_order',
    status: doc.status as any,
    number: doc.number,
    issuedAt: doc.issuedAt?.toISOString() ?? null,
    docDate: doc.docDate,
    expectedDeliveryDate: doc.expectedDeliveryDate,
    legalEntityId: doc.legalEntityId.toString(),
    supplierId: doc.supplierId.toString(),
    warehouseId: doc.warehouseId.toString(),
    supplier: doc.supplier
      ? {
          partyId: doc.supplier.partyId,
          name: doc.supplier.name,
          legalName: doc.supplier.legalName,
          pan: '',
          gstin: doc.supplier.gstin,
          address: {
            line1: doc.supplier.billingAddress?.line1 ?? '',
            city: doc.supplier.billingAddress?.city ?? '',
            stateCode: doc.supplier.billingAddress?.stateCode ?? '27',
            pincode: doc.supplier.billingAddress?.pincode ?? '',
          },
        }
      : null,
    lines: doc.lines.map((l) => mapPurchaseLine(l, hasCostAccess)),
    amounts: hasCostAccess ? mapTotalsDoc(doc.totals) : undefined,
    notes: doc.notes || null,
    terms: doc.terms || null,
    pdfReady: doc.pdfReady,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function mapGoodsReceiptResponse(doc: GoodsReceiptDoc, hasCostAccess: boolean): GoodsReceiptResponse {
  return {
    id: doc._id.toString(),
    docType: 'goods_receipt',
    status: doc.status as any,
    number: doc.number,
    docDate: doc.docDate,
    legalEntityId: doc.legalEntityId.toString(),
    supplierId: doc.supplierId.toString(),
    warehouseId: doc.warehouseId.toString(),
    purchaseOrderId: doc.purchaseOrderId?.toString() ?? null,
    supplierDeliveryChallanNumber: doc.supplierDeliveryChallanNumber,
    supplier: doc.supplier
      ? {
          partyId: doc.supplier.partyId,
          name: doc.supplier.name,
          legalName: doc.supplier.legalName,
          pan: '',
          gstin: doc.supplier.gstin,
          address: {
            line1: doc.supplier.billingAddress?.line1 ?? '',
            city: doc.supplier.billingAddress?.city ?? '',
            stateCode: doc.supplier.billingAddress?.stateCode ?? '27',
            pincode: doc.supplier.billingAddress?.pincode ?? '',
          },
        }
      : null,
    lines: doc.lines.map((l) => mapPurchaseLine(l, hasCostAccess)),
    notes: doc.notes || null,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function mapSupplierBillResponse(doc: SupplierBillDoc, hasCostAccess: boolean): SupplierBillResponse {
  return {
    id: doc._id.toString(),
    docType: 'supplier_bill',
    status: doc.status as any,
    paymentStatus: doc.paymentStatus as any,
    number: doc.number,
    supplierInvoiceNumber: doc.supplierInvoiceNumber,
    supplierInvoiceDate: doc.supplierInvoiceDate,
    docDate: doc.docDate,
    dueDate: doc.dueDate,
    legalEntityId: doc.legalEntityId.toString(),
    supplierId: doc.supplierId.toString(),
    warehouseId: doc.warehouseId?.toString() ?? null,
    purchaseOrderId: doc.purchaseOrderId?.toString() ?? null,
    goodsReceiptId: doc.goodsReceiptId?.toString() ?? null,
    itcEligible: doc.itcEligible,
    supplier: doc.supplier
      ? {
          partyId: doc.supplier.partyId,
          name: doc.supplier.name,
          legalName: doc.supplier.legalName,
          pan: '',
          gstin: doc.supplier.gstin,
          address: {
            line1: doc.supplier.billingAddress?.line1 ?? '',
            city: doc.supplier.billingAddress?.city ?? '',
            stateCode: doc.supplier.billingAddress?.stateCode ?? '27',
            pincode: doc.supplier.billingAddress?.pincode ?? '',
          },
        }
      : null,
    lines: doc.lines.map((l) => mapPurchaseLine(l, hasCostAccess)),
    amounts: mapTotalsDoc(doc.totals),
    outstanding: fromDecimal(doc.outstanding) ?? '0.00',
    notes: doc.notes || null,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
