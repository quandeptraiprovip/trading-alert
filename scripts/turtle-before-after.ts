/**
 * turtle-before-after.ts — Báo cáo TRƯỚC/SAU cho thay đổi 2026-08-04.
 *
 * TRƯỚC: entryDays 15 · kênh thoát = kênh vào · pyramid ≤4 unit · không có chính sách heat.
 * SAU  : entryDays 15 · kênh thoát 20d · pyramid ≤3 unit · size ×1/(1+heat/4).
 *
 * NET R thô KHÔNG so được trực tiếp: risk/unit là env var tự do và bản SAU cố ý chạy đòn bẩy thấp
 * hơn. Ba cách đọc đúng, tất cả đều bất biến đòn bẩy hoặc đã chuẩn hoá:
 *   1. Sharpe P&L ngày.
 *   2. "NET R quy đổi" = NET × (maxDD_trước / maxDD_sau) — NET đạt được nếu chỉnh risk/unit cho
 *      maxDD bằng đúng bản cũ.
 *   3. CAGR compounding khi chỉnh risk/unit để maxDD = 30%.
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-before-after.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { AdmitFn, compoundedEquity, portfolioStats, riskForTargetDD, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const heatDecay: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);

  const AFTER: TurtleParams = { ...T, gate };
  const BEFORE: TurtleParams = { ...T, gate, longExitDays: 0, pyramidMaxUnits: 4 };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(T.shortEntryDays * bpd), Math.round((T.longExitDays || T.entryDays) * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const spanDays = (to - from) / TF_MS["1d"];
  const years = spanDays / 365.25;
  const eras = [0, 1, 2].map((k) => ({ name: ["A", "B", "C"][k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));

  const evalOne = (p: TurtleParams, admit?: AdmitFn) => {
    const res = runTurtlePortfolio(data, p, admit);
    const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
    const risk = riskForTargetDD(eq, 0.3);
    const ce = compoundedEquity(eq, risk);
    return {
      res, eq,
      rm: riskMetrics(eq),
      st: portfolioStats(res, { from, to }),
      risk,
      cagr: (Math.pow(Math.max(ce.mult, 1e-9), 1 / years) - 1) * 100,
      era: eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to))),
    };
  };

  const b = evalOne(BEFORE);
  const a = evalOne(AFTER, heatDecay);

  console.log("=".repeat(86));
  console.log(`  TURTLE — TRƯỚC vs SAU (2026-08-04) · ${fmtD(from)} → ${fmtD(to)} · ${spanDays.toFixed(0)} ngày · ${data.size} coin`);
  console.log("=".repeat(86));
  const row = (label: string, x: string, y: string, note = "") =>
    console.log("  " + label.padEnd(30) + x.padStart(14) + y.padStart(14) + (note ? "   " + note : ""));
  row("", "TRƯỚC", "SAU");
  console.log("  " + "-".repeat(60));
  row("unit (lệnh)", String(b.st.n), String(a.st.n));
  row("vị thế", String(b.st.positions), String(a.st.positions));
  row("NET R (risk/unit như nhau)", b.rm.netR.toFixed(0), a.rm.netR.toFixed(0), "← KHÔNG so trực tiếp được");
  row("maxDD (R)", b.rm.maxDD.toFixed(0), a.rm.maxDD.toFixed(0));
  row("Ulcer (R)", b.rm.ulcer.toFixed(1), a.rm.ulcer.toFixed(1));
  row("tháng tệ nhất (R)", b.rm.worstMonthR.toFixed(0), a.rm.worstMonthR.toFixed(0));
  console.log("  " + "-".repeat(60));
  row("SHARPE (P&L ngày)", b.rm.sharpe.toFixed(2), a.rm.sharpe.toFixed(2), `${(((a.rm.sharpe - b.rm.sharpe) / b.rm.sharpe) * 100).toFixed(0)}%`);
  row("Sortino", b.rm.sortino.toFixed(2), a.rm.sortino.toFixed(2));
  row("NET/maxDD", b.rm.netOverMaxDD.toFixed(2), a.rm.netOverMaxDD.toFixed(2));
  row("NET/Ulcer", b.rm.netOverUlcer.toFixed(1), a.rm.netOverUlcer.toFixed(1));
  console.log("  " + "-".repeat(60));
  const equiv = a.rm.netR * (b.rm.maxDD / a.rm.maxDD);
  row("NET R QUY ĐỔI (cùng maxDD)", b.rm.netR.toFixed(0), equiv.toFixed(0), `${(((equiv - b.rm.netR) / b.rm.netR) * 100).toFixed(0)}%`);
  row("risk/unit cho maxDD 30%", (b.risk * 100).toFixed(2) + "%", (a.risk * 100).toFixed(2) + "%");
  row("CAGR tại maxDD 30%", b.cagr.toFixed(0) + "%", a.cagr.toFixed(0) + "%", `${(((a.cagr - b.cagr) / b.cagr) * 100).toFixed(0)}%`);
  // Mức risk ĐANG chạy thật (TURTLE_RISK_PCT mặc định 0,5%/unit) tương ứng drawdown lịch sử nào?
  const live = 0.005;
  const bl = compoundedEquity(b.eq, live), al = compoundedEquity(a.eq, live);
  row("maxDD @ risk 0,5%/unit (LIVE)", (bl.maxDD * 100).toFixed(0) + "%", (al.maxDD * 100).toFixed(0) + "%", "← mức đang chạy thật");
  row("CAGR @ risk 0,5%/unit", ((Math.pow(Math.max(bl.mult, 1e-9), 1 / years) - 1) * 100).toFixed(0) + "%",
    ((Math.pow(Math.max(al.mult, 1e-9), 1 / years) - 1) * 100).toFixed(0) + "%");
  console.log("  " + "-".repeat(60));
  for (let i = 0; i < 3; i++)
    row(`Sharpe era ${eras[i].name} (${fmtD(eras[i].from)})`, b.era[i].sharpe.toFixed(2), a.era[i].sharpe.toFixed(2),
      a.era[i].sharpe > b.era[i].sharpe ? "✅" : "❌");

  console.log("\n  WALK-FORWARD 6 cửa sổ (Sharpe):");
  const K = 6;
  let wf = 0;
  for (let k = 0; k < K; k++) {
    const w = { from: from + ((to - from) * k) / K, to: from + ((to - from) * (k + 1)) / K };
    const bs = riskMetrics(b.res.equity.filter((x) => x.time >= w.from && x.time <= w.to)).sharpe;
    const as = riskMetrics(a.res.equity.filter((x) => x.time >= w.from && x.time <= w.to)).sharpe;
    if (as > bs) wf++;
    console.log(`    W${k + 1} ${fmtD(w.from)}→${fmtD(w.to)}: ${bs.toFixed(2).padStart(6)} → ${as.toFixed(2).padStart(6)}  ${as > bs ? "✅" : "❌"}`);
  }
  console.log(`    → SAU thắng ${wf}/${K} cửa sổ`);

  console.log("\n  THEO SYMBOL (NET R, risk/unit như nhau):");
  for (const s of data.keys()) {
    const bn = b.res.trades.filter((t) => t.symbol === s && t.entryTime >= from).reduce((x, t) => x + t.netR * t.weight, 0);
    const an = a.res.trades.filter((t) => t.symbol === s && t.entryTime >= from).reduce((x, t) => x + t.netR * t.weight, 0);
    console.log(`    ${s.replace("usdt", "").toUpperCase().padEnd(6)}: ${bn.toFixed(0).padStart(7)} → ${an.toFixed(0).padStart(7)}`);
  }

  const maxHeatB = Math.max(...b.eq.map((e) => Math.max(e.longUnits, e.shortUnits)));
  const maxHeatA = Math.max(...a.eq.map((e) => Math.max(e.longUnits, e.shortUnits)));
  console.log(`\n  Risk cùng hướng cao nhất từng chạm: ${maxHeatB.toFixed(1)} → ${maxHeatA.toFixed(1)} đơn vị`);
  console.log(`  (với TURTLE_RISK_PCT hiện tại 0,5%/unit: ${(maxHeatB * 0.5).toFixed(1)}% → ${(maxHeatA * 0.5).toFixed(1)}% equity)`);
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
