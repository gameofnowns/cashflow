import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/dynamics";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/?dynamics_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/?dynamics_error=no_code", request.url)
    );
  }

  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(
      new URL("/?dynamics_connected=true", request.url)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Token exchange failed";
    return NextResponse.redirect(
      new URL(`/?dynamics_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
