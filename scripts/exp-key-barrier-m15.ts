/**
 * CỬA 3 — CẤU TRÚC RÀO ở M15. Bắt buộc dù Cửa 2 đã null.
 *
 * Lỗ hổng của Cửa 2: nó đo TRUNG BÌNH bước giá, nhưng hệ có stop và target là bài toán
 * **first-passage** — hai phân phối CÙNG trung bình vẫn cho kỳ vọng R khác hẳn, vì stop cắt cụt
 * đuôi trái còn target cắt cụt đuôi phải. "Trung bình ≈ 0" KHÔNG đủ bác bỏ một hệ stop/target.
 *
 * Rào dựng đúng cấu hình TAY của user (đo ở Cửa 1, không phải giả định):
 *   · vào ở close nến chạm key, theo chiều BẬT LẠI
 *   · R = 2,1 × ATR(M15) — trung vị stop thật của user
 *   · target = 4R — trung vị target thật của user
 *   · nến chạm cả hai ⇒ tính STOP trước; trần giữ 7 ngày (maxHoldBars của KEY_VOLUME_CONFIG)
 *   · phí 0,246 R/lệnh (Cửa 0)
 *
 * BỐN NHÓM, cùng một bộ máy thoát:
 *   spike  — key thật · normal — nến volume bình thường · syn — mức GIẢ dời 0,7 ATR
 *   random — vào lệnh NGẪU NHIÊN (bar ngẫu nhiên, chiều tung đồng xu). BẮT BUỘC: vào ngẫu nhiên
 *            với bộ máy thoát tốt từng đạt Sharpe 1,19 trong repo này ⇒ không vượt nhóm này thì
 *            "key" không đóng góp gì.
 *
 * MỐC NULL TỰ CHUẨN: bước ngẫu nhiên không trôi cho gộp R = 0 và WR = 1/(1+k) = 19,8% ở k=4.
 * NGƯỠNG ĐẬU (Cửa 0): WR_key ≥ 1,246 × WR_random VÀ WR_key > WR_syn ngoài biên.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-key-barrier-m15.ts [days] [symbols]
 */
import { KEY_VOLUME_CONFIG as P } from "../key-volume";
import { Candle, TF_MS } from "../strategy";
import { Kind, PASS_BY_MARKET, Rung, atr14, loadM15, medianOf, usableFrom } from "./exp-key-premise-m15";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const STOP_ATR = 2.1;       // R thật của user (Cửa 1)
const TARGET_R = 4;         // target thật của user (Cửa 1)
let COST_R = PASS_BY_MARKET.crypto; // phí/R (Cửa 0) — đổi sang mức vàng khi chạy XAUUSD
const MAX_HOLD = 4 * 24 * 7; // 7 ngày ở M15
const MAX_LEVELS = 6000;
const DEFAULT_MULTS = [2, 6, 12];
const RUNGS: Rung[] = ["R0", "R4"];

interface Book { n: number; wins: number; sumR: number; sumSq: number }
const empty = (): Book => ({ n: 0, wins: 0, sumR: 0, sumSq: 0 });
function record(book: Book, r: number): void {
  book.n += 1;
  book.sumR += r;
  book.sumSq += r * r;
  if (r > 0) book.wins += 1;
}
const wr = (b: Book): number => (b.n ? (100 * b.wins) / b.n : 0);
const expectancy = (b: Book): number => (b.n ? b.sumR / b.n : 0);
function ciWr(b: Book): number {
  if (!b.n) return Infinity;
  const p = b.wins / b.n;
  return 100 * 1.96 * Math.sqrt(Math.max(1e-9, (p * (1 - p)) / b.n));
}

/** Đi qua rào từ nến vào lệnh. Trả về R gộp. Nến chạm cả hai ⇒ STOP trước. */
function walkBarrier(c: Candle[], entryIndex: number, dir: number, risk: number): number | null {
  if (!(risk > 0)) return null;
  const entry = c[entryIndex].close;
  const stop = entry - dir * risk;
  const target = entry + dir * TARGET_R * risk;
  const end = Math.min(c.length - 1, entryIndex + MAX_HOLD);
  for (let i = entryIndex + 1; i <= end; i++) {
    const hitStop = dir > 0 ? c[i].low <= stop : c[i].high >= stop;
    if (hitStop) return -1;
    const hitTarget = dir > 0 ? c[i].high >= target : c[i].low <= target;
    if (hitTarget) return TARGET_R;
  }
  return (dir * (c[end].close - entry)) / risk;
}

function runKeyGroup(c: Candle[], kind: Kind, rung: Rung, mult: number): Book {
  const vol = c.map((candle) => candle.volume * candle.close);
  const atr = atr14(c);
  const maxAge = Math.ceil((P.keyMaxAgeDays * 86_400_000) / TF_MS["15m"]);
  const book = empty();

  const events: number[] = [];
  for (let i = P.volumeLookback; i < c.length - MAX_HOLD - 1; i++) {
    const base = medianOf(vol, i - P.volumeLookback, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    if (kind === "spike" ? ratio >= mult : ratio >= 0.9 && ratio <= 1.1) events.push(i);
  }
  const stride = Math.max(1, Math.ceil(events.length / MAX_LEVELS));

  for (let e = 0; e < events.length; e += stride) {
    const i = events[e];
    const price = kind === "syn" ? c[i].close + (e % 2 ? 0.7 : -0.7) * atr[i] : c[i].close;
    const from = usableFrom(c, atr, i, price, rung);
    if (from < 0) continue;
    const tol = P.keyTouchAtr * atr[i];
    const limit = Math.min(c.length - MAX_HOLD - 1, i + maxAge);
    for (let j = Math.max(from, i + 2); j <= limit; j++) {
      if (c[j].low > price + tol || c[j].high < price - tol) continue;
      const dir = c[j - 1].close >= price ? 1 : -1; // chiều BẬT LẠI
      const r = walkBarrier(c, j, dir, STOP_ATR * atr[j]);
      if (r !== null) record(book, r);
      break;
    }
  }
  return book;
}

function runRandomGroup(c: Candle[], count: number, seedBase: number): Book {
  const atr = atr14(c);
  const book = empty();
  let seed = seedBase;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const lo = P.volumeLookback;
  const hi = c.length - MAX_HOLD - 2;
  for (let k = 0; k < count && hi > lo; k++) {
    const j = lo + Math.floor(random() * (hi - lo));
    const dir = random() < 0.5 ? 1 : -1;
    const r = walkBarrier(c, j, dir, STOP_ATR * atr[j]);
    if (r !== null) record(book, r);
  }
  return book;
}

function line(label: string, book: Book): string {
  const net = expectancy(book) - COST_R;
  return [
    label.padEnd(9),
    String(book.n).padStart(7),
    `${wr(book).toFixed(1)}%`.padStart(7),
    `±${ciWr(book).toFixed(1)}`.padStart(7),
    expectancy(book).toFixed(3).padStart(8),
    `${net >= 0 ? "+" : ""}${net.toFixed(3)}`.padStart(8),
  ].join(" ");
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "400", 10);
  const symbols = (process.argv[3]?.split(",") ?? SYMBOLS).map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Ngưỡng spike phải hợp phân phối volume của từng thị trường: tick volume vàng mượt hơn hẳn
  // volume crypto nên 6×/12× gần như không tồn tại ở vàng (97 và 4 sự kiện/năm).
  const MULTS = process.argv[4]?.split(",").map(Number).filter((x) => x > 0) ?? DEFAULT_MULTS;
  if (symbols.every((symbol) => symbol === "xauusd")) COST_R = PASS_BY_MARKET.gold;

  const series: Candle[][] = [];
  for (const symbol of symbols) {
    series.push(await loadM15(symbol, days));
  }
  console.log(
    `${symbols.length} coin × ${series[0].length} nến 15m · R = ${STOP_ATR}×ATR · target ${TARGET_R}R`
    + ` · phí ${COST_R} R/lệnh · trần giữ 7 ngày`,
  );
  console.log(`Mốc bước ngẫu nhiên: WR = 1/(1+k) = ${(100 / (1 + TARGET_R)).toFixed(1)}% · gộp R = 0\n`);

  for (const mult of MULTS) {
    console.log(`═══ spike ≥ ${mult}× ═══`);
    for (const rung of RUNGS) {
      const books: Record<string, Book> = { spike: empty(), normal: empty(), syn: empty(), random: empty() };
      for (const candles of series) {
        for (const kind of ["spike", "normal", "syn"] as Kind[]) {
          const book = runKeyGroup(candles, kind, rung, mult);
          books[kind].n += book.n;
          books[kind].wins += book.wins;
          books[kind].sumR += book.sumR;
          books[kind].sumSq += book.sumSq;
        }
      }
      const randomCount = Math.ceil(books.spike.n / series.length);
      for (let s = 0; s < series.length; s++) {
        const book = runRandomGroup(series[s], randomCount, 20260828 + s * 7919);
        books.random.n += book.n;
        books.random.wins += book.wins;
        books.random.sumR += book.sumR;
        books.random.sumSq += book.sumSq;
      }
      const ratio = wr(books.random) > 0 ? wr(books.spike) / wr(books.random) : 0;
      const need = 1 + COST_R;
      const verdict = ratio >= need && wr(books.spike) - ciWr(books.spike) > wr(books.syn) + ciWr(books.syn)
        ? "ĐẬU"
        : "RỚT";
      console.log(`  ${rung}  ${"nhóm".padEnd(9)} ${"n".padStart(7)} ${"WR".padStart(7)} ${"±95%".padStart(7)} ${"gộp R".padStart(8)} ${"NET R".padStart(8)}`);
      for (const kind of ["spike", "normal", "syn", "random"]) {
        console.log(`      ${line(kind, books[kind])}`);
      }
      console.log(
        `      ⇒ WR_key/WR_random = ${ratio.toFixed(3)} (cần ≥ ${need.toFixed(3)}) · ${verdict}\n`,
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
