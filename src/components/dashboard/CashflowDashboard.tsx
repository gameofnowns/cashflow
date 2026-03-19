"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Helpers ────────────────────────────────────────────────

const EUR = (n: number | null | undefined) => {
  if (n == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  const f = abs.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? "- " : "") + "EUR " + f;
};

const SHORT = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000000) return sign + "EUR " + (abs / 1000000).toFixed(1) + "M";
  if (abs >= 1000) return sign + "EUR " + Math.round(abs / 1000) + "K";
  return EUR(n);
};

const shortMonth = (mk: string) => {
  const [y, mo] = mk.split("-");
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(mo) - 1] + " " + y.slice(2);
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
};

// ─── Types ──────────────────────────────────────────────────

interface MilestoneItem {
  projectName: string;
  jobNo: string | null;
  projectType: string;
  label: string | null;
  amount: number;
  expectedDate: string;
  status: string;
  trigger?: string;
}

interface MonthRaw {
  month: string;
  currentAr: number;
  currentArItems: MilestoneItem[];
  billableAr: number;
  billableArItems: MilestoneItem[];
  pipelinePhase3: number;
  pipelinePhase3Items: MilestoneItem[];
  ap: number;
  apItems: MilestoneItem[];
  cogsWon: number;
  cogsPhase3: number;
  vatReturn: number;
  overhead: number;
}

interface DashboardData {
  bankBalance: number;
  bankBalanceSource: string;
  months: MonthRaw[];
  pipeline: { totalOpportunities: number };
}

interface StatusData {
  dynamics: { connected: boolean; tokenValid: boolean; projectsSynced: number };
  clickup: { connected: boolean; projectsSynced: number };
  exact: { connected: boolean; tokenValid: boolean; arItems: { total: number } };
}

interface Toggles {
  currentAr: boolean;
  billableAr: boolean;
  phase3: boolean;
  ap: boolean;
  cogsWon: boolean;
  cogsPipeline: boolean;
  vat: boolean;
  overhead: boolean;
  weighted: boolean;
}

interface ComputedMonth {
  month: string;
  currentAr: number;
  billableAr: number;
  committed: number;
  ap: number;
  cogsWon: number;
  cogsPipeline: number;
  vat: number;
  overhead: number;
  inflow: number;
  outflow: number;
  net: number;
  _raw: MonthRaw;
}

const SERIES = [
  { id: "currentAr", label: "Current AR", color: "#82D780", type: "inflow" },
  { id: "billableAr", label: "Billable AR", color: "#0086D5", type: "inflow" },
  { id: "phase3", label: "Committed", color: "#D8E1EB", type: "inflow" },
  { id: "ap", label: "AP", color: "#C0392B", type: "outflow" },
  { id: "cogsWon", label: "COGS (Won)", color: "#887550", type: "outflow" },
  { id: "cogsPipeline", label: "COGS (Pipeline)", color: "#BD6A55", type: "outflow" },
  { id: "vat", label: "VAT Returns", color: "#8F9A8F", type: "inflow" },
  { id: "overhead", label: "Overhead", color: "#F7E5DF", type: "outflow" },
] as const;

// ─── Styles (inline object for NOWN branding) ───────────────

const S = {
  grid: "1px solid #1A1814",
  ghostGrid: "1px solid #C8C2B8",
  ink: "#1A1814",
  bg: "#EAE6DF",
  sub: "#6B6560",
  dim: "#A09890",
  ghost: "#C8C2B8",
  orange: "#FE6337",
  mono: "'SF Mono', 'Fira Code', Consolas, monospace",
} as const;

// ─── NOWN Logo SVG ──────────────────────────────────────────

function NownLogo() {
  return (
    <svg width="164" height="20" viewBox="0 0 328 41" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M65.4138 0H76.3161V24.2839C76.3161 31.1677 72.3342 37.047 65.8835 39.6833C59.4327 42.3195 52.4042 40.9378 47.4664 36.0712L39.752 28.4617L10.9023 0H26.3185L55.1682 28.4576L65.4096 38.5599V0H65.4138ZM317.098 0H328V24.2839C328 31.1677 324.018 37.047 317.567 39.6833C311.117 42.3195 304.088 40.9378 299.15 36.0712L291.436 28.4617L262.586 0V40.9993H251.684V0H278.002L306.852 28.4576L317.094 38.5599V0H317.098ZM158.077 0H147.175V24.2839C147.175 31.1677 151.157 37.047 157.607 39.6833C164.058 42.3195 171.087 40.9378 176.025 36.0712L183.739 28.4617L186.345 25.8911C186.914 32.0738 190.763 37.2561 196.703 39.6833C203.154 42.3195 210.182 40.9378 215.12 36.0712L222.834 28.4617L251.684 0H236.268L207.418 28.4576L197.177 38.5599V15.2067L212.589 0H197.172L168.323 28.4576L158.081 38.5599V0H158.077ZM133.55 9.40935H89.9408V31.59H133.55V9.40935ZM98.4574 0H125.029C135.724 0 144.448 8.60576 144.448 19.1549V21.8444C144.448 32.3936 135.724 40.9993 125.029 40.9993H98.4574C87.7629 40.9993 79.0386 32.3936 79.0386 21.8444V19.1549C79.0386 8.60576 87.7629 0 98.4574 0ZM0 0H10.9023V40.9993H0V0Z" fill="#1A1814" />
    </svg>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function CashflowDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bankInput, setBankInput] = useState("");
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Toggles>({
    currentAr: true, billableAr: true, phase3: true,
    ap: true, cogsWon: true, cogsPipeline: true,
    vat: true, overhead: true, weighted: false,
  });

  const chartRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const toggle = (id: keyof Toggles) => setToggles((t) => ({ ...t, [id]: !t[id] }));

  const applyPreset = (name: string) => {
    const all = (v: boolean): Toggles => ({
      currentAr: v, billableAr: v, phase3: v, ap: v,
      cogsWon: v, cogsPipeline: v, vat: v, overhead: v, weighted: false,
    });
    switch (name) {
      case "conservative": setToggles({ ...all(true), phase3: false, cogsPipeline: false }); break;
      case "likely": setToggles(all(true)); break;
      case "full": setToggles(all(true)); break;
      case "weighted": setToggles({ ...all(true), weighted: true }); break;
    }
  };

  const loadData = useCallback(async () => {
    const params = bankInput ? `?bankBalance=${encodeURIComponent(bankInput)}` : "";
    try {
      const res = await fetch(`/api/dashboard/cash-position${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setError(null);
      if (!bankInput && json.bankBalance > 0) setBankInput(String(Math.round(json.bankBalance)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [bankInput]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/status");
      if (res.ok) {
        const s = await res.json();
        if (!s.error) setStatus(s);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadData(); loadStatus(); }, [loadData, loadStatus]);

  const runSync = async (provider: string, btn: HTMLButtonElement) => {
    btn.textContent = "...";
    btn.disabled = true;
    try {
      const res = await fetch(`/api/sync/${provider}`, { method: "POST" });
      const d = await res.json();
      btn.textContent = d.error ? "ERR" : "OK";
      setTimeout(() => { btn.textContent = "Sync"; btn.disabled = false; loadStatus(); loadData(); }, 1000);
    } catch {
      btn.textContent = "ERR";
      setTimeout(() => { btn.textContent = "Sync"; btn.disabled = false; }, 2000);
    }
  };

  // ─── Compute ────────────────────────────────────────────

  const computed: ComputedMonth[] = data ? data.months.map((m) => {
    const w = toggles.weighted;
    const cAr = toggles.currentAr ? m.currentAr : 0;
    const bAr = toggles.billableAr ? m.billableAr : 0;
    const p3 = toggles.phase3 ? (w ? m.pipelinePhase3 * 0.9 : m.pipelinePhase3) : 0;
    const vat = toggles.vat ? m.vatReturn : 0;
    const inflow = cAr + bAr + p3 + vat;
    const ap = toggles.ap ? (m.ap || 0) : 0;
    const cW = toggles.cogsWon ? m.cogsWon : 0;
    let cP = 0;
    if (toggles.cogsPipeline && toggles.phase3) cP = w ? m.cogsPhase3 * 0.9 : m.cogsPhase3;
    const oh = toggles.overhead ? m.overhead : 0;
    const outflow = ap + cW + cP + oh;
    return { month: m.month, currentAr: cAr, billableAr: bAr, committed: p3, ap, cogsWon: cW, cogsPipeline: cP, vat, overhead: oh, inflow, outflow, net: inflow - outflow, _raw: m };
  }) : [];

  // Cash by month
  let runningCash = data?.bankBalance || 0;
  const cashByMonth = computed.map((m) => { runningCash += m.net; return runningCash; });

  // KPI totals
  const totIn = computed.reduce((s, m) => s + m.inflow, 0);
  const totOut = computed.reduce((s, m) => s + m.outflow, 0);
  const m3 = computed.slice(0, 3).reduce((s, m) => s + m.net, 0);
  const endPos = (data?.bankBalance || 0) + computed.reduce((s, m) => s + m.net, 0);
  const bank = data?.bankBalance || 0;

  // ─── Chart rendering via DOM (imperative for precise alignment) ──

  useEffect(() => {
    if (!data || !chartRef.current || !tableRef.current || computed.length === 0) return;
    const el = chartRef.current;
    el.innerHTML = "";
    const H = 400;
    const W = el.offsetWidth || 800;

    let maxBarUp = 0, maxBarDown = 0;
    computed.forEach((m) => { maxBarUp = Math.max(maxBarUp, m.inflow); maxBarDown = Math.max(maxBarDown, m.outflow); });
    let cash = bank, cashMax = cash, cashMin = cash;
    computed.forEach((m) => { cash += m.net; cashMax = Math.max(cashMax, cash); cashMin = Math.min(cashMin, cash); });

    const maxAbove = Math.max(maxBarUp, cashMax, 0) * 1.1;
    const maxBelow = Math.max(maxBarDown, cashMin < 0 ? Math.abs(cashMin) : 0) * 1.1;
    const minAbove = Math.max(maxAbove, (maxAbove + maxBelow) * 0.15);
    const minBelow = Math.max(maxBelow, (maxAbove + maxBelow) * 0.15);
    const totalRange = minAbove + minBelow || 1;
    const zeroY = (minAbove / totalRange) * H;
    const scale = H / totalRange;

    const maxTick = Math.max(minAbove, minBelow);
    const rawStep = maxTick / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => maxTick / s <= 6) || mag * 10;

    for (let v = niceStep; v <= minAbove; v += niceStep) {
      const y = zeroY - v * scale; if (y < 5) break;
      el.innerHTML += `<div style="position:absolute;right:calc(100% + 8px);top:${y}px;font-size:7.5px;font-weight:300;color:${S.dim};font-family:${S.mono};letter-spacing:0.5px;transform:translateY(-50%);white-space:nowrap">${SHORT(v)}</div><div style="position:absolute;left:0;right:0;top:${y}px;height:1px;background:${S.ghost}"></div>`;
    }
    for (let v = niceStep; v <= minBelow; v += niceStep) {
      const y = zeroY + v * scale; if (y > H - 5) break;
      el.innerHTML += `<div style="position:absolute;right:calc(100% + 8px);top:${y}px;font-size:7.5px;font-weight:300;color:${S.dim};font-family:${S.mono};letter-spacing:0.5px;transform:translateY(-50%);white-space:nowrap">${SHORT(-v)}</div><div style="position:absolute;left:0;right:0;top:${y}px;height:1px;background:${S.ghost}"></div>`;
    }
    el.innerHTML += `<div style="position:absolute;left:0;right:0;top:${zeroY}px;height:1px;background:${S.dim};opacity:0.6"></div><div style="position:absolute;right:calc(100% + 8px);top:${zeroY}px;font-size:7.5px;font-weight:700;color:${S.dim};font-family:${S.mono};transform:translateY(-50%)">0</div>`;

    // Read table column positions
    const thCells = tableRef.current.querySelectorAll("thead th");
    const n = computed.length;
    const chartRect = el.getBoundingClientRect();
    const colCenters: { x: number; w: number }[] = [];

    if (thCells.length >= n + 1) {
      for (let i = 1; i <= n; i++) {
        const r = thCells[i].getBoundingClientRect();
        colCenters.push({ x: r.left + r.width / 2 - chartRect.left, w: r.width });
      }
    } else {
      const step = W / (n + 1);
      for (let i = 0; i < n; i++) colCenters.push({ x: (i + 0.5) * step, w: step });
    }

    const barW = Math.min(40, (colCenters[0]?.w || 60) - 8);

    computed.forEach((m, i) => {
      const x = colCenters[i].x;
      [{ val: m.currentAr, c: "#82D780" }, { val: m.billableAr, c: "#0086D5" }, { val: m.committed, c: "#D8E1EB" }, { val: m.vat, c: "#8F9A8F" }].filter((p) => p.val > 0).reduce((cum, p) => {
        const h = p.val * scale;
        el.innerHTML += `<div style="position:absolute;left:${x - barW / 2}px;top:${zeroY - cum - h}px;width:${barW}px;height:${h}px;background:${p.c};border:${S.grid};cursor:pointer;transition:opacity 150ms" title="${EUR(p.val)}"></div>`;
        return cum + h;
      }, 0);
      [{ val: m.ap, c: "#C0392B" }, { val: m.cogsWon, c: "#887550" }, { val: m.cogsPipeline, c: "#BD6A55" }, { val: m.overhead, c: "#F7E5DF" }].filter((p) => p.val > 0).reduce((cum, p) => {
        const h = p.val * scale;
        el.innerHTML += `<div style="position:absolute;left:${x - barW / 2}px;top:${zeroY + cum}px;width:${barW}px;height:${h}px;background:${p.c};border:${S.grid};cursor:pointer;transition:opacity 150ms" title="${EUR(-p.val)}"></div>`;
        return cum + h;
      }, 0);
    });

    cash = bank;
    const pts = computed.map((m, i) => { cash += m.net; return { x: colCenters[i].x, y: zeroY - cash * scale, cash }; });
    const startY = zeroY - bank * scale;
    const startX = colCenters[0].x - (colCenters[0].w / 2);
    let d = `M ${startX} ${startY}`;
    pts.forEach((p) => { d += ` L ${p.x} ${p.y}`; });
    let svg = `<svg style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${S.ink}" stroke-width="3.5"/>`;
    pts.forEach((p) => { svg += `<circle cx="${p.x}" cy="${p.y}" r="5" fill="${S.ink}" stroke="${S.bg}" stroke-width="2"/>`; });
    svg += `</svg>`;
    el.innerHTML += svg;
    el.innerHTML += `<div style="position:absolute;left:${startX - 4}px;top:${startY - 16}px;font-size:9px;font-weight:700;font-family:${S.mono};letter-spacing:1px">${SHORT(bank)}</div>`;
    const lp = pts[pts.length - 1];
    el.innerHTML += `<div style="position:absolute;left:${lp.x + 6}px;top:${lp.y - 6}px;font-size:9px;font-weight:700;font-family:${S.mono};letter-spacing:1px">${SHORT(lp.cash)}</div>`;
  }, [data, computed, bank, toggles]);

  // ─── P&L Rows ─────────────────────────────────────────────

  const pnlRows = [
    { label: "Current AR", fn: (m: ComputedMonth) => m.currentAr, fc: false },
    { label: "Billable AR", fn: (m: ComputedMonth) => m.billableAr, fc: false },
    { label: "Committed", fn: (m: ComputedMonth) => m.committed, fc: true },
    { label: "Total Inflow", fn: (m: ComputedMonth) => m.inflow, sep: true },
    { label: "AP", fn: (m: ComputedMonth) => -m.ap },
    { label: "COGS", fn: (m: ComputedMonth) => -(m.cogsWon + m.cogsPipeline) },
    { label: "VAT Returns", fn: (m: ComputedMonth) => m.vat },
    { label: "Overhead", fn: (m: ComputedMonth) => -m.overhead },
    { label: "Total Outflow", fn: (m: ComputedMonth) => -m.outflow, sep: true },
    { label: "Net", fn: (m: ComputedMonth) => m.net, sep: true },
  ];

  const v = (n: number, fc?: boolean) => n > 0 ? <span className={fc ? "text-[#BD6A55]" : ""}>{EUR(n)}</span> : n < 0 ? <span>{EUR(n)}</span> : <span style={{ color: S.ghost }}>—</span>;

  // ─── Detail Drill-Down ────────────────────────────────────

  const expandedData = expandedMonth ? data?.months.find((m) => m.month === expandedMonth) : null;
  const totalItems = (items: MilestoneItem[]) => items.reduce((s, i) => s + i.amount, 0);

  const pctBar = (pct: number) => (
    <div style={{ display: "flex", height: 12, border: S.grid, width: "100%", minWidth: 80 }}>
      <div style={{ background: "#82D780", width: `${pct}%`, height: "100%" }} />
      <div style={{ background: "#0086D5", width: `${100 - pct}%`, height: "100%" }} />
    </div>
  );

  // ─── Render ───────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: S.grid }}>
        <div style={{ padding: "8px 18px", borderRight: S.grid, display: "flex", alignItems: "center" }}>
          <NownLogo />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: "auto", padding: "8px 18px" }}>
          <span style={{ fontSize: 7, fontWeight: 300, letterSpacing: 1.5, color: S.dim }}>
            last updated: {new Date().toLocaleString("nl-NL").toLowerCase()}
          </span>
          <button onClick={() => { loadData(); loadStatus(); }} style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 2, padding: "8px 16px", background: S.ink, color: S.bg, border: "none", cursor: "pointer" }}>
            Refresh
          </button>
        </div>
      </div>

      {/* Hero bar */}
      <div style={{ display: "flex", alignItems: "center", borderBottom: S.grid }}>
        <div style={{ padding: "12px 18px", fontSize: 28, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 6, lineHeight: 0.7, borderRight: S.grid }}>
          CASHFLOWS
        </div>
        <div style={{ display: "flex", alignItems: "center", flex: 1, gap: 0 }}>
          {[
            { key: "dynamics", ok: status?.dynamics.connected && status?.dynamics.tokenValid, detail: status?.dynamics.connected ? `${status.dynamics.projectsSynced} opps` : "—" },
            { key: "clickup", ok: status?.clickup.connected && (status?.clickup.projectsSynced || 0) > 0, detail: status?.clickup.connected ? `${status.clickup.projectsSynced} projects` : "—" },
            { key: "exact", ok: status?.exact.connected && status?.exact.tokenValid, detail: status?.exact.connected ? `AR ${status.exact.arItems.total}` : "—" },
          ].map((s) => (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRight: `1px solid ${S.ghost}` }}>
              <span style={{ width: 6, height: 6, background: s.ok ? "#82D780" : "#BD6A55", display: "inline-block" }} />
              <span style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2, color: S.sub }}>{s.key}</span>
              <span style={{ fontSize: 6.5, fontWeight: 300, color: S.dim }}>{s.detail}</span>
              <button onClick={(e) => runSync(s.key, e.currentTarget)} style={{ fontFamily: "inherit", fontSize: 6.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "2px 6px", background: S.ink, color: S.bg, border: "none", cursor: "pointer" }}>
                Sync
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* KPIs */}
      {error ? (
        <div style={{ padding: "20px 18px", borderBottom: S.grid }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: S.orange }}>{error}</span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", borderBottom: S.grid }}>
          {[
            { label: "Opening Balance", value: SHORT(bank), caption: data?.bankBalanceSource === "manual" ? "manual entry" : "from exact online" },
            { label: "3-Month Position", value: SHORT(bank + m3), caption: "cash in 3 months" },
            { label: "12-Month End", value: SHORT(endPos), caption: "projected position" },
            { label: "Total Inflows", value: SHORT(totIn), caption: "active series" },
            { label: "Total Outflows", value: SHORT(totOut), caption: "active series" },
            { label: "12M Net", value: SHORT(totIn - totOut), caption: "inflows - outflows" },
          ].map((kpi, i) => (
            <div key={i} style={{ padding: "14px 18px", borderRight: i < 5 ? S.grid : "none" }}>
              <div style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3.5, color: S.sub, marginBottom: 6 }}>{kpi.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2, lineHeight: 0.75, fontFamily: S.mono }}>{kpi.value}</div>
              <div style={{ fontSize: 7, fontWeight: 300, letterSpacing: 1.5, color: S.dim, marginTop: 6 }}>{kpi.caption}</div>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div style={{ padding: "10px 18px", borderBottom: S.grid, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3.5, color: S.sub, marginRight: 4 }}>Balance</span>
        <input type="text" value={bankInput} onChange={(e) => setBankInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadData()} style={{ fontFamily: S.mono, fontSize: 11, fontWeight: 700, padding: "4px 8px", border: S.grid, background: S.bg, color: S.ink, width: 110, letterSpacing: 1 }} />
        <button onClick={() => loadData()} style={{ fontFamily: "inherit", fontSize: 7, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "4px 8px", border: S.grid, background: "transparent", color: S.ink, cursor: "pointer" }}>Set</button>
        <div style={{ width: 1, height: 24, background: S.ghost, margin: "0 6px" }} />
        <span style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3.5, color: S.sub, marginRight: 4 }}>Presets</span>
        {["conservative", "likely", "full", "weighted"].map((p) => (
          <button key={p} onClick={() => applyPreset(p)} style={{ fontFamily: "inherit", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "5px 10px", border: S.grid, background: "transparent", color: S.ink, cursor: "pointer" }}>{p === "full" ? "Full Forecast" : p}</button>
        ))}
      </div>

      {/* Toggles */}
      <div style={{ padding: "10px 18px", borderBottom: S.grid, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3.5, color: S.sub, marginRight: 4 }}>Inflows</span>
        {SERIES.filter((s) => s.type === "inflow" && s.id !== "vat").map((s) => (
          <button key={s.id} onClick={() => toggle(s.id as keyof Toggles)} style={{ fontFamily: "inherit", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "5px 10px", border: S.grid, background: toggles[s.id as keyof Toggles] ? S.ink : "transparent", color: toggles[s.id as keyof Toggles] ? S.bg : S.ink, cursor: "pointer" }}>
            <span style={{ display: "inline-block", width: 6, height: 6, background: s.color, marginRight: 4, verticalAlign: "middle" }} />{s.label}
          </button>
        ))}
        <div style={{ width: 1, height: 24, background: S.ghost, margin: "0 6px" }} />
        <span style={{ fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3.5, color: S.sub, marginRight: 4 }}>Outflows</span>
        {SERIES.filter((s) => s.type === "outflow").map((s) => (
          <button key={s.id} onClick={() => toggle(s.id as keyof Toggles)} style={{ fontFamily: "inherit", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "5px 10px", border: S.grid, background: toggles[s.id as keyof Toggles] ? S.ink : "transparent", color: toggles[s.id as keyof Toggles] ? S.bg : S.ink, cursor: "pointer" }}>
            <span style={{ display: "inline-block", width: 6, height: 6, background: s.color, marginRight: 4, verticalAlign: "middle" }} />{s.label}
          </button>
        ))}
        {(() => { const vatS = SERIES.find((s) => s.id === "vat")!; return (
          <button onClick={() => toggle("vat")} style={{ fontFamily: "inherit", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "5px 10px", border: S.grid, background: toggles.vat ? S.ink : "transparent", color: toggles.vat ? S.bg : S.ink, cursor: "pointer" }}>
            <span style={{ display: "inline-block", width: 6, height: 6, background: vatS.color, marginRight: 4, verticalAlign: "middle" }} />{vatS.label}
          </button>
        ); })()}
        <div style={{ width: 1, height: 24, background: S.ghost, margin: "0 6px" }} />
        <button onClick={() => toggle("weighted")} style={{ fontFamily: "inherit", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "5px 10px", border: `1px solid ${S.orange}`, background: toggles.weighted ? S.ink : "transparent", color: toggles.weighted ? S.bg : S.ink, cursor: "pointer" }}>Weighted</button>
      </div>

      {/* Chart */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div ref={chartRef} style={{ position: "relative", height: 400, marginLeft: 120, borderLeft: S.grid, borderBottom: S.grid }} />
        {/* Legend — top right */}
        <div style={{ position: "absolute", top: 10, right: 18, display: "flex", flexDirection: "column", gap: 4, padding: "8px 12px", border: S.grid, background: S.bg }}>
          {SERIES.filter((s) => toggles[s.id as keyof Toggles]).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 7, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, color: S.sub }}>
              <div style={{ width: 8, height: 8, background: s.color, border: S.grid }} />{s.label}
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 7, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, color: S.sub }}>
            <div style={{ width: 8, height: 8, background: S.ink }} />Cash Position
          </div>
        </div>
      </div>

      {/* P&L Table */}
      <div style={{ overflowX: "auto", borderBottom: S.grid }}>
        <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, tableLayout: "fixed", minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", width: 120, minWidth: 120, maxWidth: 120, padding: "8px 8px", fontWeight: 700, fontSize: 7, textTransform: "uppercase", letterSpacing: 2, background: S.bg, color: S.sub, borderRight: S.grid, borderBottom: S.grid, position: "sticky", left: 0, zIndex: 2 }}></th>
              {computed.map((m) => (
                <th key={m.month} onClick={() => setExpandedMonth(expandedMonth === m.month ? null : m.month)} style={{ textAlign: "right", padding: "8px 8px", fontWeight: 700, fontSize: 7, textTransform: "uppercase", letterSpacing: 2, background: expandedMonth === m.month ? S.orange : S.ink, color: expandedMonth === m.month ? S.ink : S.bg, borderRight: S.grid, borderBottom: S.grid, cursor: "pointer", whiteSpace: "nowrap", transition: "background 150ms" }}>{shortMonth(m.month)}</th>
              ))}
              <th style={{ textAlign: "right", padding: "8px 8px", fontWeight: 700, fontSize: 7, textTransform: "uppercase", letterSpacing: 2, background: S.ink, color: S.bg, borderBottom: S.grid, whiteSpace: "nowrap" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {pnlRows.map((row, ri) => (
              <tr key={ri} style={{ borderBottom: row.sep ? S.grid : S.ghostGrid }}>
                <td style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700, letterSpacing: 2, fontSize: 10, position: "sticky", left: 0, background: S.bg, zIndex: 1, borderRight: S.grid }}>{row.label}</td>
                {computed.map((m, i) => {
                  const val = row.fn(m);
                  return <td key={i} style={{ textAlign: "right", padding: "6px 8px", fontFamily: S.mono, fontWeight: 700, letterSpacing: 1, fontSize: 9, borderRight: S.grid, color: row.fc ? "#BD6A55" : S.ink, whiteSpace: "nowrap" }}>{v(val, row.fc)}</td>;
                })}
                <td style={{ textAlign: "right", padding: "6px 8px", fontFamily: S.mono, fontWeight: 700, letterSpacing: 1, fontSize: 9, whiteSpace: "nowrap" }}>{v(computed.reduce((s, m) => s + row.fn(m), 0), row.fc)}</td>
              </tr>
            ))}
            {/* Cash Position row */}
            <tr style={{ borderTop: `2px solid ${S.ink}` }}>
              <td style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700, letterSpacing: 2, fontSize: 10, position: "sticky", left: 0, zIndex: 1, background: S.ink, color: S.bg, borderRight: S.grid }}>Cash Position</td>
              {cashByMonth.map((c, i) => (
                <td key={i} style={{ textAlign: "right", padding: "6px 8px", fontFamily: S.mono, fontWeight: 700, letterSpacing: 1, fontSize: 10, borderRight: S.grid, whiteSpace: "nowrap", background: c < 0 ? S.ink : "transparent", color: c < 0 ? S.orange : S.ink }}>{EUR(c)}</td>
              ))}
              <td style={{ textAlign: "right", padding: "6px 8px", fontFamily: S.mono, fontWeight: 700, letterSpacing: 1, fontSize: 10, whiteSpace: "nowrap", background: cashByMonth[cashByMonth.length - 1] < 0 ? S.ink : "transparent", color: cashByMonth[cashByMonth.length - 1] < 0 ? S.orange : S.ink }}>{EUR(cashByMonth[cashByMonth.length - 1])}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Detail Drill-Down */}
      {expandedMonth && expandedData && (
        <div style={{ borderBottom: S.grid }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: S.grid }}>
            <div style={{ fontSize: 28, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 6, lineHeight: 0.7 }}>{shortMonth(expandedMonth)} BREAKDOWN</div>
            <button onClick={() => setExpandedMonth(null)} style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2, padding: "8px 16px", background: S.ink, color: S.bg, border: "none", cursor: "pointer" }}>Close</button>
          </div>

          {/* Current AR */}
          {expandedData.currentArItems.length > 0 && (
            <>
              <div style={{ padding: "8px 18px", fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3, color: S.sub, borderBottom: S.ghostGrid }}>Current AR — {expandedData.currentArItems.length} invoices · {EUR(totalItems(expandedData.currentArItems))}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead><tr>{["Customer", "Invoice", "Job No.", "Due Date", "Status", "Amount"].map((h, i) => <th key={i} style={{ padding: "8px 12px", fontWeight: 700, fontSize: 7, textTransform: "uppercase" as const, letterSpacing: 2.5, color: S.bg, background: S.ink, borderRight: i < 5 ? `1px solid ${S.sub}` : "none", borderBottom: S.grid, textAlign: h === "Amount" ? "right" : "left" }}>{h}</th>)}</tr></thead>
                <tbody>{expandedData.currentArItems.map((item, i) => <tr key={i}><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectName}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.label}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.jobNo || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{fmtDate(item.expectedDate)}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.status}</td><td style={{ padding: "6px 12px", borderBottom: S.grid, fontWeight: 700, fontFamily: S.mono, textAlign: "right" }}>{EUR(item.amount)}</td></tr>)}</tbody>
              </table>
            </>
          )}

          {/* Billable AR */}
          {expandedData.billableArItems.length > 0 && (
            <>
              <div style={{ padding: "8px 18px", fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3, color: S.sub, borderBottom: S.ghostGrid, borderTop: S.grid }}>Billable AR — {expandedData.billableArItems.length} milestones · {EUR(totalItems(expandedData.billableArItems))}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead><tr>{["Project", "Type", "Job No.", "Milestone", "Status", "Progress", "Amount"].map((h, i) => <th key={i} style={{ padding: "8px 12px", fontWeight: 700, fontSize: 7, textTransform: "uppercase" as const, letterSpacing: 2.5, color: S.bg, background: S.ink, borderRight: i < 6 ? `1px solid ${S.sub}` : "none", borderBottom: S.grid, textAlign: h === "Amount" ? "right" : "left", width: h === "Progress" ? 120 : undefined }}>{h}</th>)}</tr></thead>
                <tbody>{expandedData.billableArItems.map((item, i) => {
                  const pct = item.status === "received" ? 100 : item.status === "invoiced" ? 50 : 0;
                  return <tr key={i}><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectName}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectType}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.jobNo || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.label || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.status}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid }}>{pctBar(pct)}<div style={{ fontSize: 7, fontWeight: 300, color: S.dim, marginTop: 2 }}>{pct}% received</div></td><td style={{ padding: "6px 12px", borderBottom: S.grid, fontWeight: 700, fontFamily: S.mono, textAlign: "right" }}>{EUR(item.amount)}</td></tr>;
                })}</tbody>
              </table>
            </>
          )}

          {/* Committed Pipeline */}
          {expandedData.pipelinePhase3Items.length > 0 && (
            <>
              <div style={{ padding: "8px 18px", fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3, color: S.sub, borderBottom: S.ghostGrid, borderTop: S.grid }}>Committed Pipeline — {expandedData.pipelinePhase3Items.length} milestones · {EUR(totalItems(expandedData.pipelinePhase3Items))}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead><tr>{["Opportunity", "Type", "Job No.", "Milestone", "Trigger", "Progress", "Amount"].map((h, i) => <th key={i} style={{ padding: "8px 12px", fontWeight: 700, fontSize: 7, textTransform: "uppercase" as const, letterSpacing: 2.5, color: S.bg, background: S.ink, borderRight: i < 6 ? `1px solid ${S.sub}` : "none", borderBottom: S.grid, textAlign: h === "Amount" ? "right" : "left", width: h === "Progress" ? 120 : undefined }}>{h}</th>)}</tr></thead>
                <tbody>{expandedData.pipelinePhase3Items.map((item, i) => <tr key={i}><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectName}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectType}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.jobNo || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.label || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.trigger || "—"}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid }}>{pctBar(0)}<div style={{ fontSize: 7, fontWeight: 300, color: S.dim, marginTop: 2 }}>0% received</div></td><td style={{ padding: "6px 12px", borderBottom: S.grid, fontWeight: 700, fontFamily: S.mono, textAlign: "right" }}>{EUR(item.amount)}</td></tr>)}</tbody>
              </table>
            </>
          )}

          {/* AP */}
          {expandedData.apItems.length > 0 && (
            <>
              <div style={{ padding: "8px 18px", fontSize: 7.5, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 3, color: S.sub, borderBottom: S.ghostGrid, borderTop: S.grid }}>Accounts Payable — {expandedData.apItems.length} items · {EUR(totalItems(expandedData.apItems))}</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead><tr>{["Vendor", "Invoice", "Due Date", "Amount"].map((h, i) => <th key={i} style={{ padding: "8px 12px", fontWeight: 700, fontSize: 7, textTransform: "uppercase" as const, letterSpacing: 2.5, color: S.bg, background: S.ink, borderRight: i < 3 ? `1px solid ${S.sub}` : "none", borderBottom: S.grid, textAlign: h === "Amount" ? "right" : "left" }}>{h}</th>)}</tr></thead>
                <tbody>{expandedData.apItems.map((item, i) => <tr key={i}><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.projectName}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{item.label}</td><td style={{ padding: "6px 12px", borderRight: S.grid, borderBottom: S.grid, fontWeight: 700 }}>{fmtDate(item.expectedDate)}</td><td style={{ padding: "6px 12px", borderBottom: S.grid, fontWeight: 700, fontFamily: S.mono, textAlign: "right" }}>{EUR(item.amount)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
