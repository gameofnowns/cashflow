import { NextResponse } from "next/server";
import {
  getToken,
  dynamicsFetch,
  decodeQuote,
  QUOTE_SELECT_FIELDS,
  PAYMENT_TERMS_MAP,
} from "@/lib/dynamics-quotes";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/debug/quote-details?jobNo=26-Z2661
 *
 * Fetches the Dynamics opportunity, all quotes (Won, Draft, Active),
 * and crucially the QUOTE LINE ITEMS (quotedetails / quote products).
 * This shows the full breakdown of what's in the quote document.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobNo = searchParams.get("jobNo");

  if (!jobNo) {
    return NextResponse.json(
      { error: "Missing required query param: jobNo" },
      { status: 400, headers: CORS }
    );
  }

  console.log(`[DEBUG] quote-details: ${jobNo}`);

  try {
    const token = await getToken();

    // 1. Find the opportunity
    const oppsResp = await dynamicsFetch(
      `/opportunities?$filter=contains(name,'${jobNo}')&$top=5&$select=opportunityid,name,estimatedvalue,closeprobability,estimatedclosedate,actualclosedate,statuscode,stepname,statecode`,
      token
    );

    const opps = oppsResp.value || [];
    if (opps.length === 0) {
      return NextResponse.json(
        { status: "NOT_FOUND", jobNo, message: "No opportunity found in Dynamics" },
        { headers: CORS }
      );
    }

    // Prefer closed-won (statecode=1), then open (statecode=0)
    const opp = opps.find((o: Record<string, unknown>) => o.statecode === 1) || opps[0];

    // 2. Fetch ALL quotes for this opportunity (won, draft, active)
    const allQuotesResp = await dynamicsFetch(
      `/quotes?$filter=_opportunityid_value eq '${opp.opportunityid}'&$orderby=createdon desc&$select=${QUOTE_SELECT_FIELDS},statecode,statuscode`,
      token
    );
    const allQuotes = allQuotesResp.value || [];

    // 3. For each quote, fetch its line items (quotedetails)
    const quotesWithDetails = [];
    for (const q of allQuotes) {
      // Fetch quote detail lines (products/line items)
      let lineItems: Record<string, unknown>[] = [];
      try {
        const detailsResp = await dynamicsFetch(
          `/quotedetails?$filter=_quoteid_value eq '${q.quoteid}'&$orderby=sequencenumber asc&$select=productdescription,quotedetailname,quantity,priceperunit,baseamount,extendedamount,manualdiscountamount,tax,sequencenumber,description,_productid_value,isproductoverridden`,
          token
        );
        lineItems = detailsResp.value || [];
      } catch (e) {
        lineItems = [{ error: e instanceof Error ? e.message : "Failed to fetch line items" }];
      }

      // Also try fetching custom fields on the quote that might hold payment terms
      const stateLabels: Record<number, string> = {
        0: "Draft",
        1: "Won/Active",
        2: "Closed",
        3: "Active",
      };

      // Decode with line items for payment terms resolution
      const decoded = decodeQuote(opp, q, Array.isArray(lineItems) ? lineItems : undefined);

      quotesWithDetails.push({
        quoteid: q.quoteid,
        name: q.name,
        quotenumber: q.quotenumber,
        createdon: q.createdon,
        statecode: q.statecode,
        stateLabel: stateLabels[q.statecode as number] || `state-${q.statecode}`,
        statuscode: q.statuscode,
        // Payment terms from header
        paymentTermsCode: q.paymenttermscode,
        paymentTermsText: q.paymenttermscode != null
          ? PAYMENT_TERMS_MAP[q.paymenttermscode as number] || `UNKNOWN (${q.paymenttermscode})`
          : null,
        manualPaymentTerms: q.nown_manualentrypaymentterms || null,
        // Payment terms resolution
        paymentTermsSource: decoded.paymentTermsSource,
        paymentTermsResolved: decoded.paymentTermsResolved,
        // Pricing from header
        totalPrice: q.nown_mon_totalprice,
        totalAmount: q.totalamount,
        subtotal: q.nown_mon_subtotal,
        // Decoded milestones (now using resolved terms)
        decodedMilestones: decoded.milestones,
        // LINE ITEMS — the key data
        lineItemCount: Array.isArray(lineItems) ? lineItems.length : 0,
        lineItems: lineItems.map((li) => ({
          sequenceNumber: li.sequencenumber,
          name: li.quotedetailname || li.productdescription,
          description: li.description,
          quantity: li.quantity,
          pricePerUnit: li.priceperunit,
          baseAmount: li.baseamount,
          extendedAmount: li.extendedamount,
          discount: li.manualdiscountamount,
          tax: li.tax,
          isWriteIn: li.isproductoverridden,
        })),
        // Sum of line items
        lineItemTotal: Array.isArray(lineItems)
          ? lineItems.reduce((s, li) => s + ((li.extendedamount as number) || (li.baseamount as number) || 0), 0)
          : 0,
      });
    }

    return NextResponse.json(
      {
        status: "OK",
        jobNo,
        opportunity: {
          id: opp.opportunityid,
          name: opp.name,
          estimatedValue: opp.estimatedvalue,
          closeDate: opp.actualclosedate || opp.estimatedclosedate,
          statecode: opp.statecode,
          statuscode: opp.statuscode,
          stepname: opp.stepname,
        },
        quotesFound: allQuotes.length,
        quotes: quotesWithDetails,
      },
      { headers: CORS }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed", status: "ERROR" },
      { status: 500, headers: CORS }
    );
  }
}
