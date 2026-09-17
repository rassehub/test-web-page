/**
 * TASK-105 — DB-backed staff sessions (DESIGN §3.7, §5.1, §5.3; REQ-009).
 *
 * The cookie carries the raw token; staff_sessions stores sha256(token) hex.
 * Expired rows are LAZILY deleted on read — no cron (§3.7).
 *
 * getSessionUser is request-context-bound (reads next/headers cookies()) and
 * takes no parameters by contract; tests inject the cookie by mocking
 * next/headers.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "../../db/client";
import { staffSessions, staffUsers } from "../../db/schema";

export const SESSION_COOKIE = "staff_session";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionUser {
  userId: string;
  role: "owner" | "employee" | "platform_admin";
  salonId: string | null; // null iff platform_admin
  employeeId: string | null; // set for role === "employee"
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** INSERT staff_sessions (sha256 hex token_hash, 7d expiry); returns the raw cookie token (never stored). */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(staffSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

/** cookie token → sha256 → sessions×users join; expired/revoked ⇒ null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      userId: staffUsers.id,
      role: staffUsers.role,
      salonId: staffUsers.salonId,
      employeeId: staffUsers.employeeId,
      expiresAt: staffSessions.expiresAt,
    })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffSessions.userId, staffUsers.id))
    .where(eq(staffSessions.tokenHash, hashToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    // Lazy cleanup (§3.7): the read itself removes expired rows — no cron.
    await db.delete(staffSessions).where(lt(staffSessions.expiresAt, new Date()));
    return null;
  }
  return { userId: row.userId, role: row.role, salonId: row.salonId, employeeId: row.employeeId };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(staffSessions).where(eq(staffSessions.tokenHash, hashToken(token)));
}

/** §5.1 Set-Cookie contract: HttpOnly, SameSite=Lax, Secure(prod), Path=/, 7d. */
export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
