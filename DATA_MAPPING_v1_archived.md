# NOWN Cash Position Dashboard — Data Mapping v1

> For Jason to verify: where each data point comes from, which system is source of truth, and where it lands on the timeline.

---

## The Three AR Layers (Inflows)

### LAYER 1: Current AR (Actual Outstanding Invoices)
**What it is:** Real invoices that have been issued and are waiting for payment.

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Invoice number | `ReceivablesList` → `InvoiceNumber` | **Exact Online** | Source of truth for what's been invoiced |
| Amount | `ReceivablesList` → `Amount` | **Exact Online** | Actual invoice amount in EUR |
| Due date (= when it lands) | `ReceivablesList` → `DueDate` | **Exact Online** | Determines which month the cash lands |
| Invoice date | `ReceivablesList` → `InvoiceDate` | **Exact Online** | When invoice was issued |
| Customer | `ReceivablesList` → `AccountName` | **Exact Online** | |
| Job number | Extracted from `Description` | **Exact Online** | Pattern: `26-Y2651` — used to link to ClickUp project |
| Project link | Matched by job number → `Project.externalId` | **DB (matched)** | Links invoice to a project for Layer 2 |

**Timeline placement:** Bucketed by **DueDate** from Exact. If overdue (past today), floored into current month.

**Split behavior:**
- **Unmatched AR** (no job number match → no project link) = standalone Layer 1 items
- **Matched AR** = updates the corresponding project milestone in Layer 2 to "invoiced" status with the real DueDate

---

### LAYER 2: Billable AR (Won Projects — Future Payments)
**What it is:** Payment milestones for confirmed/won projects. Some are already invoiced (matched from Exact), others are estimated based on project timing.

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Project name | `Task.name` | **ClickUp** | Source of truth for project identity |
| Job number | `Job No.` custom field | **ClickUp** | Links across all 3 systems |
| Project type (X/Y/Z) | `Project Type` dropdown | **ClickUp** | Determines COGS rate |
| Total value | `Project Value` text field OR `Signed Quotation` PDF OCR | **ClickUp** | Fallback chain: text field → OCR → 0 |
| Payment terms | `nown_manualentrypaymentterms` or `paymenttermscode` | **Dynamics 365 (quote)** | Source of truth for payment structure |
| Design weeks | `nown_designcoordinationweeks` | **Dynamics 365 (quote)** | Used to compute milestone dates |
| Manufacturing weeks | `nown_manufacturingtimeweeks` | **Dynamics 365 (quote)** | Used to compute milestone dates |
| Milestone split (%) | Derived from payment terms text | **Dynamics 365** | e.g., "30% start, 40% pre-ship, 30% NET 30" → 3 milestones |
| Milestone expected date | **5-layer estimation** (see below) | **ClickUp timing fields** | Best available date from project status |
| Milestone status | `pending` / `invoiced` / `received` | **ClickUp + Exact** | See lifecycle below |
| 1st Payment received? | `1st Payment Status` dropdown | **ClickUp** | If "Received" → milestone marked received |
| 1st Payment received date | `1st Payment Received Date` | **ClickUp** | Actual date payment arrived |
| Final Payment received? | `Final Payment Status` dropdown | **ClickUp** | If "Received" → milestone marked received |

**Timeline placement:** Each milestone's `expectedDate` determined by this priority chain:

```
1. ClickUp says "Received" with a date         → Use that date (it's done)
2. Exact AR matched → real invoice DueDate      → Use Exact DueDate
3. ClickUp has timing fields (see estimation)   → Compute from project status
4. Dynamics quote has lead time info            → Compute from payment terms + lead time
5. Fallback                                     → Rough estimate (2-3 months out)
```

**Milestone date estimation from ClickUp timing fields:**

| For 1st Payment | Logic |
|-----------------|-------|
| Quote date exists | `quoteDate + 1 week` |
| No quote date | 15th of next month |

| For Final/Later Payments | Logic (priority order) |
|--------------------------|----------------------|
| `productionEta` exists | `productionEta + 1 week` |
| Y/Z project, shops approved | `approvedShopsDate + (leadtime × 0.6) + 1 week` |
| Y/Z project, shops not approved | `dueDateShops + 2 weeks + (leadtime × 0.6) + 1 week` |
| Has quote date + leadtime | `quoteDate + leadtimeWeeks + 1 week` |
| Nothing available | 2-3 months from today |

---

### LAYER 3: Forecasted AR (Pipeline — Expected Future Sales)
**What it is:** Opportunities still in the sales pipeline (not yet won), with estimated payment timing based on their most recent open quotation.

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Opportunity name | `opportunities` entity → `name` | **Dynamics 365** | |
| Estimated value | `opportunities` → `estimatedvalue` | **Dynamics 365** | Used if no quote exists |
| Estimated close date | `opportunities` → `estimatedclosedate` | **Dynamics 365** | Anchor date for milestone computation |
| Pipeline stage | `opportunities` → `stepname` | **Dynamics 365** | e.g., "1-Qualify", "2-Develop" |
| Quote total price | `quotes` → `nown_mon_totalprice` or `totalamount` | **Dynamics 365** | From most recent open quote |
| Payment terms | `quotes` → `paymenttermscode` / `nown_manualentrypaymentterms` | **Dynamics 365** | Decoded from option set (26 variants) |
| Design weeks | `quotes` → `nown_designcoordinationweeks` | **Dynamics 365** | From open quote |
| Manufacturing weeks | `quotes` → `nown_manufacturingtimeweeks` | **Dynamics 365** | From open quote |

**Filters applied:**
- `statecode eq 0` (open opportunities only)
- `estimatedclosedate` between today and 12 months from now
- Optionally filtered by `stepname` (pipeline stage)

**Timeline placement:** Milestones computed from estimated close date + payment terms + lead time:

| Trigger | When it lands |
|---------|---------------|
| "start" / "deposit" | Estimated close date + 1 week |
| "shops" | Close date + design weeks |
| "approval" | Close date + design weeks + 2 weeks |
| "mid-manufacture" | Close date + design weeks + (mfg weeks / 2) |
| "pre-ship" | Close date + design weeks + mfg weeks |
| "NET 30" | Close date + total lead time + 4 weeks |
| "NET 60" | Close date + total lead time + 9 weeks |

**If no open quote exists:** Defaults to 50/50 split, 8 weeks manufacturing, 0 design weeks.

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXACT ONLINE                                  │
│                                                                         │
│  ReceivablesList ──→ Outstanding invoices (amount, due date, desc)       │
│  PayablesList    ──→ Outstanding payables (future: AP layer)            │
│  BankBalance     ──→ Current bank position (GL 1000-1199)              │
│                                                                         │
│  Invoice description contains job number (e.g., "26-Y2651")            │
│  ──→ AR Matching: links invoice to ClickUp project by job number       │
│  ──→ Updates milestone status from "pending" → "invoiced"              │
│  ──→ Replaces estimated date with real Exact DueDate                   │
└────────────┬───────────────────────────────────────────┬────────────────┘
             │                                           │
             ▼                                           ▼
┌────────────────────────┐              ┌────────────────────────────────┐
│     LAYER 1            │              │          DATABASE              │
│   Current AR           │              │                                │
│                        │              │  Project (won/pipeline)        │
│  Unmatched invoices    │              │  PaymentMilestone              │
│  from Exact that       │              │    → status: pending/          │
│  don't link to any     │              │      invoiced/received         │
│  project. Bucketed     │              │    → expectedDate              │
│  by DueDate.           │              │    → amount                    │
│                        │              │  ArLineItem (matched/          │
│  These are standalone  │              │    unmatched)                  │
│  receivables.          │              │  FinancialSnapshot             │
└────────────────────────┘              └──────────┬─────────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLICKUP                                    │
│                                                                         │
│  ACTIVE PROJECTS list (list ID: 84391559)                              │
│                                                                         │
│  For each task (project):                                              │
│    Job No.            → project identity (links to Dynamics + Exact)    │
│    Project Type       → X/Y/Z (determines COGS rate: 30%/40%/50%)     │
│    Project Value      → total contract value                           │
│    Payment Terms      → fallback if Dynamics quote unavailable         │
│    1st/Final Payment  → status (Received/Pending/Not Required)         │
│    Status             → where in lifecycle (3-design, 5-production...) │
│                                                                         │
│  TIMING FIELDS (drive milestone date estimation):                      │
│    quoteDate          → anchor for all timing                          │
│    leadtimeWeeks      → total project duration                         │
│    productionEta      → best estimate for final payment date           │
│    dueDateShops       → Y/Z: when drawings due to client              │
│    shopsStatus        → "Approved" = production green light            │
│    approvedShopsDate  → when client approved drawings                  │
│    prodFinishedDate   → actual production complete                     │
│    actualDispatch     → shipped date                                   │
│                                                                         │
│  ──→ Becomes LAYER 2: Billable AR (won projects with milestones)       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                          DYNAMICS 365                                   │
│                                                                         │
│  FOR WON PROJECTS (enriches Layer 2):                                  │
│    Quote → paymenttermscode   → exact payment structure (26 variants)   │
│    Quote → designcoordweeks   → design phase duration                  │
│    Quote → manufacturingweeks → production duration                    │
│    Quote → nown_mon_totalprice → verified total price                  │
│    Quote → crating/shipping   → additional cost components             │
│                                                                         │
│  FOR PIPELINE (Layer 3):                                               │
│    Opportunity → name, estimatedvalue, estimatedclosedate, stepname    │
│    Open Quote  → payment terms, lead time, total price                 │
│    ──→ Becomes LAYER 3: Forecasted AR (pipeline milestones)            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Dashboard Output: Monthly Timeline

For each month in the rolling 12-month window:

```
MONTH: e.g., "Apr 2026"
├── LAYER 1: Current AR          = EUR X    (Exact invoices due this month)
├── LAYER 2: Billable AR         = EUR Y    (Won project milestones expected this month)
├── LAYER 3: Forecasted AR       = EUR Z    (Pipeline milestones expected this month)
├── COGS (Won)                   = EUR -A   (Layer 2 amount × COGS rate × 1.10 buffer)
├── COGS (Pipeline)              = EUR -B   (Layer 3 amount × COGS rate × 1.10 buffer)
├── VAT Return                   = EUR +V   (Quarterly, lands 1-2 months after quarter end)
├── Overhead                     = EUR -O   (Monthly fixed costs from OverheadBudget)
│
├── Operating Cash = Bank + cumulative(L1 + L2 - COGS_won + VAT - Overhead)
└── Forecasted Cash = Operating + cumulative(L3 - COGS_pipeline)
```

---

## Toggle Behavior (New Dashboard)

Each layer can be toggled independently:

| Toggle | On = shows | Off = hides |
|--------|-----------|-------------|
| Current AR | Exact unmatched invoices | Remove from chart + cash line |
| Billable AR | Won project milestones | Remove from chart + cash line |
| Forecasted AR | Pipeline milestones | Remove from chart + cash line |
| COGS (Won) | Won project cost of goods | Remove from cash line |
| COGS (Pipeline) | Pipeline cost of goods | Remove from cash line |
| VAT Returns | Quarterly VAT refunds | Remove from cash line |
| Overhead | Monthly fixed costs | Remove from cash line |

**Presets:**
- **Conservative** = Current AR + Billable AR + all outflows. No pipeline.
- **Full Forecast** = All layers on.
- **AR Only** = Just the 3 AR layers, no outflows.

---

## COGS Rates

| Project Type | COGS Rate | Buffer | Effective |
|--------------|-----------|--------|-----------|
| X (production only) | 30% | ×1.10 | 33% |
| Y (design + production) | 40% | ×1.10 | 44% |
| Z (custom design + production) | 50% | ×1.10 | 55% |

---

## Questions / Assumptions to Verify

1. **Dynamics as source of truth for payment terms on won projects**: Currently, ClickUp `Payment Terms` field is used during sync. Should Dynamics quote data override ClickUp for won projects where a linked Dynamics quote exists? (I'm assuming YES — Dynamics has structured option sets, ClickUp has free text.)

2. **ClickUp timing fields vs Dynamics lead time**: For milestone date estimation on won projects, ClickUp timing fields (productionEta, shopsStatus, etc.) reflect *actual progress*. Dynamics quote lead times are the *original estimate*. I'm using ClickUp timing as primary (real status) and Dynamics as fallback (if ClickUp fields are empty). **Correct?**

3. **"Pipeline Phase 3"**: In Dynamics, opportunities have `stepname` values like "1-Qualify", "2-Develop". When you say "Pipeline Phase 3" — is that a specific stepname in your Dynamics setup? From the data I pulled, I only see "1-Qualify" and "2-Develop" as current stages. Should I filter by a specific stepname, or show all open opportunities?

4. **Bank balance as starting point**: The cash position line starts from the Exact bank balance (GL accounts 1000-1199). This is the current opening balance for the rolling forecast. **Correct?**

5. **Matched AR double-counting prevention**: When an Exact invoice is matched to a project milestone, the milestone gets updated to "invoiced" with the real DueDate. The original unmatched AR item is removed from Layer 1. So there's no double-counting — the cash shows up in Layer 2 (project milestone) not Layer 1 (standalone AR). **This is the current behavior — should it stay?**
