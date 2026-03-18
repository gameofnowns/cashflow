import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const budgets = await prisma.overheadBudget.findMany({
    orderBy: { month: "asc" },
  });
  return NextResponse.json(budgets);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const budget = await prisma.overheadBudget.upsert({
    where: { month: new Date(body.month) },
    update: {
      amount: body.amount,
      notes: body.notes,
      updatedBy: body.updatedBy,
    },
    create: {
      month: new Date(body.month),
      amount: body.amount,
      notes: body.notes,
      updatedBy: body.updatedBy,
    },
  });
  return NextResponse.json(budget);
}
