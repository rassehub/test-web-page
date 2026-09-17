# Hair Salon Reservation Platform

Multi-salon hair salon reservation platform: public guest booking, staff admin with calendar, role-based access control (owner / employee / platform admin), and a DST-correct slot engine.

Full system design: [docs/DESIGN.md](docs/DESIGN.md) · Requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) · Sprint plan: [docs/SPRINTS.md](docs/SPRINTS.md)

## Stack

- Next.js (App Router) + TypeScript (strict)
- PostgreSQL 16 + Drizzle ORM (`drizzle-orm`, `pg`, `drizzle-kit`)
- Domain deps: `luxon` (slot math), `zod` (input validation), `@node-rs/argon2` (password hashing)
- Vitest for tests

## Prerequisites

- Node.js 20+
- Docker (for PostgreSQL; app runs on host in dev)

## Setup

```bash
cp .env.example .env      # then edit — never commit real secrets
docker compose up -d postgres
npm install
npm run db:migrate        # apply DB migrations
npm run bootstrap:admin -- --email you@example.com   # platform admin (prompts for password)
npm run dev               # http://localhost:3000
```

## Commands

| Command | Purpose |
|---|---|
| `docker compose up -d postgres` | Start dev PostgreSQL 16 (healthchecked, persistent volume) |
| `npm run dev` | Next.js dev server |
| `npm test` | Run Vitest suite |
| `npm run db:generate` | Generate SQL migrations from `src/db/schema.ts` (drizzle-kit) |
| `npm run db:migrate` | Apply migrations to the database |
| `npm run db:push` | Push schema directly (dev shortcut) |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run bootstrap:admin` | Create/update a `platform_admin` staff user (see below) |

Health check (requires dev server + Postgres running):

```bash
curl http://localhost:3000/api/health
# 200 {"status":"ok"} when DB reachable, 503 {"status":"error"} otherwise
```

## Admin bootstrap (`npm run bootstrap:admin`)

Creates or updates a `platform_admin` staff user — the supported way to get a
first admin login without hand-written SQL. After bootstrapping, sign in at
`/admin/login`.

```bash
npm run bootstrap:admin -- --email you@example.com
# prompts for the password (hidden input, min 12 chars); for scripting:
npm run bootstrap:admin -- --email you@example.com --password '<12+ chars>'
```

- `--password` on the command line is visible in `ps` output — prefer the
  interactive prompt; the flag exists for non-interactive use. The secret is
  never written to any file.
- Re-running with the same email updates the password hash.
- Exit codes: `0` success · `1` usage/validation error · `2` conflict (email
  already belongs to a non-admin user — roles are never converted silently).

## Environment

Copy [.env.example](.env.example) to `.env` and fill in real values. `.env` is gitignored; `.env.example` documents the contract (`DATABASE_URL` now, `SMTP_*` from Sprint 5 per DESIGN §8). Never commit real secrets.
