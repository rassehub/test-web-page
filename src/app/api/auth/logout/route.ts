/**
 * TASK-105 — POST /api/auth/logout (DESIGN §2.3, §5.1; REQ-009).
 *
 * Session-guarded: deletes the staff_sessions row for the presented token
 * and clears the cookie. 401 without a valid session.
 */
import { cookies } from "next/headers";
import {
  clearedSessionCookie,
  destroySession,
  getSessionUser,
  SESSION_COOKIE,
} from "../../../../lib/auth/session";

export async function POST(_request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await destroySession(token);
  }

  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie() } });
}
