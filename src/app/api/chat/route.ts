import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { fetchPayables, parseExactDate } from "@/lib/exact";
import {
  getToken,
  dynamicsFetch,
  QUOTE_SELECT_FIELDS,
} from "@/lib/dynamics-quotes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── System Prompt ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are NOWN's financial assistant embedded in the cashflow dashboard. You have access to live API connections:

1. EXACT ONLINE — accounting (AR, AP, invoices, bank balance)
2. CLICKUP — project management (project status, timelines, milestones)
3. DYNAMICS 365 — CRM (opportunities, quotes, payment terms, pipeline)

Rules:
- Always show your sources. Tag data points with [EXACT], [CLICKUP], or [DYNAMICS].
- When showing financial data, use the dataCard format: include a JSON block like {"dataCard":{"rows":[{"label":"...","value":"EUR X","color":"default"}]}}
- Currency is EUR throughout. Format: EUR 1.234 for thousands (European convention).
- Be concise. This is a terminal-style interface.
- When answering about cash position, reference the current dashboard state provided in context.
- NEVER say "Arktura" — the company is always "NOWN".
- For payment actions, always require explicit user confirmation.
- If you don't have enough data to answer, say so and suggest what sync or query might help.`;

// ─── Tool Definitions ───────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "query_receivables",
    description:
      "Query outstanding receivables (AR) from Exact Online. Returns invoices with customer, amount, due date, job number.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["overdue", "current", "all"],
          description: "Filter by status. 'overdue' = past due date, 'current' = not yet due, 'all' = everything",
        },
      },
      required: [],
    },
  },
  {
    name: "query_payables",
    description:
      "Query outstanding payables (AP) from Exact Online. Returns vendor invoices with amount and due date.",
    input_schema: {
      type: "object" as const,
      properties: {
        sortBy: {
          type: "string",
          enum: ["dueDate", "amount", "vendor"],
          description: "How to sort the results",
        },
      },
      required: [],
    },
  },
  {
    name: "query_projects",
    description:
      "Query projects from the database (sourced from ClickUp). Returns project name, type, value, status, milestones.",
    input_schema: {
      type: "object" as const,
      properties: {
        source: {
          type: "string",
          enum: ["clickup", "dynamics", "all"],
          description: "Filter by data source",
        },
        status: {
          type: "string",
          description: "Filter by project status (e.g., 'won', 'active', 'pipeline')",
        },
        jobNumber: {
          type: "string",
          description: "Look up a specific project by job number (e.g., '26-Y2651')",
        },
      },
      required: [],
    },
  },
  {
    name: "query_pipeline",
    description:
      "Query pipeline opportunities from Dynamics 365. Returns opportunity name, value, stage, close date, and quote details.",
    input_schema: {
      type: "object" as const,
      properties: {
        stage: {
          type: "string",
          enum: ["1-Qualify", "2-Develop", "3-Propose", "all"],
          description: "Filter by pipeline stage",
        },
      },
      required: [],
    },
  },
  {
    name: "get_bank_balance",
    description:
      "Get the current bank balance from the latest Exact Online snapshot or manual override.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_ap_aging",
    description:
      "Get AP aging report — payables grouped by overdue, due this week, due this month, and future.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ─── Tool Execution ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "query_receivables": {
        const items = await prisma.arLineItem.findMany({
          orderBy: { dueDate: "asc" },
          take: 50,
        });
        const now = new Date();
        const filtered =
          input.status === "overdue"
            ? items.filter((i) => i.dueDate < now)
            : input.status === "current"
              ? items.filter((i) => i.dueDate >= now)
              : items;
        const total = filtered.reduce((s, i) => s + i.amount, 0);
        return JSON.stringify({
          source: "EXACT",
          totalItems: filtered.length,
          totalAmount: Math.round(total * 100) / 100,
          items: filtered.slice(0, 20).map((i) => ({
            customer: i.accountName,
            invoice: i.invoiceNumber,
            jobNo: i.jobNo,
            amount: Math.round(i.amount * 100) / 100,
            dueDate: i.dueDate.toISOString().split("T")[0],
            status: i.matchStatus,
            overdue: i.dueDate < now,
          })),
          note: filtered.length > 20 ? `Showing 20 of ${filtered.length} items` : undefined,
        });
      }

      case "query_payables": {
        const payables = await fetchPayables();
        const sorted = [...payables.items].sort((a, b) => {
          if (input.sortBy === "amount") return Math.abs(b.Amount) - Math.abs(a.Amount);
          if (input.sortBy === "vendor") return (a.AccountName || "").localeCompare(b.AccountName || "");
          return new Date(a.DueDate).getTime() - new Date(b.DueDate).getTime();
        });
        return JSON.stringify({
          source: "EXACT",
          totalItems: sorted.length,
          totalAmount: Math.round(payables.total * 100) / 100,
          items: sorted.slice(0, 20).map((i) => ({
            vendor: i.AccountName,
            invoice: String(i.InvoiceNumber),
            amount: Math.round(Math.abs(i.Amount) * 100) / 100,
            dueDate: parseExactDate(i.DueDate).toISOString().split("T")[0],
          })),
          note: sorted.length > 20 ? `Showing 20 of ${sorted.length} items` : undefined,
        });
      }

      case "query_projects": {
        const where: Record<string, unknown> = {};
        if (input.source && input.source !== "all") where.source = input.source;
        if (input.status) where.confidenceTier = input.status;
        if (input.jobNumber) where.externalId = input.jobNumber;
        const projects = await prisma.project.findMany({
          where,
          include: { milestones: true },
          take: 20,
          orderBy: { totalValue: "desc" },
        });
        return JSON.stringify({
          source: "CLICKUP",
          totalProjects: projects.length,
          projects: projects.map((p) => ({
            name: p.name,
            jobNo: p.externalId,
            type: p.projectType,
            value: p.totalValue,
            status: p.status,
            tier: p.confidenceTier,
            source: p.source,
            milestones: p.milestones.map((m) => ({
              label: m.label,
              amount: m.amount,
              date: m.expectedDate.toISOString().split("T")[0],
              status: m.status,
            })),
          })),
        });
      }

      case "query_pipeline": {
        try {
          const token = await getToken();
          let filter = "statecode eq 0";
          if (input.stage && input.stage !== "all") {
            filter += ` and contains(stepname,'${input.stage.split("-")[0]}')`;
          }
          const resp = await dynamicsFetch(
            `/opportunities?$filter=${filter}&$orderby=estimatedvalue desc&$top=20&$select=opportunityid,name,estimatedvalue,estimatedclosedate,stepname`,
            token
          );
          const opps = resp.value || [];
          return JSON.stringify({
            source: "DYNAMICS",
            totalOpportunities: opps.length,
            opportunities: opps.map(
              (o: { name: string; estimatedvalue: number; estimatedclosedate: string; stepname: string }) => ({
                name: o.name,
                value: o.estimatedvalue,
                closeDate: o.estimatedclosedate,
                stage: o.stepname,
              })
            ),
          });
        } catch {
          return JSON.stringify({ source: "DYNAMICS", error: "Dynamics not connected" });
        }
      }

      case "get_bank_balance": {
        const snapshot = await prisma.financialSnapshot.findFirst({
          orderBy: { snapshotDate: "desc" },
        });
        return JSON.stringify({
          source: "EXACT",
          bankBalance: snapshot?.bankBalance || 0,
          totalAr: snapshot?.totalAr || 0,
          totalAp: snapshot?.totalAp || 0,
          snapshotDate: snapshot?.snapshotDate?.toISOString().split("T")[0] || "unknown",
        });
      }

      case "get_ap_aging": {
        const payables = await fetchPayables();
        const now = new Date();
        const thisWeekEnd = new Date(now);
        thisWeekEnd.setDate(thisWeekEnd.getDate() + (7 - thisWeekEnd.getDay()));
        const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const overdue: typeof payables.items = [];
        const thisWeek: typeof payables.items = [];
        const thisMonth: typeof payables.items = [];
        const future: typeof payables.items = [];

        for (const item of payables.items) {
          const due = parseExactDate(item.DueDate);
          if (due < now) overdue.push(item);
          else if (due <= thisWeekEnd) thisWeek.push(item);
          else if (due <= thisMonthEnd) thisMonth.push(item);
          else future.push(item);
        }

        const sum = (arr: typeof payables.items) =>
          Math.round(arr.reduce((s, i) => s + Math.abs(i.Amount), 0) * 100) / 100;

        return JSON.stringify({
          source: "EXACT",
          overdue: { count: overdue.length, total: sum(overdue) },
          dueThisWeek: { count: thisWeek.length, total: sum(thisWeek) },
          dueThisMonth: { count: thisMonth.length, total: sum(thisMonth) },
          future: { count: future.length, total: sum(future) },
          grandTotal: Math.round(payables.total * 100) / 100,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : "Tool execution failed" });
  }
}

// ─── Main Handler ───────────────────────────────────────────

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured. Add it to your environment variables." },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  try {
    const body = await request.json();
    const { messages, context } = body as {
      messages: { role: "user" | "assistant"; content: string }[];
      context?: Record<string, unknown>;
    };

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400, headers: CORS_HEADERS });
    }

    const client = new Anthropic({ apiKey });

    // Build context string from dashboard state
    let contextStr = "";
    if (context) {
      contextStr = `\n\nCurrent dashboard state:\n${JSON.stringify(context, null, 2)}`;
    }

    // Initial Claude call with tools
    let response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT + contextStr,
      tools: TOOLS,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    // Handle tool use loop (max 5 iterations)
    let iterations = 0;
    const toolResults: { name: string; result: string; source: string }[] = [];

    while (response.stop_reason === "tool_use" && iterations < 5) {
      iterations++;
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResultMessages: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of toolBlocks) {
        const result = await executeTool(tool.name, tool.input as Record<string, unknown>);
        toolResults.push({
          name: tool.name,
          result,
          source: JSON.parse(result).source || "unknown",
        });
        toolResultMessages.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: result,
        });
      }

      // Continue conversation with tool results
      response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: SYSTEM_PROMPT + contextStr,
        tools: TOOLS,
        messages: [
          ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
          { role: "assistant" as const, content: response.content },
          { role: "user" as const, content: toolResultMessages },
        ],
      });
    }

    // Extract final text response
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const responseText = textBlocks.map((b) => b.text).join("\n");

    // Extract source tags from tool results
    const sources = [...new Set(toolResults.map((t) => t.source.toLowerCase()))];

    return NextResponse.json(
      {
        message: responseText,
        sources,
        toolsUsed: toolResults.map((t) => t.name),
      },
      { headers: CORS_HEADERS }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500, headers: CORS_HEADERS });
  }
}
