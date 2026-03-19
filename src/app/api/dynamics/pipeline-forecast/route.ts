import { NextResponse } from "next/server";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
  type DecodedQuote,
  type ComputedMilestone,
} from "@/lib/dynamics-quotes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /api/dynamics/pipeline-forecast
 *
 * Fetches open pipeline opportunities with estimated close dates within the
 * next 12 months, and their most recent open quotations, to produce a rolling
 * 12-month forecasted AR breakdown.
 *
 * Filters by pipeline phase (stepname) only — probability is ignored.
 *
 * Query params:
 *   stage — filter by stepname (e.g., "3" matches stepname containing "3")
 *           Default: returns all open pipeline opportunities
 *   count — max opportunities (default 100)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const stage = searchParams.get("stage") || null;
  const count = parseInt(searchParams.get("count") || "100");

  try {
    const token = await getToken();

    // Date window: today → 12 months from now
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const cutoff = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // Fetch open opportunities (statecode=0) with estimated close date in next 12 months
    let filter = `statecode eq 0 and estimatedclosedate ge ${todayStr} and estimatedclosedate le ${cutoffStr}`;

    // If stage is specified, filter by stepname
    if (stage) {
      filter += ` and contains(stepname,'${stage}')`;
    }

    const oppsResp = await dynamicsFetch(
      `/opportunities?$filter=${filter}&$orderby=estimatedvalue desc&$top=${count}&$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,statuscode,stepname,salesstagecode`,
      token
    );
    const opportunities = oppsResp.value || [];

    // For each opportunity, fetch the most recent OPEN quotation (statecode=0 = Draft)
    const decodedOpps: (DecodedQuote & {
      estimatedCloseDate: string | null;
      pipelineStage: string | null;
      hasOpenQuote: boolean;
    })[] = [];

    for (const opp of opportunities) {
      // Fetch most recent open/draft quote for this opportunity
      const quotesResp = await dynamicsFetch(
        `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 0&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
        token
      );
      const q = quotesResp.value?.[0] || null;

      // Also try active quotes (statecode=3) if no draft found
      let activeQ = null;
      if (!q) {
        const activeResp = await dynamicsFetch(
          `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 3&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
          token
        );
        activeQ = activeResp.value?.[0] || null;
      }

      const quoteToUse = q || activeQ;
      const decoded = decodeQuote(
        {
          opportunityid: opp.opportunityid,
          name: opp.name,
          estimatedvalue: opp.estimatedvalue,
          estimatedclosedate: opp.estimatedclosedate,
        },
        quoteToUse
      );

      decodedOpps.push({
        ...decoded,
        estimatedCloseDate: opp.estimatedclosedate || null,
        pipelineStage: opp.stepname || null,
        hasOpenQuote: !!quoteToUse,
      });
    }

    // ─── Build Rolling 12-Month Forecast ───────────────────

    const now = new Date();
    const monthKeys: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      monthKeys.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      );
    }

    // Bucket milestones by month
    const monthlyForecast: Record<
      string,
      {
        totalAr: number;
        milestones: (ComputedMilestone & {
          opportunityName: string;
          projectType: string | null;
          jobNo: string | null;
        })[];
      }
    > = {};
    for (const mk of monthKeys) {
      monthlyForecast[mk] = { totalAr: 0, milestones: [] };
    }

    // Also track amounts that fall outside the 12-month window
    let beyondWindowTotal = 0;
    let beforeWindowTotal = 0;

    for (const opp of decodedOpps) {
      for (const ms of opp.milestones) {
        const msDate = new Date(ms.estimatedDate);
        const msMonth = `${msDate.getFullYear()}-${String(msDate.getMonth() + 1).padStart(2, "0")}`;

        const enrichedMs = {
          ...ms,
          opportunityName: opp.opportunityName,
          projectType: opp.projectType,
          jobNo: opp.jobNo,
        };

        if (msMonth < monthKeys[0]) {
          // Past due — bucket into current month
          beforeWindowTotal += ms.amount;
          monthlyForecast[monthKeys[0]].totalAr += ms.amount;
          monthlyForecast[monthKeys[0]].milestones.push(enrichedMs);
        } else if (msMonth > monthKeys[monthKeys.length - 1]) {
          beyondWindowTotal += ms.amount;
        } else if (monthlyForecast[msMonth]) {
          monthlyForecast[msMonth].totalAr += ms.amount;
          monthlyForecast[msMonth].milestones.push(enrichedMs);
        }
      }
    }

    // Summary
    const totalForecastedAr = Object.values(monthlyForecast).reduce(
      (sum, m) => sum + m.totalAr,
      0
    );

    // By project type
    const byType: Record<string, { count: number; value: number }> = {};
    for (const opp of decodedOpps) {
      const pt = opp.projectType || "Unknown";
      if (!byType[pt]) byType[pt] = { count: 0, value: 0 };
      byType[pt].count++;
      byType[pt].value += opp.totalPrice;
    }

    // By pipeline stage
    const byStage: Record<string, { count: number; value: number }> = {};
    for (const opp of decodedOpps) {
      const s = opp.pipelineStage || "Unknown";
      if (!byStage[s]) byStage[s] = { count: 0, value: 0 };
      byStage[s].count++;
      byStage[s].value += opp.totalPrice;
    }

    return NextResponse.json(
      {
        _info: `Pipeline forecast: ${decodedOpps.length} open opportunities (est. close ${todayStr} → ${cutoffStr})${stage ? ` (stage: "${stage}")` : ""}`,
        generatedAt: new Date().toISOString(),
        filters: { stage, dateFrom: todayStr, dateTo: cutoffStr },
        summary: {
          totalOpportunities: decodedOpps.length,
          withQuotes: decodedOpps.filter((o) => o.hasOpenQuote).length,
          withoutQuotes: decodedOpps.filter((o) => !o.hasOpenQuote).length,
          totalPipelineValue: Math.round(
            decodedOpps.reduce((s, o) => s + o.totalPrice, 0) * 100
          ) / 100,
          totalForecastedAr: Math.round(totalForecastedAr * 100) / 100,
          beyondWindowTotal: Math.round(beyondWindowTotal * 100) / 100,
          pastDueBucketedToCurrent: Math.round(beforeWindowTotal * 100) / 100,
          byProjectType: byType,
          byPipelineStage: byStage,
        },
        monthlyForecast: Object.fromEntries(
          monthKeys.map((mk) => [
            mk,
            {
              totalAr: Math.round(monthlyForecast[mk].totalAr * 100) / 100,
              milestoneCount: monthlyForecast[mk].milestones.length,
              milestones: monthlyForecast[mk].milestones.map((ms) => ({
                ...ms,
                amount: Math.round(ms.amount * 100) / 100,
              })),
            },
          ])
        ),
        opportunities: decodedOpps.map((o) => ({
          ...o,
          totalPrice: Math.round(o.totalPrice * 100) / 100,
          milestones: o.milestones.map((ms) => ({
            ...ms,
            amount: Math.round(ms.amount * 100) / 100,
          })),
        })),
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
