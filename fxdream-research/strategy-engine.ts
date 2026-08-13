/**
 * fxdream-research/strategy-engine.ts
 *
 * Engine số hoá FX Dream Trading — Phiên bản Mô Phỏng Giao Dịch Tay (LiveTrader Engine).
 * Tích hợp 3 trụ cột của giao dịch tay thực tế:
 * 1. Hợp lưu H4 + H1 (Key Confluence) & Chọn lọc bối cảnh cao.
 * 2. Gồng lời R:R khung lớn H4/D1 (2R chốt 1/2 -> gồng 5R-20R theo swing H1).
 * 3. Khớp Limit tại OB (Maker fee) & Stop loss chuẩn cấu trúc.
 */

import { Candle, TF_MS, aggregate, findSwings, Swing } from "../strategy";

export type FXDreamDirection = "long" | "short";
export type ExecutionType = "limit-maker" | "market-taker";

export interface FXDreamParams {
  baseTf: "5m";
  confirmTf: "15m";
  keyTf: "1h";
  confluenceTf: "4h";
  dailyTf: "1d";

  // Volume & Key Confluence
  volumeLookback: number;
  volumeSpikeMult: number; // 2.0x
  minDisplacementAtr: number; // 1.2 ATR
  maxKeyMitigations: number; // 2
  keyMaxAgeDays: number;
  requireH4H1Confluence: boolean; // Bắt buộc hợp lưu H4 + H1

  // Sideway & Top-Down Bias
  requireTrendRegime: boolean;
  minDailyAdx: number;
  requireDailyTrapGate: boolean;
  dailyBiasBars: number;

  // SFP & Execution
  sfpLookbackBars: number;
  requireLiquidityPoolSweep: boolean;
  candlePatternRequired: boolean;
  obPullbackFraction: number; // 0.3

  // Risk & High R:R Runner Management
  riskPct: number;
  maxLeverage: number;
  minRR: number; // 3.0
  partialAtR: number; // 2.0R (Chốt 50%)
  partialFraction: number; // 0.5
  allowStructuralRunners: boolean; // Gồng lời 5R-20R tới cản H4/D1
  maxTargetR: number; // Trần target R gồng (vd: 15.0R)
  requireFollowThrough: boolean;
  followThroughBars: number;
  trailMode: "h1-swing" | "m5-swing" | "none"; // H1 Swing trailing cho runner

  // Fee Structure (Binance Futures Standard Limit Maker)
  makerFeeRate: number;
  takerFeeRate: number;
  slippageRate: number;
}

export const LIVE_TRADER_FXDREAM_PARAMS: FXDreamParams = {
  baseTf: "5m",
  confirmTf: "15m",
  keyTf: "1h",
  confluenceTf: "4h",
  dailyTf: "1d",

  volumeLookback: 96,
  volumeSpikeMult: 2.0,
  minDisplacementAtr: 1.2,
  maxKeyMitigations: 2,
  keyMaxAgeDays: 180,
  requireH4H1Confluence: true, // Trụ cột 1: Hợp lưu H4 + H1

  requireTrendRegime: false, // Tránh gate-stacking quá đà
  minDailyAdx: 15.0,
  requireDailyTrapGate: true, // Trụ cột 1: Daily Trap Gate (#31)
  dailyBiasBars: 3,

  sfpLookbackBars: 20,
  requireLiquidityPoolSweep: true,
  candlePatternRequired: true,
  obPullbackFraction: 0.3,

  riskPct: 1.0,
  maxLeverage: 10.0,
  minRR: 3.0,
  partialAtR: 2.0,
  partialFraction: 0.5,
  allowStructuralRunners: true, // Trụ cột 2: Gồng R:R khung lớn H4/D1 (5R - 15R)
  maxTargetR: 15.0,
  requireFollowThrough: true,
  followThroughBars: 6,
  trailMode: "h1-swing", // Trụ cột 2: Trailing H1 swing

  makerFeeRate: 0.0002, // Trụ cột 3: Maker fee 0.02%
  takerFeeRate: 0.0005,
  slippageRate: 0.0002,
};

export interface KeyLevel {
  id: string;
  price: number;
  type: "demand" | "supply";
  tf: "1h" | "4h";
  originTime: number;
  originIndex: number;
  volumeRatio: number;
  mitigations: number;
  isFresh: boolean;
  displacementAtr: number;
  isConfluent: boolean;
}

export interface SFPEvent {
  keyLevel: KeyLevel;
  dir: FXDreamDirection;
  sweepTime: number;
  sweepPrice: number;
  reclaimPrice: number;
  confirmTime: number;
  confirmClose: number;
  patternName: string;
  obHigh: number;
  obLow: number;
}

export interface SignalPlan {
  symbol: string;
  dir: FXDreamDirection;
  sfpEvent: SFPEvent;
  entryPrice: number;
  initialSL: number;
  targetPrice: number;
  targetR: number;
  riskPct: number;
  createdTime: number;
  expiryTime: number;
}

export interface TradeResult {
  id: string;
  symbol: string;
  dir: FXDreamDirection;
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  targetPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "TP_FULL" | "TP_PARTIAL_TRAIL" | "STOP_LOSS" | "EARLY_EXIT_BE" | "EARLY_EXIT_INVALID" | "EXPIRED";
  grossR: number;
  costR: number;
  netR: number;
  maxR: number;
  holdBars5m: number;
}

export function calculateATR(candles: Candle[], period = 14): number[] {
  const atr = new Array<number>(candles.length).fill(0);
  if (candles.length < 2) return atr;
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
    } else {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  let sum = 0;
  for (let i = 0; i < Math.min(period, tr.length); i++) sum += tr[i];
  atr[Math.min(period - 1, atr.length - 1)] = sum / Math.min(period, tr.length);
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

export function calculateADX(candles: Candle[], period = 14): number[] {
  const adx = new Array<number>(candles.length).fill(0);
  if (candles.length < period * 2) return adx;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(candles[i].high - candles[i].low);
    } else {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;

      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }

  let trSmooth = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSmooth = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSmooth = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx: number[] = [];
  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      trSmooth = trSmooth - trSmooth / period + tr[i];
      plusDMSmooth = plusDMSmooth - plusDMSmooth / period + plusDM[i];
      minusDMSmooth = minusDMSmooth - minusDMSmooth / period + minusDM[i];
    }
    const plusDI = (plusDMSmooth / trSmooth) * 100;
    const minusDI = (minusDMSmooth / trSmooth) * 100;
    const diSum = plusDI + minusDI;
    const dxVal = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dx.push(dxVal);
  }

  if (dx.length >= period) {
    let adxSmooth = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    adx[period * 2 - 1] = adxSmooth;
    for (let i = period; i < dx.length; i++) {
      adxSmooth = (adxSmooth * (period - 1) + dx[i]) / period;
      adx[period + i] = adxSmooth;
    }
  }

  return adx;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────────────────────────
// STRUCTURAL KEY VOLUME FINDER (WITH H4 + H1 CONFLUENCE)
// ─────────────────────────────────────────────

export function findKeyVolumeLevels(
  candlesH1: Candle[],
  candlesH4: Candle[],
  params: FXDreamParams
): KeyLevel[] {
  const levels: KeyLevel[] = [];
  if (candlesH1.length < params.volumeLookback + 15) return levels;

  const atrH1 = calculateATR(candlesH1, 14);
  const atrH4 = calculateATR(candlesH4, 14);

  // 1. Find H4 Key Levels
  const h4Levels: KeyLevel[] = [];
  for (let i = params.volumeLookback; i < candlesH4.length - 10; i++) {
    const windowVols = candlesH4.slice(i - params.volumeLookback, i).map((c) => c.volume);
    const medVol = median(windowVols);
    if (medVol <= 0) continue;

    const volRatio = candlesH4[i].volume / medVol;
    if (volRatio >= params.volumeSpikeMult) {
      const c = candlesH4[i];
      const curAtr = atrH4[i] || c.high - c.low;

      const future = candlesH4.slice(i + 1, Math.min(candlesH4.length, i + 12));
      if (future.length < 3) continue;

      const moveUp = Math.max(...future.map((f) => f.high)) - c.close;
      const moveDown = c.close - Math.min(...future.map((f) => f.low));

      if (moveUp / curAtr >= params.minDisplacementAtr) {
        h4Levels.push({
          id: `4h-demand-${c.openTime}`,
          price: c.low,
          type: "demand",
          tf: "4h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          mitigations: 0,
          isFresh: true,
          displacementAtr: moveUp / curAtr,
          isConfluent: true,
        });
      }

      if (moveDown / curAtr >= params.minDisplacementAtr) {
        h4Levels.push({
          id: `4h-supply-${c.openTime}`,
          price: c.high,
          type: "supply",
          tf: "4h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          mitigations: 0,
          isFresh: true,
          displacementAtr: moveDown / curAtr,
          isConfluent: true,
        });
      }
    }
  }

  // 2. Find H1 Key Levels and check Confluence with H4
  for (let i = params.volumeLookback; i < candlesH1.length - 10; i++) {
    const windowVols = candlesH1.slice(i - params.volumeLookback, i).map((c) => c.volume);
    const medVol = median(windowVols);
    if (medVol <= 0) continue;

    const volRatio = candlesH1[i].volume / medVol;
    if (volRatio >= params.volumeSpikeMult) {
      const c = candlesH1[i];
      const curAtr = atrH1[i] || c.high - c.low;

      const future = candlesH1.slice(i + 1, Math.min(candlesH1.length, i + 12));
      if (future.length < 3) continue;

      const moveUp = Math.max(...future.map((f) => f.high)) - c.close;
      const moveDown = c.close - Math.min(...future.map((f) => f.low));

      const isDemand = moveUp / curAtr >= params.minDisplacementAtr;
      const isSupply = moveDown / curAtr >= params.minDisplacementAtr;

      if (!isDemand && !isSupply) continue;

      const levelPrice = isDemand ? c.low : c.high;
      const levelType = isDemand ? "demand" : "supply";

      // Confluence check with H4 levels (Tolerance 1.5 ATR H1)
      const isConfluent = h4Levels.some(
        (h4) => h4.type === levelType && Math.abs(h4.price - levelPrice) <= curAtr * 1.5
      );

      if (params.requireH4H1Confluence && !isConfluent) continue;

      levels.push({
        id: `1h-${levelType}-${c.openTime}`,
        price: levelPrice,
        type: levelType,
        tf: "1h",
        originTime: c.openTime,
        originIndex: i,
        volumeRatio: volRatio,
        mitigations: 0,
        isFresh: true,
        displacementAtr: isDemand ? moveUp / curAtr : moveDown / curAtr,
        isConfluent,
      });
    }
  }

  return [...levels, ...h4Levels];
}

// ─────────────────────────────────────────────
// DAILY CONTEXT, ADX REGIME & TRAP GATE (#31)
// ─────────────────────────────────────────────

export interface DailyContext {
  bias: "long" | "short" | "neutral";
  trapGatePassed: boolean;
  isTrendingRegime: boolean;
}

export function evaluateDailyContext(
  dailyCandles: Candle[],
  currentIndexTime: number,
  params: FXDreamParams
): DailyContext {
  const validDaily = dailyCandles.filter((c) => c.openTime + TF_MS["1d"] <= currentIndexTime);
  if (validDaily.length < params.dailyBiasBars + 14) {
    return { bias: "neutral", trapGatePassed: true, isTrendingRegime: true };
  }

  let isTrendingRegime = true;
  if (params.requireTrendRegime) {
    const adxValues = calculateADX(validDaily, 14);
    const lastAdx = adxValues[adxValues.length - 1] || 0;
    isTrendingRegime = lastAdx >= params.minDailyAdx;
  }

  const lastBars = validDaily.slice(-params.dailyBiasBars);
  const greenCount = lastBars.filter((c) => c.close > c.open).length;
  const redCount = lastBars.filter((c) => c.close < c.open).length;

  let bias: "long" | "short" | "neutral" = "neutral";
  if (greenCount >= params.dailyBiasBars - 1) bias = "long";
  else if (redCount >= params.dailyBiasBars - 1) bias = "short";

  if (!params.requireDailyTrapGate) {
    return { bias, trapGatePassed: true, isTrendingRegime };
  }

  const prevBar = validDaily[validDaily.length - 1];
  const anteBar = validDaily[validDaily.length - 2];

  let trapGatePassed = false;
  if (bias === "long") {
    const wickedLow = prevBar.low < anteBar.low && prevBar.close > anteBar.low;
    trapGatePassed = wickedLow || prevBar.close > anteBar.high;
  } else if (bias === "short") {
    const wickedHigh = prevBar.high > anteBar.high && prevBar.close < anteBar.high;
    trapGatePassed = wickedHigh || prevBar.close < anteBar.low;
  } else {
    trapGatePassed = true;
  }

  return { bias, trapGatePassed, isTrendingRegime };
}

// ─────────────────────────────────────────────
// SFP & LIQUIDITY POOL SWEEP DETECTION
// ─────────────────────────────────────────────

export function detectSFPSignals(
  m15Candles: Candle[],
  keyLevels: KeyLevel[],
  dailyContext: DailyContext,
  params: FXDreamParams
): SFPEvent[] {
  const events: SFPEvent[] = [];
  if (m15Candles.length < params.sfpLookbackBars + 5) return events;

  if (params.requireTrendRegime && !dailyContext.isTrendingRegime) {
    return events;
  }

  const lastIdx = m15Candles.length - 1;
  const cCurr = m15Candles[lastIdx];
  const cPrev = m15Candles[lastIdx - 1];
  const cAnte = m15Candles[lastIdx - 2];

  const atr = calculateATR(m15Candles, 14)[lastIdx] || (cCurr.high - cCurr.low);
  const swings = findSwings(m15Candles.slice(Math.max(0, lastIdx - 40), lastIdx), 2, 2);

  for (const key of keyLevels) {
    if (!key.isFresh || key.mitigations >= params.maxKeyMitigations) continue;

    if (params.requireDailyTrapGate) {
      if (key.type === "demand" && dailyContext.bias === "short") continue;
      if (key.type === "supply" && dailyContext.bias === "long") continue;
    }

    const distToKey = Math.abs(cCurr.close - key.price);
    if (distToKey > atr * 3.0) continue;

    if (key.type === "demand") {
      const window = m15Candles.slice(lastIdx - params.sfpLookbackBars, lastIdx + 1);
      const sweepBar = window.find((b) => b.low < key.price);

      if (sweepBar) {
        let sweptLiquidityPool = true;
        if (params.requireLiquidityPoolSweep) {
          const recentLowSwings = swings.filter((s) => s.type === "low");
          sweptLiquidityPool = recentLowSwings.some((s) => sweepBar.low < s.price);
        }

        if (sweptLiquidityPool && cCurr.close > key.price) {
          let isPattern = false;
          let patternName = "";

          if (cCurr.close > cCurr.open && cPrev.close < cPrev.open && cCurr.close >= cPrev.high) {
            isPattern = true;
            patternName = "Engulfing";
          } else if (
            cCurr.close > cCurr.open &&
            (cCurr.open - cCurr.low) >= (cCurr.high - cCurr.low) * 0.5
          ) {
            isPattern = true;
            patternName = "Pinbar";
          } else if (cPrev.low < cAnte.low && cCurr.close > cAnte.high) {
            isPattern = true;
            patternName = "3-bar-reversal";
          }

          if (isPattern) {
            const minLow = Math.min(...window.map((b) => b.low));
            events.push({
              keyLevel: key,
              dir: "long",
              sweepTime: sweepBar.openTime,
              sweepPrice: minLow,
              reclaimPrice: cCurr.close,
              confirmTime: cCurr.openTime,
              confirmClose: cCurr.close,
              patternName,
              obHigh: Math.max(cCurr.open, cCurr.close),
              obLow: cCurr.low,
            });
          }
        }
      }
    }

    if (key.type === "supply") {
      const window = m15Candles.slice(lastIdx - params.sfpLookbackBars, lastIdx + 1);
      const sweepBar = window.find((b) => b.high > key.price);

      if (sweepBar) {
        let sweptLiquidityPool = true;
        if (params.requireLiquidityPoolSweep) {
          const recentHighSwings = swings.filter((s) => s.type === "high");
          sweptLiquidityPool = recentHighSwings.some((s) => sweepBar.high > s.price);
        }

        if (sweptLiquidityPool && cCurr.close < key.price) {
          let isPattern = false;
          let patternName = "";

          if (cCurr.close < cCurr.open && cPrev.close > cPrev.open && cCurr.close <= cPrev.low) {
            isPattern = true;
            patternName = "Engulfing";
          } else if (
            cCurr.close < cCurr.open &&
            (cCurr.high - cCurr.open) >= (cCurr.high - cCurr.low) * 0.5
          ) {
            isPattern = true;
            patternName = "Pinbar";
          } else if (cPrev.high > cAnte.high && cCurr.close < cAnte.low) {
            isPattern = true;
            patternName = "3-bar-reversal";
          }

          if (isPattern) {
            const maxHigh = Math.max(...window.map((b) => b.high));
            events.push({
              keyLevel: key,
              dir: "short",
              sweepTime: sweepBar.openTime,
              sweepPrice: maxHigh,
              reclaimPrice: cCurr.close,
              confirmTime: cCurr.openTime,
              confirmClose: cCurr.close,
              patternName,
              obHigh: cCurr.high,
              obLow: Math.min(cCurr.open, cCurr.close),
            });
          }
        }
      }
    }
  }

  return events;
}

// ─────────────────────────────────────────────
// SIGNAL PLAN BUILDER (STRUCTURAL HIGH R:R RUNNER TARGETS)
// ─────────────────────────────────────────────

export function buildSignalPlan(
  symbol: string,
  event: SFPEvent,
  opposingStructurePrice: number | null,
  params: FXDreamParams
): SignalPlan | null {
  let entryPrice = event.confirmClose;
  let initialSL = 0;

  if (event.dir === "long") {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obLow + obRange * params.obPullbackFraction;
    initialSL = event.sweepPrice * 0.999;
  } else {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obHigh - obRange * params.obPullbackFraction;
    initialSL = event.sweepPrice * 1.001;
  }

  const riskDist = Math.abs(entryPrice - initialSL);
  if (riskDist <= 0 || riskDist / entryPrice > 0.05) return null;

  let targetPrice = 0;
  if (params.allowStructuralRunners && opposingStructurePrice && opposingStructurePrice > 0) {
    targetPrice = opposingStructurePrice;
  } else {
    if (event.dir === "long") targetPrice = entryPrice + riskDist * params.minRR;
    else targetPrice = entryPrice - riskDist * params.minRR;
  }

  const rewardDist = Math.abs(targetPrice - entryPrice);
  let targetR = rewardDist / riskDist;

  // Cap target R at maxTargetR (e.g. 15R)
  if (params.maxTargetR && targetR > params.maxTargetR) {
    targetR = params.maxTargetR;
    if (event.dir === "long") targetPrice = entryPrice + riskDist * targetR;
    else targetPrice = entryPrice - riskDist * targetR;
  }

  if (targetR < params.minRR) return null;

  const expiryBars = 12;
  const expiryTime = event.confirmTime + expiryBars * TF_MS["15m"];

  return {
    symbol,
    dir: event.dir,
    sfpEvent: event,
    entryPrice,
    initialSL,
    targetPrice,
    targetR,
    riskPct: params.riskPct,
    createdTime: event.confirmTime,
    expiryTime,
  };
}
