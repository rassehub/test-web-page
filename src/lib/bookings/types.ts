/**
 * TASK-203 — Booking domain types (DESIGN §7 + §14.6(e), binding).
 *
 * BookingError is the union BOTH pipelines return (never throw): the route is a
 * thin mapper to 422/409/404. §14.6(e) members (NOT_FOUND/ALREADY_CANCELLED)
 * are cancel-path errors; they exist here so the HTTP mapping table is total.
 */

export type BookingError =
  | { code: "VALIDATION"; field: string } // → 422
  | { code: "SERVICE_INACTIVE" } // → 422
  | { code: "OUTSIDE_WORKING_HOURS" } // → 422 (§14.6(b))
  | { code: "STALE_SLOT" } // → 409 (§14.6(b): schedule-shaped staleness)
  | { code: "GAP_FRAGMENT"; fragmentMinutes: number } // → 422
  | { code: "SLOT_OCCUPIED" } // → 409 (§14.6(a): busy-overlap OR 23P01)
  | { code: "NOT_FOUND" } // → 404 (§14.6(e); also create's unknown salon/service/employee)
  | { code: "ALREADY_CANCELLED" }; // → 409 (§14.6(e): status ≠ 'confirmed')

export interface BookingCustomerInput {
  name: string;
  phone?: string;
  email?: string;
}

/**
 * §7 CreateBookingCmd. NO bypassGapRule — REQ-006/A1's structural guarantee
 * that the customer flow cannot bypass the gap rule is enforced by this type
 * (compile-level @ts-expect-error assert in tests/bookings/create.test.ts).
 */
export interface CreateBookingCmd {
  salonId: string;
  serviceId: string;
  employeeId?: string; // omitted ⇒ server resolves first available (deterministic order)
  startsAt: string; // UTC ISO; must equal an engine-offered slot start unless bypass
  customer: BookingCustomerInput;
  notes?: string;
}

export type CreateBookingSuccess = { bookingId: string; status: "confirmed" };
export type CreateBookingResult = CreateBookingSuccess | BookingError;

export type CancelBookingSuccess = { bookingId: string; status: "cancelled" };
export type CancelBookingResult = CancelBookingSuccess | BookingError;
