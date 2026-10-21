import { randomBytes } from 'node:crypto';
import { trusted, Types, type ClientSession, type Connection } from 'mongoose';
import {
  DOCUMENT_TYPES,
  stateName,
  type AuditAction,
  type AuditChange,
  type Permission,
  type SalesDocType,
  type SalesDocument,
  type SalesDocumentKind,
  type SalesLine,
} from '@bizmgmt/contracts';
import { dec, money } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { AmountsDoc, BuyerSnapshotDoc, DocumentSeriesDoc, GstRegistrationDoc, LegalEntityDoc, Models, PartyDoc, SalesDocDoc, SalesLineDoc, SellerSnapshotDoc, TotalsDoc, WarehouseDoc } from '../../models.js';
import type { ObjectStorage } from '../../platform/storage.js';
import { fromDecimal, toDecimal, todayIST, versionConflict } from '../../platform/values.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { JournalService } from '../finance/journals.js';
import type { NumberingService } from '../finance/numbering.js';
import type { PreviewService } from '../finance/preview.js';
import type { RequestMeta } from '../identity/identity.js';
import { StockLedger } from '../inventory/ledger.js';
import { canInEntity, canInWarehouse, visibleEntities, type TenantContext } from '../tenancy/tenancy.js';
import { templateFor } from '../../pdf/sales-print.js';

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = () => new AppError('FORBIDDEN', "You don't have permission to do this");
export const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);
export const invalidState = (message: string) => new AppError('INVALID_STATE', message);
export const rule = (message: string, path?: string) => new AppError('BUSINESS_RULE', message, path ? [{ path, message }] : undefined);

export const newLineId = () => randomBytes(6).toString('hex');
const ZERO = () => toDecimal('0');

export const DOC_LABELS: Record<SalesDocType, string> = { quotation: 'Quotation', sales_order: 'Sales order', dispatch: 'Dispatch', sales_invoice: 'Invoice' };

/** Who can open each kind of document (permission-matrix.md, Phase 7 notes). Actions need their own permission. */
export const VIEW_PERMISSIONS: Record<SalesDocType, Permission[]> = {
  quotation: ['quotation.edit', 'quotation.issue', 'report.sales', 'report.financial'],
  sales_order: ['salesorder.edit', 'salesorder.confirm', 'salesorder.cancel', 'dispatch.post', 'invoice.edit', 'report.sales', 'report.financial'],
  dispatch: ['dispatch.post', 'salesorder.edit', 'invoice.edit', 'report.sales', 'report.financial'],
  sales_invoice: ['invoice.edit', 'invoice.issue', 'invoice.cancel', 'report.sales', 'report.financial'],
};

/** Prices and amounts are shown to people who sell or keep the books, not to those who only move goods. */
const PRICE_PERMISSIONS: Permission[] = ['quotation.edit', 'quotation.issue', 'salesorder.edit', 'salesorder.confirm', 'salesorder.cancel', 'invoice.edit', 'invoice.issue', 'invoice.cancel', 'report.sales', 'report.financial'];

/** The editable inputs of a draft, as decimal strings (what the create schemas produce). */
export interface DraftInput {
  legalEntityId: string;
  gstRegistrationId: string;
  partyId: string;
  docDate: string;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  placeOfSupply: string | null;
  documentDiscount: string;
  customerReference: string;
  notes: string;
  terms: string;
  seriesId: string | null;
  lines: Array<{ itemId: string; qty: string; unitPrice: string; discount: { type: 'percent' | 'amount'; value: string } | null; sourceLineId: string | null }>;
  kind?: 'quotation' | 'proforma' | undefined;
  warehouseId?: string | null | undefined;
  validUntil?: string | null | undefined;
  dueDate?: string | null | undefined;
  expectedDate?: string | null | undefined;
  transport?: { vehicleNumber: string; transporterName: string; ewayBillNumber: string } | undefined;
}

/** Fields that a computation sets on a document (inputs plus the figures and current snapshots). */
export type ComputedFields = Pick<
  SalesDocDoc,
  | 'gstRegistrationId'
  | 'documentKind'
  | 'seriesId'
  | 'docDate'
  | 'partyId'
  | 'partyName'
  | 'billingAddressId'
  | 'shippingAddressId'
  | 'placeOfSupply'
  | 'placeOfSupplyOverridden'
  | 'supply'
  | 'warehouseId'
  | 'documentDiscount'
  | 'customerReference'
  | 'notes'
  | 'terms'
  | 'validUntil'
  | 'dueDate'
  | 'expectedDate'
  | 'transport'
  | 'lines'
  | 'totals'
  | 'hsnSummary'
  | 'calcVersion'
  | 'warnings'
  | 'seller'
  | 'buyer'
>;

export interface Computation {
  fields: ComputedFields;
  entity: LegalEntityDoc;
  registration: GstRegistrationDoc;
  party: PartyDoc;
  warehouse: WarehouseDoc | null;
}

const AMOUNT_KEYS = ['gross', 'discount', 'net', 'documentDiscount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'total'] as const;
const TOTAL_KEYS = ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'reverseChargeTax', 'subtotal', 'roundOff', 'grand'] as const;
const decimals = <K extends string>(keys: readonly K[], values: Record<K, string>) => Object.fromEntries(keys.map((k) => [k, toDecimal(values[k])])) as Record<K, Types.Decimal128>;
const strings = <K extends string>(keys: readonly K[], values: Record<K, Types.Decimal128>) => Object.fromEntries(keys.map((k) => [k, values[k].toString()])) as Record<K, string>;

export const totalsOf = (doc: Pick<SalesDocDoc, 'totals'>) => strings(TOTAL_KEYS, doc.totals);
export const qtyOf = (v: Types.Decimal128 | null | undefined) => (v ? v.toString() : '0');

/**
 * Shared plumbing of the sales documents (FR-SAL-01..09): access, the draft
 * computation (Phase 6 calculation plus address and place-of-supply rules),
 * snapshots, numbering series, the credit-limit check and responses.
 */
export class SalesCore {
  readonly ledger: StockLedger;

  constructor(
    readonly deps: {
      connection: Connection;
      models: Models;
      audit: AuditLog;
      journals: JournalService;
      numbering: NumberingService;
      preview: PreviewService;
      storage: ObjectStorage;
      now?: (() => Date) | undefined;
    },
  ) {
    this.ledger = new StockLedger(deps.models);
  }

  now() {
    return this.deps.now?.() ?? new Date();
  }

  model(docType: SalesDocType) {
    const { Quotation, SalesOrder, Dispatch, SalesInvoice } = this.deps.models;
    return { quotation: Quotation, sales_order: SalesOrder, dispatch: Dispatch, sales_invoice: SalesInvoice }[docType];
  }

  record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>, session?: ClientSession) {
    return this.deps.audit.record({ ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash }, session);
  }

  audit(ctx: TenantContext, meta: RequestMeta, doc: Pick<SalesDocDoc, '_id' | 'docType'>, action: AuditAction, summary: string, changes: AuditChange[] = [], session?: ClientSession) {
    return this.record(ctx, meta, { action, entityType: doc.docType, entityId: doc._id.toHexString(), summary, changes }, session);
  }

  require(ctx: TenantContext, permission: Permission, entityId: Types.ObjectId | string) {
    if (!canInEntity(ctx, permission, entityId)) throw forbidden();
  }

  /** An entity the caller can work in with any of the permissions; otherwise "not found". */
  async findEntity(ctx: TenantContext, id: string | Types.ObjectId, permissions: Permission[]): Promise<LegalEntityDoc> {
    const _id = typeof id === 'string' ? new Types.ObjectId(id) : id;
    const scope = visibleEntities(ctx, permissions);
    if (scope !== 'all' && !scope.has(_id.toHexString())) throw notFound('Business entity');
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id }).lean();
    if (!entity || entity.archivedAt) throw notFound('Business entity');
    return entity;
  }

  /** A document the caller may open; out of scope or another tenant's is "not found" (AC-TEN-1). */
  async findDoc(ctx: TenantContext, docType: SalesDocType, id: string): Promise<SalesDocDoc> {
    const doc = await this.model(docType).findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!doc || !VIEW_PERMISSIONS[docType].some((p) => canInEntity(ctx, p, doc.legalEntityId))) throw notFound(DOC_LABELS[docType]);
    return doc;
  }

  showPrices(ctx: TenantContext, entityId: Types.ObjectId) {
    return PRICE_PERMISSIONS.some((p) => canInEntity(ctx, p, entityId));
  }

  /** A warehouse of the entity, usable for the document's GSTIN (each GSTIN is a distinct person). */
  async findWarehouse(ctx: TenantContext, id: string | Types.ObjectId, entityId: Types.ObjectId, registrationId: Types.ObjectId, path = 'warehouseId'): Promise<WarehouseDoc> {
    const warehouse = await this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: typeof id === 'string' ? new Types.ObjectId(id) : id }).lean();
    if (!warehouse || !warehouse.legalEntityId.equals(entityId)) throw invalid(path, 'Choose a warehouse of this business entity');
    if (warehouse.archivedAt) throw invalid(path, 'This warehouse is archived');
    if (warehouse.gstRegistrationId && !warehouse.gstRegistrationId.equals(registrationId)) {
      throw invalid(path, 'This warehouse is under another GSTIN of the business. Goods sold under one GSTIN must leave from its own place of business.');
    }
    return warehouse;
  }

  requireInWarehouse(ctx: TenantContext, permission: Permission, warehouse: WarehouseDoc) {
    if (!canInWarehouse(ctx, permission, warehouse)) throw forbidden();
  }

  /** Not in the future; documents that post (dispatch, invoice, cancellation) also not in a locked period (FR-CO-05). */
  checkDate(entity: LegalEntityDoc, docDate: string, posting: boolean) {
    if (docDate > todayIST(this.now())) throw invalid('docDate', 'The date can’t be in the future');
    if (posting && entity.periodLockDate && docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked for this business entity`, [{ path: 'docDate', message: 'Locked period' }]);
    }
  }

  inputOf(doc: SalesDocDoc): DraftInput {
    return {
      legalEntityId: doc.legalEntityId.toHexString(),
      gstRegistrationId: doc.gstRegistrationId.toHexString(),
      partyId: doc.partyId.toHexString(),
      docDate: doc.docDate,
      billingAddressId: doc.billingAddressId,
      shippingAddressId: doc.shippingAddressId,
      placeOfSupply: doc.placeOfSupplyOverridden ? doc.placeOfSupply : null,
      documentDiscount: doc.documentDiscount.toString(),
      customerReference: doc.customerReference,
      notes: doc.notes,
      terms: doc.terms,
      seriesId: doc.seriesId?.toHexString() ?? null,
      lines: doc.lines.map((l) => ({ itemId: l.itemId.toHexString(), qty: l.qty.toString(), unitPrice: l.unitPrice.toString(), discount: l.discount ? { type: l.discount.type, value: l.discount.value.toString() } : null, sourceLineId: l.sourceLineId })),
      // Only the fields of this document type (the input schemas are strict).
      ...(doc.docType === 'quotation' ? { kind: doc.documentKind === 'proforma_invoice' ? ('proforma' as const) : ('quotation' as const), validUntil: doc.validUntil } : {}),
      ...(doc.docType !== 'quotation' ? { warehouseId: doc.warehouseId?.toHexString() ?? null } : {}),
      ...(doc.docType === 'sales_order' ? { expectedDate: doc.expectedDate } : {}),
      ...(doc.docType === 'sales_invoice' ? { dueDate: doc.dueDate } : {}),
      ...(doc.docType === 'dispatch' ? { transport: doc.transport ?? { vehicleNumber: '', transporterName: '', ewayBillNumber: '' } } : {}),
    };
  }

  /**
   * Computes a draft from its inputs: the customer's addresses, the place of
   * supply (default: the shipping address's state, else billing; GST-10, C-01),
   * the buyer GSTIN (the one on the billing address, else the one in the place
   * of supply's state), the figures, and the current seller and buyer details.
   */
  async compute(ctx: TenantContext, docType: SalesDocType, input: DraftInput): Promise<Computation> {
    const { models } = this.deps;
    const entityId = new Types.ObjectId(input.legalEntityId);
    const registration = await models.GstRegistration.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(input.gstRegistrationId), legalEntityId: entityId }).lean();
    if (!registration) throw invalid('gstRegistrationId', 'Choose a GST registration of this business entity');
    const party = await models.Party.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(input.partyId), archivedAt: null }).lean();
    if (!party || !party.isCustomer) throw invalid('partyId', 'Choose a customer');

    const address = (id: string | null, path: string) => {
      if (id === null) return null;
      const found = party.addresses.find((a) => a.id === id);
      if (!found) throw invalid(path, 'Choose one of the customer’s addresses');
      return found;
    };
    const billing = address(input.billingAddressId, 'billingAddressId') ?? party.addresses.find((a) => a.isBilling) ?? party.addresses[0] ?? null;
    const shipping = address(input.shippingAddressId, 'shippingAddressId') ?? party.addresses.find((a) => a.isShipping) ?? billing;
    const derived = shipping?.stateCode ?? billing?.stateCode ?? registration.stateCode;
    const placeOfSupply = input.placeOfSupply ?? derived;
    const billingGstin = billing ? party.gstins.find((g) => g.addressId === billing.id)?.gstin : undefined;

    let warehouse: WarehouseDoc | null = null;
    if (input.warehouseId) warehouse = await this.findWarehouse(ctx, input.warehouseId, entityId, registration._id);

    const computed = await this.deps.preview.compute(
      ctx,
      { legalEntityId: input.legalEntityId, gstRegistrationId: input.gstRegistrationId, partyId: input.partyId, docDate: input.docDate, placeOfSupply, documentDiscount: input.documentDiscount, lines: input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })) },
      { buyerGstin: billingGstin, forDocument: docType },
    );
    const entity = computed.entity;

    const lines: SalesLineDoc[] = computed.lines.map((l, i) => {
      const src = input.lines[i];
      const unit = computed.units.get(computed.items.get(l.itemId)?.baseUnitId.toHexString() ?? '');
      if (!src || !unit) throw new Error('calculation line missing');
      return {
        lineId: newLineId(),
        itemId: new Types.ObjectId(l.itemId),
        qty: toDecimal(l.qty),
        unitPrice: toDecimal(l.unitPrice),
        discount: src.discount ? { type: src.discount.type, value: toDecimal(src.discount.value) } : null,
        sourceLineId: src.sourceLineId,
        item: { sku: l.item.sku, name: l.item.name, type: l.item.type, hsnSac: l.item.hsnSac, unitCode: l.item.unitCode, uqc: l.item.uqc, decimals: unit.decimals },
        taxRate: l.taxRate === null ? null : toDecimal(l.taxRate),
        cessRate: l.cessRate === null ? null : toDecimal(l.cessRate),
        reverseCharge: l.reverseCharge,
        amounts: decimals(AMOUNT_KEYS, l) as unknown as AmountsDoc,
        reservedQty: ZERO(),
        fulfilledQty: ZERO(),
        invoicedQty: ZERO(),
        unitCost: null,
        costValue: null,
      };
    });

    const strip = (a: (typeof party.addresses)[number] | null) => (a ? { line1: a.line1, line2: a.line2, city: a.city, district: a.district, stateCode: a.stateCode, pincode: a.pincode } : null);
    const seller: SellerSnapshotDoc = {
      legalEntityId: entity._id.toHexString(),
      legalName: entity.legalName,
      tradeName: entity.tradeName,
      pan: entity.pan,
      gstin: registration.gstin,
      stateCode: registration.stateCode,
      registrationType: registration.registrationType,
      address: { ...registration.address },
      email: entity.email,
      phone: entity.phone,
    };
    const buyer: BuyerSnapshotDoc = {
      partyId: party._id.toHexString(),
      name: party.name,
      legalName: party.legalName,
      gstin: computed.buyer?.gstin ?? null,
      stateCode: computed.buyer?.stateCode ?? null,
      billingAddress: strip(billing),
      shippingAddress: strip(shipping),
    };

    const documentKind: SalesDocumentKind =
      docType === 'quotation' ? (input.kind === 'proforma' ? 'proforma_invoice' : 'quotation') : docType === 'sales_order' ? 'sales_order' : docType === 'dispatch' ? 'delivery_challan' : computed.documentKind;
    const warnings = [...computed.warnings];
    if (input.placeOfSupply && input.placeOfSupply !== derived) warnings.push(`Place of supply set to ${stateName(input.placeOfSupply) ?? input.placeOfSupply} instead of ${stateName(derived) ?? derived} (from the customer’s address). This is recorded in the audit log.`);

    return {
      entity,
      registration,
      party,
      warehouse,
      fields: {
        gstRegistrationId: registration._id,
        documentKind,
        seriesId: input.seriesId ? new Types.ObjectId(input.seriesId) : null,
        docDate: input.docDate,
        partyId: party._id,
        partyName: party.name,
        billingAddressId: billing?.id ?? null,
        shippingAddressId: shipping?.id ?? null,
        placeOfSupply,
        placeOfSupplyOverridden: placeOfSupply !== derived,
        supply: computed.supply,
        warehouseId: warehouse?._id ?? null,
        documentDiscount: toDecimal(input.documentDiscount),
        customerReference: input.customerReference,
        notes: input.notes,
        terms: input.terms,
        validUntil: input.validUntil ?? null,
        dueDate: input.dueDate ?? null,
        expectedDate: input.expectedDate ?? null,
        transport: input.transport ?? null,
        lines,
        totals: decimals(TOTAL_KEYS, computed.totals) as unknown as TotalsDoc,
        hsnSummary: computed.hsnSummary.map((h) => ({ hsnSac: h.hsnSac, rate: h.rate === null ? null : toDecimal(h.rate), reverseCharge: h.reverseCharge, taxable: toDecimal(h.taxable), cgst: toDecimal(h.cgst), sgst: toDecimal(h.sgst), utgst: toDecimal(h.utgst), igst: toDecimal(h.igst), cess: toDecimal(h.cess) })),
        calcVersion: computed.calcVersion,
        warnings,
        seller,
        buyer,
      },
    };
  }

  /** A new draft document from a computation. */
  newDraft(ctx: TenantContext, docType: SalesDocType, c: Computation, extra: Partial<SalesDocDoc> = {}): SalesDocDoc {
    const now = this.now();
    return {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: c.entity._id,
      docType,
      status: 'draft',
      series: null,
      number: null,
      logoFileId: null,
      bankAccount: null,
      templateVersion: null,
      source: null,
      revision: 0,
      revisionOf: null,
      outstanding: null,
      paymentStatus: null,
      einvoiceStatus: null,
      createdBy: ctx.userId,
      issuedBy: null,
      issuedAt: null,
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...c.fields,
      ...extra,
    };
  }

  /** Saves new draft fields with optimistic concurrency. */
  async saveDraft(ctx: TenantContext, doc: SalesDocDoc, version: number, fields: Partial<SalesDocDoc>, session?: ClientSession): Promise<SalesDocDoc> {
    const updated = await this.model(doc.docType)
      .findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: fields, $inc: { version: 1 } }, { returnDocument: 'after', ...(session ? { session } : {}) })
      .lean();
    if (!updated) throw versionConflict(DOC_LABELS[doc.docType].toLowerCase());
    return updated;
  }

  // -------------------------------------------------------------- numbering

  /**
   * The series that numbers the document: the one chosen on the draft, else
   * the default series of the document type in its scope (the GSTIN for GST
   * documents, the business entity otherwise). The counter is prepared here,
   * outside the transaction; the number is taken inside it.
   */
  async prepareSeries(ctx: TenantContext, doc: Pick<SalesDocDoc, 'legalEntityId' | 'gstRegistrationId' | 'seriesId' | 'docDate'>, kind: SalesDocumentKind, registration: GstRegistrationDoc): Promise<DocumentSeriesDoc> {
    const scopeId = DOCUMENT_TYPES[kind].scope === 'registration' ? doc.gstRegistrationId : doc.legalEntityId;
    const label = DOCUMENT_TYPES[kind].label.toLowerCase();
    const { DocumentSeries } = this.deps.models;
    let series: DocumentSeriesDoc | null;
    if (doc.seriesId) {
      series = await DocumentSeries.findOne({ tenantId: ctx.tenantId, _id: doc.seriesId }).lean();
      if (!series || !series.scopeId.equals(scopeId) || series.docType !== kind) throw rule(`The chosen series doesn’t number ${label}s for this ${DOCUMENT_TYPES[kind].scope === 'registration' ? 'GSTIN' : 'business'}. Choose another series.`, 'seriesId');
      if (!series.active) throw rule(`The series "${series.name}" is not active`, 'seriesId');
    } else {
      const candidates = await DocumentSeries.find({ tenantId: ctx.tenantId, scopeId, docType: kind, active: true }).lean();
      series = candidates.find((s) => s.isDefault) ?? (candidates.length === 1 ? (candidates[0] ?? null) : null);
      if (!series) {
        const where = DOCUMENT_TYPES[kind].scope === 'registration' ? ` for GSTIN ${registration.gstin}` : '';
        throw rule(candidates.length ? `Several ${label} series exist${where}; choose one on the document or mark one as the default.` : `Add a ${label} series${where} under Settings › Document series first.`, 'seriesId');
      }
    }
    await this.deps.numbering.prepare(ctx.tenantId, series._id, doc.docDate);
    return series;
  }

  async takeNumber(session: ClientSession, ctx: TenantContext, series: DocumentSeriesDoc, docDate: string) {
    const issued = await this.deps.numbering.take(session, ctx.tenantId, series._id, docDate);
    return { number: issued.number, series: { seriesId: issued.seriesId, scopeId: issued.scopeId, fy: issued.fy, sequence: issued.sequence } };
  }

  /** Snapshots printed with a numbered document: the logo and default bank account as they are now. */
  printSnapshot(entity: LegalEntityDoc, docType: SalesDocType): Pick<SalesDocDoc, 'logoFileId' | 'bankAccount' | 'templateVersion'> {
    const bank = entity.bankAccounts.find((b) => b.isDefault) ?? entity.bankAccounts[0] ?? null;
    return { logoFileId: entity.logo?.fileId ?? null, bankAccount: bank ? { ...bank } : null, templateVersion: templateFor({ docType }) };
  }

  // ---------------------------------------------------------- credit limit

  /**
   * FR-SAL-08: the customer's open invoices (all business entities) plus this
   * document must stay within the credit limit, unless someone with
   * credit.override confirms it. Returns an audit change when overridden.
   */
  async checkCredit(ctx: TenantContext, party: PartyDoc, amount: string, override: boolean, entityId: Types.ObjectId): Promise<AuditChange | null> {
    if (party.creditLimit === null) return null;
    const rows = await this.deps.models.SalesInvoice.aggregate<{ total: unknown }>([
      { $match: { tenantId: ctx.tenantId, partyId: party._id, status: 'issued' } },
      { $group: { _id: null, total: { $sum: '$outstanding' } } },
    ]);
    const open = dec(String(rows[0]?.total ?? '0'));
    const limit = dec(party.creditLimit.toString());
    const exposure = open.plus(dec(amount));
    if (exposure.lessThanOrEqualTo(limit)) return null;
    if (!override) {
      throw new AppError('BUSINESS_RULE', `This takes ${party.name} to ₹${money(exposure)} owed, over their credit limit of ₹${money(limit)} (₹${money(open)} already outstanding).`, [{ path: 'creditLimit', message: 'Over the credit limit' }]);
    }
    if (!canInEntity(ctx, 'credit.override', entityId)) throw new AppError('FORBIDDEN', 'Going over a credit limit needs the “Approve sales beyond the credit limit” permission', [{ path: 'overrideCreditLimit', message: 'credit.override' }]);
    return { field: 'creditLimit', from: money(limit), to: `overridden at ${money(exposure)}` };
  }

  // -------------------------------------------------------------- responses

  private async actorNames(ids: Array<Types.ObjectId | null>) {
    const unique = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))].map((id) => new Types.ObjectId(id));
    const users = unique.length ? await this.deps.models.User.find({ _id: trusted({ $in: unique }) }, { name: 1 }).lean() : [];
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return (id: Types.ObjectId | null) => (id ? { id: id.toHexString(), name: names.get(id.toHexString()) ?? 'Former member' } : null);
  }

  /** Documents made from this one (and, for a quotation, its revisions). */
  async related(ctx: TenantContext, doc: SalesDocDoc) {
    const targets: SalesDocType[] = { quotation: ['sales_order', 'sales_invoice'], sales_order: ['dispatch', 'sales_invoice'], dispatch: ['sales_invoice'], sales_invoice: [] }[doc.docType] as SalesDocType[];
    const out: SalesDocument['related'] = [];
    for (const type of targets) {
      const rows = await this.model(type).find({ tenantId: ctx.tenantId, 'source.id': doc._id, status: trusted({ $ne: 'discarded' }) }, { number: 1, status: 1 }).sort({ _id: 1 }).limit(100).lean();
      out.push(...rows.map((r) => ({ type, id: r._id.toHexString(), number: r.number, status: r.status })));
    }
    if (doc.docType === 'quotation') {
      const revisions = await this.deps.models.Quotation.find({ tenantId: ctx.tenantId, revisionOf: doc._id }, { number: 1, status: 1 }).lean();
      out.push(...revisions.map((r) => ({ type: 'quotation' as const, id: r._id.toHexString(), number: r.number, status: r.status })));
    }
    return out;
  }

  async toResponse(ctx: TenantContext, doc: SalesDocDoc, detail = true): Promise<SalesDocument> {
    const { models } = this.deps;
    const prices = this.showPrices(ctx, doc.legalEntityId);
    const cost = ctx.permissions.has('price.view_cost');
    const [actor, warehouse, source, revisionOf, related, artifact] = await Promise.all([
      this.actorNames([doc.createdBy, doc.issuedBy, doc.cancelledBy]),
      doc.warehouseId ? models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: doc.warehouseId }, { code: 1, name: 1 }).lean() : null,
      doc.source ? this.model(doc.source.type).findOne({ tenantId: ctx.tenantId, _id: doc.source.id }, { number: 1, status: 1 }).lean() : null,
      doc.revisionOf ? models.Quotation.findOne({ tenantId: ctx.tenantId, _id: doc.revisionOf }, { number: 1 }).lean() : null,
      detail ? this.related(ctx, doc) : Promise.resolve([]),
      doc.templateVersion ? models.DocumentArtifact.findOne({ tenantId: ctx.tenantId, docType: doc.docType, docId: doc._id, templateVersion: doc.templateVersion }).lean() : null,
    ]);
    const file = artifact?.fileId ? await models.File.findOne({ tenantId: ctx.tenantId, _id: artifact.fileId }, { size: 1 }).lean() : null;
    const isOrder = doc.docType === 'sales_order';
    const lines: SalesLine[] = doc.lines.map((l) => {
      const { discount: discountAmount, ...amounts } = strings(AMOUNT_KEYS, l.amounts as unknown as Record<(typeof AMOUNT_KEYS)[number], Types.Decimal128>);
      return {
      lineId: l.lineId,
      itemId: l.itemId.toHexString(),
      sku: l.item.sku,
      itemName: l.item.name,
      itemType: l.item.type,
      hsnSac: l.item.hsnSac,
      unitCode: l.item.unitCode,
      uqc: l.item.uqc,
      qty: l.qty.toString(),
      sourceLineId: l.sourceLineId,
      reverseCharge: l.reverseCharge,
      taxRate: fromDecimal(l.taxRate),
      cessRate: fromDecimal(l.cessRate),
      ...(prices ? { unitPrice: l.unitPrice.toString(), discount: l.discount ? { type: l.discount.type, value: l.discount.value.toString() } : null, discountAmount, ...amounts } : {}),
      ...(isOrder ? { reservedQty: qtyOf(l.reservedQty), fulfilledQty: qtyOf(l.fulfilledQty) } : {}),
      ...(isOrder || doc.docType === 'dispatch' ? { invoicedQty: qtyOf(l.invoicedQty) } : {}),
      ...(cost && (doc.docType === 'dispatch' || doc.docType === 'sales_invoice') ? { unitCost: fromDecimal(l.unitCost), costValue: fromDecimal(l.costValue) } : {}),
      };
    });
    return {
      id: doc._id.toHexString(),
      docType: doc.docType,
      documentKind: doc.documentKind,
      number: doc.number,
      status: doc.status as SalesDocument['status'],
      legalEntityId: doc.legalEntityId.toHexString(),
      gstRegistrationId: doc.gstRegistrationId.toHexString(),
      seriesId: doc.seriesId?.toHexString() ?? null,
      docDate: doc.docDate,
      partyId: doc.partyId.toHexString(),
      partyName: doc.partyName,
      billingAddressId: doc.billingAddressId,
      shippingAddressId: doc.shippingAddressId,
      seller: { legalEntityId: doc.seller.legalEntityId, legalName: doc.seller.legalName, tradeName: doc.seller.tradeName, pan: doc.seller.pan, gstin: doc.seller.gstin, stateCode: doc.seller.stateCode, registrationType: doc.seller.registrationType, address: doc.seller.address },
      buyer: doc.buyer,
      placeOfSupply: doc.placeOfSupply,
      placeOfSupplyOverridden: doc.placeOfSupplyOverridden,
      supply: doc.supply,
      warehouseId: doc.warehouseId?.toHexString() ?? null,
      warehouseName: warehouse ? `${warehouse.code} · ${warehouse.name}` : null,
      customerReference: doc.customerReference,
      notes: doc.notes,
      terms: doc.terms,
      validUntil: doc.validUntil,
      dueDate: doc.dueDate,
      expectedDate: doc.expectedDate,
      transport: doc.transport,
      lines,
      ...(prices ? { documentDiscount: doc.documentDiscount.toString(), totals: totalsOf(doc), hsnSummary: doc.hsnSummary.map((h) => ({ hsnSac: h.hsnSac, rate: fromDecimal(h.rate), reverseCharge: h.reverseCharge, taxable: h.taxable.toString(), cgst: h.cgst.toString(), sgst: h.sgst.toString(), utgst: h.utgst.toString(), igst: h.igst.toString(), cess: h.cess.toString() })) } : {}),
      calcVersion: doc.calcVersion,
      warnings: doc.status === 'draft' ? doc.warnings : [],
      source: doc.source && source ? { type: doc.source.type, id: doc.source.id.toHexString(), number: source.number, status: source.status } : null,
      related,
      revision: doc.revision,
      revisionOf: doc.revisionOf ? { id: doc.revisionOf.toHexString(), number: revisionOf?.number ?? null } : null,
      ...(doc.docType === 'sales_invoice' && prices ? { outstanding: fromDecimal(doc.outstanding) } : {}),
      paymentStatus: doc.paymentStatus,
      einvoiceStatus: doc.einvoiceStatus,
      pdf: artifact ? { status: artifact.status, templateVersion: artifact.templateVersion, sizeBytes: file?.size ?? null, createdAt: artifact.createdAt.toISOString() } : null,
      createdBy: actor(doc.createdBy),
      createdAt: doc.createdAt.toISOString(),
      issuedBy: actor(doc.issuedBy),
      issuedAt: doc.issuedAt?.toISOString() ?? null,
      cancelledBy: actor(doc.cancelledBy),
      cancelledAt: doc.cancelledAt?.toISOString() ?? null,
      cancelReason: doc.cancelReason,
      version: doc.version,
    };
  }

  /** Lists documents of the entities the caller can see, newest first. */
  async list(ctx: TenantContext, docType: SalesDocType, query: { legalEntityId?: string | undefined; status?: string | undefined; partyId?: string | undefined; q?: string | undefined; limit: number; cursor?: string | undefined }) {
    const scope = visibleEntities(ctx, VIEW_PERMISSIONS[docType]);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) {
      if (scope !== 'all' && !scope.has(query.legalEntityId)) throw notFound('Business entity');
      filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    } else if (scope !== 'all') {
      filter.legalEntityId = trusted({ $in: [...scope].map((id) => new Types.ObjectId(id)) });
    }
    if (query.status) filter.status = query.status;
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    if (query.q) {
      const q = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ number: trusted({ $regex: `^${q}`, $options: 'i' }) }, { partyName: trusted({ $regex: q, $options: 'i' }) }];
    }
    if (query.cursor) filter._id = trusted({ $lt: new Types.ObjectId(query.cursor) });
    const found = await this.model(docType).find(filter).sort({ _id: -1 }).limit(query.limit + 1).lean();
    const rows = found.slice(0, query.limit);
    return { data: await Promise.all(rows.map((r) => this.toResponse(ctx, r, false))), page: { nextCursor: found.length > query.limit ? (rows.at(-1)?._id.toHexString() ?? null) : null, limit: query.limit } };
  }

  /** The stored PDF of a numbered document, served as rendered (AC-DOC-1). */
  async pdf(ctx: TenantContext, docType: SalesDocType, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const doc = await this.findDoc(ctx, docType, id);
    if (!doc.templateVersion || !doc.number) throw invalidState(`A PDF is made when the ${DOC_LABELS[docType].toLowerCase()} is ${docType === 'quotation' ? 'sent' : docType === 'dispatch' ? 'dispatched' : 'issued'}`);
    const artifact = await this.deps.models.DocumentArtifact.findOne({ tenantId: ctx.tenantId, docType, docId: doc._id, templateVersion: doc.templateVersion }).lean();
    if (!artifact || artifact.status === 'pending') throw invalidState('The PDF is being prepared. Try again in a moment.');
    if (artifact.status === 'failed' || !artifact.fileId) throw rule('The PDF could not be made. The team has been alerted.');
    const file = await this.deps.models.File.findOne({ tenantId: ctx.tenantId, _id: artifact.fileId }).lean();
    if (!file) throw notFound('PDF');
    return { bytes: await this.deps.storage.get(file.storageKey), filename: `${doc.number.replace(/[^A-Za-z0-9-]/g, '_')}.pdf` };
  }

  /** Lines of a document for a source line id. */
  static lineById(doc: Pick<SalesDocDoc, 'lines'>, lineId: string | null) {
    return lineId ? (doc.lines.find((l) => l.lineId === lineId) ?? null) : null;
  }
}
