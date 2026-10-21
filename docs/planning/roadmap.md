# Roadmap and Prioritized Backlog

Status: Draft v0.1 · 2026-10-19 · Progress log: [progress.md](progress.md)

## 1. Phases
| Phase | Theme | Exit criteria |
|---|---|---|
| 1 | Repository, CI, environments, contracts, logging, error handling | Workspace builds; API health/ready; error envelope; config validation; tests + typecheck green; CI file present |
| 2 | Design system, components, responsive shell | Tokens recalibrated to reference (needs screenshots); shell at 4 breakpoints; a11y checks; screenshots captured |
| 3 | Auth, sessions, tenancy, users, roles, permissions | AC-AUTH-*, AC-TEN-1, AC-RBAC-1 green on real Mongo replica set |
| 4 | Company, registrations, settings, parties, catalogue | GSTIN validation; series config; tax schedules; CRM tasks |
| 5 | Inventory | AC-INV-1/2; valuation; transfers; counts |
| 6 | Financial engine: decimal domain, journals, sequences, idempotency, snapshots, outbox, worker, PDF foundation | AC-CALC-1, AC-NUM-1, AC-IDEM-1, AC-JRN-1; PDF spike decision (ADR-006) |
| 7 | Quotations, orders, dispatches, invoices, receivables | Order-to-cash E2E |
| 8 | Purchase orders, receipts, bills, payables | Procure-to-pay E2E |
| 9 | Payments, allocations, expenses, refunds, returns, notes | AC-PAY-1 |
| 10 | Reviewed GST integrations (requires C-07 resolution), regulatory status, GST reports | Sandbox only until legal sign-off |
| 11 | Dashboard, reports, exports, deterministic insights | FR-RPT-* |
| 12 | Hardening, accessibility, performance, backup restoration, deployment prep | Security checklist, restore drill, pentest |
| 13 | Pilot onboarding, migration reconciliation, handover | Pilot customer sign-off |

## 2. Prioritized backlog (next items)
| # | Item | Phase | Req |
|---|---|---|---|
| 1 | Monorepo, strict TS, lint, Vitest, CI | 1 | NFR-MNT-01 |
| 2 | Contracts: error envelope, decimal string, health | 1 | API conventions |
| 3 | API skeleton: config, logging w/ redaction, request IDs, headers, CORS, body limits, error handler, health/ready | 1 | NFR-OBS-01, T10 |
| 4 | Worker skeleton: config, logging, graceful shutdown | 1 | — |
| 5 | Web skeleton (Vite + React + Tailwind) | 1 | — |
| 6 | Obtain reference screenshots; recalibrate tokens (still open; Phase 2 built on provisional tokens) | 2 | Design §1 |
| 7 | ~~`packages/ui` primitives + AppShell + dashboard layout with placeholder data clearly marked~~ done 2026-10-19 | 2 | FR-RPT-01 (UI only) |
| 8 | ~~Playwright; responsive screenshots~~ done 2026-10-19 (installed Chrome) | 2 | AC-UI-1 |
| 9 | ~~Mongo test harness (replica set)~~ done 2026-10-19 (mongod 8.0.34, approved download) | 3 | Testing §1 |
| 10 | ~~Users, sessions, CSRF, login throttling, MFA (TOTP)~~ done 2026-10-19 | 3 | FR-AUTH-* |
| 11 | ~~Tenancy context, memberships, roles, permission middleware + matrix tests~~ done 2026-10-19 | 3 | FR-TEN-*, FR-RBAC-* |
| 12 | ~~Audit log~~ done 2026-10-19 | 3 | FR-AUD-01 |
| 13 | Email provider integration via the outbox (invitations, resets, sending documents to customers): provider choice needs approval (still blocked after Phase 7) | 8+ | FR-AUTH-07/08 |
| 14 | ~~Legal entities, GST registrations, settings; role scoping by entity; catalogue; parties; CRM~~ done 2026-10-20 | 4 | FR-TEN-01, FR-CO-*, FR-RBAC-03, FR-CAT-01..03, FR-PTY-01/02/04/05 |
| 16 | Price lists per customer group (FR-CAT-04, S): not built in Phase 7; lines default to the item's sale price | 8+ | FR-CAT-04 |
| 17 | CSV import of parties and items with a validation report (FR-CAT-05, S) | 13 | FR-CAT-05 |
| 18 | ~~Logo upload (file storage) for documents~~ done 2026-10-20 | 7 | FR-CO-01 |
| 19 | GSTIN status lookup via GSTN/GSP (external service; needs approval) | 10 | FR-CO-02 |
| 15 | Generate openapi.yaml from the contracts; contract test in CI | 4 | API conventions |
| 20 | ~~Warehouses and warehouse scope; opening stock; stock ledger; guarded stock-outs; moving average; transfers, adjustments, counts; reconciliation~~ done 2026-10-20 | 5 | FR-INV-01..04/06..10, AC-INV-1/2, FR-RBAC-03 |
| 21 | ~~Schedule stock reconciliation in the worker (distributed lock, alert on drift)~~ done 2026-10-20 | 6 | FR-INV-09 |
| 23 | ~~Financial engine: calculation, numbering, idempotency, journals, outbox, worker, PDF foundation, period locks~~ done 2026-10-20 | 6 | AC-CALC-1, AC-NUM-1, AC-IDEM-1, AC-JRN-1, FR-CO-05 |
| 24 | S3 object storage and production document rendering | 12 | architecture §10 |
| 22 | ~~Reservations from confirmed sales orders; re-run AC-INV-1 with dispatches~~ done 2026-10-20 | 7 | FR-INV-05, AC-INV-1 |
| 25 | ~~Order to cash: quotations, proformas, orders, dispatches, invoices and bills of supply, cancellation, PDFs, receivables, credit limits~~ done 2026-10-20 | 7 | FR-SAL-01..09, FR-DOC-01 (sales), AC-DOC-1 |
| 26 | Discount limit setting for `discount.override` (no limit exists yet) | 9 | FR-RBAC-02 |
| 27 | Keyboard-only invoice creation E2E (testing-strategy `e2e.keyboard`) | 12 | NFR-A11Y-01 |
| 28 | "Own sales only" scope for the Sales role (receivables, documents) | 11 | permission-matrix (`report.sales`) |

## 3. Deferred features (not in MVP)
E-invoice/e-way bill live integration · GSTR-1 JSON export · bank statement import & reconciliation · FIFO/batch/serial/expiry · price-list rules engine · payment links/gateway · WhatsApp delivery · email campaigns · optional AI insights (Gemini or other; server-side, aggregates only, no write authority) · native mobile apps · Tally export · multi-currency & exports/SEZ · TDS/TCS · manufacturing/BOM/WIP/job-work · payroll · statutory financial statements · separate admin app (not planned).
