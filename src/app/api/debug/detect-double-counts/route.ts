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

/**
 * GET /api/debug/detect-double-counts
 *
 * Scans all dashboard layers for duplicate invoices/amounts.
 * The primary vector: a matched AR item still appearing in currentAr (Layer 1)
 * when it should only be in billableAr (Layer 2).
 */
export async function GET(request: Request) {
  console.log("[DEBUG] detect-double-counts");

  try {
    // 1. Check database for matched AR items
    const matchedAr = await prisma.arLineItem.findMany({
      where: { matchStatus: "matched" },
      include: {
        project: { select: { name: true, externalId: true } },
      },
    });

    // 2. Get dashboard data
    let dashData: Record<string, unknown> = {};
    try {
      const baseUrl = new URL(request.url).origin;
      const res = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      dashData = await res.json();
    } catch {
      return NextResponse.json(
        { error: "Could not fetch dashboard data", status: "ERROR" },
        { status: 500, headers: CORS }
      );
    }

    const months = (dashData as { months?: Array<Record<string, unknown>> })
      .months || [];

    const duplicates: {
      type: string;
      detail: string;
      amount: number;
      months: string[];
    }[] = [];

    // 3. Check: matched AR items that still appear in currentAr (Layer 1)
    // This is the PRIMARY double-count vector.
    // In the current code, Layer 1 only shows matchStatus="unmatched",
    // so this should not happen. But verify.
    const currentArInvoices = new Set<string>();
    const currentArByJobNo = new Map<string, { month: string; amount: number }[]>();

    for (const month of months) {
      const mk = (month as { month: string }).month;
      for (const item of (month as { currentArItems?: Array<Record<string, unknown>> }).currentArItems || []) {
        const inv = item.label as string;
        const jobNo = item.jobNo as string;
        if (inv) currentArInvoices.add(inv);
        if (jobNo) {
          if (!currentArByJobNo.has(jobNo)) currentArByJobNo.set(jobNo, []);
          currentArByJobNo.get(jobNo)!.push({ month: mk, amount: item.amount as number });
        }
      }
    }

    for (const ar of matchedAr) {
      if (currentArInvoices.has(ar.invoiceNumber)) {
        duplicates.push({
          type: "MATCHED_IN_CURRENT_AR",
          detail: `Invoice ${ar.invoiceNumber} (${ar.accountName}) is matched to project "${ar.project?.name}" but still appears in Current AR (Layer 1)`,
          amount: ar.amount,
          months: [],
        });
      }
    }

    // 4. Check: same jobNo appearing in both currentAr and billableAr
    const billableByJobNo = new Map<string, { month: string; amount: number; label: string }[]>();
    for (const month of months) {
      const mk = (month as { month: string }).month;
      for (const item of (month as { billableArItems?: Array<Record<string, unknown>> }).billableArItems || []) {
        const jobNo = item.jobNo as string;
        if (jobNo) {
          if (!billableByJobNo.has(jobNo)) billableByJobNo.set(jobNo, []);
          billableByJobNo.get(jobNo)!.push({
            month: mk,
            amount: item.amount as number,
            label: item.label as string,
          });
        }
      }
    }

    for (const [jobNo, currentEntries] of currentArByJobNo) {
      if (billableByJobNo.has(jobNo)) {
        const billableEntries = billableByJobNo.get(jobNo)!;
        const currentTotal = currentEntries.reduce((s, e) => s + e.amount, 0);
        const billableTotal = billableEntries.reduce((s, e) => s + e.amount, 0);
        duplicates.push({
          type: "CROSS_LAYER_DUPLICATE",
          detail: `Job ${jobNo} appears in BOTH currentAr (€${currentTotal.toFixed(0)}) and billableAr (€${billableTotal.toFixed(0)})`,
          amount: currentTotal + billableTotal,
          months: [
            ...currentEntries.map((e) => e.month),
            ...billableEntries.map((e) => e.month),
          ],
        });
      }
    }

    // 5. Check: same invoice number appearing in multiple months
    const invoiceMonths = new Map<string, string[]>();
    for (const month of months) {
      const mk = (month as { month: string }).month;
      for (const item of (month as { currentArItems?: Array<Record<string, unknown>> }).currentArItems || []) {
        const inv = item.label as string;
        if (inv) {
          if (!invoiceMonths.has(inv)) invoiceMonths.set(inv, []);
          invoiceMonths.get(inv)!.push(mk);
        }
      }
    }
    for (const [inv, mks] of invoiceMonths) {
      if (mks.length > 1) {
        duplicates.push({
          type: "MULTI_MONTH_INVOICE",
          detail: `Invoice ${inv} appears in ${mks.length} months: ${mks.join(", ")}`,
          amount: 0,
          months: mks,
        });
      }
    }

    // 6. Check: pipeline items that also exist as won projects (DB overlap)
    const wonJobNos = new Set(
      (
        await prisma.project.findMany({
          where: { confidenceTier: { in: ["won", "committed"] } },
          select: { externalId: true, name: true },
        })
      ).map((p) => p.externalId)
    );

    for (const month of months) {
      const mk = (month as { month: string }).month;
      const pipelineLayers = ["pipelinePhase1Items", "pipelinePhase2Items", "pipelinePhase3Items"];
      for (const layerName of pipelineLayers) {
        for (const item of (month as Record<string, unknown[]>)[layerName] || []) {
          const jobNo = (item as Record<string, unknown>).jobNo as string;
          if (jobNo && wonJobNos.has(jobNo)) {
            duplicates.push({
              type: "PIPELINE_AND_WON_OVERLAP",
              detail: `Job ${jobNo} appears in pipeline (${layerName}) but is already a won/committed project in DB`,
              amount: (item as Record<string, unknown>).amount as number,
              months: [mk],
            });
          }
        }
      }
    }

    const totalDuplicateAmount = duplicates.reduce(
      (s, d) => s + d.amount,
      0
    );

    return NextResponse.json(
      {
        status: duplicates.length === 0 ? "PASS" : "FAIL",
        duplicatesFound: duplicates.length,
        totalDuplicateAmount: Math.round(totalDuplicateAmount * 100) / 100,
        duplicates,
        dbStats: {
          matchedArItems: matchedAr.length,
          wonProjectJobNos: wonJobNos.size,
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
