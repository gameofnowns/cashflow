"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface OverheadEntry {
  id: string;
  month: string;
  amount: number;
  notes: string | null;
  updatedBy: string | null;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="text-gray-500">Loading...</div>}>
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const [overheads, setOverheads] = useState<OverheadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [exactSyncing, setExactSyncing] = useState(false);
  const [exactResult, setExactResult] = useState<string | null>(null);
  const [dynamicsSyncing, setDynamicsSyncing] = useState(false);
  const [dynamicsResult, setDynamicsResult] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const exactConnected = searchParams.get("exact_connected") === "true";
  const exactError = searchParams.get("exact_error");

  useEffect(() => {
    fetch("/api/overhead")
      .then((r) => r.json())
      .then((data) => {
        setOverheads(data);
        setLoading(false);
      });
  }, []);

  async function updateOverhead(month: string, amount: number) {
    await fetch("/api/overhead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month, amount, updatedBy: "dashboard" }),
    });
  }

  async function syncDynamics() {
    setDynamicsSyncing(true);
    setDynamicsResult(null);
    try {
      const res = await fetch("/api/sync/dynamics", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setDynamicsResult(`Error: ${data.error}`);
      } else {
        setDynamicsResult(
          `Synced ${data.synced} pipeline deals of ${data.total} (${data.skipped} skipped)${data.errors?.length ? `, ${data.errors.length} errors` : ""}`
        );
      }
    } catch (e) {
      setDynamicsResult(`Error: ${e instanceof Error ? e.message : "Network error"}`);
    } finally {
      setDynamicsSyncing(false);
    }
  }

  async function syncExact() {
    setExactSyncing(true);
    setExactResult(null);
    try {
      const res = await fetch("/api/sync/exact", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setExactResult(`Error: ${data.error}`);
      } else {
        setExactResult(
          `Synced — Bank: EUR ${data.bankBalance?.toLocaleString("nl-NL") ?? "?"}, AR: EUR ${data.totalAr?.toLocaleString("nl-NL") ?? "?"}, AP: EUR ${data.totalAp?.toLocaleString("nl-NL") ?? "?"}`
        );
      }
    } catch (e) {
      setExactResult(`Error: ${e instanceof Error ? e.message : "Network error"}`);
    } finally {
      setExactSyncing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
        <p className="text-sm text-gray-500">Manage fixed overhead budgets and data source connections</p>
      </div>

      {exactConnected && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          Exact Online connected successfully.
        </div>
      )}
      {exactError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Exact Online error: {exactError}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Data Sources</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div>
              <p className="text-sm font-medium text-gray-900">ClickUp</p>
              <p className="text-xs text-gray-500">Won projects &amp; payment milestones</p>
            </div>
            <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
              Connected
            </span>
          </div>

          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div>
              <p className="text-sm font-medium text-gray-900">Exact Online</p>
              <p className="text-xs text-gray-500">AR, AP, Bank balance</p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="/api/auth/exact"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                {exactConnected ? "Reconnect" : "Connect"}
              </a>
              <button
                onClick={syncExact}
                disabled={exactSyncing}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {exactSyncing ? "Syncing..." : "Sync Now"}
              </button>
            </div>
          </div>
          {exactResult && (
            <p className={`text-xs ${exactResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
              {exactResult}
            </p>
          )}

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Dynamics CRM</p>
              <p className="text-xs text-gray-500">Pipeline deals (90%+)</p>
            </div>
            <button
              onClick={syncDynamics}
              disabled={dynamicsSyncing}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {dynamicsSyncing ? "Syncing..." : "Sync Now"}
            </button>
          </div>
          {dynamicsResult && (
            <p className={`text-xs ${dynamicsResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
              {dynamicsResult}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Fixed Overhead by Month</h3>
        {loading ? (
          <p className="text-gray-500">Loading...</p>
        ) : overheads.length === 0 ? (
          <p className="text-gray-400 text-sm">
            No overhead data yet. Run the seed script to populate initial data.
          </p>
        ) : (
          <div className="space-y-3">
            {overheads.map((entry) => (
              <div key={entry.id} className="flex items-center gap-4">
                <span className="w-24 text-sm font-medium text-gray-700">
                  {new Date(entry.month).toLocaleDateString("en-US", { year: "numeric", month: "short" })}
                </span>
                <input
                  type="number"
                  defaultValue={entry.amount}
                  onBlur={(e) => updateOverhead(entry.month, Number(e.target.value))}
                  className="w-32 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-900"
                />
                <span className="text-xs text-gray-400">{entry.notes || ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
