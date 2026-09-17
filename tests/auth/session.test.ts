/**
 * TASK-103 — Session lifecycle specs per DESIGN §5.1/§5.3 + §3.7 (REQ-009).
 *
 * Contracts under test (module paths per DESIGN §9):
 *   import { getSessionUser } from "../../src/lib/auth/session"   (§5.3)
 *   POST /api/auth/logout  (../../src/app/api/auth/logout/route) (§5.1)
 *
 * SessionUser shape (§5.3, binding):
 *   { userId: string; role: "owner" | "employee" | "platform_admin";
 *     salonId: string | null; employeeId: string | null }
 *
 * DB contract (§3.7): staff_sessions.token_hash = char(64) sha256 hex of the
 * raw cookie token; expired rows are LAZILY DELETED on read (no cron); logout
 * deletes the row and clears the cookie.
 *
 * EXPECTED STATE: RED at import right now — src/lib/auth/session.ts and the
 * logout route do not exist yet (TASK-105). Intended initial red.
 *
 * Session cookie: next/headers cookies() mocked via hoisted holder (same
 * pattern as rbac.test.ts — getSessionUser is request-context-bound).
 *
 * Isolation: PLAIN mode — getSessionUser uses the app's own DB pool; seeded
 * rows must be committed to be visible to it, so unique-per-run data +
 * Seeder cascade cleanup (rollback impossible here by construction).
 *
 * Activation: docker compose up -d postgres · cp .env.example .env ·
 * npm run db:migrate (TASK-104) · implement auth (TASK-105) · npm test.
 */
import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as logoutRoute } from "../../src/app/api/auth/logout/route";
import { getSessionUser } from "../../src/lib/auth/session";
import { Db, getDbStatus, makePool } from "../helpers/db";
import { Seeder, findSessionByToken, inHours, newRawToken } from "../helpers/seed";

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

afterAll(async () => {
  await pool?.end();
});

afterEach(async () => {
  cookie.token = null;
  await seed.cleanup();
});

describe.skipIf(!status.ready)("getSessionUser — §5.3 (REQ-009)", () => {
  it("REQ-009: valid token resolves the full SessionUser for an owner", async () => {
    const salonId = await seed.salon();
    const userId = await seed.staffUser({ role: "owner", salonId });
    const token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(6) });
    cookie.token = token;

    const user = await getSessionUser();
    expect(user).not.toBeNull();
    expect(user?.userId).toBe(userId);
    expect(user?.role).toBe("owner");
    expect(user?.salonId).toBe(salonId);
    expect(user?.employeeId).toBeNull();
  });

  it("REQ-009: valid token resolves an employee SessionUser with employeeId and salonId set", async () => {
    const salonId = await seed.salon();
    const employeeId = await seed.employee(salonId);
    const userId = await seed.staffUser({ role: "employee", salonId, employeeId });
    const token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(6) });
    cookie.token = token;

    const user = await getSessionUser();
    expect(user?.userId).toBe(userId);
    expect(user?.role).toBe("employee");
    expect(user?.salonId).toBe(salonId);
    expect(user?.employeeId).toBe(employeeId);
  });

  it("REQ-009: platform-admin token resolves role 'platform_admin' with salonId null (§14.3 role → §5.3 SessionUser)", async () => {
    const userId = await seed.staffUser({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(6) });
    cookie.token = token;

    const user = await getSessionUser();
    expect(user?.userId).toBe(userId);
    expect(user?.role).toBe("platform_admin");
    expect(user?.salonId).toBeNull();
    expect(user?.employeeId).toBeNull();
  });

  it("REQ-009/§3.7: expired token resolves null AND the session row is lazily deleted on read", async () => {
    const salonId = await seed.salon();
    const userId = await seed.staffUser({ role: "owner", salonId });
    const token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(-1) });
    cookie.token = token;

    expect(await getSessionUser()).toBeNull();
    // Lazy delete: the read itself must remove the expired row (no cron, §3.7).
    expect(await findSessionByToken(db, token)).toBeNull();
  });

  it("REQ-009: unknown token resolves null without throwing", async () => {
    cookie.token = newRawToken();
    expect(await getSessionUser()).toBeNull();
  });

  it("REQ-009: no cookie at all resolves null without throwing", async () => {
    cookie.token = null;
    expect(await getSessionUser()).toBeNull();
  });
});

describe.skipIf(!status.ready)("POST /api/auth/logout — §5.1 (REQ-009)", () => {
  let userId: string;
  let token: string;

  beforeEach(async () => {
    const salonId = await seed.salon();
    userId = await seed.staffUser({ role: "owner", salonId });
    token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(6) });
    cookie.token = token;
  });

  it("REQ-009: logout deletes the session row (next read with same token is null)", async () => {
    const res = await logoutRoute(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await findSessionByToken(db, token)).toBeNull();
    cookie.token = token; // replay the old cookie
    expect(await getSessionUser()).toBeNull();
  });

  it("REQ-009: logout clears the staff_session cookie (Set-Cookie without the token value)", async () => {
    const res = await logoutRoute(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("staff_session=");
    expect(setCookie).not.toContain(token);
  });

  it("REQ-009: logout without a session → 401 (route is session-guarded per §2.3)", async () => {
    cookie.token = null;
    const res = await logoutRoute(new Request("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(401);
  });
});
