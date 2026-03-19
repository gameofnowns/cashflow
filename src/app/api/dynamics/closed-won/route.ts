import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
  type DecodedQuote,
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
 * GET /api/dynamics/closed-won
 *
 * Fetches Closed Won opportunities from Dynamics with their linked Won quotes.
 * Decodes all option sets, computes payment milestones, and cross-references
 * with ClickUp projects in the database.
 *
 * Query params:
 *   count   — max opportunities to return (default 50)
 *   months  — limit to opportunities closed within N months (default: all)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const count = parseInt(searchParams.get("count") || "50");
  const monthsBack = searchParams.get("months")
    ? parseInt(searchParams.get("months")!)
    : null;

  try {
    const token = await getToken();

    // Build filter: statecode=1 (Won), optionally limit by close date
    let filter = "statecode eq 1";
    if (monthsBack) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - monthsBack);
      filter += ` and actualclosedate ge ${cutoff.toISOString().split("T")[0]}`;
    }

    const oppsResp = await dynamicsFetch(
      `/opportunities?$filter=${filter}&$orderby=actualclosedate desc&$top=${count}&$select=opportunityid,name,estimatedvalue,actualclosedate,statuscode`,
      token
    );
    const opportunities = oppsResp.value || [];

    const quotes: (DecodedQuote & {
      actualCloseDate: string | null;
      clickup: {
        matched: boolean;
        jobNo: string | null;
        projectName: string | null;
        status: string | null;
        milestones: Array<{
          label: string | null;
          amount: number;
          expectedDate: string;
          status: string;
        }>;
      } | null;
    })[] = [];

    // Aggregate stats
    let totalValue = 0;
    const byType: Record<string, { count: number; value: number }> = {};
    const byMonth: Record<string, { count: number; value: number }> = {};
    const paymentTermsDistribution: Record<string, number> = {};

    for (const opp of opportunities) {
      // Fetch linked Won quote (statecode=1)
      const quotesResp = await dynamicsFetch(
        `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 1&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
        token
      );
      const q = quotesResp.value?.[0] || null;

      const decoded = decodeQuote(opp, q);
      totalValue += decoded.totalPrice;

      // Aggregate by project type
      const pt = decoded.projectType || "Unknown";
      if (!byType[pt]) byType[pt] = { count: 0, value: 0 };
      byType[pt].count++;
      byType[pt].value += decoded.totalPrice;

      // Aggregate by close month
      if (opp.actualclosedate) {
        const monthKey = opp.actualclosedate.substring(0, 7);
        if (!byMonth[monthKey]) byMonth[monthKey] = { count: 0, value: 0 };
        byMonth[monthKey].count++;
        byMonth[monthKey].value += decoded.totalPrice;
      }

      // Payment terms distribution
      const terms = decoded.paymentTermsText || "Unknown";
      paymentTermsDistribution[terms] =
        (paymentTermsDistribution[terms] || 0) + 1;

      // Cross-reference with ClickUp
      let clickupData = null;
      if (decoded.jobNo) {
        const project = await prisma.project.findFirst({
          where: { externalId: decoded.jobNo, source: "clickup" },
          include: { milestones: true },
        });
        if (project) {
          clickupData = {
            matched: true,
            jobNo: decoded.jobNo,
            projectName: project.name,
            status: project.status,
            milestones: project.milestones.map((m) => ({
              label: m.label,
              amount: m.amount,
              expectedDate: m.expectedDate.toISOString(),
              status: m.status,
            })),
          };
        } else {
          clickupData = {
            matched: false,
            jobNo: decoded.jobNo,
            projectName: null,
            status: null,
            milestones: [],
          };
        }
      }

      quotes.push({
        ...decoded,
        actualCloseDate: opp.actualclosedate || null,
        clickup: clickupData,
      });
    }

    return NextResponse.json(
      {
        _info: `${quotes.length} Closed Won opportunities with linked quotes`,
        generatedAt: new Date().toISOString(),
        summary: {
          totalOpportunities: quotes.length,
          totalValue: Math.round(totalValue * 100) / 100,
          averageDealSize:
            quotes.length > 0
              ? Math.round((totalValue / quotes.length) * 100) / 100
              : 0,
          byProjectType: byType,
          byCloseMonth: Object.fromEntries(
            Object.entries(byMonth).sort(([a], [b]) => b.localeCompare(a))
          ),
          paymentTermsDistribution,
        },
        quotes,
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
