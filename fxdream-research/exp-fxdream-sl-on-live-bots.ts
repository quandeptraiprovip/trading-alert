/**
 * fxdream-research/exp-fxdream-sl-on-live-bots.ts
 *
 * TÍNH THỬ: Áp Dụng Cách Đặt Stop Loss Của FXDream Vào 2 Chiến Lược Live Bot (Fast Trend & Turtle)
 *
 * Thử nghiệm 2 Nâng Cấp:
 * 1. SL Cấu Trúc Ngắn At Breakout Wick / OB Edge (thay vì 3x ATR hay 2x N-unit).
 * 2. Dời SL về Breakeven (BE) tại 1.5R & Gồng Thả Trôi 100% Vị Thế (High R:R Runners).
 */

import "../load-env";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, aggregate, findSwings, TF_MS } from "../strategy";

export function calculateATR(candles: Candle[], period = 14): number[] {
  const atr = new Array<number>(candles.length).fill(0);
  if (candles.length < 2) return atr;
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
    } else {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  let sum = 0;
  for (let i = 0; i < Math.min(period, tr.length); i++) sum += tr[i];
  atr[Math.min(period - 1, atr.length - 1)] = sum / Math.min(period, tr.length);
  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// ─────────────────────────────────────────────
// THỬ NGHIỆM 1: FAST TREND BOT + FXDREAM TIGHT SL
// ─────────────────────────────────────────────

export function runFastTrendWithFXDreamSL(candles4h: Candle[], useFXDreamSL: boolean) {
  const atr = calculateATR(candles4h, 14);
  const entryLookback = 10 * 6; // 10 days on 4h (60 bars)
  const exitLookback = 20 * 6; // 20 days on 4h (120 bars)

  let inPosition = false;
  let entryPrice = 0;
  let currentSL = 0;
  let initialRiskDist = 0;
  let slMovedToBE = false;

  let totalTrades = 0;
  let wins = 0;
  let grossR = 0;
  let costR = 0;

  for (let i = entryLookback; i < candles4h.length; i++) {
    const bar = candles4h[i];

    if (inPosition) {
      const currentGainR = (bar.high - entryPrice) / initialRiskDist;

      // FXDream Rule: Dời SL về BE tại 1.5R
      if (useFXDreamSL && !slMovedToBE && currentGainR >= 1.5) {
        slMovedToBE = true;
        currentSL = Math.max(currentSL, entryPrice);
      }

      // Exit check (Donchian Exit or SL Hit)
      let isClosed = false;
      let exitPrice = 0;

      if (bar.low <= currentSL) {
        isClosed = true;
        exitPrice = currentSL;
      } else {
        // Standard Exit (Break below 20d mid-close)
        const exitWindow = candles4h.slice(i - exitLookback, i).map((c) => c.close);
        const midClose = (Math.max(...exitWindow) + Math.min(...exitWindow)) / 2;
        if (bar.close < midClose) {
          isClosed = true;
          exitPrice = bar.close;
        }
      }

      if (isClosed) {
        totalTrades++;
        const tradeR = (exitPrice - entryPrice) / initialRiskDist;
        const feeR = useFXDreamSL ? 0.05 : 0.15; // Tight SL vs Wide SL fee impact

        grossR += tradeR;
        costR += feeR;
        if (tradeR > 0) wins++;

        inPosition = false;
      }
      continue;
    }

    // Signal Entry (Breakout 10d High)
    const window = candles4h.slice(i - entryLookback, i).map((c) => c.high);
    const high10d = Math.max(...window);

    if (bar.close > high10d) {
      inPosition = true;
      entryPrice = bar.close;
      slMovedToBE = false;

      if (useFXDreamSL) {
        // FXDream Tight SL: Đặt SL sát dưới Đáy của nến Breakout (Tight Structure SL)
        const breakWickSL = bar.low * 0.998;
        const rawStopPct = (entryPrice - breakWickSL) / entryPrice;
        // Giữ floor 0.8% để tránh phí phế
        const stopPct = Math.max(0.008, rawStopPct);
        currentSL = entryPrice * (1 - stopPct);
      } else {
        // Standard Wide SL: 3x ATR (khoảng 3% - 5%)
        currentSL = entryPrice - atr[i] * 3.0;
      }

      initialRiskDist = Math.abs(entryPrice - currentSL);
    }
  }

  const netR = grossR - costR;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  return { totalTrades, winRate, grossR, costR, netR };
}

// ─────────────────────────────────────────────
// THỬ NGHIỆM 2: TURTLE BOT + FXDREAM TIGHT SL
// ─────────────────────────────────────────────

export function runTurtleWithFXDreamSL(candles1d: Candle[], useFXDreamSL: boolean) {
  const atr = calculateATR(candles1d, 20);
  const entryLookback = 20; // 20-day Donchian Breakout
  const exitLookback = 10; // 10-day Exit

  let inPosition = false;
  let entryPrice = 0;
  let currentSL = 0;
  let initialRiskDist = 0;
  let slMovedToBE = false;

  let totalTrades = 0;
  let wins = 0;
  let grossR = 0;
  let costR = 0;

  for (let i = entryLookback; i < candles1d.length; i++) {
    const bar = candles1d[i];

    if (inPosition) {
      const currentGainR = (bar.high - entryPrice) / initialRiskDist;

      // FXDream Rule: Dời SL về BE tại 1.5R
      if (useFXDreamSL && !slMovedToBE && currentGainR >= 1.5) {
        slMovedToBE = true;
        currentSL = Math.max(currentSL, entryPrice);
      }

      let isClosed = false;
      let exitPrice = 0;

      if (bar.low <= currentSL) {
        isClosed = true;
        exitPrice = currentSL;
      } else {
        const exitWindow = candles1d.slice(i - exitLookback, i).map((c) => c.low);
        const exit10dLow = Math.min(...exitWindow);
        if (bar.close < exit10dLow) {
          isClosed = true;
          exitPrice = bar.close;
        }
      }

      if (isClosed) {
        totalTrades++;
        const tradeR = (exitPrice - entryPrice) / initialRiskDist;
        const feeR = useFXDreamSL ? 0.04 : 0.10;

        grossR += tradeR;
        costR += feeR;
        if (tradeR > 0) wins++;

        inPosition = false;
      }
      continue;
    }

    const window = candles1d.slice(i - entryLookback, i).map((c) => c.high);
    const high20d = Math.max(...window);

    if (bar.close > high20d) {
      inPosition = true;
      entryPrice = bar.close;
      slMovedToBE = false;

      if (useFXDreamSL) {
        // FXDream Tight SL at Breakout Low
        const breakWickSL = bar.low * 0.998;
        const rawStopPct = (entryPrice - breakWickSL) / entryPrice;
        const stopPct = Math.max(0.008, rawStopPct);
        currentSL = entryPrice * (1 - stopPct);
      } else {
        // Standard Turtle 2N SL (2x ATR)
        currentSL = entryPrice - atr[i] * 2.0;
      }

      initialRiskDist = Math.abs(entryPrice - currentSL);
    }
  }

  const netR = grossR - costR;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  return { totalTrades, winRate, grossR, costR, netR };
}

async function main() {
  const symbol = "BTCUSDT";
  const days = 365;

  console.log(`================================================================`);
  console.log(` THỬ NGHIỆM: ÁP DỤNG STOP LOSS FXDREAM VÀO FAST TREND & TURTLE BOT`);
  console.log(`================================================================\n`);

  console.log(`[1/2] Đang tải 365 ngày dữ liệu nến BTCUSDT...`);
  const c5m = await fetchKlinesPaged(symbol, "5m", days * 288, "futures");
  const c4h = aggregate(c5m, "4h", "5m");
  const c1d = aggregate(c5m, "1d", "5m");

  console.log(` -> Đã tải thành công ${c5m.length} nến 5m.`);

  console.log(`\n[2/2] Đang tính toán thử nghiệm...`);

  const fastStd = runFastTrendWithFXDreamSL(c4h, false);
  const fastFXD = runFastTrendWithFXDreamSL(c4h, true);

  const turtleStd = runTurtleWithFXDreamSL(c1d, false);
  const turtleFXD = runTurtleWithFXDreamSL(c1d, true);

  console.log(`\n========================================================================================================`);
  console.log(`              BẢNG SO SÁNH HIỆU NĂNG KHI ÁP DỤNG STOP LOSS FXDREAM VÀO 2 LIVE BOTS`);
  console.log(`========================================================================================================`);
  console.log(
    `| ${"Chiến Lược & Mô Hình Stop Loss".padEnd(45)} | ${"Lệnh".padStart(5)} | ${"WinRate".padStart(8)} | ${"Gross R".padStart(9)} | ${"Phí R".padStart(8)} | ${"Net R".padStart(9)} |`
  );
  console.log(`--------------------------------------------------------------------------------------------------------`);

  const printRow = (label: string, s: { totalTrades: number; winRate: number; grossR: number; costR: number; netR: number }) => {
    const wrStr = `${s.winRate.toFixed(1)}%`;
    const grossStr = `${s.grossR >= 0 ? "+" : ""}${s.grossR.toFixed(1)}R`;
    const costStr = `-${s.costR.toFixed(1)}R`;
    const netStr = `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R`;
    console.log(
      `| ${label.padEnd(45)} | ${s.totalTrades.toString().padStart(5)} | ${wrStr.padStart(8)} | ${grossStr.padStart(9)} | ${costStr.padStart(8)} | ${netStr.padStart(9)} |`
    );
  };

  printRow("1A. Fast Trend (Stop Loss 3x ATR Gốc)", fastStd);
  printRow("1B. Fast Trend + Stop Loss FXDream (Tight+BE)", fastFXD);
  console.log(`--------------------------------------------------------------------------------------------------------`);
  printRow("2A. Turtle Breakout (Stop Loss 2N ATR Gốc)", turtleStd);
  printRow("2B. Turtle Breakout + Stop Loss FXDream (Tight+BE)", turtleFXD);
  console.log(`========================================================================================================\n`);
}

main().catch((err) => {
  console.error("Lỗi chạy thử nghiệm Stop Loss FXDream:", err);
  process.exit(1);
});
