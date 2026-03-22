import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/exact";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/?exact_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/?exact_error=no_code", request.url)
    );
  }

  try {
    await exchangeCodeForTokens(code);
    return NextResponse.redirect(
      new URL("/?exact_connected=true", request.url)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Token exchange failed";
    return NextResponse.redirect(
      new URL(`/?exact_error=${encodeURIComponent(msg)}`, request.url)
    );
  }
}
