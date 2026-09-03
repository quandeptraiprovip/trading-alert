/**
 * Tách công/tội hai cửa mới của CỤM ĐẢO CHIỀU:
 *   · `requireKeyInsideBlock` — key phải nằm trong thân hộp,
 *   · `keyDepartureLookback`  — giá phải TỪNG rời key rồi mới quay về.
 *
 * Đo RIÊNG nhánh key: nhánh quét không đi qua hai cửa này, để chung sẽ pha
 * loãng tín hiệu. Kèm chia đôi kỳ, vì cửa 1 phiên trước đã cho thấy gross ở
 * cửa sổ này không ổn định.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-cluster-gates.ts [days]
 */
import { KEY_VOLUME_CONFIG, KeyVolumeParams, runKeyVolume } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS } from "../strategy";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
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

  const variants: Array<[string, Partial<KeyVolumeParams>]> = [
    ["cả hai cửa TẮT", { requireKeyInsideBlock: false, keyDepartureLookback: 0 }],
    ["chỉ KEY TRONG HỘP", { requireKeyInsideBlock: true, keyDepartureLookback: 0 }],
    ["chỉ PHẢI RỜI KEY", { requireKeyInsideBlock: false, keyDepartureLookback: 20 }],
    ["cả hai BẬT (đang chạy)", { requireKeyInsideBlock: true, keyDepartureLookback: 20 }],
  ];

  console.log(`\nCỬA CỤM ĐẢO CHIỀU · ${days} ngày · ${SYMBOLS.length} coin · CHỈ nhánh key\n`);
  console.log("  biến thể                 │  cụm │ plan │ lệnh │    WR │  gross │ nửa ĐẦU │ nửa SAU │ cùng dấu");
  console.log("  ─────────────────────────┼──────┼──────┼──────┼───────┼────────┼─────────┼─────────┼─────────");

  for (const [name, override] of variants) {
    // Tắt nhánh quét để cô lập đúng phần luật này chạm tới.
    const params: KeyVolumeParams = {
      ...KEY_VOLUME_CONFIG, ...override, enableSweepBranch: false,
    };
    let clusters = 0, plans = 0, n = 0, wins = 0, gross = 0, g1 = 0, g2 = 0;
    for (const [symbol, candles] of data) {
      const r = runKeyVolume(symbol, candles, params);
      clusters += r.diagnostics.candlePatterns;
      plans += r.diagnostics.volumeBranchPlans;
      for (const t of r.trades) {
        if (t.entryTime < start) continue;
        n++; if (t.netR > 0) wins++;
        gross += t.grossR;
        if (t.entryTime < mid) g1 += t.grossR; else g2 += t.grossR;
      }
    }
    const agree = n > 0 && Math.sign(g1) === Math.sign(g2) ? "CÓ" : "không";
    console.log(
      `  ${name.padEnd(24)} │ ${String(clusters).padStart(4)} │ ${String(plans).padStart(4)} │`
      + ` ${String(n).padStart(4)} │ ${(n ? 100 * wins / n : 0).toFixed(1).padStart(4)}% │`
      + ` ${gross.toFixed(1).padStart(6)} │ ${g1.toFixed(1).padStart(7)} │ ${g2.toFixed(1).padStart(7)} │ ${agree}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
