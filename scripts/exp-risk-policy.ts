/**
 * exp-risk-policy.ts — chính sách risk danh mục: 1/(1+H/k) hiện tại có phải dạng ĐÚNG không?
 *
 * ĐỘNG CƠ TỪ SỐ LIỆU: `exp-market-regime.ts` đo tương quan trung bình cặp của rổ tăng từ 0,49 (2021)
 * lên 0,81 (2026). Với corr 0,81 thì 8 vị thế cùng hướng KHÔNG phải 8 cược — độ lệch chuẩn danh mục
 * gần như tỉ lệ THẲNG với số vị thế, chứ không phải với căn bậc hai. Công thức 1/(1+H/k) là hằng số
 * theo thời gian nên không biết điều đó.
 *
 * LÝ THUYẾT (không phải tham số dò): với H unit cùng hướng, tương quan cặp ρ, độ lệch chuẩn danh mục
 *   σ(H) ∝ sqrt( H + H(H−1)ρ ).
 * Muốn σ không đổi thì tỉ trọng mỗi unit phải là w = 1 / sqrt( H + H(H−1)ρ ).
 *   ρ = 0 ⇒ w = 1/√H  (các cược độc lập)
 *   ρ = 1 ⇒ w = 1/H   (chỉ là một cược nhân lên)
 * Đây chính là vol targeting cấp danh mục (Harvey et al. 2018), viết cho R thay vì cho %.
 *
 * ĐỐI CHỨNG BẮT BUỘC: quét trên cũng cho thấy "siết mạnh hơn thì tốt hơn" (k=2 > k=4 > k=20). Vì vậy
 * phải so công thức nhận biết tương quan với heat SIẾT MẠNH NHẤT, nếu không sẽ nhầm "biết tương quan"
 * với "siết mạnh". Có cả biến thể ρ CỐ ĐỊNH để tách phần "hình dạng công thức" khỏi phần "ρ động".
 *
 * Chuẩn hoá: mọi chính sách đều được chỉnh đòn bẩy về cùng maxDD ⇒ so bằng tiền.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-risk-policy.ts [days] [targetDDpct]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

/**
 * ρ TRUNG BÌNH CẶP của rổ, ước lượng trượt 90 ngày, CHỈ dùng nến đã đóng trước t (không lookahead).
 * Trả hàm t → ρ; thiếu dữ liệu thì trả giá trị mặc định thận trọng 0,7.
 */
function rollingCorr(data: Map<string, Candle[]>, windowDays = 90): (t: number) => number {
  const daily = new Map<string, Map<number, number>>();
  for (const [sym, c] of data) {
    const closeByDay = new Map<number, number>();
    for (const b of c) closeByDay.set(Math.floor(b.openTime / DAY), b.close);
    const days = [...closeByDay.keys()].sort((a, b) => a - b);
    const r = new Map<number, number>();
    for (let i = 1; i < days.length; i++) {
      const p0 = closeByDay.get(days[i - 1])!, p1 = closeByDay.get(days[i])!;
      if (p0 > 0) r.set(days[i], Math.log(p1 / p0));
    }
    daily.set(sym, r);
  }
  const syms = [...daily.keys()];
  const cache = new Map<number, number>();
  return (t: number) => {
    const end = Math.floor(t / DAY);
    if (cache.has(end)) return cache.get(end)!;
    const days: number[] = [];
    for (let d = end - windowDays; d < end; d++) days.push(d);
    let sum = 0, pairs = 0;
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        const a = daily.get(syms[i])!, b = daily.get(syms[j])!;
        const xs: number[] = [], ys: number[] = [];
        for (const d of days) {
          const x = a.get(d), y = b.get(d);
          if (x !== undefined && y !== undefined) { xs.push(x); ys.push(y); }
        }
        if (xs.length < windowDays * 0.6) continue;
        const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
        let cov = 0, sx = 0, sy = 0;
        for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); sx += (xs[k] - mx) ** 2; sy += (ys[k] - my) ** 2; }
        if (sx > 0 && sy > 0) { sum += cov / Math.sqrt(sx * sy); pairs++; }
      }
    }
    const rho = pairs ? Math.max(0, Math.min(0.99, sum / pairs)) : 0.7;
    cache.set(end, rho);
    return rho;
  };
}

function dailyR(res: PortfolioResult, from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(m.get(d) ?? 0);
  return out;
}

function riskForDD(series: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of series) {
      e *= 1 + rho * r;
      if (e <= 0) return 1;
      peak = Math.max(peak, e);
      m = Math.max(m, (peak - e) / peak);
    }
    return m;
  };
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}

const sharpeOf = (s: number[]) => {
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const targetDD = parseFloat(process.argv[3] ?? "30") / 100;
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const years = (w.to - w.from) / (365 * DAY);
  const rhoAt = rollingCorr(data);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(2)} năm) · maxDD ép về ${(targetDD * 100).toFixed(0)}%`);
  console.log(`ρ trượt 90 ngày: đầu kỳ ${rhoAt(w.from + 200 * DAY).toFixed(2)} · giữa ${rhoAt((w.from + w.to) / 2).toFixed(2)} · cuối ${rhoAt(w.to).toFixed(2)}\n`);

  // H = heat cùng hướng KỂ CẢ unit sắp mở (heat hiện tại chỉ đếm unit đã mở → +1 cho nhất quán)
  const POLICIES: [string, AdmitFn][] = [
    ["heat k=4 (ĐANG CHẠY)", (c) => 1 / (1 + c.sameDirHeat / 4)],
    ["heat k=2 (siết mạnh nhất đã quét)", (c) => 1 / (1 + c.sameDirHeat / 2)],
    ["heat k=1", (c) => 1 / (1 + c.sameDirHeat / 1)],
    ["1/√H  (giả định ρ=0)", (c) => 1 / Math.sqrt(c.sameDirHeat + 1)],
    ["1/H   (giả định ρ=1)", (c) => 1 / (c.sameDirHeat + 1)],
    ["vol-target ρ CỐ ĐỊNH 0,7", (c) => { const H = c.sameDirHeat + 1; return 1 / Math.sqrt(H + H * (H - 1) * 0.7); }],
    ["vol-target ρ ĐỘNG 90d", (c) => { const H = c.sameDirHeat + 1; const r = rhoAt(c.time); return 1 / Math.sqrt(H + H * (H - 1) * r); }],
  ];

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    console.log("=".repeat(116));
    console.log(`  ${name} — chính sách tỉ trọng risk (mọi dòng ép về cùng maxDD ⇒ so bằng VỐN CUỐI KỲ)`);
    console.log("=".repeat(116));
    console.log("chính sách                          vịthế   Sharpe   VỐN(×)   era A/B/C (×)          365d(×)   WF Sharpe TB   số WF âm");
    console.log("-".repeat(116));
    for (const [label, admit] of POLICIES) {
      const res = runBooks(bk, admit);
      const s = dailyR(res, w.from, w.to);
      const rho = riskForDD(s, targetDD);
      let e = 1;
      for (const r of s) e *= 1 + rho * r;
      const eraCells = w.eras.map((era) => {
        const a = Math.floor(era.from / DAY) - Math.floor(w.from / DAY);
        const b = Math.floor(era.to / DAY) - Math.floor(w.from / DAY);
        let x = 1;
        for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) x *= 1 + rho * s[i];
        return x.toFixed(2);
      });
      let e365 = 1;
      for (let i = Math.max(0, s.length - 365); i < s.length; i++) e365 *= 1 + rho * s[i];
      const wf: number[] = [];
      for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
      const pos = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
      console.log(
        `${label.padEnd(35)} ${String(pos).padStart(6)}   ${sharpeOf(s).toFixed(2).padStart(6)}   ${e.toFixed(2).padStart(6)}   ` +
          `${eraCells.join(" / ").padEnd(20)}   ${e365.toFixed(2).padStart(6)}   ${(wf.reduce((a, x) => a + x, 0) / wf.length).toFixed(2).padStart(11)}   ` +
          `${String(wf.filter((x) => x < 0).length).padStart(7)}`,
      );
    }
    console.log();
  }
}

if (require.main === module && /exp-risk-policy\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
