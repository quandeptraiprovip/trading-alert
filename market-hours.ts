/**
 * market-hours.ts — giờ đóng cửa của vàng thật cho XAUUSDT Binance (TradFi perp).
 *
 * Binance giao dịch XAUUSDT 24/7 nhưng vàng thật đóng từ thứ Sáu 17:00 tới Chủ nhật
 * 18:00 giờ New York. Nến trong khung đó là nến chết (volume ~1/10) xen đột biến lẻ mà
 * key-volume coi là key — backtest 06/10/26: xoá chúng làm số key chín giảm 259 → 138.
 */

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", hour: "2-digit", hour12: false,
});

/** true nếu `ms` rơi vào khung vàng đóng cửa cuối tuần (giờ New York, DST tự xử lý). */
export function goldClosedNy(ms: number): boolean {
  const parts = NY_PARTS.formatToParts(new Date(ms));
  const wd = parts.find((p) => p.type === "weekday")!.value;
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  return (wd === "Fri" && h >= 17) || wd === "Sat" || (wd === "Sun" && h < 18);
}

/** Mã chỉ giao dịch theo giờ thị trường vàng — nến cuối tuần bị bỏ trước khi vẽ/chạy engine. */
export function dropsWeekendBars(symbol: string): boolean {
  return symbol.toLowerCase() === "xauusdt";
}
