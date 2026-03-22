import { NextResponse } from "next/server";
import { syncExactOnline, isConnected } from "@/lib/exact";

export const maxDuration = 60; // Exact sync can be slow (pagination)

export async function POST() {
  try {
    const connected = await isConnected();
    if (!connected) {
      return NextResponse.json(
        { error: "Exact Online not connected. Visit /api/auth/exact to authorize." },
        { status: 401 }
      );
    }

    const result = await syncExactOnline();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 }
    );
  }
}
