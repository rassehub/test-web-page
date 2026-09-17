/**
 * TASK-103 seed helpers.
 *
 * Raw SQL only — these specs must NOT depend on Drizzle table definitions
 * (schema.ts is the TASK-104 deliverable). Column lists mirror DESIGN §3
 * exactly; if TASK-104 DDL deviates from DESIGN §3, these seeds fail loudly
 * and that is the intended red.
 *
 * Two consumption patterns:
 *  - TX-mode specs (constraints/exclusion): Seeder over a rollback
 *    transaction; cleanup() is a no-op safety net (rollback already undid
 *    everything) but still correct to call.
 *  - PLAIN-mode specs (scoping/auth): Seeder over a plain pool; MUST call
 *    cleanup() in afterEach — deletes staff_users (cascades staff_sessions),
 *    then salons (cascades settings/services/employees/working_hours/
 *    time_off/bookings per §3.2–§3.9), then orphaned global customers rows
 *    (§3.8 — deliberately NOT salon-scoped, no cascade from salons).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Raw cookie token (any high-entropy string); DB stores sha256Hex(token). */
export function newRawToken(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

export function inHours(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

/** §14.3: role enum is binding — 'platform_admin' is a first-class role, not just the §3.7 flag. */
export type StaffRole = "owner" | "employee" | "platform_admin";
export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";
export type CreatedVia = "customer" | "admin_manual";

export interface SalonOverrides {
  slug?: string;
  name?: string;
  timezone?: string;
}

export interface ServiceOverrides {
  name?: string;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceCents?: number;
  active?: boolean;
}

export interface EmployeeOverrides {
  displayName?: string;
  active?: boolean;
}

export interface BookingSeed {
  salonId: string;
  serviceId: string;
  employeeId: string;
  customerId: string;
  startsAt: Date;
  endsAt: Date;
  /** Defaults to startsAt (zero-buffer snapshot). */
  blockedStart?: Date;
  /** Defaults to endsAt (zero-buffer snapshot). */
  blockedEnd?: Date;
  status?: BookingStatus;
  createdVia?: CreatedVia;
  notes?: string;
}

export interface StaffUserSeed {
  email?: string;
  passwordHash?: string;
  role: StaffRole;
  salonId: string | null;
  employeeId?: string | null;
  isPlatformAdmin?: boolean;
}

export class Seeder {
  private readonly salonIds: string[] = [];
  private readonly customerIds: string[] = [];
  private readonly staffUserIds: string[] = [];

  constructor(private readonly db: Db) {}

  async salon(o: SalonOverrides = {}): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO salons (slug, name, timezone) VALUES ($1, $2, $3) RETURNING id`,
      [o.slug ?? `t-${randomUUID()}`, o.name ?? "Test Salon", o.timezone ?? "Europe/Helsinki"],
    );
    return this.track(this.salonIds, row);
  }

  /** Valid-only settings row; omit overrides to accept DDL defaults (45 / 15). */
  async salonSettings(
    salonId: string,
    o: { gapThresholdMinutes?: number; slotGranularityMinutes?: number } = {},
  ): Promise<void> {
    const cols: string[] = ["salon_id"];
    const vals: unknown[] = [salonId];
    if (o.gapThresholdMinutes !== undefined) {
      cols.push("gap_threshold_minutes");
      vals.push(o.gapThresholdMinutes);
    }
    if (o.slotGranularityMinutes !== undefined) {
      cols.push("slot_granularity_minutes");
      vals.push(o.slotGranularityMinutes);
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    await this.db.exec(`INSERT INTO salon_settings (${cols.join(", ")}) VALUES (${placeholders})`, vals);
  }

  async service(salonId: string, o: ServiceOverrides = {}): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO services (salon_id, name, duration_minutes, buffer_before_minutes, buffer_after_minutes, price_cents, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        salonId,
        o.name ?? `svc-${randomUUID()}`,
        o.durationMinutes ?? 30,
        o.bufferBeforeMinutes ?? 0,
        o.bufferAfterMinutes ?? 0,
        o.priceCents ?? 4_500,
        o.active ?? true,
      ],
    );
    return row?.id ?? this.fail("seed service: no id returned");
  }

  async employee(salonId: string, o: EmployeeOverrides = {}): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO employees (salon_id, display_name, active) VALUES ($1, $2, $3) RETURNING id`,
      [salonId, o.displayName ?? `Stylist ${randomUUID().slice(0, 8)}`, o.active ?? true],
    );
    return row?.id ?? this.fail("seed employee: no id returned");
  }

  /** Global customers table (§3.8) — not salon-scoped; tracked for cleanup. */
  async customer(o: { name?: string; email?: string | null; phone?: string | null } = {}): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
      [o.name ?? "Guest Customer", o.email ?? null, o.phone ?? null],
    );
    return this.track(this.customerIds, row);
  }

  /** Valid booking; blocked_* default to a zero-buffer snapshot (§3.9). */
  async booking(b: BookingSeed): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO bookings (salon_id, service_id, employee_id, customer_id, starts_at, ends_at,
                             blocked_start, blocked_end, status, created_via, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        b.salonId,
        b.serviceId,
        b.employeeId,
        b.customerId,
        b.startsAt,
        b.endsAt,
        b.blockedStart ?? b.startsAt,
        b.blockedEnd ?? b.endsAt,
        b.status ?? "confirmed",
        b.createdVia ?? "customer",
        b.notes ?? null,
      ],
    );
    return row?.id ?? this.fail("seed booking: no id returned");
  }

  async staffUser(s: StaffUserSeed): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO staff_users (email, password_hash, role, salon_id, employee_id, is_platform_admin)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        s.email ?? `staff-${randomUUID()}@test.example`,
        s.passwordHash ?? "not-a-real-hash",
        s.role,
        s.salonId,
        s.employeeId ?? null,
        s.isPlatformAdmin ?? false,
      ],
    );
    return this.track(this.staffUserIds, row);
  }

  /** Stores sha256(token) as token_hash per §3.7; returns session row id. */
  async session(s: { userId: string; token: string; expiresAt: Date }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO staff_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
      [s.userId, sha256Hex(s.token), s.expiresAt],
    );
    return row?.id ?? this.fail("seed session: no id returned");
  }

  /** Order matters: staff_users → salons → customers (see file header). */
  async cleanup(): Promise<void> {
    if (this.staffUserIds.length > 0) {
      await this.db.exec(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [this.staffUserIds]);
      this.staffUserIds.length = 0;
    }
    if (this.salonIds.length > 0) {
      await this.db.exec(`DELETE FROM salons WHERE id = ANY($1::uuid[])`, [this.salonIds]);
      this.salonIds.length = 0;
    }
    if (this.customerIds.length > 0) {
      await this.db.exec(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [this.customerIds]);
      this.customerIds.length = 0;
    }
  }

  private track<T>(ids: string[], row: { id: T } | null): T {
    if (!row) return this.fail("seed returned no row");
    ids.push(String(row.id));
    return row.id;
  }

  private fail(msg: string): never {
    throw new Error(msg);
  }
}

/** Direct lookup for lazy-delete / logout assertions (§3.7, §5.1). */
export async function findSessionByToken(db: Db, token: string): Promise<{ id: string } | null> {
  return db.one<{ id: string }>(`SELECT id FROM staff_sessions WHERE token_hash = $1`, [sha256Hex(token)]);
}
