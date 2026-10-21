# Security Design

Status: Draft v0.1 · 2026-10-19 · Baseline: OWASP ASVS 4.0.3 L2 (applicable controls), OWASP Top 10 (2021) and API Security Top 10 (2023).
Passing tests does not make the system secure; an independent review/pentest is required before production (release checklist).

## 1. Threat model (STRIDE, summarized)
Assets: party PII (names, phones, addresses, GSTIN/PAN), financial records, stock, credentials/sessions, issued documents, regulatory credentials (future).
Actors: anonymous internet users, authenticated users of another tenant, low-privilege staff within a tenant, compromised user account, malicious file uploader, insider with infrastructure access.

| # | Threat | Vector | Mitigation | Phase |
|---|---|---|---|---|
| T1 | Spoofing — credential stuffing | /auth/login | Argon2id, per-account + per-IP throttling, generic errors, MFA for privileged roles, breached-password check (k-anonymity, optional) | 3 |
| T2 | Session hijack | XSS, network | HttpOnly `__Host-` cookie, Secure, SameSite=Strict (workable because the SPA calls a same-origin API), strict CSP, rotation on login/privilege change, idle+absolute expiry, revoke | 3 |
| T3 | CSRF | cross-site form/fetch | HMAC token bound to the session (or to a pre-session cookie for sign-in/sign-up), `X-CSRF-Token` on every unsafe method, Origin allowlist, `Sec-Fetch-Site` check, SameSite=Strict | 3 |
| T4 | Cross-tenant data access (IDOR/BOLA) | guessing IDs, forged `X-Tenant-Id` | Membership validation, repository-enforced scope, 404 on out-of-scope, cross-tenant tests | 3 |
| T5 | Privilege escalation (BFLA) | calling admin APIs | Per-route `requirePermission`; matrix tests | 3 |
| T6 | Mass assignment | extra JSON fields (`status`, `tenantId`) | Strict Zod schemas; explicit field mapping into models | 1+ |
| T7 | NoSQL injection | `{"$gt":""}` in body/query | Strict schemas (strings only), ObjectId validation, no raw query passthrough, `sanitizeFilter`/`strictQuery` in Mongoose | 1+ |
| T8 | Tampering with issued documents | API edits, DB access | State machine forbids edits; append-only collections; audit log; DB user without delete on financial collections (where Atlas roles allow) | 6 |
| T9 | Repudiation | "I didn't cancel it" | Audit events with actor, time, request id, IP hash | 3 |
| T10 | Information disclosure in errors/logs | stack traces, DB errors | Error envelope; pino redaction; no bodies of financial requests in logs | 1 |
| T11 | Malicious uploads | polyglot files, huge files, SVG/HTML | Allowlist (PDF, PNG, JPEG, CSV), magic-byte check, size limits, random keys, private bucket, `Content-Disposition: attachment`, never served from app origin | 4/6 |
| T12 | SSRF | PDF renderer fetching URLs, import by URL | Programmatic PDF (no fetch); images only from our storage; no URL import in MVP; if added: allowlist, block private ranges, no redirects | 6 |
| T13 | DoS / abuse | expensive reports, login floods | Rate limits per route class, body limits, pagination caps, query timeouts (`maxTimeMS`), report jobs in worker | 1/11 |
| T14 | Secret leakage | repo, bundle, logs | `.env` git-ignored, secret scanning in CI, only `VITE_PUBLIC_*` exposed to web, Secrets Manager in AWS | 1 |
| T15 | Supply chain | malicious package | Lockfile, `npm ci`, `npm audit` + Dependabot/OSV, minimal deps, no install scripts unless needed (review list) | 1 |
| T16 | Regulatory credential misuse | IRP/GSP API keys | Stored encrypted per registration; worker-only access; disabled by default | 10 |

## 2. Authentication and sessions
- Argon2id (ADR-007); passwords 12–128 chars, no composition rules, block top common passwords.
- Login: constant-time-ish path (hash a dummy when user missing); lockout is soft (exponential delay), not permanent, to avoid lockout DoS.
- Session token 32 random bytes (base64url) → cookie `__Host-sid`; DB stores SHA-256 hash.
- Idle timeout 30 min (configurable), absolute 12 h; rotation on login, MFA step-up, role change.
- Logout deletes server session and clears cookie; "sign out everywhere" revokes all.
- MFA: TOTP (RFC 6238), secrets envelope-encrypted with a KMS-managed key; 10 single-use recovery codes (hashed). Step-up MFA required for: role/permission changes, period unlock, user removal, regulatory settings.
- Password reset: 32-byte token, hashed at rest, 30 min TTL, single use, revokes all sessions.

## 3. Tenant-isolation strategy
1. Membership check produces `RequestContext{userId, tenantId, legalEntityIds, permissions, warehouseScope}`.
2. Repositories take `ctx` as first argument and always add `tenantId` (+ legal entity) to filters and inserts; IDs from the client are only ever used *together* with the scope filter.
3. Mongoose plugin throws if a scoped model is queried without `tenantId` (defence in depth).
4. Aggregation pipelines start with a `$match` on tenant.
5. Files: storage keys prefixed by tenant; download authorization checks the owning record.
6. Tests: each module's suite includes a two-tenant fixture asserting 404 and no list leakage.

## 4. Browser security
- CSP (API responses and SPA): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Tailwind v4 builds static CSS, so no `unsafe-inline` styles are expected; Recharts inline style attributes may need `style-src-attr 'unsafe-inline'` — to verify in Phase 2 and document if required.
- HSTS (prod), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` minimal.
- CORS: same-origin deployment preferred (SPA and API under one domain via CloudFront path routing); otherwise explicit allowlist with credentials, no wildcard.
- React escapes output by default; `dangerouslySetInnerHTML` banned by lint.

## 5. Upload and document security
Pipeline: size check (default 10 MB, CSV 5 MB) → MIME allowlist → magic-byte signature check → store with random key in private bucket → record in `files` with sha256 → (optional future) malware scan via worker before `available`. CSV imports parsed in the worker with row limits; formula-injection neutralized on export (`=`, `+`, `-`, `@` prefixed with `'`).
Issued PDFs: stored once; regenerated copies are labelled "Duplicate/Reprint" and never overwrite the original.

## 6. Logging, secrets, audit
- pino JSON logs; redact `authorization`, `cookie`, `set-cookie`, `x-csrf-token`, and any `password`, `token`, `secret`, `otp` keys. GSTIN/PAN are business data rather than secrets, but request bodies are not logged by default so they do not appear in logs either.
- Never log request bodies of auth or financial endpoints; log ids and outcome.
- Audit events append-only; retained 8 years (see privacy) — exportable for auditors.

## 7. Privacy and retention plan
- Legal basis and notices under the Digital Personal Data Protection Act, 2023 and the DPDP Rules (notified Nov 2025 with phased commencement) — **legal review required** for: role as data fiduciary vs processor (we are processor for tenants' customer data), breach notification timelines, retention, cross-border transfer.
- Data minimization: only fields needed for invoicing/CRM; no Aadhaar collection.
- Retention: GST law requires accounts/records to be kept for 72 months from the due date of the annual return for the year (CGST Act s.36 — verify); default retention of financial records **8 years**, then archive/erase on tenant request; sessions purged by TTL; audit IP stored as keyed hash.
- Tenant offboarding: export (CSV + PDFs), then deletion after confirmation and statutory hold review.
- Backups inherit retention; deletion from backups occurs as they expire.

## 8. Incident-response outline
1. **Detect:** alerts (auth anomaly, 5xx spike, reconciliation drift, dead outbox), user reports via SECURITY.md contact.
2. **Triage:** severity S1–S4; incident lead assigned; timeline log opened.
3. **Contain:** revoke sessions/keys, disable affected feature flag, block IPs, rotate secrets.
4. **Eradicate & recover:** patch, restore from backup if integrity affected, run reconciliation.
5. **Notify:** affected tenants; CERT-In reporting within 6 hours for reportable incidents (CERT-In Directions, 28 Apr 2022 — verify applicability); DPDP Board/data principals as required — legal review.
6. **Post-incident review** within 5 business days; actions into backlog.

## 9. Security checklist (tracked per release)
- [ ] Argon2id hashing, params benchmarked
- [ ] Session cookie flags, rotation, expiry, revocation tested
- [ ] CSRF enforced on all unsafe methods
- [ ] CORS allowlist; CSP without `unsafe-eval`
- [ ] Rate limits on auth and expensive routes
- [ ] MFA enforced for privileged roles in production
- [ ] Permission matrix tests green
- [ ] Cross-tenant tests green for every module
- [ ] Strict schemas; no `any` passthrough to queries
- [ ] Error envelope never leaks internals
- [ ] Log redaction tests green
- [ ] Upload validation tests (signature mismatch, oversize, SVG/HTML rejected)
- [ ] `npm audit` (high/critical = 0 or accepted with rationale)
- [ ] Secret scan clean
- [ ] Independent security review / pentest completed

## 10. Phase 3 implementation record (2026-10-19)
- **Passwords:** Argon2id, m=64 MiB, t=2, p=1 (about 125 ms per verification on the development machine; re-benchmark on production hardware).
  - At most 4 hashes run at once, which bounds memory use.
  - Unknown accounts get a dummy verification, so the response time is the same.
  - Hashes are upgraded at sign-in when the parameters change.
  - Policy: 12–128 code points, a common-password list, and the password can't be the user's email or name.
  - The breached-password check (HIBP) is not implemented, because it is an external service.
- **Sessions:** a 32-byte token in `__Host-sid` (HttpOnly, Secure, SameSite=Strict, Path=/); only its SHA-256 hash is stored.
  - Expiry: 30 minutes idle, 12 hours absolute. A session waiting for an MFA code expires after 10 minutes.
  - The token rotates on sign-in, MFA completion, step-up, password change and MFA on/off.
  - Changing the password revokes the other sessions; resetting it revokes all of them.
- **CSRF:** the token is `HMAC(key, "sid:"+sessionId)`, or `HMAC(key, "anon:"+__Host-csrf)` before sign-in.
  - It is checked on every POST, PUT, PATCH and DELETE (AC-AUTH-3).
  - The same requests must pass the Origin allowlist, and `Sec-Fetch-Site: cross-site` is rejected.
  - **CORS_ORIGINS must include the web app's own origin**, because browsers send Origin on same-origin POSTs too.
- **Throttling:** counters live in MongoDB under keyed hashes, so raw emails and IPs are never stored. Each update is one atomic pipeline.
  - Sign-in per account: after 5 failures in 15 minutes the account is blocked for 1, 2, 4 … up to 15 minutes. A blocked attempt looks exactly like a wrong password (AC-AUTH-1).
  - Sign-in per IP: 30 failures returns 429.
  - MFA codes: 5 failures per user.
  - Sign-up: 10 per IP per hour.
  - Password-reset requests: 3 per email and 20 per IP per hour.
  - Invitation endpoints: 30 per IP per 15 minutes.
- **MFA:** TOTP (RFC 6238, SHA-1, 6 digits, ±1 step); a code can't be reused, because the last-used step is recorded.
  - Secrets are encrypted with AES-256-GCM, with associated data that binds each one to its user.
  - The encryption key is derived from `APP_SECRET` with HKDF. This **deviates from §2**, which calls for a KMS-managed envelope key; that arrives with deployment (Phase 12).
  - Users get 10 recovery codes, stored hashed, each usable once.
  - Step-up permissions need an MFA check within the last 15 minutes. With `MFA_ENFORCEMENT=privileged` (the production default), users must enrol before they can use them.
- **Tenancy:** `X-Tenant-Id` is resolved only through an active membership. A non-member, a missing tenant or a foreign resource id all get 404.
  - A Mongoose plugin refuses queries on tenant-owned models without `tenantId`, and aggregations that don't start with `$match` on tenantId.
  - Deliberate cross-tenant reads must name a reason.
  - `sanitizeFilter` is on, so the code wraps its own query operators in `trusted()`.
- **Escalation guards:**
  - Users can grant only permissions they hold themselves.
  - They can't manage a member whose permissions exceed their own, or change their own access.
  - A business always keeps at least one active Owner. Concurrent demotions are serialised by a tenant-version write inside the transaction, which prevents write skew.
- **Known limitations:**
  - **Email:** there is no email provider yet. The dev file mailer writes to `.artifacts/mail` and production refuses it, so production can't send invitations or password resets until a provider is approved and integrated.
  - **Sign-up:** it reveals whether an email is already registered (409). Rate limits reduce the risk; email verification would be needed to remove it.
  - **Signing out a member everywhere:** this also ends their sessions in other businesses, because sessions belong to the user.
