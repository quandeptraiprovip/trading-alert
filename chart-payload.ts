import { CONFIG, TF_MS } from "./strategy";
import { fetchKlinesPaged, runBacktest } from "./backtest";

export type ChartTrade = {
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: string;
  netR: number;
  zoneDesc: string;
};

export async function buildChartPayload(days: number, symbol = "btcusdt"): Promise<object> {
  const sym = symbol.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(sym)) {
    throw new Error("Symbol không hợp lệ");
  }
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400;
  const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
  const trades = runBacktest(sym, ltf);

  const displayStart =
    ltf.length > 0 ? ltf[Math.max(0, ltf.length - Math.ceil(days * barsPerDay))].openTime : 0;
  const candles = ltf
    .filter((c) => c.openTime >= displayStart)
    .map((c) => ({
      t: c.openTime,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume,
      q: c.quoteVolume ?? c.volume * c.close,
      tb: c.takerBuyVolume,
    }));

  const chartTrades: ChartTrade[] = trades
    .filter((t) => t.entryTime >= displayStart)
    .map((t) => ({
      dir: t.dir,
      entryTime: t.entryTime,
      entryPrice: t.entryPrice,
      initialSL: t.initialSL,
      exitTime: t.exitTime,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason,
      netR: t.netR,
      zoneDesc: t.zoneDesc,
    }));

  return {
    symbol: sym.toUpperCase(),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: chartTrades.length,
    candles,
    trades: chartTrades,
  };
}
