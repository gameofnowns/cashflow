import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const DYNAMICS_URL =
  process.env.DYNAMICS_URL || "https://arktura.crm4.dynamics.com";
const TENANT_ID = process.env.DYNAMICS_TENANT_ID || "";
const CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || "";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const API_BASE = `${DYNAMICS_URL}/api/data/v9.2`;

// ─── Option Set Decoders ────────────────────────────────────

const PROJECT_TYPE_MAP: Record<number, string> = {
  211680000: "X",
  211680001: "Y",
  211680002: "Z",
  211680003: "Marketing",
  211680004: "Mockup",
  211680005: "Other",
};

const DESIGN_WEEKS_MAP: Record<number, number> = {
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

function decodeManufacturingWeeks(val: number | null): number | null {
  if (val === null || val === undefined) return null;
  return val - 211680000 + 1;
}

const PAYMENT_TERMS_MAP: Record<number, string> = {
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

const CRATING_MAP: Record<number, string> = {
  211680000: "Palett (5%)",
  211680001: "Standard (7%)",
  211680002: "Pre Assembled (20%)",
  211680003: "Custom bulky (25%)",
};

const SHIPPING_MAP: Record<number, string> = {
  211680000: "Ex works (0%)",
  211680001: "Standard (10%)",
  211680002: "Pre Assembled (20%)",
  211680003: "Sea (25%)",
  211680004: "Air (35%)",
};

// ─── Token & Fetch ──────────────────────────────────────────

async function getToken(): Promise<string> {
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

async function dynamicsFetch(path: string, token: string) {
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

interface MilestoneDef {
  label: string;
  percentage: number;
  trigger: string; // start, shops, approval, mid-manufacture, pre-ship, NET 30, NET 60
}

function parsePaymentTermsIntoMilestones(
  termsText: string
): MilestoneDef[] {
  const milestones: MilestoneDef[] = [];
  // Split on commas
  const parts = termsText.split(",").map((s) => s.trim());

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const pctMatch = part.match(/(\d+)%/);
    if (!pctMatch) continue;
    const pct = parseInt(pctMatch[1]) / 100;

    // Determine trigger from the text after the percentage
    const rest = part.replace(/\d+%\s*/, "").toLowerCase();
    let trigger = "start";
    if (rest.includes("net 60")) trigger = "NET 60";
    else if (rest.includes("net 30")) trigger = "NET 30";
    else if (rest.includes("pre-ship") || rest.includes("preship"))
      trigger = "pre-ship";
    else if (rest.includes("mid-manufacture")) trigger = "mid-manufacture";
    else if (rest.includes("approval")) trigger = "approval";
    else if (rest.includes("shops")) trigger = "shops";
    else if (
      rest.includes("start") ||
      rest.includes("manufacture") ||
      rest.includes("deposit") ||
      rest.includes("due")
    )
      trigger = "start";

    const labels = ["1st Payment", "2nd Payment", "3rd Payment", "4th Payment"];
    milestones.push({
      label: labels[i] || `Payment ${i + 1}`,
      percentage: pct,
      trigger,
    });
  }

  return milestones;
}

function addWeeks(date: Date, weeks: number): Date {
  return new Date(date.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
}

function computeMilestoneDate(
  trigger: string,
  quoteDate: Date,
  designWeeks: number,
  mfgWeeks: number
): { date: Date; reasoning: string } {
  const totalWeeks = designWeeks + mfgWeeks;

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
        date: addWeeks(quoteDate, designWeeks + Math.ceil(mfgWeeks / 2)),
        reasoning: `Design ${designWeeks}wk + ${Math.ceil(mfgWeeks / 2)}wk (mid-mfg)`,
      };
    case "pre-ship":
      return {
        date: addWeeks(quoteDate, totalWeeks),
        reasoning: `Full lead time: ${designWeeks}wk design + ${mfgWeeks}wk mfg`,
      };
    case "NET 30":
      return {
        date: addWeeks(quoteDate, totalWeeks + 4),
        reasoning: `Lead time ${totalWeeks}wk + 30 days`,
      };
    case "NET 60":
      return {
        date: addWeeks(quoteDate, totalWeeks + 9),
        reasoning: `Lead time ${totalWeeks}wk + 60 days`,
      };
    default:
      return {
        date: addWeeks(quoteDate, Math.ceil(totalWeeks / 2)),
        reasoning: `Estimated midpoint: ${totalWeeks} weeks`,
      };
  }
}

// ─── Main Handler ───────────────────────────────────────────

interface DecodedQuote {
  quoteid: string;
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
  totalPrice: number | null;
  subtotal: number | null;
  crating: string | null;
  shipping: string | null;
  opportunityId: string | null;
  milestones: Array<{
    label: string;
    percentage: number;
    amount: number;
    trigger: string;
    estimatedDate: string;
    reasoning: string;
  }>;
  clickup: {
    matched: boolean;
    jobNo: string | null;
    projectName: string | null;
    status: string | null;
    leadtimeWeeks: number | null;
    productionEta: string | null;
    prodFinished: string | null;
    shopsStatus: string | null;
    approvedShops: string | null;
    paymentTerms: string | null;
    milestones: Array<{
      label: string | null;
      amount: number;
      expectedDate: string;
      status: string;
    }>;
  } | null;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const count = parseInt(searchParams.get("count") || "5");

  try {
    const token = await getToken();

    // 1. Fetch Closed Won opportunities (statecode=1), most recent first
    const oppsResp = await dynamicsFetch(
      `/opportunities?$filter=statecode eq 1&$orderby=actualclosedate desc&$top=${count}&$select=opportunityid,name,estimatedvalue,actualclosedate,statuscode`,
      token
    );
    const opportunities = oppsResp.value || [];

    const decoded: DecodedQuote[] = [];

    for (const opp of opportunities) {
      // 2. Fetch linked won quote(s) for this opportunity
      const quotesResp = await dynamicsFetch(
        `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq 1&$top=1&$orderby=createdon desc&$select=quoteid,name,quotenumber,createdon,nown_os_projecttype,nown_designcoordinationweeks,nown_manufacturingtimeweeks,paymenttermscode,nown_mon_totalprice,nown_mon_subtotal,nown_os_cratintype,nown_os_shippingtype,_opportunityid_value,nown_manualentrypaymentterms,nown_leadtime,totalamount`,
        token
      );
      const q = quotesResp.value?.[0];

      // Decode option sets from quote (if exists) or use opportunity data
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
        ? (PAYMENT_TERMS_MAP[q.paymenttermscode] || null)
        : null;

      // Use quote total or fall back to opportunity estimated value
      const totalPrice = q?.nown_mon_totalprice || q?.totalamount || opp.estimatedvalue || 0;

      // Anchor date: actual close date from opportunity (= quote signed date)
      const anchorDate = opp.actualclosedate
        ? new Date(opp.actualclosedate)
        : q?.createdon
          ? new Date(q.createdon)
          : new Date();

      // Compute milestones
      const termsToUse = q
        ? (paymentTermsText === "Manual Entry"
            ? q.nown_manualentrypaymentterms || "100% DUE"
            : paymentTermsText || "50% manufacture, 50% pre-ship")
        : "50% manufacture, 50% pre-ship";

      const milestoneDefs = parsePaymentTermsIntoMilestones(termsToUse);
      const dw = designWeeks ?? 0;
      const mw = mfgWeeks ?? 8;

      const milestones = milestoneDefs.map((m) => {
        const { date, reasoning } = computeMilestoneDate(
          m.trigger,
          anchorDate,
          dw,
          mw
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

      // 3. Extract job number from opportunity name
      let jobNo: string | null = null;
      const jobMatch = opp.name?.match(/(\d{2}-[XYZ]\d{3,4})/);
      if (jobMatch) jobNo = jobMatch[1];

      // Also try quote name
      if (!jobNo && q?.name) {
        const nameMatch = q.name.match(/(\d{2}-[XYZ]\d{3,4})/);
        if (nameMatch) jobNo = nameMatch[1];
      }

      // 4. Cross-reference with ClickUp project in DB
      let clickupData: DecodedQuote["clickup"] = null;
      if (jobNo) {
        const project = await prisma.project.findFirst({
          where: { externalId: jobNo, source: "clickup" },
          include: { milestones: true },
        });
        if (project) {
          clickupData = {
            matched: true,
            jobNo,
            projectName: project.name,
            status: project.status,
            leadtimeWeeks: project.leadtimeWeeks,
            productionEta: project.productionEta?.toISOString() || null,
            prodFinished: project.prodFinishedDate?.toISOString() || null,
            shopsStatus: project.shopsStatus,
            approvedShops: project.approvedShopsDate?.toISOString() || null,
            paymentTerms: project.paymentTerms,
            milestones: project.milestones.map((m) => ({
              label: m.label,
              amount: m.amount,
              expectedDate: m.expectedDate.toISOString(),
              status: m.status,
            })),
          };
        } else {
          clickupData = {
            matched: false,
            jobNo,
            projectName: null,
            status: null,
            leadtimeWeeks: null,
            productionEta: null,
            prodFinished: null,
            shopsStatus: null,
            approvedShops: null,
            paymentTerms: null,
            milestones: [],
          };
        }
      }

      decoded.push({
        quoteid: q?.quoteid || opp.opportunityid,
        opportunityName: opp.name,
        name: q?.name || opp.name,
        quotenumber: q?.quotenumber || "—",
        createdon: opp.actualclosedate || q?.createdon || "",
        projectType,
        designWeeks,
        manufacturingWeeks: mfgWeeks,
        totalLeadWeeks: totalLead,
        paymentTermsCode: q?.paymenttermscode ?? null,
        paymentTermsText,
        manualPaymentTerms: q?.nown_manualentrypaymentterms || null,
        totalPrice,
        subtotal: q?.nown_mon_subtotal || null,
        crating: q ? (CRATING_MAP[q.nown_os_cratintype] || null) : null,
        shipping: q ? (SHIPPING_MAP[q.nown_os_shippingtype] || null) : null,
        opportunityId: opp.opportunityid,
        milestones,
        clickup: clickupData,
      });
    }

    return NextResponse.json({
      _info: `${decoded.length} most recent Closed Won opportunities with linked quotes + ClickUp alignment`,
      generatedAt: new Date().toISOString(),
      quotes: decoded,
    }, { headers: CORS_HEADERS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
