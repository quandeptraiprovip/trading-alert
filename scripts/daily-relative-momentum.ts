/**
 * Daily cross-sectional momentum on liquid crypto perpetuals (research-only).
 *
 * At 00:00 UTC on each rebalance date, rank trailing returns across liquid
 * majors. Long the top group, short the bottom group, and hold to the next rebalance.
 * A 2xATR emergency stop defines 1R; there is no price target because this is a
 * portfolio-sort signal.
 *
 * The forward-test candidate default is two-week formation / one-week holding:
 *   ./node_modules/.bin/ts-node scripts/daily-relative-momentum.ts
 *     [days=1200] [lookbackDays=21] [holdDays=7] [phaseDays=all|0..6]
 *     [universe=major8|broad16]
 */

import { CONFIG, Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";

const MAJOR8 = [
  "btcusdt", "ethusdt", "solusdt", "xrpusdt",
  "dogeusdt", "adausdt", "avaxusdt", "dotusdt",
];
const BROAD16 = [
  ...MAJOR8,
  "bnbusdt", "linkusdt", "ltcusdt", "trxusdt",
  "bchusdt", "etcusdt", "xlmusdt", "uniusdt",
];
const UNIVERSE = process.argv[6] ?? "major8";
const SYMBOLS = UNIVERSE === "broad16" ? BROAD16 : MAJOR8;
const HOUR = TF_MS["1h"];
const DAY = TF_MS["1d"];
const LOOKBACK_HOURS = 24 * Number(process.argv[3] ?? 14);
const HOLD_HOURS = 24 * Number(process.argv[4] ?? 7);
const ATR_PERIOD = 24;
const STOP_ATR = 2;
const PICKS_PER_SIDE = SYMBOLS.length === 8 ? 2 : Math.max(1, Math.floor(SYMBOLS.length / 5));
const ENTRY_DELAY_HOURS = 1;

type Direction = "long" | "short";
type Trade = {
  symbol: string;
  dir: Direction;
  entryTime: number;
  exitTime: number;
  score: number;
  grossR: number;
  costR: number;
  netR: number;
  reason: "sl" | "time";
};

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

function tradeCostR(entry: number, risk: number, hours: number): number {
  const riskFraction = risk / entry;
  const roundTrip = 2 * (CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100;
  const fundingPeriods = Math.floor(hours / 8);
  const funding = fundingPeriods * CONFIG.costs.fundingPer8hPct / 100;
  return (roundTrip + funding) / riskFraction;
}

function simulate(
  symbol: string,
  candles: Candle[],
  atr: number[],
  entryIndex: number,
  dir: Direction,
  score: number,
): Trade | null {
  if (!(atr[entryIndex - 1] > 0) || entryIndex + HOLD_HOURS >= candles.length) return null;
  const entry = candles[entryIndex].open;
  const risk = STOP_ATR * atr[entryIndex - 1];
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

  const grossR = (dir === "long" ? exitPrice - entry : entry - exitPrice) / risk;
  const heldHours = Math.max(1, (candles[exitIndex].openTime - candles[entryIndex].openTime) / HOUR);
  const costR = tradeCostR(entry, risk, heldHours);
  return {
    symbol,
    dir,
    entryTime: candles[entryIndex].openTime,
    exitTime: candles[exitIndex].openTime,
    score,
    grossR,
    costR,
    netR: grossR - costR,
    reason,
  };
}

function metrics(trades: Trade[], riskScale: number) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const rawGrossR = sorted.reduce((sum, trade) => sum + trade.grossR, 0);
  const rawCostR = sorted.reduce((sum, trade) => sum + trade.costR, 0);
  const rawNetR = rawGrossR - rawCostR;
  const grossR = riskScale * rawGrossR;
  const costR = riskScale * rawCostR;
  const netR = grossR - costR;
  let equity = 100;
  let peak = equity;
  let maxDd = 0;
  for (const trade of sorted) {
    // Equal-risk legs; staggered cohorts split the same 1% total risk budget.
    const legRisk = 0.01 / (2 * PICKS_PER_SIDE);
    equity *= Math.max(0, 1 + trade.netR * legRisk * riskScale);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return {
    n: sorted.length,
    wr: sorted.length ? sorted.filter((trade) => trade.netR > 0).length / sorted.length : 0,
    grossR,
    costR,
    netR,
    exp: sorted.length ? rawNetR / sorted.length : 0,
    equity,
    maxDd,
  };
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
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function blockBootstrap(
  trades: Trade[],
  start: number,
  end: number,
  riskScale: number,
  samples = 10_000,
): { low: number; high: number; pPositive: number } {
  const blockMs = 28 * DAY;
  const count = Math.max(1, Math.ceil((end - start) / blockMs));
  const blocks = Array(count).fill(0);
  for (const trade of trades) {
    const index = Math.floor((trade.entryTime - start) / blockMs);
    if (index >= 0 && index < count) blocks[index] += trade.netR * riskScale;
  }
  const rng = mulberry32(0x43534d32);
  const totals: number[] = [];
  let positive = 0;
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let block = 0; block < count; block++) {
      total += blocks[Math.floor(rng() * count)];
    }
    totals.push(total);
    if (total > 0) positive++;
  }
  totals.sort((a, b) => a - b);
  return {
    low: quantile(totals, 0.05),
    high: quantile(totals, 0.95),
    pPositive: positive / samples,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printRow(name: string, trades: Trade[], riskScale: number): void {
  const m = metrics(trades, riskScale);
  console.log(
    `${name.padEnd(13)} ${String(m.n).padStart(5)} ${(100 * m.wr).toFixed(1).padStart(6)}%`
    + ` ${signed(m.grossR).padStart(9)} ${signed(-m.costR).padStart(9)}`
    + ` ${signed(m.netR).padStart(9)} ${m.exp.toFixed(3).padStart(8)}`
    + ` ${(100 * m.maxDd).toFixed(1).padStart(6)}% ${m.equity.toFixed(1).padStart(8)}`,
  );
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 1200);
  const phaseArg = process.argv[5] ?? "all";
  const phaseCount = HOLD_HOURS / 24;
  const phases = phaseArg === "all"
    ? Array.from({ length: phaseCount }, (_, index) => index)
    : [Number(phaseArg)];
  if (![days, LOOKBACK_HOURS, HOLD_HOURS].every((value) => value > 0)
    || !Number.isInteger(phaseCount)
    || phases.some((phase) => !Number.isInteger(phase) || phase < 0 || phase >= phaseCount)
    || !["major8", "broad16"].includes(UNIVERSE)) {
    throw new Error("days/lookbackDays/holdDays phải > 0; phaseDays là all hoặc 0..holdDays-1");
  }
  const riskScale = 1 / phases.length;
  const warmupHours = Math.max(LOOKBACK_HOURS, ATR_PERIOD) + 2;
  const totalBars = Math.ceil(days * 24) + warmupHours + HOLD_HOURS + ENTRY_DELAY_HOURS;
  const data = new Map<string, Candle[]>();
  const atrs = new Map<string, number[]>();

  console.log(
    `Cross-sectional momentum | ${days}d | ${UNIVERSE} | rank ${LOOKBACK_HOURS / 24}d`
    + ` | top/bottom ${PICKS_PER_SIDE} | hold ${HOLD_HOURS / 24}d`
    + ` | phase ${phaseArg} | entry delay ${ENTRY_DELAY_HOURS}h`
    + ` | emergency SL ${STOP_ATR} ATR24h`,
  );
  for (const symbol of SYMBOLS) {
    const candles = await fetchKlinesPaged(symbol, "1h", totalBars);
    data.set(symbol, candles);
    atrs.set(symbol, atrSeries(candles, ATR_PERIOD));
  }

  const starts = [...data.values()].map((candles) => candles[0].openTime);
  const ends = [...data.values()].map((candles) => candles[candles.length - 1].openTime);
  const evaluationStart = Math.max(...starts) + warmupHours * HOUR;
  const evaluationEnd = Math.min(...ends) - (HOLD_HOURS + ENTRY_DELAY_HOURS) * HOUR;
  const indexBySymbol = new Map(
    [...data].map(([symbol, candles]) => [symbol, new Map(candles.map((candle, i) => [candle.openTime, i]))]),
  );
  const trades: Trade[] = [];

  const baseFirstDay = Math.ceil(evaluationStart / DAY) * DAY;
  for (const phase of phases) {
    const firstDay = baseFirstDay + phase * DAY;
    for (let time = firstDay; time <= evaluationEnd; time += HOLD_HOURS * HOUR) {
      const ranked: Array<{ symbol: string; index: number; score: number }> = [];
      for (const symbol of SYMBOLS) {
        const index = indexBySymbol.get(symbol)?.get(time);
        const candles = data.get(symbol)!;
        if (index == null || index < LOOKBACK_HOURS) continue;
        ranked.push({
          symbol,
          index,
          score: candles[index].open / candles[index - LOOKBACK_HOURS].open - 1,
        });
      }
      if (ranked.length !== SYMBOLS.length) continue;
      ranked.sort((a, b) => a.score - b.score);
      const picks = [
        ...ranked.slice(0, PICKS_PER_SIDE).map((value) => ({ ...value, dir: "short" as Direction })),
        ...ranked.slice(-PICKS_PER_SIDE).map((value) => ({ ...value, dir: "long" as Direction })),
      ];
      for (const pick of picks) {
        const trade = simulate(
          pick.symbol,
          data.get(pick.symbol)!,
          atrs.get(pick.symbol)!,
          pick.index + ENTRY_DELAY_HOURS,
          pick.dir,
          pick.score,
        );
        if (trade) trades.push(trade);
      }
    }
  }

  console.log("\ncohort        trades     WR     gross     costs     NET R    R/trade  maxDD   equity");
  console.log("-".repeat(91));
  printRow("ALL", trades, riskScale);
  printRow("LONG", trades.filter((trade) => trade.dir === "long"), riskScale);
  printRow("SHORT", trades.filter((trade) => trade.dir === "short"), riskScale);
  for (const symbol of SYMBOLS) {
    printRow(symbol.toUpperCase(), trades.filter((trade) => trade.symbol === symbol), riskScale);
  }
  const portfolioR = metrics(trades, riskScale).netR / (2 * PICKS_PER_SIDE);
  console.log(
    `Portfolio-equivalent NET R: ${signed(portfolioR)}`
    + ` (1R = tổng risk của ${2 * PICKS_PER_SIDE} legs trong một cohort)`,
  );

  const span = evaluationEnd - baseFirstDay;
  console.log("\n3 era liên tục:");
  for (let era = 0; era < 3; era++) {
    const lo = baseFirstDay + era * span / 3;
    const hi = baseFirstDay + (era + 1) * span / 3;
    printRow(
      `ERA ${era + 1}`,
      trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi),
      riskScale,
    );
  }

  console.log("\nTheo năm (leg-R đã scale qua các phase; chia tiếp cho số legs để ra portfolio-R):");
  const firstYear = new Date(baseFirstDay).getUTCFullYear();
  const lastYear = new Date(evaluationEnd).getUTCFullYear();
  for (let year = firstYear; year <= lastYear; year++) {
    const lo = Date.UTC(year, 0, 1);
    const hi = Date.UTC(year + 1, 0, 1);
    printRow(String(year), trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi), riskScale);
  }

  const bootstrap = blockBootstrap(trades, baseFirstDay, evaluationEnd, riskScale);
  console.log(
    `\nBlock bootstrap 28d (10.000 mẫu): 90% CI NET leg-R = [`
    + `${signed(bootstrap.low)}, ${signed(bootstrap.high)}]`
    + ` | P(NET>0)=${(100 * bootstrap.pPositive).toFixed(1)}%`,
  );
}

main().catch((error) => {
  console.error("Lỗi:", error?.response?.data ?? error.message);
  process.exit(1);
});
