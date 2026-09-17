/**
 * TASK-105 — argon2id password wrappers (DESIGN §3.7, §5.1; REQ-009).
 *
 * Parameters are the OWASP Password Storage Cheat Sheet minimums for
 * argon2id: m = 19456 KiB, t = 2, p = 1. [CONF: HIGH] [SRC: STANDARD]
 *
 * Argument order note: @node-rs/argon2 2.x verify() takes (hashed, password)
 * — verified against upstream packages/argon2/index.d.ts (v2.2.1 on main,
 * semver-compatible with our ^2.0.0).
 */
import { hash, verify, type Options } from "@node-rs/argon2";

const OWASP_ARGON2ID: Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, OWASP_ARGON2ID);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return verify(passwordHash, password);
}
