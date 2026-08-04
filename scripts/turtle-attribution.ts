/**
 * turtle-attribution.ts — R đang được tạo ra / mất đi ở ĐÂU? Chẩn đoán trước khi đề xuất.
 * Cắt theo: hướng, lý do thoát, thứ tự unit, thời gian giữ, era, symbol, và tháng.
 *
 * Run: ./node_modules/.bin/ts-node scripts/turtle-attribution.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { UnitTrade, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function line(label: string, ts: UnitTrade[], total: number) {
  const n = ts.length;
  const net = ts.reduce((s, t) => s + t.netR, 0);
  const wr = n ? (ts.filter((t) => t.netR > 0).length / n) * 100 : 0;
  const cost = ts.reduce((s, t) => s + t.costR, 0);
  const avgHold = n ? (ts.reduce((s, t) => s + t.holdBars, 0) / n) * (TF_MS[T.tf] / TF_MS["1d"]) : 0;
  console.log(
    "  " + label.padEnd(22) +
      String(n).padStart(5) +
      net.toFixed(0).padStart(8) +
      (n ? net / n : 0).toFixed(3).padStart(8) +
      wr.toFixed(0).padStart(6) +
      cost.toFixed(0).padStart(8) +
      avgHold.toFixed(1).padStart(8) +
      ((total ? (net / total) * 100 : 0).toFixed(0) + "%").padStart(8),
  );
}
const HDR = "  " + "nhóm".padEnd(22) + "unit".padStart(5) + "NET R".padStart(8) + "exp".padStart(8) +
  "WR%".padStart(6) + "costR".padStart(8) + "giữ(d)".padStart(8) + "%NET".padStart(8);

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const p: TurtleParams = { ...T, gate };
  const res = runTurtlePortfolio(data, p);

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(T.entryDays * bpd), Math.round(T.shortEntryDays * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const all = res.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
  const total = all.reduce((s, t) => s + t.netR, 0);
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)} | ${all.length} unit | NET ${total.toFixed(0)}R\n`);

  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));

  console.log("── THEO HƯỚNG ──");
  console.log(HDR);
  for (const d of ["long", "short"] as const) line(d, all.filter((t) => t.dir === d), total);
  for (const e of eras) {
    console.log(`  — era ${e.name} (${fmtD(e.from)}→${fmtD(e.to)})`);
    const sub = all.filter((t) => t.entryTime >= e.from && t.entryTime < e.to);
    for (const d of ["long", "short"] as const) line(`  ${d}`, sub.filter((t) => t.dir === d), total);
  }

  console.log("\n── THEO LÝ DO THOÁT ──");
  console.log(HDR);
  for (const r of ["trail", "mid", "time"] as const) line(r, all.filter((t) => t.exitReason === r), total);
  for (const d of ["long", "short"] as const)
    for (const r of ["trail", "mid", "time"] as const)
      line(`${d}/${r}`, all.filter((t) => t.dir === d && t.exitReason === r), total);

  console.log("\n── THEO THỨ TỰ UNIT (pyramiding) ──");
  console.log(HDR);
  for (let u = 0; u < 4; u++) line(`unit #${u + 1}`, all.filter((t) => t.unitIndex === u), total);

  console.log("\n── THEO THỜI GIAN GIỮ ──");
  console.log(HDR);
  const buckets: [string, number, number][] = [["<1d", 0, 6], ["1-3d", 6, 18], ["3-7d", 18, 42], ["7-14d", 42, 84], ["14-30d", 84, 180], [">30d", 180, 1e9]];
  for (const [name, lo, hi] of buckets) line(name, all.filter((t) => t.holdBars >= lo && t.holdBars < hi), total);

  console.log("\n── THEO SYMBOL ──");
  console.log(HDR);
  for (const s of data.keys()) line(s, all.filter((t) => t.symbol === s), total);

  console.log("\n── TẬP TRUNG LỢI NHUẬN ──");
  const sorted = [...all].sort((a, b) => b.netR - a.netR);
  for (const k of [5, 10, 20, 50]) {
    const top = sorted.slice(0, k).reduce((s, t) => s + t.netR, 0);
    console.log(`  Top ${String(k).padStart(3)} unit đóng góp ${((top / total) * 100).toFixed(0)}% NET (${top.toFixed(0)}R)`);
  }
  const pos = all.filter((t) => t.netR > 0).reduce((s, t) => s + t.netR, 0);
  const neg = all.filter((t) => t.netR <= 0).reduce((s, t) => s + t.netR, 0);
  console.log(`  Tổng lãi ${pos.toFixed(0)}R / tổng lỗ ${neg.toFixed(0)}R → profit factor ${(pos / -neg).toFixed(2)}`);
  console.log(`  Tổng chi phí đã trừ: ${all.reduce((s, t) => s + t.costR, 0).toFixed(0)}R (${((all.reduce((s, t) => s + t.costR, 0) / (total + all.reduce((s, t) => s + t.costR, 0))) * 100).toFixed(0)}% gross)`);

  console.log("\n── SỐ UNIT MỞ CÙNG LÚC (phân bố) ──");
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  const hist = new Map<number, number>();
  for (const e of eq) hist.set(e.openUnits, (hist.get(e.openUnits) ?? 0) + 1);
  const keys = [...hist.keys()].sort((a, b) => a - b);
  let cum = 0;
  for (const k of keys) {
    cum += hist.get(k)!;
    if (k % 2 === 0 || k === keys[keys.length - 1])
      console.log(`  ${String(k).padStart(2)} unit: ${((hist.get(k)! / eq.length) * 100).toFixed(1).padStart(5)}% thời gian (tích luỹ ${((cum / eq.length) * 100).toFixed(0)}%)`);
  }
  const rm = riskMetrics(eq);
  console.log(`\n  Sharpe ${rm.sharpe.toFixed(2)} | Ulcer ${rm.ulcer.toFixed(1)} | maxDD ${rm.maxDD.toFixed(0)}R | skew ${rm.skew.toFixed(2)} | tháng tệ nhất ${rm.worstMonthR.toFixed(0)}R`);
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
