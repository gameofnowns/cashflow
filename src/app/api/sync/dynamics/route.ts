import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Simple API key for securing the webhook
const WEBHOOK_KEY = process.env.DYNAMICS_WEBHOOK_KEY || "";

interface DynamicsOpportunity {
  name: string;
  estimatedvalue: number;
  closeprobability: number;
  estimatedclosedate: string;
  opportunityid: string;
  statuscode: number;
  projecttype?: string; // X, Y, or Z — custom field or derived
}

/**
 * POST /api/sync/dynamics
 * Receives pipeline opportunities from Power Automate.
 * Body: { opportunities: DynamicsOpportunity[] }
 * Header: x-webhook-key must match DYNAMICS_WEBHOOK_KEY
 */
export async function POST(request: NextRequest) {
  // Verify webhook key
  const key = request.headers.get("x-webhook-key");
  if (WEBHOOK_KEY && key !== WEBHOOK_KEY) {
    return NextResponse.json({ error: "Invalid webhook key" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const opportunities: DynamicsOpportunity[] = body.opportunities || body.value || [];

    if (!Array.isArray(opportunities) || opportunities.length === 0) {
      return NextResponse.json({ error: "No opportunities provided" }, { status: 400 });
    }

    let synced = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const opp of opportunities) {
      try {
        if (!opp.opportunityid || !opp.estimatedvalue) {
          skipped++;
          continue;
        }

        // Determine project type from name or custom field
        // Try to extract from opportunity name (e.g., "25-Y2600 - Project Name")
        const typeMatch = opp.name?.match(/\d{2}-([XYZ])\d/);
        const projectType = opp.projecttype || (typeMatch ? typeMatch[1] : "Y"); // Default to Y

        // Upsert the project as pipeline
        const project = await prisma.project.upsert({
          where: {
            externalId_source: {
              externalId: opp.opportunityid,
              source: "dynamics",
            },
          },
          update: {
            name: opp.name || "Unnamed Opportunity",
            projectType,
            totalValue: opp.estimatedvalue,
            confidenceTier: "pipeline",
            status: "committed",
          },
          create: {
            externalId: opp.opportunityid,
            source: "dynamics",
            name: opp.name || "Unnamed Opportunity",
            projectType,
            confidenceTier: "pipeline",
            totalValue: opp.estimatedvalue,
            status: "committed",
          },
        });

        // Create/replace milestones — split 50/50 based on estimated close date
        await prisma.paymentMilestone.deleteMany({
          where: { projectId: project.id },
        });

        const closeDate = opp.estimatedclosedate
          ? new Date(opp.estimatedclosedate)
          : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // Default 90 days out

        // 1st milestone at close date, 2nd milestone 2 months after
        await prisma.paymentMilestone.create({
          data: {
            projectId: project.id,
            amount: opp.estimatedvalue * 0.5,
            expectedDate: closeDate,
            status: "pending",
          },
        });
        await prisma.paymentMilestone.create({
          data: {
            projectId: project.id,
            amount: opp.estimatedvalue * 0.5,
            expectedDate: new Date(closeDate.getFullYear(), closeDate.getMonth() + 2, closeDate.getDate()),
            status: "pending",
          },
        });

        synced++;
      } catch (e) {
        errors.push(`${opp.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Clean up: remove pipeline projects from Dynamics that are no longer in the list
    const syncedIds = opportunities
      .filter(o => o.opportunityid)
      .map(o => o.opportunityid);

    if (syncedIds.length > 0) {
      await prisma.project.deleteMany({
        where: {
          source: "dynamics",
          confidenceTier: "pipeline",
          externalId: { notIn: syncedIds },
        },
      });
    }

    return NextResponse.json({
      total: opportunities.length,
      synced,
      skipped,
      errors,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to process opportunities" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/sync/dynamics
 * Returns current pipeline projects from Dynamics.
 */
export async function GET() {
  const projects = await prisma.project.findMany({
    where: { source: "dynamics" },
    include: { milestones: true },
    orderBy: { totalValue: "desc" },
  });
  return NextResponse.json(projects);
}
