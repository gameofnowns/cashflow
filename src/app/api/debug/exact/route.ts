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
    return { status: res.status, url, data: JSON.parse(text) };
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

  // 1. Check GL accounts that are bank accounts
  results.glBankAccounts = await exactGet(
    "/financial/GLAccounts?$select=Code,Description,IsBankAccount&$filter=IsBankAccount eq true&$format=json",
    auth.token, auth.division!
  );

  // 2. Check ReportingBalance for GL code 20 (main bank)
  results.reportingBalance20 = await exactGet(
    "/financial/ReportingBalance?$select=GLAccountCode,GLAccountDescription,Amount,ReportingYear,ReportingPeriod&$filter=GLAccountCode eq '20'&$format=json",
    auth.token, auth.division!
  );

  // 3. Check PayablesList count and first few items
  results.payablesList = await exactGet(
    "/read/financial/PayablesList?$select=AccountName,Amount,InvoiceNumber&$top=5&$format=json",
    auth.token, auth.division!
  );

  // 4. Try the OutstandingInvoicesPayable endpoint
  results.outstandingPayable = await exactGet(
    "/purchaseentry/PurchaseEntries?$select=AmountDC,EntryNumber,SupplierName&$filter=Status eq 20&$top=5&$format=json",
    auth.token, auth.division!
  );

  return NextResponse.json(results);
}
