/**
 * backtest.ts — Mô phỏng chiến lược swing trên lịch sử nhiều symbol Perpetual
 *
 * - Fetch nến 15m (có phân trang) từ Binance Futures cho TỪNG symbol
 * - Gộp lên 1h, 4h để lấy bias + vùng order block
 * - Replay từng nến 15m, vào lệnh theo strategy.ts
 * - Quản lý lệnh: SL theo vùng + trailing theo swing/vùng, 1 lệnh 1 thời điểm / symbol
 * - (B) Trừ CHI PHÍ thật: phí taker + slippage + funding -> báo cáo NET R
 * - (F) Đa symbol + walk-forward windows + bootstrap CI + Monte Carlo random-entry p-value
 * - (D) Breakeven gate theo CONFIG.breakevenEnabled (mặc định TẮT)
 *
 * Run:
 *   npx ts-node backtest.ts [soNgay] [riskPctMoiLenh] [symbols]
 *   vd: npx ts-node backtest.ts 250 1                  (dùng CONFIG.symbols)
 *       npx ts-node backtest.ts 250 1 btcusdt          (chỉ BTC)
 *       npx ts-node backtest.ts 250 1 btcusdt,ethusdt  (BTC + ETH)
 */

import axios from "axios";
import {
  Candle,
  CONFIG,
  TF_MS,
  aggregate,
  findSwings,
  buildHtfContext,
  SetupTracker,
  htfClosedCount,
} from "./strategy";

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

// ─── NGUỒN KLINE (có fallback khi bị chặn địa lý 451) ─────────
// Binance Futures (fapi) bị chặn IP datacenter (Vercel/AWS) -> HTTP 451.
// data-api.binance.vision là endpoint dữ liệu công khai KHÔNG bị chặn (spot,
// định dạng mảng giống hệt futures, nhưng limit tối đa 1000/req).
type KlineSource = { url: string; maxLimit: number };
const KLINE_SOURCES: KlineSource[] = [
  { url: "https://fapi.binance.com/fapi/v1/klines", maxLimit: 1500 }, // futures (local)
  { url: "https://data-api.binance.vision/api/v3/klines", maxLimit: 1000 }, // spot mirror (cloud)
];

async function fetchKlinesFromSource(
  src: KlineSource,
  symbol: string,
  tf: string,
  totalBars: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let endTime = Date.now();

  while (all.length < totalBars) {
    const need = Math.min(src.maxLimit, totalBars - all.length);
    const res = await axios.get(src.url, {
      params: { symbol: symbol.toUpperCase(), interval: tf, limit: need, endTime },
      timeout: 15000, // fail nhanh thay vì treo cả function
    });
    const batch: Candle[] = (res.data as any[]).map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVolume: parseFloat(k[7]), // dollar volume
      takerBuyVolume: parseFloat(k[9]), // taker-buy base volume (cho delta/CVD)
    }));
    if (batch.length === 0) break;
    all.unshift(...batch);
    endTime = batch[0].openTime - 1; // lùi về quá khứ
    if (batch.length < need) break; // hết lịch sử
    process.stdout.write(`\r[Fetch ${symbol.toUpperCase()}] ${all.length}/${totalBars} nến ${tf}...`);
  }
  process.stdout.write("\n");
  const map = new Map<number, Candle>();
  for (const c of all) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

// ─── FETCH 15m CÓ PHÂN TRANG (thử lần lượt các nguồn) ────────
export async function fetchKlinesPaged(symbol: string, tf: string, totalBars: number): Promise<Candle[]> {
  let lastErr: unknown;
  for (const src of KLINE_SOURCES) {
    try {
      return await fetchKlinesFromSource(src, symbol, tf, totalBars);
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      console.warn(`[Fetch] ${src.url} lỗi${status ? ` (HTTP ${status})` : ""}, thử nguồn kế tiếp...`);
    }
  }
  throw lastErr; // hết nguồn vẫn lỗi
}

// ─── TRADE TYPES ─────────────────────────────────────────────
export interface Trade {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "sl" | "trail" | "time" | "target";
  grossR: number; // R trước chi phí
  costR: number; // chi phí quy ra R
  netR: number; // R sau chi phí
  holdBars: number;
  zoneDesc: string;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── (B) CHI PHÍ: phí taker + slippage + funding -> quy ra R ──
function tradeCostR(entryPrice: number, initialSL: number, entryTime: number, exitTime: number): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFrac = Math.abs(entryPrice - initialSL) / entryPrice;
  if (riskFrac <= 0) return 0;
  const feeFrac = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2; // round-trip 2 chiều
  const periods = Math.max(
    0,
    Math.floor(exitTime / FUNDING_INTERVAL_MS) - Math.floor(entryTime / FUNDING_INTERVAL_MS)
  );
  const fundingFrac = (periods * CONFIG.costs.fundingPer8hPct) / 100;
  return (feeFrac + fundingFrac) / riskFrac;
}

// ─── BACKTEST CORE (1 symbol) ────────────────────────────────
export function runBacktest(symbol: string, ltf: Candle[]): Trade[] {
  const biasTf = aggregate(ltf, CONFIG.htfBiasTf, CONFIG.entryTf); // 4h
  const zoneTf = aggregate(ltf, CONFIG.htfZoneTf, CONFIG.entryTf); // 1h

  const biasSwings = findSwings(biasTf);
  const zoneSwings = findSwings(zoneTf);

  const trades: Trade[] = [];

  let pos: {
    dir: "long" | "short";
    entryIndex: number;
    entry: number;
    initialSL: number;
    sl: number;
    target: number;
    zoneDesc: string;
  } | null = null;
  let cooldownUntil = -1;

  const ltfMs = TF_MS[CONFIG.entryTf];
  const maxHold = CONFIG.maxHoldBars;

  let cacheKey = "";
  let cachedCtx: ReturnType<typeof buildHtfContext> | null = null;

  const tracker = new SetupTracker();

  for (let i = CONFIG.volAvgPeriod; i < ltf.length; i++) {
    const c = ltf[i];
    const closeTime = c.openTime + ltfMs;

    // ─── Quản lý lệnh đang mở ───
    if (pos) {
      const heldBars = i - pos.entryIndex;
      let exitPrice: number | null = null;
      let reason: Trade["exitReason"] | null = null;

      if (pos.dir === "long") {
        if (c.low <= pos.sl) {
          exitPrice = pos.sl;
          reason = pos.sl > pos.initialSL ? "trail" : "sl";
        } else if (c.high >= pos.target) {
          exitPrice = pos.target;
          reason = "target";
        } else if (heldBars >= maxHold) {
          exitPrice = c.close;
          reason = "time";
        }
      } else {
        if (c.high >= pos.sl) {
          exitPrice = pos.sl;
          reason = pos.sl < pos.initialSL ? "trail" : "sl";
        } else if (c.low <= pos.target) {
          exitPrice = pos.target;
          reason = "target";
        } else if (heldBars >= maxHold) {
          exitPrice = c.close;
          reason = "time";
        }
      }

      if (exitPrice !== null && reason !== null) {
        const risk = Math.abs(pos.entry - pos.initialSL);
        const pnl = pos.dir === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
        const grossR = risk > 0 ? pnl / risk : 0;
        const entryTime = ltf[pos.entryIndex].openTime;
        const exitTime = c.openTime;
        const costR = tradeCostR(pos.entry, pos.initialSL, entryTime, exitTime);
        trades.push({
          symbol,
          dir: pos.dir,
          entryTime,
          entryPrice: pos.entry,
          initialSL: pos.initialSL,
          exitTime,
          exitPrice,
          exitReason: reason,
          grossR,
          costR,
          netR: grossR - costR,
          holdBars: heldBars,
          zoneDesc: pos.zoneDesc,
        });
        cooldownUntil = i + CONFIG.cooldownBars;
        pos = null;
        tracker.reset();
        continue;
      }

      // ─── Quản lý SL động: (D) breakeven (tùy chọn) -> trail theo swing 1h ───
      if (CONFIG.trailEnabled) {
        const risk = Math.abs(pos.entry - pos.initialSL);
        const zCount = htfClosedCount(zoneTf, closeTime);
        if (pos.dir === "long") {
          const profitR = (c.high - pos.entry) / risk;
          if (CONFIG.breakevenEnabled && profitR >= CONFIG.breakevenAtR && pos.sl < pos.entry) {
            pos.sl = pos.entry;
          }
          if (profitR >= CONFIG.trailStartR) {
            const sl = zoneSwings
              .filter((s) => s.type === "low" && s.confirmIndex <= zCount - 1 && s.price < c.close)
              .sort((a, b) => b.index - a.index)[0];
            if (sl) {
              const newSL = sl.price * (1 - CONFIG.slBufferPct);
              if (newSL > pos.sl && newSL < c.close) pos.sl = newSL;
            }
          }
        } else {
          const profitR = (pos.entry - c.low) / risk;
          if (CONFIG.breakevenEnabled && profitR >= CONFIG.breakevenAtR && pos.sl > pos.entry) {
            pos.sl = pos.entry;
          }
          if (profitR >= CONFIG.trailStartR) {
            const sh = zoneSwings
              .filter((s) => s.type === "high" && s.confirmIndex <= zCount - 1 && s.price > c.close)
              .sort((a, b) => b.index - a.index)[0];
            if (sh) {
              const newSL = sh.price * (1 + CONFIG.slBufferPct);
              if (newSL < pos.sl && newSL > c.close) pos.sl = newSL;
            }
          }
        }
      }
      continue;
    }

    // ─── Tìm lệnh mới ───
    if (i < cooldownUntil) continue;

    const biasCount = htfClosedCount(biasTf, closeTime);
    const zoneCount = htfClosedCount(zoneTf, closeTime);
    if (biasCount < 5 || zoneCount < CONFIG.volAvgPeriod) continue;

    const key = `${biasCount}_${zoneCount}`;
    if (key !== cacheKey) {
      cachedCtx = buildHtfContext(biasTf, zoneTf, biasSwings, zoneSwings, biasCount - 1, zoneCount - 1);
      cacheKey = key;
    }

    const signal = tracker.update(ltf, i, cachedCtx!);
    if (signal) {
      pos = {
        dir: signal.direction,
        entryIndex: i,
        entry: signal.entry,
        initialSL: signal.initialSL,
        sl: signal.initialSL,
        target: signal.initialTarget,
        zoneDesc: signal.reason,
      };
    }
  }

  return trades;
}

// ─── (F) VALIDATION: walk-forward, bootstrap, Monte Carlo ────
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Bootstrap: resample netR với hoàn lại -> CI cho tổng R & P(tổng > 0). */
function bootstrap(netRs: number[], B = 5000): { p5: number; p50: number; p95: number; pPositive: number } {
  if (netRs.length === 0) return { p5: 0, p50: 0, p95: 0, pPositive: 0 };
  const sums: number[] = [];
  let positive = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let k = 0; k < netRs.length; k++) {
      s += netRs[Math.floor(Math.random() * netRs.length)];
    }
    sums.push(s);
    if (s > 0) positive++;
  }
  sums.sort((a, b) => a - b);
  return { p5: quantile(sums, 0.05), p50: quantile(sums, 0.5), p95: quantile(sums, 0.95), pPositive: positive / B };
}

/** Mô phỏng 1 lệnh random: entry tại close[startIdx], hướng dir, stop = riskFrac, target = targetRR. */
function simRandomTrade(
  ltf: Candle[],
  startIdx: number,
  dir: "long" | "short",
  riskFrac: number
): { netR: number } | null {
  if (startIdx + 1 >= ltf.length) return null;
  const entry = ltf[startIdx].close;
  const sl = dir === "long" ? entry * (1 - riskFrac) : entry * (1 + riskFrac);
  const tp = dir === "long" ? entry * (1 + CONFIG.targetRR * riskFrac) : entry * (1 - CONFIG.targetRR * riskFrac);
  const maxK = Math.min(ltf.length - 1, startIdx + CONFIG.maxHoldBars);
  let grossR: number | null = null;
  let exitTime = ltf[maxK].openTime;
  for (let k = startIdx + 1; k <= maxK; k++) {
    const c = ltf[k];
    if (dir === "long") {
      if (c.low <= sl) { grossR = -1; exitTime = c.openTime; break; }
      if (c.high >= tp) { grossR = CONFIG.targetRR; exitTime = c.openTime; break; }
    } else {
      if (c.high >= sl) { grossR = -1; exitTime = c.openTime; break; }
      if (c.low <= tp) { grossR = CONFIG.targetRR; exitTime = c.openTime; break; }
    }
  }
  if (grossR === null) {
    const last = ltf[maxK];
    const pnl = dir === "long" ? last.close - entry : entry - last.close;
    grossR = pnl / (riskFrac * entry);
  }
  const costR = tradeCostR(entry, sl, ltf[startIdx].openTime, exitTime);
  return { netR: grossR - costR };
}

/**
 * Monte Carlo random-entry: với CÙNG số lệnh, CÙNG phân bố risk%, vào ngẫu nhiên trên
 * các nến lịch sử (hướng random). p-value = tỉ lệ sim có mean netR >= mean netR thật.
 * Trả lời: "entry của chiến lược có hơn vào ngẫu nhiên (cùng money-management) không?"
 */
function monteCarloRandomEntry(
  ltfBySymbol: Map<string, Candle[]>,
  trades: Trade[],
  sims = 2000
): { actualMean: number; nullMean: number; pValue: number } {
  const n = trades.length;
  const actualMean = n > 0 ? trades.reduce((s, t) => s + t.netR, 0) / n : 0;
  const riskFracs = trades.map((t) => Math.abs(t.entryPrice - t.initialSL) / t.entryPrice).filter((r) => r > 0);
  const symbols = [...ltfBySymbol.keys()];
  if (n === 0 || riskFracs.length === 0 || symbols.length === 0) {
    return { actualMean, nullMean: 0, pValue: 1 };
  }

  let beat = 0;
  let nullSum = 0;
  let nullCount = 0;
  const warmup = CONFIG.volAvgPeriod + 5;
  for (let s = 0; s < sims; s++) {
    let sum = 0;
    let cnt = 0;
    for (let t = 0; t < n; t++) {
      const sym = symbols[Math.floor(Math.random() * symbols.length)];
      const ltf = ltfBySymbol.get(sym)!;
      if (ltf.length < warmup + 10) continue;
      const startIdx = warmup + Math.floor(Math.random() * (ltf.length - warmup - 2));
      const dir = Math.random() < 0.5 ? "long" : "short";
      const riskFrac = riskFracs[Math.floor(Math.random() * riskFracs.length)];
      const r = simRandomTrade(ltf, startIdx, dir, riskFrac);
      if (r) { sum += r.netR; cnt++; }
    }
    if (cnt === 0) continue;
    const mean = sum / cnt;
    nullSum += mean;
    nullCount++;
    if (mean >= actualMean) beat++;
  }
  return { actualMean, nullMean: nullCount ? nullSum / nullCount : 0, pValue: nullCount ? beat / nullCount : 1 };
}

// ─── METRICS / REPORT ────────────────────────────────────────
function report(
  trades: Trade[],
  ltfBySymbol: Map<string, Candle[]>,
  riskPct: number,
  periodStart: number,
  periodEnd: number
) {
  console.log("=".repeat(70));
  console.log(`  KẾT QUẢ BACKTEST — entry ${CONFIG.entryTf} | bias ${CONFIG.htfBiasTf}/${CONFIG.htfZoneTf}`);
  console.log(`  Symbols: ${[...ltfBySymbol.keys()].map((s) => s.toUpperCase()).join(", ")}`);
  console.log(
    `  Chi phí: ${CONFIG.costs.enabled ? `taker ${CONFIG.costs.takerFeePct}% + slip ${CONFIG.costs.slippagePct}% /chiều + funding ${CONFIG.costs.fundingPer8hPct}%/8h` : "TẮT"}` +
      ` | Breakeven: ${CONFIG.breakevenEnabled ? `ON @${CONFIG.breakevenAtR}R` : "OFF"} | maxMitig: ${CONFIG.maxZoneMitigations} | delta: ${CONFIG.useDelta ? "ON" : "OFF"} | quoteVol: ${CONFIG.useQuoteVolume ? "ON" : "OFF"}`
  );
  console.log("=".repeat(70));

  if (trades.length === 0) {
    console.log("⚠️  Không có lệnh nào. Thử nới threshold (volSpikeMult, ltfConfirmVolMult, deltaBuyMin, maxZoneMitigations).");
    return;
  }

  trades.sort((a, b) => a.entryTime - b.entryTime);

  const wins = trades.filter((t) => t.netR > 0);
  const losses = trades.filter((t) => t.netR <= 0);
  const grossR = trades.reduce((s, t) => s + t.grossR, 0);
  const netR = trades.reduce((s, t) => s + t.netR, 0);
  const costR = trades.reduce((s, t) => s + t.costR, 0);
  const avgHoldDays = (trades.reduce((s, t) => s + t.holdBars, 0) / trades.length) * (TF_MS[CONFIG.entryTf] / TF_MS["1d"]);

  // equity (compounding) theo NET R
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  const r = riskPct / 100;
  for (const t of trades) {
    equity *= 1 + t.netR * r;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  const periodDays = (periodEnd - periodStart) / TF_MS["1d"];

  console.log(`\nKhoảng test : ${fmtTime(periodStart)} → ${fmtTime(periodEnd)} (${periodDays.toFixed(0)} ngày)`);
  console.log(`Tổng lệnh   : ${trades.length}  (long ${trades.filter((t) => t.dir === "long").length} / short ${trades.filter((t) => t.dir === "short").length})`);
  console.log(`Tần suất    : ~1 lệnh mỗi ${(periodDays / trades.length).toFixed(1)} ngày`);
  console.log(`Win rate    : ${((wins.length / trades.length) * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L) [theo NET]`);
  console.log(`Gross R     : ${grossR >= 0 ? "+" : ""}${grossR.toFixed(2)}R`);
  console.log(`Chi phí     : -${costR.toFixed(2)}R  (${(costR / trades.length).toFixed(3)}R/lệnh)`);
  console.log(`NET R       : ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R   | NET R TB/lệnh: ${(netR / trades.length).toFixed(3)}R`);
  console.log(`Giữ lệnh TB : ${avgHoldDays.toFixed(1)} ngày`);
  console.log(`\n[Risk ${riskPct}%/lệnh, compounding NET từ 100 đơn vị]`);
  console.log(`Equity cuối : ${equity.toFixed(1)}  (${equity >= 100 ? "+" : ""}${(equity - 100).toFixed(1)}%)`);
  console.log(`Max drawdown: -${(maxDD * 100).toFixed(1)}%`);

  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  console.log(`Lý do thoát : ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  // per-symbol breakdown
  console.log("\n" + "─".repeat(70));
  console.log("THEO SYMBOL (NET):");
  for (const sym of ltfBySymbol.keys()) {
    const ts = trades.filter((t) => t.symbol === sym);
    if (ts.length === 0) { console.log(`  ${sym.toUpperCase().padEnd(9)} : 0 lệnh`); continue; }
    const w = ts.filter((t) => t.netR > 0).length;
    const nr = ts.reduce((s, t) => s + t.netR, 0);
    console.log(`  ${sym.toUpperCase().padEnd(9)} : ${String(ts.length).padStart(3)} lệnh | WR ${((w / ts.length) * 100).toFixed(0)}% | NET ${nr >= 0 ? "+" : ""}${nr.toFixed(2)}R`);
  }

  // ── (F) Walk-forward windows: edge có ổn định theo thời gian không? ──
  const K = 4;
  console.log("\n" + "─".repeat(70));
  console.log(`WALK-FORWARD — chia khoảng test thành ${K} cửa sổ thời gian (NET R mỗi cửa sổ):`);
  const span = periodEnd - periodStart;
  for (let w = 0; w < K; w++) {
    const wStart = periodStart + (span * w) / K;
    const wEnd = periodStart + (span * (w + 1)) / K;
    const ts = trades.filter((t) => t.entryTime >= wStart && t.entryTime < wEnd);
    const nr = ts.reduce((s, t) => s + t.netR, 0);
    const win = ts.length ? ts.filter((t) => t.netR > 0).length / ts.length : 0;
    const bar = nr >= 0 ? "█".repeat(Math.min(20, Math.round(nr))) : "░".repeat(Math.min(20, Math.round(-nr)));
    console.log(
      `  W${w + 1} ${fmtTime(wStart).slice(0, 10)}→${fmtTime(wEnd).slice(0, 10)} : ${String(ts.length).padStart(3)} lệnh | WR ${(win * 100).toFixed(0).padStart(3)}% | NET ${nr >= 0 ? "+" : ""}${nr.toFixed(2)}R ${bar}`
    );
  }

  // ── (F) Bootstrap CI ──
  const boot = bootstrap(trades.map((t) => t.netR));
  console.log("\n" + "─".repeat(70));
  console.log("BOOTSTRAP (resample lệnh có hoàn lại, 5000 lần) — độ tin cậy của tổng NET R:");
  console.log(`  90% CI tổng NET R : [${boot.p5.toFixed(2)}R , ${boot.p95.toFixed(2)}R]  (trung vị ${boot.p50.toFixed(2)}R)`);
  console.log(`  P(tổng NET R > 0) : ${(boot.pPositive * 100).toFixed(1)}%`);

  // ── (F) Monte Carlo random-entry p-value ──
  const mc = monteCarloRandomEntry(ltfBySymbol, trades, 2000);
  console.log("\n" + "─".repeat(70));
  console.log("MONTE CARLO random-entry (2000 sim, cùng số lệnh + risk% + money-management):");
  console.log(`  Mean NET R/lệnh — chiến lược : ${mc.actualMean.toFixed(3)}R`);
  console.log(`  Mean NET R/lệnh — random     : ${mc.nullMean.toFixed(3)}R`);
  console.log(`  p-value (random >= chiến lược): ${mc.pValue.toFixed(3)}  ${mc.pValue < 0.05 ? "✅ có edge (p<0.05)" : "⚠️ CHƯA đủ edge so với random (p>=0.05)"}`);

  // ── danh sách lệnh ──
  console.log("\n" + "─".repeat(70));
  console.log("CHI TIẾT LỆNH (NET R):\n");
  for (const t of trades) {
    const arrow = t.dir === "long" ? "🟢 LONG " : "🔴 SHORT";
    const rStr = `${t.netR >= 0 ? "+" : ""}${t.netR.toFixed(2)}R`;
    const holdDays = (t.holdBars * (TF_MS[CONFIG.entryTf] / TF_MS["1d"])).toFixed(1);
    console.log(
      `${t.symbol.toUpperCase().padEnd(8)} ${arrow} ${fmtTime(t.entryTime)} $${t.entryPrice.toFixed(0)} → ${fmtTime(t.exitTime)} $${t.exitPrice.toFixed(0)} | ${rStr.padStart(7)} | ${t.exitReason.padEnd(6)} | giữ ${holdDays}d`
    );
  }
  console.log();
  console.log("👉 Đối chiếu TradingView: mở đúng symbol + timestamp IN/OUT để kiểm tra điểm vào/ra.");
  console.log();
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const riskPct = parseFloat(process.argv[3] ?? "1");
  const symbols = (process.argv[4] ? process.argv[4].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());

  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(days * barsPerDay) + 400; // +warmup cho HTF

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol (${totalBars} nến ${CONFIG.entryTf} mỗi symbol)...\n`);

  const ltfBySymbol = new Map<string, Candle[]>();
  const allTrades: Trade[] = [];
  let periodStart = Infinity;
  let periodEnd = -Infinity;

  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length < 500) {
      console.log(`[${sym.toUpperCase()}] Không đủ dữ liệu (${ltf.length} nến), bỏ qua.\n`);
      continue;
    }
    ltfBySymbol.set(sym, ltf);
    periodStart = Math.min(periodStart, ltf[0].openTime);
    periodEnd = Math.max(periodEnd, ltf[ltf.length - 1].openTime);
    const trades = runBacktest(sym, ltf);
    allTrades.push(...trades);
    console.log(`[${sym.toUpperCase()}] ${trades.length} lệnh.`);
  }

  if (ltfBySymbol.size === 0) {
    console.log("Không tải được symbol nào.");
    return;
  }
  console.log();
  report(allTrades, ltfBySymbol, riskPct, periodStart, periodEnd);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Lỗi:", err?.response?.data ?? err.message);
    process.exit(1);
  });
}
