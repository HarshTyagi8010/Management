import { trusted, Types } from 'mongoose';
import {
  DEFAULT_UNITS,
  isSac,
  type AuditChange,
  type Category,
  type Item,
  type ItemType,
  type RateSchedule,
  type TaxClass,
  type TaxTreatment,
  type Unit,
  type Uqc,
} from '@bizmgmt/contracts';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../errors.js';
import type { ItemDoc, Models, TaxClassDoc, UnitDoc } from '../../models.js';
import { decodeCursor, encodeCursor, escapeRegex, fromDecimal, isDuplicateKey, nameKey, toDecimal, toDecimalOrNull, todayIST, versionConflict } from '../../platform/values.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { RequestMeta } from '../identity/identity.js';
import type { TenantContext } from '../tenancy/tenancy.js';

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);

type Optional<T> = { [K in keyof T]?: T[K] | undefined };

interface ItemInput {
  name: string;
  description: string;
  type: ItemType;
  categoryId: string | null;
  baseUnitId: string;
  altUnits: Array<{ unitId: string; factor: string }>;
  hsnSac: string;
  taxClassId: string;
  salePrice: string | null;
  purchasePrice: string | null;
  reorderLevel: string | null;
}

/** Decimal places in a decimal string ("12.50" → 2). */
const scaleOf = (value: string) => value.split('.')[1]?.length ?? 0;

/**
 * Catalogue (FR-CAT-01..03): units mapped to GST UQCs, categories, tax classes
 * with effective-dated rate schedules (no rates are shipped: GST-11) and items.
 */
export class CatalogueService {
  constructor(private readonly deps: { models: Models; audit: AuditLog; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>) {
    return this.deps.audit.record({ ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash });
  }

  /** Default units for a new business (UQC mappings only). Runs in the sign-up transaction and in migration 002. */
  async seedUnits(tenantId: Types.ObjectId, session?: ClientSession) {
    const docs = DEFAULT_UNITS.map(([code, name, uqc, decimals]) => ({ tenantId, code, name, uqc, decimals, archivedAt: null, version: 0 }));
    await this.deps.models.Unit.insertMany(docs, { ordered: false, ...(session ? { session } : {}) }).catch((err: unknown) => {
      if (!isDuplicateKey(err) && !(err as { writeErrors?: unknown[] }).writeErrors) throw err;
    });
  }

  // ----------------------------------------------------------------- units

  private toUnit(u: UnitDoc): Unit {
    return { id: u._id.toHexString(), code: u.code, name: u.name, uqc: u.uqc, decimals: u.decimals, archived: u.archivedAt !== null, version: u.version };
  }

  async listUnits(ctx: TenantContext): Promise<Unit[]> {
    const rows = await this.deps.models.Unit.find({ tenantId: ctx.tenantId }).sort({ code: 1 }).lean();
    return rows.map((u) => this.toUnit(u));
  }

  async createUnit(ctx: TenantContext, input: { code: string; name: string; uqc: Uqc; decimals: number }, meta: RequestMeta): Promise<Unit> {
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, ...input, archivedAt: null, version: 0 };
    try {
      await this.deps.models.Unit.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('code', 'A unit with this code already exists');
      throw err;
    }
    await this.record(ctx, meta, { action: 'unit.created', entityType: 'unit', entityId: doc._id.toHexString(), summary: `Added unit ${input.code} (UQC ${input.uqc})` });
    return this.toUnit(doc);
  }

  async updateUnit(ctx: TenantContext, id: string, input: { version: number; name?: string | undefined; uqc?: Uqc | undefined; decimals?: number | undefined; archived?: boolean | undefined }, meta: RequestMeta): Promise<Unit> {
    const unit = await this.deps.models.Unit.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!unit) throw notFound('Unit');
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.uqc !== undefined) set.uqc = input.uqc;
    if (input.decimals !== undefined) set.decimals = input.decimals;
    if (input.archived !== undefined) {
      if (input.archived && (await this.unitInUse(ctx, unit._id))) throw new AppError('BUSINESS_RULE', 'Items still use this unit; change them first');
      set.archivedAt = input.archived ? this.now() : null;
    }
    const updated = await this.deps.models.Unit.findOneAndUpdate({ tenantId: ctx.tenantId, _id: unit._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('unit');
    const changes: AuditChange[] = Object.keys(set).map((field) => ({ field, from: (unit as unknown as Record<string, unknown>)[field], to: set[field] }));
    await this.record(ctx, meta, { action: 'unit.updated', entityType: 'unit', entityId: id, summary: `Updated unit ${unit.code}`, changes });
    return this.toUnit(updated);
  }

  private async unitInUse(ctx: TenantContext, unitId: Types.ObjectId) {
    return (await this.deps.models.Item.countDocuments({ tenantId: ctx.tenantId, archivedAt: null, $or: [{ baseUnitId: unitId }, { 'altUnits.unitId': unitId }] })) > 0;
  }

  // ------------------------------------------------------------ categories

  async listCategories(ctx: TenantContext): Promise<Category[]> {
    const rows = await this.deps.models.Category.find({ tenantId: ctx.tenantId }).sort({ nameKey: 1 }).lean();
    const counts = await this.deps.models.Item.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { tenantId: ctx.tenantId, archivedAt: null, categoryId: { $ne: null } } },
      { $group: { _id: '$categoryId', n: { $sum: 1 } } },
    ]);
    const count = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
    return rows.map((c) => ({ id: c._id.toHexString(), name: c.name, itemCount: count.get(c._id.toHexString()) ?? 0, archived: c.archivedAt !== null, version: c.version }));
  }

  async createCategory(ctx: TenantContext, input: { name: string }, meta: RequestMeta): Promise<Category> {
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, name: input.name, nameKey: nameKey(input.name), archivedAt: null, version: 0 };
    try {
      await this.deps.models.Category.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('name', 'A category with this name already exists');
      throw err;
    }
    await this.record(ctx, meta, { action: 'category.created', entityType: 'category', entityId: doc._id.toHexString(), summary: `Added category "${input.name}"` });
    return { id: doc._id.toHexString(), name: doc.name, itemCount: 0, archived: false, version: 0 };
  }

  async updateCategory(ctx: TenantContext, id: string, input: { version: number; name?: string | undefined; archived?: boolean | undefined }, meta: RequestMeta): Promise<Category> {
    const category = await this.deps.models.Category.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!category) throw notFound('Category');
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) Object.assign(set, { name: input.name, nameKey: nameKey(input.name) });
    if (input.archived !== undefined) set.archivedAt = input.archived ? this.now() : null;
    let updated;
    try {
      updated = await this.deps.models.Category.findOneAndUpdate({ tenantId: ctx.tenantId, _id: category._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('name', 'A category with this name already exists');
      throw err;
    }
    if (!updated) throw versionConflict('category');
    await this.record(ctx, meta, { action: 'category.updated', entityType: 'category', entityId: id, summary: `Updated category "${updated.name}"`, changes: input.name ? [{ field: 'name', from: category.name, to: input.name }] : [{ field: 'archived', to: input.archived }] });
    const itemCount = await this.deps.models.Item.countDocuments({ tenantId: ctx.tenantId, categoryId: category._id, archivedAt: null });
    return { id, name: updated.name, itemCount, archived: updated.archivedAt !== null, version: updated.version };
  }

  // ----------------------------------------------------- tax classes, rates

  /** The schedule covering a business date, if any (used when documents are calculated, Phase 6/7). */
  static scheduleOn(taxClass: Pick<TaxClassDoc, 'schedules'>, date: string) {
    return taxClass.schedules.find((s) => s.effectiveFrom <= date && (s.effectiveTo === null || s.effectiveTo >= date)) ?? null;
  }

  private async toTaxClass(t: TaxClassDoc): Promise<TaxClass> {
    const verifierIds = [...new Set(t.schedules.map((s) => s.verifiedBy.toHexString()))].map((id) => new Types.ObjectId(id));
    const users = verifierIds.length ? await this.deps.models.User.find({ _id: trusted({ $in: verifierIds }) }, { name: 1 }).lean() : [];
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    const schedules: RateSchedule[] = [...t.schedules]
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
      .map((s) => ({
        id: s._id.toHexString(),
        effectiveFrom: s.effectiveFrom,
        effectiveTo: s.effectiveTo,
        gstRate: s.gstRate.toString(),
        cessRate: fromDecimal(s.cessRate),
        sourceReference: s.sourceReference,
        verifiedBy: names.get(s.verifiedBy.toHexString()) ?? 'Unknown',
        verifiedAt: s.verifiedAt.toISOString(),
      }));
    const current = t.treatment === 'taxable' ? CatalogueService.scheduleOn(t, todayIST(this.now())) : null;
    return {
      id: t._id.toHexString(),
      name: t.name,
      kind: t.kind,
      treatment: t.treatment,
      reverseCharge: t.reverseCharge,
      description: t.description,
      schedules,
      currentRate: current ? current.gstRate.toString() : null,
      archived: t.archivedAt !== null,
      version: t.version,
    };
  }

  async listTaxClasses(ctx: TenantContext): Promise<TaxClass[]> {
    const rows = await this.deps.models.TaxClass.find({ tenantId: ctx.tenantId }).sort({ nameKey: 1 }).lean();
    return Promise.all(rows.map((t) => this.toTaxClass(t)));
  }

  private async findTaxClass(ctx: TenantContext, id: string | Types.ObjectId) {
    const t = await this.deps.models.TaxClass.findOne({ tenantId: ctx.tenantId, _id: typeof id === 'string' ? new Types.ObjectId(id) : id }).lean();
    if (!t) throw notFound('Tax class');
    return t;
  }

  async createTaxClass(ctx: TenantContext, input: { name: string; kind: 'goods' | 'service'; treatment: TaxTreatment; reverseCharge: boolean; description: string }, meta: RequestMeta): Promise<TaxClass> {
    if (input.reverseCharge && input.treatment !== 'taxable') throw invalid('reverseCharge', 'Reverse charge applies only to taxable supplies');
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, ...input, nameKey: nameKey(input.name), schedules: [], archivedAt: null, version: 0 };
    try {
      await this.deps.models.TaxClass.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('name', 'A tax class with this name already exists');
      throw err;
    }
    await this.record(ctx, meta, { action: 'tax_class.created', entityType: 'tax_class', entityId: doc._id.toHexString(), summary: `Added tax class "${input.name}"`, changes: [{ field: 'treatment', to: input.treatment }, { field: 'reverseCharge', to: input.reverseCharge }] });
    return this.toTaxClass(doc);
  }

  async updateTaxClass(
    ctx: TenantContext,
    id: string,
    input: Optional<{ name: string; kind: 'goods' | 'service'; treatment: TaxTreatment; reverseCharge: boolean; description: string; archived: boolean }> & { version: number },
    meta: RequestMeta,
  ): Promise<TaxClass> {
    const t = await this.findTaxClass(ctx, id);
    const next = { treatment: input.treatment ?? t.treatment, reverseCharge: input.reverseCharge ?? t.reverseCharge, kind: input.kind ?? t.kind };
    if (next.reverseCharge && next.treatment !== 'taxable') throw invalid('reverseCharge', 'Reverse charge applies only to taxable supplies');
    if (next.treatment !== 'taxable' && t.schedules.length > 0) throw new AppError('BUSINESS_RULE', 'Remove the rate schedules before making this class non-taxable');
    if (input.kind && input.kind !== t.kind && (await this.deps.models.Item.countDocuments({ tenantId: ctx.tenantId, taxClassId: t._id, archivedAt: null })) > 0) {
      throw new AppError('BUSINESS_RULE', 'Items use this class; goods/service can’t change');
    }
    const set: Record<string, unknown> = {};
    for (const key of ['name', 'kind', 'treatment', 'reverseCharge', 'description'] as const) if (input[key] !== undefined) set[key] = input[key];
    if (input.name !== undefined) set.nameKey = nameKey(input.name);
    if (input.archived !== undefined) set.archivedAt = input.archived ? this.now() : null;
    let updated;
    try {
      updated = await this.deps.models.TaxClass.findOneAndUpdate({ tenantId: ctx.tenantId, _id: t._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('name', 'A tax class with this name already exists');
      throw err;
    }
    if (!updated) throw versionConflict('tax class');
    const changes = Object.keys(set)
      .filter((k) => k !== 'nameKey')
      .map((field) => ({ field, from: (t as unknown as Record<string, unknown>)[field], to: set[field] }));
    await this.record(ctx, meta, { action: 'tax_class.updated', entityType: 'tax_class', entityId: id, summary: `Updated tax class "${updated.name}"`, changes });
    return this.toTaxClass(updated);
  }

  /** Adds an effective-dated rate. Periods may not overlap; the version check makes check-and-write atomic. */
  async addSchedule(
    ctx: TenantContext,
    id: string,
    input: { version: number; effectiveFrom: string; effectiveTo: string | null; gstRate: string; cessRate: string | null; sourceReference: string },
    meta: RequestMeta,
  ): Promise<TaxClass> {
    const t = await this.findTaxClass(ctx, id);
    if (t.treatment !== 'taxable') throw new AppError('BUSINESS_RULE', `${t.name} is not taxable, so it has no GST rate`);
    const end = (d: string | null) => d ?? '9999-12-31';
    const clash = t.schedules.find((s) => s.effectiveFrom <= end(input.effectiveTo) && input.effectiveFrom <= end(s.effectiveTo));
    if (clash) {
      throw invalid('effectiveFrom', `Overlaps the rate from ${clash.effectiveFrom}${clash.effectiveTo ? ` to ${clash.effectiveTo}` : ' (open-ended)'}. End that period first.`);
    }
    const schedule = {
      _id: new Types.ObjectId(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      gstRate: toDecimal(input.gstRate),
      cessRate: toDecimalOrNull(input.cessRate),
      sourceReference: input.sourceReference,
      verifiedBy: ctx.userId,
      verifiedAt: this.now(),
    };
    const updated = await this.deps.models.TaxClass.findOneAndUpdate({ tenantId: ctx.tenantId, _id: t._id, version: input.version }, { $push: { schedules: schedule }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('tax class');
    await this.record(ctx, meta, {
      action: 'tax_rate.added',
      entityType: 'tax_class',
      entityId: id,
      summary: `Added ${input.gstRate}% GST to "${t.name}" from ${input.effectiveFrom}`,
      changes: [
        { field: 'gstRate', to: input.gstRate },
        { field: 'cessRate', to: input.cessRate },
        { field: 'effectiveFrom', to: input.effectiveFrom },
        { field: 'effectiveTo', to: input.effectiveTo },
        { field: 'sourceReference', to: input.sourceReference },
      ],
    });
    return this.toTaxClass(updated);
  }

  /** Closes an open-ended schedule (so a new rate can start) or removes it. Issued documents keep their own copy of the rate. */
  async updateSchedule(ctx: TenantContext, id: string, scheduleId: string, input: { version: number; effectiveTo: string | null } | { version: number; remove: true }, meta: RequestMeta): Promise<TaxClass> {
    const t = await this.findTaxClass(ctx, id);
    const schedule = t.schedules.find((s) => s._id.toHexString() === scheduleId);
    if (!schedule) throw notFound('Rate schedule');
    let update: Record<string, unknown>;
    let summary: string;
    if ('remove' in input) {
      update = { $pull: { schedules: { _id: schedule._id } } };
      summary = `Removed the ${schedule.gstRate.toString()}% rate from ${schedule.effectiveFrom} on "${t.name}"`;
    } else {
      if (input.effectiveTo !== null && input.effectiveTo < schedule.effectiveFrom) throw invalid('effectiveTo', 'End date must be on or after the start date');
      const end = (d: string | null) => d ?? '9999-12-31';
      const clash = t.schedules.find((s) => !s._id.equals(schedule._id) && s.effectiveFrom <= end(input.effectiveTo) && schedule.effectiveFrom <= end(s.effectiveTo));
      if (clash) throw invalid('effectiveTo', `Would overlap the rate from ${clash.effectiveFrom}`);
      update = { $set: { 'schedules.$[s].effectiveTo': input.effectiveTo } };
      summary = `Set the end of the ${schedule.gstRate.toString()}% rate on "${t.name}" to ${input.effectiveTo ?? 'open-ended'}`;
    }
    const updated = await this.deps.models.TaxClass.findOneAndUpdate({ tenantId: ctx.tenantId, _id: t._id, version: input.version }, { ...update, $inc: { version: 1 } }, {
      returnDocument: 'after',
      ...('remove' in input ? {} : { arrayFilters: [{ 's._id': schedule._id }] }),
    }).lean();
    if (!updated) throw versionConflict('tax class');
    await this.record(ctx, meta, { action: 'remove' in input ? 'tax_rate.removed' : 'tax_class.updated', entityType: 'tax_class', entityId: id, summary });
    return this.toTaxClass(updated);
  }

  // ----------------------------------------------------------------- items

  private async toItems(ctx: TenantContext, items: ItemDoc[]): Promise<Item[]> {
    const unitIds = new Set<string>();
    const classIds = new Set<string>();
    const categoryIds = new Set<string>();
    for (const i of items) {
      unitIds.add(i.baseUnitId.toHexString());
      i.altUnits.forEach((a) => unitIds.add(a.unitId.toHexString()));
      classIds.add(i.taxClassId.toHexString());
      if (i.categoryId) categoryIds.add(i.categoryId.toHexString());
    }
    const ids = (s: Set<string>) => [...s].map((id) => new Types.ObjectId(id));
    const [units, classes, categories] = await Promise.all([
      this.deps.models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids(unitIds) }) }, { code: 1 }).lean(),
      this.deps.models.TaxClass.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids(classIds) }) }, { name: 1 }).lean(),
      this.deps.models.Category.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids(categoryIds) }) }, { name: 1 }).lean(),
    ]);
    const unitCode = new Map(units.map((u) => [u._id.toHexString(), u.code]));
    const className = new Map(classes.map((c) => [c._id.toHexString(), c.name]));
    const categoryName = new Map(categories.map((c) => [c._id.toHexString(), c.name]));
    const showCost = ctx.permissions.has('price.view_cost');
    return items.map((i) => ({
      id: i._id.toHexString(),
      sku: i.sku,
      name: i.name,
      description: i.description,
      type: i.type,
      categoryId: i.categoryId?.toHexString() ?? null,
      categoryName: i.categoryId ? (categoryName.get(i.categoryId.toHexString()) ?? null) : null,
      baseUnitId: i.baseUnitId.toHexString(),
      baseUnitCode: unitCode.get(i.baseUnitId.toHexString()) ?? '?',
      altUnits: i.altUnits.map((a) => ({ unitId: a.unitId.toHexString(), unitCode: unitCode.get(a.unitId.toHexString()) ?? '?', factor: a.factor.toString() })),
      hsnSac: i.hsnSac,
      taxClassId: i.taxClassId.toHexString(),
      taxClassName: className.get(i.taxClassId.toHexString()) ?? '?',
      salePrice: fromDecimal(i.salePrice),
      // FR-RBAC-04: cost is omitted, not blanked, for callers without price.view_cost.
      ...(showCost ? { purchasePrice: fromDecimal(i.purchasePrice) } : {}),
      reorderLevel: fromDecimal(i.reorderLevel),
      archived: i.archivedAt !== null,
      version: i.version,
    }));
  }

  async listItems(
    ctx: TenantContext,
    query: { q?: string | undefined; type?: ItemType | undefined; categoryId?: string | undefined; archived: 'true' | 'false'; limit: number; cursor?: string | undefined },
  ) {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, archivedAt: query.archived === 'true' ? trusted({ $ne: null }) : null };
    if (query.type) filter.type = query.type;
    if (query.categoryId) filter.categoryId = new Types.ObjectId(query.categoryId);
    if (query.q) {
      const q = escapeRegex(query.q.toLowerCase());
      filter.$or = [{ nameKey: trusted({ $regex: q }) }, { sku: trusted({ $regex: `^${escapeRegex(query.q.toUpperCase())}` }) }, { hsnSac: trusted({ $regex: `^${q}` }) }];
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      filter.$and = [{ $or: [{ nameKey: trusted({ $gt: c.sortKey }) }, { nameKey: c.sortKey, _id: trusted({ $gt: c.id }) }] }];
    }
    const rows = await this.deps.models.Item.find(filter).sort({ nameKey: 1, _id: 1 }).limit(query.limit + 1).lean();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { data: await this.toItems(ctx, page), page: { nextCursor: rows.length > query.limit && last ? encodeCursor(last.nameKey, last._id) : null, limit: query.limit } };
  }

  private async findItem(ctx: TenantContext, id: string) {
    const item = await this.deps.models.Item.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!item) throw notFound('Item');
    return item;
  }

  async getItem(ctx: TenantContext, id: string): Promise<Item> {
    const [item] = await this.toItems(ctx, [await this.findItem(ctx, id)]);
    if (!item) throw notFound('Item');
    return item;
  }

  /** Cross-field and reference checks shared by create and update. All referenced ids must belong to this tenant. */
  private async validateItem(ctx: TenantContext, item: ItemInput) {
    const { models } = this.deps;
    const unitIds = [item.baseUnitId, ...item.altUnits.map((a) => a.unitId)].map((id) => new Types.ObjectId(id));
    const [units, taxClass, category] = await Promise.all([
      models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: unitIds }), archivedAt: null }).lean(),
      models.TaxClass.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(item.taxClassId), archivedAt: null }).lean(),
      item.categoryId ? models.Category.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(item.categoryId), archivedAt: null }).lean() : Promise.resolve(null),
    ]);
    const unitById = new Map(units.map((u) => [u._id.toHexString(), u]));
    const base = unitById.get(item.baseUnitId);
    if (!base) throw invalid('baseUnitId', 'Choose a unit');
    item.altUnits.forEach((a, i) => {
      if (!unitById.has(a.unitId)) throw invalid(`altUnits.${i}.unitId`, 'Choose a unit');
      if (a.unitId === item.baseUnitId) throw invalid(`altUnits.${i}.unitId`, 'An alternate unit must differ from the base unit');
    });
    if (!taxClass) throw invalid('taxClassId', 'Choose a tax class');
    if (item.categoryId && !category) throw invalid('categoryId', 'Choose a category');
    const service = item.type === 'service';
    if (service !== (taxClass.kind === 'service')) throw invalid('taxClassId', service ? 'Choose a tax class for services' : 'Choose a tax class for goods');
    if (service && !isSac(item.hsnSac)) throw invalid('hsnSac', 'Services use a 6-digit SAC starting with 99');
    if (!service && item.hsnSac.startsWith('99')) throw invalid('hsnSac', 'Codes starting with 99 are SAC codes for services; use the goods HSN code');
    if (item.reorderLevel !== null) {
      if (item.type !== 'stock') throw invalid('reorderLevel', 'Only stock items have a reorder level');
      if (scaleOf(item.reorderLevel) > base.decimals) throw invalid('reorderLevel', `${base.code} allows ${base.decimals} decimal places`);
    }
  }

  private requirePriceEdit(ctx: TenantContext) {
    if (!ctx.permissions.has('price.edit')) throw new AppError('FORBIDDEN', 'Changing prices needs the “Change prices” permission', [{ path: 'salePrice', message: 'price.edit' }]);
  }

  private toDoc(input: ItemInput) {
    return {
      name: input.name,
      nameKey: nameKey(input.name),
      description: input.description,
      type: input.type,
      categoryId: input.categoryId ? new Types.ObjectId(input.categoryId) : null,
      baseUnitId: new Types.ObjectId(input.baseUnitId),
      altUnits: input.altUnits.map((a) => ({ unitId: new Types.ObjectId(a.unitId), factor: toDecimal(a.factor) })),
      hsnSac: input.hsnSac,
      taxClassId: new Types.ObjectId(input.taxClassId),
      salePrice: toDecimalOrNull(input.salePrice),
      purchasePrice: toDecimalOrNull(input.purchasePrice),
      reorderLevel: toDecimalOrNull(input.reorderLevel),
    };
  }

  async createItem(ctx: TenantContext, input: ItemInput & { sku: string }, meta: RequestMeta): Promise<Item> {
    if (input.salePrice !== null || input.purchasePrice !== null) this.requirePriceEdit(ctx);
    await this.validateItem(ctx, input);
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, sku: input.sku, ...this.toDoc(input), archivedAt: null, version: 0 };
    try {
      await this.deps.models.Item.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw invalid('sku', 'Another item already uses this code');
      throw err;
    }
    await this.record(ctx, meta, {
      action: 'item.created',
      entityType: 'item',
      entityId: doc._id.toHexString(),
      summary: `Added item ${input.sku} "${input.name}"`,
      changes: [
        { field: 'hsnSac', to: input.hsnSac },
        { field: 'salePrice', to: input.salePrice },
        { field: 'purchasePrice', to: input.purchasePrice },
      ],
    });
    return this.getItem(ctx, doc._id.toHexString());
  }

  async updateItem(ctx: TenantContext, id: string, input: Optional<ItemInput> & { version: number; archived?: boolean | undefined }, meta: RequestMeta): Promise<Item> {
    const item = await this.findItem(ctx, id);
    const current: ItemInput = {
      name: item.name,
      description: item.description,
      type: item.type,
      categoryId: item.categoryId?.toHexString() ?? null,
      baseUnitId: item.baseUnitId.toHexString(),
      altUnits: item.altUnits.map((a) => ({ unitId: a.unitId.toHexString(), factor: a.factor.toString() })),
      hsnSac: item.hsnSac,
      taxClassId: item.taxClassId.toHexString(),
      salePrice: fromDecimal(item.salePrice),
      purchasePrice: fromDecimal(item.purchasePrice),
      reorderLevel: fromDecimal(item.reorderLevel),
    };
    const { version, archived, ...fields } = input;
    const next: ItemInput = { ...current, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    const changed = (Object.keys(next) as Array<keyof ItemInput>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (changed.includes('salePrice') || changed.includes('purchasePrice')) this.requirePriceEdit(ctx);
    if (changed.length) await this.validateItem(ctx, next);
    // Ledger quantities are in the base unit and only stock items move, so both are fixed once stock has moved.
    if ((changed.includes('type') || changed.includes('baseUnitId')) && (await this.deps.models.StockMovement.exists({ tenantId: ctx.tenantId, itemId: item._id }))) {
      throw new AppError('BUSINESS_RULE', 'This item has stock movements, so its type and base unit can’t change. Create a new item instead.');
    }
    if (archived === true && item.archivedAt === null) {
      const zero = toDecimal('0');
      const holding = await this.deps.models.StockBalance.exists({ tenantId: ctx.tenantId, itemId: item._id, $or: [{ onHand: trusted({ $ne: zero }) }, { inTransit: trusted({ $ne: zero }) }] });
      if (holding) throw new AppError('BUSINESS_RULE', 'This item still has stock. Adjust it to zero before archiving.');
    }
    const set: Record<string, unknown> = { ...this.toDoc(next) };
    if (archived !== undefined) set.archivedAt = archived ? this.now() : null;
    const updated = await this.deps.models.Item.findOneAndUpdate({ tenantId: ctx.tenantId, _id: item._id, version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('item');
    // Price and tax-code changes are recorded with values (FR-AUD-01); text fields only by name.
    const valued = new Set(['salePrice', 'purchasePrice', 'hsnSac', 'type', 'reorderLevel']);
    const changes: AuditChange[] = changed.map((field) => (valued.has(field) ? { field, from: current[field], to: next[field] } : { field }));
    if (archived !== undefined) changes.push({ field: 'archived', from: item.archivedAt !== null, to: archived });
    if (changes.length) await this.record(ctx, meta, { action: 'item.updated', entityType: 'item', entityId: id, summary: `Updated item ${item.sku}`, changes });
    return this.getItem(ctx, id);
  }
}
