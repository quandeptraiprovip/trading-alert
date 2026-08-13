/**
 * fxdream-research/strategy-engine-infinite-r.ts
 *
 * Engine Số Hoá Mô Hình "TP VÔ CỰC & SIÊU R" (Ultra-High R Multipliers: 20R - 100R+)
 * Trích xuất trực tiếp từ video `LiveTrade +50R`, `#22`, `#43` của FX Dream Trading.
 *
 * Các Quy Tắc Cốt Lõi:
 * 1. SL Siêu Ngắn At Order Block / SFP Wick: Đặt SL sát mép OB/SFP wick (0.08% - 0.15%).
 * 2. KHÔNG Chốt Lời Non Tại 2R (Hoặc dời SL về BE tại 1.5R và giữ 100% vị thế gồng).
 * 3. Thả Trôi TP Vô Cực (Target R = 20R - 100R hoặc cản Daily/H4 cực xa).
 * 4. Trailing Stop Bám Theo Structure H4 / D1 (Cho phép vị thế thở qua các sóng chỉnh H1).
 * 5. Tỷ lệ Thắng (Win Rate) chỉ cần 20% - 25%, nhưng 1 lệnh thắng 30R - 50R bù đắp gấp hàng chục lần lệnh thua.
 */

import { Candle, TF_MS, aggregate, findSwings, Swing } from "../strategy";

export type FXDreamDirection = "long" | "short";

export interface FXDreamInfiniteRParams {
  baseTf: "5m";
  confirmTf: "15m";
  keyTf: "1h";
  confluenceTf: "4h";
  dailyTf: "1d";

  volumeLookback: number;
  volumeSpikeMult: number; // 2.0x
  minDisplacementAtr: number; // 1.2 ATR

  // SL Siêu Ngắn at OB
  obPullbackFraction: number; // 0.20 (Sát mép OB)
  stopBufferPct: number; // 0.0005 (0.05% buffer)

  // TP Vô Cực & Ultra-High R Rules
  moveBEAtR: number; // 1.5R (Dời SL về hòa vốn tại 1.5R)
  keepFullPosition: boolean; // TRUE: Giữ 100% vị thế gồng (KHÔNG cắt 50% ở 2R)
  maxTargetR: number; // 50.0R
  trailMode: "h4-swing" | "d1-swing"; // Trail theo H4/D1 Swing

  // Context Gates
  requireDailyTrapGate: boolean;
  dailyBiasBars: number;
  sfpLookbackBars: number;
  requireLiquidityPoolSweep: boolean;
  candlePatternRequired: boolean;

  requireFollowThrough: boolean;
  followThroughBars: number;

  // Fee Modeling
  makerFeeRate: number; // Limit Maker 0.02%
  takerFeeRate: number;
  slippageRate: number;
}

export const INFINITE_R_PARAMS: FXDreamInfiniteRParams = {
  baseTf: "5m",
  confirmTf: "15m",
  keyTf: "1h",
  confluenceTf: "4h",
  dailyTf: "1d",

  volumeLookback: 96,
  volumeSpikeMult: 2.0,
  minDisplacementAtr: 1.2,

  obPullbackFraction: 0.20,
  stopBufferPct: 0.0005,

  moveBEAtR: 1.5,
  keepFullPosition: true, // GIỮ 100% VỊ THẾ GỒNG 50R+
  maxTargetR: 50.0, // TARGET 50R
  trailMode: "h4-swing",

  requireDailyTrapGate: true,
  dailyBiasBars: 3,
  sfpLookbackBars: 20,
  requireLiquidityPoolSweep: true,
  candlePatternRequired: true,

  requireFollowThrough: true,
  followThroughBars: 6,

  riskPct: 1.0,
  maxLeverage: 10.0,

  makerFeeRate: 0.0002,
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

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────────────────────────
// KEY VOLUME FINDER
// ─────────────────────────────────────────────

export function findKeyVolumeLevelsInfiniteR(
  candlesH1: Candle[],
  candlesH4: Candle[],
  params: FXDreamInfiniteRParams
): KeyLevel[] {
  const levels: KeyLevel[] = [];
  if (candlesH1.length < params.volumeLookback + 10) return levels;

  const atrH1 = calculateATR(candlesH1, 14);

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

      let reactsAsDemand = maxUp >= currentAtr * 0.8;
      let reactsAsSupply = maxDown >= currentAtr * 0.8;

      if (!reactsAsDemand && !reactsAsSupply) continue;

      if (reactsAsDemand) {
        levels.push({
          id: `1h-demand-${c.openTime}`,
          price: c.low,
          type: "demand",
          tf: "1h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          mitigations: 0,
          isFresh: true,
        });
      }

      if (reactsAsSupply) {
        levels.push({
          id: `1h-supply-${c.openTime}`,
          price: c.high,
          type: "supply",
          tf: "1h",
          originTime: c.openTime,
          originIndex: i,
          volumeRatio: volRatio,
          mitigations: 0,
          isFresh: true,
        });
      }
    }
  }

  return levels;
}

// ─────────────────────────────────────────────
// DAILY CONTEXT & TRAP GATE (#31)
// ─────────────────────────────────────────────

export interface DailyContextInfiniteR {
  bias: "long" | "short" | "neutral";
  trapGatePassed: boolean;
}

export function evaluateDailyContextInfiniteR(
  dailyCandles: Candle[],
  currentIndexTime: number,
  params: FXDreamInfiniteRParams
): DailyContextInfiniteR {
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
// SFP SIGNALS DETECTION (ULTRA-TIGHT SL AT OB)
// ─────────────────────────────────────────────

export function detectSFPSignalsInfiniteR(
  m15Candles: Candle[],
  keyLevels: KeyLevel[],
  dailyContext: DailyContextInfiniteR,
  params: FXDreamInfiniteRParams
): SFPEvent[] {
  const events: SFPEvent[] = [];
  if (m15Candles.length < params.sfpLookbackBars + 5) return events;

  const lastIdx = m15Candles.length - 1;
  const cCurr = m15Candles[lastIdx];
  const cPrev = m15Candles[lastIdx - 1];
  const cAnte = m15Candles[lastIdx - 2];

  const atr = calculateATR(m15Candles, 14)[lastIdx] || (cCurr.high - cCurr.low);

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
          const minLow = Math.min(...window.map((b) => b.low).filter((v) => typeof v === "number" && !isNaN(v)));
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
          });
        }
      }
    }

    if (key.type === "supply") {
      const window = m15Candles.slice(lastIdx - params.sfpLookbackBars, lastIdx + 1);
      const sweepBar = window.find((b) => b.high >= key.price * 0.998);

      if (sweepBar && cCurr.close <= key.price * 1.002) {
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
          const maxHigh = Math.max(...window.map((b) => b.high).filter((v) => typeof v === "number" && !isNaN(v)));
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
          });
        }
      }
    }
  }

  return events;
}

// ─────────────────────────────────────────────
// SIGNAL PLAN BUILDER (ULTRA-HIGH R MULTIPLIERS)
// ─────────────────────────────────────────────

export function buildSignalPlanInfiniteR(
  symbol: string,
  event: SFPEvent,
  opposingStructurePrice: number | null,
  params: FXDreamInfiniteRParams
): SignalPlan | null {
  let entryPrice = event.confirmClose;
  let initialSL = 0;

  if (event.dir === "long") {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obLow + obRange * params.obPullbackFraction; // Entry at OB 20%
    initialSL = event.sweepPrice * (1 - params.stopBufferPct); // Ultra-tight SL just below sweep wick
  } else {
    const obRange = event.obHigh - event.obLow;
    entryPrice = event.obHigh - obRange * params.obPullbackFraction;
    initialSL = event.sweepPrice * (1 + params.stopBufferPct);
  }

  let riskDist = Math.abs(entryPrice - initialSL);
  if (riskDist / entryPrice < 0.0008) {
    if (event.dir === "long") initialSL = entryPrice * (1 - 0.0008);
    else initialSL = entryPrice * (1 + 0.0008);
    riskDist = Math.abs(entryPrice - initialSL);
  }
  if (riskDist <= 0 || riskDist / entryPrice > 0.05) return null;

  // Ultra-High R Target (50R Target)
  let targetPrice = 0;
  if (opposingStructurePrice && opposingStructurePrice > 0) {
    const structRewardDist = Math.abs(opposingStructurePrice - entryPrice);
    const structR = structRewardDist / riskDist;
    if (structR >= 3.0) {
      targetPrice = opposingStructurePrice;
    } else {
      if (event.dir === "long") targetPrice = entryPrice + riskDist * params.maxTargetR;
      else targetPrice = entryPrice - riskDist * params.maxTargetR;
    }
  } else {
    if (event.dir === "long") targetPrice = entryPrice + riskDist * params.maxTargetR;
    else targetPrice = entryPrice - riskDist * params.maxTargetR;
  }

  const rewardDist = Math.abs(targetPrice - entryPrice);
  const targetR = rewardDist / riskDist;

  if (targetR < 3.0) return null;

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
    riskPct: 1.0,
    createdTime: event.confirmTime,
    expiryTime,
  };
}
