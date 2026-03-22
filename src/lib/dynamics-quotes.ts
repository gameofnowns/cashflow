/**
 * Shared Dynamics 365 quote logic — option set decoders, payment term parsing,
 * milestone date computation, and API helpers.
 *
 * Used by:
 *  - /api/dynamics/closed-won
 *  - /api/dynamics/pipeline-forecast
 *  - /api/debug/quote-alignment
 */

import { prisma } from "./db";

// ─── Environment ────────────────────────────────────────────

const DYNAMICS_URL =
  process.env.DYNAMICS_URL || "https://arktura.crm4.dynamics.com";
const TENANT_ID = process.env.DYNAMICS_TENANT_ID || "";
const CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || "";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const API_BASE = `${DYNAMICS_URL}/api/data/v9.2`;

// ─── Option Set Decoders ────────────────────────────────────

export const PROJECT_TYPE_MAP: Record<number, string> = {
  211680000: "X",
  211680001: "Y",
  211680002: "Z",
  211680003: "Marketing",
  211680004: "Mockup",
  211680005: "Other",
};

export const DESIGN_WEEKS_MAP: Record<number, number> = {
  211680008: 0,
  211680000: 1,
  211680001: 2,
  211680002: 3,
  211680003: 4,
  211680004: 5,
  211680005: 6,
  211680006: 7,
  211680007: 8,
};

export function decodeManufacturingWeeks(val: number | null): number | null {
  if (val === null || val === undefined) return null;
  return val - 211680000 + 1;
}

export const PAYMENT_TERMS_MAP: Record<number, string> = {
  211680000: "100% start",
  211680001: "50% start, 50% mid-manufacture",
  211680002: "50% start, 50% pre-ship",
  211680003: "100% pre-ship",
  211680004: "100% DUE",
  211680005: "100% NET 30",
  211680006: "100% NET 60",
  211680007: "50% start, 50% NET 30",
  211680008: "50% start, 50% NET 60",
  211680009: "30% start, 40% mid-manufacture, 30% pre-ship",
  211680010: "30% start, 30% mid-manufacture, 40% pre-ship",
  211680011: "30% start, 40% pre-ship, 30% NET 30",
  211680012: "30% start, 30% pre-ship, 40% NET 30",
  211680013: "40% start, 30% pre-ship, 30% NET 30",
  211680014: "50% Shops, 50% pre-ship",
  211680015: "30% Shops, 30% approval, 40% pre-ship",
  211680016: "30% Shops, 40% approval, 30% pre-ship",
  211680017: "50% approval, 50% pre-ship",
  211680018: "30% approval, 40% pre-ship, 30% NET 30",
  211680019: "40% approval, 30% pre-ship, 30% NET 30",
  211680020: "50% manufacture, 50% NET 30",
  211680021: "50% manufacture, 50% pre-ship",
  211680022: "30% Deposit, 40% pre-ship, 30% NET 30 days",
  211680023: "40% Deposit, 30% pre-ship, 30% NET 30 days",
  211680024: "30% Deposit, 50% pre-ship, 20% NET 30 days",
  211680025: "Manual Entry",
};

export const CRATING_MAP: Record<number, string> = {
  211680000: "Palett (5%)",
  211680001: "Standard (7%)",
  211680002: "Pre Assembled (20%)",
  211680003: "Custom bulky (25%)",
};

export const SHIPPING_MAP: Record<number, string> = {
  211680000: "Ex works (0%)",
  211680001: "Standard (10%)",
  211680002: "Pre Assembled (20%)",
  211680003: "Sea (25%)",
  211680004: "Air (35%)",
};

/** Estimated shipping transit time in weeks by shipping type */
export const SHIPPING_WEEKS: Record<number, number> = {
  211680000: 0,  // Ex works — client collects, no transit
  211680001: 2,  // Standard — road delivery ~2 weeks
  211680002: 2,  // Pre Assembled — similar to standard
  211680003: 4,  // Sea — ocean freight ~4 weeks
  211680004: 1,  // Air — air freight ~1 week
};

// ─── Token & Fetch ──────────────────────────────────────────

export async function getToken(): Promise<string> {
  const stored = await prisma.oAuthToken.findUnique({
    where: { provider: "dynamics" },
  });
  if (!stored) throw new Error("No Dynamics token");

  if (new Date() >= stored.expiresAt && stored.refreshToken) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
        scope: `${DYNAMICS_URL}/user_impersonation offline_access`,
      }),
    });
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    const data = await res.json();
    await prisma.oAuthToken.update({
      where: { provider: "dynamics" },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || stored.refreshToken,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      },
    });
    return data.access_token;
  }

  return stored.accessToken;
}

export async function dynamicsFetch(path: string, token: string) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamics ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Payment Timeline Logic ─────────────────────────────────

export interface MilestoneDef {
  label: string;
  percentage: number;
  trigger: string;
}

export interface ComputedMilestone {
  label: string;
  percentage: number;
  amount: number;
  trigger: string;
  estimatedDate: string;
  reasoning: string;
}

export function parsePaymentTermsIntoMilestones(
  termsText: string
): MilestoneDef[] {
  const milestones: MilestoneDef[] = [];
  // Split on semicolons first (line-item format), then commas
  const rawParts = termsText.includes(";")
    ? termsText.split(";").map((s) => s.trim())
    : termsText.split(",").map((s) => s.trim());

  // Filter to only parts that contain a percentage
  const parts = rawParts.filter((p) => /\d+%/.test(p));

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const pctMatch = part.match(/(\d+)%/);
    if (!pctMatch) continue;
    const pct = parseInt(pctMatch[1]) / 100;

    const rest = part.replace(/\d+%\s*/, "").toLowerCase();
    let trigger = "start";
    if (rest.includes("net 60")) trigger = "NET 60";
    else if (rest.includes("net 30")) trigger = "NET 30";
    else if (rest.includes("pre-ship") || rest.includes("pre ship") || rest.includes("preship") || rest.includes("shipment"))
      trigger = "pre-ship";
    else if (rest.includes("mid-manufacture")) trigger = "mid-manufacture";
    else if (rest.includes("approval") || rest.includes("drawings"))
      trigger = "approval";
    else if (rest.includes("shops")) trigger = "shops";
    else if (rest.includes("dispatch") || rest.includes("balance"))
      trigger = "NET 30";
    else if (
      rest.includes("start") ||
      rest.includes("manufacture") ||
      rest.includes("deposit") ||
      rest.includes("due")
    )
      trigger = "start";

    const labels = [
      "1st Payment",
      "2nd Payment",
      "3rd Payment",
      "4th Payment",
    ];
    milestones.push({
      label: labels[i] || `Payment ${i + 1}`,
      percentage: pct,
      trigger,
    });
  }

  return milestones;
}

/**
 * Extract payment terms text from quote line items.
 * Looks for a line item named "Payment Terms" (€0 info line)
 * and parses the description for percentage-based terms.
 */
export function extractPaymentTermsFromLineItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lineItems: Record<string, any>[]
): string | null {
  if (!lineItems || !Array.isArray(lineItems)) return null;

  for (const li of lineItems) {
    const name = (li.quotedetailname || li.productdescription || "").toLowerCase();
    if (name.includes("payment term")) {
      const desc = li.description || "";
      // Check it actually contains percentages
      if (/\d+%/.test(desc)) {
        // Strip the leading "Payment Terms - " prefix if present
        return desc.replace(/^payment\s+terms\s*[-–—:]\s*/i, "").trim();
      }
    }
  }
  return null;
}

export function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
}

export function computeMilestoneDate(
  trigger: string,
  quoteDate: Date,
  designWeeks: number,
  mfgWeeks: number,
  shippingWeeks: number = 2
): { date: Date; reasoning: string } {
  const totalWeeks = designWeeks + mfgWeeks;
  const dispatchWeeks = totalWeeks + shippingWeeks; // production + shipping = dispatch

  switch (trigger) {
    case "start":
      return {
        date: addWeeks(quoteDate, 1),
        reasoning: "Quote signed → invoice ~1 week",
      };
    case "shops":
      return {
        date: addWeeks(quoteDate, designWeeks),
        reasoning: `Design phase complete: ${designWeeks} weeks`,
      };
    case "approval":
      return {
        date: addWeeks(quoteDate, designWeeks + 2),
        reasoning: `Design ${designWeeks}wk + ~2wk client approval`,
      };
    case "mid-manufacture":
      return {
        date: addWeeks(
          quoteDate,
          designWeeks + Math.ceil(mfgWeeks / 2)
        ),
        reasoning: `Design ${designWeeks}wk + ${Math.ceil(mfgWeeks / 2)}wk (mid-mfg)`,
      };
    case "pre-ship":
      return {
        date: addWeeks(quoteDate, totalWeeks),
        reasoning: `Full lead time: ${designWeeks}wk design + ${mfgWeeks}wk mfg`,
      };
    case "NET 30":
      return {
        date: addWeeks(quoteDate, dispatchWeeks + 4),
        reasoning: `Lead ${totalWeeks}wk + ${shippingWeeks}wk shipping + 30 days`,
      };
    case "NET 60":
      return {
        date: addWeeks(quoteDate, dispatchWeeks + 9),
        reasoning: `Lead ${totalWeeks}wk + ${shippingWeeks}wk shipping + 60 days`,
      };
    default:
      return {
        date: addWeeks(quoteDate, Math.ceil(totalWeeks / 2)),
        reasoning: `Estimated midpoint: ${totalWeeks} weeks`,
      };
  }
}

// ─── Quote Decoding ─────────────────────────────────────────

export interface DecodedQuote {
  quoteid: string;
  opportunityId: string;
  opportunityName: string;
  name: string;
  quotenumber: string;
  createdon: string;
  projectType: string | null;
  designWeeks: number | null;
  manufacturingWeeks: number | null;
  totalLeadWeeks: number | null;
  paymentTermsCode: number | null;
  paymentTermsText: string | null;
  manualPaymentTerms: string | null;
  paymentTermsSource: string;
  paymentTermsResolved: string;
  totalPrice: number;
  subtotal: number | null;
  crating: string | null;
  shipping: string | null;
  shippingWeeks: number;
  milestones: ComputedMilestone[];
  jobNo: string | null;
}

/**
 * Decode a raw Dynamics quote + its parent opportunity into a structured object
 * with computed payment milestones.
 */
export function decodeQuote(
  opp: {
    opportunityid: string;
    name: string;
    estimatedvalue?: number;
    actualclosedate?: string;
    estimatedclosedate?: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: Record<string, any> | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quoteLineItems?: Record<string, any>[] | null
): DecodedQuote {
  const projectType = q
    ? PROJECT_TYPE_MAP[q.nown_os_projecttype] || null
    : null;
  const designWeeks = q
    ? (DESIGN_WEEKS_MAP[q.nown_designcoordinationweeks] ?? null)
    : null;
  const mfgWeeks = q
    ? decodeManufacturingWeeks(q.nown_manufacturingtimeweeks)
    : null;
  const totalLead =
    designWeeks !== null && mfgWeeks !== null
      ? designWeeks + mfgWeeks
      : null;
  const paymentTermsText = q
    ? PAYMENT_TERMS_MAP[q.paymenttermscode] || null
    : null;

  const totalPrice =
    q?.nown_mon_totalprice || q?.totalamount || opp.estimatedvalue || 0;

  // Anchor date: actual close date (won) or estimated close date (pipeline)
  const anchorDate = opp.actualclosedate
    ? new Date(opp.actualclosedate)
    : opp.estimatedclosedate
      ? new Date(opp.estimatedclosedate)
      : q?.createdon
        ? new Date(q.createdon)
        : new Date();

  // Determine payment terms — resolution chain:
  // 1. Standard payment terms code (header dropdown)
  // 2. Manual payment terms text field (if it contains actual % terms)
  // 3. Quote line items (look for a "Payment Terms" product line)
  // 4. Default fallback: 50/50
  let termsToUse = "50% manufacture, 50% pre-ship";
  let termsSource = "default";

  if (q) {
    const manual = (q.nown_manualentrypaymentterms || "").trim();
    const manualHasTerms = manual && !manual.toLowerCase().includes("see line") && /\d+%/.test(manual);
    const lineItemTerms = quoteLineItems
      ? extractPaymentTermsFromLineItems(quoteLineItems)
      : null;

    if (paymentTermsText && paymentTermsText !== "Manual Entry") {
      // 1. Standard payment terms from header dropdown
      termsToUse = paymentTermsText;
      termsSource = "standard";
    } else if (manualHasTerms) {
      // 2. Manual terms field has actual parseable terms
      termsToUse = manual;
      termsSource = "manual";
    } else if (lineItemTerms) {
      // 3. Check quote line items for a "Payment Terms" product line
      termsToUse = lineItemTerms;
      termsSource = "lineItem";
    }
    // else: stays as default 50/50
  }

  const milestoneDefs = parsePaymentTermsIntoMilestones(termsToUse);
  const dw = designWeeks ?? 0;
  const mw = mfgWeeks ?? 8;
  const sw = q ? (SHIPPING_WEEKS[q.nown_os_shippingtype] ?? 2) : 2;

  const milestones = milestoneDefs.map((m) => {
    const { date, reasoning } = computeMilestoneDate(
      m.trigger,
      anchorDate,
      dw,
      mw,
      sw
    );
    return {
      label: m.label,
      percentage: m.percentage,
      amount: Math.round(totalPrice * m.percentage * 100) / 100,
      trigger: m.trigger,
      estimatedDate: date.toISOString(),
      reasoning,
    };
  });

  // Extract job number
  let jobNo: string | null = null;
  const jobMatch = opp.name?.match(/(\d{2}-[XYZ]\d{3,4})/);
  if (jobMatch) jobNo = jobMatch[1];
  if (!jobNo && q?.name) {
    const nameMatch = q.name.match(/(\d{2}-[XYZ]\d{3,4})/);
    if (nameMatch) jobNo = nameMatch[1];
  }

  return {
    quoteid: q?.quoteid || opp.opportunityid,
    opportunityId: opp.opportunityid,
    opportunityName: opp.name,
    name: q?.name || opp.name,
    quotenumber: q?.quotenumber || "—",
    createdon: opp.actualclosedate || opp.estimatedclosedate || q?.createdon || "",
    projectType,
    designWeeks,
    manufacturingWeeks: mfgWeeks,
    totalLeadWeeks: totalLead,
    paymentTermsCode: q?.paymenttermscode ?? null,
    paymentTermsText,
    manualPaymentTerms: q?.nown_manualentrypaymentterms || null,
    paymentTermsSource: termsSource,
    paymentTermsResolved: termsToUse,
    totalPrice,
    subtotal: q?.nown_mon_subtotal || null,
    crating: q ? CRATING_MAP[q.nown_os_cratintype] || null : null,
    shipping: q ? SHIPPING_MAP[q.nown_os_shippingtype] || null : null,
    shippingWeeks: q ? (SHIPPING_WEEKS[q.nown_os_shippingtype] ?? 2) : 2, // default 2 weeks if unknown
    milestones,
    jobNo,
  };
}

/** Standard quote $select fields for Dynamics OData queries */
export const QUOTE_SELECT_FIELDS =
  "quoteid,name,quotenumber,createdon,statecode,nown_os_projecttype,nown_designcoordinationweeks,nown_manufacturingtimeweeks,paymenttermscode,nown_mon_totalprice,nown_mon_subtotal,nown_os_cratintype,nown_os_shippingtype,_opportunityid_value,nown_manualentrypaymentterms,nown_leadtime,totalamount";
