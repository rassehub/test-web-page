/**
 * TASK-103 — Repository salon-scoping specs.
 *
 * Design ref: docs/DESIGN.md §4 (createRepos factory, mandatory scope,
 * scope isolation) + §2.3 rules ("cross-salon id yields empty/404, never
 * data"). REQ-012 acceptance: "data-layer tests prove every query is
 * salon-scoped; salon A data is never returned in salon B contexts".
 *
 * CONTRACT UNDER TEST (§4):
 *   import { createRepos } from "../../src/repos"
 *   createRepos(db, { salonId }) → Repos { services, employees,
 *   workingHours, timeOff, bookings, settings }
 *
 * Assumed minimal repo method surface (SPEC'D ASSUMPTION — if TASK-104/105
 * ship different method names, AUDIT updates these specs; documented in
 * tests/README.md): `<entity>.get(id) → domain object | null`,
 * `<entity>.list() → domain object[]`, `settings.get() → settings object`.
 * Domain objects expose `id: string`; settings exposes
 * `gapThresholdMinutes` / `slotGranularityMinutes` (camelCase domain
 * mapping per §4 "repos return domain objects, never Drizzle rows").
 * [CONF: MED] [SRC: INFERENCE from §4]
 *
 * EXPECTED STATE: RED at import right now — src/repos/index.ts is a
 * placeholder exporting nothing, so `createRepos` fails to resolve. This is
 * the intended initial red; it turns green only when TASK-104/105 implement
 * the factory AND migrations exist (skipIf guard below also probes the DB,
 * so the file stays skipped pre-TASK-104 if imports are fixed first).
 *
 * Isolation: PLAIN mode (NO outer transaction — repos are allowed to use
 * db.transaction() internally, which would break outer-tx rollback).
 * Unique-per-run seed data + cascade cleanup (Seeder) instead.
 *
 * Activation:
 *   1. docker compose up -d postgres && cp .env.example .env
 *   2. npm run db:migrate            (TASK-104)
 *   3. implement createRepos         (TASK-104/105)
 *   4. npm test
 */
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepos } from "../../src/repos";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder, inHours } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

interface Fixture {
  salonA: string;
  salonB: string;
  serviceA: string;
  serviceB: string;
  employeeA: string;
  employeeB: string;
  bookingA: string;
  bookingB: string;
}

let f: Fixture;

afterAll(async () => {
  await pool?.end();
});

afterEach(async () => {
  await seed.cleanup();
});

describe.skipIf(!status.ready)("createRepos salon scoping (DESIGN §4; REQ-012)", () => {
  beforeEach(async () => {
    const salonA = await seed.salon({ name: "Salon A" });
    const salonB = await seed.salon({ name: "Salon B" });
    await seed.salonSettings(salonA, { gapThresholdMinutes: 45 });
    await seed.salonSettings(salonB, { gapThresholdMinutes: 75 }); // distinct value: proves no cross-bleed
    const serviceA = await seed.service(salonA, { name: "Cut A" });
    const serviceB = await seed.service(salonB, { name: "Cut B" });
    const employeeA = await seed.employee(salonA);
    const employeeB = await seed.employee(salonB);
    const customerId = await seed.customer();
    const bookingA = await seed.booking({
      salonId: salonA, serviceId: serviceA, employeeId: employeeA, customerId,
      startsAt: inHours(24), endsAt: inHours(25),
    });
    const bookingB = await seed.booking({
      salonId: salonB, serviceId: serviceB, employeeId: employeeB, customerId,
      startsAt: inHours(24), endsAt: inHours(25),
    });
    f = { salonA, salonB, serviceA, serviceB, employeeA, employeeB, bookingA, bookingB };
  });

  describe("factory guard — mandatory scope (§4)", () => {
    it("REQ-012/§4: createRepos without a salonId argument throws (a repo instance IS a salon scope)", () => {
      expect(() =>
        createRepos(db.drizzle, undefined as unknown as { salonId: string }),
      ).toThrow();
    });

    it("REQ-012/§4: createRepos with salonId: undefined throws", () => {
      expect(() =>
        createRepos(db.drizzle, { salonId: undefined as unknown as string }),
      ).toThrow();
    });

    // [CONF: MED] [SRC: INFERENCE from §4 "mandatory salon scope"] — an empty
    // string is not a usable scope; rejecting it is the safe reading.
    it("REQ-012/§4: createRepos with empty-string salonId throws", () => {
      expect(() => createRepos(db.drizzle, { salonId: "" })).toThrow();
    });

    it("REQ-012/§4: positive control — createRepos with a real salonId constructs all six repos", () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      expect(repos.services).toBeDefined();
      expect(repos.employees).toBeDefined();
      expect(repos.workingHours).toBeDefined();
      expect(repos.timeOff).toBeDefined();
      expect(repos.bookings).toBeDefined();
      expect(repos.settings).toBeDefined();
    });
  });

  describe("cross-salon lookups return nothing (§4: and(eq(id), eq(salon_id)) — 404-shaped, never data)", () => {
    it("REQ-012: services.get(id of salon B's service) under scope A returns null", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      expect(await repos.services.get(f.serviceB)).toBeNull();
    });

    it("REQ-012: bookings.get(id of salon B's booking) under scope A returns null", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      expect(await repos.bookings.get(f.bookingB)).toBeNull();
    });

    it("REQ-012: positive control — bookings.get(own salon's booking) under scope A returns it", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      const found = await repos.bookings.get(f.bookingA);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(f.bookingA);
    });

    it("REQ-012: positive control — services.get(own salon's service) under scope A returns it", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      const found = await repos.services.get(f.serviceA);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(f.serviceA);
    });
  });

  describe("list() never returns other salons' rows (§4: every emitted query filters salon_id)", () => {
    it("REQ-012: services.list() under scope A contains A's services and never B's", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      const ids = (await repos.services.list()).map((s) => s.id);
      expect(ids).toContain(f.serviceA);
      expect(ids).not.toContain(f.serviceB);
    });

    it("REQ-012: bookings.list() under scope B contains B's bookings and never A's", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonB });
      const ids = (await repos.bookings.list()).map((b) => b.id);
      expect(ids).toContain(f.bookingB);
      expect(ids).not.toContain(f.bookingA);
    });

    it("REQ-012: employees.list() under scope A contains A's employees and never B's", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      const ids = (await repos.employees.list()).map((e) => e.id);
      expect(ids).toContain(f.employeeA);
      expect(ids).not.toContain(f.employeeB);
    });
  });

  describe("settings are scope-isolated (§3.2 1:1, §4)", () => {
    it("REQ-012: settings.get() under scope A returns salon A's values, not B's", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonA });
      const settings = await repos.settings.get();
      expect(settings?.gapThresholdMinutes).toBe(45);
    });

    it("REQ-012: settings.get() under scope B returns salon B's values, not A's", async () => {
      const repos = createRepos(db.drizzle, { salonId: f.salonB });
      const settings = await repos.settings.get();
      expect(settings?.gapThresholdMinutes).toBe(75);
    });
  });
});

