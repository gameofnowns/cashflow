import { prisma } from "./db";
import {
  COGS_RATES,
  COGS_BUFFER,
  VAT_RETURN_RATE,
  type ProjectType,
  type MonthlyBreakdown,
} from "./types";

/**
 * Calculate COGS for a set of milestone amounts given a project type.
 * Applies the type-specific rate plus the 10% buffer.
 * COGS = Sum(milestone_amount × cogs_rate[type]) × 1.10
 */
export function calculateCOGS(
  totalMilestoneAmount: number,
  projectType: ProjectType
): number {
  return totalMilestoneAmount * COGS_RATES[projectType] * COGS_BUFFER;
}

/**
 * Calculate VAT return for a quarter's COGS.
 * ~50% of AP is from NL vendors → effective return ~10% of quarterly COGS.
 * Returns land 1-2 months after quarter end.
 */
export function calculateVATReturn(quarterlyCOGS: number): number {
  return quarterlyCOGS * VAT_RETURN_RATE;
}

/**
 * Get the month (YYYY-MM) when a VAT return lands for a given quarter.
 * Q1 (Jan-Mar) → May, Q2 (Apr-Jun) → Aug, Q3 (Jul-Sep) → Nov, Q4 (Oct-Dec) → Feb next year
 */
export function getVATReturnMonth(quarterEndMonth: number, year: number): string {
  const mapping: Record<number, { month: number; yearOffset: number }> = {
    3: { month: 5, yearOffset: 0 },   // Q1 → May
    6: { month: 8, yearOffset: 0 },   // Q2 → Aug
    9: { month: 11, yearOffset: 0 },  // Q3 → Nov
    12: { month: 2, yearOffset: 1 },  // Q4 → Feb next year
  };
  const target = mapping[quarterEndMonth];
  if (!target) throw new Error(`Invalid quarter end month: ${quarterEndMonth}`);
  const targetYear = year + target.yearOffset;
  return `${targetYear}-${String(target.month).padStart(2, "0")}`;
}

/**
 * Format a date to YYYY-MM string.
 */
function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Generate the 12-month rolling cash flow forecast.
 *
 * 3-layer payment timing:
 * - Layer 1 (Current AR): Unmatched AR items from Exact, bucketed by actual DueDate
 * - Layer 2 (Billable AR): Won project milestones (pending + invoiced), using real project timing
 * - Layer 3 (Forecasted AR): Pipeline milestones from Dynamics
 *
 * Matched AR items already updated their milestones to "invoiced" with real DueDates,
 * so they flow through Layer 2 automatically — no double-counting.
 */
export async function generateForecast(
  startDate: Date = new Date()
): Promise<MonthlyBreakdown[]> {
  const currentMonthKey = toMonthKey(startDate);
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    months.push(toMonthKey(d));
  }

  // Fetch all active projects with milestones
  const projects = await prisma.project.findMany({
    where: { status: { in: ["won", "active", "in_production", "committed", "pipeline"] } },
    include: { milestones: true },
  });

  // Fetch latest financial snapshot (for bank balance only — AR total no longer used for forecast)
  const latestSnapshot = await prisma.financialSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
  });

  // Fetch unmatched AR items — these are real invoices not linked to any project
  // They contribute to operating cash by their actual due date
  const unmatchedAr = await prisma.arLineItem.findMany({
    where: { matchStatus: "unmatched" },
  });

  // Bucket unmatched AR by due date (floor past-due into current month)
  const unmatchedArByMonth: Record<string, number> = {};
  for (const item of unmatchedAr) {
    const monthKey = toMonthKey(item.dueDate);
    // If overdue (past due date), bucket into current month
    const effectiveMonth = monthKey < currentMonthKey ? currentMonthKey : monthKey;
    unmatchedArByMonth[effectiveMonth] = (unmatchedArByMonth[effectiveMonth] || 0) + item.amount;
  }

  // Fetch overhead budgets for the forecast period
  const overheads = await prisma.overheadBudget.findMany();
  const overheadByMonth: Record<string, number> = {};
  for (const oh of overheads) {
    overheadByMonth[toMonthKey(oh.month)] = oh.amount;
  }

  // Bucket milestones by month and confidence tier
  const billableByMonth: Record<string, number> = {};
  const forecastedByMonth: Record<string, number> = {};
  const cogsByMonthWon: Record<string, number> = {};
  const cogsByMonthPipeline: Record<string, number> = {};

  for (const project of projects) {
    const type = project.projectType as ProjectType;
    const isWon = project.confidenceTier === "won";

    for (const ms of project.milestones) {
      if (ms.status === "received") continue;

      const monthKey = toMonthKey(ms.expectedDate);
      // Floor past-due milestones into current month
      const effectiveMonth = monthKey < currentMonthKey ? currentMonthKey : monthKey;

      if (isWon) {
        billableByMonth[effectiveMonth] = (billableByMonth[effectiveMonth] || 0) + ms.amount;
        cogsByMonthWon[effectiveMonth] =
          (cogsByMonthWon[effectiveMonth] || 0) + calculateCOGS(ms.amount, type);
      } else {
        forecastedByMonth[effectiveMonth] = (forecastedByMonth[effectiveMonth] || 0) + ms.amount;
        cogsByMonthPipeline[effectiveMonth] =
          (cogsByMonthPipeline[effectiveMonth] || 0) + calculateCOGS(ms.amount, type);
      }
    }
  }

  // Calculate quarterly COGS for VAT returns
  const vatByMonth: Record<string, number> = {};
  const quarterEnds = [3, 6, 9, 12];
  const startYear = startDate.getFullYear();
  for (let yearOffset = -1; yearOffset <= 1; yearOffset++) {
    const yr = startYear + yearOffset;
    for (const qEnd of quarterEnds) {
      let quarterCOGS = 0;
      for (let m = qEnd - 2; m <= qEnd; m++) {
        const mk = `${yr}-${String(m).padStart(2, "0")}`;
        quarterCOGS += (cogsByMonthWon[mk] || 0) + (cogsByMonthPipeline[mk] || 0);
      }
      if (quarterCOGS > 0) {
        const returnMonth = getVATReturnMonth(qEnd, yr);
        vatByMonth[returnMonth] = (vatByMonth[returnMonth] || 0) + calculateVATReturn(quarterCOGS);
      }
    }
  }

  // Build monthly breakdown with rolling cash position
  const bankBalance = latestSnapshot?.bankBalance ?? 0;

  let runningOperating = bankBalance;
  const result: MonthlyBreakdown[] = [];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const currentAr = unmatchedArByMonth[month] || 0;
    const billable = billableByMonth[month] || 0;
    const forecasted = forecastedByMonth[month] || 0;
    const cogsWon = cogsByMonthWon[month] || 0;
    const cogsPipeline = cogsByMonthPipeline[month] || 0;
    const vat = vatByMonth[month] || 0;
    const overhead = overheadByMonth[month] || 0;

    // Operating = bank + unmatched AR (by due date) + won milestones - COGS + VAT - overhead
    runningOperating =
      runningOperating + currentAr + billable - cogsWon + vat - overhead;

    // Forecasted = operating + pipeline
    const forecastedCash = runningOperating + forecasted - cogsPipeline;

    result.push({
      month,
      currentAr,
      billableAr: billable,
      forecastedAr: forecasted,
      cogsWon,
      cogsPipeline,
      vatReturn: vat,
      overhead,
      operatingCash: Math.round(runningOperating * 100) / 100,
      forecastedCash: Math.round(forecastedCash * 100) / 100,
    });
  }

  return result;
}
