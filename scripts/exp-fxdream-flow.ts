/**
 * Đo LUỒNG FX Dream sau bốn thay đổi 01/09/26, chỉ trên 200 ngày gần nhất:
 *   1. Quét: cửa sổ 1 ngày -> 5 ngày, và mức bị quét phải sạch 1 ngày về trước.
 *   2. Key volume = ĐƯỜNG THẲNG tại giá MỞ CỬA nến M15 (không còn vùng).
 *   3. Vào lệnh: lệnh CHỜ ở mép thuận chiều của order block dựng từ cụm nến đảo
 *      chiều (hộp THÂN NẾN, bỏ râu).
 *   4. Thoát: ngay ngoài mép ĐỐI DIỆN của chính hộp đó.
 *
 * Tải thẳng nến 15m (không gộp từ 5m) để đỡ băng thông và thời gian.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-fxdream-flow.ts [days] [symbols]
 */
import "../load-env";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeParams,
  KeyVolumeTrade,
  runKeyVolume,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, CONFIG, TF_MS } from "../strategy";

const WARMUP_DAYS = 30;

type Summary = {
  trades: number;
  long: number;
  short: number;
  winRate: number;
  grossR: number;
  costR: number;
  netR: number;
  expectancy: number;
  maxDrawdown: number;
  medianStopPct: number;
};

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function summarize(all: KeyVolumeTrade[], start: number, end: number, riskPct: number): Summary {
  const trades = all
    .filter((trade) => trade.entryTime >= start && trade.entryTime < end)
    .sort((a, b) => a.entryTime - b.entryTime);
  let equity = 100;
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netR * riskPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const stops = trades
    .map((trade) => Math.abs(trade.entryPrice - trade.initialSL) / trade.entryPrice)
    .sort((a, b) => a - b);
  const netR = trades.reduce((sum, trade) => sum + trade.netR, 0);
  return {
    trades: trades.length,
    long: trades.filter((trade) => trade.dir === "long").length,
    short: trades.filter((trade) => trade.dir === "short").length,
    winRate: trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0,
    grossR: trades.reduce((sum, trade) => sum + trade.grossR, 0),
    costR: trades.reduce((sum, trade) => sum + trade.costR, 0),
    netR,
    expectancy: trades.length ? netR / trades.length : 0,
    maxDrawdown,
    medianStopPct: stops.length ? 100 * stops[Math.floor(stops.length / 2)] : 0,
  };
}

function row(name: string, value: Summary): string {
  return [
    name.padEnd(30),
    String(value.trades).padStart(6),
    `${(100 * value.winRate).toFixed(1)}%`.padStart(7),
    value.expectancy.toFixed(3).padStart(8),
    signed(value.grossR).padStart(9),
    signed(value.netR).padStart(9),
    `${(100 * value.maxDrawdown).toFixed(1)}%`.padStart(8),
    `${value.medianStopPct.toFixed(2)}%`.padStart(8),
  ].join(" ");
}

function header(): string {
  return [
    "Cấu hình".padEnd(30),
    "N".padStart(6),
    "WR".padStart(7),
    "exp".padStart(8),
    "GROSS R".padStart(9),
    "NET R".padStart(9),
    "maxDD".padStart(8),
    "medSL".padStart(8),
  ].join(" ");
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "200", 10);
  const riskPct = 1;
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols)
    .map((symbol) => symbol.trim().toLowerCase())
    .filter(Boolean);
  if (!(days > 0) || !symbols.length) throw new Error("days>0 và ít nhất một symbol");

  const bars = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["15m"]) + 12;
  console.log(
    `Tải ${days} ngày đánh giá + ${WARMUP_DAYS} ngày warmup × ${symbols.length} symbol`
    + ` (${bars} nến 15m/symbol)...`,
  );
  const bySymbol = new Map<string, Candle[]>();
  const now = Date.now();
  for (const symbol of symbols) {
    const fetched = await fetchKlinesPaged(symbol, "15m", bars);
    const closed = fetched.filter((candle) => candle.openTime + TF_MS["15m"] <= now);
    if (closed.length < bars * 0.8) {
      console.warn(`[${symbol.toUpperCase()}] chỉ có ${closed.length}/${bars} nến; bỏ qua.`);
      continue;
    }
    bySymbol.set(symbol, closed);
  }
  if (!bySymbol.size) throw new Error("Không có symbol đủ dữ liệu");

  const periodEnd = Math.min(
    ...[...bySymbol.values()].map((c) => c[c.length - 1].openTime + TF_MS["15m"]),
  );
  const periodStart = periodEnd - days * TF_MS["1d"];

  const variants: Array<[string, KeyVolumeParams]> = [
    ["LUỒNG MỚI (đang chạy)", KEY_VOLUME_CONFIG],
    ["ĐO SIẾT: CẢ CÂY nến ngoài hộp", { ...KEY_VOLUME_CONFIG, obDepartMode: "candle" }],
    ["  ↳ chờ rời hộp 4 nến", { ...KEY_VOLUME_CONFIG, obDepartBars: 4 }],
    ["  ↳ chờ rời hộp 2 nến", { ...KEY_VOLUME_CONFIG, obDepartBars: 2 }],
    ["  ↳ chờ rời hộp 1 nến", { ...KEY_VOLUME_CONFIG, obDepartBars: 1 }],
    ["  ↳ BỎ cửa rời hộp", { ...KEY_VOLUME_CONFIG, obDepartBars: 0 }],
    ["  ↳ nới dư địa minRR 3->1,5", { ...KEY_VOLUME_CONFIG, minRR: 1.5 }],
    ["  ↳ SL luật CŨ (ngoài râu)", { ...KEY_VOLUME_CONFIG, stopMode: "sweep-window" }],
    ["  ↳ quét 1 ngày thay vì 5", { ...KEY_VOLUME_CONFIG, sweepLookback: 96 }],
    ["chỉ nhánh QUÉT", { ...KEY_VOLUME_CONFIG, enableVolumeReversalBranch: false }],
    ["chỉ nhánh KEY+NẾN", { ...KEY_VOLUME_CONFIG, enableSweepBranch: false }],
  ];

  console.log(`\n${"=".repeat(96)}`);
  console.log(
    `FX DREAM · ${new Date(periodStart).toISOString().slice(0, 10)}`
    + ` -> ${new Date(periodEnd).toISOString().slice(0, 10)}`
    + ` · ${[...bySymbol.keys()].map((s) => s.toUpperCase()).join(" ")} · risk ${riskPct}%`,
  );
  console.log("=".repeat(96));
  console.log(header());

  for (const [name, params] of variants) {
    const trades: KeyVolumeTrade[] = [];
    let placed = 0, filled = 0, retouched = 0, broken = 0;
    let levels = 0, sweeps = 0, patterns = 0, plans = 0, rejRisk = 0, rejRoom = 0, rejDepart = 0, sweepPlans = 0, volPlans = 0;
    for (const [symbol, candles] of bySymbol) {
      const result = runKeyVolume(symbol, candles, params);
      trades.push(...result.trades);
      const d = result.diagnostics;
      placed += d.boxesArmed; filled += d.entries;
      retouched += d.boxesRetouched; broken += d.boxesBroken;
      levels += d.m15Levels; sweeps += d.sweeps; patterns += d.candlePatterns;
      plans += d.plans; rejRisk += d.rejectedRisk; rejRoom += d.rejectedRoom;
      rejDepart += d.rejectedDepart;
      sweepPlans += d.sweepBranchPlans; volPlans += d.volumeBranchPlans;
    }
    console.log(row(name, summarize(trades, periodStart, periodEnd, riskPct)));
    if (params === KEY_VOLUME_CONFIG) {
      console.log(
        `${"".padEnd(30)} phễu: key ${levels} · quét ${sweeps} · cụm nến ${patterns}`
        + ` · KHÔNG rời hộp ${rejDepart} · plan ${plans}`
        + ` · loại risk ${rejRisk} · loại dư địa ${rejRoom}`,
      );
      console.log(
        `${"".padEnd(30)} plan theo nhánh: quét ${sweepPlans} · key+nến ${volPlans}`,
      );
      console.log(
        `${"".padEnd(30)} hộp canh retest: trang bị ${placed} -> quay lại ${retouched} -> vào ${filled}`
        + ` (${placed ? (100 * filled / placed).toFixed(1) : "0.0"}%)`
        + ` · hộp bị phá ${broken}`,
      );
    }
  }

  // Chi tiết luồng mới: lý do thoát và phân tách hai nhánh.
  const detail: KeyVolumeTrade[] = [];
  for (const [symbol, candles] of bySymbol) {
    detail.push(...runKeyVolume(symbol, candles, KEY_VOLUME_CONFIG).trades);
  }
  const inPeriod = detail.filter((t) => t.entryTime >= periodStart && t.entryTime < periodEnd);
  const reasons = new Map<string, number>();
  for (const trade of inPeriod) reasons.set(trade.exitReason, (reasons.get(trade.exitReason) ?? 0) + 1);
  console.log(`\nLý do thoát: ${[...reasons].map(([r, n]) => `${r}=${n}`).join(" · ")}`);
  for (const branch of ["sweep-reclaim", "volume-reversal"] as const) {
    const slice = inPeriod.filter((trade) => trade.branch === branch);
    const net = slice.reduce((sum, trade) => sum + trade.netR, 0);
    console.log(
      `  ${branch.padEnd(16)} N=${String(slice.length).padStart(4)}`
      + ` · NET ${signed(net)}R · gross ${signed(slice.reduce((s, t) => s + t.grossR, 0))}R`,
    );
  }
  const perSymbol = [...bySymbol.keys()].map((symbol) => {
    const slice = inPeriod.filter((trade) => trade.symbol === symbol);
    return `${symbol.toUpperCase()} ${signed(slice.reduce((s, t) => s + t.netR, 0))}R (${slice.length})`;
  });
  console.log(`  theo symbol: ${perSymbol.join(" · ")}`);
}

if (require.main === module && /exp-fxdream-flow\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    const detail = error as { response?: { data?: unknown }; message?: string };
    console.error("Lỗi:", detail.response?.data ?? detail.message ?? error);
    process.exit(1);
  });
}
