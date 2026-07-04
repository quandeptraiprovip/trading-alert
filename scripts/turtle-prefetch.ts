/**
 * Prefetch 4h klines cho các symbol ứng viên mở rộng rổ Turtle (cache đĩa).
 * Run: ./node_modules/.bin/ts-node scripts/turtle-prefetch.ts [soNgay]
 */
import { TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../backtest";

const CANDIDATES = [
  "linkusdt", "trxusdt", "ltcusdt", "bchusdt", "dotusdt", "suiusdt", "aptusdt",
  "nearusdt", "atomusdt", "uniusdt", "filusdt", "opusdt", "injusdt", "etcusdt",
];

async function main() {
  const DAYS = parseInt(process.argv[2] ?? "1050", 10);
  const bpd = TF_MS["1d"] / TF_MS["4h"];
  const totalBars = Math.ceil(DAYS * bpd) + 100;
  for (const s of CANDIDATES) {
    try {
      const c = await fetchKlinesPaged(s, "4h", totalBars);
      console.log(`${s.toUpperCase()}: ${c.length} nến 4h (~${Math.round(c.length / bpd)}d), từ ${new Date(c[0]?.openTime).toISOString().slice(0, 10)}`);
    } catch (e: any) {
      console.log(`${s.toUpperCase()}: LỖI ${e?.response?.status ?? e.message}`);
    }
  }
}
main();
