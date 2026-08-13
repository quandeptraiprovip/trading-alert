/**
 * exp-volume-sizing.ts — thu nhỏ unit vào lệnh khi KHÔNG có volume nở gần đây.
 *
 * XUẤT XỨ: trong `exp-key-sizing.ts`, ĐỐI CHỨNG chỉ-volume (chỉ hỏi "6 nến gần đây có nến volume đột
 * biến không", BỎ QUA khoảng cách tới key) đánh bại hẳn bản dùng khoảng cách key ở sleeve Fast
 * (+38% vs −30%). Nghĩa là phần "key" của FX Dream — vị trí GIÁ của vùng volume — không đóng góp gì;
 * thứ mang tin chỉ là volume có nở hay không. Nên tách ra kiểm định riêng, đúng như nó là.
 *
 * QUAN HỆ VỚI CÁI ĐÃ LOẠI: `T.confirmVolMult` từng được thử như BỘ LỌC ("volume nến breakout ≥ k ×
 * SMA20") và bị bỏ vì "cải thiện nhỏ". Ở đây là dạng SIZING (giữ mọi lệnh, chỉ đổi tỉ trọng) và cửa
 * sổ nhìn lại rộng hơn một nến. Đó là biến thể chưa đo.
 *
 * CỬA DUYỆT: cao nguyên trên (cửa sổ × ngưỡng) · phải thắng ở CẢ HAI sleeve · và 4/4 pha nến.
 * Thắng một sleeve mà không thắng sleeve kia = không có cơ chế, vì cả hai cùng đọc một chuỗi giá.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-volume-sizing.ts [grid|phase] [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";
import { fetchFuturesKlinesPaged } from "../kline-fetch";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;

/** quoteVolume của nến; rơi về volume nếu thiếu. */
const qv = (c: Candle) => (Number.isFinite(c.quoteVolume) && c.quoteVolume > 0 ? c.quoteVolume : c.volume);

/**
 * Cờ "có volume nở trong `win` nến gần đây" theo (symbol, openTime).
 * Nến đột biến = qv ≥ mult × TRUNG VỊ của 96 nến TRƯỚC nó. Cửa sổ chỉ gồm nến ĐÃ ĐÓNG trước nến
 * đang xét (k < i) ⇒ không lookahead.
 */
function buildVolFlags(data: Map<string, Candle[]>, mult: number, win: number): Map<string, Map<number, boolean>> {
  const LOOK = 96;
  const out = new Map<string, Map<number, boolean>>();
  for (const [sym, c] of data) {
    const v = c.map(qv);
    const spike = new Array<boolean>(c.length).fill(false);
    for (let i = LOOK; i < c.length; i++) {
      const prior = v.slice(i - LOOK, i).sort((a, b) => a - b);
      const med = prior[Math.floor(LOOK / 2)];
      spike[i] = med > 0 && v[i] >= mult * med;
    }
    const m = new Map<number, boolean>();
    for (let i = 0; i < c.length; i++) {
      let any = false;
      for (let k = Math.max(0, i - win); k < i; k++) if (spike[k]) { any = true; break; }
      m.set(c[i].openTime, any);
    }
    out.set(sym, m);
  }
  return out;
}

function dailySeries(res: PortfolioResult, from: number, to: number): number[] {
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
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}

const sharpeOf = (s: number[]) => {
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

function evalSeries(s: number[], eras: { from: number; to: number }[], from: number) {
  const rho = riskForDD(s, TARGET_DD);
  let e = 1;
  for (const x of s) e *= 1 + rho * x;
  const eraCells = eras.map((era) => {
    const a = Math.floor(era.from / DAY) - Math.floor(from / DAY);
    const b = Math.floor(era.to / DAY) - Math.floor(from / DAY);
    let v = 1;
    for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) v *= 1 + rho * s[i];
    return v;
  });
  const wf: number[] = [];
  for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
  return { mult: e, sharpe: sharpeOf(s), eras: eraCells, wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length };
}

async function main() {
  const mode = (process.argv[2] ?? "grid").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const LAMBDA = 0.35;

  if (mode === "grid") {
    const data = await loadPool(days, CORE8);
    const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
    const { turtle, fast } = liveSleeves(gate);
    const w = coreWindow(data, T.btcGateSlow + 130);
    const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
    const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}% · λ = ${LAMBDA} cho unit KHÔNG có volume nở\n`);

    for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
      const base = evalSeries(dailySeries(runBooks(bk(p), heat), w.from, w.to), w.eras, w.from);
      console.log("=".repeat(104));
      console.log(`  ${name} — VỐN(×) theo (ngưỡng spike × cửa sổ nhìn lại). Mốc λ=1: ${base.mult.toFixed(2)}× (Sharpe ${base.sharpe.toFixed(2)})`);
      console.log("=".repeat(104));
      console.log("mult \\ cửa sổ      3 nến          6 nến         12 nến         18 nến");
      for (const mult of [1.5, 2, 2.5, 3]) {
        const cells: string[] = [];
        for (const win of [3, 6, 12, 18]) {
          const flags = buildVolFlags(data, mult, win);
          const admit: AdmitFn = (c) => heat(c) * (flags.get(c.symbol)?.get(c.time) ? 1 : LAMBDA);
          const r = evalSeries(dailySeries(runBooks(bk(p), admit), w.from, w.to), w.eras, w.from);
          const d = ((r.mult - base.mult) / base.mult) * 100;
          cells.push(`${r.mult.toFixed(1)}× ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`.padStart(14));
        }
        console.log(`${mult.toFixed(1).padStart(4)}       ${cells.join(" ")}`);
      }
      console.log();
    }
    return;
  }

  // ── PHASE: chạy lại trên 4 lưới nến lệch pha (cửa giả-OOS) ──
  const bars1h = days * 24 + 3000;
  const h1 = new Map<string, Candle[]>();
  for (const s of CORE8) {
    const c = await fetchFuturesKlinesPaged(s, "1h", bars1h);
    if (c.length > 5000) h1.set(s, c);
  }
  const agg = (c: Candle[], offH: number): Candle[] => {
    const b = new Map<number, Candle[]>();
    for (const x of c) {
      const k = Math.floor((x.openTime - offH * TF_MS["1h"]) / TF_MS["4h"]);
      if (!b.has(k)) b.set(k, []);
      b.get(k)!.push(x);
    }
    const out: Candle[] = [];
    for (const k of [...b.keys()].sort((p, q) => p - q)) {
      const g = b.get(k)!.sort((p, q) => p.openTime - q.openTime);
      if (g.length !== 4) continue;
      out.push({
        openTime: k * TF_MS["4h"] + offH * TF_MS["1h"],
        open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[3].close,
        volume: g.reduce((s, x) => s + x.volume, 0), quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
        takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
      });
    }
    return out;
  };

  console.log(`Cửa giả-OOS: cùng luật trên 4 lưới nến 4h lệch pha · λ=${LAMBDA}, spike ≥2×, cửa sổ 6 nến\n`);
  console.log("sleeve   pha    λ=1 (đang chạy)      + volume-sizing        thay đổi");
  console.log("-".repeat(80));
  for (const sleeve of ["TURTLE", "FAST"] as const) {
    let wins = 0;
    for (const ph of [0, 1, 2, 3]) {
      const data = new Map<string, Candle[]>();
      for (const [s, c] of h1) data.set(s, agg(c, ph));
      const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const params = liveSleeves(gate);
      const p: ExtParams = sleeve === "TURTLE" ? params.turtle : params.fast;
      const w = coreWindow(data, T.btcGateSlow + 130);
      const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
      const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
      const flags = buildVolFlags(data, 2, 6);
      const admit: AdmitFn = (c) => heat(c) * (flags.get(c.symbol)?.get(c.time) ? 1 : LAMBDA);
      const b = evalSeries(dailySeries(runBooks(bk, heat), w.from, w.to), w.eras, w.from);
      const v = evalSeries(dailySeries(runBooks(bk, admit), w.from, w.to), w.eras, w.from);
      const d = ((v.mult - b.mult) / b.mult) * 100;
      if (d > 0) wins++;
      console.log(
        `${sleeve.padEnd(8)} ${(ph === 0 ? "0h*" : `${ph}h`).padEnd(6)} ${b.sharpe.toFixed(2)} / ${b.mult.toFixed(2).padStart(6)}×` +
          `        ${v.sharpe.toFixed(2)} / ${v.mult.toFixed(2).padStart(6)}×        ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`,
      );
    }
    console.log(`  → ${sleeve}: thắng ${wins}/4 pha\n`);
  }
}

if (require.main === module && /exp-volume-sizing\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
