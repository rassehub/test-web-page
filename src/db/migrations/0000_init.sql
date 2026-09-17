-- TASK-104 — Sprint 1 initial schema.
-- Source of truth: docs/DESIGN.md §3.1–§3.9, §14.3 (staff_users CHECKs,
-- superseding §3.7's single XOR CHECK), §3.10 (exclusion constraint, verbatim).
-- Applied by scripts/migrate.mjs (NOT drizzle-kit journal format).
-- PostgreSQL 16: gen_random_uuid() is built-in.

-- §3.10: btree_gist enables `employee_id WITH =` (uuid) inside the gist EXCLUDE.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- §3.1 salons
CREATE TABLE salons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL CONSTRAINT salons_slug_key UNIQUE,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Europe/Helsinki',
  address     text,
  phone       text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- §3.2 salon_settings — 1:1 with salon (REQ-006 threshold)
CREATE TABLE salon_settings (
  salon_id                uuid PRIMARY KEY REFERENCES salons (id) ON DELETE CASCADE,
  gap_threshold_minutes   integer NOT NULL DEFAULT 45
    CONSTRAINT salon_settings_gap_positive CHECK (gap_threshold_minutes > 0),
  slot_granularity_minutes integer NOT NULL DEFAULT 15
    CONSTRAINT salon_settings_granularity_range CHECK (slot_granularity_minutes BETWEEN 5 AND 60),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- §3.3 services (REQ-002)
CREATE TABLE services (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id             uuid NOT NULL REFERENCES salons (id) ON DELETE CASCADE,
  name                 text NOT NULL,
  duration_minutes     integer NOT NULL DEFAULT 30
    CONSTRAINT services_duration_positive CHECK (duration_minutes > 0),
  buffer_before_minutes integer NOT NULL DEFAULT 0
    CONSTRAINT services_buffer_before_nonneg CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes  integer NOT NULL DEFAULT 0
    CONSTRAINT services_buffer_after_nonneg CHECK (buffer_after_minutes >= 0),
  price_cents          integer NOT NULL DEFAULT 0
    CONSTRAINT services_price_nonneg CHECK (price_cents >= 0),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_salon_name_unique UNIQUE (salon_id, name),
  -- Composite-FK target for bookings.service_id (§3.9).
  CONSTRAINT services_salon_id_unique UNIQUE (salon_id, id)
);

CREATE INDEX services_active_salon_idx ON services (salon_id) WHERE active;

-- §3.4 employees (REQ-003)
CREATE TABLE employees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id     uuid NOT NULL REFERENCES salons (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  title        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Composite-FK target for working_hours/time_off/bookings (§3.5, §3.6, §3.9).
  CONSTRAINT employees_salon_id_unique UNIQUE (salon_id, id)
);

-- §3.5 working_hours (REQ-003)
CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL,
  employee_id uuid NOT NULL,
  iso_weekday smallint NOT NULL
    CONSTRAINT working_hours_weekday_range CHECK (iso_weekday BETWEEN 1 AND 7),
  start_minute integer NOT NULL
    CONSTRAINT working_hours_start_range CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   integer NOT NULL
    CONSTRAINT working_hours_end_range CHECK (end_minute BETWEEN 0 AND 1439),
  CONSTRAINT working_hours_start_before_end CHECK (start_minute < end_minute),
  CONSTRAINT working_hours_employee_fk
    FOREIGN KEY (salon_id, employee_id) REFERENCES employees (salon_id, id) ON DELETE CASCADE
);

CREATE INDEX working_hours_employee_weekday_idx ON working_hours (employee_id, iso_weekday);

-- §3.6 time_off (REQ-003)
CREATE TABLE time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id    uuid NOT NULL,
  employee_id uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  CONSTRAINT time_off_start_before_end CHECK (starts_at < ends_at),
  CONSTRAINT time_off_employee_fk
    FOREIGN KEY (salon_id, employee_id) REFERENCES employees (salon_id, id) ON DELETE CASCADE
);

CREATE INDEX time_off_employee_start_idx ON time_off (employee_id, starts_at);

-- §3.7/§14.3 staff_users — role-consistency CHECKs are §14.3 (binding).
CREATE TABLE staff_users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL CONSTRAINT staff_users_email_key UNIQUE,
  password_hash      text NOT NULL,
  role               text NOT NULL
    CONSTRAINT staff_users_role_allowed
      CHECK (role IN ('owner', 'employee', 'platform_admin')),
  salon_id           uuid REFERENCES salons (id),
  employee_id        uuid,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- §14.3: role='platform_admin' ⟺ is_platform_admin.
  CONSTRAINT staff_users_platform_role_iff_flag
    CHECK ((role = 'platform_admin') = is_platform_admin),
  -- §14.3: role='employee' ⇒ employee_id IS NOT NULL.
  CONSTRAINT staff_users_employee_requires_link
    CHECK (role <> 'employee' OR employee_id IS NOT NULL),
  -- §14.3: role='owner' ⇒ employee_id IS NULL.
  CONSTRAINT staff_users_owner_unlinked
    CHECK (role <> 'owner' OR employee_id IS NULL),
  -- §14.3: role='platform_admin' ⇒ salon_id IS NULL AND employee_id IS NULL.
  CONSTRAINT staff_users_admin_unscoped
    CHECK (role <> 'platform_admin' OR (salon_id IS NULL AND employee_id IS NULL)),
  -- §14.3: NOT is_platform_admin ⇒ salon_id IS NOT NULL.
  CONSTRAINT staff_users_nonadmin_scoped
    CHECK (is_platform_admin OR salon_id IS NOT NULL),
  CONSTRAINT staff_users_employee_fk
    FOREIGN KEY (salon_id, employee_id) REFERENCES employees (salon_id, id)
);

-- §3.7 staff_sessions (DB-backed sessions — no Redis)
CREATE TABLE staff_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL CONSTRAINT staff_sessions_token_hash_key UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_sessions_expires_idx ON staff_sessions (expires_at);

-- §3.8 customers — global, deliberately NOT salon-scoped
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text,
  phone         text,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customers_email_unique ON customers (email) WHERE email IS NOT NULL;

-- §3.9 bookings (REQ-004/005/006/007/012)
CREATE TABLE bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id      uuid NOT NULL REFERENCES salons (id) ON DELETE CASCADE,
  service_id    uuid NOT NULL,
  employee_id   uuid NOT NULL,
  customer_id   uuid NOT NULL REFERENCES customers (id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  blocked_start timestamptz NOT NULL,
  blocked_end   timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'confirmed'
    CONSTRAINT bookings_status_allowed
      CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  created_via   text NOT NULL DEFAULT 'customer'
    CONSTRAINT bookings_created_via_allowed
      CHECK (created_via IN ('customer', 'admin_manual')),
  notes         text,
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_start_before_end CHECK (starts_at < ends_at),
  -- §3.9: blocked range must contain the actual range (zero-buffer allowed).
  CONSTRAINT bookings_blocked_contains_actual
    CHECK (blocked_start <= starts_at AND ends_at <= blocked_end),
  -- Composite-FK target for Sprint 4 audit trails (§3.9).
  CONSTRAINT bookings_salon_id_unique UNIQUE (salon_id, id),
  -- §4 layer 1: cross-salon references are structurally impossible (REQ-012).
  CONSTRAINT bookings_service_fk
    FOREIGN KEY (salon_id, service_id) REFERENCES services (salon_id, id),
  CONSTRAINT bookings_employee_fk
    FOREIGN KEY (salon_id, employee_id) REFERENCES employees (salon_id, id)
);

CREATE INDEX bookings_salon_start_idx ON bookings (salon_id, starts_at);
CREATE INDEX bookings_employee_confirmed_start_idx
  ON bookings (employee_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX bookings_customer_idx ON bookings (customer_id);

-- §3.10 anti-double-booking exclusion constraint (REQ-007) — DESIGN verbatim.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_double_booking
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(blocked_start, blocked_end, '[)') WITH &&
  )
  WHERE (status = 'confirmed');
