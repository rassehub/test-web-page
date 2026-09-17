/**
 * TASK-103 test DB harness.
 *
 * Two isolation modes (TASK-103 brief: "transaction/rollback or unique-per-run data"):
 *
 *  - TX MODE (constraint + exclusion specs): begin() checks out an exclusive
 *    client and opens a transaction; finish() rolls it back, so every test's
 *    writes vanish. Intentionally-failing statements go through expectCode(),
 *    which wraps them in a SAVEPOINT so the outer transaction stays usable
 *    after a deliberate constraint violation (Postgres aborts the transaction
 *    otherwise).
 *
 *  - PLAIN MODE (repo scoping + auth specs): NO outer transaction. The code
 *    under test (repos, auth lib) is allowed to manage its own transactions
 *    (e.g. Drizzle db.transaction()), which would COMMIT/ROLLBACK an outer
 *    test transaction and silently break rollback isolation. These specs use
 *    unique-per-run seed data + cascade cleanup instead (see Seeder).
 *
 * GATING: specs call getDbStatus() at module top level and use
 * describe.skipIf() so they stay skipped until TASK-104 migrations exist.
 * The probe fails fast (no hang) when Postgres is down or DATABASE_URL unset.
 *
 * Activation (automatic on every run — no code change needed):
 *   1. docker compose up -d postgres
 *   2. copy .env.example -> .env, set DATABASE_URL
 *   3. npm run db:migrate (TASK-104, incl. DESIGN §3.10 exclusion SQL)
 *   4. npm test
 */
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool, type DatabaseError, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

/** Every table Sprint 1 DDL must create (DESIGN §3.1–§3.9). */
export const REQUIRED_TABLES = [
  "salons",
  "salon_settings",
  "services",
  "employees",
  "working_hours",
  "time_off",
  "staff_users",
  "staff_sessions",
  "customers",
  "bookings",
] as const;

/** DESIGN §3.10 exclusion constraint name. */
export const EXCLUSION_CONSTRAINT_NAME = "bookings_no_double_booking";

/** PostgreSQL error codes used by these specs. */
export const PG = {
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  EXCLUSION_VIOLATION: "23P01",
} as const;

export interface DbStatus {
  /** All REQUIRED_TABLES exist (TASK-104 migrations applied). */
  ready: boolean;
  /** §3.10 exclusion constraint exists (TASK-104 custom SQL applied). */
  exclusionReady: boolean;
  /** Human-readable reason when not ready. */
  reason: string;
}

let statusPromise: Promise<DbStatus> | null = null;

/** Cached per worker; safe to call at module top level in every spec file. */
export function getDbStatus(): Promise<DbStatus> {
  statusPromise ??= probe();
  return statusPromise;
}

async function probe(): Promise<DbStatus> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return { ready: false, exclusionReady: false, reason: "DATABASE_URL not set (copy .env.example to .env)" };
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const res = await client.query<{ oid: string | null }>("SELECT to_regclass($1) AS oid", [`public.${table}`]);
      if (res.rows[0]?.oid == null) missing.push(table);
    }
    if (missing.length > 0) {
      return {
        ready: false,
        exclusionReady: false,
        reason: `migrations not applied (TASK-104 pending); missing tables: ${missing.join(", ")}`,
      };
    }
    const ex = await client.query(
      `SELECT 1
         FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
        WHERE c.contype = 'x'
          AND rel.relname = 'bookings'
          AND c.conname = $1`,
      [EXCLUSION_CONSTRAINT_NAME],
    );
    const exclusionReady = (ex.rowCount ?? 0) === 1;
    return {
      ready: true,
      exclusionReady,
      reason: exclusionReady ? "ok" : `exclusion constraint '${EXCLUSION_CONSTRAINT_NAME}' missing (TASK-104 must apply DESIGN §3.10 SQL)`,
    };
  } catch (err) {
    return {
      ready: false,
      exclusionReady: false,
      reason: `postgres unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Dedicated pool for one spec file (files run in separate workers). */
export function makePool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (see .env.example)");
  return new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3_000 });
}

export class Db {
  private readonly pool: Pool | null;
  private client: PoolClient | null = null;
  private savepointSeq = 0;

  constructor(pool: Pool | null) {
    this.pool = pool;
  }

  /** TX mode: acquire exclusive client + BEGIN. */
  async begin(): Promise<void> {
    const pool = this.requirePool();
    if (this.client) throw new Error("Db.begin(): transaction already open");
    this.client = await pool.connect();
    await this.client.query("BEGIN");
  }

  /** TX mode: ROLLBACK + release. Never throws; safe in afterEach. */
  async finish(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  /** Drizzle handle over the tx client (TX mode) or the pool (PLAIN mode). */
  get drizzle(): NodePgDatabase {
    if (this.client) return drizzle(this.client);
    return drizzle(this.requirePool());
  }

  async exec(sql: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult<QueryResultRow>> {
    if (this.client) return this.client.query(sql, params as unknown[]);
    return this.requirePool().query(sql, params as unknown[]);
  }

  /** First row or null. */
  async one<Row extends QueryResultRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<Row | null> {
    const res = await this.exec(sql, params);
    return (res.rows[0] as Row | undefined) ?? null;
  }

  /**
   * Run a statement EXPECTED to fail, inside a SAVEPOINT so the surrounding
   * transaction remains usable. Returns the PostgreSQL error code actually
   * raised (null = statement unexpectedly succeeded — the test's
   * `expect(res.code).toBe(...)` will then fail, which is the point).
   * Requires TX mode.
   */
  async expectCode(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ code: string | null; message: string | null }> {
    const client = this.client;
    if (!client) throw new Error("Db.expectCode(): requires TX mode (call begin() first)");
    const sp = `sp_${++this.savepointSeq}`;
    await client.query(`SAVEPOINT ${sp}`);
    let code: string | null = null;
    let message: string | null = null;
    try {
      await client.query(sql, params as unknown[]);
    } catch (err) {
      const dbErr = err as DatabaseError;
      code = typeof dbErr.code === "string" ? dbErr.code : null;
      message = err instanceof Error ? err.message : String(err);
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    return { code, message };
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error("DB pool unavailable — spec should be skipped (migrations/Postgres not ready)");
    return this.pool;
  }
}
