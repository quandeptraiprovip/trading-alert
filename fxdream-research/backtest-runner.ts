/**
 * fxdream-research/backtest-runner.ts
 *
 * Engine simulation & backtest chuyên biệt cho FX Dream Trading trên Binance Futures.
 * Mô hình hoá chính xác lệnh Limit (Maker) vs Market (Taker), trượt giá, đòn bẩy cap,
 * chốt lời từng phần 1/2 tại 2R, dời SL hòa vốn, trailing stop, và luật cắt lệnh sớm.
 */

import { Candle, TF_MS, findSwings } from "../strategy";
import {
  FXDreamParams,
  SignalPlan,
  TradeResult,
  findKeyVolumeLevels,
  evaluateDailyContext,
  detectSFPSignals,
  buildSignalPlan,
  calculateATR,
} from "./strategy-engine";

export interface BacktestSummary {
  symbol: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossR: number;
  costR: number;
  netR: number;
  expectancy: number; // Net R per trade
  profitFactor: number;
  maxDrawdownR: number;
  avgHoldHours: number;
  limitFillRate: number;
  earlyExitCount: number;
  trades: TradeResult[];
}

/**
 * Chạy backtest chiến lược FX Dream trên rổ dữ liệu nến đa khung thời gian.
 */
export function runFXDreamBacktest(
  symbol: string,
  c5m: Candle[],
  c15m: Candle[],
  c1h: Candle[],
  c4h: Candle[],
  c1d: Candle[],
  params: FXDreamParams
): BacktestSummary {
  const trades: TradeResult[] = [];
  if (c5m.length < 500 || c15m.length < 200 || c1h.length < 100) {
    return createEmptySummary(symbol);
  }

  // 1. Pre-calculate Key Volume Levels on H1 and H4
  const allKeys = findKeyVolumeLevels(c1h, c4h, params);

  // Active Pending Signals
  let pendingPlan: SignalPlan | null = null;

  // Active Position State
  let activePosition: {
    plan: SignalPlan;
    entryTime: number;
    entryPrice: number;
    currentSL: number;
    targetPrice: number;
    partialTaken: boolean;
    entryBar5mIdx: number;
    highestPrice: number;
    lowestPrice: number;
  } | null = null;

  let totalLimitOrders = 0;
  let filledLimitOrders = 0;
  let earlyExitCount = 0;

  // Cooldown tracker
  let cooldownUntil5m = 0;

  // Align timestamps
  const start5mIdx = 200;
  for (let i = start5mIdx; i < c5m.length; i++) {
    const bar5m = c5m[i];
    const nowTime = bar5m.openTime;

    if (nowTime < cooldownUntil5m) continue;

    // ─────────────────────────────────────────────
    // A. POSITION MANAGEMENT (If Position is Active)
    // ─────────────────────────────────────────────
    if (activePosition) {
      const pos = activePosition;
      const holdBars5m = i - pos.entryBar5mIdx;
      const riskDist = Math.abs(pos.entryPrice - pos.plan.initialSL);

      // Track peak prices
      if (bar5m.high > pos.highestPrice) pos.highestPrice = bar5m.high;
      if (bar5m.low < pos.lowestPrice) pos.lowestPrice = bar5m.low;

      let isClosed = false;
      let exitPrice = 0;
      let exitReason: TradeResult["exitReason"] = "STOP_LOSS";
      let grossR = 0;

      if (pos.plan.dir === "long") {
        const currentGainR = (bar5m.high - pos.entryPrice) / riskDist;

        // 1. Partial TP at 2R & Move SL to Breakeven
        if (!pos.partialTaken && currentGainR >= params.partialAtR) {
          pos.partialTaken = true;
          pos.currentSL = Math.max(pos.currentSL, pos.entryPrice); // Move SL to BE
        }

        // 2. Trailing SL on Swings (H1 or 5m) if enabled
        if (params.trailMode !== "none" && pos.partialTaken && i > pos.entryBar5mIdx + 12) {
          if (params.trailMode === "h1-swing") {
            const valid1h = c1h.filter((c) => c.openTime + TF_MS["1h"] <= nowTime);
            const swings1h = findSwings(valid1h.slice(-24), 2, 2);
            const lowSwings = swings1h.filter((s) => s.type === "low");
            if (lowSwings.length > 0) {
              const lastLow = lowSwings[lowSwings.length - 1].price;
              if (lastLow > pos.currentSL) pos.currentSL = lastLow;
            }
          } else if (params.trailMode === "m5-swing") {
            const recent5m = c5m.slice(Math.max(0, i - 24), i + 1);
            const swings5m = findSwings(recent5m, 2, 2);
            const lowSwings = swings5m.filter((s) => s.type === "low");
            if (lowSwings.length > 0) {
              const lastLow = lowSwings[lowSwings.length - 1].price;
              if (lastLow > pos.currentSL) pos.currentSL = lastLow;
            }
          }
        }

        // 3. Early Exit check ("Không sập/bật liền là bỏ")
        if (
          params.requireFollowThrough &&
          !pos.partialTaken &&
          holdBars5m >= params.followThroughBars * 3 // M15 bars converted to 5m
        ) {
          const mfeR = (pos.highestPrice - pos.entryPrice) / riskDist;
          if (mfeR < params.minFollowThroughR) {
            isClosed = true;
            exitPrice = bar5m.close;
            exitReason = "EARLY_EXIT_BE";
            grossR = (exitPrice - pos.entryPrice) / riskDist;
            earlyExitCount++;
          }
        }

        // 4. Invalidation Exit (close back below Key Level)
        if (!isClosed && bar5m.close < pos.plan.sfpEvent.keyLevel.price * 0.999) {
          isClosed = true;
          exitPrice = bar5m.close;
          exitReason = "EARLY_EXIT_INVALID";
          grossR = (exitPrice - pos.entryPrice) / riskDist;
          earlyExitCount++;
        }

        // 5. Full Target Hit (TP)
        if (!isClosed && bar5m.high >= pos.targetPrice) {
          isClosed = true;
          exitPrice = pos.targetPrice;
          exitReason = pos.partialTaken ? "TP_PARTIAL_TRAIL" : "TP_FULL";
          const fullR = (exitPrice - pos.entryPrice) / riskDist;
          grossR = pos.partialTaken
            ? params.partialAtR * params.partialFraction + fullR * (1 - params.partialFraction)
            : fullR;
        }

        // 6. Stop Loss Hit
        if (!isClosed && bar5m.low <= pos.currentSL) {
          isClosed = true;
          exitPrice = pos.currentSL;
          exitReason = "STOP_LOSS";
          const slR = (exitPrice - pos.entryPrice) / riskDist;
          grossR = pos.partialTaken
            ? params.partialAtR * params.partialFraction + slR * (1 - params.partialFraction)
            : slR;
        }
      } else {
        // SHORT POSITION
        const currentGainR = (pos.entryPrice - bar5m.low) / riskDist;

        // 1. Partial TP at 2R & Move SL to Breakeven
        if (!pos.partialTaken && currentGainR >= params.partialAtR) {
          pos.partialTaken = true;
          pos.currentSL = Math.min(pos.currentSL, pos.entryPrice); // Move SL to BE
        }

        // 2. Trailing SL on Swings (H1 or 5m)
        if (params.trailMode !== "none" && pos.partialTaken && i > pos.entryBar5mIdx + 12) {
          if (params.trailMode === "h1-swing") {
            const valid1h = c1h.filter((c) => c.openTime + TF_MS["1h"] <= nowTime);
            const swings1h = findSwings(valid1h.slice(-24), 2, 2);
            const highSwings = swings1h.filter((s) => s.type === "high");
            if (highSwings.length > 0) {
              const lastHigh = highSwings[highSwings.length - 1].price;
              if (lastHigh < pos.currentSL) pos.currentSL = lastHigh;
            }
          } else if (params.trailMode === "m5-swing") {
            const recent5m = c5m.slice(Math.max(0, i - 24), i + 1);
            const swings5m = findSwings(recent5m, 2, 2);
            const highSwings = swings5m.filter((s) => s.type === "high");
            if (highSwings.length > 0) {
              const lastHigh = highSwings[highSwings.length - 1].price;
              if (lastHigh < pos.currentSL) pos.currentSL = lastHigh;
            }
          }
        }

        // 3. Early Exit check
        if (
          params.requireFollowThrough &&
          !pos.partialTaken &&
          holdBars5m >= params.followThroughBars * 3
        ) {
          const mfeR = (pos.entryPrice - pos.lowestPrice) / riskDist;
          if (mfeR < params.minFollowThroughR) {
            isClosed = true;
            exitPrice = bar5m.close;
            exitReason = "EARLY_EXIT_BE";
            grossR = (pos.entryPrice - exitPrice) / riskDist;
            earlyExitCount++;
          }
        }

        // 4. Invalidation Exit
        if (!isClosed && bar5m.close > pos.plan.sfpEvent.keyLevel.price * 1.001) {
          isClosed = true;
          exitPrice = bar5m.close;
          exitReason = "EARLY_EXIT_INVALID";
          grossR = (pos.entryPrice - exitPrice) / riskDist;
          earlyExitCount++;
        }

        // 5. Full Target Hit (TP)
        if (!isClosed && bar5m.low <= pos.targetPrice) {
          isClosed = true;
          exitPrice = pos.targetPrice;
          exitReason = pos.partialTaken ? "TP_PARTIAL_TRAIL" : "TP_FULL";
          const fullR = (pos.entryPrice - exitPrice) / riskDist;
          grossR = pos.partialTaken
            ? params.partialAtR * params.partialFraction + fullR * (1 - params.partialFraction)
            : fullR;
        }

        // 6. Stop Loss Hit
        if (!isClosed && bar5m.high >= pos.currentSL) {
          isClosed = true;
          exitPrice = pos.currentSL;
          exitReason = "STOP_LOSS";
          const slR = (pos.entryPrice - exitPrice) / riskDist;
          grossR = pos.partialTaken
            ? params.partialAtR * params.partialFraction + slR * (1 - params.partialFraction)
            : slR;
        }
      }

      // Record Closed Trade
      if (isClosed) {
        // Calculate Fee Costs in R terms
        const stopPct = riskDist / pos.entryPrice;
        const riskBudget = params.riskPct / 100;
        const leverageScale = Math.min(1, (params.maxLeverage * stopPct) / riskBudget);

        const feeEntryRate =
          pos.plan.executionType === "limit-maker"
            ? params.makerFeeRate
            : params.takerFeeRate + params.slippageRate;
        const feeExitRate =
          exitReason.startsWith("TP")
            ? params.makerFeeRate
            : params.takerFeeRate + params.slippageRate;

        const totalFeePct = feeEntryRate + feeExitRate;
        const costR = (totalFeePct / stopPct) * leverageScale;
        const scaledGrossR = grossR * leverageScale;
        const netR = scaledGrossR - costR;

        const maxR =
          pos.plan.dir === "long"
            ? (pos.highestPrice - pos.entryPrice) / riskDist
            : (pos.entryPrice - pos.lowestPrice) / riskDist;

        trades.push({
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
          executionType: pos.plan.executionType,
        });

        activePosition = null;
        cooldownUntil5m = nowTime + 6 * TF_MS["15m"]; // Cooldown 1.5h before next setup
      }
      continue;
    }

    // ─────────────────────────────────────────────
    // B. ORDER FILL CHECK (If Pending Plan Exists)
    // ─────────────────────────────────────────────
    if (pendingPlan) {
      if (nowTime > pendingPlan.expiryTime) {
        pendingPlan = null; // Plan expired unfilled
      } else {
        let isFilled = false;
        let fillPrice = pendingPlan.entryPrice;

        if (pendingPlan.executionType === "limit-maker") {
          totalLimitOrders++;
          if (pendingPlan.dir === "long" && bar5m.low <= pendingPlan.entryPrice) {
            isFilled = true;
            filledLimitOrders++;
          } else if (pendingPlan.dir === "short" && bar5m.high >= pendingPlan.entryPrice) {
            isFilled = true;
            filledLimitOrders++;
          }
        } else {
          // Market execution fills immediately at next bar open
          isFilled = true;
          fillPrice = bar5m.open;
        }

        if (isFilled) {
          activePosition = {
            plan: pendingPlan,
            entryTime: nowTime,
            entryPrice: fillPrice,
            currentSL: pendingPlan.initialSL,
            targetPrice: pendingPlan.targetPrice,
            partialTaken: false,
            entryBar5mIdx: i,
            highestPrice: fillPrice,
            lowestPrice: fillPrice,
          };
          pendingPlan = null;
          continue;
        }
      }
    }

    // ─────────────────────────────────────────────
    // C. SIGNAL GENERATION (On M15 Bar Boundaries)
    // ─────────────────────────────────────────────
    if (nowTime % TF_MS["15m"] === 0) {
      const valid15m = c15m.filter((c) => c.openTime + TF_MS["15m"] <= nowTime);
      const validDaily = c1d.filter((c) => c.openTime + TF_MS["1d"] <= nowTime);

      if (valid15m.length < 50) continue;

      // 1. Evaluate Daily Bias & Trap Gate (#31)
      const dailyCtx = evaluateDailyContext(validDaily, nowTime, params);
      if (params.requireDailyTrapGate && !dailyCtx.trapGatePassed) continue;

      // 2. Filter Active Valid Keys
      const validKeys = allKeys.filter(
        (k) =>
          k.originTime <= nowTime &&
          nowTime - k.originTime <= params.keyMaxAgeDays * TF_MS["1d"]
      );
      if (validKeys.length === 0) continue;

      // 3. Detect SFP Events
      const sfpEvents = detectSFPSignals(valid15m, validKeys, dailyCtx, params);

      if (sfpEvents.length > 0) {
        const latestEvent = sfpEvents[sfpEvents.length - 1];

        // Find opposing structural price for target calculation
        const h1Valid = c1h.filter((c) => c.openTime + TF_MS["1h"] <= nowTime);
        const swings = findSwings(h1Valid.slice(-60), 3, 3);
        let opposingTarget: number | null = null;

        if (latestEvent.dir === "long") {
          const highSwings = swings.filter((s) => s.type === "high" && s.price > bar5m.close);
          if (highSwings.length > 0) opposingTarget = highSwings[0].price;
        } else {
          const lowSwings = swings.filter((s) => s.type === "low" && s.price < bar5m.close);
          if (lowSwings.length > 0) opposingTarget = lowSwings[0].price;
        }

        // Build Signal Plan
        const plan = buildSignalPlan(symbol, latestEvent, opposingTarget, params);
        if (plan) {
          pendingPlan = plan;
        }
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

  if (totalTrades === 0) {
    return createEmptySummary(symbol);
  }

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

  // Max Drawdown Calculation
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
