# Requirements Ledger — Hair Salon Platform

Single source of truth. Sole writer: Scrum Lead. Status changes only from verified evidence.

Status values: `planned` | `in-progress` | `done`

Stack decisions (approved): Next.js + TypeScript · PostgreSQL + Drizzle ORM · guest booking with optional accounts · gap rule = hard block, per-salon configurable threshold (default 45 min) · timezone Europe/Helsinki.

| ID | Description | Acceptance criteria | Status |
|----|-------------|---------------------|--------|
| REQ-001 | Customer landing page per salon: info, services with prices, opening hours; modern, clean, responsive | Given a salon exists, landing renders its service list, prices, hours; Lighthouse mobile performance ≥ 90; usable at 360–1440 px | planned |
| REQ-002 | Admin CRUD for per-salon service catalog: name, duration, buffer time, price, active flag | Owner can create/edit/deactivate services; inactive services never appear in customer flow or slot computation | in-progress |
| REQ-003 | Admin CRUD for employees per salon: profile, weekly working hours, days off | Working-hours change reflects in slot engine same day; overlapping schedule entries rejected at save | in-progress |
| REQ-004 | Guest reservation flow: salon → service → stylist (or any) → free slot → name + phone/email → confirmation | Booking persists with status `confirmed`; server rejects stale/invalid slot submissions (409/422) even when client is bypassed | in-progress |
| REQ-005 | Slot engine: free slots = working hours − bookings − service buffers; Europe/Helsinki, DST-correct | Unit tests cover: DST transition days (March/Oct), buffer application, booked-interval exclusion, multi-stylist calendars | done |
| REQ-006 | Gap-fragmentation rule: hard block any booking that would leave a residual gap fragment < threshold; threshold is per-salon setting, default 45 min | Test: 3 h gap, mid-gap booking leaving < 45 min fragment → rejected 422; changing threshold changes outcome; admin manual bookings bypass (A1, approved) | in-progress |
| REQ-007 | Concurrency safety: no double-booking, enforced at DB level | Test: 20 parallel requests for the same slot → exactly 1 succeeds; no orphaned rows | done |
| REQ-008 | Employee calendar UI: day/week views, create/edit/cancel bookings, visual gap indicators | Owner sees all salon bookings; employee sees only own; cancel frees the slot immediately | in-progress |
| REQ-009 | Staff auth with roles: owner (per salon), employee (per salon); session-based | Wrong credentials → 401; employee accessing other stylist's calendar or salon settings → 403; tests cover both roles | done |
| REQ-010 | Optional customer accounts: register/login, booking history, self-cancellation | Guest and account bookings coexist in one flow; account user sees own history; self-cancel frees slot and (later) triggers email | planned |
| REQ-011 | Email notifications: booking confirmation + cancellation confirmation via SMTP (A2, approved) | With valid SMTP env config, confirmation sends on booking; failed send is logged and does not fail the booking; secrets only via env vars, `.env.example` documents them | in-progress |
| REQ-012 | Multi-salon data model: `salons` table; all resources scoped by `salon_id` (A3, approved) | Data-layer tests prove every query is salon-scoped; salon A data is never returned in salon B contexts; platform admin can CRUD salons | done |
| REQ-013 | Deployment: Podman compose (app + Postgres), Caddy reverse proxy, HTTPS | `podman compose up` runs full stack with healthchecks; Caddyfile passes InfraSec header review; smoke test books a slot end-to-end | planned |
