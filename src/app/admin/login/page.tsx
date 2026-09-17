/**
 * TASK-109 (audit F2) — /admin/login (DESIGN §2.2, REQ-009).
 *
 * Server shell for the admin login form. Unauthenticated /admin/* traffic is
 * redirected here by src/middleware.ts (§5.2 — UX only, not a boundary);
 * authentication itself is POST /api/auth/login.
 */
import type { Metadata } from "next";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Admin login",
};

export default function AdminLoginPage() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <section style={{ width: "100%", maxWidth: "22rem", padding: "0 1rem" }}>
        <h1>Admin login</h1>
        <LoginForm />
      </section>
    </main>
  );
}
