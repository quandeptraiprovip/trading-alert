/**
 * exp-indicator-info.ts — MỖI CHỈ BÁO MANG BAO NHIÊU THÔNG TIN VỀ KẾT QUẢ MỘT LỆNH CỦA HỆ NÀY?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO ĐO TRƯỚC KHI XÂY LUẬT
 *
 * Quy trình thông thường — "thêm chỉ báo X, backtest, xem NET R" — có hai chỗ hỏng:
 *   · mỗi lần thử là một lần rút thăm trên cùng bộ dữ liệu (chi phí chọn lọc, Bailey & López de
 *     Prado), nên đủ số lần thử thì kiểu gì cũng ra một biến thể "thắng";
 *   · một chỉ báo VÔ THÔNG TIN vẫn có thể làm NET R tăng, chỉ vì nó vô tình bỏ bớt lệnh ở đúng giai
 *     đoạn xấu của mẫu.
 *
 * Ở đây làm ngược lại: ghi lại giá trị chỉ báo TẠI THỜI ĐIỂM VÀO của từng unit mà hệ THẬT SỰ đã mở,
 * rồi hỏi một câu duy nhất — chỉ báo đó có tương quan với netR về sau không. Một bảng, không luật
 * nào được xây, không tham số nào được chọn. Chỉ báo không qua nổi bước này thì mọi luật dựng trên
 * nó đều là nhiễu, và ta biết điều đó với chi phí ĐÚNG MỘT lần thử.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HAI ĐỐI CHỨNG NẰM NGAY TRONG BẢNG (không có chúng thì bảng không đọc được)
 *
 *   [ĐC+] atrPct — repo ĐÃ đo hiệu ứng này rất mạnh (Q1 1,072R/unit vs Q5 0,298R/unit,
 *         scripts/exp-vol-entry-filter.ts). Nếu bảng này KHÔNG thấy lại nó thì bảng bị hỏng.
 *   [ĐC−] hourUTC / rand — giờ trong ngày và một số ngẫu nhiên có seed. Không có cơ chế nào để
 *         chúng dự báo netR. Chúng cho biết SÀN NHIỄU thật của phép đo — bất kỳ chỉ báo nào có
 *         |ρ| không vượt rõ hai cái này thì bằng 0.
 *
 * SÀN PHÁT HIỆN: các unit KHÔNG độc lập (pyramid cùng vị thế dùng chung exit; các symbol phá vỡ
 * cùng lúc thắng/thua cùng nhau). Sai số chuẩn 1/√n vì thế LẠC QUAN GIẢ. Khoảng tin cậy dưới đây
 * dùng bootstrap theo KHỐI THÁNG — lấy lại nguyên cả tháng, giữ nguyên mọi phụ thuộc trong tháng.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-indicator-info.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs, ema } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, UnitTrade, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { buildRollingCorr } from "./exp-corr-heat";

const DAY = TF_MS["1d"];
const BPD = TF_MS["1d"] / TF_MS["4h"]; // 6 nến 4h / ngày

// ─────────────────────────────────────────────────────────────────────────────
// CHỈ BÁO — mỗi hàm trả một mảng cùng độ dài nến, chỉ dùng dữ liệu tới nến i
// ─────────────────────────────────────────────────────────────────────────────

/** ADX Wilder — "sức mạnh xu hướng" theo Wilder (1978). KHÔNG có hướng: 25 mạnh, <20 lình xình. */
export function adxSeries(c: Candle[], len = 14): number[] {
  const n = c.length;
  const tr = new Array(n).fill(0), pdm = new Array(n).fill(0), ndm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    ndm[i] = dn > up && dn > 0 ? dn : 0;
    const pc = c[i - 1].close;
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
  }
  const rma = (x: number[]) => {
    const o = new Array(n).fill(0);
    let p = 0;
    for (let i = 0; i < n; i++) {
      if (i < len) { p += x[i]; o[i] = p / (i + 1); if (i === len - 1) p = o[i]; }
      else { p = (p * (len - 1) + x[i]) / len; o[i] = p; }
    }
    return o;
  };
  const atr = rma(tr), pd = rma(pdm), nd = rma(ndm);
  const dx = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!(atr[i] > 0)) continue;
    const p = (100 * pd[i]) / atr[i], m = (100 * nd[i]) / atr[i];
    dx[i] = p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0;
  }
  return rma(dx);
}

/**
 * Kaufman Efficiency Ratio — "đi được bao xa / đi hết bao nhiêu đường".
 * 1 = đường thẳng tuyệt đối, 0 = đi lòng vòng về chỗ cũ. Đây là định nghĩa toán học của "trend sạch".
 */
function erSeries(c: Candle[], len: number): number[] {
  const n = c.length, out = new Array(n).fill(0);
  const step = new Array(n).fill(0);
  for (let i = 1; i < n; i++) step[i] = Math.abs(c[i].close - c[i - 1].close);
  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum += step[i];
    if (i > len) sum -= step[i - len];
    if (i >= len) out[i] = sum > 0 ? Math.abs(c[i].close - c[i - len].close) / sum : 0;
  }
  return out;
}

/** t-stat của hệ số góc OLS log(close) ~ thời gian, `len` nến — "TREND rule" của Baltas & Kosowski. */
function trendTStat(c: Candle[], len: number): number[] {
  const n = c.length, out = new Array(n).fill(0);
  const xs = Array.from({ length: len }, (_, k) => k);
  const mx = (len - 1) / 2;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  for (let i = len; i < n; i++) {
    let sy = 0;
    for (let k = 0; k < len; k++) sy += Math.log(c[i - len + 1 + k].close);
    const my = sy / len;
    let sxy = 0;
    for (let k = 0; k < len; k++) sxy += (xs[k] - mx) * (Math.log(c[i - len + 1 + k].close) - my);
    const b = sxy / sxx;
    let sse = 0;
    for (let k = 0; k < len; k++) {
      const e = Math.log(c[i - len + 1 + k].close) - (my + b * (xs[k] - mx));
      sse += e * e;
    }
    const se = Math.sqrt(sse / (len - 2) / sxx);
    out[i] = se > 0 ? b / se : 0;
  }
  return out;
}

/**
 * Variance Ratio (Lo & MacKinlay 1988) — Var(return q nến) / (q · Var(return 1 nến)).
 * >1 = giá có quán tính (trend-friendly); <1 = giá hồi về (mean-reverting); =1 = bước ngẫu nhiên.
 */
function varianceRatio(c: Candle[], q: number, win: number): number[] {
  const n = c.length, out = new Array(n).fill(1);
  const r = new Array(n).fill(0);
  for (let i = 1; i < n; i++) r[i] = Math.log(c[i].close / c[i - 1].close);
  for (let i = win + q; i < n; i++) {
    let s1 = 0, m1 = 0, cnt = 0;
    for (let k = i - win + 1; k <= i; k++) { m1 += r[k]; cnt++; }
    m1 /= cnt;
    for (let k = i - win + 1; k <= i; k++) s1 += (r[k] - m1) ** 2;
    s1 /= cnt - 1;
    let sq = 0, mq = 0, cq = 0;
    for (let k = i - win + q; k <= i; k++) {
      let acc = 0;
      for (let j = 0; j < q; j++) acc += r[k - j];
      mq += acc; cq++;
    }
    mq /= cq;
    for (let k = i - win + q; k <= i; k++) {
      let acc = 0;
      for (let j = 0; j < q; j++) acc += r[k - j];
      sq += (acc - mq) ** 2;
    }
    sq /= cq - 1;
    out[i] = s1 > 0 ? sq / (q * s1) : 1;
  }
  return out;
}

export function rsiSeries(c: Candle[], len = 14): number[] {
  const n = c.length, out = new Array(n).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < n; i++) {
    const d = c[i].close - c[i - 1].close;
    const g = Math.max(0, d), l = Math.max(0, -d);
    if (i <= len) { ag += g / len; al += l / len; }
    else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; }
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Độ lệch (skew) của return `len` nến gần nhất — đuôi phải dày hay đuôi trái dày. */
function skewSeries(c: Candle[], len: number): number[] {
  const n = c.length, out = new Array(n).fill(0);
  const r = new Array(n).fill(0);
  for (let i = 1; i < n; i++) r[i] = Math.log(c[i].close / c[i - 1].close);
  for (let i = len; i < n; i++) {
    let m = 0;
    for (let k = i - len + 1; k <= i; k++) m += r[k];
    m /= len;
    let v = 0, t = 0;
    for (let k = i - len + 1; k <= i; k++) { v += (r[k] - m) ** 2; t += (r[k] - m) ** 3; }
    v /= len;
    out[i] = v > 0 ? t / len / v ** 1.5 : 0;
  }
  return out;
}

/** Số nến kể từ lần close cắt EMA theo hướng đang xét — "trend này đã già bao lâu". */
function barsSinceCross(c: Candle[], emaArr: number[]): { up: number[]; dn: number[] } {
  const n = c.length, up = new Array(n).fill(0), dn = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    up[i] = c[i].close > emaArr[i] ? up[i - 1] + 1 : 0;
    dn[i] = c[i].close < emaArr[i] ? dn[i - 1] + 1 : 0;
  }
  return { up, dn };
}

// ─────────────────────────────────────────────────────────────────────────────
// THỐNG KÊ
// ─────────────────────────────────────────────────────────────────────────────
function rankOf(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(x.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

const spearman = (a: number[], b: number[]) => pearson(rankOf(a), rankOf(b));

/**
 * Chênh lệch netR TRUNG BÌNH giữa ngũ phân vị cao nhất và thấp nhất.
 *
 * VÌ SAO CẦN CẢ HAI THỐNG KÊ: netR của hệ này có đuôi phải cực dày (1% số ngày mang 68% lợi nhuận).
 * Spearman chạy trên HẠNG nên nó trả lời "chỉ báo có dự báo TẦN SUẤT THẮNG không". Còn tiền thì nằm
 * ở ĐỘ LỚN của vài lệnh thắng lớn, và đại lượng đó chỉ hiện ra ở TRUNG BÌNH. Hai câu hỏi khác nhau,
 * và một chỉ báo hoàn toàn có thể mạnh ở câu thứ hai mà bằng 0 ở câu thứ nhất (atrPct chính là ca đó).
 */
function q5MinusQ1(vals: number[], outs: number[]): number {
  const order = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const seg = (k: number) => {
    const a = Math.floor((order.length * k) / 5), b = Math.floor((order.length * (k + 1)) / 5);
    const s = order.slice(a, b);
    return s.length ? s.reduce((t, [, i]) => t + outs[i], 0) / s.length : 0;
  };
  return seg(4) - seg(0);
}

/** Bootstrap theo KHỐI THÁNG — giữ nguyên phụ thuộc giữa các unit trong cùng tháng. */
function blockBootstrapCI(vals: number[], outs: number[], months: number[], B = 800, seed = 11) {
  const byMonth = new Map<number, number[]>();
  months.forEach((m, i) => { if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m)!.push(i); });
  const keys = [...byMonth.keys()];
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rho: number[] = [], spread: number[] = [];
  for (let b = 0; b < B; b++) {
    const va: number[] = [], oa: number[] = [];
    for (let k = 0; k < keys.length; k++) {
      const ids = byMonth.get(keys[Math.floor(rand() * keys.length)])!;
      for (const i of ids) { va.push(vals[i]); oa.push(outs[i]); }
    }
    rho.push(spearman(va, oa));
    spread.push(q5MinusQ1(va, oa));
  }
  rho.sort((a, b) => a - b);
  spread.sort((a, b) => a - b);
  const pick = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(B * p)))];
  return {
    lo: pick(rho, 0.025), hi: pick(rho, 0.975),
    // Cửa Bonferroni cho 19 phép thử: 95% → 99,74% (α/19). Không có nó thì với 19 chỉ báo, một
    // "phát hiện" ở mức 95% là chuyện PHẢI xảy ra chứ không phải bằng chứng — xem đối chứng `rand`.
    loB: pick(rho, 0.0013), hiB: pick(rho, 0.9987),
    sLo: pick(spread, 0.025), sHi: pick(spread, 0.975),
    sLoB: pick(spread, 0.0013), sHiB: pick(spread, 0.9987),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
interface Feat { [k: string]: number }

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const corr = buildRollingCorr(data, 90);
  const syms = [...data.keys()].sort();
  console.log(`Cửa sổ đánh giá: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}\n`);

  // ── tiền tính chỉ báo cho từng symbol ──
  type Pre = {
    idx: Map<number, number>; atr: number[]; atrMed: number[]; adx: number[]; er20: number[]; er50: number[];
    tstat: number[]; vr5: number[]; vr10: number[]; rsi: number[]; skew: number[]; volSma: number[];
    emaArr: number[]; up: number[]; dn: number[]; c: Candle[];
  };
  const pre = new Map<string, Pre>();
  for (const [s, c] of data) {
    const closes = c.map((x) => x.close);
    const atr = atrSeries(c, T.atrPeriod);
    const atrMed = new Array(c.length).fill(0);
    for (let i = 90; i < c.length; i++) {
      const win = atr.slice(i - 90, i).sort((a, b) => a - b);
      atrMed[i] = win[45];
    }
    const volSma = new Array(c.length).fill(0);
    let vs = 0;
    for (let i = 0; i < c.length; i++) { vs += c[i].volume; if (i >= 20) vs -= c[i - 20].volume; volSma[i] = vs / Math.min(i + 1, 20); }
    const emaArr = ema(closes, T.trendLen);
    const { up, dn } = barsSinceCross(c, emaArr);
    pre.set(s, {
      idx: new Map(c.map((b, i) => [b.openTime, i])),
      atr, atrMed, adx: adxSeries(c, 14), er20: erSeries(c, 20), er50: erSeries(c, 50),
      tstat: trendTStat(c, T.trendLen), vr5: varianceRatio(c, 5, 100), vr10: varianceRatio(c, 10, 100),
      rsi: rsiSeries(c, 14), skew: skewSeries(c, 20), volSma, emaArr, up, dn, c,
    });
  }

  // ── chạy hệ, ghi đặc trưng tại mỗi lần admit ──
  const feats = new Map<string, Feat>();
  let rseed = 99;
  const rnd = () => { rseed |= 0; rseed = (rseed + 0x6d2b79f5) | 0; let t = Math.imul(rseed ^ (rseed >>> 15), 1 | rseed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const record: AdmitFn = (ctx: AdmitCtx) => {
    const wt = 1 / (1 + ctx.sameDirHeat / T.heatDecayK);
    const sym = ctx.rawSymbol;
    const p = pre.get(sym);
    const i = p?.idx.get(ctx.time);
    if (!p || i === undefined) return wt;
    const sign = ctx.dir === "long" ? 1 : -1;
    const bar = p.c[i];
    let bc = 0, bn = 0;
    for (const a of syms) for (const b of syms) if (a < b) { bc += corr(ctx.time, a, b); bn++; }
    feats.set(`${ctx.symbol}|${ctx.time}`, {
      atrPct: p.atr[i] > 0 ? (p.atr[i] / bar.close) * 100 : 0,
      atrRel: p.atrMed[i] > 0 ? p.atr[i] / p.atrMed[i] : 1,
      adx14: p.adx[i],
      er20: p.er20[i],
      er50: p.er50[i],
      tstat50: sign * p.tstat[i],
      vr5: p.vr5[i],
      vr10: p.vr10[i],
      rsi14: sign > 0 ? p.rsi[i] : 100 - p.rsi[i],
      skew20: sign * p.skew[i],
      extEma: p.atr[i] > 0 ? (sign * (bar.close - p.emaArr[i])) / p.atr[i] : 0,
      trendAge: sign > 0 ? p.up[i] : p.dn[i],
      volZ: p.volSma[i] > 0 ? Math.log(bar.volume / p.volSma[i]) : 0,
      heat: ctx.sameDirHeat,
      openUnits: ctx.open.length,
      basketCorr: bn ? bc / bn : 0,
      isAdd: ctx.kind === "add" ? 1 : 0,
      hourUTC: new Date(ctx.time).getUTCHours(),
      rand: rnd(),
    });
    return wt;
  };

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const res = runBooks([...bk(turtle, "t"), ...bk(fast, "f")], record);

  // ── ghép đặc trưng với kết quả ──
  const rows: { f: Feat; netR: number; month: number; dir: string }[] = [];
  for (const t of res.trades as UnitTrade[]) {
    if (t.entryTime < w.from || t.entryTime > w.to) continue;
    const f = feats.get(`${t.book}|${t.entryTime}`);
    if (!f) continue;
    const d = new Date(t.entryTime);
    rows.push({ f, netR: t.netR, month: d.getUTCFullYear() * 12 + d.getUTCMonth(), dir: t.dir });
  }
  console.log(`Ghép được ${rows.length} unit có đủ đặc trưng (trên ${res.trades.length} unit).`);
  const nMonths = new Set(rows.map((r) => r.month)).size;
  console.log(`Trải trên ${nMonths} tháng → bootstrap khối tháng.\n`);

  const NAMES: [string, string][] = [
    ["atrPct", "[ĐC+] ATR%/giá lúc vào"],
    ["atrRel", "ATR / trung vị ATR 90 nến"],
    ["adx14", "ADX(14) — sức mạnh trend"],
    ["er20", "Efficiency Ratio 20 — trend sạch"],
    ["er50", "Efficiency Ratio 50"],
    ["tstat50", "t-stat độ dốc 50 nến (B&K)"],
    ["vr5", "Variance Ratio q=5 — quán tính"],
    ["vr10", "Variance Ratio q=10"],
    ["rsi14", "RSI(14) theo hướng lệnh"],
    ["skew20", "Skew 20 nến theo hướng"],
    ["extEma", "Độ giãn khỏi EMA50 (×ATR)"],
    ["trendAge", "Tuổi trend (nến trên/dưới EMA)"],
    ["volZ", "log(volume / SMA20 volume)"],
    ["heat", "heat cùng hướng (đang dùng)"],
    ["openUnits", "số unit đang mở cả rổ"],
    ["basketCorr", "tương quan TB của rổ lúc vào"],
    ["isAdd", "unit pyramid hay lệnh mới"],
    ["hourUTC", "[ĐC−] giờ UTC"],
    ["rand", "[ĐC−] số ngẫu nhiên"],
  ];

  const outs = rows.map((r) => r.netR);
  const months = rows.map((r) => r.month);

  console.log("═".repeat(124));
  console.log("  THÔNG TIN CỦA TỪNG CHỈ BÁO VỀ netR CỦA UNIT — bootstrap khối THÁNG, 19 phép thử");
  console.log("═".repeat(124));
  console.log("  " + "chỉ báo".padEnd(32) +
    "ρ Spearman".padStart(11) + " (dự báo TẦN SUẤT)".padEnd(20) +
    "Q5−Q1 netR".padStart(11) + " (dự báo ĐỘ LỚN)".padEnd(22) + "  ngũ phân vị Q1→Q5");
  console.log("-".repeat(124));

  type Res = { key: string; rho: number; sig95: boolean; sigB: boolean; spread: number; sSig95: boolean; sSigB: boolean };
  const results: Res[] = [];
  for (const [key, label] of NAMES) {
    const vals = rows.map((r) => r.f[key] ?? 0);
    const rho = spearman(vals, outs);
    const spread = q5MinusQ1(vals, outs);
    const ci = blockBootstrapCI(vals, outs, months);
    const sig95 = ci.lo > 0 || ci.hi < 0;
    const sigB = ci.loB > 0 || ci.hiB < 0;
    const sSig95 = ci.sLo > 0 || ci.sHi < 0;
    const sSigB = ci.sLoB > 0 || ci.sHiB < 0;
    results.push({ key, rho, sig95, sigB, spread, sSig95, sSigB });

    const order = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const qs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const a = Math.floor((order.length * k) / 5), b = Math.floor((order.length * (k + 1)) / 5);
      const seg = order.slice(a, b);
      qs.push(seg.length ? seg.reduce((s, [, i]) => s + outs[i], 0) / seg.length : 0);
    }
    const mk = (s95: boolean, sB: boolean) => (sB ? "◆◆" : s95 ? "◆ " : "  ");
    console.log("  " + label.padEnd(32) +
      ((rho >= 0 ? "+" : "") + rho.toFixed(3)).padStart(11) + " " + mk(sig95, sigB).padEnd(19) +
      ((spread >= 0 ? "+" : "") + spread.toFixed(2)).padStart(11) + " " + mk(sSig95, sSigB).padEnd(21) +
      "  " + qs.map((x) => (x >= 0 ? "+" : "") + x.toFixed(2)).join(" "));
  }

  const ctrl = results.filter((r) => r.key === "hourUTC" || r.key === "rand");
  const floorR = Math.max(...ctrl.map((r) => Math.abs(r.rho)));
  const floorS = Math.max(...ctrl.map((r) => Math.abs(r.spread)));
  console.log("-".repeat(124));
  console.log(`  ◆ = CI 95% không chứa 0   ·   ◆◆ = còn đứng vững sau Bonferroni cho 19 phép thử (CI 99,74%)`);
  console.log(`  SÀN NHIỄU đo từ hai đối chứng âm: |ρ| ≤ ${floorR.toFixed(3)} · |Q5−Q1| ≤ ${floorS.toFixed(2)}R`);
  const real = results.filter((r) => r.key !== "hourUTC" && r.key !== "rand");
  const passB = real.filter((r) => (r.sigB && Math.abs(r.rho) > floorR) || (r.sSigB && Math.abs(r.spread) > floorS));
  const pass95 = real.filter((r) => ((r.sig95 && Math.abs(r.rho) > floorR) || (r.sSig95 && Math.abs(r.spread) > floorS)) && !passB.includes(r));
  console.log(`  Vượt cửa 95% (CHƯA chỉnh đa phép thử): ` + (pass95.length ? pass95.map((r) => r.key).join(", ") : "không có"));
  console.log(`  Vượt cửa Bonferroni — cửa DUY NHẤT đáng tin: ` + (passB.length ? passB.map((r) => r.key).join(", ") : "KHÔNG CÓ CHỈ BÁO NÀO"));
  const randRes = results.find((r) => r.key === "rand")!;
  if (randRes.sig95) console.log(`  ⚠️  Đối chứng âm 'số ngẫu nhiên' ĐẬU cửa 95% (ρ ${randRes.rho.toFixed(3)}) — minh hoạ sống: với 19 phép thử,\n      một phát hiện mức 95% là chuyện PHẢI xảy ra. Đây chính là lý do cột Bonferroni tồn tại.`);

  console.log(
    "\nĐỌC KẾT QUẢ: ρ ở đây là thông tin TẠI THỜI ĐIỂM VÀO của những lệnh hệ ĐÃ mở — nó KHÔNG nói\n" +
    "chỉ báo có giá trị cho một hệ khác. Và vượt cửa ở bảng này mới chỉ là điều kiện CẦN: repo đã có\n" +
    "ca atrPct — hiệu ứng rất mạnh ở bảng kiểu này nhưng khi biến thành luật vào lệnh thì era A sụp\n" +
    "1,44 → 0,73 (planning/chop-regime-diagnosis-2026-08.md). Bảng này chỉ dùng để LOẠI, không để CHỌN.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
