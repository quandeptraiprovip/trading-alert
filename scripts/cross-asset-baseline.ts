/**
 * So sánh CONFIG hiện tại trên nhiều USDⓈ-M Perpetual (Binance fapi/v1/klines).
 * Chạy: npx ts-node scripts/cross-asset-baseline.ts [soNgay]
 */
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const DAYS = parseInt(process.argv[2] ?? "250", 10);
/** Các cặp phổ biến trên chart Perpetual Binance (USD-M). */
const SYMBOLS = [
  "btcusdt",
  "ethusdt",
  "solusdt",
  "bnbusdt",
  "xrpusdt",
  "dogeusdt",
  "avaxusdt",
  "linkusdt",
];

function summarize(symbol: string, trades: ReturnType<typeof runBacktest>) {
  const net = trades.reduce((s, t) => s + t.netR, 0);
  const wins = trades.filter((t) => t.netR > 0).length;
  const wr = trades.length ? (wins / trades.length) * 100 : 0;
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  return { symbol, n: trades.length, net, wr, losses: trades.length - wins, byReason, trades };
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;

  console.log("=".repeat(72));
  console.log(`  CONFIG hiện tại — ${DAYS} ngày — Binance USDⓈ-M (fapi) — ${CONFIG.entryTf} entry`);
  console.log(
    `  delta=${CONFIG.deltaBuyMin} | maxHold=${(CONFIG.maxHoldBars / 96).toFixed(1)}d | trail@${CONFIG.trailStartR}R | expiry=${CONFIG.setupExpiryBars}`,
  );
  console.log("=".repeat(72));

  const rows: ReturnType<typeof summarize>[] = [];

  for (const sym of SYMBOLS) {
    console.log(`\nTải ${sym.toUpperCase()}…`);
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) {
      console.log(`  ⚠️  Không đủ nến (${ltf.length}), bỏ qua.`);
      continue;
    }
    const trades = runBacktest(sym, ltf);
    const s = summarize(sym, trades);
    rows.push(s);
    console.log(
      `  ${sym.toUpperCase().padEnd(8)} : ${String(s.n).padStart(3)} lệnh | WR ${s.wr.toFixed(0).padStart(3)}% | NET ${s.net >= 0 ? "+" : ""}${s.net.toFixed(2)}R | L=${s.losses}`,
    );
    console.log(`           thoát: ${Object.entries(s.byReason).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
    for (const t of s.trades) {
      const mark = t.netR > 0 ? "🟢" : "🔴";
      const d = new Date(t.entryTime).toISOString().slice(0, 10);
      console.log(
        `    ${mark} ${t.dir.toUpperCase().padEnd(5)} ${d}  ${t.netR >= 0 ? "+" : ""}${t.netR.toFixed(2)}R  ${t.exitReason}`,
      );
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log("TỔNG (cộng NET R, không compounding đa symbol):");
  const totalNet = rows.reduce((s, r) => s + r.net, 0);
  const totalN = rows.reduce((s, r) => s + r.n, 0);
  console.log(`  ${totalN} lệnh | NET ${totalNet >= 0 ? "+" : ""}${totalNet.toFixed(2)}R`);
  for (const r of rows) {
    console.log(`  ${r.symbol.toUpperCase().padEnd(8)} ${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)}R (${r.n} lệnh)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
