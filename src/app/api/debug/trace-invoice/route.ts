import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { extractJobNo } from "@/lib/exact";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/debug/trace-invoice?invoiceNumber=26010030
 *
 * Traces a single Exact invoice through the matching pipeline.
 * Shows regex extraction, match result, milestone update, and dashboard layer.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const invoiceNumber = searchParams.get("invoiceNumber");

  if (!invoiceNumber) {
    return NextResponse.json(
      { error: "Missing required query param: invoiceNumber" },
      { status: 400, headers: CORS }
    );
  }

  console.log(`[DEBUG] trace-invoice: ${invoiceNumber}`);

  const checks: { check: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; detail: string }[] = [];

  try {
    // 1. Find the invoice in ar_line_items
    const arItem = await prisma.arLineItem.findFirst({
      where: { invoiceNumber },
    });

    if (!arItem) {
      return NextResponse.json(
        {
          status: "NOT_FOUND",
          invoiceNumber,
          message: "Invoice not found in ar_line_items. Has Exact sync been run?",
        },
        { headers: CORS }
      );
    }

    // 2. Show raw description and regex extraction
    const extractedJobNo = extractJobNo(arItem.description);
    checks.push({
      check: "Job Number Extraction",
      status: extractedJobNo ? "PASS" : "WARN",
      detail: extractedJobNo
        ? `Extracted "${extractedJobNo}" from "${arItem.description}"`
        : `No job number found in description: "${arItem.description}"`,
    });

    // 3. Match status
    checks.push({
      check: "Match Status",
      status: arItem.matchStatus === "matched" ? "PASS" : "INFO",
      detail: `matchStatus="${arItem.matchStatus}", projectId=${arItem.projectId || "null"}`,
    });

    // 4. If matched, check the milestone
    let milestone = null;
    let project = null;
    if (arItem.projectId) {
      project = await prisma.project.findUnique({
        where: { id: arItem.projectId },
        include: { milestones: true },
      });

      // Find the milestone that was updated with this invoice
      milestone = project?.milestones.find(
        (ms) => ms.invoiceId === invoiceNumber
      );

      if (milestone) {
        checks.push({
          check: "Milestone Updated",
          status: "PASS",
          detail: `Milestone "${milestone.label}" marked as "${milestone.status}", expectedDate=${milestone.expectedDate.toISOString()}`,
        });
      } else {
        checks.push({
          check: "Milestone Updated",
          status: "WARN",
          detail: `Matched to project but no milestone has invoiceId="${invoiceNumber}"`,
        });
      }
    }

    // 5. Check dashboard for double-counting
    let dashboardLayers: { month: string; layer: string; amount: number }[] = [];
    try {
      const baseUrl = new URL(request.url).origin;
      const dashRes = await fetch(`${baseUrl}/api/dashboard/cash-position`);
      const dashData = await dashRes.json();

      for (const month of dashData.months || []) {
        // Check if invoice appears in currentAr
        for (const item of month.currentArItems || []) {
          if (item.label === invoiceNumber || item.jobNo === arItem.jobNo) {
            dashboardLayers.push({
              month: month.month,
              layer: "currentAr",
              amount: item.amount,
            });
          }
        }
        // Check if related project appears in billableAr
        if (project) {
          for (const item of month.billableArItems || []) {
            if (item.jobNo === project.externalId) {
              dashboardLayers.push({
                month: month.month,
                layer: "billableAr",
                amount: item.amount,
              });
            }
          }
        }
      }
    } catch {
      dashboardLayers = [];
    }

    // Double-count detection
    const inCurrentAr = dashboardLayers.filter((l) => l.layer === "currentAr");
    const inBillableAr = dashboardLayers.filter((l) => l.layer === "billableAr");

    if (inCurrentAr.length > 0 && inBillableAr.length > 0) {
      checks.push({
        check: "Double-Count Detection",
        status: "FAIL",
        detail: `Invoice appears in BOTH currentAr (${inCurrentAr.length} entries) AND billableAr (${inBillableAr.length} entries). This is a double-count bug.`,
      });
    } else if (arItem.matchStatus === "matched" && inCurrentAr.length > 0) {
      checks.push({
        check: "Double-Count Detection",
        status: "FAIL",
        detail: `Invoice is matched but still appears in currentAr (unmatched layer). Should only be in billableAr.`,
      });
    } else {
      checks.push({
        check: "Double-Count Detection",
        status: "PASS",
        detail: `Invoice appears in ${dashboardLayers.length} layer(s): ${[...new Set(dashboardLayers.map((l) => l.layer))].join(", ") || "none"}`,
      });
    }

    const passed = checks.filter((c) => c.status === "PASS").length;
    const failed = checks.filter((c) => c.status === "FAIL").length;

    return NextResponse.json(
      {
        status: failed > 0 ? "FAIL" : "PASS",
        invoiceNumber,
        invoice: {
          accountName: arItem.accountName,
          description: arItem.description,
          amount: arItem.amount,
          invoiceDate: arItem.invoiceDate.toISOString(),
          dueDate: arItem.dueDate.toISOString(),
          currencyCode: arItem.currencyCode,
          matchStatus: arItem.matchStatus,
          jobNo: arItem.jobNo,
          projectId: arItem.projectId,
        },
        regexExtraction: {
          rawDescription: arItem.description,
          extractedJobNo,
          pattern: "\\d{2}-[XYZ]\\d{3,4}",
        },
        matchedProject: project
          ? {
              name: project.name,
              externalId: project.externalId,
              projectType: project.projectType,
              totalValue: project.totalValue,
            }
          : null,
        milestoneUpdate: milestone
          ? {
              label: milestone.label,
              amount: milestone.amount,
              status: milestone.status,
              expectedDate: milestone.expectedDate.toISOString(),
              invoiceId: milestone.invoiceId,
            }
          : null,
        dashboardLayers,
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
