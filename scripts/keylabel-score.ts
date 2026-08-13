/**
 * keylabel-score.ts — chấm detector bằng NHÃN NGƯỜI: precision / recall / F1 theo ngưỡng.
 *
 * Đọc `fxdream-key-labels.csv` (người đánh dấu, xem `keylabel-init.ts`) và `fxdream-key-windows.json`,
 * chạy `detectKeyVolumeLevels` trên đúng các cửa sổ đó, rồi ghép cặp.
 *
 * LUẬT GHÉP CẶP: một key của máy khớp một key của người khi (a) cách nhau ≤ `tolBars` nến trên khung
 * đánh dấu, VÀ (b) chênh giá ≤ `tolAtr` × ATR tại thời điểm đó. Ghép một-một, ưu tiên cặp gần nhất
 * (tham lam theo khoảng cách) để một key máy không "ăn" nhiều nhãn người.
 *
 * ĐỌC KẾT QUẢ:
 *   - recall cao ở ngưỡng CHẶT ⇒ máy thấy đúng thứ người thấy, chỉ khác ĐỘ PHÂN GIẢI. Sửa = chỉnh
 *     ngưỡng, xong.
 *   - recall thấp ở MỌI ngưỡng ⇒ người đang dùng thông tin máy KHÔNG có (M5 Volume Profile, bối cảnh
 *     W1/H4, macro). Không ngưỡng nào cứu được; phải số hoá phần còn thiếu trước.
 *   - recall trên key hạng A là con số đáng tin nhất: đó là những key người thật sự vào lệnh.
 *
 * Run: ./node_modules/.bin/ts-node scripts/keylabel-score.ts [tolBars] [tolAtr]
 */
import fs from "fs";
import path from "path";
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { atrSeries } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeSourceTf } from "../key-volume";

const CSV = path.resolve("fxdream-key-labels.csv");
const WINDOWS = path.resolve("fxdream-key-windows.json");

interface Label {
  symbol: string;
  tf: KeyVolumeSourceTf;
  time: number;
  price: number;
  grade: string;
}

function parseLabels(): Label[] {
  const raw = fs.readFileSync(CSV, "utf8").split(/\r?\n/);
  const out: Label[] = [];
  for (const [i, line] of raw.entries()) {
    const s = line.trim();
    if (!s || s.startsWith("#") || s.startsWith("symbol,")) continue;
    const p = s.split(",").map((x) => x.trim());
    if (p.length < 4) { console.log(`⚠️  dòng ${i + 1} thiếu cột, bỏ qua: ${s}`); continue; }
    const [symbol, tf, dt, price, , , grade] = p;
    const t = Date.parse(dt.replace(" ", "T").replace(/Z?$/, "Z"));
    if (!Number.isFinite(t)) { console.log(`⚠️  dòng ${i + 1} giờ không đọc được: ${dt}`); continue; }
    const px = Number(price);
    if (!Number.isFinite(px)) { console.log(`⚠️  dòng ${i + 1} giá không đọc được: ${price}`); continue; }
    out.push({ symbol: symbol.toLowerCase(), tf: (tf || "1h") as KeyVolumeSourceTf, time: t, price: px, grade: (grade || "B").toUpperCase() });
  }
  return out;
}

async function main() {
  const tolBars = parseInt(process.argv[2] ?? "2", 10);
  const tolAtr = parseFloat(process.argv[3] ?? "0.5");
  if (!fs.existsSync(CSV) || !fs.existsSync(WINDOWS)) {
    console.error(`Thiếu ${CSV} hoặc ${WINDOWS}. Chạy scripts/keylabel-init.ts trước.`);
    process.exit(1);
  }
  const { windows } = JSON.parse(fs.readFileSync(WINDOWS, "utf8")) as {
    windows: { symbol: string; from: number; to: number }[];
  };
  const labels = parseLabels();
  if (labels.length < 15) {
    console.log(`⚠️  Mới có ${labels.length} nhãn. Dưới ~40 thì khoảng tin cậy rộng đến mức không kết luận được.`);
    if (!labels.length) return;
  }

  const tfMs = TF_MS[labels[0].tf] ?? TF_MS["1h"];
  const symbols = [...new Set(windows.map((w) => w.symbol))];
  const data = new Map<string, Candle[]>();
  for (const s of symbols) data.set(s, await fetchFuturesKlinesPaged(s, labels[0].tf, 20000));

  // Nhãn nằm ngoài cửa sổ ⇒ loại, vì ngoài đó không vét cạn nên không chấm precision được.
  const inWindow = (l: Label) => windows.some((w) => w.symbol === l.symbol && l.time >= w.from && l.time < w.to);
  const kept = labels.filter(inWindow);
  const dropped = labels.length - kept.length;

  console.log(`Nhãn người: ${labels.length}${dropped ? ` (bỏ ${dropped} nằm ngoài cửa sổ)` : ""} · ${windows.length} cửa sổ · khung ${labels[0].tf}`);
  console.log(`Ghép cặp: cách ≤ ${tolBars} nến VÀ chênh giá ≤ ${tolAtr}×ATR\n`);
  const byGrade = new Map<string, number>();
  for (const l of kept) byGrade.set(l.grade, (byGrade.get(l.grade) ?? 0) + 1);
  console.log(`Theo hạng: ${[...byGrade.entries()].sort().map(([g, n]) => `${g}=${n}`).join(" · ")}\n`);

  console.log("=".repeat(100));
  console.log("  DETECTOR vs MẮT NGƯỜI — quét ngưỡng volume spike");
  console.log("=".repeat(100));
  console.log("ngưỡng   key máy   khớp   precision   recall   F1     recall hạng A   key máy/ngày");
  console.log("-".repeat(100));

  const totalDays = windows.reduce((s, w) => s + (w.to - w.from) / TF_MS["1d"], 0);

  for (const mult of [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    let machine = 0, matched = 0, matchedA = 0;
    const totalA = kept.filter((l) => l.grade === "A").length;

    for (const w of windows) {
      const c = data.get(w.symbol);
      if (!c) continue;
      const atr = atrSeries(c, KEY_VOLUME_CONFIG.volumeLookback > 0 ? 20 : 20);
      const idx = new Map<number, number>();
      for (let i = 0; i < c.length; i++) idx.set(c[i].openTime, i);
      const levels = detectKeyVolumeLevels(c, labels[0].tf, { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult })
        .filter((l) => l.eventTime >= w.from && l.eventTime < w.to);
      machine += levels.length;

      const mine = kept.filter((l) => l.symbol === w.symbol && l.time >= w.from && l.time < w.to);
      // ghép tham lam theo khoảng cách chuẩn hoá, một-một
      const pairs: { d: number; li: number; mi: number }[] = [];
      mine.forEach((l, li) => {
        levels.forEach((m, mi) => {
          const bars = Math.abs(m.eventTime - l.time) / tfMs;
          if (bars > tolBars) return;
          const i = idx.get(m.eventTime);
          const a = i !== undefined && atr[i] > 0 ? atr[i] : Math.abs(l.price) * 0.005;
          const dp = Math.abs(m.price - l.price) / a;
          if (dp > tolAtr) return;
          pairs.push({ d: bars / Math.max(1, tolBars) + dp / Math.max(1e-9, tolAtr), li, mi });
        });
      });
      pairs.sort((a, b) => a.d - b.d);
      const usedL = new Set<number>(), usedM = new Set<number>();
      for (const p of pairs) {
        if (usedL.has(p.li) || usedM.has(p.mi)) continue;
        usedL.add(p.li); usedM.add(p.mi);
        matched++;
        if (mine[p.li].grade === "A") matchedA++;
      }
    }

    const precision = machine ? matched / machine : 0;
    const recall = kept.length ? matched / kept.length : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const recallA = totalA ? matchedA / totalA : NaN;
    console.log(
      `${mult.toFixed(1).padStart(5)}×   ${String(machine).padStart(7)}   ${String(matched).padStart(4)}   ` +
        `${(precision * 100).toFixed(1).padStart(8)}%   ${(recall * 100).toFixed(1).padStart(5)}%   ${f1.toFixed(2)}   ` +
        `${Number.isFinite(recallA) ? `${(recallA * 100).toFixed(1)}%`.padStart(12) : "          — "}   ${(machine / totalDays).toFixed(2).padStart(11)}`,
    );
  }

  console.log("\nĐọc kết quả:");
  console.log("  · recall hạng A CAO ở ngưỡng chặt  ⇒ chỉ khác ĐỘ PHÂN GIẢI, chỉnh ngưỡng là xong.");
  console.log("  · recall THẤP ở mọi ngưỡng          ⇒ người dùng thông tin máy KHÔNG có; phải số hoá");
  console.log("    phần còn thiếu (M5 Volume Profile, bối cảnh W1/H4) trước, ngưỡng không cứu được.");
  console.log("  · precision thấp mà recall cao      ⇒ máy đúng hướng nhưng quá dày — đúng chẩn đoán");
  console.log("    mật độ ở planning/fxdream-as-trend-input-2026-08-12.md §K1.");
}

if (require.main === module && /keylabel-score\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
