import { NextResponse } from "next/server";

// Middleware is effectively disabled — auth is handled by the dashboard component itself.
// All routes pass through. The dashboard checks the auth cookie client-side
// and shows a login overlay if needed.
export function middleware() {
  return NextResponse.next();
}
