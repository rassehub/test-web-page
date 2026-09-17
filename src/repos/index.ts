/**
 * TASK-104 — Salon-scoped repositories (DESIGN §4 + §14.2 binding repo surface).
 *
 * §4 contract:
 *  - createRepos refuses to construct without a non-empty salonId — a repo
 *    instance IS a salon scope.
 *  - Every emitted query includes eq(table.salon_id, scope.salonId); lookups
 *    are and(eq(id), eq(salon_id)) — cross-salon ids yield null, never data.
 *  - Repos return camelCase domain objects, never Drizzle rows; schema types
 *    stay inside this module.
 *
 * working-hours save-time overlap rejection is OUT of scope (Sprint 4) —
 * plain CRUD only.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  bookings,
  employees,
  salonSettings,
  services,
  timeOff,
  workingHours,
  type BookingStatus,
  type CreatedVia,
} from "../db/schema";

export type DrizzleDb = NodePgDatabase;

export interface SalonScope {
  salonId: string;
}

// ---------------------------------------------------------------------------
// Domain objects (camelCase; Drizzle rows never cross this line)
// ---------------------------------------------------------------------------

export interface Service {
  id: string;
  salonId: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceCents: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Employee {
  id: string;
  salonId: string;
  displayName: string;
  title: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkingHours {
  id: string;
  salonId: string;
  employeeId: string;
  isoWeekday: number;
  startMinute: number;
  endMinute: number;
}

export interface TimeOff {
  id: string;
  salonId: string;
  employeeId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

export interface Booking {
  id: string;
  salonId: string;
  serviceId: string;
  employeeId: string;
  customerId: string;
  startsAt: Date;
  endsAt: Date;
  blockedStart: Date;
  blockedEnd: Date;
  status: BookingStatus;
  createdVia: CreatedVia;
  notes: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalonSettings {
  salonId: string;
  gapThresholdMinutes: number;
  slotGranularityMinutes: number;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Inputs / filters
// ---------------------------------------------------------------------------

export interface ServiceCreate {
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceCents?: number;
  active?: boolean;
}
export type ServicePatch = Partial<Omit<ServiceCreate, "name">> & { name?: string };

export interface EmployeeCreate {
  displayName: string;
  title?: string | null;
  active?: boolean;
}
export type EmployeePatch = Partial<EmployeeCreate>;

export interface WorkingHoursCreate {
  employeeId: string;
  isoWeekday: number;
  startMinute: number;
  endMinute: number;
}
export type WorkingHoursPatch = Partial<Omit<WorkingHoursCreate, "employeeId">>;

export interface TimeOffCreate {
  employeeId: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}
export type TimeOffPatch = Partial<TimeOffCreate>;

export interface BookingCreate {
  serviceId: string;
  employeeId: string;
  customerId: string;
  startsAt: Date;
  endsAt: Date;
  blockedStart: Date;
  blockedEnd: Date;
  status?: BookingStatus;
  createdVia?: CreatedVia;
  notes?: string | null;
}
export type BookingPatch = Partial<Omit<BookingCreate, "serviceId" | "employeeId" | "customerId">>;

export interface SettingsPatch {
  gapThresholdMinutes?: number;
  slotGranularityMinutes?: number;
}

export interface ServiceFilter {
  active?: boolean;
}
export interface EmployeeFilter {
  active?: boolean;
}
export interface WorkingHoursFilter {
  employeeId?: string;
  isoWeekday?: number;
}
export interface TimeOffFilter {
  employeeId?: string;
}
export interface BookingFilter {
  employeeId?: string;
  customerId?: string;
  status?: BookingStatus;
}

// ---------------------------------------------------------------------------
// Repo interfaces (§14.2: get(id), list(filter) + entity mutations)
// ---------------------------------------------------------------------------

export interface ServicesRepo {
  get(id: string): Promise<Service | null>;
  list(filter?: ServiceFilter): Promise<Service[]>;
  create(input: ServiceCreate): Promise<Service>;
  update(id: string, patch: ServicePatch): Promise<Service | null>;
}
export interface EmployeesRepo {
  get(id: string): Promise<Employee | null>;
  list(filter?: EmployeeFilter): Promise<Employee[]>;
  create(input: EmployeeCreate): Promise<Employee>;
  update(id: string, patch: EmployeePatch): Promise<Employee | null>;
}
export interface WorkingHoursRepo {
  get(id: string): Promise<WorkingHours | null>;
  list(filter?: WorkingHoursFilter): Promise<WorkingHours[]>;
  create(input: WorkingHoursCreate): Promise<WorkingHours>;
  update(id: string, patch: WorkingHoursPatch): Promise<WorkingHours | null>;
}
export interface TimeOffRepo {
  get(id: string): Promise<TimeOff | null>;
  list(filter?: TimeOffFilter): Promise<TimeOff[]>;
  create(input: TimeOffCreate): Promise<TimeOff>;
  update(id: string, patch: TimeOffPatch): Promise<TimeOff | null>;
}
export interface BookingsRepo {
  get(id: string): Promise<Booking | null>;
  list(filter?: BookingFilter): Promise<Booking[]>;
  create(input: BookingCreate): Promise<Booking>;
  update(id: string, patch: BookingPatch): Promise<Booking | null>;
}
export interface SettingsRepo {
  get(): Promise<SalonSettings | null>;
  update(patch: SettingsPatch): Promise<SalonSettings | null>;
}

export interface Repos {
  services: ServicesRepo;
  employees: EmployeesRepo;
  workingHours: WorkingHoursRepo;
  timeOff: TimeOffRepo;
  bookings: BookingsRepo;
  settings: SettingsRepo;
}

// ---------------------------------------------------------------------------
// Factory (§4 layer 2: mandatory scope)
// ---------------------------------------------------------------------------

export function createRepos(db: DrizzleDb, scope: SalonScope): Repos {
  const salonId = scope?.salonId;
  if (typeof salonId !== "string" || salonId.length === 0) {
    throw new Error(
      "createRepos: a non-empty scope.salonId is required — a repo instance IS a salon scope (DESIGN §4)",
    );
  }
  return {
    services: makeServicesRepo(db, salonId),
    employees: makeEmployeesRepo(db, salonId),
    workingHours: makeWorkingHoursRepo(db, salonId),
    timeOff: makeTimeOffRepo(db, salonId),
    bookings: makeBookingsRepo(db, salonId),
    settings: makeSettingsRepo(db, salonId),
  };
}

// ---------------------------------------------------------------------------
// Mappers: row → domain object
// ---------------------------------------------------------------------------

type ServiceRow = typeof services.$inferSelect;
type EmployeeRow = typeof employees.$inferSelect;
type WorkingHoursRow = typeof workingHours.$inferSelect;
type TimeOffRow = typeof timeOff.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;
type SettingsRow = typeof salonSettings.$inferSelect;

function toService(r: ServiceRow): Service {
  return {
    id: r.id,
    salonId: r.salonId,
    name: r.name,
    durationMinutes: r.durationMinutes,
    bufferBeforeMinutes: r.bufferBeforeMinutes,
    bufferAfterMinutes: r.bufferAfterMinutes,
    priceCents: r.priceCents,
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toEmployee(r: EmployeeRow): Employee {
  return {
    id: r.id,
    salonId: r.salonId,
    displayName: r.displayName,
    title: r.title,
    active: r.active,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toWorkingHours(r: WorkingHoursRow): WorkingHours {
  return {
    id: r.id,
    salonId: r.salonId,
    employeeId: r.employeeId,
    isoWeekday: r.isoWeekday,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
  };
}

function toTimeOff(r: TimeOffRow): TimeOff {
  return {
    id: r.id,
    salonId: r.salonId,
    employeeId: r.employeeId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    reason: r.reason,
  };
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    salonId: r.salonId,
    serviceId: r.serviceId,
    employeeId: r.employeeId,
    customerId: r.customerId,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    blockedStart: r.blockedStart,
    blockedEnd: r.blockedEnd,
    status: r.status,
    createdVia: r.createdVia,
    notes: r.notes,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toSettings(r: SettingsRow): SalonSettings {
  return {
    salonId: r.salonId,
    gapThresholdMinutes: r.gapThresholdMinutes,
    slotGranularityMinutes: r.slotGranularityMinutes,
    updatedAt: r.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Entity repos — every query is salon-scoped
// ---------------------------------------------------------------------------

function makeServicesRepo(db: DrizzleDb, salonId: string): ServicesRepo {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(services)
        .where(and(eq(services.id, id), eq(services.salonId, salonId)))
        .limit(1);
      return rows[0] ? toService(rows[0]) : null;
    },

    async list(filter: ServiceFilter = {}) {
      const conds: SQL[] = [eq(services.salonId, salonId)];
      if (filter.active !== undefined) conds.push(eq(services.active, filter.active));
      const rows = await db.select().from(services).where(and(...conds));
      return rows.map(toService);
    },

    async create(input) {
      const rows = await db
        .insert(services)
        .values({
          salonId,
          name: input.name,
          durationMinutes: input.durationMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
          bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
          priceCents: input.priceCents ?? 0,
          active: input.active ?? true,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("services create: no row returned");
      return toService(row);
    },

    async update(id, patch) {
      const rows = await db
        .update(services)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(services.id, id), eq(services.salonId, salonId)))
        .returning();
      return rows[0] ? toService(rows[0]) : null;
    },
  };
}

function makeEmployeesRepo(db: DrizzleDb, salonId: string): EmployeesRepo {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), eq(employees.salonId, salonId)))
        .limit(1);
      return rows[0] ? toEmployee(rows[0]) : null;
    },

    async list(filter: EmployeeFilter = {}) {
      const conds: SQL[] = [eq(employees.salonId, salonId)];
      if (filter.active !== undefined) conds.push(eq(employees.active, filter.active));
      const rows = await db.select().from(employees).where(and(...conds));
      return rows.map(toEmployee);
    },

    async create(input) {
      const rows = await db
        .insert(employees)
        .values({
          salonId,
          displayName: input.displayName,
          title: input.title ?? null,
          active: input.active ?? true,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("employees create: no row returned");
      return toEmployee(row);
    },

    async update(id, patch) {
      const rows = await db
        .update(employees)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(employees.id, id), eq(employees.salonId, salonId)))
        .returning();
      return rows[0] ? toEmployee(rows[0]) : null;
    },
  };
}

function makeWorkingHoursRepo(db: DrizzleDb, salonId: string): WorkingHoursRepo {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(workingHours)
        .where(and(eq(workingHours.id, id), eq(workingHours.salonId, salonId)))
        .limit(1);
      return rows[0] ? toWorkingHours(rows[0]) : null;
    },

    async list(filter: WorkingHoursFilter = {}) {
      const conds: SQL[] = [eq(workingHours.salonId, salonId)];
      if (filter.employeeId !== undefined) conds.push(eq(workingHours.employeeId, filter.employeeId));
      if (filter.isoWeekday !== undefined) conds.push(eq(workingHours.isoWeekday, filter.isoWeekday));
      const rows = await db.select().from(workingHours).where(and(...conds));
      return rows.map(toWorkingHours);
    },

    async create(input) {
      const rows = await db
        .insert(workingHours)
        .values({
          salonId,
          employeeId: input.employeeId,
          isoWeekday: input.isoWeekday,
          startMinute: input.startMinute,
          endMinute: input.endMinute,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("working_hours create: no row returned");
      return toWorkingHours(row);
    },

    async update(id, patch) {
      const rows = await db
        .update(workingHours)
        .set(patch)
        .where(and(eq(workingHours.id, id), eq(workingHours.salonId, salonId)))
        .returning();
      return rows[0] ? toWorkingHours(rows[0]) : null;
    },
  };
}

function makeTimeOffRepo(db: DrizzleDb, salonId: string): TimeOffRepo {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(timeOff)
        .where(and(eq(timeOff.id, id), eq(timeOff.salonId, salonId)))
        .limit(1);
      return rows[0] ? toTimeOff(rows[0]) : null;
    },

    async list(filter: TimeOffFilter = {}) {
      const conds: SQL[] = [eq(timeOff.salonId, salonId)];
      if (filter.employeeId !== undefined) conds.push(eq(timeOff.employeeId, filter.employeeId));
      const rows = await db.select().from(timeOff).where(and(...conds));
      return rows.map(toTimeOff);
    },

    async create(input) {
      const rows = await db
        .insert(timeOff)
        .values({
          salonId,
          employeeId: input.employeeId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("time_off create: no row returned");
      return toTimeOff(row);
    },

    async update(id, patch) {
      const rows = await db
        .update(timeOff)
        .set(patch)
        .where(and(eq(timeOff.id, id), eq(timeOff.salonId, salonId)))
        .returning();
      return rows[0] ? toTimeOff(rows[0]) : null;
    },
  };
}

function makeBookingsRepo(db: DrizzleDb, salonId: string): BookingsRepo {
  return {
    async get(id) {
      const rows = await db
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.salonId, salonId)))
        .limit(1);
      return rows[0] ? toBooking(rows[0]) : null;
    },

    async list(filter: BookingFilter = {}) {
      const conds: SQL[] = [eq(bookings.salonId, salonId)];
      if (filter.employeeId !== undefined) conds.push(eq(bookings.employeeId, filter.employeeId));
      if (filter.customerId !== undefined) conds.push(eq(bookings.customerId, filter.customerId));
      if (filter.status !== undefined) conds.push(eq(bookings.status, filter.status));
      const rows = await db.select().from(bookings).where(and(...conds));
      return rows.map(toBooking);
    },

    async create(input) {
      const rows = await db
        .insert(bookings)
        .values({
          salonId,
          serviceId: input.serviceId,
          employeeId: input.employeeId,
          customerId: input.customerId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          blockedStart: input.blockedStart,
          blockedEnd: input.blockedEnd,
          status: input.status ?? "confirmed",
          createdVia: input.createdVia ?? "customer",
          notes: input.notes ?? null,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("bookings create: no row returned");
      return toBooking(row);
    },

    async update(id, patch) {
      const rows = await db
        .update(bookings)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(bookings.id, id), eq(bookings.salonId, salonId)))
        .returning();
      return rows[0] ? toBooking(rows[0]) : null;
    },
  };
}

function makeSettingsRepo(db: DrizzleDb, salonId: string): SettingsRepo {
  return {
    async get() {
      const rows = await db
        .select()
        .from(salonSettings)
        .where(eq(salonSettings.salonId, salonId))
        .limit(1);
      return rows[0] ? toSettings(rows[0]) : null;
    },

    async update(patch) {
      const rows = await db
        .update(salonSettings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(salonSettings.salonId, salonId))
        .returning();
      return rows[0] ? toSettings(rows[0]) : null;
    },
  };
}
