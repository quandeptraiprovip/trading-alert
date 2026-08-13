/**
 * fxdream-research/strategy-engine-v2.ts
 *
 * Chiến lược FX Dream Trading V2 — đường cảnh báo đã đối chiếu transcript.
 *
 * Luật mặc định là biến thể V7 của `measure-live-path.ts`:
 * - key candidate xuất hiện ngay khi nến volume đột biến đóng, không đợi phản ứng tương lai;
 * - Daily gate #31 đúng ba câu hỏi;
 * - sweep/reclaim liền mạch với Engulfing, Inside-bar breakout hoặc 3-bar reversal;
 * - entry tham chiếu là giá đóng xác nhận, không giả gọi nến xác nhận là Order Block;
 * - không nới structural stop bằng một sàn phần trăm;
 * - không có cấu trúc đối diện đủ dư địa thì bỏ lệnh.
 */

import { Candle, TF_MS, aggregate, findSwings, Swing } from "../strategy";

export type FXDreamDirection = "long" | "short";

export interface FXDreamV2Params {
  baseTf: "5m";
  confirmTf: "15m";
  keyTf: "1h";
  confluenceTf: "4h";
  dailyTf: "1d";

  // Volume & Key Level
  volumeLookback: number; // 96
  volumeSpikeMult: number; // 2.0x
  minKeyReactions: number; // legacy research only; V7 không yêu cầu phản ứng trước
  keyMaxAgeDays: number; // 180
  keyGeometry: "representative-point" | "full-candle-zone";

  // Giữ field để nghiên cứu tương thích; mặc định 0 = không nới structural stop.
  minStopPct: number;

  // Các field quản trị dưới đây được giữ để tái lập nghiên cứu cũ; không phải luật nguồn cố định.
  partialAtR: number; // 2.0R
  partialFraction: number; // 0 = không hard-code tỷ lệ chốt non
  maxTargetR: number; // 0 = không cắt target cấu trúc bằng trần R
  trailMode: "h4-swing" | "h1-swing" | "m5-swing" | "none";

  // NÂNG CẤP 3: Daily Context & Trap Gate (#31)
  requireDailyTrapGate: boolean;
  dailyBiasBars: number;

  // Bộ quét ứng viên SFP. `obPullbackFraction` chỉ còn để tương thích nghiên cứu cũ.
  sfpLookbackBars: number;
  candlePatternRequired: boolean;
  obPullbackFraction: number; // legacy research only; V7 không dùng để tạo entry

  // Risk & Fee Modeling
  riskPct: number;
  maxLeverage: number;
  minRR: number;
  requireFollowThrough: boolean;
  followThroughBars: number;

  makerFeeRate: number;
  takerFeeRate: number;
  slippageRate: number;
  /** Chỉ true sau khi một cấu hình đóng băng dương trên holdout sau chi phí. */
  validatedForLiveAlerts: boolean;
  /** Mức ma sát tối đa của chính cấu hình đã được xác thực; 0 khi chưa có. */
  maxValidatedRoundTripFrictionRate: number;
}

export const FXDREAM_V2_CONFIG: FXDreamV2Params = {
  baseTf: "5m",
  confirmTf: "15m",
  keyTf: "1h",
  confluenceTf: "4h",
  dailyTf: "1d",

  volumeLookback: 96,
  volumeSpikeMult: 2.0,
  minKeyReactions: 0,
  keyMaxAgeDays: 180,
  // Một nến volume spike không mặc nhiên biến toàn bộ râu nến thành vùng kích hoạt.
  keyGeometry: "representative-point",

  minStopPct: 0,

  partialAtR: 2.0,
  // Không hard-code tỷ lệ chốt non: nguồn cho phép BE/partial tùy hành vi giá.
  partialFraction: 0,
  // 0 = không cắt target cấu trúc bằng một trần R nhân tạo.
  maxTargetR: 0,
  trailMode: "none",

  requireDailyTrapGate: true, // NÂNG CẤP 3: Daily Trap Gate (#31)
  dailyBiasBars: 3,

  sfpLookbackBars: 20,
  candlePatternRequired: true,
  obPullbackFraction: 0.3,

  riskPct: 1.0,
  maxLeverage: 10.0,
  minRR: 1.5,
  // Nguồn yêu cầu setup phải phản ứng tốt nhưng không đưa ra deadline 6 nến cố định.
  requireFollowThrough: false,
  followThroughBars: 6,

  makerFeeRate: 0.0002, // Maker 0.02%
  takerFeeRate: 0.0005,
  slippageRate: 0.0002,
  validatedForLiveAlerts: false,
  maxValidatedRoundTripFrictionRate: 0,
};

export function estimatedRoundTripFrictionRate(params: FXDreamV2Params): number {
  return params.makerFeeRate + params.takerFeeRate + params.slippageRate;
}

export function isExecutionCostSupported(params: FXDreamV2Params): boolean {
  return params.validatedForLiveAlerts &&
    estimatedRoundTripFrictionRate(params) <= params.maxValidatedRoundTripFrictionRate;
}

export interface KeyLevel {
  id: string;
  price: number;
  type: "neutral" | "demand" | "supply";
  /** Biên vùng của nến/vùng volume spike; fallback về `price` với dữ liệu legacy. */
  zoneLow?: number;
  zoneHigh?: number;
  tf: "1h" | "4h";
  originTime: number;
  originIndex: number;
  volumeRatio: number;
  reactionsCount: number;
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
  /** Biên nến xác nhận; KHÔNG phải Order Block đã được nhận diện. */
  obHigh: number;
  /** Biên nến xác nhận; KHÔNG phải Order Block đã được nhận diện. */
  obLow: number;
}

export function getKeyZoneBounds(key: KeyLevel): { low: number; high: number } {
  const low = Math.min(key.zoneLow ?? key.price, key.zoneHigh ?? key.price);
  const high = Math.max(key.zoneLow ?? key.price, key.zoneHigh ?? key.price);
  return { low, high };
}

function distanceFromKeyGeometry(
  price: number,
  key: KeyLevel,
  geometry: FXDreamV2Params["keyGeometry"],
): number {
  const zone = geometry === "full-candle-zone"
    ? getKeyZoneBounds(key)
    : { low: key.price, high: key.price };
  if (price < zone.low) return zone.low - price;
  if (price > zone.high) return price - zone.high;
  return 0;
}

/** Chọn event ổn định: gần vùng Key hơn, rồi volume mạnh hơn, rồi Key mới hơn. */
export function selectBestSFPEventV2(
  events: SFPEvent[],
  geometry: FXDreamV2Params["keyGeometry"] = "representative-point",
): SFPEvent | null {
  let best: SFPEvent | null = null;
  for (const event of events) {
    if (!best) {
      best = event;
      continue;
    }
    const eventDistance = distanceFromKeyGeometry(event.confirmClose, event.keyLevel, geometry);
    const bestDistance = distanceFromKeyGeometry(best.confirmClose, best.keyLevel, geometry);
    if (
      eventDistance < bestDistance ||
      (eventDistance === bestDistance && event.keyLevel.volumeRatio > best.keyLevel.volumeRatio) ||
      (eventDistance === bestDistance &&
        event.keyLevel.volumeRatio === best.keyLevel.volumeRatio &&
        event.keyLevel.originTime > best.keyLevel.originTime)
    ) {
      best = event;
    }
  }
  return best;
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
  partialAtR: number;
  partialFraction: number;
  estimatedFrictionRate: number;
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

/** Cấu trúc đối diện gần nhất có thể dùng làm mốc TP/headroom, không chọn swing xa nhất. */
export function findNearestOpposingStructurePrice(
  dir: FXDreamDirection,
  referencePrice: number,
  swings: Swing[],
): number | null {
  if (dir === "long") {
    const highs = swings.filter((s) => s.type === "high" && s.price > referencePrice);
    return highs.length > 0 ? Math.min(...highs.map((s) => s.price)) : null;
  }
  const lows = swings.filter((s) => s.type === "low" && s.price < referencePrice);
  return lows.length > 0 ? Math.max(...lows.map((s) => s.price)) : null;
}

// ─────────────────────────────────────────────
// ABNORMAL-VOLUME KEY CANDIDATE FINDER
// ─────────────────────────────────────────────

export function findKeyVolumeLevelsV2(
  candlesH1: Candle[],
  candlesH4: Candle[],
  params: FXDreamV2Params
): KeyLevel[] {
  const levels: KeyLevel[] = [];
  if (candlesH1.length < params.volumeLookback + 1) return levels;
  // H4 vẫn là checklist/target ở caller. `minKeyReactions` được giữ để các study cũ
  // còn đọc được config, nhưng định nghĩa hiện tại không đợi phản ứng giá tương lai.
  void candlesH4;
  void params.minKeyReactions;

  for (let i = params.volumeLookback; i < candlesH1.length; i++) {
    const windowVols = candlesH1.slice(i - params.volumeLookback, i).map((c) => c.volume);
    const medVol = median(windowVols);
    if (medVol <= 0) continue;

    const volRatio = candlesH1[i].volume / medVol;
    if (volRatio >= params.volumeSpikeMult) {
      const c = candlesH1[i];
      levels.push({
        id: `1h-volume-${c.openTime}`,
        price: c.close,
        type: "neutral",
        zoneLow: c.low,
        zoneHigh: c.high,
        tf: "1h",
        originTime: c.openTime,
        originIndex: i,
        volumeRatio: volRatio,
        reactionsCount: 0,
        isConfluent: false,
      });
    }
  }

  return levels;
}

// ─────────────────────────────────────────────
// DAILY CONTEXT & TRAP GATE (#31)
// ─────────────────────────────────────────────

export interface DailyContextV2 {
  bias: "long" | "short" | "neutral";
  trapGatePassed: boolean;
}

export function evaluateDailyContextV2(
  dailyCandles: Candle[],
  currentIndexTime: number,
  params: FXDreamV2Params
): DailyContextV2 {
  const validDaily = dailyCandles.filter((c) => c.openTime + TF_MS["1d"] <= currentIndexTime);
  if (validDaily.length < params.dailyBiasBars + 5) {
    return { bias: "neutral", trapGatePassed: !params.requireDailyTrapGate };
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

  if (bias === "neutral") return { bias, trapGatePassed: false };

  if (bias === "long") {
    let referenceIndex = -1;
    for (let i = validDaily.length - 1; i >= 0; i--) {
      if (validDaily[i].close > validDaily[i].open) {
        referenceIndex = i;
        break;
      }
    }
    if (referenceIndex < 0) return { bias, trapGatePassed: false };
    const referenceLow = validDaily[referenceIndex].low;
    let closedThrough = false;
    let swept = false;
    for (let i = referenceIndex + 1; i < validDaily.length; i++) {
      if (validDaily[i].close < referenceLow) closedThrough = true;
      if (validDaily[i].low < referenceLow) swept = true;
    }
    return { bias, trapGatePassed: !closedThrough && swept };
  }

  let referenceIndex = -1;
  for (let i = validDaily.length - 1; i >= 0; i--) {
    if (validDaily[i].close < validDaily[i].open) {
      referenceIndex = i;
      break;
    }
  }
  if (referenceIndex < 0) return { bias, trapGatePassed: false };
  const referenceHigh = validDaily[referenceIndex].high;
  let closedThrough = false;
  let swept = false;
  for (let i = referenceIndex + 1; i < validDaily.length; i++) {
    if (validDaily[i].close > referenceHigh) closedThrough = true;
    if (validDaily[i].high > referenceHigh) swept = true;
  }
  return { bias, trapGatePassed: !closedThrough && swept };
}

// ─────────────────────────────────────────────
// SFP SIGNALS DETECTION V2
// ─────────────────────────────────────────────

export function detectSFPSignalsV2(
  m15Candles: Candle[],
  keyLevels: KeyLevel[],
  dailyContext: DailyContextV2,
  params: FXDreamV2Params
): SFPEvent[] {
  const events: SFPEvent[] = [];
  if (m15Candles.length < params.sfpLookbackBars + 5) return events;

  const lastIdx = m15Candles.length - 1;
  const cCurr = m15Candles[lastIdx];
  const cPrev = m15Candles[lastIdx - 1];
  const cAnte = m15Candles[lastIdx - 2];

  const atr = calculateATR(m15Candles, 14)[lastIdx] || (cCurr.high - cCurr.low);

  for (const key of keyLevels) {
    const canLong = key.type !== "supply" && dailyContext.bias !== "short";
    const canShort = key.type !== "demand" && dailyContext.bias !== "long";
    if (!canLong && !canShort) continue;

    const sourceZone = getKeyZoneBounds(key);
    const zone = params.keyGeometry === "full-candle-zone"
      ? sourceZone
      : { low: key.price, high: key.price };
    const distToKey = distanceFromKeyGeometry(cCurr.close, key, params.keyGeometry);
    if (distToKey > atr * 3.0) continue;

    // Sweep phải thuộc chính cụm xác nhận 3 nến; không ghép một sweep cũ cách 20 nến
    // với pattern hiện tại. `sfpLookbackBars` được giữ cho tương thích nghiên cứu cũ.
    const confirmationCluster = [cAnte, cPrev, cCurr];

    if (canLong) {
      const sweepBars = confirmationCluster.filter((b) => b.low < zone.low);
      const sweepBar = sweepBars[sweepBars.length - 1];

      if (sweepBar && cCurr.close > zone.low) {
        let isPattern = false;
        let patternName = "";

        const isGreen = cCurr.close > cCurr.open;
        if (
          isGreen &&
          cPrev.close < cPrev.open &&
          cCurr.open < cPrev.close &&
          cCurr.close > cPrev.open
        ) {
          isPattern = true;
          patternName = "Engulfing";
        } else if (
          cPrev.high < cAnte.high &&
          cPrev.low > cAnte.low &&
          cCurr.close > cAnte.high
        ) {
          isPattern = true;
          patternName = "Inside-bar-breakout";
        } else if (cPrev.low < cAnte.low && cCurr.close > cAnte.close) {
          isPattern = true;
          patternName = "3-bar-reversal";
        }

        if (isPattern || !params.candlePatternRequired) {
          const minLow = Math.min(...confirmationCluster.map((b) => b.low));
          events.push({
            keyLevel: key,
            dir: "long",
            sweepTime: sweepBar.openTime,
            sweepPrice: minLow,
            reclaimPrice: cCurr.close,
            // Chỉ biết pattern sau khi nến M15 đã đóng.
            confirmTime: cCurr.openTime + TF_MS["15m"],
            confirmClose: cCurr.close,
            patternName: patternName || "SFP-reclaim",
            obHigh: Math.max(cCurr.open, cCurr.close),
            obLow: cCurr.low,
          });
        }
      }
    }

    if (canShort) {
      const sweepBars = confirmationCluster.filter((b) => b.high > zone.high);
      const sweepBar = sweepBars[sweepBars.length - 1];

      if (sweepBar && cCurr.close < zone.high) {
        let isPattern = false;
        let patternName = "";

        const isRed = cCurr.close < cCurr.open;
        if (
          isRed &&
          cPrev.close > cPrev.open &&
          cCurr.open > cPrev.close &&
          cCurr.close < cPrev.open
        ) {
          isPattern = true;
          patternName = "Engulfing";
        } else if (
          cPrev.high < cAnte.high &&
          cPrev.low > cAnte.low &&
          cCurr.close < cAnte.low
        ) {
          isPattern = true;
          patternName = "Inside-bar-breakout";
        } else if (cPrev.high > cAnte.high && cCurr.close < cAnte.close) {
          isPattern = true;
          patternName = "3-bar-reversal";
        }

        if (isPattern || !params.candlePatternRequired) {
          const maxHigh = Math.max(...confirmationCluster.map((b) => b.high));
          events.push({
            keyLevel: key,
            dir: "short",
            sweepTime: sweepBar.openTime,
            sweepPrice: maxHigh,
            reclaimPrice: cCurr.close,
            // Chỉ biết pattern sau khi nến M15 đã đóng.
            confirmTime: cCurr.openTime + TF_MS["15m"],
            confirmClose: cCurr.close,
            patternName: patternName || "SFP-reclaim",
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
// SIGNAL PLAN BUILDER V2 (STRUCTURAL SL FLOOR & HIGH R:R RUNNER)
// ─────────────────────────────────────────────

export function buildSignalPlanV2(
  symbol: string,
  event: SFPEvent,
  opposingStructurePrice: number | null,
  params: FXDreamV2Params
): SignalPlan | null {
  const entryPrice = event.confirmClose;
  let initialSL = 0;

  if (event.dir === "long") {
    initialSL = event.sweepPrice * 0.999;
  } else {
    initialSL = event.sweepPrice * 1.001;
  }

  if (event.dir === "long" && initialSL >= entryPrice) return null;
  if (event.dir === "short" && initialSL <= entryPrice) return null;

  const riskDist = Math.abs(entryPrice - initialSL);
  if (riskDist <= 0 || riskDist / entryPrice > 0.05) return null;

  if (!opposingStructurePrice || opposingStructurePrice <= 0) return null;
  if (event.dir === "long" && opposingStructurePrice <= entryPrice) return null;
  if (event.dir === "short" && opposingStructurePrice >= entryPrice) return null;

  let targetPrice = opposingStructurePrice;
  const structRewardDist = Math.abs(opposingStructurePrice - entryPrice);
  const structR = structRewardDist / riskDist;
  if (structR < params.minRR) return null;

  const rewardDist = Math.abs(targetPrice - entryPrice);
  let targetR = rewardDist / riskDist;

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
    partialAtR: params.partialAtR,
    partialFraction: params.partialFraction,
    estimatedFrictionRate: estimatedRoundTripFrictionRate(params),
  };
}
