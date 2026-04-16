import { prisma } from "./db";
import {
  getToken as getDynamicsQuotesToken,
  dynamicsFetch as dynamicsQuotesFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
} from "./dynamics-quotes";

const TENANT_ID = process.env.DYNAMICS_TENANT_ID || "";
const CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || "";
const DYNAMICS_URL = process.env.DYNAMICS_URL || "https://arktura.crm4.dynamics.com";
const REDIRECT_URI = process.env.DYNAMICS_REDIRECT_URI || "https://cashflow-lake-kappa.vercel.app/api/auth/dynamics/callback";

const AUTH_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const API_BASE = `${DYNAMICS_URL}/api/data/v9.2`;

// ─── OAuth Flow ─────────────────────────────────────────────

/**
 * Generate the Dynamics OAuth authorization URL.
 */
export function getAuthorizationUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: `${DYNAMICS_URL}/user_impersonation offline_access`,
  });
  if (state) params.set("state", state);
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code,
      scope: `${DYNAMICS_URL}/user_impersonation offline_access`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamics token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await prisma.oAuthToken.upsert({
    where: { provider: "dynamics" },
    update: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresAt,
    },
    create: {
      provider: "dynamics",
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresAt,
    },
  });
}

/**
 * Get a valid access token — refreshes automatically if expired.
 */
async function getAccessToken(): Promise<string> {
  const stored = await prisma.oAuthToken.findUnique({
    where: { provider: "dynamics" },
  });

  if (!stored) throw new Error("Dynamics not connected. Click Connect first.");

  // If token is still valid, use it
  if (new Date() < stored.expiresAt) {
    return stored.accessToken;
  }

  // Refresh the token
  if (!stored.refreshToken) {
    throw new Error("Dynamics token expired and no refresh token. Reconnect.");
  }

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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamics token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await prisma.oAuthToken.update({
    where: { provider: "dynamics" },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || stored.refreshToken,
      expiresAt,
    },
  });

  return data.access_token;
}

// ─── API Calls ──────────────────────────────────────────────

async function dynamicsGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamics API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.value ?? json;
}

// ─── Opportunities ──────────────────────────────────────────

interface DynamicsOpportunity {
  opportunityid: string;
  name: string;
  estimatedvalue: number;
  closeprobability: number;
  estimatedclosedate: string;
  statuscode: number;
  statecode: number;
}

/**
 * Fetch open opportunities with close probability >= 90%.
 */
export async function fetchPipelineOpportunities(): Promise<DynamicsOpportunity[]> {
  return dynamicsGet<DynamicsOpportunity[]>(
    "/opportunities?$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,statuscode,statecode&$filter=statecode eq 0 and closeprobability ge 90"
  );
}

/**
 * Fetch ALL open opportunities (for the full pipeline view).
 */
export async function fetchAllOpportunities(): Promise<DynamicsOpportunity[]> {
  return dynamicsGet<DynamicsOpportunity[]>(
    "/opportunities?$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,statuscode,statecode&$filter=statecode eq 0&$orderby=estimatedvalue desc"
  );
}

/**
 * Sync pipeline opportunities (>=90% probability) into the database.
 */
export async function syncDynamics(): Promise<{
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
}> {
  const result = { total: 0, synced: 0, skipped: 0, errors: [] as string[] };

  let opportunities: DynamicsOpportunity[];
  try {
    opportunities = await fetchPipelineOpportunities();
  } catch (e) {
    result.errors.push(`Failed to fetch: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  result.total = opportunities.length;

  for (const opp of opportunities) {
    try {
      if (!opp.opportunityid || !opp.estimatedvalue) {
        result.skipped++;
        continue;
      }

      // Try to extract project type from name (e.g., "25-Y2600" pattern)
      const typeMatch = opp.name?.match(/\d{2}-([XYZ])\d/);
      const projectType = typeMatch ? typeMatch[1] : "Y"; // Default to Y

      const project = await prisma.project.upsert({
        where: {
          externalId_source: {
            externalId: opp.opportunityid,
            source: "dynamics",
          },
        },
        update: {
          name: opp.name || "Unnamed Opportunity",
          projectType,
          totalValue: opp.estimatedvalue,
          confidenceTier: "pipeline",
          status: "committed",
        },
        create: {
          externalId: opp.opportunityid,
          source: "dynamics",
          name: opp.name || "Unnamed Opportunity",
          projectType,
          confidenceTier: "pipeline",
          totalValue: opp.estimatedvalue,
          status: "committed",
        },
      });

      // Replace milestones using decoded Dynamics quote
      await prisma.paymentMilestone.deleteMany({
        where: { projectId: project.id },
      });

      // Fetch quote and decode with full resolution chain
      let milestoneData: { label: string; amount: number; expectedDate: Date; status: string }[] = [];
      try {
        const quotesToken = await getDynamicsQuotesToken();
        // Try Draft (0), then Active (3) quotes
        let quoteToUse = null;
        for (const sc of [0, 3]) {
          const qResp = await dynamicsQuotesFetch(
            `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}' and statecode eq ${sc}&$top=1&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS}`,
            quotesToken
          );
          if (qResp.value?.[0]) { quoteToUse = qResp.value[0]; break; }
        }

        // Conditionally fetch line items
        let lineItems = null;
        if (quoteToUse) {
          const hasTerms = quoteToUse.paymenttermscode != null;
          const manual = (quoteToUse.nown_manualentrypaymentterms || "").trim();
          const manualOk = manual && !manual.toLowerCase().includes("see line") && /\d+%/.test(manual);
          if (!hasTerms && !manualOk) {
            try {
              const liResp = await dynamicsQuotesFetch(
                `/quotedetails?$filter=_quoteid_value eq '${quoteToUse.quoteid}'&$select=quotedetailname,productdescription,description,baseamount&$top=50`,
                quotesToken
              );
              lineItems = liResp.value || null;
            } catch { /* proceed without */ }
          }
        }

        const decoded = decodeQuote(
          { opportunityid: opp.opportunityid, name: opp.name, estimatedvalue: opp.estimatedvalue, estimatedclosedate: opp.estimatedclosedate },
          quoteToUse,
          lineItems
        );

        milestoneData = decoded.milestones.map((m) => ({
          label: m.label,
          amount: m.amount,
          expectedDate: new Date(m.estimatedDate),
          status: "pending",
        }));
      } catch {
        // Fallback: simple 50/50 if quote fetch fails
        const closeDate = opp.estimatedclosedate
          ? new Date(opp.estimatedclosedate)
          : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        const aw = (d: Date, w: number) => new Date(d.getTime() + w * 7 * 24 * 60 * 60 * 1000);
        milestoneData = [
          { label: "1st Payment", amount: opp.estimatedvalue * 0.5, expectedDate: aw(closeDate, 1), status: "pending" },
          { label: "Final Payment", amount: opp.estimatedvalue * 0.5, expectedDate: aw(closeDate, projectType === "X" ? 10 : 16), status: "pending" },
        ];
      }

      if (milestoneData.length > 0) {
        await prisma.paymentMilestone.createMany({
          data: milestoneData.map((m) => ({ projectId: project.id, ...m })),
        });
      }

      result.synced++;
    } catch (e) {
      result.errors.push(`${opp.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Remove pipeline projects no longer in Dynamics
  const syncedIds = opportunities
    .filter(o => o.opportunityid)
    .map(o => o.opportunityid);

  if (syncedIds.length > 0) {
    await prisma.project.deleteMany({
      where: {
        source: "dynamics",
        confidenceTier: "pipeline",
        externalId: { notIn: syncedIds },
      },
    });
  }

  return result;
}

/**
 * Check if Dynamics is configured.
 */
export function isConfigured(): boolean {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
}

/**
 * Check if Dynamics is connected (has tokens).
 */
export async function isConnected(): Promise<boolean> {
  const token = await prisma.oAuthToken.findUnique({
    where: { provider: "dynamics" },
  });
  return !!token;
}
