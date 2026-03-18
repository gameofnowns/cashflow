import { NextResponse } from "next/server";
import { syncClickUp } from "@/lib/sync";

export async function POST() {
  try {
    const result = await syncClickUp();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 }
    );
  }
}
