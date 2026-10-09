/**
 * types.ts — Định nghĩa kiểu dữ liệu và tiện ích nến cơ bản dùng chung
 * cho FX Dream và Bot Chart.
 */

export interface Candle {
  openTime: number; // ms, thời điểm mở nến
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base asset volume (vd: số BTC)
  quoteVolume?: number; // quote volume (vd: USDT) — "dollar volume"
  takerBuyVolume?: number; // base volume của lệnh taker MUA (để tính delta/CVD)
}

export const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export function timeframeMs(tf: string): number {
  const ms = TF_MS[tf];
  if (!ms) throw new Error(`Timeframe không hỗ trợ: ${tf}`);
  return ms;
}

/** Gộp mảng nến nhỏ thành nến lớn hơn. Chỉ trả về bucket đã đủ/đóng. */
export function aggregate(base: Candle[], targetTf: string, baseTf: string): Candle[] {
  const factor = TF_MS[targetTf] / TF_MS[baseTf];
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Không gộp được ${baseTf} -> ${targetTf}`);
  }
  const tfMs = TF_MS[targetTf];
  const buckets = new Map<number, Candle[]>();
  for (const c of base) {
    // Unix epoch bắt đầu vào thứ Năm; dịch 3 ngày để bucket tuần bắt đầu thứ Hai UTC.
    const weekOffset = targetTf === "1w" ? 3 * TF_MS["1d"] : 0;
    const bucketStart = Math.floor((c.openTime + weekOffset) / tfMs) * tfMs - weekOffset;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart)!.push(c);
  }
  const out: Candle[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const group = buckets.get(key)!.sort((a, b) => a.openTime - b.openTime);
    out.push({
      openTime: key,
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
      quoteVolume: group.reduce((s, g) => s + (g.quoteVolume ?? 0), 0),
      takerBuyVolume: group.reduce((s, g) => s + (g.takerBuyVolume ?? 0), 0),
    });
  }
  return out;
}

export interface Swing {
  index: number;
  price: number;
  type: "high" | "low";
  confirmIndex: number;
}

/** Tìm swing high/low theo pivot. Pivot xác nhận sau `right` nến. */
export function findSwings(candles: Candle[], left = 3, right = 3): Swing[] {
  const swings: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left; k++) {
      if (candles[i - k].high >= h) isHigh = false;
      if (candles[i - k].low <= l) isLow = false;
    }
    for (let k = 1; k <= right; k++) {
      if (candles[i + k].high > h) isHigh = false;
      if (candles[i + k].low < l) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: h, type: "high", confirmIndex: i + right });
    if (isLow) swings.push({ index: i, price: l, type: "low", confirmIndex: i + right });
  }
  return swings;
}

export function lastConfirmedSwing(
  candles: Candle[],
  i: number,
  type: "high" | "low",
  left = 3,
  right = 3,
  window = 40,
  minPivotIndex = 0
): { index: number; price: number } | null {
  for (let p = i - right; p >= Math.max(left, i - window, minPivotIndex); p--) {
    const ref = type === "high" ? candles[p].high : candles[p].low;
    let ok = true;
    for (let k = 1; k <= left && ok; k++) {
      const v = type === "high" ? candles[p - k].high : candles[p - k].low;
      if (type === "high" ? v >= ref : v <= ref) ok = false;
    }
    for (let k = 1; k <= right && ok; k++) {
      const v = type === "high" ? candles[p + k].high : candles[p + k].low;
      if (type === "high" ? v > ref : v < ref) ok = false;
    }
    if (ok) return { index: p, price: ref };
  }
  return null;
}

export const CONFIG = {
  symbols: ["btcusdt", "xauusdt", "solusdt", "xrpusdt", "dogeusdt"],
  entryTf: "15m",
  maxStopPct: 0.065,
  costs: {
    enabled: true,
    takerFeePct: 0.05, // % mỗi chiều (Binance USDⓈ-M VIP0 taker)
    slippagePct: 0.02, // % mỗi chiều (ước lượng)
    fundingPer8hPct: 0.01, // % mỗi mốc funding 8h khi giữ lệnh
  },
};
