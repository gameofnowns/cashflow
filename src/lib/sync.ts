import { prisma } from "./db";
import { fetchActiveTasks, parseTask, type ParsedProject } from "./clickup";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  extractPaymentTermsFromLineItems,
  addWeeks,
  computeMilestoneDate,
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
 * Fetch Dynamics quote data for a specific set of job numbers.
 * Only fetches quotes for projects we're about to sync (not all Won opps).
 *
 * Wrapped in a timeout + try/catch so ClickUp sync continues if Dynamics is down.
 */
async function fetchDynamicsQuoteMap(
  jobNumbers: string[]
): Promise<Map<string, DynamicsQuoteData>> {
  const map = new Map<string, DynamicsQuoteData>();
  if (jobNumbers.length === 0) return map;

  const token = await getToken();

  // Fetch Won opportunities that match our job numbers
  // Use contains() filter for each — batch into groups to stay under URL length limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < jobNumbers.length; i += BATCH_SIZE) {
    const batch = jobNumbers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (jobNo) => {
        // Find the Won opportunity for this job number
        const oppsResp = await dynamicsFetch(
          `/opportunities?$filter=statecode eq 1 and contains(name,'${jobNo}')&$top=1&$select=opportunityid,name,estimatedvalue,actualclosedate,estimatedclosedate`,
          token
        );
        const opp = oppsResp.value?.[0];
        if (!opp) return null;

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

// ─── Anchor-Based Date Estimation ─────────────────────────────

/**
 * Determine the anchor date for projecting payment milestones.
 *
 * Two modes:
 * - TRIGGERED: 1st Payment is Requested/Received → use that actual date
 * - PROVISIONAL: not yet triggered → use ClickUp task creation date
 *
 * Returns { anchorDate, isProvisional }
 */
function getProjectAnchor(project: ParsedProject): {
  anchorDate: Date;
  isProvisional: boolean;
} {
  if (project.firstPaymentTriggered && project.firstPaymentDate) {
    return { anchorDate: project.firstPaymentDate, isProvisional: false };
  }
  // Provisional: use task creation date (quoteDate is our proxy)
  return {
    anchorDate: project.quoteDate || new Date(),
    isProvisional: true,
  };
}

/**
 * Legacy date estimator — used when no Dynamics data is available.
 * Uses anchor + simple lead time estimation.
 */
function estimatePaymentDate(
  label: string,
  project: ParsedProject
): Date {
  const { anchorDate } = getProjectAnchor(project);
  const leadWeeks = project.leadtimeWeeks || 12;
  if (label === "1st Payment") {
    return addWeeks(anchorDate, 1);
  }
  return addWeeks(anchorDate, leadWeeks);
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

  // Phase 1: Parse all ClickUp tasks first to collect job numbers
  const parsedTasks: { task: typeof tasks[0]; parsed: ParsedProject }[] = [];
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
    parsedTasks.push({ task, parsed });
  }

  // Phase 2: Batch-fetch Dynamics quotes for parsed job numbers only
  const jobNumbers = parsedTasks.map((t) => t.parsed.externalId);
  let dynamicsMap = new Map<string, DynamicsQuoteData>();
  try {
    dynamicsMap = await Promise.race([
      fetchDynamicsQuoteMap(jobNumbers),
      new Promise<Map<string, DynamicsQuoteData>>((_, reject) =>
        setTimeout(() => reject(new Error("Dynamics batch fetch timeout (120s)")), 120000)
      ),
    ]);
    console.log(`[SYNC] Dynamics enrichment: ${dynamicsMap.size}/${jobNumbers.length} projects matched`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[SYNC] Dynamics enrichment unavailable: ${msg}`);
    result.errors.push(`[Dynamics enrichment skipped: ${msg}]`);
  }

  // Phase 3: Upsert projects with enriched milestones
  for (const { parsed } of parsedTasks) {

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

      // Determine anchor date for this project
      const { anchorDate, isProvisional } = getProjectAnchor(parsed);
      const dw = dynamicsDesignWeeks ?? Math.round((parsed.leadtimeWeeks || 12) * 0.4);
      const mw = dynamicsMfgWeeks ?? Math.round((parsed.leadtimeWeeks || 12) * 0.6);

      // Use Dynamics milestones if available, otherwise ClickUp milestones
      if (dynamicsMilestones) {
        // Dynamics provides structure (amounts, triggers)
        // Anchor date + Dynamics lead times provide the payment schedule
        for (let i = 0; i < dynamicsMilestones.length; i++) {
          const dms = dynamicsMilestones[i];

          // Check for prior invoiced/received state
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
            // Compute date from anchor + Dynamics lead times
            const computed = computeMilestoneDate(dms.trigger, anchorDate, dw, mw);
            expectedDate = computed.date;
            status = isProvisional ? "pending" : "pending";
          }

          await prisma.paymentMilestone.create({
            data: {
              projectId: project.id,
              label: isProvisional && !clickupSaysReceived && !priorInvoiced
                ? `${dms.label} (provisional)`
                : dms.label,
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
