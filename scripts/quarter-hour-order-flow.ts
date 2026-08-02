/**
 * Quarter-hour opening order-flow continuation (research proxy).
 *
 * Binance 5m taker-buy volume approximates the paper's first-window order
 * imbalance. Signal uses a completed 5m candle whose open is on a quarter-hour;
 * entry is the following 5m open. One position per symbol, time exit only plus
 * a 2x 24h-realized-volatility emergency stop. This is not a 10-second
 * trade-data replication.
 *
 * Run: ./node_modules/.bin/ts-node scripts/quarter-hour-order-flow.ts
 *   [days=400] [holdHours=12]
 */

import { CONFIG, Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";

const SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];
const TF = "5m";
const BAR_MS = TF_MS[TF];
const BARS_PER_DAY = TF_MS["1d"] / BAR_MS;
const VOL_PERIOD = BARS_PER_DAY;
const STOP_SIGMA = 2;

type Direction = "long" | "short";
type Trade = {
  symbol: string;
  dir: Direction;
  entryTime: number;
  exitTime: number;
  imbalance: number;
  grossR: number;
  costR: number;
  netR: number;
  reason: "sl" | "time";
};

function realizedVolPrice(candles: Candle[], period: number): number[] {
  const out = Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  let sumSquared = 0;
  for (let i = 1; i < candles.length; i++) {
    const logReturn = Math.log(candles[i].close / candles[i - 1].close);
    sumSquared += logReturn * logReturn;
    if (i > period) {
      const oldReturn = Math.log(candles[i - period].close / candles[i - period - 1].close);
      sumSquared -= oldReturn * oldReturn;
    }
    if (i >= period) out[i] = candles[i].close * Math.sqrt(Math.max(0, sumSquared));
  }
  return out;
}

function tradeCostR(entry: number, risk: number, holdMs: number): number {
  const riskFraction = risk / entry;
  const roundTrip = 2 * (CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100;
  const fundingPeriods = Math.floor(holdMs / (8 * 60 * 60 * 1000));
  const funding = fundingPeriods * CONFIG.costs.fundingPer8hPct / 100;
  return (roundTrip + funding) / riskFraction;
}

function runSymbol(symbol: string, candles: Candle[], holdBars: number, evaluationStart: number): Trade[] {
  const volatility = realizedVolPrice(candles, VOL_PERIOD);
  const trades: Trade[] = [];
  let busyUntil = -Infinity;
  for (let signalIndex = VOL_PERIOD; signalIndex + holdBars + 1 < candles.length; signalIndex++) {
    const signal = candles[signalIndex];
    if (signal.openTime < evaluationStart || signal.openTime <= busyUntil) continue;
    const minute = new Date(signal.openTime).getUTCMinutes();
    if (minute % 15 !== 0 || !(signal.volume > 0) || signal.takerBuyVolume == null) continue;
    const imbalance = 2 * signal.takerBuyVolume / signal.volume - 1;
    if (!Number.isFinite(imbalance) || imbalance === 0) continue;
    const dir: Direction = imbalance > 0 ? "long" : "short";
    const entryIndex = signalIndex + 1;
    const entry = candles[entryIndex].open;
    const risk = STOP_SIGMA * volatility[signalIndex];
    if (!(risk > 0)) continue;
    const stop = dir === "long" ? entry - risk : entry + risk;
    let exitIndex = entryIndex + holdBars;
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
    const costR = tradeCostR(entry, risk, exitTime - candles[entryIndex].openTime);
    trades.push({
      symbol,
      dir,
      entryTime: candles[entryIndex].openTime,
      exitTime,
      imbalance,
      grossR,
      costR,
      netR: grossR - costR,
      reason,
    });
    busyUntil = exitTime;
  }
  return trades;
}

function metrics(trades: Trade[]) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const grossR = sorted.reduce((sum, trade) => sum + trade.grossR, 0);
  const costR = sorted.reduce((sum, trade) => sum + trade.costR, 0);
  const netR = grossR - costR;
  let equity = 100;
  let peak = equity;
  let maxDd = 0;
  for (const trade of sorted) {
    equity *= Math.max(0, 1 + trade.netR * 0.0025);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return {
    n: sorted.length,
    wr: sorted.length ? sorted.filter((trade) => trade.netR > 0).length / sorted.length : 0,
    grossR,
    costR,
    netR,
    exp: sorted.length ? netR / sorted.length : 0,
    maxDd,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printRow(name: string, trades: Trade[]): void {
  const m = metrics(trades);
  console.log(
    `${name.padEnd(13)} ${String(m.n).padStart(5)} ${(100 * m.wr).toFixed(1).padStart(6)}%`
    + ` ${signed(m.grossR).padStart(9)} ${signed(-m.costR).padStart(9)}`
    + ` ${signed(m.netR).padStart(9)} ${m.exp.toFixed(3).padStart(8)}`
    + ` ${(100 * m.maxDd).toFixed(1).padStart(6)}%`,
  );
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 400);
  const holdHours = Number(process.argv[3] ?? 12);
  if (!(days > 0) || !(holdHours > 0)) throw new Error("days và holdHours phải > 0");
  const holdBars = Math.round(holdHours * 60 / 5);
  const totalBars = Math.ceil(days * BARS_PER_DAY) + VOL_PERIOD + holdBars + 2;
  const evaluationStart = Date.now() - days * TF_MS["1d"];
  const all: Trade[] = [];

  console.log(
    `Quarter-hour 5m order-flow proxy | ${days}d | hold ${holdHours}h`
    + ` | entry next 5m | SL ${STOP_SIGMA}σ realized-vol 24h`,
  );
  for (const symbol of SYMBOLS) {
    const candles = await fetchKlinesPaged(symbol, TF, totalBars);
    const trades = runSymbol(symbol, candles, holdBars, evaluationStart);
    all.push(...trades);
    printRow(symbol.toUpperCase(), trades);
  }

  console.log("\ncohort        trades     WR     gross     costs     NET R    R/trade  maxDD");
  console.log("-".repeat(83));
  printRow("ALL", all);
  printRow("LONG", all.filter((trade) => trade.dir === "long"));
  printRow("SHORT", all.filter((trade) => trade.dir === "short"));
  const end = Date.now();
  const span = end - evaluationStart;
  console.log("\n3 era liên tục:");
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
