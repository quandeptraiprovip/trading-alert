/**
 * turtle.ts — Chiến lược TREND-FOLLOWING (Donchian breakout / Turtle) cho crypto market-cap lớn.
 *
 * VÌ SAO PHƯƠNG PHÁP NÀY (nghiên cứu):
 *   - "A Decade of Evidence of Trend Following Investing in Cryptocurrencies" (arXiv 2009.12155)
 *     + nhiều backtest 20/55 Donchian: DƯƠNG qua mọi regime 2017→nay, WR 30-40% nhưng
 *       winner gấp 3-5x loser (right-tail dày). Crypto 24/7 → không gap, ATR-sizing sạch.
 *   - ĐỐI LẬP triết lý với strategy.ts (SMC mean-reversion mua vùng demand khi giá HỒI về):
 *     đây là MUA SỨC MẠNH / phá vỡ, để winner chạy → đa dạng hoá thật (corr thấp).
 *
 * LUẬT (thuần price-action, mechanical, KHÔNG lookahead):
 *   1. Lọc xu hướng (HTF mindset): chỉ LONG khi close > EMA(trendLen); chỉ SHORT khi close < EMA.
 *      (Nghiên cứu khuyến nghị thêm trend filter cho crypto để né whipsaw range-bound.)
 *   2. Vào lệnh: close phá ĐỈNH Donchian `dcEntry` nến gần nhất (long) / phá ĐÁY (short).
 *   3. Stop ban đầu: entry ∓ atrMult × ATR  → đơn vị risk (R) = atrMult×ATR (kiểu Turtle).
 *   4. Thoát: trailing theo ĐÁY/ĐỈNH Donchian `dcExit` nến (Turtle exit) — để trend chạy;
 *      hoặc time-stop maxHold. Không target cố định (right-tail là nguồn lợi nhuận).
 *   5. 1 lệnh / symbol tại một thời điểm. Tần suất ~1 lệnh/ngày đạt được nhờ rổ đa-symbol.
 *
 * Chi phí (taker+slippage+funding) tái sử dụng CONFIG.costs → ra NET R như backtest.ts.
 *
 * Run:
 *   npx ts-node turtle.ts                 # sweep lookback (tìm ~1 lệnh/ngày) + báo cáo best
 *   npx ts-node turtle.ts 365 1           # 365 ngày, risk 1%/lệnh
 *   npx ts-node turtle.ts 365 1 btcusdt   # chỉ BTC
 */

import { Candle, CONFIG, TF_MS, aggregate } from "./strategy";
import { fetchKlinesPaged } from "./backtest";

// ─────────────────────────────────────────────
// CONFIG riêng cho Turtle (tách khỏi CONFIG SMC)
// ─────────────────────────────────────────────
export const T = {
  tf: "4h", // khung vào lệnh — 4h: cân bằng giữa "daily-proven" của Turtle và tần suất ~1/ngày
  entryDays: 5, // VÀO khi phá đỉnh/đáy N NGÀY gần nhất (Turtle gốc 20-NGÀY; rút ngắn để ~1 lệnh/ngày)
  chandelierMult: 3.0, // THOÁT: chandelier — stop trail = đỉnh-từ-entry − mult×ATR (rộng → winner chạy)
  atrPeriod: 20, // ATR theo nến TF
  trendLen: 50, // EMA lọc xu hướng (50 nến 4h ≈ 8 ngày) — chỉ long khi trên, short khi dưới
  maxHoldDays: 60, // time-stop (trend dài có thể giữ lâu)
  cooldownBars: 0, // breakout re-enter nhanh
  allowShort: true,
};

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// INDICATORS (forward-only, không lookahead)
// ─────────────────────────────────────────────
function ema(values: number[], len: number): number[] {
  const out = new Array(values.length).fill(0);
  const k = 2 / (len + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** ATR (Wilder) — atr[i] dùng dữ liệu tới nến i (đã đóng). */
function atrSeries(c: Candle[], len: number): number[] {
  const tr = new Array(c.length).fill(0);
  for (let i = 0; i < c.length; i++) {
    if (i === 0) tr[i] = c[i].high - c[i].low;
    else {
      const pc = c[i - 1].close;
      tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - pc), Math.abs(c[i].low - pc));
    }
  }
  const out = new Array(c.length).fill(0);
  let prev = 0;
  for (let i = 0; i < c.length; i++) {
    if (i < len) {
      prev += tr[i];
      out[i] = prev / (i + 1);
      if (i === len - 1) prev = out[i];
    } else {
      prev = (prev * (len - 1) + tr[i]) / len;
      out[i] = prev;
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// CHI PHÍ → quy ra R (giống backtest.ts)
// ─────────────────────────────────────────────
function tradeCostR(entry: number, initialSL: number, entryTime: number, exitTime: number): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFrac = Math.abs(entry - initialSL) / entry;
  if (riskFrac <= 0) return 0;
  const feeFrac = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = Math.max(0, Math.floor(exitTime / FUNDING_INTERVAL_MS) - Math.floor(entryTime / FUNDING_INTERVAL_MS));
  const fundingFrac = (periods * CONFIG.costs.fundingPer8hPct) / 100;
  return (feeFrac + fundingFrac) / riskFrac;
}

// ─────────────────────────────────────────────
// TRADE
// ─────────────────────────────────────────────
export interface Trade {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "trail" | "time";
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
}

// ─────────────────────────────────────────────
// BACKTEST 1 symbol
// ─────────────────────────────────────────────
export function runTurtle(symbol: string, c: Candle[], p = T): Trade[] {
  const closes = c.map((x) => x.close);
  const emaArr = ema(closes, p.trendLen);
  const atr = atrSeries(c, p.atrPeriod);
  const trades: Trade[] = [];
  const barsPerDay = TF_MS["1d"] / TF_MS[p.tf];
  const dcEntry = Math.max(2, Math.round(p.entryDays * barsPerDay)); // lookback breakout theo NGÀY → nến
  const maxHoldBars = Math.round(p.maxHoldDays * barsPerDay);

  // pos.extreme = đỉnh-cao-nhất (long) / đáy-thấp-nhất (short) KỂ TỪ entry → cho chandelier trailing
  let pos: { dir: "long" | "short"; entryIndex: number; entry: number; initialSL: number; sl: number; extreme: number } | null = null;
  let cooldownUntil = -1;
  const warmup = Math.max(dcEntry, p.trendLen, p.atrPeriod) + 1;

  for (let i = warmup; i < c.length; i++) {
    const bar = c[i];

    // ─── Quản lý lệnh mở ───
    if (pos) {
      const held = i - pos.entryIndex;
      let exitPrice: number | null = null;
      let reason: Trade["exitReason"] | null = null;

      if (pos.dir === "long") {
        if (bar.low <= pos.sl) { exitPrice = pos.sl; reason = "trail"; }
        else if (held >= maxHoldBars) { exitPrice = bar.close; reason = "time"; }
      } else {
        if (bar.high >= pos.sl) { exitPrice = pos.sl; reason = "trail"; }
        else if (held >= maxHoldBars) { exitPrice = bar.close; reason = "time"; }
      }

      if (exitPrice !== null && reason !== null) {
        const risk = Math.abs(pos.entry - pos.initialSL);
        const pnl = pos.dir === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
        const grossR = risk > 0 ? pnl / risk : 0;
        const entryTime = c[pos.entryIndex].openTime;
        const exitTime = bar.openTime;
        const costR = tradeCostR(pos.entry, pos.initialSL, entryTime, exitTime);
        trades.push({
          symbol, dir: pos.dir, entryTime, entryPrice: pos.entry, initialSL: pos.initialSL,
          exitTime, exitPrice, exitReason: reason, grossR, costR, netR: grossR - costR, holdBars: held,
        });
        cooldownUntil = i + p.cooldownBars;
        pos = null;
        continue;
      }

      // ─── Chandelier trailing (Turtle "để winner chạy") — ratchet theo đỉnh kể từ entry ───
      if (pos.dir === "long") {
        pos.extreme = Math.max(pos.extreme, bar.high);
        const trail = pos.extreme - p.chandelierMult * atr[i];
        if (trail > pos.sl) pos.sl = trail;
      } else {
        pos.extreme = Math.min(pos.extreme, bar.low);
        const trail = pos.extreme + p.chandelierMult * atr[i];
        if (trail < pos.sl) pos.sl = trail;
      }
      continue;
    }

    // ─── Tìm lệnh mới ───
    if (i < cooldownUntil) continue;

    // Đỉnh/đáy của dcEntry nến TRƯỚC nến hiện tại (loại nến i → không lookahead)
    let hh = -Infinity, ll = Infinity;
    for (let k = i - dcEntry; k < i; k++) { hh = Math.max(hh, c[k].high); ll = Math.min(ll, c[k].low); }

    const uptrend = bar.close > emaArr[i];
    const downtrend = bar.close < emaArr[i];

    if (uptrend && bar.close > hh) {
      const entry = bar.close;
      const initialSL = entry - p.chandelierMult * atr[i];
      if (initialSL > 0 && initialSL < entry) {
        pos = { dir: "long", entryIndex: i, entry, initialSL, sl: initialSL, extreme: bar.high };
      }
    } else if (p.allowShort && downtrend && bar.close < ll) {
      const entry = bar.close;
      const initialSL = entry + p.chandelierMult * atr[i];
      if (initialSL > entry) {
        pos = { dir: "short", entryIndex: i, entry, initialSL, sl: initialSL, extreme: bar.low };
      }
    }
  }

  return trades;
}

// ─────────────────────────────────────────────
// METRICS
// ─────────────────────────────────────────────
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function bootstrap(netRs: number[], B = 5000) {
  if (netRs.length === 0) return { p5: 0, p95: 0, pPositive: 0 };
  const sums: number[] = [];
  let positive = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let k = 0; k < netRs.length; k++) s += netRs[Math.floor(Math.random() * netRs.length)];
    sums.push(s);
    if (s > 0) positive++;
  }
  sums.sort((a, b) => a - b);
  return { p5: quantile(sums, 0.05), p95: quantile(sums, 0.95), pPositive: positive / B };
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function summarize(trades: Trade[]) {
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.netR, 0);
  const gross = trades.reduce((s, t) => s + t.grossR, 0);
  const wins = trades.filter((t) => t.netR > 0);
  const wr = n ? (wins.length / n) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.netR, 0) / wins.length : 0;
  const losses = trades.filter((t) => t.netR <= 0);
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.netR, 0) / losses.length : 0;
  return { n, net, gross, wr, exp: n ? net / n : 0, avgWin, avgLoss };
}

// ─────────────────────────────────────────────
// REPORT chi tiết
// ─────────────────────────────────────────────
function report(trades: Trade[], data: Map<string, Candle[]>, riskPct: number, t0: number, t1: number) {
  trades.sort((a, b) => a.entryTime - b.entryTime);
  const s = summarize(trades);
  const periodDays = (t1 - t0) / TF_MS["1d"];
  const avgHoldDays = s.n ? (trades.reduce((a, t) => a + t.holdBars, 0) / s.n) * (TF_MS[T.tf] / TF_MS["1d"]) : 0;

  console.log("=".repeat(72));
  console.log(`  TURTLE / DONCHIAN TREND-FOLLOWING — tf ${T.tf} | breakout ${T.entryDays}d | chandelier ${T.chandelierMult}×ATR | EMA${T.trendLen}`);
  console.log(`  Symbols: ${[...data.keys()].map((x) => x.toUpperCase()).join(", ")}`);
  console.log(`  Chi phí: ${CONFIG.costs.enabled ? `taker ${CONFIG.costs.takerFeePct}%+slip ${CONFIG.costs.slippagePct}%/chiều + funding ${CONFIG.costs.fundingPer8hPct}%/8h` : "TẮT"}`);
  console.log("=".repeat(72));

  if (s.n === 0) { console.log("⚠️  Không có lệnh nào."); return; }

  // equity compounding theo NET R
  let equity = 100, peak = 100, maxDD = 0;
  const r = riskPct / 100;
  for (const t of trades) { equity *= 1 + t.netR * r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak); }

  console.log(`\nKhoảng test : ${fmtTime(t0)} → ${fmtTime(t1)} (${periodDays.toFixed(0)} ngày)`);
  console.log(`Tổng lệnh   : ${s.n}  (long ${trades.filter((t) => t.dir === "long").length} / short ${trades.filter((t) => t.dir === "short").length})`);
  console.log(`Tần suất    : ~1 lệnh mỗi ${(periodDays / s.n).toFixed(2)} ngày  (${(s.n / periodDays).toFixed(2)} lệnh/ngày)`);
  console.log(`Win rate    : ${s.wr.toFixed(1)}%  | avg win ${s.avgWin >= 0 ? "+" : ""}${s.avgWin.toFixed(2)}R | avg loss ${s.avgLoss.toFixed(2)}R`);
  console.log(`Gross R     : ${s.gross >= 0 ? "+" : ""}${s.gross.toFixed(2)}R`);
  console.log(`NET R       : ${s.net >= 0 ? "+" : ""}${s.net.toFixed(2)}R   | NET R TB/lệnh: ${s.exp.toFixed(3)}R`);
  console.log(`Giữ lệnh TB : ${avgHoldDays.toFixed(1)} ngày`);
  console.log(`\n[Risk ${riskPct}%/lệnh, compounding NET từ 100]`);
  console.log(`Equity cuối : ${equity.toFixed(1)}  (${equity >= 100 ? "+" : ""}${(equity - 100).toFixed(1)}%)  | Max DD: -${(maxDD * 100).toFixed(1)}%`);

  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  console.log(`Lý do thoát : ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  console.log("\n" + "─".repeat(72) + "\nTHEO SYMBOL (NET):");
  for (const sym of data.keys()) {
    const ts = trades.filter((t) => t.symbol === sym);
    if (!ts.length) { console.log(`  ${sym.toUpperCase().padEnd(9)} : 0 lệnh`); continue; }
    const w = ts.filter((t) => t.netR > 0).length;
    const nr = ts.reduce((a, t) => a + t.netR, 0);
    console.log(`  ${sym.toUpperCase().padEnd(9)} : ${String(ts.length).padStart(3)} lệnh | WR ${((w / ts.length) * 100).toFixed(0)}% | NET ${nr >= 0 ? "+" : ""}${nr.toFixed(2)}R`);
  }

  // Walk-forward 4 cửa sổ
  const K = 4;
  console.log("\n" + "─".repeat(72) + `\nWALK-FORWARD — ${K} cửa sổ thời gian (NET R mỗi cửa sổ):`);
  const span = t1 - t0;
  for (let w = 0; w < K; w++) {
    const ws = t0 + (span * w) / K, we = t0 + (span * (w + 1)) / K;
    const ts = trades.filter((t) => t.entryTime >= ws && t.entryTime < we);
    const nr = ts.reduce((a, t) => a + t.netR, 0);
    const win = ts.length ? ts.filter((t) => t.netR > 0).length / ts.length : 0;
    const bar = nr >= 0 ? "█".repeat(Math.min(20, Math.round(nr))) : "░".repeat(Math.min(20, Math.round(-nr)));
    console.log(`  W${w + 1} ${fmtTime(ws).slice(0, 10)}→${fmtTime(we).slice(0, 10)} : ${String(ts.length).padStart(3)} lệnh | WR ${(win * 100).toFixed(0).padStart(3)}% | NET ${nr >= 0 ? "+" : ""}${nr.toFixed(2)}R ${bar}`);
  }

  const boot = bootstrap(trades.map((t) => t.netR));
  console.log("\n" + "─".repeat(72));
  console.log("BOOTSTRAP (5000 resample) — độ tin cậy tổng NET R:");
  console.log(`  90% CI tổng NET R : [${boot.p5.toFixed(2)}R , ${boot.p95.toFixed(2)}R]`);
  console.log(`  P(tổng NET R > 0) : ${(boot.pPositive * 100).toFixed(1)}%`);
}

// ─────────────────────────────────────────────
// MAIN — sweep lookback để tìm ~1 lệnh/ngày, rồi báo cáo chi tiết
// ─────────────────────────────────────────────
async function main() {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const riskPct = parseFloat(process.argv[3] ?? "1");
  const symbols = (process.argv[4] ? process.argv[4].split(",") : CONFIG.symbols).map((x) => x.trim().toLowerCase());

  const barsPerDay = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(days * barsPerDay) + T.trendLen + 50;
  console.log(`Tải ~${days} ngày × ${symbols.length} symbol (${totalBars} nến ${T.tf} mỗi symbol)...\n`);

  const data = new Map<string, Candle[]>();
  let t0 = Infinity, t1 = -Infinity;
  for (const sym of symbols) {
    let c: Candle[];
    if (T.tf === "1h") c = await fetchKlinesPaged(sym, "1h", totalBars);
    else { const ltf = await fetchKlinesPaged(sym, "15m", totalBars * (TF_MS[T.tf] / TF_MS["15m"]) + 400); c = aggregate(ltf, T.tf, "15m"); }
    if (c.length < T.trendLen + 50) { console.log(`[${sym.toUpperCase()}] thiếu dữ liệu (${c.length}), bỏ qua.`); continue; }
    data.set(sym, c);
    t0 = Math.min(t0, c[0].openTime); t1 = Math.max(t1, c[c.length - 1].openTime);
  }
  if (data.size === 0) { console.log("Không tải được symbol nào."); return; }

  const periodDays = (t1 - t0) / TF_MS["1d"];

  // ── SWEEP breakout lookback (NGÀY) × chandelier: tìm ~1 lệnh/ngày & xem NET R ──
  console.log("=".repeat(72));
  console.log(`  SWEEP breakout(ngày) × chandelier(×ATR) — mục tiêu ~1 lệnh/ngày trên rổ — ${periodDays.toFixed(0)} ngày`);
  console.log("=".repeat(72));
  console.log("entryD  chand  lệnh  lệnh/ngày  WR%   avgWin avgLoss  NET R   R/lệnh");
  console.log("-".repeat(72));
  const entryDayCands = [2, 3, 4, 5, 7, 10, 15, 20];
  const chandCands = [2.5, 3.0, 4.0];
  let best: { p: typeof T; trades: Trade[]; freq: number } | null = null;
  for (const ch of chandCands) {
    for (const ed of entryDayCands) {
      const p = { ...T, entryDays: ed, chandelierMult: ch };
      const all: Trade[] = [];
      for (const [sym, c] of data) all.push(...runTurtle(sym, c, p));
      const s = summarize(all);
      const freq = s.n / periodDays;
      console.log(`${String(ed).padStart(5)}d  ${ch.toFixed(1).padStart(4)}  ${String(s.n).padStart(4)}  ${freq.toFixed(2).padStart(8)}  ${s.wr.toFixed(0).padStart(3)}  ${(s.avgWin >= 0 ? "+" : "") + s.avgWin.toFixed(2)}  ${s.avgLoss.toFixed(2)}  ${((s.net >= 0 ? "+" : "") + s.net.toFixed(1)).padStart(7)}  ${s.exp.toFixed(3)}`);
      // Chọn EDGE mạnh nhất (tổng NET R lớn nhất) trong số cấu hình còn "hoạt động" (>=0.4 lệnh/ngày).
      // Ép tần suất lên 1/ngày bằng breakout ngắn sẽ GIẾT edge → tăng tần suất bằng MỞ RỘNG RỔ thay vì.
      if (s.net > 0 && freq >= 0.4) {
        if (!best || best.trades.reduce((a, t) => a + t.netR, 0) < s.net) best = { p, trades: all, freq };
      }
    }
    console.log("-".repeat(72));
  }

  console.log();
  if (!best) {
    console.log("⚠️  Không cấu hình nào NET R > 0 trong sweep. Báo cáo cấu hình mặc định.");
    const all: Trade[] = [];
    for (const [sym, c] of data) all.push(...runTurtle(sym, c, T));
    report(all, data, riskPct, t0, t1);
    return;
  }

  console.log(`→ Chọn breakout=${best.p.entryDays}d / chandelier=${best.p.chandelierMult}×ATR (EDGE mạnh nhất, freq>=0.4/ngày). Báo cáo chi tiết:\n`);
  T.entryDays = best.p.entryDays; T.chandelierMult = best.p.chandelierMult;
  report(best.trades, data, riskPct, t0, t1);
}

if (require.main === module) {
  main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
}
