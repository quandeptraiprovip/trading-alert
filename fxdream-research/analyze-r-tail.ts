/**
 * Đo phần đuôi R của đường backtest V7 đã sửa.
 *
 * `maxR` là MFE quan sát được trước khi chiến lược hiện tại thoát lệnh. Nó không
 * phải lợi nhuận có thể khớp chắc chắn và cũng không mô phỏng một runner vô hạn.
 *
 * Run:
 *   ./node_modules/.bin/ts-node fxdream-research/analyze-r-tail.ts 365
 *   FXDREAM_R_TAIL_SYMBOLS=XRPUSDT ./node_modules/.bin/ts-node fxdream-research/analyze-r-tail.ts 1095
 */

import "../load-env";
import { median } from "./strategy-engine-v2";
import { Flags, Trade, load, runSymbol } from "./measure-live-path";

const V7: Flags = {
  label: "V7",
  noLookahead: true,
  keyAtClose: true,
  strictEngulf: true,
  strictSweep: true,
  strictDailyGate: true,
  noStopFloor: true,
  requireHeadroom: true,
  trailH1: false,
  requireSecondTouch: false,
};

const THRESHOLDS = [1, 2, 3, 5, 10, 15, 20, 30];

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function printTail(trades: Trade[]): void {
  console.log("\nPHÂN PHỐI PHẦN ĐUÔI");
  console.log("ngưỡng".padEnd(9) + "MFE đạt".padStart(12) + "tỷ lệ".padStart(10) + "R thực thu đạt".padStart(16) + "tỷ lệ".padStart(10));
  for (const threshold of THRESHOLDS) {
    const mfe = trades.filter((trade) => trade.maxR >= threshold).length;
    const realized = trades.filter((trade) => trade.grossR >= threshold).length;
    console.log(
      `${threshold}R`.padEnd(9) +
        String(mfe).padStart(12) +
        pct(mfe, trades.length).padStart(10) +
        String(realized).padStart(16) +
        pct(realized, trades.length).padStart(10),
    );
  }
}

function printConcentration(trades: Trade[]): void {
  const winners = trades.filter((trade) => trade.grossR > 0).sort((a, b) => b.grossR - a.grossR);
  const grossWins = winners.reduce((sum, trade) => sum + trade.grossR, 0);
  const grossTotal = trades.reduce((sum, trade) => sum + trade.grossR, 0);
  console.log("\nMỨC TẬP TRUNG LỢI NHUẬN");
  console.log(`Gross thắng: +${grossWins.toFixed(1)}R · Gross toàn bộ: ${grossTotal >= 0 ? "+" : ""}${grossTotal.toFixed(1)}R`);
  for (const count of [1, 3, 5, 10, Math.max(1, Math.ceil(trades.length * 0.05))]) {
    const uniqueCount = Math.min(count, winners.length);
    const contribution = winners.slice(0, uniqueCount).reduce((sum, trade) => sum + trade.grossR, 0);
    console.log(
      `Top ${String(uniqueCount).padStart(3)} lệnh: +${contribution.toFixed(1).padStart(6)}R` +
        ` = ${pct(contribution, grossWins).padStart(6)} gross thắng` +
        ` · bỏ đi còn ${(grossTotal - contribution).toFixed(1)}R`,
    );
  }
}

function printStopBuckets(trades: Trade[]): void {
  const buckets = [
    { label: "<0,25%", min: 0, max: 0.0025 },
    { label: "0,25–0,50%", min: 0.0025, max: 0.005 },
    { label: "0,50–1,00%", min: 0.005, max: 0.01 },
    { label: ">=1,00%", min: 0.01, max: Number.POSITIVE_INFINITY },
  ];
  console.log("\nR THEO ĐỘ RỘNG STOP");
  console.log(
    "stop".padEnd(14) + "lệnh".padStart(7) + "SL tv".padStart(10) + "MFE tv".padStart(10) +
      "MFE>=5R".padStart(11) + "MFE>=10R".padStart(12) + "gross".padStart(10),
  );
  for (const bucket of buckets) {
    const rows = trades.filter((trade) => trade.stopPct >= bucket.min && trade.stopPct < bucket.max);
    const gross = rows.reduce((sum, trade) => sum + trade.grossR, 0);
    console.log(
      bucket.label.padEnd(14) +
        String(rows.length).padStart(7) +
        `${(median(rows.map((trade) => trade.stopPct)) * 100).toFixed(3)}%`.padStart(10) +
        `${median(rows.map((trade) => trade.maxR)).toFixed(2)}R`.padStart(10) +
        pct(rows.filter((trade) => trade.maxR >= 5).length, rows.length).padStart(11) +
        pct(rows.filter((trade) => trade.maxR >= 10).length, rows.length).padStart(12) +
        `${gross >= 0 ? "+" : ""}${gross.toFixed(1)}R`.padStart(10),
    );
  }
}

function printBySymbol(trades: Trade[]): void {
  const symbols = [...new Set(trades.map((trade) => trade.symbol))];
  console.log("\nTHEO SYMBOL");
  console.log("symbol".padEnd(10) + "lệnh".padStart(7) + "gross".padStart(10) + "MFE>=5R".padStart(11) + "MFE>=10R".padStart(12) + "MFE max".padStart(10));
  for (const symbol of symbols) {
    const rows = trades.filter((trade) => trade.symbol === symbol);
    const gross = rows.reduce((sum, trade) => sum + trade.grossR, 0);
    console.log(
      symbol.padEnd(10) +
        String(rows.length).padStart(7) +
        `${gross >= 0 ? "+" : ""}${gross.toFixed(1)}R`.padStart(10) +
        pct(rows.filter((trade) => trade.maxR >= 5).length, rows.length).padStart(11) +
        pct(rows.filter((trade) => trade.maxR >= 10).length, rows.length).padStart(12) +
        `${Math.max(...rows.map((trade) => trade.maxR)).toFixed(1)}R`.padStart(10),
    );
  }
}

function printTopMfe(trades: Trade[]): void {
  console.log("\nTOP 10 MFE QUAN SÁT ĐƯỢC");
  for (const trade of [...trades].sort((a, b) => b.maxR - a.maxR).slice(0, 10)) {
    console.log(
      `${new Date(trade.entryTime).toISOString().slice(0, 10)} ${trade.symbol.padEnd(9)} ${trade.dir.padEnd(5)}` +
        ` MFE ${trade.maxR.toFixed(1).padStart(5)}R` +
        ` · thực thu ${trade.grossR.toFixed(1).padStart(5)}R` +
        ` · SL ${(trade.stopPct * 100).toFixed(3)}%` +
        ` · giữ ${(trade.holdBars5m * 5 / 60).toFixed(1)}h` +
        ` · ${trade.reason}`,
    );
  }
}

async function main(): Promise<void> {
  const days = Number.parseInt(process.argv[2] ?? "365", 10);
  const symbols = (process.env.FXDREAM_R_TAIL_SYMBOLS?.trim() || "BTCUSDT,SOLUSDT,XRPUSDT,DOGEUSDT")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  let trades: Trade[] = [];
  for (const symbol of symbols) {
    const data = await load(symbol, days);
    trades = trades.concat(runSymbol(data, V7).trades);
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  if (trades.length === 0) throw new Error("Không có lệnh V7 để phân tích");

  const gross = trades.reduce((sum, trade) => sum + trade.grossR, 0);
  const realizedWins = trades.filter((trade) => trade.grossR > 0);
  console.log(`\nV7 · ${days} ngày · ${symbols.join(", ")} · ${trades.length} lệnh`);
  console.log(`Gross: ${gross >= 0 ? "+" : ""}${gross.toFixed(1)}R · win rate: ${pct(realizedWins.length, trades.length)}`);
  console.log(
    `MFE p50/p75/p90/p95/p99/max: ` +
      [0.5, 0.75, 0.9, 0.95, 0.99].map((q) => `${quantile(trades.map((trade) => trade.maxR), q).toFixed(2)}R`).join(" / ") +
      ` / ${Math.max(...trades.map((trade) => trade.maxR)).toFixed(2)}R`,
  );
  console.log(
    `R thực thu p50/p75/p90/p95/p99/max: ` +
      [0.5, 0.75, 0.9, 0.95, 0.99].map((q) => `${quantile(trades.map((trade) => trade.grossR), q).toFixed(2)}R`).join(" / ") +
      ` / ${Math.max(...trades.map((trade) => trade.grossR)).toFixed(2)}R`,
  );

  printTail(trades);
  printConcentration(trades);
  printStopBuckets(trades);
  printBySymbol(trades);
  printTopMfe(trades);

  console.log("\nLưu ý: MFE chỉ là quãng thuận lợi đã xuất hiện trước exit của V7, không phải R đã chốt và không chứng minh có thể giữ lệnh tới đó.");
}

main().catch((error) => {
  console.error("Lỗi phân tích phần đuôi R:", error?.response?.data ?? error);
  process.exitCode = 1;
});
