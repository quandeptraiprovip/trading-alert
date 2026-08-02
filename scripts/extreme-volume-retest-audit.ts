/**
 * Event-study: vùng extreme-volume 15m và lần retest đầu tiên.
 *
 * Không dùng dữ liệu tương lai để tạo event/vùng/tín hiệu:
 * - volume event so với mean quote-volume của 96/192 nến đứng trước;
 * - giá phải rời vùng >= 0.5 ATR rồi mới ghi nhận retest;
 * - entry/outcome bắt đầu sau khi nến retest đóng.
 *
 * Kline không có volume-at-price; body/range ở đây chỉ là proxy vùng giá.
 * Run: ./node_modules/.bin/ts-node scripts/extreme-volume-retest-audit.ts [days] [symbols]
 */
import "../load-env";
import {
  Candle,
  CONFIG,
  TF_MS,
  aggregate,
  buildHtfContext,
  findSwings,
  htfClosedCount,
  lastConfirmedSwing,
} from "../strategy";
import { runBacktest, Trade } from "../backtest";
import { fetchKlinesPaged } from "../kline-fetch";

type Direction = "long" | "short";
type FlowClass = "aligned" | "opposite" | "neutral";
type ZoneKind = "body" | "range";

interface Spec {
  name: string;
  lookback: number;
  threshold: number;
  clusterBars: number;
  zoneKind: ZoneKind;
}

interface Observation {
  symbol: string;
  eventIndex: number;
  retestIndex: number;
  eventTime: number;
  retestTime: number;
  direction: Direction;
  zoneLow: number;
  zoneHigh: number;
  eventVolRatio: number;
  retestVolRatio: number;
  eventFlow: FlowClass;
  retestFlow: FlowClass;
  eventBodyRatio: number;
  retestBodyRatio: number;
  retestCloseStrength: number; // 1 = đóng sát phía kỳ vọng của vùng, 0 = sát phía phá vùng
  retestPriceAligned: boolean;
  retestRejectionWick: boolean;
  htfAligned: boolean;
  delayBars: number;
  smallerRepeat: boolean;
  ret1h: number;
  ret4h: number;
  ret12h: number;
  ret24h: number;
  grossR: number;
  costR: number;
  netR: number;
  netR2Atr24h: number;
  netR3Atr24h: number;
}

const SPECS: Spec[] = [
  { name: "single L96 2.0x body", lookback: 96, threshold: 2, clusterBars: 1, zoneKind: "body" },
  { name: "single L192 1.8x body", lookback: 192, threshold: 1.8, clusterBars: 1, zoneKind: "body" },
  { name: "single L192 2.0x body", lookback: 192, threshold: 2, clusterBars: 1, zoneKind: "body" },
  { name: "single L192 2.2x body", lookback: 192, threshold: 2.2, clusterBars: 1, zoneKind: "body" },
  { name: "single L192 2.0x range", lookback: 192, threshold: 2, clusterBars: 1, zoneKind: "range" },
  { name: "cluster4 L192 1.5x", lookback: 192, threshold: 1.5, clusterBars: 4, zoneKind: "body" },
  { name: "cluster4 L192 1.75x", lookback: 192, threshold: 1.75, clusterBars: 4, zoneKind: "body" },
  { name: "cluster4 L192 2.0x", lookback: 192, threshold: 2, clusterBars: 4, zoneKind: "body" },
];

const ATR_PERIOD = 20;
const MAX_RETEST_BARS = 96 * 10;
const OUTCOME_BARS = 96;
const DEPART_ATR = 0.5;
const RETEST_SPIKE = 1.3;
const ROUND_TRIP_FEE_SLIP = 0.0014; // 0.05% fee + 0.02% slip, mỗi chiều
const FUNDING_PER_8H = 0.0001;

function quoteVolume(c: Candle): number {
  return c.quoteVolume != null && c.quoteVolume > 0 ? c.quoteVolume : c.volume * c.close;
}

function prefix(values: number[]): number[] {
  const out = Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i] + values[i];
  return out;
}

function rangeSum(p: number[], start: number, endExclusive: number): number {
  return p[endExclusive] - p[start];
}

function atr(candles: Candle[]): number[] {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const p = prefix(tr);
  return tr.map((_, i) => {
    const start = Math.max(0, i - ATR_PERIOD + 1);
    return rangeSum(p, start, i + 1) / (i - start + 1);
  });
}

function aggregateBuyRatio(candles: Candle[], start: number, end: number): number | null {
  let buy = 0;
  let total = 0;
  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (c.takerBuyVolume == null || !Number.isFinite(c.takerBuyVolume) || c.volume <= 0) return null;
    buy += c.takerBuyVolume;
    total += c.volume;
  }
  return total > 0 ? buy / total : null;
}

function flowClass(buyRatio: number | null, direction: Direction): FlowClass {
  if (buyRatio == null || (buyRatio > 0.45 && buyRatio < 0.55)) return "neutral";
  const flowDirection: Direction = buyRatio >= 0.55 ? "long" : "short";
  return flowDirection === direction ? "aligned" : "opposite";
}

function signedReturn(entry: number, future: number, direction: Direction): number {
  return direction === "long" ? future / entry - 1 : entry / future - 1;
}

function simulateOneAtr(
  candles: Candle[],
  entryIndex: number,
  direction: Direction,
  risk: number,
): { grossR: number; costR: number; netR: number } {
  const entry = candles[entryIndex].close;
  const stop = direction === "long" ? entry - risk : entry + risk;
  const target = direction === "long" ? entry + risk : entry - risk;
  const end = Math.min(candles.length - 1, entryIndex + OUTCOME_BARS);
  let grossR: number | null = null;
  let exitIndex = end;

  for (let i = entryIndex + 1; i <= end; i++) {
    const c = candles[i];
    const stopHit = direction === "long" ? c.low <= stop : c.high >= stop;
    const targetHit = direction === "long" ? c.high >= target : c.low <= target;
    if (stopHit) { // nếu cùng nến chạm cả hai: giả định bất lợi, SL trước
      grossR = -1;
      exitIndex = i;
      break;
    }
    if (targetHit) {
      grossR = 1;
      exitIndex = i;
      break;
    }
  }
  if (grossR == null) grossR = signedReturn(entry, candles[end].close, direction) * entry / risk;

  const riskFrac = risk / entry;
  const fundingPeriods = Math.max(
    0,
    Math.floor(candles[exitIndex].openTime / (8 * TF_MS["1h"])) -
      Math.floor(candles[entryIndex].openTime / (8 * TF_MS["1h"])),
  );
  const costR = riskFrac > 0 ? (ROUND_TRIP_FEE_SLIP + fundingPeriods * FUNDING_PER_8H) / riskFrac : 0;
  return { grossR, costR, netR: grossR - costR };
}

/** Stop rộng N ATR, không TP, thoát sau 24h; dùng để đo drift sau absorption. */
function simulateWideStopTime(
  candles: Candle[],
  entryIndex: number,
  direction: Direction,
  atrValue: number,
  stopAtr: number,
): number {
  const entry = candles[entryIndex].close;
  const risk = atrValue * stopAtr;
  const stop = direction === "long" ? entry - risk : entry + risk;
  const end = Math.min(candles.length - 1, entryIndex + OUTCOME_BARS);
  let exitIndex = end;
  let grossR: number | null = null;
  for (let i = entryIndex + 1; i <= end; i++) {
    const hit = direction === "long" ? candles[i].low <= stop : candles[i].high >= stop;
    if (hit) {
      grossR = -1;
      exitIndex = i;
      break;
    }
  }
  if (grossR == null) grossR = signedReturn(entry, candles[end].close, direction) * entry / risk;
  const riskFrac = risk / entry;
  const fundingPeriods = Math.max(
    0,
    Math.floor(candles[exitIndex].openTime / (8 * TF_MS["1h"])) -
      Math.floor(candles[entryIndex].openTime / (8 * TF_MS["1h"])),
  );
  const costR = riskFrac > 0 ? (ROUND_TRIP_FEE_SLIP + fundingPeriods * FUNDING_PER_8H) / riskFrac : 0;
  return grossR - costR;
}

function buildHtfAlignment(candles: Candle[]): Map<number, Direction | null> {
  const biasTf = aggregate(candles, CONFIG.htfBiasTf, "15m");
  const zoneTf = aggregate(candles, CONFIG.htfZoneTf, "15m");
  const biasSwings = findSwings(biasTf);
  const zoneSwings = findSwings(zoneTf);
  const out = new Map<number, Direction | null>();
  let cacheKey = "";
  let cached: ReturnType<typeof buildHtfContext> | null = null;
  for (const candle of candles) {
    const closeTime = candle.openTime + TF_MS["15m"];
    const biasCount = htfClosedCount(biasTf, closeTime);
    const zoneCount = htfClosedCount(zoneTf, closeTime);
    if (biasCount < 5 || zoneCount < CONFIG.volAvgPeriod) {
      out.set(candle.openTime, null);
      continue;
    }
    const key = `${biasCount}_${zoneCount}`;
    if (key !== cacheKey) {
      cached = buildHtfContext(biasTf, zoneTf, biasSwings, zoneSwings, biasCount - 1, zoneCount - 1);
      cacheKey = key;
    }
    const direction: Direction | null = cached!.bias === cached!.zoneBias
      ? cached!.bias === "bull" ? "long" : cached!.bias === "bear" ? "short" : null
      : null;
    out.set(candle.openTime, direction);
  }
  return out;
}

function analyzeSymbol(
  symbol: string,
  candles: Candle[],
  spec: Spec,
  htfByTime: Map<number, Direction | null>,
): Observation[] {
  const volumes = candles.map(quoteVolume);
  const volPrefix = prefix(volumes);
  const atrs = atr(candles);
  const observations: Observation[] = [];
  let lastEventEnd = -Infinity;

  for (let end = spec.lookback + spec.clusterBars - 1; end < candles.length - OUTCOME_BARS; end++) {
    const start = end - spec.clusterBars + 1;
    if (start <= lastEventEnd) continue; // không đếm chồng các cluster cùng cú spike
    const baselineStart = start - spec.lookback;
    const baselineMean = rangeSum(volPrefix, baselineStart, start) / spec.lookback;
    if (!(baselineMean > 0)) continue;
    const eventVolume = rangeSum(volPrefix, start, end + 1);
    const eventVolRatio = eventVolume / (baselineMean * spec.clusterBars);
    if (eventVolRatio < spec.threshold) continue;
    lastEventEnd = end;

    const first = candles[start];
    const last = candles[end];
    if (last.close === first.open || !(atrs[end] > 0)) continue;
    const direction: Direction = last.close > first.open ? "long" : "short";
    const eventHigh = Math.max(...candles.slice(start, end + 1).map((c) => c.high));
    const eventLow = Math.min(...candles.slice(start, end + 1).map((c) => c.low));
    const bodyHigh = Math.max(...candles.slice(start, end + 1).map((c) => Math.max(c.open, c.close)));
    const bodyLow = Math.min(...candles.slice(start, end + 1).map((c) => Math.min(c.open, c.close)));
    const zoneHigh = spec.zoneKind === "body" ? bodyHigh : eventHigh;
    const zoneLow = spec.zoneKind === "body" ? bodyLow : eventLow;
    const eventBodyRatio = (bodyHigh - bodyLow) / Math.max(eventHigh - eventLow, Number.EPSILON);
    const eventFlow = flowClass(aggregateBuyRatio(candles, start, end), direction);

    let departed = false;
    let retest = -1;
    const searchEnd = Math.min(candles.length - OUTCOME_BARS - 1, end + MAX_RETEST_BARS);
    for (let i = end + 1; i <= searchEnd; i++) {
      const c = candles[i];
      if (!departed) {
        departed = direction === "long"
          ? c.close >= zoneHigh + DEPART_ATR * atrs[end]
          : c.close <= zoneLow - DEPART_ATR * atrs[end];
        continue;
      }
      if (c.low <= zoneHigh && c.high >= zoneLow) {
        retest = i;
        break;
      }
    }
    if (retest < 0 || !(atrs[retest] > 0)) continue;

    const retestBaseline = rangeSum(volPrefix, retest - spec.lookback, retest) / spec.lookback;
    if (!(retestBaseline > 0)) continue;
    const retestVolRatio = volumes[retest] / retestBaseline;
    const retestFlow = flowClass(aggregateBuyRatio(candles, retest, retest), direction);
    const retestCandle = candles[retest];
    const retestRange = retestCandle.high - retestCandle.low;
    const retestBodyRatio = retestRange > 0 ? Math.abs(retestCandle.close - retestCandle.open) / retestRange : 0;
    const retestCloseStrength = retestRange > 0
      ? direction === "long"
        ? (retestCandle.close - retestCandle.low) / retestRange
        : (retestCandle.high - retestCandle.close) / retestRange
      : 0.5;
    const retestPriceAligned = direction === "long"
      ? retestCandle.close > retestCandle.open
      : retestCandle.close < retestCandle.open;
    const lowerWick = Math.min(retestCandle.open, retestCandle.close) - retestCandle.low;
    const upperWick = retestCandle.high - Math.max(retestCandle.open, retestCandle.close);
    const retestRejectionWick = direction === "long" ? lowerWick > upperWick : upperWick > lowerWick;
    const entry = candles[retest].close;
    const result = simulateOneAtr(candles, retest, direction, atrs[retest]);
    observations.push({
      symbol,
      eventIndex: end,
      retestIndex: retest,
      eventTime: candles[end].openTime,
      retestTime: candles[retest].openTime,
      direction,
      zoneLow,
      zoneHigh,
      eventVolRatio,
      retestVolRatio,
      eventFlow,
      retestFlow,
      eventBodyRatio,
      retestBodyRatio,
      retestCloseStrength,
      retestPriceAligned,
      retestRejectionWick,
      htfAligned: htfByTime.get(candles[retest].openTime) === direction,
      delayBars: retest - end,
      smallerRepeat: retestVolRatio >= RETEST_SPIKE && retestVolRatio < eventVolRatio,
      ret1h: signedReturn(entry, candles[retest + 4].close, direction),
      ret4h: signedReturn(entry, candles[retest + 16].close, direction),
      ret12h: signedReturn(entry, candles[retest + 48].close, direction),
      ret24h: signedReturn(entry, candles[retest + 96].close, direction),
      ...result,
      netR2Atr24h: simulateWideStopTime(candles, retest, direction, atrs[retest], 2),
      netR3Atr24h: simulateWideStopTime(candles, retest, direction, atrs[retest], 3),
    });
  }
  return observations;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
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

/** Block bootstrap theo tuần; các coin cùng tuần nằm chung block để giữ tương quan chéo. */
function weeklyBootstrap(
  obs: Observation[],
  samples = 4000,
  valueOf: (o: Observation) => number = (o) => o.netR,
): { lo: number; hi: number; pPositive: number } {
  if (!obs.length) return { lo: 0, hi: 0, pPositive: 0 };
  const weekMs = 7 * TF_MS["1d"];
  const groups = new Map<number, number[]>();
  for (const o of obs) {
    const week = Math.floor(o.retestTime / weekMs);
    const values = groups.get(week) ?? [];
    values.push(valueOf(o));
    groups.set(week, values);
  }
  const blocks = [...groups.values()];
  const rng = mulberry32(0x15e7e57);
  const means: number[] = [];
  let positive = 0;
  for (let s = 0; s < samples; s++) {
    let total = 0;
    let n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      total += block.reduce((sum, value) => sum + value, 0);
      n += block.length;
    }
    const value = n ? total / n : 0;
    means.push(value);
    if (value > 0) positive++;
  }
  means.sort((a, b) => a - b);
  return { lo: quantile(means, 0.05), hi: quantile(means, 0.95), pPositive: positive / samples };
}

function metricRow(label: string, obs: Observation[]): string {
  const ci4 = weeklyBootstrap(obs, 4000, (o) => o.ret4h);
  const ci24 = weeklyBootstrap(obs, 4000, (o) => o.ret24h);
  return `${label.padEnd(31)} ${String(obs.length).padStart(6)} ${(100 * mean(obs.map((o) => o.ret4h))).toFixed(3).padStart(8)}% ${(`[${(100 * ci4.lo).toFixed(3)},${(100 * ci4.hi).toFixed(3)}]`).padStart(19)} ${(100 * mean(obs.map((o) => o.ret24h))).toFixed(3).padStart(8)}% ${(`[${(100 * ci24.lo).toFixed(3)},${(100 * ci24.hi).toFixed(3)}]`).padStart(19)}`;
}

function wideStopRow(label: string, obs: Observation[]): string {
  const ci2 = weeklyBootstrap(obs, 4000, (o) => o.netR2Atr24h);
  const ci3 = weeklyBootstrap(obs, 4000, (o) => o.netR3Atr24h);
  return `${label.padEnd(31)} ${String(obs.length).padStart(6)} ${mean(obs.map((o) => o.netR2Atr24h)).toFixed(3).padStart(8)} ${(`[${ci2.lo.toFixed(3)},${ci2.hi.toFixed(3)}]`).padStart(17)} ${mean(obs.map((o) => o.netR3Atr24h)).toFixed(3).padStart(8)} ${(`[${ci3.lo.toFixed(3)},${ci3.hi.toFixed(3)}]`).padStart(17)}`;
}

function row(label: string, obs: Observation[]): string {
  const ci = weeklyBootstrap(obs);
  const winRate = obs.length ? obs.filter((o) => o.netR > 0).length / obs.length : 0;
  const pct = (key: "ret1h" | "ret4h" | "ret12h" | "ret24h") => 100 * mean(obs.map((o) => o[key]));
  return `${label.padEnd(31)} ${String(obs.length).padStart(6)} ${(100 * winRate).toFixed(1).padStart(6)}% ${mean(obs.map((o) => o.netR)).toFixed(3).padStart(8)} ${(`[${ci.lo.toFixed(3)},${ci.hi.toFixed(3)}]`).padStart(17)} ${(100 * ci.pPositive).toFixed(1).padStart(6)}% ${pct("ret1h").toFixed(3).padStart(8)}% ${pct("ret4h").toFixed(3).padStart(8)}% ${pct("ret24h").toFixed(3).padStart(8)}%`;
}

function printCohorts(title: string, cohorts: Array<[string, Observation[]]>): void {
  console.log(`\n${title}`);
  console.log(`${"Cohort".padEnd(31)} ${"N".padStart(6)} ${"WR1R".padStart(7)} ${"expNET".padStart(8)} ${"CI90 expNET".padStart(17)} ${"P+".padStart(7)} ${"ret1h".padStart(9)} ${"ret4h".padStart(9)} ${"ret24h".padStart(9)}`);
  for (const [label, obs] of cohorts) console.log(row(label, obs));
}

function tradeRow(label: string, trades: Trade[]): string {
  const net = trades.reduce((sum, trade) => sum + trade.netR, 0);
  const exp = trades.length ? net / trades.length : 0;
  const wr = trades.length ? trades.filter((trade) => trade.netR > 0).length / trades.length : 0;
  return `${label.padEnd(32)} ${String(trades.length).padStart(5)} ${(100 * wr).toFixed(0).padStart(5)}% ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(8)}R ${exp.toFixed(3).padStart(8)}`;
}

function printBaselineConfluence(data: Map<string, Candle[]>, primary: Observation[]): void {
  const trades = [...data].flatMap(([symbol, candles]) => runBacktest(symbol, candles));
  const maxGap = 24 * TF_MS["15m"];
  const tagged = trades.map((trade) => {
    const matches = primary.filter((o) =>
      o.symbol === trade.symbol &&
      o.direction === trade.dir &&
      o.retestTime <= trade.entryTime &&
      trade.entryTime - o.retestTime <= maxGap,
    );
    return { trade, observation: matches.sort((a, b) => b.retestTime - a.retestTime)[0] };
  });
  const select = (predicate: (o: Observation) => boolean): Trade[] => tagged
    .filter((item) => item.observation && predicate(item.observation))
    .map((item) => item.trade);
  const exact = tagged.filter((item) => item.observation?.retestTime === item.trade.entryTime).map((item) => item.trade);
  const within4 = tagged.filter((item) => item.observation && item.trade.entryTime - item.observation.retestTime <= 4 * TF_MS["15m"]).map((item) => item.trade);
  const any = tagged.filter((item) => item.observation).map((item) => item.trade);
  const none = tagged.filter((item) => !item.observation).map((item) => item.trade);

  console.log("\nPRIMARY AS CONFLUENCE — loc tren entry SMC 4h/1h/15m hien tai");
  console.log(`${"Cohort".padEnd(32)} ${"N".padStart(5)} ${"WR".padStart(6)} ${"NET".padStart(10)} ${"exp".padStart(8)}`);
  console.log(tradeRow("tat ca baseline", trades));
  console.log(tradeRow("retest cung nen entry", exact));
  console.log(tradeRow("retest trong 4 bars truoc", within4));
  console.log(tradeRow("retest trong 24 bars truoc", any));
  console.log(tradeRow("khong co retest 24 bars", none));
  console.log(tradeRow("24b + retest vol>=1.3", select((o) => o.retestVolRatio >= 1.3)));
  console.log(tradeRow("24b + smaller repeat", select((o) => o.smallerRepeat)));
  console.log(tradeRow("24b + close bao ve", select((o) => o.retestVolRatio >= 1.3 && o.retestCloseStrength >= 0.55)));
  console.log(tradeRow("24b + absorption", select((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)));
  console.log(tradeRow("24b + effort/no-result", select((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5)));
}

type ConfirmKind = "immediate" | "reclaim" | "bos" | "bos-after" | "hour-reclaim";

interface ConfirmedTrade {
  symbol: string;
  direction: Direction;
  entryTime: number;
  exitTime: number;
  grossR: number;
  costR: number;
  netR: number;
}

interface ConfirmVariant {
  name: string;
  kind: ConfirmKind;
  maxBars: number;
  filter: (o: Observation) => boolean;
}

function findConfirmation(candles: Candle[], o: Observation, kind: ConfirmKind, maxBars: number): number | null {
  if (kind === "immediate") return o.retestIndex;
  const end = Math.min(candles.length - OUTCOME_BARS - 1, o.retestIndex + maxBars);
  const reclaim = o.direction === "long" ? candles[o.retestIndex].high : candles[o.retestIndex].low;
  for (let i = o.retestIndex + 1; i <= end; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (kind === "reclaim" || kind === "hour-reclaim") {
      if (kind === "hour-reclaim" && (c.openTime + TF_MS["15m"]) % TF_MS["1h"] !== 0) continue;
      const crossed = o.direction === "long"
        ? prev.close <= reclaim && c.close > reclaim
        : prev.close >= reclaim && c.close < reclaim;
      if (crossed) return i;
      continue;
    }
    const swingType = o.direction === "long" ? "high" : "low";
    const minPivot = kind === "bos-after" ? o.retestIndex : 0;
    const swing = lastConfirmedSwing(candles, i, swingType, 3, 3, 40, minPivot);
    if (!swing) continue;
    const crossed = o.direction === "long"
      ? prev.close <= swing.price && c.close > swing.price
      : prev.close >= swing.price && c.close < swing.price;
    if (crossed) return i;
  }
  return null;
}

function simulateConfirmedTrade(
  symbol: string,
  candles: Candle[],
  atrs: number[],
  o: Observation,
  entryIndex: number,
): { trade: ConfirmedTrade; exitIndex: number } | null {
  const entry = candles[entryIndex].close;
  const slice = candles.slice(o.retestIndex, entryIndex + 1);
  const protectedExtreme = o.direction === "long"
    ? Math.min(o.zoneLow, ...slice.map((c) => c.low))
    : Math.max(o.zoneHigh, ...slice.map((c) => c.high));
  const stop = o.direction === "long"
    ? protectedExtreme - 0.25 * atrs[entryIndex]
    : protectedExtreme + 0.25 * atrs[entryIndex];
  const risk = Math.abs(entry - stop);
  const riskFrac = risk / entry;
  if (!(risk > 0) || riskFrac > CONFIG.maxStopPct) return null;
  const target = o.direction === "long" ? entry + 2.5 * risk : entry - 2.5 * risk;
  const end = Math.min(candles.length - 1, entryIndex + OUTCOME_BARS);
  let exitIndex = end;
  let grossR: number | null = null;
  for (let i = entryIndex + 1; i <= end; i++) {
    const c = candles[i];
    const stopHit = o.direction === "long" ? c.low <= stop : c.high >= stop;
    const targetHit = o.direction === "long" ? c.high >= target : c.low <= target;
    if (stopHit) {
      grossR = -1;
      exitIndex = i;
      break;
    }
    if (targetHit) {
      grossR = 2.5;
      exitIndex = i;
      break;
    }
  }
  if (grossR == null) grossR = signedReturn(entry, candles[end].close, o.direction) * entry / risk;
  const fundingPeriods = Math.max(
    0,
    Math.floor(candles[exitIndex].openTime / (8 * TF_MS["1h"])) -
      Math.floor(candles[entryIndex].openTime / (8 * TF_MS["1h"])),
  );
  const costR = (ROUND_TRIP_FEE_SLIP + fundingPeriods * FUNDING_PER_8H) / riskFrac;
  return {
    exitIndex,
    trade: {
      symbol,
      direction: o.direction,
      entryTime: candles[entryIndex].openTime,
      exitTime: candles[exitIndex].openTime,
      grossR,
      costR,
      netR: grossR - costR,
    },
  };
}

function runConfirmedVariant(
  data: Map<string, Candle[]>,
  primary: Observation[],
  variant: ConfirmVariant,
): ConfirmedTrade[] {
  const trades: ConfirmedTrade[] = [];
  for (const [symbol, candles] of data) {
    const atrs = atr(candles);
    const candidates = primary
      .filter((o) => o.symbol === symbol && variant.filter(o))
      .sort((a, b) => a.retestIndex - b.retestIndex);
    let blockedUntil = -1;
    for (const o of candidates) {
      const entryIndex = findConfirmation(candles, o, variant.kind, variant.maxBars);
      if (entryIndex == null || entryIndex <= blockedUntil) continue;
      const result = simulateConfirmedTrade(symbol, candles, atrs, o, entryIndex);
      if (!result) continue;
      trades.push(result.trade);
      blockedUntil = result.exitIndex + CONFIG.cooldownBars;
    }
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

function confirmedBootstrap(trades: ConfirmedTrade[], samples = 4000): { lo: number; hi: number; pPositive: number } {
  if (!trades.length) return { lo: 0, hi: 0, pPositive: 0 };
  const weekMs = 7 * TF_MS["1d"];
  const groups = new Map<number, number[]>();
  for (const trade of trades) {
    const week = Math.floor(trade.entryTime / weekMs);
    const values = groups.get(week) ?? [];
    values.push(trade.netR);
    groups.set(week, values);
  }
  const blocks = [...groups.values()];
  const rng = mulberry32(0xc0f1a7);
  const means: number[] = [];
  let positive = 0;
  for (let s = 0; s < samples; s++) {
    let total = 0;
    let n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      total += block.reduce((sum, value) => sum + value, 0);
      n += block.length;
    }
    const value = n ? total / n : 0;
    means.push(value);
    if (value > 0) positive++;
  }
  means.sort((a, b) => a - b);
  return { lo: quantile(means, 0.05), hi: quantile(means, 0.95), pPositive: positive / samples };
}

function printConfirmedEntries(data: Map<string, Candle[]>, primary: Observation[]): void {
  const absorption = (o: Observation) =>
    o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55;
  const htfAbsorption = (o: Observation) => o.htfAligned && absorption(o);
  const htfEffort = (o: Observation) =>
    htfAbsorption(o) && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5;
  const variants: ConfirmVariant[] = [
    { name: "absorb immediate", kind: "immediate", maxBars: 0, filter: absorption },
    { name: "absorb reclaim <=8b", kind: "reclaim", maxBars: 8, filter: absorption },
    { name: "absorb BOS <=16b", kind: "bos", maxBars: 16, filter: absorption },
    { name: "HTF absorb reclaim <=16b", kind: "reclaim", maxBars: 16, filter: htfAbsorption },
    { name: "HTF absorb BOS <=16b", kind: "bos", maxBars: 16, filter: htfAbsorption },
    { name: "HTF absorb BOS-after <=16b", kind: "bos-after", maxBars: 16, filter: htfAbsorption },
    { name: "HTF absorb 1h reclaim", kind: "hour-reclaim", maxBars: 16, filter: htfAbsorption },
    { name: "HTF effort BOS <=16b", kind: "bos", maxBars: 16, filter: htfEffort },
  ];

  const allResults = variants.map((variant) => ({ variant, trades: runConfirmedVariant(data, primary, variant) }));
  const minTime = Math.min(...allResults.flatMap((r) => r.trades.map((t) => t.entryTime)));
  const maxTime = Math.max(...allResults.flatMap((r) => r.trades.map((t) => t.entryTime)));
  const eraSpan = (maxTime - minTime + 1) / 3;
  console.log("\nCONFIRMED ENTRY — absorption ARM -> reclaim/BOS -> TP2.5R, zone stop, time 24h");
  console.log(`${"Variant".padEnd(30)} ${"N".padStart(5)} ${"WR".padStart(6)} ${"NET".padStart(9)} ${"exp".padStart(8)} ${"CI90 exp".padStart(17)} ${"P+".padStart(7)} ${"EraA".padStart(8)} ${"EraB".padStart(8)} ${"EraC".padStart(8)} ${"sym+".padStart(5)}`);
  for (const result of allResults) {
    const trades = result.trades;
    const net = trades.reduce((sum, trade) => sum + trade.netR, 0);
    const exp = trades.length ? net / trades.length : 0;
    const wr = trades.length ? trades.filter((trade) => trade.netR > 0).length / trades.length : 0;
    const ci = confirmedBootstrap(trades);
    const eras = [0, 1, 2].map((era) => {
      const lo = minTime + era * eraSpan;
      const hi = era === 2 ? maxTime + 1 : minTime + (era + 1) * eraSpan;
      return trades.filter((trade) => trade.entryTime >= lo && trade.entryTime < hi).reduce((sum, trade) => sum + trade.netR, 0);
    });
    const positiveSymbols = [...data.keys()].filter((symbol) =>
      trades.filter((trade) => trade.symbol === symbol).reduce((sum, trade) => sum + trade.netR, 0) > 0,
    ).length;
    console.log(`${result.variant.name.padEnd(30)} ${String(trades.length).padStart(5)} ${(100 * wr).toFixed(0).padStart(5)}% ${(net >= 0 ? "+" : "") + net.toFixed(1).padStart(8)} ${exp.toFixed(3).padStart(8)} ${(`[${ci.lo.toFixed(3)},${ci.hi.toFixed(3)}]`).padStart(17)} ${(100 * ci.pPositive).toFixed(1).padStart(6)}% ${eras.map((value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`.padStart(8)).join(" ")} ${String(positiveSymbols).padStart(4)}/4`);
  }
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "1200", 10);
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS["15m"]) + 400;
  console.log(`Nap ${days} ngay x ${symbols.length} symbols (${bars} nen 15m/symbol)...`);
  const pairs = await Promise.all(symbols.map(async (s) => [s, await fetchKlinesPaged(s, "15m", bars)] as const));
  const data = new Map(pairs.filter(([, candles]) => candles.length >= 1000));
  const htfBySymbol = new Map([...data].map(([symbol, candles]) => [symbol, buildHtfAlignment(candles)]));

  const bySpec = new Map<string, Observation[]>();
  for (const spec of SPECS) {
    const obs = [...data].flatMap(([symbol, candles]) => analyzeSymbol(symbol, candles, spec, htfBySymbol.get(symbol)!));
    bySpec.set(spec.name, obs);
  }

  console.log("\n" + "=".repeat(132));
  console.log("EXTREME-VOLUME 15M -> DEPART -> FIRST RETEST | entry sau close retest | TP/SL = 1 ATR | da tru chi phi");
  console.log("=".repeat(132));
  console.log(`${"Spec".padEnd(31)} ${"N".padStart(6)} ${"WR1R".padStart(7)} ${"expNET".padStart(8)} ${"CI90 expNET".padStart(17)} ${"P+".padStart(7)} ${"ret1h".padStart(9)} ${"ret4h".padStart(9)} ${"ret24h".padStart(9)}`);
  for (const spec of SPECS) console.log(row(spec.name, bySpec.get(spec.name)!));

  const primary = bySpec.get("single L192 2.0x body")!;
  printCohorts("PRIMARY — tach dau hieu tai event/retest", [
    ["tat ca retest", primary],
    ["event delta aligned", primary.filter((o) => o.eventFlow === "aligned")],
    ["event delta opposite/absorb", primary.filter((o) => o.eventFlow === "opposite")],
    ["event delta neutral", primary.filter((o) => o.eventFlow === "neutral")],
    ["event body <=0.35 range", primary.filter((o) => o.eventBodyRatio <= 0.35)],
    ["event body >0.50 range", primary.filter((o) => o.eventBodyRatio > 0.5)],
    ["retest vol <1.0x", primary.filter((o) => o.retestVolRatio < 1)],
    ["retest vol 1.0-1.3x", primary.filter((o) => o.retestVolRatio >= 1 && o.retestVolRatio < 1.3)],
    ["retest vol 1.3-2.0x", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestVolRatio < 2)],
    ["retest vol >=2.0x", primary.filter((o) => o.retestVolRatio >= 2)],
    ["retest >=1.3 + delta align", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "aligned")],
    ["retest >=1.3 + delta oppose", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite")],
    ["retest >=1.3 + close bao ve", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestCloseStrength >= 0.55)],
    ["retest >=1.3 + close pha vung", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestCloseStrength < 0.45)],
    ["initiative defense", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "aligned" && o.retestPriceAligned)],
    ["absorption defense", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
    ["absorb + rejection wick", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55 && o.retestRejectionWick)],
    ["effort/no-result body<=.35", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5)],
    ["repeat spike nho hon event", primary.filter((o) => o.smallerRepeat)],
    ["repeat nho + delta align", primary.filter((o) => o.smallerRepeat && o.retestFlow === "aligned")],
    ["repeat nho + absorption", primary.filter((o) => o.smallerRepeat && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
    ["HTF 4h/1h aligned", primary.filter((o) => o.htfAligned)],
    ["HTF + retest vol>=1.3", primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3)],
    ["HTF + absorption", primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
    ["HTF + effort/no-result", primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5)],
  ]);

  console.log("\nPRIMARY — CI90 block-bootstrap cho phan ung gia");
  console.log(`${"Cohort".padEnd(31)} ${"N".padStart(6)} ${"ret4h".padStart(9)} ${"CI90 ret4h".padStart(19)} ${"ret24h".padStart(9)} ${"CI90 ret24h".padStart(19)}`);
  const reactionCohorts: Array<[string, Observation[]]> = [
    ["tat ca retest", primary],
    ["retest vol 1.3-2.0x", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestVolRatio < 2)],
    ["retest vol >=2.0x", primary.filter((o) => o.retestVolRatio >= 2)],
    ["absorption defense", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
    ["effort/no-result body<=.35", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5)],
    ["repeat spike nho hon event", primary.filter((o) => o.smallerRepeat)],
    ["repeat nho + delta align", primary.filter((o) => o.smallerRepeat && o.retestFlow === "aligned")],
    ["HTF + retest vol>=1.3", primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3)],
    ["HTF + absorption", primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
  ];
  for (const [label, obs] of reactionCohorts) console.log(metricRow(label, obs));

  const htfAbsorption = primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55);
  const htfEffort = primary.filter((o) => o.htfAligned && o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestBodyRatio <= 0.35 && o.retestCloseStrength >= 0.5);
  console.log("\nPRIMARY — stop rong + time-exit 24h (NET R sau chi phi)");
  console.log(`${"Cohort".padEnd(31)} ${"N".padStart(6)} ${"stop2ATR".padStart(8)} ${"CI90".padStart(17)} ${"stop3ATR".padStart(8)} ${"CI90".padStart(17)}`);
  const wideCohorts: Array<[string, Observation[]]> = [
    ["tat ca retest", primary],
    ["absorption defense", primary.filter((o) => o.retestVolRatio >= 1.3 && o.retestFlow === "opposite" && o.retestCloseStrength >= 0.55)],
    ["HTF + absorption", htfAbsorption],
    ["HTF + effort/no-result", htfEffort],
  ];
  for (const [label, obs] of wideCohorts) console.log(wideStopRow(label, obs));

  const htfAbsMin = Math.min(...htfAbsorption.map((o) => o.retestTime));
  const htfAbsMax = Math.max(...htfAbsorption.map((o) => o.retestTime));
  const htfAbsSpan = (htfAbsMax - htfAbsMin + 1) / 3;
  console.log("\nHTF + absorption — stop2ATR theo era/symbol");
  const htfAbsCuts: Array<[string, Observation[]]> = [
    ...[0, 1, 2].map((era): [string, Observation[]] => {
      const lo = htfAbsMin + era * htfAbsSpan;
      const hi = era === 2 ? htfAbsMax + 1 : htfAbsMin + (era + 1) * htfAbsSpan;
      return [`Era ${String.fromCharCode(65 + era)}`, htfAbsorption.filter((o) => o.retestTime >= lo && o.retestTime < hi)];
    }),
    ...[...data.keys()].map((symbol): [string, Observation[]] => [symbol.toUpperCase(), htfAbsorption.filter((o) => o.symbol === symbol)]),
  ];
  for (const [label, obs] of htfAbsCuts) console.log(wideStopRow(label, obs));

  const minTime = Math.min(...primary.map((o) => o.retestTime));
  const maxTime = Math.max(...primary.map((o) => o.retestTime));
  const eraSpan = (maxTime - minTime + 1) / 3;
  printCohorts("PRIMARY — do ben theo thoi gian", [0, 1, 2].map((era) => {
    const lo = minTime + era * eraSpan;
    const hi = era === 2 ? maxTime + 1 : minTime + (era + 1) * eraSpan;
    return [`Era ${String.fromCharCode(65 + era)}`, primary.filter((o) => o.retestTime >= lo && o.retestTime < hi)];
  }));
  printCohorts("PRIMARY — do ben theo symbol", [...data.keys()].map((symbol) => [
    symbol.toUpperCase(),
    primary.filter((o) => o.symbol === symbol),
  ]));

  printBaselineConfluence(data, primary);
  printConfirmedEntries(data, primary);

  console.log(`\nMedian delay event->retest: ${quantile(primary.map((o) => o.delayBars).sort((a, b) => a - b), 0.5).toFixed(0)} nen 15m`);
  console.log("Luu y: day la event-study OHLCV. Chua duoc xem la strategy live cho toi khi cohort qua gate era/symbol va backtest portfolio khong chong lenh.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
