import { NextRequest, NextResponse } from "next/server";

const AUTH_PASSWORD = process.env.APP_PASSWORD || "";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Skip if no password is set
  if (!AUTH_PASSWORD) return NextResponse.next();

  // ALLOW LIST — these paths bypass auth entirely
  if (
    path.endsWith(".html") ||
    path.startsWith("/api/") ||
    path.startsWith("/stream") ||
    path.startsWith("/quote-alignment") ||
    path === "/login" ||
    path === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = request.cookies.get("app_auth")?.value;
  if (authCookie === AUTH_PASSWORD) {
    return NextResponse.next();
  }

  // Redirect to login
  return NextResponse.redirect(new URL("/login", request.url));
}
