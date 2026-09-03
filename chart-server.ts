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
import { getBotUniverse } from "./bot-universe";
import { loadPlaybookDocument, savePlaybookDocument } from "./playbook-store";

const PORT = parseInt(process.argv[2] ?? "3847", 10);
const PUBLIC = path.join(__dirname, "public");

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("Playbook JSON vượt quá 5 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Playbook JSON không hợp lệ"));
      }
    });
    req.on("error", reject);
  });
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
    // Không đặt header cache cho .js/.css thì trình duyệt tự suy đoán và giữ bản cũ
    // — đủ để một tính năng vừa deploy trông như "bấm không ăn".
    res.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/symbols") {
    const universe = getBotUniverse();
    sendJson(res, 200, { symbols: universe.all, ...universe });
    return;
  }
  if (req.url?.startsWith("/api/playbook")) {
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
      if (req.method === "GET") {
        sendJson(res, 200, await loadPlaybookDocument(q.searchParams.get("symbol")));
        return;
      }
      if (req.method === "POST") {
        sendJson(res, 200, await savePlaybookDocument(await readJsonBody(req)));
        return;
      }
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message });
    }
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
  console.log("   🔒 UI-only: Turtle/Fast không được khởi chạy bởi process này.");
  console.log(`   (Lần đầu tải nến từ Binance có thể mất vài giây)\n`);
});
