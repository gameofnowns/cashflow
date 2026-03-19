import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
} from "@/lib/dynamics-quotes";
import {
  COGS_RATES,
  COGS_BUFFER,
  VAT_RETURN_RATE,
  type ProjectType,
} from "@/lib/types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── Helpers ────────────────────────────────────────────────

function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function calcCOGS(amount: number, type: string): number {
  const rate = COGS_RATES[type as ProjectType] ?? 0.4;
  return amount * rate * COGS_BUFFER;
}

// Pipeline phase likelihood weights
const PHASE_WEIGHTS: Record<string, number> = {
  "1-Qualify": 0.10,
  "2-Develop": 0.30,
  "3-Propose": 0.90,
};

function phaseFromStepname(stepname: string | null): string {
  if (!stepname) return "unknown";
  if (stepname.includes("1")) return "1-Qualify";
  if (stepname.includes("2")) return "2-Develop";
  if (stepname.includes("3")) return "3-Propose";
  return stepname;
}

// ─── Types ──────────────────────────────────────────────────

interface MilestoneItem {
  projectName: string;
  jobNo: string | null;
  projectType: string;
  label: string | null;
  amount: number;
  expectedDate: string;
  status: string;
  trigger?: string;
}

interface MonthData {
  currentAr: number;
  currentArItems: MilestoneItem[];
  billableAr: number;
  billableArItems: MilestoneItem[];
  pipelinePhase1: number;
  pipelinePhase1Items: MilestoneItem[];
  pipelinePhase2: number;
  pipelinePhase2Items: MilestoneItem[];
  pipelinePhase3: number;
  pipelinePhase3Items: MilestoneItem[];
  cogsWon: number;
  cogsPhase1: number;
  cogsPhase2: number;
  cogsPhase3: number;
  vatReturn: number;
  overhead: number;
}

// ─── Main Handler ───────────────────────────────────────────

/**
 * GET /api/dashboard/cash-position
 *
 * Returns all data needed for the toggleable cash position dashboard:
 * - Layer 1: Current AR (Exact unmatched invoices)
 * - Layer 2: Billable AR (won project milestones from ClickUp, enriched by Dynamics)
 * - Layer 3: Pipeline AR, split by phase (1-Qualify, 2-Develop, 3-Propose)
 * - Outflows: COGS (per layer), VAT returns, overhead
 * - Bank balance (manual override supported)
 *
 * Query params:
 *   bankBalance — manual bank balance override (EUR). If not provided, uses Exact snapshot.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const manualBankBalance = searchParams.get("bankBalance");

  try {
    const now = new Date();
    const currentMonthKey = toMonthKey(now);

    // Build 12-month window
    const monthKeys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      monthKeys.push(toMonthKey(d));
    }

    // Initialize monthly data
    const months: Record<string, MonthData> = {};
    for (const mk of monthKeys) {
      months[mk] = {
        currentAr: 0, currentArItems: [],
        billableAr: 0, billableArItems: [],
        pipelinePhase1: 0, pipelinePhase1Items: [],
        pipelinePhase2: 0, pipelinePhase2Items: [],
        pipelinePhase3: 0, pipelinePhase3Items: [],
        cogsWon: 0, cogsPhase1: 0, cogsPhase2: 0, cogsPhase3: 0,
        vatReturn: 0, overhead: 0,
      };
    }

    // Helper to bucket into months (floor past-due into current month)
    function bucketMonth(date: Date): string | null {
      const mk = toMonthKey(date);
      if (mk < monthKeys[0]) return monthKeys[0]; // past due → current
      if (mk > monthKeys[monthKeys.length - 1]) return null; // beyond window
      return mk;
    }

    // ─── LAYER 1: Current AR (Exact unmatched invoices) ─────

    const unmatchedAr = await prisma.arLineItem.findMany({
      where: { matchStatus: "unmatched" },
    });

    for (const item of unmatchedAr) {
      const mk = bucketMonth(item.dueDate);
      if (!mk) continue;
      months[mk].currentAr += item.amount;
      months[mk].currentArItems.push({
        projectName: item.accountName,
        jobNo: item.jobNo,
        projectType: "—",
        label: item.invoiceNumber,
        amount: item.amount,
        expectedDate: item.dueDate.toISOString(),
        status: "invoiced",
      });
    }

    // ─── LAYER 2: Billable AR (won projects from DB) ────────

    const wonProjects = await prisma.project.findMany({
      where: {
        confidenceTier: { in: ["won", "committed"] },
      },
      include: { milestones: true },
    });

    for (const project of wonProjects) {
      const type = project.projectType || "Y";
      for (const ms of project.milestones) {
        if (ms.status === "received") continue;
        const mk = bucketMonth(ms.expectedDate);
        if (!mk) continue;
        months[mk].billableAr += ms.amount;
        months[mk].billableArItems.push({
          projectName: project.name,
          jobNo: project.externalId,
          projectType: type,
          label: ms.label,
          amount: ms.amount,
          expectedDate: ms.expectedDate.toISOString(),
          status: ms.status,
        });
        months[mk].cogsWon += calcCOGS(ms.amount, type);
      }
    }

    // ─── LAYER 3: Pipeline AR (Dynamics open opportunities) ─

    let pipelineData: {
      phase: string;
      opportunityName: string;
      jobNo: string | null;
      projectType: string | null;
      totalPrice: number;
      milestones: Array<{
        label: string;
        percentage: number;
        amount: number;
        trigger: string;
        estimatedDate: string;
      }>;
      hasQuote: boolean;
      estimatedCloseDate: string | null;
    }[] = [];

    try {
      const token = await getToken();

      // Fetch open opportunities with est. close date in next 12 months
      const todayStr = now.toISOString().split("T")[0];
      const cutoff = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const oppsResp = await dynamicsFetch(
        `/opportunities?$filter=statecode eq 0 and estimatedclosedate ge ${todayStr} and estimatedclosedate le ${cutoffStr}&$orderby=estimatedvalue desc&$top=100&$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,statuscode,stepname,salesstagecode`,
        token
      );

      for (const opp of oppsResp.value || []) {
        // Fetch most recent open quote
        let quoteToUse = null;
        const draftResp = await dynamicsFetch(
          `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 0&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
          token
        );
        quoteToUse = draftResp.value?.[0] || null;

        if (!quoteToUse) {
          const activeResp = await dynamicsFetch(
            `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 3&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
            token
          );
          quoteToUse = activeResp.value?.[0] || null;
        }

        const decoded = decodeQuote(
          {
            opportunityid: opp.opportunityid,
            name: opp.name,
            estimatedvalue: opp.estimatedvalue,
            estimatedclosedate: opp.estimatedclosedate,
          },
          quoteToUse
        );

        const phase = phaseFromStepname(opp.stepname);

        pipelineData.push({
          phase,
          opportunityName: decoded.opportunityName,
          jobNo: decoded.jobNo,
          projectType: decoded.projectType,
          totalPrice: decoded.totalPrice,
          milestones: decoded.milestones,
          hasQuote: !!quoteToUse,
          estimatedCloseDate: opp.estimatedclosedate || null,
        });

        // Bucket milestones by phase
        for (const ms of decoded.milestones) {
          const msDate = new Date(ms.estimatedDate);
          const mk = bucketMonth(msDate);
          if (!mk) continue;

          const type = decoded.projectType || "Y";
          const item: MilestoneItem = {
            projectName: decoded.opportunityName,
            jobNo: decoded.jobNo,
            projectType: type,
            label: ms.label,
            amount: ms.amount,
            expectedDate: ms.estimatedDate,
            status: "forecast",
            trigger: ms.trigger,
          };

          if (phase === "1-Qualify") {
            months[mk].pipelinePhase1 += ms.amount;
            months[mk].pipelinePhase1Items.push(item);
            months[mk].cogsPhase1 += calcCOGS(ms.amount, type);
          } else if (phase === "2-Develop") {
            months[mk].pipelinePhase2 += ms.amount;
            months[mk].pipelinePhase2Items.push(item);
            months[mk].cogsPhase2 += calcCOGS(ms.amount, type);
          } else {
            months[mk].pipelinePhase3 += ms.amount;
            months[mk].pipelinePhase3Items.push(item);
            months[mk].cogsPhase3 += calcCOGS(ms.amount, type);
          }
        }
      }
    } catch (e) {
      // Dynamics may not be connected — pipeline data will be empty
      console.error("Pipeline fetch failed:", e instanceof Error ? e.message : e);
    }

    // ─── OVERHEAD ───────────────────────────────────────────

    const overheads = await prisma.overheadBudget.findMany();
    for (const oh of overheads) {
      const mk = toMonthKey(oh.month);
      if (months[mk]) {
        months[mk].overhead = oh.amount;
      }
    }

    // ─── VAT RETURNS ────────────────────────────────────────

    const quarterEnds = [3, 6, 9, 12];
    const vatMapping: Record<number, { month: number; yearOffset: number }> = {
      3: { month: 5, yearOffset: 0 },
      6: { month: 8, yearOffset: 0 },
      9: { month: 11, yearOffset: 0 },
      12: { month: 2, yearOffset: 1 },
    };

    for (let yearOffset = -1; yearOffset <= 1; yearOffset++) {
      const yr = now.getFullYear() + yearOffset;
      for (const qEnd of quarterEnds) {
        let quarterCOGS = 0;
        for (let m = qEnd - 2; m <= qEnd; m++) {
          const mk = `${yr}-${String(m).padStart(2, "0")}`;
          const md = months[mk];
          if (md) {
            quarterCOGS += md.cogsWon + md.cogsPhase1 + md.cogsPhase2 + md.cogsPhase3;
          }
        }
        if (quarterCOGS > 0) {
          const target = vatMapping[qEnd];
          const targetYear = yr + target.yearOffset;
          const returnMk = `${targetYear}-${String(target.month).padStart(2, "0")}`;
          if (months[returnMk]) {
            months[returnMk].vatReturn += quarterCOGS * VAT_RETURN_RATE;
          }
        }
      }
    }

    // ─── BANK BALANCE ───────────────────────────────────────

    let bankBalance = 0;
    let bankBalanceSource = "none";

    if (manualBankBalance !== null && manualBankBalance !== "") {
      bankBalance = parseFloat(manualBankBalance);
      bankBalanceSource = "manual";
    } else {
      const snapshot = await prisma.financialSnapshot.findFirst({
        orderBy: { snapshotDate: "desc" },
      });
      if (snapshot?.bankBalance) {
        bankBalance = snapshot.bankBalance;
        bankBalanceSource = "exact";
      }
    }

    // ─── BUILD RESPONSE ─────────────────────────────────────

    // Round helper
    const r = (n: number) => Math.round(n * 100) / 100;

    const monthlyData = monthKeys.map((mk) => {
      const m = months[mk];
      return {
        month: mk,
        currentAr: r(m.currentAr),
        currentArItems: m.currentArItems,
        billableAr: r(m.billableAr),
        billableArItems: m.billableArItems,
        pipelinePhase1: r(m.pipelinePhase1),
        pipelinePhase1Items: m.pipelinePhase1Items,
        pipelinePhase2: r(m.pipelinePhase2),
        pipelinePhase2Items: m.pipelinePhase2Items,
        pipelinePhase3: r(m.pipelinePhase3),
        pipelinePhase3Items: m.pipelinePhase3Items,
        cogsWon: r(m.cogsWon),
        cogsPhase1: r(m.cogsPhase1),
        cogsPhase2: r(m.cogsPhase2),
        cogsPhase3: r(m.cogsPhase3),
        vatReturn: r(m.vatReturn),
        overhead: r(m.overhead),
      };
    });

    // Summary totals
    const totals = monthlyData.reduce(
      (acc, m) => ({
        currentAr: acc.currentAr + m.currentAr,
        billableAr: acc.billableAr + m.billableAr,
        pipelinePhase1: acc.pipelinePhase1 + m.pipelinePhase1,
        pipelinePhase2: acc.pipelinePhase2 + m.pipelinePhase2,
        pipelinePhase3: acc.pipelinePhase3 + m.pipelinePhase3,
        cogsWon: acc.cogsWon + m.cogsWon,
        cogsPipeline: acc.cogsPipeline + m.cogsPhase1 + m.cogsPhase2 + m.cogsPhase3,
        vatReturn: acc.vatReturn + m.vatReturn,
        overhead: acc.overhead + m.overhead,
      }),
      {
        currentAr: 0, billableAr: 0,
        pipelinePhase1: 0, pipelinePhase2: 0, pipelinePhase3: 0,
        cogsWon: 0, cogsPipeline: 0, vatReturn: 0, overhead: 0,
      }
    );

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        bankBalance: r(bankBalance),
        bankBalanceSource,
        phaseWeights: PHASE_WEIGHTS,
        cogsBuffer: COGS_BUFFER,
        cogsRates: COGS_RATES,
        totals: {
          currentAr: r(totals.currentAr),
          billableAr: r(totals.billableAr),
          pipelinePhase1: r(totals.pipelinePhase1),
          pipelinePhase2: r(totals.pipelinePhase2),
          pipelinePhase3: r(totals.pipelinePhase3),
          totalInflows: r(
            totals.currentAr + totals.billableAr +
            totals.pipelinePhase1 + totals.pipelinePhase2 + totals.pipelinePhase3
          ),
          cogsWon: r(totals.cogsWon),
          cogsPipeline: r(totals.cogsPipeline),
          vatReturn: r(totals.vatReturn),
          overhead: r(totals.overhead),
          totalOutflows: r(totals.cogsWon + totals.cogsPipeline + totals.overhead - totals.vatReturn),
        },
        pipeline: {
          totalOpportunities: pipelineData.length,
          withQuotes: pipelineData.filter((p) => p.hasQuote).length,
          byPhase: {
            "1-Qualify": pipelineData.filter((p) => p.phase === "1-Qualify").length,
            "2-Develop": pipelineData.filter((p) => p.phase === "2-Develop").length,
            "3-Propose": pipelineData.filter((p) => p.phase === "3-Propose").length,
          },
        },
        months: monthlyData,
      },
      { headers: CORS_HEADERS }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
