import { trusted, type Types } from 'mongoose';
import { dec } from '@bizmgmt/domain';
import type { Models } from '../../models.js';

export type ReconciliationIssueKind = 'on_hand' | 'in_transit' | 'reserved' | 'valuation_qty' | 'valuation_value' | 'valuation_zero_qty';

export interface RawIssue {
  kind: ReconciliationIssueKind;
  legalEntityId: Types.ObjectId;
  warehouseId: Types.ObjectId | null;
  itemId: Types.ObjectId;
  expected: string;
  actual: string;
}

export interface RawReconciliation {
  balancesChecked: number;
  valuationsChecked: number;
  issues: RawIssue[];
  negativeBalances: Array<{ legalEntityId: Types.ObjectId; warehouseId: Types.ObjectId; itemId: Types.ObjectId; onHand: string }>;
}

type Sum = { qty: string; value: string };
const key = (...ids: Array<Types.ObjectId | null>) => ids.map((id) => id?.toHexString() ?? '-').join(':');
const str = (v: unknown) => (v === null || v === undefined ? '0' : String(v));

/**
 * Recomputes stock from the append-only ledger and compares it with the stored
 * running figures (FR-INV-09, AC-INV-2, financial-policy.md §7):
 * - balance on hand = Σ movement qty per (warehouse, item)
 * - balance in transit = Σ qty of dispatched, unreceived transfers per destination
 * - balance reserved = Σ reserved qty of open (confirmed, partly fulfilled) sales order lines
 * - valuation qty / value = Σ movement qty / value per (entity, item) plus goods in transit
 * Read-only; it reports drift and never repairs it (repairs are reviewed corrections).
 */
export async function reconcileStock(models: Models, tenantId: Types.ObjectId, legalEntityIds: Types.ObjectId[] | 'all'): Promise<RawReconciliation> {
  const entityFilter = legalEntityIds === 'all' ? {} : { legalEntityId: trusted({ $in: legalEntityIds }) };

  const [movementSums, balances, transitRows, valuations, reservedRows] = await Promise.all([
    models.StockMovement.aggregate<{ _id: { e: Types.ObjectId; w: Types.ObjectId; i: Types.ObjectId }; qty: unknown; value: unknown }>([
      { $match: { tenantId, ...entityFilter } },
      { $group: { _id: { e: '$legalEntityId', w: '$warehouseId', i: '$itemId' }, qty: { $sum: '$qty' }, value: { $sum: '$value' } } },
    ]),
    models.StockBalance.find({ tenantId, ...entityFilter }, { legalEntityId: 1, warehouseId: 1, itemId: 1, onHand: 1, inTransit: 1, reserved: 1 }).lean(),
    models.StockTransfer.aggregate<{ _id: { e: Types.ObjectId; w: Types.ObjectId; i: Types.ObjectId }; qty: unknown; value: unknown }>([
      { $match: { tenantId, status: 'dispatched', ...entityFilter } },
      { $unwind: '$lines' },
      { $group: { _id: { e: '$legalEntityId', w: '$toWarehouseId', i: '$lines.itemId' }, qty: { $sum: '$lines.qty' }, value: { $sum: '$lines.value' } } },
    ]),
    models.ItemValuation.find({ tenantId, ...entityFilter }).lean(),
    models.SalesOrder.aggregate<{ _id: { w: Types.ObjectId; i: Types.ObjectId }; qty: unknown }>([
      { $match: { tenantId, status: { $in: ['confirmed', 'partially_fulfilled'] }, ...entityFilter } },
      { $unwind: '$lines' },
      { $group: { _id: { w: '$warehouseId', i: '$lines.itemId' }, qty: { $sum: '$lines.reservedQty' } } },
    ]),
  ]);

  const issues: RawIssue[] = [];
  const differ = (a: string, b: string) => !dec(a).eq(dec(b));

  // Per warehouse: on hand and in transit.
  const ledgerByBalance = new Map<string, Sum>();
  const ledgerByEntityItem = new Map<string, Sum>();
  const add = (map: Map<string, Sum>, k: string, qty: string, value: string) => {
    const cur = map.get(k) ?? { qty: '0', value: '0' };
    map.set(k, { qty: dec(cur.qty).plus(dec(qty)).toString(), value: dec(cur.value).plus(dec(value)).toString() });
  };
  for (const m of movementSums) {
    add(ledgerByBalance, key(m._id.w, m._id.i), str(m.qty), str(m.value));
    add(ledgerByEntityItem, key(m._id.e, m._id.i), str(m.qty), str(m.value));
  }
  const transitByBalance = new Map<string, string>();
  for (const t of transitRows) {
    transitByBalance.set(key(t._id.w, t._id.i), str(t.qty));
    add(ledgerByEntityItem, key(t._id.e, t._id.i), str(t.qty), str(t.value));
  }

  const reservedByBalance = new Map(reservedRows.map((r) => [key(r._id.w, r._id.i), str(r.qty)]));

  const seenBalances = new Set<string>();
  const negativeBalances: RawReconciliation['negativeBalances'] = [];
  for (const b of balances) {
    const k = key(b.warehouseId, b.itemId);
    seenBalances.add(k);
    const onHand = b.onHand.toString();
    const expected = ledgerByBalance.get(k)?.qty ?? '0';
    if (differ(expected, onHand)) issues.push({ kind: 'on_hand', legalEntityId: b.legalEntityId, warehouseId: b.warehouseId, itemId: b.itemId, expected, actual: onHand });
    const transit = transitByBalance.get(k) ?? '0';
    if (differ(transit, b.inTransit.toString())) issues.push({ kind: 'in_transit', legalEntityId: b.legalEntityId, warehouseId: b.warehouseId, itemId: b.itemId, expected: transit, actual: b.inTransit.toString() });
    const reserved = reservedByBalance.get(k) ?? '0';
    if (differ(reserved, b.reserved.toString())) issues.push({ kind: 'reserved', legalEntityId: b.legalEntityId, warehouseId: b.warehouseId, itemId: b.itemId, expected: reserved, actual: b.reserved.toString() });
    if (dec(onHand).isNegative() && !dec(onHand).isZero()) negativeBalances.push({ legalEntityId: b.legalEntityId, warehouseId: b.warehouseId, itemId: b.itemId, onHand });
  }
  // Movements with no balance row at all are drift too.
  for (const m of movementSums) {
    const k = key(m._id.w, m._id.i);
    if (!seenBalances.has(k) && !dec(str(m.qty)).isZero()) issues.push({ kind: 'on_hand', legalEntityId: m._id.e, warehouseId: m._id.w, itemId: m._id.i, expected: str(m.qty), actual: '0' });
  }

  // Per entity and item: valuation.
  const seenValuations = new Set<string>();
  for (const v of valuations) {
    const k = key(v.legalEntityId, v.itemId);
    seenValuations.add(k);
    const expected = ledgerByEntityItem.get(k) ?? { qty: '0', value: '0' };
    const qty = v.qty.toString();
    const value = v.value.toString();
    if (differ(expected.qty, qty)) issues.push({ kind: 'valuation_qty', legalEntityId: v.legalEntityId, warehouseId: null, itemId: v.itemId, expected: expected.qty, actual: qty });
    if (differ(expected.value, value)) issues.push({ kind: 'valuation_value', legalEntityId: v.legalEntityId, warehouseId: null, itemId: v.itemId, expected: dec(expected.value).toFixed(2), actual: value });
    if (dec(qty).isZero() && !dec(value).isZero()) issues.push({ kind: 'valuation_zero_qty', legalEntityId: v.legalEntityId, warehouseId: null, itemId: v.itemId, expected: '0.00', actual: value });
  }
  for (const [k, sum] of ledgerByEntityItem) {
    if (seenValuations.has(k) || (dec(sum.qty).isZero() && dec(sum.value).isZero())) continue;
    const [e = '', i = ''] = k.split(':');
    const sample = movementSums.find((m) => m._id.e.toHexString() === e && m._id.i.toHexString() === i)?._id ?? transitRows.find((t) => t._id.e.toHexString() === e && t._id.i.toHexString() === i)?._id;
    if (sample) issues.push({ kind: 'valuation_qty', legalEntityId: sample.e, warehouseId: null, itemId: sample.i, expected: sum.qty, actual: '0' });
  }

  return { balancesChecked: balances.length, valuationsChecked: valuations.length, issues, negativeBalances };
}
