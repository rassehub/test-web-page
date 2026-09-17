import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// TASK-105 — DESIGN §5.2 middleware split. Edge-runtime safe by construction:
// cookie PRESENCE check only — no DB, no argon2/pg imports (those live in
// route handlers / lib on the Node runtime). This is UX routing, never a
// security boundary; real authn/authz happen via requireRole.
const SESSION_COOKIE = "staff_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) {
    return NextResponse.next();
  }
  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"],
};
