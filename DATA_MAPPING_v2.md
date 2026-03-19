# NOWN Cash Position Dashboard — Data Mapping v2

> **Revised:** 19 March 2026 — incorporates Jason's review feedback on v1.
> **Status:** 1/7 sections fully approved, 1/7 flagged with corrections applied, 5/7 reviewed with notes integrated.

---

## Changelog from v1

| Section | Change | Source |
|---------|--------|--------|
| Layer 2 — project value | Source of truth changed from ClickUp `Project Value` text field to **Dynamics Closed Won Opportunity → Won Quote → total price**. ClickUp text field is unreliable. | Jason review |
| Layer 2 — 1st payment date | Priority 1 for 1st payment date now uses **Dynamics Opportunity Actual Close Date** (not ClickUp quote date) | Jason review |
| Layer 2 — final payment triggers | Must validate that triggers (pre-ship, NET 30, etc.) are extracted from **Dynamics payment terms** — not assumed | Jason review |
| Layer 3 — pipeline phases | Dashboard must allow **independent toggle of Phase 1, 2, 3** with weighted likelihood (10%, 30%, 90%) | Jason review |
| COGS — VAT buffer | Buffer changed from **1.10 → 1.21** (Dutch VAT rate) | Jason review |
| VAT returns | Added **manual override option** alongside Exact pull and derived-from-COGS-buffer options | Jason review |
| Cash position — bank balance | Added **manual entry option** as alternative to Exact GL pull (Exact mapping not yet confirmed) | Jason review |
| Payment terms — source priority | Changed to **Dynamics first, ClickUp as fallback** (was ClickUp during sync) | Jason review — Q1 |
| Pipeline phase labels | Mapped OOB labels: 1-Qualify=10%, 2-Develop=30%, **3-Propose=90%** (committed) | Jason review — Q3 |

---

## The Three AR Layers (Inflows)

### LAYER 1: Current AR (Actual Outstanding Invoices)

**What it is:** Real invoices that have been issued and are waiting for payment.
**Source of truth:** Exact Online.
**Review status:** Not yet reviewed (no corrections flagged).

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Invoice number | `ReceivablesList` → `InvoiceNumber` | **Exact Online** | Source of truth for what's been invoiced |
| Amount | `ReceivablesList` → `Amount` | **Exact Online** | Actual invoice amount in EUR |
| Due date | `ReceivablesList` → `DueDate` | **Exact Online** | Determines which month the cash lands |
| Invoice date | `ReceivablesList` → `InvoiceDate` | **Exact Online** | When invoice was issued |
| Customer | `ReceivablesList` → `AccountName` | **Exact Online** | |
| Job number | Extracted from `Description` | **Exact Online** | Pattern: `26-Y2651` — used to link to ClickUp/Dynamics project |
| Project link | Matched by job number → `Project.externalId` | **DB (matched)** | Links invoice to a project for Layer 2 |

**Timeline placement:** Bucketed by **DueDate** from Exact. If overdue (past today), floored into current month.

**Split behavior:**
- **Matched AR** (job number links to a project) = updates the corresponding project milestone in Layer 2 to "invoiced" status with the real DueDate. Removed from Layer 1 to prevent double-counting.
- **Unmatched AR** (no job number match) = stays as standalone Layer 1 item, bucketed by DueDate.

---

### LAYER 2: Billable AR (Won Projects — Future Payments)

**What it is:** Payment milestones for confirmed/won projects. Some already invoiced (matched from Exact), others estimated from project timing.
**Review status:** FLAGGED — corrections applied below.

#### Project Identity & Value

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Project name | `Task.name` (should match Dynamics opportunity name) | **ClickUp + Dynamics** | Name and number should be the same across both systems |
| Job number | `Job No.` custom field | **ClickUp** | Links across all 3 systems (Exact, ClickUp, Dynamics) |
| Project type (X/Y/Z) | `Project Type` dropdown | **ClickUp** | Determines COGS rate |
| **Total value** | **Dynamics: Closed Won Opportunity → Won Quote → `nown_mon_totalprice` or `totalamount`** | **Dynamics 365** | **CHANGED v2:** Do NOT use ClickUp `Project Value` text field — it is unreliable. The Won quote under the Closed Won opportunity has the most up-to-date information. Fallback chain: Dynamics Won Quote → Dynamics Opportunity `estimatedvalue` → ClickUp `Project Value` text field → 0 |

> **IMPORTANT (v2):** The previous version used ClickUp's `Project Value` text field as primary source for total value. This has been changed to Dynamics. The ClickUp field should only be used as a last-resort fallback.

#### Payment Structure

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Payment terms | **Primary:** `quotes` → `nown_manualentrypaymentterms` or `paymenttermscode` | **Dynamics 365** | **CHANGED v2:** Dynamics is source of truth. 26 structured option set variants. |
| Payment terms (fallback) | `Payment Terms` custom field | **ClickUp** | **Only if Dynamics quote lookup fails.** Free text — less reliable. |
| Design weeks | `nown_designcoordinationweeks` | **Dynamics 365 (quote)** | Used to compute milestone dates |
| Manufacturing weeks | `nown_manufacturingtimeweeks` | **Dynamics 365 (quote)** | Used to compute milestone dates |
| Milestone split (%) | Derived from payment terms text | **Dynamics 365** | e.g., "30% start, 40% pre-ship, 30% NET 30" → 3 milestones |

> **Source priority for payment terms (v2):**
> 1. Dynamics Won Quote → structured payment terms (26 variants)
> 2. If Dynamics lookup fails → ClickUp `Payment Terms` free text field
> 3. If both empty → default 50/50 split

#### Payment Status Tracking

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| 1st payment status | `1st Payment Status` dropdown | **ClickUp** | Received / Pending / Not Required |
| 1st payment date | `1st Payment Received Date` | **ClickUp** | Actual date payment arrived |
| Final payment status | `Final Payment Status` dropdown | **ClickUp** | Received / Pending / Not Required |
| Milestone status | `pending` → `invoiced` → `received` | **ClickUp + Exact** | Lifecycle driven by Exact match + ClickUp fields |

---

### LAYER 2: Milestone Date Estimation

**Review status:** Notes integrated — corrections applied below.

#### 5-Layer Priority Chain

```
1. ClickUp says "Received" with a date         → Use that date (it's done)
2. Exact AR matched → real invoice DueDate      → Use Exact DueDate
3. ClickUp has timing fields (see estimation)   → Compute from project status
4. Dynamics quote has lead time info            → Compute from payment terms + lead time
5. Fallback                                     → Rough estimate (2-3 months out)
```

#### 1st Payment Date Logic

**CHANGED v2:** Primary anchor is now Dynamics Actual Close Date, not ClickUp quote date.

| Priority | Condition | Logic |
|----------|-----------|-------|
| 1 | ClickUp `1st Payment Status` = "Received" | Use `1st Payment Received Date` |
| 2 | Exact AR matched for this milestone | Use Exact `DueDate` |
| **3** | **Dynamics Opportunity has `actualclosedate`** | **`actualclosedate` + 1 week** |
| 4 | ClickUp `quoteDate` exists (fallback) | `quoteDate + 1 week` |
| 5 | Nothing available | 15th of next month |

> **CHANGED v2:** Previous version used ClickUp `quoteDate` as primary. Now uses Dynamics `actualclosedate` from the Closed Won opportunity. ClickUp quote date is fallback only.

#### Final / Later Payment Date Logic

| Priority | Condition | Logic |
|----------|-----------|-------|
| 1 | `productionEta` exists (ClickUp) | `productionEta + 1 week` |
| 2 | Y/Z project, shops approved | `approvedShopsDate + (leadtime × 0.6) + 1 week` |
| 3 | Y/Z project, shops not approved | `dueDateShops + 2 weeks + (leadtime × 0.6) + 1 week` |
| 4 | Has quote date + leadtime | `quoteDate + leadtimeWeeks + 1 week` |
| 5 | Nothing available | 2-3 months from today |

> **v2 NOTE:** The trigger labels used in this logic (e.g., "pre-ship", "NET 30", "shops") must be validated against the actual payment terms extracted from Dynamics. Do not assume trigger names — parse them from the `paymenttermscode` or `nown_manualentrypaymentterms` fields. The 26 payment term variants in Dynamics define what milestones exist and what triggers them.

---

### LAYER 3: Forecasted AR (Pipeline — Expected Future Sales)

**What it is:** Opportunities still in the sales pipeline (not yet won), with estimated payment timing based on their most recent open quotation.
**Review status:** Notes integrated — pipeline phase toggle added.

| Field | Source | System | Notes |
|-------|--------|--------|-------|
| Opportunity name | `opportunities` → `name` | **Dynamics 365** | |
| Estimated value | `opportunities` → `estimatedvalue` | **Dynamics 365** | Used if no quote exists |
| Estimated close date | `opportunities` → `estimatedclosedate` | **Dynamics 365** | Anchor date for milestone computation |
| Pipeline stage | `opportunities` → `stepname` | **Dynamics 365** | See phase mapping below |
| Quote total price | `quotes` → `nown_mon_totalprice` or `totalamount` | **Dynamics 365** | From most recent open quote |
| Payment terms | `quotes` → `paymenttermscode` / `nown_manualentrypaymentterms` | **Dynamics 365** | Decoded from option set (26 variants) |
| Design weeks | `quotes` → `nown_designcoordinationweeks` | **Dynamics 365** | From open quote |
| Manufacturing weeks | `quotes` → `nown_manufacturingtimeweeks` | **Dynamics 365** | From open quote |

#### Pipeline Phase Mapping & Toggle (NEW v2)

The dashboard must support **independent toggles for each pipeline phase**, allowing the user to see cash impact at different confidence levels.

| Dynamics `stepname` | Dashboard Label | Likelihood | Toggle Behavior |
|---------------------|----------------|------------|-----------------|
| `1-Qualify` | Phase 1 — Qualify | **10%** | Toggle independently. When on, shows at full value (user mentally discounts). When used in weighted mode, multiplies by 0.10. |
| `2-Develop` | Phase 2 — Develop | **30%** | Toggle independently. Weighted mode multiplies by 0.30. |
| `3-Propose` | Phase 3 — Propose (committed) | **90%** | Toggle independently. This is the only phase considered truly committed. Most accurate data. Weighted mode multiplies by 0.90. |

> **NEW v2:** Jason notes that the OOB Dynamics labels are not perfectly descriptive. "3-Propose" effectively means **committed project with 90% likelihood of order entry** — this is the most reliable pipeline layer. Phases 1 and 2 are early-stage and should be treated as speculative. Consider adding a **weighted mode toggle** that applies the likelihood percentages to the pipeline amounts, vs. showing raw values.

**Presets updated:**
- **Conservative** = Current AR + Billable AR + all outflows. No pipeline at all.
- **Likely** = Conservative + Phase 3 only (90% committed pipeline).
- **Full Forecast** = All layers on, all phases on.
- **Weighted Forecast** = All layers on, pipeline amounts × likelihood percentages.

**Filters applied:**
- `statecode eq 0` (open opportunities only)
- `estimatedclosedate` between today and 12 months from now
- Filtered by `stepname` based on which phase toggles are active

**Milestone timing from close date** (unchanged from v1):

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

## Outflows

### COGS Rates

**CHANGED v2:** VAT buffer updated from 1.10 to **1.21** (Dutch VAT rate, 21%).

| Project Type | Description | Base COGS Rate | VAT Buffer | Effective Rate |
|--------------|-------------|---------------|------------|----------------|
| X | Production only | 30% | ×1.21 | **36.3%** |
| Y | Design + production | 40% | ×1.21 | **48.4%** |
| Z | Custom design + production | 50% | ×1.21 | **60.5%** |

- **COGS (Won)** = Layer 2 milestone amount × effective rate for project type
- **COGS (Pipeline)** = Layer 3 milestone amount × effective rate for project type

### Monthly Overhead

Source: `OverheadBudget` table (manual input, updated quarterly).
Fixed monthly costs: rent, salaries, insurance, utilities.
Deducted from cash position every month.

### VAT Returns

**CHANGED v2:** Three source options, user-selectable.

| Source Option | How it works | When to use |
|---------------|-------------|-------------|
| **Derived from COGS buffer** | Takes the VAT component from the 1.21 buffer applied to COGS. Quarterly, lands 1-2 months after quarter end. | Default — automated estimate |
| **Manual entry** | User inputs a fixed EUR amount per quarter | When you know the actual return amount or want to override |
| **Pull from Exact** | Reads VAT return data from Exact Online (endpoint TBD) | When Exact has the actual filed/expected return data |

The dashboard should show which source mode is active and allow switching between them.

---

## Cash Position Calculation

### Starting Balance

**CHANGED v2:** Two options for bank balance, user-selectable.

| Option | Source | Notes |
|--------|--------|-------|
| **Exact Online** | GL accounts 1000-1199 → `BankBalance` | Automated pull. Mapping not yet confirmed — may need adjustment once Exact GL structure is verified. |
| **Manual entry** | User inputs a EUR amount | Use this until Exact GL mapping is confirmed. Default for initial deployment. |

> **v2 NOTE:** Jason flags that the Exact GL mapping for bank balance is not yet properly mapped. **Default to manual entry for launch.** Add the Exact pull as a secondary option that can be enabled once the GL account mapping is verified.

### Monthly Cash Formula

```
Starting point = Bank balance (manual entry OR Exact GL 1000-1199)

OPERATING CASH (per month) =
  Starting balance
  + cumulative( Layer 1: Current AR )
  + cumulative( Layer 2: Billable AR )
  − cumulative( COGS on won projects )
  + cumulative( VAT returns )
  − cumulative( Monthly overhead )

FORECASTED CASH (per month) =
  Operating cash
  + cumulative( Layer 3: Pipeline AR × phase filter )
  − cumulative( COGS on pipeline projects )
```

### Toggle Behavior

Each series can be toggled independently. Cash position recalculates on every toggle change.

| Toggle | On = includes | Off = excludes |
|--------|--------------|----------------|
| Current AR (Layer 1) | Exact unmatched invoices | Remove from chart + cash line |
| Billable AR (Layer 2) | Won project milestones | Remove from chart + cash line |
| Pipeline — Phase 1 | 1-Qualify opportunities (10% likelihood) | Remove from chart + cash line |
| Pipeline — Phase 2 | 2-Develop opportunities (30% likelihood) | Remove from chart + cash line |
| Pipeline — Phase 3 | 3-Propose opportunities (90% likelihood) | Remove from chart + cash line |
| COGS (Won) | Won project cost of goods (×1.21) | Remove from cash line |
| COGS (Pipeline) | Pipeline cost of goods (×1.21) | Remove from cash line |
| VAT Returns | Quarterly VAT refunds | Remove from cash line |
| Overhead | Monthly fixed costs | Remove from cash line |
| Weighted mode | Pipeline amounts × likelihood % | Show raw pipeline values |

**Presets:**
- **Conservative** = Layer 1 + Layer 2 + all outflows. No pipeline.
- **Likely** = Conservative + Phase 3 pipeline only.
- **Full Forecast** = All layers, all phases on.
- **Weighted** = All layers on, pipeline amounts weighted by phase likelihood.
- **AR Only** = Just the 3 AR layers, no outflows.

---

## AR Matching & Double-Count Prevention

**Review status:** APPROVED

When an Exact invoice is matched to a project milestone by job number:
1. Milestone status updated from `pending` → `invoiced`
2. Estimated date replaced with real Exact `DueDate`
3. Invoice **removed from Layer 1** — it now lives in Layer 2
4. No double-counting: cash shows in Layer 2 (project context) not Layer 1 (standalone)

If no match is found, the invoice stays in Layer 1 as a standalone receivable.

> **v2 NOTE:** Jason wants to verify this behavior against real data before finalizing. The logic is approved in principle but may need adjustment once live Exact data is flowing through. Flag for QA testing.

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXACT ONLINE                                  │
│                                                                         │
│  ReceivablesList ──→ Outstanding invoices (amount, due date, desc)       │
│  PayablesList    ──→ Outstanding payables (future: AP layer)            │
│  BankBalance     ──→ Current bank position (GL 1000-1199)              │
│                      ⚠️  GL mapping not yet confirmed — manual override  │
│                         available as default                            │
│                                                                         │
│  Invoice description contains job number (e.g., "26-Y2651")            │
│  ──→ AR Matching: links invoice to ClickUp/Dynamics project            │
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
          ┌────────────────────────────────────────┤
          ▼                                        ▼
┌─────────────────────────────────────┐  ┌────────────────────────────────┐
│         DYNAMICS 365                │  │           CLICKUP              │
│                                     │  │                                │
│  ** SOURCE OF TRUTH FOR: **         │  │  ACTIVE PROJECTS list          │
│                                     │  │  (list ID: 84391559)          │
│  WON PROJECTS (enriches Layer 2):   │  │                                │
│   Closed Won Opportunity            │  │  For each task (project):     │
│    → actualclosedate (v2: anchor    │  │   Job No. → identity link     │
│      for 1st payment date)          │  │   Project Type → X/Y/Z       │
│   Won Quote (under opportunity)     │  │   Payment Terms → FALLBACK    │
│    → nown_mon_totalprice            │  │     only if Dynamics fails    │
│      (v2: SOURCE OF TRUTH for       │  │   1st/Final Payment status    │
│       total project value)          │  │   Status → lifecycle stage    │
│    → paymenttermscode (v2: PRIMARY  │  │                                │
│      source for payment terms)      │  │  TIMING FIELDS (date est.):   │
│    → nown_manualentrypaymentterms   │  │   productionEta               │
│    → designcoordweeks               │  │   dueDateShops                │
│    → manufacturingweeks             │  │   shopsStatus                 │
│    → crating/shipping               │  │   approvedShopsDate           │
│                                     │  │   prodFinishedDate            │
│  PIPELINE (Layer 3):                │  │   actualDispatch              │
│   Opportunity                       │  │   quoteDate (fallback for     │
│    → name, estimatedvalue           │  │     1st payment if Dynamics   │
│    → estimatedclosedate             │  │     actualclosedate missing)  │
│    → stepname:                      │  │   leadtimeWeeks               │
│      1-Qualify  = Phase 1 (10%)     │  │                                │
│      2-Develop  = Phase 2 (30%)     │  │  ──→ LAYER 2: Billable AR    │
│      3-Propose  = Phase 3 (90%)     │  │      (timing + status)       │
│   Open Quote                        │  │                                │
│    → payment terms, lead time       │  └────────────────────────────────┘
│    → total price                    │
│   ──→ LAYER 3: Forecasted AR       │
│       (pipeline milestones)         │
└─────────────────────────────────────┘
```

---

## Source Priority Summary (v2)

| Data Point | Primary Source | Fallback | Notes |
|------------|---------------|----------|-------|
| **Total project value** | Dynamics Won Quote → `nown_mon_totalprice` | Dynamics Opportunity → `estimatedvalue` → ClickUp `Project Value` → 0 | v2: ClickUp text field is last resort |
| **Payment terms** | Dynamics Quote → `paymenttermscode` / `nown_manualentrypaymentterms` | ClickUp `Payment Terms` free text | v2: Dynamics first, ClickUp only if Dynamics fails |
| **1st payment anchor date** | Dynamics Opportunity → `actualclosedate` | ClickUp → `quoteDate` | v2: Changed from ClickUp-first |
| **Milestone timing fields** | ClickUp (productionEta, shopsStatus, etc.) | Dynamics quote lead times | Confirmed: ClickUp reflects actual progress, Dynamics is original estimate |
| **Bank balance** | Manual entry (default for launch) | Exact GL 1000-1199 (once mapping confirmed) | v2: Manual override required |
| **VAT returns** | Derived from COGS ×1.21 buffer (default) | Manual entry OR Exact pull | v2: Three options, user-selectable |

---

## Open Items for Implementation

1. **Exact GL mapping for bank balance** — needs to be verified before enabling automated pull. Ship with manual entry as default.
2. **AR matching QA** — double-count prevention logic is approved in principle but needs testing against real Exact data.
3. **Pipeline weighted mode** — implement both raw and weighted views. Weighted applies 10%/30%/90% multipliers to Phase 1/2/3 pipeline amounts.
4. **Payment term trigger validation** — ensure that milestone trigger labels ("pre-ship", "NET 30", etc.) are parsed from actual Dynamics payment term data, not hardcoded.
5. **VAT return source switching** — build UI for toggling between derived/manual/Exact sources.
