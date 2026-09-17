/**
 * TASK-103 — Schema constraint specs (integration, real PostgreSQL).
 *
 * Design refs: docs/DESIGN.md §3.2 (salon_settings), §3.3 (services),
 * §3.4/§3.5 (employees/working_hours), §3.6 (time_off), §14.3 (staff_users
 * role consistency — supersedes §3.7's XOR CHECK), §3.9 (bookings).
 * REQs: REQ-002 (services constraint surface),
 * REQ-003 (working_hours/time_off constraint surface), REQ-012 (composite FKs
 * make cross-salon rows structurally impossible, §4 layer 1).
 *
 * EXPECTED STATE: SKIPPED until TASK-104 lands migrations. Activation is
 * automatic — the describe.skipIf probe re-runs on every `npm test`:
 *   1. docker compose up -d postgres
 *   2. cp .env.example .env  (set DATABASE_URL)
 *   3. npm run db:migrate    (TASK-104, incl. §3.10 exclusion SQL)
 *   4. npm test
 * Isolation: every test runs inside a rolled-back transaction (helpers/db.ts);
 * intentional violations go through Db.expectCode() savepoints.
 *
 * DELIBERATELY NOT TESTED HERE (documented in tests/README.md):
 *  - working-hours overlap rejection (§3.5): save-time advisory-lock logic,
 *    Sprint 4 repo behavior — not DDL.
 *
 * TASK-103b: the staff_users block below asserts DESIGN §14.3 (binding) —
 * role-enum + role-consistency CHECKs superseding §3.7's single XOR CHECK.
 */
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, getDbStatus, makePool, PG } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
let seed: Seeder;

/** Fixed UTC instants (timestamptz — DST-irrelevant, DESIGN §3). */
const T0 = Date.UTC(2031, 5, 15, 9, 0, 0);
const MIN = 60_000;
const at = (minutes: number): Date => new Date(T0 + minutes * MIN);

interface Fixture {
  salonA: string;
  salonB: string;
  serviceA: string;
  serviceB: string;
  employeeA: string;
  employeeB: string;
  customerId: string;
}

let f: Fixture;

async function seedFixture(): Promise<Fixture> {
  const salonA = await seed.salon({ name: "Salon A" });
  const salonB = await seed.salon({ name: "Salon B" });
  return {
    salonA,
    salonB,
    serviceA: await seed.service(salonA, { name: "Cut A" }),
    serviceB: await seed.service(salonB, { name: "Cut B" }),
    employeeA: await seed.employee(salonA),
    employeeB: await seed.employee(salonB),
    customerId: await seed.customer(),
  };
}

function insertBookingSql(): string {
  return `INSERT INTO bookings (salon_id, service_id, employee_id, customer_id,
                                starts_at, ends_at, blocked_start, blocked_end, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
}

function insertWorkingHoursSql(): string {
  return `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
          VALUES ($1, $2, $3, $4, $5)`;
}

function insertStaffUserSql(): string {
  return `INSERT INTO staff_users (email, password_hash, role, salon_id, employee_id, is_platform_admin)
          VALUES ($1, 'x', $2, $3, $4, $5)`;
}

afterAll(async () => {
  await pool?.end();
});

if (!status.ready) {
  console.warn(`[constraints.test.ts] SKIPPED — ${status.reason}`);
}

describe.skipIf(!status.ready)("schema constraints (DESIGN §3)", () => {
  beforeEach(async () => {
    await db.begin();
    seed = new Seeder(db);
    f = await seedFixture();
  });

  afterEach(async () => {
    await db.finish();
  });

  describe("composite FKs — cross-salon rows are structurally impossible (§3.5, §3.9, §4; REQ-012)", () => {
    it("REQ-012/§3.9: booking in salon A referencing salon B's service violates composite FK (salon_id, service_id)", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceB, f.employeeA, f.customerId,
        at(0), at(30), at(0), at(30), "confirmed",
      ]);
      expect(res.code).toBe(PG.FOREIGN_KEY_VIOLATION);
    });

    it("REQ-012/§3.9: booking in salon A referencing salon B's employee violates composite FK (salon_id, employee_id)", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeB, f.customerId,
        at(0), at(30), at(0), at(30), "confirmed",
      ]);
      expect(res.code).toBe(PG.FOREIGN_KEY_VIOLATION);
    });

    it("REQ-012/§3.5: working_hours row for salon A referencing salon B's employee violates composite FK", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeB, 1, 540, 1020]);
      expect(res.code).toBe(PG.FOREIGN_KEY_VIOLATION);
    });

    it("REQ-012/§3.9: positive control — an all-salon-A booking inserts cleanly", async () => {
      await db.exec(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(30), at(0), at(30), "confirmed",
      ]);
    });
  });

  describe("bookings CHECKs (§3.9; REQ-004/REQ-005 surface)", () => {
    it("REQ-004: starts_at = ends_at is rejected (CHECK starts_at < ends_at, boundary)", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(0), at(0), at(30), "confirmed",
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-004: starts_at after ends_at is rejected", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(30), at(0), at(0), at(30), "confirmed",
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-005: blocked_start later than starts_at is rejected (blocked range must contain actual range)", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(30), at(5), at(35), "confirmed",
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-005: blocked_end earlier than ends_at is rejected", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(30), at(-5), at(25), "confirmed",
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-005: zero-buffer snapshot (blocked range == actual range) is allowed (CHECK uses <=)", async () => {
      await db.exec(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(30), at(0), at(30), "confirmed",
      ]);
    });

    it("REQ-008: status outside ('confirmed','cancelled','completed','no_show') is rejected", async () => {
      const res = await db.expectCode(insertBookingSql(), [
        f.salonA, f.serviceA, f.employeeA, f.customerId,
        at(0), at(30), at(0), at(30), "bogus",
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });
  });

  describe("salon_settings CHECKs (§3.2; REQ-006 surface)", () => {
    it("REQ-006: gap_threshold_minutes = 0 is rejected (CHECK > 0, boundary)", async () => {
      const res = await db.expectCode(
        `INSERT INTO salon_settings (salon_id, gap_threshold_minutes) VALUES ($1, 0)`,
        [f.salonA],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-006: negative gap_threshold_minutes is rejected", async () => {
      const res = await db.expectCode(
        `INSERT INTO salon_settings (salon_id, gap_threshold_minutes) VALUES ($1, -45)`,
        [f.salonA],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-006: gap_threshold_minutes = 1 is accepted (strict > 0 lower boundary)", async () => {
      await db.exec(`INSERT INTO salon_settings (salon_id, gap_threshold_minutes) VALUES ($1, 1)`, [f.salonA]);
    });

    it("REQ-006: slot_granularity_minutes = 4 is rejected (CHECK BETWEEN 5 AND 60, lower boundary)", async () => {
      const res = await db.expectCode(
        `INSERT INTO salon_settings (salon_id, slot_granularity_minutes) VALUES ($1, 4)`,
        [f.salonA],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-006: slot_granularity_minutes = 5 is accepted (lower boundary)", async () => {
      await db.exec(`INSERT INTO salon_settings (salon_id, slot_granularity_minutes) VALUES ($1, 5)`, [f.salonA]);
    });

    it("REQ-006: slot_granularity_minutes = 60 is accepted (upper boundary)", async () => {
      await db.exec(`INSERT INTO salon_settings (salon_id, slot_granularity_minutes) VALUES ($1, 60)`, [f.salonA]);
    });

    it("REQ-006: slot_granularity_minutes = 61 is rejected (upper boundary)", async () => {
      const res = await db.expectCode(
        `INSERT INTO salon_settings (salon_id, slot_granularity_minutes) VALUES ($1, 61)`,
        [f.salonA],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });
  });

  describe("services CHECKs + uniqueness (§3.3; REQ-002 constraint surface)", () => {
    it("REQ-002: duration_minutes = 0 is rejected (CHECK > 0)", async () => {
      const res = await db.expectCode(
        `INSERT INTO services (salon_id, name, duration_minutes) VALUES ($1, $2, 0)`,
        [f.salonA, `svc-${Math.random()}`],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-002: negative buffer_before_minutes is rejected (CHECK >= 0)", async () => {
      const res = await db.expectCode(
        `INSERT INTO services (salon_id, name, buffer_before_minutes) VALUES ($1, $2, -1)`,
        [f.salonA, `svc-${Math.random()}`],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-002: negative buffer_after_minutes is rejected (CHECK >= 0)", async () => {
      const res = await db.expectCode(
        `INSERT INTO services (salon_id, name, buffer_after_minutes) VALUES ($1, $2, -1)`,
        [f.salonA, `svc-${Math.random()}`],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-002: negative price_cents is rejected (CHECK >= 0)", async () => {
      const res = await db.expectCode(
        `INSERT INTO services (salon_id, name, price_cents) VALUES ($1, $2, -1)`,
        [f.salonA, `svc-${Math.random()}`],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-002: price_cents = 0 is accepted (>= 0 boundary, free service)", async () => {
      await seed.service(f.salonA, { priceCents: 0 });
    });

    it("REQ-002: duplicate (salon_id, name) is rejected by UNIQUE", async () => {
      const res = await db.expectCode(
        `INSERT INTO services (salon_id, name) VALUES ($1, $2)`,
        [f.salonA, "Cut A"],
      );
      expect(res.code).toBe(PG.UNIQUE_VIOLATION);
    });

    it("REQ-002: same service name in a different salon is accepted (scope-local uniqueness)", async () => {
      await seed.service(f.salonB, { name: "Cut A" });
    });
  });

  describe("working_hours CHECKs (§3.5; REQ-003 constraint surface)", () => {
    it("REQ-003: start_minute = -1 is rejected (CHECK BETWEEN 0 AND 1439)", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, -1, 540]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: end_minute = 1440 is rejected (upper boundary is 1439)", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, 540, 1440]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: 00:00–23:59 (0–1439) window is accepted (both boundaries valid)", async () => {
      await db.exec(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, 0, 1439]);
    });

    it("REQ-003: start_minute = end_minute is rejected (CHECK start < end, boundary)", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, 540, 540]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: start_minute > end_minute is rejected", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, 1020, 540]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: iso_weekday = 0 is rejected (CHECK BETWEEN 1 AND 7)", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 0, 540, 1020]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: iso_weekday = 8 is rejected", async () => {
      const res = await db.expectCode(insertWorkingHoursSql(), [f.salonA, f.employeeA, 8, 540, 1020]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: iso_weekday 1 (Mon) and 7 (Sun) are both accepted (boundaries)", async () => {
      await db.exec(insertWorkingHoursSql(), [f.salonA, f.employeeA, 1, 540, 1020]);
      await db.exec(insertWorkingHoursSql(), [f.salonA, f.employeeA, 7, 540, 1020]);
    });
  });

  describe("time_off CHECKs (§3.6; REQ-003 constraint surface)", () => {
    it("REQ-003: time_off with starts_at = ends_at is rejected (CHECK starts_at < ends_at)", async () => {
      const res = await db.expectCode(
        `INSERT INTO time_off (salon_id, employee_id, starts_at, ends_at) VALUES ($1, $2, $3, $3)`,
        [f.salonA, f.employeeA, at(0)],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-003: time_off with starts_at after ends_at is rejected", async () => {
      const res = await db.expectCode(
        `INSERT INTO time_off (salon_id, employee_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)`,
        [f.salonA, f.employeeA, at(60), at(0)],
      );
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });
  });

  describe("staff_users role-consistency CHECKs (§14.3, supersedes §3.7 XOR; REQ-009)", () => {
    // §14.3 clause 1: role ∈ ('owner','employee','platform_admin') only.
    it("REQ-009: role 'superadmin' outside ('owner','employee','platform_admin') is rejected", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "superadmin", f.salonA, null, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role 'Owner' (case variant) is rejected — role CHECK is case-sensitive", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "Owner", f.salonA, null, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    // §14.3 clause 2: role='employee' ⇒ employee_id IS NOT NULL.
    it("REQ-009: role='employee' with employee_id NULL is rejected", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "employee", f.salonA, null, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role='employee' with salon_id + employee_id set and is_platform_admin=false is accepted", async () => {
      await seed.staffUser({ role: "employee", salonId: f.salonA, employeeId: f.employeeA });
    });

    // §14.3 clause 3: role='owner' ⇒ employee_id IS NULL.
    it("REQ-009: role='owner' with employee_id set is rejected", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "owner", f.salonA, f.employeeA, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role='owner' with employee_id NULL (salon-bound) is accepted", async () => {
      await seed.staffUser({ role: "owner", salonId: f.salonA });
    });

    // §14.3 clause 4: role='platform_admin' ⇒ is_platform_admin AND salon_id IS NULL AND employee_id IS NULL.
    it("REQ-009: role='platform_admin' with is_platform_admin=false is rejected (role ⟺ flag)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "platform_admin", null, null, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role='platform_admin' with salon_id set is rejected (admin must be salon-less)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "platform_admin", f.salonA, null, true,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role='platform_admin' with employee_id set is rejected (must be all-NULL scope)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "platform_admin", null, f.employeeA, true,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: role='platform_admin' with is_platform_admin=true + salon_id NULL + employee_id NULL is accepted", async () => {
      await seed.staffUser({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    });

    // §14.3 clause 5: is_platform_admin=true ⇒ role='platform_admin' (⟺, reverse direction).
    it("REQ-009: is_platform_admin=true with role='owner' is rejected (role ⟺ is_platform_admin)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "owner", f.salonA, null, true,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    it("REQ-009: is_platform_admin=true with role='employee' is rejected (role ⟺ is_platform_admin)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "employee", f.salonA, f.employeeA, true,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });

    // §14.3 clause 6: NOT is_platform_admin ⇒ salon_id IS NOT NULL.
    it("REQ-009/REQ-012: is_platform_admin=false with salon_id NULL is rejected (every non-admin staff user is salon-bound)", async () => {
      const res = await db.expectCode(insertStaffUserSql(), [
        `u-${Math.random()}@test.example`, "owner", null, null, false,
      ]);
      expect(res.code).toBe(PG.CHECK_VIOLATION);
    });
  });
});
