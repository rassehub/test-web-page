/**
 * TASK-300 — Public catalog route specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §2.3 (GET /api/public/salons/[slug]/services and
 * /employees — auth "none", Sprint 3, REQ-002/REQ-003), §3.3/§3.4 (active flag
 * — "inactive services never appear in customer flow", active employees only),
 * §2.3 rules (404 no-leak), §14.6(2) (camelCase domain fields at the boundary).
 *
 * CONTRACT UNDER TEST (module paths per DESIGN §9 — direct handler
 * invocation, same strategy as tests/public/slots-api.test.ts):
 *   import { GET } from "../../src/app/api/public/salons/[slug]/services/route"
 *   import { GET } from "../../src/app/api/public/salons/[slug]/employees/route"
 * RouteContext is structural: { params: Promise<{ slug: string }> } (Next 15).
 *
 * DTO PIN (spec decision — see tests/README.md Sprint 3 decisions):
 *   services item keys EXACTLY  { id, name, durationMinutes, priceCents }
 *   employees item keys EXACTLY { id, displayName, title }  (title: string | null)
 * No buffer fields, no timestamps — the customer flow gets id/name/price/
 * duration (wizard) and id/name/title (stylist pick) and nothing else.
 *
 * NO AUTH: handlers are invoked with NO session cookie and NO next/headers
 * mock — any 200 proves auth is not required (slots-api precedent).
 *
 * Isolation: PLAIN mode. skipIf-gated on DB probe. RED at import until
 * TASK-302 lands the routes.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as GET_services } from "../../src/app/api/public/salons/[slug]/services/route";
import { GET as GET_employees } from "../../src/app/api/public/salons/[slug]/employees/route";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder } from "../helpers/seed";

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

interface Fix {
  slug: string;
  salonId: string;
  cutId: string;
  beardId: string;
  ainoId: string;
  mikaId: string;
}
let f: Fix;

function req(slug: string, kind: "services" | "employees"): Request {
  return new Request(`http://localhost/api/public/salons/${slug}/${kind}`, { method: "GET" });
}

/** Next.js 15 route context (params is a Promise). */
function ctx(slug: string): { params: Promise<{ slug: string }> } {
  return { params: Promise.resolve({ slug }) };
}

interface ServiceDto {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}
interface EmployeeDto {
  id: string;
  displayName: string;
  title: string | null;
}

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  const salonId = await seed.salon({ slug: `catalog-${randomUUID()}` });
  f = {
    slug: (await db.one<{ slug: string }>(`SELECT slug FROM salons WHERE id = $1`, [salonId]))!.slug,
    salonId,
    cutId: await seed.service(salonId, { name: "Cut & Style", durationMinutes: 45, priceCents: 4_500 }),
    beardId: await seed.service(salonId, { name: "Beard Trim", durationMinutes: 20, priceCents: 2_500 }),
    ainoId: await seed.employee(salonId, { displayName: "Aino Korhonen" }),
    mikaId: await seed.employee(salonId, { displayName: "Mika Virtanen" }),
  };
  // Deactivated rows — must NEVER surface in the customer flow (§3.3/§3.4).
  await seed.service(salonId, { name: "Legacy Perm", durationMinutes: 90, priceCents: 9_000, active: false });
  await seed.employee(salonId, { displayName: "Retired Stylist", active: false });
  // Title round-trip for one active employee (nullable column, §3.4).
  await db.exec(`UPDATE employees SET title = 'Senior stylist' WHERE id = $1`, [f.ainoId]);
});

afterEach(async () => {
  await seed.cleanup();
});

describe.skipIf(!status.ready)("GET /api/public/salons/[slug]/services (§2.3, §3.3; REQ-002)", () => {
  // Behavior: with no auth whatsoever, the services route returns 200 with
  // ONLY active services — exact camelCase DTO keys, seeded values, inactive
  // service hidden (REQ-002 AC: "inactive services never appear in customer
  // flow").
  it("REQ-002/§2.3: 200 with active services only — exact keys, seeded ids/prices, inactive hidden, no auth required", async () => {
    const res = await GET_services(req(f.slug, "services"), ctx(f.slug));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceDto[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((s) => s.name).sort()).toEqual(["Beard Trim", "Cut & Style"]); // Legacy Perm absent
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(["durationMinutes", "id", "name", "priceCents"]);
    }
    const cut = body.find((s) => s.name === "Cut & Style")!;
    expect(cut.id).toBe(f.cutId);
    expect(cut.durationMinutes).toBe(45);
    expect(cut.priceCents).toBe(4_500);
    const beard = body.find((s) => s.name === "Beard Trim")!;
    expect(beard.id).toBe(f.beardId);
    expect(beard.durationMinutes).toBe(20);
    expect(beard.priceCents).toBe(2_500);
  });

  // Behavior: unknown slug → 404 (existence never leaked, §2.3 rule).
  it("REQ-012/§2.3: unknown slug → 404", async () => {
    const ghost = `ghost-${randomUUID()}`;
    const res = await GET_services(req(ghost, "services"), ctx(ghost));
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!status.ready)("GET /api/public/salons/[slug]/employees (§2.3, §3.4; REQ-003)", () => {
  // Behavior: with no auth whatsoever, the employees route returns 200 with
  // ONLY active employees — exact camelCase DTO keys, displayName + nullable
  // title round-trip, inactive employee hidden.
  it("REQ-003/§2.3: 200 with active employees only — exact keys, title round-trip (null when unset), inactive hidden, no auth required", async () => {
    const res = await GET_employees(req(f.slug, "employees"), ctx(f.slug));
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmployeeDto[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((e) => e.displayName).sort()).toEqual(["Aino Korhonen", "Mika Virtanen"]); // Retired Stylist absent
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(["displayName", "id", "title"]);
    }
    const aino = body.find((e) => e.displayName === "Aino Korhonen")!;
    expect(aino.id).toBe(f.ainoId);
    expect(aino.title).toBe("Senior stylist");
    const mika = body.find((e) => e.displayName === "Mika Virtanen")!;
    expect(mika.id).toBe(f.mikaId);
    expect(mika.title).toBe(null);
  });

  // Behavior: unknown slug → 404 (existence never leaked, §2.3 rule).
  it("REQ-012/§2.3: unknown slug → 404", async () => {
    const ghost = `ghost-${randomUUID()}`;
    const res = await GET_employees(req(ghost, "employees"), ctx(ghost));
    expect(res.status).toBe(404);
  });
});
