/**
 * audit-candidates.ts — Kiểm định NGHIÊM cho các ứng viên trước khi đụng vào production.
 *
 * Vì sao cần: Sharpe ước lượng trên 5,7 năm có sai số chuẩn ~0,6 — mọi so sánh "1,39 vs 1,57" đọc
 * độc lập đều VÔ NGHĨA. Nhưng các biến thể chạy trên CÙNG dữ liệu và chia sẻ phần lớn P&L, nên phép
 * so đúng là GHÉP CẶP (paired), nơi sai số nhỏ hơn nhiều.
 *
 * Bốn phép kiểm:
 *   (1) Paired moving-block bootstrap (block 28 ngày) trên ΔSharpe — CI90 và CI99 (CI99 để chịu
 *       hiệu chỉnh đa kiểm định: nghiên cứu này đã thử ~100 biến thể).
 *   (2) Walk-forward 6 cửa sổ — bao nhiêu cửa sổ ứng viên thắng?
 *   (3) Perturbation ±15% mọi tham số × 30 seed — edge sống qua nhiễu tham số hay chỉ ở một điểm?
 *   (4) Leave-one-symbol-out — cải thiện có phụ thuộc một coin duy nhất không?
 *
 * Run: ./node_modules/.bin/ts-node scripts/audit-candidates.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T } from "../turtle";
import { AdmitFn, EquityPoint, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 24 * 3600 * 1000;

const decay = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

interface Variant { label: string; p: ExtParams; admit?: AdmitFn }

/** Chuỗi P&L ngày (R) trên cửa sổ đánh giá. */
function dailySeries(eq: EquityPoint[], from: number, to: number): { day: number; r: number }[] {
  const m = new Map<number, number>();
  const win = eq.filter((e) => e.time >= from && e.time <= to);
  for (let i = 1; i < win.length; i++) {
    const d = Math.floor(win[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (win[i].mtm - win[i - 1].mtm));
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([day, r]) => ({ day, r }));
}

function sharpeOf(r: number[]): number {
  const n = r.length;
  if (n < 2) return 0;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
}

/** Moving-block bootstrap GHÉP CẶP: cùng chỉ số block cho cả hai chuỗi → giữ tương quan. */
function pairedBootstrap(a: number[], b: number[], block = 28, B = 5000) {
  const n = a.length;
  const nBlocks = Math.ceil(n / block);
  const diffs: number[] = [];
  for (let it = 0; it < B; it++) {
    const ra: number[] = [], rb: number[] = [];
    for (let k = 0; k < nBlocks; k++) {
      const start = Math.floor(Math.random() * Math.max(1, n - block));
      for (let j = 0; j < block && ra.length < n; j++) {
        ra.push(a[start + j]);
        rb.push(b[start + j]);
      }
    }
    diffs.push(sharpeOf(rb) - sharpeOf(ra));
  }
  diffs.sort((x, y) => x - y);
  const q = (p: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(p * diffs.length)))];
  return { p05: q(0.05), p50: q(0.5), p95: q(0.95), p005: q(0.005), p995: q(0.995), pPos: diffs.filter((d) => d > 0).length / B };
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
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)}  (${((to - from) / DAY).toFixed(0)} ngày)\n`);

  const run = (v: Variant, subset?: Map<string, Candle[]>) => {
    const d = subset ?? data;
    const books = [...d.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: v.p }));
    return runBooks(books, v.admit);
  };

  // Mốc so sánh = cấu hình TRƯỚC 2026-08-04 (kênh thoát = kênh vào, ≤4 unit, không chính sách heat).
  const CURRENT: Variant = { label: "TRƯỚC 2026-08-04", p: { ...base, longExitDays: 0, pyramidMaxUnits: 4 } };
  const cands: Variant[] = [
    { label: "A. chỉ heat-decay k=4", p: { ...base, longExitDays: 0, pyramidMaxUnits: 4 }, admit: decay(4) },
    { label: "B. chỉ exit20", p: { ...base, pyramidMaxUnits: 4 } },
    { label: "C. chỉ ≤3 unit", p: { ...base, longExitDays: 0 } },
    { label: "D. heat-decay + exit20", p: { ...base, pyramidMaxUnits: 4 }, admit: decay(4) },
    { label: "E. ĐANG SHIP (cả 3)", p: { ...base }, admit: decay(4) },
  ];

  const baseSeries = dailySeries(run(CURRENT).equity, from, to);
  const baseR = baseSeries.map((x) => x.r);
  console.log(`${CURRENT.label}: Sharpe ${sharpeOf(baseR).toFixed(3)} trên ${baseR.length} ngày\n`);

  // ── (1) Paired bootstrap ──
  console.log("── (1) PAIRED MOVING-BLOCK BOOTSTRAP (block 28d, B=5000) trên ΔSharpe ──");
  console.log("ứng viên".padEnd(30) + "Sharpe".padStart(8) + "ΔSharpe".padStart(9) + "CI90".padStart(20) + "CI99".padStart(20) + "P(Δ>0)".padStart(9));
  console.log("-".repeat(96));
  const kept: Variant[] = [];
  for (const v of cands) {
    const s = dailySeries(run(v).equity, from, to).map((x) => x.r);
    const bs = pairedBootstrap(baseR, s);
    const ok90 = bs.p05 > 0, ok99 = bs.p005 > 0;
    console.log(
      v.label.padEnd(30) + sharpeOf(s).toFixed(2).padStart(8) + (sharpeOf(s) - sharpeOf(baseR)).toFixed(3).padStart(9) +
        `[${bs.p05.toFixed(3)}, ${bs.p95.toFixed(3)}]${ok90 ? "✅" : "❌"}`.padStart(20) +
        `[${bs.p005.toFixed(3)}, ${bs.p995.toFixed(3)}]${ok99 ? "✅" : "❌"}`.padStart(20) +
        (bs.pPos * 100).toFixed(1).padStart(8) + "%",
    );
    if (ok90) kept.push(v);
  }

  // ── (2) Walk-forward 6 cửa sổ ──
  console.log("\n── (2) WALK-FORWARD 6 CỬA SỔ (Sharpe) ──");
  const K = 6;
  const wins = [...Array(K)].map((_, k) => ({ from: from + ((to - from) * k) / K, to: from + ((to - from) * (k + 1)) / K }));
  console.log("ứng viên".padEnd(30) + wins.map((w, i) => `W${i + 1}`.padStart(8)).join("") + "  thắng");
  console.log("  " + wins.map((w) => fmtD(w.from).slice(2)).join(" ").padEnd(28));
  const baseW = wins.map((w) => sharpeOf(dailySeries(run(CURRENT).equity, w.from, w.to).map((x) => x.r)));
  console.log(CURRENT.label.padEnd(30) + baseW.map((s) => s.toFixed(2).padStart(8)).join(""));
  for (const v of cands) {
    const eq = run(v).equity;
    const ws = wins.map((w) => sharpeOf(dailySeries(eq, w.from, w.to).map((x) => x.r)));
    const w = ws.filter((s, i) => s > baseW[i]).length;
    console.log(v.label.padEnd(30) + ws.map((s) => s.toFixed(2).padStart(8)).join("") + `  ${w}/${K}`);
  }

  // ── (3) Perturbation ──
  console.log("\n── (3) PERTURBATION ±15% × 30 seed (ΔSharpe vẫn > 0?) ──");
  const SEEDS = 30;
  console.log("ứng viên".padEnd(30) + "Δ>0".padStart(8) + "ΔSharpe median".padStart(16) + "min".padStart(9) + "max".padStart(9));
  console.log("-".repeat(74));
  for (const v of cands) {
    const ds: number[] = [];
    for (let s = 0; s < SEEDS; s++) {
      const rnd = (i: number) => {
        const x = Math.sin((s + 1) * 12.9898 + i * 78.233) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
      };
      const jit = (val: number, i: number, amp = 0.15) => val * (1 + rnd(i) * amp);
      const mut = (p: ExtParams): ExtParams => ({
        ...p,
        entryDays: Math.max(3, Math.round(jit(p.entryDays, 1))),
        shortEntryDays: Math.max(5, Math.round(jit(p.shortEntryDays, 2))),
        longExitDays: p.longExitDays ? Math.max(5, Math.round(jit(p.longExitDays, 3))) : p.longExitDays,
        chandelierMult: jit(p.chandelierMult, 4),
        atrPeriod: Math.max(5, Math.round(jit(p.atrPeriod, 5))),
        trendLen: Math.max(10, Math.round(jit(p.trendLen, 6))),
        maxHoldDays: Math.max(10, Math.round(jit(p.maxHoldDays, 7))),
        pyramidStepAtr: jit(p.pyramidStepAtr, 8),
        pyramidMaxUnits: Math.max(1, p.pyramidMaxUnits + (rnd(9) > 0.5 ? 1 : rnd(9) < -0.5 ? -1 : 0)),
      });
      const kJit = 4 * (1 + rnd(10) * 0.3);
      const bp = mut(CURRENT.p), vp = mut(v.p);
      const b = sharpeOf(dailySeries(run({ label: "", p: bp }).equity, from, to).map((x) => x.r));
      const a = sharpeOf(dailySeries(run({ label: "", p: vp, admit: v.admit ? decay(kJit) : undefined }).equity, from, to).map((x) => x.r));
      ds.push(a - b);
    }
    ds.sort((a, b) => a - b);
    console.log(
      v.label.padEnd(30) + `${ds.filter((d) => d > 0).length}/${SEEDS}`.padStart(8) +
        ds[Math.floor(ds.length / 2)].toFixed(3).padStart(16) + ds[0].toFixed(3).padStart(9) + ds[ds.length - 1].toFixed(3).padStart(9),
    );
  }

  // ── (4) Leave-one-symbol-out ──
  console.log("\n── (4) LEAVE-ONE-SYMBOL-OUT (ΔSharpe khi bỏ từng coin) ──");
  const syms = [...data.keys()];
  console.log("ứng viên".padEnd(30) + syms.map((s) => s.replace("usdt", "").toUpperCase().padStart(7)).join(""));
  console.log("-".repeat(30 + syms.length * 7));
  for (const v of cands) {
    const row: string[] = [];
    for (const drop of syms) {
      const sub = new Map([...data.entries()].filter(([k]) => k !== drop));
      const b = sharpeOf(dailySeries(run(CURRENT, sub).equity, from, to).map((x) => x.r));
      const a = sharpeOf(dailySeries(run(v, sub).equity, from, to).map((x) => x.r));
      row.push((a - b).toFixed(2).padStart(7));
    }
    console.log(v.label.padEnd(30) + row.join(""));
  }
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
