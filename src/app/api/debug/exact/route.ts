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

  // 1. cashflow/Banks — get ALL properties to find the balance field
  results.banksAllProps = await exactGet(
    "/cashflow/Banks?$top=5",
    auth.token, auth.division!
  );

  // 2. Try financial/OutstandingInvoicesPayable for AP
  results.outstandingPayable = await exactGet(
    "/financial/AgingPayablesList?$select=AgeGroup,Amount&$top=10",
    auth.token, auth.division!
  );

  // 3. ReportingBalance for just GL 1100 (likely main bank)
  results.rb1100 = await exactGet(
    "/financial/ReportingBalance?$select=GLAccountCode,GLAccountDescription,Amount,ReportingYear,ReportingPeriod&$filter=GLAccountCode eq '1100'&$top=10",
    auth.token, auth.division!
  );

  // 4. Try financial/FinancialPeriods to see current period
  results.currentPeriod = await exactGet(
    "/financial/FinancialPeriods?$select=FinYear,FinPeriod&$filter=Current eq true",
    auth.token, auth.division!
  );

  // 5. Get AgingReceivablesList for comparison
  results.agingReceivables = await exactGet(
    "/financial/AgingReceivablesList?$select=AgeGroup,Amount&$top=10",
    auth.token, auth.division!
  );

  return NextResponse.json(results);
}
