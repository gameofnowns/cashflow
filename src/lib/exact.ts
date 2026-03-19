import { prisma } from "./db";

const EXACT_BASE = "https://start.exactonline.nl";
const AUTH_URL = `${EXACT_BASE}/api/oauth2/auth`;
const TOKEN_URL = `${EXACT_BASE}/api/oauth2/token`;
const API_BASE = `${EXACT_BASE}/api/v1`;

function getClientId(): string {
  const id = process.env.EXACT_CLIENT_ID;
  if (!id) throw new Error("EXACT_CLIENT_ID not set");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.EXACT_CLIENT_SECRET;
  if (!secret) throw new Error("EXACT_CLIENT_SECRET not set");
  return secret;
}

function getRedirectUri(): string {
  return process.env.EXACT_REDIRECT_URI || "http://localhost:3000/api/auth/exact/callback";
}

// ─── OAuth Flow ─────────────────────────────────────────────

/**
 * Generate the Exact Online OAuth authorization URL.
 * Redirect the user here to start the OAuth flow.
 */
export function getAuthorizationUrl(): string {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    force_login: "0",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: "authorization_code",
      redirect_uri: getRedirectUri(),
      code,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Get the division (company) ID
  const division = await fetchDivision(data.access_token);

  await prisma.oAuthToken.upsert({
    where: { provider: "exact" },
    update: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      division,
    },
    create: {
      provider: "exact",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      division,
    },
  });
}

/**
 * Refresh the access token using the stored refresh token.
 */
async function refreshAccessToken(): Promise<string> {
  const stored = await prisma.oAuthToken.findUnique({
    where: { provider: "exact" },
  });
  if (!stored) throw new Error("No Exact Online token found. Please authorize first.");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  await prisma.oAuthToken.update({
    where: { provider: "exact" },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    },
  });

  return data.access_token;
}

/**
 * Get a valid access token — refreshes automatically if expired.
 */
async function getValidToken(): Promise<{ token: string; division: string }> {
  const stored = await prisma.oAuthToken.findUnique({
    where: { provider: "exact" },
  });
  if (!stored) throw new Error("No Exact Online token found. Please authorize first at /api/auth/exact");

  // Only refresh if actually expired (no early buffer — Exact rate-limits refresh calls)
  if (new Date() >= stored.expiresAt) {
    try {
      const newToken = await refreshAccessToken();
      return { token: newToken, division: stored.division || "" };
    } catch {
      // If refresh fails with rate limit, try using existing token anyway
      return { token: stored.accessToken, division: stored.division || "" };
    }
  }

  return { token: stored.accessToken, division: stored.division || "" };
}

// ─── API Calls ──────────────────────────────────────────────

/**
 * Make an authenticated GET request to the Exact Online REST API.
 * Returns the first page of results.
 */
async function exactGet<T>(path: string): Promise<T> {
  const { token, division } = await getValidToken();
  const url = `${API_BASE}/${division}${path}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Exact API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  // Exact Online wraps results in { d: { results: [...] } } or { d: [...] }
  return (json.d?.results ?? json.d ?? json) as T;
}

/**
 * Fetch ALL pages from an Exact Online endpoint (handles 60-item pagination).
 */
async function exactGetAll<T>(path: string): Promise<T[]> {
  const { token, division } = await getValidToken();
  const allItems: T[] = [];
  let pageUrl: string = `${API_BASE}/${division}${path}`;

  for (;;) {
    const res = await fetch(pageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Exact API error ${res.status}: ${body}`);
    }

    const json = await res.json();
    const items = json.d?.results ?? json.d ?? [];
    if (Array.isArray(items)) {
      allItems.push(...items);
    }

    // Check for next page
    const next: string | undefined = json.d?.__next;
    if (!next) break;
    pageUrl = next;
  }

  return allItems;
}

/**
 * Fetch the current division (company) ID.
 */
async function fetchDivision(accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}/current/Me?$select=CurrentDivision`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("Failed to fetch division");
  const data = await res.json();
  const division = data.d?.results?.[0]?.CurrentDivision ?? data.d?.CurrentDivision;
  return String(division);
}

// ─── Financial Data ─────────────────────────────────────────

interface ExactReceivable {
  AccountName: string;
  Amount: number;
  InvoiceNumber: string;
  InvoiceDate: string;
  DueDate: string;
  CurrencyCode: string;
  Description: string;
}

interface ExactPayable {
  AccountName: string;
  Amount: number;
  InvoiceNumber: string;
  InvoiceDate: string;
  DueDate: string;
  CurrencyCode: string;
}

/**
 * Fetch outstanding receivables (AR) — paginated.
 */
export async function fetchReceivables(): Promise<{ total: number; items: ExactReceivable[] }> {
  const items = await exactGetAll<ExactReceivable>(
    "/read/financial/ReceivablesList?$select=AccountName,Amount,InvoiceNumber,InvoiceDate,DueDate,CurrencyCode,Description"
  );
  const total = items.reduce((sum, item) => sum + (item.Amount || 0), 0);
  return { total, items };
}

/**
 * Fetch outstanding payables (AP).
 * Uses PayablesList with full pagination (Exact returns max 60 per page).
 * The Exact dashboard "Purchase Outstanding Items" should match this total.
 */
export async function fetchPayables(): Promise<{ total: number; items: ExactPayable[] }> {
  const items = await exactGetAll<ExactPayable>(
    "/read/financial/PayablesList?$select=AccountName,Amount,InvoiceNumber,InvoiceDate,DueDate,CurrencyCode"
  );
  const total = items.reduce((sum, item) => sum + Math.abs(item.Amount || 0), 0);
  return { total, items };
}

/**
 * Fetch current bank balance from Exact Online.
 * Uses the financial reporting balance endpoint.
 */
export async function fetchBankBalance(): Promise<number> {
  // NOWN bank/liquid asset GL accounts (confirmed from Exact):
  // 1000 = ING Creditcard
  // 1100 = ING EUR Operations (NL91 INGB 0009 2651 80)
  // 1101 = JP Morgan Chase USD
  // 1103 = ING Bank GBP (NL02 INGB 0020 2402 95)
  // 1104 = Pleo Wallet
  // Plus NL09 account and savings — need to find their GL codes
  //
  // ReportingBalance gives period MOVEMENTS, not running balance.
  // Cumulative balance = sum of ALL movements across ALL years.
  // MUST paginate — each account can have 60+ entries across years.

  try {
    // Get all GL accounts in the 10xx-11xx range (bank/cash/liquid assets)
    const glAccounts = await exactGetAll<{ Code: string; Description: string }>(
      "/financial/GLAccounts?$select=Code,Description&$filter=startswith(Code,'10') or startswith(Code,'11')"
    );

    // Filter to bank/cash accounts only (10xx and 11xx, exclude 12xx debtors etc.)
    const bankAccounts = glAccounts.filter(a => {
      const code = parseInt(a.Code);
      return code >= 1000 && code <= 1199;
    });

    if (bankAccounts.length === 0) return 0;

    let total = 0;
    for (const account of bankAccounts) {
      try {
        // PAGINATE through all reporting balance entries for this account
        const balances = await exactGetAll<{ Amount: number }>(
          `/financial/ReportingBalance?$select=Amount&$filter=GLAccountCode eq '${account.Code}'`
        );
        for (const b of balances) {
          total += b.Amount || 0;
        }
      } catch {
        // Skip this account if query fails
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ─── AR Matching ─────────────────────────────────────────────

/**
 * Extract Job No. from an Exact invoice description.
 * Format: "26-Y2651 - GENK | BE_K.R.C. Genk_Y_SoftSpan"
 * Returns e.g. "26-Y2651" or null.
 */
export function extractJobNo(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = description.match(/\d{2}-[XYZ]\d{3,4}/);
  return match ? match[0] : null;
}

/**
 * Parse Exact Online's date format.
 * Exact returns dates as "/Date(1234567890)/" or ISO strings.
 */
function parseExactDate(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date();
  // Handle /Date(ms)/ format
  const msMatch = dateStr.match(/\/Date\((\d+)\)\//);
  if (msMatch) return new Date(Number(msMatch[1]));
  // Try ISO parse
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Match AR line items to projects and store them.
 * For matched items, updates the corresponding milestone to "invoiced".
 */
async function matchAndStoreArItems(
  items: ExactReceivable[]
): Promise<{ matched: number; unmatched: number }> {
  const now = new Date();
  let matched = 0;
  let unmatched = 0;

  // Clear previous AR line items (replace-all strategy)
  await prisma.arLineItem.deleteMany({});

  // Pre-fetch all projects for matching
  const projects = await prisma.project.findMany({
    select: { id: true, externalId: true },
  });
  const projectByJobNo = new Map(projects.map((p) => [p.externalId, p.id]));

  for (const item of items) {
    const jobNo = extractJobNo(item.Description);
    const projectId = jobNo ? projectByJobNo.get(jobNo) ?? null : null;
    const isMatched = projectId !== null;

    // Generate a stable invoice number if missing
    const invoiceNumber = String(item.InvoiceNumber || `unknown-${item.AccountName}-${item.Amount}`);

    await prisma.arLineItem.create({
      data: {
        invoiceNumber,
        accountName: item.AccountName || "",
        description: item.Description || null,
        amount: item.Amount,
        invoiceDate: parseExactDate(item.InvoiceDate),
        dueDate: parseExactDate(item.DueDate),
        currencyCode: item.CurrencyCode || "EUR",
        jobNo,
        projectId,
        matchStatus: isMatched ? "matched" : "unmatched",
        snapshotDate: now,
      },
    });

    if (isMatched && projectId) {
      matched++;
      await updateMilestoneFromAr(projectId, item);
    } else {
      unmatched++;
    }
  }

  return { matched, unmatched };
}

/**
 * Update the best-matching pending milestone to "invoiced" using AR data.
 * Matches by amount (within 10% tolerance), preferring closest match.
 * Uses "1 of 2" / "2 of 2" in description to target the right milestone.
 */
async function updateMilestoneFromAr(
  projectId: string,
  arItem: ExactReceivable
): Promise<void> {
  const milestones = await prisma.paymentMilestone.findMany({
    where: { projectId, status: "pending" },
    orderBy: { expectedDate: "asc" },
  });

  if (milestones.length === 0) return;

  // Try to identify which milestone from description ("1 of 2" = 1st, "2 of 2" = final)
  const desc = arItem.Description || "";
  let targetLabel: string | null = null;
  if (/1\s*of\s*2/i.test(desc)) targetLabel = "1st Payment";
  else if (/2\s*of\s*2/i.test(desc)) targetLabel = "Final Payment";

  // Find best matching milestone
  let bestMatch = milestones[0];
  let bestDiff = Infinity;

  for (const ms of milestones) {
    // If we identified a target label, prefer that
    if (targetLabel && ms.label === targetLabel) {
      bestMatch = ms;
      break;
    }
    // Otherwise match by closest amount (within 10% tolerance)
    const diff = Math.abs(ms.amount - arItem.Amount);
    const tolerance = ms.amount * 0.1;
    if (diff < bestDiff && diff <= tolerance) {
      bestDiff = diff;
      bestMatch = ms;
    }
  }

  // Update milestone to invoiced with actual Exact due date
  await prisma.paymentMilestone.update({
    where: { id: bestMatch.id },
    data: {
      status: "invoiced",
      invoiceId: arItem.InvoiceNumber ? String(arItem.InvoiceNumber) : null,
      expectedDate: parseExactDate(arItem.DueDate),
    },
  });
}

/**
 * Sync financial position from Exact Online into a snapshot.
 * Also matches AR items to projects and stores line items.
 */
export async function syncExactOnline(): Promise<{
  bankBalance: number;
  totalAr: number;
  totalAp: number;
  arMatching: { matched: number; unmatched: number };
}> {
  const [receivables, payables, bankBalance] = await Promise.all([
    fetchReceivables(),
    fetchPayables(),
    fetchBankBalance(),
  ]);

  // Store snapshot (keep for audit/display)
  await prisma.financialSnapshot.create({
    data: {
      snapshotDate: new Date(),
      bankBalance,
      totalAr: receivables.total,
      totalAp: payables.total,
      source: "exact",
    },
  });

  // Match AR items to projects and store line items
  const arMatching = await matchAndStoreArItems(receivables.items);

  return {
    bankBalance,
    totalAr: receivables.total,
    totalAp: payables.total,
    arMatching,
  };
}

/**
 * Check if Exact Online is connected (has valid tokens).
 */
export async function isConnected(): Promise<boolean> {
  const token = await prisma.oAuthToken.findUnique({
    where: { provider: "exact" },
  });
  return !!token;
}
