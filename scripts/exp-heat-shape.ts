/**
 * exp-heat-shape.ts — (1) CƠ CHẾ nào làm chính sách giảm-size-theo-heat hoạt động, và
 *                     (2) kết quả có phụ thuộc DẠNG HÀM cụ thể không (nếu có → là fit, không phải cơ chế).
 *
 * (1) Hai giả thuyết cạnh tranh:
 *     H-risk : lợi ích thuần tuý là ổn định rủi ro ex-ante (vol targeting cấp danh mục).
 *              → expectancy MỖI unit sẽ KHÔNG đổi theo mức đông đúc; chỉ phương sai đổi.
 *     H-alpha: unit vào khi sổ đã đông là unit KÉM hơn (trend đã già / vào muộn / thị trường đồng pha).
 *              → expectancy mỗi unit GIẢM theo mức đông đúc.
 *     Đo trực tiếp bằng cách ghi lại heat tại thời điểm vào của từng unit ở bản BASELINE.
 *
 * (2) Nếu chỉ dạng 1/(1+h/k) thắng còn exp(−h/k), (1−h/k)+ … thua thì đó là fit dạng hàm.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-heat-shape.ts [days]
 */
import { TF_MS } from "../strategy";
import { T, TurtleParams } from "../turtle";
import { AdmitFn, portfolioStats, riskMetrics, runTurtlePortfolio } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const p: TurtleParams = { ...T, gate };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(T.entryDays * bpd), Math.round(T.shortEntryDays * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({ name: ["A", "B", "C"][k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}\n`);

  // ── (1) Ghi heat tại thời điểm vào của từng unit (bản BASELINE, mọi weight = 1) ──
  const heatAt = new Map<string, number>();
  const recorder: AdmitFn = (c) => {
    heatAt.set(`${c.symbol}|${c.time}|${c.dir}|${c.kind}`, c.sameDirHeat);
    return 1;
  };
  const base = runTurtlePortfolio(data, p, recorder);
  const win = base.trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
  const withHeat = win.map((t) => ({
    t,
    h: heatAt.get(`${t.symbol}|${t.entryTime}|${t.dir}|${t.unitIndex === 0 ? "entry" : "add"}`) ?? -1,
  })).filter((x) => x.h >= 0);

  console.log("── (1) EXPECTANCY THEO MỨC ĐÔNG ĐÚC TẠI LÚC VÀO (baseline, weight=1) ──");
  console.log("  heat cùng hướng      unit   NET R      exp    WR%  | expA     B     C");
  console.log("  " + "-".repeat(74));
  const buckets: [string, number, number][] = [["0 (sổ trống)", 0, 1], ["1-2", 1, 3], ["3-5", 3, 6], ["6-9", 6, 10], ["10-15", 10, 16], ["16-23", 16, 24], ["24+", 24, 1e9]];
  for (const [name, lo, hi] of buckets) {
    const g = withHeat.filter((x) => x.h >= lo && x.h < hi);
    const net = g.reduce((s, x) => s + x.t.netR, 0);
    const wr = g.length ? (g.filter((x) => x.t.netR > 0).length / g.length) * 100 : 0;
    const eraExp = eras.map((e) => {
      const gg = g.filter((x) => x.t.entryTime >= e.from && x.t.entryTime < e.to);
      return gg.length ? gg.reduce((s, x) => s + x.t.netR, 0) / gg.length : NaN;
    });
    console.log(
      "  " + name.padEnd(18) + String(g.length).padStart(6) + net.toFixed(0).padStart(8) +
        (g.length ? net / g.length : 0).toFixed(3).padStart(9) + wr.toFixed(0).padStart(7) + "  |" +
        eraExp.map((x) => (Number.isFinite(x) ? x.toFixed(2) : "—").padStart(6)).join(""),
    );
  }
  // hệ số tương quan hạng giữa heat và netR
  const n = withHeat.length;
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length).fill(0);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rh = rank(withHeat.map((x) => x.h)), rr = rank(withHeat.map((x) => x.t.netR));
  const mh = rh.reduce((s, x) => s + x, 0) / n, mr = rr.reduce((s, x) => s + x, 0) / n;
  let num = 0, dh = 0, dr = 0;
  for (let i = 0; i < n; i++) { num += (rh[i] - mh) * (rr[i] - mr); dh += (rh[i] - mh) ** 2; dr += (rr[i] - mr) ** 2; }
  console.log(`\n  Spearman(heat, netR) = ${(num / Math.sqrt(dh * dr)).toFixed(3)}  (n=${n})`);
  console.log("  → gần 0 ⇒ H-risk (lợi ích là ổn định rủi ro). Âm rõ ⇒ H-alpha (unit vào lúc đông là unit kém).");

  // ── (2) Dạng hàm khác nhau ──
  const shapes: [string, AdmitFn][] = [
    ["1/(1+h/2)", (c) => 1 / (1 + c.sameDirHeat / 2)],
    ["1/(1+h/4)", (c) => 1 / (1 + c.sameDirHeat / 4)],
    ["exp(-h/4)", (c) => Math.exp(-c.sameDirHeat / 4)],
    ["exp(-h/8)", (c) => Math.exp(-c.sameDirHeat / 8)],
    ["max(.1,1-h/8)", (c) => Math.max(0.1, 1 - c.sameDirHeat / 8)],
    ["max(.1,1-h/16)", (c) => Math.max(0.1, 1 - c.sameDirHeat / 16)],
    ["1/(1+n_sym/2)", (c) => 1 / (1 + new Set(c.open.filter((u) => u.dir === c.dir).map((u) => u.symbol)).size / 2)],
    ["1/(1+h_all/4)", (c) => 1 / (1 + c.totalHeat / 4)],
    ["1/√(1+h/2)", (c) => 1 / Math.sqrt(1 + c.sameDirHeat / 2)],
    ["h≤4 rồi 1/(1+h/4)", (c) => (c.sameDirHeat <= 4 ? 1 : 1 / (1 + (c.sameDirHeat - 4) / 4))],
  ];
  console.log("\n── (2) DẠNG HÀM — nếu mọi dạng đều thắng baseline thì là CƠ CHẾ, không phải fit ──");
  console.log("dạng                   NET R  Sharpe NET/Ulc  NET/DD  maxHeat | SharpeA      B      C");
  console.log("-".repeat(90));
  const show = (label: string, admit?: AdmitFn) => {
    const res = runTurtlePortfolio(data, p, admit);
    const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
    const rm = riskMetrics(eq);
    const maxHeat = Math.max(...eq.map((e) => Math.max(e.longUnits, e.shortUnits)));
    const era = eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
    console.log(
      label.padEnd(22) + rm.netR.toFixed(0).padStart(8) + rm.sharpe.toFixed(2).padStart(8) +
        rm.netOverUlcer.toFixed(1).padStart(8) + rm.netOverMaxDD.toFixed(2).padStart(8) +
        maxHeat.toFixed(1).padStart(9) + " |" + era.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
    );
  };
  show("BASELINE (w=1)");
  for (const [label, fn] of shapes) show(label, fn);
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
