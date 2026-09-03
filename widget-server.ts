/**
 * widget-server.ts — Nguồn dữ liệu cho widget macOS. CHỈ ĐỌC, CHỈ LOOPBACK.
 *
 * Run:  npm run widget            (mặc định cổng 3849)
 * Thử:  curl -s localhost:3849/widget.json | jq
 *
 * Chỉ nghe 127.0.0.1 — payload có số dư và vị thế, không được ra ngoài máy.
 */
import http from "http";
import { buildWidgetFeed, WidgetFeed } from "./widget-feed";

const PORT = parseInt(process.argv[2] ?? process.env.WIDGET_PORT ?? "3849", 10);
/** Nhiều client (menu bar + widget) không được nhân số lần gọi sàn lên. */
const CACHE_MS = Number(process.env.WIDGET_CACHE_MS ?? 5000);

const logTimeVn = (): string =>
  new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });

let cached: { at: number; feed: WidgetFeed } | null = null;
let inflight: Promise<WidgetFeed> | null = null;

async function getFeed(): Promise<WidgetFeed> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.feed;
  if (inflight) return inflight;
  inflight = buildWidgetFeed()
    .then((feed) => {
      cached = { at: Date.now(), feed };
      return feed;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && url.startsWith("/widget.json")) {
    try {
      const feed = await getFeed();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(feed));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("widget-server: GET /widget.json");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${logTimeVn()}] widget-server nghe http://127.0.0.1:${PORT}/widget.json (chỉ đọc, chỉ loopback)`);
});
