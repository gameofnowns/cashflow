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
  // Exact Online wraps results in { d: { results: [...] } }
  return (json.d?.results ?? json.d ?? json) as T;
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
 * Fetch outstanding receivables (AR).
 */
export async function fetchReceivables(): Promise<{ total: number; items: ExactReceivable[] }> {
  const items = await exactGet<ExactReceivable[]>(
    "/read/financial/ReceivablesList?$select=AccountName,Amount,InvoiceNumber,InvoiceDate,DueDate,CurrencyCode"
  );
  const total = items.reduce((sum, item) => sum + (item.Amount || 0), 0);
  return { total, items };
}

/**
 * Fetch outstanding payables (AP).
 */
export async function fetchPayables(): Promise<{ total: number; items: ExactPayable[] }> {
  // Try PayablesList first — use AmountDC (domestic currency) for consistent totals
  const items = await exactGet<(ExactPayable & { AmountDC?: number })[]>(
    "/read/financial/PayablesList?$select=AccountName,Amount,AmountDC,InvoiceNumber,InvoiceDate,DueDate,CurrencyCode"
  );
  // Use AmountDC if available, fall back to Amount. Use absolute values.
  const total = items.reduce((sum, item) => sum + Math.abs(item.AmountDC ?? item.Amount ?? 0), 0);
  return { total, items };
}

/**
 * Fetch current bank balance from Exact Online.
 * Uses the financial reporting balance endpoint.
 */
export async function fetchBankBalance(): Promise<number> {
  // NOWN bank accounts are GL codes 20-26
  // Sum up the ReportingBalance for all bank GL accounts
  try {
    const year = new Date().getFullYear();
    // Fetch all reporting balances for bank accounts (GL codes starting with '2' in the 20-29 range)
    const balances = await exactGet<Array<{
      GLAccountCode: string;
      GLAccountDescription: string;
      Amount: number;
      ReportingPeriod: number;
    }>>(
      `/financial/ReportingBalance?$select=GLAccountCode,GLAccountDescription,Amount,ReportingPeriod&$filter=ReportingYear eq ${year} and substringof('Bank',GLAccountDescription) eq true`
    );
    if (balances.length > 0) {
      // Get the latest period's balance for each account
      const latestByAccount = new Map<string, number>();
      for (const b of balances) {
        const existing = latestByAccount.get(b.GLAccountCode);
        if (existing === undefined || b.ReportingPeriod > 0) {
          latestByAccount.set(b.GLAccountCode, b.Amount || 0);
        }
      }
      return Array.from(latestByAccount.values()).reduce((sum, amt) => sum + amt, 0);
    }
  } catch {
    // Fallback approach
  }

  // Fallback: query each known bank account directly
  try {
    const year = new Date().getFullYear();
    let total = 0;
    for (const code of ["20", "21", "22", "23", "24", "25", "26"]) {
      try {
        const balances = await exactGet<Array<{ Amount: number; ReportingPeriod: number }>>(
          `/financial/ReportingBalance?$select=Amount,ReportingPeriod&$filter=ReportingYear eq ${year} and GLAccountCode eq '${code}'&$orderby=ReportingPeriod desc&$top=1`
        );
        if (balances.length > 0) {
          total += balances[0].Amount || 0;
        }
      } catch {
        // Skip this account
      }
    }
    return total;
  } catch {
    // Return 0
  }

  return 0;
}

/**
 * Sync financial position from Exact Online into a snapshot.
 */
export async function syncExactOnline(): Promise<{
  bankBalance: number;
  totalAr: number;
  totalAp: number;
}> {
  const [receivables, payables, bankBalance] = await Promise.all([
    fetchReceivables(),
    fetchPayables(),
    fetchBankBalance(),
  ]);

  // Store snapshot
  await prisma.financialSnapshot.create({
    data: {
      snapshotDate: new Date(),
      bankBalance,
      totalAr: receivables.total,
      totalAp: payables.total,
      source: "exact",
    },
  });

  return {
    bankBalance,
    totalAr: receivables.total,
    totalAp: payables.total,
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
