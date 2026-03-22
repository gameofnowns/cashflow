import { prisma } from "./db";
import { fetchActiveTasks, parseTask, type ParsedProject } from "./clickup";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  extractPaymentTermsFromLineItems,
  addWeeks,
  QUOTE_SELECT_FIELDS,
  type ComputedMilestone,
} from "./dynamics-quotes";

export interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
  dynamicsEnriched?: number;
}

// ─── Dynamics Batch Fetch ─────────────────────────────────────

interface DynamicsQuoteData {
  opp: {
    opportunityid: string;
    name: string;
    estimatedvalue?: number;
    actualclosedate?: string;
    estimatedclosedate?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quote: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineItems: Record<string, any>[] | null;
}

/**
 * Batch-fetch all Dynamics closed-won opportunities with their quotes
 * and (when needed) quote line items. Returns a Map keyed by job number.
 *
 * Wrapped in a timeout + try/catch so ClickUp sync continues if Dynamics is down.
 */
async function fetchDynamicsQuoteMap(): Promise<Map<string, DynamicsQuoteData>> {
  const map = new Map<string, DynamicsQuoteData>();

  const token = await getToken();

  // Fetch all Won opportunities (statecode=1 means Won)
  const oppsResp = await dynamicsFetch(
    `/opportunities?$filter=statecode eq 1&$select=opportunityid,name,estimatedvalue,actualclosedate,estimatedclosedate&$top=500`,
    token
  );
  const opps = oppsResp.value || [];

  // For each opp, extract job number and fetch the Won quote
  // Process in batches of 5 to avoid hammering the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < opps.length; i += BATCH_SIZE) {
    const batch = opps.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (opp: Record<string, string>) => {
        // Extract job number from opportunity name
        const jobMatch = opp.name?.match(/(\d{2}-[XYZ]\d{3,4})/);
        if (!jobMatch) return null;
        const jobNo = jobMatch[1];

        // Fetch Won quote (statecode=1 for Won, then 2 for Closed)
        let quote = null;
        for (const statecode of [1, 2]) {
          const qResp = await dynamicsFetch(
            `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq ${statecode}&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
            token
          );
          if (qResp.value?.[0]) {
            quote = qResp.value[0];
            break;
          }
        }

        // Conditionally fetch line items if terms need resolution
        let lineItems = null;
        if (quote) {
          const hasStandardTerms = quote.paymenttermscode != null;
          const manual = (quote.nown_manualentrypaymentterms || "").trim();
          const manualHasTerms = manual && !manual.toLowerCase().includes("see line") && /\d+%/.test(manual);

          if (!hasStandardTerms && !manualHasTerms) {
            // Need to check line items
            try {
              const liResp = await dynamicsFetch(
                `/quotedetails?$filter=_quoteid_value eq '${quote.quoteid}'&$select=quotedetailname,productdescription,description,baseamount&$top=50`,
                token
              );
              lineItems = liResp.value || null;
            } catch {
              // Line item fetch failed — proceed without
            }
          }
        }

        return { jobNo, opp, quote, lineItems };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const { jobNo, opp, quote, lineItems } = result.value;
        map.set(jobNo, { opp, quote, lineItems });
      }
    }
  }

  return map;
}

// ─── Trigger-Based Date Estimation ────────────────────────────

/**
 * Estimate when a payment milestone will land based on the payment trigger
 * (from Dynamics) and real project timing (from ClickUp).
 *
 * Dynamics tells us WHAT the trigger is (start, approval, pre-ship, NET 30).
 * ClickUp tells us WHERE the project is (status, timing fields).
 *
 * Trigger → ClickUp field mapping:
 *   start/deposit    → quoteDate + 1 week
 *   shops            → dueDateShops, or quoteDate + designWeeks
 *   approval         → approvedShopsDate, or dueDateShops + 2wk buffer
 *   mid-manufacture  → midpoint between approval and pre-ship estimates
 *   pre-ship         → productionEta, or approvedShops + productionWeeks
 *   NET 30           → pre-ship estimate + 4 weeks
 *   NET 60           → pre-ship estimate + 9 weeks
 */
function estimateMilestoneDate(
  trigger: string,
  project: ParsedProject,
  dynamicsDesignWeeks?: number | null,
  dynamicsMfgWeeks?: number | null
): Date {
  const now = new Date();
  const designWeeks = dynamicsDesignWeeks ?? Math.round((project.leadtimeWeeks || 12) * 0.4);
  const mfgWeeks = dynamicsMfgWeeks ?? Math.round((project.leadtimeWeeks || 12) * 0.6);
  const productionWeeks = project.leadtimeWeeks
    ? Math.round(project.leadtimeWeeks * 0.6)
    : mfgWeeks;

  switch (trigger) {
    case "start": {
      // Deposit / 1st payment: ~1 week after quote signing
      if (project.quoteDate) return addWeeks(project.quoteDate, 1);
      return new Date(now.getFullYear(), now.getMonth() + 1, 15);
    }

    case "shops": {
      // Design complete → shops delivered
      if (project.dueDateShops) return project.dueDateShops;
      if (project.quoteDate) return addWeeks(project.quoteDate, designWeeks);
      return new Date(now.getFullYear(), now.getMonth() + 2, 15);
    }

    case "approval": {
      // Client approves shop drawings
      if (project.approvedShopsDate) return addWeeks(project.approvedShopsDate, 0);
      if (project.dueDateShops) return addWeeks(project.dueDateShops, 2); // 2wk approval buffer
      if (project.quoteDate) return addWeeks(project.quoteDate, designWeeks + 2);
      return new Date(now.getFullYear(), now.getMonth() + 2, 15);
    }

    case "mid-manufacture": {
      // Midpoint of production
      const approvalDate = project.approvedShopsDate
        || (project.dueDateShops ? addWeeks(project.dueDateShops, 2) : null)
        || (project.quoteDate ? addWeeks(project.quoteDate, designWeeks + 2) : null);
      if (approvalDate) return addWeeks(approvalDate, Math.ceil(productionWeeks / 2));
      return new Date(now.getFullYear(), now.getMonth() + 3, 15);
    }

    case "pre-ship": {
      // Production complete, ready to ship
      if (project.productionEta) return project.productionEta;
      if (project.approvedShopsDate) return addWeeks(project.approvedShopsDate, productionWeeks);
      if (project.dueDateShops) return addWeeks(project.dueDateShops, 2 + productionWeeks);
      if (project.quoteDate && project.leadtimeWeeks) return addWeeks(project.quoteDate, project.leadtimeWeeks);
      if (project.quoteDate) return addWeeks(project.quoteDate, designWeeks + mfgWeeks);
      return new Date(now.getFullYear(), now.getMonth() + 4, 15);
    }

    case "NET 30": {
      // 30 days after dispatch (pre-ship + ~4 weeks)
      const preShipDate = estimateMilestoneDate("pre-ship", project, dynamicsDesignWeeks, dynamicsMfgWeeks);
      return addWeeks(preShipDate, 4);
    }

    case "NET 60": {
      // 60 days after dispatch (pre-ship + ~9 weeks)
      const preShipDate = estimateMilestoneDate("pre-ship", project, dynamicsDesignWeeks, dynamicsMfgWeeks);
      return addWeeks(preShipDate, 9);
    }

    default: {
      // Unknown trigger — estimate midpoint of total lead time
      if (project.quoteDate && project.leadtimeWeeks) {
        return addWeeks(project.quoteDate, Math.ceil(project.leadtimeWeeks / 2));
      }
      return new Date(now.getFullYear(), now.getMonth() + 3, 15);
    }
  }
}

/**
 * Legacy date estimator — used when no Dynamics data is available.
 * Only handles "1st Payment" and "Final Payment" labels.
 */
function estimatePaymentDate(
  label: string,
  project: ParsedProject
): Date {
  if (label === "1st Payment") {
    return estimateMilestoneDate("start", project);
  }
  // For "Final Payment" or anything else, estimate as pre-ship
  return estimateMilestoneDate("pre-ship", project);
}

// ─── Main Sync ────────────────────────────────────────────────

/**
 * Sync ClickUp projects into the local database.
 * Enriches with Dynamics payment terms when available.
 * Preserves "invoiced" milestones that were matched by AR sync.
 */
export async function syncClickUp(): Promise<SyncResult> {
  const result: SyncResult = { total: 0, synced: 0, skipped: 0, errors: [], dynamicsEnriched: 0 };

  // Fetch all active tasks from ClickUp
  let tasks;
  try {
    tasks = await fetchActiveTasks();
  } catch (e) {
    result.errors.push(`Failed to fetch tasks: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  result.total = tasks.length;

  // Batch-fetch Dynamics Won quotes for enrichment (graceful degradation)
  let dynamicsMap = new Map<string, DynamicsQuoteData>();
  try {
    dynamicsMap = await Promise.race([
      fetchDynamicsQuoteMap(),
      new Promise<Map<string, DynamicsQuoteData>>((_, reject) =>
        setTimeout(() => reject(new Error("Dynamics batch fetch timeout (60s)")), 60000)
      ),
    ]);
    console.log(`[SYNC] Dynamics enrichment: ${dynamicsMap.size} Won quotes loaded`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[SYNC] Dynamics enrichment unavailable: ${msg}`);
    result.errors.push(`[Dynamics enrichment skipped: ${msg}]`);
    // Continue with ClickUp-only sync
  }

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
      // Check if Dynamics has better payment terms for this project
      const dynamicsData = dynamicsMap.get(parsed.externalId);
      let dynamicsMilestones: ComputedMilestone[] | null = null;
      let resolvedPaymentTerms: string | null = parsed.paymentTerms;
      let dynamicsDesignWeeks: number | null = null;
      let dynamicsMfgWeeks: number | null = null;

      if (dynamicsData) {
        const decoded = decodeQuote(
          dynamicsData.opp,
          dynamicsData.quote,
          dynamicsData.lineItems
        );
        console.log(`[SYNC] ${parsed.externalId}: Dynamics terms source="${decoded.paymentTermsSource}", milestones=${decoded.milestones.length}, hasQuote=${!!dynamicsData.quote}, hasLineItems=${!!dynamicsData.lineItems}`);
        // Only use Dynamics milestones if we got real terms (not default 50/50)
        if (decoded.paymentTermsSource !== "default" && decoded.milestones.length > 0) {
          dynamicsMilestones = decoded.milestones;
          resolvedPaymentTerms = decoded.paymentTermsResolved;
          dynamicsDesignWeeks = decoded.designWeeks;
          dynamicsMfgWeeks = decoded.manufacturingWeeks;
          result.dynamicsEnriched!++;
        }
      }

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
          paymentTerms: resolvedPaymentTerms,
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
          paymentTerms: resolvedPaymentTerms,
        },
      });

      // Preserve "invoiced" milestones from AR matching before replacing
      const existingMilestones = await prisma.paymentMilestone.findMany({
        where: { projectId: project.id },
      });
      const invoicedByLabel = new Map<string, { status: string; invoiceId: string | null; expectedDate: Date }>();
      for (const em of existingMilestones) {
        if ((em.status === "invoiced" || em.status === "received") && em.label) {
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

      // Use Dynamics milestones if available, otherwise ClickUp milestones
      if (dynamicsMilestones) {
        // Dynamics provides structure (amounts, triggers), ClickUp provides timing
        for (let i = 0; i < dynamicsMilestones.length; i++) {
          const dms = dynamicsMilestones[i];

          // Check for prior invoiced/received state
          // Try exact label match first, then "Final Payment" for the last milestone
          let priorInvoiced = invoicedByLabel.get(dms.label);
          if (!priorInvoiced && i === dynamicsMilestones.length - 1) {
            priorInvoiced = invoicedByLabel.get("Final Payment");
          }

          // Check if ClickUp says this milestone is received
          const clickupMs = parsed.milestones.find((m) => m.label === dms.label)
            || (i === 0 ? parsed.milestones.find((m) => m.label === "1st Payment") : null)
            || (i === dynamicsMilestones.length - 1 ? parsed.milestones.find((m) => m.label === "Final Payment") : null);
          const clickupSaysReceived = clickupMs?.status === "received";

          let expectedDate: Date;
          let status: string;
          let invoiceId: string | null = null;

          if (clickupSaysReceived && clickupMs?.expectedDate) {
            // ClickUp confirms received — use ClickUp date
            expectedDate = clickupMs.expectedDate;
            status = "received";
          } else if (priorInvoiced) {
            // Restore AR-matched invoiced/received state
            expectedDate = priorInvoiced.expectedDate;
            status = priorInvoiced.status;
            invoiceId = priorInvoiced.invoiceId;
          } else {
            // Estimate date from ClickUp timing, using Dynamics trigger
            expectedDate = estimateMilestoneDate(
              dms.trigger,
              parsed,
              dynamicsDesignWeeks,
              dynamicsMfgWeeks
            );
            status = "pending";
          }

          await prisma.paymentMilestone.create({
            data: {
              projectId: project.id,
              label: dms.label,
              amount: dms.amount,
              expectedDate,
              status,
              invoiceId,
            },
          });
        }
      } else {
        // No Dynamics data — use ClickUp milestones (existing behavior)
        for (const ms of parsed.milestones) {
          const priorInvoiced = invoicedByLabel.get(ms.label);

          let expectedDate: Date;
          let status = ms.status;
          let invoiceId: string | null = null;

          if (ms.status === "received" && ms.expectedDate) {
            expectedDate = ms.expectedDate;
          } else if (priorInvoiced) {
            expectedDate = priorInvoiced.expectedDate;
            status = priorInvoiced.status as "pending" | "invoiced" | "received";
            invoiceId = priorInvoiced.invoiceId;
          } else if (ms.expectedDate) {
            expectedDate = ms.expectedDate;
          } else {
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
