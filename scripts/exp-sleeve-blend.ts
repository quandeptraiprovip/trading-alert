/**
 * exp-sleeve-blend.ts — 2026-08-10. Câu hỏi DANH MỤC chưa ai trả lời bằng số:
 *
 *   Hai sleeve đang chạy trùng lặp 95-100% và tương quan P&L tuần 0,97-1,00
 *   (`planning/fast-exit-channel-2026-08.md`). Nếu vậy, chạy CẢ HAI ở nửa size có tốt hơn chạy
 *   MỘT sleeve ở full size không? Hay nó chỉ trả PHÍ HAI LẦN cho cùng một cược?
 *
 * Cách đo: mỗi sleeve cho ra chuỗi P&L NGÀY tính bằng R (cùng risk 0,5%/unit ⇒ 1R hai bên bằng nhau
 * theo equity), nên trộn w·Turtle + (1−w)·Fast là ĐÚNG mô hình "hai sổ risk riêng, tổng risk không đổi".
 * Sharpe bất biến đòn bẩy nên so trực tiếp được; kèm NET/maxDD.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-sleeve-blend.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { EquityPoint, PortfolioResult, riskMetrics, runBooks } from "./portfolio-engine";
import { loadData, windowOf, decayH, books, fmtD } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";

const DAY = TF_MS["1d"];

/** P&L theo NGÀY lịch (đơn vị R) từ chuỗi equity mark-to-market. */
function dailyR(eq: EquityPoint[], from: number, to: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    const d = Math.floor(eq[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return m;
}

interface Stat { sharpe: number; net: number; maxDD: number; netDd: number; worstMonth: number; days: number }

function statsOf(series: number[]): Stat {
  const n = series.length;
  if (n < 3) return { sharpe: 0, net: 0, maxDD: 0, netDd: 0, worstMonth: 0, days: n };
  const mean = series.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of series) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  return {
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    net: cum,
    maxDD,
    netDd: maxDD > 0 ? cum / maxDD : 0,
    worstMonth: 0,
    days: n,
  };
}

function blend(a: Map<number, number>, b: Map<number, number>, wA: number): { days: number[]; series: number[] } {
  const days = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y);
  return { days, series: days.map((d) => wA * (a.get(d) ?? 0) + (1 - wA) * (b.get(d) ?? 0)) };
}

function corr(a: Map<number, number>, b: Map<number, number>): number {
  const days = [...a.keys()].filter((k) => b.has(k));
  const xs = days.map((d) => a.get(d)!), ys = days.map((d) => b.get(d)!);
  if (xs.length < 3) return 0;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return sx > 0 && sy > 0 ? cov / (sx * sy) : 0;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);

  const tRes: PortfolioResult = runBooks(books(data, turtle), decayH(T.heatDecayK));
  const fRes: PortfolioResult = runBooks(books(data, fast));

  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · risk/unit hai sleeve BẰNG NHAU (0,5%) ⇒ R cộng được`);
  console.log("Trộn w·Turtle + (1−w)·Fast = giữ TỔNG risk không đổi, chia cho hai sleeve.\n");

  const windows: [string, number][] = [
    ["toàn kỳ", w.from],
    ["1095d", w.to - 1095 * DAY],
    ["730d", w.to - 730 * DAY],
    ["545d", w.to - 545 * DAY],
    ["365d", w.to - 365 * DAY],
    ["180d", w.to - 180 * DAY],
  ];

  for (const [tag, from] of windows) {
    const tD = dailyR(tRes.equity, from, w.to);
    const fD = dailyR(fRes.equity, from, w.to);
    console.log("=".repeat(104));
    console.log(`  ${tag}  (corr P&L NGÀY Turtle↔Fast = ${corr(tD, fD).toFixed(2)})`);
    console.log("=".repeat(104));
    console.log("  w(Turtle)".padEnd(12) + "Sharpe".padStart(9) + "NET R".padStart(9) + "maxDD".padStart(9) + "NET/DD".padStart(9) + "   ghi chú");
    let best = { w: -1, sharpe: -Infinity };
    for (const wt of [1, 0.75, 0.5, 0.25, 0]) {
      const { series } = blend(tD, fD, wt);
      const s = statsOf(series);
      if (s.sharpe > best.sharpe) best = { w: wt, sharpe: s.sharpe };
      const note = wt === 1 ? "chỉ Turtle" : wt === 0 ? "chỉ Fast" : wt === 0.5 ? "50/50 = ĐANG CHẠY" : "";
      console.log(
        `  ${wt.toFixed(2)}`.padEnd(12) + s.sharpe.toFixed(2).padStart(9) + s.net.toFixed(0).padStart(9) +
          s.maxDD.toFixed(1).padStart(9) + s.netDd.toFixed(2).padStart(9) + `   ${note}`,
      );
    }
    console.log(`  → Sharpe cao nhất ở w=${best.w.toFixed(2)}\n`);
  }

  // Ổn định qua era: 50/50 có thắng "chỉ Turtle" ở CẢ BA era không?
  console.log("=".repeat(104));
  console.log("  Theo ERA (Sharpe): 50/50 có thật sự đa dạng hoá, hay chỉ pha loãng?");
  console.log("=".repeat(104));
  console.log("  era".padEnd(28) + "chỉ Turtle".padStart(12) + "50/50".padStart(12) + "chỉ Fast".padStart(12) + "   corr ngày");
  for (const e of w.eras) {
    const tD = dailyR(tRes.equity, e.from, e.to);
    const fD = dailyR(fRes.equity, e.from, e.to);
    const s = (wt: number) => statsOf(blend(tD, fD, wt).series).sharpe.toFixed(2).padStart(12);
    console.log(`  ${e.name} ${fmtD(e.from)}→${fmtD(e.to)}`.padEnd(28) + s(1) + s(0.5) + s(0) + `   ${corr(tD, fD).toFixed(2)}`);
  }

  // Theo năm
  console.log("\n" + "=".repeat(104));
  console.log("  Theo NĂM (Sharpe | NET R)");
  console.log("=".repeat(104));
  console.log("  năm".padEnd(8) + "chỉ Turtle".padStart(16) + "50/50".padStart(16) + "chỉ Fast".padStart(16) + "   corr ngày");
  for (const y of [2021, 2022, 2023, 2024, 2025, 2026]) {
    const lo = Math.max(Date.UTC(y, 0, 1), w.from);
    const hi = Math.min(Date.UTC(y + 1, 0, 1), w.to);
    if (hi <= lo) continue;
    const tD = dailyR(tRes.equity, lo, hi);
    const fD = dailyR(fRes.equity, lo, hi);
    const c = (wt: number) => { const s = statsOf(blend(tD, fD, wt).series); return `${s.sharpe.toFixed(2)}|${s.net.toFixed(0)}`.padStart(16); };
    console.log(`  ${y}`.padEnd(8) + c(1) + c(0.5) + c(0) + `   ${corr(tD, fD).toFixed(2)}`);
  }

  // ── Ổn định: quét MỌI cửa sổ 365 ngày trượt theo tháng, đếm xem ai thắng ──
  console.log("\n" + "=".repeat(104));
  console.log("  ỔN ĐỊNH — mọi cửa sổ 365 ngày (bước 1 tháng): ai có Sharpe cao nhất?");
  console.log("=".repeat(104));
  const MONTH = 30 * DAY;
  let winT = 0, winB = 0, winF = 0, nWin = 0;
  let sumT = 0, sumB = 0, sumF = 0;
  let blendBest = 0;
  for (let start = w.from; start + 365 * DAY <= w.to; start += MONTH) {
    const end = start + 365 * DAY;
    const tD = dailyR(tRes.equity, start, end);
    const fD = dailyR(fRes.equity, start, end);
    const sT = statsOf(blend(tD, fD, 1).series).sharpe;
    const sB = statsOf(blend(tD, fD, 0.5).series).sharpe;
    const sF = statsOf(blend(tD, fD, 0).series).sharpe;
    nWin++;
    sumT += sT; sumB += sB; sumF += sF;
    const best = Math.max(sT, sB, sF);
    if (best === sT) winT++; else if (best === sF) winF++; else winB++;
    // 50/50 có bao giờ VƯỢT cả hai đầu mút (bằng chứng đa dạng hoá thật) không?
    if (sB > sT && sB > sF) blendBest++;
  }
  console.log(`  ${nWin} cửa sổ · Sharpe TB: chỉ Turtle ${(sumT / nWin).toFixed(2)} · 50/50 ${(sumB / nWin).toFixed(2)} · chỉ Fast ${(sumF / nWin).toFixed(2)}`);
  console.log(`  Số lần thắng: Turtle ${winT} · 50/50 ${winB} · Fast ${winF}`);
  console.log(`  Số cửa sổ mà 50/50 VƯỢT CẢ HAI đầu mút (đa dạng hoá thật): ${blendBest}/${nWin} (${((blendBest / nWin) * 100).toFixed(0)}%)`);

  // Fast + heat-decay k=4 — ứng viên đã có bằng chứng trong planning/fast-exit-channel nhưng CHƯA ship
  const fHeat = runBooks(books(data, fast), decayH(T.heatDecayK));
  console.log("\n" + "=".repeat(104));
  console.log("  Kiểm chứng lại ứng viên ĐÃ CÓ BẰNG CHỨNG nhưng chưa ship: Fast + heat-decay k=4");
  console.log("=".repeat(104));
  for (const [label, r] of [["Fast hiện tại (không heat)", fRes], ["Fast + heat k=4", fHeat]] as [string, PortfolioResult][]) {
    const m = riskMetrics(r.equity.filter((e) => e.time >= w.from));
    const eras = w.eras.map((e) => riskMetrics(r.equity.filter((x) => x.time >= e.from && x.time <= e.to)).sharpe);
    console.log(
      `  ${label.padEnd(28)} Sharpe ${m.sharpe.toFixed(2)} · NET ${m.netR.toFixed(0)}R · maxDD ${m.maxDD.toFixed(1)} · N/DD ${m.netOverMaxDD.toFixed(2)}` +
        ` · era ${eras.map((x) => x.toFixed(2)).join("/")}`,
    );
  }
  {
    const tD = dailyR(tRes.equity, w.from, w.to);
    const fhD = dailyR(fHeat.equity, w.from, w.to);
    console.log(`  corr ngày Turtle↔(Fast+heat) = ${corr(tD, fhD).toFixed(2)} · 50/50 Sharpe = ${statsOf(blend(tD, fhD, 0.5).series).sharpe.toFixed(2)}`);
  }

  // Trùng lặp exposure. LƯU Ý: phí quy ra R KHÔNG phụ thuộc size (costR = phí/risk), nên trùng lặp
  // KHÔNG phải "trả phí hai lần" — cái mất là chi phí/R của Fast cao hơn (MEXC 0,08 vs Binance 0,05).
  const fTr = fRes.trades.filter((t) => t.entryTime >= w.from);
  const tTr = tRes.trades.filter((t) => t.entryTime >= w.from);
  let dup = 0;
  for (const f of fTr) {
    if (tTr.some((t) => t.symbol === f.symbol && t.dir === f.dir && t.entryTime <= f.entryTime && t.exitTime >= f.entryTime)) dup++;
  }
  const costPerUnit = (xs: typeof fTr) => xs.reduce((s, t) => s + t.costR, 0) / (xs.length || 1);
  console.log(
    `\nTRÙNG LẶP EXPOSURE: ${dup}/${fTr.length} unit Fast (${((dup / fTr.length) * 100).toFixed(0)}%) vào khi Turtle ĐANG GIỮ cùng symbol+hướng.` +
      `\nChi phí/R mỗi unit: Turtle ${costPerUnit(tTr).toFixed(3)}R · Fast ${costPerUnit(fTr).toFixed(3)}R` +
      ` (phí quy ra R độc lập với size, nên đây là chênh lệch sàn + thời gian giữ, không phải "phí hai lần").`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
