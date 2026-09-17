/**
 * TASK-105 — /api/admin/salons (DESIGN §2.3; REQ-012).
 *
 * platform_admin only via requireRole (§5.4: owner/employee ⇒ 403). Salon
 * CRUD is deliberately NOT routed through createRepos — a repo instance IS a
 * salon scope (§4); platform-level tables are addressed directly here.
 *
 * POST creates the salon AND its salon_settings row with defaults (45/15,
 * §3.2) in one transaction. Slug must match [a-z0-9-]+ and be unique —
 * format violations and unique violations both map to 422.
 */
import { z } from "zod";
import { db } from "../../../../db/client";
import { salons, salonSettings } from "../../../../db/schema";
import { requireRole } from "../../../../lib/auth/rbac";

const slugSchema = z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must match [a-z0-9-]+");

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1),
  timezone: z.string().refine(isValidTimezone, "unknown IANA timezone").optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type SalonRow = typeof salons.$inferSelect;

function toJson(r: SalonRow) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    timezone: r.timezone,
    address: r.address,
    phone: r.phone,
    email: r.email,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Walks error + cause chain for a PostgreSQL SQLSTATE code. */
function pgErrorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e; depth++) {
    if (typeof e === "object" && "code" in e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export async function GET(): Promise<Response> {
  try {
    await requireRole("platform_admin");
    const rows = await db.select().from(salons).orderBy(salons.createdAt);
    return Response.json(rows.map(toJson));
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireRole("platform_admin");
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "VALIDATION", issues: parsed.error.issues }, { status: 422 });
    }
    const salon = await db.transaction(async (tx) => {
      const inserted = await tx.insert(salons).values(parsed.data).returning();
      const row = inserted[0];
      if (!row) throw new Error("salons insert returned no row");
      await tx.insert(salonSettings).values({ salonId: row.id }); // §3.2 defaults 45/15
      return row;
    });
    return Response.json(toJson(salon), { status: 201 });
  } catch (err) {
    if (err instanceof Response) return err;
    if (pgErrorCode(err) === "23505") {
      return Response.json({ error: "DUPLICATE_SLUG" }, { status: 422 });
    }
    throw err;
  }
}
