/**
 * TASK-108 — Salon-CRUD route specs (audit finding F4; REQ-012).
 *
 * Spec-after-implementation remediation: the TASK-105 route handlers
 * (src/app/api/admin/salons/route.ts + [id]/route.ts) exist and were only
 * statically verified (AUDIT-SPRINT1 V-CODE). These specs pin the full
 * behavior matrix so the claims become runtime evidence:
 *
 *   - platform_admin gate: owner/employee ⇒ 403, no session ⇒ 401
 *     (auth fires BEFORE the uuid gate — asserted via 403-not-404 on a
 *     random uuid path)
 *   - POST tx creates salon + salon_settings defaults 45/15 (§3.2) — no
 *     route exposes settings, so defaults are verified via direct DB read
 *   - slug contract [a-z0-9-]+ (uppercase/underscore/empty ⇒ 422), on both
 *     POST and PATCH slug changes
 *   - duplicate slug ⇒ 23505 → 422 (POST and PATCH)
 *   - unknown uuid ⇒ 404; non-uuid id ⇒ 404 (uuid gate, never reaches DB)
 *   - DELETE: 204 + cascade wipes settings/services/employees/bookings;
 *     staff_users.salon_id has NO cascade ⇒ 23503 → 409
 *
 * CONTRACTS UNDER TEST (module paths per DESIGN §9 — direct handler
 * invocation, same strategy as rbac.test.ts login specs):
 *   import { GET, POST } from "../../src/app/api/admin/salons/route"
 *   import { GET, PATCH, DELETE } from "../../src/app/api/admin/salons/[id]/route"
 * RouteContext is structural: { params: Promise<{ id: string }> }.
 *
 * Session injection: mock next/headers cookies() (§5.1 read path) via a
 * hoisted per-test holder — requireRole is request-context-bound.
 *
 * Isolation: PLAIN mode (POST handler manages its own db.transaction(),
 * which would break an outer test tx). Unique-per-run slugs/seeds +
 * Seeder cascade cleanup; salons created through the ROUTE (not Seeder)
 * are tracked locally and deleted in afterEach after seed.cleanup()
 * (staff_users first — FK has no cascade).
 *
 * Activation: docker compose up -d postgres · cp .env.example .env ·
 * npm run db:migrate · npm test.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GET as listSalons, POST as createSalon } from "../../src/app/api/admin/salons/route";
import {
  DELETE as deleteSalon,
  GET as getSalon,
  PATCH as patchSalon,
} from "../../src/app/api/admin/salons/[id]/route";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder, inHours, newRawToken } from "../helpers/seed";

// --- next/headers mock: control the staff_session cookie per test ---------
const cookie = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "staff_session" && cookie.token !== null ? { name, value: cookie.token } : undefined,
  })),
}));

const status = await getDbStatus();
const pool = status.ready ? makePool() : null;
const db = new Db(pool);
const seed = new Seeder(db);

/** Salons created via the ROUTE (untracked by Seeder) — manual cleanup. */
const createdSalonIds: string[] = [];

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Next.js 15 route context (params is a Promise). */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** Seed staff_user + staff_session, set the cookie. */
async function stageSession(opts: {
  role: "owner" | "employee" | "platform_admin";
  salonId: string | null;
  employeeId?: string;
  isPlatformAdmin?: boolean;
}): Promise<void> {
  const userId = await seed.staffUser({
    role: opts.role,
    salonId: opts.salonId,
    employeeId: opts.employeeId ?? null,
    isPlatformAdmin: opts.isPlatformAdmin ?? false,
  });
  const token = newRawToken();
  await seed.session({ userId, token, expiresAt: inHours(6) });
  cookie.token = token;
}

/** POST-create a salon as platform_admin; tracks it for afterEach cleanup. */
async function createSalonViaRoute(slug: string): Promise<string> {
  const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug, name: "Route Salon" }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  createdSalonIds.push(body.id);
  return body.id;
}

afterAll(async () => {
  await pool?.end();
});

afterEach(async () => {
  cookie.token = null;
  await seed.cleanup(); // staff_users BEFORE salons (no cascade on salon_id FK)
  if (createdSalonIds.length > 0) {
    await db.exec(`DELETE FROM salons WHERE id = ANY($1::uuid[])`, [createdSalonIds]);
    createdSalonIds.length = 0;
  }
});

describe.skipIf(!status.ready)("/api/admin/salons — RBAC gate (F4; REQ-012)", () => {
  it("REQ-012/F4: no session → 401 on every salon handler (POST, GET list, GET/PATCH/DELETE by id)", async () => {
    cookie.token = null;
    const randomId = randomUUID();
    expect((await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: uniqueSlug("x"), name: "X" }))).status).toBe(401);
    expect((await listSalons()).status).toBe(401);
    expect((await getSalon(jsonRequest("GET", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(401);
    expect((await patchSalon(jsonRequest("PATCH", `/api/admin/salons/${randomId}`, { name: "X" }), ctx(randomId))).status).toBe(401);
    expect((await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(401);
  });

  it("REQ-012/F4: owner session → 403 on every salon handler (403, not 404 — auth fires before the uuid gate)", async () => {
    const salonId = await seed.salon();
    await stageSession({ role: "owner", salonId });
    const randomId = randomUUID();
    expect((await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: uniqueSlug("x"), name: "X" }))).status).toBe(403);
    expect((await listSalons()).status).toBe(403);
    expect((await getSalon(jsonRequest("GET", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(403);
    expect((await patchSalon(jsonRequest("PATCH", `/api/admin/salons/${randomId}`, { name: "X" }), ctx(randomId))).status).toBe(403);
    expect((await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(403);
  });

  it("REQ-012/F4: employee session → 403 on every salon handler", async () => {
    const salonId = await seed.salon();
    const employeeId = await seed.employee(salonId);
    await stageSession({ role: "employee", salonId, employeeId });
    const randomId = randomUUID();
    expect((await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: uniqueSlug("x"), name: "X" }))).status).toBe(403);
    expect((await listSalons()).status).toBe(403);
    expect((await getSalon(jsonRequest("GET", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(403);
    expect((await patchSalon(jsonRequest("PATCH", `/api/admin/salons/${randomId}`, { name: "X" }), ctx(randomId))).status).toBe(403);
    expect((await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${randomId}`), ctx(randomId))).status).toBe(403);
  });
});

describe.skipIf(!status.ready)("POST /api/admin/salons — platform_admin create (F4; REQ-012)", () => {
  it("REQ-012/F4: create returns 201 + id/slug and the same transaction writes salon_settings with DDL defaults 45/15 (§3.2)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const slug = uniqueSlug("create");
    const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug, name: "Created Salon" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.slug).toBe(slug);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    createdSalonIds.push(body.id);

    // No route exposes settings — defaults verified via direct DB read.
    const settings = await db.one<{ gap_threshold_minutes: number; slot_granularity_minutes: number }>(
      `SELECT gap_threshold_minutes, slot_granularity_minutes FROM salon_settings WHERE salon_id = $1`,
      [body.id],
    );
    expect(settings).not.toBeNull();
    expect(settings?.gap_threshold_minutes).toBe(45);
    expect(settings?.slot_granularity_minutes).toBe(15);
  });

  it("REQ-012/F4: uppercase slug → 422 (contract: [a-z0-9-]+)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: "Invalid-Slug", name: "X" }));
    expect(res.status).toBe(422);
  });

  it("REQ-012/F4: underscore slug → 422", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: "invalid_slug", name: "X" }));
    expect(res.status).toBe(422);
  });

  it("REQ-012/F4: empty slug → 422 (min length 1)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug: "", name: "X" }));
    expect(res.status).toBe(422);
  });

  it("REQ-012/F4: duplicate slug → 23505 mapped to 422 DUPLICATE_SLUG", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const slug = uniqueSlug("dupe");
    await seed.salon({ slug }); // Seeder-tracked → cascade cleanup
    const res = await createSalon(jsonRequest("POST", "/api/admin/salons", { slug, name: "Impostor" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("DUPLICATE_SLUG");
  });
});

describe.skipIf(!status.ready)("GET /api/admin/salons[/id] — platform_admin reads (F4; REQ-012)", () => {
  it("REQ-012/F4: list returns 200 and contains the created salon's slug", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const slug = uniqueSlug("list");
    await createSalonViaRoute(slug);
    const res = await listSalons();
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ slug: string }>;
    expect(list.map((s) => s.slug)).toContain(slug);
  });

  it("REQ-012/F4: get by id returns 200 + the salon row", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const slug = uniqueSlug("get");
    const id = await createSalonViaRoute(slug);
    const res = await getSalon(jsonRequest("GET", `/api/admin/salons/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(id);
    expect(body.slug).toBe(slug);
  });

  it("REQ-012/F4: unknown-but-valid uuid → 404 on GET, PATCH and DELETE (never leak existence)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const ghost = randomUUID();
    expect((await getSalon(jsonRequest("GET", `/api/admin/salons/${ghost}`), ctx(ghost))).status).toBe(404);
    expect((await patchSalon(jsonRequest("PATCH", `/api/admin/salons/${ghost}`, { name: "X" }), ctx(ghost))).status).toBe(404);
    expect((await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${ghost}`), ctx(ghost))).status).toBe(404);
  });

  it("REQ-012/F4: non-uuid id → 404 (uuid gate short-circuits before any DB read)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const res = await getSalon(jsonRequest("GET", "/api/admin/salons/not-a-uuid"), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!status.ready)("PATCH /api/admin/salons/[id] — platform_admin update (F4; REQ-012)", () => {
  it("REQ-012/F4: PATCH name + address returns 200 with updated fields", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const id = await createSalonViaRoute(uniqueSlug("patch"));
    const res = await patchSalon(
      jsonRequest("PATCH", `/api/admin/salons/${id}`, { name: "Renamed Salon", address: "New Address 1" }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; address: string | null };
    expect(body.name).toBe("Renamed Salon");
    expect(body.address).toBe("New Address 1");
  });

  it("REQ-012/F4: PATCH slug to another salon's existing slug → 23505 mapped to 422", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const takenSlug = uniqueSlug("taken");
    await seed.salon({ slug: takenSlug }); // Seeder-tracked
    const id = await createSalonViaRoute(uniqueSlug("clash"));
    const res = await patchSalon(
      jsonRequest("PATCH", `/api/admin/salons/${id}`, { slug: takenSlug }),
      ctx(id),
    );
    expect(res.status).toBe(422);
  });

  it("REQ-012/F4: PATCH slug re-validates [a-z0-9-]+ — uppercase → 422", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const id = await createSalonViaRoute(uniqueSlug("revalidate"));
    const res = await patchSalon(
      jsonRequest("PATCH", `/api/admin/salons/${id}`, { slug: "Still-Invalid" }),
      ctx(id),
    );
    expect(res.status).toBe(422);
  });
});

describe.skipIf(!status.ready)("DELETE /api/admin/salons/[id] — cascade + staff guard (F4; REQ-012)", () => {
  it("REQ-012/F4: DELETE returns 204 and cascades salon_settings/services/employees/bookings (§3 FKs)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const id = await createSalonViaRoute(uniqueSlug("cascade"));

    // Full child graph under the route-created salon.
    const serviceId = await seed.service(id, { name: "Cascade Cut" });
    const employeeId = await seed.employee(id);
    const customerId = await seed.customer();
    await seed.booking({
      salonId: id, serviceId, employeeId, customerId,
      startsAt: inHours(24), endsAt: inHours(25),
    });

    const res = await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${id}`), ctx(id));
    expect(res.status).toBe(204);

    const counts = await db.one<{
      salons: string; settings: string; services: string; employees: string; bookings: string;
    }>(
      `SELECT (SELECT count(*) FROM salons WHERE id = $1) AS salons,
              (SELECT count(*) FROM salon_settings WHERE salon_id = $1) AS settings,
              (SELECT count(*) FROM services WHERE salon_id = $1) AS services,
              (SELECT count(*) FROM employees WHERE salon_id = $1) AS employees,
              (SELECT count(*) FROM bookings WHERE salon_id = $1) AS bookings`,
      [id],
    );
    expect(counts?.salons).toBe("0");
    expect(counts?.settings).toBe("0");
    expect(counts?.services).toBe("0");
    expect(counts?.employees).toBe("0");
    expect(counts?.bookings).toBe("0");
  });

  it("REQ-012/F4: DELETE on a salon that still has staff_users → 23503 mapped to 409 (salon_id FK has no cascade)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const id = await createSalonViaRoute(uniqueSlug("staffed"));
    // Owner account attached to the salon (§14.3-valid form) blocks the delete.
    await seed.staffUser({ role: "owner", salonId: id });

    const res = await deleteSalon(jsonRequest("DELETE", `/api/admin/salons/${id}`), ctx(id));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("SALON_HAS_STAFF");

    // afterEach: seed.cleanup() removes the staff_user, then the tracked salon.
  });
});
