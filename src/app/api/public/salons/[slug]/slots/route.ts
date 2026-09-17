/**
 * TASK-203 — GET /api/public/salons/[slug]/slots (DESIGN §2.3; REQ-005).
 *
 * Auth: none (public). zod at the HTTP boundary (§9); scope resolved from the
 * unique slug (§2.3 rule). Mapping: 200 SlotComputationResult; 404 unknown
 * slug/service/employee (no cross-salon existence leak); 422 malformed or
 * out-of-contract ranges (reversed / > 31 days / non-calendar dates).
 */
import { z } from "zod";
import { db } from "../../../../../../db/client";
import { findSalonBySlug } from "../../../../../../repos";
import { SlotRangeError } from "../../../../../../lib/slots/engine";
import { SlotNotFoundError, getAvailableSlots } from "../../../../../../lib/slots/service";

const querySchema = z.object({
  serviceId: z.string().uuid(),
  employeeId: z.string().uuid().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate must be YYYY-MM-DD"),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "toDate must be YYYY-MM-DD"),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const sp = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    serviceId: sp.get("serviceId") ?? undefined,
    employeeId: sp.get("employeeId") ?? undefined,
    fromDate: sp.get("fromDate") ?? undefined,
    toDate: sp.get("toDate") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: "VALIDATION", issues: parsed.error.issues }, { status: 422 });
  }

  const salon = await findSalonBySlug(db, slug);
  if (!salon) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

  try {
    const result = await getAvailableSlots({ salonId: salon.id, ...parsed.data });
    return Response.json(result);
  } catch (err) {
    if (err instanceof SlotNotFoundError) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    if (err instanceof SlotRangeError) return Response.json({ error: "VALIDATION" }, { status: 422 });
    throw err;
  }
}
