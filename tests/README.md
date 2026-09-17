# Test Suite — Sprint 1 Status (TASK-103 → TASK-108)

Specs for the data layer, RBAC, and salon-CRUD routes per
[docs/DESIGN.md](../docs/DESIGN.md) §3/§4/§5/§14 and [docs/SPRINTS.md](../docs/SPRINTS.md).
Originally authored RED-first (TASK-103); implementation landed in TASK-104/105;
audit remediation specs added in TASK-108 (findings F4/F5 — see
[docs/AUDIT-SPRINT1.md](../docs/AUDIT-SPRINT1.md)).

## Current state (2026-09-17, post-migration — user-verified all green)

| File | State | Notes |
|---|---|---|
| `tests/smoke.test.ts` | GREEN | Runner sanity (V-UO 2026-09-17) |
| `tests/db/constraints.test.ts` | GREEN | skipIf-gated on DB probe; active since migrations applied |
| `tests/db/exclusion.test.ts` | GREEN | Dual-gated (tables + §3.10 `contype='x'` probe) |
| `tests/repos/scoping.test.ts` | GREEN | `createRepos` implemented (TASK-104) |
| `tests/auth/rbac.test.ts` | GREEN | + TASK-108 F5 additions: §14.1 owner-positive branch (4 tests, appended describe) |
| `tests/auth/session.test.ts` | GREEN | TASK-105 session lib |
| `tests/admin/salons.test.ts` | NEW (TASK-108, F4) | Route-level salon-CRUD matrix vs existing TASK-105 handlers — spec-after-implementation remediation; green required at the post-TASK-109 verification run |

History: the TASK-103-era map described the pre-implementation red ("RED at
import" / DB-probe skips). That state is obsolete — superseded by this table.
The three former "RED at import" files were also DB-gated, so they skipped
(rather than failed) in the post-code/pre-DB window; the old narrative was
mildly imprecise on that point (audit §4 nuance).

**Code-pending, resolved by TASK-109** (not test gaps — no spec changes needed):

- **F2** — `/admin/login` page (DESIGN §2.2, REQ-009, S1 scope). API routes and
  middleware redirect target exist; the page itself does not yet.
- **F10** — `scripts/bootstrap-admin.mjs`: no platform-admin bootstrap path
  exists (blocks manual login-as-platform_admin evidence for the F4 specs;
  the specs themselves stage sessions directly in the DB and are unaffected).

## Activation steps

```bash
docker compose up -d postgres
cp .env.example .env          # set DATABASE_URL
npm install
npm run db:migrate            # TASK-104: full §3 DDL incl. §3.10 exclusion SQL
npm test
```

The DB-gated files self-activate — `getDbStatus()` re-probes on every run, so
applying migrations is the only "flip the switch" action. No test edits needed.

If the implementation uses `@/` self-imports inside `src/` (e.g. rbac.ts
importing `@/lib/auth/session`), Vitest needs the alias — add to
`vitest.config.ts`: `resolve: { alias: { "@": path.resolve(__dirname, "src") } }`.
Specs themselves use relative imports and are alias-agnostic. [CONF: HIGH]
[SRC: DOC — Vitest does not read tsconfig paths]

## Isolation model (tests/helpers/db.ts)

- **TX mode** (`constraints`, `exclusion`): exclusive client + BEGIN/ROLLBACK
  per test; intentional violations asserted via SAVEPOINT-wrapped
  `Db.expectCode()` so the transaction survives the error.
- **PLAIN mode** (`scoping`, `auth`, `admin/salons`): NO outer transaction —
  code under test may call `db.transaction()` internally (POST /api/admin/salons
  does), which would silently COMMIT/ROLLBACK an outer test transaction.
  Unique-per-run seeds + `Seeder.cleanup()` cascade (staff_users → salons →
  customers) instead. `salons.test.ts` additionally deletes route-created
  salons in afterEach (after `seed.cleanup()`, so blocking staff_users are
  gone first).

## Coverage mapping (REQ → tests)

| REQ | AC / Design ref | Tests |
|---|---|---|
| REQ-002 | §3.3 services CHECK surface | `constraints.test.ts` › services: duration>0, buffers≥0, price≥0 (0 accepted), UNIQUE(salon_id,name) + same-name-other-salon accepted |
| REQ-003 | §3.5 working_hours + §3.6 time_off CHECK surface | `constraints.test.ts` › working_hours: minutes 0–1439 boundaries, start<end (incl. equal), weekday 1–7 boundaries; time_off: starts<ends |
| REQ-009 | §5.1 login, §5.3 contracts, §5.4 matrix | `rbac.test.ts`: wrong password→401, unknown email→401, correct→200+HttpOnly cookie; employee→owner 403; no/garbage/expired session→401; cross-salon owner & employee→403; platform_admin≠owner→403 + own role resolves; ownEmployeeIdOnly other stylist→403 / own→resolve. `session.test.ts`: SessionUser shape (owner/employee/platform_admin), expired→null+lazy row delete, unknown/no cookie→null, logout deletes row + clears cookie + 401 unguarded |
| REQ-009 (§14.1 owner branch — F5, TASK-108) | employee-gate: owner-of-salon resolves; explicit-salon trap; platform_admin never passes | `rbac.test.ts` › "§14.1 employee-gate owner branch": owner+employeeId+matching salonId resolves as owner; owner+employeeId without salonId→403; platform_admin+employeeId+salonId→403; employee E1 vs employeeId E2→403 without `ownEmployeeIdOnly` |
| REQ-009 (§14.3 DB surface) | staff_users role-enum + role-consistency CHECKs (TASK-103b) | `constraints.test.ts` › staff_users §14.3: role outside enum rejected (incl. case variant); employee⇒employee_id; owner⇒no employee_id; platform_admin⇒flag true + salon NULL + employee NULL; flag⟺role; NOT flag⇒salon NOT NULL |
| REQ-012 | §3 composite FKs, §4 factory + scoping | `constraints.test.ts` › composite FKs: booking→cross-salon service/employee, working_hours→cross-salon employee (all 23503) + all-A positive; `scoping.test.ts`: factory throws without/empty salonId, six repos constructed, get() cross-salon→null + positives, list() never leaks B rows, settings scope-isolated (45 vs 75) |
| REQ-012 (route clause — F4, TASK-108) | "platform admin can CRUD salons" | `admin/salons.test.ts`: 401 no-session / 403 owner+employee on all five handlers; POST 201 + slug + settings defaults 45/15 (DB-verified); slug [a-z0-9-]+ violations (uppercase/underscore/empty) → 422 on POST and PATCH; duplicate slug → 422 POST and PATCH; unknown uuid + non-uuid → 404; DELETE 204 + cascade (settings/services/employees/bookings); DELETE with staff → 409 |
| REQ-007 (DDL surface only) | §3.10 | `exclusion.test.ts`: overlap same employee→23P01, non-overlap/adjacent OK, different employee OK, buffered-range overlap→23P01, cancelled→slot free, completed→no block. 20-way parallel race = TASK-201 (per §3.10 justification) |
| REQ-004/005/008 (side surface) | §3.9 | `constraints.test.ts` › bookings: starts<ends, blocked-contains-actual (incl. equal boundary), status enum. `exclusion.test.ts`: cancel-frees-slot at DB level |

## Documented decisions & flagged gaps

1. **Login strategy**: integration with a real argon2id hash seeded via
   `@node-rs/argon2.hash()` — exercises the real verify path, no stub. [CONF: HIGH]
2. **`requireRole` ownEmployeeIdOnly gap — RESOLVED (§14.1)**: the missing
   target parameter was ratified as `opts.employeeId` (employee_id of the
   stylist whose resource is accessed). Since §14.1 its presence alone
   activates the gate; `ownEmployeeIdOnly` is signature-compat only. Owner
   branch coverage added TASK-108 (F5).
3. **Repo method surface**: §4 names entities but not methods. Specs assume
   `get(id)` / `list()` / `settings.get()` with camelCase domain fields
   (`gapThresholdMinutes`). Implemented as assumed (TASK-104). [CONF: MED]
   [SRC: INFERENCE from §4]
4. **`role='employee'` without `employee_id` — RESOLVED (TASK-103b)**: DESIGN
   §14.3 (binding) supersedes §3.7's single XOR CHECK with the full
   role-consistency set; covered in `constraints.test.ts` › staff_users §14.3.
5. **Module path mapping** per §9: `SessionUser`+`getSessionUser` ←
   `src/lib/auth/session.ts`; `requireRole` ← `src/lib/auth/rbac.ts`.
6. **Not tested here by design**: working-hours overlap-at-save (§3.5 save-time
   advisory lock, Sprint 4), slot engine/gap rule (TASK-201), middleware
   presence-check (§5.2 UX-only, not a security boundary). The former
   owner-satisfies-employee substitution question is now SPECIFIED by §14.1
   and covered by the F5 tests (TASK-108).
7. **PATCH null-out semantics (F9, audit note)**: PATCH `/api/admin/salons/[id]`
   cannot clear nullable fields (`address`/`phone`/`email`); unspecified in
   DESIGN — deliberately NOT tested; decision routed to TASK-402.
8. **F4 route specs are remediation, not red-first**: handlers shipped in
   TASK-105 before specs (audit finding). The specs pin current intended
   behavior; any failure at the post-TASK-109 verification run is a route
   defect to route to [DEBUG], not a spec defect.

## Pragmatics

- All specs TS strict, no `any`, relative imports (alias-agnostic).
- `DATABASE_URL` loaded via `dotenv/config` as each spec's first import —
  `src/db/client.ts` singleton therefore sees the env before first pool use.
- Vitest forks terminate pooled clients after the run; no teardown beyond
  `afterAll(pool.end)` is required. [CONF: MED] [SRC: INFERENCE]
- Verification protocol: full suite runs green post-TASK-109 (user-executed)
  is a Sprint 1 close condition (SPRINTS.md DoD #3/#4).
