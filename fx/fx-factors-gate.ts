/**
 * fx-factors-gate.ts — CỬA DUYỆT cho ứng viên DUY NHẤT sống sót vòng nhân tố: CARRY.
 *
 * Sau fx-factors.ts + fx-factors-check.ts, bức tranh là:
 *   momentum  — sập sau công bố (mom3 rổ 13: Sharpe 0,64 ≤2011 → −0,27 ≥2012)
 *   value     — ≈0 cả hai kỳ
 *   tổ hợp    — corr(value,mom) = −0,47 đúng như AMP báo (−0,42), cơ chế đa dạng hoá CÒN NGUYÊN,
 *               nhưng đang trộn hai nhân tố lợi suất bằng 0 nên ra một đường phẳng
 *   carry     — Sharpe 0,25, ỔN ĐỊNH cả hai kỳ, khớp đúng con số hậu-GFC của văn liệu (0,25)
 *
 * Chỉ carry đáng đưa vào cửa duyệt. Sáu phép, xếp theo thứ tự CÁI NÀO GIẾT NHANH NHẤT TRƯỚC:
 *   §1 Markup broker  — người bán lẻ KHÔNG nhận chênh lãi suất liên ngân hàng. Phép quyết định.
 *   §2 Rủi ro đuôi    — carry nổi tiếng skew âm; Sharpe không mô tả được nó.
 *   §3 Tập trung      — cùng ngưỡng với scripts/exp-concentration.ts để so được với hệ crypto.
 *   §4 Nhiễu tham số  — số đồng mỗi chân 2/3/4.
 *   §5 Bỏ từng đồng   — có phải chỉ một đồng gánh không.
 *   §6 Tương quan với hệ crypto đang chạy — câu hỏi thật là "có đáng mở NHÁNH THỨ HAI không",
 *      mà một nhánh chỉ đáng mở nếu nó không phải đòn bẩy trá hình của nhánh đang có.
 *
 * Chạy: npx ts-node fx/fx-factors-gate.ts
 */

import { T, buildBtcGateLongs } from "../turtle";
import { runBooks, Book, AdmitFn } from "../scripts/portfolio-engine";
import { decayH } from "../scripts/rx-lab";
import { liveSleeves } from "../scripts/chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "../scripts/exp-breadth";
import {
  FactorResult, G13, G9, HDR, buildPanel, corr, runFactor, show, sigCarry, stats,
} from "./fx-factors";

/** Markup broker thu MỖI CHIỀU trên swap, %/năm. Dải lấy từ biểu phí bán lẻ phổ biến. */
const MARKUPS = [0, 0.5, 1.0, 1.5, 2.0];

/** Cùng ngưỡng với scripts/exp-concentration.ts — không thành phần nào quá nửa lợi nhuận. */
const FAIL_PCT = 50;

/** Trừ markup broker: drag = (tổng |trọng số|) × markup, vì broker cắt trên MỌI chân, cả long lẫn
 *  short. Danh mục 3 long + 3 short có tổng |trọng số| = 2,0 ⇒ markup 1%/năm tốn 2%/năm. */
function afterMarkup(r: FactorResult, markupPctPerYear: number): number[] {
  return r.net.map((v, i) => v - (r.grossExp[i] * markupPctPerYear) / 100 / 12);
}

function perYear(r: number[], months: string[]): [number, number][] {
  const m = new Map<number, number>();
  for (let i = 0; i < r.length; i++) {
    const y = parseInt(months[i].slice(0, 4), 10);
    m.set(y, (m.get(y) ?? 0) + r[i]);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

async function main() {
  const p9 = buildPanel(G9);
  const p13 = buildPanel(G13);
  const base9 = runFactor("carry G9", p9, [sigCarry]);
  const base13 = runFactor("carry G13", p13, [sigCarry]);

  // ── §1. MARKUP BROKER — phép quyết định ──
  console.log("═══ §1. MARKUP BROKER — người bán lẻ không nhận lãi suất liên ngân hàng ═══");
  console.log("Carry là nhân tố DUY NHẤT trong văn liệu mà nguồn lợi nhuận là một dòng tiền broker");
  console.log("trực tiếp kiểm soát. Broker công bố swap của riêng họ, và họ cắt trên CẢ HAI chiều.\n");
  console.log("markup/chiều".padEnd(16) + "G9: annRet  Sharpe".padStart(22) + "G13: annRet  Sharpe".padStart(24));
  for (const m of MARKUPS) {
    const a = stats(afterMarkup(base9, m), base9.months);
    const b = stats(afterMarkup(base13, m), base13.months);
    const dead = b.annRet <= 0 ? "   ← chết" : "";
    console.log(
      `${m.toFixed(1)}%/năm`.padEnd(16) +
      `${(a.annRet * 100).toFixed(2)}%`.padStart(12) + a.sharpe.toFixed(2).padStart(10) +
      `${(b.annRet * 100).toFixed(2)}%`.padStart(14) + b.sharpe.toFixed(2).padStart(10) + dead,
    );
  }
  console.log(
    "\nĐọc: 0%/năm là mức quỹ phòng hộ có quan hệ ngân hàng chính. Tài khoản bán lẻ thực tế nằm ở\n" +
    "0,5–1,5%. Đây KHÔNG phải chi phí có thể thương lượng bằng cách chọn broker tốt hơn — nó là\n" +
    "mô hình kinh doanh của broker bán lẻ.",
  );

  // ── §2. RỦI RO ĐUÔI ──
  console.log("\n═══ §2. RỦI RO ĐUÔI — cái Sharpe không nói ═══");
  for (const [label, r] of [["G9", base9], ["G13", base13]] as [string, FactorResult][]) {
    const s = stats(r.net, r.months);
    const sorted = [...r.net].sort((a, b) => a - b);
    const worst = sorted.slice(0, 3).map((x) => `${(x * 100).toFixed(1)}%`).join(" ");
    // Chuỗi 12 tháng tệ nhất
    let worst12 = 0;
    for (let i = 0; i + 12 <= r.net.length; i++) {
      const s12 = r.net.slice(i, i + 12).reduce((a, b) => a + b, 0);
      worst12 = Math.min(worst12, s12);
    }
    console.log(
      `${label.padEnd(6)} skew ${s.skew.toFixed(2).padStart(6)}  ·  3 tháng tệ nhất: ${worst}` +
      `  ·  12 tháng tệ nhất ${(worst12 * 100).toFixed(1)}%  ·  maxDD ${(s.maxDD * 100).toFixed(0)}%`,
    );
  }
  console.log(
    "Skew âm mạnh = đúng bản chất đã biết của carry (Brunnermeier–Nagel–Pedersen 2008: 'nhặt xu\n" +
    "trước xe lu'). Với Sharpe 0,25 thì phần thưởng không bù được hình dạng rủi ro này.",
  );

  // ── §3. TẬP TRUNG ──
  console.log("\n═══ §3. TẬP TRUNG — cùng ngưỡng với hệ crypto (≤50% mỗi thành phần) ═══");
  for (const [label, r] of [["G9", base9], ["G13", base13]] as [string, FactorResult][]) {
    const s = stats(r.net, r.months);
    const yrs = perYear(r.net, r.months);
    const total = yrs.reduce((a, b) => a + b[1], 0);
    const top = [...yrs].sort((a, b) => b[1] - a[1])[0];
    const ccys = Object.entries(r.byCcy).sort((a, b) => b[1] - a[1]);
    const topC = ccys[0];
    const yPct = total > 0 ? (top[1] / total) * 100 : 0;
    const totC = ccys.reduce((a, b) => a + b[1], 0);
    const cPct = totC > 0 ? (topC[1] / totC) * 100 : 0;
    const pass = total > 0 && yPct <= FAIL_PCT && cPct <= FAIL_PCT;
    console.log(
      `${label}  năm tốt nhất ${top[0]}: ${yPct.toFixed(0)}%  ·  đồng lớn nhất ${topC[0]}: ${cPct.toFixed(0)}%` +
      `  ·  hồi phục ${s.recovery.toFixed(2)}  ⇒ ${pass ? "✅ ĐẬU" : "❌ RỚT"}`,
    );
    console.log(`     theo đồng: ${ccys.map(([c, v]) => `${c} ${(v * 100).toFixed(0)}%`).join("  ")}`);
  }
  console.log(
    "So sánh: Turtle CORE8 đang chạy tiền thật có hồi phục 0,86 drawdown/năm.",
  );

  // ── §4. NHIỄU THAM SỐ ──
  console.log("\n═══ §4. NHIỄU THAM SỐ — số đồng mỗi chân ═══");
  console.log(HDR);
  for (const n of [2, 3, 4]) {
    const r = runFactor(`G13, ${n} đồng/chân`, p13, [sigCarry], n);
    show(`G13, ${n} đồng/chân`, stats(r.net, r.months));
  }

  // ── §5. BỎ TỪNG ĐỒNG ──
  console.log("\n═══ §5. BỎ TỪNG ĐỒNG (rổ 13) ═══");
  const full = stats(base13.net, base13.months).sharpe;
  console.log(`đầy đủ: Sharpe ${full.toFixed(2)}`);
  // Phải GHIM CỬA SỔ THÁNG: rổ đầy đủ bắt đầu 2004-11 vì ZAR chỉ có từ đó, nên bỏ ZAR ra sẽ tự
  // động kéo dài mẫu về 2004-01 và dòng đó không còn so được với các dòng khác. Chỉ tính trên
  // đúng những tháng có trong rổ đầy đủ.
  const baseMonths = new Set(base13.months);
  const drops: [string, number][] = [];
  for (const c of G13) {
    const sub = G13.filter((x) => x !== c);
    const r = runFactor("x", buildPanel(sub), [sigCarry]);
    const net: number[] = [], ms: string[] = [];
    for (let i = 0; i < r.months.length; i++) {
      if (baseMonths.has(r.months[i])) { net.push(r.net[i]); ms.push(r.months[i]); }
    }
    drops.push([c, stats(net, ms).sharpe]);
  }
  for (const [c, s] of drops.sort((a, b) => a[1] - b[1])) {
    console.log(`  bỏ ${c}: Sharpe ${s.toFixed(2)}${s < 0 ? "  ← âm khi thiếu đồng này" : ""}`);
  }

  // ── §5b. LỆCH PHA — bản tháng của phép thử mốc nến ──
  console.log("\n═══ §5b. LỆCH PHA — dịch ngày chốt tái cân bằng ═══");
  console.log("mốc chốt".padEnd(20) + "G13 annRet".padStart(12) + "Sharpe".padStart(9) + "  t-stat");
  const phaseSharpe: number[] = [];
  for (const off of [0, 3, 7, 10, 14, 21]) {
    const r = runFactor("x", buildPanel(G13, off), [sigCarry]);
    const s = stats(r.net, r.months);
    phaseSharpe.push(s.sharpe);
    console.log(
      `cuối tháng −${off}d`.padEnd(20) + `${(s.annRet * 100).toFixed(2)}%`.padStart(12) +
      s.sharpe.toFixed(2).padStart(9) + s.t.toFixed(2).padStart(9),
    );
  }
  const lo = Math.min(...phaseSharpe), hi = Math.max(...phaseSharpe);
  console.log(
    `biên độ Sharpe ${lo.toFixed(2)}…${hi.toFixed(2)}${lo < 0 && hi > 0 ? "  ← ĐỔI DẤU theo mốc chốt" : "  (giữ dấu)"}`,
  );

  // ── §6. TƯƠNG QUAN VỚI HỆ CRYPTO ĐANG CHẠY ──
  console.log("\n═══ §6. TƯƠNG QUAN VỚI HỆ CRYPTO ĐANG CHẠY TIỀN THẬT ═══");
  const data = await loadPool(2000, CORE8);
  if (data.size < CORE8.length) {
    console.log(`⚠️  chỉ nạp được ${data.size}/${CORE8.length} symbol — bỏ qua §6`);
    return;
  }
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const heat: AdmitFn = decayH(T.heatDecayK);
  const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({
    key: `${symbol}@t`, symbol, candles, p: turtle,
  }));
  const w = coreWindow(data, T.btcGateSlow + 200);
  const res = runBooks(bk, heat);

  const cryptoByMonth = new Map<string, number>();
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  for (let i = 1; i < eq.length; i++) {
    const ym = new Date(eq[i].time).toISOString().slice(0, 7);
    cryptoByMonth.set(ym, (cryptoByMonth.get(ym) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < base13.months.length; i++) {
    const v = cryptoByMonth.get(base13.months[i]);
    if (v !== undefined) { a.push(base13.net[i]); b.push(v); }
  }
  console.log(`Tháng chồng lấn: ${a.length}`);
  console.log(`corr(carry FX, Turtle CORE8) = ${corr(a, b).toFixed(3)}`);
  console.log(
    "Tương quan ≈0 là điều kiện CẦN để mở nhánh thứ hai, nhưng không phải điều kiện ĐỦ:\n" +
    "một nhánh có kỳ vọng ≈0 thì dù không tương quan cũng chỉ thêm phương sai và công sức.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
