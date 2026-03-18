"use client";

import { MonthlyBreakdown } from "@/lib/types";

function fmt(value: number): string {
  if (value === 0) return "—";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function cashClass(value: number): string {
  if (value < 0) return "text-red-600 font-semibold";
  if (value < 50000) return "text-amber-600 font-semibold";
  return "text-green-700 font-semibold";
}

export function MonthlyTable({ data }: { data: MonthlyBreakdown[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            <th className="px-4 py-3 sticky left-0 bg-gray-50">Month</th>
            <th className="px-4 py-3 text-right">Current AR</th>
            <th className="px-4 py-3 text-right">Billable AR</th>
            <th className="px-4 py-3 text-right">Forecasted AR</th>
            <th className="px-4 py-3 text-right">COGS (Won)</th>
            <th className="px-4 py-3 text-right">COGS (Pipeline)</th>
            <th className="px-4 py-3 text-right">VAT Return</th>
            <th className="px-4 py-3 text-right">Overhead</th>
            <th className="px-4 py-3 text-right">Operating Cash</th>
            <th className="px-4 py-3 text-right">Forecasted Cash</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {data.map((row) => (
            <tr key={row.month} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium text-gray-900 sticky left-0 bg-white">
                {row.month}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{fmt(row.currentAr)}</td>
              <td className="px-4 py-3 text-right text-gray-600">{fmt(row.billableAr)}</td>
              <td className="px-4 py-3 text-right text-blue-600">{fmt(row.forecastedAr)}</td>
              <td className="px-4 py-3 text-right text-red-500">{row.cogsWon > 0 ? `-${fmt(row.cogsWon)}` : "—"}</td>
              <td className="px-4 py-3 text-right text-red-400">{row.cogsPipeline > 0 ? `-${fmt(row.cogsPipeline)}` : "—"}</td>
              <td className="px-4 py-3 text-right text-emerald-600">{fmt(row.vatReturn)}</td>
              <td className="px-4 py-3 text-right text-red-500">{row.overhead > 0 ? `-${fmt(row.overhead)}` : "—"}</td>
              <td className={`px-4 py-3 text-right ${cashClass(row.operatingCash)}`}>
                {fmt(row.operatingCash)}
              </td>
              <td className={`px-4 py-3 text-right ${cashClass(row.forecastedCash)}`}>
                {fmt(row.forecastedCash)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
