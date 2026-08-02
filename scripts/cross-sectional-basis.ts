/**
 * Cross-sectional perpetual basis factor (research-only).
 *
 * Every UTC day, rank yesterday's Binance premium index. Long the lowest
 * third (perpetual discount), short the highest third (perpetual premium),
 * enter one hour after the daily signal is known, and hold at most 24 hours.
 * Actual funding cashflows, taker fees, and slippage are included in net R.
 *
 * Run: ./node_modules/.bin/ts-node scripts/cross-sectional-basis.ts [days=1200]
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { CONFIG, Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";

const SYMBOLS = [
  "btcusdt", "ethusdt", "solusdt", "xrpusdt",
  "dogeusdt", "adausdt", "avaxusdt", "dotusdt",
  "bnbusdt", "linkusdt", "ltcusdt", "trxusdt",
  "bchusdt", "etcusdt", "xlmusdt", "uniusdt",
];
const PICKS_PER_SIDE = Math.floor(SYMBOLS.length / 3);
const HOUR = TF_MS["1h"];
const DAY = TF_MS["1d"];
const ATR_PERIOD = 24;
const STOP_ATR = 2;
const HOLD_HOURS = 24;
const ENTRY_DELAY_HOURS = 1;
const FUNDING_URL = "https://fapi.binance.com/fapi/v1/fundingRate";
const PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndexKlines";

type Direction = "long" | "short";
type Funding = { fundingTime: number; fundingRate: number };
type Premium = { openTime: number; close: number };
type Trade = {
  symbol: string;
  dir: Direction;
  entryTime: number;
  exitTime: number;
  signalPremium: number;
  grossR: number;
  feeR: number;
  fundingR: number;
  netR: number;
  reason: "sl" | "time";
};

function cachePath(kind: "funding" | "premium", symbol: string): string {
  return path.join(process.cwd(), ".cache", kind, `${symbol}.json`);
}

function readCache<T extends { fundingTime?: number; openTime?: number }>(
  kind: "funding" | "premium",
  symbol: string,
  start: number,
): T[] | null {
  try {
    const values = JSON.parse(fs.readFileSync(cachePath(kind, symbol), "utf8")) as T[];
    if (!Array.isArray(values) || !values.length) return null;
    const firstTime = values[0]?.fundingTime ?? values[0]?.openTime;
    if (firstTime == null || firstTime > start) return null;
    return values.filter((value) => (value.fundingTime ?? value.openTime ?? 0) >= start);
  } catch {
    return null;
  }
}

function writeCache(kind: "funding" | "premium", symbol: string, values: unknown[]): void {
  fs.mkdirSync(path.dirname(cachePath(kind, symbol)), { recursive: true });
  fs.writeFileSync(cachePath(kind, symbol), JSON.stringify(values));
}

async function fetchFunding(symbol: string, start: number): Promise<Funding[]> {
  const cached = readCache<Funding>("funding", symbol, start);
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
    }));
    if (!batch.length) break;
    out.push(...batch);
    const next = batch[batch.length - 1].fundingTime + 1;
    if (next <= cursor || next >= Date.now()) break;
    cursor = next;
  }
  const unique = [...new Map(out.map((value) => [value.fundingTime, value])).values()]
    .sort((a, b) => a.fundingTime - b.fundingTime);
  writeCache("funding", symbol, unique);
  return unique;
}

async function fetchPremium(symbol: string, start: number): Promise<Premium[]> {
  const cached = readCache<Premium>("premium", symbol, start);
  if (cached) return cached;
  const out: Premium[] = [];
  let cursor = start;
  for (let page = 0; page < 10; page++) {
    const response = await axios.get(PREMIUM_URL, {
      params: { symbol: symbol.toUpperCase(), interval: "1d", startTime: cursor, limit: 1500 },
      timeout: 30_000,
    });
    const batch = (response.data as any[][]).map((row) => ({
      openTime: Number(row[0]),
      close: Number(row[4]),
    }));
    if (!batch.length) break;
    out.push(...batch);
    const next = batch[batch.length - 1].openTime + DAY;
    if (next <= cursor || next >= Date.now()) break;
    cursor = next;
  }
  const unique = [...new Map(out.map((value) => [value.openTime, value])).values()]
    .sort((a, b) => a.openTime - b.openTime);
  writeCache("premium", symbol, unique);
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

function fundingR(
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

function simulate(
  symbol: string,
  candles: Candle[],
  atr: number[],
  funding: Funding[],
  entryIndex: number,
  dir: Direction,
  signalPremium: number,
): Trade | null {
  if (!(atr[entryIndex - 1] > 0) || entryIndex + HOLD_HOURS >= candles.length) return null;
  const entry = candles[entryIndex].open;
  const risk = STOP_ATR * atr[entryIndex - 1];
  const riskFraction = risk / entry;
  const stop = dir === "long" ? entry - risk : entry + risk;
  let exitIndex = entryIndex + HOLD_HOURS;
  let exitPrice = candles[exitIndex].open;
  let reason: Trade["reason"] = "time";
  for (let i = entryIndex; i < exitIndex; i++) {
    const stopped = dir === "long" ? candles[i].low <= stop : candles[i].high >= stop;
    if (stopped) {
      exitIndex = i;
      exitPrice = stop;
      reason = "sl";
      break;
    }
  }
  const exitTime = candles[exitIndex].openTime;
  const grossR = (dir === "long" ? exitPrice - entry : entry - exitPrice) / risk;
  const feeFraction = 2 * (CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100;
  const feeR = feeFraction / riskFraction;
  const realizedFundingR = fundingR(
    funding,
    dir,
    candles[entryIndex].openTime,
    exitTime,
    riskFraction,
  );
  return {
    symbol,
    dir,
    entryTime: candles[entryIndex].openTime,
    exitTime,
    signalPremium,
    grossR,
    feeR,
    fundingR: realizedFundingR,
    netR: grossR - feeR + realizedFundingR,
    reason,
  };
}

function metrics(trades: Trade[]) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const grossR = sorted.reduce((sum, trade) => sum + trade.grossR, 0);
  const feeR = sorted.reduce((sum, trade) => sum + trade.feeR, 0);
  const realizedFundingR = sorted.reduce((sum, trade) => sum + trade.fundingR, 0);
  const netR = grossR - feeR + realizedFundingR;
  const legRisk = 0.01 / (2 * PICKS_PER_SIDE);
  let equity = 100;
  let peak = equity;
  let maxDd = 0;
  for (const trade of sorted) {
    equity *= Math.max(0, 1 + trade.netR * legRisk);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return {
    n: sorted.length,
    wr: sorted.length ? sorted.filter((trade) => trade.netR > 0).length / sorted.length : 0,
    grossR,
    feeR,
    fundingR: realizedFundingR,
    netR,
    exp: sorted.length ? netR / sorted.length : 0,
    equity,
    maxDd,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printRow(name: string, trades: Trade[]): void {
  const m = metrics(trades);
  console.log(
    `${name.padEnd(13)} ${String(m.n).padStart(6)} ${(100 * m.wr).toFixed(1).padStart(6)}%`
    + ` ${signed(m.grossR).padStart(9)} ${signed(-m.feeR).padStart(9)}`
    + ` ${signed(m.fundingR).padStart(9)} ${signed(m.netR).padStart(9)}`
    + ` ${m.exp.toFixed(3).padStart(8)} ${(100 * m.maxDd).toFixed(1).padStart(6)}%`,
  );
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function blockBootstrap(trades: Trade[], start: number, end: number) {
  const blockMs = 28 * DAY;
  const count = Math.max(1, Math.ceil((end - start) / blockMs));
  const blocks = Array(count).fill(0);
  for (const trade of trades) {
    const index = Math.floor((trade.entryTime - start) / blockMs);
    if (index >= 0 && index < count) blocks[index] += trade.netR;
  }
  const rng = mulberry32(0x42415349);
  const totals: number[] = [];
  let positive = 0;
  for (let sample = 0; sample < 10_000; sample++) {
    let total = 0;
    for (let block = 0; block < count; block++) total += blocks[Math.floor(rng() * count)];
    totals.push(total);
    if (total > 0) positive++;
  }
  totals.sort((a, b) => a - b);
  return { low: quantile(totals, 0.05), high: quantile(totals, 0.95), p: positive / totals.length };
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 1200);
  if (!(days > 0)) throw new Error("days phải > 0");
  const warmupDays = 30;
  const start = Date.now() - (days + warmupDays) * DAY;
  const totalBars = Math.ceil((days + warmupDays) * 24) + HOLD_HOURS + ENTRY_DELAY_HOURS;
  const candlesBySymbol = new Map<string, Candle[]>();
  const atrBySymbol = new Map<string, number[]>();
  const fundingBySymbol = new Map<string, Funding[]>();
  const premiumBySymbol = new Map<string, Map<number, number>>();

  console.log(
    `Cross-sectional basis | ${days}d | ${SYMBOLS.length} symbols | top/bottom ${PICKS_PER_SIDE}`
    + ` | hold ${HOLD_HOURS}h | entry delay ${ENTRY_DELAY_HOURS}h | actual funding`,
  );
  for (const symbol of SYMBOLS) {
    const [candles, funding, premium] = await Promise.all([
      fetchKlinesPaged(symbol, "1h", totalBars),
      fetchFunding(symbol, start),
      fetchPremium(symbol, start),
    ]);
    candlesBySymbol.set(symbol, candles);
    atrBySymbol.set(symbol, atrSeries(candles, ATR_PERIOD));
    fundingBySymbol.set(symbol, funding);
    premiumBySymbol.set(symbol, new Map(premium.map((value) => [value.openTime, value.close])));
  }

  const starts = [...candlesBySymbol.values()].map((candles) => candles[0].openTime);
  const ends = [...candlesBySymbol.values()].map((candles) => candles[candles.length - 1].openTime);
  const evaluationStart = Math.max(...starts) + warmupDays * DAY;
  const evaluationEnd = Math.min(...ends) - (HOLD_HOURS + ENTRY_DELAY_HOURS) * HOUR;
  const indexBySymbol = new Map(
    [...candlesBySymbol].map(([symbol, candles]) => [
      symbol,
      new Map(candles.map((candle, index) => [candle.openTime, index])),
    ]),
  );
  const firstDay = Math.ceil(evaluationStart / DAY) * DAY;
  const trades: Trade[] = [];

  for (let time = firstDay; time <= evaluationEnd; time += DAY) {
    const signalDay = time - DAY;
    const ranked = SYMBOLS.map((symbol) => ({
      symbol,
      premium: premiumBySymbol.get(symbol)?.get(signalDay),
    })).filter((value): value is { symbol: string; premium: number } => value.premium != null);
    if (ranked.length !== SYMBOLS.length) continue;
    ranked.sort((a, b) => a.premium - b.premium);
    const picks = [
      ...ranked.slice(0, PICKS_PER_SIDE).map((value) => ({ ...value, dir: "long" as Direction })),
      ...ranked.slice(-PICKS_PER_SIDE).map((value) => ({ ...value, dir: "short" as Direction })),
    ];
    for (const pick of picks) {
      const signalIndex = indexBySymbol.get(pick.symbol)?.get(time);
      if (signalIndex == null) continue;
      const trade = simulate(
        pick.symbol,
        candlesBySymbol.get(pick.symbol)!,
        atrBySymbol.get(pick.symbol)!,
        fundingBySymbol.get(pick.symbol)!,
        signalIndex + ENTRY_DELAY_HOURS,
        pick.dir,
        pick.premium,
      );
      if (trade) trades.push(trade);
    }
  }

  console.log("\ncohort        trades     WR     gross      fees   funding     NET R    R/trade  maxDD");
  console.log("-".repeat(95));
  printRow("ALL", trades);
  printRow("LONG", trades.filter((trade) => trade.dir === "long"));
  printRow("SHORT", trades.filter((trade) => trade.dir === "short"));
  for (const symbol of SYMBOLS) {
    printRow(symbol.toUpperCase(), trades.filter((trade) => trade.symbol === symbol));
  }

  const span = evaluationEnd - firstDay;
  console.log("\n3 era liên tục:");
  for (let era = 0; era < 3; era++) {
    const lo = firstDay + era * span / 3;
    const hi = firstDay + (era + 1) * span / 3;
    printRow(`ERA ${era + 1}`, trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi));
  }
  console.log("\nTheo năm:");
  for (let year = new Date(firstDay).getUTCFullYear(); year <= new Date(evaluationEnd).getUTCFullYear(); year++) {
    const lo = Date.UTC(year, 0, 1);
    const hi = Date.UTC(year + 1, 0, 1);
    printRow(String(year), trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi));
  }
  const bootstrap = blockBootstrap(trades, firstDay, evaluationEnd);
  console.log(
    `\nBlock bootstrap 28d: 90% CI NET R = [${signed(bootstrap.low)}, ${signed(bootstrap.high)}]`
    + ` | P(NET>0)=${(100 * bootstrap.p).toFixed(1)}%`,
  );
}

main().catch((error) => {
  console.error("Lỗi:", error?.response?.data ?? error.message);
  process.exit(1);
});
