/**
 * fxdream-research/run-infinite-r-study.ts
 *
 * Mô Phỏng Mô Hình "TP VÔ CỰC & SIÊU R" (20R - 50R+ per winning trade)
 * Dữ liệu: 365 ngày nến 5m BTCUSDT Binance Futures.
 */

import "../load-env";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, aggregate, findSwings, TF_MS } from "../strategy";
import {
  INFINITE_R_PARAMS,
  FXDreamInfiniteRParams,
  findKeyVolumeLevelsInfiniteR,
  evaluateDailyContextInfiniteR,
  detectSFPSignalsInfiniteR,
  buildSignalPlanInfiniteR,
  SignalPlan,
  TradeResult,
} from "./strategy-engine-infinite-r";
import { BacktestSummary } from "./backtest-runner";

function runInfiniteRBacktest(
  symbol: string,
  c5m: Candle[],
  c15m: Candle[],
  c1h: Candle[],
  c4h: Candle[],
  c1d: Candle[],
  params: FXDreamInfiniteRParams
): BacktestSummary {
  const trades: TradeResult[] = [];
  if (c5m.length < 500 || c15m.length < 200 || c1h.length < 100) {
    return createEmptySummary(symbol);
  }

  const allKeys = findKeyVolumeLevelsInfiniteR(c1h, c4h, params);

  let pendingPlan: SignalPlan | null = null;
  let activePosition: {
    plan: SignalPlan;
    entryTime: number;
    entryPrice: number;
    currentSL: number;
    targetPrice: number;
    slMovedToBE: boolean;
    entryBar5mIdx: number;
    highestPrice: number;
    lowestPrice: number;
  } | null = null;

  let totalLimitOrders = 0;
  let filledLimitOrders = 0;
  let earlyExitCount = 0;
  let cooldownUntil5m = 0;

  const start5mIdx = 200;
  for (let i = start5mIdx; i < c5m.length; i++) {
    const bar5m = c5m[i];
    const nowTime = bar5m.openTime;

    if (nowTime < cooldownUntil5m) continue;

    // A. POSITION MANAGEMENT (SIÊU R & GỒNG 100% VỊ THẾ)
    if (activePosition) {
      const pos = activePosition;
      const holdBars5m = i - pos.entryBar5mIdx;
      const rawRiskDist = Math.abs(pos.entryPrice - pos.plan.initialSL);
      const riskDist = Math.max(pos.entryPrice * 0.0005, rawRiskDist);

      if (bar5m.high > pos.highestPrice) pos.highestPrice = bar5m.high;
      if (bar5m.low < pos.lowestPrice) pos.lowestPrice = bar5m.low;

      let isClosed = false;
      let exitPrice = 0;
      let exitReason: TradeResult["exitReason"] = "STOP_LOSS";
      let grossR = 0;

      if (pos.plan.dir === "long") {
        const currentGainR = (bar5m.high - pos.entryPrice) / riskDist;

        // 1. Move SL to Breakeven (BE) at 1.5R, but KEEP 100% position active!
        if (!pos.slMovedToBE && currentGainR >= params.moveBEAtR) {
          pos.slMovedToBE = true;
          pos.currentSL = Math.max(pos.currentSL, pos.entryPrice);
        }

        // 2. Trailing SL on H4 Swings for Ultra-High R Runners
        if (params.trailMode === "h4-swing" && pos.slMovedToBE && i > pos.entryBar5mIdx + 48) {
          const valid4h = c4h.filter((c) => c.openTime + TF_MS["4h"] <= nowTime);
          const swings4h = findSwings(valid4h.slice(-20), 2, 2);
          const lowSwings = swings4h.filter((s) => s.type === "low");
          if (lowSwings.length > 0) {
            const lastLow = lowSwings[lowSwings.length - 1].price;
            if (lastLow > pos.currentSL) pos.currentSL = lastLow;
          }
        }

        // 3. Early Exit check ("không chạy liền là bỏ")
        if (
          params.requireFollowThrough &&
          !pos.slMovedToBE &&
          holdBars5m >= params.followThroughBars * 3
        ) {
          const mfeR = (pos.highestPrice - pos.entryPrice) / riskDist;
          if (mfeR < 0.5) {
            isClosed = true;
            exitPrice = bar5m.close;
            exitReason = "EARLY_EXIT_BE";
            grossR = (exitPrice - pos.entryPrice) / riskDist;
            earlyExitCount++;
          }
        }

        // 4. Hit Full Target (50R+)
        if (!isClosed && bar5m.high >= pos.targetPrice) {
          isClosed = true;
          exitPrice = pos.targetPrice;
          exitReason = "TP_FULL";
          grossR = (exitPrice - pos.entryPrice) / riskDist; // 100% position gets full R!
        }

        // 5. Stop Loss / Trailing Stop Hit
        if (!isClosed && bar5m.low <= pos.currentSL) {
          isClosed = true;
          exitPrice = pos.currentSL;
          exitReason = "STOP_LOSS";
          grossR = (exitPrice - pos.entryPrice) / riskDist;
        }
      } else {
        // SHORT POSITION
        const currentGainR = (pos.entryPrice - bar5m.low) / riskDist;

        if (!pos.slMovedToBE && currentGainR >= params.moveBEAtR) {
          pos.slMovedToBE = true;
          pos.currentSL = Math.min(pos.currentSL, pos.entryPrice);
        }

        if (params.trailMode === "h4-swing" && pos.slMovedToBE && i > pos.entryBar5mIdx + 48) {
          const valid4h = c4h.filter((c) => c.openTime + TF_MS["4h"] <= nowTime);
          const swings4h = findSwings(valid4h.slice(-20), 2, 2);
          const highSwings = swings4h.filter((s) => s.type === "high");
          if (highSwings.length > 0) {
            const lastHigh = highSwings[highSwings.length - 1].price;
            if (lastHigh < pos.currentSL) pos.currentSL = lastHigh;
          }
        }

        if (
          params.requireFollowThrough &&
          !pos.slMovedToBE &&
          holdBars5m >= params.followThroughBars * 3
        ) {
          const mfeR = (pos.entryPrice - pos.lowestPrice) / riskDist;
          if (mfeR < 0.5) {
            isClosed = true;
            exitPrice = bar5m.close;
            exitReason = "EARLY_EXIT_BE";
            grossR = (pos.entryPrice - exitPrice) / riskDist;
            earlyExitCount++;
          }
        }

        if (!isClosed && bar5m.low <= pos.targetPrice) {
          isClosed = true;
          exitPrice = pos.targetPrice;
          exitReason = "TP_FULL";
          grossR = (pos.entryPrice - exitPrice) / riskDist;
        }

        if (!isClosed && bar5m.high >= pos.currentSL) {
          isClosed = true;
          exitPrice = pos.currentSL;
          exitReason = "STOP_LOSS";
          grossR = (pos.entryPrice - exitPrice) / riskDist;
        }
      }

      if (isClosed) {
        const stopPct = riskDist / pos.entryPrice;
        const riskBudget = params.riskPct / 100;
        const leverageScale = Math.min(1, (params.maxLeverage * stopPct) / riskBudget);

        const feeEntryRate = params.makerFeeRate;
        const feeExitRate = exitReason.startsWith("TP") ? params.makerFeeRate : params.takerFeeRate;

        const totalFeePct = feeEntryRate + feeExitRate;
        const costR = (totalFeePct / stopPct) * leverageScale;
        const scaledGrossR = grossR * leverageScale;
        const netR = scaledGrossR - costR;

        const maxR =
          pos.plan.dir === "long"
            ? (pos.highestPrice - pos.entryPrice) / riskDist
            : (pos.entryPrice - pos.lowestPrice) / riskDist;

        const t: TradeResult = {
          id: `trade-${trades.length + 1}`,
          symbol,
          dir: pos.plan.dir,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          initialSL: pos.plan.initialSL,
          targetPrice: pos.targetPrice,
          exitTime: nowTime,
          exitPrice,
          exitReason,
          grossR: scaledGrossR,
          costR,
          netR,
          maxR: maxR * leverageScale,
          holdBars5m,
        };
        trades.push(t);
        if (trades.length === 1) {
          console.log("[Debug Trade 1]:", t);
        }

        activePosition = null;
        cooldownUntil5m = nowTime + 6 * TF_MS["15m"];
      }
      continue;
    }

    // B. ORDER FILL CHECK
    if (pendingPlan) {
      if (nowTime > pendingPlan.expiryTime) {
        pendingPlan = null;
      } else {
        totalLimitOrders++;
        let isFilled = false;
        if (pendingPlan.dir === "long" && bar5m.low <= pendingPlan.entryPrice) {
          isFilled = true;
          filledLimitOrders++;
        } else if (pendingPlan.dir === "short" && bar5m.high >= pendingPlan.entryPrice) {
          isFilled = true;
          filledLimitOrders++;
        }

        if (isFilled) {
          activePosition = {
            plan: pendingPlan,
            entryTime: nowTime,
            entryPrice: pendingPlan.entryPrice,
            currentSL: pendingPlan.initialSL,
            targetPrice: pendingPlan.targetPrice,
            slMovedToBE: false,
            entryBar5mIdx: i,
            highestPrice: pendingPlan.entryPrice,
            lowestPrice: pendingPlan.entryPrice,
          };
          pendingPlan = null;
          continue;
        }
      }
    }

    // C. SIGNAL GENERATION
    if (nowTime % TF_MS["15m"] === 0) {
      const valid15m = c15m.filter((c) => c.openTime + TF_MS["15m"] <= nowTime);
      const validDaily = c1d.filter((c) => c.openTime + TF_MS["1d"] <= nowTime);

      if (valid15m.length < 50) continue;

      const dailyCtx = evaluateDailyContextInfiniteR(validDaily, nowTime, params);
      const sfpEvents = detectSFPSignalsInfiniteR(valid15m, allKeys, dailyCtx, params);

      if (sfpEvents.length > 0) {
        const latestEvent = sfpEvents[sfpEvents.length - 1];

        const h4Valid = c4h.filter((c) => c.openTime + TF_MS["4h"] <= nowTime);
        const swings = findSwings(h4Valid.slice(-60), 2, 2);
        let opposingTarget: number | null = null;

        if (latestEvent.dir === "long") {
          const highSwings = swings.filter((s) => s.type === "high" && s.price > bar5m.close);
          if (highSwings.length > 0) opposingTarget = Math.max(...highSwings.map((s) => s.price));
        } else {
          const lowSwings = swings.filter((s) => s.type === "low" && s.price < bar5m.close);
          if (lowSwings.length > 0) opposingTarget = Math.min(...lowSwings.map((s) => s.price));
        }

        const plan = buildSignalPlanInfiniteR(symbol, latestEvent, opposingTarget, params);
        if (plan) pendingPlan = plan;
      }
    }
  }

  return summarizeBacktest(
    symbol,
    c5m[0].openTime,
    c5m[c5m.length - 1].openTime,
    trades,
    totalLimitOrders,
    filledLimitOrders,
    earlyExitCount
  );
}

function createEmptySummary(symbol: string): BacktestSummary {
  return {
    symbol,
    startDate: "N/A",
    endDate: "N/A",
    totalDays: 0,
    totalTrades: 0,
    longTrades: 0,
    shortTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossR: 0,
    costR: 0,
    netR: 0,
    expectancy: 0,
    profitFactor: 0,
    maxDrawdownR: 0,
    avgHoldHours: 0,
    limitFillRate: 0,
    earlyExitCount: 0,
    trades: [],
  };
}

function summarizeBacktest(
  symbol: string,
  startTime: number,
  endTime: number,
  trades: TradeResult[],
  totalLimitOrders: number,
  filledLimitOrders: number,
  earlyExitCount: number
): BacktestSummary {
  const totalDays = (endTime - startTime) / TF_MS["1d"];
  const totalTrades = trades.length;
  if (totalTrades === 0) return createEmptySummary(symbol);

  const longTrades = trades.filter((t) => t.dir === "long").length;
  const shortTrades = trades.filter((t) => t.dir === "short").length;
  const wins = trades.filter((t) => t.netR > 0).length;
  const losses = trades.filter((t) => t.netR <= 0).length;
  const winRate = (wins / totalTrades) * 100;

  const grossR = trades.reduce((sum, t) => sum + t.grossR, 0);
  const costR = trades.reduce((sum, t) => sum + t.costR, 0);
  const netR = grossR - costR;
  const expectancy = netR / totalTrades;

  const grossWins = trades.filter((t) => t.grossR > 0).reduce((sum, t) => sum + t.grossR, 0);
  const grossLosses = Math.abs(
    trades.filter((t) => t.grossR <= 0).reduce((sum, t) => sum + t.grossR, 0)
  );
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;

  let peak = 0;
  let cumNetR = 0;
  let maxDrawdownR = 0;
  for (const t of trades) {
    cumNetR += t.netR;
    if (cumNetR > peak) peak = cumNetR;
    const dd = peak - cumNetR;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  const avgHoldHours =
    trades.reduce((sum, t) => sum + (t.holdBars5m * 5) / 60, 0) / totalTrades;
  const limitFillRate =
    totalLimitOrders > 0 ? (filledLimitOrders / totalLimitOrders) * 100 : 100;

  return {
    symbol,
    startDate: new Date(startTime).toISOString().split("T")[0],
    endDate: new Date(endTime).toISOString().split("T")[0],
    totalDays,
    totalTrades,
    longTrades,
    shortTrades,
    wins,
    losses,
    winRate,
    grossR,
    costR,
    netR,
    expectancy,
    profitFactor,
    maxDrawdownR,
    avgHoldHours,
    limitFillRate,
    earlyExitCount,
    trades,
  };
}

async function main() {
  const symbol = "BTCUSDT";
  const days = 365;
  const totalBars5m = days * 288;

  console.log(`================================================================`);
  console.log(` MÔ PHỎNG CHIẾN LƯỢC TP VÔ CỰC & SIÊU R (20R - 50R+) ON BTCUSDT`);
  console.log(`================================================================\n`);

  console.log(`[1/2] Đang tải 365 ngày dữ liệu nến BTCUSDT từ Binance Futures...`);
  const c5m = await fetchKlinesPaged(symbol, "5m", totalBars5m, "futures");
  const c15m = aggregate(c5m, "15m", "5m");
  const c1h = aggregate(c5m, "1h", "5m");
  const c4h = aggregate(c5m, "4h", "5m");
  const c1d = aggregate(c5m, "1d", "5m");

  console.log(` -> Đã tải thành công ${c5m.length} nến 5m.`);

  console.log(`\n[2/2] Đang chạy mô phỏng TP Vô Cực...`);

  // Model 1: Standard Binance Futures Fee
  const summaryStd = runInfiniteRBacktest(symbol, c5m, c15m, c1h, c4h, c1d, INFINITE_R_PARAMS);

  // Model 2: Low-Fee Venue (Vàng / Forex / Zero Maker Fee Tier)
  const lowFeeParams: FXDreamInfiniteRParams = {
    ...INFINITE_R_PARAMS,
    makerFeeRate: 0.0001,
    takerFeeRate: 0.0001,
    slippageRate: 0.0,
  };
  const summaryLowFee = runInfiniteRBacktest(symbol, c5m, c15m, c1h, c4h, c1d, lowFeeParams);

  console.log(`\n========================================================================================================`);
  console.log(`           BẢNG KẾT QUẢ MÔ PHỎNG CHIẾN LƯỢC TP VÔ CỰC & SIÊU R (20R - 50R+)`);
  console.log(`========================================================================================================`);
  console.log(
    `| ${"Kịch Bản Mô Phỏng".padEnd(45)} | ${"Lệnh".padStart(5)} | ${"WinRate".padStart(8)} | ${"Gross R".padStart(9)} | ${"Phí R".padStart(8)} | ${"Net R".padStart(9)} | ${"PF".padStart(6)} |`
  );
  console.log(`--------------------------------------------------------------------------------------------------------`);

  const printRow = (label: string, s: BacktestSummary) => {
    const wrStr = `${s.winRate.toFixed(1)}%`;
    const grossStr = `${s.grossR >= 0 ? "+" : ""}${s.grossR.toFixed(1)}R`;
    const costStr = `-${s.costR.toFixed(1)}R`;
    const netStr = `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R`;
    const pfStr = s.profitFactor.toFixed(2);
    console.log(
      `| ${label.padEnd(45)} | ${s.totalTrades.toString().padStart(5)} | ${wrStr.padStart(8)} | ${grossStr.padStart(9)} | ${costStr.padStart(8)} | ${netStr.padStart(9)} | ${pfStr.padStart(6)} |`
    );
  };

  printRow("TP Vô Cực (Binance Futures Phí Standard)", summaryStd);
  printRow("TP Vô Cực (Venue Phí Thấp / Vàng-Forex)", summaryLowFee);

  console.log(`========================================================================================================\n`);

  // Log top winning trades
  const topWins = [...summaryStd.trades].sort((a, b) => b.grossR - a.grossR).slice(0, 5);
  console.log(`>>> DANH SÁCH 5 KÈO THẮNG ĐỈNH CAO (SIÊU R MULTIPLIER):`);
  topWins.forEach((t, idx) => {
    console.log(
      ` ${idx + 1}. Trade ${t.id} (${t.dir.toUpperCase()}) | Lợi Nhuận Gộp: +${t.grossR.toFixed(1)}R | Max R: +${t.maxR.toFixed(1)}R | Hold: ${t.holdBars5m} bars 5m`
    );
  });
}

main().catch((err) => {
  console.error("Lỗi chạy Infinite R Study:", err);
  process.exit(1);
});
