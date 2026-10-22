# Money, Quantity, Tax, Rounding and Inventory Valuation Policy

Status: Draft v0.1 · 2026-10-19 · **Requires review by a Chartered Accountant before pilot** (see compliance doc §8).

## 1. Representation
| Kind | Storage | API | Scale (stored) | Notes |
|---|---|---|---|---|
| Money amount | Decimal128 | decimal string `^-?\d{1,15}(\.\d{1,2})?$` | 2 dp | INR only in MVP |
| Unit price / rate | Decimal128 | decimal string, ≤ 6 dp | 6 dp | Allows ₹0.000125 per unit pricing |
| Quantity | Decimal128 | decimal string, ≤ 3 dp | 3 dp (per-unit configurable 0–3) | Unit `decimals` setting (e.g. Nos = 0, Kg = 3) |
| Tax rate % | Decimal128 | decimal string ≤ 4 dp | 4 dp | e.g. `"18"`, `"0.25"`, `"1.5"` |
| Cess | rate % and/or specific amount per unit | decimal strings | as above | supports ad-valorem, specific, or both |
| Unit cost (valuation) | Decimal128 | decimal string | 6 dp | weighted average |

Arithmetic in `packages/domain` uses `decimal.js` configured `precision: 34`,
`rounding: ROUND_HALF_UP`. No intermediate rounding except at the documented stages below.

## 2. Line calculation (sales and purchase documents)
For each line *i*:
1. `gross_i = qty_i × unitPrice_i` → round to 2 dp (**Stage R1**).
2. `lineDiscount_i` = percentage (`gross_i × pct`) or absolute → round 2 dp; must be ≤ gross.
3. `net_i = gross_i − lineDiscount_i`.
4. **Document-level discount** `D` (before tax) is allocated across lines pro-rata to `net_i` using the **largest-remainder method**: compute raw shares, floor to paisa, distribute leftover paise one by one to lines with the largest remainders, ties broken by line order. Σ shares = D exactly. (**Stage R2**)
5. `taxable_i = net_i − share_i`.
6. Tax components per line on `taxable_i`: intra-state → CGST = taxable × rate/2, SGST/UTGST = taxable × rate/2; inter-state → IGST = taxable × rate. Each component rounded to 2 dp **per line** (**Stage R3**). Cess: ad-valorem on taxable and/or specific × qty, rounded 2 dp.
7. `lineTotal_i = taxable_i + Σ tax_i`.

Document totals = Σ of line values (no re-rounding). Tax summary grouped by
HSN/SAC + rate = Σ of line components (consistent with line-level rounding).

Per-line rounding is the default because it makes HSN summaries and line
totals reconcile exactly; an alternative "tax computed on rate-wise taxable totals"
mode is **not** offered in MVP (unresolved review item C-03).

## 3. Invoice rounding (Stage R4)
Optional "round off grand total to nearest rupee" setting per legal entity
(default **on**, half-up). The difference (−0.49 … +0.50; half-up sends .50 up) is shown as a separate
"Round off" line and posted to a Rounding account. It never alters taxable value or tax.

## 4. Discounts — additional rules
- Discounts after supply (e.g. trade schemes) are issued as credit notes, not by editing invoices.
- Free items: quantity with zero price is allowed; tax treatment of free supplies is a **legal review item (C-05)** and blocked by default.

## 5. Determinism guarantees
- The same input (lines, rates, settings version) always yields identical output; calculation code is pure and versioned (`calcVersion` stored on the document).
- Issued documents store all computed values; they are never recomputed for display.
- Client previews call the server; the browser does not compute authoritative totals.

## 6. Inventory valuation — moving weighted average
Per (legal entity, item):
- On receipt: `newAvg = (onHandValue + receiptQty × receiptUnitCost) / (onHandQty + receiptQty)`, unit cost stored at 6 dp, value at 2 dp.
- On issue (sale/dispatch/transfer-out of entity/adjust-out): cost = qty × currentAvg; the issued unit cost is **stored on the movement** for later reversal.
- Transfers between warehouses of the same legal entity move value at current average (average is entity-wide, quantity is warehouse-wide).
- Sales return re-enters at the cost stored on the original issue movement. Purchase return leaves at the receipt cost; resulting avg recalculated.
- Supplier bill cost differing from GRN provisional cost: difference posted as a valuation-adjustment movement (value only, qty 0), applied to on-hand; if the stock has already been issued, the share related to issued quantity goes to COGS adjustment.
- Negative stock (when permitted) issues at last known average; on next receipt a revaluation adjustment corrects the average. Flagged in reconciliation report.

### 6.1 Implementation notes (Phase 5) — for CA review
- The average is updated in **posting order**, not document-date order. A back-dated posting does not revalue issues posted after it. Postings into a locked period are refused.
- Transfers are only between warehouses of **one legal entity**; goods moving to another entity are a supply that needs a tax document (Phase 7). A transfer leaves at the current average, is held in transit at that value, and arrives (or returns on cancellation) at the same value; the entity valuation does not change.
- Issuing all remaining quantity takes the whole remaining value, so quantity 0 always means value 0. An issue that the rounded average would value above what is left is capped at what is left.
- Negative stock (only with the entity override) issues at the last average, or at 0 before any receipt. The next receipt restates the remaining stock at the receipt cost and records the difference as a `revalue` movement (qty 0), journalled to cost of goods sold.

### 6.2 Journals for stock (Phase 6)
| Movement | Debit | Credit |
|---|---|---|
| Opening stock | 1300 Inventory | 3100 Opening balances |
| Adjustment or count variance, in | 1300 Inventory | 5300 Inventory adjustments |
| Adjustment or count variance, out (at average) | 5300 Inventory adjustments | 1300 Inventory |
| Negative-stock revaluation | 1300 / 5200 Cost of goods sold (by sign) | 5200 / 1300 |
| Transfer between warehouses of one entity | — (no journal) | — |

Each posting makes one journal, netted per account. The daily journal check also confirms that the Inventory account equals the stock valuation of each entity.
- Stock adjustments in default to the current average; with no average, a unit cost is required. Count variances use the current average, and the line's cost only when the item has no average yet.
- Counts compare against the on-hand figure taken when counting started; posting is refused if stock moved since (reopen refreshes it). Uncounted items are never treated as zero.

### 6.3 Sales postings (Phase 7)
| Posting | Debit | Credit |
|---|---|---|
| Tax invoice or bill of supply issued | 1200 Trade receivables (grand total); 4900 Rounding (negative round-off) | 4100 Sales (taxable value); 2210 Output CGST; 2211 Output SGST/UTGST; 2212 Output IGST; 2213 Output cess (tax charged only); 4900 Rounding (positive round-off) |
| Goods leave stock (dispatch, or the invoice when it is the stock-out point) | 5200 Cost of goods sold (at moving average) | 1300 Inventory |
| Cancelled invoice or dispatch | Mirror journal of the original (debits and credits swapped, `reversalOf` set) | |

- **Cost of goods sold is recognised at the stock-out point.** With the dispatch as stock-out point, the dispatch posts cost of goods sold and the invoice posts only the sale; there is no "dispatched, not invoiced" account. For CA review.
- **Reverse charge:** tax on reverse-charge lines is the customer's liability. It is shown on the invoice but is not output tax of the seller, so it is not journalled.
- **Cancellation** keeps the number. The original journal is reversed by a mirror journal dated like the original, so a cancellation needs that period to be open. Goods come back at exactly the value they left with (`restore` in `valuation.ts`): the paise match even when the issue was capped at what was left.
- **Partial conversions:** when a draft is made from part of an order or dispatch, amount discounts and the document discount follow the share of value carried, floored to the paisa (`carryLines`). The new draft's figures are then computed afresh.
### 6.4 Purchasing postings (Phase 8)
| Posting | Debit | Credit |
|---|---|---|
| Supplier bill posted | 1300 Inventory (stock lines cost); 5100 Purchases (non-stock lines cost); 1410 Input CGST; 1411 Input SGST/UTGST; 1412 Input IGST; 1413 Input cess (if ITC eligible); 4900 Rounding (if positive round-off) | 2100 Trade payables (grand total); 4900 Rounding (if negative round-off) |
| Direct supplier bill stock-in (when stockInPoint = 'supplier_bill') | Physical stock IN recorded via `StockLedger.post` at bill unit cost | — |
| Cancelled supplier bill | Mirror journal of the original (`reversalOf` set); stock rolled back if direct stock-in | |

### 6.5 Payments, Allocations, Refunds, Expenses, Returns, and Notes (Phase 9)
All money amounts use `Decimal128` and exact `decimal.js` domain calculations. Posting and cancellations are atomic MongoDB transactions.

#### Posting and Reversal Matrix
| Operation | Source Document | Preconditions | Debit | Credit | Receivable / Payable Effect | Stock Effect | Audit Event | Reversal Path | Transaction Boundary |
|---|---|---|---|---|---|---|---|---|---|
| **Customer receipt** | Payment (`receipt`) | Customer party; open period; valid mode/bank; exact amount | 1100 Cash / 1110 Bank | 1200 Trade receivables (allocated portion) + 2300 Customer advances (unallocated remainder) | Reduces customer outstanding / creates advance | None | `payment.posted` | Payment reversal (`reversalOf` mirror journal) | Single transaction |
| **Supplier payment** | Payment (`disbursement`) | Supplier party; open period; valid mode/bank; exact amount | 2100 Trade payables (allocated) | 1100 Cash / 1110 Bank | Reduces supplier payable | None | `payment.posted` | Payment reversal (`reversalOf` mirror journal) | Single transaction |
| **Manual / FIFO Allocation** | Allocation | Payment posted; doc posted; same party & entity; unallocated >= amount; doc outstanding >= amount | — *(No secondary cash journal: cash is moved on payment recording)* | — | Doc `outstanding` reduced; payment `unallocatedAmount` reduced | None | `payment.allocated` | Deallocation or payment reversal restores doc outstanding and payment advance | Single transaction |
| **Payment reversal** | Payment reversal | Payment posted; no active refunds; open period; reason provided | Mirror journal of original payment (Cr 1100/1110; Dr 1200/2100/2300) | Mirror journal of original payment | Restores invoice/bill `outstanding`; cancels allocations | None | `payment.reversed` | Terminal | Single transaction |
| **Customer refund** | Refund | Customer advance or unallocated receipt exists; refund <= unallocated balance; open period | 2300 Customer advances (or 1200 Trade receivables) | 1100 Cash / 1110 Bank | Decreases customer unallocated advance | None | `refund.posted` | Refund reversal (mirror journal) | Single transaction |
| **Expense** | Expense | Category `5400 Expenses`; open period; payee; optional tax with ITC eligibility | 5400 Expenses; 1410–1413 Input GST (if tax charged and ITC eligible); 4900 Rounding | 1100 Cash / 1110 Bank (if direct paid) or 2100 Trade payables (if accrued) | None or trade payable | None | `expense.posted` | Expense cancellation (mirror journal) | Single transaction |
| **Sales return & Credit note** | Credit note (`sales_return`) | Linked to issued sales invoice; return qty <= invoiced - previously returned; open period | 4100 Sales (taxable); 2210–2213 Output GST (tax reversal); 4900 Rounding | 1200 Trade receivables (reduces invoice outstanding or creates credit) | Reduces invoice receivable | Stock IN: `return_in` movement (`restore` at original issue cost) | `credit_note.issued` | Note cancellation (mirror journal + stock out reversal) | Single transaction |
| **Purchase return & Debit note** | Debit note (`purchase_return`) | Linked to posted supplier bill/receipt; return qty <= received - previously returned; open period | 2100 Trade payables (reduces bill payable) | 1300 Inventory (or 5100 Purchases); 1410–1413 Input GST (tax reversal); 4900 Rounding | Reduces supplier payable | Stock OUT: `return_out` movement (`receipt_return` at receipt cost) | `debit_note.issued` | Note cancellation (mirror journal + stock in reversal) | Single transaction |
| **Standalone price adjustment (Credit note)** | Credit note (`price_adjustment`) | Original invoice reference; reason; adjustment <= invoice value - prior credits; open period | 4100 Sales; 2210–2213 Output GST; 4900 Rounding | 1200 Trade receivables | Reduces invoice receivable | None (value only) | `credit_note.issued` | Note cancellation (mirror journal) | Single transaction |
| **Standalone price adjustment (Debit note)** | Debit note (`price_adjustment`) | Original bill reference; reason; adjustment <= bill value - prior debits; open period | 2100 Trade payables | 5100 Purchases (or 1300 Inventory); 1410–1413 Input GST; 4900 Rounding | Reduces bill payable | None (value only) | `debit_note.issued` | Note cancellation (mirror journal) | Single transaction |

## 7. Stock invariants
- `stockBalances(onHand) = Σ stockMovements(qty)` per (warehouse, item) — always; checked by the reconciliation job (`GET /stock/reconciliation`, `npm run stock:reconcile`).
- `stockBalances(inTransit)` = Σ qty of dispatched, unreceived transfers per destination; `itemValuations(qty, value)` = Σ movement qty and value per (entity, item) plus goods in transit.
- `available = onHand − reserved`; reservations never affect onHand.
- `stockBalances(reserved)` = Σ `reservedQty` of the lines of open (confirmed or partly fulfilled) sales orders per (warehouse, item); checked by the reconciliation job (Phase 7).
- Every stock-out (dispatch, invoice, transfer, adjustment) may take only what is available, plus the reservation it uses up itself: an order's dispatch can take the goods held for that order, nothing else can (unless negative stock is allowed).
- Stock moves **once** per configured stock-out / stock-in point (ADR-010).
- Movements are append-only; corrections are new reversing movements referencing the original.
- Sales returns re-enter stock at the original issue cost (`restore`), preventing phantom profit/loss on returns.
- Purchase returns leave stock at the original receipt cost (`receipt_return`), preventing inventory valuation distortions.

## 8. Journals (internal)
Every posting produces one journal with lines `{account, debit, credit, partyId?, taxComponent?}`;
Σdebit = Σcredit enforced in domain code and by a `$jsonSchema`-checked total
field plus daily reconciliation. Reversals create mirror journals; nothing is deleted.

## 9. Labels for reporting
| Shown as | Definition |
|---|---|
| Sales | Σ taxable value of issued sales invoices − credit notes in period (excl. GST) |
| Purchases | Σ taxable value of posted supplier bills − debit notes (excl. GST) |
| Receivables | Σ outstanding of issued sales invoices + debit notes − unallocated receipts/advances |
| Payables | Σ outstanding of posted supplier bills − unallocated payments/debit notes |
| Inventory value | Σ onHand × current average cost |
| Gross margin (estimate) | Sales − COGS at weighted average. Never "net profit". |

## 10. Authoritative Financial Reconciliation (Batch B)

Implemented via `ReconciliationService` (`GET /api/v1/reconciliation/financial`), protected by permission `report.financial` and tenant/legal-entity scoping.

### 10.1 Customer Receipt Settlement and Allocation Accounting Model
When an incoming customer cash receipt is posted as an advance, it credits `2300 Customer advances`:
- **Receipt Journal**: Dr 1110 Bank / 1100 Cash, Cr 2300 Customer advances.
When that advance is subsequently allocated to a sales invoice:
- **Allocation Reclassification Journal**: Dr 2300 Customer advances, Cr 1200 Trade receivables (`sourceType: 'allocation'`, `sourceId: allocation._id`).
- This reclassifies the advance liability into a settlement of the customer receivable, ensuring both GL 1200 and GL 2300 reflect true economic balances without requiring artificial reconciliation additions.
- On payment reversal, active allocation journals are mirrored (Dr 1200, Cr 2300) alongside payment reversal (Dr 2300, Cr 1110), restoring invoice outstanding and GL balances cleanly.
- For note-origin credits (`recordKind = 'credit_note_excess'`), GL 1200 was already credited at Credit Note issue time; allocations of note-origin credits do **not** post secondary journals, avoiding double-counting.

### 10.2 Revised Control Account Bridges and Subledger Formulas

| Module | GL Account(s) | GL Sign Convention | Subledger Expected Balance Formula | Included Operational Records |
|---|---|---|---|---|
| **Journal Integrity** | All active accounts | N/A (Self-balancing) | Σ Line Debits = Σ Line Credits; 1-to-1 operational document posting check | All posted `Journal` records; sales invoices, supplier bills, payments, credit/debit notes, expenses, allocations |
| **Trade Receivables (AR)** | 1200 | Net Dr (Debit − Credit) | `Σ salesInvoices.remainingBalance` (issued) − `Σ unallocatedCreditNoteExcess` | Issued `SalesInvoice`, unallocated `Payment` (`recordKind = 'credit_note_excess'`) |
| **Trade Payables (AP)** | 2100 | Net Cr (Credit − Debit) | `Σ supplierBills.remainingBalance` (posted) + `Σ accruedExpenses` − `Σ supplierDisbursementsUnallocated` − `Σ unallocatedDebitNoteExcess` | Posted `SupplierBill`, posted `Expense` (`paymentMode = 'payable'`), unallocated `Payment` (`disbursement`), unallocated `Payment` (`recordKind = 'debit_note_excess'`) |
| **Customer Advances** | 2300 | Net Cr (Credit − Debit) | `Σ unallocatedCustomerReceipts` | Posted `Payment` (`direction = 'incoming'`, `recordKind = 'payment'`, `status = 'posted'`) |
| **Inventory Valuation** | 1300 | Net Dr (Debit − Credit) | `Σ itemValuations.totalValue` | `ItemValuation` moving-average valuation records per legal entity and stock item |
| **Input Tax (ITC)** | 1410 CGST, 1411 SGST, 1412 IGST, 1413 RCM | Net Dr (Debit − Credit) | `Σ ITC-eligible bills tax` + `Σ ITC-eligible direct expenses tax` − `Σ ITC-eligible purchase return debit notes tax` | Posted `SupplierBill` (`itcEligible: true`), posted `Expense` (`itcEligible: true`), issued `DebitNote` (linked to ITC-eligible bill) |
| **Output Tax** | 2210 CGST, 2211 SGST, 2212 IGST, 2213 Cess | Net Cr (Credit − Debit) | `Σ issued invoices tax` − `Σ sales return credit notes tax` | Issued `SalesInvoice`, issued `CreditNote` |

### 10.3 Purchase Return Tax Treatment
- Purchase returns (Debit Notes) reduce input tax accounts (1410–1413) **only** when the underlying supplier bill was ITC-eligible.
- When an inward supply was ITC-ineligible (`itcEligible: false`), the original purchase and its return credit gross cost (1300 or 5100), not input tax. The reconciliation verifies the linked bill's ITC status and avoids incorrect deductions.
- Unsupported or manual postings on tax accounts are surfaced in reconciliation diagnostics.

### 10.4 Date Policy and Runtime Bounds
- **Closed Historical Periods**: Direct edits or mirror reversals of postings dated in a locked period are strictly prevented by the period-lock guard.
- **Linked Current-Period Corrections**: Linked commercial adjustment documents (Credit Notes, Debit Notes) can reference historical documents while being dated and posted in an open current period.
- **Application Runtime Bounds**: Reconciliation requests enforce an application-level timeout (15,000 ms). An interrupted or timed-out execution yields status `INCOMPLETE`, never `MATCHED`.
- **Historical Retrospective Mode**: Retrospective reconciliation at past dates is unsupported (`mode === 'historical'` returns `UNSUPPORTED`) because mutable in-place fields reflect current balances. Point-in-time reconstruction would require period balance snapshots or historical roll-ups.
- **Empty Dataset**: Returns status `INCOMPLETE` (`emptyDataset: true`), never `MATCHED`.



