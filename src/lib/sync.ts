import { prisma } from "./db";
import { fetchActiveTasks, parseTask, type ParsedProject } from "./clickup";
import type { ProjectType } from "./types";

export interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
}

/** Add weeks to a date */
function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
}

/**
 * Estimate when a payment will land based on real project data.
 * Uses the dependency chain: Prod. ETA → Approved Shops + production → quote + leadtime → fallback.
 */
function estimatePaymentDate(
  label: string,
  project: ParsedProject
): Date {
  const now = new Date();

  // 1st Payment: ~1 week after quote date (invoice sent at quote signing)
  if (label === "1st Payment") {
    if (project.quoteDate) {
      return addWeeks(project.quoteDate, 1);
    }
    // Fallback: next month
    return new Date(now.getFullYear(), now.getMonth() + 1, 15);
  }

  // For subsequent/final payments, use the dependency chain:

  // 1. Best: Prod. ETA exists → invoice goes out then → payment +1 week
  if (project.productionEta) {
    return addWeeks(project.productionEta, 1);
  }

  // 2. Y/Z with Approved Shops date → production starts from approval
  //    Estimate production as a portion of total leadtime
  if (
    (project.projectType === "Y" || project.projectType === "Z") &&
    project.approvedShopsDate
  ) {
    // If we know total leadtime, estimate production as ~60% of it (design is ~40%)
    const productionWeeks = project.leadtimeWeeks
      ? Math.round(project.leadtimeWeeks * 0.6)
      : 8; // default 8 weeks production
    return addWeeks(project.approvedShopsDate, productionWeeks + 1);
  }

  // 3. Y/Z shops NOT yet approved → estimate from Due Date Shops
  //    Assume ~2 weeks for approval after delivery, then production
  if (
    (project.projectType === "Y" || project.projectType === "Z") &&
    project.shopsStatus !== "Approved" &&
    project.dueDateShops
  ) {
    const productionWeeks = project.leadtimeWeeks
      ? Math.round(project.leadtimeWeeks * 0.6)
      : 8;
    // Due Date Shops + 2 weeks approval buffer + production + 1 week payment
    return addWeeks(project.dueDateShops, 2 + productionWeeks + 1);
  }

  // 4. Fallback: quote date + total leadtime + 1 week
  if (project.quoteDate && project.leadtimeWeeks) {
    return addWeeks(project.quoteDate, project.leadtimeWeeks + 1);
  }

  // 5. Last resort: rough estimate
  const monthsOut = label === "Final Payment" ? 3 : 2;
  return new Date(now.getFullYear(), now.getMonth() + monthsOut, 15);
}

/**
 * Sync ClickUp projects into the local database.
 * Uses upsert to handle both new and updated projects.
 * Preserves "invoiced" milestones that were matched by AR sync.
 */
export async function syncClickUp(): Promise<SyncResult> {
  const result: SyncResult = { total: 0, synced: 0, skipped: 0, errors: [] };

  // Fetch all active tasks from ClickUp
  let tasks;
  try {
    tasks = await fetchActiveTasks();
  } catch (e) {
    result.errors.push(`Failed to fetch tasks: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  result.total = tasks.length;

  for (const task of tasks) {
    let parsed: ParsedProject | null;
    try {
      parsed = await parseTask(task);
    } catch (e) {
      result.errors.push(`Failed to parse task ${task.name}: ${e instanceof Error ? e.message : String(e)}`);
      result.skipped++;
      continue;
    }

    if (!parsed) {
      result.skipped++;
      continue;
    }

    try {
      // Upsert the project with timing fields
      const project = await prisma.project.upsert({
        where: {
          externalId_source: {
            externalId: parsed.externalId,
            source: "clickup",
          },
        },
        update: {
          name: parsed.name,
          projectType: parsed.projectType,
          totalValue: parsed.totalValue,
          status: parsed.status,
          confidenceTier: "won",
          quoteDate: parsed.quoteDate,
          leadtimeWeeks: parsed.leadtimeWeeks,
          productionEta: parsed.productionEta,
          prodFinishedDate: parsed.prodFinishedDate,
          dueDateShops: parsed.dueDateShops,
          shopsStatus: parsed.shopsStatus,
          approvedShopsDate: parsed.approvedShopsDate,
          recordSetStatus: parsed.recordSetStatus,
          dueDate: parsed.dueDate,
          contractDeadline: parsed.contractDeadline,
          actualDispatch: parsed.actualDispatch,
          paymentTerms: parsed.paymentTerms,
        },
        create: {
          externalId: parsed.externalId,
          source: "clickup",
          name: parsed.name,
          projectType: parsed.projectType,
          confidenceTier: "won",
          totalValue: parsed.totalValue,
          status: parsed.status,
          quoteDate: parsed.quoteDate,
          leadtimeWeeks: parsed.leadtimeWeeks,
          productionEta: parsed.productionEta,
          prodFinishedDate: parsed.prodFinishedDate,
          dueDateShops: parsed.dueDateShops,
          shopsStatus: parsed.shopsStatus,
          approvedShopsDate: parsed.approvedShopsDate,
          recordSetStatus: parsed.recordSetStatus,
          dueDate: parsed.dueDate,
          contractDeadline: parsed.contractDeadline,
          actualDispatch: parsed.actualDispatch,
          paymentTerms: parsed.paymentTerms,
        },
      });

      // Preserve "invoiced" milestones from AR matching before replacing
      const existingMilestones = await prisma.paymentMilestone.findMany({
        where: { projectId: project.id },
      });
      const invoicedByLabel = new Map<string, { status: string; invoiceId: string | null; expectedDate: Date }>();
      for (const em of existingMilestones) {
        if (em.status === "invoiced" && em.label) {
          invoicedByLabel.set(em.label, {
            status: em.status,
            invoiceId: em.invoiceId,
            expectedDate: em.expectedDate,
          });
        }
      }

      // Replace milestones
      await prisma.paymentMilestone.deleteMany({
        where: { projectId: project.id },
      });

      for (const ms of parsed.milestones) {
        // Check if this milestone was previously matched to an AR invoice
        const priorInvoiced = invoicedByLabel.get(ms.label);

        // Use ClickUp date if available, then AR-matched date, then estimate
        let expectedDate: Date;
        let status = ms.status;
        let invoiceId: string | null = null;

        if (ms.status === "received" && ms.expectedDate) {
          // ClickUp says received with a date — use it
          expectedDate = ms.expectedDate;
        } else if (priorInvoiced) {
          // Restore AR-matched invoiced state
          expectedDate = priorInvoiced.expectedDate;
          status = priorInvoiced.status as "pending" | "invoiced" | "received";
          invoiceId = priorInvoiced.invoiceId;
        } else if (ms.expectedDate) {
          expectedDate = ms.expectedDate;
        } else {
          // Estimate using real project data
          expectedDate = estimatePaymentDate(ms.label, parsed);
        }

        await prisma.paymentMilestone.create({
          data: {
            projectId: project.id,
            label: ms.label,
            amount: ms.amount,
            expectedDate,
            status,
            invoiceId,
          },
        });
      }

      result.synced++;
    } catch (e) {
      result.errors.push(
        `Failed to upsert ${parsed.externalId}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return result;
}
