/**
 * exp-vol-estimator.ts — ATR CÓ PHẢI CÁCH ĐO BIẾN ĐỘNG TỐT NHẤT KHÔNG?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VÌ SAO CÂU HỎI NÀY ĐÁNG HỎI
 *
 * ATR(20) không phải "một chỉ báo phụ" của hệ này — nó là MẪU SỐ R. Nó quyết định:
 *   · stop ban đầu khi không có cấu trúc (3×ATR)  → mẫu số R của Fast ở MỌI lệnh (obLookback = 0)
 *   · biên chấp nhận stop cấu trúc (1,5–4×ATR)    → quyết định lệnh nào dùng stop cấu trúc
 *   · Chandelier trail của SHORT (3×ATR)
 *   · bước pyramid (0,5×ATR)
 * Nhiễu trong ATR chảy THẲNG vào risk thật của từng lệnh: ước lượng cao hơn thực tế ⇒ size nhỏ
 * hơn dự định; thấp hơn thực tế ⇒ size to hơn dự định. Đó là nhiễu cộng thêm vào R, không phải
 * nhiễu của thị trường.
 *
 * Và True Range chỉ dùng 2 trong 4 mốc giá của nến (đỉnh, đáy). Có cả một họ ước lượng dùng đủ OHLC
 * với phương sai nhỏ hơn 5–8 lần ở CÙNG số nến — tức cùng một lượng dữ liệu nhưng đo chính xác hơn.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NỀN TÀI LIỆU (hiệu suất tương đối so với ước lượng close-to-close)
 *   Parkinson (1980)         ~5,2×   dùng H,L        — bỏ qua drift ⇒ ƯỚC LƯỢNG THẤP khi có xu hướng
 *   Garman & Klass (1980)    ~7,4×   dùng O,H,L,C    — giả định drift = 0
 *   Rogers & Satchell (1991) ~8×     dùng O,H,L,C    — ĐỘC LẬP VỚI DRIFT (quan trọng cho hệ trend)
 *   Yang & Zhang (2000)      ~14×    thêm gap qua đêm — lợi thế chính là GAP, mà crypto 24/7 gần như
 *                                                       không có ⇒ dự báo: không hơn RS bao nhiêu
 *
 * Với một hệ theo xu hướng, drift ≠ 0 THEO ĐỊNH NGHĨA ở đúng những lúc quan trọng nhất. Đó là lý do
 * Rogers-Satchell là ứng viên đúng về mặt lý thuyết, còn Parkinson là ứng viên SAI (nó sẽ báo biến
 * động thấp giả tạo giữa trend mạnh ⇒ stop quá sát ⇒ size quá to).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BA TẦNG ĐO (tầng 1 và 2 KHÔNG liên quan tới lời lỗ — chúng trả lời "chỉ báo đo đúng không")
 *
 *   1) CHÊNH THANG   — mọi ước lượng phải quy về cùng đơn vị "khoảng giá kiểu ATR" trước khi so.
 *                      Nếu không, ta chỉ đang test "stop rộng hơn / hẹp hơn", thứ đã quét rồi.
 *                      Hằng số quy đổi là LÝ THUYẾT (E[range] = σ·√(8/π) cho chuyển động Brown),
 *                      không phải hằng số fit. Bảng in tỉ lệ thực tế để thấy sai lệch còn lại.
 *   2) SỨC DỰ BÁO    — log(ước lượng tại t) dự báo log(biên độ THỰC 20 nến sau) tốt đến đâu?
 *                      Đây là định nghĩa "đo tốt hơn", đo được mà không cần chiến lược nào.
 *   3) LỜI LỖ        — thay vào hệ, giữ MỌI luật khác y nguyên. Sharpe / NET-DD / ba era.
 *
 * ĐỐI CHỨNG ÂM: close-to-close là ước lượng KÉM NHẤT trong họ. Nếu nó cho kết quả ngang mọi bản
 * khác thì độ chính xác của phép đo biến động KHÔNG quan trọng với hệ này, và cả họ giải pháp này
 * bị loại — đó là thông tin có giá trị chứ không phải thất bại.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-vol-estimator.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

/** E[biên độ] / σ của chuyển động Brown trong một nến — hằng số LÝ THUYẾT, không fit. */
const RANGE_OVER_SIGMA = Math.sqrt(8 / Math.PI); // ≈ 1,5958
const LN2 = Math.log(2);

/**
 * Làm mượt Wilder (RMA) — DÙNG CHUNG cho mọi ước lượng, để khác biệt duy nhất giữa các bản là
 * THỐNG KÊ TỪNG NẾN, không phải độ dài trí nhớ. `atrSeries` của repo dùng đúng cách mượt này.
 */
function rma(x: number[], len: number): number[] {
  const out = new Array(x.length).fill(0);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < len) {
      prev += x[i];
      out[i] = prev / (i + 1);
      if (i === len - 1) prev = out[i];
    } else {
      prev = (prev * (len - 1) + x[i]) / len;
      out[i] = prev;
    }
  }
  return out;
}

/** Từ phương sai log/nến → khoảng giá "kiểu ATR" tại mỗi nến. */
function toAtrScale(c: Candle[], varPerBar: number[], len: number): number[] {
  const sm = rma(varPerBar.map((v) => Math.max(0, v)), len);
  return sm.map((v, i) => Math.sqrt(v) * c[i].close * RANGE_OVER_SIGMA);
}

export type VolFn = (c: Candle[], len: number) => number[];

/**
 * CHUẨN HOÁ THANG BẰNG CỬA SỔ MỞ RỘNG (nhân quả, không lookahead, không tham số tự do):
 * tại nến i, nhân ước lượng với  mean(ATR trên [0..i]) / mean(est trên [0..i]).
 *
 * BẮT BUỘC phải có. Hằng số lý thuyết √(8/π) để lại lệch thang 12–18% trên nến 4h crypto (đuôi dày
 * + bất đẳng thức Jensen giữa "trung bình của căn" và "căn của trung bình"). Nếu không khử, bảng lời
 * lỗ chỉ đang đo "stop rộng hơn 18%" — một thứ đã được quét bằng `chandelierMult` và không liên quan
 * gì tới câu hỏi "ước lượng nào ÍT NHIỄU hơn".
 */
export function rescaleToAtr(fn: VolFn): VolFn {
  return (c, len) => {
    const v = fn(c, len);
    const a = atrSeries(c, len);
    const out = new Array(v.length).fill(0);
    let sa = 0, sv = 0;
    for (let i = 0; i < v.length; i++) {
      sa += a[i]; sv += v[i];
      out[i] = sv > 0 ? v[i] * (sa / sv) : v[i];
    }
    return out;
  };
}

export const volParkinson: VolFn = (c, len) =>
  toAtrScale(c, c.map((b) => (b.high > 0 && b.low > 0 ? Math.log(b.high / b.low) ** 2 / (4 * LN2) : 0)), len);

export const volGarmanKlass: VolFn = (c, len) =>
  toAtrScale(c, c.map((b) => {
    if (!(b.high > 0 && b.low > 0 && b.open > 0 && b.close > 0)) return 0;
    return 0.5 * Math.log(b.high / b.low) ** 2 - (2 * LN2 - 1) * Math.log(b.close / b.open) ** 2;
  }), len);

export const volRogersSatchell: VolFn = (c, len) =>
  toAtrScale(c, c.map((b) => {
    if (!(b.high > 0 && b.low > 0 && b.open > 0 && b.close > 0)) return 0;
    return Math.log(b.high / b.close) * Math.log(b.high / b.open)
      + Math.log(b.low / b.close) * Math.log(b.low / b.open);
  }), len);

/** Yang-Zhang: gap qua đêm + open-to-close + RS. Crypto 24/7 nên phần gap gần như bằng 0. */
export const volYangZhang: VolFn = (c, len) => {
  const k = 0.34 / (1.34 + (len + 1) / (len - 1));
  const vo = c.map((b, i) => (i > 0 && b.open > 0 && c[i - 1].close > 0 ? Math.log(b.open / c[i - 1].close) ** 2 : 0));
  const vc = c.map((b) => (b.open > 0 && b.close > 0 ? Math.log(b.close / b.open) ** 2 : 0));
  const vrs = c.map((b) => {
    if (!(b.high > 0 && b.low > 0 && b.open > 0 && b.close > 0)) return 0;
    return Math.log(b.high / b.close) * Math.log(b.high / b.open)
      + Math.log(b.low / b.close) * Math.log(b.low / b.open);
  });
  return toAtrScale(c, vo.map((v, i) => v + k * vc[i] + (1 - k) * vrs[i]), len);
};

/** ĐỐI CHỨNG ÂM — ước lượng kém nhất trong họ (chỉ dùng giá đóng). */
export const volCloseToClose: VolFn = (c, len) =>
  toAtrScale(c, c.map((b, i) => (i > 0 && b.close > 0 && c[i - 1].close > 0 ? Math.log(b.close / c[i - 1].close) ** 2 : 0)), len);

/** Bản THÔ (chỉ hằng số lý thuyết) — dùng để thấy lệch thang còn lại là bao nhiêu. */
export const ESTIMATORS_RAW: [string, VolFn][] = [
  ["ATR Wilder (đang chạy)", atrSeries],
  ["Parkinson", volParkinson],
  ["Garman-Klass", volGarmanKlass],
  ["Rogers-Satchell", volRogersSatchell],
  ["Yang-Zhang", volYangZhang],
  ["close-to-close (ĐC âm)", volCloseToClose],
];

/** Bản ĐÃ KHỬ LỆCH THANG — chỉ bản này mới so được về lời lỗ. */
export const ESTIMATORS: [string, VolFn][] = ESTIMATORS_RAW.map(
  ([n, f]) => [n, f === atrSeries ? f : rescaleToAtr(f)] as [string, VolFn],
);

// ─────────────────────────────────────────────────────────────────────────────
// TẦNG 2 — SỨC DỰ BÁO: log(ước lượng tại t) vs log(biên độ THỰC 20 nến sau)
// ─────────────────────────────────────────────────────────────────────────────
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Biên độ THỰC HIỆN của `h` nến TIẾP THEO, quy về cùng đơn vị "ATR trung bình mỗi nến". */
function futureRealizedAtr(c: Candle[], i: number, h: number): number | null {
  if (i + h >= c.length) return null;
  let s = 0;
  for (let k = i + 1; k <= i + h; k++) {
    const pc = c[k - 1].close;
    s += Math.max(c[k].high - c[k].low, Math.abs(c[k].high - pc), Math.abs(c[k].low - pc));
  }
  return s / h;
}

/**
 * Tách LỆCH THANG (bias) khỏi NHIỄU (sd của sai số) — hai thứ khác hẳn nhau:
 *   bias  : ước lượng lớn/nhỏ hơn thực tế một cách hệ thống → sửa được bằng một hằng số
 *   sdErr : phần KHÔNG sửa được bằng hằng số nào → đây mới là "ước lượng tốt hơn"
 * `corr` tính trên log ĐÃ TRỪ TRUNG BÌNH THEO SYMBOL: không trừ thì mọi ước lượng đều ra ~0,996 vì
 * bị chi phối bởi chênh lệch mức biến động GIỮA các coin, không phải bởi chất lượng phép đo.
 */
function forecastQuality(data: Map<string, Candle[]>, fn: VolFn, len: number, horizon: number) {
  const xs: number[] = [], ys: number[] = [], errs: number[] = [];
  for (const c of data.values()) {
    const v = fn(c, len);
    const lx: number[] = [], ly: number[] = [];
    for (let i = len * 3; i < c.length - horizon; i += 3) {
      const fut = futureRealizedAtr(c, i, horizon);
      if (fut === null || !(fut > 0) || !(v[i] > 0)) continue;
      lx.push(Math.log(v[i])); ly.push(Math.log(fut));
    }
    if (lx.length < 10) continue;
    const mx = lx.reduce((s, x) => s + x, 0) / lx.length;
    const my = ly.reduce((s, x) => s + x, 0) / ly.length;
    for (let i = 0; i < lx.length; i++) {
      xs.push(lx[i] - mx); ys.push(ly[i] - my);
      errs.push(lx[i] - ly[i]);
    }
  }
  const n = errs.length;
  const bias = n ? errs.reduce((s, x) => s + x, 0) / n : 0;
  const sdErr = n ? Math.sqrt(errs.reduce((s, x) => s + (x - bias) ** 2, 0) / n) : 0;
  return { corr: pearson(xs, ys), bias, sdErr, n };
}

// ─────────────────────────────────────────────────────────────────────────────
type Win = ReturnType<typeof coreWindow>;
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

function scoreOf(label: string, bs: Book[], admit: AdmitFn, w: Win) {
  const res = runBooks(bs, admit);
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const tr = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const stopFrac = tr.length
    ? tr.reduce((s, t) => s + Math.abs(t.entryPrice - t.initialSL) / t.entryPrice, 0) / tr.length : 0;
  return {
    label, sharpe: m.sharpe, netR: m.netR, maxDD: m.maxDD, netDd: m.netOverMaxDD,
    era: eras.map((e) => e.sharpe), units: tr.length, stopPct: stopFrac * 100,
    positions: new Set(tr.map((t) => `${t.book}#${t.positionId}`)).size,
  };
}
type Row = ReturnType<typeof scoreOf>;

const HDR = "  " + "ước lượng".padEnd(26) + "Sharpe".padStart(8) + "NET R".padStart(9) + "maxDD".padStart(8) +
  "NET/DD".padStart(8) + "  eraA/B/C".padEnd(20) + "unit".padStart(6) + "vịthế".padStart(7) + "stop%".padStart(7);

function printRow(r: Row, base?: Row) {
  const d = base ? ` (${r.sharpe >= base.sharpe ? "+" : ""}${((r.sharpe / base.sharpe - 1) * 100).toFixed(1)}%)` : "";
  console.log("  " + r.label.padEnd(26) + r.sharpe.toFixed(2).padStart(8) + r.netR.toFixed(0).padStart(9) +
    r.maxDD.toFixed(0).padStart(8) + r.netDd.toFixed(2).padStart(8) + "  " +
    r.era.map((x) => x.toFixed(2)).join("/").padEnd(20) + String(r.units).padStart(6) +
    String(r.positions).padStart(7) + r.stopPct.toFixed(2).padStart(7) + d);
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
  const LEN = T.atrPeriod;
  console.log(`Cửa sổ đánh giá: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · cửa sổ ước lượng ${LEN} nến 4h\n`);

  // ── TẦNG 1: chênh thang so với ATR ──
  console.log("═".repeat(112));
  console.log("  1) CHÊNH THANG — mọi ước lượng đã quy về 'khoảng giá kiểu ATR' bằng hằng số LÝ THUYẾT √(8/π)");
  console.log("═".repeat(112));
  console.log("  " + "ước lượng".padEnd(26) + "THÔ /ATR".padStart(14) + "ĐÃ KHỬ /ATR".padStart(16) + "   ← cột THÔ lệch nhiều ⇒ hằng số lý thuyết KHÔNG đủ");
  console.log("-".repeat(112));
  const meanOf = (fn: VolFn) => {
    let s = 0, n = 0;
    for (const c of data.values()) { const v = fn(c, LEN); for (let i = LEN * 3; i < c.length; i++) { s += v[i]; n++; } }
    return n ? s / n : 0;
  };
  const baseMean = meanOf(atrSeries);
  for (const [name, fn] of ESTIMATORS_RAW) {
    const raw = meanOf(fn) / baseMean;
    const fixed = meanOf(fn === atrSeries ? fn : rescaleToAtr(fn)) / baseMean;
    console.log("  " + name.padEnd(26) + raw.toFixed(4).padStart(14) + fixed.toFixed(4).padStart(16));
  }

  // ── TẦNG 2: sức dự báo ──
  console.log("\n" + "═".repeat(112));
  console.log("  2) SỨC DỰ BÁO — log(ước lượng tại t) vs log(ATR thực hiện 20 nến SAU đó). Đây là 'đo tốt hơn'.");
  console.log("═".repeat(112));
  console.log("  " + "ước lượng".padEnd(26) + "corr(đã khử".padStart(12) + "  bias(log)".padStart(12) + "  sd sai số".padStart(12) + "   mẫu");
  console.log("  " + "".padEnd(26) + "mức coin)".padStart(12));
  console.log("-".repeat(112));
  const fq: [string, ReturnType<typeof forecastQuality>][] = [];
  for (const [name, fn] of ESTIMATORS) {
    const q = forecastQuality(data, fn, LEN, 20);
    fq.push([name, q]);
    console.log("  " + name.padEnd(26) + q.corr.toFixed(4).padStart(12) + q.bias.toFixed(4).padStart(12) +
      q.sdErr.toFixed(4).padStart(12) + `   ${q.n.toLocaleString()}`);
  }
  const atrQ = fq[0][1];
  const best = fq.reduce((a, b) => (b[1].sdErr < a[1].sdErr ? b : a));
  console.log(`  → ít nhiễu nhất: ${best[0]} (sd sai số ${best[1].sdErr.toFixed(4)} vs ATR ${atrQ.sdErr.toFixed(4)} = ` +
    `${(((atrQ.sdErr - best[1].sdErr) / atrQ.sdErr) * 100).toFixed(1)}% ít hơn)`);
  console.log("  LƯU Ý: đích đo là 'ATR thực hiện 20 nến sau' nên ATR có lợi thế sân nhà. Đọc cột sd sai số\n" +
    "  như so sánh TƯƠNG ĐỐI giữa các bản không-ATR, đừng đọc như bằng chứng ATR thắng.");

  // ── TẦNG 3: lời lỗ ──
  const bk = (p: ExtParams, tag: string, fn: VolFn): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p: { ...p, volSeries: fn === atrSeries ? undefined : fn } }));
  const heat = decayH(T.heatDecayK);

  console.log("\n" + "═".repeat(112));
  console.log("  3) LỜI LỖ — thay ước lượng vào hệ, KHÔNG đổi một luật nào khác (hai sleeve chạy chung)");
  console.log("═".repeat(112));
  console.log(HDR);
  console.log("-".repeat(112));
  let base: Row | undefined;
  for (const [name, fn] of ESTIMATORS) {
    const r = scoreOf(name, [...bk(turtle, "t", fn), ...bk(fast, "f", fn)], heat, w);
    if (!base) { base = r; printRow(r); } else printRow(r, base);
  }

  // ── Từng sleeve (Fast dùng 3×ATR ở MỌI lệnh nên nhạy nhất) ──
  for (const [nm, p, tag] of [["TURTLE (stop cấu trúc ưu tiên)", turtle, "t"], ["FAST (3×ATR ở MỌI lệnh)", fast, "f"]] as [string, ExtParams, string][]) {
    console.log(`\n  ${nm}`);
    console.log(HDR);
    console.log("-".repeat(112));
    let b: Row | undefined;
    for (const [name, fn] of ESTIMATORS) {
      const r = scoreOf(name, bk(p, tag, fn), heat, w);
      if (!b) { b = r; printRow(r); } else printRow(r, b);
    }
  }

  console.log(
    "\nĐỌC KẾT QUẢ: cột stop% cho biết khoảng stop trung bình — nếu nó lệch nhiều so với bản ATR thì\n" +
    "phần chênh Sharpe KHÔNG phải do 'đo tốt hơn' mà do stop rộng/hẹp khác đi (thứ đã quét bằng\n" +
    "chandelierMult). Chỉ khi stop% gần bằng nhau MÀ Sharpe khác thì mới là hiệu ứng của phép đo.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
