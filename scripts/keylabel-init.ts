/**
 * keylabel-init.ts — sinh CỬA SỔ ĐÁNH DẤU và file CSV trống để người dùng gán nhãn Key bằng mắt.
 *
 * MỤC ĐÍCH: lần đầu tiên có NHÃN NGƯỜI để đo precision/recall của detector. Không có nhãn thì câu
 * "có xác định Key chính xác như mắt người không" mãi là phỏng đoán (xem
 * `planning/fxdream-as-trend-input-2026-08-12.md` §2).
 *
 * VÌ SAO KHÔNG DÙNG `fxdream-journal-cli.ts`: journal đó được thiết kế để DUYỆT ứng viên do MÁY
 * sinh (accepted/rejected/missed). Nhìn output của máy rồi mới đánh dấu là neo mắt người vào máy —
 * phá đúng tính độc lập mà phép đo cần. Ở đây người đánh dấu TRƯỚC, mù hoàn toàn với detector.
 *
 * BA RÀNG BUỘC LÀM PHÉP ĐO CÓ NGHĨA (thiếu một cái là hỏng cả bài):
 *   1. VÉT CẠN trong cửa sổ — phải đánh dấu MỌI key trong cửa sổ, không chọn cái đẹp. Nếu chỉ đánh
 *      dấu vài cái nhớ được thì recall không đo được, và precision bị thổi phồng vì mọi key máy tìm
 *      thấy mà người bỏ sót đều bị tính oan là dương tính giả.
 *   2. KHÔNG NHÌN TƯƠNG LAI — key phải nhận ra được NGAY LÚC nến đó đóng. Dùng Bar Replay của
 *      TradingView (phím tắt: thanh Replay → chọn mốc thời gian → tua từng nến). Cuộn chart bình
 *      thường là thấy hết phản ứng phía sau, và nhãn sẽ mang thông tin tương lai mà detector không
 *      bao giờ có ⇒ detector bị chấm oan.
 *   3. MÙ VỚI MÁY — đừng chạy `keylabel-score.ts` hay xem key của detector trước khi đánh dấu xong.
 *
 * Run: ./node_modules/.bin/ts-node scripts/keylabel-init.ts [số cửa sổ] [số ngày mỗi cửa sổ]
 */
import fs from "fs";
import path from "path";
import { TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";

const SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];
const OUT_CSV = path.resolve("fxdream-key-labels.csv");
const OUT_WINDOWS = path.resolve("fxdream-key-windows.json");

/** PRNG có seed — cửa sổ phải TÁI LẬP ĐƯỢC và không được chọn theo hiệu suất detector. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";

async function main() {
  const nWindows = parseInt(process.argv[2] ?? "6", 10);
  const windowDays = parseInt(process.argv[3] ?? "21", 10);

  if (fs.existsSync(OUT_CSV)) {
    console.log(`⚠️  ${OUT_CSV} đã tồn tại — KHÔNG ghi đè (sợ mất nhãn đã đánh).`);
    console.log(`   Muốn tạo lại thì đổi tên file cũ đi trước.`);
    return;
  }

  // Lấy mốc thời gian cuối có dữ liệu, chỉ để giới hạn khoảng chọn cửa sổ.
  const btc = await fetchFuturesKlinesPaged("btcusdt", "1h", 20000);
  const lastTime = btc[btc.length - 1].openTime;
  // Tránh 60 ngày gần nhất: cần dữ liệu SAU cửa sổ cho các phân tích tiếp theo, và tránh việc bạn
  // vừa xem thị trường đó tuần trước nên nhớ kết quả.
  const hi = lastTime - 60 * TF_MS["1d"];
  const lo = lastTime - 540 * TF_MS["1d"];

  const rand = rng(20260812);
  const span = windowDays * TF_MS["1d"];
  const windows: { symbol: string; from: number; to: number }[] = [];
  for (let i = 0; i < nWindows; i++) {
    const symbol = SYMBOLS[i % SYMBOLS.length];
    // Cửa sổ CÙNG symbol không được chồng nhau: chồng nhau thì bạn đánh dấu trùng và cùng một key
    // bị đếm hai lần khi chấm điểm. Thử tối đa 200 lần rồi mới chịu thua.
    let start = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      const cand = Math.floor((lo + rand() * (hi - lo - span)) / TF_MS["1h"]) * TF_MS["1h"];
      const clash = windows.some((w) => w.symbol === symbol && cand < w.to && cand + span > w.from);
      if (!clash) { start = cand; break; }
      start = 0;
    }
    if (!start) { console.log(`⚠️  Không tìm được chỗ trống cho ${symbol} — giảm số cửa sổ hoặc số ngày.`); continue; }
    windows.push({ symbol, from: start, to: start + span });
  }
  windows.sort((a, b) => a.from - b.from);

  fs.writeFileSync(OUT_WINDOWS, JSON.stringify({ windowDays, windows }, null, 2));
  fs.writeFileSync(
    OUT_CSV,
    "symbol,tf,datetime_utc,price,zone_low,zone_high,grade,note\n" +
      "# XOÁ các dòng bắt đầu bằng # sau khi đọc xong. Mỗi Key = MỘT dòng.\n" +
      "# datetime_utc = giờ MỞ của cây nến tạo Key, định dạng YYYY-MM-DD HH:MM (giờ UTC)\n" +
      "# price        = mức giá đại diện của Key (bạn thường nhìn mức nào thì ghi mức đó)\n" +
      "# zone_low/high= biên vùng nếu bạn vẽ vùng; để TRỐNG nếu chỉ dùng một mức\n" +
      "# grade        = A (chắc chắn, vào lệnh được) | B (đáng chú ý) | C (yếu, ghi cho đủ)\n" +
      "# note         = tuỳ ý, vd 'trùng OB H4'\n" +
      "# Ví dụ:  btcusdt,1h,2026-03-14 08:00,68450,68300,68600,A,trùng OB H4\n",
  );

  console.log("=".repeat(96));
  console.log("  CỬA SỔ ĐÁNH DẤU KEY — vét cạn trong từng cửa sổ, dùng Bar Replay, KHÔNG xem output máy");
  console.log("=".repeat(96));
  console.log(`${nWindows} cửa sổ × ${windowDays} ngày · khung đánh dấu: H1\n`);
  console.log("#   symbol      từ (UTC)            đến (UTC)");
  console.log("-".repeat(96));
  windows.forEach((w, i) => {
    console.log(`${String(i + 1).padStart(2)}  ${w.symbol.toUpperCase().padEnd(10)}  ${fmt(w.from)}   ${fmt(w.to)}`);
  });

  console.log(`\nGhi nhãn vào : ${OUT_CSV}`);
  console.log(`Cửa sổ lưu ở : ${OUT_WINDOWS}`);
  console.log(`\nXong thì chạy: ./node_modules/.bin/ts-node scripts/keylabel-score.ts`);
  console.log("\nBa điều làm hỏng phép đo nếu vi phạm:");
  console.log("  1. Bỏ sót key trong cửa sổ  → recall không đo được, precision bị chấm oan.");
  console.log("  2. Cuộn chart thấy phía sau → nhãn mang thông tin tương lai, detector bị chấm oan.");
  console.log("  3. Xem key của máy trước    → nhãn không còn độc lập, mọi con số vô nghĩa.");
  console.log("\nDừng lại khi đủ ~40–60 key. Thiếu hơn thì khoảng tin cậy rộng đến mức không kết luận được.");
}

if (require.main === module && /keylabel-init\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
