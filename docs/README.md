# Documentation Index

All documents are **draft v0.1 (2026-10-19)** unless stated otherwise. Related topics are consolidated into a few documents for maintainability.

| Area | Document | Contents |
|---|---|---|
| Requirements | [requirements/product-and-requirements.md](requirements/product-and-requirements.md) | Product brief, personas & scenarios, MVP/deferred scope, functional & non-functional requirements, acceptance criteria |
| | [requirements/workflows.md](requirements/workflows.md) | State-transition specifications for every document type |
| | [requirements/traceability.md](requirements/traceability.md) | Requirement → design → implementation → test matrix |
| Architecture | [architecture/architecture.md](architecture/architecture.md) | System diagram, modules, request pipeline, tenant model, transaction boundaries, idempotency, numbering, outbox, files |
| | [architecture/decisions.md](architecture/decisions.md) | ADR-001 to ADR-012, incl. the MongoDB vs PostgreSQL evaluation and verified toolchain versions |
| | [architecture/financial-policy.md](architecture/financial-policy.md) | Money/quantity/tax representation, rounding stages, discount allocation, valuation, journals, report labels |
| Database | [database/schema.md](database/schema.md) | Collections, ER diagram, index plan, migration strategy |
| API | [api/api-conventions.md](api/api-conventions.md), [api/openapi.yaml](api/openapi.yaml) | Conventions, error codes, OpenAPI (Phase 1 implemented, rest planned) |
| Design | [design/design-system.md](design/design-system.md) | Reference analysis (**blocked**), design brief, provisional tokens, screens, navigation map, components, responsive, states, accessibility, visual checklist |
| Security | [security/security.md](security/security.md) | Threat model, sessions, tenant isolation, browser security, uploads, logging, privacy & retention, incident response, checklist |
| | [security/permission-matrix.md](security/permission-matrix.md) | Permissions × system roles |
| Compliance | [compliance/gst.md](compliance/gst.md) | GST requirements matrix, supported/unsupported scenarios, document particulars, e-invoice/e-way-bill boundaries, source register, legal-review items |
| Testing | [testing/testing-strategy.md](testing/testing-strategy.md) | Test layers, required suites, conventions, verification reporting |
| Operations | [operations/operations.md](operations/operations.md) | Environments, config reference, CI/CD, backup/restore, migration, monitoring, release checklist, developer setup |
| Planning | [planning/roadmap.md](planning/roadmap.md) | Phases, backlog, deferred features |
| | [planning/progress.md](planning/progress.md) | Progress log and next executable task |

## Status vocabulary
**Verified** (checked against a recorded source on a date) · **Verified-secondary** · **Recommended** · **Assumed** · **Unresolved**. Test results: **Passed · Failed · Not run · Blocked · Manual review required**.
