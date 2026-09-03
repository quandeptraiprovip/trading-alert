import { Candle, CONFIG, TF_MS } from "./strategy";
import { fetchKlinesPaged, runBacktest } from "./backtest";
import {
  T,
  atrSeries,
  buildBtcGateLongs,
  ema,
  priorDonchian,
  turtleConfigLine,
  turtleInitialStop,
} from "./turtle";
import {
  FAST_LONG_EXIT_DAYS,
  FAST_MAX_UNITS,
  FAST_MEXC_TAKER_FEE_PCT,
  FAST_SHORT_CONFIRM_BARS,
  FAST_SHORT_ENTRY_DAYS,
  fastConfigLine,
  parseFastTrendEntryDays,
  priorFastShortCloseLow,
} from "./fast-trend-config";
import { ExtParams, OpenUnit, UnitTrade, runBooks } from "./scripts/portfolio-engine";
import { getBotUniverse } from "./bot-universe";
import { fetchOandaGoldM15 } from "./oanda-fetch";
import { EvidenceItem, buildKeyVolumeView } from "./chart-keyvolume";

/** Cửa sổ Key Volume (ngày). Ngắn hơn chart vì detector M15 sinh ~12 key/ngày. */
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
  chartContext: StrategyChartContext | null;
};

export type StrategyChartContext = {
  kind: "breakout" | "confirmation" | "pyramid";
  startTime: number;
  endTime: number;
  level: number;
  label: string;
  detail: string;
};

type AuditUnit = {
  strategy: StrategyAuditTrade["strategy"];
  symbol: string;
  dir: "long" | "short";
  positionId: number;
  unitIndex: number;
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: UnitTrade["exitReason"] | null;
  resultR: number;
};

function fmtEvidencePrice(value: number): string {
  const digits = value >= 1000 ? 1 : value >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function auditExitReason(strategy: AuditUnit["strategy"], dir: AuditUnit["dir"], reason: AuditUnit["exitReason"]): string {
  if (!reason) return "Vị thế vẫn đang mở ở nến 4h cuối cùng.";
  if (reason === "time") return `Time-stop sau tối đa ${T.maxHoldDays} ngày.`;
  if (reason === "mid") return `Close cắt midpoint của kênh close ${strategy === "fast" ? FAST_LONG_EXIT_DAYS : T.longExitDays} ngày.`;
  if (dir === "short") return `Giá chạm Chandelier/SL ${T.chandelierMult}×ATR.`;
  return "Giá chạm hard SL đang có hiệu lực.";
}

type AuditEntry = { summary: string; evidence: EvidenceItem[] };

function auditEntryReason(
  unit: AuditUnit,
  allUnits: AuditUnit[],
  candles: Candle[],
  ema50: number[],
  atr: number[],
  gate: (time: number, dir: "long" | "short") => boolean,
  fastEntryDays: number,
): AuditEntry {
  const index = candles.findIndex((candle) => candle.openTime === unit.entryTime);
  if (index < 0) {
    return { summary: "Không tìm thấy nến entry trong cửa sổ dữ liệu hiện tại.", evidence: [] };
  }
  const bar = candles[index];
  const close = fmtEvidencePrice(bar.close);
  const emaValue = fmtEvidencePrice(ema50[index]);
  const gatePass = unit.dir === "long" ? gate(bar.openTime, unit.dir) : true;
  const gateText = unit.dir === "long"
    ? `BTC gate ${T.btcGateFast / 6}/${T.btcGateSlow / 6} ngày ${gatePass ? "PASS" : "FAIL"}`
    : "SHORT không bị chặn bởi BTC gate";
  const tfMs = TF_MS[T.tf];
  const contextStart = Math.max(candles[0].openTime, unit.entryTime - 3 * tfMs);

  const emaItem: EvidenceItem = {
    label: `Giá so với EMA${T.trendLen}`,
    value: `close ${close} ${unit.dir === "long" ? ">" : "<"} EMA${T.trendLen} ${emaValue}`,
    threshold: unit.dir === "long" ? `phải ở TRÊN EMA${T.trendLen}` : `phải ở DƯỚI EMA${T.trendLen}`,
    pass: unit.dir === "long" ? bar.close > ema50[index] : bar.close < ema50[index],
    chart: { kind: "level", startTime: contextStart, endTime: unit.entryTime, priceA: ema50[index] },
  };
  const gateItem: EvidenceItem = {
    label: `Cổng xu hướng BTC ${T.btcGateFast / 6}/${T.btcGateSlow / 6} ngày`,
    value: gateText,
    threshold: unit.dir === "long" ? "LONG chỉ được mở khi cổng PASS" : "không áp dụng cho SHORT",
    pass: gatePass,
  };
  const slItem = (detail: string): EvidenceItem => ({
    label: "Stop loss ban đầu",
    value: `${fmtEvidencePrice(unit.initialSL)} — ${detail}`,
    threshold: `1R = ${fmtEvidencePrice(Math.abs(unit.entryPrice - unit.initialSL))}`,
    pass: true,
    chart: {
      kind: "level",
      startTime: unit.entryTime,
      endTime: unit.exitTime ?? candles[candles.length - 1].openTime,
      priceA: unit.initialSL,
    },
  });

  if (unit.unitIndex > 0) {
    const previous = allUnits.find((candidate) =>
      candidate.strategy === unit.strategy &&
      candidate.positionId === unit.positionId &&
      candidate.unitIndex === unit.unitIndex - 1,
    );
    const moveAtr = previous && atr[index] > 0 ? Math.abs(unit.entryPrice - previous.entryPrice) / atr[index] : NaN;
    const moveText = Number.isFinite(moveAtr) ? `${moveAtr.toFixed(2)}×ATR` : `≥${T.pyramidStepAtr}×ATR`;
    return {
      summary: `Pyramid unit ${unit.unitIndex + 1}: close ${close} đã đi thuận ${moveText} từ unit trước; yêu cầu tối thiểu ${T.pyramidStepAtr}×ATR và vị thế gốc vẫn còn hiệu lực.`,
      evidence: [
        {
          label: `Bước giá từ unit ${unit.unitIndex}`,
          value: `close ${close} đã đi thuận ${moveText}`,
          threshold: `≥ ${T.pyramidStepAtr}×ATR`,
          pass: !Number.isFinite(moveAtr) || moveAtr >= T.pyramidStepAtr,
          chart: previous
            ? { kind: "segment", startTime: previous.entryTime, endTime: unit.entryTime, priceA: previous.entryPrice, priceB: unit.entryPrice }
            : undefined,
        },
        {
          label: "Vị thế gốc",
          value: `unit ${unit.unitIndex} vẫn còn hiệu lực`,
          threshold: `tối đa ${T.pyramidMaxUnits} unit mỗi vị thế`,
          pass: unit.unitIndex + 1 <= T.pyramidMaxUnits,
        },
        slItem(`${T.chandelierMult}×ATR từ entry của unit này`),
      ],
    };
  }

  if (unit.strategy === "turtle") {
    const days = unit.dir === "long" ? T.entryDays : T.shortEntryDays;
    const bars = Math.max(2, Math.round(days * 6));
    const channel = priorDonchian(candles, index, bars);
    const breakout = unit.dir === "long" ? channel.closeHigh : channel.closeLow;
    const comparison = unit.dir === "long" ? ">" : "<";
    const stop = turtleInitialStop(candles, index, unit.dir, bar.close, atr[index], T);
    const stopText = stop.source === "ob" ? "SL ngoài nến cấu trúc gần nhất" : `SL fallback ${T.chandelierMult}×ATR`;
    return {
      summary: `Close ${close} ${comparison} close-channel ${days} ngày ${fmtEvidencePrice(breakout)}; close ${comparison} EMA${T.trendLen} ${emaValue}; ${gateText}; ${stopText}.`,
      evidence: [
        {
          label: `Phá kênh close ${days} ngày`,
          value: `close ${close} ${comparison} ${fmtEvidencePrice(breakout)}`,
          threshold: `close phải ${comparison === ">" ? "vượt" : "thủng"} kênh ${days} ngày (${bars} nến ${T.tf})`,
          pass: comparison === ">" ? bar.close > breakout : bar.close < breakout,
          chart: { kind: "level", startTime: contextStart, endTime: unit.entryTime, priceA: breakout },
        },
        emaItem,
        gateItem,
        slItem(stopText),
      ],
    };
  }

  if (unit.dir === "long") {
    const bars = Math.max(2, Math.round(fastEntryDays * 6));
    const breakout = priorDonchian(candles, index, bars).high;
    return {
      summary: `Close ${close} > high-channel ${fastEntryDays} ngày ${fmtEvidencePrice(breakout)}; close > EMA${T.trendLen} ${emaValue}; ${gateText}; SL ban đầu ${T.chandelierMult}×ATR.`,
      evidence: [
        {
          label: `Phá kênh high ${fastEntryDays} ngày`,
          value: `close ${close} > ${fmtEvidencePrice(breakout)}`,
          threshold: `close phải vượt đỉnh ${fastEntryDays} ngày (${bars} nến ${T.tf})`,
          pass: bar.close > breakout,
          chart: { kind: "level", startTime: contextStart, endTime: unit.entryTime, priceA: breakout },
        },
        emaItem,
        gateItem,
        slItem(`${T.chandelierMult}×ATR`),
      ],
    };
  }

  const signalIndex = Math.max(0, index - FAST_SHORT_CONFIRM_BARS);
  const breakout = priorFastShortCloseLow(candles, signalIndex);
  return {
    summary: `SHORT xác nhận: nến trước đã phá close-low ${FAST_SHORT_ENTRY_DAYS} ngày ${fmtEvidencePrice(breakout)}, nến 4h kế tiếp đóng ${close} vẫn thấp hơn mức đã đóng băng; close < EMA${T.trendLen} ${emaValue}; ${gateText}; SL ban đầu ${T.chandelierMult}×ATR.`,
    evidence: [
      {
        label: `Nến tín hiệu phá close-low ${FAST_SHORT_ENTRY_DAYS} ngày`,
        value: `mức đã đóng băng ${fmtEvidencePrice(breakout)} tại nến ${new Date(candles[signalIndex].openTime).toISOString().slice(5, 16).replace("T", " ")}`,
        threshold: `phá kênh close-low ${FAST_SHORT_ENTRY_DAYS} ngày`,
        pass: true,
        chart: { kind: "level", startTime: candles[signalIndex].openTime, endTime: unit.entryTime, priceA: breakout },
      },
      {
        label: `Nến xác nhận (+${FAST_SHORT_CONFIRM_BARS} nến ${T.tf})`,
        value: `close ${close} vẫn thấp hơn mức đã đóng băng`,
        threshold: "close nến kế tiếp phải giữ dưới mức đã phá",
        pass: bar.close < breakout,
        chart: { kind: "candle", startTime: unit.entryTime, endTime: unit.entryTime + tfMs, priceA: bar.close },
      },
      emaItem,
      gateItem,
      slItem(`${T.chandelierMult}×ATR`),
    ],
  };
}

function buildChartContext(
  unit: AuditUnit,
  allUnits: AuditUnit[],
  candles: Candle[],
  atr: number[],
  fastEntryDays: number,
  detail: string,
): StrategyChartContext | null {
  const index = candles.findIndex((candle) => candle.openTime === unit.entryTime);
  if (index < 0) return null;
  const tfMs = TF_MS[T.tf];
  const prefix = unit.strategy === "turtle" ? "T" : "F";

  if (unit.unitIndex > 0) {
    const previous = allUnits.find((candidate) =>
      candidate.strategy === unit.strategy &&
      candidate.positionId === unit.positionId &&
      candidate.unitIndex === unit.unitIndex - 1,
    );
    if (!previous || !(atr[index] > 0)) return null;
    const direction = unit.dir === "long" ? 1 : -1;
    return {
      kind: "pyramid",
      startTime: Math.max(previous.entryTime, unit.entryTime - 6 * tfMs),
      endTime: unit.entryTime,
      level: previous.entryPrice + direction * T.pyramidStepAtr * atr[index],
      label: `${prefix} ADD ${T.pyramidStepAtr}A`,
      detail,
    };
  }

  if (unit.strategy === "fast" && unit.dir === "short") {
    const signalIndex = index - FAST_SHORT_CONFIRM_BARS;
    if (signalIndex < 0) return null;
    return {
      kind: "confirmation",
      startTime: candles[signalIndex].openTime,
      endTime: unit.entryTime,
      level: priorFastShortCloseLow(candles, signalIndex),
      label: `F CONF ${FAST_SHORT_ENTRY_DAYS}D`,
      detail,
    };
  }

  const days = unit.strategy === "fast"
    ? fastEntryDays
    : unit.dir === "long" ? T.entryDays : T.shortEntryDays;
  const bars = Math.max(2, Math.round(days * (TF_MS["1d"] / tfMs)));
  const channel = priorDonchian(candles, index, bars);
  const level = unit.strategy === "fast"
    ? channel.high
    : unit.dir === "long" ? channel.closeHigh : channel.closeLow;
  return {
    kind: "breakout",
    startTime: Math.max(candles[0].openTime, unit.entryTime - 3 * tfMs),
    endTime: unit.entryTime,
    level,
    label: unit.strategy === "fast" ? `F HIGH ${days}D` : `${prefix} BRK ${days}D`,
    detail,
  };
}

function normalizeClosed(strategy: AuditUnit["strategy"], trades: UnitTrade[]): AuditUnit[] {
  return trades.map((trade) => ({
    strategy,
    symbol: trade.symbol,
    dir: trade.dir,
    positionId: trade.positionId,
    unitIndex: trade.unitIndex,
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    initialSL: trade.initialSL,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    resultR: trade.netR,
  }));
}

function normalizeOpen(strategy: AuditUnit["strategy"], units: OpenUnit[], lastPrice: number): AuditUnit[] {
  return units.map((unit) => {
    const risk = Math.abs(unit.entry - unit.initialSL);
    const pnl = unit.dir === "long" ? lastPrice - unit.entry : unit.entry - lastPrice;
    return {
      strategy,
      symbol: unit.symbol,
      dir: unit.dir,
      positionId: unit.positionId,
      unitIndex: unit.unitIndex,
      entryTime: unit.entryTime,
      entryPrice: unit.entry,
      initialSL: unit.initialSL,
      exitTime: null,
      exitPrice: null,
      exitReason: null,
      resultR: risk > 0 ? pnl / risk : 0,
    };
  });
}

function buildStrategyAudit(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[],
  displayStart: number,
  methods: StrategyAuditTrade["strategy"][],
) {
  const gate = buildBtcGateLongs(btcCandles, T.btcGateFast, T.btcGateSlow);
  const fastEntryDays = parseFastTrendEntryDays(process.env.FAST_TREND_ENTRY_DAYS);
  const turtleParams: ExtParams = { ...T, gate };
  const fastParams: ExtParams = {
    ...T,
    gate,
    entryDays: fastEntryDays,
    longEntrySource: "high",
    longExitMode: "mid",
    longExitDays: FAST_LONG_EXIT_DAYS,
    shortEntryDays: FAST_SHORT_ENTRY_DAYS,
    shortEntrySource: "close",
    shortExitMode: "chandelier",
    shortConfirmBars: FAST_SHORT_CONFIRM_BARS,
    initialStopObLookback: 0,
    pyramidMaxUnits: FAST_MAX_UNITS,
    takerFeePct: FAST_MEXC_TAKER_FEE_PCT,
  };
  const turtle = methods.includes("turtle")
    ? runBooks([{ key: `${symbol}@turtle`, symbol, candles, p: turtleParams }])
    : { trades: [], openAtEnd: [] };
  const fast = methods.includes("fast")
    ? runBooks([{ key: `${symbol}@fast`, symbol, candles, p: fastParams }])
    : { trades: [], openAtEnd: [] };
  const lastPrice = candles.at(-1)?.close ?? 0;
  const allUnits = [
    ...normalizeClosed("turtle", turtle.trades),
    ...normalizeOpen("turtle", turtle.openAtEnd, lastPrice),
    ...normalizeClosed("fast", fast.trades),
    ...normalizeOpen("fast", fast.openAtEnd, lastPrice),
  ];
  const ema50 = ema(candles.map((candle) => candle.close), T.trendLen);
  const atr = atrSeries(candles, T.atrPeriod);
  const trades: StrategyAuditTrade[] = allUnits
    .filter((unit) => unit.entryTime >= displayStart)
    .map((unit) => {
      const entry = auditEntryReason(unit, allUnits, candles, ema50, atr, gate, fastEntryDays);
      return {
        id: `${unit.strategy}-${unit.positionId}-${unit.unitIndex}-${unit.entryTime}`,
        strategy: unit.strategy,
        symbol: unit.symbol.toUpperCase(),
        dir: unit.dir,
        positionId: unit.positionId,
        unit: unit.unitIndex + 1,
        entryTime: unit.entryTime,
        entryPrice: unit.entryPrice,
        initialSL: unit.initialSL,
        exitTime: unit.exitTime,
        exitPrice: unit.exitPrice,
        exitReason: unit.exitReason,
        exitReasonLabel: auditExitReason(unit.strategy, unit.dir, unit.exitReason),
        status: unit.exitTime === null ? ("open" as const) : ("closed" as const),
        resultR: unit.resultR,
        entryReason: entry.summary,
        evidence: entry.evidence,
        chartContext: buildChartContext(unit, allUnits, candles, atr, fastEntryDays, entry.summary),
      };
    })
    .sort((a, b) => b.entryTime - a.entryTime || a.strategy.localeCompare(b.strategy));

  return {
    timeframe: T.tf,
    generatedAt: Date.now(),
    methods,
    turtleConfig: methods.includes("turtle")
      ? turtleConfigLine().replaceAll("`", "")
      : "Symbol này không thuộc rổ Turtle hiện tại.",
    fastConfig: methods.includes("fast")
      ? fastConfigLine(fastEntryDays)
      : "Symbol này không thuộc rổ Fast hiện tại.",
    trades,
  };
}

function chartUniverse(universe: ReturnType<typeof getBotUniverse>) {
  return [
    ...universe.all.map((candidate) => ({
      symbol: candidate.toUpperCase(),
      venue: "BINANCE",
      strategies: [
        ...(universe.turtle.includes(candidate) ? ["turtle"] : []),
        ...(universe.fast.includes(candidate) ? ["fast"] : []),
      ],
    })),
    { symbol: "XAUUSD", venue: "OANDA", strategies: [] },
  ];
}

async function buildOandaGoldChartPayload(days: number): Promise<object> {
  const universe = getBotUniverse();
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
    botUniverse: chartUniverse(universe),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: 0,
    candles,
    trades: [],
    strategyAudit: {
      timeframe: T.tf,
      generatedAt: Date.now(),
      methods: [],
      turtleConfig: "XAUUSD OANDA không thuộc rổ bot Turtle hiện tại.",
      fastConfig: "XAUUSD OANDA không thuộc rổ bot Fast hiện tại.",
      trades: [],
    },
    // OANDA chỉ trả M15; Key Volume cần nến 5m nên nhánh vàng chưa có lớp này.
    keyVolume: null,
  };
}

export async function buildChartPayload(days: number, symbol = "btcusdt"): Promise<object> {
  const sym = symbol.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(sym)) {
    throw new Error("Symbol không hợp lệ");
  }
  if (sym === "xauusd") return buildOandaGoldChartPayload(days);
  const universe = getBotUniverse();
  const methods: StrategyAuditTrade["strategy"][] = [
    ...(universe.turtle.includes(sym) ? ["turtle" as const] : []),
    ...(universe.fast.includes(sym) ? ["fast" as const] : []),
  ];
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400;
  const strategyBarsPerDay = TF_MS["1d"] / TF_MS[T.tf];
  const strategyBars = Math.ceil(days * strategyBarsPerDay) + T.btcGateSlow + 160;
  const strategyPromise = fetchKlinesPaged(sym, T.tf, strategyBars);
  const btcPromise = sym === "btcusdt"
    ? strategyPromise
    : fetchKlinesPaged("btcusdt", T.tf, strategyBars);
  // Key Volume chạy trọn trên M15. Cửa sổ ngắn hơn chart vì mật độ key rất dày
  // (~12 key/ngày) — kéo dài thêm chỉ làm phình payload chứ không thêm thông tin.
  const keyVolumeDays = Math.min(days, KEY_VOLUME_CHART_DAYS);
  const keyVolumeBars = Math.ceil(keyVolumeDays * (TF_MS["1d"] / TF_MS["15m"])) + 400;
  const [ltf, rawStrategyCandles, rawBtcCandles, rawKeyVolumeM15] = await Promise.all([
    fetchKlinesPaged(sym, CONFIG.entryTf, totalBars),
    strategyPromise,
    btcPromise,
    fetchKlinesPaged(sym, "15m", keyVolumeBars),
  ]);
  const now = Date.now();
  const strategyCandles = rawStrategyCandles.filter((candle) => candle.openTime + TF_MS[T.tf] <= now);
  const btcCandles = rawBtcCandles.filter((candle) => candle.openTime + TF_MS[T.tf] <= now);
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
  const strategyAudit = buildStrategyAudit(sym, strategyCandles, btcCandles, displayStart, methods);
  const keyVolumeStart = Math.max(displayStart, now - keyVolumeDays * TF_MS["1d"]);
  const keyVolumeM15 = rawKeyVolumeM15.filter((candle) => candle.openTime + TF_MS["15m"] <= now);
  const keyVolume = buildKeyVolumeView(sym, keyVolumeM15, keyVolumeStart);

  return {
    symbol: sym.toUpperCase(),
    venue: "BINANCE",
    sourceLabel: "Binance Futures · 15m",
    instrumentType: "PERP",
    volumeType: "quote",
    volumeUnit: "USDT",
    botUniverse: chartUniverse(universe),
    timeframe: CONFIG.entryTf,
    days,
    candleCount: candles.length,
    tradeCount: chartTrades.length,
    candles,
    trades: chartTrades,
    strategyAudit,
    keyVolume,
  };
}
