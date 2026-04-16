import { NextRequest, NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/exact";

export async function GET(request: NextRequest) {
  try {
    const popup = request.nextUrl.searchParams.get("popup") === "1";
    const url = getAuthorizationUrl(popup ? "popup" : undefined);
    return NextResponse.redirect(url);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate auth URL" },
      { status: 500 }
    );
  }
}
