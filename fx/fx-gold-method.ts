/**
 * fx-gold-method.ts — phương pháp SUY RA TỪ CHỮ KÝ, không phải thử mò.
 *
 * `fx-gold-shape.ts` khoá chặt ba điều về vàng:
 *   1. VR ≈ 1 ở mọi thang, phá vỡ KHÔNG tiếp diễn (t −1,5…0,8 so với nền) ⇒ HƯỚNG không dự báo được.
 *      Mọi luật định thời điểm bằng giá đều bị loại ngay tại đây, kể cả luật chưa nghĩ ra.
 *   2. 96% lợi nhuận nằm ở 1% số ngày ⇒ phải LUÔN CÓ MẶT; ra khỏi thị trường là bỏ lỡ.
 *   3. Chi phí ở thang ngày chỉ bằng 1/14 biên độ ngày ⇒ chi phí KHÔNG phải ràng buộc (khác intraday).
 *
 * Ba điều đó chừa lại đúng MỘT lớp: long-only, luôn ở trong thị trường, và chỉ điều chỉnh KÍCH CỠ.
 * Cơ sở: hướng không tự tương quan nhưng BIẾN ĐỘNG thì có (vol clustering là tính chất phổ quát) —
 * nên thứ dự báo được là rủi ro, không phải lợi nhuận. Vol-targeting khai thác đúng phần dự báo được.
 *
 * ⚠️ ĐỐI CHỨNG BẮT BUỘC: `vol-target-sizing-experiment` trong repo này đã LOẠI vol-targeting cho
 * crypto vì rớt audit OOS. Nên ở đây phải qua đúng những cửa đó: ba era, tập trung theo năm, và
 * mua-và-giữ làm mốc — chứ không được nhận chỉ vì Sharpe cao hơn trên toàn mẫu.
 *
 * Chạy: npx ts-node fx/fx-gold-method.ts [SYMBOL]
 */

import { FxCandle, loadH1 } from "./fx-data";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, runBooks } from "../scripts/portfolio-engine";
import { decayH } from "../scripts/rx-lab";
import { liveSleeves } from "../scripts/chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "../scripts/exp-breadth";
import { dailySeries } from "./fx-validate";

const SYMBOL = process.argv[2] ?? "XAUUSD";
const DAY_CLOSE_H = 22;
const COST_ONEWAY_BPS = 2.73;   // nửa spread era gần nhất + trượt một chiều (xem fx-gold-shape §4)
const TARGET_VOL = 0.15;        // 15%/năm — cùng thang với vol thực tế của vàng, không phải tham số quét
const CAP = 3;                  // trần đòn bẩy

interface Day { t: number; close: number }

export function daily(sym: string): Day[] {
  const bars: FxCandle[] = loadH1(sym);
  const byDay = new Map<number, FxCandle>();
  for (const b of bars) {
    const d = Math.floor((b.openTime - DAY_CLOSE_H * 3600e3) / 86400e3);
    const prev = byDay.get(d);
    if (!prev || b.openTime > prev.openTime) byDay.set(d, b);
  }
  return [...byDay.keys()].sort((a, b) => a - b).map((d) => ({ t: d * 86400e3, close: byDay.get(d)!.close }));
}

interface Perf { cagr: number; vol: number; sharpe: number; dd: number; turnover: number }

function perf(rets: number[], times: number[]): Perf {
  const n = rets.length;
  const mu = rets.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1));
  let eq = 1, peak = 1, dd = 0;
  for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  const years = (times[n - 1] - times[0]) / (365.25 * 86400e3);
  return { cagr: (eq ** (1 / years) - 1) * 100, vol: sd * Math.sqrt(252) * 100,
    sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, dd: dd * 100, turnover: 0 };
}

/** Long-only. `mode`: buy-and-hold, hoặc vol-target với cửa sổ L và băng rebalance `band`. */
export function strat(days: Day[], mode: "bh" | "vt", L = 60, band = 0, cap = CAP):
  { rets: number[]; times: number[]; turnover: number } {
  const r = days.slice(1).map((d, i) => d.close / days[i].close - 1);
  const times = days.slice(1).map((d) => d.t);
  const out: number[] = [], ot: number[] = [];
  let wPrev = 0, turn = 0;
  for (let i = 0; i < r.length; i++) {
    let w = 1;
    if (mode === "vt") {
      if (i < L) continue;
      const win = r.slice(i - L, i);                       // CHỈ dùng dữ liệu đã đóng, không nhìn trước
      const m = win.reduce((s, x) => s + x, 0) / L;
      const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / (L - 1)) * Math.sqrt(252);
      w = sd > 0 ? Math.min(cap, TARGET_VOL / sd) : 0;
      if (band > 0 && wPrev > 0 && Math.abs(w - wPrev) / wPrev < band) w = wPrev;  // băng: bớt vòng quay
    }
    const cost = Math.abs(w - wPrev) * (COST_ONEWAY_BPS / 1e4);
    turn += Math.abs(w - wPrev);
    out.push(w * r[i] - cost);
    ot.push(times[i]);
    wPrev = w;
  }
  return { rets: out, times: ot, turnover: turn };
}

function line(label: string, s: { rets: number[]; times: number[]; turnover: number }, eras: number[]) {
  const p = perf(s.rets, s.times);
  const es = [0, 1, 2].map((e) => {
    const idx = s.times.map((t, i) => [t, i] as const).filter(([t]) => (t < eras[0] ? 0 : t < eras[1] ? 1 : 2) === e).map(([, i]) => i);
    return idx.length > 100 ? perf(idx.map((i) => s.rets[i]), idx.map((i) => s.times[i])).sharpe : NaN;
  });
  console.log(label.padEnd(30) + `${p.cagr.toFixed(1)}%`.padStart(8) + `${p.vol.toFixed(1)}%`.padStart(8) +
    p.sharpe.toFixed(2).padStart(8) + `${p.dd.toFixed(0)}%`.padStart(8) +
    `${(s.turnover / ((s.times[s.times.length - 1] - s.times[0]) / (365.25 * 86400e3))).toFixed(0)}×`.padStart(9) +
    "   " + es.map((x) => (Number.isNaN(x) ? "  n/a" : x.toFixed(2).padStart(5))).join(" /"));
}

async function main() {
  const days = daily(SYMBOL);
  const t0 = days[0].t, t1 = days[days.length - 1].t;
  const eras = [t0 + (t1 - t0) / 3, t0 + (2 * (t1 - t0)) / 3];

  console.log(`═══ ${SYMBOL} — long-only, khác nhau CHỈ Ở KÍCH CỠ (${new Date(t0).toISOString().slice(0, 7)} → ${new Date(t1).toISOString().slice(0, 7)}) ═══`);
  console.log(`Vol mục tiêu ${TARGET_VOL * 100}%/năm · trần ${CAP}× · chi phí ${COST_ONEWAY_BPS} bps/chiều trên vòng quay THẬT\n`);
  console.log("chiến lược".padEnd(30) + "CAGR".padStart(8) + "vol".padStart(8) + "Sharpe".padStart(8) +
    "maxDD".padStart(8) + "quay/năm".padStart(9) + "   Sharpe era1/2/3");

  line("MUA-VÀ-GIỮ (mốc)", strat(days, "bh"), eras);
  for (const L of [20, 60, 120]) line(`vol-target ${L}d`, strat(days, "vt", L), eras);
  for (const band of [0.1, 0.25]) line(`vol-target 60d · băng ${band * 100}%`, strat(days, "vt", 60, band), eras);

  // ── CỬA TẬP TRUNG THEO NĂM ──
  // Phép đã bắt được thứ mà era/holdout bỏ lọt: nếu toàn bộ phần hơn đến từ một năm thì loại.
  console.log("\n═══ CỬA TẬP TRUNG — phần HƠN của vol-target 60d so với mua-và-giữ, theo năm ═══");
  const bh = strat(days, "bh"), vt = strat(days, "vt", 60);
  const bhMap = new Map(bh.times.map((t, i) => [t, bh.rets[i]]));
  const byYear = new Map<number, number>();
  for (let i = 0; i < vt.times.length; i++) {
    const b = bhMap.get(vt.times[i]);
    if (b === undefined) continue;
    const y = new Date(vt.times[i]).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + (vt.rets[i] - b));
  }
  const ys = [...byYear.keys()].sort();
  const total = [...byYear.values()].reduce((s, x) => s + x, 0);
  for (let i = 0; i < ys.length; i += 6) {
    console.log("  " + ys.slice(i, i + 6).map((y) => `${y} ${(byYear.get(y)! * 100).toFixed(1).padStart(6)}%`).join("  │"));
  }
  const top = [...byYear.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`  tổng ${(total * 100).toFixed(1)}% · năm lớn nhất ${top[0]} = ${((top[1] / total) * 100).toFixed(0)}% ` +
    `· ${Math.abs(top[1] / total) < 0.5 ? "✅ ĐẬU" : "❌ RỚT"}`);
  console.log(`  số năm phần hơn DƯƠNG: ${[...byYear.values()].filter((v) => v > 0).length}/${ys.length}`);
  await portfolio(vt, bh);
}

// ── CÂU HỎI THẬT: thêm vào hệ crypto ĐANG CHẠY thì tổng danh mục có tốt lên không? ──────────────
// "Vàng có ăn không" là câu hỏi sai. Một nhánh Sharpe 0,77 vẫn đáng thêm nếu tương quan thấp; một
// nhánh Sharpe 1,5 vẫn vô ích nếu trùng với cái đang có. Chỉ nhận khi nâng ĐỒNG THỜI Sharpe và hồi
// phục của TỔNG. Đối chứng bắt buộc là mua-và-giữ ở CÙNG mức rủi ro — phép đã giết nhánh vàng lần trước.
function stat(m: Map<number, number>) {
  const days = [...m.keys()].sort((a, b) => a - b);
  const v = days.map((d) => m.get(d)!);
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
  let cum = 0, peak = 0, maxDD = 0;
  const byYear = new Map<number, number>();
  for (let i = 0; i < v.length; i++) {
    cum += v[i]; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    const y = new Date(days[i] * 86400e3).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + v[i]);
  }
  const yrs = [...byYear.values()];
  const total = yrs.reduce((s, x) => s + x, 0);
  const rest = yrs.length > 1 ? (total - Math.max(...yrs)) / (yrs.length - 1) : 0;
  return { net: total, sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, maxDD, sd,
    recovery: maxDD > 0 ? rest / maxDD : 0, byYear };
}

async function portfolio(vt: { rets: number[]; times: number[] }, bh: { rets: number[]; times: number[] }) {
  console.log("\n═══ GHÉP VÀO HỆ CRYPTO ĐANG CHẠY — câu hỏi thật ═══");
  const data = await loadPool(2000, CORE8);
  if (data.size < CORE8.length) { console.log(`⚠️  chỉ nạp ${data.size}/${CORE8.length} symbol — BỎ QUA (rổ khuyết cho kết quả sai)`); return; }
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const admit: AdmitFn = decayH(T.heatDecayK);
  const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@t`, symbol, candles, p: turtle }));
  const w = coreWindow(data, T.btcGateSlow + 200);
  const crypto = new Map<number, number>();
  for (const [d, v] of dailySeries(runBooks(bk, admit))) {
    if (d * 86400e3 >= w.from && d * 86400e3 <= w.to) crypto.set(d, v);
  }
  const base = stat(crypto);
  console.log(`NỀN — Turtle CORE8: NET ${base.net.toFixed(0)}R · Sharpe ${base.sharpe.toFixed(2)} · ` +
    `maxDD ${base.maxDD.toFixed(0)}R · hồi phục ${base.recovery.toFixed(2)}`);

  const toMap = (s: { rets: number[]; times: number[] }) => {
    const m = new Map<number, number>();
    for (let i = 0; i < s.times.length; i++) {
      const d = Math.floor(s.times[i] / 86400e3);
      if (crypto.has(d)) m.set(d, s.rets[i]);
    }
    return m;
  };
  console.log("\n" + "nhánh vàng".padEnd(26) + "trọng số".padStart(9) + "corr".padStart(7) +
    "Sharpe TỔNG".padStart(13) + "hồi phục".padStart(10) + "maxDD".padStart(9) + "  đánh giá");
  for (const [label, s] of [["vol-target 60d", vt], ["MUA-VÀ-GIỮ (đối chứng)", bh]] as const) {
    const g = toMap(s);
    const gs = stat(g);
    const vs = [...crypto.keys()].sort().map((d) => [crypto.get(d)!, g.get(d) ?? 0] as const);
    const mc = vs.reduce((a, x) => a + x[0], 0) / vs.length, mg = vs.reduce((a, x) => a + x[1], 0) / vs.length;
    const cov = vs.reduce((a, x) => a + (x[0] - mc) * (x[1] - mg), 0);
    const c = cov / Math.sqrt(vs.reduce((a, x) => a + (x[0] - mc) ** 2, 0) * vs.reduce((a, x) => a + (x[1] - mg) ** 2, 0));
    for (const wt of [0.25, 0.5, 1.0]) {
      const k = (base.sd / gs.sd) * wt;   // chuẩn hoá về rủi ro NGÀY của sleeve crypto rồi nhân trọng số
      const mix = new Map<number, number>();
      for (const [d, v] of crypto) mix.set(d, v + (g.get(d) ?? 0) * k);
      const m = stat(mix);
      const ok = m.sharpe > base.sharpe && m.recovery > base.recovery;
      console.log(label.padEnd(26) + `${(wt * 100).toFixed(0)}%`.padStart(9) + c.toFixed(2).padStart(7) +
        m.sharpe.toFixed(2).padStart(13) + m.recovery.toFixed(2).padStart(10) +
        `${m.maxDD.toFixed(0)}R`.padStart(9) + (ok ? "  ✅ tốt lên" : "  ❌ không"));
    }
  }
  console.log("\nMột nhánh chỉ đáng thêm nếu nâng ĐỒNG THỜI Sharpe và hồi phục. Tương quan thấp không đủ:");
  console.log("thêm một nhánh kỳ vọng ~0 vào danh mục chỉ pha loãng.");

  // ── CỬA QUYẾT ĐỊNH: đóng góp của vàng THEO NĂM, chỉ trong cửa sổ chồng lấn ──
  // Bảng trên đo TOÀN cửa sổ. Nhưng cửa sổ crypto trùng đúng đợt tăng lịch sử của vàng 2024-2025
  // (xem fx-gold-drivers: phần dư +23%/+29%). Nếu toàn bộ đóng góp đến từ một hai năm đó thì bảng
  // trên chỉ đang nói "vàng vừa tăng mạnh", không nói "vàng là nhánh đáng giữ". Đây đúng là phép đã
  // giết đề xuất vàng lần trước (2025 chiếm 96-105%).
  console.log("\n═══ CỬA QUYẾT ĐỊNH — đóng góp vàng theo năm TRONG cửa sổ crypto ═══");
  for (const [label, s] of [["vol-target 60d", vt], ["mua-và-giữ", bh]] as const) {
    const g = toMap(s);
    const gs = stat(g);
    const k = (base.sd / gs.sd) * 0.5;    // trọng số 50% — hàng tốt nhất ở bảng trên
    const yrs = [...gs.byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => [y, v * k] as const);
    const tot = yrs.reduce((a, x) => a + x[1], 0);
    const best = Math.max(...yrs.map((x) => x[1]));
    console.log(`  ${label.padEnd(16)}` + yrs.map(([y, v]) => `${y}:${v >= 0 ? "+" : ""}${v.toFixed(0)}R`).join("  "));
    console.log(`  ${" ".repeat(16)}tổng ${tot.toFixed(0)}R · năm lớn nhất chiếm ` +
      `${tot > 0 ? ((best / tot) * 100).toFixed(0) : "—"}%` +
      `${tot > 0 && best / tot > 0.5 ? "  ❌ RỚT — MỘT NĂM gánh hơn nửa" : "  ✅ ĐẬU"}` +
      ` · năm dương ${yrs.filter((x) => x[1] > 0).length}/${yrs.length}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
