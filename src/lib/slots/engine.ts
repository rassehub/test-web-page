/**
 * Slot engine — DESIGN §6.2 computation semantics (binding). PURE: no I/O.
 *
 * 1. Per local date × active employee, working windows materialize from
 *    wall-clock minutes → UTC via Luxon in the salon timezone. Non-existent
 *    wall times on spring-forward days are skipped, never phantom-mapped
 *    (§14.6(c)); fall-back windows expand naturally.
 * 2. time_off (absolute UTC) subtraction.
 * 3. busy (blocked_* of confirmed bookings) subtraction.
 * 4. Candidates step by granularityMinutes from each open window's own
 *    boundary; valid iff [start − bufferBefore, start + duration +
 *    bufferAfter] fits entirely inside one open window; endUtc un-buffered.
 * 5. Output sorted by startUtc, then employeeId.
 */
import { DateTime } from "luxon";
import type {
  AvailableSlot,
  IsoDate,
  SlotComputationInput,
  SlotComputationResult,
  UtcInterval,
  WorkingHoursEntry,
} from "./types";

const MINUTE_MS = 60_000;
const MAX_RANGE_DAYS = 31; // exactly 31 inclusive days allowed (§14.6(d))

/** Range violation (reversed / over cap / unparsable) — wrapper maps to 422. */
export class SlotRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotRangeError";
  }
}

interface MsInterval {
  start: number;
  end: number;
}

const toMs = (i: UtcInterval): MsInterval => ({
  start: Date.parse(i.startUtc),
  end: Date.parse(i.endUtc),
});

const toIsoZ = (ms: number): string =>
  DateTime.fromMillis(ms, { zone: "utc" }).toISO({ suppressMilliseconds: true })!;

/**
 * Materialize a wall-clock minute-of-day on a local date to a UTC epoch ms.
 * Returns null for non-existent wall times: across a spring-forward gap Luxon
 * forward-maps skipped times, so their components come back shifted.
 * minuteOfDay ≥ 1440 rolls into the next local day (e.g. 24:00 end-of-day).
 */
function wallToUtc(zone: string, date: IsoDate, minuteOfDay: number): number | null {
  const [year, month, day] = date.split("-").map(Number);
  const dt = DateTime.fromObject(
    { year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
    { zone },
  );
  if (!dt.isValid) return null;
  if (dt.hour * 60 + dt.minute !== minuteOfDay % 1440) return null;
  return dt.toMillis();
}

/** Subtract blocked ranges from a window → disjoint open pieces (§6.2.2–6.2.3). */
function subtractIntervals(window: MsInterval, blocked: readonly MsInterval[]): MsInterval[] {
  let pieces: MsInterval[] = [window];
  for (const b of blocked) {
    const next: MsInterval[] = [];
    for (const p of pieces) {
      if (b.end <= p.start || b.start >= p.end) {
        next.push(p); // disjoint — touching endpoints do not block
      } else {
        if (b.start > p.start) next.push({ start: p.start, end: b.start });
        if (b.end < p.end) next.push({ start: b.end, end: p.end });
      }
    }
    pieces = next;
  }
  return pieces;
}

export function computeSlots(input: SlotComputationInput): SlotComputationResult {
  const from = DateTime.fromISO(input.range.fromDate, { zone: input.timezone });
  const to = DateTime.fromISO(input.range.toDate, { zone: input.timezone });
  if (!from.isValid || !to.isValid) {
    throw new SlotRangeError(`invalid range dates: ${input.range.fromDate}..${input.range.toDate}`);
  }
  if (to < from) {
    throw new SlotRangeError(`reversed range: fromDate > toDate`);
  }
  const spanDays = Math.round(to.startOf("day").diff(from.startOf("day"), "days").days) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new SlotRangeError(`range spans ${spanDays} days; max ${MAX_RANGE_DAYS}`);
  }

  const durationMs = input.service.durationMinutes * MINUTE_MS;
  const beforeMs = input.service.bufferBeforeMinutes * MINUTE_MS;
  const afterMs = input.service.bufferAfterMinutes * MINUTE_MS;
  const stepMs = input.granularityMinutes * MINUTE_MS;

  const selected = input.employees.filter(
    (e) => e.active && (input.employeeFilter === undefined || e.id === input.employeeFilter),
  );

  const slots: AvailableSlot[] = [];

  for (const employee of selected) {
    const hours = input.workingHoursByEmployee[employee.id] ?? [];
    const blocked = [
      ...(input.timeOffByEmployee[employee.id] ?? []),
      ...(input.busyByEmployee[employee.id] ?? []),
    ].map(toMs);

    for (let cursor = from; cursor <= to; cursor = cursor.plus({ days: 1 })) {
      const localDate = cursor.toISODate()!;
      for (const h of hours.filter((entry) => entry.isoWeekday === cursor.weekday)) {
        const windowStart = wallToUtc(input.timezone, localDate, h.startMinute);
        const windowEnd = wallToUtc(input.timezone, localDate, h.endMinute);
        if (windowStart === null || windowEnd === null || windowEnd <= windowStart) continue;

        for (const open of subtractIntervals({ start: windowStart, end: windowEnd }, blocked)) {
          for (let start = open.start; start + durationMs + afterMs <= open.end; start += stepMs) {
            if (start - beforeMs < open.start) continue; // buffered interval must fit fully
            slots.push({
              startUtc: toIsoZ(start),
              endUtc: toIsoZ(start + durationMs),
              employeeId: employee.id,
              localDate,
            });
          }
        }
      }
    }
  }

  slots.sort(
    (a, b) =>
      Date.parse(a.startUtc) - Date.parse(b.startUtc) ||
      (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0),
  );

  return { granularityMinutes: input.granularityMinutes, slots };
}

/**
 * Materialize one local date's working windows (UTC epoch-ms intervals) —
 * TASK-203's booking-pipeline validation input. Pure reuse of the engine's own
 * wall→UTC semantics (incl. §14.6(c)/(h) DST skip), so OUTSIDE_WORKING_HOURS /
 * gap-rule window selection can never disagree with what computeSlots offers.
 */
export function materializeWorkingWindows(
  timezone: string,
  localDate: IsoDate,
  hours: readonly WorkingHoursEntry[],
): Array<{ start: number; end: number }> {
  const [year, month, day] = localDate.split("-").map(Number);
  const weekday = DateTime.fromObject({ year, month, day }, { zone: "utc" }).weekday;
  const windows: Array<{ start: number; end: number }> = [];
  for (const h of hours) {
    if (h.isoWeekday !== weekday) continue;
    const start = wallToUtc(timezone, localDate, h.startMinute);
    const end = wallToUtc(timezone, localDate, h.endMinute);
    if (start !== null && end !== null && end > start) windows.push({ start, end });
  }
  return windows;
}
