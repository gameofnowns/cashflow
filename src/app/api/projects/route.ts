import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const projects = await prisma.project.findMany({
    include: { milestones: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(projects);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const project = await prisma.project.create({
    data: {
      externalId: body.externalId,
      source: body.source,
      name: body.name,
      projectType: body.projectType,
      confidenceTier: body.confidenceTier,
      totalValue: body.totalValue,
      status: body.status,
    },
  });
  return NextResponse.json(project, { status: 201 });
}
