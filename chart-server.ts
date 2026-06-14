/**
 * chart-server.ts — Web UI: biểu đồ BTCUSDT + marker vào/ra lệnh từ backtest
 *
 * Run:  npx ts-node chart-server.ts [port]
 * Mở:   http://localhost:3847
 */

import http from "http";
import fs from "fs";
import path from "path";
import { CONFIG, TF_MS } from "./strategy";
import { fetchKlinesPaged, runBacktest } from "./backtest";

const PORT = parseInt(process.argv[2] ?? "3847", 10);
const PUBLIC = path.join(__dirname, "public");

type ChartTrade = {
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  netR: number;
  zoneDesc: string;
};

async function buildChartPayload(days: number): Promise<object> {
  const symbol = "btcusdt";
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400;
  const ltf = await fetchKlinesPaged(symbol, CONFIG.entryTf, totalBars);
  const trades = runBacktest(symbol, ltf);

  const displayStart = ltf.length > 0 ? ltf[Math.max(0, ltf.length - Math.ceil(days * barsPerDay))].openTime : 0;
  const candles = ltf
    .filter((c) => c.openTime >= displayStart)
    .map((c) => ({
      t: c.openTime,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume,
      q: c.quoteVolume ?? c.volume * c.close,
      tb: c.takerBuyVolume,
    }));

  const chartTrades: ChartTrade[] = trades
    .filter((t) => t.entryTime >= displayStart)
    .map((t) => ({
      dir: t.dir,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      initialSL: t.initialSL,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason,
      netR: t.netR,
      zoneDesc: t.zoneDesc,
    }));

  return {
    symbol: symbol.toUpperCase(),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: chartTrades.length,
    candles,
    trades: chartTrades,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = req.url?.split("?")[0] ?? "/";
  const file = urlPath === "/" ? "index.html" : path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC, file);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
    };
    res.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      ...(ext === ".html" ? { "Cache-Control": "no-cache" } : {}),
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/api/chart")) {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const days = Math.min(400, Math.max(30, parseInt(q.searchParams.get("days") ?? "120", 10) || 120));
    try {
      const payload = await buildChartPayload(days);
      sendJson(res, 200, payload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n📈 Chart UI: http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api/chart?days=120`);
  console.log(`   (Lần đầu tải nến từ Binance có thể mất vài giây)\n`);
});
