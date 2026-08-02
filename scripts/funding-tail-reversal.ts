/**
 * Funding-tail reversal — research-only, deliberately separate from the live bot.
 *
 * Hypothesis: an unusually high/low realized funding rate identifies crowded
 * positioning. Fade the tail after the rate is published, with an ATR-defined R.
 *
 * No-lookahead rules:
 * - z-score uses only earlier funding observations;
 * - signal rate must already be published;
 * - entry is the next 1h open after publication;
 * - same-bar SL/TP ambiguity is resolved against the strategy (SL first).
 *
 * Run:
 *   ./node_modules/.bin/ts-node scripts/funding-tail-reversal.ts [days=1200]
 *     [z=2] [stopAtr=2] [targetR=2] [holdHours=24]
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { CONFIG, Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";

const SYMBOLS = [
  "btcusdt", "ethusdt", "solusdt", "xrpusdt",
  "dogeusdt", "adausdt", "avaxusdt", "dotusdt",
];
const FUNDING_URL = "https://fapi.binance.com/fapi/v1/fundingRate";
const HOUR = TF_MS["1h"];
const DAY = TF_MS["1d"];
const FUNDING_LOOKBACK = 90;
const ATR_PERIOD = 24;

type Direction = "long" | "short";
type Funding = { fundingTime: number; fundingRate: number; markPrice: number };
type Params = { z: number; stopAtr: number; targetR: number; holdHours: number };
type Trade = {
  symbol: string;
  dir: Direction;
  signalTime: number;
  entryTime: number;
  exitTime: number;
  signalRate: number;
  signalZ: number;
  grossR: number;
  feeR: number;
  fundingR: number;
  netR: number;
  reason: "sl" | "target" | "time";
};

function fundingCachePath(symbol: string): string {
  return path.join(process.cwd(), ".cache", "funding", `${symbol}.json`);
}

function readFundingCache(symbol: string, start: number): Funding[] | null {
  try {
    const values = JSON.parse(fs.readFileSync(fundingCachePath(symbol), "utf8")) as Funding[];
    if (!Array.isArray(values) || !values.length || values[0].fundingTime > start) return null;
    if (Date.now() - values[values.length - 1].fundingTime > 2 * DAY) return null;
    return values.filter((value) => value.fundingTime >= start);
  } catch {
    return null;
  }
}

async function fetchFunding(symbol: string, start: number): Promise<Funding[]> {
  const cached = readFundingCache(symbol, start);
  if (cached) return cached;

  const out: Funding[] = [];
  let cursor = start;
  for (let page = 0; page < 100; page++) {
    const response = await axios.get(FUNDING_URL, {
      params: { symbol: symbol.toUpperCase(), startTime: cursor, limit: 1000 },
      timeout: 30_000,
    });
    const batch = (response.data as Array<Record<string, string | number>>).map((row) => ({
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate),
      markPrice: Number(row.markPrice),
    }));
    if (!batch.length) break;
    out.push(...batch);
    const next = batch[batch.length - 1].fundingTime + 1;
    if (next <= cursor || batch.length < 1000 || next >= Date.now()) break;
    cursor = next;
  }

  const unique = [...new Map(out.map((value) => [value.fundingTime, value])).values()]
    .sort((a, b) => a.fundingTime - b.fundingTime);
  fs.mkdirSync(path.dirname(fundingCachePath(symbol)), { recursive: true });
  fs.writeFileSync(fundingCachePath(symbol), JSON.stringify(unique));
  return unique;
}

function atrSeries(candles: Candle[], period: number): number[] {
  const out = Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = candles.map((candle, index) => index === 0
    ? candle.high - candle.low
    : Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - candles[index - 1].close),
      Math.abs(candle.low - candles[index - 1].close),
    ));
  let value = tr.slice(1, period + 1).reduce((sum, x) => sum + x, 0) / period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

function priorZ(values: Funding[], index: number): number {
  const prior = values.slice(index - FUNDING_LOOKBACK, index).map((value) => value.fundingRate);
  const mean = prior.reduce((sum, value) => sum + value, 0) / prior.length;
  const variance = prior.reduce((sum, value) => sum + (value - mean) ** 2, 0) / prior.length;
  const sd = Math.sqrt(variance);
  return sd > 0 ? (values[index].fundingRate - mean) / sd : 0;
}

function firstCandleAfter(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].openTime <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fundingCashflowR(
  rates: Funding[],
  dir: Direction,
  entryTime: number,
  exitTime: number,
  riskFraction: number,
): number {
  const paid = rates
    .filter((rate) => rate.fundingTime > entryTime && rate.fundingTime <= exitTime)
    .reduce((sum, rate) => sum + rate.fundingRate, 0);
  return (dir === "short" ? paid : -paid) / riskFraction;
}

function runSymbol(
  symbol: string,
  candles: Candle[],
  funding: Funding[],
  params: Params,
  evaluationStart: number,
): Trade[] {
  const atr = atrSeries(candles, ATR_PERIOD);
  const trades: Trade[] = [];
  let busyUntil = -Infinity;

  for (let i = FUNDING_LOOKBACK; i < funding.length; i++) {
    const signal = funding[i];
    if (signal.fundingTime < evaluationStart || signal.fundingTime <= busyUntil) continue;
    const signalZ = priorZ(funding, i);
    if (Math.abs(signalZ) < params.z) continue;
    const dir: Direction = signalZ > 0 ? "short" : "long";
    const entryIndex = firstCandleAfter(candles, signal.fundingTime);
    if (entryIndex >= candles.length || !(atr[entryIndex - 1] > 0)) continue;

    const entry = candles[entryIndex].open;
    const risk = params.stopAtr * atr[entryIndex - 1];
    const riskFraction = risk / entry;
    if (!(risk > 0) || !(riskFraction > 0)) continue;
    const stop = dir === "long" ? entry - risk : entry + risk;
    const target = dir === "long"
      ? entry + params.targetR * risk
      : entry - params.targetR * risk;
    const lastIndex = Math.min(candles.length - 1, entryIndex + params.holdHours - 1);
    let exitIndex = lastIndex;
    let exitPrice = candles[lastIndex].close;
    let reason: Trade["reason"] = "time";

    for (let bar = entryIndex; bar <= lastIndex; bar++) {
      const candle = candles[bar];
      const stopped = dir === "long" ? candle.low <= stop : candle.high >= stop;
      const targeted = dir === "long" ? candle.high >= target : candle.low <= target;
      if (stopped) {
        exitIndex = bar;
        exitPrice = stop;
        reason = "sl";
        break;
      }
      if (targeted) {
        exitIndex = bar;
        exitPrice = target;
        reason = "target";
        break;
      }
    }

    const exitTime = candles[exitIndex].openTime + HOUR;
    const pricePnl = dir === "long" ? exitPrice - entry : entry - exitPrice;
    const grossR = pricePnl / risk;
    const roundTripFraction = 2 * (CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100;
    const feeR = roundTripFraction / riskFraction;
    const fundingR = fundingCashflowR(funding, dir, candles[entryIndex].openTime, exitTime, riskFraction);
    trades.push({
      symbol,
      dir,
      signalTime: signal.fundingTime,
      entryTime: candles[entryIndex].openTime,
      exitTime,
      signalRate: signal.fundingRate,
      signalZ,
      grossR,
      feeR,
      fundingR,
      netR: grossR - feeR + fundingR,
      reason,
    });
    busyUntil = exitTime;
  }
  return trades;
}

function metrics(trades: Trade[]) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const netR = sorted.reduce((sum, trade) => sum + trade.netR, 0);
  const grossR = sorted.reduce((sum, trade) => sum + trade.grossR, 0);
  const feeR = sorted.reduce((sum, trade) => sum + trade.feeR, 0);
  const fundingR = sorted.reduce((sum, trade) => sum + trade.fundingR, 0);
  let equity = 100;
  let peak = equity;
  let maxDd = 0;
  for (const trade of sorted) {
    equity *= Math.max(0, 1 + trade.netR * 0.01);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return {
    n: sorted.length,
    wr: sorted.length ? sorted.filter((trade) => trade.netR > 0).length / sorted.length : 0,
    grossR,
    feeR,
    fundingR,
    netR,
    exp: sorted.length ? netR / sorted.length : 0,
    maxDd,
    equity,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printRow(name: string, trades: Trade[]): void {
  const m = metrics(trades);
  console.log(
    `${name.padEnd(13)} ${String(m.n).padStart(5)} ${(100 * m.wr).toFixed(1).padStart(6)}%`
    + ` ${signed(m.grossR).padStart(9)} ${signed(-m.feeR).padStart(9)}`
    + ` ${signed(m.fundingR).padStart(9)} ${signed(m.netR).padStart(9)}`
    + ` ${m.exp.toFixed(3).padStart(8)} ${(100 * m.maxDd).toFixed(1).padStart(6)}%`,
  );
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 1200);
  const params: Params = {
    z: Number(process.argv[3] ?? 2),
    stopAtr: Number(process.argv[4] ?? 2),
    targetR: Number(process.argv[5] ?? 2),
    holdHours: Number(process.argv[6] ?? 24),
  };
  if (![days, params.z, params.stopAtr, params.targetR, params.holdHours].every((x) => x > 0)) {
    throw new Error("days, z, stopAtr, targetR và holdHours phải > 0");
  }

  const warmupDays = 60;
  const fetchStart = Date.now() - (days + warmupDays) * DAY;
  const evaluationStart = Date.now() - days * DAY;
  const totalBars = Math.ceil((days + warmupDays) * 24) + 10;
  const all: Trade[] = [];

  console.log(
    `Funding-tail reversal | ${days}d | z=${params.z} | SL=${params.stopAtr} ATR24h`
    + ` | TP=${params.targetR}R | hold<=${params.holdHours}h`,
  );
  for (const symbol of SYMBOLS) {
    const [candles, funding] = await Promise.all([
      fetchKlinesPaged(symbol, "1h", totalBars),
      fetchFunding(symbol, fetchStart),
    ]);
    const trades = runSymbol(symbol, candles, funding, params, evaluationStart);
    all.push(...trades);
    printRow(symbol.toUpperCase(), trades);
  }

  console.log("\n" + "-".repeat(91));
  console.log("cohort        trades     WR     gross      fees   funding     NET R    R/trade  maxDD");
  printRow("ALL", all);
  printRow("LONG", all.filter((trade) => trade.dir === "long"));
  printRow("SHORT", all.filter((trade) => trade.dir === "short"));

  const end = Date.now();
  const span = end - evaluationStart;
  console.log("\n3 era liên tục (không reset state; phân theo entry time):");
  for (let era = 0; era < 3; era++) {
    const lo = evaluationStart + era * span / 3;
    const hi = evaluationStart + (era + 1) * span / 3;
    printRow(`ERA ${era + 1}`, all.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi));
  }
}

main().catch((error) => {
  console.error("Lỗi:", error?.response?.data ?? error.message);
  process.exit(1);
});
