/**
 * TASK-203 — POST /api/public/salons/[slug]/bookings (DESIGN §2.3; REQ-004/006).
 *
 * Auth: none (public guest booking). zod at the HTTP boundary (§9); scope from
 * the unique slug; salonId is NEVER taken from the body. The route is a thin
 * mapper over createBookingPublic (§7 — no bypass parameter exists on the
 * public path). BookingError → HTTP: VALIDATION/SERVICE_INACTIVE/
 * OUTSIDE_WORKING_HOURS/GAP_FRAGMENT → 422; STALE_SLOT/SLOT_OCCUPIED/
 * ALREADY_CANCELLED → 409; NOT_FOUND → 404.
 */
import { z } from "zod";
import { db } from "../../../../../../db/client";
import { findSalonBySlug } from "../../../../../../repos";
import { createBookingPublic } from "../../../../../../lib/bookings/create";
import type { BookingError } from "../../../../../../lib/bookings/types";

const bodySchema = z.object({
  serviceId: z.string().uuid(),
  employeeId: z.string().uuid().optional(),
  startsAt: z.string().min(1),
  customer: z
    .object({
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().optional(),
    })
    .refine((c) => c.phone !== undefined || c.email !== undefined, {
      message: "customer requires at least one of phone/email",
    }),
  notes: z.string().optional(),
});

const ERROR_STATUS: Record<BookingError["code"], number> = {
  VALIDATION: 422,
  SERVICE_INACTIVE: 422,
  OUTSIDE_WORKING_HOURS: 422,
  GAP_FRAGMENT: 422,
  STALE_SLOT: 409,
  SLOT_OCCUPIED: 409,
  ALREADY_CANCELLED: 409,
  NOT_FOUND: 404,
};

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const salon = await findSalonBySlug(db, slug);
  if (!salon) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "VALIDATION", issues: parsed.error.issues }, { status: 422 });
  }

  const result = await createBookingPublic({ salonId: salon.id, ...parsed.data });
  if ("bookingId" in result) {
    return Response.json({ bookingId: result.bookingId, status: result.status }, { status: 201 });
  }
  return Response.json(result, { status: ERROR_STATUS[result.code] });
}
