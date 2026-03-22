import { NextResponse } from "next/server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * GET /api/debug/full-audit
 *
 * Runs ALL debug tests and returns a summary.
 * Pass ?month=YYYY-MM to specify the reconciliation month (defaults to current).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const baseUrl = new URL(request.url).origin;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month = searchParams.get("month") || currentMonth;

  console.log("[DEBUG] full-audit starting...");

  const tests: {
    name: string;
    url: string;
    status: string;
    duration: number;
    summary?: unknown;
    error?: string;
  }[] = [];

  // Define all tests to run
  const testDefs = [
    { name: "COGS Timing", url: `/api/debug/verify-cogs-timing` },
    { name: "Double-Count Detection", url: `/api/debug/detect-double-counts` },
    { name: "Overdue Analysis", url: `/api/debug/overdue-analysis` },
    { name: "AP Freshness", url: `/api/debug/ap-freshness` },
    {
      name: `Month Reconciliation (${month})`,
      url: `/api/debug/reconcile-month?month=${month}`,
    },
  ];

  // Run all tests in parallel
  const results = await Promise.allSettled(
    testDefs.map(async (test) => {
      const start = Date.now();
      try {
        const res = await fetch(`${baseUrl}${test.url}`);
        const data = await res.json();
        return {
          name: test.name,
          url: test.url,
          status: data.status || (res.ok ? "PASS" : "ERROR"),
          duration: Date.now() - start,
          summary: data.summary || null,
        };
      } catch (e) {
        return {
          name: test.name,
          url: test.url,
          status: "ERROR",
          duration: Date.now() - start,
          error: e instanceof Error ? e.message : "Unknown error",
        };
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      tests.push(result.value);
    } else {
      tests.push({
        name: "Unknown",
        url: "",
        status: "ERROR",
        duration: 0,
        error: result.reason?.message || "Promise rejected",
      });
    }
  }

  const passed = tests.filter(
    (t) => t.status === "PASS" || t.status === "INFO"
  ).length;
  const failed = tests.filter((t) => t.status === "FAIL").length;
  const warnings = tests.filter((t) => t.status === "WARN").length;
  const errors = tests.filter((t) => t.status === "ERROR").length;
  const totalDuration = tests.reduce((s, t) => s + t.duration, 0);

  console.log(
    `[DEBUG] full-audit complete: ${passed} passed, ${failed} failed, ${warnings} warnings, ${errors} errors (${totalDuration}ms)`
  );

  return NextResponse.json(
    {
      status:
        failed > 0 || errors > 0
          ? "FAIL"
          : warnings > 0
            ? "WARN"
            : "PASS",
      runAt: new Date().toISOString(),
      month,
      summary: { passed, failed, warnings, errors, total: tests.length },
      totalDurationMs: totalDuration,
      tests,
      availableTests: {
        "trace-project":
          "/api/debug/trace-project?jobNo=26-Z2661 — Trace one project across all systems",
        "trace-invoice":
          "/api/debug/trace-invoice?invoiceNumber=26010030 — Trace one invoice through matching",
        "reconcile-month":
          "/api/debug/reconcile-month?month=2026-03 — Reconcile all lines for a month",
        "verify-cogs-timing":
          "/api/debug/verify-cogs-timing — Check COGS lands in M+1",
        "detect-double-counts":
          "/api/debug/detect-double-counts — Find items in multiple layers",
        "verify-payment-terms":
          "/api/debug/verify-payment-terms?jobNo=26-Z2661 — Check payment terms decoding",
        "overdue-analysis":
          "/api/debug/overdue-analysis — Overdue items inflating current month",
        "ap-freshness":
          "/api/debug/ap-freshness — Compare dashboard AP to live Exact data",
        "full-audit":
          "/api/debug/full-audit — Run all tests (this endpoint)",
      },
    },
    { headers: CORS }
  );
}
