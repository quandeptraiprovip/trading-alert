/**
 * exp-corr-heat.ts — THAY THƯỚC ĐO "HEAT" BẰNG THƯỚC CÓ TƯƠNG QUAN.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VẤN ĐỀ (đọc thẳng từ code live, turtle-live.ts:167-190)
 *
 *   w = 1 / (1 + heat / k),   heat = TỔNG TỈ TRỌNG các unit đang mở CÙNG HƯỚNG
 *
 * Comment ngay trên hàm đó viết: "rổ 8 large-cap crypto có tương quan ~0,85 — 24 unit cùng hướng
 * KHÔNG phải 24 cược độc lập". Đúng. Nhưng công thức thì KHÔNG hề chứa tương quan: nó đếm số unit.
 * Tức là hệ đang dùng một HẰNG SỐ NGẦM ĐỊNH ρ = 1 cho mọi cặp, mọi thời điểm, và bù lại bằng cách
 * chỉnh tay k. Hai hệ quả đo được:
 *
 *   (a) Tương quan crypto KHÔNG cố định. Nó dao động theo regime (0,5 lúc phân hoá → 0,95 lúc
 *       risk-off). Với ρ = 1 cứng, hệ siết size y hệt nhau ở cả hai chế độ.
 *   (b) Vị thế NGƯỢC HƯỚNG bị bỏ qua hoàn toàn (heat chỉ đếm cùng hướng). Short BTC + long ETH với
 *       ρ = 0,85 gần như phẳng, nhưng hệ chấm nó là "hai unit đầy risk".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NỀN TÀI LIỆU
 *   - Baltas & Kosowski (2013), "Demystifying Time-Series Momentum Strategies": hệ số đòn bẩy
 *     CF = 1/√(1 + (N−1)·ρ̄) với ρ̄ = tương quan cặp TRUNG BÌNH CÓ DẤU (signed) của rổ. Bản
 *     correlation-adjusted đánh bại bản naive, và chênh lệch RÕ NHẤT ở giai đoạn hậu-2008 khi
 *     tương quan tăng.
 *   - Baltas (2015), "Trend-Following, Risk-Parity and the influence of Correlations": chuyển từ
 *     volatility-parity (bỏ qua tương quan) sang risk-parity (dùng tương quan) đưa Sharpe
 *     1,31 → 1,48 toàn kỳ và 0,31 → 0,78 giai đoạn hậu khủng hoảng; cải thiện đến CHỦ YẾU từ các
 *     chế độ tương quan cực trị.
 *   - Levine & Pedersen (2016), "Which Trend Is Your Friend?": mọi bộ lọc trend tuyến tính (MA
 *     crossover, breakout, TSMOM, HP, Kalman) là BIỂU DIỄN TƯƠNG ĐƯƠNG của cùng một tín hiệu.
 *     ⇒ Thêm một chỉ báo trend nữa (ADX/ER/RSI) về lý thuyết KHÔNG thêm thông tin — trùng khớp
 *     với kết quả thực nghiệm repo đã có (planning/trend-method-remediation-research-2026-08.md).
 *     Chỗ còn thông tin chưa khai thác là tầng RỦI RO, không phải tầng TÍN HIỆU. Đó là file này.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HAI DẠNG ĐƯỢC ĐO (cả hai đều CHỨA luật hiện tại làm trường hợp riêng khi ρ ≡ 1)
 *
 *   proj : H = Σ_i w_i · d_i·d_c · ρ(s_i, s_c)          ← đóng góp biên vào risk danh mục
 *   tot  : H = √( Σ_i Σ_j w_i w_j d_i d_j ρ(s_i,s_j) )  ← tổng risk danh mục (dạng Baltas)
 *
 *   d = ±1 theo hướng, s = symbol, c = unit đang xin vào. ρ(s,s) = 1 (unit cùng symbol tương quan 1).
 *   ρ ≡ 1 và mọi unit cùng hướng ⇒ cả hai về ĐÚNG Σw = heat hiện tại.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ĐỐI CHỨNG BẮT BUỘC (không có thì kết quả vô nghĩa — xem memory null-result-toolkit)
 *
 *   const : dùng ρ̄ HẰNG SỐ (trung bình toàn mẫu) thay ma trận động. Nếu bản này thắng NGANG bản
 *           động thì lợi ích chỉ là MỘT PHÉP ĐỔI THANG của k, không phải "đo được tương quan".
 *           Đây là đối chứng quan trọng nhất của cả file.
 *   shuf  : ma trận tương quan THẬT nhưng gán vào một HOÁN VỊ ngẫu nhiên của nhãn symbol. Giữ
 *           nguyên phân phối giá trị ρ, phá nát việc "cặp nào tương quan với cặp nào". Nhóm giả.
 *   k-sweep: bản mới phải thắng ở CẢ MỘT VÙNG k, không phải một điểm.
 *   L-sweep: cửa sổ ước lượng tương quan 45/90/180 ngày phải cùng dấu.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-corr-heat.ts [days=2000]
 */

import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

const DAY = TF_MS["1d"];

// ─────────────────────────────────────────────────────────────────────────────
// MA TRẬN TƯƠNG QUAN LĂN, KHÔNG LOOKAHEAD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return NGÀY cho từng symbol trên một lưới ngày CHUNG.
 * Dùng nến 4h đã đóng: close của nến 4h cuối cùng trong ngày UTC đó.
 */
function dailyCloses(data: Map<string, Candle[]>): { days: number[]; ret: Map<string, (number | null)[]> } {
  const perSym = new Map<string, Map<number, number>>();
  const dayset = new Set<number>();
  for (const [s, c] of data) {
    const m = new Map<number, number>();
    for (const bar of c) {
      const d = Math.floor(bar.openTime / DAY);
      m.set(d, bar.close); // nến sau ghi đè nến trước ⇒ giữ close cuối ngày
      dayset.add(d);
    }
    perSym.set(s, m);
  }
  const days = [...dayset].sort((a, b) => a - b);
  const ret = new Map<string, (number | null)[]>();
  for (const [s, m] of perSym) {
    const r: (number | null)[] = new Array(days.length).fill(null);
    for (let i = 1; i < days.length; i++) {
      const c1 = m.get(days[i]);
      const c0 = m.get(days[i - 1]);
      r[i] = c1 !== undefined && c0 !== undefined && c0 > 0 ? Math.log(c1 / c0) : null;
    }
    ret.set(s, r);
  }
  return { days, ret };
}

export type CorrFn = ((time: number, a: string, b: string) => number) & { stats?: () => { calls: number; fallbacks: number } };

/**
 * BIÊN PHÁT HIỆN: đếm số lần tra ρ phải rơi về fallback. Nếu tỉ lệ này cao thì "kết quả không đổi"
 * chỉ có nghĩa là ρ chưa bao giờ được dùng — không có nghĩa là tương quan vô ích. Vòng đo đầu tiên
 * của chính file này rơi vào đúng bẫy đó (100% fallback do tra bằng khoá sổ thay vì symbol).
 */
function assertCorrUsed(name: string, fn: CorrFn) {
  const s = fn.stats?.();
  if (!s || s.calls === 0) return;
  const pct = (s.fallbacks / s.calls) * 100;
  const line = `  [biên phát hiện] ${name}: ${s.calls.toLocaleString()} lần tra ρ, ${pct.toFixed(1)}% rơi về fallback`;
  if (pct > 5) console.log(`${line}  ⚠️  QUÁ CAO — kết quả KHÔNG diễn giải được`);
  else console.log(line);
}

/**
 * ρ(a,b) tại thời điểm `time`, ước lượng trên `lookback` ngày ĐÃ ĐÓNG trước ngày chứa `time`.
 * Thiếu dữ liệu → trả `fallback` (mặc định 1 = hành vi hiện tại, phía an toàn/siết size).
 */
export function buildRollingCorr(
  data: Map<string, Candle[]>,
  lookback: number,
  fallback = 1,
): CorrFn {
  const syms = [...data.keys()].sort();
  const idxOfSym = new Map(syms.map((s, i) => [s, i]));
  const { days, ret } = dailyCloses(data);
  const R = syms.map((s) => ret.get(s)!);
  const n = syms.length;

  // corrByDay[d] = ma trận n×n phẳng, dùng cho MỌI thời điểm trong ngày days[d]
  // (ước lượng từ các ngày [d-lookback, d-1] — không chứa ngày d).
  // Trước khi đủ `lookback` ngày thì dùng CỬA SỔ MỞ RỘNG (tối thiểu 20 ngày) thay vì trả fallback:
  // fallback = 1 ở đầu mẫu sẽ làm một phần cửa sổ đánh giá chạy bằng luật CŨ mà bảng số không hề
  // nói ra — đúng kiểu lỗi làm vòng đo đầu tiên của file này thành null giả.
  const MIN_DAYS = 20;
  const corrByDay: (Float64Array | null)[] = new Array(days.length).fill(null);
  for (let d = MIN_DAYS; d < days.length; d++) {
    const lb = Math.min(lookback, d);
    const M = new Float64Array(n * n);
    // trung bình & độ lệch chuẩn từng chuỗi trên cửa sổ
    const mean = new Float64Array(n);
    const sd = new Float64Array(n);
    const cnt = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = d - lb; k < d; k++) { const v = R[i][k]; if (v !== null) { s += v; c++; } }
      mean[i] = c > 0 ? s / c : 0;
      cnt[i] = c;
      let q = 0;
      for (let k = d - lb; k < d; k++) { const v = R[i][k]; if (v !== null) q += (v - mean[i]) ** 2; }
      sd[i] = c > 1 ? Math.sqrt(q / (c - 1)) : 0;
    }
    for (let i = 0; i < n; i++) {
      M[i * n + i] = 1;
      for (let j = i + 1; j < n; j++) {
        let cov = 0, c = 0;
        for (let k = d - lb; k < d; k++) {
          const a = R[i][k], b = R[j][k];
          if (a !== null && b !== null) { cov += (a - mean[i]) * (b - mean[j]); c++; }
        }
        const r = c > 1 && sd[i] > 0 && sd[j] > 0 ? cov / (c - 1) / (sd[i] * sd[j]) : fallback;
        M[i * n + j] = r;
        M[j * n + i] = r;
      }
    }
    corrByDay[d] = M;
  }

  const day0 = days[0];
  let calls = 0, fallbacks = 0;
  const fn: CorrFn = (time, a, b) => {
    if (a === b) return 1;
    calls++;
    const ia = idxOfSym.get(a), ib = idxOfSym.get(b);
    if (ia === undefined || ib === undefined) { fallbacks++; return fallback; }
    const d = Math.floor(time / DAY) - day0;
    const M = d >= 0 && d < corrByDay.length ? corrByDay[d] : null;
    if (!M) { fallbacks++; return fallback; }
    return M[ia * n + ib];
  };
  fn.stats = () => ({ calls, fallbacks });
  return fn;
}

/** ρ HẰNG SỐ = trung bình mọi cặp trên toàn mẫu — đối chứng "chỉ là đổi thang k". */
export function constantCorr(data: Map<string, Candle[]>, lookback: number): { fn: CorrFn; rho: number } {
  const roll = buildRollingCorr(data, lookback);
  const syms = [...data.keys()].sort();
  const { days } = dailyCloses(data);
  let sum = 0, cnt = 0;
  for (let d = Math.min(lookback, 20); d < days.length; d += 7) {
    const t = days[d] * DAY;
    for (let i = 0; i < syms.length; i++)
      for (let j = i + 1; j < syms.length; j++) { sum += roll(t, syms[i], syms[j]); cnt++; }
  }
  const rho = cnt ? sum / cnt : 1;
  return { fn: (_t, a, b) => (a === b ? 1 : rho), rho };
}

/** Nhóm GIẢ: ρ thật nhưng gán cho một hoán vị ngẫu nhiên CỐ ĐỊNH của nhãn symbol. */
export function shuffledCorr(data: Map<string, Candle[]>, lookback: number, seed = 7): CorrFn {
  const roll = buildRollingCorr(data, lookback);
  const syms = [...data.keys()].sort();
  let s = seed;
  const rand = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const perm = [...syms];
  for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const map = new Map(syms.map((x, i) => [x, perm[i]]));
  return (t, a, b) => (a === b ? 1 : roll(t, map.get(a) ?? a, map.get(b) ?? b));
}

// ─────────────────────────────────────────────────────────────────────────────
// CHÍNH SÁCH ADMIT
// ─────────────────────────────────────────────────────────────────────────────

/** Luật ĐANG CHẠY: heat = tổng tỉ trọng unit cùng hướng. */
export const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

export type Shape = "proj" | "tot";

/**
 * `AdmitCtx.symbol` là KHOÁ SỔ, không phải symbol: khi chạy hai sleeve nó là "btcusdt@t".
 * `OpenUnit.symbol` thì là symbol thô. Tra tương quan bằng khoá sổ sẽ trượt về fallback ở MỌI lần
 * gọi — đúng cái bẫy đã làm vòng đo đầu tiên ra kết quả null giả (ρ đo được = 1,000 ở cả 61.830 cặp).
 */
const rawSym = (bookKeyOrSymbol: string): string => {
  const i = bookKeyOrSymbol.indexOf("@");
  return i < 0 ? bookKeyOrSymbol : bookKeyOrSymbol.slice(0, i);
};
// Từ 2026-08-14 engine có sẵn `AdmitCtx.rawSymbol`; `rawSym` giữ lại cho `OpenUnit` và tương thích.

/**
 * Heat có tương quan. `clamp0` = true giữ H ≥ 0 nên w ≤ 1 (không bao giờ NÂNG size khi sổ đang
 * hedge) — giữ đúng trần của luật hiện tại để so sánh không lẫn với "được phép đánh to hơn".
 */
export function corrHeat(k: number, corr: CorrFn, shape: Shape, clamp0 = true): AdmitFn {
  return (c: AdmitCtx) => {
    if (!(k > 0)) return 1;
    const dc = c.dir === "long" ? 1 : -1;
    const sc = rawSym(c.symbol);
    let H: number;
    if (shape === "proj") {
      H = 0;
      for (const u of c.open) {
        const du = u.dir === "long" ? 1 : -1;
        H += u.weight * du * dc * corr(c.time, rawSym(u.symbol), sc);
      }
    } else {
      let q = 0;
      for (let i = 0; i < c.open.length; i++) {
        const ui = c.open[i];
        const di = ui.dir === "long" ? 1 : -1;
        q += ui.weight * ui.weight; // ρ(i,i) = 1
        for (let j = i + 1; j < c.open.length; j++) {
          const uj = c.open[j];
          const dj = uj.dir === "long" ? 1 : -1;
          q += 2 * ui.weight * uj.weight * di * dj * corr(c.time, rawSym(ui.symbol), rawSym(uj.symbol));
        }
      }
      H = Math.sqrt(Math.max(0, q));
    }
    if (clamp0) H = Math.max(0, H);
    return 1 / (1 + H / k);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHẤM ĐIỂM
// ─────────────────────────────────────────────────────────────────────────────

type Win = ReturnType<typeof coreWindow>;

interface Row {
  label: string;
  sharpe: number;
  netR: number;
  maxDD: number;
  netDd: number;
  era: number[];
  eraNet: number[];
  units: number;
  avgW: number;
}

function scoreOf(label: string, bs: Book[], admit: AdmitFn, w: Win): Row {
  const res = runBooks(bs, admit);
  const m = riskMetrics(res.equity.filter((e) => e.time >= w.from && e.time <= w.to));
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  const tr = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  return {
    label,
    sharpe: m.sharpe,
    netR: m.netR,
    maxDD: m.maxDD,
    netDd: m.netOverMaxDD,
    era: eras.map((e) => e.sharpe),
    eraNet: eras.map((e) => e.netR),
    units: tr.length,
    avgW: tr.length ? tr.reduce((s, t) => s + t.weight, 0) / tr.length : 0,
  };
}

const HDR =
  "  " + "biến thể".padEnd(30) + "Sharpe".padStart(8) + "NET R".padStart(9) + "maxDD".padStart(8) +
  "NET/DD".padStart(8) + "  eraA/B/C Sharpe".padEnd(24) + "unit".padStart(6) + "wTB".padStart(7);

function printRow(r: Row, base?: Row) {
  const d = base ? ` (${r.sharpe >= base.sharpe ? "+" : ""}${((r.sharpe / base.sharpe - 1) * 100).toFixed(0)}%)` : "";
  console.log(
    "  " + r.label.padEnd(30) +
    r.sharpe.toFixed(2).padStart(8) + r.netR.toFixed(0).padStart(9) + r.maxDD.toFixed(0).padStart(8) +
    r.netDd.toFixed(2).padStart(8) + "  " +
    r.era.map((x) => x.toFixed(2)).join("/").padEnd(24) +
    String(r.units).padStart(6) + r.avgW.toFixed(3).padStart(7) + d,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  if (data.size < CORE8.length) console.log(`⚠️  chỉ nạp được ${data.size}/${CORE8.length} symbol`);

  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  console.log(`Cửa sổ đánh giá: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}\n`);

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const both = [...bk(turtle, "t"), ...bk(fast, "f")];

  // ── Tương quan thực tế đang ở mức nào? ──
  const L0 = 90;
  const roll = buildRollingCorr(data, L0);
  const { rho: rhoBar } = constantCorr(data, L0);
  const syms = [...data.keys()].sort();
  const { days: dayGrid } = dailyCloses(data);
  const samples: number[] = [];
  for (let d = L0; d < dayGrid.length; d += 5) {
    const t = dayGrid[d] * DAY;
    if (t < w.from || t > w.to) continue;
    let s = 0, c = 0;
    for (let i = 0; i < syms.length; i++)
      for (let j = i + 1; j < syms.length; j++) { s += roll(t, syms[i], syms[j]); c++; }
    if (c) samples.push(s / c);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.round((samples.length - 1) * p)))];
  console.log("═".repeat(110));
  console.log(`  TƯƠNG QUAN CẶP TRUNG BÌNH CỦA RỔ (cửa sổ ${L0} ngày, ${samples.length} mẫu trong khung đánh giá)`);
  console.log("═".repeat(110));
  console.log(`  trung bình ${rhoBar.toFixed(3)} · p5 ${q(0.05).toFixed(3)} · p25 ${q(0.25).toFixed(3)} · trung vị ${q(0.5).toFixed(3)} · p75 ${q(0.75).toFixed(3)} · p95 ${q(0.95).toFixed(3)}`);
  console.log(`  → Luật hiện tại giả định ρ = 1,000 ở MỌI thời điểm. Khoảng dao động thật là ${q(0.05).toFixed(2)}–${q(0.95).toFixed(2)}.\n`);

  // ── Bảng 1: dạng hàm, ở đúng k đang chạy ──
  console.log("═".repeat(110));
  console.log(`  1) HAI SLEEVE CHẠY CHUNG — thay thước đo heat, giữ k = ${T.heatDecayK} y nguyên`);
  console.log("═".repeat(110));
  console.log(HDR);
  console.log("-".repeat(110));
  const base = scoreOf(`BASE live (heat=Σw, k=${T.heatDecayK})`, both, decayH(T.heatDecayK), w);
  printRow(base);
  for (const shape of ["proj", "tot"] as Shape[]) {
    printRow(scoreOf(`corr-${shape} L=${L0}`, both, corrHeat(T.heatDecayK, roll, shape), w), base);
  }
  console.log("  ── đối chứng ──");
  const cc = constantCorr(data, L0);
  for (const shape of ["proj", "tot"] as Shape[]) {
    printRow(scoreOf(`const ρ=${cc.rho.toFixed(2)} ${shape}`, both, corrHeat(T.heatDecayK, cc.fn, shape), w), base);
  }
  const shuf = shuffledCorr(data, L0);
  for (const shape of ["proj", "tot"] as Shape[]) {
    printRow(scoreOf(`GIẢ hoán vị nhãn ${shape}`, both, corrHeat(T.heatDecayK, shuf, shape), w), base);
  }
  assertCorrUsed("ρ động L=90", roll);

  // ── Bảng 2: quét k (bản mới phải thắng cả VÙNG, không phải một điểm) ──
  console.log("\n" + "═".repeat(110));
  console.log("  2) QUÉT k — thắng một điểm là fit, thắng cả vùng mới là cơ chế");
  console.log("═".repeat(110));
  console.log(HDR);
  console.log("-".repeat(110));
  for (const k of [0.5, 1, 2, 4, 8]) {
    printRow(scoreOf(`BASE k=${k}`, both, decayH(k), w));
    for (const shape of ["proj", "tot"] as Shape[]) {
      printRow(scoreOf(`  corr-${shape} k=${k}`, both, corrHeat(k, roll, shape), w));
    }
    console.log("  " + "-".repeat(106));
  }

  // ── Bảng 3: quét cửa sổ ước lượng tương quan ──
  console.log("\n" + "═".repeat(110));
  console.log(`  3) QUÉT CỬA SỔ ƯỚC LƯỢNG ρ (k = ${T.heatDecayK}) — kết quả phải cùng dấu ở mọi L`);
  console.log("═".repeat(110));
  console.log(HDR);
  console.log("-".repeat(110));
  printRow(base);
  for (const L of [30, 45, 60, 90, 120, 180, 250]) {
    const c = buildRollingCorr(data, L);
    for (const shape of ["proj", "tot"] as Shape[]) {
      printRow(scoreOf(`corr-${shape} L=${L}`, both, corrHeat(T.heatDecayK, c, shape), w), base);
    }
  }

  // ── Bảng 4: từng sleeve riêng ──
  console.log("\n" + "═".repeat(110));
  console.log("  4) TỪNG SLEEVE RIÊNG (Turtle đang có tiền thật; Fast chưa có chính sách heat nào ở live)");
  console.log("═".repeat(110));
  for (const [name, bs] of [["TURTLE", bk(turtle, "t")], ["FAST", bk(fast, "f")]] as [string, Book[]][]) {
    console.log(`\n  ${name}`);
    console.log(HDR);
    console.log("-".repeat(110));
    const b = scoreOf(`BASE k=${T.heatDecayK}`, bs, decayH(T.heatDecayK), w);
    printRow(b);
    for (const shape of ["proj", "tot"] as Shape[]) {
      printRow(scoreOf(`corr-${shape} L=${L0}`, bs, corrHeat(T.heatDecayK, roll, shape), w), b);
    }
  }

  console.log(
    "\nĐỌC KẾT QUẢ: Sharpe và NET/DD là thước chính (bất biến đòn bẩy). NET R thô TĂNG là chuyện\n" +
    "hiển nhiên khi ρ<1 làm heat nhỏ đi ⇒ size to hơn — nó KHÔNG phải bằng chứng gì cả. Chỉ khi\n" +
    "Sharpe/NET-DD tăng thì mới là đo tốt hơn. Và nếu bản 'const ρ' bám sát bản động thì toàn bộ\n" +
    "lợi ích chỉ là đổi thang k — lúc đó cách đúng là chỉnh k, không phải thêm ma trận tương quan.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
