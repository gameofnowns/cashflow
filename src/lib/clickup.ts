import type { ProjectType } from "./types";
import { extractFromQuotationPDF } from "./quotation-ocr";

const API_BASE = "https://api.clickup.com/api/v2";

// Custom field IDs from NOWN ClickUp workspace
const FIELD_IDS = {
  jobNo: "Job No.",
  projectType: "Project Type",
  projectValue: "Project Value",
  signedQuotation: "Signed Quotation",
  firstPaymentStatus: "1st Payment Status",
  firstPaymentDate: "1st Payment Received Date",
  finalPaymentStatus: "Final Payment Status",
  finalPaymentDate: "Final Payment Received Date",
  paymentTerms: "Payment Terms",
  fourLetter: "4LETTER",
  // Timing fields
  leadtimeWeeks: "Leadtime (week)",
  productionEta: "Prod. ETA",
  prodFinished: "Prod. Finished Date",
  dueDateShops: "Due Date Shops",
  shopsStatus: "Shops Status",
  approvedShops: "Approved Shops",
  recordSetStatus: "Record Set Status",
  dueDate: "Due Date",
  contractDeadline: "Contract Deadline",
  actualDispatch: "Actual Dispatch",
} as const;

// Project Type dropdown option IDs → our type codes
const PROJECT_TYPE_MAP: Record<string, ProjectType> = {
  "783a849b-3ba6-435b-97d6-57895ad59191": "Y",
  "0cea8809-1994-4b40-ab63-a4997a13649e": "X",
  "c0fe50ef-aef1-4d31-bd4f-71c83b5b0f4a": "Z",
};

// Payment status option IDs that mean "received"
const RECEIVED_STATUS_IDS = new Set([
  "a4e38616-129b-49b9-a18c-7182a49f7603", // 1st Payment: Received
  "3074d653-dbbf-4e5e-b836-9d92eedd4aea", // Final Payment: Received
]);

// Statuses to exclude from sync (not active projects)
const CLOSED_STATUSES = new Set([
  "shipped",
  "cancelled",
  "complete",
  "00 - complete",
  "template",
  "not started",
  "z - hold",
  "hold",
]);

/**
 * Parse European-formatted numbers: €98.521,78 → 98521.78
 * Handles: €, USD, spaces, newlines, thousands separators (. or ,), decimal separators
 */
function parseEuropeanNumber(raw: string): number {
  // Strip currency symbols, whitespace, newlines
  let s = raw.replace(/[€$£\s\n\r]/g, "").replace(/^USD/i, "").trim();
  if (!s) return 0;

  // Detect format:
  // European: 98.521,78 (dot=thousands, comma=decimal)
  // Standard: 98521.78 or 98,521.78 (comma=thousands, dot=decimal)
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastComma > lastDot) {
    // European format: dots are thousands, comma is decimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    // Standard format: commas are thousands, dot is decimal
    s = s.replace(/,/g, "");
  } else {
    // No decimal separator or ambiguous — just strip commas
    s = s.replace(/,/g, "");
  }

  return parseFloat(s);
}

interface ClickUpTask {
  id: string;
  name: string;
  status: { status: string };
  custom_fields: ClickUpCustomField[];
  date_created: string;
  date_updated: string;
  due_date: string | null;
}

interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  value: unknown;
  type_config?: {
    options?: Array<{ id: string; name: string; orderindex: number }>;
  };
}

export interface ParsedProject {
  externalId: string;
  name: string;
  projectType: ProjectType;
  totalValue: number;
  status: string;
  milestones: ParsedMilestone[];
  // Timing fields
  quoteDate: Date | null;
  leadtimeWeeks: number | null;
  productionEta: Date | null;
  prodFinishedDate: Date | null;
  dueDateShops: Date | null;
  shopsStatus: string | null;
  approvedShopsDate: Date | null;
  recordSetStatus: string | null;
  dueDate: Date | null;
  contractDeadline: Date | null;
  actualDispatch: Date | null;
  paymentTerms: string | null;
}

export interface ParsedMilestone {
  label: string;
  amount: number;
  expectedDate: Date | null;
  status: "pending" | "invoiced" | "received";
}

function getToken(): string {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error("CLICKUP_API_TOKEN not set");
  return token;
}

function getListId(): string {
  return process.env.CLICKUP_LIST_ID || "84391559";
}

async function clickupFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: getToken() },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

function getCustomField(
  task: ClickUpTask,
  fieldName: string
): ClickUpCustomField | undefined {
  return task.custom_fields.find((f) => f.name === fieldName);
}

function getDropdownValue(field: ClickUpCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined) return null;
  const idx = Number(field.value);
  const options = field.type_config?.options;
  if (!options) return null;
  const option = options.find((o) => o.orderindex === idx);
  return option?.id ?? null;
}

/** Get the display name of a dropdown option (e.g., "Approved", "In Progress") */
function getDropdownLabel(field: ClickUpCustomField | undefined): string | null {
  if (!field || field.value === null || field.value === undefined) return null;
  const idx = Number(field.value);
  const options = field.type_config?.options;
  if (!options) return null;
  const option = options.find((o) => o.orderindex === idx);
  return option?.name ?? null;
}

/** Extract a date from a ClickUp custom field (stored as ms timestamp string) */
function getDateValue(field: ClickUpCustomField | undefined): Date | null {
  if (!field?.value) return null;
  const ts = Number(field.value);
  if (isNaN(ts)) return null;
  return new Date(ts);
}

/** Extract a number from a ClickUp custom field */
function getNumberValue(field: ClickUpCustomField | undefined): number | null {
  if (!field?.value && field?.value !== 0) return null;
  const n = Number(field.value);
  return isNaN(n) ? null : n;
}

/** Extract a text value from a ClickUp custom field */
function getTextValue(field: ClickUpCustomField | undefined): string | null {
  if (!field?.value) return null;
  return String(field.value);
}

/**
 * Fetch all active tasks from the ACTIVE PROJECTS list.
 * Pages through results (100 per page).
 */
export async function fetchActiveTasks(): Promise<ClickUpTask[]> {
  const listId = getListId();
  const allTasks: ClickUpTask[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await clickupFetch<{ tasks: ClickUpTask[]; last_page: boolean }>(
      `/list/${listId}/task?page=${page}&limit=100&include_closed=false&subtasks=false`
    );
    allTasks.push(...data.tasks);
    hasMore = !data.last_page;
    page++;
  }

  return allTasks;
}

/**
 * Get the Signed Quotation attachment URL from a task, if available.
 */
function getSignedQuotationUrl(task: ClickUpTask): string | null {
  const field = getCustomField(task, FIELD_IDS.signedQuotation);
  if (!field?.value || !Array.isArray(field.value)) return null;
  const attachments = field.value as Array<{ url?: string; extension?: string }>;
  const pdf = attachments.find((a) => a.extension === "pdf" && a.url);
  return pdf?.url ?? null;
}

/**
 * Parse payment terms string from OCR into milestone split percentages.
 * Examples: "50% manufacture, 50% pre-ship" → [0.5, 0.5]
 *           "30/40/30" → [0.3, 0.4, 0.3]
 *           "100% upon delivery" → [1.0]
 */
function parsePaymentTermsSplit(terms: string | null): number[] {
  if (!terms) return [0.5, 0.5]; // Default: 50/50

  const percentages = terms.match(/(\d+)\s*%/g);
  if (percentages && percentages.length > 0) {
    const splits = percentages.map((p) => parseInt(p) / 100);
    const sum = splits.reduce((a, b) => a + b, 0);
    // Normalize if they don't sum to 1
    if (Math.abs(sum - 1) > 0.01) {
      return splits.map((s) => s / sum);
    }
    return splits;
  }

  return [0.5, 0.5]; // Default fallback
}

/**
 * Parse a ClickUp task into our project + milestones format.
 * Uses Project Value text field first, falls back to Signed Quotation PDF OCR.
 * Returns null if the task can't be mapped.
 */
export async function parseTask(task: ClickUpTask): Promise<ParsedProject | null> {
  const statusName = task.status.status.toLowerCase();

  // Skip closed/template tasks
  if (CLOSED_STATUSES.has(statusName)) return null;

  // Get Job No.
  const jobNoField = getCustomField(task, FIELD_IDS.jobNo);
  const jobNo = (jobNoField?.value as string) || null;
  if (!jobNo) return null;

  // Get Project Type
  const typeField = getCustomField(task, FIELD_IDS.projectType);
  const typeOptionId = getDropdownValue(typeField);
  const projectType = typeOptionId ? PROJECT_TYPE_MAP[typeOptionId] : null;
  if (!projectType) return null; // Skip Mock Up, INTERNAL, etc.

  // Get Project Value — try text field first, then OCR from Signed Quotation
  let totalValue = 0;
  let ocrPaymentTerms: string | null = null;

  const valueField = getCustomField(task, FIELD_IDS.projectValue);
  if (valueField?.value) {
    totalValue = parseEuropeanNumber(String(valueField.value));
  }

  // Fallback: OCR the Signed Quotation PDF
  if (!totalValue || isNaN(totalValue)) {
    const pdfUrl = getSignedQuotationUrl(task);
    if (pdfUrl) {
      try {
        const ocrData = await extractFromQuotationPDF(pdfUrl, getToken());
        totalValue = ocrData.grandTotal ?? ocrData.totalPrice ?? 0;
        ocrPaymentTerms = ocrData.paymentTerms;
      } catch {
        // OCR failed — skip this project
      }
    }
  }

  if (!totalValue || isNaN(totalValue)) return null;

  // Parse payment milestones from 1st and Final payment fields
  const milestones: ParsedMilestone[] = [];

  // 1st Payment
  const firstStatus = getCustomField(task, FIELD_IDS.firstPaymentStatus);
  const firstDate = getCustomField(task, FIELD_IDS.firstPaymentDate);
  const firstStatusId = getDropdownValue(firstStatus);

  // Determine if 1st payment is required
  const notRequiredId = "cf608606-0cb3-4d8f-800a-488124243bc7";

  // Use OCR payment terms for split if available, otherwise default 50/50
  const splits = parsePaymentTermsSplit(ocrPaymentTerms);

  if (firstStatusId !== notRequiredId) {
    const isReceived = firstStatusId ? RECEIVED_STATUS_IDS.has(firstStatusId) : false;
    const dateVal = firstDate?.value ? new Date(Number(firstDate.value)) : null;

    milestones.push({
      label: "1st Payment",
      amount: totalValue * splits[0],
      expectedDate: dateVal,
      status: isReceived ? "received" : "pending",
    });
  }

  // Final Payment
  const finalStatus = getCustomField(task, FIELD_IDS.finalPaymentStatus);
  const finalDate = getCustomField(task, FIELD_IDS.finalPaymentDate);
  const finalStatusId = getDropdownValue(finalStatus);

  const finalNotRequiredId = "243edd39-3bd9-49ea-a643-6a2aade722ce";
  if (finalStatusId !== finalNotRequiredId) {
    const isReceived = finalStatusId ? RECEIVED_STATUS_IDS.has(finalStatusId) : false;
    const dateVal = finalDate?.value ? new Date(Number(finalDate.value)) : null;

    const firstAmount = milestones.length > 0 ? milestones[0].amount : 0;
    milestones.push({
      label: "Final Payment",
      amount: totalValue - firstAmount,
      expectedDate: dateVal,
      status: isReceived ? "received" : "pending",
    });
  }

  // If no milestones were created (both not required), create a single one
  if (milestones.length === 0) {
    milestones.push({
      label: "Full Payment",
      amount: totalValue,
      expectedDate: null,
      status: "pending",
    });
  }

  // Extract timing fields
  const leadtimeWeeks = getNumberValue(getCustomField(task, FIELD_IDS.leadtimeWeeks));
  const productionEta = getDateValue(getCustomField(task, FIELD_IDS.productionEta));
  const prodFinishedDate = getDateValue(getCustomField(task, FIELD_IDS.prodFinished));
  const dueDateShops = getDateValue(getCustomField(task, FIELD_IDS.dueDateShops));
  const shopsStatus = getDropdownLabel(getCustomField(task, FIELD_IDS.shopsStatus));
  const approvedShopsDate = getDateValue(getCustomField(task, FIELD_IDS.approvedShops));
  const recordSetStatus = getDropdownLabel(getCustomField(task, FIELD_IDS.recordSetStatus));
  const contractDeadline = getDateValue(getCustomField(task, FIELD_IDS.contractDeadline));
  const actualDispatch = getDateValue(getCustomField(task, FIELD_IDS.actualDispatch));
  const paymentTermsText = getTextValue(getCustomField(task, FIELD_IDS.paymentTerms));

  // Due date: ClickUp built-in field (top-level), not a custom field
  const dueDate = task.due_date ? new Date(Number(task.due_date)) : null;

  // Quote date: use task creation date as proxy (project created at kick-off after quote signed)
  const quoteDate = task.date_created ? new Date(Number(task.date_created)) : null;

  return {
    externalId: jobNo.trim(),
    name: task.name,
    projectType,
    totalValue,
    status: statusName,
    milestones,
    quoteDate,
    leadtimeWeeks,
    productionEta,
    prodFinishedDate,
    dueDateShops,
    shopsStatus,
    approvedShopsDate,
    recordSetStatus,
    dueDate,
    contractDeadline,
    actualDispatch,
    paymentTerms: paymentTermsText || ocrPaymentTerms,
  };
}
