/**
 * turtle-live-parity.ts — Lớp LIVE có chạy ĐÚNG thứ đã được audit không?
 *
 * Chạy `TurtleLive` ở chế độ GIẤY (api=null, trader=null, telegram tắt) TỪNG NẾN MỘT bằng cách
 * thay `fetchClosed` bằng tiền tố dữ liệu lịch sử, rồi đối chiếu từng unit (symbol/hướng/thời điểm
 * vào **và tỉ trọng risk**) với `runTurtlePortfolio` + chính sách heat-decay.
 *
 * Đây là chốt chặn cho thay đổi 2026-08-04: nếu thứ tự xử lý hoặc công thức heat của live lệch khỏi
 * engine, mọi con số audit đều không áp dụng cho tiền thật.
 *
 * AN TOÀN: KHÔNG import `load-env`; không key; state/journal ghi vào thư mục tạm (chdir trước import).
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-live-parity.ts [soNếnKiểmTra]
 */
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "turtle-parity-"));
process.chdir(SANDBOX); // PHẢI trước khi import turtle-live (module tính STATE_FILE lúc load)

/* eslint-disable @typescript-eslint/no-var-requires */
const { TurtleLive } = require(path.join(REPO, "turtle-live")) as typeof import("../turtle-live");
const { T } = require(path.join(REPO, "turtle")) as typeof import("../turtle");
const { TF_MS } = require(path.join(REPO, "strategy")) as typeof import("../strategy");
const { fetchKlinesPaged } = require(path.join(REPO, "kline-fetch")) as typeof import("../kline-fetch");
const { runBooks } = require(path.join(REPO, "scripts", "portfolio-engine")) as typeof import("./portfolio-engine");
const { buildBtcGateLongs } = require(path.join(REPO, "turtle")) as typeof import("../turtle");
const { BASKET } = require(path.join(REPO, "scripts", "portfolio-equivalence")) as typeof import("./portfolio-equivalence");
/* eslint-enable */

type Candle = import("../strategy").Candle;

async function main() {
  const STEPS = parseInt(process.argv[2] ?? "300", 10);
  const bars = 700 + STEPS + Math.round(T.btcGateSlow);
  console.log(`Sandbox ${SANDBOX} · kiểm ${STEPS} nến 4h`);

  const data = new Map<string, Candle[]>();
  for (const s of BASKET) data.set(s, await fetchKlinesPaged(s, T.tf, bars));
  const minLen = Math.min(...[...data.values()].map((c) => c.length));
  const start = minLen - STEPS;
  if (start < 700) throw new Error(`không đủ nến (minLen=${minLen})`);

  // ── (1) LIVE, từng nến một ──
  const live: any = new TurtleLive({
    symbols: BASKET,
    api: null,
    trader: null,
    telegram: { enabled: false, botToken: "", chatId: "" },
    riskPct: 0.01,
    maxPortfolioRiskPct: 0.2,
    leverage: 10,
    isTradingReady: () => false,
    otherHoldsSymbol: () => false,
    otherOpenRiskFrac: () => 0,
  } as any);
  live.loadState();

  const seen: { key: string; weight: number }[] = [];
  const origOpen = live.openPosition.bind(live);
  const origAdd = live.addUnit.bind(live);
  live.openPosition = async (st: any, candles: Candle[], i: number, dir: string, ...rest: any[]) => {
    const before = st.pos;
    const r = await origOpen(st, candles, i, dir, ...rest);
    if (!before && st.pos) seen.push({ key: `${st.symbol}|${dir}|${candles[i].openTime}`, weight: st.pos.units[0].weight ?? 1 });
    return r;
  };
  live.addUnit = async (st: any, pos: any, candles: Candle[], i: number, ...rest: any[]) => {
    const n = pos.units.length;
    const r = await origAdd(st, pos, candles, i, ...rest);
    if (pos.units.length > n) {
      const u = pos.units[pos.units.length - 1];
      seen.push({ key: `${st.symbol}|${pos.dir}|${candles[i].openTime}`, weight: u.weight ?? 1 });
    }
    return r;
  };

  let cursor = start;
  live.fetchClosed = async (symbol: string) => data.get(symbol)!.slice(0, cursor);
  // Nến đầu tiên: silent replay để dựng vị thế đang mở (giống cold-start production)
  await live.cycle(true);
  const firstTime = data.get("btcusdt")![cursor - 1].openTime;
  seen.length = 0; // bỏ phần replay im lặng (không đại diện hành vi live)
  for (cursor = start + 1; cursor <= minLen; cursor++) await live.cycle(false);
  const lastTime = data.get("btcusdt")![minLen - 1].openTime;
  console.log(`Live: ${seen.length} unit từ ${new Date(firstTime).toISOString().slice(0, 10)} → ${new Date(lastTime).toISOString().slice(0, 10)}`);

  // ── (2) ENGINE đã audit, cùng cửa sổ ──
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const res = runBooks(
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...T, gate } })),
    (c) => (T.heatDecayK > 0 ? 1 / (1 + c.sameDirHeat / T.heatDecayK) : 1),
  );
  const engine = res.trades
    .filter((t) => t.entryTime > firstTime && t.entryTime <= lastTime)
    .map((t) => ({ key: `${t.symbol}|${t.dir}|${t.entryTime}`, weight: t.weight }));
  console.log(`Engine: ${engine.length} unit cùng cửa sổ`);

  const liveMap = new Map(seen.map((u) => [u.key, u.weight]));
  const engMap = new Map(engine.map((u) => [u.key, u.weight]));
  let missing = 0, extra = 0, wrongW = 0;
  for (const [k, w] of engMap) {
    if (!liveMap.has(k)) { if (missing < 5) console.log(`  ✗ live thiếu ${k}`); missing++; }
    else if (Math.abs(liveMap.get(k)! - w) > 1e-6) {
      if (wrongW < 5) console.log(`  ✗ lệch weight ${k}: live ${liveMap.get(k)!.toFixed(4)} vs engine ${w.toFixed(4)}`);
      wrongW++;
    }
  }
  for (const k of liveMap.keys()) if (!engMap.has(k)) { if (extra < 5) console.log(`  ✗ live thừa ${k}`); extra++; }

  console.log(`\nthiếu ${missing} · lệch weight ${wrongW} · thừa ${extra}`);
  const ok = missing === 0 && wrongW === 0 && extra === 0 && engMap.size > 0;
  console.log(ok ? "✅ LIVE KHỚP ENGINE (chuỗi lệnh + tỉ trọng risk)." : "❌ LỆCH — live không chạy đúng thứ đã audit.");
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e.message ?? e);
  process.exit(1);
});
