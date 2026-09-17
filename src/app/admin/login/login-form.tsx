"use client";

/**
 * TASK-109 (audit F2) — client login form for /admin/login.
 *
 * POSTs JSON {email, password} to /api/auth/login (§5.1). On 200 the
 * staff_session cookie is already stored (same-origin fetch honors
 * Set-Cookie) and we replace to /admin. On 401 a single generic
 * "Invalid credentials" is shown — no detail differentiation, mirroring
 * the API's no-account-existence-leak contract.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CSSProperties, FormEvent } from "react";

const labelStyle: CSSProperties = {
  display: "block",
  marginTop: "1rem",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.25rem",
  padding: "0.5rem",
  boxSizing: "border-box",
  font: "inherit",
};

export default function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = JSON.stringify({
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    });
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (res.ok) {
        router.replace("/admin");
        return; // keep pending=true through navigation
      }
      setError(res.status === 401 ? "Invalid credentials" : "Login failed");
    } catch {
      setError("Login failed");
    }
    setPending(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email" style={labelStyle}>
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="username"
        style={inputStyle}
      />
      <label htmlFor="password" style={labelStyle}>
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        required
        autoComplete="current-password"
        style={inputStyle}
      />
      {error !== null && (
        <p role="alert" style={{ color: "#b00020", marginTop: "1rem" }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        style={{ marginTop: "1.5rem", padding: "0.5rem 1.25rem", font: "inherit" }}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
