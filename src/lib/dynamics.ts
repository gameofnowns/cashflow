import { prisma } from "./db";

const TENANT_ID = process.env.DYNAMICS_TENANT_ID || "";
const CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || "";
const DYNAMICS_URL = process.env.DYNAMICS_URL || "https://arktura.crm4.dynamics.com";

const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const API_BASE = `${DYNAMICS_URL}/api/data/v9.2`;

// ─── Authentication ─────────────────────────────────────────

/**
 * Get an access token using client credentials flow.
 */
async function getAccessToken(): Promise<string> {
  // Check for cached token
  const stored = await prisma.oAuthToken.findUnique({
    where: { provider: "dynamics" },
  });

  if (stored && new Date() < stored.expiresAt) {
    return stored.accessToken;
  }

  // Request new token
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: `${DYNAMICS_URL}/.default`,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamics token failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await prisma.oAuthToken.upsert({
    where: { provider: "dynamics" },
    update: {
      accessToken: data.access_token,
      refreshToken: "",
      expiresAt,
    },
    create: {
      provider: "dynamics",
      accessToken: data.access_token,
      refreshToken: "",
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

      // Replace milestones — split 50/50 based on estimated close date
      await prisma.paymentMilestone.deleteMany({
        where: { projectId: project.id },
      });

      const closeDate = opp.estimatedclosedate
        ? new Date(opp.estimatedclosedate)
        : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      await prisma.paymentMilestone.createMany({
        data: [
          {
            projectId: project.id,
            amount: opp.estimatedvalue * 0.5,
            expectedDate: closeDate,
            status: "pending",
          },
          {
            projectId: project.id,
            amount: opp.estimatedvalue * 0.5,
            expectedDate: new Date(closeDate.getFullYear(), closeDate.getMonth() + 2, closeDate.getDate()),
            status: "pending",
          },
        ],
      });

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
