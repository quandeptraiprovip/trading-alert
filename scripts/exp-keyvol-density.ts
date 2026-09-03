/**
 * CỬA 1b — MẬT ĐỘ KEY: ở ngưỡng nào thì "có key gần đây" mới còn là một phát biểu có nội dung?
 *
 * Cửa 1 cho thấy ngưỡng đang chạy (`volumeSpikeMult = 2` trên M15) sinh ~20 key/ngày/coin:
 * 100% điểm (thời gian, giá) TUỲ Ý cũng có key ở gần, trung vị 81 key trong ±0,3 ATR.
 * Ở mật độ đó, mọi phép đo "giá phản ứng tại key" đều đang đo một vật thể phủ kín mặt phẳng giá
 * — không phải một mức.
 *
 * Phép này quét ngưỡng và in ba số cạnh nhau ở mỗi bậc:
 *   · mật độ key (key/ngày) và mốc người: user vẽ 6 mức trong 62 ngày ≈ 1 mức / 10 ngày
 *   · tỉ lệ "có key gần" ở 500 điểm TUỲ Ý (đối chứng giả) — sàn nhiễu thật của phép đo
 *   · tỉ lệ đó ở 6 điểm USER VẼ, kèm chênh lệch
 *
 * Chỉ khi đối chứng giả rơi khỏi 100% thì con số của user mới có nghĩa.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-density.ts [days]
 */
import fs from "fs";
import path from "path";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeLevel,
  atrSeriesForward,
  detectKeyVolumeLevels,
  isKeyVolumeLevelActive,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { TF_MS, aggregate } from "../strategy";

const SYMBOL = "btcusdt";
const MATCH_ATR = 0.3;
const MULTS = [2, 3, 4, 5, 6, 8, 10, 12];
const PLACEBO_POINTS = 500;

function loadManualPoints(): { time: number; price: number }[] {
  const file = path.resolve("trading-runtime/chart-playbook", `${SYMBOL}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    sampleOrders?: Record<string, unknown>[];
  };
  return (raw.sampleOrders ?? [])
    .map((order) => ({ time: Number(order.entryTime), price: Number(order.entry) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price))
    .sort((a, b) => a.time - b.time);
}

/**
 * Định nghĩa Key CHẶT NHẤT từng đo được trong repo ([[key-maturation-rule]]): key chỉ thành key sau
 * chu trình RỜI ĐI → QUAY LẠI CHẠM → BẬT RA. Bản gốc `confirmByReaction` trong
 * `scripts/exp-key-reaction.ts` gắn cứng khung 4h nên không dùng lại trực tiếp được; đây là đúng
 * chu trình đó, tính trên nến M15 và chỉ dùng dữ liệu tới lúc xác nhận (không lookahead).
 */
function confirmByReactionM15(
  candles: { openTime: number; high: number; low: number; close: number }[],
  levels: KeyVolumeLevel[],
  atr: number[],
  awayAtr = 1,
  bounceAtr = 1,
  reactBars = 6,
  maxWaitBars = 672,
): (KeyVolumeLevel & { usableAt: number })[] {
  const index = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) index.set(candles[i].openTime, i);
  const out: (KeyVolumeLevel & { usableAt: number })[] = [];

  for (const level of levels) {
    const event = index.get(level.eventTime);
    if (event === undefined) continue;
    let side = 0; // +1 = giá rời lên trên vùng, −1 = rời xuống dưới
    const limit = Math.min(event + maxWaitBars, candles.length - 1);
    for (let i = event + 1; i <= limit; i++) {
      const candle = candles[i];
      const a = atr[i];
      if (!(a > 0)) continue;
      if (side === 0) {
        if (candle.close > level.zoneHigh + awayAtr * a) side = 1;
        else if (candle.close < level.zoneLow - awayAtr * a) side = -1;
        continue;
      }
      const touched = side === 1 ? candle.low <= level.zoneHigh : candle.high >= level.zoneLow;
      if (!touched) continue;
      if (side === 1 ? candle.close < level.zoneLow : candle.close > level.zoneHigh) break; // đóng xuyên ⇒ chết
      let usableAt = 0;
      for (let j = i + 1; j <= Math.min(i + reactBars, candles.length - 1); j++) {
        const next = candles[j];
        const bounced = side === 1
          ? next.high >= level.zoneHigh + bounceAtr * a
          : next.low <= level.zoneLow - bounceAtr * a;
        if (bounced) {
          usableAt = next.openTime;
          break;
        }
        if (side === 1 ? next.close < level.zoneLow : next.close > level.zoneHigh) break;
      }
      if (usableAt) out.push({ ...level, usableAt });
      break; // chỉ xét cú chạm lại ĐẦU TIÊN
    }
  }
  return out;
}

function nearCount(levels: KeyVolumeLevel[], time: number, price: number, tolerance: number): number {
  let count = 0;
  for (const level of levels) {
    if (!isKeyVolumeLevelActive(level, time)) continue;
    if (price >= level.zoneLow && price <= level.zoneHigh) {
      count += 1;
      continue;
    }
    const gap = Math.min(Math.abs(price - level.zoneLow), Math.abs(price - level.zoneHigh));
    if (gap <= tolerance) count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const manual = loadManualPoints();
  const base = await fetchKlinesPaged(SYMBOL, "5m", Math.ceil((days * TF_MS["1d"]) / TF_MS["5m"]));
  const m15 = aggregate(base, "15m", "5m");
  const atrSeries = atrSeriesForward(m15, 14);
  const atrAt = (time: number): number => {
    let index = -1;
    for (let i = 0; i < m15.length && m15[i].openTime <= time; i++) index = i;
    return index >= 0 ? atrSeries[index] : 0;
  };
  const spanDays = (m15[m15.length - 1].openTime - m15[0].openTime) / TF_MS["1d"];
  const manualSpanDays = (manual[manual.length - 1].time - manual[0].time) / TF_MS["1d"];

  let seed = 20260828;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pool = m15.filter((candle) => candle.openTime >= manual[0].time);
  const placeboPoints: { time: number; price: number }[] = [];
  for (let i = 0; i < PLACEBO_POINTS; i++) {
    const candle = pool[Math.floor(random() * pool.length)];
    placeboPoints.push({ time: candle.openTime, price: candle.close });
  }

  console.log(
    `${SYMBOL.toUpperCase()} · nến 15m ${m15.length} · ${spanDays.toFixed(0)} ngày`
    + ` · mốc người: ${manual.length} mức trong ${manualSpanDays.toFixed(0)} ngày`
    + ` = 1 mức / ${(manualSpanDays / manual.length).toFixed(1)} ngày\n`,
  );
  console.log(
    `${"spike×".padStart(6)} ${"key".padStart(7)} ${"key/ngày".padStart(9)}`
    + ` ${"1 key mỗi".padStart(10)} ${"GIẢ có key".padStart(11)} ${"GIẢ sl.key".padStart(11)}`
    + ` ${"USER có key".padStart(12)} ${"chênh".padStart(7)}`,
  );

  for (const mult of MULTS) {
    const params = { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult };
    const levels = detectKeyVolumeLevels(m15, "15m", params);
    const perDay = levels.length / spanDays;
    const hit = (points: { time: number; price: number }[]): { rate: number; median: number } => {
      const counts = points.map((point) => nearCount(levels, point.time, point.price, MATCH_ATR * atrAt(point.time)));
      const sorted = [...counts].sort((a, b) => a - b);
      return {
        rate: (100 * counts.filter((count) => count > 0).length) / counts.length,
        median: sorted[Math.floor(sorted.length / 2)],
      };
    };
    const placebo = hit(placeboPoints);
    const user = hit(manual);
    console.log(
      `${String(mult).padStart(6)} ${String(levels.length).padStart(7)}`
      + ` ${perDay.toFixed(2).padStart(9)}`
      + ` ${`${(1 / perDay).toFixed(1)}d`.padStart(10)}`
      + ` ${`${placebo.rate.toFixed(1)}%`.padStart(11)}`
      + ` ${String(placebo.median).padStart(11)}`
      + ` ${`${user.rate.toFixed(1)}%`.padStart(12)}`
      + ` ${`${(user.rate - placebo.rate).toFixed(1)}`.padStart(7)}`,
    );
  }
  console.log(
    "\nGIẢ = 500 điểm (thời gian, giá) tuỳ ý cùng kỳ. Chênh chỉ có nghĩa khi cột GIẢ đã rời 100%."
    + `\nn=${manual.length} ⇒ mỗi ca sai lệch 16,7 điểm phần trăm; đừng đọc chênh nhỏ hơn ~33 điểm.`,
  );

  console.log(
    "\n═══ Định nghĩa CHÍN: rời 1×ATR → quay lại chạm → bật 1×ATR trong 6 nến ═══",
  );
  console.log(
    `${"spike×".padStart(6)} ${"key thô".padStart(8)} ${"key chín".padStart(9)} ${"còn lại".padStart(8)}`
    + ` ${"key/ngày".padStart(9)} ${"GIẢ có key".padStart(11)} ${"USER có key".padStart(12)} ${"chênh".padStart(7)}`,
  );
  for (const mult of MULTS) {
    const params = { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult };
    const raw = detectKeyVolumeLevels(m15, "15m", params);
    const confirmed = confirmByReactionM15(m15, raw, atrSeries);
    const hit = (points: { time: number; price: number }[]): number => {
      const counts = points.map((point) =>
        confirmed.filter(
          (level) =>
            level.usableAt <= point.time
            && isKeyVolumeLevelActive(level, point.time)
            && (point.price >= level.zoneLow && point.price <= level.zoneHigh
              ? true
              : Math.min(
                Math.abs(point.price - level.zoneLow),
                Math.abs(point.price - level.zoneHigh),
              ) <= MATCH_ATR * atrAt(point.time)),
        ).length,
      );
      return (100 * counts.filter((count) => count > 0).length) / counts.length;
    };
    const placeboRate = hit(placeboPoints);
    const userRate = hit(manual);
    console.log(
      `${String(mult).padStart(6)} ${String(raw.length).padStart(8)} ${String(confirmed.length).padStart(9)}`
      + ` ${`${((100 * confirmed.length) / Math.max(1, raw.length)).toFixed(0)}%`.padStart(8)}`
      + ` ${(confirmed.length / spanDays).toFixed(2).padStart(9)}`
      + ` ${`${placeboRate.toFixed(1)}%`.padStart(11)}`
      + ` ${`${userRate.toFixed(1)}%`.padStart(12)}`
      + ` ${`${(userRate - placeboRate).toFixed(1)}`.padStart(7)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
