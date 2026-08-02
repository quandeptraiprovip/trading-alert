/**
 * Diagnose why the recent Turtle era underperforms without tuning on that era.
 *
 * Key differences from exp-turtle-overfit.ts:
 * - run each symbol continuously, then attribute by entry time (no era-boundary reset/censoring);
 * - treat pyramid units sharing one exit as one dependent position;
 * - report right-tail concentration, MFE, market trendiness, and fixed counterfactuals;
 * - bootstrap weekly portfolio totals instead of pretending every pyramid unit is independent.
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-era-diagnosis.ts [days=1050]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import {
  T,
  Trade,
  TurtleParams,
  atrSeries,
  buildBtcGateLongs,
  runTurtle,
} from "../turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const DAY = TF_MS["1d"];
const BPD = DAY / TF_MS[T.tf];

type Era = { name: "A" | "B" | "C"; lo: number; hi: number };
type Position = {
  symbol: string;
  dir: Trade["dir"];
  entryTime: number;
  exitTime: number;
  exitReason: Trade["exitReason"];
  units: Trade[];
  netR: number;
};

function sum(a: number[]): number { return a.reduce((s, x) => s + x, 0); }
function mean(a: number[]): number { return a.length ? sum(a) / a.length : 0; }
function quantile(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (at - lo);
}
function fmt(n: number, digits = 1): string { return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`; }
function date(t: number): string { return new Date(t).toISOString().slice(0, 10); }

function positionsOf(trades: Trade[]): Position[] {
  const grouped = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.dir}|${t.exitTime}|${t.exitPrice}`;
    const g = grouped.get(key);
    if (g) g.push(t); else grouped.set(key, [t]);
  }
  return [...grouped.values()].map((units) => ({
    symbol: units[0].symbol,
    dir: units[0].dir,
    entryTime: Math.min(...units.map((t) => t.entryTime)),
    exitTime: units[0].exitTime,
    exitReason: units[0].exitReason,
    units: units.sort((a, b) => a.entryTime - b.entryTime),
    netR: sum(units.map((t) => t.netR)),
  })).sort((a, b) => a.entryTime - b.entryTime);
}

function eraTrades(trades: Trade[], era: Era): Trade[] {
  return trades.filter((t) => t.entryTime >= era.lo && t.entryTime < era.hi);
}

function metrics(trades: Trade[]) {
  const positions = positionsOf(trades);
  const net = sum(trades.map((t) => t.netR));
  const wins = trades.filter((t) => t.netR > 0);
  const losses = trades.filter((t) => t.netR <= 0);
  const sortedPositions = [...positions].sort((a, b) => b.netR - a.netR);
  const positiveNet = sum(sortedPositions.filter((p) => p.netR > 0).map((p) => p.netR));
  const top5 = sum(sortedPositions.slice(0, 5).map((p) => p.netR));
  const trim = Math.ceil(positions.length * 0.05);
  return {
    units: trades.length,
    positions: positions.length,
    net,
    expUnit: trades.length ? net / trades.length : 0,
    expPosition: positions.length ? net / positions.length : 0,
    wr: trades.length ? wins.length / trades.length : 0,
    avgWin: mean(wins.map((t) => t.netR)),
    avgLoss: mean(losses.map((t) => t.netR)),
    medianPosition: quantile(positions.map((p) => p.netR), 0.5),
    p90Position: quantile(positions.map((p) => p.netR), 0.9),
    top5Share: positiveNet > 0 ? top5 / positiveNet : 0,
    trimmedNet: sum(sortedPositions.slice(trim).map((p) => p.netR)),
  };
}

function printEraSummary(trades: Trade[], eras: Era[]): void {
  console.log("\nERA SUMMARY — continuous run, attribution by first unit entry");
  console.log("era  range                    units pos   WR    NET     R/unit  R/pos   avgW   avgL  medPos p90Pos top5/wins trim5%");
  console.log("-".repeat(123));
  for (const e of eras) {
    const ts = eraTrades(trades, e);
    const m = metrics(ts);
    console.log(
      `${e.name.padEnd(4)} ${`${date(e.lo)}→${date(e.hi - 1)}`.padEnd(24)} ${String(m.units).padStart(4)} ${String(m.positions).padStart(3)}` +
      ` ${(m.wr * 100).toFixed(0).padStart(3)}% ${fmt(m.net).padStart(7)} ${m.expUnit.toFixed(3).padStart(7)}` +
      ` ${m.expPosition.toFixed(2).padStart(6)} ${m.avgWin.toFixed(2).padStart(6)} ${m.avgLoss.toFixed(2).padStart(6)}` +
      ` ${m.medianPosition.toFixed(2).padStart(6)} ${m.p90Position.toFixed(2).padStart(6)}` +
      ` ${(m.top5Share * 100).toFixed(0).padStart(4)}% ${fmt(m.trimmedNet).padStart(7)}`,
    );
  }
}

function printBreakdown(trades: Trade[], eras: Era[], title: string, key: (t: Trade, unitNo: number) => string): void {
  const rows = new Set<string>();
  const tagged = new Map<Trade, number>();
  for (const p of positionsOf(trades)) p.units.forEach((t, i) => tagged.set(t, i + 1));
  for (const t of trades) rows.add(key(t, tagged.get(t) ?? 1));
  console.log(`\n${title} — NET R / units / R-unit`);
  console.log("group".padEnd(12) + eras.map((e) => e.name.padStart(22)).join(""));
  console.log("-".repeat(78));
  for (const row of [...rows].sort()) {
    const cells = eras.map((e) => {
      const ts = eraTrades(trades, e).filter((t) => key(t, tagged.get(t) ?? 1) === row);
      const net = sum(ts.map((t) => t.netR));
      return `${fmt(net)}/${ts.length}/${(ts.length ? net / ts.length : 0).toFixed(2)}`.padStart(22);
    });
    console.log(row.padEnd(12) + cells.join(""));
  }
}

function tradeMfeR(t: Trade, data: Map<string, Candle[]>, index: Map<string, Map<number, number>>): number {
  const candles = data.get(t.symbol)!;
  const idx = index.get(t.symbol)!;
  const start = idx.get(t.entryTime), end = idx.get(t.exitTime);
  const risk = Math.abs(t.entryPrice - t.initialSL);
  if (start == null || end == null || risk <= 0) return 0;
  let favorable = Math.max(0, t.dir === "long" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice);
  // Exclude the exit candle: intrabar path relative to the stop is unknown.
  for (let i = start + 1; i < end; i++) {
    favorable = Math.max(favorable, t.dir === "long" ? candles[i].high - t.entryPrice : t.entryPrice - candles[i].low);
  }
  return favorable / risk;
}

function printMfe(trades: Trade[], eras: Era[], data: Map<string, Candle[]>): void {
  const index = new Map<string, Map<number, number>>();
  for (const [sym, candles] of data) index.set(sym, new Map(candles.map((c, i) => [c.openTime, i])));
  console.log("\nFOLLOW-THROUGH (conservative MFE; exit candle excluded)");
  console.log("era  meanMFE p50 p75 p90  MFE>=3R MFE>=5R");
  for (const e of eras) {
    const mfes = eraTrades(trades, e).map((t) => tradeMfeR(t, data, index));
    console.log(
      `${e.name.padEnd(4)} ${mean(mfes).toFixed(2).padStart(7)} ${quantile(mfes, .5).toFixed(2).padStart(4)}` +
      ` ${quantile(mfes, .75).toFixed(2).padStart(4)} ${quantile(mfes, .9).toFixed(2).padStart(4)}` +
      ` ${(100 * mfes.filter((x) => x >= 3).length / mfes.length).toFixed(1).padStart(7)}%` +
      ` ${(100 * mfes.filter((x) => x >= 5).length / mfes.length).toFixed(1).padStart(7)}%`,
    );
  }
}

function efficiency(c: Candle[], i: number, len: number): number {
  if (i < len) return NaN;
  let path = 0;
  for (let k = i - len + 1; k <= i; k++) path += Math.abs(c[k].close - c[k - 1].close);
  return path > 0 ? Math.abs(c[i].close - c[i - len].close) / path : 0;
}

function printMarketRegimes(data: Map<string, Candle[]>, eras: Era[]): void {
  console.log("\nMARKET REGIME — values known at each sampled 4h close");
  console.log("era  BTC return  mean ATR%  mean ER30d  ER30d>=0.25");
  for (const e of eras) {
    const atrPcts: number[] = [], ers: number[] = [];
    for (const candles of data.values()) {
      const atr = atrSeries(candles, T.atrPeriod);
      for (let i = Math.max(T.atrPeriod, Math.round(30 * BPD)); i < candles.length; i += BPD) {
        if (candles[i].openTime < e.lo || candles[i].openTime >= e.hi) continue;
        atrPcts.push(atr[i] / candles[i].close);
        ers.push(efficiency(candles, i, Math.round(30 * BPD)));
      }
    }
    const btc = data.get("btcusdt")!;
    const first = btc.find((c) => c.openTime >= e.lo);
    const last = [...btc].reverse().find((c) => c.openTime < e.hi);
    const btcReturn = first && last ? last.close / first.open - 1 : 0;
    console.log(
      `${e.name.padEnd(4)} ${(btcReturn * 100).toFixed(1).padStart(9)}% ${(mean(atrPcts) * 100).toFixed(2).padStart(9)}%` +
      ` ${mean(ers).toFixed(3).padStart(11)} ${(100 * ers.filter((x) => x >= .25).length / ers.length).toFixed(1).padStart(12)}%`,
    );
  }
}

function weeklyTotals(trades: Trade[], era: Era): number[] {
  const weeks = Math.max(1, Math.ceil((era.hi - era.lo) / (7 * DAY)));
  const out = new Array(weeks).fill(0);
  for (const t of eraTrades(trades, era)) {
    const i = Math.min(weeks - 1, Math.floor((t.entryTime - era.lo) / (7 * DAY)));
    out[i] += t.netR;
  }
  return out;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function bootstrapWeeklyDifference(trades: Trade[], eras: Era[]): void {
  const old = [...weeklyTotals(trades, eras[0]), ...weeklyTotals(trades, eras[1])];
  const recent = weeklyTotals(trades, eras[2]);
  const rng = mulberry32(20260722), diffs: number[] = [];
  const B = 20_000;
  for (let b = 0; b < B; b++) {
    let a = 0, c = 0;
    for (let i = 0; i < old.length; i++) a += old[Math.floor(rng() * old.length)];
    for (let i = 0; i < recent.length; i++) c += recent[Math.floor(rng() * recent.length)];
    diffs.push(c / recent.length - a / old.length);
  }
  console.log("\nDEPENDENCE-AWARE BOOTSTRAP (portfolio NET aggregated by entry week)");
  console.log(`Observed mean weekly NET: A+B ${mean(old).toFixed(2)}R vs C ${mean(recent).toFixed(2)}R`);
  console.log(`C − (A+B), 90% bootstrap CI: [${quantile(diffs, .05).toFixed(2)}, ${quantile(diffs, .95).toFixed(2)}] R/week`);
  console.log(`P(C >= A+B): ${(100 * diffs.filter((x) => x >= 0).length / B).toFixed(1)}%`);
}

function buildBtcTwoSidedGate(btc: Candle[], fastLen: number, slowLen: number) {
  const sma = (len: number) => {
    const out = new Array(btc.length).fill(NaN); let s = 0;
    for (let i = 0; i < btc.length; i++) {
      s += btc[i].close; if (i >= len) s -= btc[i - len].close;
      if (i >= len - 1) out[i] = s / len;
    }
    return out;
  };
  const fast = sma(fastLen), slow = sma(slowLen), times = btc.map((c) => c.openTime);
  return (t: number, dir: Trade["dir"]): boolean => {
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0 || !Number.isFinite(fast[idx]) || !Number.isFinite(slow[idx])) return true;
    return dir === "long" ? fast[idx] > slow[idx] : fast[idx] < slow[idx];
  };
}

function buildBtcLongGate(
  btc: Candle[],
  fastLen: number,
  slowLen: number,
  options: { priceAboveSlow?: boolean; slowSlopeBars?: number },
) {
  const sma = (len: number) => {
    const out = new Array(btc.length).fill(NaN); let s = 0;
    for (let i = 0; i < btc.length; i++) {
      s += btc[i].close; if (i >= len) s -= btc[i - len].close;
      if (i >= len - 1) out[i] = s / len;
    }
    return out;
  };
  const fast = sma(fastLen), slow = sma(slowLen), times = btc.map((c) => c.openTime);
  return (t: number, dir: Trade["dir"]): boolean => {
    if (dir === "short") return true;
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const slopeBars = options.slowSlopeBars ?? 0;
    if (idx < Math.max(0, slopeBars) || !Number.isFinite(fast[idx]) || !Number.isFinite(slow[idx])) return true;
    if (!(fast[idx] > slow[idx])) return false;
    if (options.priceAboveSlow && !(btc[idx].close > slow[idx])) return false;
    if (slopeBars > 0 && !(slow[idx] > slow[idx - slopeBars])) return false;
    return true;
  };
}

function printCounterfactuals(data: Map<string, Candle[]>, eras: Era[], gate: TurtleParams["gate"]): void {
  const btc = data.get("btcusdt")!;
  const previous: TurtleParams = {
    ...T, shortEntryDays: 0, shortEntrySource: "low", shortExitMode: "chandelier", gate,
  };
  const variants: [string, TurtleParams][] = [
    ["PREVIOUS", previous],
    ["fixed 3ATR stop", { ...previous, initialStopObLookback: 0 }],
    ["max 1 unit", { ...previous, pyramidStepAtr: 0, pyramidMaxUnits: 1 }],
    ["max 2 units", { ...previous, pyramidMaxUnits: 2 }],
    ["max 3 units", { ...previous, pyramidMaxUnits: 3 }],
    ["entry 10d", { ...previous, entryDays: 10 }],
    ["entry 20d", { ...previous, entryDays: 20 }],
    ["entry 25d", { ...previous, entryDays: 25 }],
    ["short entry 20d", { ...previous, shortEntryDays: 20 }],
    ["short entry 25d", { ...previous, shortEntryDays: 25 }],
    ["short entry 30d", { ...previous, shortEntryDays: 30 }],
    ["long only", { ...previous, allowShort: false }],
    ["short close entry", { ...previous, shortEntrySource: "close" }],
    ["short close 20d", { ...previous, shortEntrySource: "close", shortEntryDays: 20 }],
    ["short close 25d", { ...previous, shortEntrySource: "close", shortEntryDays: 25 }],
    ["PRODUCTION FIX", { ...previous, shortEntrySource: "close", shortEntryDays: 30 }],
    ["short midpoint exit", { ...previous, shortExitMode: "mid" }],
    ["symmetric Hybrid", { ...previous, shortEntrySource: "close", shortExitMode: "mid" }],
    ["long gate +price>SMA100", { ...previous, gate: buildBtcLongGate(btc, T.btcGateFast, T.btcGateSlow, { priceAboveSlow: true }) }],
    ["long gate +SMA100 up10d", { ...previous, gate: buildBtcLongGate(btc, T.btcGateFast, T.btcGateSlow, { slowSlopeBars: 10 * BPD }) }],
    ["long gate +SMA100 up30d", { ...previous, gate: buildBtcLongGate(btc, T.btcGateFast, T.btcGateSlow, { slowSlopeBars: 30 * BPD }) }],
    ["two-sided BTC gate", { ...previous, gate: buildBtcTwoSidedGate(btc, T.btcGateFast, T.btcGateSlow) }],
    ["no BTC gate", { ...previous, gate: undefined }],
    ["legacy engine", { ...previous, longEntrySource: "high", longExitMode: "chandelier", initialStopObLookback: 0 }],
  ];
  console.log("\nPRE-SPECIFIED COUNTERFACTUALS — continuous run; R/unit by era");
  console.log("variant".padEnd(23) + " totalNET  totalExp" + eras.map((e) => `  ${e.name}:NET/exp/n`.padStart(18)).join(""));
  console.log("-".repeat(100));
  for (const [label, p] of variants) {
    const all: Trade[] = [];
    for (const [sym, candles] of data) all.push(...runTurtle(sym, candles, p));
    const eligible = all.filter((t) => t.entryTime >= eras[0].lo && t.entryTime < eras[2].hi);
    const total = metrics(eligible);
    const cells = eras.map((e) => {
      const ts = eraTrades(eligible, e), net = sum(ts.map((t) => t.netR));
      return `${fmt(net)}/${(ts.length ? net / ts.length : 0).toFixed(2)}/${ts.length}`.padStart(18);
    });
    console.log(`${label.padEnd(23)} ${fmt(total.net).padStart(8)} ${total.expUnit.toFixed(3).padStart(9)}${cells.join("")}`);
  }
}

function runBasket(data: Map<string, Candle[]>, p: TurtleParams, lo: number, hi: number): Trade[] {
  const all: Trade[] = [];
  for (const [sym, candles] of data) all.push(...runTurtle(sym, candles, p));
  return all.filter((t) => t.entryTime >= lo && t.entryTime < hi).sort((a, b) => a.entryTime - b.entryTime);
}

function monthKey(t: number): string { return new Date(t).toISOString().slice(0, 7); }

function monthlyTotals(trades: Trade[], lo: number, hi: number): Map<string, number> {
  const out = new Map<string, number>();
  const d = new Date(lo);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < hi) {
    out.set(monthKey(d.getTime()), 0);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  for (const t of trades) out.set(monthKey(t.entryTime), (out.get(monthKey(t.entryTime)) ?? 0) + t.netR);
  return out;
}

function printCandidateRobustness(data: Map<string, Candle[]>, eras: Era[], gate: TurtleParams["gate"]): void {
  const lo = eras[0].lo, hi = eras[2].hi;
  const previous: TurtleParams = {
    ...T, shortEntryDays: 0, shortEntrySource: "low", shortExitMode: "chandelier", gate,
  };
  const candidates: [string, TurtleParams][] = [
    ["short close entry", { ...previous, shortEntrySource: "close" }],
    ["short close 20d", { ...previous, shortEntrySource: "close", shortEntryDays: 20 }],
    ["short close 25d", { ...previous, shortEntrySource: "close", shortEntryDays: 25 }],
    ["short close 30d", { ...previous, shortEntrySource: "close", shortEntryDays: 30 }],
    ["short 25d", { ...previous, shortEntryDays: 25 }],
    ["short 30d", { ...previous, shortEntryDays: 30 }],
  ];
  const current = runBasket(data, previous, lo, hi);
  const currentMonths = monthlyTotals(current, lo, hi);
  console.log("\nPAIRED MONTHLY ROBUSTNESS VS CURRENT (20k deterministic bootstrap)");
  console.log("candidate".padEnd(20) + " deltaNET beatMonths meanΔ/mo  90% CI meanΔ/mo   P(meanΔ>0)");
  console.log("-".repeat(88));
  for (const [label, p] of candidates) {
    const trades = runBasket(data, p, lo, hi);
    const months = monthlyTotals(trades, lo, hi);
    const deltas = [...currentMonths.keys()].map((k) => (months.get(k) ?? 0) - (currentMonths.get(k) ?? 0));
    const rng = mulberry32(20260722 + label.length), boot: number[] = [];
    for (let b = 0; b < 20_000; b++) {
      let v = 0;
      for (let i = 0; i < deltas.length; i++) v += deltas[Math.floor(rng() * deltas.length)];
      boot.push(v / deltas.length);
    }
    const delta = sum(trades.map((t) => t.netR)) - sum(current.map((t) => t.netR));
    console.log(
      `${label.padEnd(20)} ${fmt(delta).padStart(8)} ${String(deltas.filter((x) => x > 0).length).padStart(3)}/${String(deltas.length).padEnd(3)}` +
      ` ${mean(deltas).toFixed(2).padStart(8)} [${quantile(boot, .05).toFixed(2).padStart(6)}, ${quantile(boot, .95).toFixed(2).padStart(6)}]` +
      ` ${(100 * boot.filter((x) => x > 0).length / boot.length).toFixed(1).padStart(10)}%`,
    );
  }

  console.log("\nROLLING 6-MONTH NET — current / short-close15 / short-close25");
  const shortClose = runBasket(data, candidates[0][1], lo, hi);
  const shortClose25 = runBasket(data, candidates[2][1], lo, hi);
  for (let start = lo; start < hi; start += 182 * DAY) {
    const end = Math.min(hi, start + 182 * DAY);
    const net = (ts: Trade[]) => sum(ts.filter((t) => t.entryTime >= start && t.entryTime < end).map((t) => t.netR));
    console.log(`${date(start)}→${date(end - 1)}  ${fmt(net(current)).padStart(8)} / ${fmt(net(shortClose)).padStart(8)} / ${fmt(net(shortClose25)).padStart(8)}`);
  }
}

function printTopPositions(trades: Trade[], eras: Era[]): void {
  console.log("\nTOP 5 POSITIONS PER ERA (all pyramid units clustered)");
  for (const e of eras) {
    const ps = positionsOf(eraTrades(trades, e)).sort((a, b) => b.netR - a.netR).slice(0, 5);
    console.log(`${e.name}: ${ps.map((p) => `${p.symbol.replace("usdt", "").toUpperCase()}-${p.dir[0].toUpperCase()} ${fmt(p.netR)}R/${p.units.length}u @${date(p.entryTime)}`).join(" | ")}`);
  }
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "1050", 10);
  const totalBars = Math.ceil(days * BPD) + T.btcGateSlow + 50;
  const data = new Map<string, Candle[]>();
  console.log(`Fetch/cache ${SYMBOLS.length} symbols × ${totalBars} bars ${T.tf}...`);
  for (const sym of SYMBOLS) data.set(sym, await fetchKlinesPaged(sym, T.tf, totalBars));

  const btc = data.get("btcusdt")!;
  const warmup = Math.max(Math.round(T.entryDays * BPD), T.trendLen, T.atrPeriod, T.btcGateSlow) + 1;
  const t0 = btc[warmup].openTime;
  const t1 = btc[btc.length - 1].openTime + TF_MS[T.tf];
  const eras: Era[] = [0, 1, 2].map((i) => ({
    name: (["A", "B", "C"] as const)[i],
    lo: t0 + (t1 - t0) * i / 3,
    hi: t0 + (t1 - t0) * (i + 1) / 3,
  }));
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const trades: Trade[] = [];
  const previous: TurtleParams = {
    ...T, shortEntryDays: 0, shortEntrySource: "low", shortExitMode: "chandelier", gate,
  };
  for (const [sym, candles] of data) trades.push(...runTurtle(sym, candles, previous));
  const eligible = trades.filter((t) => t.entryTime >= t0 && t.entryTime < t1).sort((a, b) => a.entryTime - b.entryTime);

  console.log(`Analysis window ${date(t0)}→${date(t1 - 1)}; ${eligible.length} closed units, ${positionsOf(eligible).length} dependent positions.`);
  printEraSummary(eligible, eras);
  printBreakdown(eligible, eras, "DIRECTION", (t) => t.dir);
  printBreakdown(eligible, eras, "SYMBOL", (t) => t.symbol.replace("usdt", "").toUpperCase());
  printBreakdown(eligible, eras, "EXIT REASON", (t) => t.exitReason);
  printBreakdown(eligible, eras, "PYRAMID UNIT", (_t, unitNo) => `unit${unitNo}`);
  printTopPositions(eligible, eras);
  printMfe(eligible, eras, data);
  printMarketRegimes(data, eras);
  bootstrapWeeklyDifference(eligible, eras);
  printCounterfactuals(data, eras, gate);
  printCandidateRobustness(data, eras, gate);
}

main().catch((e) => { console.error("Error:", e?.response?.data ?? e.message); process.exit(1); });
