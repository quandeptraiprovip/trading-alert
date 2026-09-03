/**
 * exp-retest-volume.ts — kiểm chứng luật rút từ corpus SHORT của @fxdreamtrading:
 * **volume phải xuất hiện HAI lần** — một lần tạo key (phá cấu trúc), một lần BẢO VỆ key (retest).
 *
 * Trong code, điều kiện lần hai là `touchVolumeSpikeMult`, và production đang đặt = 1 (tức KHÔNG
 * yêu cầu gì); chỉ `KEY_VOLUME_DOCUMENT_V1_CONFIG` đặt 2.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * VÌ SAO PHẢI ĐỔI BÀN THỬ (đọc trước khi tin bất cứ số nào dưới đây)
 *
 * Bản đầu của script này chạy thẳng cấu hình production và ra 1–13 lệnh/năm với stop trung vị
 * 0,03% — vô nghĩa. `scripts/exp-keyvol-funnel.ts` chỉ ra cơ chế, và đọc code xác nhận:
 *
 *     opposingR = |target − entry| / risk        (key-volume.ts:1754)
 *     loại nếu opposingR < minRR                 (minRR = 3)
 *
 * `risk` nằm ở MẪU SỐ, nên stop càng nhỏ thì opposingR càng lớn. Với rổ level M15/H1/H4 rất dày,
 * target cấu trúc gần nhất luôn ở sát ⇒ **chỉ lệnh có stop suy biến mới vượt được sàn RR**. Sàn RR
 * ở đây không lọc chất lượng, nó CHỌN stop suy biến. Bỏ sàn: 13 → 787 lệnh, stop trung vị
 * 0,017% → 0,468%. Đây đúng họ lỗi đã ghi trong `keyvolume-manual-vs-code`, và nó VẪN CÒN trong
 * cấu hình mặc định của `key-volume.ts`.
 *
 * Nhưng bỏ sàn RR không thôi cũng sai: `resolveTargetR` trả `min(finalTargetR, opposingR)`
 * (key-volume.ts:1461) nên lệnh có target cách 0,05R vẫn được nhận. Bàn thử sạch phải cắt hẳn
 * phụ thuộc cấu trúc: `targetSourceTfs: []` ⇒ không tìm thấy level đối diện ⇒ target = 5R cố định.
 *
 * Bàn thử: stop = cực trị cửa sổ touch→sweep (đúng nguồn), target 5R cố định, không gate cấu trúc.
 * Đây KHÔNG phải cấu hình đề nghị giao dịch — nó là môi trường để câu hỏi "volume lần hai" trả
 * lời được, thay vì bị nhánh suy biến nuốt.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-retest-volume.ts [days]
 */
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { TF_MS, aggregate } from "../strategy";
import { KEY_VOLUME_CONFIG, KeyVolumeParams, runKeyVolume } from "../key-volume";

const SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];

/**
 * Bàn thử sạch — xem khối chú thích đầu file.
 *
 * ⚠️ HỎNG TỪ 01/09/2026: key-volume.ts bỏ `targetSourceTfs` khi rút về M15+M5, nên mẹo
 * "không có level đối diện ⇒ target 5R cố định" KHÔNG còn hiệu lực. Chạy lại script này
 * bây giờ là đo một bàn thử KHÁC (target theo key M15 đối diện), không tái lập được số cũ.
 */
const CLEAN: Partial<KeyVolumeParams> = {
  requireStructuralTarget: false,
  minRR: 0,
};

/** CI90 của expectancy bằng bootstrap — n nhỏ thì khoảng này mới nói lên sự thật. */
function bootstrapCI(xs: number[], B = 4000): [number, number] {
  if (xs.length < 5) return [NaN, NaN];
  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(Math.random() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(B * 0.05)], means[Math.floor(B * 0.95)]];
}

async function main() {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS["5m"]) + 5000;
  const data = new Map<string, Awaited<ReturnType<typeof fetchFuturesKlinesPaged>>>();
  for (const s of SYMBOLS) {
    const c = aggregate(await fetchFuturesKlinesPaged(s, "5m", bars), "15m", "5m");
    if (c.length > 10000) data.set(s, c);
  }
  const span = [...data.values()].reduce((mx, c) => Math.max(mx, c[c.length - 1].openTime - c[0].openTime), 0);
  const years = span / (365 * TF_MS["1d"]);
  console.log(`${data.size} symbol · ${years.toFixed(2)} năm · nến gốc 5m`);
  console.log(`Bàn thử: stop = cửa sổ touch→sweep · target 5R cố định · KHÔNG gate cấu trúc\n`);

  console.log("=".repeat(112));
  console.log("  Ngưỡng volume của cú RETEST (touchVolumeSpikeMult) — mọi tham số khác giữ nguyên production");
  console.log("=".repeat(112));
  console.log("ngưỡng   lệnh   lệnh/coin/năm   WR%    gross R   exp/lệnh   CI90 exp        stop TV%   net@0,14%   net@0,02%");
  console.log("-".repeat(112));

  for (const mult of [1, 1.5, 2, 2.5, 3, 4, 5]) {
    const rs: number[] = [];
    const stops: number[] = [];
    for (const [sym, c] of data) {
      const r = runKeyVolume(sym, c, { ...KEY_VOLUME_CONFIG, ...CLEAN, touchVolumeSpikeMult: mult });
      for (const t of r.trades) {
        rs.push(t.grossR ?? t.netR);
        stops.push(Math.abs(t.entryPrice - t.initialSL) / t.entryPrice);
      }
    }
    const n = rs.length;
    if (!n) { console.log(`${mult.toFixed(1).padStart(5)}×      0`); continue; }
    const gross = rs.reduce((a, b) => a + b, 0);
    const exp = gross / n;
    const wins = rs.filter((x) => x > 0).length;
    const [lo, hi] = bootstrapCI(rs);
    stops.sort((a, b) => a - b);
    const stopMed = stops[Math.floor(stops.length / 2)];
    // phí một vòng quy ra R = ma sát / stopFraction
    const netAt = (fric: number) => gross - n * (fric / 100 / stopMed);
    console.log(
      `${mult.toFixed(1).padStart(5)}×   ${String(n).padStart(4)}   ${(n / data.size / years).toFixed(1).padStart(13)}   ` +
        `${((wins / n) * 100).toFixed(1).padStart(4)}   ${gross.toFixed(1).padStart(7)}   ${exp.toFixed(3).padStart(8)}   ` +
        `[${lo.toFixed(3)};${hi.toFixed(3)}]`.padStart(16) + `   ${(stopMed * 100).toFixed(3).padStart(7)}   ` +
        `${netAt(0.14).toFixed(0).padStart(9)}   ${netAt(0.02).toFixed(0).padStart(9)}`,
    );
  }
  console.log(`\nThang người đối chiếu: tác giả kênh ~60 kèo/năm trên TOÀN BỘ thị trường của họ.`);
  console.log(`CI90 chứa 0 ⇒ không có bằng chứng edge, bất kể dấu của expectancy.`);
}

if (require.main === module && /exp-retest-volume\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
