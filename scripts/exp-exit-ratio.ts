/**
 * exp-exit-ratio.ts — Tham số hoá kênh THOÁT theo TỈ LỆ với kênh VÀO (exit = entry × ratio).
 *
 * Lý do: perturbation cho thấy `longExitDays=20` cố định mong manh (19/30) — vì khi jitter làm
 * entryDays trôi, khoảng cách vào/ra đổi theo. Đại lượng có ý nghĩa cơ chế là "kênh thoát rộng hơn
 * kênh vào bao nhiêu lần", không phải con số ngày tuyệt đối. Nếu ratio tạo plateau trơn thì đây là
 * tham số hoá ĐÚNG và bền hơn.
 *
 * Đồng thời kiểm tra: decay mạnh hơn có THAY THẾ được việc cắt maxUnits 4→3 không (ưu tiên bản
 * không bỏ lệnh, ít knob hơn).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-exit-ratio.ts [days]
 */
import { TF_MS } from "../strategy";
import { T } from "../turtle";
import { AdmitFn, EquityPoint, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 24 * 3600 * 1000;
const decay = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

function sharpeIn(eq: EquityPoint[], from: number, to: number): number {
  const m = new Map<number, number>();
  const win = eq.filter((e) => e.time >= from && e.time <= to);
  for (let i = 1; i < win.length; i++) {
    const d = Math.floor(win[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (win[i].mtm - win[i - 1].mtm));
  }
  const r = [...m.values()];
  if (r.length < 2) return 0;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const base: ExtParams = { ...T, gate };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(90 * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const K = 6;
  const wins = [...Array(K)].map((_, k) => ({ from: from + ((to - from) * k) / K, to: from + ((to - from) * (k + 1)) / K }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}\n`);

  const run = (p: ExtParams, admit?: AdmitFn) =>
    runBooks([...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p })), admit);

  const baseEq = run(base).equity;
  const baseFull = sharpeIn(baseEq, from, to);
  const baseW = wins.map((w) => sharpeIn(baseEq, w.from, w.to));
  console.log(`HIỆN TẠI: Sharpe ${baseFull.toFixed(3)} | WF ${baseW.map((x) => x.toFixed(2)).join(" ")}\n`);

  const RATIOS = [1.0, 1.15, 1.33, 1.5, 1.75, 2.0, 2.5];
  const ENTRIES = [12, 15, 18];

  console.log("── (a) PLATEAU THEO TỈ LỆ exit/entry (decay k=4, maxUnits 4) — Sharpe toàn kỳ ──");
  console.log("entry\\ratio" + RATIOS.map((r) => r.toFixed(2).padStart(8)).join(""));
  for (const ed of ENTRIES) {
    const row = RATIOS.map((r) => {
      const eq = run({ ...base, entryDays: ed, longExitDays: Math.round(ed * r) }, decay(4)).equity;
      return sharpeIn(eq, from, to).toFixed(2).padStart(8);
    });
    console.log(`${ed}d`.padEnd(11) + row.join(""));
  }

  console.log("\n── (b) decay k × maxUnits tại ratio 1.33 — decay mạnh có thay thế được u3? ──");
  console.log("k\\units" + [3, 4, 5].map((u) => String(u).padStart(9)).join("") + "   (Sharpe toàn kỳ | số cửa sổ WF thắng)");
  for (const k of [2, 3, 4, 6, 8]) {
    const row = [3, 4, 5].map((mu) => {
      const eq = run({ ...base, longExitDays: Math.round(T.entryDays * 1.33), pyramidMaxUnits: mu }, decay(k)).equity;
      const w = wins.filter((wd, i) => sharpeIn(eq, wd.from, wd.to) > baseW[i]).length;
      return `${sharpeIn(eq, from, to).toFixed(2)}|${w}`.padStart(9);
    });
    console.log(`k=${k}`.padEnd(7) + row.join(""));
  }

  console.log("\n── (c) PERTURBATION cho bản tham số hoá TỈ LỆ (±15%, 30 seed, so với baseline cũng bị jitter) ──");
  const variants: [string, number, number, number][] = [
    // label, ratio, decayK, maxUnits
    ["ratio1.33 k4 u4", 1.33, 4, 4],
    ["ratio1.33 k4 u3", 1.33, 4, 3],
    ["ratio1.33 k2 u4", 1.33, 2, 4],
    ["ratio1.5  k4 u4", 1.5, 4, 4],
    ["ratio1.5  k4 u3", 1.5, 4, 3],
    ["ratio1.75 k4 u3", 1.75, 4, 3],
  ];
  console.log("biến thể".padEnd(20) + "Sharpe".padStart(8) + "Δ".padStart(8) + "pert Δ>0".padStart(10) + "median Δ".padStart(10) + " | eraA    B    C");
  const eras = [0, 1, 2].map((k) => ({ from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  for (const [label, ratio, k, mu] of variants) {
    const p: ExtParams = { ...base, longExitDays: Math.round(T.entryDays * ratio), pyramidMaxUnits: mu };
    const eq = run(p, decay(k)).equity;
    const full = sharpeIn(eq, from, to);
    const ds: number[] = [];
    for (let s = 0; s < 30; s++) {
      const rnd = (i: number) => { const x = Math.sin((s + 1) * 12.9898 + i * 78.233) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
      const jit = (v: number, i: number, amp = 0.15) => v * (1 + rnd(i) * amp);
      const ed = Math.max(5, Math.round(jit(T.entryDays, 1)));
      const common = {
        entryDays: ed,
        shortEntryDays: Math.max(5, Math.round(jit(T.shortEntryDays, 2))),
        chandelierMult: jit(T.chandelierMult, 4),
        atrPeriod: Math.max(5, Math.round(jit(T.atrPeriod, 5))),
        trendLen: Math.max(10, Math.round(jit(T.trendLen, 6))),
        maxHoldDays: Math.max(10, Math.round(jit(T.maxHoldDays, 7))),
        pyramidStepAtr: jit(T.pyramidStepAtr, 8),
      };
      const b = sharpeIn(run({ ...base, ...common }).equity, from, to);
      const a = sharpeIn(
        run({ ...base, ...common, longExitDays: Math.round(ed * jit(ratio, 11)), pyramidMaxUnits: Math.max(1, mu + (rnd(9) > 0.5 ? 1 : rnd(9) < -0.5 ? -1 : 0)) },
          decay(jit(k, 10, 0.3))).equity, from, to);
      ds.push(a - b);
    }
    ds.sort((a, b) => a - b);
    const eraS = eras.map((e) => sharpeIn(eq, e.from, e.to));
    console.log(
      label.padEnd(20) + full.toFixed(2).padStart(8) + (full - baseFull).toFixed(3).padStart(8) +
        `${ds.filter((d) => d > 0).length}/30`.padStart(10) + ds[15].toFixed(3).padStart(10) + " |" +
        eraS.map((x) => x.toFixed(2).padStart(6)).join(""),
    );
  }
  const beraS = eras.map((e) => sharpeIn(baseEq, e.from, e.to));
  console.log("HIỆN TẠI".padEnd(20) + baseFull.toFixed(2).padStart(8) + "—".padStart(8) + "—".padStart(10) + "—".padStart(10) + " |" + beraS.map((x) => x.toFixed(2).padStart(6)).join(""));
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
