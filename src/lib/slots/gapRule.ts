/**
 * Gap-fragmentation rule — DESIGN §6.3 (binding; Scrum Lead sign-off §13.3).
 *
 * prevEnd   = latest busy end before candidate start within the window.
 * nextStart = earliest busy start after candidate end.
 * Reject (allowed=false) iff an interior neighbor exists and the gap to it is
 * > 0 AND < thresholdMinutes. Gaps touching the working-window boundary are
 * exterior — never counted; a fully-adjacent booking (zero gap) always passes.
 * Pre-existing fragments elsewhere in the day never block.
 */
import { DateTime } from "luxon";
import type { UtcInterval } from "./types";

export interface GapRuleInput {
  thresholdMinutes: number; // from salon_settings.gap_threshold_minutes at call time
  workingWindow: UtcInterval; // one contiguous employee working window (that day)
  busyIntervals: UtcInterval[]; // within window, sorted, pairwise disjoint (incl. buffers)
  candidate: UtcInterval; // buffered candidate; within window; disjoint from busy
}

export type GapRuleDecision =
  | { allowed: true }
  | { allowed: false; fragment: UtcInterval; fragmentMinutes: number };

const MINUTE_MS = 60_000;

const toIsoZ = (ms: number): string =>
  DateTime.fromMillis(ms, { zone: "utc" }).toISO({ suppressMilliseconds: true })!;

export function evaluateGapRule(input: GapRuleInput): GapRuleDecision {
  const candidateStart = Date.parse(input.candidate.startUtc);
  const candidateEnd = Date.parse(input.candidate.endUtc);

  let prevEnd: number | null = null; // latest busy end ≤ candidate start
  let nextStart: number | null = null; // earliest busy start ≥ candidate end
  for (const busy of input.busyIntervals) {
    const busyStart = Date.parse(busy.startUtc);
    const busyEnd = Date.parse(busy.endUtc);
    if (busyEnd <= candidateStart && (prevEnd === null || busyEnd > prevEnd)) prevEnd = busyEnd;
    if (busyStart >= candidateEnd && (nextStart === null || busyStart < nextStart)) {
      nextStart = busyStart;
    }
  }

  // A null neighbor means the gap runs to the working-window boundary —
  // exterior, never counted (§6.3). When both sides fragment, the prev-side
  // fragment is reported first (deterministic; spec silent on the tie).
  if (prevEnd !== null) {
    const gapMinutes = (candidateStart - prevEnd) / MINUTE_MS;
    if (gapMinutes > 0 && gapMinutes < input.thresholdMinutes) {
      return {
        allowed: false,
        fragment: { startUtc: toIsoZ(prevEnd), endUtc: toIsoZ(candidateStart) },
        fragmentMinutes: gapMinutes,
      };
    }
  }
  if (nextStart !== null) {
    const gapMinutes = (nextStart - candidateEnd) / MINUTE_MS;
    if (gapMinutes > 0 && gapMinutes < input.thresholdMinutes) {
      return {
        allowed: false,
        fragment: { startUtc: toIsoZ(candidateEnd), endUtc: toIsoZ(nextStart) },
        fragmentMinutes: gapMinutes,
      };
    }
  }
  return { allowed: true };
}
