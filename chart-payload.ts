/**
 * chart-payload.ts — Chuẩn bị dữ liệu biểu đồ cho bot chart:
 * nến M15, lớp Key Volume và playbook.
 */

import { Candle, CONFIG, TF_MS } from "./types";
import { fetchKlinesPaged } from "./kline-fetch";
import { fetchOandaGoldM15 } from "./oanda-fetch";
import { dropsWeekendBars, goldClosedNy } from "./market-hours";
import { EvidenceGeometry, EvidenceItem, buildKeyVolumeView } from "./chart-keyvolume";

/** Cửa sổ Key Volume (ngày). Detector M15 sinh ~12 key/ngày. */
const KEY_VOLUME_CHART_DAYS = 45;

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

export type StrategyAuditTrade = {
  id: string;
  strategy: "turtle" | "fast";
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unit: number;
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  exitReasonLabel: string;
  status: "open" | "closed";
  resultR: number;
  entryReason: string;
  evidence: EvidenceItem[];
};

function chartUniverse() {
  return [
    { symbol: "BTCUSDT", venue: "BINANCE", strategies: [] },
    { symbol: "XAUUSDT", venue: "BINANCE", strategies: [] },
    { symbol: "XAUUSD", venue: "OANDA", strategies: [] },
  ];
}

async function buildOandaGoldChartPayload(days: number): Promise<object> {
  const displayStart = Date.now() - days * TF_MS["1d"];
  const source = await fetchOandaGoldM15(days);
  const candles = source
    .filter((candle) => candle.openTime >= displayStart)
    .map((candle) => ({
      t: candle.openTime,
      o: candle.open,
      h: candle.high,
      l: candle.low,
      c: candle.close,
      v: candle.volume,
      q: candle.volume,
    }));
  return {
    symbol: "XAUUSD",
    venue: "OANDA",
    sourceLabel: "OANDA v20 · XAU_USD · M15",
    instrumentType: "CFD",
    volumeType: "tick",
    volumeUnit: "ticks",
    botUniverse: chartUniverse(),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: 0,
    candles,
    trades: [],
    strategyAudit: {
      timeframe: "4h",
      generatedAt: Date.now(),
      methods: [],
      turtleConfig: "Nhánh này chỉ chạy FX Dream và Bot Chart.",
      fastConfig: "Các phương pháp khác đã chuyển sang nhánh strategy-all-methods.",
      trades: [],
    },
    keyVolume: null,
  };
}

export async function buildChartPayload(days: number, symbol = "btcusdt"): Promise<object> {
  const sym = symbol.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(sym)) {
    throw new Error("Symbol không hợp lệ");
  }
  if (sym === "xauusd") return buildOandaGoldChartPayload(days);

  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400;

  // Key Volume chạy trọn trên M15.
  const keyVolumeDays = Math.min(days, KEY_VOLUME_CHART_DAYS);
  const keyVolumeBars = Math.ceil(keyVolumeDays * (TF_MS["1d"] / TF_MS["15m"])) + 400;

  const rawLtf = await fetchKlinesPaged(sym, CONFIG.entryTf, Math.max(totalBars, keyVolumeBars));

  // Vàng: bỏ nến lúc thị trường thật đóng cửa cuối tuần — cả phần vẽ lẫn engine Key Volume.
  const dropWeekend = dropsWeekendBars(sym);
  const ltf = dropWeekend ? rawLtf.filter((c) => !goldClosedNy(c.openTime)) : rawLtf;

  const now = Date.now();
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

  const keyVolumeStart = Math.max(displayStart, now - keyVolumeDays * TF_MS["1d"]);
  const keyVolumeM15 = ltf.filter((candle) => candle.openTime + TF_MS["15m"] <= now);
  const keyVolume = buildKeyVolumeView(sym, keyVolumeM15, keyVolumeStart);

  return {
    symbol: sym.toUpperCase(),
    venue: "BINANCE",
    sourceLabel: "Binance Futures · 15m",
    instrumentType: "PERP",
    volumeType: "quote",
    volumeUnit: "USDT",
    botUniverse: chartUniverse(),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: 0,
    candles,
    trades: [],
    strategyAudit: {
      timeframe: "4h",
      generatedAt: Date.now(),
      methods: [],
      turtleConfig: "Nhánh này chỉ chạy FX Dream và Bot Chart.",
      fastConfig: "Các phương pháp khác đã chuyển sang nhánh strategy-all-methods.",
      trades: [],
    },
    keyVolume,
  };
}
