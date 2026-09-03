/**
 * Nghiên cứu các model FXDream tách biệt, có nguồn và đăng ký trước khi chạy.
 *
 * ⚠️ HỎNG TỪ 01/09/2026: key-volume.ts đã rút về M15+M5 và bỏ `keySelectionMode`,
 * `entryTrigger`, `targetSourceTfs`, `requireDailyTrapGate` cùng toàn bộ nhánh Daily/H1/H4.
 * Ba variant dưới đây vì thế TRÙNG NHAU khi chạy lại — số cũ không tái lập được bằng script này.
 *
 * Mục tiêu của script này không phải tìm bộ tham số đẹp nhất. Mỗi variant chỉ
 * thay những điều kiện cần thiết để biểu diễn một model được nói rõ trong video:
 *
 * - follow-trend-sfp: Daily cùng hướng -> H1 Key Volume -> retest + volume đúng
 *   vị trí -> sweep/reclaim -> mô hình nến đảo chiều.
 * - follow-trend-bos: cùng pipeline nhưng chờ phá cấu trúc rồi mới vào.
 * - daily-trap-sfp: model trap Daily riêng, không coi trap là gate bắt buộc cho
 *   mọi setup thuận xu hướng.
 *
 * Run:
 *   npx ts-node scripts/fxdream-source-model-research.ts [days] [symbols] [riskPct]
 */
import "../load-env";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeDiagnostics,
  KeyVolumeParams,
  KeyVolumeTrade,
  runKeyVolume,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { CONFIG, Candle, TF_MS, aggregate } from "../strategy";

type Variant = {
  name: string;
  source: string;
  overrides: Partial<KeyVolumeParams>;
};

type EvaluatedTrade = KeyVolumeTrade & {
  evaluatedGrossR: number;
  evaluatedNetR: number;
};

type Metrics = {
  trades: number;
  winRate: number;
  grossR: number;
  netR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
};

const WARMUP_DAYS = 120;
const TRAIN_FRACTION = 2 / 3;
// Tổng phí + slippage khứ hồi. Funding thực tế mô phỏng trong engine được giữ
// riêng và cộng vào cả ba kịch bản.
const ROUND_TRIP_FRICTIONS = [0.0002, 0.001, 0.0014] as const;

/**
 * Danh sách này cố ý ngắn và cố định. Không thêm/bớt variant sau khi nhìn kết
 * quả của chính cửa sổ đang đo.
 */
const VARIANTS: Variant[] = [
  {
    name: "spike-follow-trend-structure",
    source: "Key spike-only + follow-trend SFP + TP cấu trúc (#22/#50)",
    overrides: {
      keySelectionMode: "spike-only",
      minKeyReactions: 0,
      requireDailyTrapGate: false,
      entryTrigger: "candle-pattern",
      targetSourceTfs: ["15m", "1h", "4h"],
      requireStructuralTarget: true,
      partialFraction: 0,
      trailMode: "none",
    },
  },
  {
    name: "spike-follow-trend-5r-study",
    source: "Cùng entry nhưng fallback 5R chỉ để chẩn đoán target detector",
    overrides: {
      keySelectionMode: "spike-only",
      minKeyReactions: 0,
      requireDailyTrapGate: false,
      entryTrigger: "candle-pattern",
      requireStructuralTarget: false,
      partialFraction: 0,
      trailMode: "none",
    },
  },
  {
    name: "spike-follow-trend-bos",
    source: "LiveTrade +50R: sweep cuối -> break structure -> next open",
    overrides: {
      keySelectionMode: "spike-only",
      minKeyReactions: 0,
      requireDailyTrapGate: false,
      entryTrigger: "bos",
      targetSourceTfs: ["15m", "1h", "4h"],
      requireStructuralTarget: true,
      partialFraction: 0,
      trailMode: "none",
    },
  },
  {
    name: "spike-daily-trap-structure",
    source: "Key spike-only + Daily trap #31 + SFP #50 + TP cấu trúc",
    overrides: {
      keySelectionMode: "spike-only",
      minKeyReactions: 0,
      requireDailyTrapGate: true,
      entryTrigger: "candle-pattern",
      targetSourceTfs: ["15m", "1h", "4h"],
      requireStructuralTarget: true,
      partialFraction: 0,
      trailMode: "none",
    },
  },
  {
    name: "spike-daily-trap-5r-study",
    source: "Daily trap cùng entry; fallback 5R chỉ để chẩn đoán target detector",
    overrides: {
      keySelectionMode: "spike-only",
      minKeyReactions: 0,
      requireDailyTrapGate: true,
      entryTrigger: "candle-pattern",
      requireStructuralTarget: false,
      partialFraction: 0,
      trailMode: "none",
    },
  },
  {
    name: "displacement-reference",
    source: "Đối chứng: phân loại Key bằng displacement; không đúng luật spike-only",
    overrides: {
      keySelectionMode: "displacement-classified",
      minKeyReactions: 0,
      requireDailyTrapGate: false,
      entryTrigger: "candle-pattern",
      targetSourceTfs: ["15m", "1h", "4h"],
      requireStructuralTarget: true,
      partialFraction: 0,
      trailMode: "none",
    },
  },
];

function leverageScale(trade: KeyVolumeTrade, riskPct: number, maxLeverage: number): number {
  const riskBudget = riskPct / 100;
  const stopFraction = Math.abs(trade.entryPrice - trade.initialSL) / trade.entryPrice;
  if (!(riskBudget > 0) || !(maxLeverage > 0) || !(stopFraction > 0)) return 1;
  return Math.min(1, maxLeverage * stopFraction / riskBudget);
}

function evaluateTrade(
  trade: KeyVolumeTrade,
  roundTripFriction: number,
  riskPct: number,
  maxLeverage: number,
): EvaluatedTrade {
  const stopFraction = Math.abs(trade.entryPrice - trade.initialSL) / trade.entryPrice;
  const configuredRoundTrip = CONFIG.costs.enabled
    ? 2 * (CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100
    : 0;
  const configuredFeeR = stopFraction > 0 ? configuredRoundTrip / stopFraction : 0;
  // costR còn lại là funding đã được engine tính theo thời gian giữ lệnh.
  const fundingR = Math.max(0, trade.costR - configuredFeeR);
  const frictionR = stopFraction > 0 ? roundTripFriction / stopFraction : 0;
  const scale = leverageScale(trade, riskPct, maxLeverage);
  const evaluatedGrossR = trade.grossR * scale;
  const evaluatedNetR = (trade.grossR - frictionR - fundingR) * scale;
  return { ...trade, evaluatedGrossR, evaluatedNetR };
}

function metrics(
  trades: KeyVolumeTrade[],
  start: number,
  end: number,
  friction: number,
  riskPct: number,
  maxLeverage: number,
): Metrics {
  const evaluated = trades
    .filter((trade) => trade.entryTime >= start && trade.entryTime < end)
    .sort((a, b) => a.entryTime - b.entryTime)
    .map((trade) => evaluateTrade(trade, friction, riskPct, maxLeverage));
  const grossR = evaluated.reduce((sum, trade) => sum + trade.evaluatedGrossR, 0);
  const netR = evaluated.reduce((sum, trade) => sum + trade.evaluatedNetR, 0);
  const gains = evaluated.reduce(
    (sum, trade) => sum + Math.max(0, trade.evaluatedNetR),
    0,
  );
  const losses = Math.abs(evaluated.reduce(
    (sum, trade) => sum + Math.min(0, trade.evaluatedNetR),
    0,
  ));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of evaluated) {
    equity += trade.evaluatedNetR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: evaluated.length,
    winRate: evaluated.length
      ? evaluated.filter((trade) => trade.evaluatedNetR > 0).length / evaluated.length
      : 0,
    grossR,
    netR,
    expectancy: evaluated.length ? netR / evaluated.length : 0,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : 0,
    maxDrawdown,
  };
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function line(label: string, value: Metrics): string {
  return [
    label.padEnd(10),
    `N=${String(value.trades).padStart(3)}`,
    `WR=${(100 * value.winRate).toFixed(0).padStart(2)}%`,
    `gross=${signed(value.grossR).padStart(6)}R`,
    `net=${signed(value.netR).padStart(6)}R`,
    `exp=${signed(value.expectancy, 3)}R`,
    `PF=${Number.isFinite(value.profitFactor) ? value.profitFactor.toFixed(2) : "inf"}`,
    `DD=${value.maxDrawdown.toFixed(1)}R`,
  ].join("  ");
}

function diagnosticLine(values: KeyVolumeDiagnostics[]): string {
  const sum = (key: keyof KeyVolumeDiagnostics) =>
    values.reduce((total, value) => total + value[key], 0);
  return [
    `H1key=${sum("h1Levels")}`,
    `touch=${sum("confluentTouches")}`,
    `vol=${sum("touchVolumeConfirmed")}`,
    `sweep=${sum("sweeps")}`,
    `pattern=${sum("candlePatterns")}`,
    `plan=${sum("plans")}`,
    `entry=${sum("entries")}`,
    `rejectDaily=${sum("rejectedDailyTrap")}`,
    `rejectRoom=${sum("rejectedRoom")}`,
  ].join("  ");
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols)
    .map((symbol) => symbol.trim().toLowerCase())
    .filter(Boolean);
  const riskPct = parseFloat(process.argv[4] ?? "1");
  const maxLeverage = parseFloat(process.env.LEVERAGE ?? "10");
  if (!(days > 0) || !(riskPct > 0) || !(maxLeverage > 0) || !symbols.length) {
    throw new Error("days, riskPct, LEVERAGE và symbols phải hợp lệ");
  }

  const totalBars = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["5m"]) + 12;
  const baseBySymbol = new Map<string, Candle[]>();
  console.log(`Tải ${days}d + ${WARMUP_DAYS}d warmup × ${symbols.length} symbol...`);
  for (const symbol of symbols) {
    const candles = (await fetchKlinesPaged(symbol, "5m", totalBars))
      .filter((candle) => candle.openTime + TF_MS["5m"] <= Date.now());
    if (candles.length >= totalBars * 0.8) baseBySymbol.set(symbol, candles);
  }
  if (!baseBySymbol.size) throw new Error("Không có symbol đủ dữ liệu");

  const periodEnd = Math.min(
    ...[...baseBySymbol.values()].map(
      (candles) => candles[candles.length - 1].openTime + TF_MS["5m"],
    ),
  );
  const periodStart = periodEnd - days * TF_MS["1d"];
  const split = periodStart + Math.floor((periodEnd - periodStart) * TRAIN_FRACTION);
  console.log(
    `${new Date(periodStart).toISOString().slice(0, 10)} -> `
    + `${new Date(periodEnd).toISOString().slice(0, 10)}`,
  );
  console.log(
    `Train < ${new Date(split).toISOString().slice(0, 10)} | `
    + `holdout >= ${new Date(split).toISOString().slice(0, 10)} | `
    + `risk ${riskPct}% | cap ${maxLeverage}x`,
  );

  const requestedVariant = process.env.FXDREAM_VARIANT?.trim();
  const variants = requestedVariant
    ? VARIANTS.filter((variant) => variant.name === requestedVariant)
    : VARIANTS;
  if (!variants.length) throw new Error(`Không tìm thấy variant ${requestedVariant}`);
  for (const variant of variants) {
    const params: KeyVolumeParams = { ...KEY_VOLUME_CONFIG, ...variant.overrides };
    const results = [...baseBySymbol].map(([symbol, candles]) =>
      runKeyVolume(symbol, aggregate(candles, "15m", "5m"), params),
    );
    const trades = results.flatMap((result) => result.trades);
    console.log(`\n${variant.name} — ${variant.source}`);
    console.log(diagnosticLine(results.map((result) => result.diagnostics)));
    for (const friction of ROUND_TRIP_FRICTIONS) {
      const label = `${(100 * friction).toFixed(2)}%`;
      console.log(line(`${label} all`, metrics(
        trades,
        periodStart,
        periodEnd,
        friction,
        riskPct,
        maxLeverage,
      )));
      console.log(line(`${label} tr`, metrics(
          trades,
          periodStart,
          split,
          friction,
          riskPct,
          maxLeverage,
        )));
      console.log(line(`${label} ho`, metrics(
          trades,
          split,
          periodEnd,
          friction,
          riskPct,
          maxLeverage,
        )));
    }
  }
  console.log(
    "\nĐiều kiện thăng hạng: net > 0 và PF > 1.15 ở cả train lẫn holdout tại 0.14%; "
    + "nếu không đạt thì giữ fail-closed.",
  );
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
