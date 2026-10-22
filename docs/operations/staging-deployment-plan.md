# Staging Deployment Plan: Vercel Frontend & Persistent Backend

**Environment**: `staging`  
**Status**: Proposal & Readiness Audit · Pending Explicit User Approval  
**Date**: October 2026  
**Target Domain Concept**: Single-Origin via Vercel Edge Proxy / Custom Domain  

---

## 1. Executive Summary & Recommended Topology

To deploy the **BizMgmt** ERP & CRM application to online staging while preserving strict financial integrity, transactional locking, and robust session security, the architecture is split into specialized, least-privilege tiers:

```
[ Browser Client ]
        │
        ▼ (HTTPS)
┌─────────────────────────────────────────────────────────────┐
│ Vercel Edge Network (React 19 / Vite SPA)                   │
│ - Origin: https://<staging-app>.vercel.app                  │
│ - Serves static assets, fonts, client-side routing          │
│ - Rewrites `/api/:path*` ──────────────┐                   │
└────────────────────────────────────────┼────────────────────┘
                                         │ (Encrypted HTTPS Reverse Proxy)
                                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Persistent Application Host (Node.js 22+ Express API)       │
│ Recommended: Render / Railway / AWS App Runner              │
│ - Host: https://<api-staging>.<provider>.app                │
│ - Validates `__Host-sid` cookie & CSRF tokens               │
│ - Transactional Business Logic & Reporting                  │
│ - Health Endpoints: `/api/v1/health`, `/api/v1/ready`       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼ (TLS 1.3)
┌─────────────────────────────────────────────────────────────┐
│ MongoDB Atlas (Dedicated Staging Cluster: M0/M10+)          │
│ - Replica Set (required for Multi-Document Transactions)    │
│ - IP Access List restricted to API & Worker outbound IPs    │
│ - Isolated Database: `bizmgmt_staging` (synthetic data)     │
└───────────────────────▲─────────────────────────────────────┘
                        │
                        │ (TLS 1.3)
┌───────────────────────┴─────────────────────────────────────┐
│ Persistent Background Worker (Node.js 22+ Process)          │
│ Recommended: Render Background Worker / Railway Service     │
│ - Runs `npm run dev:worker` (main: `apps/worker/dist`)      │
│ - Outbox processor (`document.render` PDF jobs)             │
│ - Daily stock & journal reconciliation scheduler            │
│ - Retries with exponential backoff & dead-letter tracking   │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Provider Evaluation & Recommendations

| Layer | Recommended Provider | Alternative | Approval Status | Key Rationale & Constraints |
|---|---|---|---|---|
| **Frontend Web** | **Vercel** | CloudFront + S3 | **Approved by Instruction** | Zero-config Vite build, global edge CDN, built-in reverse proxy rewrite for same-origin session preservation. |
| **Backend API** | **Render / Railway / AWS App Runner** | Vercel Serverless Functions | **Pending User Approval** | Express server requires persistent process lifecycle, continuous database connection pooling, and bounded memory for PDF generation. **Running Express on Vercel Functions is NOT recommended** due to connection churn on Atlas and cold starts. |
| **Worker** | **Render Background Worker / Railway** | AWS ECS Fargate | **Pending User Approval** | The worker executes perpetual polling (`WORKER_POLL_MS=1000`) on `models.OutboxEvent` and scheduled daily integrity sweeps. Cannot run in request-driven serverless environments. |
| **Database** | **MongoDB Atlas (Staging)** | Self-hosted EC2 | **Pending User Approval** | Atlas provides managed replica sets required for MongoDB ACID transactions (`withTransaction`), automated backups, and TLS. |
| **Storage (PDFs)**| **Private S3 / Cloudflare R2** | Attached Volume / Disabled | **Pending User Approval** | Storage driver `local` is explicitly disabled in `NODE_ENV=production`. Staging requires S3/R2 or `STORAGE_DRIVER=disabled` until S3 credentials are provided. |

---

## 3. Crucial Architectural Discovery: The Single-Origin Session Model

During codebase inspection of [apps/api/src/middleware/auth.ts](file:///c:/management/apps/api/src/middleware/auth.ts) and [apps/web/src/lib/api.ts](file:///c:/management/apps/web/src/lib/api.ts), two fundamental security constraints were identified:

1. **`__Host-` Cookie Enforcement**:
   - The session token is stored in cookie `__Host-sid` with `secure: true`, `httpOnly: true`, `sameSite: 'strict'`, `path: '/'`.
   - By RFC 6265bis, `__Host-` cookies **cannot have a `Domain` attribute** and are strictly origin-bound.
2. **`credentials: 'same-origin'` in Fetch**:
   - [apps/web/src/lib/api.ts](file:///c:/management/apps/web/src/lib/api.ts) executes all API requests with `credentials: 'same-origin'`.
   - If the browser accesses the API via a separate cross-domain origin (e.g. `https://api.onrender.com` vs `https://app.vercel.app`), the browser will **strip the session cookie entirely**, causing all authenticated operations to fail with HTTP 401.

### Solution: Vercel Edge Rewrite Proxy
In [vercel.json](file:///c:/management/vercel.json), all `/api/:path*` traffic is transparently proxied to the backend API host.  
To the browser, requests are strictly same-origin (`https://<staging-app>.vercel.app/api/v1/...`). The cookie `__Host-sid` is sent and received without third-party cookie restrictions or cross-site security degradation.

---

## 4. Monorepo Build Settings (Vercel)

The repository is an npm workspace monorepo (`packages/contracts`, `packages/domain`, `packages/ui`, `apps/api`, `apps/worker`, `apps/web`).

| Setting | Vercel Value | Rationale |
|---|---|---|
| **Root Directory** | `./` (Workspace root) | Must resolve `@bizmgmt/contracts` and `@bizmgmt/ui` sibling workspace sources. |
| **Framework Preset** | `Vite` | Matches `apps/web/vite.config.ts`. |
| **Install Command** | `npm install` | Installs root dependencies and symlinks workspace packages. |
| **Build Command** | `npm run build -w @bizmgmt/web` | Runs `tsc --noEmit -p . && vite build` inside `apps/web`. |
| **Output Directory** | `apps/web/dist` | Standard Vite production distribution folder. |
| **Node.js Version** | `22.x` | Complies with `package.json` engines requirement (`>=22.12.0 <27`). |

### Root `vercel.json` Specification
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "installCommand": "npm install",
  "buildCommand": "npm run build -w @bizmgmt/web",
  "outputDirectory": "apps/web/dist",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://REPLACE_WITH_BACKEND_API_HOST/api/:path*"
    },
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

---

## 5. Environment Variable Matrix (No Secret Values)

### A. Vercel Frontend (`apps/web`)
*Never inject backend secrets into Vercel web variables! Only `VITE_*` variables are exposed to the client bundle.*

| Variable Name | Required | Default (Staging) | Description |
|---|---|---|---|
| `VITE_API_BASE` | Optional | `/api/v1` | Relative path matching Vercel rewrite proxy. |

### B. Persistent API Backend (`apps/api`)

| Variable Name | Required | Staging Value / Guidance | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Enables production security guards, HSTS, and strict validation. |
| `PORT` | Yes | Provided by host (e.g. `4000` or `10000`) | Listening port. |
| `HOST` | Yes | `0.0.0.0` | Bind address for container/host routing. |
| `LOG_LEVEL` | Yes | `info` | Structured JSON log level via Pino. |
| `MONGODB_URI` | Yes | `mongodb+srv://...` (Atlas Staging) | Connection URI for staging replica set. |
| `MONGODB_DB_NAME` | Yes | `bizmgmt_staging` | Separate staging database name. |
| `APP_SECRET` | Yes | Unique 64+ char random hex string | HKDF master secret for CSRF, lookup hashes, and MFA. |
| `PUBLIC_APP_URL` | Yes | `https://<staging-app>.vercel.app` | Base URL used in emails and redirect links. |
| `CORS_ORIGINS` | Yes | `https://<staging-app>.vercel.app` | Comma-separated list of allowed browser origins. |
| `TRUST_PROXY` | Yes | `1` | Number of upstream reverse-proxy hops (Vercel/Render). |
| `BODY_LIMIT` | No | `256kb` | JSON payload ceiling. |
| `SESSION_IDLE_MINUTES` | No | `30` | Idle session expiry. |
| `SESSION_ABSOLUTE_HOURS`| No | `12` | Absolute session timeout. |
| `SIGNUP_ENABLED` | Yes | `false` | Staging accounts created via controlled seed or invitations. |
| `MFA_ENFORCEMENT` | Yes | `privileged` | Demands step-up MFA for privileged business mutations. |
| `MAIL_TRANSPORT` | Yes | `disabled` (or staging SMTP/Resend) | `file` transport is rejected when `NODE_ENV=production`. |
| `STORAGE_DRIVER` | Yes | `disabled` (until S3 driver configured) | `local` storage is rejected in production. |

### C. Persistent Worker (`apps/worker`)

| Variable Name | Required | Staging Value / Guidance | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` | Production mode. |
| `LOG_LEVEL` | Yes | `info` | Log level. |
| `MONGODB_URI` | Yes | Same as API (`bizmgmt_staging`) | Worker consumes outbox events from the same database. |
| `MONGODB_DB_NAME` | Yes | `bizmgmt_staging` | Staging database. |
| `WORKER_POLL_MS` | No | `1000` | Outbox polling interval (milliseconds). |
| `STORAGE_DRIVER` | Yes | Same as API (`disabled` / S3) | Document storage backend. |

---

## 6. Database Configuration & Security Boundaries

1. **Atlas Replica Set Requirement**:
   - The ERP relies on MongoDB transactions (`withTransaction` in `platform/transactions.ts`) for double-entry journal balance enforcement, inventory serial/batch reservations, and idempotent numbering. A single standalone MongoDB instance without a replica set will throw transaction errors. Atlas M0 (Free Tier) and M10+ both support replica set transactions.
2. **Network Isolation**:
   - Do **NOT** leave Atlas open to `0.0.0.0/0` (anywhere).
   - Configure the Atlas IP Access List to include only the static outbound IP addresses of the API and Worker hosts (Render / Railway / NAT gateway).
3. **Database Separation**:
   - Production and staging MUST use distinct Atlas projects or database names. Staging data will be seeded with synthetic entities (`demo.owner@example.test`) and test GSTINs. Real customer data is strictly forbidden in staging.

---

## 7. Migration Procedure (Release Pipeline)

1. Migrations are located in [apps/api/src/migrations/index.ts](file:///c:/management/apps/api/src/migrations/index.ts).
2. Outside production, migrations run automatically on server start. When `NODE_ENV=production`, the API **deliberately refuses to auto-migrate on boot** to prevent race conditions across multi-instance clusters.
3. **Staging Migration Command**:
   ```bash
   npm run db:migrate
   ```
   Must be executed as a pre-deploy release step (e.g. Render Pre-Deploy Command or Railway Release Command) before starting the new API containers.

---

## 8. Staging Verification & Smoke-Test Checklist

Upon receiving approval and executing deployment, verify the following sequence:

1. **Edge Reachability & Direct Routing**:
   - Navigate to `https://<staging-app>.vercel.app/login`.
   - Refresh the page while at `/settings/company` or `/sales/invoices`. Verify that Vercel rewrites to `/index.html` (no 404).
2. **Health Probes**:
   - `GET https://<staging-app>.vercel.app/api/v1/health` -> HTTP 200 `{ status: "ok", service: "api" }`.
   - `GET https://<staging-app>.vercel.app/api/v1/ready` -> HTTP 200 `{ status: "ready", checks: { database: "up" } }`.
3. **Authentication & Session Flow**:
   - Sign in using the staging seed account.
   - Inspect response headers for `Set-Cookie: __Host-sid=...; Secure; HttpOnly; SameSite=Strict; Path=/`.
   - Verify `GET /api/v1/auth/session` returns `status: "authenticated"` and CSRF token.
4. **Tenant Isolation & RBAC**:
   - Verify active tenant header `X-Tenant-Id` is transmitted.
   - Verify non-accessible tenant IDs return HTTP 403 Forbidden.
5. **Business Workflows (Synthetic Data Only)**:
   - Create one Quotation -> Sales Order -> Sales Invoice.
   - Create one Purchase Order -> Goods Receipt -> Supplier Bill.
   - Record one Payment & Allocation. Verify ledger debit/credit equality.
6. **Worker Processing**:
   - Verify outbox processing logs in worker console.
   - Confirm daily stock reconciliation task runs without unhandled exceptions.

---

## 9. Rollback & Disaster Recovery Procedure

- **Frontend (Vercel)**: Instant rollback to previous deployment SHA via Vercel dashboard or CLI in < 5 seconds.
- **Backend API & Worker**: Rollback image tag/commit SHA on persistent host.
- **Database**: Atlas Point-in-Time Restore (PITR) snapshot rollback if a migration causes schema corruption. All migrations must be backward-compatible (expand/contract pattern).

---

## 10. Estimated Recurring Cost Categories (Staging)

| Category | Component | Staging Tier Recommendation | Estimated Cost |
|---|---|---|---|
| Frontend | Vercel | Hobby (Free) / Pro ($20/seat/mo if team) | $0 - $20/mo |
| Backend API | Render / Railway | Starter / Standard Container (512MB - 1GB RAM) | ~$7 - $15/mo |
| Worker | Render / Railway | Background Worker Service | ~$7 - $10/mo |
| Database | MongoDB Atlas | M0 (Free Shared) or M2/M5 ($9 - $25/mo) | $0 - $25/mo |
| **Total Staging** | | | **~$14 - $55/mo** |
