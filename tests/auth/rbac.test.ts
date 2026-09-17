/**
 * TASK-103 — RBAC + login specs per DESIGN §5.3/§5.4 (REQ-009).
 *
 * Contracts under test (module paths per DESIGN §9):
 *   import { requireRole } from "../../src/lib/auth/rbac"
 *   import type { SessionUser } from "../../src/lib/auth/session"
 *   POST /api/auth/login  (../../src/app/api/auth/login/route)
 *
 * requireRole semantics (§5.3): resolves the caller's SessionUser, or throws
 * a Response — 401 when no valid session, 403 on wrong role or cross-salon.
 *
 * EXPECTED STATE: RED at import right now — src/lib/auth/rbac.ts and the
 * login route do not exist yet (TASK-105). Intended initial red.
 *
 * LOGIN STRATEGY (documented decision per TASK-103 brief): INTEGRATION, no
 * argon2 stub — seed a real argon2id hash via @node-rs/argon2 `hash()` and
 * exercise the real verify path end-to-end. [CONF: HIGH] [SRC: DESIGN §5.1]
 *
 * CONTRACT GAP FLAGGED FOR AUDIT (TASK-106): §5.3's opts
 * `{ salonId?; ownEmployeeIdOnly? }` cannot express "which stylist's
 * resource is being accessed" — there is no target parameter. REQ-009's
 * acceptance ("employee accessing other stylist's calendar → 403") requires
 * one. These specs assume the minimal extension
 * `opts.employeeId?: string` = resource owner's employee_id. If the Scrum
 * Lead/Architect resolve this differently, update these two tests only.
 * [CONF: MED] [SRC: INFERENCE from REQ-009 + §5.4]
 *
 * Session cookie: mock next/headers cookies() (§5.1 read path) via a hoisted
 * per-test holder — getSessionUser/requireRole are request-context-bound
 * (no parameters by contract), so this is the only injection point.
 *
 * Isolation: PLAIN mode (auth lib may use its own transactions/pool);
 * unique-per-run seeds + Seeder cascade cleanup.
 * Activation: docker compose up -d postgres · cp .env.example .env ·
 * npm run db:migrate (TASK-104) · implement auth (TASK-105) · npm test.
 */
import "dotenv/config";
import { hash } from "@node-rs/argon2";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as loginRoute } from "../../src/app/api/auth/login/route";
import type { SessionUser } from "../../src/lib/auth/session";
import { requireRole } from "../../src/lib/auth/rbac";
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

const PASSWORD = "correct-horse-battery-staple";

interface StagedUser {
  userId: string;
  token: string;
  employeeId: string | null;
  salonId: string | null;
}

/** Seed staff_user + staff_session, set the cookie, return identities. */
async function stageSession(opts: {
  role: "owner" | "employee" | "platform_admin";
  salonId: string | null;
  employeeId?: string;
  isPlatformAdmin?: boolean;
}): Promise<StagedUser> {
  const userId = await seed.staffUser({
    role: opts.role,
    salonId: opts.salonId,
    employeeId: opts.employeeId ?? null,
    isPlatformAdmin: opts.isPlatformAdmin ?? false,
  });
  const token = newRawToken();
  await seed.session({ userId, token, expiresAt: inHours(6) });
  cookie.token = token;
  return { userId, token, employeeId: opts.employeeId ?? null, salonId: opts.salonId };
}

/** Assert requireRole rejects with a thrown Response of the given status. */
async function expectReject(promise: Promise<SessionUser>, expectedStatus: number): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(expectedStatus);
}

function loginRequest(body: { email: string; password: string }): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  await pool?.end();
});

afterEach(async () => {
  cookie.token = null;
  await seed.cleanup();
});

describe.skipIf(!status.ready)("requireRole — §5.4 RBAC matrix (REQ-009)", () => {
  it("REQ-009/§5.2: no session at all → requireRole('owner') throws 401", async () => {
    await expectReject(requireRole("owner"), 401);
  });

  it("REQ-009: unknown token (no staff_sessions row) → throws 401", async () => {
    cookie.token = newRawToken();
    await expectReject(requireRole("owner"), 401);
  });

  it("REQ-009/§5.1: expired session (expires_at in the past) → throws 401 (expired ⇒ null ⇒ 401)", async () => {
    const salonId = await seed.salon();
    const userId = await seed.staffUser({ role: "owner", salonId });
    const token = newRawToken();
    await seed.session({ userId, token, expiresAt: inHours(-1) });
    cookie.token = token;
    await expectReject(requireRole("owner"), 401);
  });

  it("REQ-009/§5.4: employee session calling requireRole('owner') throws 403 (settings/employees are owner-only)", async () => {
    const salonId = await seed.salon();
    const employeeId = await seed.employee(salonId);
    await stageSession({ role: "employee", salonId, employeeId });
    await expectReject(requireRole("owner"), 403);
  });

  it("REQ-009: positive control — owner of salon A resolves requireRole('owner', { salonId: A })", async () => {
    const salonId = await seed.salon();
    const staged = await stageSession({ role: "owner", salonId });
    const user = await requireRole("owner", { salonId });
    expect(user.userId).toBe(staged.userId);
    expect(user.role).toBe("owner");
    expect(user.salonId).toBe(salonId);
    expect(user.employeeId).toBeNull();
  });

  it("REQ-009/§5.4: owner of salon A calling requireRole('owner', { salonId: B }) throws 403 (cross-salon)", async () => {
    const salonA = await seed.salon();
    const salonB = await seed.salon();
    await stageSession({ role: "owner", salonId: salonA });
    await expectReject(requireRole("owner", { salonId: salonB }), 403);
  });

  it("REQ-009/§5.4: platform_admin calling requireRole('owner') throws 403 (platform admin is NOT a salon owner)", async () => {
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    await expectReject(requireRole("owner"), 403);
  });

  it("REQ-012: positive control — platform_admin resolves requireRole('platform_admin') with salonId null", async () => {
    const staged = await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    const user = await requireRole("platform_admin");
    expect(user.userId).toBe(staged.userId);
    expect(user.role).toBe("platform_admin");
    expect(user.salonId).toBeNull();
    expect(user.employeeId).toBeNull();
  });

  it("REQ-009/§5.4: employee with ownEmployeeIdOnly accessing ANOTHER stylist's resource throws 403 (assumes opts.employeeId — see header)", async () => {
    const salonId = await seed.salon();
    const ownEmployeeId = await seed.employee(salonId);
    const otherEmployeeId = await seed.employee(salonId);
    await stageSession({ role: "employee", salonId, employeeId: ownEmployeeId });
    await expectReject(
      requireRole("employee", { salonId, ownEmployeeIdOnly: true, employeeId: otherEmployeeId }),
      403,
    );
  });

  it("REQ-009/§5.4: employee with ownEmployeeIdOnly accessing their OWN resource resolves", async () => {
    const salonId = await seed.salon();
    const ownEmployeeId = await seed.employee(salonId);
    const staged = await stageSession({ role: "employee", salonId, employeeId: ownEmployeeId });
    const user = await requireRole("employee", {
      salonId,
      ownEmployeeIdOnly: true,
      employeeId: ownEmployeeId,
    });
    expect(user.userId).toBe(staged.userId);
    expect(user.employeeId).toBe(ownEmployeeId);
  });

  it("REQ-009/§5.4: employee calling requireRole('employee', { salonId: otherSalon }) throws 403 (cross-salon)", async () => {
    const salonA = await seed.salon();
    const salonB = await seed.salon();
    const employeeId = await seed.employee(salonA);
    await stageSession({ role: "employee", salonId: salonA, employeeId });
    await expectReject(requireRole("employee", { salonId: salonB }), 403);
  });
});

describe.skipIf(!status.ready)("POST /api/auth/login — §5.1 (REQ-009)", () => {
  let salonId: string;
  let email: string;

  beforeEach(async () => {
    salonId = await seed.salon();
    email = `owner-${crypto.randomUUID()}@test.example`;
    await seed.staffUser({
      role: "owner",
      salonId,
      email,
      passwordHash: await hash(PASSWORD),
    });
  });

  it("REQ-009: wrong password for an existing account → 401", async () => {
    const res = await loginRoute(loginRequest({ email, password: "wrong-password" }));
    expect(res.status).toBe(401);
  });

  it("REQ-009: unknown email → 401 (do not reveal account existence)", async () => {
    const res = await loginRoute(
      loginRequest({ email: "ghost@example.com", password: "whatever" }),
    );
    expect(res.status).toBe(401);
  });

  it("REQ-009: correct credentials → 200 + HttpOnly staff_session cookie (§5.1 Set-Cookie contract)", async () => {
    const res = await loginRoute(loginRequest({ email, password: PASSWORD }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("staff_session=");
    expect(setCookie).toContain("HttpOnly");
  });
});

/**
 * TASK-108 — §14.1 employee-gate owner branch (audit finding F5; REQ-009).
 *
 * The rbac.ts:39 branch (opts.employeeId present → owner-of-salon OR
 * employee-matching) was implemented in TASK-105 but never exercised:
 *   - owner + employeeId + MATCHING salonId → resolves (§5.4 "own calendar"
 *     is RW for owners too; the `role` argument is superseded by the gate)
 *   - owner + employeeId WITHOUT salonId → 403 (trap for future callers:
 *     owner-of-salon requires the explicit salonId match)
 *   - platform_admin never passes the gate
 *   - employee gate activates on opts.employeeId alone (ownEmployeeIdOnly
 *     is signature-compat only since §14.1)
 */
describe.skipIf(!status.ready)("requireRole — §14.1 employee-gate owner branch (F5; REQ-009)", () => {
  it("REQ-009/§14.1 (F5): owner of salon A calling requireRole('employee', { employeeId: X, salonId: A }) resolves as the owner", async () => {
    const salonId = await seed.salon();
    const employeeX = await seed.employee(salonId);
    const staged = await stageSession({ role: "owner", salonId });
    const user = await requireRole("employee", { employeeId: employeeX, salonId });
    expect(user.userId).toBe(staged.userId);
    expect(user.role).toBe("owner"); // gate resolves the OWNER, not a role-substituted employee
    expect(user.salonId).toBe(salonId);
  });

  it("REQ-009/§14.1 (F5): owner calling requireRole('employee', { employeeId: X }) WITHOUT opts.salonId throws 403 (explicit-salon trap)", async () => {
    const salonId = await seed.salon();
    const employeeX = await seed.employee(salonId);
    await stageSession({ role: "owner", salonId });
    await expectReject(requireRole("employee", { employeeId: employeeX }), 403);
  });

  it("REQ-009/§14.1 (F5): platform_admin never passes the employee gate — throws 403 even with employeeId + salonId", async () => {
    const salonId = await seed.salon();
    const employeeX = await seed.employee(salonId);
    await stageSession({ role: "platform_admin", salonId: null, isPlatformAdmin: true });
    await expectReject(requireRole("employee", { employeeId: employeeX, salonId }), 403);
  });

  it("REQ-009/§14.1 (F5): employee E1 with opts.employeeId: E2 (other stylist) throws 403 — gate fires on employeeId alone, no ownEmployeeIdOnly flag", async () => {
    const salonId = await seed.salon();
    const e1 = await seed.employee(salonId);
    const e2 = await seed.employee(salonId);
    await stageSession({ role: "employee", salonId, employeeId: e1 });
    await expectReject(requireRole("employee", { employeeId: e2, salonId }), 403);
  });
});
