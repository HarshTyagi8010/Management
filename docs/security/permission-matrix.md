# Permission Matrix (system roles — tenant-cloneable)

Status: v0.2 · 2026-10-19 (Phase 3). Legend: ● granted · ○ not granted.
Every permission is checked on the server. The code copy lives in
`packages/contracts/src/permissions.ts`; `permissions.test.ts` parses this table and fails if the two disagree.

Changes from v0.1: each permission now has its own row (v0.1 combined some, e.g. `quotation.edit / .issue`), and the
read-only "R" cells became separate view permissions: `settings.view` (Auditor's read access to company and workflow
settings), `tax.view` (Auditor's read access to tax setup) and `party.view_basic` (Storekeeper's name/address-only access).
Holders of the matching edit permission also hold the view permission.

Role assignments can be limited to chosen legal entities (Phase 4) and warehouses (Phase 5); see the notes below.

| Permission | Owner | Admin | Accountant | Sales | Storekeeper | Purchase | Auditor |
|---|---|---|---|---|---|---|---|
| `tenant.manage` (billing, delete tenant) | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| `users.manage` (invite, disable, revoke sessions) | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `roles.manage` | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `settings.view` (read company, GST and workflow settings) | ● | ● | ○ | ○ | ○ | ○ | ● |
| `settings.company` (entity, GST registrations, series) | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `settings.workflow` (stock points, negative stock) | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `period.lock` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `period.unlock` | ● | ○ | ○ | ○ | ○ | ○ | ○ |
| `audit.view` | ● | ● | ● | ○ | ○ | ○ | ● |
| `party.view_basic` (name and address only) | ● | ● | ● | ● | ● | ● | ● |
| `party.view` | ● | ● | ● | ● | ○ | ● | ● |
| `party.edit` | ● | ● | ● | ● | ○ | ● | ○ |
| `crm.tasks` | ● | ● | ● | ● | ○ | ● | ○ |
| `item.view` | ● | ● | ● | ● | ● | ● | ● |
| `item.edit` | ● | ● | ● | ○ | ○ | ● | ○ |
| `price.edit` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `price.view_cost` | ● | ● | ● | ○ | ○ | ● | ● |
| `tax.view` (read tax classes and rate schedules) | ● | ● | ● | ○ | ○ | ○ | ● |
| `tax.manage` (tax classes, rate schedules) | ● | ● | ● | ○ | ○ | ○ | ○ |
| `stock.view` | ● | ● | ● | ● | ● | ● | ● |
| `stock.move` (transfers, GRN, dispatch) | ● | ● | ○ | ○ | ● | ● | ○ |
| `stock.adjust` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `stock.count.post` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `quotation.edit` | ● | ● | ● | ● | ○ | ○ | ○ |
| `quotation.issue` | ● | ● | ● | ● | ○ | ○ | ○ |
| `salesorder.edit` | ● | ● | ● | ● | ○ | ○ | ○ |
| `salesorder.confirm` | ● | ● | ● | ● | ○ | ○ | ○ |
| `salesorder.cancel` | ● | ● | ● | ● | ○ | ○ | ○ |
| `dispatch.post` | ● | ● | ○ | ○ | ● | ○ | ○ |
| `invoice.edit` (draft) | ● | ● | ● | ● | ○ | ○ | ○ |
| `invoice.issue` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `invoice.cancel` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `purchase.edit` | ● | ● | ● | ○ | ○ | ● | ○ |
| `purchase.issue` | ● | ● | ● | ○ | ○ | ● | ○ |
| `bill.post` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `bill.cancel` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `receipt.post` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `payment.post` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `allocation.manage` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `expense.post` | ● | ● | ● | ○ | ○ | ○ | ○ |
| `note.issue` (credit/debit notes, returns) | ● | ● | ● | ○ | ○ | ○ | ○ |
| `discount.override` (beyond limit) | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `credit.override` | ● | ● | ○ | ○ | ○ | ○ | ○ |
| `document.download` (Sales: own scope; Storekeeper: challans) | ● | ● | ● | ● | ● | ● | ● |
| `report.financial` (registers, ledgers, GST, margin) | ● | ● | ● | ○ | ○ | ○ | ● |
| `report.sales` (own sales, outstanding) | ● | ● | ● | ● | ○ | ○ | ● |
| `export.csv` | ● | ● | ● | ○ | ○ | ○ | ● |
| `regulatory.manage` (e-invoice credentials, mode) | ● | ○ | ○ | ○ | ○ | ○ | ○ |

`invoice.issue` is not granted to Sales by default. Many small businesses let sales staff issue invoices, so a tenant can clone the Sales role and add it.

**Step-up MFA** is required for `users.manage`, `roles.manage`, `period.unlock`, `regulatory.manage` and `tenant.manage`.
- A user with MFA enabled must have verified a code within the last 15 minutes.
- When `MFA_ENFORCEMENT=privileged` (the production default), a user without MFA must enrol before using these permissions.

**Phase 4 notes:**
- `GET /tax-classes` is also allowed to `item.edit`, because whoever edits items must pick a tax class. Listing classes and rates reveals no more than the item form needs.
- With only `party.view_basic` (the Storekeeper default), party responses contain only name, legal name, roles and addresses. Search by GSTIN or phone is turned off for these users.
- Without `price.view_cost`, item responses omit `purchasePrice` altogether rather than blanking it (FR-RBAC-04). Changing either price needs `price.edit`.
- **Entity scope:** an assignment can be limited to chosen legal entities. Creating a new entity needs `settings.company` for every entity. The Owner role is never limited.

**Phase 5 notes:**
- **Warehouse scope:** an assignment can also be limited to chosen warehouses, which must belong to its entities. Stock figures and stock commands check the permission in the specific warehouse; entity-level permissions (settings, parties, items) ignore the warehouse scope. The Owner role is never limited.
- Warehouse names are listed to anyone working in the entity (`GET /warehouses` needs any stock or settings permission), so a storekeeper can pick the destination of a transfer. Creating and editing warehouses needs `settings.company`.
- Transfers: create, edit, dispatch and cancel need `stock.move` at the source; receive needs `stock.move` at the destination. A transfer is visible from either end.
- Opening stock and adjustments need `stock.adjust`. Counts can be planned, counted, submitted, reopened and cancelled with `stock.move` or `stock.count.post`; posting needs `stock.count.post`. Entering costs on a count needs `price.view_cost`.
- `GET /stock/valuation` also needs `price.view_cost` and `stock.view` in every warehouse of the entity. Without `price.view_cost`, costs and values are omitted from every stock response (FR-RBAC-04).
- `GET /stock/reconciliation` needs `stock.adjust` or `report.financial`.

**Phase 6 notes:**
- `POST /calc/preview` is open to anyone who prepares sales or purchase documents (`invoice.edit`, `quotation.edit`, `salesorder.edit`, `purchase.edit`). It computes figures; it saves nothing.
- Accounts, journals and the trial balance need `report.financial` in the entity. `GET /integrity-checks` needs `stock.adjust` or `report.financial`.
- Period locks: moving the lock date forward needs `period.lock`. Moving it back or removing it needs `period.unlock` plus a recent two-step verification. Both need a reason, which is kept in the audit log.
- Transfer notes (PDF) need `document.download` and a transfer the caller can see.

**Phase 7 notes (order to cash):**
- **Viewing** a document needs one of these in its business entity. A missing one, or another business's, is "not found":
  - Quotations: `quotation.edit`, `quotation.issue`, `report.sales` or `report.financial`.
  - Sales orders: `salesorder.*`, `dispatch.post`, `invoice.edit`, `report.sales` or `report.financial`.
  - Dispatches: `dispatch.post`, `salesorder.edit`, `invoice.edit`, `report.sales` or `report.financial`.
  - Invoices: `invoice.*`, `report.sales` or `report.financial`.
- **Prices and amounts** are shown only to holders of a selling or reporting permission (`quotation.*`, `salesorder.*`, `invoice.*`, `report.sales`, `report.financial`). A storekeeper sees dispatches and orders with quantities only. Dispatch lines may be saved without prices, and the server keeps the order's or draft's price. Line costs (cost of goods sold) need `price.view_cost`.
- **Actions:**
  - Quotations: draft, accept, reject, revise and convert need `quotation.edit`; send (number) needs `quotation.issue`. Converting also needs `salesorder.edit` or `invoice.edit`.
  - Sales orders: drafts need `salesorder.edit`, confirm needs `salesorder.confirm`, cancel and short-close need `salesorder.cancel`.
  - Dispatches need `dispatch.post` in the warehouse.
  - Invoices: drafts need `invoice.edit`, issue needs `invoice.issue`, cancel needs `invoice.cancel`. When the invoice is the stock-out point, issuing also needs `invoice.issue` in the warehouse the goods leave from. Confirming an order checks `salesorder.confirm` in its warehouse.
  - Making a dispatch from an order needs `dispatch.post`; making an invoice from an order or dispatch needs `invoice.edit`.
- **Credit limit (FR-SAL-08):** confirming an order or issuing an invoice beyond the customer's limit needs `credit.override` and an explicit approval in the request. The override is recorded in the audit entry.
- **Receivables** (`GET /receivables`) need `report.sales` or `report.financial` in the entity. "Own sales only" for the Sales role is not modelled yet: Sales sees the entity's receivables.
- **Logo upload** needs `settings.company`. **PDFs** of quotations, challans and invoices need `document.download` and access to the document.
- `discount.override` is not used yet: there is no discount limit setting.

**Escalation guard:** a user can only create or edit roles, and assign roles, whose permissions they hold themselves, within their own entity and warehouse scope (a warehouse-limited administrator can only grant access to their warehouses). Assigning the Owner role needs `tenant.manage`.

**Test obligation:**
- The matrix suite checks every system role against every implemented endpoint, expecting 403 where a permission is missing.
- Rows for modules that aren't built yet get endpoint coverage when their module lands (see `docs/requirements/traceability.md`).
