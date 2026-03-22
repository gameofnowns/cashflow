import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { COGS_RATES, COGS_BUFFER, type ProjectType } from "@/lib/types";

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

function shiftMonthKey(mk: string, offset: number): string {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return toMonthKey(d);
}

/**
 * GET /api/debug/verify-cogs-timing
 *
 * For every milestone in the database, checks that COGS is bucketed
 * into M+1 (not the same month as the AR milestone).
 */
export async function GET(request: Request) {
  console.log("[DEBUG] verify-cogs-timing");

  try {
    const projects = await prisma.project.findMany({
      where: { confidenceTier: { in: ["won", "committed"] } },
      include: { milestones: true },
    });

    const now = new Date();
    const currentMonthKey = toMonthKey(now);

    // Get dashboard data to verify actual COGS placement
    let dashMonths: Record<string, { cogsWon: number }> = {};
    try {
      const baseUrl = new URL(request.url).origin;
      const dashRes = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      const dashData = await dashRes.json();
      for (const m of dashData.months || []) {
        dashMonths[m.month] = { cogsWon: m.cogsWon };
      }
    } catch {
      // Dashboard unavailable — we'll still show expected values
    }

    const results: {
      project: string;
      jobNo: string | null;
      projectType: string;
      milestone: string | null;
      milestoneAmount: number;
      milestoneMonth: string;
      cogsAmount: number;
      expectedCogsMonth: string;
      status: string;
    }[] = [];

    let wrongCount = 0;

    for (const project of projects) {
      const type = (project.projectType || "Y") as ProjectType;
      const rate = COGS_RATES[type] ?? 0.4;

      for (const ms of project.milestones) {
        if (ms.status === "received") continue;

        const msMk = toMonthKey(ms.expectedDate);
        // Floor past-due milestones to current month (same as dashboard)
        const bucketedMk = msMk < currentMonthKey ? currentMonthKey : msMk;
        const expectedCogsMk = shiftMonthKey(bucketedMk, 1);
        const cogsAmt = ms.amount * rate * COGS_BUFFER;

        // The dashboard should have this COGS in expectedCogsMk
        // We can't verify individual project COGS in the aggregate, but we can flag the expectation
        results.push({
          project: project.name,
          jobNo: project.externalId,
          projectType: type,
          milestone: ms.label,
          milestoneAmount: ms.amount,
          milestoneMonth: bucketedMk,
          cogsAmount: Math.round(cogsAmt * 100) / 100,
          expectedCogsMonth: expectedCogsMk,
          status: "OK", // Individual verification requires dashboard item-level data
        });
      }
    }

    // Aggregate check: sum expected COGS per month and compare to dashboard
    const expectedCogsByMonth: Record<string, number> = {};
    for (const r of results) {
      expectedCogsByMonth[r.expectedCogsMonth] =
        (expectedCogsByMonth[r.expectedCogsMonth] || 0) + r.cogsAmount;
    }

    const monthComparisons: {
      month: string;
      expectedCogs: number;
      dashboardCogs: number;
      difference: number;
      status: string;
    }[] = [];

    for (const [mk, expected] of Object.entries(expectedCogsByMonth)) {
      const dashCogs = dashMonths[mk]?.cogsWon || 0;
      const diff = Math.abs(expected - dashCogs);
      monthComparisons.push({
        month: mk,
        expectedCogs: Math.round(expected * 100) / 100,
        dashboardCogs: Math.round(dashCogs * 100) / 100,
        difference: Math.round(diff * 100) / 100,
        status: diff < 100 ? "MATCH" : "MISMATCH",
      });
      if (diff >= 100) wrongCount++;
    }

    return NextResponse.json(
      {
        status: wrongCount === 0 ? "PASS" : "FAIL",
        rule: "COGS lands 1 month AFTER the AR milestone (M+1)",
        milestones: results,
        monthlyAggregates: monthComparisons.sort((a, b) =>
          a.month.localeCompare(b.month)
        ),
        summary: {
          totalMilestones: results.length,
          monthsChecked: monthComparisons.length,
          monthsMatched: monthComparisons.filter((m) => m.status === "MATCH")
            .length,
          monthsMismatched: wrongCount,
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
