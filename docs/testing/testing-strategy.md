# Testing Strategy

Status: Draft v0.1 · 2026-10-19

## 1. Layers
| Layer | Tool | Scope | Where |
|---|---|---|---|
| Unit (pure) | Vitest | `packages/domain` calculations, rounding, allocation, state machines; `packages/contracts` schemas | `packages/*/src/**/*.test.ts` |
| API integration | Vitest + Supertest | HTTP pipeline, validation, error envelope, auth, permission, tenancy | `apps/api/src/**/*.test.ts` |
| Persistence integration | Vitest project `api-int` + real MongoDB **replica set** (mongod 8.0.34 via mongodb-memory-server, `test/global-setup.ts`; one database per test file) | auth, tenancy, permission matrix (Phase 3); later numbering, stock concurrency, idempotency, reconciliation | `apps/api/test/integration/` |
| Worker | Vitest | outbox claim/lease/retry, idempotent handlers, PDF generation | `apps/worker/src/**/*.test.ts` |
| Component | Vitest + Testing Library (jsdom) | UI components, forms, accessibility attributes | `apps/web`, `packages/ui` |
| E2E | Playwright (installed Google Chrome via `channel: chrome`; no browser download) + @axe-core/playwright, against the production build **and a real API on its own replica set** (`apps/api/test/e2e-server.ts`) | sign-in/out, sign-up, cookie flags, critical journeys, keyboard, responsive, CSP, axe WCAG 2.2 AA, visual screenshots | `apps/web/e2e/` |
| Static | `tsc --noEmit` (strict), ESLint, `npm audit`, secret scan | all | CI |

Financial integration tests **must** run against a real MongoDB replica set
(transactions require it). Options, all project-local: `mongodb-memory-server`
`MongoMemoryReplSet` with `MONGOMS_DOWNLOAD_DIR=PROJECT_ROOT/.cache/mongodb-binaries`
(downloads a mongod binary from mongodb.org — approval point noted in
operations), or a developer-provided Atlas test cluster via `MONGODB_URI_TEST`.
Mocks are never used in place of persistence for financial invariants.

## 2. Required suites (mapped to requirements)
| Suite | Covers |
|---|---|
| `calc.fixtures` | 40+ fixtures: mixed rates, per-line/ doc discounts, largest-remainder allocation, cess (ad valorem + specific), intra/inter-state, round-off ±0.50, zero-value lines, max-precision quantities (AC-CALC-1). Phase 6: 47 fixtures in `calc.test.ts` (specific cess is deferred: GST-12) |
| `state-machines` | every allowed and a sample of disallowed transitions per workflow |
| `permissions.matrix` | iterates permission matrix (AC-RBAC-1) |
| `tenancy.cross` | two-tenant fixtures per module (AC-TEN-1) |
| `idempotency` | replay, in-progress, key reuse with different body (AC-IDEM-1). Phase 6: `finance.test.ts` |
| `numbering.concurrency` | 100 parallel issues → gap-free unique (AC-NUM-1). Phase 6: `finance.test.ts` at the numbering level |
| `stock.concurrency` | parallel dispatch of last units (AC-INV-1), transfer atomicity. Phase 5: `inventory.test.ts` with parallel transfers and adjustments; dispatches join in Phase 7 |
| `allocation.limits` | over-allocation rejected atomically (AC-PAY-1) |
| `journal.balance` | Σdebit = Σcredit for every posting type (AC-JRN-1). Phase 6: stock postings in `finance.test.ts`; domain rules in `journal.test.ts` |
| `reconciliation` | inject drift → job detects; clean ledger → zero drift (AC-INV-2). Phase 5: `inventory.test.ts` |
| `pdf` | content (particulars present), page breaks with 1/30/200 lines, header repetition, byte-identical originals (AC-DOC-1) |
| `upload.abuse` | wrong magic bytes, oversize, SVG/HTML, path tricks in filenames |
| `security.http` | headers, CSP, CORS, CSRF, cookie flags, error leakage, body limits |
| `e2e.responsive` | 360/768/1280/1440 screenshots, no horizontal scroll (AC-UI-1) |
| `e2e.keyboard` | complete invoice creation with keyboard only |
| `recovery` | backup restore drill script verified against reconciliation (Phase 12) |

## 3. Conventions
- Tests live next to code; integration tests in `test/integration`.
- Deterministic: fixed clocks (`vi.useFakeTimers`/injected clock), seeded IDs, no network.
- Test data contains no real customer data; GSTINs in fixtures are synthetically generated with valid checksums and clearly fake names.
- Outputs (coverage, reports, screenshots, traces) go to `test-results/`, `playwright-report/`, `coverage/` inside PROJECT_ROOT, all git-ignored.
- Coverage targets: domain ≥ 95 % lines/branches; api ≥ 80 %; ui components ≥ 70 %.

## 4. Verification reporting
Each milestone report lists suites as **Passed / Failed / Not run / Blocked / Manual review required**, with the exact command and date. Results are never inferred.
