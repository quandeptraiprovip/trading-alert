/**
 * Tách công/tội của HAI thay đổi 02/09: ngưỡng key ×2 -> ×4, và trần chờ hộp
 * vô hạn -> 2 ngày. Bốn tổ hợp, cùng dữ liệu, cùng mọi tham số khác.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-ablation-2x4x.ts [days]
 */
import { KEY_VOLUME_CONFIG, KeyVolumeParams, runKeyVolume } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS } from "../strategy";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];
const HUGE = 10 ** 7;

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + 800;
  const data = new Map<string, Candle[]>();
  for (const symbol of SYMBOLS) data.set(symbol, await fetchKlinesPaged(symbol, "15m", bars));

  const variants: Array<[string, Partial<KeyVolumeParams>]> = [
    ["×2 · chờ vô hạn (bản 1)", { volumeSpikeMult: 2, boxWaitBars: HUGE }],
    ["×2 · chờ 2 ngày", { volumeSpikeMult: 2, boxWaitBars: 192 }],
    ["×4 · chờ vô hạn", { volumeSpikeMult: 4, boxWaitBars: HUGE }],
    ["×4 · chờ 2 ngày (ĐANG CHẠY)", { volumeSpikeMult: 4, boxWaitBars: 192 }],
    ["×3 · chờ 2 ngày", { volumeSpikeMult: 3, boxWaitBars: 192 }],
    ["×4 · chờ 1 ngày", { volumeSpikeMult: 4, boxWaitBars: 96 }],
    ["×4 · chờ 4 ngày", { volumeSpikeMult: 4, boxWaitBars: 384 }],
  ];

  console.log(`\n${days} ngày M15 · ${SYMBOLS.length} coin · mọi tham số khác giữ nguyên\n`);
  console.log("  biến thể                       │   key │  lệnh │    WR │  gross │    net │ phí/lệnh │ SL%");
  console.log("  ───────────────────────────────┼───────┼───────┼───────┼────────┼────────┼──────────┼──────");

  for (const [name, override] of variants) {
    const params: KeyVolumeParams = { ...KEY_VOLUME_CONFIG, ...override };
    let keys = 0, n = 0, wins = 0, gross = 0, net = 0, cost = 0;
    const stops: number[] = [];
    for (const [symbol, candles] of data) {
      const r = runKeyVolume(symbol, candles, params);
      keys += r.diagnostics.m15Levels;
      n += r.trades.length;
      wins += r.trades.filter((t) => t.netR > 0).length;
      for (const t of r.trades) {
        gross += t.grossR; net += t.netR; cost += t.costR;
        stops.push(100 * Math.abs(t.entryPrice - t.initialSL) / t.entryPrice);
      }
    }
    const med = stops.length
      ? [...stops].sort((a, b) => a - b)[Math.floor(stops.length / 2)]
      : 0;
    console.log(
      `  ${name.padEnd(30)} │ ${String(keys).padStart(5)} │ ${String(n).padStart(5)} │`
      + ` ${(n ? 100 * wins / n : 0).toFixed(1).padStart(4)}% │`
      + ` ${gross.toFixed(1).padStart(6)} │ ${net.toFixed(1).padStart(6)} │`
      + ` ${(n ? cost / n : 0).toFixed(3).padStart(8)} │ ${med.toFixed(3)}`,
    );
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
