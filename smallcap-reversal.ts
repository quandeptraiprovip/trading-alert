/**
 * Native small-cap reversal research engine.
 *
 * Signals use a point-in-time cross-section at a completed daily observation.
 * The lowest de-trended-volume cohort is ranked by market-residual return:
 * long prior losers, short prior winners. No live module imports this file.
 */
import { SmallCapDirection, WeightedSmallCapSignal } from "./smallcap-research";

const DAY = 24 * 60 * 60 * 1000;

export interface ReversalObservation {
  symbol: string;
  observedAt: number;
  listedAt: number;
  close: number;
  quoteVolume: number;
  marketCapUsd: number;
  spreadBps: number;
  depth20BpsUsd: number;
  active: boolean;
  stable: boolean;
  wrapped: boolean;
  shortable: boolean;
  /** Listing/unlock/news/manipulation quarantine known at observedAt. */
  eventRisk: boolean;
}

export interface SmallCapReversalParams {
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minHistoryDays: number;
  volumeLookbackDays: number;
  minQuoteVolumeUsd: number;
  maxSpreadBps: number;
  minDepth20BpsUsd: number;
  maxAbsoluteDailyReturn: number;
  maxVolumeShockZ: number;
  lowVolumeFraction: number;
  minCrossSection: number;
  picksPerSide: number;
}

export const SMALLCAP_REVERSAL_DEFAULTS: SmallCapReversalParams = {
  minMarketCapUsd: 25_000_000,
  maxMarketCapUsd: 5_000_000_000,
  minHistoryDays: 365,
  volumeLookbackDays: 30,
  minQuoteVolumeUsd: 5_000_000,
  maxSpreadBps: 20,
  minDepth20BpsUsd: 50_000,
  maxAbsoluteDailyReturn: 0.20,
  maxVolumeShockZ: 3,
  lowVolumeFraction: 1 / 3,
  minCrossSection: 12,
  picksPerSide: 2,
};

export interface SmallCapReversalSignal extends WeightedSmallCapSignal {
  signalTime: number;
  rawReturn: number;
  marketReturn: number;
  residualReturn: number;
  volumeShockZ: number;
  marketCapUsd: number;
  shortable: boolean;
}

type Feature = Omit<SmallCapReversalSignal, "direction" | "weight">;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function volumeShock(current: number, prior: number[]): number {
  const values = prior.map(Math.log);
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return NaN;
  return (Math.log(current) - average) / sd;
}

function eligibleCurrent(
  current: ReversalObservation,
  signalTime: number,
  params: SmallCapReversalParams,
): boolean {
  const listingAgeDays = (signalTime - current.listedAt) / DAY;
  return current.active
    && !current.stable
    && !current.wrapped
    && !current.eventRisk
    && current.close > 0
    && current.quoteVolume >= params.minQuoteVolumeUsd
    && current.marketCapUsd >= params.minMarketCapUsd
    && current.marketCapUsd <= params.maxMarketCapUsd
    && current.spreadBps <= params.maxSpreadBps
    && current.depth20BpsUsd >= params.minDepth20BpsUsd
    && listingAgeDays >= params.minHistoryDays;
}

function validateParams(params: SmallCapReversalParams): void {
  if (!(params.minMarketCapUsd > 0 && params.maxMarketCapUsd > params.minMarketCapUsd)) {
    throw new Error("Khoảng market cap không hợp lệ");
  }
  if (!(params.volumeLookbackDays > 1 && params.minHistoryDays >= params.volumeLookbackDays)) {
    throw new Error("History phải dài hơn volume lookback");
  }
  if (!(params.lowVolumeFraction > 0 && params.lowVolumeFraction <= 1)) {
    throw new Error("lowVolumeFraction phải thuộc (0, 1]");
  }
  if (!(params.picksPerSide > 0 && Number.isInteger(params.picksPerSide))) {
    throw new Error("picksPerSide phải là số nguyên dương");
  }
}

export function buildSmallCapReversalSignals(
  observations: ReversalObservation[],
  signalTime: number,
  params: SmallCapReversalParams = SMALLCAP_REVERSAL_DEFAULTS,
): SmallCapReversalSignal[] {
  validateParams(params);
  const histories = new Map<string, ReversalObservation[]>();
  for (const observation of observations) {
    if (observation.observedAt > signalTime) continue;
    const symbol = observation.symbol.toLowerCase();
    const rows = histories.get(symbol) ?? [];
    rows.push({ ...observation, symbol });
    histories.set(symbol, rows);
  }

  const raw: Array<Omit<Feature, "marketReturn" | "residualReturn">> = [];
  for (const [symbol, unsorted] of histories) {
    const rows = [...unsorted].sort((a, b) => a.observedAt - b.observedAt);
    const index = rows.findIndex((row) => row.observedAt === signalTime);
    if (index < params.minHistoryDays || index < params.volumeLookbackDays) continue;
    const current = rows[index];
    if (!eligibleCurrent(current, signalTime, params)) continue;
    const previous = rows[index - 1];
    const rawReturn = current.close / previous.close - 1;
    const priorVolumes = rows
      .slice(index - params.volumeLookbackDays, index)
      .map((row) => row.quoteVolume);
    if (!(previous.close > 0) || priorVolumes.some((volume) => !(volume > 0))) continue;
    const volumeShockZ = volumeShock(current.quoteVolume, priorVolumes);
    if (!Number.isFinite(volumeShockZ)) continue;
    if (Math.abs(rawReturn) >= params.maxAbsoluteDailyReturn) continue;
    if (volumeShockZ >= params.maxVolumeShockZ) continue;
    raw.push({
      symbol,
      signalTime,
      rawReturn,
      volumeShockZ,
      marketCapUsd: current.marketCapUsd,
      shortable: current.shortable,
    });
  }
  if (raw.length < params.minCrossSection) return [];

  const marketReturn = median(raw.map((feature) => feature.rawReturn));
  const features: Feature[] = raw.map((feature) => ({
    ...feature,
    marketReturn,
    residualReturn: feature.rawReturn - marketReturn,
  }));
  const lowVolumeCount = Math.max(
    2 * params.picksPerSide,
    Math.floor(features.length * params.lowVolumeFraction),
  );
  const lowVolume = [...features]
    .sort((a, b) => a.volumeShockZ - b.volumeShockZ || a.symbol.localeCompare(b.symbol))
    .slice(0, lowVolumeCount);
  if (lowVolume.length < 2 * params.picksPerSide) return [];

  const longs = [...lowVolume]
    .sort((a, b) => a.residualReturn - b.residualReturn || a.symbol.localeCompare(b.symbol))
    .slice(0, params.picksPerSide);
  const longSymbols = new Set(longs.map((feature) => feature.symbol));
  const shorts = [...lowVolume]
    .filter((feature) => feature.shortable && !longSymbols.has(feature.symbol))
    .sort((a, b) => b.residualReturn - a.residualReturn || a.symbol.localeCompare(b.symbol))
    .slice(0, params.picksPerSide);
  if (shorts.length !== params.picksPerSide) return [];

  return [
    ...longs.map((feature): SmallCapReversalSignal => ({
      ...feature,
      direction: "long",
      weight: 1 / longs.length,
    })),
    ...shorts.map((feature): SmallCapReversalSignal => ({
      ...feature,
      direction: "short",
      weight: -1 / shorts.length,
    })),
  ];
}

export interface TopOfBook {
  observedAt: number;
  bid: number;
  ask: number;
}

export interface PassiveOrder {
  symbol: string;
  direction: SmallCapDirection;
  placedAt: number;
  expiresAt: number;
  limitPrice: number;
  bestBidAtPlacement: number;
  bestAskAtPlacement: number;
}

export interface AggregateTrade {
  tradedAt: number;
  price: number;
  quoteQuantity: number;
  /** Binance aggTrade `m`: true means the buyer was maker. */
  buyerIsMaker: boolean;
}

export function quotePassiveOrder(
  signal: SmallCapReversalSignal,
  book: TopOfBook,
  ttlMs: number,
): PassiveOrder {
  if (!(book.bid > 0 && book.ask > book.bid)) throw new Error("Top-of-book không hợp lệ");
  if (!(ttlMs > 0)) throw new Error("ttlMs phải > 0");
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    placedAt: book.observedAt,
    expiresAt: book.observedAt + ttlMs,
    limitPrice: signal.direction === "long" ? book.bid : book.ask,
    bestBidAtPlacement: book.bid,
    bestAskAtPlacement: book.ask,
  };
}

export type MakerFillResult = {
  status: "filled" | "unfilled" | "post-only-rejected";
  fillTime?: number;
  fillPrice?: number;
};

export function simulateConservativeMakerFill(
  order: PassiveOrder,
  trades: AggregateTrade[],
): MakerFillResult {
  const crosses = order.direction === "long"
    ? order.limitPrice >= order.bestAskAtPlacement
    : order.limitPrice <= order.bestBidAtPlacement;
  if (crosses) return { status: "post-only-rejected" };

  const ordered = trades
    .filter((trade) => trade.tradedAt >= order.placedAt && trade.tradedAt <= order.expiresAt)
    .sort((a, b) => a.tradedAt - b.tradedAt);
  const fill = ordered.find((trade) => order.direction === "long"
    ? trade.buyerIsMaker && trade.price < order.limitPrice
    : !trade.buyerIsMaker && trade.price > order.limitPrice);
  return fill
    ? { status: "filled", fillTime: fill.tradedAt, fillPrice: order.limitPrice }
    : { status: "unfilled" };
}
