export type ProjectType = "X" | "Y" | "Z";
export type ConfidenceTier = "won" | "committed" | "pipeline";
export type MilestoneStatus = "pending" | "invoiced" | "received";
export type DataSource = "clickup" | "dynamics" | "manual";

export const COGS_RATES: Record<ProjectType, number> = {
  X: 0.3,
  Y: 0.4,
  Z: 0.5,
};

export const COGS_BUFFER = 1.21; // Dutch VAT rate (21%) — changed from 1.10 per v2 spec
export const VAT_RETURN_RATE = 0.21 / 1.21; // VAT component recoverable from COGS (≈17.36%)

export interface MonthlyBreakdown {
  month: string; // YYYY-MM
  currentAr: number;
  billableAr: number;
  forecastedAr: number;
  cogsWon: number;
  cogsPipeline: number;
  vatReturn: number;
  overhead: number;
  operatingCash: number;
  forecastedCash: number;
}
