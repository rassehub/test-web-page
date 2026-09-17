# Sprint 3 Audit — TASK-303

**Date:** 2026-09-17 · **Mode:** Auditor (static review, no shell — scoped tight; most DoD accepted on user-verified runtime evidence) · **Sprint:** 3 (Customer Site & Booking Wizard)
**Inputs:** [docs/SPRINTS.md](SPRINTS.md) §Sprint 3 · [docs/REQUIREMENTS.md](REQUIREMENTS.md) · user runtime evidence 2026-09-17 (**192/192 green**, wizard e2e booking on Demo Salon with confirmation, Lighthouse mobile ≥ 90) · full source of the touched test/helper/UI/route files.

**Arithmetic cross-check:** 176 (S2 close) + 13 (TASK-300) = 189 ✓ + 3 (TASK-302b) = **192** ✓ matches user output.

## 1. Assigned scope-item verdicts

### 1.1 TASK-301 entity-escape test edit — **NOT WEAKENED**

[landing.test.ts:104](../tests/public/landing.test.ts:104) asserts `toContain("Cut &" + "amp; Style")` — evaluates to the literal `"Cut & Style"`, the entity-escaped serialization react-dom/server produces for the text child `{service.name}` ([view.tsx:112](../src/app/(public)/s/[slug]/view.tsx:112)).

- **Loophole closed:** the only other producer of that substring would be `dangerouslySetInnerHTML` — absent from the entire 143-line [view.tsx](../src/app/(public)/s/[slug]/view.tsx) (full-file read). The substring therefore appears iff the full service name renders as a text node.
- Strength unchanged for the name itself (full contiguous substring, same as the pre-edit intent); strictly **stronger** overall — it now also pins correct SSR text escaping (no raw-`&`/HTML pass-through). Cross-pins intact: raw salon name ([:96](../tests/public/landing.test.ts:96)), `Beard Trim` ([:106](../tests/public/landing.test.ts:106)), fi-FI prices ([:105](../tests/public/landing.test.ts:105)).
- The string concatenation is cosmetic (keeps the source free of a literal `&`); no semantic effect. Ratified post-hoc → **ratification upheld**.

### 1.2 TASK-302b seed.ts cleanup-order — **CORRECT, PRECEDENT-MATCHED, NO LEAK PATH**

[`cleanup()`](../tests/helpers/seed.ts:201) deletes **staff_users → salons → customers**. DDL proves this is the unique FK-valid order:

| Stage | Why it must run here | DDL evidence |
|---|---|---|
| staff_users first | `staff_users_employee_fk` is NO ACTION — a lingering staff row would **block** the salon cascade deleting its employee | [0000_init.sql:130](../src/db/migrations/0000_init.sql:130) |
| salons second | `bookings.salon_id` ON DELETE CASCADE removes bookings, releasing `bookings.customer_id` (NO ACTION) references | [0000_init.sql:161](../src/db/migrations/0000_init.sql:161), [:164](../src/db/migrations/0000_init.sql:164) |
| customers last | guest rows (§3.8, global, no salon cascade) deletable only after referencing bookings are gone | [:164](../src/db/migrations/0000_init.sql:164) |

Reversed order (customers before salons) would throw FK violations and strand rows. Precedent parity — identical order in all four consumers: [create.test.ts:136](../tests/bookings/create.test.ts:136), [race.test.ts:87](../tests/bookings/race.test.ts:87), [cancel.test.ts:96](../tests/bookings/cancel.test.ts:96), [booking-flow.test.ts:108](../tests/public/booking-flow.test.ts:108).

Leak analysis: every tracked-ID array is cleared per stage (idempotent re-entry); every pipeline-created guest row is tracked **before** its POST (phones/emails at each `usedPhones`/`usedEmails` push; RED-phase unkeyed rows by UUID-suffixed name, [booking-flow.test.ts:69–72](../tests/public/booking-flow.test.ts:69)); Seeder-seeded customers land in stage 3. All seeds are unique-per-run UUIDs, so even a failure-path residue cannot logically collide across tests. **No cross-test data leak.**

### 1.3 Wizard security spot-check — **PASS (both behaviors)**

- **salonId provenance:** the wizard never emits `salonId` in any request — the only POST body is [`{serviceId, employeeId, startsAt, customer}`](../src/app/(public)/s/[slug]/book/wizard.tsx:263). The route resolves scope exclusively from the path: `slug` → [`findSalonBySlug`](../src/app/api/public/salons/[slug]/bookings/route.ts:49) → `salonId: salon.id` injected server-side ([:57](../src/app/api/public/salons/[slug]/bookings/route.ts:57)). [`bodySchema`](../src/app/api/public/salons/[slug]/bookings/route.ts:17) has no salonId key and zod's default strip behavior discards smuggled unknown keys before the pipeline — inert by construction.
- **Body shape:** wizard body ⊂ [`CreateBookingCmd`](../src/lib/bookings/types.ts:30) minus the server-added `salonId`: `serviceId`, `employeeId` (from the concrete slot — first-available collapse keeps the engine's real id, [wizard.tsx:192–206](../src/app/(public)/s/[slug]/book/wizard.tsx:192)), `startsAt` (slot's `startUtc`), `customer {name, phone?, email?}` with empty channels omitted ([:253–255](../src/app/(public)/s/[slug]/book/wizard.tsx:253)). No `notes` sent (optional, allowed), no `status`/`createdVia`/`bypassGapRule` — the last structurally impossible on the public path ([types.ts:25–29](../src/lib/bookings/types.ts:25); S2-audit-verified hardcoded `false`).

## 2. Sprint 3 DoD verification

| # | DoD item | Evidence | Verdict |
|---|---|---|---|
| 1 | Lighthouse mobile ≥ 90 on landing | **V-UO** user 2026-09-17 | **PASS** |
| 2 | E2E happy path: guest books via wizard | **V-UO** user (Demo Salon, confirmation shown; enabled by TASK-302d seed:demo) | **PASS** |
| 3 | Invalid slot submission rejected server-side | **V-UO** 192/192, incl. route-level pins: STALE_SLOT 409 ([booking-flow.test.ts:212](../tests/public/booking-flow.test.ts:212)), GAP_FRAGMENT 422 ([:230](../tests/public/booking-flow.test.ts:230)), contact VALIDATION 422 ([:297](../tests/public/booking-flow.test.ts:297), TASK-302b/c) | **PASS** |
| 4 | Committed | **OPEN** → TASK-304 (sequencing, not a defect) | **OPEN** |

## 3. REQ status recommendations (Scrum Lead applies)

| REQ | Test/fact-proven legs | Uncovered leg | Recommendation |
|---|---|---|---|
| REQ-004 | Persists `confirmed`: pipeline ([create.test.ts:179](../tests/bookings/create.test.ts:179)) + HTTP route level with DB-row asserts ([:154](../tests/public/booking-flow.test.ts:154)); server-authoritative rejections even with client bypassed: 409 STALE_SLOT, 422 GAP_FRAGMENT, 422 VALIDATION (malformed + no-contact), 404 NOT_FOUND — all route-level; "stylist (or any)": `employeeId` omitted → server-resolves deterministic ([create.test.ts:262](../tests/bookings/create.test.ts:262)); phone∨email enforced in zod; e2e confirmation V-UO | None — every AC leg has direct evidence | **done** |
| REQ-001 | Renders service list/prices/hours: 3 render specs green in the 192/192 run ([landing.test.ts:94](../tests/public/landing.test.ts:94)–[:119](../tests/public/landing.test.ts:119)) + unknown-slug 404; Lighthouse mobile ≥ 90 V-UO | "usable at 360–1440 px" — **no direct evidence**. Lighthouse emulated mobile ≈ 412×823 [CONF: MED] [SRC: DOC], not 360/1440; mobile-first CSS is V-CODE, not usability proof | **in-progress** — flip after a ~1-min user viewport check at 360 px and 1440 px (or explicit Scrum-Lead ratification that Lighthouse-mobile + mobile-first satisfies the leg) |

## 4. Findings & remediation

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| S3-F1 | note | REQ-001 responsive AC leg evidenced by inference only (§3) | User viewport check 360/1440 → flip REQ-001; route: **user** |
| S3-F2 | note | Public unauthenticated POST `/bookings` has no rate limiting / abuse control (spam bookings, customers-row pollution). Accepted for S3; hardening pass scheduled | **TASK-701** (OWASP, S7) |
| S3-F3 | note | `slug` string-interpolated into wizard fetch URLs without `encodeURIComponent` ([wizard.tsx:140](../src/app/(public)/s/[slug]/book/wizard.tsx:140), [:177](../src/app/(public)/s/[slug]/book/wizard.tsx:177), [:260](../src/app/(public)/s/[slug]/book/wizard.tsx:260)). Server-supplied, React-escaped in markup; benign today | Optional encode-at-boundary in **TASK-701** |
| S3-F4 | note | Boundary zod `object()` **strips** (not rejects) unknown body keys — smuggling is inert (never reaches the pipeline), but the strip-vs-strict choice is undocumented | Document only; no code change demanded |
| S3-F5 | note | [scripts/seed-demo.mjs](../scripts/seed-demo.mjs) carries no REQ-ID — dev tooling to unblock walkthrough (index empty until S4 admin UI), ledger-documented (TASK-302d) | Accepted as documented tooling; flagged for the record, no routing |

**No IMPLEMENTATION MISSING findings** — every export referenced by specs exists ([`SalonLandingView`](../src/app/(public)/s/[slug]/view.tsx:74), [`BookingWizard`](../src/app/(public)/s/[slug]/book/wizard.tsx:98), route `GET`/`POST`, [`Seeder.cleanup`](../tests/helpers/seed.ts:202)). Scope-creep check: Sprint 3 code traces to REQ-001/REQ-004 (+ REQ-006 route-level pin); S3-F5 is the only REQ-ID-less addition and is tooling.

## 5. Verdict

Both post-hoc-ratified edits verified sound: the entity-escape assertion is equivalent-or-stronger (§1.1), and the cleanup order is the unique FK-valid sequence matching the Sprint-2 precedent with no leak path (§1.2). Wizard scope provenance and body shape are clean (§1.3). DoD 1–3 **PASS on V-UO evidence**; DoD 4 open → TASK-304. **Sprint 3 is closeable** after: user cross-check (done for runtime evidence; pending the optional 360/1440 viewport check), Scrum Lead applies §3 (REQ-004 → done; REQ-001 → in-progress pending S3-F1), TASK-304 commits. **No blockers** — all findings note-severity.
