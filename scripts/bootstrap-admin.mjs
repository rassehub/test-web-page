#!/usr/bin/env node
/**
 * TASK-109 (audit F10) — platform_admin bootstrap CLI.
 *
 * Upsert semantics for staff_users (§14.3 role-consistency CHECKs apply):
 *   - email unknown                  → INSERT role='platform_admin',
 *                                     is_platform_admin=true, salon_id/employee_id NULL
 *   - email exists as platform_admin → UPDATE password hash (re-runnable)
 *   - email exists as another role   → refuse, exit 2 — never convert silently
 *
 * Password sources (the secret is never written to any file):
 *   - omitted + STDIN is a TTY → hidden readline prompt (preferred)
 *   - omitted + no TTY         → fail (exit 1); non-interactive callers must use --password
 *   - --password <value>       → scripting escape hatch; visible in `ps`, avoid interactively
 *
 * Usage:
 *   npm run bootstrap:admin -- --email admin@example.com
 *   npm run bootstrap:admin -- --email admin@example.com --password '<12+ chars>'
 *
 * Exit codes: 0 success · 1 usage/validation · 2 conflict.
 */
import "dotenv/config";
import { hash } from "@node-rs/argon2";
import readline from "node:readline/promises";
import { Client } from "pg";

// MUST stay in sync with OWASP_ARGON2ID in src/lib/auth/password.ts (TASK-105):
// argon2id OWASP minimums m = 19456 KiB, t = 2, p = 1. Not imported from the
// TS module because package.json has no TS-runner dependency (no tsx/ts-node).
// TODO(TASK-402): dedup — import from lib once a TS runner is added.
const OWASP_ARGON2ID = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usage(message) {
  console.error(`bootstrap-admin: ${message}`);
  process.exit(1);
}

function conflict(message) {
  console.error(`bootstrap-admin: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const key = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (key !== "--email" && key !== "--password") {
      usage(`unknown argument '${token}' (expected --email / --password)`);
    }
    let value = inline;
    if (value === undefined) {
      i += 1;
      value = argv[i];
    }
    if (value === undefined) {
      usage(`${key} requires a value`);
    }
    if (out[key.slice(2)] !== undefined) {
      usage(`${key} given twice`);
    }
    out[key.slice(2)] = value;
  }
  return out;
}

/**
 * Hidden prompt. With output = stdout TTY, readline enables terminal raw
 * mode (kernel echo off) and echoes each keystroke itself via
 * process.stdout.write — muting that write while question() runs hides the
 * input without any extra dependency.
 */
async function promptHidden(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write(query);
  process.stdout.write = () => true; // mute
  try {
    return await rl.question("");
  } finally {
    process.stdout.write = realWrite;
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.email === undefined) {
    usage("missing required --email");
  }
  // Login (src/app/api/auth/login/route.ts) matches on trim().toLowerCase().
  const email = args.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    usage(`invalid --email '${args.email}'`);
  }

  let password;
  if (args.password !== undefined) {
    password = args.password;
  } else if (process.stdin.isTTY) {
    password = await promptHidden(
      `Password for ${email} (min ${MIN_PASSWORD_LENGTH} chars): `,
    );
  } else {
    usage("no --password given and STDIN is not a TTY (nothing to prompt)");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    usage(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    usage("DATABASE_URL is not set (copy .env.example to .env)");
  }

  const passwordHash = await hash(password, OWASP_ARGON2ID);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const existing = await client.query(
      "SELECT id, role FROM staff_users WHERE email = $1",
      [email],
    );
    const row = existing.rows[0];

    if (row === undefined) {
      try {
        await client.query(
          `INSERT INTO staff_users
             (email, password_hash, role, is_platform_admin, salon_id, employee_id)
           VALUES ($1, $2, 'platform_admin', true, NULL, NULL)`,
          [email, passwordHash],
        );
        console.log(`bootstrap-admin: created platform_admin ${email}`);
      } catch (err) {
        if (err && err.code === "23505") {
          conflict(`${email} was created concurrently — re-run to update its password`);
        }
        throw err;
      }
    } else if (row.role === "platform_admin") {
      await client.query(
        "UPDATE staff_users SET password_hash = $1, updated_at = now() WHERE id = $2",
        [passwordHash, row.id],
      );
      console.log(`bootstrap-admin: updated password for platform_admin ${email}`);
    } else {
      conflict(
        `${email} already exists with role '${row.role}' — refusing to convert to platform_admin`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`bootstrap-admin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
