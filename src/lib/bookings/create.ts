/**
 * TASK-203 — Booking creation pipeline (DESIGN §7 + §14.6; REQ-004/006/007).
 *
 * Single internal transaction path; createBookingPublic/createBookingAdmin
 * differ ONLY in bypassGapRule + created_via. Transaction order (§7):
 *   resolve employee → pg_advisory_xact_lock(employee-day) → load
 *   service/settings/hours/time-off/confirmed-busy via scoped repos →
 *   validate (window fit §14.6(b), offered-membership, busy-overlap §14.6(a),
 *   gap rule §6.3) → guest upsert §14.6(f) → INSERT (23P01 ⇒ SLOT_OCCUPIED
 *   rollback) → COMMIT → BOOKING_CONFIRMED after commit (§8: never throws).
 *
 * Validation order is disambiguation-critical (§14.6(a)/(b)):
 *   1. startsAt outside every time-off-adjusted working window → OUTSIDE_WORKING_HOURS
 *   2. buffered interval overlaps confirmed busy → SLOT_OCCUPIED (never STALE_SLOT)
 *   3. startsAt not among the engine's offered slots (alignment/buffered fit) → STALE_SLOT
 *   4. evaluateGapRule (skipped iff admin bypass) → GAP_FRAGMENT
 *
 * employeeId omitted ⇒ server-side resolution: candidates in deterministic
 * order (created_at, id), first whose full validation passes wins. If every
 * candidate fails, occupancy (§14.6(a)) outranks the first schedule-shape error.
 */
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../../db/client";
import { createRepos, findSalonById, type DrizzleDb, type Employee } from "../../repos";
import { getNotificationPort } from "../notifications/port";
import { computeSlots, materializeWorkingWindows } from "../slots/engine";
import { evaluateGapRule } from "../slots/gapRule";
import type { IsoDate, IsoWeekday, UtcInterval, WorkingHoursEntry } from "../slots/types";
import type { BookingError, CreateBookingCmd, CreateBookingResult } from "./types";

const MINUTE_MS = 60_000;

/** Transaction handle type of `db.transaction` (no `any`). */
type TxHandle = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Internal abort signal — carries a domain error out of the transaction (⇒ rollback). */
class PipelineAbort extends Error {
  constructor(readonly error: BookingError) {
    super(`booking pipeline: ${error.code}`);
  }
}

/** Walks error + cause chain for a PostgreSQL SQLSTATE code. */
function pgErrorCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e; depth++) {
    if (typeof e === "object" && "code" in e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

interface CreateOptions {
  bypassGapRule: boolean;
  createdVia: "customer" | "admin_manual";
}

/** §7 public entry — structurally bypass-free (CreateBookingCmd has no flag). */
export async function createBookingPublic(cmd: CreateBookingCmd): Promise<CreateBookingResult> {
  return create(cmd, { bypassGapRule: false, createdVia: "customer" });
}

/** §7 admin entry — REQ-006/A1 manual booking with gap-rule bypass. */
export async function createBookingAdmin(
  cmd: CreateBookingCmd & { bypassGapRule: boolean },
): Promise<CreateBookingResult> {
  return create(cmd, { bypassGapRule: cmd.bypassGapRule, createdVia: "admin_manual" });
}

async function create(cmd: CreateBookingCmd, opts: CreateOptions): Promise<CreateBookingResult> {
  const startMs = Date.parse(cmd.startsAt);
  if (Number.isNaN(startMs)) return { code: "VALIDATION", field: "startsAt" };

  const salon = await findSalonById(db, cmd.salonId);
  if (!salon) return { code: "NOT_FOUND" };

  // Day-key component of the advisory lock: salon-local calendar date (§3.10).
  const localDate = DateTime.fromMillis(startMs, { zone: salon.timezone }).toISODate() as IsoDate;

  const candidateIds = cmd.employeeId
    ? [cmd.employeeId]
    : (await createRepos(db, { salonId: cmd.salonId })
        .employees.list({ active: true }))
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((e: Employee) => e.id);

  let firstError: BookingError | null = null;
  let sawOccupancy = false;
  for (const employeeId of candidateIds) {
    try {
      const bookingId = await attempt(cmd, opts, employeeId, startMs, localDate, salon.timezone);
      // §7 step 6 + §8: send AFTER commit; a failed send never propagates.
      await getNotificationPort()
        .send({
          type: "BOOKING_CONFIRMED",
          bookingId,
          salonId: cmd.salonId,
          recipientEmail: cmd.customer.email ?? null,
          locale: "fi",
        })
        .catch(() => undefined);
      return { bookingId, status: "confirmed" };
    } catch (err) {
      if (err instanceof PipelineAbort) {
        if (err.error.code === "SLOT_OCCUPIED") sawOccupancy = true;
        else if (firstError === null) firstError = err.error;
        continue; // try the next candidate employee ("first available")
      }
      throw err;
    }
  }
  if (sawOccupancy) return { code: "SLOT_OCCUPIED" }; // §14.6(a) outranks schedule-shape errors
  if (firstError !== null) return firstError;
  return { code: "NOT_FOUND" }; // no active employee candidates
}

/** One employee's full §7 transaction. Resolves with the committed booking id. */
async function attempt(
  cmd: CreateBookingCmd,
  opts: CreateOptions,
  employeeId: string,
  startMs: number,
  localDate: IsoDate,
  timezone: string,
): Promise<string> {
  try {
    return await db.transaction(async (tx) => {
      // §7 step 1 / §3.10: serialize same employee-day writes before gap evaluation.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${employeeId}::text || ${localDate}, 0))`,
      );
      // Repos are salon-scoped; bind them to THIS transaction handle so every
      // load shares the lock's serialization window.
      const repos = createRepos(tx as unknown as DrizzleDb, { salonId: cmd.salonId });

      // §7 step 2 — loads.
      const service = await repos.services.get(cmd.serviceId);
      if (!service) throw new PipelineAbort({ code: "NOT_FOUND" });
      if (!service.active) throw new PipelineAbort({ code: "SERVICE_INACTIVE" });
      const settings = await repos.settings.get();
      const granularityMinutes = settings?.slotGranularityMinutes ?? 15;
      const thresholdMinutes = settings?.gapThresholdMinutes ?? 45;

      const employee = await repos.employees.get(employeeId);
      if (!employee || !employee.active) throw new PipelineAbort({ code: "NOT_FOUND" });

      const hours = await repos.workingHours.list({ employeeId });
      const timeOff = await repos.timeOff.list({ employeeId });
      const busyBookings = await repos.bookings.list({ employeeId, status: "confirmed" });

      // §7 step 3 — validation.
      const start = startMs;
      const end = start + service.durationMinutes * MINUTE_MS;
      const blockedStart = start - service.bufferBeforeMinutes * MINUTE_MS;
      const blockedEnd = end + service.bufferAfterMinutes * MINUTE_MS;

      const hoursForEmployee: WorkingHoursEntry[] = hours.map((h) => ({
        isoWeekday: h.isoWeekday as IsoWeekday,
        startMinute: h.startMinute,
        endMinute: h.endMinute,
      }));
      const windows = materializeWorkingWindows(timezone, localDate, hoursForEmployee);

      // (§14.6(b)) startsAt must fall inside a working window that is open
      // (not away on time-off) — else OUTSIDE_WORKING_HOURS.
      const inWorkingTime = windows.some(
        (w) =>
          start >= w.start &&
          start < w.end &&
          !timeOff.some((t) => t.startsAt.getTime() <= start && t.endsAt.getTime() > start),
      );
      if (!inWorkingTime) throw new PipelineAbort({ code: "OUTSIDE_WORKING_HOURS" });

      const busy = busyBookings.map((b) => ({
        start: b.blockedStart.getTime(),
        end: b.blockedEnd.getTime(),
      }));

      // (§14.6(a)) buffered interval vs confirmed busy — strict overlap
      // ('[)' semantics, matching the exclusion constraint).
      if (busy.some((b) => b.start < blockedEnd && b.end > blockedStart)) {
        throw new PipelineAbort({ code: "SLOT_OCCUPIED" });
      }

      // Offered-membership: recompute THIS employee's day with the exact loads
      // (busy + time-off subtracted, granularity-stepped) and require the
      // engine to offer precisely this start (§6.2.4).
      const offered = computeSlots({
        service: {
          durationMinutes: service.durationMinutes,
          bufferBeforeMinutes: service.bufferBeforeMinutes,
          bufferAfterMinutes: service.bufferAfterMinutes,
        },
        granularityMinutes,
        timezone,
        range: { fromDate: localDate, toDate: localDate },
        employees: [{ id: employeeId, active: true }],
        workingHoursByEmployee: { [employeeId]: hoursForEmployee },
        timeOffByEmployee: {
          [employeeId]: timeOff.map((t) => ({
            startUtc: t.startsAt.toISOString(),
            endUtc: t.endsAt.toISOString(),
          })),
        },
        busyByEmployee: {
          [employeeId]: busyBookings.map((b) => ({
            startUtc: b.blockedStart.toISOString(),
            endUtc: b.blockedEnd.toISOString(),
          })),
        },
      });
      if (!offered.slots.some((s) => Date.parse(s.startUtc) === startMs)) {
        throw new PipelineAbort({ code: "STALE_SLOT" });
      }

      // §6.3 gap rule — admin bypass (A1) is the only skip.
      if (!opts.bypassGapRule) {
        const window = windows.find((w) => w.start <= blockedStart && blockedEnd <= w.end);
        if (window) {
          const busyInWindow = busy
            .filter((b) => b.end > window.start && b.start < window.end)
            .map((b) => ({
              start: Math.max(b.start, window.start),
              end: Math.min(b.end, window.end),
            }))
            .sort((a, b) => a.start - b.start);
          const decision = evaluateGapRule({
            thresholdMinutes,
            workingWindow: intervalOf(window.start, window.end),
            busyIntervals: busyInWindow.map((b) => intervalOf(b.start, b.end)),
            candidate: intervalOf(blockedStart, blockedEnd),
          });
          if (!decision.allowed) {
            throw new PipelineAbort({
              code: "GAP_FRAGMENT",
              fragmentMinutes: decision.fragmentMinutes,
            });
          }
        }
      }

      // §7 step 4 + §14.6(f): guest identity = email else phone; name last-known-wins.
      const customerId = cmd.customer.email
        ? await upsertGuestByEmail(tx, cmd.customer.email, cmd.customer.name, cmd.customer.phone ?? null)
        : await upsertGuestByPhone(tx, cmd.customer.phone ?? null, cmd.customer.name);

      // §7 step 5 — insert; 23P01 aborts the transaction (caught below).
      const booking = await repos.bookings.create({
        serviceId: service.id,
        employeeId,
        customerId,
        startsAt: new Date(start),
        endsAt: new Date(end),
        blockedStart: new Date(blockedStart),
        blockedEnd: new Date(blockedEnd),
        status: "confirmed",
        createdVia: opts.createdVia,
        notes: cmd.notes ?? null,
      });
      return booking.id; // commit follows; the caller sends the notification after commit
    });
  } catch (err) {
    if (err instanceof PipelineAbort) throw err;
    if (pgErrorCode(err) === "23P01") throw new PipelineAbort({ code: "SLOT_OCCUPIED" }); // §7 step 5
    throw err;
  }
}

function intervalOf(start: number, end: number): UtcInterval {
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() };
}

/**
 * Email-keyed upsert. Atomic INSERT … ON CONFLICT against the partial unique
 * index (§3.8): concurrent employee-resolution winners must not collide on the
 * global customers row (23505 would otherwise abort a legitimately won txn).
 */
async function upsertGuestByEmail(
  tx: TxHandle,
  email: string,
  name: string,
  phone: string | null,
): Promise<string> {
  const res = await tx.execute(
    sql`INSERT INTO customers (name, email, phone)
        VALUES (${name}, ${email}, ${phone})
        ON CONFLICT (email) WHERE email IS NOT NULL
        DO UPDATE SET name = EXCLUDED.name, updated_at = now()
        RETURNING id`,
  );
  const row = res.rows[0] as { id: string } | undefined;
  if (!row) throw new Error("customers upsert (email) returned no row");
  return row.id;
}

/** Phone-keyed upsert (no unique index on phone — §3.8): select, then insert or rename. */
async function upsertGuestByPhone(
  tx: TxHandle,
  phone: string | null,
  name: string,
): Promise<string> {
  if (phone !== null) {
    const found = await tx.execute(
      sql`SELECT id FROM customers WHERE phone = ${phone} ORDER BY created_at, id LIMIT 1`,
    );
    const existing = found.rows[0] as { id: string } | undefined;
    if (existing) {
      await tx.execute(
        sql`UPDATE customers SET name = ${name}, updated_at = now() WHERE id = ${existing.id}`,
      );
      return existing.id;
    }
  }
  const inserted = await tx.execute(
    sql`INSERT INTO customers (name, email, phone) VALUES (${name}, NULL, ${phone}) RETURNING id`,
  );
  const row = inserted.rows[0] as { id: string } | undefined;
  if (!row) throw new Error("customers insert (phone) returned no row");
  return row.id;
}
