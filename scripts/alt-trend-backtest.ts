/**
 * Research-only Alt Trend backtest.
 *
 * Run:
 *   ./node_modules/.bin/ts-node scripts/alt-trend-backtest.ts \
 *     [days=1200] [symbols=coin1usdt,coin2usdt,...] [plannedNotionalUsd=100]
 *
 * Symbols are mandatory to prevent a hidden/cherry-picked default universe.
 * Use alt-universe-scanner.ts for a current snapshot, while remembering that a
 * current survivor list is not a point-in-time historical universe.
 */
import { ALT_TREND_DEFAULTS, AltTrendTrade, runAltTrendPortfolio } from "../alt-trend";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS } from "../strategy";

const DAY = TF_MS["1d"];
const RISK_FRACTION = 0.002;
const COST_STRESS_BPS = [10, 25, 50, 100];

function metrics(trades: AltTrendTrade[]) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const netR = sorted.reduce((sum, trade) => sum + trade.netR, 0);
  const grossR = sorted.reduce((sum, trade) => sum + trade.grossR, 0);
  const costR = sorted.reduce((sum, trade) => sum + trade.costR, 0);
  let equity = 100;
  let peak = equity;
  let maxDd = 0;
  for (const trade of sorted) {
    equity *= Math.max(0, 1 + trade.netR * RISK_FRACTION);
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
    equity,
    maxDd,
  };
}

function rng(seed: number): () => number {
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

function blockBootstrap(trades: AltTrendTrade[], start: number, end: number) {
  const blockMs = 28 * DAY;
  const count = Math.max(1, Math.ceil((end - start) / blockMs));
  const blocks = new Array(count).fill(0);
  for (const trade of trades) {
    const index = Math.floor((trade.entryTime - start) / blockMs);
    if (index >= 0 && index < count) blocks[index] += trade.netR;
  }
  const random = rng(0xA17_2026);
  const samples: number[] = [];
  for (let sample = 0; sample < 5_000; sample++) {
    let total = 0;
    for (let draw = 0; draw < count; draw++) total += blocks[Math.floor(random() * count)];
    samples.push(total);
  }
  samples.sort((a, b) => a - b);
  return {
    low: quantile(samples, 0.05),
    high: quantile(samples, 0.95),
    pPositive: samples.filter((value) => value > 0).length / samples.length,
  };
}

function row(label: string, trades: AltTrendTrade[]): void {
  const value = metrics(trades);
  console.log(
    `${label.padEnd(12)} ${String(value.n).padStart(6)} ${(100 * value.wr).toFixed(1).padStart(6)}%`
    + ` ${value.grossR.toFixed(1).padStart(9)} ${(-value.costR).toFixed(1).padStart(9)}`
    + ` ${value.netR.toFixed(1).padStart(9)} ${value.exp.toFixed(3).padStart(9)}`
    + ` ${value.equity.toFixed(1).padStart(8)} ${(100 * value.maxDd).toFixed(1).padStart(6)}%`,
  );
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 1200);
  const rawSymbols = process.argv[3];
  const plannedNotionalUsd = Number(process.argv[4] ?? 100);
  if (!rawSymbols) {
    throw new Error("Thiếu symbols. Hãy truyền universe rõ ràng để tránh default cherry-pick.");
  }
  if (!(days > 0) || !(plannedNotionalUsd > 0)) throw new Error("days và plannedNotionalUsd phải > 0");
  const symbols = [...new Set(rawSymbols.split(",").map((value) => value.trim().toLowerCase()))]
    .filter((symbol) => symbol && symbol !== "btcusdt");
  if (symbols.length < 2) throw new Error("Alt Trend cần ít nhất 2 altcoin để xếp hạng relative strength");

  const warmup = Math.max(
    ALT_TREND_DEFAULTS.minHistoryDays,
    ALT_TREND_DEFAULTS.trendSmaDays,
    ALT_TREND_DEFAULTS.btcSlowDays,
  ) + 10;
  const totalBars = Math.ceil(days) + warmup;
  const evaluationStart = Date.now() - days * DAY;
  const data = new Map<string, Candle[]>();
  const closedOnly = (candles: Candle[]) => candles.filter((candle) => candle.openTime + DAY <= Date.now());

  console.log(`Alt Trend fetch | ${symbols.length} altcoin | ${days}d + ${warmup}d warmup | 1d`);
  const btc = closedOnly(await fetchKlinesPaged("btcusdt", "1d", totalBars));
  for (const symbol of symbols) {
    const candles = closedOnly(await fetchKlinesPaged(symbol, "1d", totalBars));
    if (candles.length < warmup) {
      console.log(`[${symbol.toUpperCase()}] chỉ có ${candles.length} nến, vẫn giữ để age gate tự loại.`);
    }
    data.set(symbol, candles);
  }

  console.log("\nCẢNH BÁO UNIVERSE:");
  console.log("- Backtest history chỉ có age + median quote-volume gate từ OHLCV.");
  console.log("- Spread/depth/OI chỉ được scanner kiểm tra ở hiện tại; danh sách survivor hiện tại không phải point-in-time universe.");
  console.log("- Không dùng kết quả này để bật live; snapshot forward mới là validation thật.\n");

  console.log("cost/side    trades     WR     gross    costs     NET R   R/trade  equity   maxDD");
  console.log("-".repeat(91));
  const byCost = new Map<number, AltTrendTrade[]>();
  for (const sideCostBps of COST_STRESS_BPS) {
    const trades = runAltTrendPortfolio(data, btc, {
      ...ALT_TREND_DEFAULTS,
      plannedNotionalUsd,
      sideCostBps,
    }, { entryStartTime: evaluationStart });
    byCost.set(sideCostBps, trades);
    row(`${sideCostBps}bp`, trades);
  }

  const base = byCost.get(25)!;
  const end = btc.at(-1)?.openTime ?? Date.now();
  const bootstrap = blockBootstrap(base, evaluationStart, end);
  console.log(`\nBASE 25bp/side | block-bootstrap 28d CI90 [${bootstrap.low.toFixed(1)}R, ${bootstrap.high.toFixed(1)}R] | P(NET>0) ${(100 * bootstrap.pPositive).toFixed(1)}%`);

  console.log("\n3 ERA LIÊN TỤC — base 25bp/side");
  const span = end - evaluationStart;
  for (let era = 0; era < 3; era++) {
    const lo = evaluationStart + era * span / 3;
    const hi = evaluationStart + (era + 1) * span / 3;
    row(`ERA ${era + 1}`, base.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi));
  }

  console.log("\nPER-SYMBOL — base 25bp/side");
  for (const symbol of symbols) row(symbol.toUpperCase(), base.filter((trade) => trade.symbol === symbol));

  const bestCoin = [...new Set(base.map((trade) => trade.symbol))]
    .map((symbol) => ({ symbol, net: base.filter((trade) => trade.symbol === symbol).reduce((sum, trade) => sum + trade.netR, 0) }))
    .sort((a, b) => b.net - a.net)[0];
  if (bestCoin) {
    const withoutBest = base.filter((trade) => trade.symbol !== bestCoin.symbol);
    console.log(`\nSENSITIVITY bỏ coin NET cao nhất (${bestCoin.symbol.toUpperCase()} ${bestCoin.net.toFixed(1)}R):`);
    row("without-best", withoutBest);
  }
}

main().catch((error) => {
  console.error("Alt Trend backtest lỗi:", error?.response?.data ?? error.message);
  process.exit(1);
});
