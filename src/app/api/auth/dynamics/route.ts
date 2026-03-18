import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/dynamics";

export async function GET() {
  try {
    const url = getAuthorizationUrl();
    return NextResponse.redirect(url);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate auth URL" },
      { status: 500 }
    );
  }
}
