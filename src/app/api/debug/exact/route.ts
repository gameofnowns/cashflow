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

  // 1. Find GL accounts starting with '1' (liquid assets / bank in Dutch accounting)
  results.glAccounts1xxx = await exactGet(
    "/financial/GLAccounts?$select=Code,Description&$filter=startswith(Code,'1')&$top=30",
    auth.token, auth.division!
  );

  // 2. Find GL accounts starting with '0' (in case banks are there)
  results.glAccounts0xxx = await exactGet(
    "/financial/GLAccounts?$select=Code,Description&$filter=startswith(Code,'0')&$top=20",
    auth.token, auth.division!
  );

  // 3. Try financial/BankAccounts endpoint
  results.bankAccounts = await exactGet(
    "/cashflow/Banks?$select=BankAccountName,CurrentBalance",
    auth.token, auth.division!
  );

  // 4. Get AP total from PurchaseEntries with open status (Status 20 = open)
  results.purchaseEntriesOpen = await exactGet(
    "/purchaseentry/PurchaseEntries?$select=AmountDC&$filter=Status eq 20",
    auth.token, auth.division!
  );

  // Calculate AP from purchase entries
  const peData = results.purchaseEntriesOpen as { data: Array<{ AmountDC: number }> };
  if (Array.isArray(peData.data)) {
    const totalAP = peData.data.reduce((sum: number, item: { AmountDC: number }) => sum + Math.abs(item.AmountDC || 0), 0);
    results.purchaseEntriesTotalCalculated = { count: peData.data.length, total: totalAP };
  }

  return NextResponse.json(results);
}
