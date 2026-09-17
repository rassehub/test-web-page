/**
 * TASK-103 — Anti-double-booking exclusion constraint specs (integration).
 *
 * Design ref: docs/DESIGN.md §3.10 — `bookings_no_double_booking`
 *   EXCLUDE USING gist (employee_id WITH =, tstzrange(blocked_start,
 *   blocked_end, '[)') WITH &&) WHERE (status = 'confirmed')
 * REQ-007 DDL surface (Sprint 1 = the constraint itself; the 20-way parallel
 * race test is TASK-201 scope per DESIGN §3.10 justification §4).
 * Side coverage: REQ-008 ("cancel frees the slot immediately" — proven here
 * at DB level via the partial index; UI-level cancel is Sprint 4).
 *
 * EXPECTED STATE: SKIPPED until TASK-104 applies migrations INCLUDING the
 * §3.10 custom SQL (probe checks pg_constraint for the exclusion constraint
 * specifically). Activation is automatic on every run:
 *   1. docker compose up -d postgres
 *   2. cp .env.example .env  (set DATABASE_URL)
 *   3. npm run db:migrate    (must include CREATE EXTENSION btree_gist + §3.10 DDL)
 *   4. npm test
 * Isolation: rollback transaction per test; 23P01 assertions via
 * Db.expectCode() savepoints.
 */
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, getDbStatus, makePool, PG } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

/** Fixed UTC day — timestamptz, DST-irrelevant. */
const DAY = Date.UTC(2031, 5, 15, 0, 0, 0);
const at = (hour: number, minute = 0): Date => new Date(DAY + (hour * 60 + minute) * 60_000);

interface Fixture {
  salonId: string;
  serviceId: string;
  employee1: string;
  employee2: string;
  customerId: string;
}

let f: Fixture;

function bookingSql(): string {
  return `INSERT INTO bookings (salon_id, service_id, employee_id, customer_id,
                                starts_at, ends_at, blocked_start, blocked_end, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed')`;
}

afterAll(async () => {
  await pool?.end();
});

if (!status.ready || !status.exclusionReady) {
  console.warn(`[exclusion.test.ts] SKIPPED — ${status.reason}`);
}

describe.skipIf(!status.ready || !status.exclusionReady)(
  "exclusion constraint bookings_no_double_booking (DESIGN §3.10; REQ-007 DDL surface)",
  () => {
    beforeEach(async () => {
      await db.begin();
      const salonId = await seed.salon();
      f = {
        salonId,
        serviceId: await seed.service(salonId, { durationMinutes: 30 }),
        employee1: await seed.employee(salonId),
        employee2: await seed.employee(salonId),
        customerId: await seed.customer(),
      };
    });

    afterEach(async () => {
      await db.finish();
    });

    it("REQ-007: overlapping confirmed booking for the SAME employee is rejected with 23P01", async () => {
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30),
      });
      const res = await db.expectCode(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(10, 15), at(10, 45), at(10, 15), at(10, 45),
      ]);
      expect(res.code).toBe(PG.EXCLUSION_VIOLATION);
    });

    it("REQ-007: non-overlapping booking for the same employee is accepted", async () => {
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30),
      });
      await db.exec(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(11), at(11, 30), at(11), at(11, 30),
      ]);
    });

    it("REQ-007: adjacent ranges (blocked_end == next blocked_start) do not conflict ('[)' half-open semantics)", async () => {
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30),
      });
      await db.exec(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(10, 30), at(11), at(10, 30), at(11),
      ]);
    });

    it("REQ-007: identical time range for a DIFFERENT employee is accepted (employee_id WITH =)", async () => {
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30),
      });
      await db.exec(bookingSql(), [
        f.salonId, f.serviceId, f.employee2, f.customerId,
        at(10), at(10, 30), at(10), at(10, 30),
      ]);
    });

    it("REQ-005/REQ-007: overlap detected on BUFFERED range — disjoint actual times still conflict when blocked ranges overlap", async () => {
      // Actual 10:00–10:30 blocked 09:45–10:45 (15/15 buffers).
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30), blockedStart: at(9, 45), blockedEnd: at(10, 45),
      });
      // Actual 10:40–11:10 (no buffers) — actuals disjoint, blocked [10:40,11:10)
      // overlaps [09:45,10:45) by 5 minutes -> must be rejected.
      const res = await db.expectCode(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(10, 40), at(11, 10), at(10, 40), at(11, 10),
      ]);
      expect(res.code).toBe(PG.EXCLUSION_VIOLATION);
    });

    it("REQ-008: cancelled booking no longer blocks — overlapping confirmed insert succeeds after status='cancelled' (partial index WHERE)", async () => {
      const firstId = await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30),
      });
      await db.exec(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [firstId],
      );
      await db.exec(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(10), at(10, 30), at(10), at(10, 30),
      ]);
    });

    it("REQ-007: non-'confirmed' statuses are outside the index — 'completed' booking does not block either", async () => {
      await seed.booking({
        salonId: f.salonId, serviceId: f.serviceId, employeeId: f.employee1, customerId: f.customerId,
        startsAt: at(10), endsAt: at(10, 30), status: "completed",
      });
      await db.exec(bookingSql(), [
        f.salonId, f.serviceId, f.employee1, f.customerId,
        at(10), at(10, 30), at(10), at(10, 30),
      ]);
    });
  },
);
