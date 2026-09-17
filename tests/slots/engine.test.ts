/**
 * TASK-201 — Slot engine PURE unit specs (RED-first).
 * TASK-201c — §14.6(h) partial-overlap endpoint-skip + fall-back ambiguous-hour
 * pins (2026-09-17). Spec-after-ratification remediation (audit S2-F1, F4
 * precedent): engine.ts wallToUtc already implements the ratified behavior —
 * these pins are green-on-arrival by design, NOT red-first.
 *
 * Design ref: docs/DESIGN.md §6.1 (computeSlots signature — BINDING) and
 * §6.2 (computation semantics — BINDING). REQ-005 acceptance criteria:
 * "DST transition days (March/Oct), buffer application, booked-interval
 * exclusion, multi-stylist calendars".
 *
 * PURE specs — no DB, no I/O, no skipIf gating: they ALWAYS run.
 * RED at import until TASK-202 implements src/lib/slots/engine.ts.
 *
 * Conventions:
 *  - Non-DST cases use timezone "UTC" (valid IANA zone for Luxon), so salon
 *    wall minutes === UTC minutes and expectations are trivial.
 *  - DST cases use Europe/Helsinki transitions:
 *      spring-forward 2027-03-28 03:00→04:00 EET(+2)→EEST(+3)
 *      fall-back     2027-10-31 04:00→03:00 EEST(+3)→EET(+2)
 *    Assertions are on UTC instants (Date.parse epochs), never wall strings.
 *  - isoWeekday is computed from the concrete date so the specs cannot drift.
 */
import { describe, expect, it } from "vitest";
import { computeSlots } from "../../src/lib/slots/engine";
import type { SlotComputationResult } from "../../src/lib/slots/types";

// --- helpers ---------------------------------------------------------------

/** Epoch ms for a UTC wall time (1-based month). */
const T = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi);

/** ISO weekday (1=Mon … 7=Sun) of a "YYYY-MM-DD" UTC calendar date. */
function isoWeekdayOf(isoDate: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return (((d.getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

const m = (h: number, min = 0): number => h * 60 + min; // wall minutes

const startsOf = (r: SlotComputationResult): number[] => r.slots.map((s) => Date.parse(s.startUtc));

const NO_IO = { timeOffByEmployee: {}, busyByEmployee: {} };

// --- §6.2.4 basic window + granularity alignment (REQ-005) -----------------

describe("computeSlots — basic window → granularity-aligned slots (§6.2.4; REQ-005)", () => {
  // Behavior: a single 09:00–17:00 window with granularity 15 and a 30-min
  // zero-buffer service yields every aligned start 09:00…16:30.
  it("REQ-005/§6.2.4: yields 31 slots 09:00…16:30 (step 15, 30-min service), Z-suffixed, endUtc = start + duration", () => {
    const date = "2027-06-07";
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }],
      },
      ...NO_IO,
    });
    expect(r.granularityMinutes).toBe(15);
    expect(r.slots).toHaveLength(31);
    const starts = startsOf(r);
    expect(starts[0]).toBe(T(2027, 6, 7, 9));
    expect(starts.at(-1)).toBe(T(2027, 6, 7, 16, 30));
    for (const s of r.slots) {
      expect(s.startUtc.endsWith("Z")).toBe(true); // §6.1: ISO 8601, Z-suffixed
      expect(Date.parse(s.endUtc) - Date.parse(s.startUtc)).toBe(30 * 60_000); // un-buffered
      expect(s.employeeId).toBe("emp-1");
      expect(s.localDate).toBe(date);
    }
    for (const s of starts) expect(s % (15 * 60_000)).toBe(0);
  });
});

// --- §6.2.3 busy-interval exclusion (REQ-005 "booked-interval exclusion") ---

describe("computeSlots — busy-interval exclusion (§6.2.3; REQ-005)", () => {
  // Behavior: a confirmed booking's blocked range splits the working window;
  // no candidate may start inside it; both surviving sides still produce slots.
  it("REQ-005/§6.2.3: busy 12:00–13:00 removes all starts inside it; 11:30 and 13:00 remain bookable (26 slots)", () => {
    const date = "2027-06-07";
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }],
      },
      busyByEmployee: {
        "emp-1": [{ startUtc: "2027-06-07T12:00:00Z", endUtc: "2027-06-07T13:00:00Z" }],
      },
      timeOffByEmployee: {},
    });
    const starts = startsOf(r);
    expect(r.slots).toHaveLength(26); // 11 before + 15 after
    expect(starts).toContain(T(2027, 6, 7, 11, 30));
    expect(starts).toContain(T(2027, 6, 7, 13, 0));
    for (const s of starts) {
      expect(s >= T(2027, 6, 7, 13, 0) || s <= T(2027, 6, 7, 11, 30)).toBe(true);
    }
  });

  // Behavior: after subtraction each window steps candidates from ITS OWN
  // open boundary (§6.2.4 "from each window's open boundary") — an unaligned
  // second-window opening still produces slots at 12:55, 13:10, …
  it("REQ-005/§6.2.4: candidate stepping is per-window — busy 12:00–12:55 leaves a window opening at 12:55 whose first slot is 12:55 (not grid-aligned)", () => {
    const date = "2027-06-07";
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }],
      },
      busyByEmployee: {
        "emp-1": [{ startUtc: "2027-06-07T12:00:00Z", endUtc: "2027-06-07T12:55:00Z" }],
      },
      timeOffByEmployee: {},
    });
    const starts = startsOf(r);
    expect(r.slots).toHaveLength(26); // 11 + 15
    const afterBusy = starts.filter((s) => s > T(2027, 6, 7, 12, 0));
    expect(afterBusy[0]).toBe(T(2027, 6, 7, 12, 55)); // per-window boundary
    for (const s of starts) {
      expect(s <= T(2027, 6, 7, 12, 0) || s >= T(2027, 6, 7, 12, 55)).toBe(true);
    }
  });
});

// --- §6.2.4 buffer semantics (REQ-005 "buffer application") ----------------

describe("computeSlots — buffer_before/after shrink availability (§6.2.4; REQ-005)", () => {
  // Behavior: a candidate is valid iff its buffered interval
  // [start − before, start + duration + after] fits ENTIRELY inside one open
  // window; edges that would overrun the window are dropped, endUtc stays
  // un-buffered.
  it("REQ-005/§6.2.4: 15/15 buffers on a 30-min service remove 09:00 and 16:30 starts; first slot 09:30, last 16:00, endUtc un-buffered", () => {
    const date = "2027-06-07";
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
      granularityMinutes: 30,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }],
      },
      ...NO_IO,
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(14); // 09:30 … 16:00 step 30
    expect(starts[0]).toBe(T(2027, 6, 7, 9, 30));
    expect(starts.at(-1)).toBe(T(2027, 6, 7, 16, 0));
    expect(starts).not.toContain(T(2027, 6, 7, 9, 0));
    expect(starts).not.toContain(T(2027, 6, 7, 16, 30));
    expect(Date.parse(r.slots[0].endUtc)).toBe(T(2027, 6, 7, 10, 0)); // 30 min, no buffer
  });

  // Behavior: busy intervals are BLOCKED ranges (§6.2.3) — a start whose
  // un-buffered interval would fit but whose buffered interval overruns the
  // shrunken open window is rejected (11:00 valid, 10:30 not).
  it("REQ-005/§6.2.3+§6.2.4: busy 10:00–10:30 with 15/15 service buffers — 10:30 start rejected (buffered interval 10:15–11:15 overruns the 10:30 window opening), first slot after busy is 11:00", () => {
    const date = "2027-06-07";
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 },
      granularityMinutes: 30,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }],
      },
      busyByEmployee: {
        "emp-1": [{ startUtc: "2027-06-07T10:00:00Z", endUtc: "2027-06-07T10:30:00Z" }],
      },
      timeOffByEmployee: {},
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(11); // 11:00 … 16:00 step 30 (window 1 fully buffered out)
    expect(starts[0]).toBe(T(2027, 6, 7, 11, 0));
    expect(starts).not.toContain(T(2027, 6, 7, 10, 30));
  });
});

// --- §6.1 multi-employee union + employeeFilter (REQ-005) ------------------

describe("computeSlots — multi-employee union + employeeFilter (§6.1; REQ-005)", () => {
  const date = "2027-06-07";
  function run(employeeFilter?: string): SlotComputationResult {
    return computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 60,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [
        { id: "emp-1", active: true },
        { id: "emp-2", active: true },
      ],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(13) }],
        "emp-2": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(11), endMinute: m(17) }],
      },
      employeeFilter,
      ...NO_IO,
    });
  }

  // Behavior: with no employeeFilter the result is the UNION over active
  // employees; overlapping openings (11:00, 12:00) yield one slot per employee.
  it("REQ-005/§6.1: omitted employeeFilter unions both calendars — 10 slots, starts 11:00 and 12:00 appear once per employee", () => {
    const r = run();
    expect(r.slots).toHaveLength(10); // emp-1: 09…12 (4) + emp-2: 11…16 (6)
    const at11 = r.slots.filter((s) => Date.parse(s.startUtc) === T(2027, 6, 7, 11, 0));
    expect(at11.map((s) => s.employeeId).sort()).toEqual(["emp-1", "emp-2"]);
    const at12 = r.slots.filter((s) => Date.parse(s.startUtc) === T(2027, 6, 7, 12, 0));
    expect(at12).toHaveLength(2);
  });

  // Behavior: employeeFilter restricts the union to that employee only.
  it("REQ-005/§6.1: employeeFilter=emp-1 returns only emp-1's 4 slots (09:00…12:00)", () => {
    const r = run("emp-1");
    expect(r.slots).toHaveLength(4);
    expect(r.slots.every((s) => s.employeeId === "emp-1")).toBe(true);
  });

  // Behavior: employeeFilter naming an employee with no working hours yields
  // an empty result (pure function — 404-on-unknown-employee is the I/O
  // wrapper's contract per §6.1).
  it("REQ-005/§6.1: employeeFilter to an employee absent from workingHoursByEmployee → zero slots", () => {
    const r = run("emp-404");
    expect(r.slots).toHaveLength(0);
  });
});

// --- inactive employees (§6.2.1 "active employee"; REQ-005/REQ-003) --------

describe("computeSlots — inactive employees excluded (§6.2.1; REQ-005)", () => {
  // Behavior: only ACTIVE employees contribute slots even when inactive ones
  // carry working hours.
  it("REQ-005/§6.2.1: inactive employee with identical hours produces no slots; active one does", () => {
    const date = "2027-06-07";
    const wh = [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }];
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [
        { id: "emp-off", active: false },
        { id: "emp-on", active: true },
      ],
      workingHoursByEmployee: { "emp-off": wh, "emp-on": wh },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(31);
    expect(r.slots.every((s) => s.employeeId === "emp-on")).toBe(true);
  });
});

// --- §6.1 sorted output ----------------------------------------------------

describe("computeSlots — output ordering (§6.1; REQ-005)", () => {
  // Behavior: slots are sorted by startUtc, then employeeId — even when the
  // employees array lists them in the opposite order.
  it("REQ-005/§6.1: sorted by startUtc then employeeId (tie at every start: 'emp-a' before 'emp-b' despite reversed input order)", () => {
    const date = "2027-06-07";
    const wh = [{ isoWeekday: isoWeekdayOf(date), startMinute: m(9), endMinute: m(17) }];
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: date, toDate: date },
      employees: [
        { id: "emp-b", active: true },
        { id: "emp-a", active: true },
      ],
      workingHoursByEmployee: { "emp-b": wh, "emp-a": wh },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(62);
    for (let i = 1; i < r.slots.length; i++) {
      const prev = r.slots[i - 1];
      const cur = r.slots[i];
      const prevStart = Date.parse(prev.startUtc);
      const curStart = Date.parse(cur.startUtc);
      expect(curStart > prevStart || (curStart === prevStart && cur.employeeId >= prev.employeeId)).toBe(true);
    }
    expect(r.slots[0].employeeId).toBe("emp-a");
    expect(r.slots[1].employeeId).toBe("emp-b");
  });
});

// --- §6.1 empty working hours ----------------------------------------------

describe("computeSlots — empty working hours (§6.1; REQ-005)", () => {
  it("REQ-005: employee with no working-hours entries yields zero slots; granularityMinutes still reported", () => {
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate: "2027-06-07", toDate: "2027-06-07" },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: { "emp-1": [] },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(0);
    expect(r.granularityMinutes).toBe(15);
  });
});

// --- §6.1 range cap (31 days) ----------------------------------------------

describe("computeSlots — range cap (§6.1 'max span 31 days'; REQ-005)", () => {
  const emptyDay = (fromDate: string, toDate: string): ReturnType<typeof computeSlots> =>
    computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "UTC",
      range: { fromDate, toDate },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: { "emp-1": [] },
      ...NO_IO,
    });

  // Behavior: exactly 31 inclusive calendar days is the maximum accepted
  // span; 32 days throws (wrapper maps to 422 per §6.1).
  it("REQ-005/§6.1: exactly 31 inclusive days (2027-01-01…2027-01-31) is accepted", () => {
    expect(() => emptyDay("2027-01-01", "2027-01-31")).not.toThrow();
    expect(emptyDay("2027-01-01", "2027-01-31").slots).toHaveLength(0);
  });

  it("REQ-005/§6.1: 32 inclusive days (2027-01-01…2027-02-01) throws", () => {
    expect(() => emptyDay("2027-01-01", "2027-02-01")).toThrow();
  });

  it("REQ-005/§6.1: reversed range (fromDate > toDate) throws", () => {
    expect(() => emptyDay("2027-01-02", "2027-01-01")).toThrow();
  });
});

// --- §6.2.1 DST — Europe/Helsinki 2027 (REQ-005 "DST transition days") -----

describe("computeSlots — DST spring-forward 2027-03-28 Europe/Helsinki (§6.2.1; REQ-005)", () => {
  const date = "2027-03-28"; // Sunday, 03:00→04:00 EET(+2)→EEST(+3)
  const wh = [{ isoWeekday: isoWeekdayOf(date), startMinute: m(2), endMinute: m(10) }];

  // Behavior: the wall window 02:00–10:00 spans the skipped hour and
  // materializes to only 7 real hours: 02:00 EEST? no — 02:00 is EET(+2) =
  // 00:00Z; 10:00 is EEST(+3) = 07:00Z. 60-min service, granularity 60 →
  // starts 00:00Z…06:00Z.
  it("REQ-005/DST: 02:00–10:00 wall on spring-forward Sunday yields 7 UTC-aligned slots 00:00Z…06:00Z (7 real hours, not 8)", () => {
    const r = computeSlots({
      service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 60,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: { "emp-1": wh },
      ...NO_IO,
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(7);
    expect(starts[0]).toBe(T(2027, 3, 28, 0)); // 02:00 EET
    expect(starts.at(-1)).toBe(T(2027, 3, 28, 6)); // window ends 10:00 EEST = 07:00Z
  });

  // Behavior: §6.2.1 "Non-existent wall times on spring-forward days are
  // skipped" — a working window lying ENTIRELY inside the skipped hour
  // (03:00–04:00 wall does not exist on 2027-03-28) yields no slots.
  // FLAGGED interpretation (TASK-201 report): Luxon's forward-mapping would
  // produce a phantom window; this spec pins the strict "skipped" reading.
  it("REQ-005/DST: working window wholly inside the skipped hour (03:00–04:00 wall) is skipped — zero slots", () => {
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(3), endMinute: m(4) }],
      },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(0);
  });
});

// --- §14.6(h) DST partial-overlap endpoint skip (TASK-201c; REQ-005) ------

describe("computeSlots — DST spring-forward partial-overlap endpoint skip (§14.6(h); REQ-005)", () => {
  const date = "2027-03-28"; // Sunday, 03:00→04:00 EET(+2)→EEST(+3); wall [03:00,04:00) nonexistent

  // Behavior: §14.6(h) ratification "window skipped entirely if ANY endpoint
  // wall time is nonexistent" (strict per-endpoint reading; never clamp /
  // phantom-map) — a START endpoint inside the skipped hour (03:30) voids the
  // whole window even though the end (06:00) exists.
  it("REQ-005/§14.6(h): START endpoint nonexistent (03:30–06:00 wall) → window skipped entirely, zero slots", () => {
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 30,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(3, 30), endMinute: m(6) }],
      },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(0);
  });

  // Behavior: symmetric partial overlap — an END endpoint inside the skipped
  // hour (03:30) voids the whole window even though the start (01:30) exists.
  it("REQ-005/§14.6(h): END endpoint nonexistent (01:30–03:30 wall) → window skipped entirely, zero slots", () => {
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 30,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(1, 30), endMinute: m(3, 30) }],
      },
      ...NO_IO,
    });
    expect(r.slots).toHaveLength(0);
  });

  // Behavior: sanity inverse — with BOTH endpoints existing, a window spanning
  // the gap materializes with per-endpoint offset asymmetry: start 02:00 maps
  // at EET(+2) → 00:00Z, end 06:00 maps at EEST(+3) → 03:00Z; 4 wall hours
  // compress to 3 real hours.
  it("REQ-005/§14.6(h): both endpoints existing (02:00–06:00 wall) span the gap → 6 slots 00:00Z…02:30Z, last endUtc 03:00Z (start +2 / end +3)", () => {
    const r = computeSlots({
      service: { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 30,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(2), endMinute: m(6) }],
      },
      ...NO_IO,
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(6);
    expect(starts[0]).toBe(T(2027, 3, 28, 0)); // 02:00 EET(+2)
    expect(starts.at(-1)).toBe(T(2027, 3, 28, 2, 30));
    expect(Date.parse(r.slots[r.slots.length - 1].endUtc)).toBe(T(2027, 3, 28, 3)); // 06:00 EEST(+3)
  });
});

describe("computeSlots — DST fall-back 2027-10-31 Europe/Helsinki (§6.2.1; REQ-005)", () => {
  const date = "2027-10-31"; // Sunday, 04:00 EEST(+3)→03:00 EET(+2)

  // Behavior: the wall window 02:00–10:00 spans the repeated hour and
  // materializes to 9 real hours: 02:00 EEST(+3) = 2027-10-30T23:00Z …
  // 10:00 EET(+2) = 08:00Z. First slot's localDate is still 2027-10-31.
  it("REQ-005/DST: 02:00–10:00 wall on fall-back Sunday expands to 9 slots starting 2027-10-30T23:00Z; localDate stays '2027-10-31' for the pre-midnight-UTC slot", () => {
    const r = computeSlots({
      service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 60,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(2), endMinute: m(10) }],
      },
      ...NO_IO,
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(9); // 23:00Z(10-30) … 07:00Z(10-31)
    expect(starts[0]).toBe(T(2027, 10, 30, 23));
    expect(starts.at(-1)).toBe(T(2027, 10, 31, 7));
    expect(r.slots[0].localDate).toBe("2027-10-31");
  });

  // Behavior: time_off is absolute UTC (§3.6) and subtracts from the
  // EXPANDED window exactly — removing its first two real hours leaves
  // 01:00Z…07:00Z.
  it("REQ-005/DST + §6.2.2: time_off [23:00Z 10-30, 01:00Z 10-31] trims the expanded window — first slot 01:00Z, 7 slots", () => {
    const r = computeSlots({
      service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 60,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(2), endMinute: m(10) }],
      },
      timeOffByEmployee: {
        "emp-1": [{ startUtc: "2027-10-30T23:00:00Z", endUtc: "2027-10-31T01:00:00Z" }],
      },
      busyByEmployee: {},
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(7);
    expect(starts[0]).toBe(T(2027, 10, 31, 1));
    expect(starts.at(-1)).toBe(T(2027, 10, 31, 7));
  });
});

// --- §14.6(c)/(h) fall-back ambiguous hour — early-offset pin (TASK-201c) --

describe("computeSlots — DST fall-back ambiguous repeated hour, early-offset pin (§14.6(c)/(h); REQ-005)", () => {
  const date = "2027-10-31"; // Sunday, 04:00 EEST(+3)→03:00 EET(+2); wall [03:00,04:00) occurs twice

  // Behavior: INTERPRETATION-PINNED (TASK-201c): a window whose BOTH endpoints
  // sit in the repeated hour (03:15–03:45 wall) materializes via Luxon's
  // default ambiguous-time resolution = the EARLIER offset (first occurrence,
  // EEST +3): 00:15Z–00:45Z — 30 real minutes, NOT duplicated across both
  // passes and NOT late-offset (+2) mapped. wallToUtc keeps the Luxon default.
  // [CONF: HIGH] [SRC: DOC — Luxon resolves ambiguous wall times to the
  // earlier offset; engine code inspected 2026-09-17]
  it("REQ-005/DST: window wholly inside the repeated hour (03:15–03:45 wall) → EARLY occurrence 00:15Z–00:45Z, 2 slots (00:15Z, 00:30Z), localDate '2027-10-31'", () => {
    const r = computeSlots({
      service: { durationMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
      granularityMinutes: 15,
      timezone: "Europe/Helsinki",
      range: { fromDate: date, toDate: date },
      employees: [{ id: "emp-1", active: true }],
      workingHoursByEmployee: {
        "emp-1": [{ isoWeekday: isoWeekdayOf(date), startMinute: m(3, 15), endMinute: m(3, 45) }],
      },
      ...NO_IO,
    });
    const starts = startsOf(r);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBe(T(2027, 10, 31, 0, 15)); // 03:15 EEST(+3) — early offset
    expect(starts.at(-1)).toBe(T(2027, 10, 31, 0, 30));
    expect(r.slots.every((s) => s.localDate === "2027-10-31")).toBe(true);
  });
});
