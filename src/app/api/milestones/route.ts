import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get("projectId");
  const milestones = await prisma.paymentMilestone.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { expectedDate: "asc" },
  });
  return NextResponse.json(milestones);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const milestone = await prisma.paymentMilestone.create({
    data: {
      projectId: body.projectId,
      amount: body.amount,
      expectedDate: new Date(body.expectedDate),
      status: body.status || "pending",
      invoiceId: body.invoiceId,
    },
  });
  return NextResponse.json(milestone, { status: 201 });
}
