import { NextRequest, NextResponse } from "next/server";

const AUTH_PASSWORD = process.env.APP_PASSWORD || "";

export function middleware(request: NextRequest) {
  // Skip if no password is set
  if (!AUTH_PASSWORD) return NextResponse.next();

  // Skip auth callback routes (OAuth redirects)
  if (request.nextUrl.pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // Skip debug endpoints and pages
  if (request.nextUrl.pathname.startsWith("/api/debug/")) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith("/quote-alignment")) {
    return NextResponse.next();
  }

  // Skip webhook endpoints that use their own auth
  if (request.nextUrl.pathname === "/api/sync/dynamics" && request.method === "POST") {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = request.cookies.get("app_auth")?.value;
  if (authCookie === AUTH_PASSWORD) {
    return NextResponse.next();
  }

  // Check for login form submission
  if (request.nextUrl.pathname === "/api/login" && request.method === "POST") {
    return NextResponse.next();
  }

  // Show login page for all other requests
  if (request.nextUrl.pathname !== "/login") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login).*)"],
};
