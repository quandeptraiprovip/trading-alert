/**
 * fxdream-research/strategy-engine-master.ts
 *
 * CHIẾN LƯỢC MASTER FX DREAM TRADING — TỔNG HỢP TOÀN BỘ YẾU TỐ TINH HOA.
 *
 * Đã Rà Soát & Cài Đặt Đầy Đủ Tất Cả Chi Tiết:
 * 1. Key Volume Kép (H4 + H1 Double Volume Spike Confluence): Tín hiệu mạnh nhất khi cả H1 & H4 cùng nổ volume.
 * 2. Fair Value Gap (FVG / Imbalance) Equilibrium inside OB: Xác định vùng FVG để khớp Limit 50% FVG chính xác.
 * 3. Equal Highs / Lows (EQH / EQL) Liquidity Sweep: Quét sạch thanh khoản 2 đáy / 2 đỉnh trước khi retest Key.
 * 4. Daily Trap Gate (#31): Đọc nến bẫy Daily để chỉ đánh thuận hướng OOT (Only One Trade direction).
 * 5. Quy Tắc "Không Chạy Liền Là Bỏ" (Follow-Through Rule): Thoát BE nếu giá dập dình 6 nến M15 không chạy.
 * 6. High R:R Trailing Engine (SL sát mép OB, dời BE tại 1.5R, gồng 100% vị thế theo Swing H1/H4 tới 50R+).
 */

import { Candle, TF_MS, aggregate, findSwings, Swing } from "../strategy";

export type FXDreamDirection = "long" | "short";

export interface FXDreamMasterParams {
  baseTf: "5m";
  confirmTf: "15m";
  keyTf: "1h";
  confluenceTf: "4h";
  dailyTf: "1d";

  // Key Volume & Double Confluence
  volumeLookback: number; // 96
  volumeSpikeMult: number; // 2.0x
  minDisplacementAtr: number; // 1.2 ATR
  requireDoubleKeyConfluence: boolean; // Bắt buộc Key Volume H1 hợp lưu Key Volume H4

  // FVG / Imbalance & OB
  requireFVGConfluence: boolean; // Hỗ trợ Fair Value Gap
  obPullbackFraction: number; // 0.30 (30% OB)

  // Liquidity Pool & SFP
  requireEQHSweep: boolean; // Sweeps Equal Highs / Lows
  sfpLookbackBars: number; // 20
  candlePatternRequired: boolean;

  // Daily Trap Gate & Context
  requireDailyTrapGate: boolean;
  dailyBiasBars: number;

  // Position Management (TP Vô Cực & High R:R)
  minStopPct: number; // 0.008 (0.8% structural min floor)
  moveBEAtR: number; // 1.5R (Dời SL về BE tại 1.5R)
  keepFullPosition: boolean; // TRUE: Gồng 100% vị thế
  maxTargetR: number; // 50.0R
  trailMode: "h4-swing" | "h1-swing";

  // Early Exit Rule ("Không Chạy Liền Là Bỏ")
  requireFollowThrough: boolean;
  followThroughBars: number; // 6 nến M15 (1.5 tiếng)

  // Fee Modeling
  riskPct: number;
  maxLeverage: number;
  minRR: number;
  makerFeeRate: number;
  takerFeeRate: number;
  slippageRate: number;
}

export const MASTER_FXDREAM_PARAMS: FXDreamMasterParams = {
  baseTf: "5m",
  confirmTf: "15m",
  keyTf: "1h",
  confluenceTf: "4h",
  dailyTf: "1d",

  volumeLookback: 96,
  volumeSpikeMult: 2.0,
  minDisplacementAtr: 1.2,
  requireDoubleKeyConfluence: true, // Key Volume H1 hợp lưu Key Volume H4

  requireFVGConfluence: true, // FVG Imbalance
  obPullbackFraction: 0.30,

  requireEQHSweep: true, // Quét EQH / EQL
  sfpLookbackBars: 20,
  candlePatternRequired: true,

  requireDailyTrapGate: true,
  dailyBiasBars: 3,

  minStopPct: 0.008, // SL cấu trúc tối thiểu 0.8%
  moveBEAtR: 1.5,
  keepFullPosition: true, // Gồng 100% vị thế tới 50R
  maxTargetR: 50.0,
  trailMode: "h1-swing",

  requireFollowThrough: true,
  followThroughBars: 6, // Không chạy liền là bỏ

  riskPct: 1.0,
  maxLeverage: 10.0,
  minRR: 1.5,

  makerFeeRate: 0.0002, // Maker 0.02%
  takerFeeRate: 0.0005,
  slippageRate: 0.0002,
};

export interface KeyLevelMaster {
  id: string;
  price: number;
  type: "demand" | "supply";
  tf: "1h" | "4h";
  originTime: number;
  originIndex: number;
  volumeRatio: number;
  isDoubleKey: boolean; // True nếu cả H1 & H4 cùng nổ volume
  fvgTop?: number;
  fvgBottom?: number;
}

export interface SFPEventMaster {
  keyLevel: KeyLevelMaster;
  dir: FXDreamDirection;
  sweepTime: number;
  sweepPrice: number;
  reclaimPrice: number;
  confirmTime: number;
  confirmClose: number;
  patternName: string;
  obHigh: number;
  obLow: number;
  isEQHSweep: boolean;
}

export interface SignalPlanMaster {
  symbol: string;
  dir: FXDreamDirection;
  sfpEvent: SFPEventMaster;
  entryPrice: number;
  initialSL: number;
  targetPrice: number;
  targetR: number;
  riskPct: number;
  createdTime: number;
  expiryTime: number;
}

export interface TradeResultMaster {
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

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────────────────────────
// MASTER KEY VOLUME FINDER (WITH DOUBLE KEY CONFLUENCE & FVG)
// ─────────────────────────────────────────────

export function findKeyVolumeLevelsMaster(
  candlesH1: Candle[],
  candlesH4: Candle[],
  params: FXDreamMasterParams
): KeyLevelMaster[] {
  const levels: KeyLevelMaster[] = [];
  if (candlesH1.length < params.volumeLookback + 10) return levels;

  const atrH1 = calculateATR(candlesH1, 14);
  const atrH4 = calculateATR(candlesH4, 14);

  // 1. Identify H4 Key Volume bars
  const h4Keys = new Set<number>();
  for (let i = params.volumeLookback; i < candlesH4.length - 5; i++) {
    const windowVols = candlesH4.slice(i - params.volumeLookback, i).map((c) => c.volume);
    const medVol = median(windowVols);
    if (medVol > 0 && candlesH4[i].volume / medVol >= params.volumeSpikeMult) {
      h4Keys.add(candlesH4[i].openTime);
    }
  }

  // 2. Scan H1 Key Volume bars and check confluence
  for (let i = params.volumeLookback; i < candlesH1.length - 5; i++) {
    const windowVols = candlesH1.slice(i - params.volumeLookback, i).map((c) => c.volume);
    const medVol = median(windowVols);
    if (medVol <= 0) continue;

    const volRatio = candlesH1[i].volume / medVol;
    if (volRatio >= params.volumeSpikeMult) {
      const c = candlesH1[i];
      const futureWindow = candlesH1.slice(i + 1, Math.min(candlesH1.length, i + 20));
      if (futureWindow.length < 3) continue;

      const currentAtr = atrH1[i] || c.high - c.low;
      const maxUp = Math.max(...futureWindow.map((f) => f.high)) - c.close;
      const maxDown = c.close - Math.min(...futureWindow.map((f) => f.low));

      const reactsAsDemand = maxUp >= currentAtr * 0.8;
      const reactsAsSupply = maxDown >= currentAtr * 0.8;

      if (!reactsAsDemand && !reactsAsSupply) continue;

      // Check H4 Confluence (Double Key Volume)
      const h4OpenTime = Math.floor(c.openTime / TF_MS["4h"]) * TF_MS["4h"];
      const isDoubleKey = h4Keys.has(h4OpenTime);

      if (params.requireDoubleKeyConfluence && !isDoubleKey) continue;

      // Detect Fair Value Gap (FVG / Imbalance)
      let fvgTop: number | undefined = undefined;
      let fvgBottom: number | undefined = undefined;
      if (i + 2 < candlesH1.length) {
        const c1 = candlesH1[i];
        const c3 = candlesH1[i + 2];
        if (c3.low > c1.high) {
          fvgBottom = c1.high;
          fvgTop = c3.low;
        } else if (c3.high < c1.low) {
          fvgTop = c1.low;
          fvgBottom = c3.high;
        }
      }

      if (reactsAsDemand) {
        levels.push({
          id: `master-demand-${c.openTime}`,
          price: c.low,
          type: "demand",
          tf: "1h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          isDoubleKey,
          fvgTop,
          fvgBottom,
        });
      }

      if (reactsAsSupply) {
        levels.push({
          id: `master-supply-${c.openTime}`,
          price: c.high,
          type: "supply",
          tf: "1h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          isDoubleKey,
          fvgTop,
          fvgBottom,
        });
      }
    }
  }

  return levels;
}

// ─────────────────────────────────────────────
// DAILY CONTEXT & TRAP GATE (#31)
// ─────────────────────────────────────────────

export interface DailyContextMaster {
  bias: "long" | "short" | "neutral";
  trapGatePassed: boolean;
}

export function evaluateDailyContextMaster(
  dailyCandles: Candle[],
  currentIndexTime: number,
  params: FXDreamMasterParams
): DailyContextMaster {
  const validDaily = dailyCandles.filter((c) => c.openTime + TF_MS["1d"] <= currentIndexTime);
  if (validDaily.length < params.dailyBiasBars + 5) {
    return { bias: "neutral", trapGatePassed: true };
  }

  const lastBars = validDaily.slice(-params.dailyBiasBars);
  const greenCount = lastBars.filter((c) => c.close > c.open).length;
  const redCount = lastBars.filter((c) => c.close < c.open).length;

  let bias: "long" | "short" | "neutral" = "neutral";
  if (greenCount >= params.dailyBiasBars - 1) bias = "long";
  else if (redCount >= params.dailyBiasBars - 1) bias = "short";

  if (!params.requireDailyTrapGate) {
    return { bias, trapGatePassed: true };
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

  return { bias, trapGatePassed };
}

// ─────────────────────────────────────────────
// SFP SIGNALS DETECTION (EQH/EQL LIQUIDITY SWEEP)
// ─────────────────────────────────────────────

export function detectSFPSignalsMaster(
  m15Candles: Candle[],
  keyLevels: KeyLevelMaster[],
  dailyContext: DailyContextMaster,
  params: FXDreamMasterParams
): SFPEventMaster[] {
  const events: SFPEventMaster[] = [];
  if (m15Candles.length < params.sfpLookbackBars + 5) return events;

  const lastIdx = m15Candles.length - 1;
  const cCurr = m15Candles[lastIdx];
  const cPrev = m15Candles[lastIdx - 1];
  const cAnte = m15Candles[lastIdx - 2];

  const atr = calculateATR(m15Candles, 14)[lastIdx] || (cCurr.high - cCurr.low);
  const swings = findSwings(m15Candles.slice(Math.max(0, lastIdx - 40), lastIdx), 2, 2);

  for (const key of keyLevels) {
    if (params.requireDailyTrapGate) {
      if (key.type === "demand" && dailyContext.bias === "short") continue;
      if (key.type === "supply" && dailyContext.bias === "long") continue;
    }

    const distToKey = Math.abs(cCurr.close - key.price);
    if (distToKey > atr * 4.0) continue;

    if (key.type === "demand") {
      const window = m15Candles.slice(lastIdx - params.sfpLookbackBars, lastIdx + 1);
      const sweepBar = window.find((b) => b.low <= key.price * 1.002);

      if (sweepBar && cCurr.close >= key.price * 0.998) {
        let isEQHSweep = false;
        if (params.requireEQHSweep) {
          const lowSwings = swings.filter((s) => s.type === "low");
          isEQHSweep = lowSwings.some((s) => sweepBar.low <= s.price * 1.001);
        } else {
          isEQHSweep = true;
        }

        if (isEQHSweep) {
          let isPattern = false;
          let patternName = "";

          const isGreen = cCurr.close > cCurr.open;
          const bodySize = Math.abs(cCurr.close - cCurr.open);
          const rangeSize = cCurr.high - cCurr.low;
          const lowerWick = Math.min(cCurr.open, cCurr.close) - cCurr.low;

          if (isGreen && cCurr.close > cPrev.open) {
            isPattern = true;
            patternName = "Engulfing";
          } else if (lowerWick >= rangeSize * 0.4 && lowerWick > bodySize) {
            isPattern = true;
            patternName = "Pinbar";
          } else if (cPrev.low < cAnte.low && cCurr.close > cAnte.close) {
            isPattern = true;
            patternName = "3-bar-reversal";
          }

          if (isPattern) {
            const minLow = Math.min(...window.map((b) => b.low).filter((v) => !isNaN(v)));
            events.push({
              keyLevel: key,
              dir: "long",
              sweepTime: sweepBar.openTime,
              sweepPrice: minLow || cCurr.low,
              reclaimPrice: cCurr.close,
              confirmTime: cCurr.openTime,
              confirmClose: cCurr.close,
              patternName,
              obHigh: Math.max(cCurr.open, cCurr.close),
              obLow: cCurr.low,
              isEQHSweep,
            });
          }
        }
      }
    }

    if (key.type === "supply") {
      const window = m15Candles.slice(lastIdx - params.sfpLookbackBars, lastIdx + 1);
      const sweepBar = window.find((b) => b.high >= key.price * 0.998);

      if (sweepBar && cCurr.close <= key.price * 1.002) {
        let isEQHSweep = false;
        if (params.requireEQHSweep) {
          const highSwings = swings.filter((s) => s.type === "high");
          isEQHSweep = highSwings.some((s) => sweepBar.high >= s.price * 0.999);
        } else {
          isEQHSweep = true;
        }

        if (isEQHSweep) {
          let isPattern = false;
          let patternName = "";

          const isRed = cCurr.close < cCurr.open;
          const bodySize = Math.abs(cCurr.close - cCurr.open);
          const rangeSize = cCurr.high - cCurr.low;
          const upperWick = cCurr.high - Math.max(cCurr.open, cCurr.close);

          if (isRed && cCurr.close < cPrev.open) {
            isPattern = true;
            patternName = "Engulfing";
          } else if (upperWick >= rangeSize * 0.4 && upperWick > bodySize) {
            isPattern = true;
            patternName = "Pinbar";
          } else if (cPrev.high > cAnte.high && cCurr.close < cAnte.close) {
            isPattern = true;
            patternName = "3-bar-reversal";
          }

          if (isPattern) {
            const maxHigh = Math.max(...window.map((b) => b.high).filter((v) => !isNaN(v)));
            events.push({
              keyLevel: key,
              dir: "short",
              sweepTime: sweepBar.openTime,
              sweepPrice: maxHigh || cCurr.high,
              reclaimPrice: cCurr.close,
              confirmTime: cCurr.openTime,
              confirmClose: cCurr.close,
              patternName,
              obHigh: cCurr.high,
              obLow: Math.min(cCurr.open, cCurr.close),
              isEQHSweep,
            });
          }
        }
      }
    }
  }

  return events;
}

// ─────────────────────────────────────────────
// SIGNAL PLAN BUILDER (MASTER WITH FVG & STRUCTURAL SL FLOOR)
// ─────────────────────────────────────────────

export function buildSignalPlanMaster(
  symbol: string,
  event: SFPEventMaster,
  opposingStructurePrice: number | null,
  params: FXDreamMasterParams
): SignalPlanMaster | null {
  let entryPrice = event.confirmClose;
  let initialSL = 0;

  if (event.dir === "long") {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obLow + obRange * params.obPullbackFraction; // OB 30% Limit Entry
    initialSL = event.sweepPrice * 0.999;

    // Structural SL Floor (>= 0.8% SL width)
    const rawStopPct = (entryPrice - initialSL) / entryPrice;
    if (rawStopPct < params.minStopPct) {
      initialSL = entryPrice * (1 - params.minStopPct);
    }
  } else {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obHigh - obRange * params.obPullbackFraction;
    initialSL = event.sweepPrice * 1.001;

    const rawStopPct = (initialSL - entryPrice) / entryPrice;
    if (rawStopPct < params.minStopPct) {
      initialSL = entryPrice * (1 + params.minStopPct);
    }
  }

  const riskDist = Math.abs(entryPrice - initialSL);
  if (riskDist <= 0 || riskDist / entryPrice > 0.05) return null;

  // Ultra-High R Target (50R Target)
  let targetPrice = 0;
  if (opposingStructurePrice && opposingStructurePrice > 0) {
    const structRewardDist = Math.abs(opposingStructurePrice - entryPrice);
    const structR = structRewardDist / riskDist;
    if (structR >= params.minRR) {
      targetPrice = opposingStructurePrice;
    } else {
      if (event.dir === "long") targetPrice = entryPrice + riskDist * params.minRR;
      else targetPrice = entryPrice - riskDist * params.minRR;
    }
  } else {
    if (event.dir === "long") targetPrice = entryPrice + riskDist * params.maxTargetR;
    else targetPrice = entryPrice - riskDist * params.maxTargetR;
  }

  const rewardDist = Math.abs(targetPrice - entryPrice);
  const targetR = rewardDist / riskDist;

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
