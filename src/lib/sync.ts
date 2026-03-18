import { prisma } from "./db";
import { fetchActiveTasks, parseTask, type ParsedProject } from "./clickup";

export interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
}

/**
 * Sync ClickUp projects into the local database.
 * Uses upsert to handle both new and updated projects.
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
      // Upsert the project
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
        },
        create: {
          externalId: parsed.externalId,
          source: "clickup",
          name: parsed.name,
          projectType: parsed.projectType,
          confidenceTier: "won",
          totalValue: parsed.totalValue,
          status: parsed.status,
        },
      });

      // Replace milestones for this project
      await prisma.paymentMilestone.deleteMany({
        where: { projectId: project.id },
      });

      for (const ms of parsed.milestones) {
        // If no expected date, estimate based on project status
        const expectedDate = ms.expectedDate || estimateMilestoneDate(ms.label);

        await prisma.paymentMilestone.create({
          data: {
            projectId: project.id,
            amount: ms.amount,
            expectedDate,
            status: ms.status,
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

/**
 * If a milestone has no date, estimate it.
 * 1st payments: assume next month; Final payments: assume 3 months out.
 */
function estimateMilestoneDate(label: string): Date {
  const now = new Date();
  const monthsOut = label === "1st Payment" ? 1 : label === "Final Payment" ? 3 : 2;
  return new Date(now.getFullYear(), now.getMonth() + monthsOut, 15);
}
