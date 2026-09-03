/**
 * Cấu hình và helper THUẦN của Fast Trend.
 *
 * File này không đọc/ghi state, không tạo timer, không gửi Telegram và không kết nối sàn.
 * Live bot, parity test và UI Strategy Audit cùng đọc một nguồn để tránh trôi rule.
 */
import { Candle, TF_MS } from "./strategy";
import { T } from "./turtle";

const TF_MS_4H = TF_MS[T.tf];
const BARS_PER_DAY = TF_MS["1d"] / TF_MS_4H;

export const FAST_DEFAULT_ENTRY_DAYS = 10;
export const FAST_SHORT_ENTRY_DAYS = 30;
export const FAST_SHORT_CONFIRM_BARS = 1;
/**
 * Kênh thoát LONG tách khỏi kênh vào: close cắt midpoint close-channel 20 ngày.
 * Audit 2.025 ngày cho thấy vùng 18–25 ngày là plateau và cải thiện cả ba era so với
 * Chandelier cũ; xem `planning/fast-exit-channel-2026-08.md`.
 */
export const FAST_LONG_EXIT_DAYS = 20;
/**
 * Các unit trong cùng symbol tương quan hoàn toàn; 3 unit có NET/maxDD tốt hơn 4–5 unit
 * trong audit 2026-08-09. Giữ trần riêng, không kế thừa ngầm từ Turtle.
 */
export const FAST_MAX_UNITS = 3;
export const FAST_MEXC_TAKER_FEE_PCT = 0.08;

const FAST_SHORT_ENTRY_BARS = Math.max(2, Math.round(FAST_SHORT_ENTRY_DAYS * BARS_PER_DAY));
const FAST_LONG_EXIT_BARS = Math.max(2, Math.round(FAST_LONG_EXIT_DAYS * BARS_PER_DAY));

export function parseFastTrendEntryDays(value: string | undefined): number {
  const parsed = parseInt(value ?? String(FAST_DEFAULT_ENTRY_DAYS), 10);
  return Number.isFinite(parsed) && parsed >= 2 ? parsed : FAST_DEFAULT_ENTRY_DAYS;
}

export type FastShortEntrySetup = {
  breakoutLevel: number;
  signalBarTime: number;
};

export function decideFastShortConfirmation(
  setup: FastShortEntrySetup,
  bar: Pick<Candle, "openTime" | "close">,
  downtrend: boolean,
  gateOk: boolean,
): "wait" | "enter" | "cancel" {
  if (bar.openTime <= setup.signalBarTime) return "wait";
  if (bar.openTime !== setup.signalBarTime + FAST_SHORT_CONFIRM_BARS * TF_MS_4H) return "cancel";
  return downtrend && gateOk && bar.close < setup.breakoutLevel ? "enter" : "cancel";
}

export function priorFastShortCloseLow(candles: Candle[], index: number): number {
  if (index < FAST_SHORT_ENTRY_BARS) return Infinity;
  let closeLow = Infinity;
  for (let k = index - FAST_SHORT_ENTRY_BARS; k < index; k++) {
    closeLow = Math.min(closeLow, candles[k].close);
  }
  return closeLow;
}

/** Midpoint kênh CLOSE trước nến `index`; không dùng dữ liệu nến hiện tại. */
export function priorFastLongMidClose(candles: Candle[], index: number): number {
  if (index < FAST_LONG_EXIT_BARS) return -Infinity;
  let high = -Infinity;
  let low = Infinity;
  for (let k = index - FAST_LONG_EXIT_BARS; k < index; k++) {
    high = Math.max(high, candles[k].close);
    low = Math.min(low, candles[k].close);
  }
  return (high + low) / 2;
}

export function fastConfigLine(entryDays: number): string {
  const fingerprint = {
    e: entryDays,
    x: FAST_LONG_EXIT_DAYS,
    s: FAST_SHORT_ENTRY_DAYS,
    k: FAST_SHORT_CONFIRM_BARS,
    c: T.chandelierMult,
    u: FAST_MAX_UNITS,
    p: T.pyramidStepAtr,
    a: T.atrPeriod,
    t: T.trendLen,
    h: T.maxHoldDays,
    g: `${T.btcGateFast}/${T.btcGateSlow}`,
  };
  let hash = 0x811c9dc5;
  const serialized = JSON.stringify(fingerprint);
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (
    `long high-${entryDays}d/exit mid-close ${FAST_LONG_EXIT_DAYS}d · ` +
    `short close-${FAST_SHORT_ENTRY_DAYS}d +${FAST_SHORT_CONFIRM_BARS} nến/chand ${T.chandelierMult}×ATR · ` +
    `pyramid ${T.pyramidStepAtr}×ATR max${FAST_MAX_UNITS} · gate ${T.btcGateFast / BARS_PER_DAY}/${T.btcGateSlow / BARS_PER_DAY}d · ` +
    `fp ${hash.toString(16).padStart(8, "0").slice(0, 6)}`
  );
}
