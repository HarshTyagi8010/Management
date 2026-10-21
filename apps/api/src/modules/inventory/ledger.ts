import { trusted, type ClientSession, type Types } from 'mongoose';
import { dec, EMPTY_VALUATION, issue, issueAt, issueCost, receive, restore, type ValuationState } from '@bizmgmt/domain';
import type { MovementKind, StockSourceType } from '@bizmgmt/contracts';
import { AppError } from '../../errors.js';
import type { ItemValuationDoc, Models, StockMovementDoc } from '../../models.js';
import { fromDecimal, isDuplicateKey, toDecimal } from '../../platform/values.js';

/**
 * What a document line does to stock. Quantities are positive here; the effect
 * decides the sign of the movement.
 * - receive: in at a unit cost (null = current average; refused if there is none).
 *   With preferAverage the current average wins and the given cost is only a fallback.
 * - issue: out of the entity at the average cost
 * - transfer_out / transfer_in: between warehouses of one entity; the entity
 *   valuation does not change (goods in transit are still the entity's stock)
 * - transfer_return: a dispatched transfer is cancelled; stock goes back to the
 *   source at the value it left with
 * - restore: a cancelled sale or dispatch; stock comes back into the entity at
 *   exactly the value it left with (financial-policy §6)
 * - receipt_return: a cancelled goods receipt or supplier bill; stock goes out at
 *   the value it was received at (financial-policy §6.4)
 */
export type StockEffect =
  | { type: 'receive'; unitCost: string | null; preferAverage?: boolean }
  | { type: 'issue' }
  | { type: 'transfer_out' }
  | { type: 'transfer_in'; unitCost: string; value: string }
  | { type: 'transfer_return'; unitCost: string; value: string; reversalOf: Types.ObjectId }
  | { type: 'restore'; value: string; reversalOf?: Types.ObjectId | null }
  | { type: 'receipt_return'; value: string; reversalOf?: Types.ObjectId | null };

export interface PostLine {
  warehouseId: Types.ObjectId;
  itemId: Types.ObjectId;
  /** For error messages ("SKU-1: only 3 in stock"). */
  label: string;
  qty: string;
  kind: MovementKind;
  sourceLineId: string;
  effect: StockEffect;
  /**
   * Stock out against a sales order line: this much of the line's reservation is
   * used up by the movement (reserved goes down with on hand). Other stock outs
   * may only take what is not reserved.
   */
  consumeReserved?: string | undefined;
}

export interface PostContext {
  session: ClientSession;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  allowNegative: boolean;
  docDate: string;
  sourceType: StockSourceType;
  sourceId: Types.ObjectId;
  sourceNumber: string;
  actorId: Types.ObjectId;
  now: Date;
}

export interface PostedLine {
  sourceLineId: string;
  movementId: Types.ObjectId;
  unitCost: string;
  /** Positive value of the goods moved. */
  value: string;
  /** Every movement written for the line (kind and signed value), for the journal. */
  movements: Array<{ kind: MovementKind; value: string }>;
}

const ZERO = () => toDecimal('0');

function insufficient(label: string, qty: string, path: string, balance: { onHand: Types.Decimal128; reserved: Types.Decimal128 }) {
  const onHand = balance.onHand.toString();
  const reserved = balance.reserved.toString();
  const reservedNote = dec(reserved).isZero() ? '' : ` (${reserved} of them reserved for sales orders)`;
  return new AppError('INSUFFICIENT_STOCK', `Not enough stock of ${label}: ${onHand} on hand${reservedNote}, ${qty} needed`, [{ path, message: `${dec(onHand).minus(dec(reserved)).toString()} available` }]);
}

const stateOf = (v: ItemValuationDoc | null): ValuationState =>
  v ? { qty: v.qty.toString(), value: fromDecimal(v.value) ?? '0.00', avgCost: fromDecimal(v.avgCost) } : EMPTY_VALUATION;

/**
 * The only code that writes stock movements, balances and valuations
 * (FR-INV-03). Callers run it inside a MongoDB transaction together with the
 * document's status change and audit entry.
 *
 * Concurrency (AC-INV-1): a stock-out decrements the balance with a guarded
 * update inside the transaction: what is available (on hand − reserved, plus
 * the reservation the movement itself uses up) must cover the quantity. Two
 * transactions taking the same last units both write the same balance
 * document, so one hits a write conflict, is retried, and then finds too
 * little stock. Reservations (FR-INV-05) use the same guard.
 */
export class StockLedger {
  constructor(private readonly models: Models) {}

  /**
   * Balance and valuation rows must exist before the transaction: an upsert
   * racing another upsert inside a transaction fails on the unique index
   * instead of being retried. Creating them up front (idempotently) avoids that.
   */
  async ensureRows(tenantId: Types.ObjectId, legalEntityId: Types.ObjectId, pairs: Array<{ warehouseId: Types.ObjectId; itemId: Types.ObjectId }>) {
    const { StockBalance, ItemValuation } = this.models;
    const ignoreDuplicate = (err: unknown) => {
      if (!isDuplicateKey(err)) throw err;
    };
    for (const { warehouseId, itemId } of pairs) {
      await StockBalance.updateOne(
        { tenantId, warehouseId, itemId },
        { $setOnInsert: { legalEntityId, onHand: ZERO(), reserved: ZERO(), inTransit: ZERO(), version: 0 } },
        { upsert: true },
      ).catch(ignoreDuplicate);
    }
    const items = new Map(pairs.map((p) => [p.itemId.toHexString(), p.itemId]));
    for (const itemId of items.values()) {
      await ItemValuation.updateOne({ tenantId, legalEntityId, itemId }, { $setOnInsert: { qty: ZERO(), value: toDecimal('0.00'), avgCost: null, version: 0 } }, { upsert: true }).catch(ignoreDuplicate);
    }
  }

  async post(c: PostContext, lines: PostLine[]): Promise<PostedLine[]> {
    const posted: PostedLine[] = [];
    // Sequential on purpose: two lines may touch the same item's valuation.
    for (const line of lines) posted.push(await this.postLine(c, line));
    return posted;
  }

  /** Changes the incoming in-transit quantity of a destination balance (transfers). */
  async addInTransit(c: Pick<PostContext, 'session' | 'tenantId'>, warehouseId: Types.ObjectId, itemId: Types.ObjectId, qty: string) {
    const res = await this.models.StockBalance.updateOne({ tenantId: c.tenantId, warehouseId, itemId }, { $inc: { inTransit: toDecimal(qty), version: 1 } }, { session: c.session });
    if (res.matchedCount !== 1) throw new Error('Stock balance row missing; ensureRows was not called');
  }

  private async valuation(c: PostContext, itemId: Types.ObjectId) {
    const doc = await this.models.ItemValuation.findOne({ tenantId: c.tenantId, legalEntityId: c.legalEntityId, itemId }, null, { session: c.session }).lean();
    if (!doc) throw new Error('Item valuation row missing; ensureRows was not called');
    return doc;
  }

  private async saveValuation(c: PostContext, doc: ItemValuationDoc, next: ValuationState) {
    const res = await this.models.ItemValuation.updateOne(
      { tenantId: c.tenantId, _id: doc._id, version: doc.version },
      { $set: { qty: toDecimal(next.qty), value: toDecimal(next.value), avgCost: next.avgCost === null ? null : toDecimal(next.avgCost) }, $inc: { version: 1 } },
      { session: c.session },
    );
    // Inside a snapshot transaction a concurrent change surfaces as a write conflict (retried), so this means a bug.
    if (res.matchedCount !== 1) throw new Error('Item valuation changed during the transaction');
  }

  /** Applies the signed quantity to the warehouse balance and returns on-hand afterwards. */
  private async moveBalance(c: PostContext, line: PostLine, signedQty: string): Promise<string> {
    const outgoing = signedQty.startsWith('-');
    const consume = line.consumeReserved && !dec(line.consumeReserved).isZero() ? line.consumeReserved : null;
    const filter: Record<string, unknown> = { tenantId: c.tenantId, warehouseId: line.warehouseId, itemId: line.itemId };
    if (outgoing && !c.allowNegative) {
      // on hand − reserved + (the reservation this movement uses) ≥ quantity
      filter.$expr = trusted({ $gte: [{ $add: [{ $subtract: ['$onHand', '$reserved'] }, toDecimal(consume ?? '0')] }, toDecimal(line.qty)] });
    }
    if (consume) filter.reserved = trusted({ $gte: toDecimal(consume) });
    const inc: Record<string, unknown> = { onHand: toDecimal(signedQty), version: 1 };
    if (consume) inc.reserved = toDecimal(`-${consume}`);
    const after = await this.models.StockBalance.findOneAndUpdate(filter, { $inc: inc }, { session: c.session, returnDocument: 'after', projection: { onHand: 1 } }).lean();
    if (!after) {
      const current = await this.models.StockBalance.findOne({ tenantId: c.tenantId, warehouseId: line.warehouseId, itemId: line.itemId }, { onHand: 1, reserved: 1 }, { session: c.session }).lean();
      if (!current) throw new Error('Stock balance row missing; ensureRows was not called');
      if (consume && dec(current.reserved.toString()).lessThan(dec(consume))) throw new Error(`Reservation of ${line.label} is smaller than the quantity to use up`);
      throw insufficient(line.label, line.qty, line.sourceLineId, current);
    }
    return after.onHand.toString();
  }

  /** Holds stock for a sales order line: available must cover it unless negative stock is allowed (FR-INV-05). */
  async reserve(c: Pick<PostContext, 'session' | 'tenantId' | 'allowNegative'>, line: { warehouseId: Types.ObjectId; itemId: Types.ObjectId; label: string; qty: string; sourceLineId: string }) {
    const filter: Record<string, unknown> = { tenantId: c.tenantId, warehouseId: line.warehouseId, itemId: line.itemId };
    if (!c.allowNegative) filter.$expr = trusted({ $gte: [{ $subtract: ['$onHand', '$reserved'] }, toDecimal(line.qty)] });
    const res = await this.models.StockBalance.updateOne(filter, { $inc: { reserved: toDecimal(line.qty), version: 1 } }, { session: c.session });
    if (res.matchedCount === 1) return;
    const current = await this.models.StockBalance.findOne({ tenantId: c.tenantId, warehouseId: line.warehouseId, itemId: line.itemId }, { onHand: 1, reserved: 1 }, { session: c.session }).lean();
    if (!current) throw new Error('Stock balance row missing; ensureRows was not called');
    throw insufficient(line.label, line.qty, line.sourceLineId, current);
  }

  /** Gives back a reservation (order cancelled or closed, or a dispatch or invoice cancelled while the order is open). */
  async release(c: Pick<PostContext, 'session' | 'tenantId'>, warehouseId: Types.ObjectId, itemId: Types.ObjectId, qty: string) {
    const res = await this.models.StockBalance.updateOne({ tenantId: c.tenantId, warehouseId, itemId, reserved: trusted({ $gte: toDecimal(qty) }) }, { $inc: { reserved: toDecimal(`-${qty}`), version: 1 } }, { session: c.session });
    if (res.matchedCount !== 1) throw new Error('Releasing more than is reserved');
  }

  private async postLine(c: PostContext, line: PostLine): Promise<PostedLine> {
    const q = dec(line.qty);
    if (!q.isPositive() || q.isZero()) throw new Error('PostLine.qty must be positive');
    const effect = line.effect;
    let unitCost: string;
    let value: string;
    let revaluation = '0.00';
    let signedQty = line.qty;
    let reversalOf: Types.ObjectId | null = null;

    switch (effect.type) {
      case 'receive': {
        const doc = await this.valuation(c, line.itemId);
        const state = stateOf(doc);
        const cost = effect.preferAverage ? (state.avgCost ?? effect.unitCost) : (effect.unitCost ?? state.avgCost);
        if (cost === null) {
          throw new AppError('BUSINESS_RULE', `${line.label} has no average cost yet: enter a unit cost for it`, [{ path: line.sourceLineId, message: 'Unit cost required' }]);
        }
        const result = receive(state, line.qty, cost);
        await this.saveValuation(c, doc, result.state);
        unitCost = dec(cost).toFixed(6);
        value = result.value;
        revaluation = result.revaluation;
        break;
      }
      case 'issue': {
        const doc = await this.valuation(c, line.itemId);
        const result = issue(stateOf(doc), line.qty);
        await this.saveValuation(c, doc, result.state);
        ({ unitCost, value } = result);
        signedQty = `-${line.qty}`;
        break;
      }
      case 'transfer_out': {
        ({ unitCost, value } = issueCost(stateOf(await this.valuation(c, line.itemId)), line.qty));
        signedQty = `-${line.qty}`;
        break;
      }
      case 'restore': {
        const doc = await this.valuation(c, line.itemId);
        const result = restore(stateOf(doc), line.qty, effect.value);
        await this.saveValuation(c, doc, result.state);
        value = result.value;
        unitCost = dec(effect.value).dividedBy(q).toFixed(6);
        revaluation = result.revaluation;
        reversalOf = effect.reversalOf ?? null;
        break;
      }
      case 'receipt_return': {
        const doc = await this.valuation(c, line.itemId);
        const result = issueAt(stateOf(doc), line.qty, effect.value);
        await this.saveValuation(c, doc, result.state);
        value = result.value;
        unitCost = dec(effect.value).dividedBy(q).toFixed(6);
        revaluation = result.revaluation;
        reversalOf = effect.reversalOf ?? null;
        signedQty = `-${line.qty}`;
        break;
      }
      case 'transfer_in':
      case 'transfer_return':
        ({ unitCost, value } = effect);
        if (effect.type === 'transfer_return') reversalOf = effect.reversalOf;
        break;
    }

    const onHandAfter = await this.moveBalance(c, line, signedQty);
    const outgoing = signedQty.startsWith('-');
    const base = {
      tenantId: c.tenantId,
      legalEntityId: c.legalEntityId,
      warehouseId: line.warehouseId,
      itemId: line.itemId,
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      sourceNumber: c.sourceNumber,
      sourceLineId: line.sourceLineId,
      docDate: c.docDate,
      createdBy: c.actorId,
      createdAt: c.now,
    };
    const movement: Omit<StockMovementDoc, '_id'> = {
      ...base,
      kind: line.kind,
      qty: toDecimal(signedQty),
      onHandAfter: toDecimal(onHandAfter),
      unitCost: toDecimal(unitCost),
      value: toDecimal(outgoing && !dec(value).isZero() ? `-${value}` : value),
      reversalOf,
    };
    const docs: Array<Omit<StockMovementDoc, '_id'>> = [movement];
    if (!dec(revaluation).isZero()) {
      docs.push({ ...base, kind: 'revalue', qty: ZERO(), onHandAfter: toDecimal(onHandAfter), unitCost: toDecimal('0'), value: toDecimal(revaluation), reversalOf: null });
    }
    let created;
    try {
      created = await this.models.StockMovement.create(docs, { session: c.session, ordered: true });
    } catch (err) {
      // The unique source key: this document line has already moved stock (FR-INV-10).
      if (isDuplicateKey(err)) throw new AppError('INVALID_STATE', 'This document has already moved stock');
      throw err;
    }
    const first = created[0];
    if (!first) throw new Error('Movement not created');
    return { sourceLineId: line.sourceLineId, movementId: first._id, unitCost, value, movements: docs.map((d) => ({ kind: d.kind, value: d.value.toString() })) };
  }
}
