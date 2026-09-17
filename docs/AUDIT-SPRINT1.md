# Sprint 1 Audit — TASK-106

**Date:** 2026-09-17 · **Mode:** Auditor (static review, no shell) · **Sprint:** 1 (Foundation & Data Model)
**Inputs:** [docs/SPRINTS.md](SPRINTS.md) · [docs/REQUIREMENTS.md](REQUIREMENTS.md) · [docs/DESIGN.md](DESIGN.md) incl. §14 · user-executed runtime evidence 2026-09-17 (`cp .env.example .env && docker compose up -d postgres && npm install && npm run db:migrate && npm test` → ALL PASSED) · full source of [src/](../src) + [tests/](../tests).

## 1. Sprint 1 DoD verification

Evidence classes: **V-UO** = verified by user terminal output · **V-CODE** = code-present, statically verified, no runtime evidence · **MISSING** = absent.

| # | DoD item ([SPRINTS.md](SPRINTS.md) L22–27) | Evidence | Verdict |
|---|---|---|---|
| 1 | `docker compose up` → app + Postgres healthy | Postgres: **V-UO** (up + healthy; all DB suites ran against it). App: **MISSING by plan** — [docker-compose.yml](../docker-compose.yml:18) deliberately ships postgres-only; app container is ratified Sprint 7 scope (TASK-702). `/api/health` HTTP 200: **V-CODE** ([route](../src/app/api/health/route.ts:7) does `SELECT 1` → 200/503) — curl step still pending. | **NOT PASS as written** — DoD text conflicts with the ratified plan (finding F1); reword + run the pending curl |
| 2 | Migrations apply cleanly, re-runnable | Apply: **V-UO** (0000_init.sql applied cleanly). Re-runnable: **V-CODE** — [migrate.mjs](../scripts/migrate.mjs:47) skips ledger-recorded files ([schema_migrations](../scripts/migrate.mjs:36)); second run was not executed but the mechanism is deterministic. | **PASS** (note: run `npm run db:migrate` twice for belt-and-braces evidence) |
| 3 | Owner login/logout works; RBAC tests pass (401/403 paths) | **V-UO** — `auth/rbac` + `auth/session` suites green: real argon2id login (wrong password → 401, unknown email → 401, correct → 200 + HttpOnly cookie), expired/no/garbage session → 401, cross-salon owner & employee → 403, §14.1 employee gate 403/resolve, logout 401-unguarded + row delete + cookie clear. | **PASS at API level** — UI gap: `/admin/login` page not built (F2) |
| 4 | Salon CRUD functional; all tests green | Tests green: **V-UO** (full suite). Salon CRUD: **V-CODE only** — [salons routes](../src/app/api/admin/salons/route.ts:66) + [[id] routes](../src/app/api/admin/salons/[id]/route.ts:76) exist and look correct (platform_admin gate, POST tx creates settings, 23505→422, 23503→409, uuid-gate 404s), but **zero tests exercise them** and no HTTP evidence exists. | **PARTIAL** — "functional" is a claim, not evidence (F4) |
| 5 | Committed with conventional message | **MISSING** — TASK-107 not yet run (expected sequencing, not a defect). | **OPEN** |

**Sprint close verdict: NOT closeable today.** Outstanding: pending `/api/health` curl; F2 decision; F4 salon-CRUD evidence (+F10 bootstrap); TASK-107 commit.

## 2. REQ status recommendations (for [REQUIREMENTS.md](REQUIREMENTS.md) — Scrum Lead applies)

No REQ is marked `done`. Per-REQ:

| REQ | Test-proven now (V-UO) | Remaining (pointer) | Recommendation |
|---|---|---|---|
| REQ-002 | Services DDL surface: duration>0, buffers≥0, price≥0, `UNIQUE(salon_id,name)` + cross-salon same-name OK; active partial index exists; scoped repo CRUD (create/update/list/get) green | Owner CRUD routes/UI → TASK-402 (S4); inactive-hidden proof in customer flow → TASK-301 (S3) + engine active-only reads TASK-202 (S2) | **in-progress** |
| REQ-003 | working_hours/time_off CHECK surface (minutes 0–1439, start<end, weekday 1–7, starts<ends) + composite-FK cross-salon rejection green | Employees CRUD routes/UI + **overlap-at-save** (§3.5) → TASK-402 (S4); same-day slot-engine reflection → TASK-201/202 (S2) | **in-progress** |
| REQ-009 | Full 401/403 matrix per DoD #3: real argon2id login, session lifecycle, cross-salon, §14.1 employee-gate; both roles covered | `/admin/login` page (F2, S1-scoped by DESIGN §2.2); login timing equalization → TASK-701; untested §14.1 owner-positive branch (F5) | **in-progress** (closest to done; do NOT set `done` while an S1-scoped artifact is absent) |
| REQ-012 | Composite-FK cross-salon rejections (23503); factory throws unscoped; `get`/`list`/settings isolation (salon A never leaks into B) green | "platform admin can CRUD salons" — routes V-CODE, no test/HTTP evidence (F4) + no admin bootstrap path (F10); public slug resolution → S3 | **in-progress** |

## 3. Code-vs-design drift spot-check (DESIGN §3/§4/§5/§14)

**Verified no deviation** (static parity check):

- [schema.ts](../src/db/schema.ts:36) ↔ [0000_init.sql](../src/db/migrations/0000_init.sql:11): 10 tables, all CHECKs/indexes/UNIQUEs/constraint names match 1:1.
- §14.3: all six role-consistency CHECKs present in both artifacts ([schema.ts](../src/db/schema.ts:152), [SQL](../src/db/migrations/0000_init.sql:115)).
- §3.10: exclusion constraint verbatim incl. `btree_gist` + `WHERE (status='confirmed')` ([SQL](../src/db/migrations/0000_init.sql:197)); correctly absent from Drizzle DSL.
- §14.5 ratified deviations: all five present (plain-SQL ledger runner; `duration_minutes` DEFAULT 30; `price_cents` DEFAULT 0; `created_via` DEFAULT 'customer'; exclusion SQL-only). No *unratified* schema deviations found.
- §4/§14.2 repos: [createRepos()](../src/repos/index.ts:231) refuses empty scope; every query `and(eq(id), eq(salon_id))`; camelCase domain objects; `settings.get()/update()` surface as amended.
- §5.1/§5.3: [SessionUser](../src/lib/auth/session.ts:22) shape exact; cookie HttpOnly/SameSite=Lax/Path=//7d/Secure(prod) ([sessionCookie()](../src/lib/auth/session.ts:78)); token = sha256-hex `char(64)`; argon2id OWASP params m=19456,t=2,p=1 ([password.ts](../src/lib/auth/password.ts:13)).
- §5.2: [middleware.ts](../src/middleware.ts:10) is cookie-presence-only (edge-safe, UX not security) with `/admin/login` exemption.
- §8: [.env.example](../.env.example:1) lists `DATABASE_URL` + all six SMTP placeholders; no secrets in files.
- [getSessionUser()](../src/lib/auth/session.ts:65) lazy-deletes **all** expired rows (superset of §3.7's "lazily deleted on read") — compliant.

**No IMPLEMENTATION MISSING findings** in shipped code — every export referenced by tests exists. Plan-vs-code gaps are F2/F3 below.

## 4. tests/README.md red/green map vs reality

TASK-103-era map ([tests/README.md](../tests/README.md:9)) was accurate for its time:

| File | README claim (TASK-103 era) | Verified reality | Now |
|---|---|---|---|
| [smoke.test.ts](../tests/smoke.test.ts) | GREEN | ✓ | GREEN (V-UO) |
| [constraints.test.ts](../tests/db/constraints.test.ts) | SKIPPED (probe) | ✓ `describe.skipIf(!status.ready)` | GREEN (V-UO) |
| [exclusion.test.ts](../tests/db/exclusion.test.ts) | SKIPPED (probe + `contype='x'`) | ✓ dual-gate [db.ts](../tests/helpers/db.ts:95) | GREEN (V-UO) |
| [scoping.test.ts](../tests/repos/scoping.test.ts) | RED at import | ✓ static `createRepos` import; **also** skipIf-gated | GREEN (V-UO) |
| [rbac.test.ts](../tests/auth/rbac.test.ts) | RED at import | ✓ static imports; **also** skipIf-gated (L117) | GREEN (V-UO) |
| [session.test.ts](../tests/auth/session.test.ts) | RED at import | ✓ static imports; **also** skipIf-gated | GREEN (V-UO) |

Nuance: the three "RED at import" files are *also* DB-gated, so post-code/pre-DB they would skip (not fail) — README narrative is mildly imprecise, immaterial. The "Current state" table is now **stale** (describes pre-implementation red; reality 2026-09-17: all six green) → F7.

## 5. Findings & remediation

| ID | Severity | Finding | Remediation → task |
|---|---|---|---|
| F1 | minor (planning) | DoD #1 says "docker compose up → app + Postgres healthy" but app-in-compose is ratified S7 scope ([compose comment](../docker-compose.yml:18)); item is unsatisfiable as written in S1 | Scrum Lead amends DoD #1 wording at close: "postgres healthy via compose; app health = dev-server `/api/health` 200" + run pending curl |
| F2 | minor → **decision required** | `/admin/login` page (DESIGN §2.2, S1, REQ-009) not built; only API routes exist. Middleware currently redirects unauthenticated `/admin/*` to a 404 | Recommend: build minimal page **before TASK-107** (smallest scope; redirect target already exists in middleware). Alternative: formal re-plan to S2 + DESIGN amendment note. Route: Scrum Lead → CODE |
| F3 | minor | DESIGN §2.3 marks `/api/admin/services`, `/api/admin/employees` (+working-hours, time-off), `/api/admin/settings` as "S1/S4" — none built in S1; SPRINTS TASK-105 scoped only login/logout/salons. Authority docs disagree on the split | Scrum Lead clarifies; default absorb into TASK-402 (S4). S2 engine reads settings via repos — no HTTP route needed before S4 [CONF: HIGH] [SRC: DOC — DESIGN §4 scope provenance] |
| F4 | minor | Zero tests exercise `/api/admin/salons` handlers (POST tx creating `salon_settings`, 23505→422, DELETE 23503→409, uuid 404s, platform_admin gate). DoD #4 "Salon CRUD functional" and REQ-012's third clause are unevidenced | Add route-level integration tests (login as platform_admin → CRUD cycle). Route: Scrum Lead → TDD; suggest small task before TASK-107 or earliest in S2 |
| F5 | note | §14.1 owner-positive branch implemented ([rbac.ts](../src/lib/auth/rbac.ts:39)) but untested: owner + `opts.employeeId` + matching `opts.salonId` → resolve; owner **without** `opts.salonId` → 403 (trap for future callers). Supersedes README gap #6, tests never extended | Add 2 tests; fold into F4's task |
| F6 | note | Login unknown-email path skips argon2 verify → timing oracle ([login/route.ts](../src/app/api/auth/login/route.ts:27)). Already routed TASK-701 — confirmed still present | TASK-701 (S7) |
| F7 | minor (docs) | [tests/README.md](../tests/README.md:7) "Current state" table describes TASK-103-era red; stale vs 2026-09-17 all-green | Update table to current state on sprint close (Auditor docs pass, on user sign-off) |
| F8 | note | `toJson` / `pgErrorCode` / `isValidTimezone` / slug schema duplicated across [salons/route.ts](../src/app/api/admin/salons/route.ts:17) and [salons/[id]/route.ts](../src/app/api/admin/salons/[id]/route.ts:16) | REFACTORER — absorb into TASK-402 when salon routes multiply |
| F9 | note | PATCH `/api/admin/salons/[id]` cannot null-out nullable fields (`address/phone/email` optional, not nullable); PUT-replace semantics unspecified in DESIGN | Decide at TASK-402 (S4) if UI needs field clearing |
| F10 | note | No platform-admin bootstrap path exists (no seed script/CLI/README SQL) — blocks F4's manual evidence: nobody can log in as platform_admin without hand-written SQL | Fold into F4's task (seed helper or documented SQL snippet) |

## 6. Verdict

Implementation quality: high — schema/SQL parity exact, all ratified §14 amendments honored, no silent deviations, no hallucinated references. Process: DoD #2/#3 pass on hard evidence; #1/#4 are blocked on wording defects and missing route-level evidence respectively, not on bad code. **Sprint 1 cannot close until:** pending `/api/health` curl · F2 decision (recommend: build `/admin/login` page now) · F4 salon-CRUD evidence (+F10) · TASK-107 commit.
