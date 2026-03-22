import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { fetchPayables, parseExactDate } from "@/lib/exact";
import { COGS_RATES, COGS_BUFFER, VAT_RETURN_RATE, type ProjectType } from "@/lib/types";

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
 * GET /api/debug/reconcile-month?month=2026-03
 *
 * Independently computes every line item for a given month,
 * compares to the dashboard's values, and returns a reconciliation table.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month");

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: "Missing or invalid query param: month (format: YYYY-MM)" },
      { status: 400, headers: CORS }
    );
  }

  console.log(`[DEBUG] reconcile-month: ${month}`);

  try {
    const [year, monthNum] = month.split("-").map(Number);
    const monthStart = new Date(year, monthNum - 1, 1);
    const monthEnd = new Date(year, monthNum, 0, 23, 59, 59); // last day of month
    const currentMonthKey = toMonthKey(new Date());

    // ─── 1. Get dashboard values ───
    let dashboardMonth: Record<string, unknown> = {};
    try {
      const baseUrl = new URL(request.url).origin;
      const dashRes = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      const dashData = await dashRes.json();
      dashboardMonth =
        (dashData.months || []).find(
          (m: { month: string }) => m.month === month
        ) || {};
    } catch {
      dashboardMonth = { error: "Could not fetch dashboard data" };
    }

    // ─── 2. Independently compute each line ───

    // 2a. Current AR (unmatched invoices due this month)
    const allUnmatched = await prisma.arLineItem.findMany({
      where: { matchStatus: "unmatched" },
    });
    const unmatchedThisMonth = allUnmatched.filter((item) => {
      const mk = toMonthKey(item.dueDate);
      // Floor past-due to current month
      if (mk < currentMonthKey && month === currentMonthKey) return true;
      return mk === month;
    });
    const computedCurrentAr = unmatchedThisMonth.reduce(
      (s, i) => s + i.amount,
      0
    );

    // 2b. Billable AR (won/committed milestones due this month)
    const wonProjects = await prisma.project.findMany({
      where: { confidenceTier: { in: ["won", "committed"] } },
      include: { milestones: true },
    });
    const billableMilestones: {
      project: string;
      label: string | null;
      amount: number;
      date: string;
      status: string;
    }[] = [];
    for (const p of wonProjects) {
      for (const ms of p.milestones) {
        if (ms.status === "received") continue;
        const mk = toMonthKey(ms.expectedDate);
        const bucketed: string =
          mk < currentMonthKey && month === currentMonthKey
            ? currentMonthKey
            : mk;
        if (bucketed === month) {
          billableMilestones.push({
            project: p.name,
            label: ms.label,
            amount: ms.amount,
            date: ms.expectedDate.toISOString(),
            status: ms.status,
          });
        }
      }
    }
    const computedBillableAr = billableMilestones.reduce(
      (s, m) => s + m.amount,
      0
    );

    // 2c. COGS Won — milestones from PREVIOUS month (M-1)
    const prevMonthKey = (() => {
      const d = new Date(year, monthNum - 2, 1);
      return toMonthKey(d);
    })();
    let computedCogsWon = 0;
    const cogsItems: {
      project: string;
      milestone: string | null;
      milestoneMonth: string;
      amount: number;
      cogsAmount: number;
      type: string;
    }[] = [];
    for (const p of wonProjects) {
      const type = (p.projectType || "Y") as ProjectType;
      const rate = COGS_RATES[type] ?? 0.4;
      for (const ms of p.milestones) {
        if (ms.status === "received") continue;
        const mk = toMonthKey(ms.expectedDate);
        const bucketed =
          mk < currentMonthKey ? currentMonthKey : mk;
        // COGS for a milestone in prevMonth lands in THIS month
        if (bucketed === prevMonthKey) {
          const cogsAmt = ms.amount * rate * COGS_BUFFER;
          computedCogsWon += cogsAmt;
          cogsItems.push({
            project: p.name,
            milestone: ms.label,
            milestoneMonth: prevMonthKey,
            amount: ms.amount,
            cogsAmount: cogsAmt,
            type,
          });
        }
      }
    }

    // 2d. AP (live from Exact)
    let computedAp = 0;
    let apItems: { vendor: string; amount: number; dueDate: string }[] = [];
    try {
      const payables = await Promise.race([
        fetchPayables(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AP timeout")), 10000)
        ),
      ]);
      for (const item of payables.items) {
        const dueDate = parseExactDate(item.DueDate);
        const mk = toMonthKey(dueDate);
        const bucketed: string =
          mk < currentMonthKey && month === currentMonthKey
            ? currentMonthKey
            : mk;
        if (bucketed === month) {
          computedAp += item.Amount || 0;
          apItems.push({
            vendor: item.AccountName || "Unknown",
            amount: item.Amount || 0,
            dueDate: dueDate.toISOString(),
          });
        }
      }
    } catch (e) {
      apItems = [
        {
          vendor: "ERROR",
          amount: 0,
          dueDate: e instanceof Error ? e.message : "AP unavailable",
        },
      ];
    }

    // 2e. Overhead
    const overhead = await prisma.overheadBudget.findFirst({
      where: {
        month: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
    });
    const computedOverhead = overhead?.amount || 0;

    // ─── 3. Build reconciliation table ───
    const r = (n: number) => Math.round(n * 100) / 100;

    const lines = [
      {
        line: "Current AR",
        dashboardValue: r((dashboardMonth.currentAr as number) || 0),
        computedValue: r(computedCurrentAr),
        itemCount: unmatchedThisMonth.length,
      },
      {
        line: "Billable AR",
        dashboardValue: r((dashboardMonth.billableAr as number) || 0),
        computedValue: r(computedBillableAr),
        itemCount: billableMilestones.length,
      },
      {
        line: "AP",
        dashboardValue: r((dashboardMonth.ap as number) || 0),
        computedValue: r(computedAp),
        itemCount: apItems.length,
      },
      {
        line: "COGS Won",
        dashboardValue: r((dashboardMonth.cogsWon as number) || 0),
        computedValue: r(computedCogsWon),
        itemCount: cogsItems.length,
      },
      {
        line: "Overhead",
        dashboardValue: r((dashboardMonth.overhead as number) || 0),
        computedValue: r(computedOverhead),
        itemCount: overhead ? 1 : 0,
      },
    ].map((l) => ({
      ...l,
      difference: r(l.dashboardValue - l.computedValue),
      status:
        Math.abs(l.dashboardValue - l.computedValue) < 100
          ? ("match" as const)
          : ("MISMATCH" as const),
    }));

    const mismatches = lines.filter((l) => l.status === "MISMATCH");

    return NextResponse.json(
      {
        status: mismatches.length === 0 ? "PASS" : "FAIL",
        month,
        reconciliation: lines,
        details: {
          currentArItems: unmatchedThisMonth.map((i) => ({
            invoiceNumber: i.invoiceNumber,
            accountName: i.accountName,
            amount: i.amount,
            dueDate: i.dueDate.toISOString(),
          })),
          billableArItems: billableMilestones,
          cogsItems,
          apItems: apItems.slice(0, 50), // limit for readability
          overhead: overhead
            ? { month: toMonthKey(overhead.month), amount: overhead.amount }
            : null,
        },
        summary: {
          matched: lines.filter((l) => l.status === "match").length,
          mismatched: mismatches.length,
          total: lines.length,
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
