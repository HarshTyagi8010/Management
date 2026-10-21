# Architecture Decision Records

Format: Context → Decision → Consequences → Status. Versions were checked
against the npm registry and nodejs.org on **2026-10-19**
(see [../compliance/gst.md §7](../compliance/gst.md#7-official-source-register) for regulatory sources).

---

## ADR-001 Modular monolith + worker, npm workspaces
**Context.** Small team, transactional consistency across sales/inventory/ledger, one product.
**Decision.** One API process (`apps/api`), one worker (`apps/worker`), one SPA (`apps/web`), shared `packages/*`. npm workspaces (npm 10 is installed; pnpm is not installed and global installation is prohibited by the workspace rules).
**Consequences.** Simple deploy and atomic transactions; module boundaries enforced by convention + lint rules rather than network. Revisit pnpm if install performance becomes a problem (can be added project-locally via `corepack`, which itself writes outside the project — deferred).
**Status.** Accepted.

## ADR-002 Database: MongoDB (retained) vs PostgreSQL
**Context.** The scope includes GST documents, stock ledgers, allocations and internal balanced journals. These are relational, constraint-heavy workloads.

| Criterion | PostgreSQL | MongoDB (Atlas, replica set) |
|---|---|---|
| Multi-entity ACID transactions | Native, mature, serializable available | Supported on replica sets since 4.0; 60 s default limit; must be designed for |
| Exact decimals | `numeric` | `Decimal128` (34 digits) |
| Declarative integrity (FK, CHECK) | Yes | No FKs; `$jsonSchema` validators + unique indexes only |
| Reporting / joins | SQL, window functions | Aggregation pipeline; workable, more verbose |
| Flexible document snapshots | `jsonb` | Native |
| Team/stack fit (brief specifies MongoDB + Mongoose) | Change required | As specified |
| Managed ops in India region | RDS/Aurora Mumbai | Atlas on AWS Mumbai |

**Assessment.** PostgreSQL is the stronger technical fit for accounting integrity. MongoDB is *adequate* if: every financial write runs in a transaction with majority write concern; `Decimal128` everywhere for money/quantity; unique indexes for numbering and idempotency; collection `$jsonSchema` validators on financial collections; append-only collections for movements, journals, audit; daily reconciliation jobs that prove balances = Σ movements and Σdebit = Σcredit.
**Decision.** **Retain MongoDB** with the mitigations above as non-negotiable engineering rules. Do not introduce a second database.
**Revisit trigger.** If the product moves into full statutory accounting (financial statements, TDS, multi-currency) or reconciliation drift is found in pilot, re-evaluate a migration to PostgreSQL before GA.
**Status.** Accepted — **flagged for product-owner confirmation** (critical decision).

## ADR-003 Decimal arithmetic
**Decision.** `decimal.js` (10.6.x) in `packages/domain` for all authoritative money/quantity/tax maths; decimal strings at API boundaries (`"1234.50"`), `Decimal128` in MongoDB. JavaScript `number` is forbidden for money (lint rule + code review). Precision policy in [financial-policy.md](financial-policy.md).
**Status.** Accepted (implemented in Phase 6; contract schema in Phase 1).

## ADR-004 Sessions
**Decision.** Server-side sessions. Cookie holds a 256-bit random token; DB stores only its SHA-256 hash with userId, createdAt, lastSeenAt, absolute/idle expiry, IP/UA hints, MFA level. Cookie `__Host-sid` (`Secure; HttpOnly; SameSite=Strict; Path=/`; Strict chosen in Phase 3 because the SPA calls a same-origin API). CSRF via synchronizer token bound to the session, sent in `X-CSRF-Token`, plus Origin check. No JWT in browser. No Redis initially — session lookups are indexed by hash; add a cache only if measured latency demands it.
**Status.** Accepted (Phase 3).

## ADR-005 One queue strategy: MongoDB transactional outbox
**Decision.** Outbox rows written in the business transaction; worker polls with leases. No BullMQ/SQS/Redis queue in MVP. If throughput later demands, the outbox relays into exactly one external queue (SQS) — still single strategy.
**Implementation (Phase 6).** The job code (outbox consumer, document rendering, scheduled jobs) lives in `apps/api/src/jobs` because it needs the API's models and services; `apps/worker` is the process that hosts it (`@bizmgmt/api/jobs`). Scheduled jobs take a lock document whose `lockedUntil` is the lease while running and "not before" afterwards.
**Status.** Accepted, implemented (Phase 6).

## ADR-006 PDF generation
**Options.** (a) Headless Chromium HTML→PDF — high fidelity but heavy, browser-sandbox and SSRF concerns, large container. (b) Programmatic (pdfmake 0.3.x / pdfkit 0.20.x) — no network fetching, deterministic, repeatable table headers (pdfmake), smaller footprint.
**Decision.** pdfmake **0.3.11** in the worker with bundled **Noto Sans** (SIL OFL 1.1, includes ₹ U+20B9; TTFs from `@expo-google-fonts/noto-sans` 0.4.2). Templates are versioned code modules; generated PDFs are stored and never regenerated for the original.
**Spike result (2026-10-20, `apps/api/src/pdf/render.test.ts`, kept as a regression suite).**
- Page breaks: 1 line → 1 page, 30 lines → ≤ 2 pages, 200 lines → 6 pages; 11–37 kB; under a second each on the development machine.
- The table header repeats on every page (checked by comparing text runs with and without `headerRows`).
- Noto Sans regular and bold contain U+20B9 and are embedded (`/FontFile2`).
- The same input renders byte-identical output, because the creation date comes from the document.
- Rendering refuses every URL and reads only the two font files (`setUrlAccessPolicy`, `setLocalAccessPolicy`), so document content cannot reach the network or the file system.
- Not done: visual review by a person of a printed page.
**Status.** Accepted (Phase 6).

## ADR-007 Password hashing
**Decision.** `argon2` (node-argon2, 0.45.x, prebuilt N-API binaries) with Argon2id. Phase 3 benchmark on the development machine: m=19 MiB/t=2 ≈ 34 ms, m=64 MiB/t=2 ≈ 124 ms, m=64 MiB/t=3 ≈ 172 ms. **Chosen: m=64 MiB, t=2, p=1** with a concurrency cap of 4; re-benchmark on production hardware (target ≈ 100–300 ms). Pepper not used initially (managed-secret rotation complexity); revisit.
**Status.** Accepted (Phase 3).

## ADR-008 Toolchain versions (verified 2026-10-19)
| Tool | Chosen | Latest seen | Reason |
|---|---|---|---|
| Node.js | 24 LTS for production (Active LTS → Maintenance 2026-10-20, EOL 2028-04-30); local dev on installed 22.22 (Maintenance LTS, EOL 2027-04-30) | 26.12 (becomes LTS 2026-10-28) | Supported LTS; plan move to Node 26 LTS after 2026-10-28 once dependencies confirm support. `engines: >=22.12 <27` |
| TypeScript | **6.0.x** | 7.0.2 | TS 7 (native compiler) released very recently; typescript-eslint and other tooling compatibility unverified. Re-evaluate in Phase 12. |
| React / React DOM | 19.3.x | 19.3.1 | Current stable |
| Vite | 8.3.x | 8.3.4 | Current stable; Node ≥ 22.12 |
| Tailwind CSS | 4.3.x via `@tailwindcss/vite` | 4.3.3 | Brief; browser floor Safari 16.4 / Chrome 111 / Firefox 128 accepted (NFR-BRW-01) |
| TanStack Query | 5.x | 5.104.4 | |
| React Hook Form | 7.x | 7.90.0 | |
| Zod | 4.x | 4.6.7 | |
| Radix UI | `radix-ui` 1.x | 1.8.1 | |
| Lucide | `lucide-react` 1.x | 1.59.0 | |
| Recharts | 3.x | 3.10.1 | |
| React Router | 8.x | 8.4.0 | Routing was unspecified; standard choice |
| Express | 5.x | 5.3.0 | Brief |
| Mongoose | 9.x | 9.11.2 | Brief |
| Vitest | 5.x | 5.0.5 | Brief |
| Supertest | 7.x | 7.3.1 | |
| Playwright | 1.64.x | 1.64.1 | Browsers must be downloaded into `PROJECT_ROOT/.cache/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) |
| pino | 10.x | 10.4.0 | Structured logging with redaction |
| helmet | 8.x | 8.3.0 | Security headers |

**Status.** Accepted; versions re-checked at each phase start.

## ADR-009 Tenancy enforcement
**Decision.** Shared database, shared collections, `tenantId` (+ `legalEntityId` where applicable) on every document; compound indexes lead with `tenantId`. Repositories cannot be called without a `RequestContext`; a Mongoose plugin rejects queries on scoped models lacking a tenant filter (defence in depth). Cross-tenant tests are mandatory per module.
**Status.** Accepted (Phase 3).

## ADR-010 Inventory valuation and stock points
**Decision.** Moving weighted-average cost per (legal entity, item). Stock-out point is **either** dispatch **or** invoice (setting); stock-in point is **either** goods receipt **or** supplier bill. FIFO/batch/serial deferred.
**Status.** Accepted (Phase 5).

## ADR-011 Accounting scope
**Decision.** Internal double-entry journals are generated for every posted financial document against a system chart of accounts (receivables, payables, sales, purchases, GST output/input per component, inventory, COGS, cash/bank, expenses, rounding). Used for party ledgers, trial balance and reconciliation. Statutory financial statements are **out of scope**; no screen labels sales − purchases as profit.
**Status.** Accepted (Phase 6).

## ADR-012 External regulatory integrations
**Decision.** E-invoice (IRP) and e-way bill behind provider interfaces with states `disabled` (default) / `sandbox` / `live`. `live` requires credentials + documented legal review. Development mocks are labelled and refused at startup when `NODE_ENV=production`.
**Status.** Accepted (Phase 10).

## ADR-013 Sales documents and fulfilment links
**Context.** Quotations, orders, dispatches and invoices share almost every field. Any two of them can be linked: quotation → order → dispatch → invoice, or order → invoice. With either stock-out point, stock must leave exactly once (FR-INV-10).
**Decision.**
- One document shape (`apps/api/src/models-sales.ts`) in four collections, with one draft computation (the Phase 6 preview) and one response mapper (`modules/sales/core.ts`).
- A document made from another keeps `source` and per-line `sourceLineId`. Quantities are counted on the source lines: `fulfilledQty` and `invoicedQty` on order lines, `invoicedQty` on dispatch lines. They are updated in the numbering or cancelling transaction, with the source read inside that transaction.
- Reservations live on the order lines (`reservedQty`) and in `stockBalances.reserved`; there is no separate reservations collection.
- With the dispatch as stock-out point, invoices may carry stock lines only from dispatches.
- Numbering (send, confirm, dispatch, issue) recomputes and freezes the figures and snapshots. The PDF is rendered once, from the snapshot.
**Consequences.**
- Several documents cannot be invoiced together on one invoice (one source per document). For example, an order's service lines are invoiced separately from its dispatched goods when the dispatch is the stock-out point.
- Partial conversions pro-rate amount discounts.
- Reconciliation checks reserved quantities against open orders.
**Status.** Accepted (Phase 7).
