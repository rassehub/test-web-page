/**
 * TASK-201 — Booking creation pipeline INTEGRATION specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §7 (pipeline, BookingError codes, transaction
 * order, upsert, 23P01→409) + §8 (NotificationPort). REQ-004 ("Booking
 * persists with status confirmed; server rejects stale/invalid slot
 * submissions (409/422) even when client is bypassed"), REQ-006 (gap hard
 * block + admin bypass A1).
 *
 * HTTP mapping asserted at the CODE level (BookingError.code per §7 table;
 * the /api/public/salons/[slug]/bookings route is a thin mapper):
 *   VALIDATION/SERVICE_INACTIVE/OUTSIDE_WORKING_HOURS/GAP_FRAGMENT → 422
 *   STALE_SLOT/SLOT_OCCUPIED → 409
 *
 * NOTIFICATION-PORT SEAM (TASK-201 decision, see tests/README.md):
 *   lib/bookings depends on NotificationPort only (§8). Injection point is
 *   the module-level setter setNotificationPort(port): NotificationPort
 *   (returns the previous port) exported from src/lib/notifications/port.ts
 *   — least invasive: DESIGN §7 signatures stay parameter-free.
 *
 * Error-code disambiguation SPECS (flagged in TASK-201 report):
 *   - start outside every working window      → OUTSIDE_WORKING_HOURS
 *   - aligned + inside window but not offered (buffered overrun) → STALE_SLOT
 *   - obstacle is an existing confirmed booking (validation OR 23P01) →
 *     SLOT_OCCUPIED — never STALE_SLOT. Binding for the race specs.
 *
 * Isolation: PLAIN mode — the pipeline manages its own transactions; unique
 * per-run seeds + Seeder.cleanup() + manual deletion of pipeline-created
 * global customer rows (tracked email/phone). skipIf-gated on the DB probe.
 * RED at import until TASK-203 implements src/lib/bookings/create.ts and
 * src/lib/notifications/port.ts.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBookingAdmin, createBookingPublic } from "../../src/lib/bookings/create";
import { setNotificationPort, type Notification, type NotificationPort } from "../../src/lib/notifications/port";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

// --- fixture ----------------------------------------------------------------

/** Fixed future Sunday; weekday seeded dynamically. Salon TZ "UTC" ⇒ wall == UTC. */
const DAY = "2031-06-15";
const ISO_WD = (((new Date(`${DAY}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** "2031-06-15T10:00:00.000Z"-style ISO string for hour/minute on DAY. */
const at = (h: number, mi = 0): string =>
  `${DAY}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00.000Z`;

interface Fix {
  salonId: string;
  /** 30 min, buffers 10/5. */
  svcA: string;
  /** 60 min, zero buffers. */
  svcB: string;
  /** 30 min, inactive. */
  svcInactive: string;
  e1: string;
  e2: string;
  email: string;
  phone: string;
}
let f: Fix;

/** Pipeline-created guest rows (global customers table §3.8) — manual cleanup. */
let usedEmails: string[] = [];
let usedPhones: string[] = [];

async function seedWorkingHours(employeeId: string): Promise<void> {
  await db.exec(
    `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
     VALUES ($1, $2, $3, 540, 1020)`, // 09:00–17:00
    [f.salonId, employeeId, ISO_WD],
  );
}

// --- notification port spy (§8 seam + post-commit proof) --------------------

interface SentRecord extends Notification {
  /** Status a FRESH connection saw at send() time — null ⇒ row not committed yet. */
  statusAtSend: string | null;
}

function makePortSpy(): { port: NotificationPort; records: SentRecord[] } {
  const records: SentRecord[] = [];
  const port: NotificationPort = {
    async send(n: Notification) {
      const row = await db.one<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [n.bookingId]);
      records.push({ ...n, statusAtSend: row?.status ?? null });
    },
  };
  return { port, records };
}

let prevPort: NotificationPort | null = null;
let spy: ReturnType<typeof makePortSpy>;

// --- lifecycle ---------------------------------------------------------------

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  // No-op without a DB: the structural no-bypass describe below is NOT
  // skipIf-gated and must pass with Postgres down.
  if (!status.ready) return;
  const salonId = await seed.salon({ timezone: "UTC" });
  await seed.salonSettings(salonId, { gapThresholdMinutes: 45, slotGranularityMinutes: 15 });
  f = {
    salonId,
    svcA: await seed.service(salonId, { durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 5 }),
    svcB: await seed.service(salonId, { durationMinutes: 60 }),
    svcInactive: await seed.service(salonId, { durationMinutes: 30, active: false }),
    e1: await seed.employee(salonId),
    e2: await seed.employee(salonId),
    email: `guest-${randomUUID()}@test.example`,
    phone: `+35840${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
  };
  usedEmails = [];
  usedPhones = [];
  await seedWorkingHours(f.e1);
  await seedWorkingHours(f.e2);
  spy = makePortSpy();
  prevPort = setNotificationPort(spy.port);
});

afterEach(async () => {
  if (!status.ready) return;
  if (prevPort !== null) setNotificationPort(prevPort);
  await seed.cleanup(); // staff → salons (cascades bookings) → tracked customers
  if (usedEmails.length > 0) await db.exec(`DELETE FROM customers WHERE email = ANY($1::text[])`, [usedEmails]);
  if (usedPhones.length > 0) await db.exec(`DELETE FROM customers WHERE phone = ANY($1::text[])`, [usedPhones]);
});

// --- guards ------------------------------------------------------------------

type PublicResult = Awaited<ReturnType<typeof createBookingPublic>>;
type AdminResult = Awaited<ReturnType<typeof createBookingAdmin>>;

function expectOk(r: PublicResult | AdminResult): { bookingId: string; status: "confirmed" } {
  if (!("bookingId" in r)) throw new Error(`expected success, got: ${JSON.stringify(r)}`);
  return r;
}

function trackCustomer(email?: string, phone?: string): void {
  if (email) usedEmails.push(email);
  if (phone) usedPhones.push(phone);
}

// --- structural no-bypass (runs ALWAYS — no DB needed) ----------------------

describe("createBookingPublic — structural no-bypass (§7; REQ-006 A1)", () => {
  // Behavior: the public entry point's command type has NO bypassGapRule
  // parameter — the customer flow structurally cannot bypass the gap rule.
  // Compile-level assert: @ts-expect-error goes stale (and fails tsc) if the
  // property ever appears on the public command type.
  it("REQ-006/§7: public command type rejects bypassGapRule (@ts-expect-error compile-level assert)", () => {
    type PublicCmd = Parameters<typeof createBookingPublic>[0];
    // @ts-expect-error — bypassGapRule must NOT exist on the public command
    const mustNotCompile: PublicCmd = {
      salonId: "s", serviceId: "v", startsAt: at(10), customer: { name: "n" }, bypassGapRule: true,
    };
    expect(mustNotCompile).toBeTruthy();
  });
});

// --- integration (DB-gated) --------------------------------------------------

describe.skipIf(!status.ready)("createBookingPublic — happy path (§7; REQ-004)", () => {
  // Behavior: a valid engine-offered slot books as confirmed with exact
  // service duration, buffered blocked_* snapshot, guest customer row, and a
  // BOOKING_CONFIRMED notification that observes COMMITTED state.
  it("REQ-004: valid slot → confirmed booking, 30-min duration, blocked [09:50, 10:35] snapshot, guest row by email, BOOKING_CONFIRMED sent after commit", async () => {
    trackCustomer(f.email, f.phone);
    const r = expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcA, employeeId: f.e1, startsAt: at(10),
        customer: { name: "Grace Guest", email: f.email, phone: f.phone },
      }),
    );
    expect(r.status).toBe("confirmed");

    const row = await db.one<{
      status: string; created_via: string; employee_id: string; customer_id: string;
      starts_at: Date; ends_at: Date; blocked_start: Date; blocked_end: Date;
    }>(
      `SELECT status, created_via, employee_id, customer_id, starts_at, ends_at, blocked_start, blocked_end
         FROM bookings WHERE id = $1`,
      [r.bookingId],
    );
    expect(row?.status).toBe("confirmed");
    expect(row?.created_via).toBe("customer");
    expect(row?.employee_id).toBe(f.e1);
    expect(row?.starts_at.toISOString()).toBe(at(10));
    expect(row?.ends_at.toISOString()).toBe(at(10, 30));   // exactly service duration
    expect(row?.blocked_start.toISOString()).toBe(at(9, 50));  // − buffer_before 10
    expect(row?.blocked_end.toISOString()).toBe(at(10, 35));   // + buffer_after 5

    const cust = await db.one<{ id: string }>(`SELECT id FROM customers WHERE email = $1`, [f.email]);
    expect(cust?.id).toBe(row?.customer_id);

    // §7 step 6 + §8: notification fires AFTER commit — the spy's fresh
    // connection must already see the committed row.
    expect(spy.records).toHaveLength(1);
    expect(spy.records[0].type).toBe("BOOKING_CONFIRMED");
    expect(spy.records[0].bookingId).toBe(r.bookingId);
    expect(spy.records[0].salonId).toBe(f.salonId);
    expect(spy.records[0].recipientEmail).toBe(f.email);
    expect(spy.records[0].statusAtSend).toBe("confirmed");
  });

  // Behavior: guest identity is upserted — a second booking with the same
  // (email, phone, name) reuses the customer row; no duplicate rows.
  it("REQ-004/§3.8: second booking with identical guest (email|phone) reuses the same customer row — exactly 1 row", async () => {
    trackCustomer(f.email, f.phone);
    const b1 = expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(10),
        customer: { name: "Grace Guest", email: f.email, phone: f.phone },
      }),
    );
    const b2 = expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, employeeId: f.e2, startsAt: at(10), // other employee, same interval
        customer: { name: "Grace Guest", email: f.email, phone: f.phone },
      }),
    );
    const rows = await db.one<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE email = $1`, [f.email]);
    expect(rows?.n).toBe("1");
    const c1 = await db.one<{ customer_id: string }>(`SELECT customer_id FROM bookings WHERE id = $1`, [b1.bookingId]);
    const c2 = await db.one<{ customer_id: string }>(`SELECT customer_id FROM bookings WHERE id = $1`, [b2.bookingId]);
    expect(c1?.customer_id).toBe(c2?.customer_id);
  });

  // Behavior: phone-only guests (no email) upsert by phone.
  it("REQ-004/§3.8: phone-only guest (no email) — two bookings, one customer row keyed by phone", async () => {
    trackCustomer(undefined, f.phone);
    expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(10),
        customer: { name: "No Email", phone: f.phone },
      }),
    );
    expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(12),
        customer: { name: "No Email", phone: f.phone },
      }),
    );
    const rows = await db.one<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE phone = $1`, [f.phone]);
    expect(rows?.n).toBe("1");
  });

  // Behavior: omitted employeeId resolves server-side to a deterministic
  // first-available employee — two sequential bookings pick the same one.
  it("REQ-004/§7: employeeId omitted → server resolves; deterministic (same employee for two sequential free-slot bookings)", async () => {
    trackCustomer(f.email);
    const b1 = expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, startsAt: at(10),
        customer: { name: "Any Stylist", email: f.email },
      }),
    );
    const b2 = expectOk(
      await createBookingPublic({
        salonId: f.salonId, serviceId: f.svcB, startsAt: at(12),
        customer: { name: "Any Stylist", email: f.email },
      }),
    );
    const r1 = await db.one<{ employee_id: string }>(`SELECT employee_id FROM bookings WHERE id = $1`, [b1.bookingId]);
    const r2 = await db.one<{ employee_id: string }>(`SELECT employee_id FROM bookings WHERE id = $1`, [b2.bookingId]);
    expect([f.e1, f.e2]).toContain(r1?.employee_id);
    expect(r2?.employee_id).toBe(r1?.employee_id);
  });
});

describe.skipIf(!status.ready)("createBookingPublic — rejection paths (§7; REQ-004/006)", () => {
  // Behavior: a startsAt that is not aligned to slot granularity is stale →
  // STALE_SLOT (409 per §7 table).
  it("REQ-004: startsAt 11:37 (not granularity-aligned, granularity 15) → { code: 'STALE_SLOT' }", async () => {
    trackCustomer(f.email);
    const r = await createBookingPublic({
      salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(11, 37),
      customer: { name: "Grace Guest", email: f.email },
    });
    expect(r).toEqual({ code: "STALE_SLOT" });
  });

  // Behavior: aligned and un-buffered-valid, but the engine would not offer
  // the slot because the buffered interval overruns the window end →
  // STALE_SLOT (spec'd disambiguation: not OUTSIDE_WORKING_HOURS).
  it("REQ-004/REQ-005: startsAt 16:30 aligned, actual 30 min fits until 17:00, but buffered end 17:35 overruns window → { code: 'STALE_SLOT' }", async () => {
    trackCustomer(f.email);
    const r = await createBookingPublic({
      salonId: f.salonId, serviceId: f.svcA, employeeId: f.e1, startsAt: at(16, 30),
      customer: { name: "Grace Guest", email: f.email },
    });
    expect(r).toEqual({ code: "STALE_SLOT" });
  });

  // Behavior: start before any working window → OUTSIDE_WORKING_HOURS (422).
  it("REQ-004: startsAt 08:00 (outside working hours) → { code: 'OUTSIDE_WORKING_HOURS' }", async () => {
    trackCustomer(f.email);
    const r = await createBookingPublic({
      salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(8),
      customer: { name: "Grace Guest", email: f.email },
    });
    expect(r).toEqual({ code: "OUTSIDE_WORKING_HOURS" });
  });

  // Behavior: inactive services never enter the booking flow (REQ-002).
  it("REQ-004/REQ-002: inactive service → { code: 'SERVICE_INACTIVE' }", async () => {
    trackCustomer(f.email);
    const r = await createBookingPublic({
      salonId: f.salonId, serviceId: f.svcInactive, employeeId: f.e1, startsAt: at(10),
      customer: { name: "Grace Guest", email: f.email },
    });
    expect(r).toEqual({ code: "SERVICE_INACTIVE" });
  });

  // Behavior: a booking that would strand a sub-threshold interior gap is
  // hard-blocked (REQ-006) with the fragment length reported.
  it("REQ-006: candidate 11:30–12:30 between busy 09:00–10:00 and 13:00–14:00 strands a 30-min fragment (< threshold 45) → { code: 'GAP_FRAGMENT', fragmentMinutes: 30 }", async () => {
    trackCustomer(f.email);
    const customerId = await seed.customer({ name: "Existing" });
    await seed.booking({ salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, customerId, startsAt: new Date(at(9)), endsAt: new Date(at(10)) });
    await seed.booking({ salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, customerId, startsAt: new Date(at(13)), endsAt: new Date(at(14)) });

    const r = await createBookingPublic({
      salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(11, 30),
      customer: { name: "Grace Guest", email: f.email },
    });
    expect(r).toEqual({ code: "GAP_FRAGMENT", fragmentMinutes: 30 });
  });
});

describe.skipIf(!status.ready)("createBookingAdmin — gap-rule bypass A1 (§7; REQ-006)", () => {
  async function seedFragmentingDay(): Promise<void> {
    const customerId = await seed.customer({ name: "Existing" });
    await seed.booking({ salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, customerId, startsAt: new Date(at(9)), endsAt: new Date(at(10)) });
    await seed.booking({ salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, customerId, startsAt: new Date(at(13)), endsAt: new Date(at(14)) });
  }

  // Behavior: admin manual booking with bypassGapRule=true inserts despite
  // the sub-threshold fragment and is tagged created_via = 'admin_manual'.
  it("REQ-006/A1: bypassGapRule=true inserts despite 30-min fragment; created_via = 'admin_manual'", async () => {
    trackCustomer(f.email);
    await seedFragmentingDay();
    const r = expectOk(
      await createBookingAdmin({
        salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(11, 30),
        customer: { name: "Walk-in", email: f.email }, bypassGapRule: true,
      }),
    );
    const row = await db.one<{ created_via: string }>(`SELECT created_via FROM bookings WHERE id = $1`, [r.bookingId]);
    expect(row?.created_via).toBe("admin_manual");
  });

  // Behavior: the flag is honored — bypassGapRule=false behaves like the
  // public pipeline.
  it("REQ-006: bypassGapRule=false on the same fragmenting submission → { code: 'GAP_FRAGMENT', fragmentMinutes: 30 }", async () => {
    trackCustomer(f.email);
    await seedFragmentingDay();
    const r = await createBookingAdmin({
      salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(11, 30),
      customer: { name: "Walk-in", email: f.email }, bypassGapRule: false,
    });
    expect(r).toEqual({ code: "GAP_FRAGMENT", fragmentMinutes: 30 });
  });
});
