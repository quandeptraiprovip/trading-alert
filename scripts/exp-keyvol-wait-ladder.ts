/**
 * Trần chờ hộp có phải một hiệu ứng THẬT? Thang bậc + chia đôi kỳ.
 *
 * Thang không đơn điệu và đổi dấu giữa hai nửa kỳ ⇒ nhiễu, không phải edge.
 * Chạy: npx ts-node scripts/exp-keyvol-wait-ladder.ts [days]
 */
import { KEY_VOLUME_CONFIG, runKeyVolume } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS } from "../strategy";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];
const WAITS = [48, 96, 192, 288, 384, 576, 960, 10 ** 7];

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
  const mult = Number(process.argv[3] ?? KEY_VOLUME_CONFIG.volumeSpikeMult);
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + 800;
  const data = new Map<string, Candle[]>();
  let latest = 0;
  for (const symbol of SYMBOLS) {
    const candles = await fetchKlinesPaged(symbol, "15m", bars);
    data.set(symbol, candles);
    latest = Math.max(latest, candles[candles.length - 1].openTime);
  }
  const end = latest + TF_MS["15m"];
  const start = end - days * TF_MS["1d"];
  const mid = start + (end - start) / 2;

  console.log(`\nTRẦN CHỜ HỘP · ${days} ngày · ${SYMBOLS.length} coin · ngưỡng ×${mult}\n`);
  console.log("  chờ (ngày) │ lệnh │  gross │ nửa ĐẦU │ nửa SAU │ cùng dấu?");
  console.log("  ───────────┼──────┼────────┼─────────┼─────────┼──────────");

  for (const wait of WAITS) {
    let n = 0, gross = 0, g1 = 0, g2 = 0;
    for (const [symbol, candles] of data) {
      for (const t of runKeyVolume(symbol, candles, { ...KEY_VOLUME_CONFIG, boxWaitBars: wait, volumeSpikeMult: mult }).trades) {
        if (t.entryTime < start) continue;
        n++; gross += t.grossR;
        if (t.entryTime < mid) g1 += t.grossR; else g2 += t.grossR;
      }
    }
    const label = wait > 10 ** 6 ? "vô hạn" : (wait / 96).toString();
    const agree = Math.sign(g1) === Math.sign(g2) && g1 !== 0 ? "CÓ" : "không";
    console.log(
      `  ${label.padStart(10)} │ ${String(n).padStart(4)} │ ${gross.toFixed(1).padStart(6)} │`
      + ` ${g1.toFixed(1).padStart(7)} │ ${g2.toFixed(1).padStart(7)} │ ${agree}`,
    );
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
