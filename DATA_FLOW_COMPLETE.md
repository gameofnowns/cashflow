# NOWN Cashflow Dashboard — Complete Data Flow & Mapping Logic

> Generated 20 March 2026 — for visualization and audit purposes

---

## 1. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        BROWSER (HTML Dashboard)                       │
│                                                                       │
│   cash-position-v5-stream.html                                       │
│   ├── Calls /api/dashboard/cash-position on load                     │
│   ├── Calls /api/dashboard/status for connection health              │
│   ├── Can trigger /api/sync/{exact|clickup|dynamics}                 │
│   ├── Can query /api/chat (Claude AI with live data tools)           │
│   └── Renders: stream chart + bar chart + P&L table + drill-down    │
│                                                                       │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ HTTPS
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     VERCEL (Next.js Backend)                          │
│                                                                       │
│   API Routes:                                                        │
│   ├── /api/dashboard/cash-position  ← MAIN DATA ENDPOINT            │
│   ├── /api/dashboard/status         ← connection health              │
│   ├── /api/sync/exact               ← triggers Exact sync           │
│   ├── /api/sync/clickup             ← triggers ClickUp sync         │
│   ├── /api/sync/dynamics            ← triggers Dynamics sync        │
│   ├── /api/chat                     ← Claude AI assistant           │
│   ├── /api/auth/exact/callback      ← OAuth callback                │
│   └── /api/auth/dynamics/callback   ← OAuth callback                │
│                                                                       │
│   Libraries:                                                         │
│   ├── src/lib/exact.ts              ← Exact Online API client        │
│   ├── src/lib/clickup.ts            ← ClickUp API client            │
│   ├── src/lib/dynamics.ts           ← Dynamics 365 API client        │
│   ├── src/lib/dynamics-quotes.ts    ← Quote decoding + payment terms │
│   ├── src/lib/cashflow.ts           ← Forecast calculation          │
│   └── src/lib/sync.ts              ← ClickUp sync orchestration     │
│                                                                       │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   NEON POSTGRES DATABASE                              │
│                                                                       │
│   Tables:                                                            │
│   ├── projects           (won + pipeline projects)                   │
│   ├── payment_milestones (expected payments per project)             │
│   ├── ar_line_items      (Exact invoices, matched/unmatched)         │
│   ├── financial_snapshots (bank balance, AR/AP totals per sync)      │
│   ├── overhead_budget    (monthly fixed costs, manually entered)     │
│   └── oauth_tokens       (Exact + Dynamics OAuth credentials)        │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ EXACT ONLINE │ │   CLICKUP    │ │ DYNAMICS 365 │
│              │ │              │ │              │
│ Accounting   │ │ Project Mgmt │ │ CRM / Sales  │
│ system       │ │ system       │ │ system       │
└──────────────┘ └──────────────┘ └──────────────┘
```

---

## 2. The Three External Systems

### 2A. Exact Online (Accounting — Source of Truth for Money)

**What it provides:**
- Outstanding receivables (AR) — real invoices waiting for payment
- Outstanding payables (AP) — real vendor bills to pay
- Bank balance — current cash in accounts

**API endpoints used:**
```
GET /read/financial/ReceivablesList
    → AccountName, Amount, InvoiceNumber, InvoiceDate, DueDate, CurrencyCode, Description

GET /read/financial/PayablesList
    → AccountName, Amount, InvoiceNumber, InvoiceDate, DueDate, CurrencyCode

GET /financial/ReportingBalance (GL accounts 1000-1199)
    → Bank/cash/liquid asset balances
```

**OAuth:** User-impersonation flow. Token stored in `oauth_tokens` table. Auto-refreshes on expiry.

**Sync trigger:** `POST /api/sync/exact`

**What happens on sync:**
1. Fetch all receivables → store as `ar_line_items`
2. Extract job number from invoice description (pattern: `\d{2}-[XYZ]\d{3,4}`)
3. Match to projects by job number → set `matchStatus` = "matched" or "unmatched"
4. For matched items: update the project's payment milestone to "invoiced" with real DueDate
5. Fetch all payables → store total in `financial_snapshots`
6. Fetch bank balance from GL accounts → store in `financial_snapshots`

### 2B. ClickUp (Project Management — Source of Truth for Project Status)

**What it provides:**
- Active projects with real production status
- Timing fields (where each project is in its lifecycle)
- Payment status (received/pending/not required)
- Project value and payment terms (fallback — Dynamics is primary)

**API endpoint:** `GET /api/v2/list/84391559/task` (ACTIVE PROJECTS list)

**Custom fields extracted per task:**
```
Job No.                  → project identity (e.g., "26-Y2651")
Project Type             → dropdown → X, Y, or Z
Project Value            → text field (European number format)
Signed Quotation         → PDF attachment (OCR'd for value if text field empty)
Payment Terms            → text field (fallback if Dynamics unavailable)
1st Payment Status       → Received / Pending / Not Required
1st Payment Received Date
Final Payment Status     → Received / Pending / Not Required
Final Payment Received Date
Leadtime (week)          → total weeks from quote to delivery
Prod. ETA                → projected production deadline
Prod. Finished Date      → actual production complete
Due Date Shops           → when drawings due to client (Y/Z projects)
Shops Status             → "Approved" = production can start
Approved Shops           → date client approved drawings
Record Set Status        → drawing progress
Actual Dispatch          → shipped date
Contract Deadline
Due Date
```

**Sync trigger:** `POST /api/sync/clickup`

**What happens on sync:**
1. Fetch all tasks from ACTIVE PROJECTS list
2. Filter out: shipped, cancelled, complete, template, not started, hold
3. For each task: extract Job No., Project Type, timing fields
4. Upsert into `projects` table (source='clickup', confidenceTier='won')
5. Create payment milestones based on payment terms split
6. Preserve "invoiced" milestones from prior Exact AR matching
7. Estimate milestone dates from timing fields (see Section 4)

### 2C. Dynamics 365 (CRM — Source of Truth for Quotes & Pipeline)

**What it provides:**
- Closed Won opportunities with linked Won quotes (enriches ClickUp projects)
- Open pipeline opportunities with open quotes (forecasted AR)
- Payment terms (26 structured variants — primary source)
- Design weeks, manufacturing weeks, lead times
- Project type, crating, shipping

**API base:** `https://arktura.crm4.dynamics.com/api/data/v9.2`

**Entities queried:**
```
opportunities
    → opportunityid, name, estimatedvalue, estimatedclosedate,
      actualclosedate, statecode, statuscode, stepname, closeprobability

quotes (linked to opportunities via _opportunityid_value)
    → quoteid, name, quotenumber, statecode,
      nown_os_projecttype, nown_designcoordinationweeks,
      nown_manufacturingtimeweeks, paymenttermscode,
      nown_manualentrypaymentterms, nown_mon_totalprice,
      nown_mon_subtotal, nown_os_cratintype, nown_os_shippingtype
```

**Option set decoders (26 payment term variants):**
```
211680000 → "100% start"
211680001 → "50% start, 50% mid-manufacture"
211680002 → "50% start, 50% pre-ship"
211680003 → "100% pre-ship"
211680004 → "100% DUE"
211680005 → "100% NET 30"
211680006 → "100% NET 60"
211680007 → "50% start, 50% NET 30"
211680008 → "50% start, 50% NET 60"
211680009 → "30% start, 40% mid-manufacture, 30% pre-ship"
211680010 → "30% start, 30% mid-manufacture, 40% pre-ship"
211680011 → "30% start, 40% pre-ship, 30% NET 30"
211680012 → "30% start, 30% pre-ship, 40% NET 30"
211680013 → "40% start, 30% pre-ship, 30% NET 30"
211680014 → "50% Shops, 50% pre-ship"
211680015 → "30% Shops, 30% approval, 40% pre-ship"
211680016 → "30% Shops, 40% approval, 30% pre-ship"
211680017 → "50% approval, 50% pre-ship"
211680018 → "30% approval, 40% pre-ship, 30% NET 30"
211680019 → "40% approval, 30% pre-ship, 30% NET 30"
211680020 → "50% manufacture, 50% NET 30"
211680021 → "50% manufacture, 50% pre-ship"
211680022 → "30% Deposit, 40% pre-ship, 30% NET 30 days"
211680023 → "40% Deposit, 30% pre-ship, 30% NET 30 days"
211680024 → "30% Deposit, 50% pre-ship, 20% NET 30 days"
211680025 → "Manual Entry" (uses nown_manualentrypaymentterms field)
```

**Pipeline phase mapping:**
```
stepname "1-Qualify"  → Phase 1 (10% likelihood)
stepname "2-Develop"  → Phase 2 (30% likelihood)
stepname "3-Propose"  → Phase 3 (90% likelihood — effectively committed)
```

**Sync trigger:** `POST /api/sync/dynamics`

**What happens on sync:**
1. Fetch open opportunities with closeprobability >= 90%
2. Upsert into `projects` table (source='dynamics', confidenceTier='pipeline')
3. Create payment milestones with 50/50 split and type-aware timing

---

## 3. The Main Data Endpoint: /api/dashboard/cash-position

This is the single endpoint that powers the entire dashboard. It assembles data from the database and live API calls into a 12-month rolling forecast.

**Called by:** The HTML dashboard on every load and refresh

**Query param:** `?bankBalance=129521` (optional manual override)

### What it returns:

```typescript
{
  bankBalance: number,           // Opening cash position
  bankBalanceSource: "manual" | "exact",
  months: [                      // 12 months rolling from current month
    {
      month: "2026-03",

      // LAYER 1: Current AR (Exact unmatched invoices)
      currentAr: 1246893.89,
      currentArItems: [
        { projectName, jobNo, amount, expectedDate, status }
      ],

      // LAYER 2: Billable AR (ClickUp won projects)
      billableAr: 675735.71,
      billableArItems: [
        { projectName, jobNo, projectType, label, amount, expectedDate, status }
      ],

      // LAYER 3: Pipeline AR by phase (Dynamics opportunities)
      pipelinePhase1: 0,          // 1-Qualify (10%)
      pipelinePhase1Items: [],
      pipelinePhase2: 0,          // 2-Develop (30%)
      pipelinePhase2Items: [],
      pipelinePhase3: 270690,     // 3-Propose (90%)
      pipelinePhase3Items: [
        { projectName, jobNo, projectType, label, amount, trigger, status }
      ],

      // OUTFLOWS
      ap: 946698,                 // Exact payables
      apItems: [...],
      cogsWon: 342058,            // COGS on won AR (lands 1 month after AR)
      cogsPhase1: 0,
      cogsPhase2: 0,
      cogsPhase3: 0,
      vatReturn: 0,               // Quarterly VAT refund
      overhead: 310000,           // Manual monthly fixed cost
    },
    // ... 11 more months
  ],
  totals: { ... },               // 12-month aggregates
  pipeline: { totalOpportunities, withQuotes, byPhase }
}
```

---

## 4. Data Assembly Logic (inside /api/dashboard/cash-position)

### Step 1: Build 12-month window
```
Current month → 11 months forward
e.g., Mar 2026 → Feb 2027
```

### Step 2: LAYER 1 — Current AR (from database)
```
Source: ar_line_items table (populated by Exact sync)
Filter: matchStatus = "unmatched" (not linked to any project)
Bucketing: by DueDate month
Rule: if DueDate < current month → floor into current month (overdue)
```

These are real invoices from Exact that don't match to any ClickUp project by job number. They represent standalone receivables.

### Step 3: LAYER 2 — Billable AR (from database)
```
Source: projects table WHERE confidenceTier IN ('won', 'committed')
        + their payment_milestones
Filter: milestone status ≠ 'received'
Bucketing: by milestone expectedDate month
Rule: if expectedDate < current month → floor into current month (overdue)
```

COGS for won projects: calculated at milestone level, **lands 1 month AFTER the AR milestone**.
```
COGS = milestone_amount × COGS_RATE[projectType] × 1.21 (Dutch VAT buffer)

COGS rates:
  Type X = 30% → effective 36.3%
  Type Y = 40% → effective 48.4%
  Type Z = 50% → effective 60.5%

If AR milestone is in month M, COGS lands in month M+1
```

### Step 4: AP — Accounts Payable (LIVE from Exact API)
```
Source: Exact Online PayablesList (fetched LIVE, not from database)
Timeout: 10 seconds (skips silently if Exact is slow)
Date parsing: Exact uses /Date(ms)/ format → parseExactDate()
Bucketing: by DueDate month (overdue → current month)
Note: Amount can be negative (credit notes) — stored as-is
```

### Step 5: LAYER 3 — Pipeline AR (LIVE from Dynamics API)
```
Source: Dynamics 365 opportunities (fetched LIVE)
Filter: statecode = 0 (open) AND estimatedclosedate within next 12 months
For each opportunity:
  1. Fetch most recent open quote (statecode=0 draft, or statecode=3 active)
  2. Decode payment terms from quote option set (26 variants)
  3. Compute milestones from payment terms + design weeks + manufacturing weeks
  4. Bucket into pipeline phase by stepname:
     "1-Qualify" → pipelinePhase1
     "2-Develop" → pipelinePhase2
     "3-Propose" → pipelinePhase3

Milestone timing from estimated close date:
  "start" / "deposit"    → close date + 1 week
  "shops"                → close date + design weeks
  "approval"             → close date + design weeks + 2 weeks
  "mid-manufacture"      → close date + design weeks + (mfg weeks / 2)
  "pre-ship"             → close date + design weeks + mfg weeks
  "NET 30"               → close date + total lead time + 4 weeks
  "NET 60"               → close date + total lead time + 9 weeks

If no quote exists: defaults to 50/50 split, 8 weeks mfg, 0 design weeks

COGS for pipeline: same rates, also lands 1 month after AR milestone
```

### Step 6: Overhead (from database)
```
Source: overhead_budget table
Manually entered per month on the settings page
Typical range: EUR 310K-425K/month
```

### Step 7: VAT Returns (calculated)
```
Quarterly COGS → VAT return lands 1-2 months after quarter end

Schedule:
  Q1 (Jan-Mar) COGS → VAT return lands in May
  Q2 (Apr-Jun) COGS → VAT return lands in August
  Q3 (Jul-Sep) COGS → VAT return lands in November
  Q4 (Oct-Dec) COGS → VAT return lands in February (next year)

VAT return rate = 0.21 / 1.21 ≈ 17.36% of total COGS
(because COGS already includes 1.21 VAT buffer, the return is the VAT component)
```

### Step 8: Bank Balance
```
Priority:
  1. Manual entry via ?bankBalance= query param
  2. Latest financial_snapshots.bankBalance from Exact sync
  3. Default: 0
```

---

## 5. Dashboard Calculation (in the browser)

The HTML dashboard receives the raw monthly data and computes the display values based on active toggles.

### Toggle State
```
currentAr:    ON/OFF  — include Exact unmatched invoices
billableAr:   ON/OFF  — include won project milestones
phase3:       ON/OFF  — include committed pipeline (Phase 3)
ap:           ON/OFF  — include Exact payables as outflow
cogsWon:      ON/OFF  — include COGS on won projects
cogsPipeline: ON/OFF  — include COGS on pipeline projects
vat:          ON/OFF  — include quarterly VAT returns
overhead:     ON/OFF  — include monthly fixed costs
weighted:     ON/OFF  — multiply pipeline by likelihood (90% for Phase 3)
```

### Monthly Calculation
```
For each month:
  inflow  = currentAr + billableAr + committed + vat
  outflow = ap + cogsWon + cogsPipeline + overhead
  net     = inflow - outflow

Cash Position = bankBalance + cumulative sum of net for all months
```

### Presets
```
Conservative = all ON except phase3 + cogsPipeline (no pipeline)
Likely       = everything ON
Full         = everything ON
Weighted     = everything ON + pipeline × 90%
```

---

## 6. AR Matching — How Exact Invoices Connect to ClickUp Projects

This is the critical integration that prevents double-counting.

```
EXACT INVOICE                          CLICKUP PROJECT
┌─────────────────────┐               ┌─────────────────────┐
│ Description:        │               │ Job No.: 26-Y2651   │
│ "26-Y2651 - GENK"  │──── match ───→│ Name: GENK | BE...  │
│ Amount: EUR 11,611  │               │ Milestone: pending   │
│ DueDate: 15 Apr 26  │               │ Amount: EUR 11,611  │
└─────────────────────┘               └─────────────────────┘

When matched:
1. ar_line_item.matchStatus = "matched"
2. ar_line_item.projectId = project.id
3. payment_milestone.status = "invoiced"
4. payment_milestone.expectedDate = Exact DueDate (real date replaces estimate)
5. payment_milestone.invoiceId = Exact InvoiceNumber

Result:
- The invoice is REMOVED from Layer 1 (Current AR)
- It now lives in Layer 2 (Billable AR) via the project milestone
- No double-counting
```

**Matching logic:**
```
1. Extract job number from Exact invoice description: regex /\d{2}-[XYZ]\d{3,4}/
2. Look up project by externalId (job number) in projects table
3. If found: match. Update milestone closest to invoice amount (10% tolerance)
4. If not found: stays as unmatched → Layer 1 Current AR
```

---

## 7. Milestone Date Estimation (for Billable AR)

When ClickUp projects don't have real invoice dates yet, the system estimates when payments will land:

### For 1st Payment:
```
Priority:
1. ClickUp says "Received" with a date         → use that date
2. Exact AR matched → real invoice DueDate      → use Exact date
3. Dynamics actualclosedate exists              → actualclosedate + 1 week
4. ClickUp quoteDate exists                     → quoteDate + 1 week
5. Nothing available                            → 15th of next month
```

### For Final / Later Payments:
```
Priority:
1. productionEta exists (ClickUp)              → productionEta + 1 week
2. Y/Z project, shops approved                 → approvedShopsDate + (leadtime × 0.6) + 1 week
3. Y/Z project, shops not approved             → dueDateShops + 2 weeks + (leadtime × 0.6) + 1 week
4. Has quoteDate + leadtimeWeeks               → quoteDate + leadtimeWeeks + 1 week
5. Nothing available                           → 2-3 months from today
```

---

## 8. Stream Chart — How the Visualization Works

The stream chart renders the same data as the bar chart but as smooth flowing curves.

### Bell Curve Generation
```
Each payment generates a Gaussian bell curve:
  center = month position on timeline (0.0 to 1.0)
  peak   = EUR amount
  width  = uncertainty of timing:
    - AR invoice (specific date):    0.020 (narrow, sharp)
    - Billable milestone (invoiced): 0.025
    - Billable milestone (pending):  0.030
    - Committed pipeline:            0.040 (wider, less certain)
    - Overhead (recurring):          0.035
    - AP vendor payment:             0.020 (sharp)

formula: value = peak × exp(-((t - center) / width)² × 2.5)
```

### Stacking Order
```
ABOVE ZERO (inflows, bottom to top):
  1. Current AR      (green #82D780)
  2. Billable AR     (blue #0086D5)
  3. Committed       (blue-grey #D8E1EB)
  4. VAT Returns     (sage #8F9A8F)

BELOW ZERO (outflows, top to bottom):
  1. Overhead        (blush #F7E5DF)
  2. COGS Won        (bronze #887550)
  3. COGS Pipeline   (terracotta #BD6A55)
  4. AP              (red #C0392B)
```

### Cash Position Line
```
- Black line (#1A1814), 3.5px stroke
- Hollow circle dots (cream fill, black stroke, 5px radius)
- Running cumulative: bankBalance + sum of (inflow - outflow) for each month
- Extends into FY Total zone as orange bar at closing position
```

---

## 9. Chat System (NOWN > command line)

### How it works:
```
User types question → POST /api/chat
  → Claude Sonnet receives:
    - System prompt (NOWN financial assistant role)
    - Dashboard context (current toggles, monthly data, cash position)
    - 6 tools for live data queries:
      1. query_receivables  → reads ar_line_items from database
      2. query_payables     → calls Exact API live
      3. query_projects     → reads projects + milestones from database
      4. query_pipeline     → calls Dynamics API live
      5. get_bank_balance   → reads latest financial_snapshot
      6. get_ap_aging       → calls Exact API, groups by overdue/due/future

Claude can call multiple tools, then synthesizes an answer with source tags.
```

---

## 10. Database Schema

```sql
projects
  id             UUID PRIMARY KEY
  external_id    TEXT           -- Job number (ClickUp) or Opportunity ID (Dynamics)
  source         TEXT           -- 'clickup' | 'dynamics' | 'manual'
  name           TEXT
  project_type   TEXT           -- 'X' | 'Y' | 'Z'
  confidence_tier TEXT          -- 'won' | 'committed' | 'pipeline'
  total_value    FLOAT
  status         TEXT
  quote_date     TIMESTAMP     -- Signed quote date (anchor for timing)
  leadtime_weeks FLOAT         -- Total lead time
  production_eta TIMESTAMP     -- Projected production deadline
  prod_finished  TIMESTAMP     -- Actual production complete
  due_date_shops TIMESTAMP     -- When drawings due to client
  shops_status   TEXT           -- "Approved" = production can start
  approved_shops TIMESTAMP     -- Date client approved drawings
  payment_terms  TEXT           -- Per-project payment terms
  UNIQUE(external_id, source)

payment_milestones
  id             UUID PRIMARY KEY
  project_id     UUID → projects.id (CASCADE DELETE)
  label          TEXT           -- '1st Payment' | 'Final Payment' | etc.
  amount         FLOAT
  expected_date  TIMESTAMP
  status         TEXT DEFAULT 'pending'  -- 'pending' | 'invoiced' | 'received'
  invoice_id     TEXT           -- Exact invoice number when matched

ar_line_items
  id             UUID PRIMARY KEY
  invoice_number TEXT
  account_name   TEXT
  description    TEXT
  amount         FLOAT
  invoice_date   TIMESTAMP
  due_date       TIMESTAMP
  currency_code  TEXT
  job_no         TEXT           -- Extracted from description
  project_id     UUID → projects.id (SET NULL)
  match_status   TEXT DEFAULT 'unmatched'  -- 'matched' | 'unmatched'
  snapshot_date  TIMESTAMP
  UNIQUE(invoice_number, snapshot_date)

financial_snapshots
  id             UUID PRIMARY KEY
  snapshot_date  TIMESTAMP
  bank_balance   FLOAT
  total_ar       FLOAT
  total_ap       FLOAT
  source         TEXT DEFAULT 'exact'

overhead_budget
  id             UUID PRIMARY KEY
  month          TIMESTAMP UNIQUE
  amount         FLOAT
  notes          TEXT

oauth_tokens
  id             UUID PRIMARY KEY
  provider       TEXT UNIQUE    -- 'exact' | 'dynamics'
  access_token   TEXT
  refresh_token  TEXT
  expires_at     TIMESTAMP
  division       TEXT           -- Exact Online division code
```

---

## 11. Sync Data Flow Diagrams

### Exact Online Sync
```
POST /api/sync/exact
  │
  ├─→ fetchReceivables()
  │     GET /read/financial/ReceivablesList (paginated, 60/page)
  │     → Array of { AccountName, Amount, InvoiceNumber, DueDate, Description }
  │
  ├─→ fetchPayables()
  │     GET /read/financial/PayablesList (paginated)
  │     → Array of { AccountName, Amount, InvoiceNumber, DueDate }
  │
  ├─→ fetchBankBalance()
  │     GET /financial/ReportingBalance (GL 1000-1199)
  │     → Sum of all bank/cash accounts
  │
  ├─→ Store financial_snapshot { bankBalance, totalAr, totalAp }
  │
  └─→ matchAndStoreArItems(receivables)
        For each invoice:
          1. Extract job number from description
          2. Match to project by externalId
          3. Store as ar_line_item (matched or unmatched)
          4. If matched: update milestone status → "invoiced"
             Replace estimated date with real Exact DueDate
```

### ClickUp Sync
```
POST /api/sync/clickup
  │
  ├─→ Fetch tasks from ACTIVE PROJECTS list (ID: 84391559)
  │     GET /api/v2/list/84391559/task?include_closed=true
  │
  ├─→ For each task: parseTask()
  │     1. Skip closed statuses (shipped, cancelled, hold, etc.)
  │     2. Extract Job No. → if missing, skip
  │     3. Extract Project Type → if not X/Y/Z, skip
  │     4. Get project value (text field → OCR fallback)
  │     5. Parse payment terms → milestone split
  │     6. Check 1st/Final payment status (Received/Pending)
  │     7. Extract timing fields
  │
  ├─→ Upsert project into database
  │
  ├─→ Before replacing milestones:
  │     Save any "invoiced" milestones (from prior Exact match)
  │
  ├─→ Delete old milestones, create new ones
  │     Restore invoiced status if previously matched
  │
  └─→ Estimate milestone dates using 5-layer priority chain
```

### Dynamics Sync
```
POST /api/sync/dynamics
  │
  ├─→ fetchPipelineOpportunities()
  │     GET /opportunities?$filter=statecode eq 0 and closeprobability ge 90
  │
  ├─→ For each opportunity:
  │     1. Extract project type from name (pattern: "25-Y2600")
  │     2. Upsert into projects (source='dynamics', tier='pipeline')
  │     3. Create 2 milestones (50/50 split):
  │        - 1st Payment: closeDate + 1 week
  │        - Final: closeDate + 10 weeks (X) or + 16 weeks (Y/Z)
  │
  └─→ Remove pipeline projects no longer in Dynamics
```

---

## 12. Source Priority Rules (from DATA_MAPPING_v2.md)

| Data Point | Primary Source | Fallback |
|------------|---------------|----------|
| Total project value | Dynamics Won Quote → nown_mon_totalprice | Dynamics Opportunity → estimatedvalue → ClickUp Project Value → 0 |
| Payment terms | Dynamics Quote → paymenttermscode | ClickUp Payment Terms free text → default 50/50 |
| 1st payment anchor date | Dynamics Opportunity → actualclosedate | ClickUp → quoteDate |
| Milestone timing fields | ClickUp (actual progress) | Dynamics quote lead times (original estimate) |
| Bank balance | Manual entry (default) | Exact GL 1000-1199 |
| VAT returns | Derived from COGS × 1.21 buffer | Manual entry option |
