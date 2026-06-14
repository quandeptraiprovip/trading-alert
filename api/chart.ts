import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildChartPayload } from "../chart-payload";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const raw = req.query.days;
  const daysParam = Array.isArray(raw) ? raw[0] : raw;
  const days = Math.min(400, Math.max(30, parseInt(daysParam ?? "120", 10) || 120));

  try {
    const payload = await buildChartPayload(days);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}
