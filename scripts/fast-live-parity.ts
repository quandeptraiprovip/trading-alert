/**
 * fast-live-parity.ts — CHỐT CHẶN cho sleeve Fast: `FastTrendLive` có chạy ĐÚNG luật đã audit không?
 *
 * Chạy `FastTrendLive` ở chế độ GIẤY (execution=null, telegram tắt) TỪNG NẾN MỘT bằng cách thay
 * `fetchClosed` bằng tiền tố dữ liệu lịch sử, rồi đối chiếu từng unit (symbol/hướng/thời điểm vào)
 * với `runBooks` chạy đúng bộ tham số Fast trong `scripts/rx-lab.ts`.
 *
 * Nếu test này đỏ thì con số trong planning/fast-exit-channel-2026-08.md KHÔNG áp dụng cho bot thật.
 *
 * AN TOÀN: KHÔNG import `load-env`; không key; state/journal ghi vào thư mục tạm (chdir trước import).
 *
 * Run: ./node_modules/.bin/ts-node scripts/fast-live-parity.ts [soNếnKiểmTra]
 */
import fs from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "fast-parity-"));
process.chdir(SANDBOX); // PHẢI trước khi import fast-trend-live (module tính STATE_FILE lúc load)

/* eslint-disable @typescript-eslint/no-var-requires */
const { FastTrendLive, FAST_LONG_EXIT_DAYS, FAST_SHORT_ENTRY_DAYS } =
  require(path.join(REPO, "fast-trend-live")) as typeof import("../fast-trend-live");
const { T, buildBtcGateLongs } = require(path.join(REPO, "turtle")) as typeof import("../turtle");
const { fetchFuturesKlinesPaged } = require(path.join(REPO, "kline-fetch")) as typeof import("../kline-fetch");
const { runBooks } = require(path.join(REPO, "scripts", "portfolio-engine")) as typeof import("./portfolio-engine");
const { BASKET } = require(path.join(REPO, "scripts", "portfolio-equivalence")) as typeof import("./portfolio-equivalence");
/* eslint-enable */

type Candle = import("../strategy").Candle;

const ENTRY_DAYS = 10; // FAST_TREND_ENTRY_DAYS mặc định

async function main() {
  const STEPS = parseInt(process.argv[2] ?? "400", 10);
  const bars = 700 + STEPS + Math.round(T.btcGateSlow);
  console.log(`Sandbox ${SANDBOX} · kiểm ${STEPS} nến 4h · long ${ENTRY_DAYS}d/exit mid ${FAST_LONG_EXIT_DAYS}d · short close-${FAST_SHORT_ENTRY_DAYS}d`);

  const data = new Map<string, Candle[]>();
  for (const s of BASKET) data.set(s, await fetchFuturesKlinesPaged(s, T.tf, bars));
  const minLen = Math.min(...[...data.values()].map((c) => c.length));
  const start = minLen - STEPS;
  if (start < 700) throw new Error(`không đủ nến (minLen=${minLen})`);

  // ── (1) LIVE, từng nến một ──
  const live: any = new FastTrendLive({
    symbols: BASKET,
    entryDays: ENTRY_DAYS,
    telegram: { enabled: false, botToken: "", chatId: "" },
    execution: null,
    riskPct: 0.005,
    maxPortfolioRiskPct: 0.1,
    leverage: 10,
    otherOpenRiskFrac: () => 0,
    isTradingReady: () => false,
  } as any);
  live.loadState();

  const seen: string[] = [];
  const origOpen = live.openPosition.bind(live);
  const origAdd = live.addUnit.bind(live);
  live.openPosition = async (st: any, bar: Candle, dir: string, ...rest: any[]) => {
    const before = st.pos;
    const r = await origOpen(st, bar, dir, ...rest);
    if (!before && st.pos) seen.push(`${st.symbol}|${dir}|${bar.openTime}`);
    return r;
  };
  live.addUnit = async (st: any, pos: any, bar: Candle, ...rest: any[]) => {
    const n = pos.units.length;
    const r = await origAdd(st, pos, bar, ...rest);
    if (pos.units.length > n) seen.push(`${st.symbol}|${pos.dir}|${bar.openTime}`);
    return r;
  };

  let cursor = start;
  live.fetchClosed = async (symbol: string) => data.get(symbol)!.slice(0, cursor);
  await live.cycle(true); // cold-start silent replay (giống production)
  const firstTime = data.get("btcusdt")![cursor - 1].openTime;
  seen.length = 0; // bỏ phần replay im lặng
  for (cursor = start + 1; cursor <= minLen; cursor++) await live.cycle(false);
  const lastTime = data.get("btcusdt")![minLen - 1].openTime;
  console.log(`Live  : ${seen.length} unit từ ${new Date(firstTime).toISOString().slice(0, 10)} → ${new Date(lastTime).toISOString().slice(0, 10)}`);

  // ── (2) ENGINE đã audit, cùng cửa sổ ──
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const p = {
    ...T,
    gate,
    entryDays: ENTRY_DAYS,
    longEntrySource: "high" as const,
    longExitMode: "mid" as const,
    longExitDays: FAST_LONG_EXIT_DAYS,
    shortEntryDays: FAST_SHORT_ENTRY_DAYS,
    shortEntrySource: "close" as const,
    shortExitMode: "chandelier" as const,
    shortConfirmBars: 1,
    initialStopObLookback: 0,
    pyramidMaxUnits: 3,
  };
  const res = runBooks([...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p })));
  // Unit còn MỞ ở nến cuối cũng phải được tính — nếu không sẽ báo nhầm "live thừa lệnh".
  const engine = [
    ...res.trades.map((t) => ({ symbol: t.symbol, dir: t.dir, entryTime: t.entryTime })),
    ...res.openAtEnd.map((u) => ({ symbol: u.symbol, dir: u.dir, entryTime: u.entryTime })),
  ]
    .filter((t) => t.entryTime > firstTime && t.entryTime <= lastTime)
    .map((t) => `${t.symbol}|${t.dir}|${t.entryTime}`);
  console.log(`Engine: ${engine.length} unit cùng cửa sổ (${res.openAtEnd.length} unit còn mở ở nến cuối)`);

  const liveSet = new Set(seen);
  const engSet = new Set(engine);
  let missing = 0;
  let extra = 0;
  for (const k of engSet) if (!liveSet.has(k)) { if (missing < 5) console.log(`  ✗ live thiếu ${k}`); missing++; }
  for (const k of liveSet) if (!engSet.has(k)) { if (extra < 5) console.log(`  ✗ live thừa ${k}`); extra++; }

  console.log(`\nthiếu ${missing} · thừa ${extra}`);
  const ok = missing === 0 && extra === 0 && engSet.size > 0;
  console.log(ok ? "✅ FAST LIVE KHỚP ENGINE (chuỗi lệnh)." : "❌ LỆCH — live không chạy đúng thứ đã audit.");
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("Lỗi:", e?.response?.data ?? e.message ?? e);
  process.exit(1);
});
