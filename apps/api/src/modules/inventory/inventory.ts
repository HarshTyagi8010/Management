import { randomBytes } from 'node:crypto';
import { trusted, Types, type ClientSession, type Connection } from 'mongoose';
import {
  stockAdjustmentInputSchema,
  type AdjustmentReason,
  type AuditAction,
  type AuditChange,
  type Permission,
  type ReconciliationReport,
  type StockAdjustment,
  type StockCount,
  type StockMovement,
  type StockSourceType,
  type StockSummaryRow,
  type StockTransfer,
  type StockValuation,
  type Warehouse,
} from '@bizmgmt/contracts';
import { dec, fitsDecimals, formatQty, money, valueAt } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { AddressDoc, ItemDoc, LegalEntityDoc, Models, StockAdjustmentDoc, StockCountDoc, StockDocLine, StockTransferDoc, UnitDoc, WarehouseDoc } from '../../models.js';
import { withTransaction } from '../../platform/transactions.js';
import { decodeCursor, encodeCursor, escapeRegex, fromDecimal, isDuplicateKey, nameKey, toDecimal, todayIST, versionConflict } from '../../platform/values.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { RequestMeta } from '../identity/identity.js';
import { canInEntity, canInWarehouse, visibleEntities, type TenantContext } from '../tenancy/tenancy.js';
import { JournalService, stockJournalLines } from '../finance/journals.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import { enqueue } from '../../platform/outbox.js';
import type { ObjectStorage } from '../../platform/storage.js';
import { STOCK_TRANSFER_TEMPLATE } from '../../pdf/templates/stock-transfer.js';
import { StockLedger, type PostLine, type PostedLine } from './ledger.js';
import { reconcileStock } from './reconciliation.js';

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const forbidden = () => new AppError('FORBIDDEN', "You don't have permission to do this");
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);
const invalidState = (message: string) => new AppError('INVALID_STATE', message);

const STOCK_PERMISSIONS: Permission[] = ['stock.view', 'stock.move', 'stock.adjust', 'stock.count.post'];
const lineId = () => randomBytes(6).toString('hex');

type ItemInfo = { item: ItemDoc; unit: UnitDoc };
type Optional<T> = { [K in keyof T]?: T[K] | undefined };

interface AdjustmentInput {
  warehouseId: string;
  type: 'opening' | 'adjustment';
  reason: AdjustmentReason | null;
  note: string;
  docDate: string;
  lines: Array<{ itemId: string; qty: string; unitCost: string | null }>;
}

interface DocListQuery {
  legalEntityId?: string | undefined;
  warehouseId?: string | undefined;
  status?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

interface TransferInput {
  fromWarehouseId: string;
  toWarehouseId: string;
  docDate: string;
  note: string;
  lines: Array<{ itemId: string; qty: string }>;
}

/**
 * Inventory (FR-INV-01..10): warehouses, opening stock, adjustments, transfers,
 * counts, stock enquiries and reconciliation. Every stock change goes through
 * StockLedger inside a transaction with the document change and its audit entry.
 *
 * Access (FR-RBAC-03): warehouses are listed to anyone working in their legal
 * entity; stock figures and stock commands need the permission in that warehouse.
 */
export class InventoryService {
  private readonly ledger: StockLedger;

  constructor(private readonly deps: { connection: Connection; models: Models; audit: AuditLog; journals: JournalService; storage: ObjectStorage; now?: () => Date }) {
    this.ledger = new StockLedger(deps.models);
  }

  /** Posts the journal for stock movements inside the posting transaction (ADR-011). */
  private postJournal(ctx: TenantContext, session: ClientSession, entity: LegalEntityDoc, docDate: string, source: { type: 'stock_adjustment' | 'stock_count'; id: Types.ObjectId; number: string; narration: string }, results: PostedLine[]) {
    return this.deps.journals.post(session, {
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      docDate,
      sourceType: source.type,
      sourceId: source.id,
      sourceNumber: source.number,
      narration: source.narration,
      lines: stockJournalLines(results.flatMap((r) => r.movements)),
      actorId: ctx.userId,
      now: this.now(),
    });
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private auditInput(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>): AuditInput {
    return { ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash };
  }

  private record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>, session?: ClientSession) {
    return this.deps.audit.record(this.auditInput(ctx, meta, input), session);
  }

  // ------------------------------------------------------------- access

  private async findEntity(ctx: TenantContext, id: Types.ObjectId | string): Promise<LegalEntityDoc> {
    const _id = typeof id === 'string' ? new Types.ObjectId(id) : id;
    const scope = visibleEntities(ctx);
    if (scope !== 'all' && !scope.has(_id.toHexString())) throw notFound('Business entity');
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id }).lean();
    if (!entity) throw notFound('Business entity');
    return entity;
  }

  /** A warehouse in an entity the caller works in; anything else is "not found". */
  private async findWarehouse(ctx: TenantContext, id: Types.ObjectId | string): Promise<WarehouseDoc> {
    const warehouse = await this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: typeof id === 'string' ? new Types.ObjectId(id) : id }).lean();
    const scope = visibleEntities(ctx);
    if (!warehouse || (scope !== 'all' && !scope.has(warehouse.legalEntityId.toHexString()))) throw notFound('Warehouse');
    return warehouse;
  }

  private requireIn(ctx: TenantContext, permissions: Permission | Permission[], warehouse: WarehouseDoc) {
    const list = Array.isArray(permissions) ? permissions : [permissions];
    if (!list.some((p) => canInWarehouse(ctx, p, warehouse))) throw forbidden();
  }

  /** Warehouses (of one entity, or all) where the caller holds the permission. */
  private async warehousesWith(ctx: TenantContext, permission: Permission, legalEntityId?: Types.ObjectId): Promise<WarehouseDoc[]> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (legalEntityId) filter.legalEntityId = legalEntityId;
    const all = await this.deps.models.Warehouse.find(filter).lean();
    return all.filter((w) => canInWarehouse(ctx, permission, w));
  }

  private showCost(ctx: TenantContext) {
    return ctx.permissions.has('price.view_cost');
  }

  /** Business date rules for anything that moves stock: not in the future, not in a locked period (FR-CO-05). */
  private checkDocDate(entity: LegalEntityDoc, docDate: string) {
    if (docDate > todayIST(this.now())) throw invalid('docDate', 'The date can’t be in the future');
    if (entity.periodLockDate && docDate <= entity.periodLockDate) {
      throw new AppError('PERIOD_LOCKED', `The period up to ${entity.periodLockDate} is locked for this business entity`, [{ path: 'docDate', message: 'Locked period' }]);
    }
  }

  private async nextNumber(ctx: TenantContext, key: 'stock_adjustment' | 'stock_opening' | 'stock_transfer' | 'stock_count'): Promise<string> {
    const prefix = { stock_adjustment: 'ADJ', stock_opening: 'OPN', stock_transfer: 'TRF', stock_count: 'CNT' }[key];
    const bump = () => this.deps.models.Counter.findOneAndUpdate({ tenantId: ctx.tenantId, key }, { $inc: { next: 1 } }, { upsert: true, returnDocument: 'after' }).lean();
    // Two first-ever numbers can race on the upsert; the loser retries once.
    const counter = await bump().catch((err: unknown) => {
      if (isDuplicateKey(err)) return bump();
      throw err;
    });
    if (!counter) throw new Error('Counter not created');
    return `${prefix}-${String(counter.next).padStart(6, '0')}`;
  }

  /** Active stock items with their base units; quantities must fit the unit's decimals. */
  private async stockItems(ctx: TenantContext, lines: Array<{ itemId: string; qty?: string | null | undefined }>, path = 'lines'): Promise<Map<string, ItemInfo>> {
    const ids = lines.map((l) => new Types.ObjectId(l.itemId));
    const items = await this.deps.models.Item.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids }) }).lean();
    const units = await this.deps.models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: items.map((i) => i.baseUnitId) }) }).lean();
    const unitById = new Map(units.map((u) => [u._id.toHexString(), u]));
    const byId = new Map<string, ItemInfo>();
    for (const i of items) {
      const unit = unitById.get(i.baseUnitId.toHexString());
      if (unit) byId.set(i._id.toHexString(), { item: i, unit });
    }
    lines.forEach((l, index) => {
      const info = byId.get(l.itemId);
      if (!info || info.item.archivedAt) throw invalid(`${path}.${index}.itemId`, 'Choose an item');
      if (info.item.type !== 'stock') throw invalid(`${path}.${index}.itemId`, `${info.item.sku} is not a stock item`);
      if (l.qty && !fitsDecimals(l.qty, info.unit.decimals)) throw invalid(`${path}.${index}.qty`, `${info.unit.code} allows ${info.unit.decimals} decimal places`);
    });
    return byId;
  }

  /** Item and unit details for display (archived items included). */
  private async itemInfo(ctx: TenantContext, ids: Types.ObjectId[]): Promise<Map<string, ItemInfo>> {
    const items = await this.deps.models.Item.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids }) }).lean();
    const units = await this.deps.models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: [...new Set(items.map((i) => i.baseUnitId.toHexString()))].map((id) => new Types.ObjectId(id)) }) }).lean();
    const unitById = new Map(units.map((u) => [u._id.toHexString(), u]));
    const out = new Map<string, ItemInfo>();
    for (const item of items) {
      const unit = unitById.get(item.baseUnitId.toHexString());
      if (unit) out.set(item._id.toHexString(), { item, unit });
    }
    return out;
  }

  private async actorNames(ids: Array<Types.ObjectId | null>) {
    const unique = [...new Set(ids.flatMap((id) => (id ? [id.toHexString()] : [])))].map((id) => new Types.ObjectId(id));
    const users = unique.length ? await this.deps.models.User.find({ _id: trusted({ $in: unique }) }, { name: 1 }).lean() : [];
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return (id: Types.ObjectId | null) => (id ? { id: id.toHexString(), name: names.get(id.toHexString()) ?? 'Former member' } : null);
  }

  private qty(info: ItemInfo | undefined, value: Types.Decimal128 | string): string {
    const s = typeof value === 'string' ? value : value.toString();
    try {
      return info ? formatQty(s, info.unit.decimals) : s;
    } catch {
      return s;
    }
  }

  // ---------------------------------------------------------- warehouses

  private toWarehouse(w: WarehouseDoc): Warehouse {
    return {
      id: w._id.toHexString(),
      legalEntityId: w.legalEntityId.toHexString(),
      code: w.code,
      name: w.name,
      address: w.address,
      gstRegistrationId: w.gstRegistrationId?.toHexString() ?? null,
      archived: w.archivedAt !== null,
      version: w.version,
    };
  }

  async listWarehouses(ctx: TenantContext, query: { legalEntityId?: string | undefined }): Promise<Warehouse[]> {
    const scope = visibleEntities(ctx);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (query.legalEntityId) filter.legalEntityId = (await this.findEntity(ctx, query.legalEntityId))._id;
    else if (scope !== 'all') filter.legalEntityId = trusted({ $in: [...scope].map((id) => new Types.ObjectId(id)) });
    const rows = await this.deps.models.Warehouse.find(filter).sort({ legalEntityId: 1, nameKey: 1 }).limit(500).lean();
    return rows.map((w) => this.toWarehouse(w));
  }

  private async checkRegistration(ctx: TenantContext, entityId: Types.ObjectId, registrationId: string | null) {
    if (!registrationId) return null;
    const reg = await this.deps.models.GstRegistration.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(registrationId), legalEntityId: entityId }, { _id: 1 }).lean();
    if (!reg) throw invalid('gstRegistrationId', 'Choose a GST registration of this business entity');
    return reg._id;
  }

  async createWarehouse(ctx: TenantContext, input: { legalEntityId: string; code: string; name: string; address: AddressDoc | null; gstRegistrationId: string | null }, meta: RequestMeta): Promise<Warehouse> {
    const entity = await this.findEntity(ctx, input.legalEntityId);
    if (!canInEntity(ctx, 'settings.company', entity._id)) throw forbidden();
    const doc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      code: input.code,
      name: input.name,
      nameKey: nameKey(input.name),
      address: input.address,
      gstRegistrationId: await this.checkRegistration(ctx, entity._id, input.gstRegistrationId),
      archivedAt: null,
      version: 0,
    };
    try {
      await this.deps.models.Warehouse.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('code', 'Another warehouse already uses this code');
      throw err;
    }
    await this.record(ctx, meta, { action: 'warehouse.created', entityType: 'warehouse', entityId: doc._id.toHexString(), summary: `Added warehouse ${doc.code} "${doc.name}" to "${entity.legalName}"` });
    return this.toWarehouse({ ...doc, createdAt: this.now(), updatedAt: this.now() });
  }

  async updateWarehouse(
    ctx: TenantContext,
    id: string,
    input: { version: number; name?: string | undefined; address?: AddressDoc | null | undefined; gstRegistrationId?: string | null | undefined; archived?: boolean | undefined },
    meta: RequestMeta,
  ): Promise<Warehouse> {
    const warehouse = await this.findWarehouse(ctx, id);
    if (!canInEntity(ctx, 'settings.company', warehouse.legalEntityId)) throw forbidden();
    const set: Record<string, unknown> = {};
    const changes: AuditChange[] = [];
    if (input.name !== undefined && input.name !== warehouse.name) {
      set.name = input.name;
      set.nameKey = nameKey(input.name);
      changes.push({ field: 'name', from: warehouse.name, to: input.name });
    }
    if (input.address !== undefined) {
      set.address = input.address;
      changes.push({ field: 'address' });
    }
    if (input.gstRegistrationId !== undefined) {
      set.gstRegistrationId = await this.checkRegistration(ctx, warehouse.legalEntityId, input.gstRegistrationId);
      changes.push({ field: 'gstRegistrationId', from: warehouse.gstRegistrationId?.toHexString() ?? null, to: input.gstRegistrationId });
    }
    if (input.archived !== undefined && input.archived !== (warehouse.archivedAt !== null)) {
      if (input.archived) await this.assertWarehouseEmpty(ctx, warehouse);
      set.archivedAt = input.archived ? this.now() : null;
      changes.push({ field: 'archived', from: !input.archived, to: input.archived });
    }
    const updated = await this.deps.models.Warehouse.findOneAndUpdate({ tenantId: ctx.tenantId, _id: warehouse._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('warehouse');
    if (changes.length) await this.record(ctx, meta, { action: 'warehouse.updated', entityType: 'warehouse', entityId: id, summary: `Updated warehouse ${warehouse.code}`, changes });
    return this.toWarehouse(updated);
  }

  private async assertWarehouseEmpty(ctx: TenantContext, warehouse: WarehouseDoc) {
    const { StockBalance, StockTransfer, StockAdjustment, StockCount } = this.deps.models;
    const zero = toDecimal('0');
    const [stock, transfers, adjustments, counts] = await Promise.all([
      StockBalance.countDocuments({ tenantId: ctx.tenantId, warehouseId: warehouse._id, $or: [{ onHand: trusted({ $ne: zero }) }, { inTransit: trusted({ $ne: zero }) }] }),
      StockTransfer.countDocuments({ tenantId: ctx.tenantId, status: trusted({ $in: ['draft', 'dispatched'] }), $or: [{ fromWarehouseId: warehouse._id }, { toWarehouseId: warehouse._id }] }),
      StockAdjustment.countDocuments({ tenantId: ctx.tenantId, status: 'draft', warehouseId: warehouse._id }),
      StockCount.countDocuments({ tenantId: ctx.tenantId, status: trusted({ $in: ['draft', 'counting', 'submitted'] }), warehouseId: warehouse._id }),
    ]);
    if (stock > 0) throw new AppError('BUSINESS_RULE', 'This warehouse still holds stock. Move or adjust it to zero first.');
    if (transfers + adjustments + counts > 0) throw new AppError('BUSINESS_RULE', 'Finish or cancel the open transfers, adjustments and counts of this warehouse first');
  }

  // --------------------------------------------------------- adjustments

  private async toAdjustment(ctx: TenantContext, a: StockAdjustmentDoc): Promise<StockAdjustment> {
    const [warehouse, info, actor] = await Promise.all([
      this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: a.warehouseId }, { name: 1, code: 1 }).lean(),
      this.itemInfo(ctx, a.lines.map((l) => l.itemId)),
      this.actorNames([a.createdBy, a.postedBy]),
    ]);
    const cost = this.showCost(ctx);
    const total = a.status === 'posted' ? money(a.lines.reduce((acc, l) => acc.plus(dec(fromDecimal(l.value) ?? '0')), dec('0'))) : null;
    return {
      id: a._id.toHexString(),
      number: a.number,
      type: a.type,
      status: a.status,
      legalEntityId: a.legalEntityId.toHexString(),
      warehouseId: a.warehouseId.toHexString(),
      warehouseName: warehouse ? `${warehouse.code} · ${warehouse.name}` : '?',
      reason: a.reason,
      note: a.note,
      docDate: a.docDate,
      lines: a.lines.map((l) => {
        const i = info.get(l.itemId.toHexString());
        return {
          lineId: l.lineId,
          itemId: l.itemId.toHexString(),
          sku: i?.item.sku ?? '?',
          itemName: i?.item.name ?? 'Unknown item',
          unitCode: i?.unit.code ?? '',
          qty: this.qty(i, l.qty),
          ...(cost ? { unitCost: fromDecimal(l.unitCost), value: fromDecimal(l.value) } : {}),
        };
      }),
      ...(cost ? { totalValue: total } : {}),
      createdBy: actor(a.createdBy),
      createdAt: a.createdAt.toISOString(),
      postedBy: actor(a.postedBy),
      postedAt: a.postedAt?.toISOString() ?? null,
      version: a.version,
    };
  }

  private adjustmentLines(lines: AdjustmentInput['lines']): StockDocLine[] {
    return lines.map((l) => ({ lineId: lineId(), itemId: new Types.ObjectId(l.itemId), qty: toDecimal(l.qty), unitCost: l.unitCost === null ? null : toDecimal(l.unitCost), value: null }));
  }

  async createAdjustment(ctx: TenantContext, input: AdjustmentInput, meta: RequestMeta): Promise<StockAdjustment> {
    const warehouse = await this.findWarehouse(ctx, input.warehouseId);
    this.requireIn(ctx, 'stock.adjust', warehouse);
    if (warehouse.archivedAt) throw invalid('warehouseId', 'This warehouse is archived');
    const entity = await this.findEntity(ctx, warehouse.legalEntityId);
    this.checkDocDate(entity, input.docDate);
    await this.stockItems(ctx, input.lines);
    const now = this.now();
    const doc: StockAdjustmentDoc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      warehouseId: warehouse._id,
      number: await this.nextNumber(ctx, input.type === 'opening' ? 'stock_opening' : 'stock_adjustment'),
      type: input.type,
      status: 'draft',
      reason: input.type === 'opening' ? null : input.reason,
      note: input.note,
      docDate: input.docDate,
      lines: this.adjustmentLines(input.lines),
      createdBy: ctx.userId,
      postedBy: null,
      postedAt: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.models.StockAdjustment.create([doc]);
    await this.record(ctx, meta, { action: 'stock_adjustment.created', entityType: 'stock_adjustment', entityId: doc._id.toHexString(), summary: `Drafted ${input.type === 'opening' ? 'opening stock' : 'stock adjustment'} ${doc.number} for ${warehouse.code}` });
    return this.toAdjustment(ctx, doc);
  }

  private async findAdjustment(ctx: TenantContext, id: string) {
    const doc = await this.deps.models.StockAdjustment.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!doc) throw notFound('Stock adjustment');
    const warehouse = await this.findWarehouse(ctx, doc.warehouseId).catch(() => {
      throw notFound('Stock adjustment');
    });
    if (!STOCK_PERMISSIONS.some((p) => canInWarehouse(ctx, p, warehouse))) throw notFound('Stock adjustment');
    return { doc, warehouse };
  }

  async getAdjustment(ctx: TenantContext, id: string): Promise<StockAdjustment> {
    return this.toAdjustment(ctx, (await this.findAdjustment(ctx, id)).doc);
  }

  async updateAdjustment(ctx: TenantContext, id: string, input: Optional<Omit<AdjustmentInput, 'warehouseId' | 'type'>> & { version: number }, meta: RequestMeta): Promise<StockAdjustment> {
    const { doc, warehouse } = await this.findAdjustment(ctx, id);
    this.requireIn(ctx, 'stock.adjust', warehouse);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be edited');
    const current: AdjustmentInput = {
      warehouseId: doc.warehouseId.toHexString(),
      type: doc.type,
      reason: doc.reason,
      note: doc.note,
      docDate: doc.docDate,
      lines: doc.lines.map((l) => ({ itemId: l.itemId.toHexString(), qty: l.qty.toString(), unitCost: fromDecimal(l.unitCost) })),
    };
    const { version, ...fields } = input;
    // The merged draft must pass the same rules as a new one (e.g. opening stock needs costs).
    const next = stockAdjustmentInputSchema.parse({ ...current, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    this.checkDocDate(entity, next.docDate);
    await this.stockItems(ctx, next.lines);
    const set = { reason: next.type === 'opening' ? null : next.reason, note: next.note, docDate: next.docDate, lines: this.adjustmentLines(next.lines) };
    const updated = await this.deps.models.StockAdjustment.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('stock adjustment');
    const changes: AuditChange[] = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined).map((field) => ({ field }));
    await this.record(ctx, meta, { action: 'stock_adjustment.updated', entityType: 'stock_adjustment', entityId: id, summary: `Edited draft ${doc.number}`, changes });
    return this.toAdjustment(ctx, updated);
  }

  async postAdjustment(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockAdjustment> {
    const { doc, warehouse } = await this.findAdjustment(ctx, id);
    this.requireIn(ctx, 'stock.adjust', warehouse);
    if (doc.status !== 'draft') throw invalidState(doc.status === 'posted' ? 'This document has already been posted' : 'This document was cancelled');
    if (doc.version !== version) throw versionConflict('stock adjustment');
    if (warehouse.archivedAt) throw new AppError('BUSINESS_RULE', 'This warehouse is archived');
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    this.checkDocDate(entity, doc.docDate);
    const info = await this.stockItems(ctx, doc.lines.map((l) => ({ itemId: l.itemId.toHexString(), qty: l.qty.toString() })));
    await this.ledger.ensureRows(ctx.tenantId, entity._id, doc.lines.map((l) => ({ warehouseId: warehouse._id, itemId: l.itemId })));
    await this.deps.journals.ensureAccounts(ctx.tenantId, entity._id);

    const posted = await withTransaction(this.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.deps.models });
      const { StockAdjustment, StockMovement } = this.deps.models;
      if (doc.type === 'opening') {
        // Opening stock is entered once per item and warehouse (FR-INV-02); later changes are adjustments.
        const moved = await StockMovement.find({ tenantId: ctx.tenantId, warehouseId: warehouse._id, itemId: trusted({ $in: doc.lines.map((l) => l.itemId) }) }, { itemId: 1 }, { session }).limit(1).lean();
        const first = moved[0];
        if (first) {
          const sku = info.get(first.itemId.toHexString())?.item.sku ?? 'An item';
          throw new AppError('BUSINESS_RULE', `${sku} already has stock movements in ${warehouse.code}. Opening stock can only be entered before any other movement; use an adjustment instead.`);
        }
      }
      const lines: PostLine[] = doc.lines.map((l) => {
        const qty = l.qty.toString();
        const out = qty.startsWith('-');
        return {
          warehouseId: warehouse._id,
          itemId: l.itemId,
          label: info.get(l.itemId.toHexString())?.item.sku ?? 'item',
          qty: out ? qty.slice(1) : qty,
          kind: doc.type === 'opening' ? 'opening' : 'adjust',
          sourceLineId: l.lineId,
          effect: out ? { type: 'issue' } : { type: 'receive', unitCost: fromDecimal(l.unitCost) },
        };
      });
      const results = await this.ledger.post(this.postContext(ctx, session, entity, doc.docDate, 'stock_adjustment', doc._id, doc.number), lines);
      await this.postJournal(ctx, session, entity, doc.docDate, { type: 'stock_adjustment', id: doc._id, number: doc.number, narration: `${doc.type === 'opening' ? 'Opening stock' : 'Stock adjustment'} ${doc.number} in ${warehouse.code}` }, results);
      const byLine = new Map(results.map((r) => [r.sourceLineId, r]));
      const updated = await StockAdjustment.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' },
        {
          $set: {
            status: 'posted',
            postedBy: ctx.userId,
            postedAt: this.now(),
            lines: doc.lines.map((l) => {
              const r = byLine.get(l.lineId);
              const signed = r && l.qty.toString().startsWith('-') && !dec(r.value).isZero() ? `-${r.value}` : (r?.value ?? '0');
              return { ...l, unitCost: r ? toDecimal(r.unitCost) : null, value: toDecimal(signed) };
            }),
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('stock adjustment');
      await this.record(
        ctx,
        meta,
        {
          action: 'stock_adjustment.posted',
          entityType: 'stock_adjustment',
          entityId: id,
          summary: `Posted ${doc.type === 'opening' ? 'opening stock' : 'stock adjustment'} ${doc.number} (${doc.lines.length} item${doc.lines.length === 1 ? '' : 's'}) in ${warehouse.code}`,
          changes: [{ field: 'status', from: 'draft', to: 'posted' }, ...(doc.reason ? [{ field: 'reason', to: doc.reason }] : [])],
        },
        session,
      );
      return updated;
    });
    return this.toAdjustment(ctx, posted);
  }

  async cancelAdjustment(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockAdjustment> {
    const { doc, warehouse } = await this.findAdjustment(ctx, id);
    this.requireIn(ctx, 'stock.adjust', warehouse);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be cancelled. Correct a posted document with a new adjustment.');
    const updated = await this.deps.models.StockAdjustment.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: { status: 'cancelled' }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('stock adjustment');
    await this.record(ctx, meta, { action: 'stock_adjustment.cancelled', entityType: 'stock_adjustment', entityId: id, summary: `Cancelled draft ${doc.number}` });
    return this.toAdjustment(ctx, updated);
  }

  private postContext(ctx: TenantContext, session: ClientSession, entity: LegalEntityDoc, docDate: string, sourceType: StockSourceType, sourceId: Types.ObjectId, sourceNumber: string) {
    return {
      session,
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      allowNegative: entity.workflow.allowNegativeStock,
      docDate,
      sourceType,
      sourceId,
      sourceNumber,
      actorId: ctx.userId,
      now: this.now(),
    };
  }

  // ----------------------------------------------------------- transfers

  private async toTransfer(ctx: TenantContext, t: StockTransferDoc): Promise<StockTransfer> {
    const [warehouses, info, actor, artifact] = await Promise.all([
      this.deps.models.Warehouse.find({ tenantId: ctx.tenantId, _id: trusted({ $in: [t.fromWarehouseId, t.toWarehouseId] }) }, { name: 1, code: 1 }).lean(),
      this.itemInfo(ctx, t.lines.map((l) => l.itemId)),
      this.actorNames([t.createdBy, t.dispatchedBy, t.receivedBy]),
      this.deps.models.DocumentArtifact.findOne({ tenantId: ctx.tenantId, docType: 'stock_transfer', docId: t._id, templateVersion: STOCK_TRANSFER_TEMPLATE }).lean(),
    ]);
    const file = artifact?.fileId ? await this.deps.models.File.findOne({ tenantId: ctx.tenantId, _id: artifact.fileId }, { size: 1 }).lean() : null;
    const name = (id: Types.ObjectId) => {
      const w = warehouses.find((x) => x._id.equals(id));
      return w ? `${w.code} · ${w.name}` : '?';
    };
    const cost = this.showCost(ctx);
    return {
      id: t._id.toHexString(),
      number: t.number,
      status: t.status,
      legalEntityId: t.legalEntityId.toHexString(),
      fromWarehouseId: t.fromWarehouseId.toHexString(),
      fromWarehouseName: name(t.fromWarehouseId),
      toWarehouseId: t.toWarehouseId.toHexString(),
      toWarehouseName: name(t.toWarehouseId),
      docDate: t.docDate,
      note: t.note,
      lines: t.lines.map((l) => {
        const i = info.get(l.itemId.toHexString());
        return {
          lineId: l.lineId,
          itemId: l.itemId.toHexString(),
          sku: i?.item.sku ?? '?',
          itemName: i?.item.name ?? 'Unknown item',
          unitCode: i?.unit.code ?? '',
          qty: this.qty(i, l.qty),
          ...(cost ? { unitCost: fromDecimal(l.unitCost), value: fromDecimal(l.value) } : {}),
        };
      }),
      createdBy: actor(t.createdBy),
      createdAt: t.createdAt.toISOString(),
      dispatchedBy: actor(t.dispatchedBy),
      dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
      receivedBy: actor(t.receivedBy),
      receivedAt: t.receivedAt?.toISOString() ?? null,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      pdf: artifact ? { status: artifact.status, templateVersion: artifact.templateVersion, sizeBytes: file?.size ?? null, createdAt: artifact.createdAt.toISOString() } : null,
      version: t.version,
    };
  }

  /** The stored transfer note. Served as rendered, never regenerated (AC-DOC-1). */
  async transferPdf(ctx: TenantContext, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const { doc } = await this.findTransfer(ctx, id);
    const artifact = await this.deps.models.DocumentArtifact.findOne({ tenantId: ctx.tenantId, docType: 'stock_transfer', docId: doc._id, templateVersion: STOCK_TRANSFER_TEMPLATE }).lean();
    if (!artifact || artifact.status === 'pending') throw invalidState(doc.status === 'draft' ? 'A transfer note is made when the transfer is dispatched' : 'The transfer note is being prepared. Try again in a moment.');
    if (artifact.status === 'failed' || !artifact.fileId) throw new AppError('BUSINESS_RULE', 'The transfer note could not be made. The team has been alerted.');
    const file = await this.deps.models.File.findOne({ tenantId: ctx.tenantId, _id: artifact.fileId }).lean();
    if (!file) throw notFound('Transfer note');
    return { bytes: await this.deps.storage.get(file.storageKey), filename: `${doc.number}.pdf` };
  }

  /**
   * Transfers stay inside one legal entity: moving goods to another PAN is a
   * supply that needs a tax document (Phase 7), not a stock transfer.
   */
  private async transferWarehouses(ctx: TenantContext, fromId: string, toId: string) {
    const from = await this.findWarehouse(ctx, fromId);
    const to = await this.findWarehouse(ctx, toId).catch(() => {
      throw invalid('toWarehouseId', 'Choose a warehouse');
    });
    if (from._id.equals(to._id)) throw invalid('toWarehouseId', 'Choose a different warehouse');
    if (!from.legalEntityId.equals(to.legalEntityId)) throw invalid('toWarehouseId', 'Both warehouses must belong to the same business entity. Moving goods to another entity needs a tax invoice or delivery challan.');
    // Each GSTIN is a distinct person under GST: goods moving between two registrations are a supply, not a stock transfer.
    if (from.gstRegistrationId && to.gstRegistrationId && !from.gstRegistrationId.equals(to.gstRegistrationId)) {
      throw invalid('toWarehouseId', 'These warehouses are under different GSTINs. Moving goods between registrations is a supply that needs a tax invoice (from Phase 7), not a stock transfer.');
    }
    if (from.archivedAt) throw invalid('fromWarehouseId', 'This warehouse is archived');
    if (to.archivedAt) throw invalid('toWarehouseId', 'This warehouse is archived');
    return { from, to };
  }

  async createTransfer(ctx: TenantContext, input: TransferInput, meta: RequestMeta): Promise<StockTransfer> {
    const { from, to } = await this.transferWarehouses(ctx, input.fromWarehouseId, input.toWarehouseId);
    this.requireIn(ctx, 'stock.move', from);
    const entity = await this.findEntity(ctx, from.legalEntityId);
    this.checkDocDate(entity, input.docDate);
    await this.stockItems(ctx, input.lines);
    const now = this.now();
    const doc: StockTransferDoc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      fromWarehouseId: from._id,
      toWarehouseId: to._id,
      number: await this.nextNumber(ctx, 'stock_transfer'),
      status: 'draft',
      docDate: input.docDate,
      note: input.note,
      lines: input.lines.map((l) => ({ lineId: lineId(), itemId: new Types.ObjectId(l.itemId), qty: toDecimal(l.qty), unitCost: null, value: null })),
      createdBy: ctx.userId,
      dispatchedBy: null,
      dispatchedAt: null,
      receivedBy: null,
      receivedAt: null,
      cancelledAt: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.models.StockTransfer.create([doc]);
    await this.record(ctx, meta, { action: 'stock_transfer.created', entityType: 'stock_transfer', entityId: doc._id.toHexString(), summary: `Drafted transfer ${doc.number} from ${from.code} to ${to.code}` });
    return this.toTransfer(ctx, doc);
  }

  private async findTransfer(ctx: TenantContext, id: string) {
    const doc = await this.deps.models.StockTransfer.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!doc) throw notFound('Transfer');
    const [from, to] = await Promise.all([this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: doc.fromWarehouseId }).lean(), this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: doc.toWarehouseId }).lean()]);
    if (!from || !to) throw notFound('Transfer');
    // Visible from either end.
    if (!STOCK_PERMISSIONS.some((p) => canInWarehouse(ctx, p, from) || canInWarehouse(ctx, p, to))) throw notFound('Transfer');
    return { doc, from, to };
  }

  async getTransfer(ctx: TenantContext, id: string): Promise<StockTransfer> {
    return this.toTransfer(ctx, (await this.findTransfer(ctx, id)).doc);
  }

  async updateTransfer(ctx: TenantContext, id: string, input: Optional<Omit<TransferInput, 'fromWarehouseId'>> & { version: number }, meta: RequestMeta): Promise<StockTransfer> {
    const { doc, from } = await this.findTransfer(ctx, id);
    this.requireIn(ctx, 'stock.move', from);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be edited');
    const set: Record<string, unknown> = {};
    if (input.toWarehouseId !== undefined) set.toWarehouseId = (await this.transferWarehouses(ctx, from._id.toHexString(), input.toWarehouseId)).to._id;
    if (input.docDate !== undefined) {
      this.checkDocDate(await this.findEntity(ctx, doc.legalEntityId), input.docDate);
      set.docDate = input.docDate;
    }
    if (input.note !== undefined) set.note = input.note;
    if (input.lines !== undefined) {
      await this.stockItems(ctx, input.lines);
      set.lines = input.lines.map((l) => ({ lineId: lineId(), itemId: new Types.ObjectId(l.itemId), qty: toDecimal(l.qty), unitCost: null, value: null }));
    }
    const updated = await this.deps.models.StockTransfer.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'draft' }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('transfer');
    await this.record(ctx, meta, { action: 'stock_transfer.updated', entityType: 'stock_transfer', entityId: id, summary: `Edited draft ${doc.number}`, changes: Object.keys(set).map((field) => ({ field })) });
    return this.toTransfer(ctx, updated);
  }

  /** Stock leaves the source and is in transit to the destination (FR-INV-06). */
  async dispatchTransfer(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockTransfer> {
    const { doc, from, to } = await this.findTransfer(ctx, id);
    this.requireIn(ctx, 'stock.move', from);
    if (doc.status !== 'draft') throw invalidState('Only a draft transfer can be dispatched');
    if (doc.version !== version) throw versionConflict('transfer');
    if (from.archivedAt || to.archivedAt) throw new AppError('BUSINESS_RULE', 'One of the warehouses is archived');
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    this.checkDocDate(entity, doc.docDate);
    const info = await this.stockItems(ctx, doc.lines.map((l) => ({ itemId: l.itemId.toHexString(), qty: l.qty.toString() })));
    await this.ledger.ensureRows(ctx.tenantId, entity._id, doc.lines.flatMap((l) => [{ warehouseId: from._id, itemId: l.itemId }, { warehouseId: to._id, itemId: l.itemId }]));
    const updated = await withTransaction(this.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.deps.models });
      const c = this.postContext(ctx, session, entity, doc.docDate, 'stock_transfer', doc._id, doc.number);
      const results = await this.ledger.post(
        c,
        doc.lines.map((l) => ({ warehouseId: from._id, itemId: l.itemId, label: info.get(l.itemId.toHexString())?.item.sku ?? 'item', qty: l.qty.toString(), kind: 'transfer_out', sourceLineId: l.lineId, effect: { type: 'transfer_out' } })),
      );
      for (const l of doc.lines) await this.ledger.addInTransit(c, to._id, l.itemId, l.qty.toString());
      const byLine = new Map(results.map((r) => [r.sourceLineId, r]));
      const saved = await this.deps.models.StockTransfer.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' },
        {
          $set: {
            status: 'dispatched',
            dispatchedBy: ctx.userId,
            dispatchedAt: this.now(),
            lines: doc.lines.map((l) => ({ ...l, unitCost: toDecimal(byLine.get(l.lineId)?.unitCost ?? '0'), value: toDecimal(byLine.get(l.lineId)?.value ?? '0') })),
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean();
      if (!saved) throw versionConflict('transfer');
      // The transfer note is rendered by the worker after commit (no PDF work inside the transaction).
      if (this.deps.storage.enabled) {
        await enqueue(this.deps.models, session, { tenantId: ctx.tenantId, type: 'document.render', aggregateId: doc._id, payload: { docType: 'stock_transfer', docId: doc._id.toHexString(), templateVersion: STOCK_TRANSFER_TEMPLATE }, now: this.now() });
      }
      await this.record(ctx, meta, { action: 'stock_transfer.dispatched', entityType: 'stock_transfer', entityId: id, summary: `Dispatched transfer ${doc.number} from ${from.code} to ${to.code}`, changes: [{ field: 'status', from: 'draft', to: 'dispatched' }] }, session);
      return saved;
    });
    return this.toTransfer(ctx, updated);
  }

  /** Stock arrives at the destination at the value it left with; the entity valuation is unchanged. */
  async receiveTransfer(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockTransfer> {
    const { doc, from, to } = await this.findTransfer(ctx, id);
    this.requireIn(ctx, 'stock.move', to);
    if (doc.status !== 'dispatched') throw invalidState('Only a dispatched transfer can be received');
    if (doc.version !== version) throw versionConflict('transfer');
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    const info = await this.itemInfo(ctx, doc.lines.map((l) => l.itemId));
    const updated = await withTransaction(this.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.deps.models });
      const c = this.postContext(ctx, session, entity, doc.docDate, 'stock_transfer', doc._id, doc.number);
      await this.ledger.post(
        c,
        doc.lines.map((l) => ({
          warehouseId: to._id,
          itemId: l.itemId,
          label: info.get(l.itemId.toHexString())?.item.sku ?? 'item',
          qty: l.qty.toString(),
          kind: 'transfer_in',
          sourceLineId: l.lineId,
          effect: { type: 'transfer_in', unitCost: fromDecimal(l.unitCost) ?? '0', value: fromDecimal(l.value) ?? '0' },
        })),
      );
      for (const l of doc.lines) await this.ledger.addInTransit(c, to._id, l.itemId, `-${l.qty.toString()}`);
      const saved = await this.deps.models.StockTransfer.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'dispatched' },
        { $set: { status: 'received', receivedBy: ctx.userId, receivedAt: this.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!saved) throw versionConflict('transfer');
      await this.record(ctx, meta, { action: 'stock_transfer.received', entityType: 'stock_transfer', entityId: id, summary: `Received transfer ${doc.number} at ${to.code} (from ${from.code})`, changes: [{ field: 'status', from: 'dispatched', to: 'received' }] }, session);
      return saved;
    });
    return this.toTransfer(ctx, updated);
  }

  /** Cancels a draft, or reverses a dispatched transfer: stock returns to the source at the value it left with. */
  async cancelTransfer(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockTransfer> {
    const { doc, from, to } = await this.findTransfer(ctx, id);
    this.requireIn(ctx, 'stock.move', from);
    if (doc.status !== 'draft' && doc.status !== 'dispatched') throw invalidState(doc.status === 'received' ? 'A received transfer can’t be cancelled. Transfer the goods back instead.' : 'This transfer is already cancelled');
    if (doc.version !== version) throw versionConflict('transfer');
    const audit = { action: 'stock_transfer.cancelled' as AuditAction, entityType: 'stock_transfer', entityId: id, changes: [{ field: 'status', from: doc.status, to: 'cancelled' }] };
    if (doc.status === 'draft') {
      const saved = await this.deps.models.StockTransfer.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: { status: 'cancelled', cancelledAt: this.now() }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
      if (!saved) throw versionConflict('transfer');
      await this.record(ctx, meta, { ...audit, summary: `Cancelled draft transfer ${doc.number}` });
      return this.toTransfer(ctx, saved);
    }
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    const info = await this.itemInfo(ctx, doc.lines.map((l) => l.itemId));
    const updated = await withTransaction(this.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.deps.models });
      const outs = await this.deps.models.StockMovement.find({ tenantId: ctx.tenantId, sourceType: 'stock_transfer', sourceId: doc._id, kind: 'transfer_out', reversalOf: null }, { sourceLineId: 1 }, { session }).lean();
      const outByLine = new Map(outs.map((m) => [m.sourceLineId, m._id]));
      const c = this.postContext(ctx, session, entity, doc.docDate, 'stock_transfer', doc._id, doc.number);
      await this.ledger.post(
        c,
        doc.lines.map((l) => {
          const original = outByLine.get(l.lineId);
          if (!original) throw new Error(`Transfer ${doc.number} line ${l.lineId} has no outgoing movement`);
          return {
            warehouseId: from._id,
            itemId: l.itemId,
            label: info.get(l.itemId.toHexString())?.item.sku ?? 'item',
            qty: l.qty.toString(),
            kind: 'transfer_out',
            sourceLineId: l.lineId,
            effect: { type: 'transfer_return', unitCost: fromDecimal(l.unitCost) ?? '0', value: fromDecimal(l.value) ?? '0', reversalOf: original },
          };
        }),
      );
      for (const l of doc.lines) await this.ledger.addInTransit(c, to._id, l.itemId, `-${l.qty.toString()}`);
      const saved = await this.deps.models.StockTransfer.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'dispatched' },
        { $set: { status: 'cancelled', cancelledAt: this.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!saved) throw versionConflict('transfer');
      await this.record(ctx, meta, { ...audit, summary: `Cancelled dispatched transfer ${doc.number}; stock returned to ${from.code}` }, session);
      return saved;
    });
    return this.toTransfer(ctx, updated);
  }

  // -------------------------------------------------------------- counts

  private async toCount(ctx: TenantContext, c: StockCountDoc): Promise<StockCount> {
    const [warehouse, info, actor] = await Promise.all([
      this.deps.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: c.warehouseId }, { name: 1, code: 1 }).lean(),
      this.itemInfo(ctx, c.lines.map((l) => l.itemId)),
      this.actorNames([c.createdBy, c.postedBy]),
    ]);
    const cost = this.showCost(ctx);
    const lines = c.lines
      .map((l) => {
        const i = info.get(l.itemId.toHexString());
        const expected = l.expectedQty?.toString() ?? null;
        const counted = l.countedQty?.toString() ?? null;
        return {
          lineId: l.lineId,
          itemId: l.itemId.toHexString(),
          sku: i?.item.sku ?? '?',
          itemName: i?.item.name ?? 'Unknown item',
          unitCode: i?.unit.code ?? '',
          expectedQty: expected === null ? null : this.qty(i, expected),
          countedQty: counted === null ? null : this.qty(i, counted),
          variance: expected !== null && counted !== null ? this.qty(i, dec(counted).minus(dec(expected)).toString()) : null,
          ...(cost ? { unitCost: fromDecimal(l.unitCost) } : {}),
          sortKey: i?.item.nameKey ?? '',
        };
      })
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map(({ sortKey: _sortKey, ...rest }) => rest);
    return {
      id: c._id.toHexString(),
      number: c.number,
      status: c.status,
      legalEntityId: c.legalEntityId.toHexString(),
      warehouseId: c.warehouseId.toHexString(),
      warehouseName: warehouse ? `${warehouse.code} · ${warehouse.name}` : '?',
      note: c.note,
      scope: c.scope,
      snapshotAt: c.snapshotAt?.toISOString() ?? null,
      lines,
      countedLines: c.lines.filter((l) => l.countedQty !== null).length,
      createdBy: actor(c.createdBy),
      createdAt: c.createdAt.toISOString(),
      postedBy: actor(c.postedBy),
      postedAt: c.postedAt?.toISOString() ?? null,
      version: c.version,
    };
  }

  private static readonly COUNTERS: Permission[] = ['stock.move', 'stock.count.post'];

  async createCount(ctx: TenantContext, input: { warehouseId: string; note: string; scope: 'all' | 'items'; itemIds: string[] }, meta: RequestMeta): Promise<StockCount> {
    const warehouse = await this.findWarehouse(ctx, input.warehouseId);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (warehouse.archivedAt) throw invalid('warehouseId', 'This warehouse is archived');
    let itemIds: Types.ObjectId[];
    if (input.scope === 'all') {
      const items = await this.deps.models.Item.find({ tenantId: ctx.tenantId, type: 'stock', archivedAt: null }, { _id: 1 }).limit(2001).lean();
      if (items.length > 2000) throw new AppError('BUSINESS_RULE', 'More than 2,000 stock items: count them in parts by choosing items');
      if (items.length === 0) throw new AppError('BUSINESS_RULE', 'There are no stock items to count');
      itemIds = items.map((i) => i._id);
    } else {
      await this.stockItems(ctx, input.itemIds.map((itemId) => ({ itemId })), 'itemIds');
      itemIds = input.itemIds.map((id) => new Types.ObjectId(id));
    }
    const now = this.now();
    const doc: StockCountDoc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: warehouse.legalEntityId,
      warehouseId: warehouse._id,
      number: await this.nextNumber(ctx, 'stock_count'),
      status: 'draft',
      note: input.note,
      scope: input.scope,
      snapshotAt: null,
      lines: itemIds.map((itemId) => ({ lineId: lineId(), itemId, expectedQty: null, countedQty: null, unitCost: null })),
      createdBy: ctx.userId,
      postedBy: null,
      postedAt: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.models.StockCount.create([doc]);
    await this.record(ctx, meta, { action: 'stock_count.created', entityType: 'stock_count', entityId: doc._id.toHexString(), summary: `Planned stock count ${doc.number} of ${itemIds.length} item${itemIds.length === 1 ? '' : 's'} in ${warehouse.code}` });
    return this.toCount(ctx, doc);
  }

  private async findCount(ctx: TenantContext, id: string) {
    const doc = await this.deps.models.StockCount.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!doc) throw notFound('Stock count');
    const warehouse = await this.findWarehouse(ctx, doc.warehouseId).catch(() => {
      throw notFound('Stock count');
    });
    if (!STOCK_PERMISSIONS.some((p) => canInWarehouse(ctx, p, warehouse))) throw notFound('Stock count');
    return { doc, warehouse };
  }

  async getCount(ctx: TenantContext, id: string): Promise<StockCount> {
    return this.toCount(ctx, (await this.findCount(ctx, id)).doc);
  }

  private async saveCount(ctx: TenantContext, doc: StockCountDoc, version: number, fromStatus: StockCountDoc['status'][], set: Record<string, unknown>, audit: { action: AuditAction; summary: string; changes?: AuditChange[] }, meta: RequestMeta) {
    const updated = await this.deps.models.StockCount.findOneAndUpdate(
      { tenantId: ctx.tenantId, _id: doc._id, version, status: trusted({ $in: fromStatus }) },
      { $set: set, $inc: { version: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw versionConflict('stock count');
    await this.record(ctx, meta, { ...audit, entityType: 'stock_count', entityId: doc._id.toHexString() });
    return this.toCount(ctx, updated);
  }

  /** Expected quantities = on hand now; missing balance rows are zero. */
  private async snapshot(ctx: TenantContext, doc: StockCountDoc) {
    const balances = await this.deps.models.StockBalance.find({ tenantId: ctx.tenantId, warehouseId: doc.warehouseId, itemId: trusted({ $in: doc.lines.map((l) => l.itemId) }) }, { itemId: 1, onHand: 1 }).lean();
    const onHand = new Map(balances.map((b) => [b.itemId.toHexString(), b.onHand]));
    return doc.lines.map((l) => ({ ...l, expectedQty: onHand.get(l.itemId.toHexString()) ?? toDecimal('0') }));
  }

  async startCount(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (doc.status !== 'draft') throw invalidState('Only a planned count can be started');
    return this.saveCount(ctx, doc, version, ['draft'], { status: 'counting', snapshotAt: this.now(), lines: await this.snapshot(ctx, doc) }, { action: 'stock_count.started', summary: `Started counting ${doc.number}` }, meta);
  }

  async updateCount(ctx: TenantContext, id: string, input: { version: number; note?: string | undefined; lines?: Array<{ itemId: string; countedQty: string | null; unitCost?: string | null | undefined }> | undefined }, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (doc.status !== 'draft' && doc.status !== 'counting') throw invalidState('This count can no longer be edited');
    const set: Record<string, unknown> = {};
    if (input.note !== undefined) set.note = input.note;
    if (input.lines?.length) {
      if (doc.status !== 'counting') throw invalidState('Start the count before entering quantities');
      if (input.lines.some((l) => l.unitCost !== undefined) && !this.showCost(ctx)) throw new AppError('FORBIDDEN', 'Entering costs needs the “See cost prices” permission', [{ path: 'lines', message: 'price.view_cost' }]);
      const byItem = new Map(input.lines.map((l) => [l.itemId, l]));
      const info = await this.itemInfo(ctx, doc.lines.map((l) => l.itemId));
      input.lines.forEach((l, index) => {
        const i = info.get(l.itemId);
        if (!doc.lines.some((x) => x.itemId.toHexString() === l.itemId) || !i) throw invalid(`lines.${index}.itemId`, 'This item is not on the count');
        if (l.countedQty !== null && !fitsDecimals(l.countedQty, i.unit.decimals)) throw invalid(`lines.${index}.countedQty`, `${i.unit.code} allows ${i.unit.decimals} decimal places`);
      });
      set.lines = doc.lines.map((l) => {
        const change = byItem.get(l.itemId.toHexString());
        if (!change) return l;
        return {
          ...l,
          countedQty: change.countedQty === null ? null : toDecimal(change.countedQty),
          unitCost: change.unitCost === undefined ? l.unitCost : change.unitCost === null ? null : toDecimal(change.unitCost),
        };
      });
    }
    return this.saveCount(ctx, doc, input.version, ['draft', 'counting'], set, { action: 'stock_count.updated', summary: `Recorded counts on ${doc.number}`, changes: input.lines ? [{ field: 'lines', to: input.lines.length }] : [{ field: 'note' }] }, meta);
  }

  async submitCount(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (doc.status !== 'counting') throw invalidState('Only a count in progress can be submitted');
    const counted = doc.lines.filter((l) => l.countedQty !== null).length;
    if (counted === 0) throw new AppError('BUSINESS_RULE', 'Enter at least one counted quantity');
    // Uncounted lines are left alone at posting: an uncounted item is never treated as zero.
    return this.saveCount(ctx, doc, version, ['counting'], { status: 'submitted' }, { action: 'stock_count.submitted', summary: `Submitted ${doc.number} (${counted} of ${doc.lines.length} counted)` }, meta);
  }

  async reopenCount(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (doc.status !== 'submitted') throw invalidState('Only a submitted count can be reopened');
    // Reopening refreshes the expected quantities; counted figures are kept.
    return this.saveCount(ctx, doc, version, ['submitted'], { status: 'counting', snapshotAt: this.now(), lines: await this.snapshot(ctx, doc) }, { action: 'stock_count.reopened', summary: `Reopened ${doc.number} and refreshed expected quantities` }, meta);
  }

  /** Variances become adjustment movements at the current average cost (workflows.md §9). */
  async postCount(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, 'stock.count.post', warehouse);
    if (doc.status !== 'submitted') throw invalidState(doc.status === 'posted' ? 'This count has already been posted' : 'Submit the count before posting it');
    if (doc.version !== version) throw versionConflict('stock count');
    const entity = await this.findEntity(ctx, doc.legalEntityId);
    const docDate = todayIST(this.now());
    this.checkDocDate(entity, docDate);
    const counted = doc.lines.filter((l) => l.countedQty !== null && l.expectedQty !== null);
    const info = await this.itemInfo(ctx, counted.map((l) => l.itemId));
    await this.ledger.ensureRows(ctx.tenantId, entity._id, counted.map((l) => ({ warehouseId: warehouse._id, itemId: l.itemId })));
    await this.deps.journals.ensureAccounts(ctx.tenantId, entity._id);
    const updated = await withTransaction(this.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate, models: this.deps.models });
      const balances = await this.deps.models.StockBalance.find({ tenantId: ctx.tenantId, warehouseId: warehouse._id, itemId: trusted({ $in: counted.map((l) => l.itemId) }) }, { itemId: 1, onHand: 1 }, { session }).lean();
      const onHand = new Map(balances.map((b) => [b.itemId.toHexString(), b.onHand.toString()]));
      // Stock that moved after the expected figures were taken would make the variance wrong.
      const stale = counted.filter((l) => !dec(onHand.get(l.itemId.toHexString()) ?? '0').eq(dec(l.expectedQty?.toString() ?? '0')));
      if (stale.length) {
        throw new AppError(
          'BUSINESS_RULE',
          'Stock of some items moved after counting started. Reopen the count to refresh the expected quantities, check those items, then post.',
          stale.map((l) => ({ path: l.itemId.toHexString(), message: info.get(l.itemId.toHexString())?.item.sku ?? 'item' })),
        );
      }
      const lines: PostLine[] = counted.flatMap((l) => {
        const variance = dec(l.countedQty?.toString() ?? '0').minus(dec(l.expectedQty?.toString() ?? '0'));
        if (variance.isZero()) return [];
        const out = variance.isNegative();
        return [
          {
            warehouseId: warehouse._id,
            itemId: l.itemId,
            label: info.get(l.itemId.toHexString())?.item.sku ?? 'item',
            qty: variance.abs().toString(),
            kind: 'adjust',
            sourceLineId: l.lineId,
            effect: out ? { type: 'issue' } : { type: 'receive', unitCost: fromDecimal(l.unitCost), preferAverage: true },
          } satisfies PostLine,
        ];
      });
      const results = await this.ledger.post(this.postContext(ctx, session, entity, docDate, 'stock_count', doc._id, doc.number), lines);
      await this.postJournal(ctx, session, entity, docDate, { type: 'stock_count', id: doc._id, number: doc.number, narration: `Stock count ${doc.number} in ${warehouse.code}` }, results);
      const saved = await this.deps.models.StockCount.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'submitted' },
        { $set: { status: 'posted', postedBy: ctx.userId, postedAt: this.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!saved) throw versionConflict('stock count');
      await this.record(ctx, meta, { action: 'stock_count.posted', entityType: 'stock_count', entityId: id, summary: `Posted stock count ${doc.number}: ${lines.length} variance${lines.length === 1 ? '' : 's'} adjusted in ${warehouse.code}`, changes: [{ field: 'status', from: 'submitted', to: 'posted' }] }, session);
      return saved;
    });
    return this.toCount(ctx, updated);
  }

  async cancelCount(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<StockCount> {
    const { doc, warehouse } = await this.findCount(ctx, id);
    this.requireIn(ctx, InventoryService.COUNTERS, warehouse);
    if (doc.status === 'posted' || doc.status === 'cancelled') throw invalidState('This count can no longer be cancelled');
    return this.saveCount(ctx, doc, version, ['draft', 'counting', 'submitted'], { status: 'cancelled' }, { action: 'stock_count.cancelled', summary: `Cancelled stock count ${doc.number}` }, meta);
  }

  // ---------------------------------------------------------------- lists

  /** Lists stock documents in warehouses the caller can see (newest first). */
  private async listDocs<T extends { _id: Types.ObjectId }>(
    ctx: TenantContext,
    find: (filter: Record<string, unknown>, limit: number) => Promise<T[]>,
    query: DocListQuery,
    warehouseFields: string[],
  ): Promise<{ rows: T[]; nextCursor: string | null }> {
    const visible = new Set<string>();
    for (const p of STOCK_PERMISSIONS) (await this.warehousesWith(ctx, p)).forEach((w) => visible.add(w._id.toHexString()));
    let ids = [...visible];
    if (query.warehouseId) ids = ids.filter((id) => id === query.warehouseId);
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, $or: warehouseFields.map((f) => ({ [f]: trusted({ $in: objectIds }) })) };
    if (query.legalEntityId) filter.legalEntityId = new Types.ObjectId(query.legalEntityId);
    if (query.status) filter.status = query.status;
    if (query.cursor) filter._id = trusted({ $lt: new Types.ObjectId(query.cursor) });
    const found = await find(filter, query.limit + 1);
    const rows = found.slice(0, query.limit);
    return { rows, nextCursor: found.length > query.limit ? (rows.at(-1)?._id.toHexString() ?? null) : null };
  }

  async listAdjustments(ctx: TenantContext, query: DocListQuery) {
    const { rows, nextCursor } = await this.listDocs(ctx, (f, n) => this.deps.models.StockAdjustment.find(f).sort({ _id: -1 }).limit(n).lean(), query, ['warehouseId']);
    return { data: await Promise.all(rows.map((r) => this.toAdjustment(ctx, r))), page: { nextCursor, limit: query.limit } };
  }

  async listTransfers(ctx: TenantContext, query: DocListQuery) {
    const { rows, nextCursor } = await this.listDocs(ctx, (f, n) => this.deps.models.StockTransfer.find(f).sort({ _id: -1 }).limit(n).lean(), query, ['fromWarehouseId', 'toWarehouseId']);
    return { data: await Promise.all(rows.map((r) => this.toTransfer(ctx, r))), page: { nextCursor, limit: query.limit } };
  }

  async listCounts(ctx: TenantContext, query: DocListQuery) {
    const { rows, nextCursor } = await this.listDocs(ctx, (f, n) => this.deps.models.StockCount.find(f).sort({ _id: -1 }).limit(n).lean(), query, ['warehouseId']);
    return { data: await Promise.all(rows.map((r) => this.toCount(ctx, r))), page: { nextCursor, limit: query.limit } };
  }

  // ------------------------------------------------------------ enquiries

  /**
   * Stock summary: one row per active stock item (alphabetical, paged), with
   * quantities summed over the chosen warehouse or every warehouse of the
   * entity the caller can view.
   */
  async stockSummary(ctx: TenantContext, query: { legalEntityId: string; warehouseId?: string | undefined; q?: string | undefined; limit: number; cursor?: string | undefined }) {
    const entity = await this.findEntity(ctx, query.legalEntityId);
    let warehouses = await this.warehousesWith(ctx, 'stock.view', entity._id);
    if (query.warehouseId) {
      const chosen = await this.findWarehouse(ctx, query.warehouseId);
      if (!chosen.legalEntityId.equals(entity._id)) throw invalid('warehouseId', 'Choose a warehouse of this business entity');
      this.requireIn(ctx, 'stock.view', chosen);
      warehouses = [chosen];
    }
    if (!warehouses.length) throw forbidden();
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, type: 'stock', archivedAt: null };
    if (query.q) {
      const q = escapeRegex(query.q.toLowerCase());
      filter.$or = [{ nameKey: trusted({ $regex: q }) }, { sku: trusted({ $regex: `^${escapeRegex(query.q.toUpperCase())}` }) }];
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      filter.$and = [{ $or: [{ nameKey: trusted({ $gt: c.sortKey }) }, { nameKey: c.sortKey, _id: trusted({ $gt: c.id }) }] }];
    }
    const items = await this.deps.models.Item.find(filter).sort({ nameKey: 1, _id: 1 }).limit(query.limit + 1).lean();
    const page = items.slice(0, query.limit);
    const itemIds = page.map((i) => i._id);
    const [balances, valuations, units] = await Promise.all([
      this.deps.models.StockBalance.find({ tenantId: ctx.tenantId, warehouseId: trusted({ $in: warehouses.map((w) => w._id) }), itemId: trusted({ $in: itemIds }) }).lean(),
      this.deps.models.ItemValuation.find({ tenantId: ctx.tenantId, legalEntityId: entity._id, itemId: trusted({ $in: itemIds }) }).lean(),
      this.deps.models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: page.map((i) => i.baseUnitId) }) }).lean(),
    ]);
    const unitById = new Map(units.map((u) => [u._id.toHexString(), u]));
    const avgByItem = new Map(valuations.map((v) => [v.itemId.toHexString(), fromDecimal(v.avgCost)]));
    const cost = this.showCost(ctx);
    const data: StockSummaryRow[] = page.map((item) => {
      const unit = unitById.get(item.baseUnitId.toHexString());
      const info = unit ? { item, unit } : undefined;
      const mine = balances.filter((b) => b.itemId.equals(item._id));
      const total = (field: 'onHand' | 'reserved' | 'inTransit') => mine.reduce((acc, b) => acc.plus(dec(b[field].toString())), dec('0')).toString();
      const onHand = total('onHand');
      const reserved = total('reserved');
      const reorder = fromDecimal(item.reorderLevel);
      const avgCost = avgByItem.get(item._id.toHexString()) ?? null;
      return {
        itemId: item._id.toHexString(),
        sku: item.sku,
        name: item.name,
        unitCode: unit?.code ?? '',
        reorderLevel: reorder === null ? null : this.qty(info, reorder),
        onHand: this.qty(info, onHand),
        reserved: this.qty(info, reserved),
        available: this.qty(info, dec(onHand).minus(dec(reserved)).toString()),
        inTransit: this.qty(info, total('inTransit')),
        belowReorder: reorder !== null && dec(onHand).lessThanOrEqualTo(dec(reorder)),
        ...(cost ? { avgCost, value: valueAt(onHand, avgCost) } : {}),
      };
    });
    const last = page.at(-1);
    return { data, page: { nextCursor: items.length > query.limit && last ? encodeCursor(last.nameKey, last._id) : null, limit: query.limit } };
  }

  /** Entity-wide valuation (FR-INV-08). Needs cost access and stock access in every warehouse of the entity. */
  async valuation(ctx: TenantContext, legalEntityId: string): Promise<StockValuation> {
    const entity = await this.findEntity(ctx, legalEntityId);
    if (!this.showCost(ctx)) throw forbidden();
    const all = await this.deps.models.Warehouse.find({ tenantId: ctx.tenantId, legalEntityId: entity._id }).lean();
    if (!all.length || !all.every((w) => canInWarehouse(ctx, 'stock.view', w))) throw forbidden();
    const rows = await this.deps.models.ItemValuation.find({ tenantId: ctx.tenantId, legalEntityId: entity._id, $or: [{ qty: trusted({ $ne: toDecimal('0') }) }, { value: trusted({ $ne: toDecimal('0') }) }] }).limit(5000).lean();
    const info = await this.itemInfo(ctx, rows.map((r) => r.itemId));
    const out = rows
      .map((r) => {
        const i = info.get(r.itemId.toHexString());
        return { itemId: r.itemId.toHexString(), sku: i?.item.sku ?? '?', name: i?.item.name ?? 'Unknown item', unitCode: i?.unit.code ?? '', qty: this.qty(i, r.qty), avgCost: fromDecimal(r.avgCost), value: money(dec(r.value.toString())), key: i?.item.nameKey ?? '' };
      })
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key: _key, ...rest }) => rest);
    return { legalEntityId: entity._id.toHexString(), asOf: this.now().toISOString(), totalValue: money(out.reduce((acc, r) => acc.plus(dec(r.value)), dec('0'))), rows: out };
  }

  /** The stock ledger, newest first, for warehouses the caller can view. */
  async movements(ctx: TenantContext, query: { legalEntityId: string; warehouseId?: string | undefined; itemId?: string | undefined; limit: number; cursor?: string | undefined }) {
    const entity = await this.findEntity(ctx, query.legalEntityId);
    let warehouses = await this.warehousesWith(ctx, 'stock.view', entity._id);
    if (query.warehouseId) warehouses = warehouses.filter((w) => w._id.toHexString() === query.warehouseId);
    if (!warehouses.length) throw query.warehouseId ? notFound('Warehouse') : forbidden();
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, legalEntityId: entity._id, warehouseId: trusted({ $in: warehouses.map((w) => w._id) }) };
    if (query.itemId) filter.itemId = new Types.ObjectId(query.itemId);
    if (query.cursor) filter._id = trusted({ $lt: new Types.ObjectId(query.cursor) });
    const found = await this.deps.models.StockMovement.find(filter).sort({ _id: -1 }).limit(query.limit + 1).lean();
    const rows = found.slice(0, query.limit);
    const info = await this.itemInfo(ctx, [...new Set(rows.map((m) => m.itemId.toHexString()))].map((id) => new Types.ObjectId(id)));
    const code = new Map(warehouses.map((w) => [w._id.toHexString(), w.code]));
    const cost = this.showCost(ctx);
    const data: StockMovement[] = rows.map((m) => {
      const i = info.get(m.itemId.toHexString());
      return {
        id: m._id.toHexString(),
        at: m.createdAt.toISOString(),
        docDate: m.docDate,
        kind: m.kind,
        warehouseId: m.warehouseId.toHexString(),
        warehouseCode: code.get(m.warehouseId.toHexString()) ?? '?',
        itemId: m.itemId.toHexString(),
        sku: i?.item.sku ?? '?',
        itemName: i?.item.name ?? 'Unknown item',
        unitCode: i?.unit.code ?? '',
        qty: this.qty(i, m.qty),
        onHandAfter: this.qty(i, m.onHandAfter),
        ...(cost ? { unitCost: m.unitCost.toString(), value: m.value.toString() } : {}),
        source: { type: m.sourceType, id: m.sourceId.toHexString(), number: m.sourceNumber },
        reversal: m.reversalOf !== null,
      };
    });
    return { data, page: { nextCursor: found.length > query.limit ? (rows.at(-1)?._id.toHexString() ?? null) : null, limit: query.limit } };
  }

  /** On-demand reconciliation for the entities the caller can see (FR-INV-09). */
  async reconciliation(ctx: TenantContext, legalEntityId?: string): Promise<ReconciliationReport> {
    let entityIds: Types.ObjectId[] | 'all';
    if (legalEntityId) entityIds = [(await this.findEntity(ctx, legalEntityId))._id];
    else {
      const scope = visibleEntities(ctx, ['stock.adjust', 'report.financial']);
      entityIds = scope === 'all' ? 'all' : [...scope].map((id) => new Types.ObjectId(id));
    }
    const raw = await reconcileStock(this.deps.models, ctx.tenantId, entityIds);
    const info = await this.itemInfo(ctx, [...new Set([...raw.issues, ...raw.negativeBalances].map((i) => i.itemId.toHexString()))].map((id) => new Types.ObjectId(id)));
    const cost = this.showCost(ctx);
    const label = (id: Types.ObjectId) => ({ sku: info.get(id.toHexString())?.item.sku ?? '?', itemName: info.get(id.toHexString())?.item.name ?? 'Unknown item' });
    return {
      checkedAt: this.now().toISOString(),
      legalEntityId: legalEntityId ?? null,
      balancesChecked: raw.balancesChecked,
      valuationsChecked: raw.valuationsChecked,
      ok: raw.issues.length === 0,
      issues: raw.issues.map((i) => ({
        kind: i.kind,
        legalEntityId: i.legalEntityId.toHexString(),
        warehouseId: i.warehouseId?.toHexString() ?? null,
        itemId: i.itemId.toHexString(),
        ...label(i.itemId),
        ...(cost || (i.kind !== 'valuation_value' && i.kind !== 'valuation_zero_qty') ? { expected: i.expected, actual: i.actual } : {}),
      })),
      negativeBalances: raw.negativeBalances.map((n) => ({ legalEntityId: n.legalEntityId.toHexString(), warehouseId: n.warehouseId.toHexString(), itemId: n.itemId.toHexString(), ...label(n.itemId), onHand: n.onHand })),
    };
  }
}
