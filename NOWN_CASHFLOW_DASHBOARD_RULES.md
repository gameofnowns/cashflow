# NOWN Cash Flow Dashboard — Design Ruleset

> Combines NOWN Brand Guidelines (12/2022), VEIL Brand Design System v3, and the existing Cash Flow Forecast dashboard layout to produce an internal financial tool that feels unmistakably NOWN.

---

## 0. Data Sources

The dashboard pulls from two systems:

| Source | Data | Sync |
|--------|------|------|
| **Cash Flow Forecast** (existing HTML dashboard) | Bank balance, AR, COGS, VAT, overhead, operating/forecasted cash, 12-month rolling projection | Manual or API sync |
| **ClickUp Production Schedule** | Active projects, PD+WO due dates, shop due dates, delivery dates, Gantt timeline | ClickUp API (`Sync ClickUp` button) |

The visualization merges financial projections with production milestones — showing *when* money moves relative to *which projects* drive it.

---

## 1. Surface & Background

### One Cream Rule
**`#EAE6DF`** is the single background for the entire dashboard. No white cards, no grey panels, no surface hierarchy through shade. Structure comes from gridlines only.

This matches both the NOWN Brand Guidelines (cream = Pantone 9043C) and the VEIL configurator convention.

> **Exception**: The existing dashboard uses `#FFFFFF` white cards on a light grey background. The NOWN-branded version replaces this with cream ground + gridline structure.

---

## 2. Color Palette

### Primary Tokens (from `brand.js`)

```
--cream:      #EAE6DF    background (everything)
--ink:        #1A1814    primary text, gridlines, chart axes
--sub:        #6B6560    secondary text (descriptions, column headers)
--dim:        #A09890    tertiary labels (month labels, axis ticks)
--ghost:      #C8C2B8    disabled states, placeholder, empty cells
```

### NOWN Brand Accents (for data visualization)

| Color | Hex | Dashboard Use |
|-------|-----|---------------|
| Blue | `#0086D5` | **Forecasted cash line** (incl. pipeline) |
| Green | `#82D780` | **Operating cash line**, positive values |
| Orange | `#FE6337` | **Hover state only** — interactive highlight, sync button hover |
| Terracotta | `#BD6A55` | **Negative/warning values**, overdue projects |
| Yellow | `#FAE791` | **Pipeline/tentative** revenue markers |
| Sage | `#8F9A8F` | **Completed/past** project bars on Gantt |
| Blue Grey | `#D8E1EB` | **Projected/future** area fill (light) |
| Bronze | `#887550` | **COGS/overhead** category |
| Black | `#1A1814` | **Actual/confirmed** data points, all text values |

### Hard Rules for Data Values
- All numeric readout values render in **ink `#1A1814`** — never red, never accent colors
- Negative values: prefix with `- ` (minus space), same ink color. Optionally use terracotta `#BD6A55` for the minus sign only
- Currency format: `EUR XXX.XXX` or `EUR -XXX.XXX` (European convention, period as thousands separator)

---

## 3. Typography

### Typeface: Replica by Norm (Zurich)

| Role | Weight | Case | Size | Letter-spacing | Line-height | Use |
|------|--------|------|------|----------------|-------------|-----|
| **PAGE TITLE** | Bold 700 | UPPERCASE | 28px | 6px | 0.70 | "CASH FLOW FORECAST" |
| **SECTION HEADER** | Bold 700 | UPPERCASE | 18px | 4px | 0.75 | "MONTHLY BREAKDOWN", "12-MONTH CASH POSITION" |
| **KPI VALUE** | Bold 700 | none | 22px | 2px | 0.75 | Bank balance, outlook numbers in summary cards |
| **KPI LABEL** | Bold 700 | UPPERCASE | 7.5px | 3.5px | 1.4 | "BANK BALANCE", "3-MONTH OUTLOOK" |
| **TABLE HEADER** | Bold 700 | UPPERCASE | 7.5px | 3.5px | 1.4 | Column headers: "MONTH", "CURRENT AR", etc. |
| **TABLE VALUE** | Bold 700 | none | 11px | 2px | 1.2 | Cell values in monthly breakdown |
| **SUBTITLE** | Light 300 | lowercase | 9px | 0.3px | 1.7 | "rolling 12-month view — operating vs forecasted position" |
| **CAPTION** | Light 300 | lowercase | 7px | 1.5px | 1.6 | "last updated: 18-3-2026, 20:54:59" |
| **CHART AXIS** | Light 300 | none | 7.5px | 0.5px | 1.6 | Month labels (03, 04, ...), Y-axis values |
| **PROJECT NAME** | Regular 400 | UPPERCASE | 7.5px | 2.5px | 1.3 | ClickUp project codes on Gantt |

Font stack: `'Replica', 'Helvetica Neue', Arial, sans-serif`
Monospace (for values): `'SF Mono', 'Fira Code', Consolas, monospace`

### Rules
- **Bold uppercase for labels.** Light lowercase for body. Never the reverse.
- **70% line-height for display type** (page title, KPI values). 100% for body.
- Headlines use **tight letter-spacing** (3.5-6px) for that compressed NOWN feel.

---

## 4. Grid & Layout

### Master Grid: 6 Columns
All content aligns to a **6-column master grid**, matching both the VEIL configurator and the NOWN brand composition system.

```
|  1  |  2  |  3  |  4  |  5  |  6  |
|-----|-----|-----|-----|-----|-----|
```

### Gridline Structure
- **`1px solid #1A1814`** between all cells — this IS the structure
- No gaps, no padding between adjacent grid cells
- Internal cell padding: `14px 18px` for content, `10px 16px` for nav/header
- Every cell: `borderBottom` + `borderRight` (except last column in row)

### Dashboard Layout Map

```
ROW 0: HEADER BAR (6-col span)
  NOWN logo (left) | "Cash Flow Forecast" (left) | [Sync ClickUp] (right) | timestamp (right)

ROW 1: KPI SUMMARY (4 cards, each 1.5 cols = 6 total)
  Bank Balance | 3-Month Outlook | 6-Month Outlook | Forecasted (incl. Pipeline)

ROW 2: CHART (6-col span)
  12-Month Cash Position — dual line chart (operating + forecasted)

ROW 3: SECTION HEADER
  "MONTHLY BREAKDOWN"

ROW 4+: DATA TABLE (6-col span, scrollable)
  Month | Current AR | Billable AR | Forecasted AR | COGS (Won) | COGS (Pipeline) | VAT Return | Overhead | Operating Cash | Forecasted Cash
```

### KPI Summary Cards
- Each card is a gridline-bounded cell — no shadow, no border-radius, no elevation
- Structure: `LABEL` (top, 7.5px bold uppercase) + `VALUE` (center, 22px bold) + `CAPTION` (bottom, 7px light lowercase)
- Separated by `1px solid #1A1814` vertical gridlines

---

## 5. Interactive States

| State | Background | Text |
|-------|-----------|------|
| **Default** | `transparent` | `#1A1814` (ink) |
| **Hover** | `#FE6337` (orange) | `#FFFFFF` (white) |
| **Active / Selected** | `#1A1814` (black) | `#EAE6DF` (cream) |

- **Sync ClickUp button**: Default = `#1A1814` bg + `#EAE6DF` text. Hover = `#FE6337` bg + `#FFFFFF` text.
- **Table row hover**: Full-width orange highlight, text inverts to white
- **Chart data point hover**: Orange dot with tooltip
- **Nav tabs** (Dashboard / Settings): Standard hover/active states

### No Border-Radius
Sharp corners everywhere. No `border-radius` on buttons, cards, inputs, tooltips, or chart elements. This is a hard NOWN rule.

---

## 6. Chart Styling

### 12-Month Cash Position Line Chart

| Element | Style |
|---------|-------|
| **Background** | `#EAE6DF` (cream) — no white chart area |
| **Grid lines** | `1px solid #C8C2B8` (ghost) — subtle horizontal guides |
| **X-axis line** | `1px solid #1A1814` (ink) |
| **Y-axis line** | `1px solid #1A1814` (ink) |
| **Operating line** | `2px solid #82D780` (green), no fill |
| **Forecasted line** | `2px solid #0086D5` (blue), dashed `4 4` |
| **Data points** | `6px` circles, same color as line, `1px solid #1A1814` border |
| **Area fill (projected)** | `#D8E1EB` at 30% opacity below forecasted line |
| **Zero line** | `1px dashed #A09890` (dim) |
| **Value callouts** | `11px Bold`, ink color, positioned at first/last data points |
| **Axis labels** | `7.5px Light`, dim color |
| **Legend** | `7.5px Bold UPPERCASE` labels with `8px` color dot, positioned top-right inside chart |

### Chart Rules
- No rounded line caps — use `stroke-linecap: butt`
- No gradient fills
- No animation on load (data appears immediately, matching the NOWN "no-nonsense" ethos)
- Tooltip: cream bg, `1px solid #1A1814`, no shadow, no border-radius

---

## 7. Data Table

### Monthly Breakdown Table

| Property | Value |
|----------|-------|
| **Header row bg** | `#1A1814` (black) |
| **Header text** | `#EAE6DF` (cream), 7.5px Bold UPPERCASE |
| **Body row bg** | `transparent` (cream shows through) |
| **Alternating rows** | No zebra striping — gridlines provide structure |
| **Cell borders** | `1px solid #1A1814` on bottom + right |
| **Cell padding** | `10px 14px` |
| **Value alignment** | Right-aligned for all numeric columns |
| **Month column** | Left-aligned, `11px Bold` |
| **Empty cells** | `—` in ghost color `#C8C2B8` |

### Conditional Formatting (Subtle)
- Forecasted AR values that exist: terracotta `#BD6A55` text (indicates estimate, not confirmed)
- Operating Cash running total: Bold ink, no special color
- The minus sign for negative values can optionally be terracotta

---

## 8. Project Timeline Integration (ClickUp Data)

When ClickUp production schedule data is displayed alongside cashflow:

### Gantt-Style Project Bars

| Element | Style |
|---------|-------|
| **Bar height** | 20px |
| **Bar fill — active** | Solid NOWN brand color per project status |
| **Bar fill — on track** | `#82D780` (green) |
| **Bar fill — at risk** | `#FAE791` (yellow) |
| **Bar fill — overdue** | `#BD6A55` (terracotta) |
| **Bar fill — complete** | `#8F9A8F` (sage) |
| **Bar border** | `1px solid #1A1814` |
| **Bar corners** | Sharp (no border-radius) |
| **Project label** | `7.5px Regular UPPERCASE`, left of bar or inside if space allows |
| **Due date marker** | `1px solid #1A1814` vertical line |

### Project-to-Cash Linking
When a project bar is hovered, highlight the corresponding months in the cash flow table and chart where its AR/COGS impact lands. Use orange hover state.

---

## 9. Header & Navigation

```
| NOWN [logo]  Cash Flow Forecast  |  [Sync ClickUp]  Last updated: ...  |
|  Dashboard  |  Settings  |                                              |
```

- **NOWN logo**: Black logotype on cream, positioned top-left
- **App title**: "Cash Flow Forecast" — 13px Bold UPPERCASE, `3px` letter-spacing
- **Nav tabs**: Standard VEIL tab convention — gridline-separated, hover = orange, active = black
- **Sync button**: `10px Bold UPPERCASE`, `padding: 8px 16px`, ink bg + cream text, hover = orange
- **Timestamp**: `7px Light lowercase`, dim color, right-aligned

---

## 10. Responsive Behavior

| Breakpoint | Grid | Adaptation |
|------------|------|------------|
| >= 1200px | 6 columns | Full layout as described |
| 900-1199px | 4 columns | KPI cards stack 2x2, table scrolls horizontally |
| < 900px | 2 columns | KPI cards stack vertically, chart below, table full-width scroll |

At all breakpoints, gridlines remain `1px solid #1A1814`. The grid compresses but the structural language stays constant.

---

## 11. Hard Rules Summary

1. **One cream.** `#EAE6DF` for every background surface. No white cards.
2. **Gridlines are structure.** `1px solid #1A1814`. No card shadows, no elevation, no spacing-based hierarchy.
3. **No border-radius.** Sharp corners on everything — buttons, tooltips, chart elements, table cells.
4. **Hover = orange.** Active = black. Text always inverts.
5. **Bold uppercase for labels.** Light lowercase for body. 70% line-height for display.
6. **Ink for values.** All numeric readouts in `#1A1814`. Never red for negative values.
7. **Light theme only.** No dark mode.
8. **Replica typeface.** Three weights: Bold 700 (labels, values), Regular 400 (tags), Light 300 (body, captions).
9. **6-column master grid.** All content aligns.
10. **No gratuitous animation.** Data appears. Hover transitions may be `150ms` max.
11. **European number format.** Period for thousands, comma for decimals: `1.827.518,00`
12. **Font sizes 6-9px for UI chrome.** 11-42px for display/values only.

---

## 12. Token Reference (CSS Custom Properties)

```css
:root {
  /* Surface */
  --bg:         #EAE6DF;

  /* Ink hierarchy */
  --ink:        #1A1814;
  --sub:        #6B6560;
  --dim:        #A09890;
  --ghost:      #C8C2B8;

  /* Brand accents */
  --orange:     #FE6337;
  --blue:       #0086D5;
  --green:      #82D780;
  --yellow:     #FAE791;
  --terracotta: #BD6A55;
  --sage:       #8F9A8F;
  --blue-grey:  #D8E1EB;
  --bronze:     #887550;
  --blush:      #F7E5DF;

  /* Structure */
  --grid:       1px solid #1A1814;

  /* Typography */
  --font:       'Replica', 'Helvetica Neue', Arial, sans-serif;
  --mono:       'SF Mono', 'Fira Code', Consolas, monospace;
}
```

---

## 13. Component Checklist

When building, verify each component against this list:

- [ ] Background is `#EAE6DF` (not white)
- [ ] All borders are `1px solid #1A1814` (not grey, not transparent)
- [ ] No `border-radius` anywhere
- [ ] Hover states use `#FE6337` with white/cream text
- [ ] Active states use `#1A1814` with cream text
- [ ] All labels are Bold 700 UPPERCASE
- [ ] All body text is Light 300 lowercase
- [ ] Numeric values are `#1A1814` (not colored)
- [ ] Font is Replica (with Helvetica Neue fallback)
- [ ] Chart lines use brand palette (green for operating, blue for forecasted)
- [ ] No card shadows or elevation effects
- [ ] 6-column grid alignment verified
- [ ] Timestamp and metadata use dim/ghost color hierarchy
