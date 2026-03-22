import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
  PAYMENT_TERMS_MAP,
} from "@/lib/dynamics-quotes";
import { extractJobNo } from "@/lib/exact";
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
 * GET /api/debug/trace-project?jobNo=26-Z2661
 *
 * Traces a single project across all systems (DB, Dynamics, Exact AR)
 * and shows where it lands on the dashboard.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobNo = searchParams.get("jobNo");

  if (!jobNo) {
    return NextResponse.json(
      { error: "Missing required query param: jobNo (e.g. 26-Z2661)" },
      { status: 400, headers: CORS }
    );
  }

  console.log(`[DEBUG] trace-project: ${jobNo}`);

  const discrepancies: string[] = [];

  try {
    // 1. Database: project
    const project = await prisma.project.findFirst({
      where: { externalId: jobNo },
      include: { milestones: true },
    });

    // 2. Database: AR line items matched to this project (or by jobNo)
    const arItems = await prisma.arLineItem.findMany({
      where: {
        OR: [
          { projectId: project?.id },
          { jobNo },
        ],
      },
    });

    // 3. All unmatched AR that mention this job in description
    const allAr = await prisma.arLineItem.findMany();
    const arMentioning = allAr.filter((item) => {
      const extracted = extractJobNo(item.description);
      return extracted === jobNo;
    });

    // 4. Dynamics: find opportunity and quote
    let dynamicsData: Record<string, unknown> | null = null;
    let decodedQuote: Record<string, unknown> | null = null;
    try {
      const token = await getToken();
      const oppsResp = await dynamicsFetch(
        `/opportunities?$filter=contains(name,'${jobNo}')&$top=5&$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,statuscode,stepname,actualclosedate`,
        token
      );
      const opp = oppsResp.value?.[0];
      if (opp) {
        dynamicsData = opp;
        // Fetch quotes
        const quotesResp = await dynamicsFetch(
          `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}'&$orderby=createdon desc&$top=3&$select=${QUOTE_SELECT_FIELDS}`,
          token
        );
        const quote = quotesResp.value?.[0] || null;
        if (quote) {
          decodedQuote = decodeQuote(opp, quote) as unknown as Record<string, unknown>;
        }
      }
    } catch (e) {
      dynamicsData = { error: e instanceof Error ? e.message : "Dynamics unavailable" };
    }

    // 5. Dashboard position: call our own endpoint
    let dashboardPosition: Record<string, unknown>[] = [];
    try {
      const baseUrl = new URL(request.url).origin;
      const dashRes = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      const dashData = await dashRes.json();
      for (const month of dashData.months || []) {
        // Check all layers for this job
        const layers = [
          { name: "currentAr", items: month.currentArItems },
          { name: "billableAr", items: month.billableArItems },
          { name: "pipelinePhase1", items: month.pipelinePhase1Items },
          { name: "pipelinePhase2", items: month.pipelinePhase2Items },
          { name: "pipelinePhase3", items: month.pipelinePhase3Items },
        ];
        for (const layer of layers) {
          for (const item of layer.items || []) {
            if (item.jobNo === jobNo) {
              dashboardPosition.push({
                month: month.month,
                layer: layer.name,
                amount: item.amount,
                label: item.label,
                status: item.status,
              });
            }
          }
        }
      }
    } catch {
      dashboardPosition = [{ error: "Could not fetch dashboard data" }];
    }

    // 6. Discrepancy checks
    if (project && decodedQuote) {
      const dq = decodedQuote as { totalPrice?: number; paymentTermsText?: string; milestones?: Array<{ amount: number }> };
      // Value mismatch
      if (project.totalValue && dq.totalPrice) {
        const diff = Math.abs(project.totalValue - (dq.totalPrice as number));
        if (diff > 100) {
          discrepancies.push(
            `Value mismatch: DB=${project.totalValue.toFixed(0)} vs Dynamics=${(dq.totalPrice as number).toFixed(0)} (diff=${diff.toFixed(0)})`
          );
        }
      }
      // Payment terms
      if (project.paymentTerms && dq.paymentTermsText) {
        if (project.paymentTerms !== dq.paymentTermsText) {
          discrepancies.push(
            `Payment terms mismatch: DB="${project.paymentTerms}" vs Dynamics="${dq.paymentTermsText}"`
          );
        }
      }
      // Milestone count
      if (dq.milestones && project.milestones) {
        if (project.milestones.length !== (dq.milestones as unknown[]).length) {
          discrepancies.push(
            `Milestone count mismatch: DB=${project.milestones.length} vs Dynamics=${(dq.milestones as unknown[]).length}`
          );
        }
      }
    }

    // COGS timing check
    if (project) {
      const type = (project.projectType || "Y") as ProjectType;
      const cogsRate = COGS_RATES[type] ?? 0.4;
      for (const ms of project.milestones || []) {
        if (ms.status === "received") continue;
        const msMk = toMonthKey(ms.expectedDate);
        const expectedCogsMk = shiftMonthKey(msMk, 1);
        // Check dashboard for COGS in the right month
        const cogsInDash = dashboardPosition.filter(
          (p) => p.layer === "billableAr" && p.label === ms.label
        );
        discrepancies.push(
          `Milestone "${ms.label}" (${msMk}): COGS should be in ${expectedCogsMk} = €${(ms.amount * cogsRate * COGS_BUFFER).toFixed(0)}`
        );
      }
    }

    // Double-count check
    const matchedArJobNos = arItems
      .filter((a) => a.matchStatus === "matched")
      .map((a) => a.jobNo);
    const inCurrentAr = dashboardPosition.filter((p) => p.layer === "currentAr");
    const inBillableAr = dashboardPosition.filter((p) => p.layer === "billableAr");
    if (inCurrentAr.length > 0 && inBillableAr.length > 0) {
      discrepancies.push(
        `DOUBLE COUNT: Project appears in BOTH currentAr (${inCurrentAr.length} items) AND billableAr (${inBillableAr.length} items)`
      );
    }

    return NextResponse.json(
      {
        status: discrepancies.length === 0 ? "PASS" : "ISSUES_FOUND",
        jobNo,
        database: {
          project: project
            ? {
                id: project.id,
                name: project.name,
                source: project.source,
                projectType: project.projectType,
                confidenceTier: project.confidenceTier,
                totalValue: project.totalValue,
                status: project.status,
                paymentTerms: project.paymentTerms,
              }
            : null,
          milestones: (project?.milestones || []).map((ms) => ({
            label: ms.label,
            amount: ms.amount,
            expectedDate: ms.expectedDate.toISOString(),
            status: ms.status,
            invoiceId: ms.invoiceId,
          })),
          arLineItems: arItems.map((a) => ({
            invoiceNumber: a.invoiceNumber,
            amount: a.amount,
            dueDate: a.dueDate.toISOString(),
            matchStatus: a.matchStatus,
            description: a.description,
          })),
        },
        dynamics: dynamicsData
          ? {
              opportunity: dynamicsData,
              decodedQuote,
            }
          : null,
        dashboardPosition,
        discrepancies,
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
