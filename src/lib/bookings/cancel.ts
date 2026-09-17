/**
 * TASK-203 — Booking cancellation (DESIGN §7 + §14.6(e); REQ-008 side coverage).
 *
 * Scoped conditional UPDATE (status='confirmed' → 'cancelled' + cancelled_at)
 * inside one transaction; 0 rows ⇒ fallback scoped read: absent (or belonging
 * to another salon — indistinguishable, §2.3 no-leak) ⇒ NOT_FOUND, any other
 * status ⇒ ALREADY_CANCELLED (idempotent-fail: cancelled_at never re-stamped).
 * BOOKING_CANCELLED is sent AFTER commit, only on success, and never throws.
 * The partial exclusion constraint (§3.9) frees the slot at COMMIT — the
 * re-book test in tests/bookings/cancel.test.ts proves the sequencing.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { bookings, customers } from "../../db/schema";
import type { SessionUser } from "../auth/session";
import { getNotificationPort } from "../notifications/port";
import type { BookingError, CancelBookingResult } from "./types";

/** Internal abort — carries the §14.6(e) error out of the transaction. */
class CancelAbort extends Error {
  constructor(readonly error: BookingError) {
    super(`cancel pipeline: ${error.code}`);
  }
}

export async function cancelBooking(
  args: { salonId: string; bookingId: string },
  actor: SessionUser,
): Promise<CancelBookingResult> {
  void actor; // reserved for Sprint 4 route-level RBAC (§2.3); domain scope is args.salonId
  let outcome: { bookingId: string; email: string | null };
  try {
    outcome = await db.transaction(async (tx) => {
      const rows = await tx
        .update(bookings)
        .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(bookings.id, args.bookingId),
            eq(bookings.salonId, args.salonId),
            eq(bookings.status, "confirmed"),
          ),
        )
        .returning({ id: bookings.id, customerId: bookings.customerId });
      const row = rows[0];
      if (row) {
        const cust = await tx
          .select({ email: customers.email })
          .from(customers)
          .where(eq(customers.id, row.customerId))
          .limit(1);
        return { bookingId: row.id, email: cust[0]?.email ?? null };
      }
      const existing = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.id, args.bookingId), eq(bookings.salonId, args.salonId)))
        .limit(1);
      if (!existing[0]) throw new CancelAbort({ code: "NOT_FOUND" });
      throw new CancelAbort({ code: "ALREADY_CANCELLED" }); // any status ≠ 'confirmed'
    });
  } catch (err) {
    if (err instanceof CancelAbort) return err.error;
    throw err;
  }
  await getNotificationPort()
    .send({
      type: "BOOKING_CANCELLED",
      bookingId: outcome.bookingId,
      salonId: args.salonId,
      recipientEmail: outcome.email,
      locale: "fi",
    })
    .catch(() => undefined); // §8: failure isolation — never affects the committed cancel
  return { bookingId: outcome.bookingId, status: "cancelled" };
}
