/**
 * TASK-203 — getAvailableSlots I/O wrapper (DESIGN §6.1; REQ-005).
 *
 * Loads every SlotComputationInput via salon-scoped repos (§4; the only
 * unscoped access is the salon lookup itself, resolved by the route from the
 * unique slug per §2.3), then delegates to the pure engine. No caching (§6.2.5).
 *
 * Error contract: throws SlotNotFoundError (route → 404) for unknown
 * salon/service/employee — existence is never leaked across salon scope — and
 * SlotRangeError (route → 422) for malformed/reversed/over-cap ranges.
 */
import { z } from "zod";
import { db } from "../../db/client";
import { createRepos, findSalonById } from "../../repos";
import { SlotRangeError, computeSlots } from "./engine";
import type {
  IsoWeekday,
  SlotComputationResult,
  SlotQuery,
  UtcInterval,
  WorkingHoursEntry,
} from "./types";

/** Unknown salon/service/employee (or cross-salon id) — route maps to 404. */
export class SlotNotFoundError extends Error {
  constructor(what: string) {
    super(`slot lookup failed: unknown ${what}`);
    this.name = "SlotNotFoundError";
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const rangeShape = z.object({ fromDate: isoDate, toDate: isoDate });

export async function getAvailableSlots(q: SlotQuery): Promise<SlotComputationResult> {
  const salon = await findSalonById(db, q.salonId);
  if (!salon) throw new SlotNotFoundError("salon");

  const dates = rangeShape.safeParse({ fromDate: q.fromDate, toDate: q.toDate });
  if (!dates.success) throw new SlotRangeError("invalid range dates: expected YYYY-MM-DD");

  const repos = createRepos(db, { salonId: q.salonId });

  // §3.3: inactive services never enter slot computation.
  const service = await repos.services.get(q.serviceId);
  if (!service || !service.active) throw new SlotNotFoundError("service");

  let employees = await repos.employees.list({ active: true });
  if (q.employeeId !== undefined) {
    const picked = await repos.employees.get(q.employeeId);
    if (!picked || !picked.active) throw new SlotNotFoundError("employee");
    employees = [picked];
  }

  const settings = await repos.settings.get();
  const [allHours, allTimeOff, confirmed] = await Promise.all([
    repos.workingHours.list(),
    repos.timeOff.list(),
    repos.bookings.list({ status: "confirmed" }),
  ]);

  const workingHoursByEmployee: Record<string, WorkingHoursEntry[]> = {};
  for (const h of allHours) {
    (workingHoursByEmployee[h.employeeId] ??= []).push({
      isoWeekday: h.isoWeekday as IsoWeekday,
      startMinute: h.startMinute,
      endMinute: h.endMinute,
    });
  }
  const timeOffByEmployee: Record<string, UtcInterval[]> = {};
  for (const t of allTimeOff) {
    (timeOffByEmployee[t.employeeId] ??= []).push({
      startUtc: t.startsAt.toISOString(),
      endUtc: t.endsAt.toISOString(),
    });
  }
  const busyByEmployee: Record<string, UtcInterval[]> = {};
  for (const b of confirmed) {
    (busyByEmployee[b.employeeId] ??= []).push({
      startUtc: b.blockedStart.toISOString(),
      endUtc: b.blockedEnd.toISOString(),
    });
  }

  return computeSlots({
    service: {
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
    },
    granularityMinutes: settings?.slotGranularityMinutes ?? 15,
    timezone: salon.timezone,
    range: { fromDate: q.fromDate, toDate: q.toDate },
    employees: employees.map((e) => ({ id: e.id, active: e.active })),
    employeeFilter: q.employeeId,
    workingHoursByEmployee,
    timeOffByEmployee,
    busyByEmployee,
  });
}
