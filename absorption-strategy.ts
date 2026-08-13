import { Candle, TF_MS, aggregate, htfClosedCount, findSwings, structureBias, lastConfirmedSwing } from "./strategy";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

export interface AbsorptionConfig {
  entryTf: string;
  htfBiasTf: string;
  htfZoneTf: string;
  
  // Volume & Zone
  lookback: number;
  clusterBars: number;
  volSpikeMult: number;
  zoneKind: "event" | "body";
  
  // Retest & Absorption
  maxRetestBars: number;
  departAtr: number;
  retestVolMult: number;
  retestFlowMin: number;
  
  // Confirmation
  confirmMaxBars: number;
  
  // Risk & Exit
  maxStopPct: number;
  stopPadAtr: number;
  targetRR: number;
  timeStopBars: number;
}

export const DEFAULT_ABSORPTION_CONFIG: AbsorptionConfig = {
  entryTf: "15m",
  htfBiasTf: "4h",
  htfZoneTf: "1h",
  
  lookback: 192,
  clusterBars: 1,
  volSpikeMult: 2.0,
  zoneKind: "body",
  
  maxRetestBars: 960,
  departAtr: 0.5,
  retestVolMult: 1.3,
  retestFlowMin: 0.55,
  
  confirmMaxBars: 16,
  
  maxStopPct: 0.065,
  stopPadAtr: 0.25,
  targetRR: 2.5,
  timeStopBars: 96,
};

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface AbsorptionZone {
  direction: "long" | "short";
  zoneLow: number;
  zoneHigh: number;
  eventIndex: number;
  eventTime: number;
  eventVolRatio: number;
}

export interface AbsorptionSignal {
  direction: "long" | "short";
  retestIndex: number;
  retestTime: number;
  zoneLow: number;
  zoneHigh: number;
  eventIndex: number;
  eventTime: number;
  retestVolRatio: number;
  htfAligned: boolean;
}

export interface AbsorptionTrade {
  direction: "long" | "short";
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskFrac: number;
}

export interface AbsorptionState {
  symbol: string;
  zones: AbsorptionZone[];
  activeSignal: AbsorptionSignal | null;
  lastEventEnd: number;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function quoteVolume(c: Candle): number {
  return c.quoteVolume != null ? c.quoteVolume : c.volume * c.close;
}

export function atr15m(candles: Candle[], period: number = 14): number[] {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const p = new Float64Array(tr.length + 1);
  for (let i = 0; i < tr.length; i++) p[i + 1] = p[i] + tr[i];
  
  return tr.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    return (p[i + 1] - p[start]) / (i - start + 1);
  });
}

function rangeSum(prefix: Float64Array, start: number, endExclusive: number): number {
  if (start < 0) start = 0;
  if (endExclusive > prefix.length - 1) endExclusive = prefix.length - 1;
  if (start >= endExclusive) return 0;
  return prefix[endExclusive] - prefix[start];
}

function aggregateBuyRatio(candles: Candle[], start: number, end: number): number | null {
  let buy = 0;
  let total = 0;
  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (c.takerBuyVolume == null || !Number.isFinite(c.takerBuyVolume) || c.volume <= 0) return null;
    buy += c.takerBuyVolume;
    total += c.volume;
  }
  return total > 0 ? buy / total : null;
}

function flowClass(buyRatio: number | null, direction: "long" | "short", minFlow: number): "aligned" | "opposite" | "neutral" {
  if (buyRatio == null) return "neutral";
  if (buyRatio > 1 - minFlow && buyRatio < minFlow) return "neutral";
  const flowDirection = buyRatio >= minFlow ? "long" : "short";
  return flowDirection === direction ? "aligned" : "opposite";
}

// ─────────────────────────────────────────────
// CORE PURE FUNCTIONS
// ─────────────────────────────────────────────

export function detectExtremeVolumeZones(candles: Candle[], config: AbsorptionConfig): AbsorptionZone[] {
  const volumes = candles.map(quoteVolume);
  const volPrefix = new Float64Array(volumes.length + 1);
  for (let i = 0; i < volumes.length; i++) volPrefix[i + 1] = volPrefix[i] + volumes[i];
  const atrs = atr15m(candles);
  const zones: AbsorptionZone[] = [];
  let lastEventEnd = -Infinity;

  for (let end = config.lookback + config.clusterBars - 1; end < candles.length; end++) {
    const start = end - config.clusterBars + 1;
    if (start <= lastEventEnd) continue;
    
    const baselineStart = start - config.lookback;
    const baselineMean = rangeSum(volPrefix, baselineStart, start) / config.lookback;
    if (!(baselineMean > 0)) continue;
    
    const eventVolume = rangeSum(volPrefix, start, end + 1);
    const eventVolRatio = eventVolume / (baselineMean * config.clusterBars);
    if (eventVolRatio < config.volSpikeMult) continue;
    
    lastEventEnd = end;
    const first = candles[start];
    const last = candles[end];
    if (last.close === first.open || !(atrs[end] > 0)) continue;
    
    const direction = last.close > first.open ? "long" : "short";
    
    const eventHigh = Math.max(...candles.slice(start, end + 1).map((c) => c.high));
    const eventLow = Math.min(...candles.slice(start, end + 1).map((c) => c.low));
    const bodyHigh = Math.max(...candles.slice(start, end + 1).map((c) => Math.max(c.open, c.close)));
    const bodyLow = Math.min(...candles.slice(start, end + 1).map((c) => Math.min(c.open, c.close)));
    
    const zoneHigh = config.zoneKind === "body" ? bodyHigh : eventHigh;
    const zoneLow = config.zoneKind === "body" ? bodyLow : eventLow;
    
    zones.push({
      direction,
      zoneLow,
      zoneHigh,
      eventIndex: end,
      eventTime: candles[end].openTime,
      eventVolRatio
    });
  }
  
  return zones;
}

/** Precomputed data to avoid recomputation per bar in backtests. */
export interface PrecomputedData {
  atrs: number[];
  volumes: number[];
  volPrefix: Float64Array;
  htfByTime: Map<number, "long" | "short" | null>;
}

/** Build HTF alignment map from 15m candles — call once per symbol. */
export function buildHtfAlignmentMap(
  candles: Candle[],
  biasTf: string,
  zoneTf: string,
  entryTf: string,
): Map<number, "long" | "short" | null> {
  const biasBars = aggregate(candles, biasTf, entryTf);
  const zoneBars = aggregate(candles, zoneTf, entryTf);
  const biasSwings = findSwings(biasBars);
  const zoneSwings = findSwings(zoneBars);
  const out = new Map<number, "long" | "short" | null>();

  for (const c of candles) {
    const closeTime = c.openTime + TF_MS[entryTf];
    const biasCount = htfClosedCount(biasBars, closeTime);
    const zoneCount = htfClosedCount(zoneBars, closeTime);
    if (biasCount < 5 || zoneCount < 20) {
      out.set(c.openTime, null);
      continue;
    }
    const bs = structureBias(biasSwings, biasCount - 1);
    const zs = structureBias(zoneSwings, zoneCount - 1);
    if (bs.bias === zs.bias) {
      out.set(c.openTime, bs.bias === "bull" ? "long" : bs.bias === "bear" ? "short" : null);
    } else {
      out.set(c.openTime, null);
    }
  }
  return out;
}

/** Precompute ATR, volumes, and HTF alignment for a symbol's 15m candles. */
export function precompute(candles: Candle[], config: AbsorptionConfig): PrecomputedData {
  const atrs = atr15m(candles);
  const volumes = candles.map(quoteVolume);
  const volPrefix = new Float64Array(volumes.length + 1);
  for (let i = 0; i < volumes.length; i++) volPrefix[i + 1] = volPrefix[i] + volumes[i];
  const htfByTime = buildHtfAlignmentMap(candles, config.htfBiasTf, config.htfZoneTf, config.entryTf);
  return { atrs, volumes, volPrefix, htfByTime };
}

export function findAbsorptionRetest(
  candles: Candle[],
  zones: AbsorptionZone[],
  index: number,
  config: AbsorptionConfig,
  pre: PrecomputedData,
): AbsorptionSignal | null {
  if (index < config.lookback) return null;
  const c = candles[index];

  const htfDir = pre.htfByTime.get(c.openTime) ?? null;

  for (const zone of zones) {
    if (index <= zone.eventIndex) continue;
    if (index - zone.eventIndex > config.maxRetestBars) continue;

    // Check departure
    let departed = false;
    const departThresh = config.departAtr * pre.atrs[zone.eventIndex];
    for (let j = zone.eventIndex + 1; j <= index; j++) {
      if (zone.direction === "long" && candles[j].close >= zone.zoneHigh + departThresh) {
        departed = true; break;
      }
      if (zone.direction === "short" && candles[j].close <= zone.zoneLow - departThresh) {
        departed = true; break;
      }
    }
    if (!departed) continue;

    // Check retest touch
    if (c.low <= zone.zoneHigh && c.high >= zone.zoneLow) {
      // Absorption checks
      const retestBaseline = rangeSum(pre.volPrefix, index - config.lookback, index) / config.lookback;
      if (!(retestBaseline > 0)) continue;
      const retestVolRatio = pre.volumes[index] / retestBaseline;
      if (retestVolRatio < config.retestVolMult) continue;

      const retestFlowClass = flowClass(aggregateBuyRatio(candles, index, index), zone.direction, config.retestFlowMin);
      if (retestFlowClass !== "opposite") continue;

      const retestRange = c.high - c.low;
      if (retestRange <= 0) continue;
      const retestBodyRatio = Math.abs(c.close - c.open) / retestRange;
      const retestCloseStrength = zone.direction === "long"
        ? (c.close - c.low) / retestRange
        : (c.high - c.close) / retestRange;

      if (retestCloseStrength < 0.55) continue;
      // bodyRatio <= 0.35 bỏ: audit gốc dùng cho "effort" variant, không phải "absorption".

      const htfAligned = htfDir === zone.direction;

      return {
        direction: zone.direction,
        retestIndex: index,
        retestTime: c.openTime,
        zoneLow: zone.zoneLow,
        zoneHigh: zone.zoneHigh,
        eventIndex: zone.eventIndex,
        eventTime: zone.eventTime,
        retestVolRatio,
        htfAligned,
      };
    }
  }

  return null;
}

export function findConfirmationEntry(
  candles: Candle[],
  signal: AbsorptionSignal,
  startIndex: number,
  maxBars: number
): number | null {
  const end = Math.min(candles.length - 1, signal.retestIndex + maxBars);
  const reclaim = signal.direction === "long" ? candles[signal.retestIndex].high : candles[signal.retestIndex].low;
  
  for (let i = Math.max(startIndex, signal.retestIndex + 1); i <= end; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    
    // Check Reclaim
    const crossedReclaim = signal.direction === "long"
      ? prev.close <= reclaim && c.close > reclaim
      : prev.close >= reclaim && c.close < reclaim;
    if (crossedReclaim) return i;
    
    // Check BOS
    const swingType = signal.direction === "long" ? "high" : "low";
    const swing = lastConfirmedSwing(candles, i, swingType, 3, 3, 40, signal.retestIndex);
    if (swing) {
      const crossedBOS = signal.direction === "long"
        ? prev.close <= swing.price && c.close > swing.price
        : prev.close >= swing.price && c.close < swing.price;
      if (crossedBOS) return i;
    }
  }
  return null;
}

export function computeAbsorptionTrade(
  candles: Candle[],
  signal: AbsorptionSignal,
  entryIndex: number,
  config: AbsorptionConfig
): AbsorptionTrade | null {
  const entry = candles[entryIndex].close;
  const atrs = atr15m(candles);
  const slice = candles.slice(signal.retestIndex, entryIndex + 1);
  
  const protectedExtreme = signal.direction === "long"
    ? Math.min(signal.zoneLow, ...slice.map((c) => c.low))
    : Math.max(signal.zoneHigh, ...slice.map((c) => c.high));
    
  const stop = signal.direction === "long"
    ? protectedExtreme - config.stopPadAtr * atrs[entryIndex]
    : protectedExtreme + config.stopPadAtr * atrs[entryIndex];
    
  const risk = Math.abs(entry - stop);
  const riskFrac = risk / entry;
  
  if (!(risk > 0) || riskFrac > config.maxStopPct) return null;
  
  const target = signal.direction === "long" 
    ? entry + config.targetRR * risk 
    : entry - config.targetRR * risk;
    
  return {
    direction: signal.direction,
    entryIndex,
    entryTime: candles[entryIndex].openTime,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    riskFrac
  };
}
