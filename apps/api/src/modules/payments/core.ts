import { randomBytes } from 'node:crypto';
import { type ClientSession, type Types } from 'mongoose';
import type {
  CreditNoteResponse,
  DebitNoteResponse,
  ExpenseResponse,
  NoteLineResponse,
  PaymentAllocationResponse,
  PaymentResponse,
  RefundResponse,
} from '@bizmgmt/contracts';
import { dec, money } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type {
  AllocationDoc,
  CreditNoteDoc,
  DebitNoteDoc,
  ExpenseDoc,
  Models,
  NoteLineDoc,
  PaymentDoc,
  RefundDoc,
} from '../../models.js';
import { fromDecimal } from '../../platform/values.js';
import type { AuditAction, AuditChange } from '@bizmgmt/contracts';
import type { AuditLog } from '../audit/audit.js';
import type { JournalService } from '../finance/journals.js';
import type { NumberingService } from '../finance/numbering.js';
import type { RequestMeta } from '../identity/identity.js';
import type { StockLedger } from '../inventory/ledger.js';
import type { TenantContext } from '../tenancy/tenancy.js';

export interface PaymentServices {
  models: Models;
  audit: AuditLog;
  numbering: NumberingService;
  journals: JournalService;
  ledger: StockLedger;
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = () => new AppError('FORBIDDEN', "You don't have permission to do this");
export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);
export const invalidState = (message: string) => new AppError('INVALID_STATE', message);
export const rule = (message: string, path?: string) => new AppError('BUSINESS_RULE', message, path ? [{ path, message }] : undefined);
export const versionConflict = (what: string) => new AppError('VERSION_CONFLICT', `Someone else edited this ${what}. Reload and try again.`);

export const newLineId = () => randomBytes(6).toString('hex');

export const formatMoneyStr = (val: Types.Decimal128 | null | undefined): string => {
  const s = fromDecimal(val);
  if (!s) return '0.00';
  return money(dec(s));
};

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

export function mapAllocationResponse(a: AllocationDoc): PaymentAllocationResponse {
  return {
    id: a._id.toHexString(),
    paymentId: a.paymentId.toHexString(),
    targetType: a.targetType,
    targetId: a.targetId.toHexString(),
    targetNumber: a.targetNumber,
    amount: formatMoneyStr(a.amount),
    allocatedAt: a.allocatedAt.toISOString(),
    allocatedBy: a.allocatedBy.toHexString(),
    status: a.status,
  };
}

export function mapPaymentResponse(p: PaymentDoc, allocations: AllocationDoc[] = []): PaymentResponse {
  return {
    id: p._id.toHexString(),
    number: p.number,
    direction: p.direction,
    partyId: p.partyId.toHexString(),
    partyName: p.partyName,
    legalEntityId: p.legalEntityId.toHexString(),
    amount: formatMoneyStr(p.amount),
    unallocatedAmount: formatMoneyStr(p.unallocatedAmount),
    paymentMethod: p.paymentMethod,
    docDate: p.docDate,
    reference: p.reference,
    bankAccountName: p.bankAccountName,
    status: p.status,
    recordKind: p.recordKind ?? 'payment',
    sourceNoteId: p.sourceNoteId ? p.sourceNoteId.toHexString() : null,
    sourceNoteNumber: p.sourceNoteNumber ?? null,
    notes: p.notes,
    postedAt: p.postedAt ? p.postedAt.toISOString() : null,
    postedBy: p.postedBy ? p.postedBy.toHexString() : null,
    reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
    reversedBy: p.reversedBy ? p.reversedBy.toHexString() : null,
    reversedReason: p.reversedReason,
    allocations: allocations.map(mapAllocationResponse),
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function mapRefundResponse(r: RefundDoc): RefundResponse {
  return {
    id: r._id.toHexString(),
    number: r.number,
    paymentId: r.paymentId.toHexString(),
    partyId: r.partyId.toHexString(),
    partyName: r.partyName,
    legalEntityId: r.legalEntityId.toHexString(),
    amount: formatMoneyStr(r.amount),
    refundDate: r.refundDate,
    paymentMethod: r.paymentMethod,
    reference: r.reference,
    reason: r.reason,
    status: r.status,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
    postedBy: r.postedBy ? r.postedBy.toHexString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export function mapExpenseResponse(e: ExpenseDoc): ExpenseResponse {
  return {
    id: e._id.toHexString(),
    number: e.number,
    legalEntityId: e.legalEntityId.toHexString(),
    category: e.category,
    description: e.description,
    docDate: e.docDate,
    amount: formatMoneyStr(e.amount),
    taxableAmount: formatMoneyStr(e.taxableAmount),
    taxAmount: formatMoneyStr(e.taxAmount),
    taxRate: e.taxRate ? fromDecimal(e.taxRate) : null,
    itcEligible: e.itcEligible,
    payeeName: e.payeeName,
    paymentMode: e.paymentMode,
    reference: e.reference,
    notes: e.notes,
    status: e.status,
    postedAt: e.postedAt ? e.postedAt.toISOString() : null,
    postedBy: e.postedBy ? e.postedBy.toHexString() : null,
    cancelledAt: e.cancelledAt ? e.cancelledAt.toISOString() : null,
    cancelledBy: e.cancelledBy ? e.cancelledBy.toHexString() : null,
    cancelReason: e.cancelReason,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function mapNoteLine(l: NoteLineDoc): NoteLineResponse {
  return {
    lineId: l.lineId,
    sourceLineId: l.sourceLineId,
    itemId: l.itemId ? l.itemId.toHexString() : null,
    itemName: l.itemName,
    sku: l.sku,
    qty: l.qty ? fromDecimal(l.qty) : null,
    unitPrice: formatMoneyStr(l.unitPrice),
    taxRate: l.taxRate ? fromDecimal(l.taxRate) : null,
    taxable: formatMoneyStr(l.taxable),
    cgst: formatMoneyStr(l.cgst),
    sgst: formatMoneyStr(l.sgst),
    utgst: formatMoneyStr(l.utgst),
    igst: formatMoneyStr(l.igst),
    cess: formatMoneyStr(l.cess),
    total: formatMoneyStr(l.total),
    reason: l.reason,
  };
}

export function mapCreditNoteResponse(c: CreditNoteDoc): CreditNoteResponse {
  return {
    id: c._id.toHexString(),
    number: c.number,
    legalEntityId: c.legalEntityId.toHexString(),
    partyId: c.partyId.toHexString(),
    partyName: c.partyName,
    salesInvoiceId: c.salesInvoiceId.toHexString(),
    salesInvoiceNumber: c.salesInvoiceNumber,
    kind: c.kind,
    status: c.status,
    docDate: c.docDate,
    reason: c.reason,
    warehouseId: c.warehouseId ? c.warehouseId.toHexString() : null,
    lines: c.lines.map(mapNoteLine),
    amounts: {
      taxable: formatMoneyStr(c.amounts.taxable),
      cgst: formatMoneyStr(c.amounts.cgst),
      sgst: formatMoneyStr(c.amounts.sgst),
      utgst: formatMoneyStr(c.amounts.utgst),
      igst: formatMoneyStr(c.amounts.igst),
      cess: formatMoneyStr(c.amounts.cess),
      roundOff: formatMoneyStr(c.amounts.roundOff),
      grand: formatMoneyStr(c.amounts.grand),
    },
    notes: c.notes,
    issuedAt: c.issuedAt ? c.issuedAt.toISOString() : null,
    issuedBy: c.issuedBy ? c.issuedBy.toHexString() : null,
    cancelledAt: c.cancelledAt ? c.cancelledAt.toISOString() : null,
    cancelledBy: c.cancelledBy ? c.cancelledBy.toHexString() : null,
    cancelReason: c.cancelReason,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function mapDebitNoteResponse(d: DebitNoteDoc): DebitNoteResponse {
  return {
    id: d._id.toHexString(),
    number: d.number,
    legalEntityId: d.legalEntityId.toHexString(),
    partyId: d.partyId.toHexString(),
    partyName: d.partyName,
    supplierBillId: d.supplierBillId.toHexString(),
    supplierBillNumber: d.supplierBillNumber,
    kind: d.kind,
    status: d.status,
    docDate: d.docDate,
    reason: d.reason,
    warehouseId: d.warehouseId ? d.warehouseId.toHexString() : null,
    lines: d.lines.map(mapNoteLine),
    amounts: {
      taxable: formatMoneyStr(d.amounts.taxable),
      cgst: formatMoneyStr(d.amounts.cgst),
      sgst: formatMoneyStr(d.amounts.sgst),
      utgst: formatMoneyStr(d.amounts.utgst),
      igst: formatMoneyStr(d.amounts.igst),
      cess: formatMoneyStr(d.amounts.cess),
      roundOff: formatMoneyStr(d.amounts.roundOff),
      grand: formatMoneyStr(d.amounts.grand),
    },
    notes: d.notes,
    issuedAt: d.issuedAt ? d.issuedAt.toISOString() : null,
    issuedBy: d.issuedBy ? d.issuedBy.toHexString() : null,
    cancelledAt: d.cancelledAt ? d.cancelledAt.toISOString() : null,
    cancelledBy: d.cancelledBy ? d.cancelledBy.toHexString() : null,
    cancelReason: d.cancelReason,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
