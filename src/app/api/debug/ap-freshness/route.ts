import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { fetchPayables, parseExactDate } from "@/lib/exact";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * GET /api/debug/ap-freshness
 *
 * Compares dashboard AP to a live Exact fetch.
 * Shows last sync time and staleness.
 */
export async function GET(request: Request) {
  console.log("[DEBUG] ap-freshness");

  try {
    const now = new Date();
    const currentMonthKey = toMonthKey(now);

    // 1. Get dashboard AP total (current month)
    let dashboardApTotal = 0;
    let dashboardApItems = 0;
    try {
      const baseUrl = new URL(request.url).origin;
      const dashRes = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      const dashData = await dashRes.json();
      for (const m of dashData.months || []) {
        dashboardApTotal += m.ap || 0;
        dashboardApItems += (m.apItems || []).length;
      }
    } catch {
      dashboardApTotal = -1; // flag as unavailable
    }

    // 2. Fetch AP live from Exact (with timeout)
    let liveApTotal = 0;
    let liveApItems = 0;
    let liveApCurrentMonth = 0;
    let liveError: string | null = null;
    try {
      const payables = await Promise.race([
        fetchPayables(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AP fetch timeout (10s)")), 10000)
        ),
      ]);
      liveApTotal = payables.total;
      liveApItems = payables.items.length;

      // Sum just current month
      for (const item of payables.items) {
        const dueDate = parseExactDate(item.DueDate);
        const mk = toMonthKey(dueDate);
        if (mk <= currentMonthKey) {
          liveApCurrentMonth += item.Amount || 0;
        }
      }
    } catch (e) {
      liveError = e instanceof Error ? e.message : "Unknown error";
    }

    // 3. Last sync timestamp
    const lastSnapshot = await prisma.financialSnapshot.findFirst({
      orderBy: { snapshotDate: "desc" },
      select: { snapshotDate: true, totalAp: true },
    });

    const lastSyncTime = lastSnapshot?.snapshotDate || null;
    const minutesSinceSync = lastSyncTime
      ? Math.round(
          (now.getTime() - lastSyncTime.getTime()) / (1000 * 60)
        )
      : null;

    // 4. Compare
    const difference = Math.abs(dashboardApTotal - liveApTotal);
    const isStale = difference > 1000;

    return NextResponse.json(
      {
        status: liveError
          ? "ERROR"
          : isStale
            ? "WARN"
            : "PASS",
        dashboard: {
          apTotal: Math.round(dashboardApTotal * 100) / 100,
          apItemCount: dashboardApItems,
          note: "AP is fetched LIVE on each dashboard call, not from DB",
        },
        liveExact: liveError
          ? { error: liveError }
          : {
              apTotal: Math.round(liveApTotal * 100) / 100,
              apItemCount: liveApItems,
              apCurrentMonth: Math.round(liveApCurrentMonth * 100) / 100,
            },
        comparison: liveError
          ? { error: "Cannot compare — live fetch failed" }
          : {
              difference: Math.round(difference * 100) / 100,
              percentDiff:
                dashboardApTotal > 0
                  ? Math.round((difference / dashboardApTotal) * 10000) / 100
                  : 0,
              isStale,
              note: difference < 100
                ? "Values match (within €100)"
                : `Difference of €${difference.toFixed(0)} detected`,
            },
        lastSync: {
          timestamp: lastSyncTime?.toISOString() || null,
          minutesAgo: minutesSinceSync,
          snapshotApTotal: lastSnapshot?.totalAp
            ? Math.round(lastSnapshot.totalAp * 100) / 100
            : null,
          note: "Snapshot AP may differ from live — AP changes between syncs",
        },
      },
      { headers: CORS }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed", status: "ERROR" },
      { status: 500, headers: CORS }
    );
  }
}
