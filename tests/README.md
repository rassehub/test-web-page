# Test Suite — Sprint 1 + Sprint 2 Status (TASK-103 → TASK-108 → TASK-201 → TASK-201c)

Specs for the data layer, RBAC, salon-CRUD routes, slot engine, gap rule,
booking pipeline, and concurrency per
[docs/DESIGN.md](../docs/DESIGN.md) §3/§4/§5/§6/§7/§8/§14 and [docs/SPRINTS.md](../docs/SPRINTS.md).
Sprint 1 specs were authored RED-first (TASK-103), implemented in
TASK-104/105, remediated in TASK-108. Sprint 2 specs were authored RED-first
(TASK-201 + TASK-201b) and turned green by TASK-202/203. TASK-201c
(2026-09-17) is spec-after-ratification remediation (audit findings S2-F1/S2-F7,
F4 precedent): it pins the §14.6(h) per-endpoint DST skip and the fall-back
ambiguous-hour early-offset mapping, and refreshed this map.

## Current state (2026-09-17, post TASK-201c)

- User-verified baseline: **172/172 green** (V-UO 2026-09-17; TASK-203 run,
  TASK-204 audit input) — 112 Sprint 1 + **28 pure slot tests** +
  **32 integration**.
- TASK-201c adds **4 pure engine pins** (green-on-arrival: production code
  already implements the ratified behavior — remediation, not red-first):
  suite is now **176 tests** — **32 pure slot** (engine 22 + gap-rule 10) +
  32 integration + 112 Sprint 1. Expected green on the next `npm test`
  (folded into the TASK-205 pre-commit run; pending V-UO).

### Sprint 1 (user-verified all green, 112/112)

| File | State | Notes |
|---|---|---|
| `tests/smoke.test.ts` | GREEN | Runner sanity (V-UO 2026-09-17) |
| `tests/db/constraints.test.ts` | GREEN | skipIf-gated on DB probe; active since migrations applied |
| `tests/db/exclusion.test.ts` | GREEN | Dual-gated (tables + §3.10 `contype='x'` probe) |
| `tests/repos/scoping.test.ts` | GREEN | `createRepos` implemented (TASK-104) |
| `tests/auth/rbac.test.ts` | GREEN | + TASK-108 F5 additions: §14.1 owner-positive branch |
| `tests/auth/session.test.ts` | GREEN | TASK-105 session lib |
| `tests/admin/salons.test.ts` | GREEN | TASK-108 F4 route matrix |

### Sprint 2 (TASK-201 + TASK-201b + TASK-201c — all green)

| File | State | Tests | Notes |
|---|---|---|---|
| `tests/slots/engine.test.ts` | GREEN | 22 | 18 TASK-201 §6.1/§6.2 PURE specs + 4 TASK-201c §14.6(h)/(c) pins: spring-forward start-/end-endpoint nonexistent → window skipped; both-endpoints-exist spanning → offset-asymmetric UTC materialization; fall-back repeated-hour early-offset pin. PURE: always runs, no DB |
| `tests/slots/gap-rule.test.ts` | GREEN | 10 | PURE: `evaluateGapRule` per §6.3 binding definition. Always runs, no DB |
| `tests/bookings/create.test.ts` | GREEN | 12 | INTEGRATION (PLAIN): `createBookingPublic`/`createBookingAdmin` per §7, incl. structural no-bypass `describe` (runs without DB) |
| `tests/bookings/race.test.ts` | GREEN | 2 | INTEGRATION: 20-way parallel races (REQ-007) |
| `tests/bookings/cancel.test.ts` | GREEN | 8 | INTEGRATION: 3 TASK-201 core cases + 5 TASK-201b error-path cases (§14.6(e) matrix: strict error-shape equality, cross-salon indistinguishability, idempotent-fail, no-notification-on-error) |
| `tests/public/slots-api.test.ts` | GREEN | 10 | INTEGRATION route specs: GET `/api/public/salons/[slug]/slots` |

Sprint 2 inventory: **64 tests across 6 files** — **32 PURE** (engine 22 +
gap-rule 10; always run, no DB, no skipIf gating) + **32 integration**
(DB-gated describes self-skip until migrations are applied).

### Red → green register (all green as of 2026-09-17)

| File | RED since | GREEN since |
|---|---|---|
| `tests/slots/engine.test.ts` | TASK-201 | TASK-202 — TASK-201c additions are NOT red-first: characterization pins of ratified behavior (audit S2-F1, F4 precedent) |
| `tests/slots/gap-rule.test.ts` | TASK-201 | TASK-202 |
| `tests/bookings/create.test.ts` | TASK-201 | TASK-203 |
| `tests/bookings/race.test.ts` | TASK-201 | TASK-203 |
| `tests/bookings/cancel.test.ts` | TASK-201 (+5 TASK-201b) | TASK-203 |
| `tests/public/slots-api.test.ts` | TASK-201 | TASK-202/203 |

Integration specs for `lib/bookings` use **PLAIN mode** (the pipeline owns
its transactions; an outer test tx would be silently committed) with
unique-per-run seeds, `Seeder.cleanup()`, plus manual deletion of
pipeline-created global `customers` rows (tracked email/phone — §3.8 rows do
not cascade from salons).

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
- **PLAIN mode** (`scoping`, `auth`, `admin/salons`, and ALL Sprint 2
  integration specs): NO outer transaction — code under test may call
  `db.transaction()` internally, which would silently COMMIT/ROLLBACK an
  outer test transaction. Unique-per-run seeds + `Seeder.cleanup()` cascade
  (staff_users → salons → customers) instead. Sprint 2 booking specs also
  delete pipeline-created guest `customers` rows by tracked email/phone in
  `afterEach` (global table, no cascade).

## Coverage mapping (REQ → tests)

### Sprint 1

| REQ | AC / Design ref | Tests |
|---|---|---|
| REQ-002 | §3.3 services CHECK surface | `constraints.test.ts` › services: duration>0, buffers≥0, price≥0 (0 accepted), UNIQUE(salon_id,name) + same-name-other-salon accepted |
| REQ-003 | §3.5 working_hours + §3.6 time_off CHECK surface | `constraints.test.ts` › working_hours: minutes 0–1439 boundaries, start<end (incl. equal), weekday 1–7 boundaries; time_off: starts<ends |
| REQ-009 | §5.1 login, §5.3 contracts, §5.4 matrix | `rbac.test.ts`: wrong password→401, unknown email→401, correct→200+HttpOnly cookie; employee→owner 403; no/garbage/expired session→401; cross-salon owner & employee→403; platform_admin≠owner→403 + own role resolves; ownEmployeeIdOnly other stylist→403 / own→resolve. `session.test.ts`: SessionUser shape, expired→null+lazy row delete, unknown/no cookie→null, logout deletes row + clears cookie + 401 unguarded |
| REQ-009 (§14.1 owner branch — F5) | employee-gate: owner-of-salon resolves; explicit-salon trap; platform_admin never passes | `rbac.test.ts` › "§14.1 employee-gate owner branch" |
| REQ-009 (§14.3 DB surface) | staff_users role-enum + role-consistency CHECKs | `constraints.test.ts` › staff_users §14.3 |
| REQ-012 | §3 composite FKs, §4 factory + scoping | `constraints.test.ts` › composite FKs (23503s + positives); `scoping.test.ts`: factory throws without/empty salonId, cross-salon get()→null, list() never leaks, settings isolation |
| REQ-012 (route clause — F4) | "platform admin can CRUD salons" | `admin/salons.test.ts`: RBAC matrix, slug contract, duplicate slug 422, 404 no-leak, DELETE cascade + staff guard 409 |
| REQ-007 (DDL surface only) | §3.10 | `exclusion.test.ts`: overlap→23P01, adjacency OK, buffered-range overlap, cancelled/completed free the slot. 20-way race = Sprint 2 ↑ |
| REQ-004/005/008 (side surface) | §3.9 | `constraints.test.ts` › bookings CHECKs; `exclusion.test.ts` cancel-frees-slot at DB level |

### Sprint 2

| REQ | AC / Design ref | Tests |
|---|---|---|
| REQ-005 "DST transition days (March/Oct)" | §6.2.1 Luxon materialization + §14.6(c)/(h) endpoint semantics | `engine.test.ts` › DST: spring-forward 2027-03-28 (02:00–10:00 wall → 7 real hours, slots 00:00Z…06:00Z); window wholly inside skipped hour → 0 slots; §14.6(h) partial overlap (TASK-201c): start endpoint nonexistent 03:30–06:00 → 0, end endpoint nonexistent 01:30–03:30 → 0, both endpoints existing 02:00–06:00 → 6 slots with offset asymmetry (start +2 → 00:00Z, end +3 → 03:00Z); fall-back 2027-10-31 (9 real hours from 2027-10-30T23:00Z, `localDate` stays 10-31); repeated-hour window 03:15–03:45 → EARLY occurrence 00:15Z–00:45Z, 2 slots (TASK-201c interpretation pin); time_off subtraction across DST (§6.2.2). All asserted as UTC instants |
| REQ-005 "buffer application" | §6.2.4 buffered-fit rule | `engine.test.ts` › buffers: 15/15 shrink edges (first 09:30 / last 16:00, `endUtc` un-buffered); buffered candidate vs shrunken window after busy (10:30 rejected, 11:00 first) |
| REQ-005 "booked-interval exclusion" | §6.2.3 | `engine.test.ts` › busy: 12:00–13:00 split (26 slots, 11:30 & 13:00 bookable); per-window boundary stepping (12:55 opening → 12:55 first slot) |
| REQ-005 "multi-stylist calendars" | §6.1 union + employeeFilter | `engine.test.ts` › union (10 slots, shared starts duplicated per employee), filter isolation, filter to unknown employee → empty; inactive employees excluded; sorted output (startUtc then employeeId); empty working hours; 31-day cap (31 ok / 32 throws / reversed throws) |
| REQ-006 gap rule | §6.3 binding definition | `gap-rule.test.ts`: no neighbors→allowed; adjacency→allowed; gap==threshold→allowed (strict <); 44-min next-side fragment→rejected with exact interval; prev-side fragment→rejected; window-boundary gaps exterior; pre-existing fragments don't block; REQ-006 AC (3h gap, 44-min fragment, 45→rejected / 40→allowed); threshold flip (30/31) |
| REQ-006 admin bypass (A1) | §7 public/admin split | `create.test.ts`: `bypassGapRule:true` inserts despite fragment (`created_via='admin_manual'`); `:false` → GAP_FRAGMENT; compile-level `@ts-expect-error` — public command type has NO bypassGapRule |
| REQ-004 happy path | §7 pipeline | `create.test.ts`: confirmed row + exact duration + blocked_* snapshot + guest upsert by email and by phone + deterministic employee resolution + BOOKING_CONFIRMED sent after commit (spy observes committed status on a fresh connection) |
| REQ-004 stale/invalid rejection (409/422) | §7 error table | `create.test.ts`: STALE_SLOT (misaligned 11:37; aligned-but-not-offered 16:30 buffered overrun); OUTSIDE_WORKING_HOURS (08:00); SERVICE_INACTIVE; GAP_FRAGMENT `{fragmentMinutes:30}` |
| REQ-007 concurrency | §3.10 race shape, §7 advisory lock + 23P01→409 | `race.test.ts`: 20 parallel same employee/interval → exactly 1 win, 19× SLOT_OCCUPIED, 1 booking row, 1 customer row, 1 notification; 20 parallel employeeId-omitted over 2 employees → ≤1 per employee, losses all SLOT_OCCUPIED, rows == winners |
| REQ-008 side (cancel frees slot) + §14.6(e) error matrix | §3.9 partial index, §7 cancel | `cancel.test.ts`: status/cancelled_at set; same interval re-books (2 rows: 1 cancelled + 1 confirmed); BOOKING_CANCELLED after commit (spy sees committed 'cancelled'); TASK-201b: strict error-shape equality (unknown id / already cancelled / cross-salon), cross-salon indistinguishability, idempotent-fail, no notification on error |
| REQ-011 side (port seam) | §8 | create/cancel spies via `setNotificationPort` (see decisions); failure-isolation specs are TASK-501 scope |
| REQ-005/012 route surface | §2.3, §6.1 | `slots-api.test.ts`: 200 SlotComputationResult shape (granularity 20, 23 slots, keys, localDate, sorted, Z-suffixed); empty weekday → 200 []; unknown slug/service → 404; cross-salon service → 404; 32-day range → 422 (31 ok); reversed → 422; malformed dates → 422; missing serviceId → 422; no auth |

## Documented decisions & flagged gaps

### Sprint 1 (carried)

1. **Login strategy**: integration with a real argon2id hash — exercises the
   real verify path. [CONF: HIGH]
2. **`requireRole` ownEmployeeIdOnly gap — RESOLVED (§14.1)**: ratified as
   `opts.employeeId`; owner branch covered TASK-108 (F5).
3. **Repo method surface**: §4 names entities but not methods; assumed
   `get(id)`/`list()`/`settings.get()` camelCase domain fields. Implemented
   as assumed (TASK-104). [CONF: MED] [SRC: INFERENCE from §4]
4. **`role='employee'` without `employee_id` — RESOLVED (TASK-103b)**: §14.3
   role-consistency CHECKs; covered in `constraints.test.ts`.
5. **Module path mapping** per §9: `SessionUser`+`getSessionUser` ←
   `src/lib/auth/session.ts`; `requireRole` ← `src/lib/auth/rbac.ts`.
6. **Not tested by design (Sprint 1)**: working-hours overlap-at-save
   (Sprint 4), middleware presence-check (§5.2 UX-only).
7. **PATCH null-out semantics (F9)**: deliberately NOT tested; TASK-402.
8. **F4 route specs are remediation, not red-first** (audit finding).

### Sprint 2 (TASK-201/201b/201c) — notification-port seam + resolved DESIGN ambiguities

9. **NotificationPort seam (SPEC DECISION, needs CODE adherence)**: DESIGN §8
   fixes the port interface but not the injection mechanism. Spec'd seam:
   `setNotificationPort(port: NotificationPort): NotificationPort`
   (returns the PREVIOUS port) exported from
   `src/lib/notifications/port.ts`; default adapter =
   `ConsoleNotificationAdapter`. Chosen over a factory/deps parameter
   because DESIGN §7 signatures (`createBookingPublic(cmd)` etc.) are BINDING
   and parameter-free — a module-level setter is the least invasive seam.
   Tests install a spy in `beforeEach` and restore in `afterEach` via the
   returned previous port. Send-after-commit is proven by the spy querying
   on a FRESH pool connection (`statusAtSend`) — a pre-commit send would
   observe the row absent or pre-cancel status and fail.
10. **SLOT_OCCUPIED vs STALE_SLOT under the advisory lock (RESOLVED, binding
    for CODE)**: §7 serializes same-employee-day transactions, so race losers
    can detect the winner during validation instead of hitting 23P01. Spec
    resolution: whenever the ONLY obstacle is an existing confirmed booking
    — detected in validation OR via 23P01 — the error is
    `{ code: "SLOT_OCCUPIED" }`. STALE_SLOT is reserved for
    schedule-shaped staleness (misalignment / slot not computable from
    hours+service shape). The 20-way race demands 19× SLOT_OCCUPIED on this
    contract.
11. **OUTSIDE_WORKING_HOURS vs STALE_SLOT boundary (RESOLVED)**: start
    outside every working window → OUTSIDE_WORKING_HOURS; start inside a
    window and aligned, but not engine-offered because the buffered interval
    overruns the window → STALE_SLOT (spec'd by the 16:30 buffered-overrun
    case).
12. **Spring-forward endpoint skip (RATIFIED §14.6(h); spec coverage completed
    by TASK-201c)**: a working window is skipped ENTIRELY if ANY endpoint
    wall time is nonexistent — the stricter per-endpoint reading; never
    clamp, never phantom-map. Covered for all three shapes: wholly inside
    the skipped hour (03:00–04:00 wall on 2027-03-28 → 0 slots), start
    endpoint nonexistent (03:30–06:00 → 0), end endpoint nonexistent
    (01:30–03:30 → 0). Windows straddling the gap with both endpoints
    existing materialize on their UTC span (7 real hours for 02:00–10:00
    wall; 3 real hours for 02:00–06:00 with per-endpoint offset asymmetry:
    start at +2, end at +3).
13. **31-day cap enforcement point (RESOLVED)**: §6.1 notes "max span 31
    days (422 beyond)" on SlotQuery; the PURE `computeSlots` is spec'd to
    THROW on >31-day and reversed ranges (wrapper maps to 422). Exactly 31
    inclusive days passes (boundary pinned in engine + route specs).
14. **cancelBooking result shape (PINNED)**: §7 gives no return contract;
    minimal success shape `{ bookingId, status: "cancelled" }` is spec'd.
    Cancel ERROR paths (unknown id, already cancelled, cross-salon) were
    specced by TASK-201b per the §14.6(e) matrix — strict error-shape
    equality, cross-salon indistinguishability, idempotent-fail,
    no-notification-on-error.
15. **Guest upsert key (RESOLVED narrowly)**: §7 "upsert by (email|phone)"
    vs §3.8 "per new (email|phone,name) combination" — spec'd: email if
    present, else phone, is the identity; identical (email|phone, name)
    reuses the row. Same-identity-DIFFERENT-name behavior deliberately NOT
    pinned (would force a §3.8 interpretation). Only same-name reuse and
    phone-only reuse are asserted.
16. **`startsWith`/ISO format latitude**: slot instant assertions compare
    `Date.parse` epochs (format-agnostic beyond the pinned "Z-suffixed"
    check) so TASK-202 may emit `…Z` or `…SSSZ` freely.
17. **Fall-back ambiguous endpoints — INTERPRETATION-PINNED (TASK-201c,
    audit S2-F1)**: wall times inside the repeated hour (wall [03:00,04:00)
    on 2027-10-31) resolve via Luxon's default to the EARLIER offset (first
    occurrence, EEST +3). A 03:15–03:45 wall window therefore materializes
    once as 00:15Z–00:45Z — never duplicated across both passes, never
    late-offset (+2) mapped. Pinned as-implemented (`wallToUtc` keeps the
    Luxon default); this is a characterization pin, not a §14.6
    ratification. [CONF: HIGH] [SRC: DOC — Luxon resolves ambiguous wall
    times to the earlier offset; engine inspected 2026-09-17]
