"use client";

import { useEffect, useState, useCallback } from "react";

const S = {
  bg: "#EAE6DF", ink: "#1A1814", sub: "#6B6560", dim: "#A09890",
  ghost: "#C8C2B8", orange: "#FE6337", green: "#82D780", terracotta: "#BD6A55",
  grid: "1px solid #1A1814",
  font: "'Replica','Helvetica Neue',Arial,sans-serif",
};

function NownLogo({ width = 200 }: { width?: number }) {
  return (
    <svg width={width} height={width * 0.13} viewBox="0 0 328 41" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M65.4138 0H76.3161V24.2839C76.3161 31.1677 72.3342 37.047 65.8835 39.6833C59.4327 42.3195 52.4042 40.9378 47.4664 36.0712L39.752 28.4617L10.9023 0H26.3185L55.1682 28.4576L65.4096 38.5599V0H65.4138ZM317.098 0H328V24.2839C328 31.1677 324.018 37.047 317.567 39.6833C311.117 42.3195 304.088 40.9378 299.15 36.0712L291.436 28.4617L262.586 0V40.9993H251.684V0H278.002L306.852 28.4576L317.094 38.5599V0H317.098ZM158.077 0H147.175V24.2839C147.175 31.1677 151.157 37.047 157.607 39.6833C164.058 42.3195 171.087 40.9378 176.025 36.0712L183.739 28.4617L186.345 25.8911C186.914 32.0738 190.763 37.2561 196.703 39.6833C203.154 42.3195 210.182 40.9378 215.12 36.0712L222.834 28.4617L251.684 0H236.268L207.418 28.4576L197.177 38.5599V15.2067L212.589 0H197.172L168.323 28.4576L158.081 38.5599V0H158.077ZM133.55 9.40935H89.9408V31.59H133.55V9.40935ZM98.4574 0H125.029C135.724 0 144.448 8.60576 144.448 19.1549V21.8444C144.448 32.3936 135.724 40.9993 125.029 40.9993H98.4574C87.7629 40.9993 79.0386 32.3936 79.0386 21.8444V19.1549C79.0386 8.60576 87.7629 0 98.4574 0ZM0 0H10.9023V40.9993H0V0Z" fill="#1A1814" />
    </svg>
  );
}

interface StatusData {
  dynamics: { connected: boolean; tokenValid: boolean; projectsSynced: number };
  clickup: { connected: boolean; projectsSynced: number; milestones: number };
  exact: { connected: boolean; tokenValid: boolean; arItems?: { total: number }; bankBalance?: number };
}

export default function Home() {
  const [phase, setPhase] = useState<"checking" | "login" | "setup" | "dashboard">("checking");
  const [status, setStatus] = useState<StatusData | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/status", { credentials: "include" });
      if (res.status === 401) {
        setPhase("login");
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        const dOk = data.dynamics?.connected && data.dynamics?.tokenValid;
        const cOk = data.clickup?.connected && (data.clickup?.projectsSynced || 0) > 0;
        const eOk = data.exact?.connected && data.exact?.tokenValid;
        if (dOk && cOk && eOk) {
          setPhase("dashboard");
        } else {
          setPhase("setup");
        }
      } else {
        setPhase("dashboard"); // No auth required
      }
    } catch {
      setPhase("dashboard"); // Network error — try anyway
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  // Listen for OAuth callback (Exact/Dynamics redirect back to this page)
  useEffect(() => {
    if (phase === "setup") {
      const interval = setInterval(async () => {
        try {
          const res = await fetch("/api/dashboard/status", { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            setStatus(data);
            const dOk = data.dynamics?.connected && data.dynamics?.tokenValid;
            const cOk = data.clickup?.connected && (data.clickup?.projectsSynced || 0) > 0;
            const eOk = data.exact?.connected && data.exact?.tokenValid;
            if (dOk && cOk && eOk) {
              setPhase("dashboard");
            }
          }
        } catch { /* silent */ }
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [phase]);

  if (phase === "checking") return <LoadingScreen />;
  if (phase === "login") return <LoginScreen onSuccess={checkAuth} />;
  if (phase === "setup") return <SetupScreen status={status} onRefresh={checkAuth} onSkip={() => setPhase("dashboard")} />;
  return <DashboardFrame />;
}

// ─── Loading Screen ─────────────────────────────────────────

function LoadingScreen() {
  return (
    <div style={{ background: S.bg, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: S.font }}>
      <NownLogo />
    </div>
  );
}

// ─── Login Screen ───────────────────────────────────────────

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!pw.trim()) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
        credentials: "include",
      });
      if (res.ok) {
        onSuccess();
      } else {
        setError("incorrect password");
      }
    } catch {
      setError("connection error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: S.bg, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: S.font }}>
      <div style={{ textAlign: "center", width: 340 }}>
        <div style={{ marginBottom: 32 }}><NownLogo /></div>
        <div style={{ fontSize: 28, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 6, marginBottom: 8 }}>CASHFLOWS</div>
        <div style={{ fontSize: 9, fontWeight: 300, color: S.dim, letterSpacing: 0.3, marginBottom: 32 }}>enter password to continue</div>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="password" autoFocus
          style={{ width: "100%", padding: "12px 16px", border: S.grid, background: "transparent", fontSize: 11, fontWeight: 700, letterSpacing: 1, textAlign: "center", marginBottom: 12, fontFamily: S.font, outline: "none" }} />
        <button onClick={submit} disabled={loading}
          style={{ width: "100%", padding: 12, background: S.ink, color: S.bg, border: "none", fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2, cursor: loading ? "wait" : "pointer", fontFamily: S.font }}
          onMouseEnter={(e) => { if (!loading) (e.target as HTMLElement).style.background = S.orange; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = S.ink; }}>
          {loading ? "..." : "Sign In"}
        </button>
        {error && <div style={{ fontSize: 9, color: S.terracotta, marginTop: 10, fontWeight: 700 }}>{error}</div>}
        <div style={{ fontSize: 7, color: S.ghost, marginTop: 32, letterSpacing: 1 }}>NOWN B.V. — CASH POSITION DASHBOARD</div>
      </div>
    </div>
  );
}

// ─── Setup Screen ───────────────────────────────────────────

function SetupScreen({ status, onRefresh, onSkip }: { status: StatusData | null; onRefresh: () => void; onSkip: () => void }) {
  const [syncing, setSyncing] = useState<string | null>(null);

  const dOk = status?.dynamics?.connected && status?.dynamics?.tokenValid;
  const cOk = status?.clickup?.connected && (status?.clickup?.projectsSynced || 0) > 0;
  const eOk = status?.exact?.connected && status?.exact?.tokenValid;
  const connectedCount = [dOk, cOk, eOk].filter(Boolean).length;

  const syncClickUp = async () => {
    setSyncing("clickup");
    try { await fetch("/api/sync/clickup", { method: "POST", credentials: "include" }); } catch { /* */ }
    setTimeout(() => { setSyncing(null); onRefresh(); }, 2000);
  };

  return (
    <div style={{ background: S.bg, minHeight: "100vh", fontFamily: S.font, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "10px 18px", borderBottom: S.grid, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <NownLogo width={140} />
        <button onClick={onSkip} style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "6px 14px", border: S.grid, background: "transparent", color: S.dim, cursor: "pointer", fontFamily: S.font }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = S.orange; (e.target as HTMLElement).style.borderColor = S.orange; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = S.dim; (e.target as HTMLElement).style.borderColor = S.ink; }}>
          Skip to Dashboard →
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 520, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 6, marginBottom: 8 }}>CONNECT</div>
          <div style={{ fontSize: 9, fontWeight: 300, color: S.dim, letterSpacing: 0.3, marginBottom: 32 }}>
            {connectedCount}/3 data sources connected — connect all three to see your full cash position
          </div>

          {/* Progress bar */}
          <div style={{ height: 3, background: S.ghost, marginBottom: 32, position: "relative" }}>
            <div style={{ height: "100%", background: S.green, width: `${(connectedCount / 3) * 100}%`, transition: "width 300ms ease" }} />
          </div>

          {/* Three cards */}
          <div style={{ display: "flex", gap: 0 }}>
            {/* Exact Online */}
            <div style={{ flex: 1, padding: "20px 18px", border: S.grid, borderRight: "none", textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, background: eOk ? S.green : S.terracotta }} />
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2 }}>Exact Online</div>
              </div>
              <div style={{ fontSize: 8, color: S.dim, marginBottom: 12, lineHeight: 1.5 }}>
                {eOk ? `Connected — Bank EUR ${Math.round((status?.exact?.bankBalance || 0) / 1000)}K` : "AR, AP, bank balance"}
              </div>
              {eOk ? (
                <div style={{ fontSize: 8, fontWeight: 700, color: S.green, letterSpacing: 1 }}>CONNECTED</div>
              ) : (
                <a href="/api/auth/exact" /* same tab — OAuth redirects back to / */
                  style={{ display: "inline-block", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "8px 16px", background: S.ink, color: S.bg, textDecoration: "none", cursor: "pointer", fontFamily: S.font }}>
                  Connect Exact
                </a>
              )}
            </div>

            {/* Dynamics 365 */}
            <div style={{ flex: 1, padding: "20px 18px", border: S.grid, borderRight: "none", textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, background: dOk ? S.green : S.terracotta }} />
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2 }}>Dynamics 365</div>
              </div>
              <div style={{ fontSize: 8, color: S.dim, marginBottom: 12, lineHeight: 1.5 }}>
                {dOk ? `Connected — ${status?.dynamics?.projectsSynced || 0} pipeline opps` : "Quotes, pipeline, payment terms"}
              </div>
              {dOk ? (
                <div style={{ fontSize: 8, fontWeight: 700, color: S.green, letterSpacing: 1 }}>CONNECTED</div>
              ) : (
                <a href="/api/auth/dynamics" /* same tab — OAuth redirects back to / */
                  style={{ display: "inline-block", fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "8px 16px", background: S.ink, color: S.bg, textDecoration: "none", cursor: "pointer", fontFamily: S.font }}>
                  Connect Dynamics
                </a>
              )}
            </div>

            {/* ClickUp */}
            <div style={{ flex: 1, padding: "20px 18px", border: S.grid, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, background: cOk ? S.green : S.orange }} />
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 2 }}>ClickUp</div>
              </div>
              <div style={{ fontSize: 8, color: S.dim, marginBottom: 12, lineHeight: 1.5 }}>
                {cOk ? `Connected — ${status?.clickup?.projectsSynced} projects` : "Won projects, milestones, timing"}
              </div>
              {cOk ? (
                <div style={{ fontSize: 8, fontWeight: 700, color: S.green, letterSpacing: 1 }}>CONNECTED</div>
              ) : (
                <button onClick={syncClickUp} disabled={syncing === "clickup"}
                  style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 1.5, padding: "8px 16px", background: S.ink, color: S.bg, border: "none", cursor: syncing ? "wait" : "pointer", fontFamily: S.font }}>
                  {syncing === "clickup" ? "Syncing..." : "Sync ClickUp"}
                </button>
              )}
            </div>
          </div>

          {/* Help text */}
          <div style={{ fontSize: 7, color: S.ghost, marginTop: 24, letterSpacing: 0.5, lineHeight: 1.6 }}>
            Connect buttons open in a new tab. After authorizing, return here — status updates automatically.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard Frame ────────────────────────────────────────

function DashboardFrame() {
  return (
    <iframe
      src="/cash-position-v5-stream.html"
      style={{ width: "100%", height: "100vh", border: "none", display: "block" }}
      title="NOWN Cashflows"
    />
  );
}
