/**
 * exp-classic-indicators.ts — MACD, EMA, RSI, Bollinger, Stochastic, CCI, SuperTrend, Ichimoku…
 * DÙNG LÀM BỘ LỌC VÀO LỆNH THẬT trên Turtle/Fast. Có kiếm thêm tiền không?
 *
 * Khác `exp-indicator-info.ts` (chỉ đo tương quan chỉ báo ↔ netR): file này BIẾN CHỈ BÁO THÀNH LUẬT
 * — chặn lệnh khi chỉ báo không xác nhận — rồi chấm bằng đúng bộ metric của repo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO PHẢI CÓ NHÓM GIẢ "LỌC NGẪU NHIÊN CÙNG TỈ LỆ" — đây là phần quan trọng nhất của file
 *
 * MỌI bộ lọc đều bỏ bớt lệnh. Bỏ bớt lệnh tự nó đã thay đổi Sharpe/maxDD theo những cách không liên
 * quan gì tới chất lượng tín hiệu:
 *   · bỏ lệnh làm giảm số cược ⇒ phương sai đổi;
 *   · bỏ lệnh làm giảm heat trung bình ⇒ các lệnh CÒN LẠI được size to hơn;
 *   · và với một mẫu hữu hạn, một bộ lọc VÔ NGHĨA vẫn có ~50% khả năng rơi trúng phía tốt.
 *
 * Nên câu hỏi đúng KHÔNG phải "bộ lọc MACD có làm Sharpe tăng không" mà là **"nó có tăng nhiều hơn
 * một bộ lọc NGẪU NHIÊN loại đi ĐÚNG cùng tỉ lệ lệnh không"**. Mỗi ứng viên vì thế được so với 9 bộ
 * lọc ngẫu nhiên có seed, khớp tỉ lệ chấp nhận; bảng in trung vị và MỨC TỐT NHẤT trong 9 bản đó.
 * Không vượt được mức tốt nhất của nhiễu ⇒ bằng 0, bất kể Sharpe tuyệt đối trông đẹp thế nào.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CỬA DUYỆT (một ứng viên phải qua HẾT)
 *   1. Sharpe VÀ NET/maxDD cao hơn baseline
 *   2. Vượt mức TỐT NHẤT của 9 nhóm giả cùng tỉ lệ lọc
 *   3. Không era nào tệ đi rõ rệt (edge thật thì không sống nhờ đúng một era)
 *   4. Có PLATEAU: các mức tham số lân cận cùng thắng, không phải một điểm
 *   5. Đậu lệch pha nến 4h (chạy riêng exp-bar-phase.ts nếu tới được bước này)
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-classic-indicators.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs, ema } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { adxSeries, rsiSeries } from "./exp-indicator-info";

type Dir = "long" | "short";

// ─────────────────────────────────────────────────────────────────────────────
// CHỈ BÁO KINH ĐIỂN — tất cả forward-only, chỉ dùng dữ liệu tới nến i
// ─────────────────────────────────────────────────────────────────────────────
const sma = (x: number[], n: number): number[] => {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
};

/** MACD(fast, slow, signal) — chênh lệch hai EMA, cùng đường tín hiệu và histogram. */
function macd(c: Candle[], f = 12, s = 26, sig = 9) {
  const cl = c.map((x) => x.close);
  const ef = ema(cl, f), es = ema(cl, s);
  const line = ef.map((v, i) => v - es[i]);
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

function stochastic(c: Candle[], n = 14, d = 3) {
  const k = new Array(c.length).fill(50);
  for (let i = n - 1; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    k[i] = hh > ll ? ((c[i].close - ll) / (hh - ll)) * 100 : 50;
  }
  return { k, d: sma(k, d) };
}

/** Bollinger: vị trí giá trong dải, chuẩn hoá — 1 = chạm biên trên, 0 = biên dưới. */
function bollingerPos(c: Candle[], n = 20, mult = 2): number[] {
  const cl = c.map((x) => x.close);
  const m = sma(cl, n);
  const out = new Array(c.length).fill(0.5);
  for (let i = n - 1; i < c.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (cl[j] - m[i]) ** 2;
    const sd = Math.sqrt(v / n);
    const up = m[i] + mult * sd, lo = m[i] - mult * sd;
    out[i] = up > lo ? (cl[i] - lo) / (up - lo) : 0.5;
  }
  return out;
}

function cci(c: Candle[], n = 20): number[] {
  const tp = c.map((b) => (b.high + b.low + b.close) / 3);
  const m = sma(tp, n);
  const out = new Array(c.length).fill(0);
  for (let i = n - 1; i < c.length; i++) {
    let mad = 0;
    for (let j = i - n + 1; j <= i; j++) mad += Math.abs(tp[j] - m[i]);
    mad /= n;
    out[i] = mad > 0 ? (tp[i] - m[i]) / (0.015 * mad) : 0;
  }
  return out;
}

/** SuperTrend — hướng (+1/−1) theo dải ATR có ratchet. */
function superTrend(c: Candle[], n = 10, mult = 3): number[] {
  const atr = atrSeries(c, n);
  const dir = new Array(c.length).fill(1);
  let upper = 0, lower = 0;
  for (let i = 1; i < c.length; i++) {
    const mid = (c[i].high + c[i].low) / 2;
    const bu = mid + mult * atr[i], bl = mid - mult * atr[i];
    upper = bu < upper || c[i - 1].close > upper ? bu : upper;
    lower = bl > lower || c[i - 1].close < lower ? bl : lower;
    if (i === 1) { upper = bu; lower = bl; }
    dir[i] = c[i].close > upper ? 1 : c[i].close < lower ? -1 : dir[i - 1];
  }
  return dir;
}

/** Ichimoku: giá so với MÂY (senkou A/B dịch trước 26 nến — mây tại i tính từ dữ liệu i−26). */
function ichimokuCloud(c: Candle[], t = 9, k = 26, b = 52) {
  const hl = (n: number, i: number) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { hh = Math.max(hh, c[j].high); ll = Math.min(ll, c[j].low); }
    return (hh + ll) / 2;
  };
  const above = new Array(c.length).fill(0);
  for (let i = b + k; i < c.length; i++) {
    const src = i - k; // mây hiện tại được vẽ từ dữ liệu k nến trước ⇒ KHÔNG lookahead
    const a = (hl(t, src) + hl(k, src)) / 2;
    const bb = hl(b, src);
    const top = Math.max(a, bb), bot = Math.min(a, bb);
    above[i] = c[i].close > top ? 1 : c[i].close < bot ? -1 : 0;
  }
  return above;
}

/** On-Balance Volume, độ dốc chuẩn hoá `n` nến. */
function obvSlope(c: Candle[], n = 20): number[] {
  const obv = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    obv[i] = obv[i - 1] + (c[i].close > c[i - 1].close ? c[i].volume : c[i].close < c[i - 1].close ? -c[i].volume : 0);
  }
  const out = new Array(c.length).fill(0);
  for (let i = n; i < c.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += Math.abs(c[j].volume);
    out[i] = s > 0 ? (obv[i] - obv[i - n]) / s : 0;
  }
  return out;
}

/** Money Flow Index — RSI có trọng số khối lượng. */
function mfi(c: Candle[], n = 14): number[] {
  const tp = c.map((b) => (b.high + b.low + b.close) / 3);
  const out = new Array(c.length).fill(50);
  for (let i = n; i < c.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const f = tp[j] * c[j].volume;
      if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f;
    }
    out[i] = neg > 0 ? 100 - 100 / (1 + pos / neg) : 100;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BỘ LỌC = (symbol, time, dir) → cho qua hay không
// ─────────────────────────────────────────────────────────────────────────────
export type Filter = (sym: string, time: number, dir: Dir) => boolean;

export interface Pre {
  idx: Map<number, number>;
  macd12: ReturnType<typeof macd>; macd5: ReturnType<typeof macd>; macd19: ReturnType<typeof macd>;
  ema: Record<number, number[]>;
  rsi: number[]; adx: number[]; stoch: ReturnType<typeof stochastic>;
  boll2: number[]; boll25: number[]; cci: number[]; st3: number[]; st2: number[]; st4: number[];
  ichi: number[]; obv: number[]; mfi: number[]; c: Candle[];
}

export function buildPre(data: Map<string, Candle[]>): Map<string, Pre> {
  const m = new Map<string, Pre>();
  for (const [s, c] of data) {
    const cl = c.map((x) => x.close);
    const emas: Record<number, number[]> = {};
    for (const n of [12, 20, 26, 50, 100, 200]) emas[n] = ema(cl, n);
    m.set(s, {
      idx: new Map(c.map((b, i) => [b.openTime, i])),
      macd12: macd(c, 12, 26, 9), macd5: macd(c, 5, 13, 5), macd19: macd(c, 19, 39, 9),
      ema: emas, rsi: rsiSeries(c, 14), adx: adxSeries(c, 14), stoch: stochastic(c, 14, 3),
      boll2: bollingerPos(c, 20, 2), boll25: bollingerPos(c, 20, 2.5), cci: cci(c, 20),
      st3: superTrend(c, 10, 3), st2: superTrend(c, 10, 2), st4: superTrend(c, 10, 4),
      ichi: ichimokuCloud(c), obv: obvSlope(c, 20), mfi: mfi(c, 14), c,
    });
  }
  return m;
}

/** Mỗi ứng viên: nhãn + nhóm (để nhóm biến thể tham số cạnh nhau) + hàm lọc. */
export function candidates(pre: Map<string, Pre>): { group: string; label: string; f: Filter }[] {
  const at = (sym: string, time: number) => {
    const p = pre.get(sym);
    const i = p?.idx.get(time);
    return p && i !== undefined ? { p, i } : null;
  };
  const mk = (group: string, label: string, fn: (p: Pre, i: number, sgn: number, dir: Dir) => boolean) =>
    ({ group, label, f: ((sym, time, dir) => { const r = at(sym, time); return r ? fn(r.p, r.i, dir === "long" ? 1 : -1, dir) : true; }) as Filter });

  return [
    // ── MACD: bốn cách dùng phổ biến nhất, mỗi cách 1-3 tham số ──
    mk("MACD", "MACD hist cùng hướng", (p, i, s) => s * p.macd12.hist[i] > 0),
    mk("MACD", "MACD hist (5,13,5) nhanh", (p, i, s) => s * p.macd5.hist[i] > 0),
    mk("MACD", "MACD hist (19,39,9) chậm", (p, i, s) => s * p.macd19.hist[i] > 0),
    mk("MACD", "MACD line vượt signal", (p, i, s) => s * (p.macd12.line[i] - p.macd12.signal[i]) > 0),
    mk("MACD", "MACD line cùng phía 0", (p, i, s) => s * p.macd12.line[i] > 0),
    mk("MACD", "MACD hist ĐANG MỞ RỘNG", (p, i, s) => i > 0 && s * p.macd12.hist[i] > 0 && s * (p.macd12.hist[i] - p.macd12.hist[i - 1]) > 0),
    mk("MACD", "MACD hist NGƯỢC (đối chứng)", (p, i, s) => s * p.macd12.hist[i] < 0),

    // ── EMA: giao cắt và bộ lọc dài hạn ──
    mk("EMA", "EMA20 vs EMA50", (p, i, s) => s * (p.ema[20][i] - p.ema[50][i]) > 0),
    mk("EMA", "EMA12 vs EMA26", (p, i, s) => s * (p.ema[12][i] - p.ema[26][i]) > 0),
    mk("EMA", "EMA50 vs EMA200", (p, i, s) => s * (p.ema[50][i] - p.ema[200][i]) > 0),
    mk("EMA", "giá vs EMA100", (p, i, s) => s * (p.c[i].close - p.ema[100][i]) > 0),
    mk("EMA", "giá vs EMA200", (p, i, s) => s * (p.c[i].close - p.ema[200][i]) > 0),
    mk("EMA", "xếp tầng 20>50>200", (p, i, s) => s * (p.ema[20][i] - p.ema[50][i]) > 0 && s * (p.ema[50][i] - p.ema[200][i]) > 0),

    // ── ADX ──
    mk("ADX", "ADX ≥ 20", (p, i) => p.adx[i] >= 20),
    mk("ADX", "ADX ≥ 25", (p, i) => p.adx[i] >= 25),
    mk("ADX", "ADX ≥ 30", (p, i) => p.adx[i] >= 30),

    // ── RSI ──
    mk("RSI", "RSI cùng phía 50", (p, i, s) => s * (p.rsi[i] - 50) > 0),
    mk("RSI", "RSI chưa quá mua/bán (30-70)", (p, i, s, d) => (d === "long" ? p.rsi[i] < 70 : p.rsi[i] > 30)),
    mk("RSI", "RSI chưa quá mua/bán (25-75)", (p, i, s, d) => (d === "long" ? p.rsi[i] < 75 : p.rsi[i] > 25)),

    // ── Stochastic / CCI / MFI ──
    mk("Stoch", "Stoch %K cùng phía 50", (p, i, s) => s * (p.stoch.k[i] - 50) > 0),
    mk("Stoch", "Stoch chưa cực trị (20-80)", (p, i, s, d) => (d === "long" ? p.stoch.k[i] < 80 : p.stoch.k[i] > 20)),
    mk("CCI", "CCI cùng phía 0", (p, i, s) => s * p.cci[i] > 0),
    mk("CCI", "|CCI| ≥ 100 cùng hướng", (p, i, s) => s * p.cci[i] >= 100),
    mk("MFI", "MFI cùng phía 50", (p, i, s) => s * (p.mfi[i] - 50) > 0),

    // ── Bollinger ──
    mk("Boll", "phá biên Bollinger 2σ", (p, i, s, d) => (d === "long" ? p.boll2[i] > 1 : p.boll2[i] < 0)),
    mk("Boll", "trong biên Bollinger 2σ", (p, i, s, d) => (d === "long" ? p.boll2[i] <= 1 : p.boll2[i] >= 0)),
    mk("Boll", "phá biên Bollinger 2,5σ", (p, i, s, d) => (d === "long" ? p.boll25[i] > 1 : p.boll25[i] < 0)),

    // ── SuperTrend / Ichimoku ──
    mk("SuperT", "SuperTrend(10;3) cùng hướng", (p, i, s) => s * p.st3[i] > 0),
    mk("SuperT", "SuperTrend(10;2) cùng hướng", (p, i, s) => s * p.st2[i] > 0),
    mk("SuperT", "SuperTrend(10;4) cùng hướng", (p, i, s) => s * p.st4[i] > 0),
    mk("Ichi", "trên/dưới mây Ichimoku", (p, i, s) => s * p.ichi[i] > 0),
    mk("Ichi", "không nằm TRONG mây", (p, i, s) => p.ichi[i] !== 0),

    // ── OBV ──
    mk("OBV", "độ dốc OBV cùng hướng", (p, i, s) => s * p.obv[i] > 0),

    // ── kết hợp phổ biến ──
    mk("Combo", "MACD + ADX≥20", (p, i, s) => s * p.macd12.hist[i] > 0 && p.adx[i] >= 20),
    mk("Combo", "MACD + EMA50>EMA200", (p, i, s) => s * p.macd12.hist[i] > 0 && s * (p.ema[50][i] - p.ema[200][i]) > 0),
    mk("Combo", "MACD + RSI cùng phía 50", (p, i, s) => s * p.macd12.hist[i] > 0 && s * (p.rsi[i] - 50) > 0),
    mk("Combo", "SuperTrend + ADX≥20", (p, i, s) => s * p.st3[i] > 0 && p.adx[i] >= 20),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);
type Win = ReturnType<typeof coreWindow>;

function admitWith(filter: Filter | null): AdmitFn {
  const heat = decayH(T.heatDecayK);
  return (c: AdmitCtx) => {
    // Bộ lọc chỉ áp cho LỆNH MỚI. Unit pyramid là hệ quả của một lệnh đã được duyệt — lọc chúng
    // là đổi luật pyramiding, một câu hỏi khác hẳn.
    if (filter && c.kind === "entry" && !filter(c.rawSymbol, c.time, c.dir)) return 0;
    return heat(c);
  };
}

interface Row { sharpe: number; netR: number; maxDD: number; netDd: number; era: number[]; units: number; keep: number }

function scoreOf(bs: Book[], admit: AdmitFn, w: Win, baseUnits?: number): Row {
  const res = runBooks(bs, admit);
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const tr = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const pos = new Set(tr.map((t) => `${t.book}#${t.positionId}`)).size;
  return {
    sharpe: m.sharpe, netR: m.netR, maxDD: m.maxDD, netDd: m.netOverMaxDD,
    era: eras.map((e) => e.sharpe), units: tr.length, keep: baseUnits ? pos / baseUnits : pos,
  };
}

/** PRNG có seed. */
function rng(seed: number) {
  let s = seed;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Bộ lọc NGẪU NHIÊN chấp nhận đúng tỉ lệ `p` — nhóm giả khớp tỉ lệ lọc. */
function randomFilter(p: number, seed: number): Filter {
  const r = rng(seed);
  const cache = new Map<string, boolean>();
  return (sym, time) => {
    const k = `${sym}|${time}`;
    let v = cache.get(k);
    if (v === undefined) { v = r() < p; cache.set(k, v); }
    return v;
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const pre = buildPre(data);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const both = [...bk(turtle, "t"), ...bk(fast, "f")];

  console.log(`Cửa sổ đánh giá: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}\n`);

  const base = scoreOf(both, admitWith(null), w);
  const basePos = base.keep;
  console.log("═".repeat(126));
  console.log(`  BASELINE (không lọc): Sharpe ${base.sharpe.toFixed(2)} · NET ${base.netR.toFixed(0)}R · maxDD ${base.maxDD.toFixed(0)}R · ` +
    `NET/DD ${base.netDd.toFixed(2)} · era ${base.era.map((x) => x.toFixed(2)).join("/")} · ${basePos} vị thế`);
  console.log("═".repeat(126));

  const cands = candidates(pre);
  console.log(`  ${cands.length} biến thể bộ lọc. Mỗi biến thể so với 9 NHÓM GIẢ lọc ngẫu nhiên CÙNG tỉ lệ.\n`);
  console.log("  " + "bộ lọc".padEnd(30) + "giữ%".padStart(6) + "Sharpe".padStart(8) + "ΔSharpe".padStart(9) +
    "NET R".padStart(8) + "NET/DD".padStart(8) + "  era A/B/C".padEnd(20) + "  giả: trung vị / TỐT NHẤT".padEnd(28) + "kết luận");
  console.log("-".repeat(126));

  let lastGroup = "";
  const survivors: string[] = [];
  for (const cand of cands) {
    if (cand.group !== lastGroup) { console.log("  " + "·".repeat(122)); lastGroup = cand.group; }
    const r = scoreOf(both, admitWith(cand.f), w, basePos);
    const keep = r.keep;

    // 9 nhóm giả khớp tỉ lệ giữ lệnh
    const placebo: number[] = [];
    for (let s = 0; s < 9; s++) placebo.push(scoreOf(both, admitWith(randomFilter(keep, 1000 + s * 37)), w).sharpe);
    placebo.sort((a, b) => a - b);
    const pMed = placebo[4], pBest = placebo[8];

    const beatsBase = r.sharpe > base.sharpe && r.netDd > base.netDd;
    const beatsNoise = r.sharpe > pBest;
    const eraOk = r.era.every((x, i) => x > base.era[i] * 0.9);
    const verdict = !beatsBase ? "thua baseline" : !beatsNoise ? "THUA NHIỄU" : !eraOk ? "rớt era" : "★ QUA";
    if (verdict === "★ QUA") survivors.push(cand.label);

    console.log("  " + cand.label.padEnd(30) + (keep * 100).toFixed(0).padStart(5) + "%" +
      r.sharpe.toFixed(2).padStart(8) +
      ((r.sharpe - base.sharpe >= 0 ? "+" : "") + (r.sharpe - base.sharpe).toFixed(2)).padStart(9) +
      r.netR.toFixed(0).padStart(8) + r.netDd.toFixed(2).padStart(8) + "  " +
      r.era.map((x) => x.toFixed(2)).join("/").padEnd(20) + "  " +
      `${pMed.toFixed(2)} / ${pBest.toFixed(2)}`.padEnd(28) + verdict);
  }

  console.log("-".repeat(126));
  console.log(`  Cửa: (1) Sharpe VÀ NET/DD > baseline · (2) Sharpe > TỐT NHẤT của 9 nhóm giả cùng tỉ lệ lọc · (3) không era nào tụt >10%`);
  console.log(`  QUA CẢ BA CỬA: ${survivors.length ? survivors.join(" | ") : "KHÔNG CÓ BIẾN THỂ NÀO"}`);
  console.log(
    `\n  Đã thử ${cands.length} biến thể trên CÙNG một bộ dữ liệu. Kể cả có biến thể "qua", chi phí chọn lọc\n` +
    `  vẫn phải trả: với ${cands.length} lần thử, xác suất ít nhất một bộ lọc VÔ NGHĨA lọt cửa là rất cao —\n` +
    `  đó chính là điều cột "nhóm giả" đo. Ứng viên qua được còn phải đậu lệch pha nến (exp-bar-phase.ts)\n` +
    `  và test tập trung (exp-concentration.ts) trước khi bàn tới production.`,
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
