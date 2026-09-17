/**
 * TASK-105 — /api/admin/salons/[id] (DESIGN §2.3; REQ-012).
 *
 * platform_admin only via requireRole. 404 for unknown ids (never leak
 * existence). DELETE cascades salon_settings/services/employees/working_hours/
 * time_off/bookings (§3 FKs); staff_users.salon_id has no cascade, so a salon
 * that still has staff accounts yields 23503 → 409. Slug changes re-validate
 * [a-z0-9-]+ and uniqueness (23505 → 422).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../../../db/client";
import { salons } from "../../../../../db/schema";
import { requireRole } from "../../../../../lib/auth/rbac";

const slugSchema = z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must match [a-z0-9-]+");

const updateSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().min(1).optional(),
  timezone: z.string().refine(isValidTimezone, "unknown IANA timezone").optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

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

function isUuid(id: string): boolean {
  return z.string().uuid().safeParse(id).success;
}

function notFound(): Response {
  return Response.json({ error: "NOT_FOUND" }, { status: 404 });
}

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    await requireRole("platform_admin");
    const { id } = await ctx.params;
    if (!isUuid(id)) return notFound();
    const rows = await db.select().from(salons).where(eq(salons.id, id)).limit(1);
    const row = rows[0];
    if (!row) return notFound();
    return Response.json(toJson(row));
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    await requireRole("platform_admin");
    const { id } = await ctx.params;
    if (!isUuid(id)) return notFound();
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "VALIDATION", issues: parsed.error.issues }, { status: 422 });
    }
    const updated = await db
      .update(salons)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(salons.id, id))
      .returning();
    const row = updated[0];
    if (!row) return notFound();
    return Response.json(toJson(row));
  } catch (err) {
    if (err instanceof Response) return err;
    if (pgErrorCode(err) === "23505") {
      return Response.json({ error: "DUPLICATE_SLUG" }, { status: 422 });
    }
    throw err;
  }
}

export async function DELETE(_request: Request, ctx: RouteContext): Promise<Response> {
  try {
    await requireRole("platform_admin");
    const { id } = await ctx.params;
    if (!isUuid(id)) return notFound();
    try {
      const deleted = await db.delete(salons).where(eq(salons.id, id)).returning({ id: salons.id });
      if (!deleted[0]) return notFound();
      return new Response(null, { status: 204 });
    } catch (err) {
      if (pgErrorCode(err) === "23503") {
        return Response.json({ error: "SALON_HAS_STAFF" }, { status: 409 });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}
