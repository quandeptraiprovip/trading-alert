/**
 * Validate maxHoldBars: sweep mịn + OOS 2 cửa sổ. Đổi baseline chỉ khi vượt NET VÀ ổn định OOS.
 * Chạy: ./node_modules/.bin/ts-node scripts/maxhold-validate.ts [days]
 */
import "../load-env";
import { CONFIG, TF_MS, Candle } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];
const DAYS = parseInt(process.argv[2] ?? "250", 10);

async function load(days: number): Promise<Map<string, Candle[]>> {
  const totalBars = Math.ceil(days * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  const m = new Map<string, Candle[]>();
  for (const s of SYMBOLS) m.set(s, await fetchKlinesPaged(s, CONFIG.entryTf, totalBars));
  return m;
}

/** NET trên các trade có entry trong [from,to) — để chia OOS theo thời gian. */
function netWindow(data: Map<string, Candle[]>, from: number, to: number) {
  let net = 0, n = 0;
  const per: Record<string, number> = {};
  for (const [sym, ltf] of data) {
    const trades = runBacktest(sym, ltf).filter((t) => t.entryTime >= from && t.entryTime < to);
    const s = trades.reduce((a, t) => a + t.netR, 0);
    per[sym] = s; net += s; n += trades.length;
  }
  return { net, n, per };
}

async function main() {
  const data = await load(DAYS);
  let pStart = Infinity, pEnd = -Infinity;
  for (const ltf of data.values()) { pStart = Math.min(pStart, ltf[0].openTime); pEnd = Math.max(pEnd, ltf[ltf.length - 1].openTime); }
  const mid = pStart + (pEnd - pStart) / 2;
  const D = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const saved = CONFIG.maxHoldBars;

  console.log(`Sweep mịn maxHold (${DAYS}d rổ) + chia OOS nửa cũ | nửa mới:\n`);
  console.log("maxHold | NET tổng | nửa cũ | nửa mới | n  | BTC/SOL/XRP/DOGE");
  console.log("-".repeat(78));
  for (const d of [6, 7, 8, 9, 10, 11, 12, 14, 16]) {
    CONFIG.maxHoldBars = d * D;
    const all = netWindow(data, -Infinity, Infinity);
    const old = netWindow(data, pStart, mid);
    const neu = netWindow(data, mid, pEnd);
    const per = SYMBOLS.map((s) => (all.per[s] >= 0 ? "+" : "") + all.per[s].toFixed(1)).join("/");
    const star = d === 7 ? " (baseline)" : "";
    console.log(
      `${String(d).padStart(4)}d   | ${((all.net >= 0 ? "+" : "") + all.net.toFixed(2)).padStart(8)} | ${(old.net >= 0 ? "+" : "") + old.net.toFixed(1).padStart(5)} | ${(neu.net >= 0 ? "+" : "") + neu.net.toFixed(1).padStart(5)} | ${String(all.n).padStart(2)} | ${per}${star}`
    );
  }
  CONFIG.maxHoldBars = saved;
  console.log("-".repeat(78));
  console.log("Đọc: muốn thấy plateau TRƠN quanh giá trị tốt + dương ở CẢ nửa cũ & nửa mới (không phải spike 1 điểm).");
}

main().catch((e) => { console.error(e); process.exit(1); });
