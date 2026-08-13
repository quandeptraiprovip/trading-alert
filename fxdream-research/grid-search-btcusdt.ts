/**
 * fxdream-research/grid-search-btcusdt.ts
 *
 * Script tìm kiếm tham số tối ưu (Grid Search & Parameter Optimization)
 * cho phương pháp FX Dream Trading trên BTCUSDT Binance Futures 365 ngày.
 *
 * Mục tiêu: Tìm các tổ hợp tham số giúp Net R dương và tối đa hóa Profit Factor.
 */

import "../load-env";
import { fetchKlinesPaged } from "../kline-fetch";
import { aggregate } from "../strategy";
import { DEFAULT_FXDREAM_PARAMS, FXDreamParams } from "./strategy-engine";
import { runFXDreamBacktest, BacktestSummary } from "./backtest-runner";

async function main() {
  const symbol = "BTCUSDT";
  const days = 365;
  const totalBars5m = days * 288;

  console.log(`================================================================`);
  console.log(` GRID SEARCH TÌM THAM SỐ NET R DƯƠNG — BTCUSDT BINANCE FUTURES`);
  console.log(`================================================================\n`);

  console.log(`[1/2] Đang nạp dữ liệu 365 ngày nến 5m...`);
  const c5m = await fetchKlinesPaged(symbol, "5m", totalBars5m, "futures");
  const c15m = aggregate(c5m, "15m", "5m");
  const c1h = aggregate(c5m, "1h", "5m");
  const c4h = aggregate(c5m, "4h", "5m");
  const c1d = aggregate(c5m, "1d", "5m");

  console.log(` -> Đã nạp thành công ${c5m.length} nến 5m.`);

  console.log(`\n[2/2] Đang quét grid search trên 36 tổ hợp tham số...`);

  // Define parameter grid
  const volumeSpikeMults = [2.0, 2.5, 3.0];
  const obPullbackFractions = [0.2, 0.5, 0.7]; // Độ sâu khớp Limit tại OB
  const minRRs = [2.5, 3.0, 4.0];
  const targetModes: ("structural-rr" | "fixed-r")[] = ["structural-rr", "fixed-r"];
  const fixedTargetRs = [4.0, 6.0];
  const minKeyReactionsList = [1, 2];

  const gridResults: { name: string; params: FXDreamParams; summary: BacktestSummary }[] = [];

  let count = 0;
  for (const volSpike of volumeSpikeMults) {
    for (const obFrac of obPullbackFractions) {
      for (const minRR of minRRs) {
        for (const tMode of targetModes) {
          const tRs = tMode === "fixed-r" ? fixedTargetRs : [5.0];
          for (const tR of tRs) {
            for (const minReact of minKeyReactionsList) {
              count++;
              const testParams: FXDreamParams = {
                ...DEFAULT_FXDREAM_PARAMS,
                volumeSpikeMult: volSpike,
                obPullbackFraction: obFrac,
                minRR: minRR,
                targetMode: tMode,
                fixedTargetR: tR,
                minKeyReactions: minReact,
                executionType: "limit-maker",
                entryTrigger: "sfp-pattern",
                stopMode: "sfp-wick",
                requireDailyTrapGate: true,
                requireFollowThrough: true,
              };

              const name = `VolSpike:${volSpike}x | OB:${(obFrac * 100)}% | React:${minReact} | Target:${tMode === "fixed-r" ? `${tR}R` : "Structure"}`;
              const summary = runFXDreamBacktest(symbol, c5m, c15m, c1h, c4h, c1d, testParams);
              gridResults.push({ name, params: testParams, summary });
            }
          }
        }
      }
    }
  }

  // Sort results by Net R descending
  gridResults.sort((a, b) => b.summary.netR - a.summary.netR);

  console.log(`\n========================================================================================================`);
  console.log(`                             TOP 10 CẤU HÌNH TỐI ƯU CHO NET R TRÊN BTCUSDT`);
  console.log(`========================================================================================================`);
  console.log(
    `| ${"Cấu Hình / Tham Số".padEnd(52)} | ${"Lệnh".padStart(5)} | ${"WinRate".padStart(8)} | ${"Gross R".padStart(9)} | ${"Phí R".padStart(8)} | ${"Net R".padStart(9)} | ${"PF".padStart(6)} |`
  );
  console.log(`--------------------------------------------------------------------------------------------------------`);

  for (let i = 0; i < Math.min(10, gridResults.length); i++) {
    const r = gridResults[i];
    const s = r.summary;
    const wrStr = `${s.winRate.toFixed(1)}%`;
    const grossStr = `${s.grossR >= 0 ? "+" : ""}${s.grossR.toFixed(1)}R`;
    const costStr = `-${s.costR.toFixed(1)}R`;
    const netStr = `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R`;
    const pfStr = s.profitFactor.toFixed(2);

    console.log(
      `| ${r.name.padEnd(52)} | ${s.totalTrades.toString().padStart(5)} | ${wrStr.padStart(8)} | ${grossStr.padStart(9)} | ${costStr.padStart(8)} | ${netStr.padStart(9)} | ${pfStr.padStart(6)} |`
    );
  }
  console.log(`========================================================================================================\n`);

  const top1 = gridResults[0];
  console.log(`>>> CẤU HÌNH TỐT NHẤT TÌM THẤY:`);
  console.log(`    Tham số: ${top1.name}`);
  console.log(`    Tổng số lệnh: ${top1.summary.totalTrades}`);
  console.log(`    Win Rate: ${top1.summary.winRate.toFixed(1)}%`);
  console.log(`    Gross R: +${top1.summary.grossR.toFixed(1)}R`);
  console.log(`    Phí R: -${top1.summary.costR.toFixed(1)}R`);
  console.log(`    Net R: ${top1.summary.netR >= 0 ? "+" : ""}${top1.summary.netR.toFixed(1)}R`);
  console.log(`    Expectancy/Lệnh: ${top1.summary.expectancy >= 0 ? "+" : ""}${top1.summary.expectancy.toFixed(2)}R`);
  console.log(`    Profit Factor: ${top1.summary.profitFactor.toFixed(2)}`);
}

main().catch((err) => {
  console.error("Lỗi grid search:", err);
  process.exit(1);
});
