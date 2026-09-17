#!/usr/bin/env node
/**
 * TASK-302d — Sprint 3 addendum: idempotent demo seed for local dev/demo.
 *
 * The only salon-creation path is the platform-admin API (TASK-105); this
 * script seeds a walk-through-ready catalog without touching auth:
 *   - salon "demo-salon" (upsert by slug — name/contact refreshed on re-run)
 *   - salon_settings §3.2 defaults 45/15 (ON CONFLICT DO NOTHING)
 *   - 4 salon-scoped services (ON CONFLICT (salon_id, name) DO NOTHING)
 *   - 2 active employees (select-by-(salon, display_name), insert if absent)
 *   - working_hours Mon–Fri 09:00–17:00 both, Sat 10:00–15:00 Aino only
 *     (existence check per (employee, iso_weekday) — dumb on purpose)
 *
 * NO staff users (npm run bootstrap:admin covers that), NO bookings,
 * NO customers — pure catalog.
 *
 * Usage: npm run seed:demo   (requires DATABASE_URL; see .env.example)
 * Exit codes: 0 success · 1 usage/DB error (single transaction, all-or-nothing).
 */
import "dotenv/config";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("seed-demo: DATABASE_URL is not set (copy .env.example to .env)");
  process.exit(1);
}

const SALON = {
  slug: "demo-salon",
  name: "Demo Salon",
  timezone: "Europe/Helsinki",
  address: "Mannerheimintie 1, 00100 Helsinki",
  phone: "+358 40 123 4567",
  email: "demo@demo-salon.example",
};

const SERVICES = [
  { name: "Haircut", duration: 45, before: 0, after: 10, price: 4500 },
  { name: "Color", duration: 120, before: 15, after: 15, price: 12000 },
  { name: "Beard trim", duration: 30, before: 0, after: 5, price: 2500 },
  { name: "Wash & Style", duration: 60, before: 0, after: 10, price: 5500 },
];

function weekdays(from, to, startMinute, endMinute) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    isoWeekday: from + i,
    startMinute,
    endMinute,
  }));
}

const EMPLOYEES = [
  {
    displayName: "Aino Virtanen",
    title: "Senior stylist",
    hours: [
      ...weekdays(1, 5, 540, 1020), // Mon–Fri 09:00–17:00
      { isoWeekday: 6, startMinute: 600, endMinute: 900 }, // Sat 10:00–15:00
    ],
  },
  {
    displayName: "Mikko Korhonen",
    title: "Stylist",
    hours: weekdays(1, 5, 540, 1020), // Mon–Fri 09:00–17:00
  },
];

const client = new Client({ connectionString: url });
await client.connect();

try {
  await client.query("BEGIN");

  // 1. Salon — select by slug, then insert or refresh name/contact.
  const existing = await client.query("SELECT id FROM salons WHERE slug = $1", [
    SALON.slug,
  ]);
  let salonId;
  let salonCreated;
  if (existing.rows[0] === undefined) {
    const inserted = await client.query(
      `INSERT INTO salons (slug, name, timezone, address, phone, email)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [SALON.slug, SALON.name, SALON.timezone, SALON.address, SALON.phone, SALON.email],
    );
    salonId = inserted.rows[0].id;
    salonCreated = true;
  } else {
    salonId = existing.rows[0].id;
    await client.query(
      `UPDATE salons
         SET name = $1, timezone = $2, address = $3, phone = $4, email = $5,
             updated_at = now()
       WHERE id = $6`,
      [SALON.name, SALON.timezone, SALON.address, SALON.phone, SALON.email, salonId],
    );
    salonCreated = false;
  }

  // 2. salon_settings — §3.2 defaults 45/15 via column defaults.
  await client.query(
    "INSERT INTO salon_settings (salon_id) VALUES ($1) ON CONFLICT (salon_id) DO NOTHING",
    [salonId],
  );

  // 3. Services — salon-scoped, keyed by (salon_id, name).
  let servicesCreated = 0;
  for (const s of SERVICES) {
    const res = await client.query(
      `INSERT INTO services
         (salon_id, name, duration_minutes, buffer_before_minutes,
          buffer_after_minutes, price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (salon_id, name) DO NOTHING`,
      [salonId, s.name, s.duration, s.before, s.after, s.price],
    );
    servicesCreated += res.rowCount ?? 0;
  }

  // 4. Employees — deterministic select by (salon, display_name).
  let employeesCreated = 0;
  let hoursCreated = 0;
  for (const e of EMPLOYEES) {
    const found = await client.query(
      "SELECT id FROM employees WHERE salon_id = $1 AND display_name = $2",
      [salonId, e.displayName],
    );
    let employeeId;
    if (found.rows[0] === undefined) {
      const inserted = await client.query(
        `INSERT INTO employees (salon_id, display_name, title, active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [salonId, e.displayName, e.title],
      );
      employeeId = inserted.rows[0].id;
      employeesCreated += 1;
    } else {
      employeeId = found.rows[0].id;
    }

    // 5. working_hours — dumb existence check per (employee, iso_weekday).
    for (const h of e.hours) {
      const has = await client.query(
        "SELECT 1 FROM working_hours WHERE employee_id = $1 AND iso_weekday = $2",
        [employeeId, h.isoWeekday],
      );
      if ((has.rowCount ?? 0) > 0) continue;
      await client.query(
        `INSERT INTO working_hours (salon_id, employee_id, iso_weekday, start_minute, end_minute)
         VALUES ($1, $2, $3, $4, $5)`,
        [salonId, employeeId, h.isoWeekday, h.startMinute, h.endMinute],
      );
      hoursCreated += 1;
    }
  }

  await client.query("COMMIT");

  console.log(`seed-demo: salon    ${SALON.slug} (${salonCreated ? "created" : "updated"})`);
  console.log("seed-demo: settings ensured (gap 45 / granularity 15)");
  console.log(
    `seed-demo: services  ${servicesCreated} created, ${SERVICES.length - servicesCreated} already present`,
  );
  console.log(
    `seed-demo: employees ${employeesCreated} created, ${EMPLOYEES.length - employeesCreated} already present`,
  );
  const totalHours = EMPLOYEES.reduce((n, e) => n + e.hours.length, 0);
  console.log(
    `seed-demo: hours     ${hoursCreated} created, ${totalHours - hoursCreated} already present`,
  );
  console.log(`seed-demo: done — salon URL: /s/${SALON.slug} (http://localhost:3000/s/${SALON.slug})`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`seed-demo: FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
