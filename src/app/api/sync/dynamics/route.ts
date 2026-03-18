import { NextResponse } from "next/server";
import { syncDynamics, isConfigured } from "@/lib/dynamics";

export async function POST() {
  try {
    if (!isConfigured()) {
      return NextResponse.json(
        { error: "Dynamics CRM not configured. Set DYNAMICS_TENANT_ID, DYNAMICS_CLIENT_ID, and DYNAMICS_CLIENT_SECRET." },
        { status: 400 }
      );
    }

    const result = await syncDynamics();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 }
    );
  }
}
