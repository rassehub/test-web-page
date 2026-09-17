/**
 * TASK-105 — POST /api/auth/login (DESIGN §2.3, §5.1; REQ-009).
 *
 * zod-validated {email, password} → argon2id verify against staff_users →
 * staff_session cookie (§5.1 Set-Cookie contract). Unknown email and wrong
 * password both return 401 — no account-existence leak.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../db/client";
import { staffUsers } from "../../../../db/schema";
import { verifyPassword } from "../../../../lib/auth/password";
import { createSession, sessionCookie } from "../../../../lib/auth/session";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "VALIDATION" }, { status: 422 });
  }
  const email = parsed.data.email.trim().toLowerCase(); // §3.7: lowercased app-side

  const rows = await db.select().from(staffUsers).where(eq(staffUsers.email, email)).limit(1);
  const user = rows[0];
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
  }

  const token = await createSession(user.id);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token) } });
}
