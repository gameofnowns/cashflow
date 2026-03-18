export type ProjectType = "X" | "Y" | "Z";
export type ConfidenceTier = "won" | "committed" | "pipeline";
export type MilestoneStatus = "pending" | "invoiced" | "received";
export type DataSource = "clickup" | "dynamics" | "manual";

export const COGS_RATES: Record<ProjectType, number> = {
  X: 0.3,
  Y: 0.4,
  Z: 0.5,
};

export const COGS_BUFFER = 1.1;
export const VAT_RETURN_RATE = 0.1;

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
