"use client";

import { useState } from "react";

interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: string[];
}

export function SyncButton() {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch("/api/sync/clickup", { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error || `Sync failed (${res.status})`);
        return;
      }
      const data: SyncResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {syncing ? "Syncing..." : "Sync ClickUp"}
      </button>
      {result && (
        <span className="text-sm text-gray-600">
          {result.synced} synced, {result.skipped} skipped of {result.total} tasks
          {result.errors.length > 0 && (
            <span className="text-red-500"> ({result.errors.length} errors)</span>
          )}
        </span>
      )}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
