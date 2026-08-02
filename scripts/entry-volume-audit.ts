/**
 * Audit entry 15m / volume đa khung trên cùng dữ liệu đóng băng.
 *
 * Mục tiêu:
 * - tách tác dụng của volume lớn, taker delta và chuẩn hoá theo slot thời gian;
 * - thử gom phản ứng 30-60 phút (2-4 nến 15m) thay vì chỉ một nến;
 * - báo cáo toàn kỳ, 3 era, 365 ngày gần nhất và bootstrap Δ theo tuần.
 *
 * Run: ./node_modules/.bin/ts-node scripts/entry-volume-audit.ts [days] [symbols] [structural|threshold|baseline]
 */
import "../load-env";
import { Candle, CONFIG, TF_MS } from "../strategy";
import { runBacktest, Trade } from "../backtest";
import { fetchKlinesPaged } from "../kline-fetch";

type Overrides = Partial<typeof CONFIG>;
type Variant = { name: string; o: Overrides };
type Result = { variant: Variant; trades: Trade[] };

const VARIANTS: Variant[] = [
  { name: "baseline", o: {} },
  { name: "khong vol + khong delta", o: { ltfConfirmVolMult: 0, useDelta: false } },
  { name: "khong vol", o: { ltfConfirmVolMult: 0 } },
  { name: "khong delta", o: { useDelta: false } },
  { name: "TOD-RVOL 1 bar", o: { ltfUseTimeOfDayRVOL: true } },
  { name: "volume 2 bars", o: { confirmVolumeWindowBars: 2 } },
  { name: "volume 4 bars", o: { confirmVolumeWindowBars: 4 } },
  { name: "delta 2 bars", o: { deltaWindowBars: 2 } },
  { name: "delta 4 bars", o: { deltaWindowBars: 4 } },
  { name: "vol4 + delta4", o: { confirmVolumeWindowBars: 4, deltaWindowBars: 4 } },
  {
    name: "TOD + vol4 + delta4",
    o: { ltfUseTimeOfDayRVOL: true, confirmVolumeWindowBars: 4, deltaWindowBars: 4 },
  },
  { name: "chan high-vol than nho", o: { confirmRejectHighVolLowBody: true } },
  { name: "CLV 0.55", o: { confirmCloseLocationMin: 0.55 } },
];

const THRESHOLD_VARIANTS: Variant[] = [
  { name: "baseline", o: {} },
  { name: "vol 0.0", o: { ltfConfirmVolMult: 0 } },
  { name: "vol 0.8", o: { ltfConfirmVolMult: 0.8 } },
  { name: "vol 1.0", o: { ltfConfirmVolMult: 1.0 } },
  { name: "vol 1.1", o: { ltfConfirmVolMult: 1.1 } },
  { name: "vol 1.2", o: { ltfConfirmVolMult: 1.2 } },
  { name: "vol 1.4", o: { ltfConfirmVolMult: 1.4 } },
  { name: "vol 1.5", o: { ltfConfirmVolMult: 1.5 } },
  { name: "vol 1.7", o: { ltfConfirmVolMult: 1.7 } },
  { name: "vol 2.0", o: { ltfConfirmVolMult: 2.0 } },
  { name: "delta 0.50", o: { deltaBuyMin: 0.5 } },
  { name: "delta 0.52", o: { deltaBuyMin: 0.52 } },
  { name: "delta 0.54", o: { deltaBuyMin: 0.54 } },
  { name: "delta 0.56", o: { deltaBuyMin: 0.56 } },
  { name: "delta 0.58", o: { deltaBuyMin: 0.58 } },
  { name: "delta 0.60", o: { deltaBuyMin: 0.6 } },
];

function sumR(trades: Trade[]): number {
  return trades.reduce((sum, trade) => sum + trade.netR, 0);
}

function meanR(trades: Trade[]): number {
  return trades.length ? sumR(trades) / trades.length : 0;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weeklySeries(trades: Trade[], start: number, weeks: number): number[] {
  const out = Array<number>(weeks).fill(0);
  const weekMs = 7 * TF_MS["1d"];
  for (const trade of trades) {
    const i = Math.floor((trade.entryTime - start) / weekMs);
    if (i >= 0 && i < weeks) out[i] += trade.netR;
  }
  return out;
}

function pairedWeeklyBootstrap(
  base: Trade[],
  candidate: Trade[],
  start: number,
  end: number,
  samples = 5000,
): { lo: number; mid: number; hi: number; pPositive: number } {
  const weeks = Math.max(1, Math.ceil((end - start) / (7 * TF_MS["1d"])));
  const a = weeklySeries(base, start, weeks);
  const b = weeklySeries(candidate, start, weeks);
  const delta = a.map((v, i) => b[i] - v);
  const rng = mulberry32(0x15a11d7);
  const means: number[] = [];
  let positive = 0;
  for (let s = 0; s < samples; s++) {
    let total = 0;
    for (let i = 0; i < weeks; i++) total += delta[Math.floor(rng() * weeks)];
    const mean = total / weeks;
    means.push(mean);
    if (mean > 0) positive++;
  }
  means.sort((x, y) => x - y);
  return {
    lo: quantile(means, 0.05),
    mid: quantile(means, 0.5),
    hi: quantile(means, 0.95),
    pPositive: positive / samples,
  };
}

function eraNets(trades: Trade[], start: number, end: number): number[] {
  const span = (end - start) / 3;
  return [0, 1, 2].map((era) => {
    const lo = start + era * span;
    const hi = era === 2 ? end + 1 : start + (era + 1) * span;
    return sumR(trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi));
  });
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function printBucket(title: string, rows: { label: string; trades: Trade[] }[]): void {
  console.log(`\n${title}`);
  console.log(`${"Bucket".padEnd(20)} ${"N".padStart(5)} ${"NET R".padStart(9)} ${"exp".padStart(8)} ${"WR".padStart(7)}`);
  for (const row of rows) {
    const wr = row.trades.length ? row.trades.filter((trade) => trade.netR > 0).length / row.trades.length : 0;
    console.log(
      `${row.label.padEnd(20)} ${String(row.trades.length).padStart(5)} ${signed(sumR(row.trades)).padStart(9)} ${meanR(row.trades).toFixed(3).padStart(8)} ${(100 * wr).toFixed(0).padStart(6)}%`,
    );
  }
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "1200", 10);
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const suite = process.argv[4] ?? "structural";
  const variants = suite === "threshold" ? THRESHOLD_VARIANTS : suite === "baseline" ? [VARIANTS[0]] : VARIANTS;
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;

  console.log(`Nap ${days} ngay x ${symbols.length} symbols (${bars} nen ${CONFIG.entryTf}/symbol)...`);
  const pairs = await Promise.all(
    symbols.map(async (symbol) => [symbol, await fetchKlinesPaged(symbol, CONFIG.entryTf, bars)] as const),
  );
  const data = new Map<string, Candle[]>(pairs.filter(([, candles]) => candles.length >= 500));
  if (!data.size) throw new Error("Khong co du du lieu de audit");

  const start = Math.max(...[...data.values()].map((candles) => candles[0].openTime));
  const end = Math.min(...[...data.values()].map((candles) => candles[candles.length - 1].openTime));
  const recentStart = end - 365 * TF_MS["1d"];
  const saved = { ...CONFIG };
  const results: Result[] = [];

  for (const variant of variants) {
    Object.assign(CONFIG, saved, variant.o);
    const trades = [...data].flatMap(([symbol, candles]) => runBacktest(symbol, candles));
    results.push({ variant, trades: trades.sort((a, b) => a.entryTime - b.entryTime) });
    process.stdout.write(`  ${variant.name}: ${trades.length} lenh, ${signed(sumR(trades))}R\n`);
  }
  Object.assign(CONFIG, saved);

  const baseline = results[0].trades;
  const baseNet = sumR(baseline);
  console.log("\n" + "=".repeat(132));
  console.log(`AUDIT ENTRY/VOLUME 15M | ${new Date(start).toISOString().slice(0, 10)} -> ${new Date(end).toISOString().slice(0, 10)}`);
  console.log("=".repeat(132));
  console.log(
    `${"Variant".padEnd(26)} ${"N".padStart(4)} ${"NET".padStart(8)} ${"exp".padStart(7)} ${"WR".padStart(6)} ${"365d".padStart(8)} ${"Era A".padStart(8)} ${"Era B".padStart(8)} ${"Era C".padStart(8)} ${"DNET".padStart(8)} ${"CI90 dR/week".padStart(21)} ${"P+".padStart(6)}`,
  );

  for (const result of results) {
    const trades = result.trades;
    const eras = eraNets(trades, start, end);
    const recent = sumR(trades.filter((trade) => trade.entryTime >= recentStart));
    const wr = trades.length ? trades.filter((trade) => trade.netR > 0).length / trades.length : 0;
    const ci = pairedWeeklyBootstrap(baseline, trades, start, end);
    console.log(
      `${result.variant.name.padEnd(26)} ${String(trades.length).padStart(4)} ${signed(sumR(trades)).padStart(8)} ${meanR(trades).toFixed(3).padStart(7)} ${(100 * wr).toFixed(0).padStart(5)}% ${signed(recent).padStart(8)} ${eras.map((v) => signed(v).padStart(8)).join(" ")} ${signed(sumR(trades) - baseNet).padStart(8)} ${(`[${signed(ci.lo, 3)},${signed(ci.hi, 3)}]`).padStart(21)} ${(100 * ci.pPositive).toFixed(1).padStart(5)}%`,
    );
  }

  const unfiltered = results.find((result) => result.variant.name === "khong vol + khong delta")?.trades;
  if (unfiltered) {
    printBucket("Counterfactual BOS theo volume ratio (bo gate volume/delta)", [
      { label: "<0.8x", trades: unfiltered.filter((t) => t.confirmVolRatio < 0.8) },
      { label: "0.8-1.3x", trades: unfiltered.filter((t) => t.confirmVolRatio >= 0.8 && t.confirmVolRatio < 1.3) },
      { label: "1.3-2.0x", trades: unfiltered.filter((t) => t.confirmVolRatio >= 1.3 && t.confirmVolRatio < 2) },
      { label: ">=2.0x", trades: unfiltered.filter((t) => t.confirmVolRatio >= 2) },
    ]);

    const directionalRatio = (trade: Trade): number => {
      if (trade.confirmBuyRatio == null) return 0.5;
      return trade.dir === "long" ? trade.confirmBuyRatio : 1 - trade.confirmBuyRatio;
    };
    printBucket("Counterfactual BOS theo taker-delta cung huong (bo gate volume/delta)", [
      { label: "<0.50", trades: unfiltered.filter((t) => directionalRatio(t) < 0.5) },
      { label: "0.50-0.55", trades: unfiltered.filter((t) => directionalRatio(t) >= 0.5 && directionalRatio(t) < 0.55) },
      { label: "0.55-0.60", trades: unfiltered.filter((t) => directionalRatio(t) >= 0.55 && directionalRatio(t) < 0.6) },
      { label: ">=0.60", trades: unfiltered.filter((t) => directionalRatio(t) >= 0.6) },
    ]);
  }

  console.log("\nNET theo symbol (baseline -> tung variant):");
  for (const symbol of data.keys()) {
    const values = results.map((result) => sumR(result.trades.filter((trade) => trade.symbol === symbol)));
    console.log(`  ${symbol.toUpperCase().padEnd(10)} ${results.map((result, i) => `${result.variant.name}=${signed(values[i])}`).join(" | ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
