import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const snapshots = await prisma.financialSnapshot.findMany({
    orderBy: { snapshotDate: "desc" },
    take: 30,
  });
  return NextResponse.json(snapshots);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const snapshot = await prisma.financialSnapshot.create({
    data: {
      snapshotDate: new Date(body.snapshotDate),
      bankBalance: body.bankBalance,
      totalAr: body.totalAr,
      totalAp: body.totalAp,
      source: body.source || "exact",
    },
  });
  return NextResponse.json(snapshot, { status: 201 });
}
