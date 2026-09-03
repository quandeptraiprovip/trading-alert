/**
 * Audit lại bản số hoá Key Volume theo transcript gốc của kênh.
 *
 * Mỗi biến thể tách riêng MỘT sai lệch so với phương pháp kênh dạy, để biết
 * sai lệch nào thực sự gây ra kết quả âm chứ không sửa gộp rồi đoán.
 *
 * Run:
 *   npx ts-node scripts/key-volume-method-audit.ts [days] [symbols] [riskPct]
 */
import "../load-env";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeParams,
  KeyVolumeTrade,
  runKeyVolume,
} from "../key-volume";
import { applyLeverageCap } from "../key-volume-backtest";
import { fetchKlinesPaged } from "../kline-fetch";
import { CONFIG, Candle, TF_MS, aggregate } from "../strategy";

const WARMUP_DAYS = 120;

type Variant = { name: string; overrides: Partial<KeyVolumeParams> };

/** Bản đang chạy trước audit: dư địa quét cả level M15, SL theo cửa sổ sweep. */
const LEGACY: Partial<KeyVolumeParams> = {
  targetSourceTfs: ["15m", "1h", "4h"],
  stopMode: "sweep-window",
  requireFollowThrough: false,
};

/**
 * `#50`/`Q&A003`: sau stop-hunt vào ngay theo mô hình nến, stop dưới cú trap.
 * Vào sớm như vậy nên `sweep-window` lúc này là stop NGẮN, không phải stop rộng
 * như khi phải chờ hết cú phá cấu trúc.
 */
const SFP: Partial<KeyVolumeParams> = {
  entryTrigger: "candle-pattern",
  stopMode: "sweep-window",
};

const VARIANTS: Variant[] = [
  { name: "legacy (trước audit)", overrides: LEGACY },
  { name: "mặc định hiện tại", overrides: {} },
  // Từng luật mới, cộng dồn lên mặc định hiện tại.
  { name: "+chạm lần 2 mới vào", overrides: { requireSecondTouch: true } },
  { name: "+hai đỉnh/hai đáy", overrides: { requireDoubleTopBottom: true } },
  { name: "+phiên Mỹ", overrides: { sessionHoursUtc: [13, 21] } },
  { name: "+vào lại khi retouch", overrides: { reentryMode: "volume-retouch" } },
  { name: "+gate Daily trap (#31)", overrides: { requireDailyTrapGate: true } },
  // Entry theo SFP thay vì chờ BOS.
  { name: "SFP: vào theo mô hình nến", overrides: SFP },
  { name: "  + chạm lần 2", overrides: { ...SFP, requireSecondTouch: true } },
  { name: "  + hai đỉnh/hai đáy", overrides: { ...SFP, requireDoubleTopBottom: true } },
  { name: "  + phiên Mỹ", overrides: { ...SFP, sessionHoursUtc: [13, 21] } },
  { name: "  + gate Daily trap", overrides: { ...SFP, requireDailyTrapGate: true } },
  {
    name: "  + vào lại retouch",
    overrides: { ...SFP, reentryMode: "volume-retouch" },
  },
  {
    name: "SFP + tất cả luật mới",
    overrides: {
      ...SFP,
      requireSecondTouch: true,
      requireDoubleTopBottom: true,
      sessionHoursUtc: [13, 21],
      requireDailyTrapGate: true,
      reentryMode: "volume-retouch",
    },
  },
];

function summarize(
  trades: KeyVolumeTrade[],
  start: number,
  end: number,
  riskPct: number,
  maxLeverage: number,
): string {
  const raw = trades.filter((t) => t.entryTime >= start && t.entryTime < end);
  const capped = raw.map((t) => applyLeverageCap(t, riskPct, maxLeverage));
  if (!capped.length) return `${"0".padStart(5)}       —        —        —        —`;
  const gross = capped.reduce((s, t) => s + t.grossR, 0);
  const cost = capped.reduce((s, t) => s + t.costR, 0);
  const net = gross - cost;
  const wins = capped.filter((t) => t.netR > 0).length;
  const medianRisk = (() => {
    const v = raw
      .map((t) => 100 * Math.abs(t.entryPrice - t.initialSL) / t.entryPrice)
      .sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  })();
  return [
    String(capped.length).padStart(5),
    `${(100 * wins / capped.length).toFixed(0)}%`.padStart(6),
    `${gross >= 0 ? "+" : ""}${gross.toFixed(1)}`.padStart(9),
    `${net >= 0 ? "+" : ""}${net.toFixed(1)}`.padStart(9),
    (net / capped.length).toFixed(3).padStart(8),
    `${medianRisk.toFixed(3)}%`.padStart(9),
  ].join(" ");
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "500", 10);
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const riskPct = parseFloat(process.argv[4] ?? "1");
  const maxLeverage = parseFloat(process.env.LEVERAGE ?? "10");

  const totalBars = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["5m"]) + 12;
  const baseBySymbol = new Map<string, Candle[]>();
  console.log(`Tải ${days}d + ${WARMUP_DAYS}d warmup × ${symbols.length} symbol...`);
  for (const symbol of symbols) {
    baseBySymbol.set(symbol, await fetchKlinesPaged(symbol, "5m", totalBars));
  }
  const periodEnd = Math.min(
    ...[...baseBySymbol.values()].map((c) => c[c.length - 1].openTime + TF_MS["5m"]),
  );
  const periodStart = periodEnd - days * TF_MS["1d"];

  console.log(
    `\n${new Date(periodStart).toISOString().slice(0, 10)}`
    + ` -> ${new Date(periodEnd).toISOString().slice(0, 10)}`
    + ` | ${symbols.join(",")} | risk ${riskPct}% | cap ${maxLeverage}x\n`,
  );
  console.log(
    `${"Biến thể".padEnd(24)} ${"N".padStart(5)} ${"WR".padStart(6)}`
    + ` ${"GROSS R".padStart(9)} ${"NET R".padStart(9)} ${"exp".padStart(8)}`
    + ` ${"SL med".padStart(9)}`,
  );
  for (const variant of VARIANTS) {
    const params: KeyVolumeParams = { ...KEY_VOLUME_CONFIG, ...variant.overrides };
    const trades: KeyVolumeTrade[] = [];
    for (const [symbol, base] of baseBySymbol) {
      trades.push(...runKeyVolume(symbol, aggregate(base, "15m", "5m"), params).trades);
    }
    console.log(
      `${variant.name.padEnd(24)}`
      + ` ${summarize(trades, periodStart, periodEnd, riskPct, maxLeverage)}`,
    );
  }
  console.log(
    "\nSL med = trung vị |entry-SL|/entry. Legacy lọc ra toàn stop siêu ngắn"
    + " nên chi phí/R nổ và bị nhiễu quét.",
  );
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
