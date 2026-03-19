import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /api/dashboard/status
 *
 * Returns connection and sync status for all three integrations.
 */
export async function GET() {
  try {
    // Check OAuth tokens
    const tokens = await prisma.oAuthToken.findMany();
    const dynamicsToken = tokens.find((t) => t.provider === "dynamics");
    const exactToken = tokens.find((t) => t.provider === "exact");

    // Check latest snapshot (Exact sync)
    const latestSnapshot = await prisma.financialSnapshot.findFirst({
      orderBy: { snapshotDate: "desc" },
    });

    // Check project counts by source
    const projectCounts = await prisma.project.groupBy({
      by: ["source"],
      _count: true,
    });
    const clickupCount =
      projectCounts.find((p) => p.source === "clickup")?._count || 0;
    const dynamicsCount =
      projectCounts.find((p) => p.source === "dynamics")?._count || 0;

    // Check AR items
    const arCount = await prisma.arLineItem.count();
    const arMatched = await prisma.arLineItem.count({
      where: { matchStatus: "matched" },
    });
    const arUnmatched = await prisma.arLineItem.count({
      where: { matchStatus: "unmatched" },
    });

    // Check milestones
    const milestoneCount = await prisma.paymentMilestone.count();

    return NextResponse.json(
      {
        dynamics: {
          connected: !!dynamicsToken,
          tokenExpiry: dynamicsToken?.expiresAt?.toISOString() || null,
          tokenValid: dynamicsToken
            ? new Date() < dynamicsToken.expiresAt
            : false,
          projectsSynced: dynamicsCount,
        },
        clickup: {
          connected: !!process.env.CLICKUP_API_TOKEN,
          projectsSynced: clickupCount,
          milestones: milestoneCount,
        },
        exact: {
          connected: !!exactToken,
          tokenExpiry: exactToken?.expiresAt?.toISOString() || null,
          tokenValid: exactToken ? new Date() < exactToken.expiresAt : false,
          lastSync: latestSnapshot?.snapshotDate?.toISOString() || null,
          bankBalance: latestSnapshot?.bankBalance || null,
          totalAr: latestSnapshot?.totalAr || null,
          totalAp: latestSnapshot?.totalAp || null,
          arItems: { total: arCount, matched: arMatched, unmatched: arUnmatched },
        },
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
