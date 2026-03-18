import { NextRequest, NextResponse } from "next/server";

const AUTH_PASSWORD = process.env.APP_PASSWORD || "";

export async function POST(request: NextRequest) {
  const body = await request.json();

  if (!AUTH_PASSWORD || body.password !== AUTH_PASSWORD) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set("app_auth", AUTH_PASSWORD, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: "/",
  });

  return response;
}
