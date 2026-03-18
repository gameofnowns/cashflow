"use client";

import { MonthlyBreakdown } from "@/lib/types";

function formatEUR(value: number): string {
  return new Intl.NumberFormat("nl-NL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function CashPositionChart({ data }: { data: MonthlyBreakdown[] }) {
  if (data.length === 0) return null;

  const allValues = data.flatMap((d) => [d.operatingCash, d.forecastedCash]);
  const maxVal = Math.max(...allValues, 1);
  const minVal = Math.min(...allValues, 0);
  const range = maxVal - minVal || 1;

  const chartHeight = 200;
  const chartWidth = 600;
  const padding = { top: 20, right: 20, bottom: 30, left: 20 };
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  const xStep = plotWidth / (data.length - 1 || 1);

  function yPos(value: number): number {
    return padding.top + plotHeight - ((value - minVal) / range) * plotHeight;
  }

  const operatingPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${padding.left + i * xStep} ${yPos(d.operatingCash)}`)
    .join(" ");

  const forecastedPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${padding.left + i * xStep} ${yPos(d.forecastedCash)}`)
    .join(" ");

  const zeroY = yPos(0);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-900">12-Month Cash Position</h3>
        <div className="flex gap-4 text-xs">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded bg-emerald-500" />
            Operating
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded bg-blue-400" />
            Forecasted (incl. Pipeline)
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Zero line */}
        {minVal < 0 && (
          <line
            x1={padding.left}
            y1={zeroY}
            x2={chartWidth - padding.right}
            y2={zeroY}
            stroke="#e5e7eb"
            strokeWidth="1"
            strokeDasharray="4 2"
          />
        )}
        {/* Forecasted line (behind) */}
        <path d={forecastedPath} fill="none" stroke="#60a5fa" strokeWidth="2" strokeDasharray="6 3" />
        {/* Operating line (front) */}
        <path d={operatingPath} fill="none" stroke="#10b981" strokeWidth="2.5" />
        {/* Data points */}
        {data.map((d, i) => (
          <g key={d.month}>
            <circle cx={padding.left + i * xStep} cy={yPos(d.operatingCash)} r="3" fill="#10b981" />
            <circle cx={padding.left + i * xStep} cy={yPos(d.forecastedCash)} r="3" fill="#60a5fa" />
          </g>
        ))}
        {/* Month labels */}
        {data.map((d, i) => (
          <text
            key={d.month}
            x={padding.left + i * xStep}
            y={chartHeight - 5}
            textAnchor="middle"
            className="text-[8px] fill-gray-400"
          >
            {d.month.slice(5)}
          </text>
        ))}
        {/* Value labels on first and last points */}
        {[0, data.length - 1].map((i) => (
          <text
            key={`label-${i}`}
            x={padding.left + i * xStep}
            y={yPos(data[i].operatingCash) - 8}
            textAnchor={i === 0 ? "start" : "end"}
            className="text-[9px] fill-emerald-700 font-medium"
          >
            {formatEUR(data[i].operatingCash)}
          </text>
        ))}
      </svg>
    </div>
  );
}
