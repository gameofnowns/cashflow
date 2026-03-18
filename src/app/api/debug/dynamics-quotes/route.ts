import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const DYNAMICS_URL = process.env.DYNAMICS_URL || "https://arktura.crm4.dynamics.com";
const TENANT_ID = process.env.DYNAMICS_TENANT_ID || "";
const CLIENT_ID = process.env.DYNAMICS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DYNAMICS_CLIENT_SECRET || "";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const API_BASE = `${DYNAMICS_URL}/api/data/v9.2`;

async function getToken(): Promise<string> {
  const stored = await prisma.oAuthToken.findUnique({ where: { provider: "dynamics" } });
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") || "schema";

  try {
    const token = await getToken();

    if (mode === "schema") {
      // Fetch ONE won quote with ALL fields to discover schema
      const quotes = await dynamicsFetch("/quotes?$filter=statecode eq 1&$top=1", token);
      const quote = quotes.value?.[0];
      if (!quote) return NextResponse.json({ error: "No won quotes found" });

      // Return all non-null fields sorted
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(quote)) {
        if (v !== null && v !== undefined && v !== "") {
          fields[k] = v;
        }
      }

      return NextResponse.json({
        _info: "All non-null fields from a won quote",
        _quoteName: quote.name,
        fields,
      });
    }

    if (mode === "all-won") {
      // Fetch all won quotes — just key fields
      const quotes = await dynamicsFetch(
        "/quotes?$filter=statecode eq 1&$orderby=totalamount desc&$top=50",
        token
      );
      return NextResponse.json({
        count: quotes.value?.length,
        quotes: quotes.value?.map((q: Record<string, unknown>) => {
          // Return all non-null fields
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(q)) {
            if (v !== null && v !== undefined && v !== "") {
              out[k] = v;
            }
          }
          return out;
        }),
      });
    }

    if (mode === "products") {
      // Fetch quote products for a specific quote
      const quoteId = searchParams.get("quoteId");
      if (!quoteId) return NextResponse.json({ error: "quoteId required" });

      const products = await dynamicsFetch(
        `/quotedetails?$filter=_quoteid_value eq '${quoteId}'`,
        token
      );
      return NextResponse.json({
        count: products.value?.length,
        products: products.value?.map((p: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p)) {
            if (v !== null && v !== undefined && v !== "") {
              out[k] = v;
            }
          }
          return out;
        }),
      });
    }

    if (mode === "opportunities") {
      // Fetch won opportunities to see which have quotes
      const opps = await dynamicsFetch(
        "/opportunities?$filter=statecode eq 1&$top=20&$orderby=estimatedvalue desc&$select=opportunityid,name,estimatedvalue,actualclosedate,statuscode",
        token
      );
      return NextResponse.json(opps);
    }

    if (mode === "option-sets") {
      // Fetch option set metadata for key fields
      const fields = ["nown_designcoordinationweeks", "nown_manufacturingtimeweeks", "paymenttermscode", "nown_os_projecttype", "nown_os_shippingtype", "nown_os_cratintype", "nown_quotevalidfor"];
      const results: Record<string, unknown> = {};

      for (const field of fields) {
        try {
          const meta = await dynamicsFetch(
            `/EntityDefinitions(LogicalName='quote')/Attributes(LogicalName='${field}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`,
            token
          );
          const options = meta.OptionSet?.Options?.map((o: { Value: number; Label: { UserLocalizedLabel: { Label: string } } }) => ({
            value: o.Value,
            label: o.Label?.UserLocalizedLabel?.Label,
          }));
          results[field] = options;
        } catch (e) {
          results[field] = { error: e instanceof Error ? e.message : "failed" };
        }
      }

      return NextResponse.json(results);
    }

    return NextResponse.json({ error: "Unknown mode. Use: schema, all-won, products, opportunities, option-sets" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
