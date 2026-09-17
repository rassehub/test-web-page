/**
 * TASK-300 — Customer booking HTTP flow specs (audit S2 remediation:
 * route-level tests for the public bookings POST were absent).
 *
 * Design ref: docs/DESIGN.md §2.3 (POST /api/public/salons/[slug]/bookings —
 * auth "none"; GET /slots — auth "none"), §6.1 (SlotComputationResult shape),
 * §7 + §14.6 (BookingError → HTTP table: STALE_SLOT 409, GAP_FRAGMENT 422,
 * NOT_FOUND 404; zod VALIDATION 422 at the boundary), §3.9 (blocked_* snapshot
 * columns).
 *
 * CONTRACT UNDER TEST (direct route-handler invocation, slots-api precedent):
 *   import { GET }  from ".../slots/route"     (landed TASK-203)
 *   import { POST } from ".../bookings/route"  (landed TASK-203)
 * Full HTTP happy path on the real DB: GET slots → first slot's startUtc +
 * employeeId → POST booking → 201 {bookingId, status:"confirmed"}; DB asserts
 * the bookings row (exact duration, blocked_* snapshot, created_via) and the
 * upserted guest customers row. Error legs AT ROUTE LEVEL (4xx + body codes).
 *
 * RED/GREEN STATUS (see tests/README.md): both routes shipped in Sprint 2, so
 * the 5 TASK-300 cases are REMEDIATION PINS expected GREEN-on-arrival
 * (TASK-108 F4 precedent) — any red there is route drift and routes to [CODE].
 * TASK-302b appends 3: 1 RED-first contract (customer with neither phone nor
 * email → 422 VALIDATION — REQ-004 server-authoritative rejection; green only
 * after TASK-302c's zod refinement) + 2 boundary positives (phone-only /
 * email-only MUST stay 201) guarding TASK-302c against over-tightening.
 *
 * Error-body shapes (as implemented by the S2 route mapper, here pinned):
 *   domain errors → the BookingError object itself, e.g. {code:"STALE_SLOT"};
 *   zod failures   → {error:"VALIDATION", issues:[...]}.
 *
 * Isolation: PLAIN mode — the booking pipeline owns its transactions.
 * Unique-per-run seeds + Seeder.cleanup() FIRST (the salon cascade removes
 * bookings before guest rows are deleted — §3.9 customer FK is NO ACTION,
 * create/race/cancel precedent) + manual deletion of pipeline-created global
 * customers rows afterwards, tracked by phone / email / (RED-phase unkeyed
 * rows) UUID-suffixed name (§3.8 no-cascade). Notification port silenced via
 * the §14.6(g) seam (spy installed per test, restored after).
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/public/salons/[slug]/slots/route";
import { POST } from "../../src/app/api/public/salons/[slug]/bookings/route";
import { setNotificationPort, type NotificationPort } from "../../src/lib/notifications/port";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

/** Fixed future day; weekday seeded dynamically. Salon TZ "UTC" ⇒ wall == UTC. */
const DAY = "2031-06-15";
const ISO_WD = (((new Date(`${DAY}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** "2031-06-15T10:00:00.000Z"-style ISO string for hour/minute on DAY. */
const at = (h: number, mi = 0): string =>
  `${DAY}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00.000Z`;

interface Fix {
  slug: string;
  salonId: string;
  serviceId: string; // 30 min, zero buffers
  employeeId: string;
}
let f: Fix;

/** Pipeline-created guest rows (global customers table §3.8) — manual cleanup. */
const usedPhones: string[] = [];
const usedEmails: string[] = [];
/** TASK-302b RED phase: unkeyed guest rows (no phone/email) — tracked by unique name. */
const usedNoKeyNames: string[] = [];

let prevPort: NotificationPort | null = null;

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!status.ready) return;
  const salonId = await seed.salon({ slug: `flow-${randomUUID()}`, timezone: "UTC" });
  await seed.salonSettings(salonId, { gapThresholdMinutes: 45, slotGranularityMinutes: 20 });
  const employeeId = await seed.employee(salonId);
  await db.exec(
    `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
     VALUES ($1, $2, $3, 540, 1020)`, // 09:00–17:00
    [salonId, employeeId, ISO_WD],
  );
  f = {
    slug: (await db.one<{ slug: string }>(`SELECT slug FROM salons WHERE id = $1`, [salonId]))!.slug,
    salonId,
    serviceId: await seed.service(salonId, { durationMinutes: 30 }),
    employeeId,
  };
  // Silence the default console adapter (§14.6(g) seam); restored in afterEach.
  prevPort = setNotificationPort({ async send() {} });
});

afterEach(async () => {
  if (prevPort) {
    setNotificationPort(prevPort);
    prevPort = null;
  }
  // Cleanup order (Sprint-2 create.test.ts precedent): salon cascade deletes
  // bookings FIRST — the §3.9 customer FK is NO ACTION, so guest rows can only
  // be removed after their referencing bookings are gone.
  await seed.cleanup();
  if (usedPhones.length > 0) {
    await db.exec(`DELETE FROM customers WHERE phone = ANY($1::text[])`, [usedPhones]);
    usedPhones.length = 0;
  }
  if (usedEmails.length > 0) {
    await db.exec(`DELETE FROM customers WHERE email = ANY($1::text[])`, [usedEmails]);
    usedEmails.length = 0;
  }
  if (usedNoKeyNames.length > 0) {
    await db.exec(`DELETE FROM customers WHERE name = ANY($1::text[])`, [usedNoKeyNames]);
    usedNoKeyNames.length = 0;
  }
});

interface SlotDto {
  startUtc: string;
  employeeId: string;
}

function slotsReq(slug: string, serviceId: string): Request {
  const url = new URL(`http://localhost/api/public/salons/${slug}/slots`);
  url.searchParams.set("serviceId", serviceId);
  url.searchParams.set("fromDate", DAY);
  url.searchParams.set("toDate", DAY);
  return new Request(url, { method: "GET" });
}

function postBooking(slug: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/public/salons/${slug}/bookings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

describe.skipIf(!status.ready)("HTTP happy path: GET slots → POST booking → 201 (§2.3, §6.1, §7; REQ-004)", () => {
  // Behavior: a guest with no session books the FIRST engine-offered slot
  // through the real route handlers — 201 with {bookingId, status:"confirmed"};
  // the bookings row persists with exact 30-min duration, blocked_* snapshot
  // equal to [starts_at, ends_at] (zero-buffer service), created_via
  // 'customer', and the guest customers row is upserted by phone with the
  // submitted name (REQ-004 AC: "Booking persists with status confirmed").
  it("REQ-004/§7: first offered slot books via HTTP → 201 {bookingId,status:'confirmed'} + DB row + blocked snapshot + guest customer row", async () => {
    const phone = `flow-${randomUUID()}`;
    usedPhones.push(phone);

    const slotsRes = await GET(slotsReq(f.slug, f.serviceId), { params: Promise.resolve({ slug: f.slug }) });
    expect(slotsRes.status).toBe(200);
    const slotsBody = (await slotsRes.json()) as { slots: SlotDto[] };
    expect(slotsBody.slots.length).toBeGreaterThan(0);
    const first = slotsBody.slots[0]!;
    expect(Date.parse(first.startUtc)).toBe(Date.parse(at(9))); // 09:00 window boundary

    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: first.employeeId,
      startsAt: first.startUtc,
      customer: { name: "Flow Guest", phone },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookingId: string; status: string };
    expect(body.status).toBe("confirmed");
    expect(typeof body.bookingId).toBe("string");
    expect(body.bookingId.length).toBeGreaterThan(0);

    const row = await db.one<{
      salon_id: string;
      service_id: string;
      employee_id: string;
      starts_at: Date;
      ends_at: Date;
      blocked_start: Date;
      blocked_end: Date;
      status: string;
      created_via: string;
    }>(
      `SELECT salon_id, service_id, employee_id, starts_at, ends_at, blocked_start, blocked_end, status, created_via
       FROM bookings WHERE id = $1`,
      [body.bookingId],
    );
    expect(row).not.toBeNull();
    expect(row!.salon_id).toBe(f.salonId);
    expect(row!.service_id).toBe(f.serviceId);
    expect(row!.employee_id).toBe(first.employeeId);
    expect(Date.parse(row!.starts_at.toISOString())).toBe(Date.parse(first.startUtc));
    expect(Date.parse(row!.ends_at.toISOString())).toBe(Date.parse(first.startUtc) + 30 * 60_000); // §3.9 exact duration
    expect(Date.parse(row!.blocked_start.toISOString())).toBe(Date.parse(row!.starts_at.toISOString())); // zero-buffer snapshot
    expect(Date.parse(row!.blocked_end.toISOString())).toBe(Date.parse(row!.ends_at.toISOString()));
    expect(row!.status).toBe("confirmed");
    expect(row!.created_via).toBe("customer");

    const guest = await db.one<{ name: string }>(`SELECT name FROM customers WHERE phone = $1`, [phone]);
    expect(guest?.name).toBe("Flow Guest");
  });
});

describe.skipIf(!status.ready)("HTTP error legs on POST /bookings (§7, §14.6; REQ-004)", () => {
  // Behavior: a startsAt MISALIGNED to slot granularity (09:37 vs 20-min grid)
  // is rejected at route level with 409 and the STALE_SLOT body — server-side
  // rejection even when the client is bypassed (REQ-004 AC).
  it("REQ-004/§7: misaligned startsAt (09:37 on 20-min grid) → 409 {code:'STALE_SLOT'}", async () => {
    const phone = `flow-${randomUUID()}`;
    usedPhones.push(phone);
    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: f.employeeId,
      startsAt: at(9, 37),
      customer: { name: "Misaligned Guest", phone },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "STALE_SLOT" });
  });

  // Behavior: an aligned, in-window, engine-offered start that would leave a
  // sub-threshold interior fragment is rejected 422 with the GAP_FRAGMENT body
  // including fragmentMinutes (§6.3 binding definition via §7; REQ-006 hard
  // block on the customer path). Busy 11:00–12:00 + candidate 12:20 ⇒
  // prev-side fragment 12:00→12:20 = 20 min < 45 threshold.
  it("REQ-006/§7: mid-gap candidate leaving 20-min fragment (threshold 45) → 422 {code:'GAP_FRAGMENT',fragmentMinutes:20}", async () => {
    const phone = `flow-${randomUUID()}`;
    usedPhones.push(phone);
    const customerId = await seed.customer({ name: "Existing Guest", phone: `busy-${randomUUID()}` });
    await seed.booking({
      salonId: f.salonId,
      serviceId: f.serviceId,
      employeeId: f.employeeId,
      customerId,
      startsAt: new Date(at(11)),
      endsAt: new Date(at(12)),
    });

    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: f.employeeId,
      startsAt: at(12, 20),
      customer: { name: "Fragment Guest", phone },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "GAP_FRAGMENT", fragmentMinutes: 20 });
  });

  // Behavior: a well-formed but unknown service uuid → 404 NOT_FOUND body
  // (§14.6(j) create-path unknown service), never a 500.
  it("REQ-004/§14.6(j): unknown serviceId (valid uuid) → 404 {code:'NOT_FOUND'}", async () => {
    const phone = `flow-${randomUUID()}`;
    usedPhones.push(phone);
    const res = await postBooking(f.slug, {
      serviceId: randomUUID(),
      employeeId: f.employeeId,
      startsAt: at(9),
      customer: { name: "Ghost Service Guest", phone },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "NOT_FOUND" });
  });

  // Behavior: malformed body — customer.name missing — is rejected at the
  // HTTP boundary by zod: 422 with the route's VALIDATION error shape.
  it("REQ-004/§9: malformed body (customer without name) → 422 VALIDATION", async () => {
    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: f.employeeId,
      startsAt: at(9),
      customer: { phone: `flow-${randomUUID()}` },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string; issues?: unknown[] };
    expect(body.error).toBe("VALIDATION");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!status.ready)("TASK-302b — server-side contact validation (§9; REQ-004)", () => {
  // Behavior: a payload whose customer has a name but NEITHER phone NOR email
  // is rejected at the HTTP boundary — the wizard's client-side gate cannot
  // be the only enforcement (REQ-004 AC: server rejects invalid submissions
  // "even when client is bypassed"). Every other field is valid (09:00 is the
  // first engine-offered slot; happy path above pins that), so the rejection
  // can only be contact-driven.
  //
  // RED until TASK-302c (zod refinement ≥1 of phone/email). Body shape
  // mirrors the route's zod VALIDATION branch pinned by the missing-name case
  // — NOT the pipeline BookingError {code:"VALIDATION",field} shape, which a
  // route-level zod refinement never produces (see tests/README decision 22).
  it("REQ-004/§9: customer with name only (no phone, no email) → 422 VALIDATION", async () => {
    const name = `NoContact-${randomUUID()}`;
    usedNoKeyNames.push(name); // today (RED) an unkeyed guest row leaks; name-tracked for cleanup
    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: f.employeeId,
      startsAt: at(9),
      customer: { name },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string; issues?: unknown[] };
    expect(body.error).toBe("VALIDATION");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues!.length).toBeGreaterThan(0);
  });

  // Behavior: phone ALONE satisfies the ≥1-contact-channel requirement —
  // boundary positive so TASK-302c's refinement cannot over-tighten into
  // both-required (or email-only). GREEN today; must stay green after 302c.
  it("REQ-004/§9: phone-only customer books → 201 (must NOT 422)", async () => {
    const phone = `flow-${randomUUID()}`;
    usedPhones.push(phone);
    const slotsRes = await GET(slotsReq(f.slug, f.serviceId), { params: Promise.resolve({ slug: f.slug }) });
    expect(slotsRes.status).toBe(200);
    const slotsBody = (await slotsRes.json()) as { slots: SlotDto[] };
    const first = slotsBody.slots[0]!;

    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: first.employeeId,
      startsAt: first.startUtc,
      customer: { name: "Phone Only Guest", phone },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookingId: string; status: string };
    expect(body.status).toBe("confirmed");
    expect(typeof body.bookingId).toBe("string");
    expect(body.bookingId.length).toBeGreaterThan(0);
  });

  // Behavior: email ALONE is the other legal single channel (§7 guest upsert
  // keys email-first) — same over-tightening guard for TASK-302c. GREEN today.
  it("REQ-004/§9: email-only customer books → 201 (must NOT 422)", async () => {
    const email = `flow-${randomUUID()}@test.example`;
    usedEmails.push(email);
    const slotsRes = await GET(slotsReq(f.slug, f.serviceId), { params: Promise.resolve({ slug: f.slug }) });
    expect(slotsRes.status).toBe(200);
    const slotsBody = (await slotsRes.json()) as { slots: SlotDto[] };
    const first = slotsBody.slots[0]!;

    const res = await postBooking(f.slug, {
      serviceId: f.serviceId,
      employeeId: first.employeeId,
      startsAt: first.startUtc,
      customer: { name: "Email Only Guest", email },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookingId: string; status: string };
    expect(body.status).toBe("confirmed");
    expect(typeof body.bookingId).toBe("string");
    expect(body.bookingId.length).toBeGreaterThan(0);
  });
});
