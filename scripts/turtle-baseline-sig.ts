/**
 * Chữ ký baseline Turtle (cấu hình GHIM = baseline TRƯỚC 2026-07-04, pyramid/gate TẮT) —
 * regression check cơ chế engine (runTurtle) khi refactor: với CÙNG dữ liệu, kết quả
 * phải bất biến. In: số lệnh, tổng NET R (4 số lẻ), checksum entryTime.
 * (Chữ ký phụ thuộc cửa sổ dữ liệu — chỉ so sánh 2 lần chạy gần nhau về thời gian.)
 * Run: ./node_modules/.bin/ts-node scripts/turtle-baseline-sig.ts
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../backtest";
import { T, runTurtle, Trade, TurtleParams } from "../turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];
// Baseline cũ ghim cứng — KHÔNG trôi theo T mặc định
const PINNED: TurtleParams = {
  ...T, entryDays: 20, chandelierMult: 3.0, atrPeriod: 20, trendLen: 50, maxHoldDays: 60,
  shortEntryDays: 0, longExitDays: 0,
  initialStopObLookback: 0,
  longEntrySource: "high", longExitMode: "chandelier",
  shortEntrySource: "low", shortExitMode: "chandelier",
  cooldownBars: 0, allowShort: true, entryBufferAtr: 0, trendLen2: 0, confirmVolMult: 0,
  pyramidStepAtr: 0, pyramidMaxUnits: 1, btcGateSlow: 0, gate: undefined,
};

async function main() {
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(1050 * bpd) + T.trendLen + 50;
  const all: Trade[] = [];
  for (const s of SYMBOLS) {
    const c: Candle[] = await fetchKlinesPaged(s, T.tf, totalBars);
    all.push(...runTurtle(s, c, PINNED));
  }
  const net = all.reduce((a, t) => a + t.netR, 0);
  let checksum = 0;
  for (const t of all) checksum = (checksum + (t.entryTime % 1_000_000_007)) % 1_000_000_007;
  console.log(`n=${all.length} net=${net.toFixed(4)} checksum=${checksum}`);
}
main().catch((e) => { console.error(e?.response?.data ?? e.message); process.exit(1); });
