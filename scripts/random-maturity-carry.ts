/**
 * Theory-motivated random-maturity spot/perpetual carry (research only).
 *
 * Protocol: planning/random-maturity-carry-protocol-2026-08.md
 * Source: He, Manela, Ross, von Wachter, "Fundamentals of Perpetual Futures".
 *
 * Examples:
 *   ./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --self-test
 *   ./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=dev
 *   ./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=validation
 *   ./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=holdout --unseal-holdout=CONFIRM
 */

import axios from "axios";
import fs from "fs";
import path from "path";

const SYMBOLS = ["btcusdt", "ethusdt", "bnbusdt", "dogeusdt", "adausdt"];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const YEAR_HOURS = 365 * 24;
const KAPPA = 3 * 365;
const SIGNAL_FINANCING_APR = 0.10;
const SPOT_FEE = 0.0010;
const PERP_FEE = 0.0005;
const SLIPPAGE = 0.0002;
const CACHE_DIR = path.join(process.cwd(), ".cache", "random-maturity-carry");

type PhaseName = "dev" | "validation" | "holdout";
type CacheKind = "spot" | "perp" | "mark" | "funding";
type Bar = { openTime: number; open: number; close: number };
type Funding = { fundingTime: number; fundingRate: number; markPrice: number };
type AlignedBar = { openTime: number; spotOpen: number; spotClose: number; perpOpen: number; perpClose: number };
type Phase = { name: PhaseName; start: number; end: number };
type ExecutionCosts = { spotFee: number; perpFee: number; slippage: number };
type Position = {
  entryIndex: number;
  entryTime: number;
  spotMid: number;
  perpMid: number;
  qty: number;
  entryDeviation: number;
};
type Trade = {
  symbol: string;
  entryTime: number;
  exitTime: number;
  durationHours: number;
  entryDeviation: number;
  pricePct: number;
  fundingPct: number;
  fundingCount: number;
  feePct: number;
  slippagePct: number;
  financingPct: number;
  netPct: number;
  reason: "signal" | "window-end";
};
type Simulation = { symbol: string; trades: Trade[]; hourlyPnl: Map<number, number> };
type Coverage = { start: number; end: number };

const PHASES: Record<PhaseName, Phase> = {
  dev: {
    name: "dev",
    start: Date.UTC(2019, 8, 1),
    end: Date.UTC(2023, 11, 31, 23),
  },
  validation: {
    name: "validation",
    start: Date.UTC(2024, 0, 8),
    end: Date.UTC(2025, 11, 31, 23),
  },
  holdout: {
    name: "holdout",
    start: Date.UTC(2026, 0, 8),
    end: Date.UTC(2026, 6, 31, 23),
  },
};

function args(): { phase: PhaseName | null; selfTest: boolean; unseal: string | null } {
  const values = process.argv.slice(2);
  const phaseValue = values.find((value) => value.startsWith("--phase="))?.split("=")[1] ?? null;
  if (phaseValue != null && !(phaseValue in PHASES)) {
    throw new Error(`Unknown phase: ${phaseValue}`);
  }
  return {
    phase: phaseValue as PhaseName | null,
    selfTest: values.includes("--self-test"),
    unseal: values.find((value) => value.startsWith("--unseal-holdout="))?.split("=")[1] ?? null,
  };
}

function fairRatio(apr = SIGNAL_FINANCING_APR): number {
  if (apr >= KAPPA) throw new Error("financing APR must be below kappa");
  return KAPPA / (KAPPA - apr);
}

function signalDeviation(spot: number, perp: number): number {
  return perp / spot - fairRatio();
}

function signalRoundTripCost(spot: number, perp: number): number {
  return 2 * (SPOT_FEE + SLIPPAGE) + 2 * (PERP_FEE + SLIPPAGE) * (perp / spot);
}

function cachePath(kind: CacheKind, symbol: string): string {
  return path.join(CACHE_DIR, kind, `${symbol}.json`);
}

function coveragePath(kind: CacheKind, symbol: string): string {
  return path.join(CACHE_DIR, kind, `${symbol}.coverage.json`);
}

function readCache<T>(kind: CacheKind, symbol: string): T[] {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath(kind, symbol), "utf8"));
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function writeCache(kind: CacheKind, symbol: string, values: unknown[]): void {
  const target = cachePath(kind, symbol);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(values));
}

function readCoverage(kind: CacheKind, symbol: string): Coverage[] {
  try {
    const value = JSON.parse(fs.readFileSync(coveragePath(kind, symbol), "utf8"));
    return Array.isArray(value) ? value as Coverage[] : [];
  } catch {
    return [];
  }
}

function addCoverage(
  kind: CacheKind,
  symbol: string,
  coverage: Coverage,
): void {
  const values = [...readCoverage(kind, symbol), coverage].sort((a, b) => a.start - b.start);
  const merged: Coverage[] = [];
  for (const value of values) {
    const previous = merged[merged.length - 1];
    if (previous && value.start <= previous.end + 1) previous.end = Math.max(previous.end, value.end);
    else merged.push({ ...value });
  }
  const target = coveragePath(kind, symbol);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged));
}

function covers(kind: CacheKind, symbol: string, start: number, end: number): boolean {
  return readCoverage(kind, symbol).some((value) => value.start <= start && value.end >= end);
}

function mergeByTime<T>(values: T[], more: T[], timeOf: (value: T) => number): T[] {
  const map = new Map<number, T>();
  for (const value of [...values, ...more]) map.set(timeOf(value), value);
  return [...map.values()].sort((a, b) => timeOf(a) - timeOf(b));
}

async function getWithRetry(url: string, params: Record<string, string | number>): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await axios.get(url, { params, timeout: 30_000 })).data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchBars(
  kind: "spot" | "perp" | "mark",
  symbol: string,
  start: number,
  end: number,
): Promise<Bar[]> {
  const cached = readCache<Bar>(kind, symbol);
  if (covers(kind, symbol, start, end)) {
    return cached.filter((bar) => bar.openTime >= start && bar.openTime <= end);
  }

  const urls = kind === "spot"
    ? [
      "https://api.binance.com/api/v3/klines",
      "https://data-api.binance.vision/api/v3/klines",
    ]
    : [kind === "perp"
      ? "https://fapi.binance.com/fapi/v1/klines"
      : "https://fapi.binance.com/fapi/v1/markPriceKlines"];
  const limit = kind === "spot" ? 1000 : 1500;
  const fetched: Bar[] = [];
  let cursor = start;
  while (cursor <= end) {
    let data: any[][] | null = null;
    let lastError: unknown;
    for (const url of urls) {
      try {
        data = await getWithRetry(url, {
          symbol: symbol.toUpperCase(),
          interval: "1h",
          startTime: cursor,
          endTime: end,
          limit,
        }) as any[][];
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!data) throw lastError;
    if (!data.length) break;
    const batch = data.map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      close: Number(row[4]),
    })).filter((bar) => Number.isFinite(bar.open) && Number.isFinite(bar.close));
    if (!batch.length) break;
    fetched.push(...batch);
    const next = batch[batch.length - 1].openTime + HOUR;
    if (next <= cursor) throw new Error(`${kind} pagination stalled for ${symbol}`);
    cursor = next;
    if (data.length < limit) break;
  }
  const merged = mergeByTime(cached, fetched, (bar) => bar.openTime);
  writeCache(kind, symbol, merged);
  addCoverage(kind, symbol, { start, end });
  return merged.filter((bar) => bar.openTime >= start && bar.openTime <= end);
}

async function fetchFunding(symbol: string, start: number, end: number): Promise<Funding[]> {
  const cached = readCache<Funding>("funding", symbol);
  if (covers("funding", symbol, start, end)) {
    return cached.filter((rate) => rate.fundingTime >= start && rate.fundingTime <= end);
  }

  const fetched: Funding[] = [];
  let cursor = start;
  while (cursor <= end) {
    const data = await getWithRetry(
      "https://fapi.binance.com/fapi/v1/fundingRate",
      { symbol: symbol.toUpperCase(), startTime: cursor, endTime: end, limit: 1000 },
    ) as Array<Record<string, string | number>>;
    if (!data.length) break;
    const batch = data.map((row) => ({
      fundingTime: Number(row.fundingTime),
      fundingRate: Number(row.fundingRate),
      markPrice: Number(row.markPrice),
    })).filter((rate) => Number.isFinite(rate.fundingRate) && Number.isFinite(rate.markPrice));
    if (!batch.length) break;
    fetched.push(...batch);
    const next = batch[batch.length - 1].fundingTime + 1;
    if (next <= cursor) throw new Error(`funding pagination stalled for ${symbol}`);
    cursor = next;
    if (data.length < 1000) break;
  }
  const merged = mergeByTime(cached, fetched, (rate) => rate.fundingTime);
  writeCache("funding", symbol, merged);
  addCoverage("funding", symbol, { start, end });
  return merged.filter((rate) => rate.fundingTime >= start && rate.fundingTime <= end);
}

function alignBars(spot: Bar[], perp: Bar[]): AlignedBar[] {
  const perpByTime = new Map(perp.map((bar) => [bar.openTime, bar]));
  const aligned = spot.flatMap((spotBar) => {
    const perpBar = perpByTime.get(spotBar.openTime);
    return perpBar ? [{
      openTime: spotBar.openTime,
      spotOpen: spotBar.open,
      spotClose: spotBar.close,
      perpOpen: perpBar.open,
      perpClose: perpBar.close,
    }] : [];
  });
  for (let i = 1; i < aligned.length; i++) {
    if (aligned[i].openTime <= aligned[i - 1].openTime) throw new Error("bars are not strictly sorted");
  }
  return aligned;
}

function hydrateFundingMarks(funding: Funding[], mark: Bar[], perp: Bar[]): Funding[] {
  const markByTime = new Map(mark.map((bar) => [bar.openTime, bar.open]));
  const perpByTime = new Map(perp.map((bar) => [bar.openTime, bar.open]));
  return funding.map((rate) => {
    if (rate.markPrice > 0) return rate;
    const hour = Math.floor(rate.fundingTime / HOUR) * HOUR;
    const fallback = markByTime.get(hour) ?? perpByTime.get(hour);
    if (!(fallback && fallback > 0)) {
      throw new Error(`missing mark price at funding time ${rate.fundingTime}`);
    }
    return { ...rate, markPrice: fallback };
  });
}

function addPnl(series: Map<number, number>, time: number, value: number): void {
  series.set(time, (series.get(time) ?? 0) + value);
}

function settleTrade(
  symbol: string,
  bars: AlignedBar[],
  funding: Funding[],
  position: Position,
  exitIndex: number,
  reason: Trade["reason"],
  costs: ExecutionCosts,
  financingApr: number,
  hourlyPnl: Map<number, number>,
): Trade {
  const exit = bars[exitIndex];
  const entry = bars[position.entryIndex];
  const { qty } = position;
  const spotEntryExec = position.spotMid * (1 + costs.slippage);
  const perpEntryExec = position.perpMid * (1 - costs.slippage);
  const spotExitExec = exit.spotOpen * (1 - costs.slippage);
  const perpExitExec = exit.perpOpen * (1 + costs.slippage);

  const pricePct = qty * (
    (exit.spotOpen - position.spotMid) + (position.perpMid - exit.perpOpen)
  );
  const slippagePct = -qty * costs.slippage * (
    position.spotMid + position.perpMid + exit.spotOpen + exit.perpOpen
  );
  const feePct = -qty * (
    costs.spotFee * (spotEntryExec + spotExitExec)
    + costs.perpFee * (perpEntryExec + perpExitExec)
  );
  const durationHours = (exit.openTime - position.entryTime) / HOUR;
  const financingPct = -qty * spotEntryExec * financingApr * durationHours / YEAR_HOURS;
  const applicableFunding = funding.filter((rate) => {
    const settlementHour = Math.floor(rate.fundingTime / HOUR) * HOUR;
    return settlementHour > position.entryTime && settlementHour < exit.openTime;
  });
  const fundingPct = qty * applicableFunding.reduce(
    (sum, rate) => sum + rate.markPrice * rate.fundingRate,
    0,
  );
  const netPct = pricePct + fundingPct + feePct + slippagePct + financingPct;

  addPnl(hourlyPnl, position.entryTime, -qty * (
    costs.slippage * (position.spotMid + position.perpMid)
    + costs.spotFee * spotEntryExec
    + costs.perpFee * perpEntryExec
  ));
  for (let i = position.entryIndex + 1; i <= exitIndex; i++) {
    const previous = bars[i - 1];
    const current = bars[i];
    const elapsedHours = (current.openTime - previous.openTime) / HOUR;
    addPnl(hourlyPnl, current.openTime, qty * (
      (current.spotOpen - previous.spotOpen) + (previous.perpOpen - current.perpOpen)
    ));
    addPnl(
      hourlyPnl,
      current.openTime,
      -qty * spotEntryExec * financingApr * elapsedHours / YEAR_HOURS,
    );
  }
  for (const rate of applicableFunding) {
    const hour = Math.floor(rate.fundingTime / HOUR) * HOUR;
    addPnl(hourlyPnl, hour, qty * rate.markPrice * rate.fundingRate);
  }
  addPnl(hourlyPnl, exit.openTime, -qty * (
    costs.slippage * (exit.spotOpen + exit.perpOpen)
    + costs.spotFee * spotExitExec
    + costs.perpFee * perpExitExec
  ));

  return {
    symbol,
    entryTime: entry.openTime,
    exitTime: exit.openTime,
    durationHours,
    entryDeviation: position.entryDeviation,
    pricePct,
    fundingPct,
    fundingCount: applicableFunding.length,
    feePct,
    slippagePct,
    financingPct,
    netPct,
    reason,
  };
}

function simulate(
  symbol: string,
  bars: AlignedBar[],
  funding: Funding[],
  costMultiplier: number,
  financingApr: number,
): Simulation {
  const costs: ExecutionCosts = {
    spotFee: SPOT_FEE * costMultiplier,
    perpFee: PERP_FEE * costMultiplier,
    slippage: SLIPPAGE * costMultiplier,
  };
  const trades: Trade[] = [];
  const hourlyPnl = new Map<number, number>();
  let position: Position | null = null;
  let enterNext = false;
  let exitNext = false;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (exitNext && position) {
      trades.push(settleTrade(
        symbol, bars, funding, position, i, "signal", costs, financingApr, hourlyPnl,
      ));
      position = null;
    }
    exitNext = false;

    if (enterNext && !position) {
      position = {
        entryIndex: i,
        entryTime: bar.openTime,
        spotMid: bar.spotOpen,
        perpMid: bar.perpOpen,
        qty: 1 / bar.spotOpen,
        entryDeviation: signalDeviation(bars[i - 1].spotClose, bars[i - 1].perpClose),
      };
    }
    enterNext = false;

    if (i >= bars.length - 2) continue;
    const deviation = signalDeviation(bar.spotClose, bar.perpClose);
    if (position) {
      if (deviation <= 0) exitNext = true;
    } else if (deviation > signalRoundTripCost(bar.spotClose, bar.perpClose)) {
      enterNext = true;
    }
  }

  if (position) {
    trades.push(settleTrade(
      symbol,
      bars,
      funding,
      position,
      bars.length - 1,
      "window-end",
      costs,
      financingApr,
      hourlyPnl,
    ));
  }
  const tradeTotal = trades.reduce((sum, trade) => sum + trade.netPct, 0);
  const hourlyTotal = [...hourlyPnl.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(tradeTotal - hourlyTotal) > 1e-8) {
    throw new Error(
      `${symbol} accounting mismatch: trades=${tradeTotal}, hourly=${hourlyTotal}`,
    );
  }
  return { symbol, trades, hourlyPnl };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function portfolioReturns(simulations: Simulation[], phase: Phase): number[] {
  const returns: number[] = [];
  for (let time = phase.start; time <= phase.end; time += HOUR) {
    returns.push(simulations.reduce(
      (sum, simulation) => sum + (simulation.hourlyPnl.get(time) ?? 0) / SYMBOLS.length,
      0,
    ));
  }
  return returns;
}

function equityStats(returns: number[]): { total: number; sharpe: number; maxDd: number } {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  const volatility = std(returns);
  return {
    total: equity - 1,
    sharpe: volatility > 0 ? mean(returns) / volatility * Math.sqrt(YEAR_HOURS) : 0,
    maxDd,
  };
}

function dailyReturns(hourly: number[]): number[] {
  const days: number[] = [];
  for (let offset = 0; offset < hourly.length; offset += 24) {
    let value = 1;
    for (const hourlyReturn of hourly.slice(offset, offset + 24)) value *= 1 + hourlyReturn;
    days.push(value - 1);
  }
  return days;
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

function blockBootstrap(values: number[], samples = 2000, block = 28): {
  low: number; high: number; pPositive: number;
} {
  if (!values.length) return { low: 0, high: 0, pPositive: 0 };
  const random = mulberry32(20260801);
  const totals: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const drawn: number[] = [];
    while (drawn.length < values.length) {
      const start = Math.floor(random() * values.length);
      for (let i = 0; i < block && drawn.length < values.length; i++) {
        drawn.push(values[(start + i) % values.length]);
      }
    }
    totals.push(drawn.reduce((equity, value) => equity * (1 + value), 1) - 1);
  }
  totals.sort((a, b) => a - b);
  return {
    low: totals[Math.floor(0.05 * totals.length)],
    high: totals[Math.floor(0.95 * totals.length)],
    pPositive: totals.filter((value) => value > 0).length / totals.length,
  };
}

function pct(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${(100 * value).toFixed(digits)}%`;
}

function report(label: string, simulations: Simulation[], phase: Phase): void {
  const trades = simulations.flatMap((simulation) => simulation.trades);
  const returns = portfolioReturns(simulations, phase);
  const stats = equityStats(returns);
  const bootstrap = blockBootstrap(dailyReturns(returns));
  const pairR = trades.reduce((sum, trade) => sum + trade.netPct / 0.01, 0);
  const portfolioR = pairR / SYMBOLS.length;
  const wins = trades.filter((trade) => trade.netPct > 0).length;
  const positiveContributions = simulations
    .map((simulation) => simulation.trades.reduce((sum, trade) => sum + trade.netPct, 0))
    .filter((value) => value > 0);
  const concentration = positiveContributions.length
    ? Math.max(...positiveContributions) / positiveContributions.reduce((sum, value) => sum + value, 0)
    : 0;

  console.log(`\n${label}`);
  console.log("symbol     n     win   price   funding     fees     slip  financing      net      pair-R");
  for (const simulation of simulations) {
    const values = simulation.trades;
    const sum = (key: keyof Pick<Trade, "pricePct" | "fundingPct" | "feePct" | "slippagePct" | "financingPct" | "netPct">) => (
      values.reduce((total, trade) => total + trade[key], 0)
    );
    const symbolR = sum("netPct") / 0.01;
    console.log(
      `${simulation.symbol.toUpperCase().padEnd(8)} ${String(values.length).padStart(4)}`
      + ` ${(100 * (values.length ? values.filter((trade) => trade.netPct > 0).length / values.length : 0)).toFixed(1).padStart(6)}%`
      + ` ${pct(sum("pricePct")).padStart(8)} ${pct(sum("fundingPct")).padStart(9)}`
      + ` ${pct(sum("feePct")).padStart(8)} ${pct(sum("slippagePct")).padStart(8)}`
      + ` ${pct(sum("financingPct")).padStart(10)} ${pct(sum("netPct")).padStart(9)}`
      + ` ${symbolR.toFixed(2).padStart(11)}`,
    );
  }
  console.log(
    `portfolio  trades=${trades.length} win=${trades.length ? (100 * wins / trades.length).toFixed(1) : "0.0"}%`
    + ` net=${pct(stats.total)} Sharpe=${stats.sharpe.toFixed(2)} maxDD=${pct(-stats.maxDd)}`,
  );
  console.log(
    `normalized R: pair-sum=${pairR.toFixed(2)}R, portfolio-equivalent=${portfolioR.toFixed(2)}R`
    + " (1R=1% notional; not stop-defined)",
  );
  console.log(
    `28d block bootstrap CI90=[${pct(bootstrap.low)}, ${pct(bootstrap.high)}]`
    + ` P(total>0)=${(100 * bootstrap.pPositive).toFixed(1)}%`
    + ` positive-PnL concentration=${(100 * concentration).toFixed(1)}%`,
  );
  const durations = trades.map((trade) => trade.durationHours).sort((a, b) => a - b);
  const medianDuration = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const maxDuration = durations.length ? durations[durations.length - 1] : 0;
  console.log(`holding hours: median=${medianDuration.toFixed(0)} max=${maxDuration.toFixed(0)}`);
  const fundingCounts = trades.map((trade) => trade.fundingCount);
  const maxFundingPct = trades.length ? Math.max(...trades.map((trade) => trade.fundingPct)) : 0;
  console.log(
    `funding settlements: total=${fundingCounts.reduce((sum, value) => sum + value, 0)}`
    + ` max/trade=${fundingCounts.length ? Math.max(...fundingCounts) : 0}`
    + ` max funding/trade=${pct(maxFundingPct, 3)}`,
  );
  if (trades.length) {
    const topFunding = [...trades].sort((a, b) => b.fundingPct - a.fundingPct)[0];
    console.log(
      `top funding trade: ${topFunding.symbol.toUpperCase()}`
      + ` ${new Date(topFunding.entryTime).toISOString()} -> ${new Date(topFunding.exitTime).toISOString()}`
      + ` settlements=${topFunding.fundingCount} funding=${pct(topFunding.fundingPct, 3)}`,
    );
  }

  console.log("year       n   portfolio-net   portfolio-R");
  for (let year = new Date(phase.start).getUTCFullYear(); year <= new Date(phase.end).getUTCFullYear(); year++) {
    const yearStart = Math.max(phase.start, Date.UTC(year, 0, 1));
    const yearEnd = Math.min(phase.end, Date.UTC(year + 1, 0, 1) - HOUR);
    const from = Math.floor((yearStart - phase.start) / HOUR);
    const to = Math.floor((yearEnd - phase.start) / HOUR) + 1;
    const yearStats = equityStats(returns.slice(from, to));
    const yearTrades = trades.filter((trade) => (
      trade.exitTime >= yearStart && trade.exitTime <= yearEnd
    ));
    const yearR = yearTrades.reduce((sum, trade) => sum + trade.netPct / 0.01, 0) / SYMBOLS.length;
    console.log(
      `${String(year).padEnd(6)} ${String(yearTrades.length).padStart(6)}`
      + ` ${pct(yearStats.total).padStart(15)} ${yearR.toFixed(2).padStart(13)}`,
    );
  }
}

function assertClose(actual: number, expected: number, label: string, tolerance = 1e-10): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function selfTest(): void {
  assertClose(fairRatio(0), 1, "zero-rate fair ratio");
  assertClose(fairRatio(0.10), KAPPA / (KAPPA - 0.10), "paper fair ratio");
  assertClose(signalRoundTripCost(100, 100), 0.0038, "four-leg signal cost");
  const hydrated = hydrateFundingMarks(
    [{ fundingTime: 1, fundingRate: 0.001, markPrice: 0 }],
    [{ openTime: 0, open: 123, close: 123 }],
    [{ openTime: 0, open: 122, close: 122 }],
  );
  assertClose(hydrated[0].markPrice, 123, "zero funding mark fallback");

  const bars: AlignedBar[] = [
    { openTime: 0, spotOpen: 100, spotClose: 100, perpOpen: 100, perpClose: 101 },
    { openTime: HOUR, spotOpen: 100, spotClose: 100, perpOpen: 101, perpClose: 101 },
    { openTime: 2 * HOUR, spotOpen: 105, spotClose: 110, perpOpen: 106, perpClose: 110 },
    { openTime: 3 * HOUR, spotOpen: 110, spotClose: 110, perpOpen: 110, perpClose: 110 },
  ];
  const funding: Funding[] = [
    { fundingTime: HOUR + 1, fundingRate: 0.01, markPrice: 101 },
    { fundingTime: 2 * HOUR + 1, fundingRate: 0.001, markPrice: 110 },
    { fundingTime: 3 * HOUR + 1, fundingRate: 0.01, markPrice: 110 },
  ];
  const result = simulate("test", bars, funding, 0, 0);
  if (result.trades.length !== 1) throw new Error("next-open test: expected one trade");
  const trade = result.trades[0];
  if (trade.entryTime !== HOUR) throw new Error("lookahead test: entry was not at next open");
  if (trade.exitTime !== 3 * HOUR) throw new Error("exit test: exit was not at next open");
  assertClose(trade.pricePct, 0.01, "delta hedge plus basis convergence");
  assertClose(trade.fundingPct, 0.0011, "strict timestamp and short-funding sign");
  assertClose(trade.netPct, 0.0111, "net accounting without costs");
  if (trade.fundingCount !== 1) throw new Error("funding boundary test: expected one settlement");

  const noFunding = settleTrade(
    "test",
    bars,
    [],
    { entryIndex: 1, entryTime: HOUR, spotMid: 100, perpMid: 101, qty: 0.01, entryDeviation: 0.01 },
    3,
    "signal",
    { spotFee: SPOT_FEE, perpFee: PERP_FEE, slippage: SLIPPAGE },
    0,
    new Map(),
  );
  const expectedSlip = -0.01 * SLIPPAGE * (100 + 101 + 110 + 110);
  const expectedFee = -0.01 * (
    SPOT_FEE * (100 * (1 + SLIPPAGE) + 110 * (1 - SLIPPAGE))
    + PERP_FEE * (101 * (1 - SLIPPAGE) + 110 * (1 + SLIPPAGE))
  );
  assertClose(noFunding.slippagePct, expectedSlip, "four adverse slippage legs");
  assertClose(noFunding.feePct, expectedFee, "four fee legs");
  console.log(
    "self-test: PASS (next-open, hedge, funding sign/timestamps, mark fallback, fees, slippage)",
  );
}

async function main(): Promise<void> {
  const options = args();
  if (options.selfTest) {
    selfTest();
    return;
  }
  if (!options.phase) throw new Error("Use --phase=dev|validation|holdout");
  if (options.phase === "holdout" && options.unseal !== "CONFIRM") {
    throw new Error("Holdout is sealed. Use --unseal-holdout=CONFIRM exactly once after validation.");
  }
  const phase = PHASES[options.phase];
  console.log(
    `phase=${phase.name} ${new Date(phase.start).toISOString()} -> ${new Date(phase.end).toISOString()}`,
  );
  console.log(
    `locked signal: kappa=${KAPPA}, financing=${(100 * SIGNAL_FINANCING_APR).toFixed(0)}%,`
    + ` spot=${(1e4 * SPOT_FEE).toFixed(0)}bps, perp=${(1e4 * PERP_FEE).toFixed(0)}bps,`
    + ` slippage=${(1e4 * SLIPPAGE).toFixed(0)}bps/leg`,
  );

  const data = await Promise.all(SYMBOLS.map(async (symbol) => {
    const [spot, perp, mark] = await Promise.all([
      fetchBars("spot", symbol, phase.start, phase.end),
      fetchBars("perp", symbol, phase.start, phase.end),
      fetchBars("mark", symbol, phase.start, phase.end),
    ]);
    const bars = alignBars(spot, perp);
    if (bars.length < 3) throw new Error(`insufficient aligned data for ${symbol}`);
    const rawFunding = await fetchFunding(
      symbol,
      bars[0].openTime,
      bars[bars.length - 1].openTime,
    );
    const funding = hydrateFundingMarks(rawFunding, mark, perp);
    console.log(
      `${symbol.toUpperCase()}: spot=${spot.length} perp=${perp.length}`
      + ` mark=${mark.length} aligned=${bars.length} funding=${funding.length}`,
    );
    return { symbol, bars, funding };
  }));

  const scenarios = [
    { label: "baseline: costs 1.0x, financing 10%", costs: 1, apr: 0.10 },
    { label: "stress: costs 1.5x, financing 10%", costs: 1.5, apr: 0.10 },
    { label: "stress: costs 2.0x, financing 10%", costs: 2, apr: 0.10 },
    { label: "financing sensitivity: costs 1.0x, financing 0%", costs: 1, apr: 0 },
    { label: "financing sensitivity: costs 1.0x, financing 5%", costs: 1, apr: 0.05 },
    { label: "financing sensitivity: costs 1.0x, financing 20%", costs: 1, apr: 0.20 },
  ];
  for (const scenario of scenarios) {
    const simulations = data.map(({ symbol, bars, funding }) => (
      simulate(symbol, bars, funding, scenario.costs, scenario.apr)
    ));
    report(scenario.label, simulations, phase);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
