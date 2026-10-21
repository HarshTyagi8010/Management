# Operations: Environments, CI/CD, Backup, Migration, Monitoring, Release, Developer Setup

Status: Draft v0.1 · 2026-10-19 · **Nothing has been provisioned or deployed.**

## 1. Environments
| Env | Purpose | Data | Regulatory providers |
|---|---|---|---|
| `development` | local | synthetic seed | mock allowed |
| `test` | CI | ephemeral | mock allowed |
| `staging` | pre-release, AWS | synthetic / anonymized | sandbox only |
| `production` | customers | real | disabled or live (approved) |

## 2. Configuration reference
All config via environment variables validated at startup (`apps/api/src/config.ts`); the worker uses the same configuration (it runs the API package's jobs), plus `WORKER_POLL_MS`. Invalid config → process exits with a redacted error. See `.env.example`.

| Variable | App | Default (dev) | Notes |
|---|---|---|---|
| `NODE_ENV` | all | `development` | `development` \| `test` \| `production` |
| `PORT` | api | `4000` | |
| `HOST` | api | `127.0.0.1` | bind address |
| `LOG_LEVEL` | api, worker | `info` | pino level |
| `MONGODB_URI` | api, worker | — | required in production; secret |
| `MONGODB_DB_NAME` | api, worker | `bizmgmt_dev` | |
| `CORS_ORIGINS` | api | `http://localhost:5173,http://127.0.0.1:5173` | comma-separated allowlist; must include the web app origin |
| `TRUST_PROXY` | api | `false` | number of hops or `false` |
| `BODY_LIMIT` | api | `256kb` | JSON body limit |
| `APP_SECRET` | api | insecure dev constant | ≥ 32 characters; **required and unique in production**; HKDF derives the CSRF, lookup-hash and MFA-encryption keys from it. Rotating it invalidates CSRF tokens and **all MFA enrolments** (users must re-enrol). Secret |
| `PUBLIC_APP_URL` | api | `http://localhost:5173` | base of links in emails; https in production |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | api | `30` / `12` | |
| `SIGNUP_ENABLED` | api | `true` (dev) / `false` (prod) | public self-service sign-up |
| `MFA_ENFORCEMENT` | api | `off` (dev) / `privileged` (prod) | `privileged`: MFA required before step-up permissions |
| `MAIL_TRANSPORT` | api | `file` (dev) / `disabled` (prod) | `file` writes to `.artifacts/mail`; refused in production. No real provider yet (needs approval) |
| `PASSWORD_HASH_PROFILE` | api | `standard` | `test` (fast) is allowed only with NODE_ENV=test |
| `STORAGE_DRIVER` | api, worker | `local` (dev) / `disabled` (prod) | `local` \| `disabled`; `local` is refused in production. With `disabled`, no documents are rendered. `s3` arrives with deployment (Phase 12) |
| `STORAGE_DIR` | api, worker | `.artifacts/storage` | directory for `local`; the API and the worker must point at the same one |
| `S3_BUCKET`, `AWS_REGION` | api, worker | — | planned for production (Phase 12) |
| `WORKER_POLL_MS` | worker | `1000` | |
| `VITE_API_BASE` | web | `/api/v1` | only `VITE_*` vars reach the bundle — never put secrets there |

## 3. CI/CD plan
CI (GitHub Actions, `.github/workflows/ci.yml`), on push/PR:
1. `npm ci` (lockfile enforced; cache `~/.npm` on the runner is acceptable — it is the CI machine, not the developer workspace).
2. `npm run typecheck` (strict), `npm run lint`.
3. `npm test` (unit, component and API integration tests). The integration project starts a mongod 8.0.34 replica set through mongodb-memory-server, which downloads into `.cache/mongodb-binaries` (cache that directory in CI), or uses `MONGODB_URI_TEST`.
4. `npm run build`.
5. `npm audit --audit-level=high` (fails on high/critical unless allowlisted with rationale).
6. Secret scan (gitleaks action).
7. Phase 2+: Playwright E2E with artifacts uploaded (`playwright-report/`).
CD (Phase 12, requires approval): build container image → push to ECR → deploy staging → smoke → manual approval → production. Web built and synced to S3 with CloudFront invalidation. **No deployment occurs without explicit approval.**

## 4. Backup / restore plan
- Atlas continuous cloud backup with point-in-time restore (PITR window ≥ 7 days; snapshots retained 35 days; monthly snapshots 12 months) — tier-dependent, confirm cost before enabling.
- S3 versioning + lifecycle on the document bucket; Object Lock (compliance mode) considered for issued originals.
- Quarterly restore drill into an isolated project: restore → run reconciliation (stock: `npm run stock:reconcile`; journals and sequences from Phase 6) → record result in `docs/operations/restore-drills.md`.
- RPO ≤ 1 h, RTO ≤ 4 h targets (NFR-AVL-01).

## 5. Migration strategy
- **Schema:** versioned migrations (see database doc §4), run explicitly in the release pipeline before deploying new code; expand/contract for breaking changes.
- **Customer onboarding data:** CSV templates for parties, items, opening stock (per warehouse with cost), opening receivables/payables (open invoices as "opening balance documents"), validated in dry-run mode → reconciliation report (counts, totals per party, stock value) signed off by customer before commit (Phase 13).

## 6. Monitoring and alerting
| Signal | Alert |
|---|---|
| API 5xx rate > 1 % over 5 min | page |
| p95 latency > 1 s over 10 min | warn |
| Readiness failing | page |
| Login failure spike / lockouts per tenant | warn (possible stuffing) |
| Outbox oldest pending > 5 min or any `dead` (worker logs `outbox event is dead` at error level) | warn / page |
| Reconciliation drift ≠ 0: the worker's daily `stock-reconciliation` and `journal-reconciliation` jobs log at error level and store results (`GET /integrity-checks`, Stock › Check records); `npm run stock:reconcile` exits 1 | page (financial integrity) |
| PDF failures > 5 % | warn |
| Atlas: replication lag, disk, connections | per Atlas defaults |
Logs → CloudWatch Logs (JSON); metrics via CloudWatch EMF or OpenTelemetry (decision in Phase 12). No PII in metrics labels.

## 7. Release checklist
- [ ] All CI gates green; test report attached (Passed/Failed/Not run/Blocked listed honestly)
- [ ] Migrations reviewed and dry-run on staging snapshot
- [ ] Security checklist ([security.md §9](../security/security.md#9-security-checklist-tracked-per-release)) reviewed
- [ ] Compliance items affected by the release reviewed by CA (if GST logic changed)
- [ ] Backups verified within last 24 h
- [ ] Feature flags for regulatory providers in intended mode
- [ ] README status section updated
- [ ] Rollback plan stated (previous image tag; migrations backward-compatible)

## 8. Developer setup (project-local)
Prerequisites: Node.js ≥ 22.12 (24 LTS recommended), npm 10, Git. No global packages.

```powershell
# from PROJECT_ROOT
$env:npm_config_cache = "$PWD\.cache\npm"   # also set in .npmrc
$env:TMP = "$PWD\.tmp"; $env:TEMP = "$PWD\.tmp"
npm ci
Copy-Item .env.example .env   # edit values; .env is git-ignored
npm run dev        # api; also: npm run dev:web, npm run dev:worker
npm test
npm run build
```
Containment note: `.npmrc` pins the npm cache inside the project and scripts set
temp dirs, but environment variables do not guarantee OS-level containment
(native installers or tools may still use OS temp paths). Strict containment
would need an OS sandbox/container, which is not configured here.

## Local database (Phase 3)
- `npm run dev:db` starts a persistent single-node replica set on `127.0.0.1:27027` (mongod 8.0.34; binary in `.cache/mongodb-binaries`, data in `.artifacts/dev-db`). Then set `MONGODB_URI=mongodb://127.0.0.1:27027/?replicaSet=rs0` in `.env`.
- Outside production the API applies migrations at start-up. In production, run `npm run db:migrate` deliberately, as a release step.
- Development emails (invitations, reset links) are written as JSON to `.artifacts/mail/`.
- Containment caveat: the binary comes from fastdl.mongodb.org. Explicit paths keep the binary, data and temporary files inside PROJECT_ROOT, but they can't guarantee the operating system writes nothing elsewhere.
