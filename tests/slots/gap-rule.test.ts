/**
 * TASK-201 — Gap-fragmentation rule PURE specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §6.3 — BINDING definition (Scrum Lead sign-off
 * §13.3: "TDD specs must encode it exactly"):
 *
 *   prevEnd   = latest busy end before candidate start within the window
 *   nextStart = earliest busy start after candidate end
 *   Reject (allowed=false) iff an interior neighbor exists and the gap to it
 *   is > 0 AND < thresholdMinutes.
 *   - Gaps touching the working-window boundary are EXTERIOR — never counted.
 *   - A fully-adjacent booking (zero gap) is always allowed.
 *   - Pre-existing sub-threshold fragments elsewhere in the day do not block.
 *
 * REQ-006 acceptance criteria: "3 h gap, mid-gap booking leaving < 45 min
 * fragment → rejected 422; changing threshold changes outcome; admin manual
 * bookings bypass (A1)" — the bypass itself is specified in
 * tests/bookings/create.test.ts (pipeline level).
 *
 * PURE specs — always run, no DB. RED at import until TASK-202 implements
 * src/lib/slots/gapRule.ts.
 */
import { describe, expect, it } from "vitest";
import { evaluateGapRule } from "../../src/lib/slots/gapRule";
import type { UtcInterval } from "../../src/lib/slots/types";

// --- helpers ---------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, "0");

/** UTC interval on the fixed spec day 2027-06-01. */
function iv(h1: number, m1: number, h2: number, m2: number): UtcInterval {
  return {
    startUtc: `2027-06-01T${pad(h1)}:${pad(m1)}:00Z`,
    endUtc: `2027-06-01T${pad(h2)}:${pad(m2)}:00Z`,
  };
}

/** Fixed working window 09:00–17:00Z (one contiguous window per §6.3). */
const WIN: UtcInterval = iv(9, 0, 17, 0);

const epoch = (i: UtcInterval, key: "startUtc" | "endUtc"): number => Date.parse(i[key]);

// --- §6.3 exhaustive decision table ----------------------------------------

describe("evaluateGapRule — §6.3 binding definition (REQ-006)", () => {
  // Behavior: with no busy neighbors at all, any in-window candidate is allowed.
  it("REQ-006/§6.3: no busy neighbors → allowed", () => {
    const d = evaluateGapRule({ thresholdMinutes: 45, workingWindow: WIN, busyIntervals: [], candidate: iv(10, 0, 11, 0) });
    expect(d).toEqual({ allowed: true });
  });

  // Behavior: a fully-adjacent booking (zero gap) is always allowed on BOTH
  // sides — zero-length gaps are never fragments.
  it("REQ-006/§6.3: gap == 0 on both sides (candidate exactly between two adjacent bookings) → allowed", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(10, 0, 11, 0), iv(12, 0, 13, 0)],
      candidate: iv(11, 0, 12, 0),
    });
    expect(d).toEqual({ allowed: true });
  });

  // Behavior: strict less-than — a gap exactly equal to the threshold is NOT
  // a fragment.
  it("REQ-006/§6.3: gap == threshold (45) → allowed (strict '<')", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(10, 0, 11, 0)],
      candidate: iv(11, 45, 12, 45), // prev gap exactly 45
    });
    expect(d).toEqual({ allowed: true });
  });

  // Behavior: a next-side interior gap of 44 (< 45) is rejected and the
  // decision reports the exact fragment interval and its length.
  it("REQ-006/§6.3: next-side gap 44 < threshold 45 → rejected with fragment [12:16, 13:00] and fragmentMinutes 44", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(13, 0, 14, 0)],
      candidate: iv(11, 16, 12, 16),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.fragmentMinutes).toBe(44);
      expect(epoch(d.fragment, "startUtc")).toBe(Date.parse("2027-06-01T12:16:00Z"));
      expect(epoch(d.fragment, "endUtc")).toBe(Date.parse("2027-06-01T13:00:00Z"));
    }
  });

  // Behavior: a prev-side interior gap is equally blocking; the reported
  // fragment is the one between the busy end and the candidate start.
  it("REQ-006/§6.3: prev-side gap 30 < threshold 45 → rejected with fragment [10:00, 10:30] and fragmentMinutes 30", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0)],
      candidate: iv(10, 30, 11, 30),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.fragmentMinutes).toBe(30);
      expect(epoch(d.fragment, "startUtc")).toBe(Date.parse("2027-06-01T10:00:00Z"));
      expect(epoch(d.fragment, "endUtc")).toBe(Date.parse("2027-06-01T10:30:00Z"));
    }
  });

  // Behavior: gaps measured to the working-window BOUNDARY are exterior and
  // never counted, however small — at both the window start and the window
  // end.
  it("REQ-006/§6.3: candidate touching the window boundary (0 min to window start / window end) with no adjacent busy → allowed (exterior gaps never counted)", () => {
    const head = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(15, 0, 16, 0)],
      candidate: iv(9, 0, 9, 20), // 0 min to window start, huge gap to busy
    });
    expect(head).toEqual({ allowed: true });

    const tail = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0)],
      candidate: iv(16, 30, 17, 0), // ends exactly at window end
    });
    expect(tail).toEqual({ allowed: true });
  });

  // Behavior: fragments elsewhere in the day — between two EXISTING bookings,
  // away from the candidate — are pre-existing salon state and do not block.
  it("REQ-006/§6.3: pre-existing 30-min fragment between two busy intervals elsewhere in the day does not block a distant candidate", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0), iv(10, 30, 11, 0)], // 30-min pre-existing hole
      candidate: iv(15, 0, 16, 0),
    });
    expect(d).toEqual({ allowed: true });
  });

  // REQ-006 acceptance case verbatim: a 3 h interior gap (busy ends 10:00,
  // next busy starts 13:00), mid-gap booking [11:16, 12:16] leaves a 44-min
  // fragment on the 13:00 side.
  it("REQ-006 AC: 3h interior gap, mid-gap booking leaving 44-min fragment, threshold 45 → rejected (fragmentMinutes 44)", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 45,
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0), iv(13, 0, 13, 30)],
      candidate: iv(11, 16, 12, 16),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.fragmentMinutes).toBe(44);
  });

  // REQ-006 acceptance case, threshold leg: identical submission with
  // threshold 40 → the 44-min fragment is now acceptable → allowed.
  it("REQ-006 AC: same 44-min fragment with threshold 40 → allowed (threshold change changes outcome)", () => {
    const d = evaluateGapRule({
      thresholdMinutes: 40,
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0), iv(13, 0, 13, 30)],
      candidate: iv(11, 16, 12, 16),
    });
    expect(d).toEqual({ allowed: true });
  });

  // Behavior: threshold change flips an otherwise-identical submission
  // (boundary of the strict '<' comparison).
  it("REQ-006: threshold change flips outcome — 30-min gap allowed at threshold 30, rejected at 31", () => {
    const input = {
      workingWindow: WIN,
      busyIntervals: [iv(9, 0, 10, 0)],
      candidate: iv(10, 30, 11, 30),
    } as const;
    expect(evaluateGapRule({ ...input, thresholdMinutes: 30 })).toEqual({ allowed: true });
    expect(evaluateGapRule({ ...input, thresholdMinutes: 31 }).allowed).toBe(false);
  });
});
