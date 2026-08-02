import assert from "node:assert/strict";
import {
  ReversalObservation,
  SMALLCAP_REVERSAL_DEFAULTS,
  buildSmallCapReversalSignals,
  quotePassiveOrder,
  simulateConservativeMakerFill,
} from "./smallcap-reversal";
import {
  SMALLCAP_SUPPLY_DEFAULTS,
  SupplyObservation,
  buildSmallCapSupplySignals,
} from "./smallcap-supply";
import { evaluateSmallCapPeriod } from "./smallcap-research";

const DAY = 24 * 60 * 60 * 1000;

function reversalSeries(
  symbol: string,
  finalReturn: number,
  finalVolume: number,
  overrides: Partial<ReversalObservation> = {},
): ReversalObservation[] {
  const closes = [100, 100, 100, 100, 100 * (1 + finalReturn)];
  return closes.map((close, day) => ({
    symbol,
    observedAt: day * DAY,
    listedAt: -20 * DAY,
    close,
    quoteVolume: day === closes.length - 1 ? finalVolume : [90, 100, 110, 100][day],
    marketCapUsd: 100_000_000,
    spreadBps: 8,
    depth20BpsUsd: 100_000,
    active: true,
    stable: false,
    wrapped: false,
    shortable: true,
    eventRisk: false,
    ...overrides,
  }));
}

const REVERSAL_PARAMS = {
  ...SMALLCAP_REVERSAL_DEFAULTS,
  minHistoryDays: 4,
  volumeLookbackDays: 3,
  minCrossSection: 4,
  lowVolumeFraction: 0.5,
  picksPerSide: 1,
  minQuoteVolumeUsd: 1,
  minDepth20BpsUsd: 1,
  maxVolumeShockZ: 5,
};

function testNativeReversalRankingAndQuarantine(): void {
  const observations = [
    ...reversalSeries("loser", -0.10, 70),
    ...reversalSeries("winner", 0.10, 80),
    ...reversalSeries("middle-down", -0.02, 110),
    ...reversalSeries("middle-up", 0.02, 120),
    ...reversalSeries("event", -0.15, 60, { eventRisk: true }),
    ...reversalSeries("pump", 0.30, 65),
  ];
  const signals = buildSmallCapReversalSignals(observations, 4 * DAY, REVERSAL_PARAMS);
  assert.deepEqual(
    signals.map((signal) => [signal.symbol, signal.direction]),
    [["loser", "long"], ["winner", "short"]],
  );
  assert.ok(signals.every((signal) => signal.volumeShockZ < 0));
  assert.equal(signals.reduce((sum, signal) => sum + signal.weight, 0), 0);

  const afterFutureAppend = buildSmallCapReversalSignals([
    ...observations,
    ...reversalSeries("loser", 0.80, 1_000).map((row) => ({
      ...row,
      observedAt: row.observedAt + 10 * DAY,
    })),
  ], 4 * DAY, REVERSAL_PARAMS);
  assert.deepEqual(afterFutureAppend, signals, "dữ liệu tương lai không được đổi signal cũ");
}

function testConservativeMakerFill(): void {
  const signal = buildSmallCapReversalSignals([
    ...reversalSeries("loser", -0.10, 70),
    ...reversalSeries("winner", 0.10, 80),
    ...reversalSeries("middle-down", -0.02, 110),
    ...reversalSeries("middle-up", 0.02, 120),
  ], 4 * DAY, REVERSAL_PARAMS)[0];
  const order = quotePassiveOrder(signal, {
    observedAt: 5 * DAY,
    bid: 89.9,
    ask: 90.1,
  }, 60_000);
  assert.equal(order.limitPrice, 89.9);

  const touchedOnly = simulateConservativeMakerFill(order, [{
    tradedAt: 5 * DAY + 1_000,
    price: 89.9,
    quoteQuantity: 10_000,
    buyerIsMaker: true,
  }]);
  assert.equal(touchedOnly.status, "unfilled", "chạm giá chưa đủ để giả định fill");

  const tradedThrough = simulateConservativeMakerFill(order, [{
    tradedAt: 5 * DAY + 2_000,
    price: 89.8,
    quoteQuantity: 10_000,
    buyerIsMaker: true,
  }]);
  assert.equal(tradedThrough.status, "filled");
  assert.equal(tradedThrough.fillPrice, 89.9);
}

function supply(
  symbol: string,
  values: Pick<SupplyObservation,
    "fdvUsd" | "circulatingSupply" | "supply12WeeksAgo" | "unlock30dTokens"
    | "exchangeNetInflowTokens" | "usageGrowth12Weeks">,
  overrides: Partial<SupplyObservation> = {},
): SupplyObservation {
  return {
    symbol,
    observedAt: 200 * DAY,
    listedAt: 20 * DAY,
    marketCapUsd: 100_000_000,
    quoteVolume30dMedianUsd: 10_000_000,
    active: true,
    stable: false,
    wrapped: false,
    shortable: true,
    ...values,
    ...overrides,
  };
}

function testSupplyPressureRanking(): void {
  const low = supply("low", {
    fdvUsd: 105_000_000,
    circulatingSupply: 100,
    supply12WeeksAgo: 100,
    unlock30dTokens: 0,
    exchangeNetInflowTokens: -2,
    usageGrowth12Weeks: 0.30,
  });
  const high = supply("high", {
    fdvUsd: 500_000_000,
    circulatingSupply: 150,
    supply12WeeksAgo: 100,
    unlock30dTokens: 30,
    exchangeNetInflowTokens: 20,
    usageGrowth12Weeks: -0.20,
  });
  const observations = [
    low,
    high,
    supply("mid-a", {
      fdvUsd: 180_000_000, circulatingSupply: 110, supply12WeeksAgo: 100,
      unlock30dTokens: 5, exchangeNetInflowTokens: 2, usageGrowth12Weeks: 0.05,
    }),
    supply("mid-b", {
      fdvUsd: 220_000_000, circulatingSupply: 115, supply12WeeksAgo: 100,
      unlock30dTokens: 8, exchangeNetInflowTokens: 4, usageGrowth12Weeks: 0.01,
    }),
  ];
  const signals = buildSmallCapSupplySignals(observations, {
    ...SMALLCAP_SUPPLY_DEFAULTS,
    minCrossSection: 4,
    picksPerSide: 1,
    minQuoteVolume30dMedianUsd: 1,
  });
  assert.deepEqual(
    signals.map((signal) => [signal.symbol, signal.direction]),
    [["low", "long"], ["high", "short"]],
  );
  assert.ok(signals[0].pressureScore < signals[1].pressureScore);
  assert.equal(signals.reduce((sum, signal) => sum + signal.weight, 0), 0);

  const withoutShort = buildSmallCapSupplySignals([
    low,
    { ...high, shortable: false },
    ...observations.slice(2),
  ], {
    ...SMALLCAP_SUPPLY_DEFAULTS,
    minCrossSection: 4,
    picksPerSide: 1,
    minQuoteVolume30dMedianUsd: 1,
  });
  assert.ok(!withoutShort.some((signal) => signal.symbol === "high" && signal.direction === "short"));

  assert.throws(() => buildSmallCapSupplySignals([
    low,
    { ...high, observedAt: high.observedAt + DAY },
  ], {
    ...SMALLCAP_SUPPLY_DEFAULTS,
    minCrossSection: 2,
    picksPerSide: 1,
    minQuoteVolume30dMedianUsd: 1,
  }), /point-in-time/);
}

function testResearchCostStress(): void {
  const signals = [
    { symbol: "loser", direction: "long" as const, weight: 1 },
    { symbol: "winner", direction: "short" as const, weight: -1 },
  ];
  const returns = new Map([["loser", 0.03], ["winner", -0.02]]);
  const base = evaluateSmallCapPeriod(signals, returns, { roundTripCostBps: 10 });
  const stress = evaluateSmallCapPeriod(signals, returns, { roundTripCostBps: 100 });
  assert.equal(base.grossReturn, stress.grossReturn);
  assert.ok(stress.netReturn < base.netReturn);
  assert.equal(evaluateSmallCapPeriod(signals, returns, {
    roundTripCostBps: 10,
    filledSymbols: new Set(["loser"]),
  }).trades.length, 1);
}

testNativeReversalRankingAndQuarantine();
testConservativeMakerFill();
testSupplyPressureRanking();
testResearchCostStress();
console.log("Small-cap native tests: OK");
