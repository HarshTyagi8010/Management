# BizMgmt — CRM, GST Billing & Inventory for Indian SMEs

> Working name. A secure, multi-user business-management application for Indian
> distributors, wholesalers, dealers, workshops, retailers/traders and service
> companies: CRM, GST-aware billing, purchasing, warehouse inventory, payments,
> documents and reporting.

**Status: development. Phases 1–10 of 13 implemented and verified across component, integration, and real-browser suites. Foundation, design system, auth/tenancy, company/tax masters, inventory/warehouses, calculation/journals/numbering, sales/orders, purchasing, payments/allocations/notes, and statutory preparation registers (GSTR-1, purchase register review, financial reconciliation, and period-close readiness coordination).**

## Implementation status

| Area | Planned | Implemented | Tested | Blocked |
|---|---|---|---|---|
| Documentation (requirements, architecture, security, GST, design, ops) | ● | ● draft v0.1 | — (needs owner/CA review) | |
| Phase 1: monorepo, strict TS, lint, CI workflow | ● | ● | ● typecheck, lint, build pass locally | CI not run yet (no remote repository) |
| Phase 1: contracts (error envelope, decimal strings, ids, health) | ● | ● | ● unit tests | |
| Phase 1: API foundation (config validation, logging/redaction, request IDs, security headers, CORS, body limits, error handling, health/ready) | ● | ● | ● Supertest | |
| Phase 1: worker foundation (task loop, graceful shutdown) | ● | ● (no tasks yet) | ● unit tests | |
| Phase 1: web scaffold (Vite, React, Tailwind, TanStack Query) | ● | ● placeholder page only | ● component test | |
| Phase 2: design system, components, responsive shell, dashboard layout (sample data) | ● | ● provisional tokens | ● unit + Playwright (axe, keyboard, responsive, CSP) | Reference fidelity unverified (no screenshots) |
| Phase 3: auth (Argon2id, sessions, CSRF, throttling, TOTP MFA, password reset, invitations), tenancy, roles and permissions, audit log | ● | ● | ● API integration on a real replica set, permission matrix over HTTP, component tests, Playwright against a real API | Email delivery has no provider (dev file mailer only) |
| Phase 4: legal entities, GSTINs (checksum), bank accounts, workflow, document series, entity-scoped roles, units (UQC), categories, tax classes with dated rates, items, parties, duplicate detection, CRM | ● | ● | ● API integration, permission matrix (31 endpoints × 7 roles), component tests, Playwright | No tax rates shipped (by design); CSV import and price lists deferred |
| Phase 5: warehouses and warehouse-scoped roles, opening stock, append-only stock ledger, guarded stock-outs (AC-INV-1), moving weighted average, transfers with in transit, adjustments, counts, reconciliation (AC-INV-2) | ● | ● | ● domain unit tests, API integration incl. concurrency and drift detection, permission matrix (49 endpoints × 7 roles), component tests, Playwright | Valuation policy needs CA review; scheduled reconciliation arrives with the Phase 6 worker |
| Phase 6: calculation engine and preview, gap-free numbering, idempotency keys, chart of accounts and journals, outbox and worker with daily integrity checks, PDF rendering (transfer notes), period locks | ● | ● | ● 47 calculation fixtures, API integration incl. 100 concurrent numbers, permission matrix (56 endpoints × 7 roles), component tests, Playwright | Storage is local-only (no PDFs in production until S3); email provider still not approved |
| Phase 7: sales workflows (quotations, sales orders, reservations, dispatches, invoices, receivables & ageing, sales PDFs) | ● | ● | ● API integration (16 tests), permission matrix (77 endpoints × 7 roles), Playwright e2e | |
| Phase 8: purchasing & supplier workflows (purchase orders, goods receipts, supplier bills, duplicate protection, payables & ageing, PO PDFs) | ● | ● | ● API integration (6/6 tests), permission matrix (540 tests), typecheck clean | |
| Phase 9: payments, allocations, advance refunds, reversals, direct expenses, returns & notes, party statements | ● | ● | ● API integration (10/10 tests), domain unit tests (5/5), typecheck clean | |
| Phase 10: statutory preparation & compliance screens (GSTR-1 outward registers, purchase register ITC review, financial reconciliation, HSN/SAC summary, document summary, period-close coordinator) | ● | ● Implemented | ● Component tested (7 JSDOM), Integration tested (36 backend tests with MongoReplSet), Real-browser verified (Playwright/Chrome on desktop/tablet/mobile) | Preparation only — not filed; direct portal integrations (e-way bill, e-invoice, GSTR-2B API) out of MVP |
| Phases 11–13 (advanced analytics, financial statements, filing integrations) | ● | | | |

Full progress log: [docs/planning/progress.md](docs/planning/progress.md).

## Scope and non-goals
In scope (MVP): multi-user CRM; company & GST registration settings; customers/suppliers; products, services, categories, units, tax classifications; warehouses & inventory; quotations, sales orders, dispatches, invoices; purchasing; receipts/payments/allocations; expenses; returns, credit/debit notes; PDFs; dashboard & reports; audit history; configurable roles.
Non-goals: manufacturing ERP, payroll, WIP/production scheduling, job-work accounting, autonomous AI agents, microservices, separate admin app, GST return filing. See [roadmap](docs/planning/roadmap.md#3-deferred-features-not-in-mvp).

## Architecture summary
A modular monolith: `apps/api` (Express 5) and `apps/worker` (outbox consumer and jobs) share `packages/*`. `apps/web` is a React SPA. There is one database, MongoDB Atlas (replica set, Decimal128, transactions), and one queue strategy (transactional outbox). Sessions are server-side, carried in HTTP-only cookies. Details: [architecture](docs/architecture/architecture.md), [ADRs](docs/architecture/decisions.md).

## Repository structure
```
apps/
  api/          Express API (modular monolith)
  worker/       background worker
  web/          React SPA
packages/
  contracts/    shared Zod schemas & types
  ui/           design tokens + accessible React components
  domain/       pure decimal arithmetic and inventory valuation (decimal.js)
docs/           requirements, architecture, database, api, design, security, compliance, testing, operations, planning
scripts/        project-local maintenance scripts
.github/        CI workflow
.cache/ .tmp/ .artifacts/ test-results/   project-local, git-ignored
```

## Prerequisites
- Node.js ≥ 22.12 (24 LTS recommended; see `.nvmrc`), npm 10, Git
- No global packages. Sign-in needs a MongoDB **replica set**: `npm run dev:db` starts a project-local one (mongod is downloaded once into `.cache/mongodb-binaries`), or use Atlas.

## Installation (project-local)
```powershell
# from the project root
$env:TMP = "$PWD\.tmp"; $env:TEMP = "$PWD\.tmp"   # keep temp files inside the project
npm ci                                            # .npmrc keeps npm's cache in .cache/npm
Copy-Item .env.example .env
```
Caveat: these settings keep npm's cache and most tool output inside the project, but environment variables cannot *guarantee* OS-level containment.

## Environment variables
See [`.env.example`](.env.example) and the [configuration reference](docs/operations/operations.md#2-configuration-reference). Main ones: `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `TRUST_PROXY`, `BODY_LIMIT`, `MONGODB_URI` (required in production), `MONGODB_DB_NAME`, `WORKER_POLL_MS`, `VITE_API_BASE`. Only `VITE_*` variables reach the browser bundle, so never put secrets in them.

## Commands
| Purpose | Command |
|---|---|
| Local database (replica set) | `npm run dev:db`, then set `MONGODB_URI=mongodb://127.0.0.1:27027/?replicaSet=rs0` in `.env` |
| Migrations | `npm run db:migrate` (applied automatically outside production) |
| Demo data (synthetic, no tax rates) | `npm run db:seed` (prints a one-time password; refuses production) |
| API (watch) | `npm run dev` (http://127.0.0.1:4000/api/v1/health) |
| Web (watch, proxies `/api`) | `npm run dev:web` (http://127.0.0.1:5173) |
| E2E (builds, serves with CSP, uses installed Chrome) | `npm run test:e2e` (set `TMP`/`TEMP` to `.tmp` first) |
| Worker (watch) | `npm run dev:worker` |
| Tests (all workspaces, including replica-set integration) | `npm test` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Build | `npm run build` |
| Stock reconciliation (read-only; exits 1 on drift) | `npm run stock:reconcile` |
| Clean build output | `npm run clean` |

## Database setup and seed
Without `MONGODB_URI` the API serves only health endpoints. With it, open the web app and **create an account** (sign-up is on by default outside production); development emails such as invitation links are written to `.artifacts/mail/`. Or run `npm run db:seed` for a demo business with synthetic customers, suppliers and items (no tax rates: add them with their source under Settings › Tax rates). Seeds will never contain real customer data or production secrets.

## Documentation
Start at [docs/README.md](docs/README.md).

## Security
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Don't open public issues for security problems. Passing tests doesn't mean the system is secure; an independent review is part of the release checklist.

## Known limitations
- The UI reference (Dribbble) couldn't be accessed from the build environment because of a bot challenge. All design tokens are **provisional**, and visual fidelity is not claimed.
- GST logic is documented but **not legal advice**. Items marked *Verify/Unresolved* in [gst.md](docs/compliance/gst.md) need CA review.
- E-invoice and e-way-bill integrations are out of MVP (interfaces and disabled states only).
- TypeScript is pinned to 6.0 because typescript-eslint doesn't support 7.x yet (ADR-008).
- The CI workflow is defined but hasn't run on a hosted runner yet.
- No email provider is integrated. Production therefore cannot send invitations or password-reset links until one is chosen and approved.

## Deployment overview
Planned target: AWS `ap-south-1`. S3 + CloudFront for the web app, ECS Fargate for API and worker, MongoDB Atlas on AWS Mumbai, Secrets Manager. **Nothing is provisioned.** Deployment requires explicit approval. See [operations](docs/operations/operations.md).
