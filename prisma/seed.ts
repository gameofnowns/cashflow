import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Clean existing data
  await prisma.paymentMilestone.deleteMany();
  await prisma.project.deleteMany();
  await prisma.financialSnapshot.deleteMany();
  await prisma.overheadBudget.deleteMany();

  // --- Financial Snapshot (current position from Exact Online) ---
  await prisma.financialSnapshot.create({
    data: {
      snapshotDate: new Date("2026-03-18"),
      bankBalance: 100000, // EUR 100K as per spec
      totalAr: 85000,
      totalAp: 42000,
      source: "exact",
    },
  });

  // --- Won Projects (from ClickUp) ---
  const project1 = await prisma.project.create({
    data: {
      externalId: "25-Y2600",
      source: "clickup",
      name: "Municipality Portal Customization",
      projectType: "Y",
      confidenceTier: "won",
      totalValue: 180000,
      status: "active",
    },
  });

  const project2 = await prisma.project.create({
    data: {
      externalId: "25-X2601",
      source: "clickup",
      name: "Standard Product Deployment - Acme",
      projectType: "X",
      confidenceTier: "won",
      totalValue: 95000,
      status: "active",
    },
  });

  const project3 = await prisma.project.create({
    data: {
      externalId: "26-Z2700",
      source: "clickup",
      name: "Custom Enterprise Solution - TechCorp",
      projectType: "Z",
      confidenceTier: "won",
      totalValue: 320000,
      status: "won",
    },
  });

  // --- Pipeline Projects (from Dynamics CRM) ---
  const pipeline1 = await prisma.project.create({
    data: {
      externalId: "OPP-4501",
      source: "dynamics",
      name: "Provincial Dashboard - 90% probability",
      projectType: "Y",
      confidenceTier: "pipeline",
      totalValue: 150000,
      status: "committed",
    },
  });

  const pipeline2 = await prisma.project.create({
    data: {
      externalId: "OPP-4502",
      source: "dynamics",
      name: "Retail Analytics Platform - 95% probability",
      projectType: "Z",
      confidenceTier: "pipeline",
      totalValue: 200000,
      status: "committed",
    },
  });

  // --- Payment Milestones ---
  // Project 1: Y-type, 180K over 4 milestones
  const milestones1 = [
    { amount: 45000, expectedDate: new Date("2026-04-01"), status: "pending" },
    { amount: 45000, expectedDate: new Date("2026-05-15"), status: "pending" },
    { amount: 45000, expectedDate: new Date("2026-07-01"), status: "pending" },
    { amount: 45000, expectedDate: new Date("2026-09-01"), status: "pending" },
  ];

  // Project 2: X-type, 95K over 3 milestones
  const milestones2 = [
    { amount: 32000, expectedDate: new Date("2026-03-30"), status: "invoiced" },
    { amount: 32000, expectedDate: new Date("2026-05-01"), status: "pending" },
    { amount: 31000, expectedDate: new Date("2026-06-15"), status: "pending" },
  ];

  // Project 3: Z-type, 320K over 5 milestones
  const milestones3 = [
    { amount: 64000, expectedDate: new Date("2026-04-15"), status: "pending" },
    { amount: 64000, expectedDate: new Date("2026-06-01"), status: "pending" },
    { amount: 64000, expectedDate: new Date("2026-08-01"), status: "pending" },
    { amount: 64000, expectedDate: new Date("2026-10-01"), status: "pending" },
    { amount: 64000, expectedDate: new Date("2026-12-01"), status: "pending" },
  ];

  // Pipeline 1: Y-type, 150K over 3 milestones
  const milestonesPipeline1 = [
    { amount: 50000, expectedDate: new Date("2026-05-01"), status: "pending" },
    { amount: 50000, expectedDate: new Date("2026-07-01"), status: "pending" },
    { amount: 50000, expectedDate: new Date("2026-09-01"), status: "pending" },
  ];

  // Pipeline 2: Z-type, 200K over 4 milestones
  const milestonesPipeline2 = [
    { amount: 50000, expectedDate: new Date("2026-06-01"), status: "pending" },
    { amount: 50000, expectedDate: new Date("2026-08-01"), status: "pending" },
    { amount: 50000, expectedDate: new Date("2026-10-01"), status: "pending" },
    { amount: 50000, expectedDate: new Date("2026-12-01"), status: "pending" },
  ];

  const allMilestones = [
    ...milestones1.map((m) => ({ ...m, projectId: project1.id })),
    ...milestones2.map((m) => ({ ...m, projectId: project2.id })),
    ...milestones3.map((m) => ({ ...m, projectId: project3.id })),
    ...milestonesPipeline1.map((m) => ({ ...m, projectId: pipeline1.id })),
    ...milestonesPipeline2.map((m) => ({ ...m, projectId: pipeline2.id })),
  ];

  for (const ms of allMilestones) {
    await prisma.paymentMilestone.create({ data: ms });
  }

  // --- Fixed Overhead (from spec: Mar 310K, Apr 325K, etc.) ---
  const overheadData = [
    { month: new Date("2026-03-01"), amount: 310000, notes: "Current month" },
    { month: new Date("2026-04-01"), amount: 325000, notes: null },
    { month: new Date("2026-05-01"), amount: 325000, notes: null },
    { month: new Date("2026-06-01"), amount: 425000, notes: "Higher due to annual license renewals" },
    { month: new Date("2026-07-01"), amount: 375000, notes: null },
    { month: new Date("2026-08-01"), amount: 335000, notes: "Normalized" },
    { month: new Date("2026-09-01"), amount: 335000, notes: null },
    { month: new Date("2026-10-01"), amount: 335000, notes: null },
    { month: new Date("2026-11-01"), amount: 335000, notes: null },
    { month: new Date("2026-12-01"), amount: 335000, notes: null },
    { month: new Date("2027-01-01"), amount: 340000, notes: "New year estimate" },
    { month: new Date("2027-02-01"), amount: 340000, notes: null },
  ];

  for (const oh of overheadData) {
    await prisma.overheadBudget.create({ data: oh });
  }

  console.log("Seed complete:");
  console.log("  - 5 projects (3 won + 2 pipeline)");
  console.log("  - 19 payment milestones");
  console.log("  - 1 financial snapshot (bank: EUR 100K)");
  console.log("  - 12 months of overhead budgets");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
