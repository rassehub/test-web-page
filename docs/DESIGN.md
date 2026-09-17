# System Design — Hair Salon Reservation Platform

**Task:** TASK-101 (Sprint 1) · **Status:** Approved by Scrum Lead (see §13)
**Refs:** REQ-002, REQ-003, REQ-005, REQ-006, REQ-007, REQ-009, REQ-011, REQ-012
**Stack (approved, fixed):** Next.js App Router + TypeScript · PostgreSQL + Drizzle ORM. No other runtime services. No Redis, no queues, no brokers.

Sources: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), [docs/SPRINTS.md](docs/SPRINTS.md).

---

## 1. System Context

```
                    ┌─────────────────────────────────────────────┐
                    │              Next.js (single app)           │
                    │                                             │
  Guest ──────────► │  (public) /s/[slug]…                        │
  Staff ──────────► │  /admin/…        middleware + session       │
                    │  /api/…          Route Handlers             │
                    │                                             │
                    │  lib/            domain (pure) ─────────┐   │
                    │  repos/          data access (scoped)   │   │
                    │  notifications/  port + console stub    │   │
                    └───────────────────────┬─────────────────┼───┘
                                            │ Drizzle (node-postgres pool)
                                    ┌───────▼───────┐         │
                                    │  PostgreSQL   │◄────────┘
                                    │  (compose)    │  SMTP (Sprint 5,
                                    └───────────────┘  env-configured, out
                                                      of booking txn)
```

Layering rule: HTTP layer → domain services (`lib/`) → repositories (`repos/`) → Drizzle → PostgreSQL. Domain slot math and gap rule are **pure functions with zero I/O**; DB-facing wrappers assemble their inputs. [CONF: HIGH] [SRC: STANDARD]

---

## 2. Route Map

Legend: S1 = Sprint 1 … S7 = Sprint 7. Method ∗ = all relevant methods.

### 2.1 Public (customer)

| Route | Type | Purpose | Sprint | REQ |
|---|---|---|---|---|
| `/s/[slug]` | Page | Salon landing: services, prices, hours | S3 | REQ-001 |
| `/s/[slug]/book` | Page | Guest booking wizard (client steps) | S3 | REQ-004 |
| `/s/[slug]/book/confirmation` | Page | Post-booking confirmation | S3 | REQ-004 |
| `/login`, `/register`, `/account` | Page | Customer accounts — **reserved, no implementation** | S6 | REQ-010 |

### 2.2 Admin (staff)

| Route | Type | Purpose | Sprint | REQ |
|---|---|---|---|---|
| `/admin/login` | Page | Staff login (email + password) | S1 | REQ-009 |
| `/admin` | Page | Dashboard | S2 | — |
| `/admin/calendar` | Page | Day/week calendar, role-scoped | S4 | REQ-008 |
| `/admin/bookings/new` | Page | Manual booking (gap-rule bypass, A1) | S4 | REQ-006 |
| `/admin/services` | Page | Service catalog CRUD | S4 | REQ-002 |
| `/admin/employees` | Page | Employees, weekly hours, time off | S4 | REQ-003 |
| `/admin/settings` | Page | Salon settings incl. gap threshold | S4 | REQ-006 |
| `/admin/salons` | Page | Platform-admin salon CRUD | S1 | REQ-012 |

### 2.3 API (Route Handlers)

| Route | Method | Auth | Purpose | Sprint | REQ |
|---|---|---|---|---|---|
| `/api/health` | GET | none | DB `SELECT 1` healthcheck (compose) | S1 | — |
| `/api/auth/login` | POST | none | Staff login → session cookie | S1 | REQ-009 |
| `/api/auth/logout` | POST | session | Destroy session | S1 | REQ-009 |
| `/api/public/salons/[slug]/services` | GET | none | Active services only | S3 | REQ-002 |
| `/api/public/salons/[slug]/employees` | GET | none | Active employees only | S3 | REQ-003 |
| `/api/public/salons/[slug]/slots` | GET | none | Free slots (§6 contract) | S2 | REQ-005 |
| `/api/public/salons/[slug]/bookings` | POST | none | Guest booking creation (no bypass) | S2 | REQ-004, REQ-006 |
| `/api/admin/services` + `[id]` | ∗ | owner | Service CRUD | S1/S4 | REQ-002 |
| `/api/admin/employees` + `[id]` | ∗ | owner | Employee CRUD | S1/S4 | REQ-003 |
| `/api/admin/employees/[id]/working-hours` | PUT | owner | Replace weekly schedule (overlap-checked) | S1/S4 | REQ-003 |
| `/api/admin/employees/[id]/time-off` | ∗ | owner | Days-off CRUD | S1/S4 | REQ-003 |
| `/api/admin/bookings` | GET/POST | owner+employee | List range / manual create (bypass A1) | S2/S4 | REQ-006, REQ-008 |
| `/api/admin/bookings/[id]` | PATCH | owner+employee | Edit / cancel (own only for employee) | S4 | REQ-008 |
| `/api/admin/settings` | GET/PUT | owner | Salon settings (gap threshold, granularity) | S1/S4 | REQ-006 |
| `/api/admin/salons` + `[id]` | ∗ | platform_admin | Salon CRUD | S1 | REQ-012 |

Rules:
- **Salon scope never comes from the request for admin APIs.** It is derived from the session (`sessionUser.salonId`). Public APIs resolve scope from the unique `slug`. [CONF: HIGH] [SRC: INFERENCE from REQ-012]
- All mutations are Route Handlers (not server actions) — one testable pattern for TDD specs. [CONF: MED] [SRC: INFERENCE]
- 401 for missing/invalid session, 403 for wrong role or cross-salon access, 404 for resources outside scope (never leak existence).

---

## 3. Database Schema

PostgreSQL 16. IDs: `uuid` PK `default gen_random_uuid()`. Money: integer cents (never floats). [CONF: HIGH] [SRC: STANDARD]
Timestamps: `timestamptz` stored/compared in UTC; all wall-clock reasoning happens in the salon IANA timezone at compute time (§6).

### 3.1 `salons`

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| slug | text | NOT NULL, UNIQUE (public URL key, `[a-z0-9-]`) |
| name | text | NOT NULL |
| timezone | text | NOT NULL DEFAULT `'Europe/Helsinki'` (IANA; validated app-side) |
| address, phone, email | text | NULLABLE |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

### 3.2 `salon_settings` — 1:1 with salon (REQ-006 threshold)

| Column | Type | Constraints |
|---|---|---|
| salon_id | uuid | PK, FK → salons(id) ON DELETE CASCADE |
| gap_threshold_minutes | int | NOT NULL DEFAULT 45, CHECK (> 0) |
| slot_granularity_minutes | int | NOT NULL DEFAULT 15, CHECK (BETWEEN 5 AND 60) |
| updated_at | timestamptz | NOT NULL DEFAULT now() |

### 3.3 `services` (REQ-002)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| salon_id | uuid | NOT NULL, FK → salons(id) ON DELETE CASCADE |
| name | text | NOT NULL; UNIQUE (salon_id, name) |
| duration_minutes | int | NOT NULL, CHECK (> 0) |
| buffer_before_minutes | int | NOT NULL DEFAULT 0, CHECK (≥ 0) |
| buffer_after_minutes | int | NOT NULL DEFAULT 0, CHECK (≥ 0) |
| price_cents | int | NOT NULL, CHECK (≥ 0) |
| active | boolean | NOT NULL DEFAULT true |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

- `UNIQUE (salon_id, id)` — composite-FK target (§3.9). [CONF: HIGH] [SRC: STANDARD]
- Partial index `(salon_id) WHERE active` — powers "inactive services never appear in customer flow or slot computation".

### 3.4 `employees` (REQ-003)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| salon_id | uuid | NOT NULL, FK → salons(id) ON DELETE CASCADE |
| display_name | text | NOT NULL |
| title | text | NULLABLE (e.g. "Senior stylist") |
| active | boolean | NOT NULL DEFAULT true |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

- `UNIQUE (salon_id, id)` — composite-FK target.

### 3.5 `working_hours` (REQ-003)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| salon_id | uuid | NOT NULL |
| employee_id | uuid | NOT NULL |
| iso_weekday | smallint | NOT NULL, CHECK (BETWEEN 1 AND 7) (1=Mon … 7=Sun) |
| start_minute | int | NOT NULL, CHECK (BETWEEN 0 AND 1439) (local wall-clock, minutes from midnight) |
| end_minute | int | NOT NULL, CHECK (BETWEEN 0 AND 1439) |
| — | — | CHECK (start_minute < end_minute); FK (salon_id, employee_id) → employees(salon_id, id) ON DELETE CASCADE |

- Index: `(employee_id, iso_weekday)`.
- **Overlap rejection at save** (REQ-003: "overlapping schedule entries rejected at save"): enforced inside the save transaction — repository re-reads the employee's entries for that weekday under `pg_advisory_xact_lock(employee-day-key)` and rejects (422) any `start_minute < existing.end AND end_minute > existing.start`. Wall-clock weekly recurrence is **not** expressible as a DB range constraint; the lock makes the check race-free. [CONF: HIGH] [SRC: INFERENCE from REQ-003 wording — "at save", not "at DB level"]
- DST semantics: weekly wall-clock pattern; engine materializes per-concrete-date UTC intervals (§6.2), so spring-forward days yield 23 real hours and fall-back days 25 — no stored UTC offsets to go stale.

### 3.6 `time_off` (REQ-003 "days off")

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| salon_id | uuid | NOT NULL |
| employee_id | uuid | NOT NULL; FK (salon_id, employee_id) → employees(salon_id, id) ON DELETE CASCADE |
| starts_at / ends_at | timestamptz | NOT NULL, CHECK (starts_at < ends_at) (absolute UTC — exact instants, DST-free) |
| reason | text | NULLABLE |

- Index: `(employee_id, starts_at)`.

### 3.7 `staff_users` + `staff_sessions` (REQ-009)

`staff_users`:

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| email | text | NOT NULL, UNIQUE (lowercased app-side) |
| password_hash | text | NOT NULL (argon2id via `@node-rs/argon2` [CONF: MED] [SRC: STANDARD OWASP]) |
| role | text | NOT NULL, CHECK (`'owner'` | `'employee'`) |
| salon_id | uuid | NULL, FK → salons(id) — NULL **iff** platform admin |
| employee_id | uuid | NULL; FK (salon_id, employee_id) → employees(salon_id, id) — required when role = `'employee'` |
| is_platform_admin | boolean | NOT NULL DEFAULT false |
| — | — | CHECK ((is_platform_admin AND salon_id IS NULL AND employee_id IS NULL) OR (NOT is_platform_admin AND salon_id IS NOT NULL)) |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

One login account belongs to exactly one salon (or is platform admin). Multi-salon staff accounts: out of scope (§11). Globally-unique email keeps login unambiguous. [CONF: MED] [SRC: INFERENCE from REQ-009 — no multi-salon-staff requirement exists]

`staff_sessions` (DB-backed — no Redis allowed; **addition beyond TASK-104 table list, see §12**):

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | NOT NULL, FK → staff_users(id) ON DELETE CASCADE |
| token_hash | char(64) | NOT NULL, UNIQUE (SHA-256 hex of cookie token) |
| expires_at | timestamptz | NOT NULL (absolute expiry 7 days) |
| created_at | timestamptz | NOT NULL DEFAULT now() |

- Index `(expires_at)` — expired rows lazily deleted on read; no cron. [CONF: MED] [SRC: STANDARD]

### 3.8 `customers` (Sprint 6-ready from day one)

**Global table — deliberately NOT salon-scoped** (task context scopes services/employees/working hours/bookings/settings by `salon_id`; customers omitted from that list; salon affiliation lives on `bookings`). [CONF: MED] [SRC: DOC — task context] Flagged §12.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| name | text | NOT NULL |
| email | text | NULL; partial UNIQUE index WHERE email IS NOT NULL |
| phone | text | NULL |
| password_hash | text | NULL — **NULL = guest row, set = account row** (Sprint 6 sets it) |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

Every booking references a customer row; guest rows are created per new (email|phone,name) combination. Accounts (Sprint 6) upgrade rows in place — zero migrations.

### 3.9 `bookings` (REQ-004, REQ-005, REQ-006, REQ-007, REQ-012)

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| salon_id | uuid | NOT NULL, FK → salons(id) ON DELETE CASCADE |
| service_id | uuid | NOT NULL; **composite FK (salon_id, service_id) → services(salon_id, id)** |
| employee_id | uuid | NOT NULL; **composite FK (salon_id, employee_id) → employees(salon_id, id)** |
| customer_id | uuid | NOT NULL, FK → customers(id) |
| starts_at / ends_at | timestamptz | NOT NULL, CHECK (starts_at < ends_at) — service duration exactly |
| blocked_start / blocked_end | timestamptz | NOT NULL — snapshot of `[starts_at − buffer_before, ends_at + buffer_after]`; CHECK (blocked_start ≤ starts_at AND ends_at ≤ blocked_end) |
| status | text | NOT NULL DEFAULT `'confirmed'`, CHECK in (`confirmed`,`cancelled`,`completed`,`no_show`) |
| created_via | text | NOT NULL, CHECK in (`customer`,`admin_manual`) |
| notes | text | NULL |
| cancelled_at | timestamptz | NULL |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

- `UNIQUE (salon_id, id)` — composite-FK target for Sprint 4 audit trails if needed.
- `employee_id` is **always a concrete employee** — "any stylist" is resolved server-side before insert. NULL employee_id would defeat the exclusion constraint (gist treats NULLs as never equal → the exact double-booking hole). [CONF: HIGH] [SRC: STANDARD]
- Cancel = `status='cancelled'` + `cancelled_at`; the exclusion constraint's `WHERE (status='confirmed')` makes the slot re-bookable **immediately** (REQ-008). Rows are never deleted (audit trail).
- Buffer snapshot trade-off: later edits to a service's buffers affect new bookings only; no history rewrite. [CONF: MED] [SRC: INFERENCE — acceptable per REQ-005 wording]

Indexes:
- `(salon_id, starts_at)` — calendar queries.
- `(employee_id, starts_at) WHERE status='confirmed'` — slot engine input.
- `(customer_id)` — history (Sprint 6).

### 3.10 Anti-double-booking constraint (REQ-007) — the decision

**Chosen: PostgreSQL exclusion constraint.** Raw SQL in the Drizzle migration (Drizzle's DSL does not express EXCLUDE; `CREATE EXTENSION` and DDL go through `drizzle-kit` custom SQL migrations):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT bookings_no_double_booking
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(blocked_start, blocked_end, '[)') WITH &&
  )
  WHERE (status = 'confirmed');
```

**Justification vs serializable transactions:** [CONF: HIGH] [SRC: DOC — PostgreSQL docs "Constraints on Table / Exclusion" describe exactly this reservation use case]
1. Declarative and always-on — enforced for every client, session, and isolation level; serializable only protects transactions that opt in and are correctly written.
2. Deterministic failure: loser gets `23P01 exclusion_violation` → mapped to `409 SLOT_OCCUPIED`. Serializable needs app-level retry loops and produces false-positive serialization failures under load.
3. Covers buffers too (constraint on `blocked_*`, not raw times) — REQ-005 buffers are part of the DB-level guarantee.
4. Race test proof shape: 20 parallel inserts of the same interval → exactly 1 commit, 19× `23P01`, no orphan rows (single-statement atomic insert).

**Secondary serialization** (gap-rule race hardening): creation transactions take `pg_advisory_xact_lock(hashtextextended(employee_id::text || local_date_text, 0))` per employee-day before gap evaluation, serializing same-day writes cheaply. [CONF: HIGH for the mechanism; MED for exact signature] [SRC: DOC — PG advisory-lock functions]. The exclusion constraint remains the mandatory DB-level guarantee; the advisory lock closes the theoretical window where two non-overlapping bookings both pass gap validation yet jointly create a sub-threshold fragment.

---

## 4. Salon Scoping — Drizzle + Repository Pattern (REQ-012)

Three structural layers; none relies on developer discipline alone:

1. **DB: composite FKs.** Cross-salon references (booking→service of another salon, working_hours→employee of another salon) are **rejected by the FK constraint itself** — structurally impossible rows. [CONF: HIGH] [SRC: STANDARD]
2. **Repository factory: mandatory scope.**

```ts
// repos/index.ts
export interface Repos {
  services: ServicesRepo; employees: EmployeesRepo; workingHours: WorkingHoursRepo;
  timeOff: TimeOffRepo; bookings: BookingsRepo; settings: SettingsRepo;
}
export function createRepos(db: DrizzleDb, scope: { salonId: string }): Repos;
```

Contract:
- Factory refuses to construct without `salonId` — no method signature in any repo accepts "unscoped" access; a repo instance **is** a salon scope. [CONF: HIGH] [SRC: INFERENCE]
- Every emitted query includes `eq(table.salon_id, scope.salonId)`; lookups are `and(eq(table.id, id), eq(table.salon_id, scope.salonId))` → cross-salon id yields empty/404, never data.
- Repos return domain objects, never Drizzle rows; schema types stay inside `repos/`.

3. **Scope provenance.** Admin callers: `createRepos(db, { salonId: sessionUser.salonId })` — from the session, never the request. Public callers: `createRepos(db, { salonId: salonBySlug.id })`. Platform admin: explicit salon CRUD repo path only.

Optional hardening (Sprint 7 SECURITY decision, out of scope now): PostgreSQL RLS with `SET LOCAL app.salon_id` per transaction. [CONF: MED] [SRC: STANDARD] Not required by REQ-012 acceptance criteria (data-layer tests).

---

## 5. Auth Design (REQ-009)

### 5.1 Session flow

```
login:  POST /api/auth/login {email, password}
        → argon2id verify (staff_users)
        → INSERT staff_sessions (sha256(token)); cookie = raw token
        → Set-Cookie staff_session: HttpOnly, SameSite=Lax, Secure(prod), Path=/, 7d
logout: POST /api/auth/logout → DELETE session row → clear cookie
read:   getSessionUser(): cookie token → sha256 → join sessions×users
        (expired/revoked ⇒ null ⇒ 401)
```

### 5.2 Middleware split

- `middleware.ts` (cheap, no DB): `/admin/*` except `/admin/login` with no session cookie → redirect `/admin/login`. [CONF: HIGH] [SRC: DOC — Next.js middleware is not for DB access]
- Real authentication + authorization happens in the protected layout and every admin Route Handler via `requireRole` — middleware presence-check is UX only, never the security boundary.

### 5.3 Contracts (TDD-ready)

```ts
export interface SessionUser {
  userId: string;
  role: "owner" | "employee" | "platform_admin";
  salonId: string | null;    // null iff platform_admin
  employeeId: string | null; // set for role === "employee"
}
export async function getSessionUser(): Promise<SessionUser | null>;
export async function requireRole(
  role: "owner" | "employee" | "platform_admin",
  opts?: { salonId?: string; ownEmployeeIdOnly?: boolean }
): Promise<SessionUser>; // throws Response 401 (no session) / 403 (wrong role or cross-salon)
```

### 5.4 RBAC matrix

| Capability | owner | employee | platform_admin |
|---|:--:|:--:|:--:|
| Own salon settings (gap threshold) | RW | — | — |
| Services CRUD (own salon) | RW | R | — |
| Employees + working hours + time off (own salon) | RW | — | — |
| All salon bookings / calendar | RW | — | — |
| Own bookings / own calendar | RW | RW | — |
| Manual booking with gap bypass (A1) | ✓ | ✓ (own calendar) | — |
| Salon CRUD (all salons) | — | — | RW |
| Any other salon's resources | 403/404 | 403/404 | n/a |

REQ-009 test targets: wrong credentials → 401; employee → other stylist's calendar or salon settings → 403. Both are direct `requireRole` outcomes.

---

## 6. Slot Engine — Interface Contracts (REQ-005)

### 6.1 Types and signatures

```ts
// lib/slots/types.ts
export type IsoDate = string;            // "YYYY-MM-DD", salon-local calendar date
export interface UtcInterval { startUtc: string; endUtc: string } // ISO 8601, Z-suffixed

export interface SlotQuery {
  salonId: string;
  serviceId: string;
  employeeId?: string;   // omitted = union over active employees
  fromDate: IsoDate;     // inclusive
  toDate: IsoDate;       // inclusive; max span 31 days (422 beyond)
}

export interface AvailableSlot {
  startUtc: string;      // aligned to slot granularity inside a working window
  endUtc: string;        // startUtc + service.duration_minutes
  employeeId: string;    // always concrete
  localDate: IsoDate;    // for UI grouping
}
export interface SlotComputationResult {
  granularityMinutes: number;
  slots: AvailableSlot[]; // sorted by startUtc, then employeeId
}

// lib/slots/engine.ts — PURE, no I/O, unit-test target for REQ-005 cases
export function computeSlots(input: {
  service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number };
  granularityMinutes: number;
  timezone: string;      // IANA, from salons.timezone
  range: { fromDate: IsoDate; toDate: IsoDate };
  employees: Array<{ id: string; active: boolean }>;
  employeeFilter?: string;
  workingHoursByEmployee: Record<string, Array<{ isoWeekday: 1|2|3|4|5|6|7; startMinute: number; endMinute: number }>>;
  timeOffByEmployee: Record<string, UtcInterval[]>;
  busyByEmployee: Record<string, UtcInterval[]>; // confirmed bookings, blocked_* range
}): SlotComputationResult;

// lib/slots/service.ts — I/O wrapper: loads inputs via Repos, calls computeSlots
export async function getAvailableSlots(q: SlotQuery): Promise<SlotComputationResult>;
// throws NotFound (salon/service/employee) or ValidationError (range) — mapped 404/422
```

### 6.2 Computation semantics (binding)

1. For each local date in range and each active employee: materialize working windows = `working_hours[iso_weekday]` as **local wall-clock minute intervals → UTC instants via Luxon (`DateTime.fromObject(..., { zone })`) in the salon timezone**. Library: `luxon` (mature, IANA-correct, DST-safe). [CONF: HIGH] [SRC: DOC] Non-existent wall times on spring-forward days are skipped; fall-back produces the expanded window. This is the DST-correctness mechanism REQ-005 tests (March/Oct).
2. Subtract `time_off` (absolute UTC) → open windows.
3. Subtract `busy` intervals (blocked ranges of `confirmed` bookings). Cancelled bookings are absent by query.
4. Candidate slots: start times stepping by `granularityMinutes` from each window's open boundary; a candidate is valid iff its **buffered interval** `[start − buffer_before, start + duration + buffer_after]` fits entirely inside one open window. `endUtc` returned un-buffered; buffering is internal.
5. No caching — settings/hours/bookings read per request ⇒ same-day schedule changes reflect immediately (REQ-003).

### 6.3 Gap-fragmentation rule contract (REQ-006)

```ts
// lib/slots/gapRule.ts — PURE
export interface GapRuleInput {
  thresholdMinutes: number;       // from salon_settings.gap_threshold_minutes at call time
  workingWindow: UtcInterval;     // one contiguous employee working window (that day)
  busyIntervals: UtcInterval[];   // within window, sorted, pairwise disjoint (incl. buffers)
  candidate: UtcInterval;         // buffered candidate; within window; disjoint from busy
}
export type GapRuleDecision =
  | { allowed: true }
  | { allowed: false; fragment: UtcInterval; fragmentMinutes: number };

export function evaluateGapRule(input: GapRuleInput): GapRuleDecision;
```

Binding definition: let `prevEnd` = latest busy end before candidate start within the window, `nextStart` = earliest busy start after candidate end. **Reject (allowed=false) iff an interior neighbor exists and the gap to it is `> 0 and < thresholdMinutes`.** Gaps touching the working-window boundary are exterior and never counted; a fully-adjacent booking (zero gap) is always allowed. Existing pre-salon-threshold fragments elsewhere in the day do not block. This is the binding interpretation of REQ-006; it satisfies the acceptance test (3 h interior gap, mid-gap booking leaving < threshold → rejected; threshold change changes outcome). [CONF: MED] [SRC: DOC — REQ-006 test is the spec; interpretation flagged §12]

---

## 7. Booking Creation Pipeline (REQ-004 flow-through, REQ-006, REQ-007)

```ts
// lib/bookings/types.ts
export type BookingError =
  | { code: "VALIDATION"; field: string }              // → 422
  | { code: "SERVICE_INACTIVE" }                       // → 422
  | { code: "OUTSIDE_WORKING_HOURS" }                  // → 422
  | { code: "STALE_SLOT" }                             // → 409 (slot no longer offered)
  | { code: "GAP_FRAGMENT"; fragmentMinutes: number }  // → 422
  | { code: "SLOT_OCCUPIED" };                         // → 409 (23P01 exclusion)

export interface CreateBookingCmd {
  salonId: string;
  serviceId: string;
  employeeId?: string;      // omitted ⇒ server resolves first available employee (deterministic order) inside the txn
  startsAt: string;         // UTC ISO; must equal an engine-offered slot start unless bypass
  customer: { name: string; phone?: string; email?: string };
  notes?: string;
}

// lib/bookings/create.ts
export async function createBookingPublic(cmd: CreateBookingCmd):
  Promise<{ bookingId: string; status: "confirmed" } | BookingError>;
export async function createBookingAdmin(cmd: CreateBookingCmd & { bypassGapRule: boolean }):
  Promise<{ bookingId: string; status: "confirmed" } | BookingError>;
```

Transaction (single pattern, both entry points; only difference: `bypassGapRule`):
1. `pg_advisory_xact_lock(employee-day-key)` — employee resolved first if omitted.
2. Load service (must be `active`), settings, employee hours/time-off, `confirmed` busy intervals (scoped repos).
3. Validate: buffered interval inside a working window; `startsAt` matches a computable slot; gap rule via `evaluateGapRule` (skipped iff `bypassGapRule` **and** caller is `createBookingAdmin` — the public wrapper has no bypass parameter, so the customer flow structurally cannot bypass A1).
4. Upsert guest `customers` row by (email|phone); insert booking `created_via` accordingly.
5. INSERT — `23P01` ⇒ rollback ⇒ `SLOT_OCCUPIED` (REQ-007's exactly-one-winner).
6. COMMIT. **After commit:** `NotificationPort.send(BOOKING_CONFIRMED)` — fire after commit, failure never propagates (§8).

Cancellation: `cancelBooking({ salonId, bookingId }, actor)` → status/cancelled_at update (freed instantly via §3.9), then `BOOKING_CANCELLED` after commit.

---

## 8. Notification Interface — Sprint 5 stub (REQ-011)

```ts
// lib/notifications/port.ts
export type NotificationType = "BOOKING_CONFIRMED" | "BOOKING_CANCELLED";
export interface Notification {
  type: NotificationType;
  bookingId: string;
  salonId: string;
  recipientEmail: string | null;
  locale: "fi";
}
export interface NotificationPort {
  /** MUST resolve (never reject). Implementations catch + log internally. */
  send(n: Notification): Promise<void>;
}
export class ConsoleNotificationAdapter implements NotificationPort; // Sprint 1 default
```

- Booking logic depends on `NotificationPort` only; Sprint 5 adds `SmtpNotificationAdapter` (nodemailer [CONF: MED] [SRC: STANDARD]) with zero booking-code changes.
- Failure isolation is part of the contract: `send` never throws ⇒ failed send logged, booking unaffected (REQ-011 acceptance).

**Env vars (documented in `.env.example`, placeholders only — no secrets in files):** `DATABASE_URL` (S1); `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` (S5, listed now so the contract is fixed).

---

## 9. Directory Layout

```
src/
  app/
    (public)/s/[slug]/{page.tsx,book/page.tsx}
    admin/login/page.tsx
    admin/(protected)/{page.tsx,calendar,services,employees,settings,salons,bookings}
    api/{health,auth/{login,logout},
         public/salons/[slug]/{services,employees,slots,bookings},
         admin/{services,employees,bookings,settings,salons}}
  db/{schema.ts,migrations/,client.ts}     # drizzle-kit generated + custom SQL (§3.10)
  lib/{auth/{session.ts,rbac.ts,password.ts},
       slots/{types.ts,engine.ts,gapRule.ts,service.ts},
       bookings/{types.ts,create.ts,cancel.ts},
       notifications/{port.ts,console-adapter.ts}}
  repos/index.ts                           # createRepos + per-entity repos
  middleware.ts
```

Dependencies: `drizzle-orm`, `pg`, `drizzle-kit`, `luxon`, `zod` (input validation at HTTP boundary), `@node-rs/argon2`. [CONF: HIGH all exist] [SRC: DOC]

---

## 10. Out of Scope (explicit)

- Customer account UIs/flows (S6; schema-ready only)
- Email templates + SMTP adapter (S5; port + env names fixed now)
- Deployment, Caddy, TLS (S7)
- Rate limiting, RLS, security hardening pass (S7)
- Payments, SMS, reminders, waiting lists, recurring bookings, i18n, multi-currency
- Multi-salon staff accounts (single salon_id per staff_user)
- Employee self-schedule editing (owner-managed hours only)
- Rewriting `blocked_*` snapshots when a service's buffers change (history preserved)

---

## 11. REQ → Design Traceability Matrix

| REQ | Design elements |
|---|---|
| REQ-002 | §3.3 services (+active flag, partial index) · §2.3 public services = active-only · §4 repo scope · engine reads active services only (§6.2) |
| REQ-003 | §3.4 employees · §3.5 working_hours (+save-time overlap rejection) · §3.6 time_off · §6.2 rule 5 no-cache ⇒ same-day effect |
| REQ-005 | §6.1 contracts · §6.2 semantics (buffers as blocked intervals, Luxon UTC/TZ, DST skip/expand) · §3.9 blocked_* columns |
| REQ-006 | §3.2 gap_threshold_minutes (default 45) · §6.3 evaluateGapRule binding definition · §7 public/admin split makes customer bypass structurally impossible |
| REQ-007 | §3.10 exclusion constraint (+SQL, +justification) · §7 advisory lock + 23P01→409 |
| REQ-009 | §3.7 staff_users/staff_sessions · §5 session flow, middleware split, requireRole, RBAC matrix (401/403 targets) |
| REQ-011 | §8 NotificationPort contract (never-reject), send-after-commit, env var list, `.env.example` rule |
| REQ-012 | §3 composite FKs everywhere · §4 repo factory mandatory scope + scope provenance · §2.3 rules (scope from session/slug, 404 no-leak) |

Side coverage (not assigned): REQ-004 error paths (§7 `STALE_SLOT`/`SLOT_OCCUPIED` 409/422), REQ-008 cancel-frees-slot (§3.9), REQ-010 guest/account rows (§3.8), REQ-013 healthcheck route (§2.3).

---

## 12. Decisions Requiring Scrum Lead Sign-off

1. **`staff_sessions` table** — addition beyond TASK-104's list; required: session-based auth (REQ-009) + no-Redis constraint leaves DB storage as the only fail-safe option.
2. **`customers` global (not salon-scoped)** — reading of the task context's scoped-resource enumeration; say the word and it becomes salon-scoped with a Sprint-6 identity table instead.
3. **Gap rule = adjacent-interior-fragment definition** (§6.3) — binding interpretation of REQ-006; matches the acceptance test.
4. **Employee role gets A1 bypass on own calendar** (§5.4) — A1 says "admin"; Sprint 4 tasks treat staff manual booking uniformly. Confirm or restrict bypass to owners.
5. **Deps**: `luxon`, `@node-rs/argon2` (native module in the container), `zod`.

---

## 13. Scrum Lead Sign-off (2026-09-17)

All five §12 decisions **APPROVED**:

1. `staff_sessions` — approved. Only fail-safe option under the no-Redis constraint.
2. `customers` global — approved. Standard identity/tenancy separation; salon affinity on `bookings` is correct.
3. Gap-rule binding definition (§6.3) — approved as the spec for REQ-006. TDD specs must encode it exactly.
4. Employee A1 bypass on own calendar — approved. Operator judgment extends to the employee's own chair; owners bypass salon-wide. RBAC tests must prove the own-calendar restriction.
5. Dependencies — approved.

TASK-101 closed. Downstream contracts (§5.3, §6.1, §6.3, §7, §8) are binding for TDD and implementation.

---

## 14. Contract Amendments (Scrum Lead, 2026-09-17 — resolving TASK-103 flags 1–4)

1. **§5.3 `requireRole` opts extended:** add `employeeId?: string` — the target stylist resource being accessed. Semantics when present: resolve iff (`role='owner'` AND session salon matches the resource's salon) OR (`role='employee'` AND `sessionUser.employeeId === opts.employeeId`); `platform_admin` never passes employee-gated checks; all other cases 403. Binding — supersedes the §5.3 signature.
2. **§4 repository surface (binding):** repos expose `get(id)`, `list(filter)` plus entity-specific mutations; `settings.get()/update()` return camelCase domain fields (`gapThresholdMinutes`, `slotGranularityMinutes`). As assumed by tests/repos/scoping.test.ts.
3. **§3.7 `staff_users` constraints (binding, supersedes the original single XOR CHECK):** `role` CHECK extended to `('owner','employee','platform_admin')`; consistency CHECKs: `role='platform_admin' ⟺ is_platform_admin`; `role='employee' ⇒ employee_id IS NOT NULL`; `role='owner' ⇒ employee_id IS NULL`; `role='platform_admin' ⇒ salon_id IS NULL AND employee_id IS NULL`; `NOT is_platform_admin ⇒ salon_id IS NOT NULL`.
4. **Login tests use real argon2id with seeded hash (integration, no stub):** approved as specified in tests/auth/.
5. **TASK-104 implementation amendments (ratified 2026-09-17):** migrations are plain SQL files applied by `scripts/migrate.mjs` + `schema_migrations` ledger (drizzle-kit journal unused; `drizzle.config.ts` retained for future generates); `services.duration_minutes` DEFAULT 30 and `services.price_cents` DEFAULT 0; `bookings.created_via` DEFAULT `'customer'`; exclusion constraint lives only in SQL DDL (Drizzle DSL cannot express EXCLUDE per §3.10).
6. **TASK-201 resolutions (ratified 2026-09-17, supersedes where conflicting):**
   - (a) Occupancy detected during validation (busy-overlap) and 23P01 exclusion both yield `SLOT_OCCUPIED` (409) — unified race contract.
   - (b) Candidate outside every working window → `OUTSIDE_WORKING_HOURS`; aligned in-window but buffered interval overruns → `STALE_SLOT`.
   - (c) Spring-forward: wall-clock windows falling entirely in the skipped hour produce ZERO slots (skip, never phantom-map). Fall-back windows expand.
   - (d) 31-day range cap enforced in pure `computeSlots` (throws); wrapper maps 422; exactly-31 allowed.
   - (e) `cancelBooking` error members added to BookingError: `{ code: "NOT_FOUND" }` → 404 (booking not in salon scope) and `{ code: "ALREADY_CANCELLED" }` → 409 (status ≠ 'confirmed'). Success shape `{ bookingId, status: "cancelled" }`.
   - (f) Guest identity key: email if present, else phone; name is NOT part of the key — rebooking under same identity updates the name (last known wins).
   - (g) Notification seam: `setNotificationPort(port): NotificationPort` module-level setter in `src/lib/notifications/port.ts`, default `ConsoleNotificationAdapter`.
   - (h) TASK-202 ratifications (2026-09-17): DST windows are skipped entirely if ANY endpoint wall time is nonexistent (stricter per-endpoint reading; never clamp/phantom-map) — spec coverage for partial overlap is a known gap, flagged to TASK-204 audit; gap-rule dual-fragment tie-break reports the prev-side fragment first (deterministic).
   - (i) §9 layout correction: notifications live in a single `port.ts` (default adapter co-located) — supersedes the two-file listing.
   - (j) TASK-203 ratifications (2026-09-17): create-path unknown salon/service/employee → `NOT_FOUND` (404); `startsAt` covered by time_off → `OUTSIDE_WORKING_HOURS`, buffered overrun into time_off → `STALE_SLOT`; omitted employeeId with zero active employees → `NOT_FOUND`; omitted-employee resolution tries candidates in deterministic `(created_at, id)` order and `SLOT_OCCUPIED` outranks schedule-shape errors when all fail; route-level `.uuid()` validation on id params (garbage → 422, never 500).
