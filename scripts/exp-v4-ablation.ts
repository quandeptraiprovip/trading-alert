/**
 * exp-v4-ablation.ts — PHƯƠNG PHÁP ĐANG CHẠY (Turtle v4) có thành phần nào THỪA hay RA QUYẾT ĐỊNH SAI?
 *
 * Bỏ TỪNG thành phần một khỏi bản v4 live (heat k=4 ảnh chụp đầu nến, mid-exit 20d, 3 unit, BTC gate,
 * EMA50, OB stop, short 30d, time-stop 60d) và chấm bằng các cửa sẵn có của repo:
 *   · 4 LƯỚI NẾN LỆCH PHA 0h/1h/2h/3h (giả-OOS: không pha lệch nào tham gia chọn tham số)
 *   · 3 era theo lịch · rổ POINT-IN-TIME top-10 thanh khoản (không hindsight CORE8)
 *   · tập trung theo NĂM của phần chênh lệch
 *
 * TIÊU CHÍ PHÂN LOẠI — CHỐT TRƯỚC KHI CHẠY (28/09/2026), không sửa sau khi thấy số:
 *   ΔS = Sharpe(bỏ thành phần) − Sharpe(v4), tính trên MỖI pha.
 *   CẦN THIẾT   : ΔS < 0 ở ≥ 3/4 pha VÀ ΔS < 0 trên rổ point-in-time.
 *   HẠI (sai)   : ΔS > 0 VÀ ΔNET/DD > 0 ở CẢ 4/4 pha, ΔS > 0 ở ≥ 2/3 era (TB 4 pha), ΔS > 0 trên rổ
 *                 point-in-time, và không năm nào mang > 50% phần cải thiện. Đậu hết cũng chỉ là
 *                 "ứng viên" — Reality Check của repo đòi ΔSharpe ≈ +0,6 mới có ý nghĩa sau chọn lọc.
 *   KHÔNG CẦN THIẾT: không rơi vào hai nhóm trên VÀ |ΔS TB 4 pha| < 0,10 VÀ ΔS point-in-time ≥ −0,10
 *                 ⇒ không đo được là nó làm gì; giữ nó chỉ thêm tham số (rủi ro overfit) mà không có
 *                 bằng chứng lợi ích.
 *   còn lại     : KHÔNG RÕ (tác dụng có dấu hiệu nhưng không nhất quán).
 *
 * Sharpe tính trên chuỗi R NGÀY mark-to-market có trọng số heat, ×√365. Cửa sổ = sau warmup tới nến cuối.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-v4-ablation.ts [days=2300]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, POOL46, loadPool } from "./exp-breadth";
import { buildLiquidityUniverse } from "./exp-liquidity-universe";

const DAY = TF_MS["1d"];
const H = TF_MS["1h"];

/** Sao y exp-bar-phase.ts: gộp 1h thành 4h lệch `offsetH` giờ, chỉ giữ nhóm đủ 4 nến. */
function aggregatePhase(h1: Candle[], offsetH: number): Candle[] {
  const buckets = new Map<number, Candle[]>();
  for (const b of h1) {
    const k = Math.floor((b.openTime - offsetH * H) / TF_MS["4h"]);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(b);
  }
  const out: Candle[] = [];
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const g = buckets.get(k)!.sort((a, b) => a.openTime - b.openTime);
    if (g.length !== 4) continue;
    out.push({
      openTime: k * TF_MS["4h"] + offsetH * H,
      open: g[0].open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: g[3].close,
      volume: g.reduce((s, x) => s + x.volume, 0),
      quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
      takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
    });
  }
  return out;
}

function daily(res: PortfolioResult, from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(m.get(d) ?? 0);
  return out;
}
const sharpe = (x: number[]) => {
  if (x.length < 3) return 0;
  const m = x.reduce((a, v) => a + v, 0) / x.length;
  const sd = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};
function netDD(x: number[]): { net: number; dd: number; nd: number } {
  let e = 0, peak = 0, dd = 0;
  for (const v of x) { e += v; peak = Math.max(peak, e); dd = Math.max(dd, peak - e); }
  return { net: e, dd, nd: dd > 0 ? e / dd : 0 };
}

interface Variant { name: string; p: (base: ExtParams, gate: Gate) => ExtParams; admit: boolean }
const VARIANTS: Variant[] = [
  { name: "v4 ĐANG CHẠY", p: (b) => b, admit: true },
  { name: "− BTC gate (long)", p: (b) => ({ ...b, gate: undefined }), admit: true },
  { name: "− EMA50 lọc xu hướng", p: (b) => ({ ...b, trendLen: 2 }), admit: true },
  { name: "− heat-decay k=4", p: (b) => b, admit: false },
  { name: "− pyramid (1 unit)", p: (b) => ({ ...b, pyramidMaxUnits: 1 }), admit: true },
  { name: "− OB stop (3×ATR)", p: (b) => ({ ...b, initialStopObLookback: 0 }), admit: true },
  { name: "− mid-exit LONG (chandelier)", p: (b) => ({ ...b, longExitMode: "chandelier", longExitDays: 0 }), admit: true },
  { name: "− short 30d (= long 15d)", p: (b) => ({ ...b, shortEntryDays: 0 }), admit: true },
  { name: "− time-stop 60d", p: (b) => ({ ...b, maxHoldDays: 100000 }), admit: true },
  { name: "− toàn bộ SHORT", p: (b) => ({ ...b, allowShort: false }), admit: true },
  { name: "− toàn bộ LONG", p: (b, g) => ({ ...b, gate: (t: number, d: "long" | "short") => d === "short" && g(t, d) }), admit: true },
];

function run(data: Map<string, Candle[]>, v: Variant, universe?: (s: string, t: number) => boolean): PortfolioResult {
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const base: ExtParams = { ...liveSleeves(gate).turtle, admitBarSnapshot: true };
  const p = v.p(base, gate);
  const books: Book[] = [...data.entries()].map(([symbol, candles]) => ({
    key: symbol,
    symbol,
    candles,
    p: universe
      ? { ...p, gate: (t: number, d: "long" | "short") => (p.gate ? p.gate(t, d) : true) && universe(symbol, t) }
      : p,
  }));
  return runBooks(books, v.admit ? (decayH(T.heatDecayK) as AdmitFn) : undefined);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const h1 = new Map<string, Candle[]>();
  for (const s of CORE8) h1.set(s, await fetchFuturesKlinesPaged(s, "1h", days * 24 + 3000));
  const phases = [0, 1, 2, 3].map((ph) => {
    const m = new Map<string, Candle[]>();
    for (const [s, c] of h1) m.set(s, aggregatePhase(c, ph));
    return m;
  });
  const p0 = phases[0];
  let from = -Infinity, to = -Infinity;
  for (const c of p0.values()) {
    from = Math.max(from, c[Math.min(T.btcGateSlow + 130, c.length - 1)].openTime);
    to = Math.max(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({ from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)} (${((to - from) / DAY).toFixed(0)} ngày) · CORE8 · 4 pha nến`);
  console.log(`era: ${eras.map((e) => `${fmtD(e.from)}→${fmtD(e.to)}`).join(" | ")}\n`);

  // Rổ point-in-time: top-10 thanh khoản trên POOL46, tái cân bằng 30 ngày (pha 0).
  const pool = await loadPool(days, POOL46);
  if (pool.size < POOL46.length) console.log(`⚠️ pool chỉ ${pool.size}/${POOL46.length} symbol`);
  let pTo = 0;
  for (const c of pool.values()) pTo = Math.max(pTo, c[c.length - 1].openTime);
  const { inTop } = buildLiquidityUniverse(pool, 10, from, pTo);

  const baseDaily: number[][] = phases.map((d) => daily(run(d, VARIANTS[0]), from, to));
  const basePit = daily(run(pool, VARIANTS[0], inTop), from, to);
  const dayIdx = (t: number) => Math.floor(t / DAY) - Math.floor(from / DAY);
  const eraSharpe = (x: number[]) => eras.map((e) => sharpe(x.slice(Math.max(0, dayIdx(e.from)), dayIdx(e.to))));
  const last365 = (x: number[]) => x.slice(Math.max(0, x.length - 365));

  console.log(
    "biến thể".padEnd(30) + "Sharpe 4 pha (0h/1h/2h/3h)".padEnd(30) + "ΔS TB".padStart(7) + " ΔS>0".padStart(6)
    + " ΔN/DD>0".padStart(9) + "  NET R  maxDD  N/DD".padEnd(22) + "era A/B/C (TB pha)".padEnd(20)
    + "PIT S".padStart(7) + " ΔPIT".padStart(7) + "  365d S".padStart(9) + "  năm lớn nhất",
  );
  const verdicts: string[] = [];
  for (const v of VARIANTS) {
    const ds = phases.map((d) => daily(run(d, v), from, to));
    const S = ds.map(sharpe);
    const S0 = baseDaily.map(sharpe);
    const dS = S.map((s, i) => s - S0[i]);
    const nd = ds.map((x) => netDD(x).nd);
    const nd0 = baseDaily.map((x) => netDD(x).nd);
    const dND = nd.map((x, i) => x - nd0[i]);
    const avgDaily = ds[0].map((_, k) => ds.reduce((a, x) => a + x[k], 0) / 4);
    const avgBase = baseDaily[0].map((_, k) => baseDaily.reduce((a, x) => a + x[k], 0) / 4);
    const eraV = eraSharpe(avgDaily);
    const eraB = eraSharpe(avgBase);
    const pit = daily(run(pool, v, inTop), from, to);
    const dPit = sharpe(pit) - sharpe(basePit);
    const { net, dd } = netDD(ds[0]);
    // tập trung theo năm của phần chênh (TB 4 pha)
    const byYear = new Map<number, number>();
    avgDaily.forEach((x, k) => {
      const y = new Date((Math.floor(from / DAY) + k) * DAY).getUTCFullYear();
      byYear.set(y, (byYear.get(y) ?? 0) + (x - avgBase[k]));
    });
    const posSum = [...byYear.values()].filter((x) => x > 0).reduce((a, x) => a + x, 0);
    const topYear = [...byYear.entries()].sort((a, b) => b[1] - a[1])[0];
    const topShare = posSum > 0 ? topYear[1] / posSum : 0;
    const mean = dS.reduce((a, x) => a + x, 0) / 4;
    const up = dS.filter((x) => x > 0).length;
    const ndUp = dND.filter((x) => x > 0).length;
    let verdict = "—";
    if (v !== VARIANTS[0]) {
      if (dS.filter((x) => x < 0).length >= 3 && dPit < 0) verdict = "CẦN THIẾT";
      else if (up === 4 && ndUp === 4 && eraV.filter((x, i) => x > eraB[i]).length >= 2 && dPit > 0 && topShare <= 0.5) verdict = "HẠI (ứng viên bỏ)";
      else if (Math.abs(mean) < 0.1 && dPit >= -0.1) verdict = "KHÔNG CẦN THIẾT";
      else verdict = "KHÔNG RÕ";
      verdicts.push(`${v.name}: ${verdict}`);
    }
    console.log(
      v.name.padEnd(30)
      + S.map((s) => s.toFixed(2)).join("/").padEnd(30)
      + (v === VARIANTS[0] ? "".padStart(7) : `${mean >= 0 ? "+" : ""}${mean.toFixed(3)}`.padStart(7))
      + (v === VARIANTS[0] ? "".padStart(6) : `${up}/4`.padStart(6))
      + (v === VARIANTS[0] ? "".padStart(9) : `${ndUp}/4`.padStart(9))
      + `  ${net.toFixed(0).padStart(5)} ${dd.toFixed(0).padStart(6)} ${(net / dd).toFixed(1).padStart(5)}  `
      + eraV.map((x) => x.toFixed(2)).join("/").padEnd(20)
      + sharpe(pit).toFixed(2).padStart(7)
      + (v === VARIANTS[0] ? "".padStart(7) : `${dPit >= 0 ? "+" : ""}${dPit.toFixed(2)}`.padStart(7))
      + sharpe(last365(avgDaily)).toFixed(2).padStart(9)
      + (v === VARIANTS[0] ? "" : `  ${topYear[0]} ${(100 * topShare).toFixed(0)}%`)
      + (v === VARIANTS[0] ? "" : `  ⇒ ${verdict}`),
    );
  }
  console.log(`\nNET R / maxDD / N/DD là của pha 0h (production). "năm lớn nhất" = năm mang phần lớn nhất của`
    + ` phần CHÊNH (bỏ − v4) dương, TB 4 pha.`);
}

if (require.main === module && /exp-v4-ablation\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
