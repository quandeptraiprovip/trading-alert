/**
 * portfolio-basket.ts — Breadth THẬT (P&L) + backtest rổ như một PORTFOLIO.
 *
 * (A1) Đo độc lập thật của các bet (không phải corr giá):
 *      - Thời gian "ở trong thị trường" mỗi symbol + % TRÙNG holding-period từng cặp.
 *      - Phân bố CONCURRENCY: bao nhiêu vị thế mở đồng thời theo thời gian.
 *      - Corr P&L theo tuần (caveat: thưa).
 * (A2) Gộp lệnh các symbol thành 1 portfolio (cho phép nhiều vị thế đồng thời):
 *      - Chuỗi R theo NGÀY -> Sharpe (annualized) + maxDD(R), so với BTC-only.
 *      - Equity compounding (risk%/lệnh) theo thứ tự ĐÓNG lệnh + maxDD%.
 *      - Walk-forward 4 cửa sổ + rủi ro đồng thời lớn nhất.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/portfolio-basket.ts [soNgay] [risk%] [sym1,sym2,...]
 */
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

const DAYS = parseInt(process.argv[2] ?? "250", 10);
const RISK = parseFloat(process.argv[3] ?? "1");
const SYMBOLS = (process.argv[4] ? process.argv[4].split(",") : ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"]).map(
  (s) => s.trim().toLowerCase(),
);
const DAY_MS = TF_MS["1d"];

function tradeSpanMs(t: Trade): number {
  return Math.max(0, t.exitTime - t.entryTime);
}

/** Tổng ms TRÙNG holding-period giữa 2 tập lệnh (O(nA·nB), n nhỏ). */
function overlapMs(a: Trade[], b: Trade[]): number {
  let ov = 0;
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.entryTime, y.entryTime);
      const hi = Math.min(x.exitTime, y.exitTime);
      if (hi > lo) ov += hi - lo;
    }
  }
  return ov;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
}
function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
}

/** Chuỗi R theo NGÀY: gán netR vào ngày ĐÓNG lệnh; bao gồm ngày 0. */
function dailyRSeries(trades: Trade[], startDay: number, endDay: number): number[] {
  const nDays = Math.max(1, Math.round((endDay - startDay) / DAY_MS) + 1);
  const arr = new Array(nDays).fill(0);
  for (const t of trades) {
    const d = Math.round((Math.floor(t.exitTime / DAY_MS) * DAY_MS - startDay) / DAY_MS);
    if (d >= 0 && d < nDays) arr[d] += t.netR;
  }
  return arr;
}

/** maxDD trên đường tích luỹ R (đơn vị R). */
function maxDrawdownR(daily: number[]): number {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const r of daily) {
    cum += r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

function sharpeAnnualized(daily: number[]): number {
  const s = std(daily);
  return s > 0 ? (mean(daily) / s) * Math.sqrt(365) : 0;
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;

  console.log("=".repeat(74));
  console.log(`  PORTFOLIO RỔ — ${SYMBOLS.map((s) => s.replace("usdt", "").toUpperCase()).join("+")} — ${DAYS} ngày`);
  console.log("=".repeat(74));

  const tradesBySym = new Map<string, Trade[]>();
  let gStart = Infinity;
  let gEnd = -Infinity;

  for (const sym of SYMBOLS) {
    console.log(`Tải ${sym.toUpperCase()}…`);
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) {
      console.log(`  ⚠️  Không đủ nến (${ltf.length}), bỏ qua.`);
      continue;
    }
    const trades = runBacktest(sym, ltf);
    tradesBySym.set(sym, trades);
    gStart = Math.min(gStart, ltf[0].openTime);
    gEnd = Math.max(gEnd, ltf[ltf.length - 1].openTime);
  }

  const syms = [...tradesBySym.keys()];
  const all: Trade[] = syms.flatMap((s) => tradesBySym.get(s)!);
  all.sort((a, b) => a.exitTime - b.exitTime);

  // ─────────────────────────────── A1 ───────────────────────────────
  console.log("\n" + "═".repeat(74));
  console.log("(A1) BREADTH THẬT — trùng holding-period & corr P&L");
  console.log("─".repeat(74));

  const inMarket = new Map<string, number>();
  for (const s of syms) inMarket.set(s, tradesBySym.get(s)!.reduce((acc, t) => acc + tradeSpanMs(t), 0));

  console.log("Thời gian Ở TRONG thị trường (so với toàn kỳ):");
  const spanMs = gEnd - gStart;
  for (const s of syms) {
    const im = inMarket.get(s)!;
    console.log(`  ${s.toUpperCase().padEnd(8)} : ${(im / DAY_MS).toFixed(1).padStart(6)}d  (${((im / spanMs) * 100).toFixed(1)}% thời gian)`);
  }

  console.log("\n% TRÙNG holding-period từng cặp  [overlap / min(in-market)]:");
  let header = "        " + syms.map((s) => s.replace("usdt", "").toUpperCase().padStart(6)).join("");
  console.log(header);
  for (let i = 0; i < syms.length; i++) {
    let row = syms[i].replace("usdt", "").toUpperCase().padEnd(8);
    for (let j = 0; j < syms.length; j++) {
      if (i === j) {
        row += "     —";
        continue;
      }
      const ov = overlapMs(tradesBySym.get(syms[i])!, tradesBySym.get(syms[j])!);
      const denom = Math.min(inMarket.get(syms[i])!, inMarket.get(syms[j])!);
      row += `${denom > 0 ? ((ov / denom) * 100).toFixed(0) + "%" : "—"}`.padStart(6);
    }
    console.log(row);
  }

  // Concurrency: lấy mẫu theo ngày
  const nDays = Math.round(spanMs / DAY_MS) + 1;
  const conc = new Array(syms.length + 1).fill(0);
  let maxConc = 0;
  for (let d = 0; d < nDays; d++) {
    const t = gStart + d * DAY_MS;
    let c = 0;
    for (const s of syms) {
      if (tradesBySym.get(s)!.some((tr) => tr.entryTime <= t && t <= tr.exitTime)) c++;
    }
    conc[c]++;
    maxConc = Math.max(maxConc, c);
  }
  console.log("\nCONCURRENCY (số vị thế mở đồng thời, lấy mẫu theo ngày):");
  for (let c = 0; c <= syms.length; c++) {
    if (conc[c] === 0) continue;
    console.log(`  ${c} vị thế : ${conc[c]} ngày (${((conc[c] / nDays) * 100).toFixed(0)}%)`);
  }
  console.log(`  → tối đa ${maxConc} vị thế đồng thời`);

  // Corr P&L theo tuần
  const WEEK = 7 * DAY_MS;
  const nWeeks = Math.max(1, Math.round(spanMs / WEEK) + 1);
  const weekly = new Map<string, number[]>();
  for (const s of syms) {
    const w = new Array(nWeeks).fill(0);
    for (const t of tradesBySym.get(s)!) {
      const wi = Math.floor((t.exitTime - gStart) / WEEK);
      if (wi >= 0 && wi < nWeeks) w[wi] += t.netR;
    }
    weekly.set(s, w);
  }
  console.log("\nCORR P&L theo TUẦN (thưa → chỉ tham khảo):");
  console.log(header);
  for (let i = 0; i < syms.length; i++) {
    let row = syms[i].replace("usdt", "").toUpperCase().padEnd(8);
    for (let j = 0; j < syms.length; j++) {
      if (i === j) {
        row += "  1.00";
        continue;
      }
      const r = pearson(weekly.get(syms[i])!, weekly.get(syms[j])!);
      row += (Number.isFinite(r) ? r.toFixed(2) : "—").padStart(6);
    }
    console.log(row);
  }

  // ─────────────────────────────── A2 ───────────────────────────────
  console.log("\n" + "═".repeat(74));
  console.log("(A2) PORTFOLIO vs BTC-ONLY");
  console.log("─".repeat(74));

  const startDay = Math.floor(gStart / DAY_MS) * DAY_MS;
  const endDay = Math.floor(gEnd / DAY_MS) * DAY_MS;
  const btcTrades = tradesBySym.get("btcusdt") ?? [];

  const dailyPort = dailyRSeries(all, startDay, endDay);
  const dailyBtc = dailyRSeries(btcTrades, startDay, endDay);

  const fmt = (label: string, trades: Trade[], daily: number[]) => {
    const net = trades.reduce((s, t) => s + t.netR, 0);
    const wr = trades.length ? (trades.filter((t) => t.netR > 0).length / trades.length) * 100 : 0;
    const perTrade = trades.map((t) => t.netR);
    const ddR = maxDrawdownR(daily);
    const sh = sharpeAnnualized(daily);
    // equity compounding theo thứ tự đóng lệnh
    let eq = 100;
    let peak = 100;
    let ddPct = 0;
    const r = RISK / 100;
    for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
      eq *= 1 + t.netR * r;
      peak = Math.max(peak, eq);
      ddPct = Math.max(ddPct, (peak - eq) / peak);
    }
    console.log(`\n${label}`);
    console.log(`  Lệnh        : ${trades.length}`);
    console.log(`  NET R       : ${net >= 0 ? "+" : ""}${net.toFixed(2)}R  | TB/lệnh ${(net / Math.max(1, trades.length)).toFixed(3)}R`);
    console.log(`  WR          : ${wr.toFixed(0)}%`);
    console.log(`  Expectancy  : mean ${mean(perTrade).toFixed(3)}R / std ${std(perTrade).toFixed(3)}R (per-trade SQ ${(mean(perTrade) / (std(perTrade) || 1)).toFixed(2)})`);
    console.log(`  Sharpe (ngày, ann.) : ${sh.toFixed(2)}`);
    console.log(`  maxDD (R)   : -${ddR.toFixed(2)}R`);
    console.log(`  Equity ${RISK}%/lệnh : ${eq.toFixed(1)} (${eq >= 100 ? "+" : ""}${(eq - 100).toFixed(1)}%) | maxDD -${(ddPct * 100).toFixed(1)}%`);
  };

  fmt("BTC-ONLY", btcTrades, dailyBtc);
  fmt(`PORTFOLIO (${syms.map((s) => s.replace("usdt", "").toUpperCase()).join("+")})`, all, dailyPort);

  // Walk-forward 4 cửa sổ (portfolio, theo entryTime)
  console.log("\n" + "─".repeat(74));
  console.log("WALK-FORWARD PORTFOLIO (4 cửa sổ, NET R):");
  const K = 4;
  for (let w = 0; w < K; w++) {
    const a = gStart + (spanMs * w) / K;
    const b = gStart + (spanMs * (w + 1)) / K;
    const ts = all.filter((t) => t.entryTime >= a && t.entryTime < b);
    const nr = ts.reduce((s, t) => s + t.netR, 0);
    const wr = ts.length ? (ts.filter((t) => t.netR > 0).length / ts.length) * 100 : 0;
    const bar = nr >= 0 ? "█".repeat(Math.min(24, Math.round(nr))) : "░".repeat(Math.min(24, Math.round(-nr)));
    console.log(`  W${w + 1} : ${String(ts.length).padStart(3)} lệnh | WR ${wr.toFixed(0).padStart(3)}% | NET ${nr >= 0 ? "+" : ""}${nr.toFixed(2)}R ${bar}`);
  }

  console.log("\n" + "─".repeat(74));
  console.log("Đọc kết quả: nếu Sharpe ngày của PORTFOLIO > BTC-only và maxDD(R) tương đối");
  console.log("nhỏ hơn (so với tổng NET lớn hơn) → đa-symbol giúp MƯỢT thật, dù corr giá cao.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
