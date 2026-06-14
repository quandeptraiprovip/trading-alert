import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { buildChartPayload } from "../../../chart-payload";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = Math.min(400, Math.max(30, parseInt(daysParam ?? "120", 10) || 120));

  try {
    const payload = await buildChartPayload(days);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
