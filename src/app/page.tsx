import { generateForecast } from "@/lib/cashflow";
import { KPICards } from "@/components/dashboard/KPICards";
import { CashPositionChart } from "@/components/dashboard/CashPositionChart";
import { MonthlyTable } from "@/components/dashboard/MonthlyTable";
import { SyncButton } from "@/components/dashboard/SyncButton";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const forecast = await generateForecast();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Cash Flow Forecast</h2>
          <p className="text-sm text-gray-500">
            Rolling 12-month view — Operating vs Forecasted position
          </p>
        </div>
        <div className="flex items-center gap-4">
          <SyncButton />
          <div className="text-right text-xs text-gray-400">
            <p>Last updated: {new Date().toLocaleString("nl-NL")}</p>
          </div>
        </div>
      </div>

      <KPICards data={forecast} />
      <CashPositionChart data={forecast} />

      <div>
        <h3 className="mb-3 text-lg font-semibold text-gray-900">Monthly Breakdown</h3>
        <MonthlyTable data={forecast} />
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <strong>Note:</strong> Operating Cash Position includes only won/active projects (confirmed).
        Forecasted Cash Position adds pipeline deals (90%+ probability) — shown separately per the spec.
      </div>
    </div>
  );
}
