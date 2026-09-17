# Sprint Ledger — Hair Salon Platform

Pipeline per feature: ARCHITECT → TDD → CODE → AUDIT → GIT. On demand: RESEARCHER, DEBUG, REFACTORER, SECURITY, DEVOPS, SRE.
A sprint closes only on verified DoD evidence (test output, audit report) — never on agent self-assessment.

Design authority: docs/DESIGN.md (TASK-101, approved — sign-off §13). Contracts in DESIGN §5.3/§6.1/§6.3/§7/§8 are binding for TDD and implementation.

## Sprint 1 — Foundation & Data Model
**Goal:** Runnable skeleton: app scaffold, dev compose, full schema + migrations, staff auth with RBAC, salon CRUD.
**Refs:** REQ-002, REQ-003, REQ-009, REQ-012

Tasks:
- TASK-101: ✅ done (2026-09-17) — [ARCHITECT] System design doc: docs/DESIGN.md. refs REQ-005, REQ-009, REQ-012
- TASK-102: ✅ code-complete, runtime verification deferred to TASK-106 — [CODE] Scaffold Next.js + TS, dev compose, Drizzle, /api/health, Vitest smoke test, .env.example, README. refs REQ-012
- TASK-103: ✅ done (2026-09-17) — [TDD] 7 spec files + red/green map (tests/README.md); coverage mapping REQ-002/003/007(DDL)/009/012. 4 contract gaps routed to Scrum Lead → resolved as DESIGN §14.
- TASK-103b: ✅ done (2026-09-17) — [TDD] §14.3 clause→test mapping complete (constraints.test.ts); auth fixture seeds migrated to §14.3-valid form; tests/README.md gap #4 RESOLVED.
- TASK-104: ✅ code-complete, execution deferred to TASK-106 — [CODE] schema.ts (10 tables), 0000_init.sql (incl. §3.10 verbatim), scripts/migrate.mjs + db:migrate, scoped repos. 4 deviations ratified as DESIGN §14.5.
- TASK-105: ✅ code-complete, execution deferred to TASK-106 — [CODE] auth (argon2id, DB sessions, requireRole §14.1), login/logout/salons routes, middleware gate. 6 notes; timing-equalization routed to TASK-701.
- TASK-106: [AUDIT] Verify Sprint 1 DoD incl. deferred TASK-102 runtime checks (npm install && npm test, docker compose up -d postgres, /api/health 200), report evidence.
- TASK-108: ✅ done (2026-09-17) — [TDD] tests/admin/salons.test.ts (F4 matrix, 13 cases), rbac.test.ts F5 additions (4 cases), tests/README refreshed. 6 inspection notes; F8/F9-adjacent routed to TASK-402.
- TASK-109: ✅ code-complete — [CODE] /admin/login page + login form, bootstrap-admin CLI (upsert, hidden prompt, exit codes 0/1/2), npm script, README. Argon2 params duplicated pending TASK-402 dedup (no TS-runner dep).
- TASK-107: ✅ done (2026-09-17) — [GIT] Sprint 1 committed (conventional commits; suite re-run green pre-commit: 112/112).

Definition of Done:
- [x] `docker compose up -d postgres` → Postgres healthy; dev server `/api/health` → 200 {"status":"ok"} (user-verified 2026-09-17; app containerization deferred to S7 per DESIGN §10 — F1 wording fix)
- [x] Migrations apply cleanly and are re-runnable (user-verified; schema_migrations ledger)
- [x] Owner login/logout works; RBAC tests pass (user-verified login incl. redirect; logout + 401/403 matrix green)
- [x] Salon CRUD functional; all tests green (TASK-108 suite green; full suite green twice: 2026-09-17 pre- and post-remediation)
- [x] Committed with conventional message → TASK-107

## Sprint 2 — Slot Engine, Gap Rule, Concurrency
**Goal:** Core domain logic proven by tests before any UI.
**Refs:** REQ-004, REQ-005, REQ-006, REQ-007

Tasks:
- TASK-201: ✅ done (2026-09-17) — [TDD] 6 files, 55 red tests (engine 18, gap-rule 10, create 12, race 2, cancel 3, slots-api 10); notification seam decided (setNotificationPort); 6 ambiguities routed → ratified DESIGN §14.6.
- TASK-201b: ✅ done (2026-09-17) — [TDD] 5 cancel error-path cases (strict error-shape equality, cross-salon indistinguishability, idempotent-fail, no-notification-on-error). Sprint 2 spec phase: 60 red tests across 7 files.
- TASK-202: ✅ done (172/172 green incl. 28 pure slot tests) — [CODE] types/engine/gapRule/port per §6/§14.6; ratifications §14.6(h)(i).
- TASK-203: ✅ done (user-verified 2026-09-17: 172/172 green, race test 1-winner/19-occupied, REQ-006 threshold flip case green) — [CODE] bookings {types,create,cancel}, slots service wrapper, public slots+bookings routes, @types/luxon. 6 ratifications §14.6(j).
- TASK-201c: ✅ done (2026-09-17) — [TDD] 4 DST pinning cases (start/end-endpoint skip, both-exist sanity, fall-back early-offset characterization); tests/README refreshed to 176-test inventory. Expect 176/176 at pre-commit run.
- TASK-204: ✅ done (2026-09-17) — [AUDIT] docs/AUDIT-SPRINT2.md: DoD 1–3 PASS (evidence pointers), 0 blockers; REQ-005/007 → done; REQ-004/006 stay in-progress (HTTP tests → S3, A1 surface → TASK-402); REQ-008/011 → in-progress.
- TASK-205: [GIT] Commit Sprint 2.

Definition of Done:
- [ ] All engine unit tests pass incl. DST boundaries, buffer math, fragment blocking
- [ ] 20-way parallel booking race test: exactly 1 winner
- [ ] Gap threshold change alters outcomes (test-proven)
- [ ] Committed

## Sprint 3 — Customer Site & Booking Wizard
**Goal:** Public face: landing + full guest booking flow.
**Refs:** REQ-001, REQ-004

Tasks:
- TASK-301: [CODE] Landing page per salon (services, prices, hours), responsive + clean. refs REQ-001
- TASK-302: [CODE] Booking wizard: salon → service → stylist → slot → contact → confirmation. refs REQ-004
- TASK-303: [AUDIT] Verify Sprint 3 DoD, report evidence.
- TASK-304: [GIT] Commit Sprint 3.

Definition of Done:
- [ ] Lighthouse mobile ≥ 90 on landing
- [ ] E2E happy path: guest books a slot end-to-end
- [ ] Invalid slot submission rejected server-side (test)
- [ ] Committed

## Sprint 4 — Employee Admin UI
**Goal:** Calendar tooling and reservation management for staff.
**Refs:** REQ-002, REQ-003, REQ-006, REQ-008

Tasks:
- TASK-401: [CODE] Calendar UI: day/week views, role-scoped visibility, gap indicators. refs REQ-008
- TASK-402: [CODE] Manual booking (bypass A1 per DESIGN §5.4: owner salon-wide, employee own calendar), edit, cancel; service/employee/working-hours CRUD; salon settings incl. gap threshold. AUDIT-SPRINT1 remediation absorbed here: F8 route-helper dedup (Refactorer pre-pass), F9 PATCH null-out + empty-body semantics (spec first). refs REQ-002, REQ-003, REQ-006, REQ-008
- TASK-403: [AUDIT] Verify Sprint 4 DoD, report evidence.
- TASK-404: [GIT] Commit Sprint 4.

Definition of Done:
- [ ] Owner sees salon-wide calendar; employee only own (test)
- [ ] Manual booking can bypass gap rule; customer flow cannot (test)
- [ ] Cancel frees slot immediately (test)
- [ ] Committed

## Sprint 5 — Email Notifications
**Goal:** Transactional email for booking lifecycle.
**Refs:** REQ-011

Tasks:
- TASK-501: [TDD] Spec notification service per DESIGN §8: send on confirm/cancel, failure isolation. refs REQ-011
- TASK-502: [CODE] SMTP integration (SmtpNotificationAdapter), templates, `.env.example` with placeholders (no secrets in files). refs REQ-011
- TASK-503: [AUDIT] Verify Sprint 5 DoD, report evidence.
- TASK-504: [GIT] Commit Sprint 5.

Definition of Done:
- [ ] Confirmation + cancellation emails send with valid SMTP env
- [ ] Send failure logged, booking unaffected (test)
- [ ] `.env.example` documents all vars; no secrets committed
- [ ] Committed

## Sprint 6 — Customer Accounts
**Goal:** Optional accounts with history and self-service.
**Refs:** REQ-010

Tasks:
- TASK-601: [TDD] Spec account flows: register, login, history, self-cancel, guest coexistence. refs REQ-010
- TASK-602: [CODE] Implement accounts + history + self-cancel (customers table pre-wired per DESIGN §3.8). refs REQ-010
- TASK-603: [AUDIT] Verify Sprint 6 DoD, report evidence.
- TASK-604: [GIT] Commit Sprint 6.

Definition of Done:
- [ ] Guest and account bookings coexist (test)
- [ ] Self-cancel frees slot and triggers cancellation email (test)
- [ ] Committed

## Sprint 7 — Hardening & Deployment
**Goal:** Production-ready deployment.
**Refs:** REQ-013

Tasks:
- TASK-701: [SECURITY] OWASP pass: auth, injection, input validation + login dummy-hash timing equalization (routed from TASK-105 note 3). refs REQ-009, REQ-013
- TASK-702: [SRE] Production compose (app + Postgres) + Caddy reverse proxy + HTTPS. refs REQ-013
- TASK-703: [INFRASEC] Caddyfile security-header review. refs REQ-013
- TASK-704: [AUDIT] Final audit + REQ status reconciliation.
- TASK-705: [GIT] Tag v1.0.0.

Definition of Done:
- [ ] Security findings resolved or accepted with justification
- [ ] `podman compose up` full stack healthy; smoke test books a slot end-to-end
- [ ] Caddyfile passes InfraSec review
- [ ] v1.0.0 tagged

---

## Execution Log

- 2026-09-17 TASK-101 done — docs/DESIGN.md approved by Scrum Lead (§13 sign-off: all 5 architect decisions approved).
- 2026-09-17 TASK-102 code-complete — scaffold on disk (app tree, compose, Drizzle, health route, Vitest, .env.example, README). Sub-agent session had no shell: `npm install && npm test`, `docker compose up -d postgres`, `/api/health` check NOT yet run — enforced at TASK-106 before sprint close.
- 2026-09-17 TASK-103 + TASK-103b done — spec suite red/green-mapped; 4 contract gaps resolved as DESIGN §14 (requireRole employeeId opt, repo surface, staff_users role CHECKs, real-argon2 login tests).
- 2026-09-17 TASK-104 code-complete — data layer on disk; migrations runner + repos; deviations §14.5. Runtime verification (install/migrate/tests) at TASK-106.
- 2026-09-17 TASK-105 code-complete — auth + salon CRUD on disk. Sprint 1 implementation phase ends; TASK-106 audit requires user-executed runtime evidence (no shell in any sub-agent session).
- 2026-09-17 User runtime evidence: install + compose + migrate + full test suite ALL GREEN (user terminal).
- 2026-09-17 TASK-106 audit done → docs/AUDIT-SPRINT1.md. Dispositions: F1 DoD reworded (ledger defect); F3 resolved — route split stands as built (salon routes S1, remaining admin routes S4); F2/F4/F5/F7/F10 → TASK-108/109; REQ-002/003/009/012 → in-progress. Sprint close pending: remediation + health curl + TASK-107.
- 2026-09-17 SPRINT 1 CLOSED — final user verification all green (tests, bootstrap, login flow, health); TASK-108/109 done; commits 079e8da + 66c6dfd (48 files, +9794; suite 112/112 green pre-commit; .env/node_modules excluded; unpushed). REQ-009, REQ-012 → done.
