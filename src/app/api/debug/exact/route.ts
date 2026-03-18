import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const EXACT_BASE = "https://start.exactonline.nl/api/v1";

async function getToken() {
  const stored = await prisma.oAuthToken.findUnique({ where: { provider: "exact" } });
  if (!stored) return null;
  return { token: stored.accessToken, division: stored.division };
}

async function exactGet(path: string, token: string, division: string) {
  const url = `${EXACT_BASE}/${division}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return { status: res.status, url, data: json.d?.results ?? json.d ?? json };
  } catch {
    return { status: res.status, url, data: text };
  }
}

export async function GET() {
  const auth = await getToken();
  if (!auth || !auth.token) {
    return NextResponse.json({ error: "Not connected" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // 1. Find ALL GL accounts with code starting with 2 (bank range)
  results.glAccountsBank = await exactGet(
    "/financial/GLAccounts?$select=Code,Description&$filter=startswith(Code,'2')&$top=20",
    auth.token, auth.division!
  );

  // 2. Try ReportingBalance for different GL code formats
  for (const code of ["20", "2000", "20000", "200000"]) {
    results[`reportingBalance_${code}`] = await exactGet(
      `/financial/ReportingBalance?$select=GLAccountCode,GLAccountDescription,Amount,ReportingYear,ReportingPeriod&$filter=GLAccountCode eq '${code}'`,
      auth.token, auth.division!
    );
  }

  // 3. Get total PayablesList count and sum
  results.payablesAll = await exactGet(
    "/read/financial/PayablesList?$select=Amount",
    auth.token, auth.division!
  );

  // Calculate total AP
  const payData = results.payablesAll as { data: Array<{ Amount: number }> };
  if (Array.isArray(payData.data)) {
    const totalAP = payData.data.reduce((sum: number, item: { Amount: number }) => sum + Math.abs(item.Amount || 0), 0);
    results.payablesTotalCalculated = { count: payData.data.length, total: totalAP };
  }

  return NextResponse.json(results);
}
