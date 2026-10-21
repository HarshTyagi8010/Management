# Product Brief and Software Requirements Specification

Status: **Draft v0.1 — awaiting product-owner review** · Last updated: 2026-10-19

This document consolidates the product brief, scope, personas, functional and
non-functional requirements, and acceptance criteria. Requirement IDs are
referenced from [traceability.md](traceability.md), the backlog, and tests.

---

## 1. Product brief

### 1.1 Problem
Indian SMEs in distribution, wholesale, dealership, workshop, retail/trading and
services commonly run on a mix of spreadsheets, a desktop accounting package, and
WhatsApp. Typical pain points:

- Stock on paper does not match stock in the godown; no reliable per-warehouse view.
- Invoices are produced without consistent GST particulars (HSN/SAC digits,
  place of supply, tax split), creating rework at return-filing time.
- Receivables follow-up is manual; nobody knows which invoices a receipt settled.
- Several staff share one login; nobody can tell who changed a price or deleted a bill.

### 1.2 Product goal
A secure, multi-user, browser-based system that covers the **order-to-cash** and
**procure-to-pay** cycles with GST-aware documents, warehouse inventory, party
balances, and an auditable history — usable on desktop and on a phone at the
counter or in the field.

### 1.3 Product principles
1. **Correct before clever.** Money, tax and stock are computed deterministically
   on the server with decimal arithmetic. Dashboards are views, never the source of truth.
2. **Issued means immutable.** Issued financial documents are never edited or
   deleted; they are reversed or adjusted through controlled documents.
3. **Explicit compliance boundaries.** The product states what GST scenarios it
   supports. It does not simulate regulatory success.
4. **Least privilege by default.** Every operation is authorized on the server
   against tenant, legal entity and permission.
5. **Operable by a small team.** Modular monolith + one worker; no microservices.

### 1.4 Non-goals for the initial product
Full manufacturing ERP, BOM/production planning, WIP, payroll, advanced job-work
accounting, autonomous AI agents, microservices, a separate admin application,
GST return **filing** (GSTR-1/3B upload), statutory financial statements
(P&L/Balance Sheet presented as audited statements), TDS/TCS computation,
multi-currency invoicing, POS hardware integration. See
[../planning/roadmap.md](../planning/roadmap.md) §Deferred.

---

## 2. Personas and supported business scenarios

| Persona | Typical user | Primary goals | Key permissions |
|---|---|---|---|
| **Owner / Admin** | Proprietor or partner | See cash, receivables, stock value; control users; approve discounts | All, incl. settings, users, period locks |
| **Accountant** | In-house or part-time CA staff | Accurate invoices, purchase bills, payments, GST summaries | Finance documents, reports, period lock (if granted) |
| **Sales executive** | Field / counter sales | Quotations, orders, customer follow-up | Customers, quotations, orders; invoices if granted; no cost price |
| **Storekeeper** | Godown staff | Receive, dispatch, transfer, count stock | Inventory movements, GRN, dispatch; no prices by default |
| **Purchase officer** | Buyer | POs, supplier bills | Suppliers, POs, GRNs, bills |
| **Auditor (read-only)** | External CA | Review records and audit log | Read-only across modules |

### Supported scenarios (MVP)
- **S1 Distributor/wholesaler:** quotation → sales order → dispatch (stock out) → tax invoice → receipt allocation; multiple warehouses; inter-warehouse transfers.
- **S2 Dealer/retailer:** direct tax invoice or bill of supply from counter with stock deduction at invoice; B2C and B2B customers; cash/UPI/bank receipts.
- **S3 Workshop/service company:** service items (SAC), parts consumption from stock, invoice combining goods and services, advance receipts.
- **S4 Purchasing:** PO → goods receipt (stock in) → supplier bill → payment; or direct supplier bill with stock receipt.
- **S5 Returns:** sales return with credit note; purchase return with debit note; stock reversal at the original valuation.
- **S6 Multi-GSTIN:** one legal entity (PAN) with GST registrations in more than one state, each with its own document series.

Scenarios explicitly **not** supported in MVP are listed in
[../compliance/gst.md](../compliance/gst.md) §3.

---

## 3. Scope

### 3.1 MVP (initial release)
| Module | Included |
|---|---|
| Platform | Tenants, legal entities, GST registrations, branches; users, roles, configurable permissions; sessions; audit log |
| Masters | Customers, suppliers (parties, with multiple addresses/GSTINs), products, services, categories, units & conversions, tax classifications (HSN/SAC + tenant-configured rate schedules with effective dates), price lists |
| Inventory | Warehouses, opening stock, append-only stock movements, reservations (from sales orders), transfers, adjustments, stock counts, moving weighted-average valuation, reconciliation |
| Sales | Quotations, proforma invoices, sales orders, dispatches/delivery challans (optional workflow), tax invoices, bills of supply, receivables |
| Purchasing | Purchase orders, goods receipts (optional workflow), supplier bills, payables |
| Money | Receipts, payments, allocations against documents, advances, refunds, expenses |
| Adjustments | Sales returns, purchase returns, credit notes, debit notes |
| Documents | Versioned PDF templates for all document types in §FR-DOC; private storage; authorized download |
| Reporting | Dashboard, sales/purchase registers, outstanding & ageing, stock summary & ledger, party ledger, GST summary (HSN-wise, rate-wise, B2B/B2C), CSV export |
| Accounting core | Internal balanced journals for every posted document against a system chart of accounts; trial balance (internal) |

### 3.2 Deferred (recorded in roadmap)
E-invoice IRP integration (interface + disabled state ship in MVP), e-way bill
integration (same), GSTR-1 JSON export, bank-statement import & reconciliation,
FIFO/batch/serial valuation, batch & expiry tracking, payment gateway links,
WhatsApp/email delivery automation beyond basic email, optional AI insights,
mobile native apps, Tally export, multi-currency, TDS/TCS.

---

## 4. Functional requirements

Priority: **M** = must (MVP), **S** = should (MVP if time permits), **C** = could (deferred).

### 4.1 Platform, identity and access (FR-AUTH, FR-TEN, FR-RBAC)
| ID | Requirement | P |
|---|---|---|
| FR-AUTH-01 | Users sign in with email + password; passwords hashed with Argon2id. | M |
| FR-AUTH-02 | Session is an opaque random token in an HTTP-only, Secure, SameSite cookie; no tokens in localStorage. | M |
| FR-AUTH-03 | Session rotates on sign-in and privilege change; idle (default 30 min) and absolute (default 12 h) expiry. | M |
| FR-AUTH-04 | Users can sign out; admins can revoke any session of a user in their tenant. | M |
| FR-AUTH-05 | Login throttling per account and per IP with progressive delay; generic failure messages. | M |
| FR-AUTH-06 | TOTP MFA available to all users and enforceable per role (default: required for Owner/Admin before production). | M |
| FR-AUTH-07 | Password reset via single-use, time-limited token delivered by email; all sessions revoked on reset. | M |
| FR-AUTH-08 | Invite flow: admin invites by email; invitee sets password; membership created on acceptance. | M |
| FR-TEN-01 | A tenant holds one or more legal entities (PAN-level businesses); each holds one or more GST registrations and branches. | M |
| FR-TEN-02 | A user may be a member of multiple tenants; each request operates in exactly one tenant + legal-entity context validated against membership. | M |
| FR-TEN-03 | No API returns or mutates data outside the caller's validated tenant and permitted legal entities. | M |
| FR-RBAC-01 | Roles are tenant-configurable sets of permissions; system roles (Owner, Admin, Accountant, Sales, Storekeeper, Purchase, Auditor) are seeded and cloneable. | M |
| FR-RBAC-02 | Permissions are action-level (`invoice.issue`, `invoice.cancel`, `stock.adjust`, `price.view_cost` …) per [permission matrix](../security/permission-matrix.md). | M |
| FR-RBAC-03 | Role assignments may be restricted to specific legal entities and warehouses. | M |
| FR-RBAC-04 | Field-level restriction: cost price and margin hidden unless `price.view_cost`. | M |
| FR-AUD-01 | Sensitive actions (auth events, permission changes, document issue/cancel, settings, period locks, price changes) are written to an append-only audit log with actor, time, IP, before/after diff (PII-minimized). | M |

### 4.2 Company and settings (FR-CO)
| ID | Requirement | P |
|---|---|---|
| FR-CO-01 | Legal entity: legal name, trade name, PAN, constitution, address, logo, bank accounts, financial-year start (default 1 April). | M |
| FR-CO-02 | GST registration: GSTIN (format + checksum validated), state code, registration type (regular / composition / unregistered), effective dates, address of principal place. | M |
| FR-CO-03 | Document series per registration, document type and financial year, with prefix and configurable padding; max 16 characters total (see compliance doc). | M |
| FR-CO-04 | Workflow settings per legal entity: stock-out point (`dispatch` or `invoice`), stock-in point (`goods_receipt` or `supplier_bill`). Changeable only when no open documents depend on it. | M |
| FR-CO-05 | Posting-period locks per legal entity: no posting dated on or before the lock date. | M |
| FR-CO-06 | Aggregate-turnover band setting (declared by the user) used to drive HSN digit validation and e-invoice applicability warnings. | M |

### 4.3 Parties (FR-PTY)
| ID | Requirement | P |
|---|---|---|
| FR-PTY-01 | Party with role flags customer/supplier; contacts; billing & shipping addresses with state; zero or more GSTINs; PAN; credit limit & terms. | M |
| FR-PTY-02 | Duplicate detection on GSTIN, PAN, phone within a tenant. | M |
| FR-PTY-03 | Party ledger and outstanding balance derived from posted documents. | M |
| FR-PTY-04 | CRM: notes, follow-up tasks with due dates and assignee; activity timeline per party. | M |
| FR-PTY-05 | Party may be archived, never hard-deleted once referenced. | M |

### 4.4 Catalogue (FR-CAT)
| ID | Requirement | P |
|---|---|---|
| FR-CAT-01 | Item types: stock goods, non-stock goods, service. | M |
| FR-CAT-02 | SKU, name, category, base unit, alternate units with exact conversion factors, HSN/SAC code, tax classification, sale/purchase price, reorder level. | M |
| FR-CAT-03 | Tax classification maps to a tenant-maintained rate schedule with effective-from dates; the product ships **no** hard-coded rates. | M |
| FR-CAT-04 | Price lists per customer group with validity dates. | S |
| FR-CAT-05 | Bulk import via CSV with validation report (no partial silent import). | S |

### 4.5 Inventory (FR-INV)
| ID | Requirement | P |
|---|---|---|
| FR-INV-01 | Warehouses per legal entity (optionally linked to a branch/registration). | M |
| FR-INV-02 | Opening stock entry per item/warehouse with cost, dated at go-live. | M |
| FR-INV-03 | Every stock change is an append-only movement with source-document reference; balances updated in the same transaction. | M |
| FR-INV-04 | Negative stock blocked by default; per-legal-entity override with audit. | M |
| FR-INV-05 | Reservations from confirmed sales orders reduce available (not on-hand) quantity. | M |
| FR-INV-06 | Transfers between warehouses: dispatch-from and receive-into steps; in-transit quantity tracked. | M |
| FR-INV-07 | Adjustments (damage, count variance) require reason and `stock.adjust`. | M |
| FR-INV-08 | Moving weighted-average cost per item per legal entity; valuation report. | M |
| FR-INV-09 | Reconciliation job recomputes balances from movements and reports drift. | M |
| FR-INV-10 | Stock deducted exactly once per configured stock-out point; received exactly once per stock-in point. | M |

### 4.6 Sales (FR-SAL)
| ID | Requirement | P |
|---|---|---|
| FR-SAL-01 | Quotation: draft → sent → accepted/rejected/expired; convert to order or invoice. | M |
| FR-SAL-02 | Proforma invoice (non-tax document, no posting). | M |
| FR-SAL-03 | Sales order: draft → confirmed (reserves stock) → partially/fully fulfilled → closed/cancelled. | M |
| FR-SAL-04 | Dispatch / delivery challan (when stock-out = dispatch): deducts stock; references order lines. | M |
| FR-SAL-05 | Tax invoice / bill of supply: draft → issued (number assigned, snapshot frozen, journal posted) → cancelled (reversal) — no edits after issue. | M |
| FR-SAL-06 | Place of supply determined per documented rules for supported scenarios, defaulting from ship-to and allowing an audited override; intra- vs inter-state tax split derived from supplier state vs place of supply. | M |
| FR-SAL-07 | Line discounts and document-level discount allocated deterministically to lines before tax. | M |
| FR-SAL-08 | Credit-limit check on order confirm / invoice issue with override permission. | S |
| FR-SAL-09 | Receivables: outstanding per invoice, ageing buckets, follow-up calendar. | M |

### 4.7 Purchasing (FR-PUR)
| ID | Requirement | P |
|---|---|---|
| FR-PUR-01 | Purchase order lifecycle mirrors sales order. | M |
| FR-PUR-02 | Goods receipt (when stock-in = goods_receipt): adds stock at PO cost provisional; cost finalized by supplier bill. | M |
| FR-PUR-03 | Supplier bill records supplier's invoice number/date (unique per supplier), tax as charged, eligibility flag for ITC (user-declared). | M |
| FR-PUR-04 | Reverse-charge flag only for explicitly configured categories — never inferred from supplier being unregistered. | M |
| FR-PUR-05 | Payables with ageing. | M |

### 4.8 Payments and adjustments (FR-PAY, FR-ADJ)
| ID | Requirement | P |
|---|---|---|
| FR-PAY-01 | Receipts and payments with mode (cash, bank transfer, UPI, cheque, card), reference, bank account. | M |
| FR-PAY-02 | Allocation of a receipt/payment across documents; total allocated ≤ amount; per-document allocation ≤ outstanding. | M |
| FR-PAY-03 | Unallocated remainder held as advance on the party. | M |
| FR-PAY-04 | Refunds of advances/credit notes. | M |
| FR-PAY-05 | Expenses with category, payee, tax (optional), attachment. | M |
| FR-ADJ-01 | Sales return linked to the original invoice; issues credit note; reverses stock at original issue cost. | M |
| FR-ADJ-02 | Purchase return with debit note; reverses stock at receipt cost. | M |
| FR-ADJ-03 | Standalone credit/debit notes for price/value adjustments (no stock). | M |
| FR-ADJ-04 | Cancelling an issued document creates a reversal journal; the number is retained and marked cancelled. | M |

### 4.9 Documents (FR-DOC)
| ID | Requirement | P |
|---|---|---|
| FR-DOC-01 | PDFs for invoice, bill of supply, quotation, proforma, purchase order, payment receipt, delivery challan, credit note, debit note, party statement. | M |
| FR-DOC-02 | Templates are versioned; an issued document records the template version used; the original PDF is preserved. | M |
| FR-DOC-03 | Rendering runs in the worker via outbox; status visible (pending/ready/failed) with retry. | M |
| FR-DOC-04 | Files stored privately; downloads require permission and are served via short-lived authorization. | M |
| FR-DOC-05 | Multi-page documents repeat table headers and carry page x/y; totals only on last page. | M |

### 4.10 Dashboard and reports (FR-RPT)
| ID | Requirement | P |
|---|---|---|
| FR-RPT-01 | Dashboard KPIs: sales (period), purchases (period), receivables outstanding, payables outstanding, inventory value — each labelled with its definition and as-of time. | M |
| FR-RPT-02 | Sales vs purchases chart by month; top customers/products. | M |
| FR-RPT-03 | Follow-up calendar: receivable due dates, PO expected dates, tasks. | M |
| FR-RPT-04 | Recent activity feed from the audit/business-event stream (permission-filtered). | M |
| FR-RPT-05 | Registers, outstanding/ageing, stock summary/ledger, party ledger, GST summary; CSV export. | M |
| FR-RPT-06 | "Sales minus purchases" is never labelled profit; a gross-margin estimate (sales − COGS at weighted average) is labelled as an estimate. | M |

---

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-SEC-01 | Security | OWASP ASVS v4.0.3 Level 2 as the target baseline for applicable controls. |
| NFR-SEC-02 | Security | All authorization enforced server-side; frontend guards are UX only. |
| NFR-SEC-03 | Security | No secrets in repository or frontend bundle; managed secrets in deployment. |
| NFR-DAT-01 | Data integrity | Money as decimal; API uses decimal strings; database uses Decimal128. |
| NFR-DAT-02 | Data integrity | Multi-document financial/stock writes are atomic (MongoDB transactions, majority write concern). |
| NFR-DAT-03 | Data integrity | Issued document numbers unique per series and never reused. |
| NFR-PERF-01 | Performance | p95 API latency < 300 ms for list/detail at 50 concurrent users per tenant with 100k documents; invoice issue p95 < 1 s (excluding PDF). |
| NFR-PERF-02 | Performance | Dashboard first contentful paint < 2.5 s on a mid-range phone over 4G (Lighthouse mobile profile). |
| NFR-AVL-01 | Availability | 99.5 % monthly target for pilot; RPO ≤ 1 h (Atlas continuous backup), RTO ≤ 4 h. |
| NFR-A11Y-01 | Accessibility | WCAG 2.2 AA for all core flows; full keyboard operation. |
| NFR-RESP-01 | Responsive | Usable at 360 px, 768 px, 1280 px and ≥ 1440 px widths. |
| NFR-BRW-01 | Browsers | Latest two versions of Chrome, Edge, Firefox, Safari; minimum Safari 16.4 / Chrome 111 / Firefox 128 (Tailwind CSS v4 baseline). |
| NFR-I18N-01 | Locale | Indian number grouping (en-IN), ₹ symbol, DD-MM-YYYY display, IST business dates; English UI with strings externalized for later Hindi/regional locales. |
| NFR-OBS-01 | Observability | Structured JSON logs with request IDs; no PII/secrets in logs; health and readiness endpoints. |
| NFR-MNT-01 | Maintainability | TypeScript strict; module boundaries enforced; tests in CI. |
| NFR-PRV-01 | Privacy | Aligned with the Digital Personal Data Protection Act, 2023 and its Rules as applicable (legal review required — see compliance doc). |

---

## 6. Acceptance criteria (selected, testable)

Each acceptance criterion maps to automated tests (see traceability).

- **AC-AUTH-1:** Given 5 failed logins for one account within 15 min, the 6th attempt is delayed/blocked and the response is indistinguishable from a wrong password.
- **AC-AUTH-2:** A session cookie is `HttpOnly; Secure; SameSite=Lax` (Strict for the auth cookie where flows allow), path `/`, and absent from any JS-readable storage.
- **AC-AUTH-3:** A state-changing request without a valid CSRF token returns 403 `CSRF_INVALID`.
- **AC-TEN-1:** User A (tenant T1) requesting any resource ID belonging to T2 receives 404 — never 403 that confirms existence — and no T2 data appears in any list.
- **AC-RBAC-1:** For every row of the permission matrix, a user lacking the permission receives 403 on the API, regardless of UI state.
- **AC-INV-1:** Two concurrent dispatches of the last 5 units each requesting 5 result in exactly one success when negative stock is disallowed.
- **AC-INV-2:** After any sequence of movements, the reconciliation job reports zero drift between movement sums and balances.
- **AC-NUM-1:** 100 concurrent invoice issues on one series produce 100 distinct, gap-free consecutive numbers; a failed issue does not consume a number.
- **AC-IDEM-1:** Repeating an issue request with the same idempotency key and identical body returns the original result; same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`.
- **AC-CALC-1:** Fixture suite of invoice calculations (discounts, mixed rates, cess, inter/intra-state, rounding) matches expected decimal outputs exactly.
- **AC-PAY-1:** Allocations exceeding a document's outstanding or the receipt's unallocated amount are rejected atomically.
- **AC-DOC-1:** An issued invoice's PDF re-downloaded after master data changes is byte-identical to the original.
- **AC-JRN-1:** Every posted journal has Σdebit = Σcredit; a database-level reconciliation report confirms it daily.
- **AC-UI-1:** Dashboard renders without horizontal scroll at 360 px; all interactive elements reachable by keyboard with visible focus.
