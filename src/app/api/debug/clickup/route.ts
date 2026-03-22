import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { fetchActiveTasks, parseTask } from "@/lib/clickup";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/debug/clickup
 *
 * Full ClickUp sync diagnostic:
 * 1. Fetches all active tasks from ClickUp API
 * 2. Parses each task (same logic as sync)
 * 3. Compares to what's in the database
 * 4. Shows skipped tasks and WHY they were skipped
 * 5. Shows value/milestone mismatches between ClickUp and DB
 *
 * Pass ?skipOcr=true to skip PDF OCR (much faster, but projects without
 * a Project Value field will show as "skipped: no value").
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const skipOcr = searchParams.get("skipOcr") === "true";

  console.log(`[DEBUG] clickup diagnostic (skipOcr=${skipOcr})`);

  try {
    // 1. Fetch raw tasks from ClickUp API
    let rawTasks;
    try {
      rawTasks = await fetchActiveTasks();
    } catch (e) {
      return NextResponse.json(
        {
          status: "ERROR",
          error: `Failed to fetch ClickUp tasks: ${e instanceof Error ? e.message : e}`,
          hint: "Check CLICKUP_API_TOKEN and CLICKUP_LIST_ID env vars",
        },
        { status: 500, headers: CORS }
      );
    }

    // 2. Get all DB projects (source=clickup)
    const dbProjects = await prisma.project.findMany({
      where: { source: "clickup" },
      include: { milestones: true },
    });
    const dbByJobNo = new Map(dbProjects.map((p) => [p.externalId, p]));

    // 3. Parse each task and compare
    const parsed: {
      jobNo: string;
      taskName: string;
      clickupStatus: string;
      projectType: string;
      totalValue: number;
      milestoneCount: number;
      milestones: {
        label: string;
        amount: number;
        expectedDate: string | null;
        status: string;
      }[];
      paymentTerms: string | null;
      timingFields: Record<string, string | number | null>;
    }[] = [];

    const skipped: {
      taskName: string;
      taskId: string;
      clickupStatus: string;
      reason: string;
      rawFields: Record<string, unknown>;
    }[] = [];

    const mismatches: {
      jobNo: string;
      field: string;
      clickupValue: string;
      dbValue: string;
    }[] = [];

    const inDbNotClickup: string[] = [];

    for (const task of rawTasks) {
      // Extract raw field values for diagnostics (even if parse fails)
      const rawFields: Record<string, unknown> = {};
      for (const cf of task.custom_fields) {
        if (cf.value !== null && cf.value !== undefined) {
          rawFields[cf.name] = cf.value;
        }
      }

      // Check skip reasons manually before parsing
      const statusName = task.status.status.toLowerCase();
      const closedStatuses = new Set([
        "shipped", "cancelled", "complete", "00 - complete",
        "template", "not started", "z - hold", "hold",
      ]);

      if (closedStatuses.has(statusName)) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: `Status "${statusName}" is in the excluded list`,
          rawFields,
        });
        continue;
      }

      // Find Job No field
      const jobNoField = task.custom_fields.find((f) => f.name === "Job No.");
      const jobNo = (jobNoField?.value as string) || null;
      if (!jobNo) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: "No Job No. field value",
          rawFields,
        });
        continue;
      }

      // Find Project Type field
      const typeField = task.custom_fields.find((f) => f.name === "Project Type");
      const typeVal = typeField?.value;
      const typeOptions = typeField?.type_config?.options;
      let typeLabel = "unknown";
      if (typeVal !== null && typeVal !== undefined && typeOptions) {
        const idx = Number(typeVal);
        const opt = typeOptions.find((o) => o.orderindex === idx);
        typeLabel = opt?.name || `option-index-${idx}`;
      }

      const projectTypeMap: Record<string, string> = {
        "783a849b-3ba6-435b-97d6-57895ad59191": "Y",
        "0cea8809-1994-4b40-ab63-a4997a13649e": "X",
        "c0fe50ef-aef1-4d31-bd4f-71c83b5b0f4a": "Z",
      };
      const optionId = typeVal !== null && typeVal !== undefined && typeOptions
        ? typeOptions.find((o) => o.orderindex === Number(typeVal))?.id
        : null;
      const mappedType = optionId ? projectTypeMap[optionId] : null;

      if (!mappedType) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: `Project Type "${typeLabel}" (option id: ${optionId}) not mapped to X/Y/Z — skipped (Mock Up, Internal, etc.)`,
          rawFields: { ...rawFields, jobNo },
        });
        continue;
      }

      // Check Project Value
      const valueField = task.custom_fields.find((f) => f.name === "Project Value");
      const rawValue = valueField?.value;

      if (!rawValue && skipOcr) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: "No Project Value field and skipOcr=true (would try PDF OCR in full sync)",
          rawFields: { ...rawFields, jobNo, projectType: mappedType },
        });
        continue;
      }

      // Full parse (includes OCR if needed and skipOcr is false)
      let result;
      try {
        if (skipOcr && !rawValue) {
          result = null;
        } else {
          result = await parseTask(task);
        }
      } catch (e) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: `Parse error: ${e instanceof Error ? e.message : e}`,
          rawFields: { ...rawFields, jobNo, projectType: mappedType },
        });
        continue;
      }

      if (!result) {
        skipped.push({
          taskName: task.name,
          taskId: task.id,
          clickupStatus: statusName,
          reason: "parseTask returned null (no value after OCR attempt, or OCR failed)",
          rawFields: { ...rawFields, jobNo, projectType: mappedType },
        });
        continue;
      }

      parsed.push({
        jobNo: result.externalId,
        taskName: result.name,
        clickupStatus: result.status,
        projectType: result.projectType,
        totalValue: result.totalValue,
        milestoneCount: result.milestones.length,
        milestones: result.milestones.map((m) => ({
          label: m.label,
          amount: m.amount,
          expectedDate: m.expectedDate?.toISOString() || null,
          status: m.status,
        })),
        paymentTerms: result.paymentTerms,
        timingFields: {
          quoteDate: result.quoteDate?.toISOString() || null,
          leadtimeWeeks: result.leadtimeWeeks,
          productionEta: result.productionEta?.toISOString() || null,
          prodFinished: result.prodFinishedDate?.toISOString() || null,
          dueDateShops: result.dueDateShops?.toISOString() || null,
          shopsStatus: result.shopsStatus,
          approvedShops: result.approvedShopsDate?.toISOString() || null,
          dueDate: result.dueDate?.toISOString() || null,
          contractDeadline: result.contractDeadline?.toISOString() || null,
          actualDispatch: result.actualDispatch?.toISOString() || null,
        },
      });

      // Compare to DB
      const dbProject = dbByJobNo.get(result.externalId);
      if (dbProject) {
        dbByJobNo.delete(result.externalId); // mark as seen

        // Value mismatch
        if (
          dbProject.totalValue &&
          Math.abs(dbProject.totalValue - result.totalValue) > 1
        ) {
          mismatches.push({
            jobNo: result.externalId,
            field: "totalValue",
            clickupValue: `€${result.totalValue.toFixed(2)}`,
            dbValue: `€${dbProject.totalValue.toFixed(2)}`,
          });
        }

        // Milestone count
        if (dbProject.milestones.length !== result.milestones.length) {
          mismatches.push({
            jobNo: result.externalId,
            field: "milestoneCount",
            clickupValue: String(result.milestones.length),
            dbValue: String(dbProject.milestones.length),
          });
        }

        // Milestone amounts
        for (let i = 0; i < result.milestones.length; i++) {
          const cuMs = result.milestones[i];
          const dbMs = dbProject.milestones.find(
            (m) => m.label === cuMs.label
          );
          if (dbMs && Math.abs(dbMs.amount - cuMs.amount) > 1) {
            mismatches.push({
              jobNo: result.externalId,
              field: `milestone.${cuMs.label}.amount`,
              clickupValue: `€${cuMs.amount.toFixed(2)}`,
              dbValue: `€${dbMs.amount.toFixed(2)}`,
            });
          }
        }

        // Project type
        if (dbProject.projectType !== result.projectType) {
          mismatches.push({
            jobNo: result.externalId,
            field: "projectType",
            clickupValue: result.projectType,
            dbValue: dbProject.projectType || "null",
          });
        }
      } else {
        mismatches.push({
          jobNo: result.externalId,
          field: "existence",
          clickupValue: "exists in ClickUp",
          dbValue: "NOT in database (never synced or different source)",
        });
      }
    }

    // Projects in DB but not in ClickUp active tasks
    for (const [jobNo, dbProject] of dbByJobNo) {
      inDbNotClickup.push(
        `${jobNo} — "${dbProject.name}" (status: ${dbProject.status}, tier: ${dbProject.confidenceTier})`
      );
    }

    // Summary
    const skipReasons: Record<string, number> = {};
    for (const s of skipped) {
      const key = s.reason.split(":")[0].split("(")[0].trim();
      skipReasons[key] = (skipReasons[key] || 0) + 1;
    }

    return NextResponse.json(
      {
        status:
          mismatches.length > 0
            ? "ISSUES_FOUND"
            : "PASS",
        summary: {
          totalClickUpTasks: rawTasks.length,
          parsed: parsed.length,
          skipped: skipped.length,
          dbClickupProjects: dbProjects.length,
          mismatches: mismatches.length,
          inDbNotClickup: inDbNotClickup.length,
          skipReasons,
        },
        mismatches,
        inDbNotClickup,
        parsed,
        skipped,
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
