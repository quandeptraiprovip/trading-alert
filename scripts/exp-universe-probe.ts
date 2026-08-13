/**
 * exp-universe-probe.ts — liệt kê ngày niêm yết + độ sâu lịch sử của các ứng viên mở rộng rổ.
 *
 * Mục đích: chọn rổ mở rộng THEO NGÀY NIÊM YẾT (point-in-time) chứ không theo vốn hoá hôm nay,
 * để giảm survivorship bias. In ra để người đọc tự kiểm chứng ứng viên nào đủ lịch sử.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-universe-probe.ts
 */
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { TF_MS } from "../strategy";

const CANDIDATES = [
  // rổ hiện tại
  "btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt",
  // majors niêm yết sớm (2019-2020) — gồm cả những coin nay đã tụt hạng (giảm survivorship bias)
  "linkusdt", "ltcusdt", "bchusdt", "etcusdt", "eosusdt", "trxusdt", "xlmusdt", "atomusdt",
  "filusdt", "uniusdt", "aaveusdt", "algousdt", "vetusdt", "neousdt", "iotausdt", "zecusdt",
  "dashusdt", "xmrusdt", "compusdt", "sushiusdt", "yfiusdt", "snxusdt", "crvusdt", "omgusdt",
  "qtumusdt", "zilusdt", "batusdt", "ontusdt", "iostusdt", "thetausdt", "enjusdt", "ksmusdt",
  // niêm yết 2021 (có mặt gần hết kỳ đo)
  "maticusdt", "nearusdt", "ftmusdt", "sandusdt", "manausdt", "grtusdt", "axsusdt", "icpusdt",
  "egldusdt", "chzusdt", "onemusdt", "hbarusdt", "rvnusdt", "galausdt", "lrcusdt", "arusdt",
];

async function main() {
  const rows: { sym: string; bars: number; first: string; last: string }[] = [];
  for (const s of CANDIDATES) {
    try {
      const c = await fetchFuturesKlinesPaged(s, "4h", 13000);
      if (!c.length) continue;
      rows.push({
        sym: s,
        bars: c.length,
        first: new Date(c[0].openTime).toISOString().slice(0, 10),
        last: new Date(c[c.length - 1].openTime).toISOString().slice(0, 10),
      });
    } catch {
      rows.push({ sym: s, bars: 0, first: "—", last: "KHÔNG TẢI ĐƯỢC" });
    }
  }
  rows.sort((a, b) => (a.first === b.first ? b.bars - a.bars : a.first.localeCompare(b.first)));
  console.log("\nsymbol        nến 4h   từ           đến         ~ngày");
  console.log("-".repeat(60));
  for (const r of rows) {
    const days = (r.bars * TF_MS["4h"]) / TF_MS["1d"];
    console.log(`${r.sym.padEnd(12)} ${String(r.bars).padStart(6)}   ${r.first}   ${r.last}  ${days.toFixed(0).padStart(5)}`);
  }
  const pre2021 = rows.filter((r) => r.first <= "2021-01-01" && r.bars > 3000);
  console.log(`\nCó lịch sử từ trước 2021-01-01 (đủ cho cả 3 era): ${pre2021.length} coin`);
  console.log(pre2021.map((r) => `"${r.sym}"`).join(", "));
}

main().catch((e) => {
  console.error("Lỗi:", e?.message ?? e);
  process.exit(1);
});
