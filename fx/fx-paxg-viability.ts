/**
 * fx-paxg-viability.ts — phép đo DỨT ĐIỂM cho nhánh vàng: giữ PAXG perp tốn bao nhiêu một năm?
 *
 * BỐI CẢNH: `fx-gold-method.ts` cho thấy lớp luật DUY NHẤT hợp với vàng là long-only + vol-target
 * (Sharpe 0,77 trên 22,6 năm spot XAUUSD, đậu ba era + cửa tập trung). Ở vốn $513, công cụ khả thi
 * duy nhất là PAXGUSDT perp (minNotional $5) — CFD XAUUSD 0,01 lot đã là $4.300 notional.
 *
 * NHƯNG backtest kia chạy trên SPOT với spread FX 2,73 bps/chiều. Perp có thêm FUNDING, và funding
 * là chi phí GIỮ — nó ăn theo thời gian chứ không theo số lần vào lệnh, nên một chiến lược "luôn có
 * mặt" chịu nó trọn vẹn. Đây đúng là chỗ mà một chiến lược đẹp trên giấy chết trong thực tế.
 *
 * NGƯỠNG ĐẶT TRƯỚC (khai báo trước khi nhìn số, để không tự nới): CAGR của nhánh là 12,7%/năm với
 * vol 16%. Chi phí giữ ăn thẳng vào CAGR:
 *   · < 3%/năm  ⇒ Sharpe còn ≥ 0,60 — nhánh còn đáng giữ vì tương quan −0,03 với crypto
 *   · 3–6%/năm  ⇒ Sharpe 0,40–0,60 — ranh giới, chỉ đáng ở trọng số rất nhỏ
 *   · > 6%/năm  ⇒ Sharpe < 0,40 — KHÉP nhánh vàng
 *
 * GIỚI HẠN PHẢI NHỚ: PAXG perp mới niêm yết 2025-03-27 (1,4 năm) và trùng đúng đợt vàng bùng nổ.
 * 1,4 năm ĐỦ để đo chi phí (funding là dòng tiền quan sát trực tiếp, không phải ước lượng thống kê)
 * nhưng KHÔNG đủ để kiểm chiến lược. File này chỉ trả lời câu hỏi chi phí.
 *
 * Chạy: npx ts-node fx/fx-paxg-viability.ts
 */

import fs from "fs";
import path from "path";
import { loadH1 } from "./fx-data";
import { daily, strat } from "./fx-gold-method";

const DIR = path.join(process.cwd(), ".cache", "fx", "paxg");
const FUNDING_PER_DAY = 6;          // chu kỳ 4 giờ
const SLEEVE_CAGR = 12.7;           // vol-target 60d băng 10%, spot XAUUSD 22,6 năm
const SLEEVE_VOL = 16.0;

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; q: number }

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };

function main() {
  const funding: [number, number][] = JSON.parse(fs.readFileSync(path.join(DIR, "funding.json"), "utf8"));
  const bars: Bar[] = JSON.parse(fs.readFileSync(path.join(DIR, "h1.json"), "utf8"));
  const days = (funding[funding.length - 1][0] - funding[0][0]) / 86400e3;

  console.log(`═══ §1 FUNDING — chi phí GIỮ vị thế LONG PAXGUSDT ═══`);
  console.log(`${funding.length} kỳ (4h) · ${new Date(funding[0][0]).toISOString().slice(0, 10)} → ` +
    `${new Date(funding[funding.length - 1][0]).toISOString().slice(0, 10)} · ${days.toFixed(0)} ngày\n`);

  const rates = funding.map(([, r]) => r);
  const avg = mean(rates);
  const annual = avg * FUNDING_PER_DAY * 365 * 100;
  const realized = rates.reduce((s, r) => s + r, 0) * 100;      // tổng % đã trả trong kỳ
  console.log(`funding TB/kỳ   = ${(avg * 100).toFixed(5)}%  ⇒ LONG trả ${annual.toFixed(2)}%/năm`);
  console.log(`đã trả thực tế  = ${realized.toFixed(2)}% trong ${(days / 365).toFixed(2)} năm ` +
    `⇒ ${(realized / (days / 365)).toFixed(2)}%/năm`);
  console.log(`phân vị/kỳ: 5% ${(pct(rates, 0.05) * 100).toFixed(4)}% · trung vị ${(pct(rates, 0.5) * 100).toFixed(4)}% · ` +
    `95% ${(pct(rates, 0.95) * 100).toFixed(4)}%`);
  console.log(`kỳ ÂM (long ĐƯỢC nhận): ${(rates.filter((r) => r < 0).length / rates.length * 100).toFixed(1)}%`);

  console.log(`\n─── theo tháng (%/năm quy đổi) — funding có ổn định không? ───`);
  const byMonth = new Map<string, number[]>();
  for (const [t, r] of funding) {
    const k = new Date(t).toISOString().slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k)!.push(r);
  }
  const ms = [...byMonth.keys()].sort();
  for (let i = 0; i < ms.length; i += 6) {
    console.log("  " + ms.slice(i, i + 6).map((m) =>
      `${m} ${(mean(byMonth.get(m)!) * FUNDING_PER_DAY * 365 * 100).toFixed(1).padStart(6)}%`).join("  │"));
  }

  // ── §2 BÁM GIÁ: perp có đi đúng vàng không? ──
  console.log(`\n═══ §2 BÁM GIÁ — PAXG perp vs XAUUSD spot ═══`);
  const spot = loadH1("XAUUSD");
  const spotAt = new Map<number, number>();
  for (const b of spot) spotAt.set(b.openTime, b.close);
  const paired: { t: number; p: number; s: number }[] = [];
  for (const b of bars) { const s = spotAt.get(b.t); if (s) paired.push({ t: b.t, p: b.c, s }); }
  console.log(`${paired.length} giờ khớp được (${(paired.length / bars.length * 100).toFixed(0)}% số nến perp; ` +
    `phần thiếu = cuối tuần, spot FX đóng cửa)`);

  const pr: number[] = [], sr: number[] = [];
  for (let i = 1; i < paired.length; i++) {
    if (paired[i].t - paired[i - 1].t !== 3600e3) continue;   // chỉ giờ LIỀN NHAU, tránh ghép qua cuối tuần
    pr.push(Math.log(paired[i].p / paired[i - 1].p));
    sr.push(Math.log(paired[i].s / paired[i - 1].s));
  }
  const mp = mean(pr), ms2 = mean(sr);
  const cov = pr.reduce((a, x, i) => a + (x - mp) * (sr[i] - ms2), 0);
  const corr = cov / Math.sqrt(pr.reduce((a, x) => a + (x - mp) ** 2, 0) * sr.reduce((a, x) => a + (x - ms2) ** 2, 0));
  const diff = pr.map((x, i) => x - sr[i]);
  const md = mean(diff);
  const te = Math.sqrt(diff.reduce((a, x) => a + (x - md) ** 2, 0) / (diff.length - 1)) * Math.sqrt(24 * 365) * 100;
  console.log(`tương quan lợi suất giờ = ${corr.toFixed(4)}`);
  console.log(`sai số bám (tracking error) = ${te.toFixed(2)}%/năm`);
  console.log(`lệch tích luỹ perp − spot  = ${(diff.reduce((a, x) => a + x, 0) * 100).toFixed(2)}% trong kỳ ` +
    `⇒ ${(diff.reduce((a, x) => a + x, 0) * 100 / (days / 365)).toFixed(2)}%/năm`);

  // ── §3 TỔNG CHI PHÍ GIỮ ──
  console.log(`\n═══ §3 TỔNG CHI PHÍ vs NGƯỠNG ĐẶT TRƯỚC ═══`);
  const fundingCost = realized / (days / 365);
  const rebal = 2 * 2 * 1.0 / 100;   // 2 vòng/năm × 2 chiều × ~1 bp spread perp — nhỏ, giữ để đầy đủ
  const total = fundingCost + rebal;
  console.log(`funding        ${fundingCost.toFixed(2)}%/năm`);
  console.log(`rebalance      ${rebal.toFixed(2)}%/năm  (vol-target quay 2×/năm)`);
  console.log(`TỔNG           ${total.toFixed(2)}%/năm`);
  const netCagr = SLEEVE_CAGR - total;
  const netSharpe = netCagr / SLEEVE_VOL;
  console.log(`\nNhánh vàng sau chi phí: CAGR ${SLEEVE_CAGR}% − ${total.toFixed(2)}% = ${netCagr.toFixed(1)}% ` +
    `· vol ${SLEEVE_VOL}% ⇒ Sharpe ≈ ${netSharpe.toFixed(2)}`);
  console.log(total < 3 ? "⇒ ✅ DƯỚI NGƯỠNG 3% — nhánh còn đáng giữ ở trọng số nhỏ"
    : total < 6 ? "⇒ ⚠️ RANH GIỚI 3–6% — chỉ đáng ở trọng số rất nhỏ"
    : "⇒ ❌ TRÊN 6% — KHÉP nhánh vàng");

  // ── §4 PHÉP BẤT ĐỐI XỨNG ──
  // Trung bình 22,6 năm CHE MẤT điều quan trọng nhất: funding là chi phí CHẮC CHẮN (18/18 tháng đo
  // được đều dương) còn lợi nhuận vàng thì KHÔNG. Nếu rơi vào một giai đoạn như era 2 — vàng gần
  // phẳng suốt 7,5 năm — thì nhánh này lỗ đều mỗi năm mà không có gì bù. Đây mới là ca phải sống sót.
  console.log(`\n═══ §4 ÁP FUNDING LÊN TỪNG ERA CỦA VÀNG (spot 22,6 năm) ═══`);
  const gd = daily("XAUUSD");
  const vt = strat(gd, "vt", 60, 0.1);
  const t0 = vt.times[0], t1 = vt.times[vt.times.length - 1];
  const edges = [t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3];
  console.log("era".padEnd(26) + "CAGR gộp".padStart(10) + "funding".padStart(10) +
    "CAGR RÒNG".padStart(12) + "  đánh giá");
  for (const e of [0, 1, 2]) {
    const idx = vt.times.map((t, i) => [t, i] as const)
      .filter(([t]) => (t < edges[0] ? 0 : t < edges[1] ? 1 : 2) === e).map(([, i]) => i);
    if (idx.length < 100) continue;
    let eq = 1;
    for (const i of idx) eq *= 1 + vt.rets[i];
    const yrs = (vt.times[idx[idx.length - 1]] - vt.times[idx[0]]) / (365.25 * 86400e3);
    const cagr = (eq ** (1 / yrs) - 1) * 100;
    const net = cagr - fundingCost;
    console.log(
      `era ${e + 1}  ${new Date(vt.times[idx[0]]).toISOString().slice(0, 7)}→${new Date(vt.times[idx[idx.length - 1]]).toISOString().slice(0, 7)}`.padEnd(26) +
      `${cagr.toFixed(1)}%`.padStart(10) + `−${fundingCost.toFixed(1)}%`.padStart(10) +
      `${net.toFixed(1)}%`.padStart(12) + (net > 0 ? "  ✅" : `  ❌ lỗ đều ${yrs.toFixed(1)} năm`));
  }
}

if (require.main === module) main();
