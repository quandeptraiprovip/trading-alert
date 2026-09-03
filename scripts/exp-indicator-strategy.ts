/**
 * exp-indicator-strategy.ts — XÂY CHIẾN LƯỢC MỚI TRONG ĐÓ CHỈ BÁO LÀ TÍN HIỆU VÀO LỆNH.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KHÁC GÌ BA VÒNG TRƯỚC
 *
 * Vòng 1-3 dùng chỉ báo làm BỘ LỌC chồng lên Donchian, và kết luận null có một phản biện rất mạnh:
 * tại nến breakout thì 86,7% chỉ báo đã đồng ý sẵn, nên chúng không còn gì để nói. Phản biện đó
 * **KHÔNG áp dụng** khi chỉ báo tự nó là cái cò vào lệnh — lúc đó nó quyết định vào lệnh Ở CHỖ KHÁC,
 * vào thời điểm khác. Đây cũng đúng cách Brock-Lakonishok-LeBaron (1992) và phần lớn tài liệu dùng chúng.
 *
 * Cách so sánh công bằng: thay ĐÚNG MỘT thứ — cái cò vào lệnh — và giữ nguyên toàn bộ bộ máy rủi ro
 * đã audit (stop 3×ATR/cấu trúc, kênh thoát mid-close 20d, pyramiding 0,5×ATR ≤3 unit, heat k=4,
 * phí Binance + funding, BTC gate). Dùng hook `entrySignal` của `portfolio-engine.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ĐỐI CHỨNG QUAN TRỌNG NHẤT: VÀO LỆNH NGẪU NHIÊN
 *
 * Bộ máy thoát của hệ này TỰ NÓ đã là một edge: trail theo midpoint kênh close 20 ngày cắt lỗ nhanh
 * và để winner chạy, pyramiding cộng thêm vào vị thế đang thắng, BTC gate chặn long trong bear.
 * Một chiến lược vào lệnh HOÀN TOÀN NGẪU NHIÊN gắn vào bộ máy đó vẫn sẽ có Sharpe dương.
 *
 * ⇒ Con số cần vượt KHÔNG phải 0, mà là **Sharpe của bản vào lệnh ngẫu nhiên cùng tần suất**. Không
 * có cột này thì mọi "chiến lược chỉ báo Sharpe 1,2" đều vô nghĩa, vì ta không biết bao nhiêu phần
 * đến từ chỉ báo và bao nhiêu đến từ luật thoát.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÀ MỘT CỘT QUAN TRỌNG NGANG: TƯƠNG QUAN VỚI SỔ ĐANG CHẠY
 *
 * Turtle và Fast có tương quan P&L ~0,96 — theo ghi chép của repo thì đó là "đòn bẩy, không phải đa
 * dạng hoá". Vì thế một chiến lược YẾU HƠN nhưng ÍT TƯƠNG QUAN có thể đáng giá hơn một chiến lược
 * mạnh hơn mà trùng lặp. Bảng in cả `corr` và **Sharpe của danh mục GỘP (Turtle+Fast+cái mới)** —
 * cột gộp mới là con số ra quyết định.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-indicator-strategy.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs, ema } from "../turtle";
import { AdmitFn, Book, EquityPoint, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { DEFS, buildComboPre, vote } from "./exp-indicator-combos";

const DAY = TF_MS["1d"];
type Dir = "long" | "short";
type Signal = (symbol: string, i: number, c: Candle[]) => Dir | null;

// ─────────────────────────────────────────────────────────────────────────────
// CHỈ BÁO (bản tối giản, tính một lần rồi cache theo symbol)
// ─────────────────────────────────────────────────────────────────────────────
const smaArr = (x: number[], n: number): number[] => {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
};

interface Ind {
  macdHist: number[]; macdLine: number[]; macdSig: number[];
  ppoHist: number[];
  ema20: number[]; ema50: number[]; ema12: number[]; ema26: number[];
  sma10: number[]; sma40: number[];
  rsi: number[]; stochK: number[]; bollLo: number[]; bollUp: number[]; cci: number[]; wr: number[];
  st: number[]; tsi: number[]; trix: number[]; aroon: number[]; vortex: number[];
  fisher: number[]; ao: number[]; cmo: number[]; ichi: number[]; kamaSl: number[];
}

function buildInd(c: Candle[]): Ind {
  const cl = c.map((x) => x.close);
  const e = (n: number) => ema(cl, n);
  const e12 = e(12), e26 = e(26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const macdSig = ema(macdLine, 9);
  const ppoLine = e12.map((v, i) => (e26[i] > 0 ? ((v - e26[i]) / e26[i]) * 100 : 0));
  const ppoSig = ema(ppoLine, 9);

  // RSI
  const rsi = new Array(c.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = cl[i] - cl[i - 1], g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  // Stochastic %K, Williams %R
  const stochK = new Array(c.length).fill(50), wr = new Array(c.length).fill(-50);
  for (let i = 13; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 13; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    stochK[i] = hh > ll ? ((cl[i] - ll) / (hh - ll)) * 100 : 50;
    wr[i] = hh > ll ? (-100 * (hh - cl[i])) / (hh - ll) : -50;
  }
  // Bollinger
  const m20 = smaArr(cl, 20);
  const bollLo = new Array(c.length).fill(NaN), bollUp = new Array(c.length).fill(NaN);
  for (let i = 19; i < c.length; i++) {
    let v = 0;
    for (let j = i - 19; j <= i; j++) v += (cl[j] - m20[i]) ** 2;
    const sd = Math.sqrt(v / 20);
    bollLo[i] = m20[i] - 2 * sd; bollUp[i] = m20[i] + 2 * sd;
  }
  // CCI
  const tp = c.map((b) => (b.high + b.low + b.close) / 3);
  const mtp = smaArr(tp, 20);
  const cci = new Array(c.length).fill(0);
  for (let i = 19; i < c.length; i++) {
    let mad = 0;
    for (let j = i - 19; j <= i; j++) mad += Math.abs(tp[j] - mtp[i]);
    mad /= 20;
    cci[i] = mad > 0 ? (tp[i] - mtp[i]) / (0.015 * mad) : 0;
  }
  // SuperTrend(10,3)
  const atr10 = atrSeries(c, 10);
  const st = new Array(c.length).fill(1);
  let upper = 0, lower = 0;
  for (let i = 1; i < c.length; i++) {
    const mid = (c[i].high + c[i].low) / 2;
    const bu = mid + 3 * atr10[i], bl = mid - 3 * atr10[i];
    if (i === 1) { upper = bu; lower = bl; }
    else {
      upper = bu < upper || cl[i - 1] > upper ? bu : upper;
      lower = bl > lower || cl[i - 1] < lower ? bl : lower;
    }
    st[i] = cl[i] > upper ? 1 : cl[i] < lower ? -1 : st[i - 1];
  }
  // TSI, TRIX
  const mom = cl.map((v, i) => (i > 0 ? v - cl[i - 1] : 0));
  const a = ema(ema(mom, 25), 13), b = ema(ema(mom.map(Math.abs), 25), 13);
  const tsi = a.map((v, i) => (b[i] > 0 ? (100 * v) / b[i] : 0));
  const lg = cl.map(Math.log);
  const e3 = ema(ema(ema(lg, 15), 15), 15);
  const trix = e3.map((v, i) => (i > 0 ? v - e3[i - 1] : 0));
  // Aroon, Vortex
  const aroon = new Array(c.length).fill(0);
  for (let i = 25; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity, hI = i, lI = i;
    for (let j = i - 24; j <= i; j++) {
      if (c[j].high >= hi) { hi = c[j].high; hI = j; }
      if (c[j].low <= lo) { lo = c[j].low; lI = j; }
    }
    aroon[i] = ((25 - (i - hI)) / 25) * 100 - ((25 - (i - lI)) / 25) * 100;
  }
  const vp = new Array(c.length).fill(0), vm = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    vp[i] = Math.abs(c[i].high - c[i - 1].low);
    vm[i] = Math.abs(c[i].low - c[i - 1].high);
    const pc = cl[i - 1];
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
  }
  const sp = smaArr(vp, 14), sm2 = smaArr(vm, 14), stt = smaArr(tr, 14);
  const vortex = stt.map((t, i) => (t > 0 ? (sp[i] - sm2[i]) / t : 0));
  // Fisher
  const fisher = new Array(c.length).fill(0);
  let fv = 0, ff = 0;
  for (let i = 10; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 9; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    const mp = (c[i].high + c[i].low) / 2;
    const x = hh > ll ? (2 * (mp - ll)) / (hh - ll) - 1 : 0;
    fv = Math.max(-0.999, Math.min(0.999, 0.66 * x + 0.67 * fv));
    ff = 0.5 * Math.log((1 + fv) / (1 - fv)) + 0.5 * ff;
    fisher[i] = ff;
  }
  // Awesome, CMO
  const mp = c.map((x) => (x.high + x.low) / 2);
  const a5 = smaArr(mp, 5), a34 = smaArr(mp, 34);
  const ao = a5.map((v, i) => v - a34[i]);
  const up = new Array(c.length).fill(0), dn = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) { const d = cl[i] - cl[i - 1]; up[i] = Math.max(0, d); dn[i] = Math.max(0, -d); }
  const su = smaArr(up, 14), sd2 = smaArr(dn, 14);
  const cmo = su.map((v, i) => (v + sd2[i] > 0 ? (100 * (v - sd2[i])) / (v + sd2[i]) : 0));
  // Ichimoku cloud (mây vẽ từ dữ liệu 26 nến trước ⇒ không lookahead)
  const hl = (n: number, i: number) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    return (hh + ll) / 2;
  };
  const ichi = new Array(c.length).fill(0);
  for (let i = 78; i < c.length; i++) {
    const src = i - 26;
    const sa = (hl(9, src) + hl(26, src)) / 2, sb = hl(52, src);
    ichi[i] = cl[i] > Math.max(sa, sb) ? 1 : cl[i] < Math.min(sa, sb) ? -1 : 0;
  }
  // KAMA slope
  const k = new Array(c.length).fill(cl[0]);
  const fsc = 2 / 3, ssc = 2 / 31;
  for (let i = 1; i < c.length; i++) {
    if (i < 10) { k[i] = cl[i]; continue; }
    let vol = 0;
    for (let j = i - 9; j <= i; j++) vol += Math.abs(cl[j] - cl[j - 1]);
    const er = vol > 0 ? Math.abs(cl[i] - cl[i - 10]) / vol : 0;
    const sc = (er * (fsc - ssc) + ssc) ** 2;
    k[i] = k[i - 1] + sc * (cl[i] - k[i - 1]);
  }
  const kamaSl = k.map((v, i) => (i > 0 ? v - k[i - 1] : 0));

  return {
    macdHist: macdLine.map((v, i) => v - macdSig[i]), macdLine, macdSig,
    ppoHist: ppoLine.map((v, i) => v - ppoSig[i]),
    ema20: e(20), ema50: e(50), ema12: e12, ema26: e26,
    sma10: smaArr(cl, 10), sma40: smaArr(cl, 40),
    rsi, stochK, bollLo, bollUp, cci, wr, st, tsi, trix, aroon, vortex, fisher, ao, cmo, ichi, kamaSl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TÍN HIỆU VÀO LỆNH
// ─────────────────────────────────────────────────────────────────────────────
/** Giao cắt: x[i] đổi dấu so với x[i−1] ⇒ long khi cắt LÊN, short khi cắt XUỐNG. */
const crossOf = (get: (d: Ind, i: number) => number) =>
  (ind: Map<string, Ind>): Signal => (sym, i) => {
    const d = ind.get(sym);
    if (!d || i < 1) return null;
    const now = get(d, i), prev = get(d, i - 1);
    if (prev <= 0 && now > 0) return "long";
    if (prev >= 0 && now < 0) return "short";
    return null;
  };

interface Cand { group: string; label: string; make: (ind: Map<string, Ind>, pre: Map<string, any>) => Signal }

const CANDS: Cand[] = [
  // ── GIAO CẮT (cấu trúc theo xu hướng) ──
  { group: "cắt", label: "MACD line × signal", make: crossOf((d, i) => d.macdHist[i]) },
  { group: "cắt", label: "MACD line × 0", make: crossOf((d, i) => d.macdLine[i]) },
  { group: "cắt", label: "PPO × signal", make: crossOf((d, i) => d.ppoHist[i]) },
  { group: "cắt", label: "EMA20 × EMA50", make: crossOf((d, i) => d.ema20[i] - d.ema50[i]) },
  { group: "cắt", label: "EMA12 × EMA26", make: crossOf((d, i) => d.ema12[i] - d.ema26[i]) },
  { group: "cắt", label: "SMA10 × SMA40", make: crossOf((d, i) => d.sma10[i] - d.sma40[i]) },
  { group: "cắt", label: "SuperTrend đảo", make: crossOf((d, i) => d.st[i]) },
  { group: "cắt", label: "TSI × 0", make: crossOf((d, i) => d.tsi[i]) },
  { group: "cắt", label: "TRIX × 0", make: crossOf((d, i) => d.trix[i]) },
  { group: "cắt", label: "Aroon × 0", make: crossOf((d, i) => d.aroon[i]) },
  { group: "cắt", label: "Vortex × 0", make: crossOf((d, i) => d.vortex[i]) },
  { group: "cắt", label: "Fisher × 0", make: crossOf((d, i) => d.fisher[i]) },
  { group: "cắt", label: "Awesome Osc × 0", make: crossOf((d, i) => d.ao[i]) },
  { group: "cắt", label: "CMO × 0", make: crossOf((d, i) => d.cmo[i]) },
  { group: "cắt", label: "mây Ichimoku", make: crossOf((d, i) => d.ichi[i]) },
  { group: "cắt", label: "KAMA đổi dốc", make: crossOf((d, i) => d.kamaSl[i]) },

  // ── HỒI VỀ TRUNG BÌNH (cấu trúc NGƯỢC — kỳ vọng ít tương quan với Turtle) ──
  {
    group: "hồi", label: "RSI thoát 30/70", make: (ind) => (sym, i) => {
      const d = ind.get(sym);
      if (!d || i < 1) return null;
      if (d.rsi[i - 1] < 30 && d.rsi[i] >= 30) return "long";
      if (d.rsi[i - 1] > 70 && d.rsi[i] <= 70) return "short";
      return null;
    },
  },
  {
    group: "hồi", label: "Stoch thoát 20/80", make: (ind) => (sym, i) => {
      const d = ind.get(sym);
      if (!d || i < 1) return null;
      if (d.stochK[i - 1] < 20 && d.stochK[i] >= 20) return "long";
      if (d.stochK[i - 1] > 80 && d.stochK[i] <= 80) return "short";
      return null;
    },
  },
  {
    group: "hồi", label: "Bollinger chạm biên → đảo", make: (ind) => (sym, i, c) => {
      const d = ind.get(sym);
      if (!d || !(d.bollLo[i] > 0)) return null;
      if (c[i].close < d.bollLo[i]) return "long";
      if (c[i].close > d.bollUp[i]) return "short";
      return null;
    },
  },
  {
    group: "hồi", label: "Williams %R thoát −80/−20", make: (ind) => (sym, i) => {
      const d = ind.get(sym);
      if (!d || i < 1) return null;
      if (d.wr[i - 1] < -80 && d.wr[i] >= -80) return "long";
      if (d.wr[i - 1] > -20 && d.wr[i] <= -20) return "short";
      return null;
    },
  },
  {
    group: "hồi", label: "CCI thoát ±100", make: (ind) => (sym, i) => {
      const d = ind.get(sym);
      if (!d || i < 1) return null;
      if (d.cci[i - 1] < -100 && d.cci[i] >= -100) return "long";
      if (d.cci[i - 1] > 100 && d.cci[i] <= 100) return "short";
      return null;
    },
  },

  // ── PHÁ BIÊN Bollinger (cùng chiều — đối chứng cấu trúc với bản hồi về) ──
  {
    group: "phá", label: "Bollinger phá biên 2σ", make: (ind) => (sym, i, c) => {
      const d = ind.get(sym);
      if (!d || !(d.bollUp[i] > 0)) return null;
      if (c[i].close > d.bollUp[i]) return "long";
      if (c[i].close < d.bollLo[i]) return "short";
      return null;
    },
  },
];

/** GỘP LÀM TÍN HIỆU CHÍNH (kiểu Neely et al.): vào khi điểm gộp 27 chỉ báo vượt ngưỡng. */
function voteSignal(pre: Map<string, any>, thr: number, idxs: number[]): Signal {
  return (sym, i, c) => {
    const t = c[i].openTime;
    let accL = 0;
    for (const k of idxs) accL += vote(pre, k, sym, t, "long");
    const s = accL / idxs.length;
    if (s >= thr) return "long";
    if (s <= -thr) return "short";
    return null;
  };
}

/** ĐỐI CHỨNG: vào lệnh NGẪU NHIÊN với xác suất p mỗi nến khi đang flat. */
function randomSignal(p: number, seed: number): Signal {
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cache = new Map<string, Dir | null>();
  return (sym, i, c) => {
    const key = `${sym}|${c[i].openTime}`;
    let v = cache.get(key);
    if (v === undefined) { v = rand() < p ? (rand() < 0.5 ? "long" : "short") : null; cache.set(key, v); }
    return v;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);
type Win = ReturnType<typeof coreWindow>;

function dailyOf(eq: EquityPoint[], from: number, to: number, grid: number[]): number[] {
  const per = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    per.set(Math.floor(eq[i].time / DAY), (per.get(Math.floor(eq[i].time / DAY)) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return grid.map((d) => per.get(d) ?? 0);
}
const sharpeOf = (r: number[]): number => {
  const n = r.length;
  const m = r.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};
const corrOf = (a: number[], b: number[]): number => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
};

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const heat = decayH(T.heatDecayK);

  const ind = new Map<string, Ind>();
  for (const [s, c] of data) ind.set(s, buildInd(c));
  const pre = buildComboPre(data);

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const liveBooks = [...bk(turtle, "t"), ...bk(fast, "f")];

  const liveRes = runBooks(liveBooks, heat);
  const gridSet = new Set<number>();
  for (const e of liveRes.equity) if (e.time >= w.from && e.time <= w.to) gridSet.add(Math.floor(e.time / DAY));
  const grid = [...gridSet].sort((a, b) => a - b);
  const liveDaily = dailyOf(liveRes.equity, w.from, w.to, grid);
  const liveSharpe = sharpeOf(liveDaily);
  const liveM = riskMetrics(liveRes.equity.filter((e) => e.time >= w.from && e.time <= w.to));

  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}`);
  console.log(`SỔ ĐANG CHẠY (Turtle+Fast): Sharpe ${liveSharpe.toFixed(3)} · NET ${liveM.netR.toFixed(0)}R · NET/DD ${liveM.netOverMaxDD.toFixed(2)}\n`);

  // Chiến lược mới dùng CÙNG bộ máy rủi ro của Turtle, chỉ đổi cái cò vào lệnh.
  const strat = (sig: Signal): ExtParams => ({ ...turtle, entrySignal: sig });

  const HDR = "  " + "chiến lược".padEnd(30) + "vịthế".padStart(6) + "Sharpe".padStart(8) + "NET R".padStart(8) +
    "NET/DD".padStart(7) + "  era A/B/C".padEnd(19) + "corr".padStart(6) + "  GỘP 3 sleeve".padStart(14) + "  Δgộp";

  const rows: { label: string; sharpe: number; corr: number; joint: number; pos: number }[] = [];
  const evalOne = (label: string, sig: Signal, print = true) => {
    const books = bk(strat(sig), "x");
    const res = runBooks(books, heat);
    const eqWin = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
    const m = riskMetrics(eqWin);
    const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
    const dly = dailyOf(res.equity, w.from, w.to, grid);
    const sh = sharpeOf(dly);
    const cr = corrOf(dly, liveDaily);
    const pos = new Set(res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to).map((t) => `${t.book}#${t.positionId}`)).size;
    // GỘP: chạy cả ba sleeve trong CÙNG một runBooks để heat được chia sẻ đúng cách
    const jointRes = runBooks([...liveBooks, ...books], heat);
    const jointSh = sharpeOf(dailyOf(jointRes.equity, w.from, w.to, grid));
    if (print) {
      console.log("  " + label.padEnd(30) + String(pos).padStart(6) + sh.toFixed(3).padStart(8) +
        m.netR.toFixed(0).padStart(8) + m.netOverMaxDD.toFixed(2).padStart(7) + "  " +
        eras.map((x) => x.sharpe.toFixed(2)).join("/").padEnd(19) + cr.toFixed(2).padStart(6) +
        jointSh.toFixed(3).padStart(14) + ((jointSh - liveSharpe >= 0 ? "  +" : "  ") + (jointSh - liveSharpe).toFixed(3)));
    }
    rows.push({ label, sharpe: sh, corr: cr, joint: jointSh, pos });
    return { sh, cr, jointSh, pos };
  };

  // ── ĐỐI CHỨNG NGẪU NHIÊN trước tiên, ở nhiều tần suất ──
  console.log("═".repeat(122));
  console.log("  0) ĐỐI CHỨNG — VÀO LỆNH NGẪU NHIÊN, cùng bộ máy thoát/stop/pyramid/gate");
  console.log("     Đây là mức sàn phải vượt. Sharpe dương ở đây HOÀN TOÀN do luật THOÁT, không do tín hiệu vào.");
  console.log("═".repeat(122));
  console.log(HDR);
  console.log("-".repeat(122));
  const randRef: { pos: number; sh: number }[] = [];
  for (const p of [0.004, 0.01, 0.02, 0.05]) {
    const best: number[] = [];
    let pos0 = 0;
    for (let s = 0; s < 3; s++) {
      const r = evalOne(`ngẫu nhiên p=${p} (seed ${s})`, randomSignal(p, 900 + s * 77), s === 0);
      best.push(r.sh);
      if (s === 0) pos0 = r.pos;
    }
    best.sort((a, b) => a - b);
    randRef.push({ pos: pos0, sh: best[2] });
    console.log(`     └ 3 seed: Sharpe ${best.map((x) => x.toFixed(3)).join(" / ")}  → TỐT NHẤT ${best[2].toFixed(3)}`);
  }
  /** Sharpe TỐT NHẤT của đối chứng ngẫu nhiên ở tần suất gần nhất với `pos`. */
  const randFloor = (pos: number): number => {
    let bi = 0;
    for (let i = 1; i < randRef.length; i++) if (Math.abs(randRef[i].pos - pos) < Math.abs(randRef[bi].pos - pos)) bi = i;
    return randRef[bi].sh;
  };

  // ── Các chiến lược chỉ báo ──
  for (const grp of ["cắt", "hồi", "phá"]) {
    const list = CANDS.filter((x) => x.group === grp);
    const title = grp === "cắt" ? "1) GIAO CẮT CHỈ BÁO làm tín hiệu vào lệnh (cấu trúc theo xu hướng)"
      : grp === "hồi" ? "2) HỒI VỀ TRUNG BÌNH — cấu trúc NGƯỢC với Turtle, kỳ vọng ít tương quan"
      : "3) PHÁ BIÊN BOLLINGER — đối chứng cấu trúc cho nhóm 2";
    console.log("\n" + "═".repeat(122));
    console.log(`  ${title}`);
    console.log("═".repeat(122));
    console.log(HDR);
    console.log("-".repeat(122));
    for (const cd of list) evalOne(cd.label, cd.make(ind, pre));
  }

  // ── GỘP CHỈ BÁO LÀM TÍN HIỆU CHÍNH ──
  console.log("\n" + "═".repeat(122));
  console.log("  4) GỘP 27 CHỈ BÁO LÀM TÍN HIỆU CHÍNH (kiểu Neely-Rapach-Tu-Zhou) — vào khi |điểm gộp| ≥ ngưỡng");
  console.log("═".repeat(122));
  console.log(HDR);
  console.log("-".repeat(122));
  const allIdx = DEFS.map((_, k) => k);
  const momIdx = DEFS.map((d, k) => (d.family === "momentum" ? k : -1)).filter((k) => k >= 0);
  for (const thr of [0.3, 0.5, 0.7, 0.85]) evalOne(`vote 27 chỉ báo ≥ ${thr}`, voteSignal(pre, thr, allIdx));
  for (const thr of [0.5, 0.7]) evalOne(`vote momentum(18) ≥ ${thr}`, voteSignal(pre, thr, momIdx));

  // ── TỔNG KẾT ──
  console.log("\n" + "═".repeat(122));
  console.log("  TỔNG KẾT");
  console.log("═".repeat(122));
  const real = rows.filter((r) => !r.label.startsWith("ngẫu nhiên"));
  const beatFloor = real.filter((r) => r.sharpe > randFloor(r.pos));
  const helpJoint = real.filter((r) => r.joint > liveSharpe);
  const lowCorr = real.filter((r) => r.corr < 0.5);
  console.log(`  Vượt SÀN NGẪU NHIÊN cùng tần suất : ${beatFloor.length}/${real.length}` +
    (beatFloor.length ? ` → ${beatFloor.slice(0, 6).map((r) => `${r.label} (${r.sharpe.toFixed(2)} vs sàn ${randFloor(r.pos).toFixed(2)})`).join(", ")}` : ""));
  console.log(`  Có tương quan < 0,50 với sổ hiện tại: ${lowCorr.length}/${real.length}` +
    (lowCorr.length ? ` → ${lowCorr.slice(0, 6).map((r) => `${r.label} (${r.corr.toFixed(2)})`).join(", ")}` : ""));
  console.log(`  LÀM TĂNG Sharpe danh mục GỘP       : ${helpJoint.length}/${real.length}` +
    (helpJoint.length ? ` → ${helpJoint.slice(0, 6).map((r) => `${r.label} (+${(r.joint - liveSharpe).toFixed(3)})`).join(", ")}` : ""));
  console.log(
    `\n  Cột GỘP là con số ra quyết định: một sleeve yếu nhưng ít tương quan vẫn có thể làm tăng Sharpe\n` +
    `  danh mục, còn một sleeve mạnh mà trùng lặp thì chỉ là đòn bẩy. Đã thử ${real.length} chiến lược ⇒ nếu có\n` +
    `  ứng viên nào nổi lên thì vẫn phải qua Reality Check, lệch pha nến và test tập trung.`,
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
