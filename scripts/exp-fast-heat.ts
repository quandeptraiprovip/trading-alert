/**
 * exp-fast-heat.ts — PLATEAU của heat-decay k cho sleeve Fast (ứng viên ship chính).
 *
 * `exp-allocation.ts` cho thấy thêm heat-decay vào Fast là thay đổi có giá trị nhất (vốn cuối kỳ
 * ở cùng maxDD 30%: 18,06× → 23,69×). Trước khi ship phải chắc k=4 nằm trên CAO NGUYÊN chứ không
 * phải một đỉnh nhọn — nếu chỉ k=4 tốt thì đó là tham số được chọn bằng dữ liệu, không phải chính sách.
 *
 * Chuẩn hoá: mỗi k được chỉnh đòn bẩy riêng để maxDD compounding = 30% ⇒ so sánh bằng tiền, công bằng.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-fast-heat.ts [days] [targetDDpct]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];

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
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (dd(mid) > target) hi = mid; else lo = mid;
  }
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
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${years.toFixed(2)} năm) · maxDD ép về ${(targetDD * 100).toFixed(0)}%\n`);

  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const decay = (k: number): AdmitFn | undefined => (k <= 0 ? undefined : (c) => 1 / (1 + c.sameDirHeat / k));
  const turtleSeries = dailyR(runBooks(bk(turtle), decay(T.heatDecayK)!), w.from, w.to);

  console.log("=".repeat(112));
  console.log("  FAST — quét k (0 = TẮT, đúng như đang chạy). Cột cuối = danh mục ½ Turtle + ½ Fast.");
  console.log("=".repeat(112));
  console.log("   k     vịthế   Sharpe(Fast)   vốn Fast(×)   |   Sharpe danh mục   VỐN DANH MỤC(×)   365d(×)   WF Sharpe TB");
  console.log("-".repeat(112));
  for (const k of [0, 2, 3, 4, 5, 6, 8, 12, 20]) {
    const res = runBooks(bk(fast), decay(k));
    const s = dailyR(res, w.from, w.to);
    const rhoF = riskForDD(s, targetDD);
    let eF = 1;
    for (const r of s) eF *= 1 + rhoF * r;

    const mixSeries = s.map((x, i) => 0.5 * x + 0.5 * turtleSeries[i]);
    const rhoM = riskForDD(mixSeries, targetDD);
    let eM = 1;
    for (const r of mixSeries) eM *= 1 + rhoM * r;
    const d365 = Math.floor((w.to - 365 * DAY) / DAY) - Math.floor(w.from / DAY);
    let e365 = 1;
    for (let i = Math.max(0, d365); i < mixSeries.length; i++) e365 *= 1 + rhoM * mixSeries[i];

    const wf: number[] = [];
    const totalDays = mixSeries.length;
    for (let end = 365; end <= totalDays; end += 30) wf.push(sharpeOf(mixSeries.slice(end - 365, end)));

    const pos = new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size;
    console.log(
      `${(k === 0 ? "TẮT" : String(k)).padStart(4)}   ${String(pos).padStart(6)}   ${sharpeOf(s).toFixed(2).padStart(10)}   ` +
        `${eF.toFixed(2).padStart(10)}   |   ${sharpeOf(mixSeries).toFixed(2).padStart(13)}   ${eM.toFixed(2).padStart(14)}   ` +
        `${e365.toFixed(2).padStart(7)}   ${(wf.reduce((a, x) => a + x, 0) / wf.length).toFixed(2).padStart(12)}`,
    );
  }
}

if (require.main === module && /exp-fast-heat\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
