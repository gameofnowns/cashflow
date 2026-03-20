import { NextRequest, NextResponse } from "next/server";

const AUTH_PASSWORD = process.env.APP_PASSWORD || "";

export function middleware(request: NextRequest) {
  // Skip if no password is set
  if (!AUTH_PASSWORD) return NextResponse.next();

  const path = request.nextUrl.pathname;

  // Skip static HTML files
  if (path.endsWith(".html")) return NextResponse.next();

  // Skip auth callback routes (OAuth redirects)
  if (path.startsWith("/api/auth/")) return NextResponse.next();

  // Skip debug endpoints
  if (path.startsWith("/api/debug/")) return NextResponse.next();

  // Skip dashboard API endpoints (used by static HTML dashboards)
  if (path.startsWith("/api/dashboard/")) return NextResponse.next();

  // Skip chat API
  if (path.startsWith("/api/chat")) return NextResponse.next();

  // Skip sync endpoints
  if (path.startsWith("/api/sync/")) return NextResponse.next();

  // Skip other API endpoints
  if (path.startsWith("/api/")) return NextResponse.next();

  // Skip quote alignment page
  if (path.startsWith("/quote-alignment")) return NextResponse.next();

  // Check for auth cookie
  const authCookie = request.cookies.get("app_auth")?.value;
  if (authCookie === AUTH_PASSWORD) return NextResponse.next();

  // Check for login form submission
  if (path === "/api/login" && request.method === "POST") return NextResponse.next();

  // Redirect to login for all other page requests
  if (path !== "/login") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
