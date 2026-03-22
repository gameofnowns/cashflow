import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
 * GET /api/debug/overdue-analysis
 *
 * Shows how much of the current month's inflows are actually overdue items
 * that were floored into the current month. Breaks down by age bucket.
 */
export async function GET() {
  console.log("[DEBUG] overdue-analysis");

  try {
    const now = new Date();
    const currentMonthKey = toMonthKey(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // ─── Current AR overdue ───
    const unmatchedAr = await prisma.arLineItem.findMany({
      where: { matchStatus: "unmatched" },
    });

    const currentArOverdue: {
      invoiceNumber: string;
      accountName: string;
      amount: number;
      originalDueDate: string;
      daysOverdue: number;
      ageBucket: string;
    }[] = [];

    const currentArGenuine: typeof currentArOverdue = [];

    for (const item of unmatchedAr) {
      const mk = toMonthKey(item.dueDate);
      if (mk > currentMonthKey) continue; // future months — not relevant

      const isOverdue = item.dueDate < monthStart;
      const daysOverdue = isOverdue
        ? Math.floor(
            (now.getTime() - item.dueDate.getTime()) / (1000 * 60 * 60 * 24)
          )
        : 0;

      const entry = {
        invoiceNumber: item.invoiceNumber,
        accountName: item.accountName,
        amount: item.amount,
        originalDueDate: item.dueDate.toISOString(),
        daysOverdue,
        ageBucket: !isOverdue
          ? "current"
          : daysOverdue <= 30
            ? "1-30 days"
            : daysOverdue <= 60
              ? "31-60 days"
              : daysOverdue <= 90
                ? "61-90 days"
                : "90+ days",
      };

      if (isOverdue) {
        currentArOverdue.push(entry);
      } else {
        currentArGenuine.push(entry);
      }
    }

    // ─── Billable AR overdue ───
    const wonProjects = await prisma.project.findMany({
      where: { confidenceTier: { in: ["won", "committed"] } },
      include: { milestones: true },
    });

    const billableOverdue: {
      project: string;
      milestone: string | null;
      amount: number;
      originalDate: string;
      daysOverdue: number;
      ageBucket: string;
    }[] = [];

    const billableGenuine: typeof billableOverdue = [];

    for (const p of wonProjects) {
      for (const ms of p.milestones) {
        if (ms.status === "received") continue;
        const mk = toMonthKey(ms.expectedDate);
        if (mk > currentMonthKey) continue;

        const isOverdue = ms.expectedDate < monthStart;
        const daysOverdue = isOverdue
          ? Math.floor(
              (now.getTime() - ms.expectedDate.getTime()) /
                (1000 * 60 * 60 * 24)
            )
          : 0;

        const entry = {
          project: p.name,
          milestone: ms.label,
          amount: ms.amount,
          originalDate: ms.expectedDate.toISOString(),
          daysOverdue,
          ageBucket: !isOverdue
            ? "current"
            : daysOverdue <= 30
              ? "1-30 days"
              : daysOverdue <= 60
                ? "31-60 days"
                : daysOverdue <= 90
                  ? "61-90 days"
                  : "90+ days",
        };

        if (isOverdue) {
          billableOverdue.push(entry);
        } else {
          billableGenuine.push(entry);
        }
      }
    }

    // ─── Summaries ───
    const currentArOverdueTotal = currentArOverdue.reduce(
      (s, i) => s + i.amount,
      0
    );
    const currentArGenuineTotal = currentArGenuine.reduce(
      (s, i) => s + i.amount,
      0
    );
    const currentArTotal = currentArOverdueTotal + currentArGenuineTotal;

    const billableOverdueTotal = billableOverdue.reduce(
      (s, i) => s + i.amount,
      0
    );
    const billableGenuineTotal = billableGenuine.reduce(
      (s, i) => s + i.amount,
      0
    );
    const billableTotal = billableOverdueTotal + billableGenuineTotal;

    // Age bucket summaries
    const ageBuckets = ["1-30 days", "31-60 days", "61-90 days", "90+ days"];
    const currentArByAge = Object.fromEntries(
      ageBuckets.map((b) => [
        b,
        {
          count: currentArOverdue.filter((i) => i.ageBucket === b).length,
          total: currentArOverdue
            .filter((i) => i.ageBucket === b)
            .reduce((s, i) => s + i.amount, 0),
        },
      ])
    );
    const billableByAge = Object.fromEntries(
      ageBuckets.map((b) => [
        b,
        {
          count: billableOverdue.filter((i) => i.ageBucket === b).length,
          total: billableOverdue
            .filter((i) => i.ageBucket === b)
            .reduce((s, i) => s + i.amount, 0),
        },
      ])
    );

    const overduePercent =
      currentArTotal + billableTotal > 0
        ? ((currentArOverdueTotal + billableOverdueTotal) /
            (currentArTotal + billableTotal)) *
          100
        : 0;

    return NextResponse.json(
      {
        status:
          overduePercent > 50
            ? "WARN"
            : overduePercent > 0
              ? "INFO"
              : "PASS",
        month: currentMonthKey,
        summary: {
          totalCurrentMonthInflows: Math.round(currentArTotal + billableTotal),
          totalOverdue: Math.round(
            currentArOverdueTotal + billableOverdueTotal
          ),
          totalGenuine: Math.round(
            currentArGenuineTotal + billableGenuineTotal
          ),
          overduePercent: Math.round(overduePercent * 10) / 10,
        },
        currentAr: {
          total: Math.round(currentArTotal),
          overdueTotal: Math.round(currentArOverdueTotal),
          genuineTotal: Math.round(currentArGenuineTotal),
          overduePercent:
            currentArTotal > 0
              ? Math.round((currentArOverdueTotal / currentArTotal) * 1000) / 10
              : 0,
          byAgeBucket: currentArByAge,
          overdueItems: currentArOverdue.sort(
            (a, b) => b.daysOverdue - a.daysOverdue
          ),
          genuineItems: currentArGenuine,
        },
        billableAr: {
          total: Math.round(billableTotal),
          overdueTotal: Math.round(billableOverdueTotal),
          genuineTotal: Math.round(billableGenuineTotal),
          overduePercent:
            billableTotal > 0
              ? Math.round(
                  (billableOverdueTotal / billableTotal) * 1000
                ) / 10
              : 0,
          byAgeBucket: billableByAge,
          overdueItems: billableOverdue.sort(
            (a, b) => b.daysOverdue - a.daysOverdue
          ),
          genuineItems: billableGenuine,
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
