/**
 * chart-server.ts — Web UI: biểu đồ BTCUSDT + marker vào/ra lệnh từ backtest
 *
 * Run:  npx ts-node chart-server.ts [port]
 * Mở:   http://localhost:3847
 */

import http from "http";
import fs from "fs";
import path from "path";
import { buildChartPayload } from "./chart-payload";

const PORT = parseInt(process.argv[2] ?? "3847", 10);
const PUBLIC = path.join(__dirname, "public");

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
  if (req.method === "GET" && req.url === "/api/symbols") {
    const { CONFIG } = await import("./strategy");
    sendJson(res, 200, { symbols: CONFIG.symbols });
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/chart")) {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const days = Math.min(400, Math.max(30, parseInt(q.searchParams.get("days") ?? "120", 10) || 120));
    const symbol = (q.searchParams.get("symbol") ?? "btcusdt").trim().toLowerCase();
    try {
      const payload = await buildChartPayload(days, symbol);
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
  console.log(`   API:      http://localhost:${PORT}/api/chart?days=120&symbol=solusdt`);
  console.log(`   (Lần đầu tải nến từ Binance có thể mất vài giây)\n`);
});
