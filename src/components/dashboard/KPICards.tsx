"use client";

import { MonthlyBreakdown } from "@/lib/types";

function formatEUR(value: number): string {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function KPICards({ data }: { data: MonthlyBreakdown[] }) {
  if (data.length === 0) return null;

  const current = data[0];
  const threeMonth = data[2];
  const sixMonth = data[5];

  const cards = [
    {
      label: "Bank Balance",
      value: formatEUR(current.operatingCash),
      sub: "Current operating position",
    },
    {
      label: "3-Month Outlook",
      value: formatEUR(threeMonth?.operatingCash ?? 0),
      sub: `Operating • ${threeMonth?.month ?? "—"}`,
    },
    {
      label: "6-Month Outlook",
      value: formatEUR(sixMonth?.operatingCash ?? 0),
      sub: `Operating • ${sixMonth?.month ?? "—"}`,
    },
    {
      label: "Forecasted (incl. Pipeline)",
      value: formatEUR(threeMonth?.forecastedCash ?? 0),
      sub: `3-month with pipeline • ${threeMonth?.month ?? "—"}`,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-gray-200 bg-white p-5"
        >
          <p className="text-sm font-medium text-gray-500">{card.label}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">
            {card.value}
          </p>
          <p className="mt-1 text-xs text-gray-400">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
