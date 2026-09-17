#!/usr/bin/env node
/**
 * TASK-104 — plain SQL migration runner.
 *
 * DEVIATION from drizzle-kit's journal format (documented in TASK-104 report):
 * applies src/db/migrations/*.sql directly in lexical order, each file inside
 * a single transaction, recording applied filenames in schema_migrations.
 * Already-applied files are skipped (idempotent re-runs).
 *
 * Usage: npm run db:migrate   (requires DATABASE_URL; see .env.example)
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "migrations",
);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set (copy .env.example to .env)");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const seen = await client.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [file],
    );
    if ((seen.rowCount ?? 0) > 0) {
      console.log(`migrate: skip   ${file} (already applied)`);
      continue;
    }
    const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sqlText);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`migrate: apply  ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`migrate: FAILED ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
