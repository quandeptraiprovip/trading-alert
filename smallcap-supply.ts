/**
 * Native small-cap supply-pressure factor (research-only).
 *
 * The input must be a point-in-time weekly snapshot. High FDV premium,
 * dilution, upcoming unlock and exchange inflow raise pressure; usage growth
 * lowers it. Rank-based components avoid letting one extreme token dominate.
 */
import { WeightedSmallCapSignal } from "./smallcap-research";

const DAY = 24 * 60 * 60 * 1000;

export interface SupplyObservation {
  symbol: string;
  observedAt: number;
  listedAt: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupply: number;
  supply12WeeksAgo: number;
  unlock30dTokens: number;
  exchangeNetInflowTokens: number;
  usageGrowth12Weeks: number;
  quoteVolume30dMedianUsd: number;
  active: boolean;
  stable: boolean;
  wrapped: boolean;
  shortable: boolean;
}

export interface SmallCapSupplyParams {
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minListingAgeDays: number;
  maxListingAgeDays: number;
  minQuoteVolume30dMedianUsd: number;
  minCrossSection: number;
  picksPerSide: number;
  requirePositiveUsageForLong: boolean;
}

export const SMALLCAP_SUPPLY_DEFAULTS: SmallCapSupplyParams = {
  minMarketCapUsd: 25_000_000,
  maxMarketCapUsd: 5_000_000_000,
  minListingAgeDays: 84,
  maxListingAgeDays: 365,
  minQuoteVolume30dMedianUsd: 5_000_000,
  minCrossSection: 12,
  picksPerSide: 2,
  requirePositiveUsageForLong: true,
};

type SupplyFeature = {
  observation: SupplyObservation;
  fdvPremium: number;
  dilution12Weeks: number;
  unlock30dPct: number;
  exchangeInflowPct: number;
};

export interface SmallCapSupplySignal extends WeightedSmallCapSignal {
  observedAt: number;
  pressureScore: number;
  fdvPremium: number;
  dilution12Weeks: number;
  unlock30dPct: number;
  exchangeInflowPct: number;
  usageGrowth12Weeks: number;
}

function percentileRanks(values: number[]): number[] {
  if (values.length === 1) return [0.5];
  const sorted = values.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = Array(values.length).fill(0);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const averageIndex = (start + end - 1) / 2;
    for (let i = start; i < end; i++) ranks[sorted[i].index] = averageIndex / (values.length - 1);
    start = end;
  }
  return ranks;
}

function eligible(observation: SupplyObservation, params: SmallCapSupplyParams): boolean {
  const listingAgeDays = (observation.observedAt - observation.listedAt) / DAY;
  return observation.active
    && !observation.stable
    && !observation.wrapped
    && observation.marketCapUsd >= params.minMarketCapUsd
    && observation.marketCapUsd <= params.maxMarketCapUsd
    && observation.quoteVolume30dMedianUsd >= params.minQuoteVolume30dMedianUsd
    && listingAgeDays >= params.minListingAgeDays
    && listingAgeDays <= params.maxListingAgeDays
    && observation.fdvUsd > 0
    && observation.circulatingSupply > 0
    && observation.supply12WeeksAgo > 0
    && observation.unlock30dTokens >= 0;
}

export function buildSmallCapSupplySignals(
  observations: SupplyObservation[],
  params: SmallCapSupplyParams = SMALLCAP_SUPPLY_DEFAULTS,
): SmallCapSupplySignal[] {
  if (!(params.picksPerSide > 0 && Number.isInteger(params.picksPerSide))) {
    throw new Error("picksPerSide phải là số nguyên dương");
  }
  if (!(params.maxListingAgeDays > params.minListingAgeDays)) {
    throw new Error("Khoảng tuổi listing không hợp lệ");
  }
  if (new Set(observations.map((observation) => observation.observedAt)).size > 1) {
    throw new Error("Supply observations phải thuộc cùng một point-in-time snapshot");
  }
  const eligibleRows = observations
    .filter((observation) => eligible(observation, params))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (eligibleRows.length < params.minCrossSection) return [];

  const features: SupplyFeature[] = eligibleRows.map((observation) => ({
    observation,
    fdvPremium: Math.max(0, observation.fdvUsd / observation.marketCapUsd - 1),
    dilution12Weeks: observation.circulatingSupply / observation.supply12WeeksAgo - 1,
    unlock30dPct: observation.unlock30dTokens / observation.circulatingSupply,
    exchangeInflowPct: observation.exchangeNetInflowTokens / observation.circulatingSupply,
  }));
  const fdvRanks = percentileRanks(features.map((feature) => feature.fdvPremium));
  const dilutionRanks = percentileRanks(features.map((feature) => feature.dilution12Weeks));
  const unlockRanks = percentileRanks(features.map((feature) => feature.unlock30dPct));
  const inflowRanks = percentileRanks(features.map((feature) => feature.exchangeInflowPct));
  const usageRanks = percentileRanks(features.map((feature) => feature.observation.usageGrowth12Weeks));
  const ranked = features.map((feature, index) => ({
    feature,
    pressureScore: (
      fdvRanks[index]
      + dilutionRanks[index]
      + unlockRanks[index]
      + inflowRanks[index]
      + (1 - usageRanks[index])
    ) / 5,
  }));

  const longs = [...ranked]
    .filter(({ feature }) => !params.requirePositiveUsageForLong
      || feature.observation.usageGrowth12Weeks > 0)
    .sort((a, b) => a.pressureScore - b.pressureScore
      || a.feature.observation.symbol.localeCompare(b.feature.observation.symbol))
    .slice(0, params.picksPerSide);
  const longSymbols = new Set(longs.map(({ feature }) => feature.observation.symbol));
  const shorts = [...ranked]
    .filter(({ feature }) => feature.observation.shortable
      && !longSymbols.has(feature.observation.symbol))
    .sort((a, b) => b.pressureScore - a.pressureScore
      || a.feature.observation.symbol.localeCompare(b.feature.observation.symbol))
    .slice(0, params.picksPerSide);
  if (longs.length !== params.picksPerSide || shorts.length !== params.picksPerSide) return [];

  const toSignal = (
    item: typeof ranked[number],
    direction: "long" | "short",
    weight: number,
  ): SmallCapSupplySignal => ({
    symbol: item.feature.observation.symbol.toLowerCase(),
    direction,
    weight,
    observedAt: item.feature.observation.observedAt,
    pressureScore: item.pressureScore,
    fdvPremium: item.feature.fdvPremium,
    dilution12Weeks: item.feature.dilution12Weeks,
    unlock30dPct: item.feature.unlock30dPct,
    exchangeInflowPct: item.feature.exchangeInflowPct,
    usageGrowth12Weeks: item.feature.observation.usageGrowth12Weeks,
  });
  return [
    ...longs.map((item) => toSignal(item, "long", 1 / longs.length)),
    ...shorts.map((item) => toSignal(item, "short", -1 / shorts.length)),
  ];
}
