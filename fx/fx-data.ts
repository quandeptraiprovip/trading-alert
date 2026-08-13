/**
 * fx-data.ts — nạp nến FX từ cache Dukascopy (fx/fetch-dukascopy.py) và gộp lên khung lớn hơn.
 *
 * KHÁC CRYPTO Ở HAI CHỖ, và cả hai đều đủ sức làm sai kết quả nếu bỏ qua:
 *
 * 1. THỊ TRƯỜNG ĐÓNG CỬA CUỐI TUẦN. Không thể dùng `aggregate()` của strategy.ts vì nó chia
 *    bucket theo mốc UTC cố định: mốc 00:00 UTC cắt phiên Á làm đôi, và bucket chứa cuối tuần
 *    sẽ có 2 giờ dữ liệu nhưng vẫn được tính là "một ngày". Ở đây gộp theo NGÀY GIAO DỊCH FX
 *    với mốc đóng cửa 22:00 UTC (= 17:00 New York, đúng quy ước ngày của mọi broker FX) → đúng
 *    5 nến ngày/tuần, giống hệt biểu đồ MT5 mà người dùng sẽ nhìn khi vào lệnh thật.
 *
 * 2. SPREAD LÀ CHI PHÍ CHÍNH và nó THAY ĐỔI theo thời gian (2008, 2015 CHF). Feed có cả BID lẫn
 *    ASK nên spread được ĐO trên đúng từng nến chứ không phải một hằng số đoán.
 *
 * `offsetHours` cho phép dịch mốc đóng nến — đây là bản FX của phép thử LỆCH PHA NẾN
 * (planning/…bar-phase…): một luật thật phải sống sót khi mốc chia nến xê dịch vài giờ.
 */

import fs from "fs";
import path from "path";
import { Candle, TF_MS } from "../strategy";

export interface FxCandle extends Candle {
  /** spread ask−bid trung bình của nến, cùng đơn vị giá. */
  spread: number;
}

const CACHE_DIR = path.join(process.cwd(), ".cache", "fx");

/** Mốc đóng ngày giao dịch FX: 22:00 UTC = 17:00 New York (quy ước chuẩn ngành). */
export const FX_DAY_CLOSE_UTC_HOUR = 22;

export function loadH1(symbol: string): FxCandle[] {
  const p = path.join(CACHE_DIR, `${symbol}_h1.json`);
  if (!fs.existsSync(p)) throw new Error(`Chưa có cache ${p} — chạy: python3 fx/fetch-dukascopy.py ${symbol}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as FxCandle[];
}

/**
 * Gộp H1 → khung `tf`, mốc chia bucket dịch `offsetHours` giờ so với 00:00 UTC.
 * Bucket thiếu quá nhiều giờ (nghỉ lễ, nửa phiên) bị LOẠI: một "ngày" chỉ có 3 giờ dữ liệu
 * mà vẫn đếm là 1 nến sẽ làm lookback "15 ngày" thành 15 mẩu vụn không cùng đơn vị.
 */
export function aggregateFx(h1: FxCandle[], tf: string, offsetHours = FX_DAY_CLOSE_UTC_HOUR): FxCandle[] {
  const tfMs = TF_MS[tf];
  if (!tfMs || tfMs < TF_MS["1h"]) throw new Error(`TF không hợp lệ cho FX: ${tf}`);
  const offsetMs = offsetHours * TF_MS["1h"];
  const expected = tfMs / TF_MS["1h"];
  const minBars = Math.max(1, Math.ceil(expected / 3));

  const buckets = new Map<number, FxCandle[]>();
  for (const c of h1) {
    const start = Math.floor((c.openTime - offsetMs) / tfMs) * tfMs + offsetMs;
    let g = buckets.get(start);
    if (!g) buckets.set(start, (g = []));
    g.push(c);
  }

  const out: FxCandle[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const g = buckets.get(key)!.sort((a, b) => a.openTime - b.openTime);
    if (g.length < minBars) continue;
    let high = -Infinity, low = Infinity, volume = 0, spreadVol = 0;
    for (const c of g) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
      spreadVol += c.spread;
    }
    out.push({
      openTime: key,
      open: g[0].open,
      high,
      low,
      close: g[g.length - 1].close,
      volume,
      spread: spreadVol / g.length,
    });
  }
  return out;
}

/** Spread TRUNG VỊ của cả mẫu, tính theo % giá — đầu vào cho mô hình chi phí. */
export function medianSpreadPct(candles: FxCandle[]): number {
  const v = candles.map((c) => (c.spread / c.close) * 100).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

/** Cắt theo khoảng thời gian [from, to) — dùng cho era-split và holdout OOS. */
export function slice<T extends Candle>(candles: T[], fromMs: number, toMs: number): T[] {
  return candles.filter((c) => c.openTime >= fromMs && c.openTime < toMs);
}

export function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
