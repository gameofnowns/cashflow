import { NextResponse } from "next/server";
import { generateForecast } from "@/lib/cashflow";

export async function GET() {
  const forecast = await generateForecast();
  return NextResponse.json(forecast);
}
