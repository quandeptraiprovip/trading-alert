/**
 * fx-gold-shape.ts — CHỮ KÝ THỐNG KÊ của vàng: chart biểu hiện thế nào, và lớp luật nào hợp.
 *
 * VÌ SAO: `fx-gold-drivers.ts` cho thấy động lực định giá của vàng đã ĐỔI (lãi suất thực chết từ
 * 2022, chỉ còn đô la là bền, và phần dư 2024-2025 = +23%/+29% không giải thích được bằng biến tài
 * chính nào). Biết vàng chạy vì cái gì vẫn chưa nói được luật nào hợp — cái đó nằm ở HÌNH DẠNG
 * chuỗi giá. File này đo hình dạng đó, và luôn đặt cạnh HAI mốc so sánh đã biết câu trả lời:
 *   · BTC — lớp tài sản mà hệ trend đang chạy CÓ ăn (Sharpe 1,5)
 *   · EURUSD — lớp mà mọi họ trend đều null trong repo này
 * Vàng nằm gần mốc nào sẽ nói thẳng lớp luật nào hợp, không cần đoán.
 *
 * BỐN PHÉP, mỗi phép trả lời một câu hỏi về lớp luật:
 *   §1 TỈ SỐ PHƯƠNG SAI (Lo–MacKinlay, z bền với phương sai thay đổi)
 *      VR(q) > 1 ⇒ lợi suất tự tương quan DƯƠNG ở thang q ⇒ trend-following có cái để ăn.
 *      VR ≈ 1 ⇒ bước ngẫu nhiên ⇒ chỉ có drift nền, tức MUA-VÀ-GIỮ.
 *      VR < 1 ⇒ hồi quy trung bình ⇒ phải đánh ngược.
 *   §2 TẬP TRUNG LỢI NHUẬN — bao nhiêu % ngày tạo ra toàn bộ lợi nhuận?
 *      Rất tập trung ⇒ phải có mặt sẵn trong thị trường, luật vào-ra nhiều sẽ bỏ lỡ.
 *   §3 TIẾP DIỄN SAU PHÁ VỠ — điều kiện hoá đúng thứ mà luật Turtle dùng.
 *      Đây là phép trực tiếp nhất: sau khi phá đỉnh N ngày, kỳ vọng phía trước có khác nền không?
 *   §4 BIÊN ĐỘ so với CHI PHÍ ở từng thang thời gian — thang nào chi phí còn nuốt hết.
 *
 * Chạy: npx ts-node fx/fx-gold-shape.ts
 */

import fs from "fs";
import path from "path";
import { FxCandle, loadH1 } from "./fx-data";

const DAY_CLOSE_H = 22;

interface Series { name: string; close: number[]; spreadBps: number }

/** FX: H1 → đóng cửa ngày giao dịch (mốc 22:00 UTC). */
function fxDaily(sym: string): Series {
  const bars: FxCandle[] = loadH1(sym);
  const byDay = new Map<number, FxCandle>();
  for (const b of bars) {
    const d = Math.floor((b.openTime - DAY_CLOSE_H * 3600e3) / 86400e3);
    const prev = byDay.get(d);
    if (!prev || b.openTime > prev.openTime) byDay.set(d, b);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const recent = days.slice(Math.floor(days.length * 2 / 3));
  return {
    name: sym,
    close: days.map((d) => byDay.get(d)!.close),
    spreadBps: recent.reduce((s, d) => s + (byDay.get(d)!.spread / byDay.get(d)!.close) * 1e4, 0) / recent.length,
  };
}

/** Crypto: nến 4h → ngày. */
function cryptoDaily(sym: string): Series {
  const raw = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), ".cache", "klines", "futures", `${sym}_4h.json`), "utf8"));
  const byDay = new Map<number, number>();
  for (const b of raw) byDay.set(Math.floor(b.openTime / 86400e3), b.close);
  return { name: sym.toUpperCase(), close: [...byDay.keys()].sort((a, b) => a - b).map((d) => byDay.get(d)!), spreadBps: 1.0 };
}

const logRet = (c: number[]) => c.slice(1).map((x, i) => Math.log(x / c[i]));
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;

// ── §1 tỉ số phương sai ───────────────────────────────────────────────────────
/** Lo–MacKinlay VR(q) với chồng lấn + z bền phương sai thay đổi (z*). */
function varianceRatio(r: number[], q: number): { vr: number; z: number } {
  const n = r.length;
  const mu = mean(r);
  const d = r.map((x) => x - mu);
  const sa = d.reduce((s, x) => s + x * x, 0) / (n - 1);
  let sc = 0;
  for (let t = q - 1; t < n; t++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += d[t - j];
    sc += s * s;
  }
  const m = q * (n - q + 1) * (1 - q / n);
  const vr = sc / m / sa;
  // theta* bền phương sai thay đổi
  const denom = d.reduce((s, x) => s + x * x, 0) ** 2;
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let num = 0;
    for (let t = j; t < n; t++) num += d[t] * d[t] * d[t - j] * d[t - j];
    theta += ((2 * (q - j)) / q) ** 2 * (num / denom);
  }
  return { vr, z: theta > 0 ? (vr - 1) / Math.sqrt(theta) : 0 };
}

// ── §3 tiếp diễn sau phá vỡ ───────────────────────────────────────────────────
/** Sau khi đóng cửa vượt đỉnh `look` ngày: lợi suất `fwd` ngày phía trước so với NỀN. */
function breakoutContinuation(c: number[], look: number, fwd: number) {
  const hits: number[] = [];
  for (let i = look; i < c.length - fwd; i++) {
    const hi = Math.max(...c.slice(i - look, i));
    if (c[i] > hi) hits.push(Math.log(c[i + fwd] / c[i]) * 100);
  }
  const base: number[] = [];
  for (let i = look; i < c.length - fwd; i++) base.push(Math.log(c[i + fwd] / c[i]) * 100);
  if (hits.length < 30) return null;
  const mh = mean(hits), mb = mean(base);
  const sd = Math.sqrt(hits.reduce((s, x) => s + (x - mh) ** 2, 0) / (hits.length - 1));
  // t so với NỀN (không phải so với 0) — vàng tăng dài hạn nên so với 0 luôn cho kết quả dương giả.
  return { n: hits.length, hit: mh, base: mb, edge: mh - mb, t: sd > 0 ? (mh - mb) / (sd / Math.sqrt(hits.length)) : 0 };
}

function main() {
  const sets = [fxDaily("XAUUSD"), cryptoDaily("btcusdt"), fxDaily("EURUSD")];

  console.log("═══ §1 TỈ SỐ PHƯƠNG SAI — chuỗi có xu hướng hay là bước ngẫu nhiên? ═══");
  console.log("VR>1 trend · VR≈1 bước ngẫu nhiên · VR<1 hồi quy. |z|≥2 mới khác 1 có ý nghĩa.\n");
  const QS = [2, 5, 10, 20, 60, 120];
  console.log("chuỗi".padEnd(10) + "n".padStart(7) + QS.map((q) => `VR(${q})`.padStart(13)).join(""));
  for (const s of sets) {
    const r = logRet(s.close);
    console.log(s.name.padEnd(10) + String(r.length).padStart(7) +
      QS.map((q) => { const { vr, z } = varianceRatio(r, q); return `${vr.toFixed(2)}${Math.abs(z) >= 2 ? "*" : " "}(${z.toFixed(1)})`.padStart(13); }).join(""));
  }
  console.log("  (* = |z| ≥ 2)");

  console.log("\n═══ §2 TẬP TRUNG LỢI NHUẬN — phải có mặt sẵn hay vào ra được? ═══");
  console.log("chuỗi".padEnd(10) + "tổng log-ret".padStart(14) + "top 1% ngày".padStart(14) +
    "top 5% ngày".padStart(14) + "  bỏ lỡ top 1% còn lại");
  for (const s of sets) {
    const r = logRet(s.close);
    const tot = r.reduce((a, b) => a + b, 0);
    const sorted = [...r].sort((a, b) => b - a);
    const k1 = Math.max(1, Math.round(r.length * 0.01)), k5 = Math.max(1, Math.round(r.length * 0.05));
    const t1 = sorted.slice(0, k1).reduce((a, b) => a + b, 0), t5 = sorted.slice(0, k5).reduce((a, b) => a + b, 0);
    console.log(s.name.padEnd(10) + `${(tot * 100).toFixed(0)}%`.padStart(14) +
      `${(t1 / tot * 100).toFixed(0)}%`.padStart(14) + `${(t5 / tot * 100).toFixed(0)}%`.padStart(14) +
      `  ${((tot - t1) * 100).toFixed(0)}%`.padStart(14));
  }

  console.log("\n═══ §3 TIẾP DIỄN SAU PHÁ VỠ — đúng thứ luật Turtle đặt cược ═══");
  console.log("So với NỀN cùng kỳ hạn (vàng tăng dài hạn nên so với 0 sẽ dương giả).\n");
  console.log("chuỗi".padEnd(10) + "phá vỡ".padStart(9) + "kỳ hạn".padStart(8) + "lệnh".padStart(7) +
    "sau phá vỡ".padStart(12) + "nền".padStart(9) + "chênh".padStart(9) + "t".padStart(8));
  for (const s of sets) {
    for (const [look, fwd] of [[20, 20], [55, 20], [55, 60], [120, 60]] as [number, number][]) {
      const r = breakoutContinuation(s.close, look, fwd);
      if (!r) continue;
      console.log(s.name.padEnd(10) + `${look}d`.padStart(9) + `${fwd}d`.padStart(8) + String(r.n).padStart(7) +
        `${r.hit.toFixed(2)}%`.padStart(12) + `${r.base.toFixed(2)}%`.padStart(9) +
        `${r.edge.toFixed(2)}%`.padStart(9) + r.t.toFixed(2).padStart(8) + (Math.abs(r.t) >= 2 ? "  ✅" : ""));
    }
  }

  console.log("\n═══ §4 BIÊN ĐỘ vs CHI PHÍ theo thang thời gian ═══");
  console.log("Chi phí một vòng = spread era gần nhất + 0,4 bps trượt. Cần ≥ 3× mới có biên an toàn.\n");
  console.log("chuỗi".padEnd(10) + "chi phí vòng".padStart(14) + ["1d", "5d", "20d", "60d"].map((x) => `|move| ${x}`.padStart(13)).join(""));
  for (const s of sets) {
    const cost = s.spreadBps + 0.4;
    const r = logRet(s.close);
    const cells = [1, 5, 20, 60].map((h) => {
      const moves: number[] = [];
      for (let i = 0; i + h < r.length; i += h) moves.push(Math.abs(r.slice(i, i + h).reduce((a, b) => a + b, 0)) * 1e4);
      const mv = mean(moves);
      return `${(mv / cost).toFixed(0)}×`.padStart(13);
    });
    console.log(s.name.padEnd(10) + `${cost.toFixed(2)} bps`.padStart(14) + cells.join(""));
  }
}

if (require.main === module) main();
