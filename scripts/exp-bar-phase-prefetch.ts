/**
 * Prefetch nến 1h cho rổ lõi, dùng cho `scripts/exp-bar-phase.ts` (dựng nến 4h lệch pha).
 *
 * Tải một mạch bằng concurrency mặc định sẽ dính 429 của Binance. Ở đây: mỗi symbol một lần, thử
 * lại có backoff, và cache đĩa giữ tiến độ nên chạy lại là tiếp tục chứ không tải lại từ đầu.
 *
 * Run: KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-bar-phase-prefetch.ts [days]
 */
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { CORE8 } from "./exp-breadth";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const bars = days * 24 + 3000;
  for (const s of CORE8) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const c = await fetchFuturesKlinesPaged(s, "1h", bars);
        console.log(`${s.toUpperCase()}: ${c.length} nến 1h, từ ${new Date(c[0]?.openTime).toISOString().slice(0, 10)}`);
        break;
      } catch (e: any) {
        const st = e?.response?.status ?? e?.message;
        const backoff = 15_000 * attempt;
        console.log(`${s.toUpperCase()}: lỗi ${st} (lần ${attempt}/6) — chờ ${backoff / 1000}s rồi thử lại`);
        if (attempt === 6) console.log(`${s.toUpperCase()}: BỎ QUA`);
        else await wait(backoff);
      }
    }
    await wait(3000); // nghỉ giữa các symbol cho hạ weight
  }
}

main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
