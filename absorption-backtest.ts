/**
 * absorption-backtest.ts — Backtest chiến lược Absorption Defense
 *
 * Run:
 *   npx ts-node absorption-backtest.ts [soNgay=1200] [symbols=btcusdt,solusdt,xrpusdt,dogeusdt]
 */
import './load-env';
import { fetchFuturesKlinesPaged } from './backtest';
import { Candle, TF_MS, CONFIG, lastConfirmedSwing } from './strategy';
import {
  DEFAULT_ABSORPTION_CONFIG,
  AbsorptionConfig,
  AbsorptionZone,
  AbsorptionTrade,
  AbsorptionSignal,
  PrecomputedData,
  atr15m,
  detectExtremeVolumeZones,
  findAbsorptionRetest,
  findConfirmationEntry,
  computeAbsorptionTrade,
  precompute,
} from './absorption-strategy';

// ─── Cost model (khớp backtest.ts) ─────────────────────────────────
const ROUND_TRIP_FEE_SLIP = 0.0014; // (0.05% taker + 0.02% slip) × 2 sides
const FUNDING_PER_8H = 0.0001;      // 0.01% per 8h funding period

// ─── Helpers ────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

function mulberry32(seed: number): () => number {
  return () => {
    let s = seed;
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BacktestTrade {
  symbol: string;
  direction: "long" | "short";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
  exitReason: "sl" | "target" | "time";
}

function weeklyBootstrap(trades: BacktestTrade[], samples = 4000) {
  if (!trades.length) return { lo: 0, hi: 0, pPositive: 0 };
  const weekMs = 7 * TF_MS["1d"];
  const groups = new Map<number, number[]>();
  for (const trade of trades) {
    const week = Math.floor(trade.entryTime / weekMs);
    const values = groups.get(week) ?? [];
    values.push(trade.netR);
    groups.set(week, values);
  }
  const blocks = [...groups.values()];
  const rng = mulberry32(0x15e7e57);
  const means: number[] = [];
  let positive = 0;
  for (let s = 0; s < samples; s++) {
    let total = 0;
    let n = 0;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      total += block.reduce((sum, value) => sum + value, 0);
      n += block.length;
    }
    const value = n ? total / n : 0;
    means.push(value);
    if (value > 0) positive++;
  }
  means.sort((a, b) => a - b);
  return { lo: quantile(means, 0.05), hi: quantile(means, 0.95), pPositive: positive / samples };
}

// ─── BACKTEST ENGINE ────────────────────────────────────────────────

function runSymbol(symbol: string, candles: Candle[], config: AbsorptionConfig): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  if (candles.length < config.lookback + 200) return trades;

  // 1. Precompute all derived data once
  const pre = precompute(candles, config);
  const zones = detectExtremeVolumeZones(candles, config);

  let blockedUntil = -1;

  // 2. Scan each bar for absorption retests
  for (let i = config.lookback; i < candles.length - config.timeStopBars; i++) {
    if (i <= blockedUntil) continue;

    const signal = findAbsorptionRetest(candles, zones, i, config, pre);
    if (!signal) continue;

    // HTF filter
    if (!signal.htfAligned) continue;

    // 3. Find BOS/reclaim confirmation
    const entryIndex = findConfirmationEntry(candles, signal, signal.retestIndex + 1, config.confirmMaxBars);
    if (entryIndex == null || entryIndex <= blockedUntil) continue;

    // 4. Compute trade (SL/TP)
    const trade = computeAbsorptionTrade(candles, signal, entryIndex, config);
    if (!trade) continue;

    // 5. Simulate trade
    const endSim = Math.min(candles.length - 1, entryIndex + config.timeStopBars);
    let exitIndex = endSim;
    let grossR: number | null = null;
    let exitReason: "sl" | "target" | "time" = "time";

    for (let k = entryIndex + 1; k <= endSim; k++) {
      const bar = candles[k];
      // SL hit (assume worst case: SL checked before TP)
      const stopHit = trade.direction === "long" ? bar.low <= trade.stopPrice : bar.high >= trade.stopPrice;
      const targetHit = trade.direction === "long" ? bar.high >= trade.targetPrice : bar.low <= trade.targetPrice;
      if (stopHit) {
        grossR = -1;
        exitIndex = k;
        exitReason = "sl";
        break;
      }
      if (targetHit) {
        grossR = config.targetRR;
        exitIndex = k;
        exitReason = "target";
        break;
      }
    }

    if (grossR == null) {
      // Time exit — R = actual move / risk
      const exitClose = candles[endSim].close;
      const move = trade.direction === "long"
        ? exitClose - trade.entryPrice
        : trade.entryPrice - exitClose;
      grossR = move / Math.abs(trade.entryPrice - trade.stopPrice);
    }

    // Cost
    const holdMs = candles[exitIndex].openTime - candles[entryIndex].openTime;
    const fundingPeriods = Math.max(0, Math.floor(holdMs / (8 * 3600_000)));
    const risk = Math.abs(trade.entryPrice - trade.stopPrice);
    const riskFrac = risk / trade.entryPrice;
    const costR = (ROUND_TRIP_FEE_SLIP + fundingPeriods * FUNDING_PER_8H) / riskFrac;

    trades.push({
      symbol,
      direction: trade.direction,
      entryTime: candles[entryIndex].openTime,
      exitTime: candles[exitIndex].openTime,
      entryPrice: trade.entryPrice,
      exitPrice: candles[exitIndex].close,
      grossR,
      costR,
      netR: grossR - costR,
      holdBars: exitIndex - entryIndex,
      exitReason,
    });

    blockedUntil = exitIndex + 48; // cooldown ~12h (same as SMC)
  }

  return trades;
}

// ─── REPORT ─────────────────────────────────────────────────────────

function formatReport(trades: BacktestTrade[], symbols: string[]) {
  console.log("=".repeat(80));
  console.log("  ABSORPTION DEFENSE BACKTEST (15m entry, 4h/1h HTF alignment)");
  console.log("=".repeat(80));

  if (trades.length === 0) {
    console.log("Không có lệnh nào.");
    return;
  }

  const net = trades.reduce((sum, t) => sum + t.netR, 0);
  const gross = trades.reduce((sum, t) => sum + t.grossR, 0);
  const cost = trades.reduce((sum, t) => sum + t.costR, 0);
  const exp = net / trades.length;
  const wins = trades.filter(t => t.netR > 0).length;
  const wr = wins / trades.length;
  const avgHold = trades.reduce((sum, t) => sum + t.holdBars, 0) / trades.length;

  console.log(`Tổng lệnh   : ${trades.length}`);
  console.log(`Win rate    : ${(wr * 100).toFixed(1)}% (${wins}W / ${trades.length - wins}L)`);
  console.log(`GROSS R     : ${gross >= 0 ? "+" : ""}${gross.toFixed(2)}R`);
  console.log(`Chi phí     : −${cost.toFixed(2)}R`);
  console.log(`NET R       : ${net >= 0 ? "+" : ""}${net.toFixed(2)}R`);
  console.log(`Exp/trade   : ${exp.toFixed(3)}R`);
  console.log(`Giữ TB      : ${avgHold.toFixed(0)} nến (${(avgHold / 4).toFixed(1)}h)\n`);

  // Direction breakdown
  const longs = trades.filter(t => t.direction === "long");
  const shorts = trades.filter(t => t.direction === "short");
  console.log(`Hướng       : Long ${longs.length} (${longs.reduce((s, t) => s + t.netR, 0).toFixed(1)}R) | Short ${shorts.length} (${shorts.reduce((s, t) => s + t.netR, 0).toFixed(1)}R)`);

  // Exit reason breakdown
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
  console.log(`Lý do thoát : ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(" | ")}\n`);

  // Era breakdown (3 equal time splits)
  const minTime = Math.min(...trades.map(t => t.entryTime));
  const maxTime = Math.max(...trades.map(t => t.entryTime));
  const eraSpan = (maxTime - minTime + 1) / 3;
  console.log("ERA (3 giai đoạn bằng nhau):");
  for (let era = 0; era < 3; era++) {
    const lo = minTime + era * eraSpan;
    const hi = era === 2 ? maxTime + 1 : minTime + (era + 1) * eraSpan;
    const eraTrades = trades.filter(t => t.entryTime >= lo && t.entryTime < hi);
    const eraNet = eraTrades.reduce((s, t) => s + t.netR, 0);
    const eraWr = eraTrades.length ? eraTrades.filter(t => t.netR > 0).length / eraTrades.length : 0;
    const label = era === 0 ? "A" : era === 1 ? "B" : "C";
    console.log(`  ${label}: ${String(eraTrades.length).padStart(3)} lệnh | WR ${(eraWr * 100).toFixed(0).padStart(3)}% | NET ${eraNet >= 0 ? "+" : ""}${eraNet.toFixed(2)}R`);
  }

  // Per-symbol breakdown
  console.log("\nTHEO SYMBOL:");
  for (const sym of symbols) {
    const symTrades = trades.filter(t => t.symbol === sym);
    if (!symTrades.length) {
      console.log(`  ${sym.toUpperCase().padEnd(9)} : 0 lệnh`);
      continue;
    }
    const symNet = symTrades.reduce((s, t) => s + t.netR, 0);
    const symWr = symTrades.filter(t => t.netR > 0).length / symTrades.length;
    console.log(`  ${sym.toUpperCase().padEnd(9)} : ${String(symTrades.length).padStart(3)} lệnh | WR ${(symWr * 100).toFixed(0).padStart(3)}% | NET ${symNet >= 0 ? "+" : ""}${symNet.toFixed(2)}R`);
  }

  // Bootstrap CI90
  console.log("\nBOOTSTRAP (Weekly block, 4000 samples):");
  const ci = weeklyBootstrap(trades, 4000);
  console.log(`  CI90 Exp/trade : [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
  console.log(`  P(NET > 0)     : ${(ci.pPositive * 100).toFixed(1)}%`);
}

// ─── MAIN ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const days = parseInt(args[0] ?? "1200", 10);
  const symbolsArg = args[1];
  const symbols = (symbolsArg ? symbolsArg.split(",") : ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"])
    .map((s: string) => s.trim().toLowerCase());

  const config = DEFAULT_ABSORPTION_CONFIG;
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS["15m"]) + 500;
  console.log(`Absorption Defense Backtest — ${days} ngày × ${symbols.length} symbol (${bars} nến 15m/sym)\n`);

  const allTrades: BacktestTrade[] = [];
  for (const sym of symbols) {
    const candles = await fetchFuturesKlinesPaged(sym, "15m", bars);
    if (candles.length < 1000) {
      console.log(`[${sym.toUpperCase()}] Không đủ dữ liệu (${candles.length} nến), bỏ qua.`);
      continue;
    }
    console.log(`[${sym.toUpperCase()}] ${candles.length} nến, đang chạy...`);
    const trades = runSymbol(sym, candles, config);
    allTrades.push(...trades);
    console.log(`[${sym.toUpperCase()}] → ${trades.length} lệnh`);
  }

  console.log();
  formatReport(allTrades, symbols);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
