/**
 * TASK-201 — Public slots route specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §2.3 (GET /api/public/salons/[slug]/slots —
 * auth "none", Sprint 2, REQ-005), §6.1 (SlotQuery + SlotComputationResult;
 * getAvailableSlots throws NotFound → 404 / ValidationError → 422), §2.3
 * rules (404 no-leak for cross-salon resources).
 *
 * CONTRACT UNDER TEST (module path per DESIGN §9 — direct handler
 * invocation, same strategy as tests/admin/salons.test.ts):
 *   import { GET } from "../../src/app/api/public/salons/[slug]/slots/route"
 * RouteContext is structural: { params: Promise<{ slug: string }> }.
 * Query params (camelCase, mirroring SlotQuery): serviceId, fromDate, toDate
 * (employeeId optional — not pinned here).
 *
 * NO AUTH: the handler is invoked with NO session cookie and NO next/headers
 * mock — any 200 proves auth is not required (importing a cookies() mock
 * would defeat the point).
 *
 * Isolation: PLAIN mode. skipIf-gated on DB probe. RED at import until
 * TASK-202/203 land the route + engine.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/public/salons/[slug]/slots/route";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

const DAY = "2031-06-15";
const ISO_WD = (((new Date(`${DAY}T00:00:00Z`).getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
const T = (h: number, mi = 0): number => Date.UTC(2031, 5, 15, h, mi);

interface Fix {
  slug: string;
  salonId: string;
  serviceId: string; // 30 min, zero buffers
  employeeId: string;
}
let f: Fix;

function req(slug: string, q: Record<string, string>): Request {
  const url = new URL(`http://localhost/api/public/salons/${slug}/slots`);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return new Request(url, { method: "GET" });
}

/** Next.js 15 route context (params is a Promise). */
function ctx(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  const salonId = await seed.salon({ slug: `slots-${randomUUID()}`, timezone: "UTC" });
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
});

afterEach(async () => {
  await seed.cleanup();
});

interface SlotDto {
  startUtc: string;
  endUtc: string;
  employeeId: string;
  localDate: string;
}
interface SlotsBody {
  granularityMinutes: number;
  slots: SlotDto[];
}

describe.skipIf(!status.ready)("GET /api/public/salons/[slug]/slots — happy path (§6.1; REQ-005)", () => {
  // Behavior: seeded salon/service/working hours return the
  // SlotComputationResult shape with granularity from salon_settings and
  // 23 granularity-20-aligned slots (starts 540+20k, k=0…22; start+30 ≤ 1020
  // ⇒ last start 16:20) sorted by startUtc — with no auth whatsoever.
  it("REQ-005/§6.1: 200 with SlotComputationResult — granularityMinutes 20, 23 slots 09:00…16:20, correct keys, localDate, no auth required", async () => {
    const res = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: DAY, toDate: DAY }),
      ctx(f.slug),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SlotsBody;
    expect(body.granularityMinutes).toBe(20);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots).toHaveLength(23);

    let prevStart = -Infinity;
    for (const s of body.slots) {
      expect(Object.keys(s).sort()).toEqual(["employeeId", "endUtc", "localDate", "startUtc"]);
      expect(s.employeeId).toBe(f.employeeId);
      expect(s.localDate).toBe(DAY);
      expect(s.startUtc.endsWith("Z")).toBe(true);
      expect(Date.parse(s.endUtc) - Date.parse(s.startUtc)).toBe(30 * 60_000);
      const start = Date.parse(s.startUtc);
      expect(start % (20 * 60_000)).toBe((540 % 20) * 60_000); // stepped from 09:00 window boundary
      expect(start).toBeGreaterThanOrEqual(prevStart);
      prevStart = start;
    }
    expect(Date.parse(body.slots[0].startUtc)).toBe(T(9));
    expect(Date.parse(body.slots.at(-1)!.startUtc)).toBe(T(16, 20));
  });

  // Behavior: an employee with no working hours on the queried day returns
  // 200 with an empty slot list (empty ≠ error).
  it("REQ-005/§6.1: weekday with no working hours → 200 with slots: []", async () => {
    const res = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: "2031-06-16", toDate: "2031-06-16" }),
      ctx(f.slug),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SlotsBody;
    expect(body.slots).toHaveLength(0);
    expect(body.granularityMinutes).toBe(20);
  });
});

describe.skipIf(!status.ready)("GET /api/public/salons/[slug]/slots — 404 no-leak (§2.3, §6.1; REQ-005/REQ-012)", () => {
  // Behavior: unknown slug → 404.
  it("REQ-005/§6.1: unknown slug → 404", async () => {
    const ghost = `ghost-${randomUUID()}`;
    const res = await GET(
      req(ghost, { serviceId: f.serviceId, fromDate: DAY, toDate: DAY }),
      ctx(ghost),
    );
    expect(res.status).toBe(404);
  });

  // Behavior: unknown-but-valid-uuid service → 404.
  it("REQ-005/§6.1: unknown serviceId (valid uuid) → 404", async () => {
    const res = await GET(
      req(f.slug, { serviceId: randomUUID(), fromDate: DAY, toDate: DAY }),
      ctx(f.slug),
    );
    expect(res.status).toBe(404);
  });

  // Behavior: a real service belonging to ANOTHER salon is 404 — existence
  // is never leaked across salon scope (§2.3 rule).
  it("REQ-012/§2.3: service of a different salon → 404 (no cross-salon leak)", async () => {
    const otherSalon = await seed.salon({ timezone: "UTC" });
    const otherService = await seed.service(otherSalon, { durationMinutes: 30 });
    const res = await GET(
      req(f.slug, { serviceId: otherService, fromDate: DAY, toDate: DAY }),
      ctx(f.slug),
    );
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!status.ready)("GET /api/public/salons/[slug]/slots — 422 validation (§6.1; REQ-005)", () => {
  // Behavior: range beyond 31 inclusive days → 422.
  it("REQ-005/§6.1: 32-day range (2031-06-01…2031-07-02) → 422", async () => {
    const res = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: "2031-06-01", toDate: "2031-07-02" }),
      ctx(f.slug),
    );
    expect(res.status).toBe(422);
  });

  // Behavior: exactly 31 inclusive days (June's 30 + Jul 1) is the cap
  // boundary and MUST pass.
  it("REQ-005/§6.1: 31-day range (2031-06-01…2031-07-01) is accepted (200)", async () => {
    const res = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: "2031-06-01", toDate: "2031-07-01" }),
      ctx(f.slug),
    );
    expect(res.status).toBe(200);
  });

  // Behavior: reversed range → 422.
  it("REQ-005/§6.1: fromDate after toDate → 422", async () => {
    const res = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: "2031-06-16", toDate: DAY }),
      ctx(f.slug),
    );
    expect(res.status).toBe(422);
  });

  // Behavior: malformed calendar dates → 422 (zod at the HTTP boundary, §9).
  it("REQ-005/§6.1: malformed fromDate (month 13) → 422; malformed toDate (garbage) → 422", async () => {
    const r1 = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: "2031-13-01", toDate: DAY }),
      ctx(f.slug),
    );
    expect(r1.status).toBe(422);
    const r2 = await GET(
      req(f.slug, { serviceId: f.serviceId, fromDate: DAY, toDate: "garbage" }),
      ctx(f.slug),
    );
    expect(r2.status).toBe(422);
  });

  // Behavior: missing required query param → 422.
  it("REQ-005/§6.1: missing serviceId → 422", async () => {
    const res = await GET(req(f.slug, { fromDate: DAY, toDate: DAY }), ctx(f.slug));
    expect(res.status).toBe(422);
  });
});
