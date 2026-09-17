/**
 * TASK-201 — Booking cancellation INTEGRATION specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §7 ("cancelBooking({ salonId, bookingId }, actor)
 * → status/cancelled_at update …, then BOOKING_CANCELLED after commit"),
 * §3.9 (exclusion constraint WHERE status='confirmed' ⇒ slot re-bookable
 * immediately), §8 (NotificationPort). REQ-008 side coverage ("cancel frees
 * the slot immediately" — DB/UI calendar is Sprint 4; the domain fact is
 * specced here), REQ-011 side coverage (send-after-commit seam).
 *
 * Cancellation result shape is NOT in DESIGN §7 — TASK-201 pins the minimal
 * success contract { bookingId, status: "cancelled" }; error paths were
 * ratified post-hoc in §14.6(e) (NOT_FOUND → 404, ALREADY_CANCELLED → 409)
 * and are specced here by TASK-201b.
 *
 * Isolation: PLAIN mode. skipIf-gated on DB probe. RED at import until
 * TASK-203 implements src/lib/bookings/cancel.ts + notifications port.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBookingPublic } from "../../src/lib/bookings/create";
import { cancelBooking } from "../../src/lib/bookings/cancel";
import { setNotificationPort, type Notification, type NotificationPort } from "../../src/lib/notifications/port";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder, type BookingStatus } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

const DAY = "2031-06-15";
const ISO_WD = (((new Date(`${DAY}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
const at = (h: number, mi = 0): string =>
  `${DAY}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00.000Z`;

interface Fix {
  salonId: string;
  svcA: string; // 30 min, buffers 10/5
  e1: string;
  email: string;
}
let f: Fix;

interface SentRecord extends Notification {
  /** Status a FRESH connection saw at send() time — proves post-commit send. */
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

/** §5.3 SessionUser-shaped owner actor (structural — cancel must accept it). */
const ownerActor = (salonId: string) => ({
  userId: randomUUID(),
  role: "owner" as const,
  salonId,
  employeeId: null,
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  const salonId = await seed.salon({ timezone: "UTC" });
  await seed.salonSettings(salonId, { gapThresholdMinutes: 45, slotGranularityMinutes: 15 });
  f = {
    salonId,
    svcA: await seed.service(salonId, { durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 5 }),
    e1: await seed.employee(salonId),
    email: `cancel-${randomUUID()}@test.example`,
  };
  await db.exec(
    `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
     VALUES ($1, $2, $3, 540, 1020)`,
    [salonId, f.e1, ISO_WD],
  );
  spy = makePortSpy();
  prevPort = setNotificationPort(spy.port);
});

afterEach(async () => {
  if (prevPort !== null) setNotificationPort(prevPort);
  await seed.cleanup();
  await db.exec(`DELETE FROM customers WHERE email = $1`, [f.email]);
});

async function bookAt10(): Promise<string> {
  const r = await createBookingPublic({
    salonId: f.salonId, serviceId: f.svcA, employeeId: f.e1, startsAt: at(10),
    customer: { name: "Cancel Me", email: f.email },
  });
  if (!("bookingId" in r)) throw new Error(`booking failed: ${JSON.stringify(r)}`);
  return r.bookingId;
}

/** Raw booking in f.salonId with explicit status — §14.6(e) non-'confirmed' paths. */
async function seededBooking(status: BookingStatus): Promise<string> {
  const customerId = await seed.customer({ name: "Status Probe" });
  return seed.booking({
    salonId: f.salonId, serviceId: f.svcA, employeeId: f.e1, customerId,
    startsAt: new Date(at(11)), endsAt: new Date(at(12)), status,
  });
}

/** Raw confirmed booking belonging to ANOTHER salon — cross-salon scope probe. */
async function foreignBooking(): Promise<string> {
  const otherSalonId = await seed.salon({ timezone: "UTC" });
  const svc = await seed.service(otherSalonId);
  const emp = await seed.employee(otherSalonId);
  const customerId = await seed.customer({ name: "Foreign Customer" });
  return seed.booking({
    salonId: otherSalonId, serviceId: svc, employeeId: emp, customerId,
    startsAt: new Date(at(10)), endsAt: new Date(at(11)),
  });
}

type CancelResult = Awaited<ReturnType<typeof cancelBooking>>;

describe.skipIf(!status.ready)("cancelBooking (§7, §3.9; REQ-008/REQ-011 side)", () => {
  // Behavior: cancel sets status='cancelled' and cancelled_at, and reports
  // the pinned minimal success shape.
  it("REQ-008: cancel → { bookingId, status: 'cancelled' }; DB row status='cancelled' with cancelled_at set", async () => {
    const bookingId = await bookAt10();
    const r: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId }, ownerActor(f.salonId));
    if (!("status" in r)) throw new Error(`expected cancel success, got: ${JSON.stringify(r)}`);
    expect(r.bookingId).toBe(bookingId);
    expect(r.status).toBe("cancelled");

    const row = await db.one<{ status: string; cancelled_at: Date | null }>(
      `SELECT status, cancelled_at FROM bookings WHERE id = $1`,
      [bookingId],
    );
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelled_at).not.toBeNull();
  });

  // Behavior: the exclusion constraint is partial (WHERE status='confirmed')
  // — a cancelled booking stops blocking immediately; the same interval
  // re-books successfully. Rows are never deleted (audit trail).
  it("REQ-008: slot is immediately re-bookable — same interval books again; 2 rows (1 cancelled + 1 confirmed)", async () => {
    const first = await bookAt10();
    const c = await cancelBooking({ salonId: f.salonId, bookingId: first }, ownerActor(f.salonId));
    if (!("status" in c)) throw new Error(`cancel failed: ${JSON.stringify(c)}`);

    const second = await bookAt10(); // same employee + interval (throws on failure)
    expect(second).not.toBe(first);

    const rows = await db.one<{ n: string; confirmed: string; cancelled: string }>(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
              count(*) FILTER (WHERE status = 'cancelled') AS cancelled
         FROM bookings WHERE salon_id = $1 AND employee_id = $2 AND starts_at = $3`,
      [f.salonId, f.e1, at(10)],
    );
    expect(rows?.n).toBe("2");          // audit trail preserved
    expect(rows?.confirmed).toBe("1");
    expect(rows?.cancelled).toBe("1");
  });

  // Behavior: BOOKING_CANCELLED fires after commit — the spy's fresh
  // connection already observes status='cancelled' at send() time.
  it("REQ-011/§8: BOOKING_CANCELLED sent after commit — spy observes committed status 'cancelled' at send time", async () => {
    const bookingId = await bookAt10();
    const r = await cancelBooking({ salonId: f.salonId, bookingId }, ownerActor(f.salonId));
    if (!("status" in r)) throw new Error(`cancel failed: ${JSON.stringify(r)}`);

    const cancels = spy.records.filter((n) => n.type === "BOOKING_CANCELLED");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].bookingId).toBe(bookingId);
    expect(cancels[0].salonId).toBe(f.salonId);
    expect(cancels[0].statusAtSend).toBe("cancelled"); // pre-commit send would see 'confirmed'/null
  });
});

// TASK-201b — §14.6(e) ratified error contract: BookingError gains
// { code: "NOT_FOUND" } → 404 and { code: "ALREADY_CANCELLED" } → 409.
// Shape assertions use toEqual (strict deep equality): the error member is
// EXACTLY { code } — no success keys, no cross-salon data leakage.
describe.skipIf(!status.ready)("cancelBooking error paths (§14.6(e); REQ-008)", () => {
  // Behavior: unknown uuid within the seeded salon scope → NOT_FOUND member.
  it("§14.6(e)/REQ-008: unknown uuid in seeded salon → exactly { code: 'NOT_FOUND' }", async () => {
    const r: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId: randomUUID() }, ownerActor(f.salonId));
    expect(r).toEqual({ code: "NOT_FOUND" });
  });

  // Behavior: a booking id belonging to another salon must be
  // indistinguishable from a nonexistent one — same member, same shape.
  it("§14.6(e)/REQ-008: booking belonging to ANOTHER salon → identical { code: 'NOT_FOUND' } (no data leak)", async () => {
    const bookingId = await foreignBooking();
    const r: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId }, ownerActor(f.salonId));
    expect(r).toEqual({ code: "NOT_FOUND" }); // byte-identical to the unknown-uuid member
  });

  // Behavior: cancelling an already-cancelled booking fails
  // ALREADY_CANCELLED and mutates nothing — status stays 'cancelled' and the
  // single cancelled_at timestamp is untouched.
  it("§14.6(e)/REQ-008: re-cancel → { code: 'ALREADY_CANCELLED' }; row unchanged (cancelled_at not re-stamped)", async () => {
    const bookingId = await bookAt10();
    const ok = await cancelBooking({ salonId: f.salonId, bookingId }, ownerActor(f.salonId));
    if (!("status" in ok)) throw new Error(`first cancel failed: ${JSON.stringify(ok)}`);
    const afterFirst = await db.one<{ status: string; cancelled_at: Date | null }>(
      `SELECT status, cancelled_at FROM bookings WHERE id = $1`,
      [bookingId],
    );
    expect(afterFirst?.status).toBe("cancelled");
    expect(afterFirst?.cancelled_at).not.toBeNull();

    const again: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId }, ownerActor(f.salonId));
    expect(again).toEqual({ code: "ALREADY_CANCELLED" });

    const afterSecond = await db.one<{ status: string; cancelled_at: Date | null }>(
      `SELECT status, cancelled_at FROM bookings WHERE id = $1`,
      [bookingId],
    );
    expect(afterSecond?.status).toBe("cancelled");
    expect(afterSecond?.cancelled_at?.getTime()).toBe(afterFirst?.cancelled_at?.getTime()); // idempotent-fail: no re-stamp
  });

  // Behavior: any status ≠ 'confirmed' at cancel time is ALREADY_CANCELLED —
  // completed and no_show hit the same member.
  it("§14.6(e)/REQ-008: status 'completed' (and 'no_show') → { code: 'ALREADY_CANCELLED' }", async () => {
    const completedId = await seededBooking("completed");
    const rCompleted: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId: completedId }, ownerActor(f.salonId));
    expect(rCompleted).toEqual({ code: "ALREADY_CANCELLED" });

    const noShowId = await seededBooking("no_show");
    const rNoShow: CancelResult = await cancelBooking({ salonId: f.salonId, bookingId: noShowId }, ownerActor(f.salonId));
    expect(rNoShow).toEqual({ code: "ALREADY_CANCELLED" });
  });

  // Behavior: BOOKING_CANCELLED is success-only — none of the §14.6(e) error
  // paths reaches the notification port. The cancelled row here is RAW-seeded
  // (never a successful cancelBooking call) so zero sends is unambiguous.
  it("§14.6(e)/§8/REQ-011: error paths fire no notifications — spy records stay empty across all error triggers", async () => {
    const unknown = await cancelBooking({ salonId: f.salonId, bookingId: randomUUID() }, ownerActor(f.salonId));
    if (!("code" in unknown)) throw new Error(`expected NOT_FOUND, got: ${JSON.stringify(unknown)}`);

    const foreignId = await foreignBooking();
    await cancelBooking({ salonId: f.salonId, bookingId: foreignId }, ownerActor(f.salonId));

    const cancelledId = await seededBooking("cancelled");
    await cancelBooking({ salonId: f.salonId, bookingId: cancelledId }, ownerActor(f.salonId));

    const completedId = await seededBooking("completed");
    await cancelBooking({ salonId: f.salonId, bookingId: completedId }, ownerActor(f.salonId));

    expect(spy.records).toHaveLength(0);
  });
});
