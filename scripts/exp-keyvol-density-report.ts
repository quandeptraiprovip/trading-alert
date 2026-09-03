/**
 * Số liệu cho báo cáo trực quan "key volume đang được xác định thế nào".
 *
 * In đúng những gì cần để người đọc tự thấy vấn đề mật độ:
 *   1. quét ngưỡng volume: mật độ key/ngày, số key CÒN SỐNG cùng lúc,
 *      và khoảng cách trung vị giữa hai key liền kề tính bằng ATR(M15).
 *   2. đối chứng GIẢ: lấy 500 điểm (thời gian, giá) TUỲ Ý, hỏi "có key ở gần
 *      không". Ngưỡng nào còn cho 100% thì ở ngưỡng đó "gần key" là phát biểu
 *      rỗng — mọi chỗ trên chart đều gần key.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-density-report.ts [symbol] [days]
 */
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeLevel,
  atrSeriesForward,
  detectKeyVolumeLevels,
  isKeyVolumeLevelActive,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { TF_MS } from "../strategy";

const MULTS = [2, 3, 4, 5, 6, 8, 10, 12, 16];
const PLACEBO_POINTS = 500;
const MATCH_ATR = 0.3;
/** User tự vẽ 6 mức trong 62 ngày ≈ 1 mức / 10 ngày. */
const HUMAN_PER_DAY = 0.1;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? "btcusdt";
  const days = Number(process.argv[3] ?? 250);
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + 800;
  const m15 = await fetchKlinesPaged(symbol, "15m", bars);
  const atr = atrSeriesForward(m15);
  const spanDays = (m15[m15.length - 1].openTime - m15[0].openTime) / TF_MS["1d"];

  // Điểm TUỲ Ý: nến ngẫu nhiên, giá ngẫu nhiên trong biên nến đó.
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const probes = Array.from({ length: PLACEBO_POINTS }, () => {
    const index = 400 + Math.floor(rand() * (m15.length - 500));
    const candle = m15[index];
    return { index, time: candle.openTime, price: candle.low + rand() * (candle.high - candle.low) };
  });

  console.log(`\n${symbol.toUpperCase()} · ${spanDays.toFixed(0)} ngày M15 (${m15.length} nến)`);
  console.log(`cửa sổ có tâm ${KEY_VOLUME_CONFIG.volumeLookback} nến · key sống ${KEY_VOLUME_CONFIG.keyMaxAgeDays} ngày`);
  console.log(`mốc người: user vẽ ~${HUMAN_PER_DAY}/ngày (6 mức / 62 ngày)\n`);
  console.log("  ×vol │ key/ngày │ so người │ key SỐNG cùng lúc │ cách nhau (ATR) │ 500 điểm TUỲ Ý có key gần");
  console.log("  ─────┼──────────┼──────────┼───────────────────┼─────────────────┼──────────────────────────");

  for (const mult of MULTS) {
    const levels: KeyVolumeLevel[] = detectKeyVolumeLevels(m15, "15m", {
      ...KEY_VOLUME_CONFIG,
      volumeSpikeMult: mult,
    });
    const perDay = levels.length / spanDays;

    // Số key còn sống, và khoảng cách giữa hai key liền kề, chấm ở các điểm probe.
    const aliveCounts: number[] = [];
    const gaps: number[] = [];
    let nearHits = 0;
    for (const probe of probes) {
      const alive = levels
        .filter((level) => isKeyVolumeLevelActive(level, probe.time))
        .map((level) => level.price)
        .sort((a, b) => a - b);
      aliveCounts.push(alive.length);
      const unit = atr[probe.index];
      if (alive.length > 1 && unit > 0) {
        const stepped: number[] = [];
        for (let i = 1; i < alive.length; i++) stepped.push((alive[i] - alive[i - 1]) / unit);
        gaps.push(median(stepped));
      }
      if (unit > 0 && alive.some((price) => Math.abs(price - probe.price) <= MATCH_ATR * unit)) {
        nearHits++;
      }
    }

    console.log(
      `  ×${String(mult).padStart(3)} │ ${perDay.toFixed(2).padStart(8)} │`
      + ` ${(perDay / HUMAN_PER_DAY).toFixed(0).padStart(6)}× │`
      + ` ${median(aliveCounts).toFixed(0).padStart(17)} │`
      + ` ${median(gaps).toFixed(3).padStart(15)} │`
      + ` ${(100 * nearHits / PLACEBO_POINTS).toFixed(1).padStart(6)}%`,
    );
  }
  console.log(`\n"có key gần" = trong ±${MATCH_ATR} ATR(M15). Cột cuối là SÀN NHIỄU: ở ngưỡng nào`);
  console.log(`nó còn ~100% thì ở đó câu "giá phản ứng tại key" không phân biệt được với ngẫu nhiên.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
