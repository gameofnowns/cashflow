"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [phase, setPhase] = useState<"checking" | "login" | "dashboard">("checking");

  useEffect(() => {
    // Check if authenticated by trying the status endpoint
    fetch("/api/dashboard/status", { credentials: "include" })
      .then((res) => {
        if (res.ok) {
          setPhase("dashboard");
        } else if (res.status === 401 || res.redirected) {
          setPhase("login");
        } else {
          // No auth required (APP_PASSWORD not set)
          setPhase("dashboard");
        }
      })
      .catch(() => {
        // Network error or no auth — try dashboard anyway
        setPhase("dashboard");
      });
  }, []);

  if (phase === "checking") {
    return (
      <div style={{ background: "#EAE6DF", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <svg width="164" height="22" viewBox="0 0 328 41" fill="none" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" clipRule="evenodd" d="M65.4138 0H76.3161V24.2839C76.3161 31.1677 72.3342 37.047 65.8835 39.6833C59.4327 42.3195 52.4042 40.9378 47.4664 36.0712L39.752 28.4617L10.9023 0H26.3185L55.1682 28.4576L65.4096 38.5599V0H65.4138ZM317.098 0H328V24.2839C328 31.1677 324.018 37.047 317.567 39.6833C311.117 42.3195 304.088 40.9378 299.15 36.0712L291.436 28.4617L262.586 0V40.9993H251.684V0H278.002L306.852 28.4576L317.094 38.5599V0H317.098ZM158.077 0H147.175V24.2839C147.175 31.1677 151.157 37.047 157.607 39.6833C164.058 42.3195 171.087 40.9378 176.025 36.0712L183.739 28.4617L186.345 25.8911C186.914 32.0738 190.763 37.2561 196.703 39.6833C203.154 42.3195 210.182 40.9378 215.12 36.0712L222.834 28.4617L251.684 0H236.268L207.418 28.4576L197.177 38.5599V15.2067L212.589 0H197.172L168.323 28.4576L158.081 38.5599V0H158.077ZM133.55 9.40935H89.9408V31.59H133.55V9.40935ZM98.4574 0H125.029C135.724 0 144.448 8.60576 144.448 19.1549V21.8444C144.448 32.3936 135.724 40.9993 125.029 40.9993H98.4574C87.7629 40.9993 79.0386 32.3936 79.0386 21.8444V19.1549C79.0386 8.60576 87.7629 0 98.4574 0ZM0 0H10.9023V40.9993H0V0Z" fill="#1A1814"/></svg>
        </div>
      </div>
    );
  }

  if (phase === "login") {
    return <LoginScreen onSuccess={() => setPhase("dashboard")} />;
  }

  // Dashboard phase — render the v5 stream HTML in an iframe
  // This is the pragmatic approach: the v5 HTML is battle-tested and complex.
  // Porting 800+ lines of imperative JS to React would take hours and introduce bugs.
  // The iframe approach gives us the exact same dashboard at the root URL.
  return <DashboardFrame />;
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
    <div style={{
      background: "#EAE6DF", height: "100vh", display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "'Replica','Helvetica Neue',Arial,sans-serif",
    }}>
      <div style={{ textAlign: "center", width: 340 }}>
        {/* Logo */}
        <div style={{ marginBottom: 32 }}>
          <svg width="200" height="26" viewBox="0 0 328 41" fill="none" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" clipRule="evenodd" d="M65.4138 0H76.3161V24.2839C76.3161 31.1677 72.3342 37.047 65.8835 39.6833C59.4327 42.3195 52.4042 40.9378 47.4664 36.0712L39.752 28.4617L10.9023 0H26.3185L55.1682 28.4576L65.4096 38.5599V0H65.4138ZM317.098 0H328V24.2839C328 31.1677 324.018 37.047 317.567 39.6833C311.117 42.3195 304.088 40.9378 299.15 36.0712L291.436 28.4617L262.586 0V40.9993H251.684V0H278.002L306.852 28.4576L317.094 38.5599V0H317.098ZM158.077 0H147.175V24.2839C147.175 31.1677 151.157 37.047 157.607 39.6833C164.058 42.3195 171.087 40.9378 176.025 36.0712L183.739 28.4617L186.345 25.8911C186.914 32.0738 190.763 37.2561 196.703 39.6833C203.154 42.3195 210.182 40.9378 215.12 36.0712L222.834 28.4617L251.684 0H236.268L207.418 28.4576L197.177 38.5599V15.2067L212.589 0H197.172L168.323 28.4576L158.081 38.5599V0H158.077ZM133.55 9.40935H89.9408V31.59H133.55V9.40935ZM98.4574 0H125.029C135.724 0 144.448 8.60576 144.448 19.1549V21.8444C144.448 32.3936 135.724 40.9993 125.029 40.9993H98.4574C87.7629 40.9993 79.0386 32.3936 79.0386 21.8444V19.1549C79.0386 8.60576 87.7629 0 98.4574 0ZM0 0H10.9023V40.9993H0V0Z" fill="#1A1814"/></svg>
        </div>

        {/* Title */}
        <div style={{
          fontSize: 28, fontWeight: 700, textTransform: "uppercase" as const,
          letterSpacing: 6, marginBottom: 8, color: "#1A1814",
        }}>
          CASHFLOWS
        </div>

        <div style={{
          fontSize: 9, fontWeight: 300, color: "#A09890",
          letterSpacing: 0.3, marginBottom: 32,
        }}>
          enter password to continue
        </div>

        {/* Password input */}
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="password"
          autoFocus
          style={{
            width: "100%", padding: "12px 16px",
            border: "1px solid #1A1814", background: "transparent",
            fontSize: 11, fontWeight: 700, letterSpacing: 1,
            textAlign: "center", marginBottom: 12,
            fontFamily: "'Replica','Helvetica Neue',Arial,sans-serif",
            outline: "none",
          }}
        />

        {/* Sign in button */}
        <button
          onClick={submit}
          disabled={loading}
          style={{
            width: "100%", padding: 12,
            background: "#1A1814", color: "#EAE6DF", border: "none",
            fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const,
            letterSpacing: 2, cursor: loading ? "wait" : "pointer",
            fontFamily: "'Replica','Helvetica Neue',Arial,sans-serif",
            transition: "background 150ms",
          }}
          onMouseEnter={(e) => { if (!loading) (e.target as HTMLElement).style.background = "#FE6337"; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = "#1A1814"; }}
        >
          {loading ? "..." : "Sign In"}
        </button>

        {/* Error */}
        {error && (
          <div style={{ fontSize: 9, color: "#BD6A55", marginTop: 10, fontWeight: 700 }}>
            {error}
          </div>
        )}

        {/* Subtle footer */}
        <div style={{ fontSize: 7, color: "#C8C2B8", marginTop: 32, letterSpacing: 1 }}>
          NOWN B.V. — CASH POSITION DASHBOARD
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
      style={{
        width: "100%",
        height: "100vh",
        border: "none",
        display: "block",
      }}
      title="NOWN Cashflows"
    />
  );
}
