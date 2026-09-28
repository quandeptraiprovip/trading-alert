/**
 * B1/B2 — BREAKOUT CÓ ĐỊNH DANH: gắn nhãn cho vị thế Turtle bằng thông tin KHÔNG suy ra từ giá.
 * Protocol (khoá trước, commit 8dbfadd + phụ lục 4e20545): planning/oi-footprint-preregistration-2026-09-28.md
 *
 *   B1 (hai phía) — ΔOI (đơn vị coin) trên đúng cửa sổ kênh vào lệnh: TĂNG = breakout có tiền mới,
 *                   GIẢM = breakout do đóng vị thế (short-covering / long-liquidation).
 *   B2 (một phía, chỉ LONG) — funding TB 15 ngày, phân vị so với 365 ngày trước: ĐÔNG (≥2/3) phải TỆ
 *                   hơn VẮNG (<1/3) — hướng lấy từ Schmeling-Schrimpf-Todorov, *Crypto Carry*.
 *
 * Kết cục chính: P(net vị thế ≥ +3R), R vị thế = tổng netR các unit, trọng số 1 (phụ lục 1).
 * Lý do: 64/908 vị thế mang 144% NET; so TB netR giữa hai nhóm có biên phát hiện LỚN HƠN kỳ vọng.
 *
 * Chạy:
 *   ./node_modules/.bin/ts-node scripts/exp-oi-breakout.ts gate0   ← chỉ đếm nhãn/thiếu/biên, KHÔNG in kết cục
 *   ./node_modules/.bin/ts-node scripts/exp-oi-breakout.ts gate1
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { Book, UnitTrade, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate } from "./rx-lab";
import { CORE8, POOL46, loadPool } from "./exp-breadth";
import { buildLiquidityUniverse } from "./exp-liquidity-universe";
import { FundingPoint, MetricRow, dayStr, loadFunding8h, loadMetricsDays, rowAtOrBefore } from "./oi-metrics";

const DAY = TF_MS["1d"];
const START = Date.UTC(2021, 11, 1);
const TOP_N = 30;
const BIG_R = 3;
const Z = 2.39;
const BOOT = 2000;
const PERM = 1000;
const FUND_WIN = 15 * DAY;
const FUND_HIST = 365 * DAY;
const MIN_FUND_HIST_POINTS = 180;

interface Pos {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;   // openTime nến tín hiệu
  cutoff: number;      // giờ đóng nến tín hiệu = mốc cắt không nhìn trước
  win: number;         // cửa sổ kênh vào lệnh (ms)
  net: number;         // tổng netR các unit, trọng số 1
  big: boolean;
  momentum: number;    // |ln(close lúc vào / close đầu cửa sổ)|
  month: string;
}

function positions(trades: UnitTrade[], data: Map<string, Candle[]>): Pos[] {
  const by = new Map<string, UnitTrade[]>();
  for (const t of trades) {
    const k = `${t.book}#${t.positionId}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(t);
  }
  const out: Pos[] = [];
  for (const units of by.values()) {
    const u0 = units.find((u) => u.unitIndex === 0)!;
    if (u0.entryTime < START) continue;
    const win = (u0.dir === "long" ? T.entryDays : T.shortEntryDays) * DAY;
    const c = data.get(u0.symbol)!;
    const i = c.findIndex((x) => x.openTime === u0.entryTime);
    const j = c.findIndex((x) => x.openTime === u0.entryTime - win);
    const net = units.reduce((s, u) => s + u.netR, 0);
    out.push({
      symbol: u0.symbol,
      dir: u0.dir,
      entryTime: u0.entryTime,
      cutoff: u0.entryTime + TF_MS["4h"],
      win,
      net,
      big: net >= BIG_R,
      momentum: i >= 0 && j >= 0 ? Math.abs(Math.log(c[i].close / c[j].close)) : NaN,
      month: new Date(u0.entryTime).toISOString().slice(0, 7),
    });
  }
  return out.sort((a, b) => a.entryTime - b.entryTime);
}

// ── Nhãn B1 ──
type Lab = "A" | "B" | null; // A = nhóm giả thuyết (B1: OI TĂNG · B2: funding ĐÔNG), B = nhóm đối lập

function oiLabel(m: Map<number, MetricRow>, cutoff: number, win: number): Lab {
  const now = rowAtOrBefore(m, cutoff);
  const then = rowAtOrBefore(m, cutoff - win);
  if (!now || !then || now.oi === then.oi) return null;
  return now.oi > then.oi ? "A" : "B";
}

// ── Nhãn B2 ──
function fundingIndex(pts: FundingPoint[]) {
  const pre = [0];
  for (const p of pts) pre.push(pre[pre.length - 1] + p.rate8h);
  const times = pts.map((p) => p.time);
  const lowerBound = (t: number) => { // chỉ số đầu tiên có time >= t
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  };
  /** TB funding (đơn vị 8h) trên các kỳ có time trong (t − FUND_WIN, t]. */
  const meanAt = (t: number): number => {
    const a = lowerBound(t - FUND_WIN + 1);
    const b = lowerBound(t + 1);
    return b - a >= 10 ? (pre[b] - pre[a]) / (b - a) : NaN;
  };
  return { times, lowerBound, meanAt };
}

function fundingLabel(ix: ReturnType<typeof fundingIndex>, cutoff: number): { lab: Lab | "MID"; pct: number } | null {
  const cur = ix.meanAt(cutoff);
  if (!Number.isFinite(cur)) return null;
  const a = ix.lowerBound(cutoff - FUND_HIST);
  const b = ix.lowerBound(cutoff); // chỉ các kỳ TRƯỚC mốc cắt
  const hist: number[] = [];
  for (let k = a; k < b; k++) {
    const v = ix.meanAt(ix.times[k]);
    if (Number.isFinite(v)) hist.push(v);
  }
  if (hist.length < MIN_FUND_HIST_POINTS) return null;
  const pct = hist.filter((v) => v < cur).length / hist.length;
  return { lab: pct >= 2 / 3 ? "A" : pct < 1 / 3 ? "B" : "MID", pct };
}

// ── Thống kê ──
function effect(ps: Pos[], lab: (p: Pos) => Lab): { d: number; nA: number; nB: number; pA: number; pB: number; mA: number; mB: number } {
  let nA = 0, nB = 0, bA = 0, bB = 0, sA = 0, sB = 0;
  for (const p of ps) {
    const l = lab(p);
    if (l === "A") { nA++; bA += +p.big; sA += p.net; } else if (l === "B") { nB++; bB += +p.big; sB += p.net; }
  }
  const pA = nA ? bA / nA : NaN;
  const pB = nB ? bB / nB : NaN;
  return { d: pA - pB, nA, nB, pA, pB, mA: nA ? sA / nA : NaN, mB: nB ? sB / nB : NaN };
}

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootZ(ps: Pos[], lab: (p: Pos) => Lab, d: number): { z: number; sd: number } {
  const months = [...new Set(ps.map((p) => p.month))];
  const byMonth = new Map(months.map((m) => [m, ps.filter((p) => p.month === m)]));
  const r = rng(20260928);
  const ds: number[] = [];
  for (let b = 0; b < BOOT; b++) {
    const sample: Pos[] = [];
    for (let k = 0; k < months.length; k++) sample.push(...byMonth.get(months[Math.floor(r() * months.length)])!);
    const e = effect(sample, lab).d;
    if (Number.isFinite(e)) ds.push(e);
  }
  const m = ds.reduce((a, b) => a + b, 0) / ds.length;
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - m) ** 2, 0) / (ds.length - 1));
  return { z: d / sd, sd };
}

/** Hoán vị nhãn (giữ số lượng) → phân phối D dưới H0. */
function permDist(ps: Pos[], lab: (p: Pos) => Lab): number[] {
  const labeled = ps.filter((p) => lab(p) === "A" || lab(p) === "B");
  const labels = labeled.map((p) => lab(p));
  const r = rng(7919);
  const out: number[] = [];
  for (let k = 0; k < PERM; k++) {
    const sh = labels.slice();
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const m = new Map(labeled.map((p, i) => [p, sh[i]]));
    out.push(effect(labeled, (p) => m.get(p) ?? null).d);
  }
  return out.sort((a, b) => a - b);
}

const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
const sg = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

interface Hyp {
  name: string;
  side: "two" | "neg";                 // B1 hai phía · B2 kỳ vọng D < 0
  set: Pos[];                           // tập vị thế áp dụng
  lab: (p: Pos) => Lab;
  fake: (p: Pos) => Lab;
  missing: number;                      // vị thế không gắn được nhãn (tra trượt)
  mid?: number;                         // B2: tercile giữa (không so)
  core8: (p: Pos) => boolean;
}

function report(h: Hyp, mode: string): boolean {
  const tot = h.set.length;
  const e = effect(h.set, h.lab);
  const labeled = e.nA + e.nB;
  const share = labeled ? e.nA / labeled : NaN;
  const p0 = h.set.filter((p) => p.big).length / Math.max(1, tot);
  const bound = Z * Math.sqrt(p0 * (1 - p0) * (1 / Math.max(1, e.nA) + 1 / Math.max(1, e.nB)));
  console.log(`\n══ ${h.name} ══`);
  console.log(`  vị thế ${tot} · nhãn A ${e.nA} · nhãn B ${e.nB}${h.mid !== undefined ? ` · giữa ${h.mid}` : ""}`
    + ` · KHÔNG nhãn ${h.missing} (${pc(h.missing / Math.max(1, tot))}) · tỉ phần A ${pc(share)}`);
  const c0 = [
    h.missing / Math.max(1, tot) < 0.05 ? null : "thiếu dữ liệu ≥ 5%",
    share >= 0.15 && share <= 0.85 ? null : "nhãn lệch > 85/15 (không có gì để lọc)",
    bound <= p0 ? null : `biên ±${pc(bound)} > tỉ lệ nền ${pc(p0)} (không đủ lực)`,
  ].filter(Boolean);
  console.log(`  CỬA 0: biên phát hiện D (z=${Z}) ±${pc(bound)} trên nền ${pc(p0)} ⇒ ${c0.length ? "RỚT — " + c0.join("; ") : "ĐẬU"}`);
  if (mode === "gate0" || c0.length) return false;

  const { z, sd } = bootZ(h.set, h.lab, e.d);
  const perm = permDist(h.set, h.lab);
  const permOk = h.side === "two"
    ? Math.abs(e.d) > perm.map(Math.abs).sort((a, b) => a - b)[Math.floor(0.99 * PERM)]
    : e.d < perm[Math.floor(0.01 * PERM)];
  const zOk = h.side === "two" ? Math.abs(z) >= Z : z <= -Z;
  const fk = effect(h.set, h.fake);
  const fakeOk = Math.abs(fk.d) < 0.5 * Math.abs(e.d);
  const withMom = h.set.filter((p) => Number.isFinite(p.momentum)).sort((a, b) => a.momentum - b.momentum);
  const strata = [0, 1, 2].map((k) => effect(withMom.slice(Math.floor((k * withMom.length) / 3), Math.floor(((k + 1) * withMom.length) / 3)), h.lab));
  const strataOk = strata.filter((s) => sg(s.d) === sg(e.d)).length >= 2;
  const meanOk = sg(e.mA - e.mB) === sg(e.d);
  const c8 = effect(h.set.filter((p) => h.core8(p)), h.lab);
  const c8Ok = sg(c8.d) === sg(e.d);

  console.log(`  P(net≥+${BIG_R}R): A ${pc(e.pA)} (n ${e.nA}) · B ${pc(e.pB)} (n ${e.nB}) ⇒ D = ${(100 * e.d).toFixed(2)} điểm %`
    + ` · sd bootstrap ${(100 * sd).toFixed(2)} · z = ${z.toFixed(2)} ${zOk ? "✓" : "✗"}`);
  console.log(`  nhãn ngẫu nhiên: ${h.side === "two" ? `|D| p99 = ${(100 * perm.map(Math.abs).sort((a, b) => a - b)[Math.floor(0.99 * PERM)]).toFixed(2)}` : `D p1 = ${(100 * perm[Math.floor(0.01 * PERM)]).toFixed(2)}`} điểm % ${permOk ? "✓" : "✗"}`);
  console.log(`  nhãn GIẢ (dời 365 ngày): D = ${(100 * fk.d).toFixed(2)} điểm % (A ${fk.nA}/B ${fk.nB}) · cần |D_giả| < ½|D| ${fakeOk ? "✓" : "✗"}`);
  console.log(`  tầng động lượng (thấp/giữa/cao): ${strata.map((s) => `${(100 * s.d).toFixed(2)}`).join(" / ")} điểm % · cùng dấu ≥2/3 ${strataOk ? "✓" : "✗"}`);
  console.log(`  TB netR: A ${e.mA.toFixed(3)}R · B ${e.mB.toFixed(3)}R · cùng dấu ${meanOk ? "✓" : "✗"}`);
  console.log(`  CORE8: D = ${(100 * c8.d).toFixed(2)} điểm % (A ${c8.nA}/B ${c8.nB}) · cùng dấu ${c8Ok ? "✓" : "✗"}`);
  const pass = zOk && permOk && fakeOk && strataOk && meanOk && c8Ok;
  console.log(`  ⇒ CỬA 1 ${h.name.split(" ")[0]}: ${pass ? "ĐẬU (còn Cửa 2)" : "RỚT"}`);
  return pass;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "gate0";
  if (mode !== "gate0" && mode !== "gate1") throw new Error("mode: gate0 | gate1");

  const data = await loadPool(2300, POOL46);
  const missingSyms = POOL46.filter((s) => !data.has(s));
  console.log(`Pool ${data.size}/${POOL46.length} symbol${missingSyms.length ? ` · THIẾU: ${missingSyms.join(",")}` : ""}`);
  if (missingSyms.length) throw new Error("loadPool thiếu symbol — phụ lục 1 đòi dừng");

  const baseGate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(baseGate);
  let last = 0;
  for (const c of data.values()) last = Math.max(last, c[c.length - 1].openTime);
  const { inTop } = buildLiquidityUniverse(data, TOP_N, START, last);
  const books: Book[] = [...data.entries()].map(([s, candles]) => ({
    key: s,
    symbol: s,
    candles,
    p: { ...turtle, gate: (t: number, dir: "long" | "short") => baseGate(t, dir) && inTop(s, t) },
  }));
  const res = runBooks(books); // KHÔNG heat: nhãn là thuộc tính của lệnh (phụ lục 1)
  const all = positions(res.trades, data);
  console.log(`Turtle live-params · top-${TOP_N} point-in-time · vị thế đã đóng từ ${dayStr(START)}: ${all.length}`
    + ` (${all.filter((p) => p.dir === "long").length} long / ${all.filter((p) => p.dir === "short").length} short)`
    + ` · ${new Set(all.map((p) => p.symbol)).size} symbol · còn mở cuối kỳ (không tính): ${res.openAtEnd.length}`);

  // ── Tải metrics đúng các ngày cần (mốc cắt, đầu cửa sổ, và bản dời ±365 ngày; kèm ngày liền trước) ──
  const needDays = new Map<string, Set<string>>();
  const want = (s: string, t: number) => {
    const set = needDays.get(s) ?? needDays.set(s, new Set()).get(s)!;
    set.add(dayStr(t)); set.add(dayStr(t - DAY));
  };
  for (const p of all) {
    for (const shift of [0, -365 * DAY, 365 * DAY]) {
      want(p.symbol, p.cutoff + shift);
      want(p.symbol, p.cutoff - p.win + shift);
    }
  }
  const metrics = new Map<string, Map<number, MetricRow>>();
  let nDays = 0;
  for (const [s, days] of needDays) {
    const { byTime } = await loadMetricsDays(s, days);
    metrics.set(s, byTime);
    nDays += days.size;
  }
  console.log(`Metrics: ${nDays} file-ngày cho ${needDays.size} symbol`);

  const oiLab = (p: Pos, shift = 0) => oiLabel(metrics.get(p.symbol)!, p.cutoff + shift, p.win);
  const fakeOi = (p: Pos): Lab => oiLab(p, -365 * DAY) ?? oiLab(p, 365 * DAY);
  const b1Missing = all.filter((p) => oiLab(p) === null).length;

  // ── Funding cho B2 (chỉ LONG) ──
  const longs = all.filter((p) => p.dir === "long");
  const fIx = new Map<string, ReturnType<typeof fundingIndex>>();
  for (const s of new Set(longs.map((p) => p.symbol))) {
    fIx.set(s, fundingIndex(await loadFunding8h(s, Date.UTC(2020, 0, 1))));
  }
  const fLab = (p: Pos, shift = 0) => fundingLabel(fIx.get(p.symbol)!, p.cutoff + shift);
  const b2 = new Map(longs.map((p) => [p, fLab(p)]));
  const b2Lab = (p: Pos): Lab => { const x = b2.get(p); return x && x.lab !== "MID" ? x.lab : null; };
  const fakeF = (p: Pos): Lab => {
    const x = fLab(p, -365 * DAY) ?? fLab(p, 365 * DAY);
    return x && x.lab !== "MID" ? x.lab : null;
  };

  const core8 = (p: Pos) => CORE8.includes(p.symbol);
  // Bootstrap/hoán vị gọi nhãn hàng triệu lần ⇒ ghi nhớ.
  const memo = (fn: (p: Pos) => Lab) => {
    const m = new Map<Pos, Lab>();
    return (p: Pos): Lab => { if (!m.has(p)) m.set(p, fn(p)); return m.get(p)!; };
  };
  const hyps: Hyp[] = [
    { name: "B1 ΔOI trên cửa sổ kênh (A = OI TĂNG, B = OI GIẢM) · hai phía", side: "two", set: all, lab: memo((p) => oiLab(p)), fake: memo(fakeOi), missing: b1Missing, core8 },
    {
      name: "B2 funding LONG (A = ĐÔNG ≥2/3, B = VẮNG <1/3) · kỳ vọng D < 0", side: "neg", set: longs, lab: memo(b2Lab), fake: memo(fakeF),
      missing: longs.filter((p) => b2.get(p) === null).length,
      mid: longs.filter((p) => b2.get(p)?.lab === "MID").length, core8,
    },
  ];
  const results = hyps.map((h) => report(h, mode));
  if (mode === "gate1") console.log(`\nTÓM TẮT: B1 ${results[0] ? "ĐẬU Cửa 1" : "RỚT"} · B2 ${results[1] ? "ĐẬU Cửa 1" : "RỚT"}`);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error("Lỗi:", e);
    process.exit(1);
  });
}
