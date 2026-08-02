import assert from "node:assert/strict";
import {
  ALT_TREND_DEFAULTS,
  evaluateTradability,
  runAltTrendPortfolio,
  selectAltTrendCandidates,
} from "./alt-trend";
import { Candle, TF_MS } from "./strategy";

const DAY = TF_MS["1d"];

function series(
  days: number,
  start: number,
  dailyReturn: number,
  quoteVolume = 10_000_000,
): Candle[] {
  const out: Candle[] = [];
  let close = start;
  for (let i = 0; i < days; i++) {
    const open = close;
    close = open * (1 + dailyReturn);
    out.push({
      openTime: i * DAY,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: quoteVolume / close,
      quoteVolume,
      takerBuyVolume: quoteVolume / close / 2,
    });
  }
  return out;
}

const TEST_PARAMS = {
  ...ALT_TREND_DEFAULTS,
  formationDays: 5,
  trendSmaDays: 10,
  btcFastDays: 3,
  btcSlowDays: 10,
  quoteVolumeLookbackDays: 5,
  minHistoryDays: 10,
  atrPeriodDays: 3,
  exitChannelDays: 3,
  maxHoldDays: 20,
  maxPositions: 1,
  plannedNotionalUsd: 100,
  minQuoteVolumeToNotional: 100,
  sideCostBps: 10,
  fundingBpsPer8h: 0,
};

function testTradabilityGate(): void {
  const base = {
    symbol: "MIDUSDT",
    onboardDate: 0,
    quoteVolume24h: 3_000_000,
    bid: 99.95,
    ask: 100.05,
    bidDepth20Bps: 10_000,
    askDepth20Bps: 8_000,
    openInterestValue: 200_000,
    adlRisk: "low" as const,
    observedAt: 200 * DAY,
  };
  const pass = evaluateTradability(base, 100);
  assert.equal(pass.eligible, true);
  assert.deepEqual(pass.reasons, []);

  const fail = evaluateTradability({
    ...base,
    quoteVolume24h: 100_000,
    ask: 100.30,
    bidDepth20Bps: 1_000,
    openInterestValue: 50_000,
    adlRisk: "high",
  }, 100);
  assert.equal(fail.eligible, false);
  assert.ok(fail.reasons.includes("quote-volume"));
  assert.ok(fail.reasons.includes("spread"));
  assert.ok(fail.reasons.includes("depth"));
  assert.ok(fail.reasons.includes("open-interest"));
  assert.ok(fail.reasons.includes("adl-risk"));
}

function testRankingRegimeAndNextOpen(): void {
  const btc = series(50, 100, 0.005);
  const fast = series(50, 10, 0.02);
  const slow = series(50, 10, 0.01);
  const falling = series(50, 10, -0.01);
  const data = new Map<string, Candle[]>([
    ["fastusdt", fast],
    ["slowusdt", slow],
    ["fallusdt", falling],
  ]);
  const entryTime = 11 * DAY;
  const candidates = selectAltTrendCandidates(data, btc, entryTime, TEST_PARAMS);
  assert.deepEqual(candidates.map((candidate) => candidate.symbol), ["fastusdt", "slowusdt"]);

  const trades = runAltTrendPortfolio(data, btc, TEST_PARAMS);
  assert.ok(trades.length > 0);
  assert.equal(trades[0].symbol, "fastusdt");
  assert.equal(trades[0].entryTime, entryTime);
  assert.equal(trades[0].entryPrice, fast[11].open, "signal nến trước phải fill ở open kế tiếp");

  const bearBtc = series(50, 100, -0.005);
  assert.equal(runAltTrendPortfolio(data, bearBtc, TEST_PARAMS).length, 0);
}

function testNoFutureLeakAndCostStress(): void {
  const btc = series(50, 100, 0.005);
  const fast = series(50, 10, 0.02);
  const data = new Map<string, Candle[]>([["fastusdt", fast]]);
  const entryTime = 20 * DAY;
  const before = selectAltTrendCandidates(data, btc, entryTime, TEST_PARAMS);

  const future = {
    ...fast[fast.length - 1],
    openTime: 50 * DAY,
    open: 1,
    high: 1,
    low: 0.1,
    close: 0.2,
  };
  const withFuture = new Map<string, Candle[]>([["fastusdt", [...fast, future]]]);
  const after = selectAltTrendCandidates(withFuture, [...btc, { ...future, close: 200 }], entryTime, TEST_PARAMS);
  assert.deepEqual(after, before, "dữ liệu sau entryTime không được đổi signal");

  const cheap = runAltTrendPortfolio(data, btc, { ...TEST_PARAMS, sideCostBps: 10 });
  const expensive = runAltTrendPortfolio(data, btc, { ...TEST_PARAMS, sideCostBps: 100 });
  assert.equal(expensive.length, cheap.length);
  assert.equal(
    expensive.reduce((sum, trade) => sum + trade.grossR, 0),
    cheap.reduce((sum, trade) => sum + trade.grossR, 0),
  );
  assert.ok(
    expensive.reduce((sum, trade) => sum + trade.netR, 0)
      < cheap.reduce((sum, trade) => sum + trade.netR, 0),
  );

  const evaluationStart = 30 * DAY;
  const isolatedWindow = runAltTrendPortfolio(data, btc, TEST_PARAMS, { entryStartTime: evaluationStart });
  assert.ok(isolatedWindow.length > 0);
  assert.ok(isolatedWindow.every((trade) => trade.entryTime >= evaluationStart));
}

testTradabilityGate();
testRankingRegimeAndNextOpen();
testNoFutureLeakAndCostStress();
console.log("Alt Trend tests: OK");
