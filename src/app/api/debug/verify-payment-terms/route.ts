import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
  PAYMENT_TERMS_MAP,
} from "@/lib/dynamics-quotes";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/debug/verify-payment-terms?jobNo=26-Z2661
 *
 * Reads the Dynamics quote, decodes payment terms, and compares
 * to the milestones stored in the database.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobNo = searchParams.get("jobNo");

  if (!jobNo) {
    return NextResponse.json(
      { error: "Missing required query param: jobNo" },
      { status: 400, headers: CORS }
    );
  }

  console.log(`[DEBUG] verify-payment-terms: ${jobNo}`);

  try {
    // 1. Find project in DB
    const project = await prisma.project.findFirst({
      where: { externalId: jobNo },
      include: { milestones: true },
    });

    // 2. Find Dynamics opportunity and quote
    let dynamicsQuote: Record<string, unknown> | null = null;
    let rawPaymentTermsCode: number | null = null;
    let decodedTermsText: string | null = null;
    let decoded: ReturnType<typeof decodeQuote> | null = null;

    try {
      const token = await getToken();
      const oppsResp = await dynamicsFetch(
        `/opportunities?$filter=contains(name,'${jobNo}')&$top=5&$select=opportunityid,name,estimatedvalue,estimatedclosedate,actualclosedate,statuscode`,
        token
      );
      const opp = oppsResp.value?.[0];

      if (opp) {
        // Try Won quote first, then Draft, then Active
        for (const statecode of [1, 0, 3]) {
          const quotesResp = await dynamicsFetch(
            `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq ${statecode}&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
            token
          );
          if (quotesResp.value?.[0]) {
            dynamicsQuote = quotesResp.value[0];
            break;
          }
        }

        if (dynamicsQuote) {
          rawPaymentTermsCode = (dynamicsQuote as Record<string, number>).paymenttermscode ?? null;
          decodedTermsText = rawPaymentTermsCode !== null
            ? PAYMENT_TERMS_MAP[rawPaymentTermsCode] || "UNKNOWN CODE"
            : null;
          decoded = decodeQuote(opp, dynamicsQuote as Record<string, unknown>);
        }
      }
    } catch (e) {
      return NextResponse.json(
        {
          status: "ERROR",
          error: `Dynamics unavailable: ${e instanceof Error ? e.message : e}`,
          jobNo,
        },
        { status: 500, headers: CORS }
      );
    }

    // 3. Compare
    const checks: { check: string; status: "PASS" | "FAIL" | "WARN"; detail: string }[] = [];

    // Check: payment terms code known?
    if (rawPaymentTermsCode === null) {
      checks.push({
        check: "Payment Terms Code",
        status: "WARN",
        detail: "No payment terms code found on Dynamics quote",
      });
    } else if (decodedTermsText === "UNKNOWN CODE") {
      checks.push({
        check: "Payment Terms Code",
        status: "FAIL",
        detail: `Code ${rawPaymentTermsCode} is NOT in the payment terms map. This project may have wrong milestone splits.`,
      });
    } else if (decodedTermsText === "Manual Entry") {
      const manual = (dynamicsQuote as Record<string, string>)?.nown_manualentrypaymentterms;
      checks.push({
        check: "Payment Terms Code",
        status: manual ? "PASS" : "WARN",
        detail: `Manual Entry — custom terms: "${manual || "NOT SET"}"`,
      });
    } else {
      checks.push({
        check: "Payment Terms Code",
        status: "PASS",
        detail: `Code ${rawPaymentTermsCode} → "${decodedTermsText}"`,
      });
    }

    // Check: milestone count match
    const dbMilestones = project?.milestones || [];
    const dynamicsMilestones = decoded?.milestones || [];

    if (project) {
      if (dbMilestones.length !== dynamicsMilestones.length) {
        checks.push({
          check: "Milestone Count",
          status: "FAIL",
          detail: `DB has ${dbMilestones.length} milestones, Dynamics decoded ${dynamicsMilestones.length}`,
        });
      } else {
        checks.push({
          check: "Milestone Count",
          status: "PASS",
          detail: `Both have ${dbMilestones.length} milestones`,
        });
      }

      // Check: milestone amounts match
      const dbTotal = dbMilestones.reduce((s, m) => s + m.amount, 0);
      const dynTotal = dynamicsMilestones.reduce((s, m) => s + m.amount, 0);
      const totalDiff = Math.abs(dbTotal - dynTotal);
      checks.push({
        check: "Total Value",
        status: totalDiff < 100 ? "PASS" : "FAIL",
        detail: `DB total: €${dbTotal.toFixed(0)}, Dynamics total: €${dynTotal.toFixed(0)}, diff: €${totalDiff.toFixed(0)}`,
      });

      // Check: individual milestone percentage splits
      for (let i = 0; i < Math.max(dbMilestones.length, dynamicsMilestones.length); i++) {
        const dbMs = dbMilestones[i];
        const dynMs = dynamicsMilestones[i];
        if (dbMs && dynMs) {
          const amtDiff = Math.abs(dbMs.amount - dynMs.amount);
          checks.push({
            check: `Milestone ${i + 1} Amount`,
            status: amtDiff < 100 ? "PASS" : "FAIL",
            detail: `DB "${dbMs.label}" €${dbMs.amount.toFixed(0)} vs Dynamics "${dynMs.label}" €${dynMs.amount.toFixed(0)} (${dynMs.percentage * 100}% × €${decoded?.totalPrice?.toFixed(0)})`,
          });
        }
      }
    }

    const passed = checks.filter((c) => c.status === "PASS").length;
    const failed = checks.filter((c) => c.status === "FAIL").length;

    return NextResponse.json(
      {
        status: failed > 0 ? "FAIL" : "PASS",
        jobNo,
        dynamicsPaymentTerms: {
          rawCode: rawPaymentTermsCode,
          decodedText: decodedTermsText,
          totalPrice: decoded?.totalPrice || null,
          milestones: dynamicsMilestones,
        },
        databaseMilestones: dbMilestones.map((ms) => ({
          label: ms.label,
          amount: ms.amount,
          expectedDate: ms.expectedDate.toISOString(),
          status: ms.status,
        })),
        checks,
        summary: { passed, failed, total: checks.length },
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
