/**
 * TASK-105 — requireRole per DESIGN §5.3 + §14.1 (binding amendment; REQ-009).
 *
 * Throws a Response — 401 (no valid session), 403 (wrong role / cross-salon /
 * employee-gate miss) — so route handlers can `if (err instanceof Response)
 * return err`.
 *
 * §14.1 employee gating: when opts.employeeId (the target stylist resource)
 * is present, the gate is owner-of-salon OR employee whose employeeId
 * matches; platform_admin never passes. This gate supersedes the simple role
 * match — an owner legitimately reaches employee-gated resources inside
 * their own salon (§5.4 "own calendar" is RW for owners too).
 *
 * ownEmployeeIdOnly (§5.3) is accepted for signature compatibility; since
 * §14.1, presence of opts.employeeId is what activates the gate.
 */
import { getSessionUser, type SessionUser } from "./session";

export interface RequireRoleOptions {
  /** Resource salon — cross-checked against the session's salon. */
  salonId?: string;
  /** §5.3 flag; superseded by §14.1's explicit employeeId target. */
  ownEmployeeIdOnly?: boolean;
  /** §14.1: employee_id of the stylist whose resource is being accessed. */
  employeeId?: string;
}

function deny(status: number): Response {
  return new Response(null, { status });
}

export async function requireRole(
  role: "owner" | "employee" | "platform_admin",
  opts: RequireRoleOptions = {},
): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw deny(401);

  if (opts.employeeId !== undefined) {
    const ownerOfResourceSalon =
      user.role === "owner" && opts.salonId !== undefined && user.salonId === opts.salonId;
    const ownEmployeeResource = user.role === "employee" && user.employeeId === opts.employeeId;
    if (!ownerOfResourceSalon && !ownEmployeeResource) throw deny(403);
    return user;
  }

  if (user.role !== role) throw deny(403);
  if (opts.salonId !== undefined && user.salonId !== opts.salonId) throw deny(403);
  return user;
}
