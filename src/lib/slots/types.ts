/**
 * Slot engine types — DESIGN §6.1 (binding).
 * Pure type declarations: no imports, no I/O, no DB.
 */

/** "YYYY-MM-DD" salon-local calendar date. */
export type IsoDate = string;

/** Absolute time interval; ISO 8601 strings, Z-suffixed. */
export interface UtcInterval {
  startUtc: string;
  endUtc: string;
}

/** Public availability query — I/O wrapper (TASK-203) input per §6.1. */
export interface SlotQuery {
  salonId: string;
  serviceId: string;
  employeeId?: string; // omitted = union over active employees
  fromDate: IsoDate; // inclusive
  toDate: IsoDate; // inclusive; max span 31 days (422 beyond)
}

export interface AvailableSlot {
  startUtc: string; // aligned to slot granularity inside a working window
  endUtc: string; // startUtc + service.durationMinutes
  employeeId: string; // always concrete
  localDate: IsoDate; // for UI grouping
}

export interface SlotComputationResult {
  granularityMinutes: number;
  slots: AvailableSlot[]; // sorted by startUtc, then employeeId
}

// --- computeSlots input (exact §6.1 inline shape, named for reuse) ----------

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface WorkingHoursEntry {
  isoWeekday: IsoWeekday;
  startMinute: number; // wall-clock minutes from local midnight
  endMinute: number;
}

export interface ServiceTiming {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export interface SlotComputationInput {
  service: ServiceTiming;
  granularityMinutes: number;
  timezone: string; // IANA, from salons.timezone
  range: { fromDate: IsoDate; toDate: IsoDate };
  employees: Array<{ id: string; active: boolean }>;
  employeeFilter?: string;
  workingHoursByEmployee: Record<string, WorkingHoursEntry[]>;
  timeOffByEmployee: Record<string, UtcInterval[]>;
  busyByEmployee: Record<string, UtcInterval[]>; // confirmed bookings, blocked_* range
}
