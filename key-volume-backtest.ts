/**
 * Backtest và so sánh cùng kỳ:
 *   Key Volume (mới) | SMC hiện có | Turtle hiện có | Fast Trend hiện có.
 *
 * Tất cả dùng cùng Binance USD-M OHLCV, cùng khoảng đánh giá và cùng CONFIG.costs.
 * Fast Trend ở đây dùng semantics production legacy (high/low Donchian + Chandelier),
 * nhưng vẫn dùng chi phí Binance để cô lập khác biệt entry/exit khỏi khác biệt venue.
 *
 * Run:
 *   ./node_modules/.bin/ts-node key-volume-backtest.ts [days] [riskPct] [symbols] [model]
 */
import "./load-env";
import { runBacktest as runSmcBacktest } from "./backtest";
import {
  KEY_VOLUME_CONFIG,
  KEY_VOLUME_DOCUMENT_V1_CONFIG,
  KeyVolumeDiagnostics,
  KeyVolumeEntryModel,
  KeyVolumeTrade,
  runKeyVolume,
} from "./key-volume";
import { fetchKlinesPaged } from "./kline-fetch";
import { Candle, CONFIG, TF_MS, aggregate } from "./strategy";
import {
  T,
  Trade as TurtleTrade,
  TurtleParams,
  buildBtcGateLongs,
  runTurtle,
} from "./turtle";

type ComparableTrade = {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  grossR: number;
  costR: number;
  netR: number;
};

type Metrics = {
  trades: number;
  long: number;
  short: number;
  winRate: number;
  grossR: number;
  costR: number;
  netR: number;
  expectancy: number;
  tradesPerDay: number;
  avgHoldDays: number;
  maxDrawdown: number;
  eras: number[];
  bootstrapLow: number;
  bootstrapHigh: number;
  pPositive: number;
};

const WARMUP_DAYS = 120;

/**
 * Quy đổi price-R sang R của ngân sách risk khi notional bị chặn bởi đòn bẩy.
 * Ví dụ risk 1%, stop 0.02%, leverage 10x chỉ triển khai được 20% size mong
 * muốn; gross R và cost R đều phải nhân 0.2, thay vì giả định leverage vô hạn.
 */
export function applyLeverageCap<T extends ComparableTrade>(
  trade: T,
  riskPct: number,
  maxLeverage: number,
): T {
  const riskBudget = riskPct / 100;
  const stopFraction = Math.abs(trade.entryPrice - trade.initialSL) / trade.entryPrice;
  if (!(riskBudget > 0) || !(maxLeverage > 0) || !(stopFraction > 0)) return trade;
  const scale = Math.min(1, maxLeverage * stopFraction / riskBudget);
  if (scale >= 1) return trade;
  const grossR = trade.grossR * scale;
  const costR = trade.costR * scale;
  return { ...trade, grossR, costR, netR: grossR - costR };
}

function closedOnly(candles: Candle[], tf: string, endTime: number): Candle[] {
  return candles.filter((candle) => candle.openTime + TF_MS[tf] <= endTime);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high
    ? sorted[low]
    : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function weeklyBootstrap(
  trades: ComparableTrade[],
  start: number,
  end: number,
  samples = 4000,
): { low: number; high: number; pPositive: number } {
  const weekMs = 7 * TF_MS["1d"];
  const weeks = Math.max(1, Math.ceil((end - start) / weekMs));
  const weekly = Array<number>(weeks).fill(0);
  for (const trade of trades) {
    const index = Math.floor((trade.entryTime - start) / weekMs);
    if (index >= 0 && index < weeks) weekly[index] += trade.netR;
  }
  const random = mulberry32(0x4b565f32);
  const totals: number[] = [];
  let positive = 0;
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let week = 0; week < weeks; week++) {
      total += weekly[Math.floor(random() * weeks)];
    }
    totals.push(total);
    if (total > 0) positive++;
  }
  totals.sort((a, b) => a - b);
  return {
    low: quantile(totals, 0.05),
    high: quantile(totals, 0.95),
    pPositive: positive / samples,
  };
}

function metrics(
  tradesInput: ComparableTrade[],
  start: number,
  end: number,
  riskPct: number,
): Metrics {
  const trades = tradesInput
    .filter((trade) => trade.entryTime >= start && trade.entryTime < end)
    .sort((a, b) => a.entryTime - b.entryTime);
  const periodDays = (end - start) / TF_MS["1d"];
  const grossR = trades.reduce((sum, trade) => sum + trade.grossR, 0);
  const costR = trades.reduce((sum, trade) => sum + trade.costR, 0);
  const netR = trades.reduce((sum, trade) => sum + trade.netR, 0);
  let equity = 100;
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netR * riskPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const span = (end - start) / 3;
  const eras = [0, 1, 2].map((era) => {
    const low = start + era * span;
    const high = era === 2 ? end : start + (era + 1) * span;
    return trades
      .filter((trade) => trade.entryTime >= low && trade.entryTime < high)
      .reduce((sum, trade) => sum + trade.netR, 0);
  });
  const bootstrap = weeklyBootstrap(trades, start, end);
  return {
    trades: trades.length,
    long: trades.filter((trade) => trade.dir === "long").length,
    short: trades.filter((trade) => trade.dir === "short").length,
    winRate: trades.length
      ? trades.filter((trade) => trade.netR > 0).length / trades.length
      : 0,
    grossR,
    costR,
    netR,
    expectancy: trades.length ? netR / trades.length : 0,
    tradesPerDay: trades.length / periodDays,
    avgHoldDays: trades.length
      ? trades.reduce((sum, trade) => sum + (trade.exitTime - trade.entryTime), 0)
        / trades.length / TF_MS["1d"]
      : 0,
    maxDrawdown,
    eras,
    bootstrapLow: bootstrap.low,
    bootstrapHigh: bootstrap.high,
    pPositive: bootstrap.pPositive,
  };
}

function fmtRow(name: string, value: Metrics): string {
  return [
    name.padEnd(13),
    String(value.trades).padStart(5),
    `${(100 * value.winRate).toFixed(1)}%`.padStart(7),
    value.expectancy.toFixed(3).padStart(8),
    signed(value.grossR).padStart(9),
    signed(value.netR).padStart(9),
    signed(-value.costR).padStart(9),
    `${(100 * value.maxDrawdown).toFixed(1)}%`.padStart(8),
    value.tradesPerDay.toFixed(2).padStart(7),
    value.avgHoldDays.toFixed(2).padStart(7),
    value.eras.map((era) => signed(era).padStart(7)).join(" "),
  ].join(" ");
}

function sumDiagnostics(
  values: KeyVolumeDiagnostics[],
): KeyVolumeDiagnostics {
  const out: KeyVolumeDiagnostics = {
    m15Levels: 0,
    h1Levels: 0,
    h4Levels: 0,
    confluentTouches: 0,
    touchVolumeConfirmed: 0,
    sweeps: 0,
    firstBos: 0,
    secondBos: 0,
    candlePatterns: 0,
    profileAccepted: 0,
    plans: 0,
    entries: 0,
    rejectedRisk: 0,
    rejectedRoom: 0,
    rejectedFirstTouch: 0,
    rejectedDailyTrap: 0,
    rejectedDouble: 0,
    rejectedSession: 0,
  };
  for (const value of values) {
    for (const key of Object.keys(out) as Array<keyof KeyVolumeDiagnostics>) {
      out[key] += value[key];
    }
  }
  return out;
}

function printPerSymbol(
  names: Array<[string, ComparableTrade[]]>,
  symbols: string[],
  start: number,
  end: number,
): void {
  console.log("\nNET R theo symbol:");
  console.log(`${"Symbol".padEnd(10)} ${names.map(([name]) => name.padStart(13)).join(" ")}`);
  for (const symbol of symbols) {
    const cells = names.map(([, trades]) => {
      const selected = trades.filter(
        (trade) =>
          trade.symbol === symbol
          && trade.entryTime >= start
          && trade.entryTime < end,
      );
      const net = selected.reduce((sum, trade) => sum + trade.netR, 0);
      return `${signed(net)} (${selected.length})`.padStart(13);
    });
    console.log(`${symbol.toUpperCase().padEnd(10)} ${cells.join(" ")}`);
  }
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const riskPct = parseFloat(process.argv[3] ?? "1");
  const maxLeverage = parseFloat(process.env.LEVERAGE ?? "10");
  const symbols = (process.argv[4]?.split(",") ?? CONFIG.symbols)
    .map((symbol) => symbol.trim().toLowerCase())
    .filter(Boolean);
  const entryModel = (process.argv[5] ?? KEY_VOLUME_CONFIG.entryModel) as KeyVolumeEntryModel;
  const keyVolumeConfig = entryModel === "document-v1"
    ? KEY_VOLUME_DOCUMENT_V1_CONFIG
    : KEY_VOLUME_CONFIG;
  if (!(days > 0) || !(riskPct > 0) || !(maxLeverage > 0) || !symbols.length) {
    throw new Error("Tham số phải là: days>0, riskPct>0, LEVERAGE>0 và ít nhất một symbol");
  }
  if (!["volume-retest", "document-v1"].includes(entryModel)) {
    throw new Error("model phải là volume-retest hoặc document-v1");
  }

  const totalBars = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["5m"]) + 12;
  const baseBySymbol = new Map<string, Candle[]>();
  console.log(
    `Tải ${days} ngày đánh giá + ${WARMUP_DAYS} ngày warmup`
    + ` × ${symbols.length} symbol (${totalBars} nến 5m/symbol)...`,
  );
  for (const symbol of symbols) {
    const fetched = await fetchKlinesPaged(symbol, "5m", totalBars);
    const now = Date.now();
    const closed = closedOnly(fetched, "5m", now);
    if (closed.length < totalBars * 0.8) {
      console.warn(`[${symbol.toUpperCase()}] chỉ có ${closed.length}/${totalBars} nến; bỏ qua.`);
      continue;
    }
    baseBySymbol.set(symbol, closed);
  }
  if (!baseBySymbol.size) throw new Error("Không có symbol đủ dữ liệu");

  const periodEnd = Math.min(
    ...[...baseBySymbol.values()].map(
      (candles) => candles[candles.length - 1].openTime + TF_MS["5m"],
    ),
  );
  const periodStart = periodEnd - days * TF_MS["1d"];
  const fourHourBySymbol = new Map<string, Candle[]>();
  for (const [symbol, base] of baseBySymbol) {
    fourHourBySymbol.set(
      symbol,
      closedOnly(aggregate(base, "4h", "5m"), "4h", periodEnd),
    );
  }

  let btc4h = fourHourBySymbol.get("btcusdt");
  if (!btc4h) {
    const needed = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["4h"]) + 10;
    btc4h = closedOnly(
      await fetchKlinesPaged("btcusdt", "4h", needed),
      "4h",
      periodEnd,
    );
  }
  const turtleGate = buildBtcGateLongs(btc4h, T.btcGateFast, T.btcGateSlow);

  const keyVolumeTrades: KeyVolumeTrade[] = [];
  const smcTrades: ComparableTrade[] = [];
  const turtleTrades: TurtleTrade[] = [];
  const fastTrades: TurtleTrade[] = [];
  const diagnostics: KeyVolumeDiagnostics[] = [];
  const fastParams: TurtleParams = {
    ...T,
    entryDays: 10,
    shortEntryDays: 0,
    longEntrySource: "high",
    longExitMode: "chandelier",
    shortEntrySource: "low",
    shortExitMode: "chandelier",
    initialStopObLookback: 0,
    gate: turtleGate,
  };
  const turtleParams: TurtleParams = { ...T, gate: turtleGate };

  for (const [symbol, base] of baseBySymbol) {
    const keyVolume = runKeyVolume(symbol, base, keyVolumeConfig);
    keyVolumeTrades.push(...keyVolume.trades);
    diagnostics.push(keyVolume.diagnostics);

    const m15 = closedOnly(aggregate(base, "15m", "5m"), "15m", periodEnd);
    smcTrades.push(...runSmcBacktest(symbol, m15));
    const h4 = fourHourBySymbol.get(symbol)!;
    turtleTrades.push(...runTurtle(symbol, h4, turtleParams));
    fastTrades.push(...runTurtle(symbol, h4, fastParams));
  }

  const rawMethods: Array<[string, ComparableTrade[]]> = [
    ["KeyVol OHLCV", keyVolumeTrades],
    ["SMC", smcTrades],
    ["Turtle", turtleTrades],
    ["Fast Trend", fastTrades],
  ];
  const methods: Array<[string, ComparableTrade[]]> = rawMethods.map(
    ([name, trades]) => [
      name,
      trades.map((trade) => applyLeverageCap(trade, riskPct, maxLeverage)),
    ],
  );
  const executableKeyVolume = keyVolumeTrades.map(
    (trade) => applyLeverageCap(trade, riskPct, maxLeverage),
  );
  const summaries = methods.map(
    ([name, trades]) => [name, metrics(trades, periodStart, periodEnd, riskPct)] as const,
  );
  const from = new Date(periodStart).toISOString().slice(0, 10);
  const to = new Date(periodEnd).toISOString().slice(0, 10);

  console.log("\n" + "=".repeat(122));
  console.log(
    `SO SÁNH CÙNG KỲ ${from} -> ${to} | risk ${riskPct}%/unit`
    + ` | cap ${maxLeverage}x | đã trừ cùng chi phí`,
  );
  console.log("=".repeat(122));
  console.log(
    `${"Phương pháp".padEnd(13)} ${"N".padStart(5)} ${"WR".padStart(7)}`
    + ` ${"exp".padStart(8)} ${"GROSS R".padStart(9)} ${"NET R".padStart(9)} ${"cost".padStart(9)}`
    + ` ${"maxDD".padStart(8)} ${"N/day".padStart(7)} ${"holdD".padStart(7)}`
    + ` ${"Era A".padStart(7)} ${"Era B".padStart(7)} ${"Era C".padStart(7)}`,
  );
  for (const [name, summary] of summaries) console.log(fmtRow(name, summary));

  console.log("\nWeekly block-bootstrap 90% CI tổng NET R:");
  for (const [name, summary] of summaries) {
    console.log(
      `  ${name.padEnd(13)} [${signed(summary.bootstrapLow)}, ${signed(summary.bootstrapHigh)}]`
      + ` · P(NET>0) ${(100 * summary.pPositive).toFixed(1)}%`
      + ` · long/short ${summary.long}/${summary.short}`,
    );
  }

  printPerSymbol(methods, [...baseBySymbol.keys()], periodStart, periodEnd);

  const diag = sumDiagnostics(diagnostics);
  console.log("\nKey Volume funnel (gồm cả warmup để chẩn đoán state machine):");
  const modelFunnel = keyVolumeConfig.entryModel === "volume-retest"
    ? ` -> volume@key ${diag.touchVolumeConfirmed}`
      + ` -> sweep ${diag.sweeps}`
      + (keyVolumeConfig.entryTrigger === "candle-pattern"
        ? ` -> mô hình nến ${diag.candlePatterns}`
        : ` -> BOS ${diag.firstBos}`)
    : ` -> sweep ${diag.sweeps}`
      + ` -> BOS1 ${diag.firstBos}`
      + ` -> BOS2 ${diag.secondBos}`
      + ` -> OB+HVN ${diag.profileAccepted}`;
  console.log(
    `  model ${keyVolumeConfig.entryModel}`
    + ` · key M15/H1/H4 ${diag.m15Levels}/${diag.h1Levels}/${diag.h4Levels}`
    + ` -> touch ${diag.confluentTouches}`
    + modelFunnel
    + ` -> plan ${diag.plans}`
    + ` -> entry ${diag.entries}`,
  );
  console.log(
    `  Từ chối tại entry: risk/SL ${diag.rejectedRisk}`
    + ` · hết dư địa trước ${keyVolumeConfig.minRR}R ${diag.rejectedRoom}`,
  );
  console.log(
    `  Từ chối trước đó: chạm lần đầu ${diag.rejectedFirstTouch}`
    + ` · gate Daily trap ${diag.rejectedDailyTrap}`
    + ` · hai đỉnh/đáy ${diag.rejectedDouble}`
    + ` · ngoài phiên ${diag.rejectedSession}`,
  );

  const evaluatedRawKeyVolume = keyVolumeTrades
    .filter((trade) => trade.entryTime >= periodStart && trade.entryTime < periodEnd)
    .sort((a, b) => a.entryTime - b.entryTime);
  const evaluatedKeyVolume = executableKeyVolume
    .filter((trade) => trade.entryTime >= periodStart && trade.entryTime < periodEnd)
    .sort((a, b) => a.entryTime - b.entryTime);
  if (evaluatedKeyVolume.length) {
    const evaluatedDays = (periodEnd - periodStart) / TF_MS["1d"];
    console.log(
      `  Tần suất Key Volume: ${(evaluatedKeyVolume.length / evaluatedDays).toFixed(3)} lệnh/ngày`
      + ` trên rổ · ${(evaluatedKeyVolume.length * 7 / evaluatedDays / baseBySymbol.size).toFixed(3)}`
      + " lệnh/tuần/symbol",
    );
    const exitReasons = new Map<string, number>();
    for (const trade of evaluatedKeyVolume) {
      exitReasons.set(trade.exitReason, (exitReasons.get(trade.exitReason) ?? 0) + 1);
    }
    const winners = evaluatedRawKeyVolume.filter((trade) => trade.grossR > 0);
    const failures = evaluatedRawKeyVolume.filter((trade) => trade.grossR <= 0);
    const average = (values: number[]) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const averageReward = average(winners.map((trade) => trade.grossR));
    const averageFail = Math.abs(average(failures.map((trade) => trade.grossR)));
    const executionWinners = evaluatedKeyVolume.filter(
      (_, index) => evaluatedRawKeyVolume[index].grossR > 0,
    );
    const executionFailures = evaluatedKeyVolume.filter(
      (_, index) => evaluatedRawKeyVolume[index].grossR <= 0,
    );
    const executionReward = average(executionWinners.map((trade) => trade.netR));
    const executionFail = Math.abs(average(executionFailures.map((trade) => trade.netR)));
    console.log(
      `  Exit Key Volume: ${[...exitReasons].map(([reason, count]) => `${reason}=${count}`).join(" · ")}`,
    );
    // Edge gộp per-lệnh chỉ trả nổi ma sát nhỏ hơn (gross/lệnh × độ rộng stop).
    // In thẳng ngưỡng này vì nó mới là thứ quyết định phương pháp sống hay chết
    // trên một venue, chứ không phải NET R của riêng Binance.
    const grossPerTrade = evaluatedKeyVolume.reduce((sum, t) => sum + t.grossR, 0)
      / evaluatedKeyVolume.length;
    const stopFractions = evaluatedKeyVolume
      .map((t) => Math.abs(t.entryPrice - t.initialSL) / t.entryPrice)
      .sort((a, b) => a - b);
    const medianStop = stopFractions[Math.floor(stopFractions.length / 2)];
    const roundTrip = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
    console.log(
      `  Ngưỡng hoà phí: gross ${grossPerTrade.toFixed(3)}R/lệnh × stop`
      + ` ${(100 * medianStop).toFixed(3)}% => chịu được ma sát khứ hồi`
      + ` < ${(100 * grossPerTrade * medianStop).toFixed(3)}%`
      + ` · đang mô hình hoá ${(100 * roundTrip).toFixed(3)}%`,
    );
    console.log(
      `  Payoff price-R reward/fail ${averageReward.toFixed(2)}R/${averageFail.toFixed(2)}R`
      + ` (${averageFail > 0 ? (averageReward / averageFail).toFixed(2) : "n/a"}x)`
      + ` · NET execution-R @${maxLeverage}x ${executionReward.toFixed(2)}R/${executionFail.toFixed(2)}R`
      + ` (${executionFail > 0 ? (executionReward / executionFail).toFixed(2) : "n/a"}x)`,
    );
    console.log("  Chi tiết lệnh Key Volume:");
    for (const trade of evaluatedKeyVolume) {
      const time = new Date(trade.entryTime).toISOString().replace("T", " ").slice(0, 16);
      console.log(
        `    ${trade.symbol.toUpperCase()} ${trade.dir.toUpperCase()} ${time}`
        + ` · ${signed(trade.netR, 2)}R (${trade.exitReason})`
        + ` · ${trade.model}`
        + ` · keyVol ${trade.keyVolumeRatio.toFixed(2)}x`
        + `${trade.triggerVolumeRatio == null ? "" : `/trigger ${trade.triggerVolumeRatio.toFixed(2)}x`}`
        + `${trade.higherVolumeRatio == null ? "" : `/H4 ${trade.higherVolumeRatio.toFixed(2)}x`}`
        + ` · hold ${(trade.exitTime - trade.entryTime) / TF_MS["1h"] < 1
          ? `${Math.round((trade.exitTime - trade.entryTime) / TF_MS["5m"]) * 5}m`
          : `${((trade.exitTime - trade.entryTime) / TF_MS["1h"]).toFixed(1)}h`}`,
      );
    }
  }

  console.log("\nCách đọc so sánh:");
  console.log("  - KeyVol OHLCV chỉ là phần kỹ thuật công khai có thể lượng hoá; không gồm macro/chọn key discretionary.");
  console.log("  - KeyVol OHLCV và SMC là pullback/reversal có xác nhận; Turtle/Fast là breakout trend-following.");
  console.log("  - Turtle/Fast tính mỗi pyramid unit là một trade/R; Key Volume và SMC là một vị thế mỗi signal.");
  console.log("  - Fast production chạy MEXC, nhưng bảng cố ý dùng cùng Binance costs để so logic, không so venue.");
  console.log("  - Macro/chọn key discretionary chưa có; HVN chỉ xuất hiện ở document-v1 và là proxy OHLCV.");
}

// Xem turtle.ts: `require.main === module` một mình không an toàn khi file bị bundle.
if (require.main === module && /[\\/]key-volume-backtest\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    const detail = (error as { response?: { data?: unknown }; message?: string });
    console.error("Lỗi:", detail.response?.data ?? detail.message ?? error);
    process.exit(1);
  });
}
