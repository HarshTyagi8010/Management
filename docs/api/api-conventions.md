# API Conventions

Status: Draft v0.1 · 2026-10-19 · Machine-readable spec: [openapi.yaml](openapi.yaml) (Phase 1 endpoints implemented; others planned)

## Base
- Base path `/api/v1`. JSON only (`Content-Type: application/json` required for bodies; others → 415).
- Resource style: `GET /sales-invoices`, `GET /sales-invoices/{id}`, `POST /sales-invoices` (create draft), `PATCH /sales-invoices/{id}` (draft only, with the document's `version` in the body for optimistic concurrency), commands as `POST /sales-invoices/{id}/issue`, `/cancel`, previews as `POST /calc/preview`.
- Context headers (Phase 3+): `X-Tenant-Id`, `X-Legal-Entity-Id` — validated against membership; never trusted on their own.
- `Idempotency-Key` required on commands that create financial/stock effects.
- CSRF: `X-CSRF-Token` is required on POST/PUT/PATCH/DELETE. Get it from `GET /auth/session`; every sign-in step returns a new one.

## Endpoints (Phase 3)
| Area | Endpoints |
|---|---|
| Session | `GET /auth/session`, `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `PATCH /auth/preferences`, `PUT /auth/active-tenant` |
| MFA | `POST /auth/mfa/verify` (sign-in step), `POST /auth/mfa/step-up`, `POST /auth/mfa/totp/setup`, `POST /auth/mfa/totp/confirm`, `POST /auth/mfa/disable` |
| Passwords | `POST /auth/password/change`, `POST /auth/password/forgot` (always 202), `POST /auth/password/reset` |
| Invitations (public) | `POST /auth/invitations/inspect`, `POST /auth/invitations/accept` |
| Tenant-scoped (`X-Tenant-Id`) | `GET /tenant/context`, `PATCH /tenant`, `GET /members`, `PATCH /members/:id`, `POST /members/:id/revoke-sessions`, `GET/POST /invitations`, `DELETE /invitations/:id`, `GET/POST /roles`, `PATCH/DELETE /roles/:id`, `GET /audit-events` |

## Endpoints (Phase 4)
| Area | Endpoints (all tenant-scoped) |
|---|---|
| Company | `GET/POST /legal-entities`, `GET/PATCH /legal-entities/:id`, `PUT /legal-entities/:id/workflow`, `PUT /legal-entities/:id/bank-accounts`, `GET/POST /legal-entities/:id/registrations`, `PATCH /gst-registrations/:id` |
| Numbering | `GET /document-series?legalEntityId=`, `POST /document-series`, `PATCH /document-series/:id` |
| Catalogue | `GET/POST /units`, `PATCH /units/:id`, `GET/POST /categories`, `PATCH /categories/:id`, `GET/POST /tax-classes`, `PATCH /tax-classes/:id`, `POST /tax-classes/:id/schedules`, `PATCH /tax-classes/:id/schedules/:scheduleId`, `GET/POST /items`, `GET/PATCH /items/:id` |
| Parties and CRM | `GET/POST /parties`, `GET/PATCH /parties/:id`, `GET /parties/:id/timeline`, `POST /parties/:id/notes`, `POST /parties/:id/tasks`, `GET /crm-tasks`, `PATCH /crm-tasks/:id` |

## Endpoints (Phase 5)
| Area | Endpoints (all tenant-scoped) |
|---|---|
| Warehouses | `GET /warehouses[?legalEntityId=]`, `POST /warehouses`, `PATCH /warehouses/:id` |
| Enquiries | `GET /stock/summary?legalEntityId=[&warehouseId=&q=&cursor=]`, `GET /stock/valuation?legalEntityId=`, `GET /stock/movements?legalEntityId=[&warehouseId=&itemId=&cursor=]`, `GET /stock/reconciliation[?legalEntityId=]` |
| Opening stock and adjustments | `GET/POST /stock-adjustments`, `GET/PATCH /stock-adjustments/:id`, `POST /stock-adjustments/:id/post`, `POST /stock-adjustments/:id/cancel` |
| Transfers | `GET/POST /stock-transfers`, `GET/PATCH /stock-transfers/:id`, `POST /stock-transfers/:id/dispatch`, `/receive`, `/cancel` |
| Counts | `GET/POST /stock-counts`, `GET/PATCH /stock-counts/:id`, `POST /stock-counts/:id/start`, `/submit`, `/reopen`, `/post`, `/cancel` |

Stock commands take `{ "version": n }`. Not enough stock gives 422 `INSUFFICIENT_STOCK`; a date in a locked period gives 422 `PERIOD_LOCKED`.

## Endpoints (Phase 6)
| Area | Endpoints (all tenant-scoped) |
|---|---|
| Calculation | `POST /calc/preview` (server-computed figures and snapshots; nothing is saved) |
| Books | `GET /accounts?legalEntityId=`, `GET /journals?legalEntityId=[&sourceId=&cursor=]`, `GET /reports/trial-balance?legalEntityId=[&asOf=]` |
| Period locks | `PUT /legal-entities/:id/period-lock` `{version, lockDate, reason}` |
| Checks and documents | `GET /integrity-checks`, `GET /stock-transfers/:id/pdf` |

## Endpoints (Phase 7)
| Area | Endpoints (all tenant-scoped) |
|---|---|
| Quotations and proformas | `GET/POST /quotations`, `GET/PATCH /quotations/:id`, `POST /quotations/:id/send` · `/accept` · `/reject` · `/revise` · `/discard` · `/convert` `{to: sales_order \| sales_invoice}`, `GET /quotations/:id/pdf` |
| Sales orders | `GET/POST /sales-orders`, `GET/PATCH /sales-orders/:id`, `POST /sales-orders/:id/confirm` `{version, overrideCreditLimit?}` · `/cancel` · `/close` `{version, reason}` · `/discard`, `POST /sales-orders/:id/dispatches` and `/invoices` (draft from the order) |
| Dispatches | `GET/POST /dispatches`, `GET/PATCH /dispatches/:id`, `POST /dispatches/:id/dispatch` · `/cancel` `{version, reason}` · `/discard`, `POST /dispatches/:id/invoices`, `GET /dispatches/:id/pdf` |
| Invoices | `GET/POST /sales-invoices`, `GET/PATCH /sales-invoices/:id`, `POST /sales-invoices/:id/issue` `{version, expectedTotal?, overrideCreditLimit?}` · `/cancel` `{version, reason}` · `/discard`, `GET /sales-invoices/:id/pdf` |
| Receivables | `GET /receivables?legalEntityId=[&asOf=&partyId=]` |
| Logo | `PUT /legal-entities/:id/logo` `{version, image: {contentType, data (base64)} \| null}` |

Lists take `?legalEntityId=&status=&partyId=&q=&limit=&cursor=` (`q` matches the start of the number or part of the customer name).
- Drafts are created with every input field; `PATCH` sends only the fields that change, plus `version`. Figures are always computed by the server.
- Numbering commands, and commands that move stock or post, need an `Idempotency-Key`: send, confirm, cancel, close, dispatch and issue. Accept, reject, revise, discard and the "make a draft from" commands don't.
- `expectedTotal` on issue guards against rates or masters changing after the user last saw the invoice: a different total gives 409 `VERSION_CONFLICT`, with the new total in `details`.
- Going over a credit limit gives 422 `BUSINESS_RULE` with `details[0].path = "creditLimit"`.
- A missing series gives 422 with `path = "seriesId"`.

**Idempotency-Key** (required since Phase 6 on `POST /stock-adjustments/:id/post`, `/stock-transfers/:id/dispatch|receive|cancel`, `/stock-counts/:id/post`): 16–64 letters, digits or hyphens; use one new key per user action and the same key when retrying it. A repeat with the same key and body replays the first response with `Idempotent-Replayed: true`; the same key with a different request (or another user) gives 422 `IDEMPOTENCY_KEY_REUSED`; a repeat while the first is still running gives 409 `IDEMPOTENCY_IN_PROGRESS`. A request that failed leaves no record, so it can be retried with the same key.

PATCH bodies contain only the fields that change. The contracts build them with `patchShape()`, because a Zod `.partial()` would fill in defaults for omitted fields. Saving a party whose GSTIN, PAN or phone matches another returns 409 `DUPLICATE`, with the matches in `details`; send `confirmDuplicates: true` to save anyway, which is audited.

Request and response schemas live in `packages/contracts/src/*.ts` (Phase 7: `sales.ts`), which is the source of truth. `openapi.yaml` still covers only the health endpoints; generating it from the contracts is backlog item 15. `MFA_REQUIRED` responses carry `details[0].message` set to `step_up` or `enrolment_required`.

## Data types
- Money, quantities, rates: **decimal strings** (`"1180.00"`). Numbers are rejected for these fields.
- Dates: business dates `YYYY-MM-DD`; timestamps ISO-8601 UTC.
- IDs: 24-hex ObjectId strings, validated before any query (prevents operator injection).
- Unknown body properties are rejected (`strict` schemas) → 400 `VALIDATION_FAILED`.

## Lists
`?limit=25&cursor=<opaque>&sort=-docDate&q=…&status=issued` — only allowlisted filter and sort fields; cursor pagination; `limit` ≤ 100. Response `{ data: [...], page: { nextCursor, limit } }`.

## Error envelope
```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed", "requestId": "…", "details": [{ "path": "lines.0.qty", "message": "Expected decimal string" }] } }
```
| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `BAD_REQUEST`, `MALFORMED_JSON` | schema/parse errors |
| 401 | `UNAUTHENTICATED` | no/expired session |
| 403 | `FORBIDDEN`, `CSRF_INVALID`, `MFA_REQUIRED` | permission/CSRF |
| 404 | `NOT_FOUND` | missing **or out-of-scope** resource |
| 409 | `INVALID_STATE`, `VERSION_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `DUPLICATE` | |
| 413 | `PAYLOAD_TOO_LARGE` | |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | |
| 422 | `BUSINESS_RULE`, `IDEMPOTENCY_KEY_REUSED`, `PERIOD_LOCKED`, `INSUFFICIENT_STOCK` | |
| 429 | `RATE_LIMITED` | with `Retry-After` |
| 500 | `INTERNAL` | never includes stack/DB error text |
| 503 | `NOT_READY` | readiness failure |

## Versioning
Breaking changes → `/api/v2`; additive changes are non-breaking. Contracts live in `packages/contracts` and the OpenAPI file is kept in sync (contract test in CI from Phase 3).
