import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const authPw = process.env.APP_PASSWORD || "";

  // No password set — everyone is authenticated
  if (!authPw) {
    return NextResponse.json({ authenticated: true });
  }

  const cookie = request.cookies.get("app_auth")?.value;
  if (cookie === authPw) {
    return NextResponse.json({ authenticated: true });
  }

  return NextResponse.json({ authenticated: false }, { status: 401 });
}
