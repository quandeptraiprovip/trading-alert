/**
 * exp-allocation.ts — PHÂN BỔ RISK giữa các sleeve, chấm bằng đồng tiền chứ không bằng R thô.
 *
 * CÂU HỎI: với CÙNG một mức đau (maxDD compounding cố định), cách chia risk nào cho nhiều tiền nhất?
 * Đây là câu hỏi đúng, vì "NET R" thô so sánh được giữa hai cấu hình CHỈ KHI chúng chạy cùng risk/unit
 * VÀ cùng maxDD. Một sleeve giảm DD có thể chạy đòn bẩy cao hơn để về lại DD cũ — chỉ khi quy đổi như
 * vậy thì "nhiều R hơn" mới thành "nhiều tiền hơn".
 *
 * KHÔNG MANG RỦI RO OVERFIT: không đổi một luật vào/ra nào. Chỉ đổi tỉ trọng vốn giữa các sổ đã có.
 *
 * Nền: `chop-regime-diagnosis-2026-08.md` §5 đo corr P&L ngày Turtle↔Fast = 0,96 và Sharpe đơn điệu
 * giữa hai đầu mút ⇒ chia đôi KHÔNG đa dạng hoá. Ở đây quy kết luận đó ra số tiền, và kiểm tra thêm
 * giả thuyết mới: phần thua thiệt của Fast đến từ PHÍ MEXC (0,08%) chứ không phải từ tốc độ 10 ngày.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-allocation.ts [days] [targetDDpct]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

/** P&L NGÀY theo R từ chuỗi mark-to-market. */
function dailyR(res: PortfolioResult): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  return m;
}

function mix(parts: { s: Map<number, number>; w: number }[], from: number, to: number) {
  const d0 = Math.floor(from / DAY), d1 = Math.floor(to / DAY);
  const days: number[] = [];
  for (let d = d0; d <= d1; d++) days.push(d);
  return { days, series: days.map((d) => parts.reduce((acc, p) => acc + p.w * (p.s.get(d) ?? 0), 0)) };
}

/** Nhân đòn bẩy ρ sao cho maxDD compounding = target. */
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
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dd(mid) > target) hi = mid;
    else lo = mid;
  }
  return lo;
}

function stats(series: number[], years: number, target: number) {
  const rho = riskForDD(series, target);
  let e = 1;
  for (const r of series) e *= 1 + rho * r;
  const mean = series.reduce((s, x) => s + x, 0) / series.length;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / (series.length - 1));
  return {
    rho,
    mult: e,
    cagr: e > 0 ? (Math.pow(e, 1 / years) - 1) * 100 : -100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    netR: series.reduce((s, x) => s + x, 0),
  };
}

function corr(a: Map<number, number>, b: Map<number, number>) {
  const ks = [...a.keys()].filter((k) => b.has(k));
  const xs = ks.map((k) => a.get(k)!), ys = ks.map((k) => b.get(k)!);
  if (xs.length < 3) return NaN;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
  return sx > 0 && sy > 0 ? cov / Math.sqrt(sx * sy) : NaN;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const targetDD = parseFloat(process.argv[3] ?? "30") / 100;
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const years = (w.to - w.from) / (365 * DAY);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(2)} năm) · ${data.size} coin`);
  console.log(`Chuẩn hoá: mọi cấu hình được chỉnh đòn bẩy để maxDD compounding = ${(targetDD * 100).toFixed(0)}%\n`);

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const heat: AdmitFn = decayH(T.heatDecayK);

  // ── Các sổ thành phần ──
  const S = {
    turtle: dailyR(runBooks(bk(turtle, "t15"), heat)),                                   // đang chạy
    fastMexc: dailyR(runBooks(bk(fast, "f10"), undefined)),                              // đang chạy (KHÔNG heat)
    fastMexcHeat: dailyR(runBooks(bk(fast, "f10h"), heat)),                              // §6 chop-diagnosis: chưa ship
    fastBinance: dailyR(runBooks(bk({ ...fast, takerFeePct: 0.05 }, "f10b"), heat)),     // giả thuyết: phí là thủ phạm
    turtle10: dailyR(runBooks(bk({ ...turtle, entryDays: 10 }, "t10"), heat)),           // luật Turtle, tốc độ 10
  };

  console.log("Tương quan P&L NGÀY giữa các sổ:");
  console.log(`  Turtle15 ↔ Fast(MEXC)     ${corr(S.turtle, S.fastMexc).toFixed(3)}`);
  console.log(`  Turtle15 ↔ Turtle10       ${corr(S.turtle, S.turtle10).toFixed(3)}`);
  console.log(`  Fast(MEXC) ↔ Fast(Binance) ${corr(S.fastMexc, S.fastBinance).toFixed(3)}\n`);

  const CONFIGS: [string, { s: Map<number, number>; w: number }[]][] = [
    ["ĐANG CHẠY: ½ Turtle + ½ Fast(MEXC)", [{ s: S.turtle, w: 0.5 }, { s: S.fastMexc, w: 0.5 }]],
    ["½ Turtle + ½ Fast(MEXC)+heat k4", [{ s: S.turtle, w: 0.5 }, { s: S.fastMexcHeat, w: 0.5 }]],
    // Giả định: nếu giải được xung đột vị thế thì Fast chạy được trên Binance (phí 0,05 thay vì 0,08).
    // Không ship được ngay — đây là CÁI GIÁ của việc tách sàn, không phải một khuyến nghị.
    ["½ Turtle + ½ Fast(phí Binance)+heat", [{ s: S.turtle, w: 0.5 }, { s: S.fastBinance, w: 0.5 }]],
    ["CHỈ Turtle 15d", [{ s: S.turtle, w: 1 }]],
    ["CHỈ Fast 10d (MEXC, như hiện tại)", [{ s: S.fastMexc, w: 1 }]],
    ["CHỈ Fast 10d + heat k4", [{ s: S.fastMexcHeat, w: 1 }]],
    ["CHỈ Fast 10d + heat, phí Binance", [{ s: S.fastBinance, w: 1 }]],
    ["CHỈ Turtle tốc độ 10d", [{ s: S.turtle10, w: 1 }]],
    ["½ Turtle15 + ½ Turtle10 (cùng Binance)", [{ s: S.turtle, w: 0.5 }, { s: S.turtle10, w: 0.5 }]],
    ["¾ Turtle15 + ¼ Fast(MEXC)", [{ s: S.turtle, w: 0.75 }, { s: S.fastMexc, w: 0.25 }]],
  ];

  const windows: [string, number, number][] = [
    ["TOÀN KỲ", w.from, w.to],
    ["era A", w.eras[0].from, w.eras[0].to],
    ["era B", w.eras[1].from, w.eras[1].to],
    ["era C", w.eras[2].from, w.eras[2].to],
    ["730d cuối", w.to - 730 * DAY, w.to],
    ["365d cuối", w.to - 365 * DAY, w.to],
  ];

  console.log("=".repeat(122));
  console.log(`  VỐN CUỐI KỲ khi mọi cấu hình đều bị ép về maxDD = ${(targetDD * 100).toFixed(0)}% (khởi điểm 1,00)`);
  console.log("=".repeat(122));
  console.log("cấu hình                                 risk/unit   TOÀN KỲ (×)   CAGR%   Sharpe   NET R    era A/B/C (×)        365d(×)");
  console.log("-".repeat(122));
  for (const [label, parts] of CONFIGS) {
    const full = mix(parts, w.from, w.to);
    const st = stats(full.series, years, targetDD);
    const cells = windows.slice(1, 4).map(([, a, b]) => {
      const m = mix(parts, a, b);
      let e = 1;
      for (const r of m.series) e *= 1 + st.rho * r;
      return e.toFixed(2);
    });
    const m365 = mix(parts, w.to - 365 * DAY, w.to);
    let e365 = 1;
    for (const r of m365.series) e365 *= 1 + st.rho * r;
    console.log(
      `${label.padEnd(40)} ${(st.rho * 100).toFixed(2).padStart(7)}%   ${st.mult.toFixed(2).padStart(9)}   ` +
        `${st.cagr.toFixed(1).padStart(6)}   ${st.sharpe.toFixed(2).padStart(6)}   ${st.netR.toFixed(0).padStart(5)}    ` +
        `${cells.join(" / ").padEnd(20)} ${e365.toFixed(2)}`,
    );
  }

  // Walk-forward: Sharpe trung bình trên 56 cửa sổ 365 ngày trượt theo tháng
  console.log("\n" + "=".repeat(122));
  console.log("  ỔN ĐỊNH — 365 ngày trượt theo tháng: Sharpe TB, số cửa sổ âm, cửa sổ tệ nhất");
  console.log("=".repeat(122));
  console.log("cấu hình                                 n cửa sổ   Sharpe TB   số âm   Sharpe tệ nhất");
  console.log("-".repeat(122));
  for (const [label, parts] of CONFIGS) {
    const sh: number[] = [];
    for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) {
      const m = mix(parts, end - 365 * DAY, end);
      const mean = m.series.reduce((s, x) => s + x, 0) / m.series.length;
      const sd = Math.sqrt(m.series.reduce((s, x) => s + (x - mean) ** 2, 0) / (m.series.length - 1));
      sh.push(sd > 0 ? (mean / sd) * Math.sqrt(365) : 0);
    }
    console.log(
      `${label.padEnd(40)} ${String(sh.length).padStart(8)}   ${(sh.reduce((s, x) => s + x, 0) / sh.length).toFixed(2).padStart(9)}   ` +
        `${String(sh.filter((x) => x < 0).length).padStart(5)}   ${Math.min(...sh).toFixed(2).padStart(14)}`,
    );
  }
}

if (require.main === module && /exp-allocation\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
