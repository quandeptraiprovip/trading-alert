/**
 * fx-reversion.ts — lỗ hổng còn lại trong lập luận. Ba bài trước đều loại chiều THUẬN xu hướng.
 * Nhưng "major không trend" và "major hồi quy về trung bình" là hai mệnh đề khác nhau: nếu tỉ giá
 * dao động quanh một mức cân bằng thì chiều NGƯỢC mới là chiều có tiền. Không test cái này thì
 * kết luận "cặp tiền không có edge" mới chỉ đúng một nửa.
 *
 * LUẬT (kinh điển, khai báo trước, quét ĐÚNG hai biến):
 *   z = (close − SMA(L)) / stdev(L). Vào NGƯỢC khi |z| ≥ k, thoát khi z về 0 hoặc quá `maxHold`.
 *   L ∈ {10, 20, 50} ngày · k ∈ {1,5; 2,0; 2,5} → 9 tổ hợp, IN HẾT kể cả xấu.
 *   Size vol-target giống fx-native.ts để so sánh được trực tiếp.
 *
 * KHÔNG có stop: đây là thiết kế có chủ ý, không phải sơ suất. Reversion mà cắt lỗ theo biến động
 * thì tự cắt đúng lúc luận điểm của mình đang đúng nhất. Bỏ stop làm kết quả TỐT HƠN thực tế
 * (rủi ro đuôi vô hạn) — nên nếu ngay cả thế mà vẫn phẳng thì kết luận càng chắc.
 *
 * Chạy: npx ts-node fx/fx-reversion.ts
 */

import { CROSSES, FX7, METALS, loadDaily } from "./fx-transfer";

const LOOKBACKS = [10, 20, 50];
const ZS = [1.5, 2.0, 2.5];
const MAX_HOLD = 20;      // ngày giao dịch — chặn vị thế treo vô hạn
const TARGET_VOL = 0.10;
const SWAP_PCT_PER_DAY = 0.0042;

interface Bar { openTime: number; close: number; spread: number }

function reversionPnl(bars: Bar[], L: number, k: number) {
  const ret: number[] = [0];
  for (let i = 1; i < bars.length; i++) ret.push(Math.log(bars[i].close / bars[i - 1].close));

  const out: { time: number; gross: number; net: number }[] = [];
  let w = 0, held = 0;
  for (let i = L + 1; i < bars.length; i++) {
    // Quyết định dùng dữ liệu tới nến i−1; P&L nhận ở nến i.
    const win = bars.slice(i - L, i).map((b) => b.close);
    const mean = win.reduce((s, x) => s + x, 0) / L;
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / (L - 1));
    const z = sd > 0 ? (bars[i - 1].close - mean) / sd : 0;

    let turnover = 0;
    const prev = w;
    if (w !== 0) {
      held++;
      if ((prev > 0 && z >= 0) || (prev < 0 && z <= 0) || held >= MAX_HOLD) { w = 0; held = 0; }
    }
    if (w === 0 && Math.abs(z) >= k) {
      const rWin = ret.slice(i - 60 > 0 ? i - 60 : 0, i);
      const m = rWin.reduce((s, x) => s + x, 0) / rWin.length;
      const rsd = Math.sqrt(rWin.reduce((s, x) => s + (x - m) ** 2, 0) / (rWin.length - 1));
      const annVol = rsd * Math.sqrt(252);
      w = annVol > 0 ? -Math.sign(z) * Math.min(TARGET_VOL / annVol, 10) : 0;
      held = 0;
    }
    turnover = Math.abs(w - prev);
    const spreadFrac = bars[i - 1].spread / bars[i - 1].close;
    const cost = turnover * spreadFrac + Math.abs(w) * (SWAP_PCT_PER_DAY / 100);
    out.push({ time: bars[i].openTime, gross: w * ret[i], net: w * ret[i] - cost });
  }
  return out;
}

function stats(p: number[], times: number[]) {
  const n = p.length;
  const mean = p.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(p.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of p) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const byYear = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = new Date(times[i]).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + p[i]);
  }
  const yrs = [...byYear.values()];
  return {
    annRet: mean * 252, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0, maxDD,
    t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    posYears: yrs.filter((v) => v > 0).length, nYears: yrs.length,
  };
}

function report(label: string, symbols: string[]) {
  console.log(`\n─── ${label} (${symbols.length} công cụ) ───`);
  console.log("L / k".padEnd(12) + "annRet".padStart(8) + "Sharpe".padStart(8) + "maxDD".padStart(8) +
    "t-stat".padStart(8) + "năm+".padStart(8) + "   | GROSS Sharpe  t-stat");
  for (const L of LOOKBACKS) {
    for (const k of ZS) {
      const perDay = new Map<number, { g: number; n: number }>();
      for (const s of symbols) {
        for (const p of reversionPnl(loadDaily(s) as Bar[], L, k)) {
          const d = Math.floor(p.time / 86400e3);
          const e = perDay.get(d) ?? { g: 0, n: 0 };
          e.g += p.gross; e.n += p.net;
          perDay.set(d, e);
        }
      }
      const days = [...perDay.keys()].sort((a, b) => a - b);
      const times = days.map((d) => d * 86400e3);
      const net = stats(days.map((d) => perDay.get(d)!.n / symbols.length), times);
      const gross = stats(days.map((d) => perDay.get(d)!.g / symbols.length), times);
      console.log(
        `${L}d / ${k.toFixed(1)}σ`.padEnd(12) +
        `${(net.annRet * 100).toFixed(1)}%`.padStart(8) + net.sharpe.toFixed(2).padStart(8) +
        `${(net.maxDD * 100).toFixed(0)}%`.padStart(8) + net.t.toFixed(2).padStart(8) +
        `${net.posYears}/${net.nYears}`.padStart(8) +
        `   | ${gross.sharpe.toFixed(2).padStart(6)}  ${gross.t.toFixed(2).padStart(6)}`,
      );
    }
  }
}

async function main() {
  console.log("═══ HỒI QUY VỀ TRUNG BÌNH TRÊN CẶP TIỀN (chiều ngược với trend) ═══");
  console.log("Không stop ⇒ kết quả này ĐẸP HƠN thực tế. Phẳng ở đây = kết luận chắc.");
  report("FX7 — major USD", FX7);
  report("FX11 — major + cross", [...FX7, ...CROSSES]);
  report("Vàng + Bạc (đối chứng: nơi trend ĂN)", METALS);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
