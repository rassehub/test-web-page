/**
 * TASK-201 — Concurrency race specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §3.10 (exclusion constraint, "race test proof
 * shape: 20 parallel inserts → exactly 1 commit, 19× 23P01, no orphan rows"),
 * §7 (advisory lock, 23P01 → SLOT_OCCUPIED). REQ-007 acceptance criteria:
 * "20 parallel requests for the same slot → exactly 1 succeeds; no orphaned
 * rows".
 *
 * BINDING disambiguation (TASK-201 report): because §7's advisory lock
 * serializes same-employee-day transactions, some losers detect the winner
 * during VALIDATION (busy overlap) instead of hitting 23P01 at INSERT. The
 * pipeline MUST emit SLOT_OCCUPIED on both paths — "slot no longer offered"
 * (STALE_SLOT) is reserved for schedule-shaped staleness, never occupancy.
 *
 * Isolation: PLAIN mode (pipeline owns its transactions). Unique per-run
 * seeds + cleanup incl. pipeline-created guest rows. skipIf-gated on the DB
 * probe. RED at import until TASK-203 lands.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBookingPublic } from "../../src/lib/bookings/create";
import { setNotificationPort, type Notification, type NotificationPort } from "../../src/lib/notifications/port";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

const DAY = "2031-06-15";
const ISO_WD = (((new Date(`${DAY}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
const at = (h: number, mi = 0): string =>
  `${DAY}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00.000Z`;

const N = 20;

interface Fix {
  salonId: string;
  svcB: string; // 60 min, zero buffers
  e1: string;
  e2: string;
  email: string;
}
let f: Fix;
let usedEmails: string[] = [];

/** Silent spy port — counts sends, proves nothing about timing (create.test.ts does that). */
function makePortSpy(): { port: NotificationPort; sends: Notification[] } {
  const sends: Notification[] = [];
  return { port: { async send(n) { sends.push(n); } }, sends };
}

let prevPort: NotificationPort | null = null;
let spy: ReturnType<typeof makePortSpy>;

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  const salonId = await seed.salon({ timezone: "UTC" });
  await seed.salonSettings(salonId, { gapThresholdMinutes: 45, slotGranularityMinutes: 15 });
  f = {
    salonId,
    svcB: await seed.service(salonId, { durationMinutes: 60 }),
    e1: await seed.employee(salonId),
    e2: await seed.employee(salonId),
    email: `race-${randomUUID()}@test.example`,
  };
  usedEmails = [f.email];
  for (const e of [f.e1, f.e2]) {
    await db.exec(
      `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
       VALUES ($1, $2, $3, 540, 1020)`,
      [salonId, e, ISO_WD],
    );
  }
  spy = makePortSpy();
  prevPort = setNotificationPort(spy.port);
});

afterEach(async () => {
  if (prevPort !== null) setNotificationPort(prevPort);
  await seed.cleanup();
  await db.exec(`DELETE FROM customers WHERE email = ANY($1::text[])`, [usedEmails]);
});

type PublicResult = Awaited<ReturnType<typeof createBookingPublic>>;
const isWin = (r: PublicResult): r is { bookingId: string; status: "confirmed" } => "bookingId" in r;

// --- scenario 1: same employee, same interval -------------------------------

describe("20-way parallel race — same employee/interval (§3.10, §7; REQ-007)", () => {
  // Behavior: exactly one of 20 concurrent public bookings for the same
  // employee/interval commits; all 19 losers get SLOT_OCCUPIED (409 class);
  // the DB holds exactly one row and one upserted customer row.
  it("REQ-007: exactly 1 success, 19 × { code: 'SLOT_OCCUPIED' }, 1 confirmed booking row, 1 customer row, 1 BOOKING_CONFIRMED", async () => {
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        createBookingPublic({
          salonId: f.salonId, serviceId: f.svcB, employeeId: f.e1, startsAt: at(10),
          customer: { name: "Race Guest", email: f.email },
        }),
      ),
    );
    const wins = results.filter(isWin);
    const losses = results.filter((r) => !isWin(r));
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(N - 1);
    for (const l of losses) expect(l).toEqual({ code: "SLOT_OCCUPIED" });

    // No orphan rows: exactly one booking for that employee/interval (any status).
    const b = await db.one<{ n: string; confirmed: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE status = 'confirmed') AS confirmed
         FROM bookings WHERE salon_id = $1 AND employee_id = $2 AND starts_at = $3`,
      [f.salonId, f.e1, at(10)],
    );
    expect(b?.n).toBe("1");
    expect(b?.confirmed).toBe("1");

    // No orphan customers beyond the single expected upsert.
    const c = await db.one<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE email = $1`, [f.email]);
    expect(c?.n).toBe("1");

    // Exactly one confirmation notification (winners only).
    expect(spy.sends.filter((n) => n.type === "BOOKING_CONFIRMED")).toHaveLength(1);
  });
});

// --- scenario 2: two employees, employeeId omitted --------------------------

describe("20-way parallel race — 2 employees, employeeId omitted (§7; REQ-007)", () => {
  // Behavior: with server-side employee resolution, no employee is ever
  // double-booked: at most one confirmed booking per employee per interval;
  // every loss is SLOT_OCCUPIED; DB rows == winners; one customer upsert.
  it("REQ-007: no employee double-booked — ≤1 confirmed booking per employee for the interval, all losses SLOT_OCCUPIED, rows == winners, 1 customer row", async () => {
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        createBookingPublic({
          salonId: f.salonId, serviceId: f.svcB, startsAt: at(10), // employeeId omitted
          customer: { name: "Race Guest", email: f.email },
        }),
      ),
    );
    const wins = results.filter(isWin);
    const losses = results.filter((r) => !isWin(r));
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(wins.length).toBeLessThanOrEqual(2); // only 2 employees exist
    expect(wins.length + losses.length).toBe(N);
    for (const l of losses) expect(l).toEqual({ code: "SLOT_OCCUPIED" });

    // DB truth: per-employee counts at the interval are ≤ 1, all distinct
    // (perEmployee.length === winners — the exclusion constraint makes a
    // same-employee collision impossible), and total == winners.
    const grouped = await db.exec(
       `SELECT employee_id, count(*) AS n FROM bookings
         WHERE salon_id = $1 AND starts_at = $2 AND status = 'confirmed'
         GROUP BY employee_id`,
       [f.salonId, at(10)],
    );
    const perEmployee = grouped.rows as Array<{ employee_id: string; n: string }>;
    for (const rowN of perEmployee) expect(Number(rowN.n)).toBeLessThanOrEqual(1);
    const total = perEmployee.reduce((acc, r) => acc + Number(r.n), 0);
    expect(total).toBe(wins.length);
    expect(perEmployee.length).toBe(wins.length);

    const c = await db.one<{ n: string }>(`SELECT count(*) AS n FROM customers WHERE email = $1`, [f.email]);
    expect(c?.n).toBe("1");

    expect(spy.sends.filter((n) => n.type === "BOOKING_CONFIRMED")).toHaveLength(wins.length);
  });
});
