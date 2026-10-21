import { trusted, Types } from 'mongoose';
import { stateName, turnoverRules, UTGST_STATE_CODES, type CalcPreview, type CalcPreviewRequest } from '@bizmgmt/contracts';
import { calculate, CalcError, fitsDecimals, type CalcLineInput } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { GstRegistrationDoc, ItemDoc, LegalEntityDoc, Models, PartyDoc, UnitDoc } from '../../models.js';
import { CatalogueService } from '../catalogue/catalogue.js';
import { canInEntity, visibleEntities, type TenantContext } from '../tenancy/tenancy.js';

const invalid = (path: string, message: string) => new AppError('VALIDATION_FAILED', message, [{ path, message }]);

export interface ComputeOptions {
  /** The customer GSTIN the document is billed to (from the billing address); default: the one in the place of supply's state. */
  buyerGstin?: string | null | undefined;
  /** Which document the figures are for; the "someone must issue it" hint is for invoices only. */
  forDocument?: 'quotation' | 'sales_order' | 'dispatch' | 'sales_invoice' | undefined;
}

/** The figures plus the master records they came from (for documents that store them). */
export interface Computed extends CalcPreview {
  entity: LegalEntityDoc;
  registration: GstRegistrationDoc;
  party: PartyDoc | null;
  units: Map<string, UnitDoc>;
  items: Map<string, ItemDoc>;
}

/**
 * Server-side calculation (architecture §11, financial-policy §5): the browser
 * shows these figures and never computes authoritative totals itself. It also
 * builds the snapshots (seller, buyer, item) that numbering a document freezes.
 */
export class PreviewService {
  constructor(private readonly models: Models) {}

  async preview(ctx: TenantContext, input: CalcPreviewRequest): Promise<CalcPreview> {
    const scope = visibleEntities(ctx, ['invoice.edit', 'quotation.edit', 'salesorder.edit', 'purchase.edit']);
    if (scope !== 'all' && !scope.has(input.legalEntityId)) throw new AppError('NOT_FOUND', 'Business entity not found');
    const { entity: _e, registration: _r, party: _p, units: _u, items: _i, ...preview } = await this.compute(ctx, input);
    return preview;
  }

  /** The calculation itself. Callers check access to the entity first. */
  async compute(ctx: TenantContext, input: CalcPreviewRequest, options: ComputeOptions = {}): Promise<Computed> {
    const { models } = this;
    const entityId = new Types.ObjectId(input.legalEntityId);
    const [entity, registration] = await Promise.all([
      models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: entityId }).lean(),
      models.GstRegistration.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(input.gstRegistrationId), legalEntityId: entityId }).lean(),
    ]);
    if (!entity) throw new AppError('NOT_FOUND', 'Business entity not found');
    if (!registration) throw invalid('gstRegistrationId', 'Choose a GST registration of this business entity');
    if (registration.effectiveFrom > input.docDate || (registration.effectiveTo && registration.effectiveTo < input.docDate)) {
      throw invalid('docDate', `GSTIN ${registration.gstin} is not in effect on this date`);
    }

    let party: PartyDoc | null = null;
    let buyer: CalcPreview['buyer'] = null;
    if (input.partyId) {
      party = await models.Party.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(input.partyId), archivedAt: null }).lean();
      if (!party || !party.isCustomer) throw invalid('partyId', 'Choose a customer');
      const chosen = options.buyerGstin === undefined ? undefined : party.gstins.find((g) => g.gstin === options.buyerGstin);
      // The GSTIN registered in the place of supply's state, if the customer has one there.
      const gstin = options.buyerGstin === null ? null : (chosen ?? party.gstins.find((g) => g.stateCode === input.placeOfSupply) ?? party.gstins[0] ?? null);
      buyer = { partyId: party._id.toHexString(), name: party.name, legalName: party.legalName, gstin: gstin?.gstin ?? null, stateCode: gstin?.stateCode ?? null };
    }

    const itemIds = input.lines.map((l) => new Types.ObjectId(l.itemId));
    const items = await models.Item.find({ tenantId: ctx.tenantId, _id: trusted({ $in: itemIds }) }).lean();
    const [units, classes] = await Promise.all([
      models.Unit.find({ tenantId: ctx.tenantId, _id: trusted({ $in: items.map((i) => i.baseUnitId) }) }).lean(),
      models.TaxClass.find({ tenantId: ctx.tenantId, _id: trusted({ $in: items.map((i) => i.taxClassId) }) }).lean(),
    ]);
    const itemById = new Map(items.map((i) => [i._id.toHexString(), i]));
    const unitById = new Map(units.map((u) => [u._id.toHexString(), u]));
    const classById = new Map(classes.map((c) => [c._id.toHexString(), c]));

    const supply = registration.stateCode === input.placeOfSupply ? 'intra' : 'inter';
    const noTax = registration.registrationType === 'composition';
    const resolved = input.lines.map((line, i) => {
      const item = itemById.get(line.itemId);
      if (!item || item.archivedAt) throw invalid(`lines.${i}.itemId`, 'Choose an item');
      const unit = unitById.get(item.baseUnitId.toHexString());
      const taxClass = classById.get(item.taxClassId.toHexString());
      if (!unit || !taxClass) throw invalid(`lines.${i}.itemId`, `${item.sku} is missing its unit or tax class`);
      if (!fitsDecimals(line.qty, unit.decimals)) throw invalid(`lines.${i}.qty`, `${unit.code} allows ${unit.decimals} decimal places`);
      let taxRate: string | null = null;
      let cessRate: string | null = null;
      if (taxClass.treatment === 'taxable' && !noTax) {
        // Rates come only from the tenant's verified schedules (GST-11), at the document date.
        const schedule = CatalogueService.scheduleOn(taxClass, input.docDate);
        if (!schedule) throw new AppError('BUSINESS_RULE', `No GST rate for "${taxClass.name}" on ${input.docDate}. Add the rate under Settings › Tax rates.`, [{ path: `lines.${i}.itemId`, message: 'No rate' }]);
        taxRate = schedule.gstRate.toString();
        cessRate = schedule.cessRate?.toString() ?? null;
      }
      const calcLine: CalcLineInput = { qty: line.qty, unitPrice: line.unitPrice, discount: line.discount, hsnSac: item.hsnSac, taxRate, cessRate, reverseCharge: taxClass.reverseCharge && !noTax };
      return { line, item, unit, calcLine, taxRate, cessRate };
    });

    let result;
    try {
      result = calculate({
        supply,
        utgst: supply === 'intra' && UTGST_STATE_CODES.includes(input.placeOfSupply),
        noTax,
        documentDiscount: input.documentDiscount,
        roundOff: entity.workflow.roundOffTotal,
        lines: resolved.map((r) => r.calcLine),
      });
    } catch (err) {
      if (err instanceof CalcError) throw invalid(err.path, err.message);
      throw err;
    }

    const warnings: string[] = [];
    const minDigits = turnoverRules(entity.turnoverBand).hsnMinDigits;
    const shortHsn = resolved.filter((r) => r.item.hsnSac.length < minDigits).map((r) => r.item.sku);
    if (shortHsn.length) warnings.push(`HSN/SAC needs at least ${minDigits} digits for your turnover band on tax invoices (GST-04): ${shortHsn.join(', ')}`);
    if (noTax && supply === 'inter') warnings.push('Composition taxpayers generally cannot make inter-state supplies. Check with your adviser (C-09).');
    if (result.totals.reverseChargeTax !== '0.00') warnings.push('Some lines are under reverse charge: the customer pays that tax, and the document must say so (GST-13).');
    if (buyer?.gstin && buyer.stateCode !== input.placeOfSupply) warnings.push(`The customer's GSTIN is in ${stateName(buyer.stateCode ?? '') ?? buyer.stateCode}, but the place of supply is ${stateName(input.placeOfSupply) ?? input.placeOfSupply}. Check the place of supply (C-01).`);
    if ((options.forDocument ?? 'sales_invoice') === 'sales_invoice' && !canInEntity(ctx, 'invoice.issue', entityId)) warnings.push('You can prepare this, but someone with “Issue invoices” must issue it.');

    // A bill of supply for a composition taxpayer, or when no line is taxable (exempt, nil-rated or non-GST: GST-14).
    const documentKind = noTax || resolved.every((r) => r.taxRate === null) ? 'bill_of_supply' : 'tax_invoice';
    return {
      calcVersion: result.calcVersion,
      documentKind,
      supply,
      placeOfSupply: input.placeOfSupply,
      seller: { legalEntityId: entity._id.toHexString(), legalName: entity.legalName, tradeName: entity.tradeName, gstin: registration.gstin, stateCode: registration.stateCode, registrationType: registration.registrationType },
      buyer,
      lines: resolved.map((r, i) => {
        const l = result.lines[i];
        if (!l) throw new Error('calculation line missing');
        return { itemId: r.item._id.toHexString(), item: { sku: r.item.sku, name: r.item.name, type: r.item.type, hsnSac: r.item.hsnSac, unitCode: r.unit.code, uqc: r.unit.uqc }, qty: r.line.qty, unitPrice: r.line.unitPrice, taxRate: r.taxRate, cessRate: r.cessRate, ...l };
      }),
      totals: result.totals,
      hsnSummary: result.hsnSummary,
      warnings,
      entity,
      registration,
      party,
      units: unitById,
      items: itemById,
    };
  }
}
