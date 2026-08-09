import fs from "fs";
import path from "path";
import { runBacktest, Trade } from "../../backtest";
import { Candle } from "../../strategy";

const DAY = 86_400_000;
const groups: Record<string, string[]> = {
  selected: ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"],
  oos: ["ethusdt", "adausdt", "avaxusdt", "dotusdt"],
};

function read(symbol: string): Candle[] {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), ".cache", "klines", `${symbol}_15m.json`), "utf8"));
}

function longestLossStreak(trades: Trade[]): number {
  let cur = 0, max = 0;
  for (const t of trades.sort((a, b) => a.entryTime - b.entryTime)) {
    cur = t.netR <= 0 ? cur + 1 : 0;
    max = Math.max(max, cur);
  }
  return max;
}

for (const [name, symbols] of Object.entries(groups)) {
  const all = new Map(symbols.map((s) => [s, read(s)]));
  const commonEnd = Math.min(...[...all.values()].map((c) => c[c.length - 1].openTime));
  for (const days of [250, 500, 1200]) {
    const trades: Trade[] = [];
    const perSymbol: Record<string, { n: number; netR: number }> = {};
    for (const symbol of symbols) {
      const candles = all.get(symbol)!.filter((c) => c.openTime >= commonEnd - days * DAY && c.openTime <= commonEnd);
      const ts = runBacktest(symbol, candles);
      trades.push(...ts);
      perSymbol[symbol] = { n: ts.length, netR: ts.reduce((s, t) => s + t.netR, 0) };
    }
    const netR = trades.reduce((s, t) => s + t.netR, 0);
    console.log(JSON.stringify({
      group: name,
      days,
      commonEnd: new Date(commonEnd).toISOString(),
      trades: trades.length,
      winRate: trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0,
      netR,
      expectancy: trades.length ? netR / trades.length : 0,
      maxLossStreak: longestLossStreak(trades),
      perSymbol,
    }));
  }
}
