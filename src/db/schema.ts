/**
 * TASK-104 — Drizzle schema, DESIGN §3.1–§3.9 + §14.3 (staff_users CHECKs,
 * superseding §3.7's single XOR CHECK).
 *
 * Ground truth for the DATABASE is src/db/migrations/0000_init.sql (handwritten,
 * applied by scripts/migrate.mjs). This file mirrors it for typed queries.
 * The §3.10 exclusion constraint (bookings_no_double_booking) is NOT
 * expressible in Drizzle's DSL — it lives in the migration only (DESIGN §3.10).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const STAFF_ROLES = ["owner", "employee", "platform_admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const BOOKING_STATUSES = ["confirmed", "cancelled", "completed", "no_show"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const CREATED_VIA = ["customer", "admin_manual"] as const;
export type CreatedVia = (typeof CREATED_VIA)[number];

/** §3.1 salons */
export const salons = pgTable("salons", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/Helsinki"),
  address: text("address"),
  phone: text("phone"),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("salons_slug_key").on(t.slug),
]);

/** §3.2 salon_settings — 1:1 with salon (REQ-006 threshold) */
export const salonSettings = pgTable("salon_settings", {
  salonId: uuid("salon_id").primaryKey()
    .references(() => salons.id, { onDelete: "cascade" }),
  gapThresholdMinutes: integer("gap_threshold_minutes").notNull().default(45),
  slotGranularityMinutes: integer("slot_granularity_minutes").notNull().default(15),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("salon_settings_gap_positive", sql`gap_threshold_minutes > 0`),
  check("salon_settings_granularity_range", sql`slot_granularity_minutes BETWEEN 5 AND 60`),
]);

/** §3.3 services (REQ-002) */
export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull()
    .references(() => salons.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  priceCents: integer("price_cents").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("services_salon_name_unique").on(t.salonId, t.name),
  // Composite-FK target for bookings.service_id (§3.9).
  uniqueIndex("services_salon_id_unique").on(t.salonId, t.id),
  // §3.3: powers "inactive services never appear in customer flow or slot computation".
  index("services_active_salon_idx").on(t.salonId).where(sql`active`),
  check("services_duration_positive", sql`duration_minutes > 0`),
  check("services_buffer_before_nonneg", sql`buffer_before_minutes >= 0`),
  check("services_buffer_after_nonneg", sql`buffer_after_minutes >= 0`),
  check("services_price_nonneg", sql`price_cents >= 0`),
]);

/** §3.4 employees (REQ-003) */
export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull()
    .references(() => salons.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  title: text("title"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Composite-FK target for working_hours/time_off/bookings (§3.5, §3.6, §3.9).
  uniqueIndex("employees_salon_id_unique").on(t.salonId, t.id),
]);

/** §3.5 working_hours (REQ-003) */
export const workingHours = pgTable("working_hours", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  isoWeekday: smallint("iso_weekday").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
}, (t) => [
  index("working_hours_employee_weekday_idx").on(t.employeeId, t.isoWeekday),
  check("working_hours_weekday_range", sql`iso_weekday BETWEEN 1 AND 7`),
  check("working_hours_start_range", sql`start_minute BETWEEN 0 AND 1439`),
  check("working_hours_end_range", sql`end_minute BETWEEN 0 AND 1439`),
  check("working_hours_start_before_end", sql`start_minute < end_minute`),
  foreignKey({
    columns: [t.salonId, t.employeeId],
    foreignColumns: [employees.salonId, employees.id],
  }).onDelete("cascade"),
]);

/** §3.6 time_off (REQ-003) */
export const timeOff = pgTable("time_off", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
}, (t) => [
  index("time_off_employee_start_idx").on(t.employeeId, t.startsAt),
  check("time_off_start_before_end", sql`starts_at < ends_at`),
  foreignKey({
    columns: [t.salonId, t.employeeId],
    foreignColumns: [employees.salonId, employees.id],
  }).onDelete("cascade"),
]);

/** §3.7/§14.3 staff_users — role-consistency CHECKs are §14.3 (binding). */
export const staffUsers = pgTable("staff_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<StaffRole>().notNull(),
  salonId: uuid("salon_id").references(() => salons.id),
  employeeId: uuid("employee_id"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("staff_users_email_key").on(t.email),
  check("staff_users_role_allowed", sql`role IN ('owner', 'employee', 'platform_admin')`),
  // §14.3: role='platform_admin' ⟺ is_platform_admin.
  check("staff_users_platform_role_iff_flag", sql`(role = 'platform_admin') = is_platform_admin`),
  // §14.3: role='employee' ⇒ employee_id IS NOT NULL.
  check("staff_users_employee_requires_link", sql`role <> 'employee' OR employee_id IS NOT NULL`),
  // §14.3: role='owner' ⇒ employee_id IS NULL.
  check("staff_users_owner_unlinked", sql`role <> 'owner' OR employee_id IS NULL`),
  // §14.3: role='platform_admin' ⇒ salon_id IS NULL AND employee_id IS NULL.
  check("staff_users_admin_unscoped", sql`role <> 'platform_admin' OR (salon_id IS NULL AND employee_id IS NULL)`),
  // §14.3: NOT is_platform_admin ⇒ salon_id IS NOT NULL.
  check("staff_users_nonadmin_scoped", sql`is_platform_admin OR salon_id IS NOT NULL`),
  foreignKey({
    columns: [t.salonId, t.employeeId],
    foreignColumns: [employees.salonId, employees.id],
  }),
]);

/** §3.7 staff_sessions (DB-backed sessions — no Redis). */
export const staffSessions = pgTable("staff_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull()
    .references(() => staffUsers.id, { onDelete: "cascade" }),
  tokenHash: char("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("staff_sessions_token_hash_key").on(t.tokenHash),
  index("staff_sessions_expires_idx").on(t.expiresAt),
]);

/** §3.8 customers — global, deliberately NOT salon-scoped. */
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("customers_email_unique").on(t.email).where(sql`email IS NOT NULL`),
]);

/** §3.9 bookings (REQ-004/005/006/007/012).
 *  §3.10 exclusion constraint lives in the migration only. */
export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull()
    .references(() => salons.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull(),
  employeeId: uuid("employee_id").notNull(),
  customerId: uuid("customer_id").notNull()
    .references(() => customers.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  blockedStart: timestamp("blocked_start", { withTimezone: true }).notNull(),
  blockedEnd: timestamp("blocked_end", { withTimezone: true }).notNull(),
  status: text("status").$type<BookingStatus>().notNull().default("confirmed"),
  createdVia: text("created_via").$type<CreatedVia>().notNull().default("customer"),
  notes: text("notes"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("bookings_salon_start_idx").on(t.salonId, t.startsAt),
  // §3.9: slot-engine input — confirmed only.
  index("bookings_employee_confirmed_start_idx").on(t.employeeId, t.startsAt)
    .where(sql`status = 'confirmed'`),
  index("bookings_customer_idx").on(t.customerId),
  // Composite-FK target for Sprint 4 audit trails (§3.9).
  uniqueIndex("bookings_salon_id_unique").on(t.salonId, t.id),
  check("bookings_start_before_end", sql`starts_at < ends_at`),
  // §3.9: blocked range must contain the actual range (zero-buffer allowed).
  check("bookings_blocked_contains_actual", sql`blocked_start <= starts_at AND ends_at <= blocked_end`),
  check("bookings_status_allowed", sql`status IN ('confirmed', 'cancelled', 'completed', 'no_show')`),
  check("bookings_created_via_allowed", sql`created_via IN ('customer', 'admin_manual')`),
  foreignKey({
    columns: [t.salonId, t.serviceId],
    foreignColumns: [services.salonId, services.id],
  }),
  foreignKey({
    columns: [t.salonId, t.employeeId],
    foreignColumns: [employees.salonId, employees.id],
  }),
]);
