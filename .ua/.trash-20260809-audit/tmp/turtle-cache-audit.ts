import fs from "fs";
import path from "path";
import { Candle } from "../../strategy";
import { T, buildBtcGateLongs } from "../../turtle";
import { portfolioStats, riskMetrics, runTurtlePortfolio } from "../../scripts/portfolio-engine";

const DAY = 86_400_000;
const symbols = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const data = new Map<string, Candle[]>();
for (const symbol of symbols) {
  data.set(symbol, JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "klines", `${symbol}_4h.json`), "utf8")));
}
const commonEnd = Math.min(...[...data.values()].map((c) => c[c.length - 1].openTime));
const from = commonEnd - 1050 * DAY;
for (const [symbol, candles] of data) data.set(symbol, candles.filter((c) => c.openTime <= commonEnd));
const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
const result = runTurtlePortfolio(data, { ...T, gate }, (ctx) => T.heatDecayK > 0 ? 1 / (1 + ctx.sameDirHeat / T.heatDecayK) : 1);
const trades = result.trades.filter((t) => t.entryTime >= from && t.entryTime <= commonEnd);

type Position = { exitTime: number; netR: number; weightedR: number };
const positions = new Map<string, Position>();
for (const t of trades) {
  const key = `${t.book}#${t.positionId}`;
  const p = positions.get(key) ?? { exitTime: t.exitTime, netR: 0, weightedR: 0 };
  p.exitTime = Math.max(p.exitTime, t.exitTime);
  p.netR += t.netR;
  p.weightedR += t.netR * t.weight;
  positions.set(key, p);
}
const ps = [...positions.values()].sort((a, b) => a.exitTime - b.exitTime);

function streak(items: Position[]) {
  let n = 0, r = 0, start = 0;
  let bestN = 0, bestR = 0, bestStart = 0, bestEnd = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].netR <= 0) {
      if (n === 0) start = items[i].exitTime;
      n++; r += items[i].netR;
      if (n > bestN) { bestN = n; bestR = r; bestStart = start; bestEnd = items[i].exitTime; }
    } else { n = 0; r = 0; }
  }
  return { n: bestN, netR: bestR, start: new Date(bestStart).toISOString(), end: new Date(bestEnd).toISOString() };
}

function stats(start: number, end: number) {
  const xs = trades.filter((t) => t.entryTime >= start && t.entryTime < end);
  const pkeys = new Set(xs.map((t) => `${t.book}#${t.positionId}`));
  return {
    units: xs.length,
    positions: pkeys.size,
    rawNetR: xs.reduce((s, t) => s + t.netR, 0),
    weightedNetR: xs.reduce((s, t) => s + t.netR * t.weight, 0),
  };
}

const span = commonEnd - from;
console.log(JSON.stringify({
  commonEnd: new Date(commonEnd).toISOString(),
  all: stats(from, commonEnd + 1),
  portfolio: portfolioStats(result, { from, to: commonEnd }),
  risk: riskMetrics(result.equity.filter((e) => e.time >= from && e.time <= commonEnd)),
  recent365: stats(commonEnd - 365 * DAY, commonEnd + 1),
  eras: [0, 1, 2].map((i) => stats(from + span * i / 3, from + span * (i + 1) / 3)),
  maxConsecutiveLosingPositions: streak(ps),
}, null, 2));
