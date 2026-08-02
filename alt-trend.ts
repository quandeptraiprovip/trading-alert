/**
 * Alt Trend — research-only dual-momentum engine for liquid mid-cap perpetuals.
 *
 * This module is intentionally not imported by the live bot. Signals use only
 * completed daily candles and enter at the following daily open.
 */
import { Candle, TF_MS } from "./strategy";

const DAY = TF_MS["1d"];
const EIGHT_HOURS = 8 * 60 * 60 * 1000;

export type AdlRisk = "low" | "medium" | "high" | "unknown";

export interface TradabilitySnapshot {
  symbol: string;
  onboardDate: number;
  observedAt: number;
  quoteVolume24h: number;
  bid: number;
  ask: number;
  bidDepth20Bps: number;
  askDepth20Bps: number;
  openInterestValue: number;
  adlRisk: AdlRisk;
}

export interface TradabilityParams {
  minListingAgeDays: number;
  maxSpreadBps: number;
  minQuoteVolumeToNotional: number;
  minDepthToNotional: number;
  minOpenInterestToNotional: number;
}

export const ALT_UNIVERSE_DEFAULTS: TradabilityParams = {
  minListingAgeDays: 180,
  maxSpreadBps: 10,
  minQuoteVolumeToNotional: 20_000,
  minDepthToNotional: 50,
  minOpenInterestToNotional: 1_000,
};

export interface TradabilityResult {
  eligible: boolean;
  spreadBps: number;
  listingAgeDays: number;
  capacityUsd: number;
  reasons: Array<"age" | "quote-volume" | "spread" | "depth" | "open-interest" | "adl-risk">;
}

export function evaluateTradability(
  snapshot: TradabilitySnapshot,
  plannedNotionalUsd: number,
  params: TradabilityParams = ALT_UNIVERSE_DEFAULTS,
): TradabilityResult {
  if (!(plannedNotionalUsd > 0)) throw new Error("plannedNotionalUsd phải > 0");
  const mid = (snapshot.bid + snapshot.ask) / 2;
  const spreadBps = mid > 0 ? ((snapshot.ask - snapshot.bid) / mid) * 10_000 : Infinity;
  const listingAgeDays = Math.max(0, (snapshot.observedAt - snapshot.onboardDate) / DAY);
  const depth = Math.min(snapshot.bidDepth20Bps, snapshot.askDepth20Bps);
  const capacityUsd = Math.max(0, Math.min(
    snapshot.quoteVolume24h / params.minQuoteVolumeToNotional,
    depth / params.minDepthToNotional,
    snapshot.openInterestValue / params.minOpenInterestToNotional,
  ));
  const reasons: TradabilityResult["reasons"] = [];
  if (listingAgeDays < params.minListingAgeDays) reasons.push("age");
  if (snapshot.quoteVolume24h < plannedNotionalUsd * params.minQuoteVolumeToNotional) {
    reasons.push("quote-volume");
  }
  if (!(spreadBps <= params.maxSpreadBps)) reasons.push("spread");
  if (depth < plannedNotionalUsd * params.minDepthToNotional) reasons.push("depth");
  if (snapshot.openInterestValue < plannedNotionalUsd * params.minOpenInterestToNotional) {
    reasons.push("open-interest");
  }
  if (snapshot.adlRisk === "high") reasons.push("adl-risk");
  return { eligible: reasons.length === 0, spreadBps, listingAgeDays, capacityUsd, reasons };
}

export interface AltTrendParams {
  formationDays: number;
  trendSmaDays: number;
  btcFastDays: number;
  btcSlowDays: number;
  quoteVolumeLookbackDays: number;
  minHistoryDays: number;
  minQuoteVolumeToNotional: number;
  atrPeriodDays: number;
  stopAtr: number;
  exitChannelDays: number;
  maxHoldDays: number;
  maxPositions: number;
  cooldownDays: number;
  plannedNotionalUsd: number;
  sideCostBps: number;
  fundingBpsPer8h: number;
  delistHaircutBps: number;
}

export const ALT_TREND_DEFAULTS: AltTrendParams = {
  formationDays: 28,
  trendSmaDays: 100,
  btcFastDays: 10,
  btcSlowDays: 100,
  quoteVolumeLookbackDays: 30,
  minHistoryDays: 180,
  minQuoteVolumeToNotional: 20_000,
  atrPeriodDays: 20,
  stopAtr: 3,
  exitChannelDays: 20,
  maxHoldDays: 60,
  maxPositions: 4,
  cooldownDays: 1,
  plannedNotionalUsd: 100,
  sideCostBps: 25,
  fundingBpsPer8h: 1,
  delistHaircutBps: 1_000,
};

export interface AltTrendCandidate {
  symbol: string;
  score: number;
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  atr: number;
  medianQuoteVolume: number;
}

export interface AltTrendTrade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  initialStop: number;
  score: number;
  grossR: number;
  costR: number;
  netR: number;
  heldDays: number;
  exitReason: "stop" | "trend" | "channel" | "time" | "delist" | "end";
}

type Position = {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  initialStop: number;
  stop: number;
  extreme: number;
  initialRisk: number;
  score: number;
};

function exactIndex(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].openTime === time) return mid;
    if (candles[mid].openTime < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function smaAt(candles: Candle[], index: number, period: number): number {
  if (period <= 0 || index < period - 1) return NaN;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += candles[i].close;
  return sum / period;
}

function atrAt(candles: Candle[], index: number, period: number): number {
  if (period <= 0 || index < period) return NaN;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const previousClose = candles[i - 1].close;
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previousClose),
      Math.abs(candles[i].low - previousClose),
    );
  }
  return sum / period;
}

function medianQuoteVolume(candles: Candle[], index: number, period: number): number {
  if (period <= 0 || index < period - 1) return NaN;
  const values: number[] = [];
  for (let i = index - period + 1; i <= index; i++) {
    values.push(candles[i].quoteVolume ?? candles[i].volume * candles[i].close);
  }
  values.sort((a, b) => a - b);
  const mid = values.length >>> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function priorChannelLow(candles: Candle[], signalIndex: number, period: number): number {
  if (period <= 0 || signalIndex < period) return NaN;
  let low = Infinity;
  for (let i = signalIndex - period; i < signalIndex; i++) low = Math.min(low, candles[i].low);
  return low;
}

function btcAllowsLong(btc: Candle[], entryTime: number, params: AltTrendParams): boolean {
  const entryIndex = exactIndex(btc, entryTime);
  if (entryIndex <= 0) return false;
  const signalIndex = entryIndex - 1;
  const fast = smaAt(btc, signalIndex, params.btcFastDays);
  const slow = smaAt(btc, signalIndex, params.btcSlowDays);
  return Number.isFinite(fast) && Number.isFinite(slow) && fast > slow;
}

export function selectAltTrendCandidates(
  data: Map<string, Candle[]>,
  btc: Candle[],
  entryTime: number,
  params: AltTrendParams = ALT_TREND_DEFAULTS,
): AltTrendCandidate[] {
  if (!btcAllowsLong(btc, entryTime, params)) return [];
  const candidates: AltTrendCandidate[] = [];
  for (const [symbol, candles] of data) {
    const entryIndex = exactIndex(candles, entryTime);
    if (entryIndex <= 0) continue;
    const signalIndex = entryIndex - 1;
    if (signalIndex < params.minHistoryDays || signalIndex < params.formationDays) continue;
    const trend = smaAt(candles, signalIndex, params.trendSmaDays);
    const atr = atrAt(candles, signalIndex, params.atrPeriodDays);
    const quoteVolume = medianQuoteVolume(candles, signalIndex, params.quoteVolumeLookbackDays);
    if (!(candles[signalIndex].close > trend) || !(atr > 0)) continue;
    if (!(quoteVolume >= params.plannedNotionalUsd * params.minQuoteVolumeToNotional)) continue;
    const oldClose = candles[signalIndex - params.formationDays].close;
    const score = oldClose > 0 ? candles[signalIndex].close / oldClose - 1 : NaN;
    if (!(score > 0)) continue;
    candidates.push({
      symbol,
      score,
      signalTime: candles[signalIndex].openTime,
      entryTime,
      entryPrice: candles[entryIndex].open,
      atr,
      medianQuoteVolume: quoteVolume,
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
}

function closeTrade(
  position: Position,
  exitTime: number,
  exitPrice: number,
  exitReason: AltTrendTrade["exitReason"],
  params: AltTrendParams,
): AltTrendTrade {
  const grossR = (exitPrice - position.entryPrice) / position.initialRisk;
  const riskFraction = position.initialRisk / position.entryPrice;
  const heldMs = Math.max(0, exitTime - position.entryTime);
  const fundingPeriods = Math.floor(heldMs / EIGHT_HOURS);
  const costFraction = (2 * params.sideCostBps + fundingPeriods * params.fundingBpsPer8h) / 10_000;
  const costR = costFraction / riskFraction;
  return {
    symbol: position.symbol,
    entryTime: position.entryTime,
    exitTime,
    entryPrice: position.entryPrice,
    exitPrice,
    initialStop: position.initialStop,
    score: position.score,
    grossR,
    costR,
    netR: grossR - costR,
    heldDays: heldMs / DAY,
    exitReason,
  };
}

export function runAltTrendPortfolio(
  data: Map<string, Candle[]>,
  btc: Candle[],
  params: AltTrendParams = ALT_TREND_DEFAULTS,
  options: { entryStartTime?: number } = {},
): AltTrendTrade[] {
  const positions = new Map<string, Position>();
  const cooldownUntil = new Map<string, number>();
  const trades: AltTrendTrade[] = [];
  const lastTime = new Map([...data].map(([symbol, candles]) => [symbol, candles.at(-1)?.openTime ?? -Infinity]));

  const exit = (
    position: Position,
    time: number,
    price: number,
    reason: AltTrendTrade["exitReason"],
  ) => {
    trades.push(closeTrade(position, time, price, reason, params));
    positions.delete(position.symbol);
    cooldownUntil.set(position.symbol, time + params.cooldownDays * DAY);
  };

  for (const btcCandle of btc) {
    const time = btcCandle.openTime;
    const closedToday = new Set<string>();

    // Close-at-open decisions use only the previous completed daily candle.
    for (const [symbol, position] of [...positions]) {
      const candles = data.get(symbol)!;
      const index = exactIndex(candles, time);
      if (index < 0) {
        if (time > (lastTime.get(symbol) ?? Infinity)) {
          const last = candles.at(-1)!;
          const price = last.close * (1 - params.delistHaircutBps / 10_000);
          exit(position, time, price, "delist");
          closedToday.add(symbol);
        }
        continue;
      }
      if (index === 0) continue;
      const signalIndex = index - 1;
      const heldDays = (time - position.entryTime) / DAY;
      let reason: AltTrendTrade["exitReason"] | null = null;
      if (heldDays >= params.maxHoldDays) reason = "time";
      else if (candles[signalIndex].close < smaAt(candles, signalIndex, params.trendSmaDays)) reason = "trend";
      else if (candles[signalIndex].close < priorChannelLow(candles, signalIndex, params.exitChannelDays)) reason = "channel";
      if (reason) {
        exit(position, time, candles[index].open, reason);
        closedToday.add(symbol);
      }
    }

    const vacancies = params.maxPositions - positions.size;
    if (vacancies > 0 && time >= (options.entryStartTime ?? -Infinity)) {
      const candidates = selectAltTrendCandidates(data, btc, time, params)
        .filter((candidate) => !positions.has(candidate.symbol))
        .filter((candidate) => !closedToday.has(candidate.symbol))
        .filter((candidate) => time >= (cooldownUntil.get(candidate.symbol) ?? -Infinity))
        .slice(0, vacancies);
      for (const candidate of candidates) {
        const initialStop = candidate.entryPrice - params.stopAtr * candidate.atr;
        const initialRisk = candidate.entryPrice - initialStop;
        if (!(initialStop > 0) || !(initialRisk > 0)) continue;
        positions.set(candidate.symbol, {
          symbol: candidate.symbol,
          entryTime: time,
          entryPrice: candidate.entryPrice,
          initialStop,
          stop: initialStop,
          extreme: candidate.entryPrice,
          initialRisk,
          score: candidate.score,
        });
      }
    }

    // Intraday hard stop uses the stop known before this candle. The stop is
    // tightened only after the candle closes, so there is no same-bar lookahead.
    for (const [symbol, position] of [...positions]) {
      const candles = data.get(symbol)!;
      const index = exactIndex(candles, time);
      if (index < 0) continue;
      const candle = candles[index];
      if (candle.low <= position.stop) {
        exit(position, time, Math.min(candle.open, position.stop), "stop");
        continue;
      }
      const atr = atrAt(candles, index, params.atrPeriodDays);
      position.extreme = Math.max(position.extreme, candle.high);
      if (atr > 0) position.stop = Math.max(position.stop, position.extreme - params.stopAtr * atr);
    }
  }

  // Mark-to-market only for research reporting; live/shadow code is not connected.
  for (const [symbol, position] of positions) {
    const last = data.get(symbol)!.at(-1)!;
    exit(position, last.openTime + DAY, last.close, "end");
  }
  return trades.sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
}
