/**
 * strategy.ts — Logic chiến lược swing đa khung (dùng chung cho bot live & backtest)
 *
 * Ý tưởng (theo style SMC / price-action):
 *   1. HTF (4h + 1h): xác định market structure (BOS/CHoCH) -> bias Long/Short
 *   2. HTF: tìm "vùng phản ứng có volume" (order block)
 *        - Nến trong quá khứ kích volume mạnh -> tạo vùng cung/cầu
 *        - ƯU TIÊN vùng FRESH (chưa bị giá quay lại "mitigate") — đây là vùng mạnh nhất
 *   3. LTF (15m): khi giá tap vào vùng cùng hướng bias + nến confirm có volume + delta cùng hướng
 *        -> tín hiệu vào lệnh
 *   4. SL đặt ngoài vùng; trailing = kéo SL theo swing/vùng đã clear
 *
 * Cải tiến đã áp dụng:
 *   (A) Vùng FRESH: bỏ yêu cầu "reactivations>=1" (đang ngược lý thuyết SMC).
 *       Thay bằng đếm `mitigations` (số lần giá quay lại chạm vùng) — càng ÍT chạm càng mạnh.
 *   (C) Volume nâng cấp: dùng dollar/quote volume, tùy chọn RVOL theo giờ trong ngày,
 *       và CVD/volume delta (taker-buy ratio) để xác nhận HƯỚNG, không chỉ "có volume".
 *
 * Toàn bộ hàm ở đây THUẦN (pure), không lookahead nếu được gọi đúng index.
 */

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
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

export type Bias = "bull" | "bear" | "neutral";
export type ZoneType = "demand" | "supply";

export interface Zone {
  type: ZoneType;
  low: number; // biên dưới vùng
  high: number; // biên trên vùng
  mid: number;
  originIndex: number; // index nến tạo vùng (trên HTF)
  baseVolRatio: number; // volume khi tạo vùng / avg
  mitigations: number; // số lần giá QUAY LẠI chạm vùng sau origin (càng nhiều -> càng YẾU)
  lastTouchIndex: number;
  displAtr: number; // độ mạnh cú rời vùng (displacement) tính theo ATR — dấu chân MM
}

export interface EntrySignal {
  direction: "long" | "short";
  entry: number;
  initialSL: number;
  initialTarget: number;
  riskPct: number; // |entry - SL| / entry
  rr: number; // (target-entry)/(entry-SL)
  zone: Zone;
  reason: string;
  htfBias: Bias;
}

// ─────────────────────────────────────────────
// CONFIG — chỉnh tham số chiến lược tại đây
// ─────────────────────────────────────────────
export const CONFIG = {
  symbol: "btcusdt",
  // (F) Danh sách symbol cho backtest. Rổ NET dương + corr P&L ≈ 0 (breadth thật ~3.3):
  // BTC+SOL+XRP+DOGE → 46 lệnh, +44.79R, Sharpe ngày 4.16 (vs BTC-only 3.28).
  // (Override qua arg, vd `... 250 1 btcusdt` để test riêng 1 coin.)
  symbols: ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"],

  // Khung entry (LTF) và các khung xác định bias/vùng (HTF)
  entryTf: "15m",
  htfBiasTf: "4h", // khung quyết định bias chính
  htfZoneTf: "1h", // khung dựng vùng order block

  // ── Volume (C: nâng cấp lọc volume) ──
  volAvgPeriod: 20,
  volSpikeMult: 2.0, // nến >= 2x avg => "kích volume" (tạo vùng)
  ltfConfirmVolMult: 1.3, // nến 15m confirm cần volume >= 1.3x avg
  useQuoteVolume: true, // dùng dollar (quote) volume thay vì base volume
  useTimeOfDayRVOL: false, // chuẩn hoá volume theo giờ-trong-ngày (cần warmup nhiều ngày)
  rvolLookbackDays: 20, // số ngày nhìn lại cho RVOL theo giờ
  useDelta: true, // yêu cầu CVD/volume delta cùng hướng (xác nhận HƯỚNG)
  deltaBuyMin: 0.55, // demand/long: taker-buy ratio >= 0.55 ; supply/short: <= 1 - 0.55

  // Swing pivot (market structure)
  pivotLeft: 3,
  pivotRight: 3,

  // ── Vùng (A: ưu tiên vùng FRESH) ──
  zoneTolPct: 0.0018, // gộp 2 vùng nếu cách nhau < 0.18%
  zoneLookbackBars: 300, // số nến HTF nhìn lại để dựng vùng
  maxZoneAgeBars: 240, // vùng quá cũ thì bỏ
  zoneTapTolPct: 0.0015, // giá coi như "tap" vùng nếu lọt vào vùng +- 0.15%
  maxZoneMitigations: 1, // 0 = chỉ vùng FRESH; 1 = cho phép đã bị chạm tối đa 1 lần (was: reactivations>=1)

  // Rủi ro
  slBufferPct: 0.0025, // đệm SL ngoài biên vùng 0.25%
  maxStopPct: 0.05, // SL xa hơn 5% thì bỏ qua (setup xấu)
  targetRR: 2.5, // target ban đầu = 2.5R (để tham chiếu/fallback)

  // Quản lý lệnh (đơn vị: số nến 15m, 96 nến = 1 ngày)
  maxHoldBars: 96 * 10, // giữ tối đa ~10 ngày. Gate rổ 250d +47.51R & 500d +65.90R (vs 7d +44.79/+63.50);
  // plateau trơn 9-14d, đỉnh ở 10d trên CẢ 2 cửa sổ, dương cả nửa cũ/mới → để winner swing chạy, ít cắt non.
  cooldownBars: 48, // sau khi đóng lệnh chờ ~12h mới tìm lệnh mới (đánh chậm)
  trailEnabled: true,
  breakevenEnabled: false, // (D) MẶC ĐỊNH TẮT — nghiên cứu cho thấy dời BE theo R cố định giảm EV
  breakevenAtR: 1.0, // chỉ dùng khi breakevenEnabled = true
  trailStartR: 2.0, // sau +2R mới trail swing 1h (gate 250d BTC: +NET vs 1.5R)

  // Entry 2 bước (ARM tap vùng -> CONFIRM bằng BOS)
  setupExpiryBars: 24, // pending setup hết hạn sau ~6h (24 nến 15m) nếu chưa confirm
  zoneInvalidationPct: 0.004, // đóng cửa thủng vùng quá 0.4% -> huỷ setup
  zoneInvalidationUseWick: false, // true = huỷ khi wick thủng vùng (không chỉ close)
  minBarsAfterArm: 3, // tối thiểu số nến 15m sau ARM trước CONFIRM (gate 250d: +NET vs 0)
  bosSwingMinPivotAfterArm: false, // BOS chỉ dùng swing có pivot >= armedIndex
  confirmCloseLocationMin: 0, // CLV tối thiểu (long: close ở nửa trên); 0 = tắt
  confirmRequireWickRejection: false,
  confirmRejectHighVolLowBody: false, // vol cao + body nhỏ -> bỏ (trap)
  confirmMaxExtensionAboveZonePct: 0, // long: entry không quá xa trên zone (0 = tắt)
  confirmMaxExtensionBelowZonePct: 0, // short: entry không quá xa dưới zone
  requirePullbackRetestZone: false, // pullback phải chạm lại vùng sau ARM
  minPullbackRiskFrac: 0, // độ sâu pullback tối thiểu tính theo R (0 = tắt)
  minEntryRR: 0, // bỏ tín hiệu nếu RR tới target < ngưỡng (0 = tắt)
  deltaStrict: false, // true = thiếu taker-buy data thì không pass delta

  // ── Thanh khoản (liquidity / stop-hunt) — thử nghiệm, mặc định TẮT ──
  // (#1) Chỉ ARM khi trước đó có cú QUÉT thanh khoản: giá thủng 1 swing 15m đã
  //      xác nhận (gom stop) rồi ĐÓNG CỬA hồi lại qua nó (reclaim). Lọc tap thụ động.
  requireLiquiditySweep: false,
  sweepLookbackBars: 20, // cửa sổ 15m tìm swing bị quét
  // (#4) Chỉ long ở nửa DƯỚI (discount) range HTF, short ở nửa TRÊN (premium).
  requireDiscountPremium: false,
  // (#2) Target = pool thanh khoản đối diện (swing 1h chưa bị lấy) thay vì vùng OB/RR.
  targetOppositeLiquidity: false,

  // ── FTR (Kudakwashe — Failure to Return) — thử nghiệm, mặc định TẮT ──
  // (FTR-a) Vùng chỉ hợp lệ nếu cú RỜI vùng là impulsive (displacement) — đặc trưng
  //         "phá mạnh + không quay lại". Lọc order block rác → chỉ giữ FTR thật.
  requireDisplacement: false,
  displacementWindow: 3, // số nến HTF sau origin để đo cú bứt phá
  displacementMult: 1.0, // biên độ rời vùng >= mult × range nến origin

  // ── Fair Value Gap (FVG / imbalance) — dấu chân MM, mặc định TẮT ──
  // FVG 3-nến: bullish nếu high[k-2] < low[k] (gap chưa lấp) → vùng demand.
  // fvgMode: "off" = chỉ OB | "add" = OB + FVG | "only" = chỉ FVG.
  fvgMode: "off" as "off" | "add" | "only",
  fvgMinAtrFrac: 0, // bỏ FVG có gap < frac × ATR (0 = lấy hết)

  // ── Chi phí giao dịch (B) — dùng trong backtest để ra con số NET ──
  costs: {
    enabled: true,
    takerFeePct: 0.05, // % mỗi chiều (Binance USDⓈ-M VIP0 taker)
    slippagePct: 0.02, // % mỗi chiều (ước lượng)
    fundingPer8hPct: 0.01, // % mỗi mốc funding 8h khi giữ lệnh (drag, không phân biệt hướng)
  },
};

// ─────────────────────────────────────────────
// AGGREGATION — gộp nến LTF -> HTF (không lookahead)
// ─────────────────────────────────────────────
export const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const DAY_MS = TF_MS["1d"];

/** Gộp mảng nến nhỏ thành nến lớn hơn. Chỉ trả về bucket đã đủ/đóng. */
export function aggregate(base: Candle[], targetTf: string, baseTf: string): Candle[] {
  const factor = TF_MS[targetTf] / TF_MS[baseTf];
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`Không gộp được ${baseTf} -> ${targetTf}`);
  }
  const tfMs = TF_MS[targetTf];
  const buckets = new Map<number, Candle[]>();
  for (const c of base) {
    const bucketStart = Math.floor(c.openTime / tfMs) * tfMs;
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

/** Số nến HTF đã ĐÓNG hoàn toàn tính tới thời điểm 1 nến LTF đóng cửa. */
export function htfClosedCount(htf: Candle[], ltfCandleCloseTime: number): number {
  // nến HTF j đóng tại openTime + tfMs; usable nếu đã đóng <= ltf close time
  let count = 0;
  for (let i = 0; i < htf.length; i++) {
    const closeT = htf[i].openTime + closeTimeGuess(htf);
    if (closeT <= ltfCandleCloseTime) count = i + 1;
    else break;
  }
  return count;
}

function closeTimeGuess(htf: Candle[]): number {
  if (htf.length < 2) return TF_MS["1h"];
  return htf[1].openTime - htf[0].openTime;
}

// ─────────────────────────────────────────────
// VOLUME HELPERS (C)
// ─────────────────────────────────────────────
/** Volume dùng để so sánh: dollar (quote) volume nếu bật & có, ngược lại base volume. */
export function candleVol(c: Candle): number {
  if (CONFIG.useQuoteVolume && c.quoteVolume != null && c.quoteVolume > 0) return c.quoteVolume;
  return c.volume;
}

/** Tỉ lệ khối lượng taker MUA / tổng (proxy cho delta). null nếu thiếu dữ liệu. */
export function candleBuyRatio(c: Candle): number | null {
  if (c.takerBuyVolume == null || c.volume <= 0) return null;
  const r = c.takerBuyVolume / c.volume;
  if (!Number.isFinite(r)) return null;
  return Math.min(1, Math.max(0, r));
}

/** Kiểm tra delta có cùng hướng không. Thiếu dữ liệu: pass trừ khi deltaStrict. */
function deltaAligned(c: Candle, dir: "demand" | "supply"): boolean {
  if (!CONFIG.useDelta) return true;
  const r = candleBuyRatio(c);
  if (r == null) return !CONFIG.deltaStrict;
  return dir === "demand" ? r >= CONFIG.deltaBuyMin : r <= 1 - CONFIG.deltaBuyMin;
}

function tfMsOf(candles: Candle[]): number {
  return candles.length > 1 ? candles[1].openTime - candles[0].openTime : TF_MS["1h"];
}

export function rollingAvgVolume(candles: Candle[], endIdx: number, period: number): number {
  const start = Math.max(0, endIdx - period);
  const slice = candles.slice(start, endIdx); // KHÔNG tính nến hiện tại
  if (slice.length === 0) return 0;
  return slice.reduce((s, c) => s + candleVol(c), 0) / slice.length;
}

/** Trung bình volume tại CÙNG giờ-trong-ngày qua `days` ngày gần nhất (RVOL). */
export function rvolByTimeOfDay(candles: Candle[], endIdx: number, days: number): number {
  if (endIdx <= 0) return 0;
  const slot = candles[endIdx].openTime % DAY_MS;
  let sum = 0;
  let n = 0;
  for (let k = endIdx - 1; k >= 0 && n < days; k--) {
    if (candles[k].openTime % DAY_MS === slot) {
      sum += candleVol(candles[k]);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Baseline volume để so spike: RVOL theo giờ (nếu bật & đủ dữ liệu) hoặc rolling avg. */
export function avgVol(candles: Candle[], endIdx: number): number {
  if (CONFIG.useTimeOfDayRVOL) {
    const r = rvolByTimeOfDay(candles, endIdx, CONFIG.rvolLookbackDays);
    if (r > 0) return r;
  }
  return rollingAvgVolume(candles, endIdx, CONFIG.volAvgPeriod);
}

// ─────────────────────────────────────────────
// INDICATORS / STRUCTURE
// ─────────────────────────────────────────────
export interface Swing {
  index: number;
  price: number;
  type: "high" | "low";
  confirmIndex: number; // thời điểm xác nhận được pivot (index + right)
}

/** Tìm swing high/low theo pivot. Pivot xác nhận sau `right` nến. */
export function findSwings(candles: Candle[], left = CONFIG.pivotLeft, right = CONFIG.pivotRight): Swing[] {
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

/** Swing high/low gần nhất ĐÃ xác nhận trước index i (quét ngược trong cửa sổ nhỏ). */
export function lastConfirmedSwing(
  candles: Candle[],
  i: number,
  type: "high" | "low",
  left = CONFIG.pivotLeft,
  right = CONFIG.pivotRight,
  window = 40,
  minPivotIndex = 0
): { index: number; price: number } | null {
  // pivot tại p chỉ xác nhận khi p + right <= i  => quét p từ (i-right) trở về
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

/** Bias theo cấu trúc HH/HL (bull) hoặc LH/LL (bear), dùng swing đã xác nhận tới atIndex. */
export function structureBias(
  swings: Swing[],
  atIndex: number
): { bias: Bias; lastHigh?: Swing; lastLow?: Swing } {
  const confirmed = swings.filter((s) => s.confirmIndex <= atIndex);
  const highs = confirmed.filter((s) => s.type === "high");
  const lows = confirmed.filter((s) => s.type === "low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  if (highs.length < 2 || lows.length < 2) return { bias: "neutral", lastHigh, lastLow };

  const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
  const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
  const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;

  let bias: Bias = "neutral";
  if (hh && hl) bias = "bull";
  else if (lh && ll) bias = "bear";
  return { bias, lastHigh, lastLow };
}

// ─────────────────────────────────────────────
// VOLUME-REACTION ZONES (order block) — (A) ưu tiên FRESH
// ─────────────────────────────────────────────
/**
 * Dựng các vùng từ những nến kích volume mạnh trong quá khứ (tới atIndex).
 * - Nến bullish + volume cao + delta MUA  -> vùng cầu (demand)
 * - Nến bearish + volume cao + delta BÁN  -> vùng cung (supply)
 * - `mitigations` = số lần giá QUAY LẠI chạm vùng sau khi tạo. Càng ít -> vùng càng FRESH/mạnh.
 */
/**
 * (FTR-a) Cú RỜI vùng có phải impulsive không? — đặc trưng "Failure to Return":
 * sau nến origin, trong `displacementWindow` nến, giá đẩy theo hướng vùng một đoạn
 * >= `displacementMult` × range nến origin. Chỉ dùng nến <= atIndex (không lookahead).
 */
/** Độ mạnh cú rời vùng (displacement) theo bội số ATR. 0 nếu thiếu dữ liệu. */
function displacementAtr(htf: Candle[], j: number, type: ZoneType, atIndex: number): number {
  // ATR (biên độ TB) của volAvgPeriod nến trước origin — chuẩn "biến động bình thường"
  const s = Math.max(0, j - CONFIG.volAvgPeriod);
  let atr = 0, n = 0;
  for (let k = s; k < j; k++) { atr += htf[k].high - htf[k].low; n++; }
  atr = n > 0 ? atr / n : 0;
  if (atr <= 0) return 0;
  const end = Math.min(atIndex, j + CONFIG.displacementWindow, htf.length - 1);
  if (end <= j) return 0;
  const origin = htf[j];
  if (type === "demand") {
    let maxHigh = -Infinity;
    for (let k = j + 1; k <= end; k++) maxHigh = Math.max(maxHigh, htf[k].high);
    return (maxHigh - origin.high) / atr;
  }
  let minLow = Infinity;
  for (let k = j + 1; k <= end; k++) minLow = Math.min(minLow, htf[k].low);
  return (origin.low - minLow) / atr;
}

function hasDisplacement(htf: Candle[], j: number, type: ZoneType, atIndex: number): boolean {
  return displacementAtr(htf, j, type, atIndex) >= CONFIG.displacementMult;
}

export function buildZones(htf: Candle[], atIndex: number): Zone[] {
  const start = Math.max(CONFIG.volAvgPeriod, atIndex - CONFIG.zoneLookbackBars);
  const raw: Zone[] = [];

  for (let j = start; j <= atIndex && j < htf.length; j++) {
    const avg = avgVol(htf, j);
    if (avg === 0) continue;
    const ratio = candleVol(htf[j]) / avg;
    if (ratio < CONFIG.volSpikeMult) continue;

    const c = htf[j];
    const bullish = c.close >= c.open;
    const type: ZoneType = bullish ? "demand" : "supply";
    // (C) delta phải cùng hướng với loại vùng
    if (!deltaAligned(c, type)) continue;
    // (FTR-a) chỉ giữ vùng có cú rời impulsive (displacement)
    if (CONFIG.requireDisplacement && !hasDisplacement(htf, j, type, atIndex)) continue;

    raw.push({
      type,
      low: Math.min(c.open, c.close, c.low),
      high: Math.max(c.open, c.close, c.high),
      mid: (c.high + c.low) / 2,
      originIndex: j,
      baseVolRatio: ratio,
      mitigations: 0,
      lastTouchIndex: j,
      displAtr: displacementAtr(htf, j, type, atIndex),
    });
  }

  // Gộp vùng gần nhau cùng loại (origin = nến spike mới nhất)
  const merged: Zone[] = [];
  for (const z of raw) {
    const hit = merged.find(
      (m) => m.type === z.type && Math.abs(m.mid - z.mid) / m.mid < CONFIG.zoneTolPct * 4
    );
    if (hit) {
      hit.low = Math.min(hit.low, z.low);
      hit.high = Math.max(hit.high, z.high);
      hit.mid = (hit.low + hit.high) / 2;
      hit.baseVolRatio = Math.max(hit.baseVolRatio, z.baseVolRatio);
      hit.displAtr = Math.max(hit.displAtr, z.displAtr);
      hit.originIndex = Math.max(hit.originIndex, z.originIndex); // vùng "tươi" tính từ spike mới nhất
      hit.lastTouchIndex = Math.max(hit.lastTouchIndex, z.lastTouchIndex);
    } else {
      merged.push({ ...z });
    }
  }

  // (A) Đếm MITIGATIONS: số lần RỜI vùng rồi QUAY LẠI chạm (mỗi lần re-enter = 1 mitigation)
  for (const z of merged) {
    let prevInside = true; // nến origin coi như đang ở trong vùng
    let mit = 0;
    for (let k = z.originIndex + 1; k <= atIndex && k < htf.length; k++) {
      const c = htf[k];
      const overlaps = c.low <= z.high && c.high >= z.low;
      if (overlaps) {
        if (!prevInside) mit++; // vừa quay lại chạm vùng
        z.lastTouchIndex = k;
      }
      prevInside = overlaps;
    }
    z.mitigations = mit;
  }

  // Bỏ vùng quá cũ
  return merged.filter((z) => atIndex - z.lastTouchIndex <= CONFIG.maxZoneAgeBars);
}

/**
 * (MM) Dựng vùng từ Fair Value Gap (imbalance) 3 nến — dấu chân nhà tạo lập.
 *  - Bullish FVG (demand): high[k-2] < low[k] (gap chưa lấp), nến giữa k-1 displacement tăng.
 *  - Bearish FVG (supply): low[k-2]  > high[k], nến giữa k-1 displacement giảm.
 * `mitigations` đếm số lần giá quay lại lấp gap (càng ít càng fresh) — như order block.
 */
export function buildFvgZones(htf: Candle[], atIndex: number): Zone[] {
  const start = Math.max(CONFIG.volAvgPeriod, atIndex - CONFIG.zoneLookbackBars);
  const out: Zone[] = [];
  for (let k = start; k <= atIndex && k < htf.length; k++) {
    if (k < 2) continue;
    const a = htf[k - 2], b = htf[k - 1], c = htf[k];
    const avg = avgVol(htf, k - 1);
    const volRatio = avg > 0 ? candleVol(b) / avg : 0;

    let zone: Zone | null = null;
    if (a.high < c.low && b.close >= b.open) {
      zone = mkFvgZone("demand", a.high, c.low, k - 1, volRatio);
    } else if (a.low > c.high && b.close <= b.open) {
      zone = mkFvgZone("supply", c.high, a.low, k - 1, volRatio);
    }
    if (!zone) continue;

    // ATR để lọc gap nhỏ + đo độ mạnh imbalance (gap/ATR)
    const s = Math.max(0, (k - 1) - CONFIG.volAvgPeriod);
    let atr = 0, n = 0;
    for (let t = s; t < k - 1; t++) { atr += htf[t].high - htf[t].low; n++; }
    atr = n > 0 ? atr / n : 0;
    const gap = zone.high - zone.low;
    if (CONFIG.fvgMinAtrFrac > 0 && atr > 0 && gap < CONFIG.fvgMinAtrFrac * atr) continue;
    zone.displAtr = atr > 0 ? gap / atr : 0;

    // mitigations: số lần giá QUAY LẠI lấp gap sau khi gap hình thành (origin = k)
    let prevInside = true, mit = 0;
    for (let t = k + 1; t <= atIndex && t < htf.length; t++) {
      const overlaps = htf[t].low <= zone.high && htf[t].high >= zone.low;
      if (overlaps) { if (!prevInside) mit++; zone.lastTouchIndex = t; }
      prevInside = overlaps;
    }
    zone.mitigations = mit;
    out.push(zone);
  }
  return out.filter((z) => atIndex - z.lastTouchIndex <= CONFIG.maxZoneAgeBars);
}

function mkFvgZone(type: ZoneType, low: number, high: number, originIndex: number, volRatio: number): Zone {
  return { type, low, high, mid: (low + high) / 2, originIndex, baseVolRatio: volRatio, mitigations: 0, lastTouchIndex: originIndex + 1, displAtr: 0 };
}

// ─────────────────────────────────────────────
// HTF CONTEXT — gói gọn bias + vùng tại 1 thời điểm
// ─────────────────────────────────────────────
export interface HtfContext {
  bias: Bias; // bias khung chính (4h)
  zoneBias: Bias; // bias khung vùng (1h) — dùng để xác nhận đồng thuận
  zones: Zone[];
  lastSwingHigh?: Swing;
  lastSwingLow?: Swing;
  zoneHighs: number[]; // giá swing-high 1h đã xác nhận (pool thanh khoản phía trên)
  zoneLows: number[]; // giá swing-low 1h đã xác nhận (pool thanh khoản phía dưới)
}

export function buildHtfContext(
  biasTf: Candle[],
  zoneTf: Candle[],
  biasSwings: Swing[],
  zoneSwings: Swing[],
  biasIdx: number,
  zoneIdx: number
): HtfContext {
  const { bias, lastHigh, lastLow } = structureBias(biasSwings, biasIdx);
  const zb = structureBias(zoneSwings, zoneIdx);
  let zones = zoneIdx >= 0 && CONFIG.fvgMode !== "only" ? buildZones(zoneTf, zoneIdx) : [];
  if (zoneIdx >= 0 && CONFIG.fvgMode !== "off") zones = zones.concat(buildFvgZones(zoneTf, zoneIdx));
  const confirmed = zoneSwings.filter((s) => s.confirmIndex <= zoneIdx);
  const zoneHighs = confirmed.filter((s) => s.type === "high").map((s) => s.price);
  const zoneLows = confirmed.filter((s) => s.type === "low").map((s) => s.price);
  return { bias, zoneBias: zb.bias, zones, lastSwingHigh: lastHigh, lastSwingLow: lastLow, zoneHighs, zoneLows };
}

// ─────────────────────────────────────────────
// LIQUIDITY HELPERS (thử nghiệm) — sweep+reclaim, discount/premium
// ─────────────────────────────────────────────
/**
 * (#1) Có cú QUÉT thanh khoản rồi reclaim không?
 *  - long : tồn tại swing-low 15m đã xác nhận trong cửa sổ, sau đó giá THỦNG xuống dưới nó
 *           (gom sell-side liquidity) và nến hiện tại ĐÓNG CỬA hồi lên trên lại.
 *  - short: đối xứng (quét buy-side phía trên rồi đóng cửa lại xuống dưới).
 * Thuần, không lookahead: swing chỉ tính khi pivot đã xác nhận (p + right <= i).
 */
function sweptAndReclaimed(ltf: Candle[], i: number, dir: "long" | "short", window: number): boolean {
  const L = CONFIG.pivotLeft;
  const R = CONFIG.pivotRight;
  const close = ltf[i].close;
  for (let p = i - R; p >= Math.max(L, i - window); p--) {
    const ref = dir === "long" ? ltf[p].low : ltf[p].high;
    let isPivot = true;
    for (let k = 1; k <= L && isPivot; k++) {
      const v = dir === "long" ? ltf[p - k].low : ltf[p - k].high;
      if (dir === "long" ? v <= ref : v >= ref) isPivot = false;
    }
    for (let k = 1; k <= R && isPivot; k++) {
      const v = dir === "long" ? ltf[p + k].low : ltf[p + k].high;
      if (dir === "long" ? v < ref : v > ref) isPivot = false;
    }
    if (!isPivot) continue;
    // đã bị quét sau khi hình thành?
    let swept = false;
    for (let k = p + 1; k <= i; k++) {
      const v = dir === "long" ? ltf[k].low : ltf[k].high;
      if (dir === "long" ? v < ref : v > ref) {
        swept = true;
        break;
      }
    }
    if (!swept) continue;
    // reclaim: nến hiện tại đóng cửa quay lại đúng phía
    if (dir === "long" ? close > ref : close < ref) return true;
  }
  return false;
}

/** (#4) Giá đang ở discount (long) / premium (short) của range HTF (swing 4h gần nhất)? */
function inDiscountPremium(ctx: HtfContext, dir: "long" | "short", price: number): boolean {
  const hi = ctx.lastSwingHigh?.price;
  const lo = ctx.lastSwingLow?.price;
  if (hi == null || lo == null || hi <= lo) return true; // thiếu range -> không chặn
  const mid = (hi + lo) / 2;
  return dir === "long" ? price <= mid : price >= mid;
}

/** Lọc + xếp hạng vùng demand hợp lệ để LONG: fresh nhất + gần giá nhất. */
function pickDemand(zones: Zone[], tapLow: number, tapClose: number): Zone | undefined {
  const tol = CONFIG.zoneTapTolPct;
  return zones
    .filter((z) => z.type === "demand")
    .filter((z) => z.mitigations <= CONFIG.maxZoneMitigations) // (A) ưu tiên FRESH
    .filter((z) => tapLow <= z.high * (1 + tol) && tapClose > z.low) // tap vào vùng & hồi lên
    .sort((a, b) => a.mitigations - b.mitigations || b.mid - a.mid) // ít chạm trước, rồi gần giá nhất
[0];
}

/** Lọc + xếp hạng vùng supply hợp lệ để SHORT: fresh nhất + gần giá nhất. */
function pickSupply(zones: Zone[], tapHigh: number, tapClose: number): Zone | undefined {
  const tol = CONFIG.zoneTapTolPct;
  return zones
    .filter((z) => z.type === "supply")
    .filter((z) => z.mitigations <= CONFIG.maxZoneMitigations) // (A) ưu tiên FRESH
    .filter((z) => tapHigh >= z.low * (1 - tol) && tapClose < z.high)
    .sort((a, b) => a.mitigations - b.mitigations || a.mid - b.mid)[0];
}

function confirmCandleQuality(c: Candle, direction: "long" | "short", volRatio: number): boolean {
  const range = c.high - c.low;
  if (range <= 0) return false;
  const closePos = (c.close - c.low) / range;
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);

  const clvMin = CONFIG.confirmCloseLocationMin;
  if (clvMin > 0) {
    if (direction === "long" && closePos < clvMin) return false;
    if (direction === "short" && closePos > 1 - clvMin) return false;
  }
  if (CONFIG.confirmRequireWickRejection) {
    if (direction === "long" && lowerWick <= upperWick) return false;
    if (direction === "short" && upperWick <= lowerWick) return false;
  }
  if (CONFIG.confirmRejectHighVolLowBody && volRatio >= CONFIG.ltfConfirmVolMult) {
    if (body / range <= 0.35) return false;
  }
  return true;
}

function zoneInvalidated(c: Candle, p: PendingSetup): boolean {
  const pct = CONFIG.zoneInvalidationPct;
  if (p.direction === "long") {
    const level = p.zone.low * (1 - pct);
    return CONFIG.zoneInvalidationUseWick ? c.low < level : c.close < level;
  }
  const level = p.zone.high * (1 + pct);
  return CONFIG.zoneInvalidationUseWick ? c.high > level : c.close > level;
}

function pullbackRetestedZone(ltf: Candle[], p: PendingSetup, i: number): boolean {
  if (!CONFIG.requirePullbackRetestZone) return true;
  const tol = CONFIG.zoneTapTolPct;
  for (let k = p.armedIndex + 1; k <= i; k++) {
    const bar = ltf[k];
    if (p.direction === "long") {
      if (bar.low <= p.zone.high * (1 + tol) && bar.low >= p.zone.low * (1 - CONFIG.zoneInvalidationPct)) return true;
    } else if (bar.high >= p.zone.low * (1 - tol) && bar.high <= p.zone.high * (1 + CONFIG.zoneInvalidationPct)) {
      return true;
    }
  }
  return false;
}

function minPullbackDepthOk(ltf: Candle[], p: PendingSetup, i: number, entry: number): boolean {
  const frac = CONFIG.minPullbackRiskFrac;
  if (frac <= 0) return true;
  const sl =
    p.direction === "long"
      ? Math.min(p.zone.low, p.extreme) * (1 - CONFIG.slBufferPct)
      : Math.max(p.zone.high, p.extreme) * (1 + CONFIG.slBufferPct);
  const risk = p.direction === "long" ? entry - sl : sl - entry;
  if (risk <= 0) return false;
  if (p.direction === "long") {
    let peak = -Infinity;
    for (let k = p.armedIndex; k < i; k++) peak = Math.max(peak, ltf[k].high);
    return peak - p.extreme >= frac * risk;
  }
  let trough = Infinity;
  for (let k = p.armedIndex; k < i; k++) trough = Math.min(trough, ltf[k].low);
  return p.extreme - trough >= frac * risk;
}

function confirmExtensionOk(entry: number, p: PendingSetup): boolean {
  if (p.direction === "long") {
    const maxPct = CONFIG.confirmMaxExtensionAboveZonePct;
    if (maxPct > 0 && entry > p.zone.high * (1 + maxPct)) return false;
  } else {
    const maxPct = CONFIG.confirmMaxExtensionBelowZonePct;
    if (maxPct > 0 && entry < p.zone.low * (1 - maxPct)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// ENTRY — đánh giá tín hiệu trên nến LTF (15m)
// ─────────────────────────────────────────────
/**
 * Trả về tín hiệu nếu nến 15m vừa đóng (ltf[i]) tạo setup vào lệnh.
 * Điều kiện LONG:
 *   - HTF bias bull (4h & 1h đồng thuận)
 *   - có vùng demand FRESH nằm dưới/ngay giá hiện tại
 *   - nến 15m tap vào vùng (low chạm vùng) nhưng đóng cửa hồi lên trên vùng
 *   - nến 15m là nến tăng + volume >= ltfConfirmVolMult * avg + delta MUA
 * SHORT đối xứng với vùng supply.
 */
export function evaluateEntry(ltf: Candle[], i: number, ctx: HtfContext): EntrySignal | null {
  if (i < CONFIG.volAvgPeriod) return null;
  if (ctx.bias === "neutral") return null;
  // Yêu cầu 4h và 1h đồng thuận hướng (confluence đa khung)
  if (ctx.bias !== ctx.zoneBias) return null;

  const c = ltf[i];
  const avgV = avgVol(ltf, i);
  if (avgV === 0) return null;
  const volRatio = candleVol(c) / avgV;
  if (volRatio < CONFIG.ltfConfirmVolMult) return null;

  const bullish = c.close > c.open;

  const range = c.high - c.low;
  if (range <= 0) return null;
  const closePos = (c.close - c.low) / range; // 1 = đóng sát đỉnh, 0 = đóng sát đáy
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);

  // Swing 15m gần nhất đã xác nhận (để check micro-BOS)
  const minorHigh = lastConfirmedSwing(ltf, i, "high");
  const minorLow = lastConfirmedSwing(ltf, i, "low");

  if (ctx.bias === "bull" && bullish) {
    // nến confirm phải có wick từ chối phía dưới + đóng cửa nửa trên
    if (closePos < 0.55 || lowerWick <= upperWick) return null;
    // (C) delta MUA xác nhận
    if (!deltaAligned(c, "demand")) return null;
    // micro-BOS: nến confirm phải phá đỉnh swing 15m gần nhất (cấu trúc đảo lên)
    if (!minorHigh || c.close <= minorHigh.price) return null;

    const zone = pickDemand(ctx.zones, c.low, c.close);
    if (!zone) return null;

    const entry = c.close;
    // SL dưới đáy wick HOẶC biên dưới vùng (cái nào thấp hơn) — tránh bị quét non
    const initialSL = Math.min(zone.low, c.low) * (1 - CONFIG.slBufferPct);
    const riskPct = (entry - initialSL) / entry;
    if (riskPct <= 0 || riskPct > CONFIG.maxStopPct) return null;

    // target: vùng supply gần nhất phía trên, fallback = targetRR
    const supplyAbove = ctx.zones
      .filter((z) => z.type === "supply" && z.low > entry)
      .sort((a, b) => a.low - b.low)[0];
    const rrTarget = entry + CONFIG.targetRR * (entry - initialSL);
    const initialTarget = supplyAbove ? Math.max(supplyAbove.low, entry + (entry - initialSL)) : rrTarget;
    const rr = (initialTarget - entry) / (entry - initialSL);

    return {
      direction: "long",
      entry,
      initialSL,
      initialTarget,
      riskPct,
      rr,
      zone,
      htfBias: ctx.bias,
      reason: `Demand FRESH $${zone.low.toFixed(0)}-${zone.high.toFixed(0)} (vol gốc ${zone.baseVolRatio.toFixed(1)}x, mitig ${zone.mitigations}); nến 15m hồi +vol ${volRatio.toFixed(1)}x; HTF bull`,
    };
  }

  if (ctx.bias === "bear" && !bullish) {
    // nến confirm phải có wick từ chối phía trên + đóng cửa nửa dưới
    if (closePos > 0.45 || upperWick <= lowerWick) return null;
    // (C) delta BÁN xác nhận
    if (!deltaAligned(c, "supply")) return null;
    // micro-BOS: nến confirm phải phá đáy swing 15m gần nhất (cấu trúc đảo xuống)
    if (!minorLow || c.close >= minorLow.price) return null;

    const zone = pickSupply(ctx.zones, c.high, c.close);
    if (!zone) return null;

    const entry = c.close;
    const initialSL = Math.max(zone.high, c.high) * (1 + CONFIG.slBufferPct);
    const riskPct = (initialSL - entry) / entry;
    if (riskPct <= 0 || riskPct > CONFIG.maxStopPct) return null;

    const demandBelow = ctx.zones
      .filter((z) => z.type === "demand" && z.high < entry)
      .sort((a, b) => b.high - a.high)[0];
    const rrTarget = entry - CONFIG.targetRR * (initialSL - entry);
    const initialTarget = demandBelow ? Math.min(demandBelow.high, entry - (initialSL - entry)) : rrTarget;
    const rr = (entry - initialTarget) / (initialSL - entry);

    return {
      direction: "short",
      entry,
      initialSL,
      initialTarget,
      riskPct,
      rr,
      zone,
      htfBias: ctx.bias,
      reason: `Supply FRESH $${zone.low.toFixed(0)}-${zone.high.toFixed(0)} (vol gốc ${zone.baseVolRatio.toFixed(1)}x, mitig ${zone.mitigations}); nến 15m rejection +vol ${volRatio.toFixed(1)}x; HTF bear`,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
// ENTRY 2 BƯỚC: ARM (tap vùng) -> CONFIRM (BOS 15m)
// ─────────────────────────────────────────────
/**
 * Khác evaluateEntry (gộp mọi điều kiện vào 1 nến), tracker này tách rời:
 *   Bước 1 (ARM)     : giá tap vào vùng order block FRESH cùng hướng bias -> ghi nhận setup chờ
 *   Bước 2 (CONFIRM) : các nến sau pullback tạo đáy/đỉnh, khi nến đóng cửa PHÁ swing 15m
 *                      gần nhất theo hướng bias (BOS) + có volume + delta -> mới vào lệnh
 * Huỷ setup nếu: đóng cửa thủng vùng, bias đảo chiều, hoặc quá hạn.
 */
export interface PendingSetup {
  direction: "long" | "short";
  zone: Zone;
  armedIndex: number;
  extreme: number; // đáy được bảo vệ (long) / đỉnh được bảo vệ (short) trong lúc pullback
  extremeIndex: number;
}

export class SetupTracker {
  pending: PendingSetup | null = null;

  reset() {
    this.pending = null;
  }

  /** Gọi mỗi nến khi đang flat. Trả EntrySignal khi CONFIRM, ngược lại null. */
  update(ltf: Candle[], i: number, ctx: HtfContext): EntrySignal | null {
    if (i < CONFIG.volAvgPeriod + 1) return null;
    const c = ltf[i];

    // Bias phải rõ ràng & 2 khung đồng thuận, nếu không -> bỏ pending
    if (ctx.bias === "neutral" || ctx.bias !== ctx.zoneBias) {
      this.pending = null;
      return null;
    }

    // Chưa có setup -> thử ARM
    if (!this.pending) {
      this.tryArm(ltf, i, ctx);
      return null;
    }

    const p = this.pending;

    // Hết hạn chờ confirm
    if (i - p.armedIndex > CONFIG.setupExpiryBars) {
      this.pending = null;
      return null;
    }
    // Bias đảo ngược hướng setup -> huỷ
    if ((p.direction === "long" && ctx.bias !== "bull") || (p.direction === "short" && ctx.bias !== "bear")) {
      this.pending = null;
      return null;
    }

    const avgV = avgVol(ltf, i);
    const volRatio = avgV > 0 ? candleVol(c) / avgV : 0;
    const prev = ltf[i - 1];

    if (p.direction === "long") {
      if (c.low < p.extreme) {
        p.extreme = c.low;
        p.extremeIndex = i;
      }
      if (zoneInvalidated(c, p)) {
        this.pending = null;
        return null;
      }
      if (CONFIG.minBarsAfterArm > 0 && i - p.armedIndex < CONFIG.minBarsAfterArm) return null;
      if (!pullbackRetestedZone(ltf, p, i)) return null;

      const minPivot = CONFIG.bosSwingMinPivotAfterArm ? p.armedIndex : 0;
      const trig = lastConfirmedSwing(ltf, i, "high", CONFIG.pivotLeft, CONFIG.pivotRight, 40, minPivot);
      const fresh = trig && prev.close <= trig.price && c.close > trig.price;
      if (
        trig &&
        fresh &&
        c.close > c.open &&
        volRatio >= CONFIG.ltfConfirmVolMult &&
        deltaAligned(c, "demand") &&
        confirmCandleQuality(c, "long", volRatio) &&
        confirmExtensionOk(c.close, p) &&
        minPullbackDepthOk(ltf, p, i, c.close)
      ) {
        const sig = this.buildLong(c, p, volRatio, trig.price, ctx);
        if (sig) this.pending = null;
        return sig;
      }
      return null;
    } else {
      if (c.high > p.extreme) {
        p.extreme = c.high;
        p.extremeIndex = i;
      }
      if (zoneInvalidated(c, p)) {
        this.pending = null;
        return null;
      }
      if (CONFIG.minBarsAfterArm > 0 && i - p.armedIndex < CONFIG.minBarsAfterArm) return null;
      if (!pullbackRetestedZone(ltf, p, i)) return null;

      const minPivot = CONFIG.bosSwingMinPivotAfterArm ? p.armedIndex : 0;
      const trig = lastConfirmedSwing(ltf, i, "low", CONFIG.pivotLeft, CONFIG.pivotRight, 40, minPivot);
      const fresh = trig && prev.close >= trig.price && c.close < trig.price;
      if (
        trig &&
        fresh &&
        c.close < c.open &&
        volRatio >= CONFIG.ltfConfirmVolMult &&
        deltaAligned(c, "supply") &&
        confirmCandleQuality(c, "short", volRatio) &&
        confirmExtensionOk(c.close, p) &&
        minPullbackDepthOk(ltf, p, i, c.close)
      ) {
        const sig = this.buildShort(c, p, volRatio, trig.price, ctx);
        if (sig) this.pending = null;
        return sig;
      }
      return null;
    }
  }

  private tryArm(ltf: Candle[], i: number, ctx: HtfContext) {
    const c = ltf[i];
    const tol = CONFIG.zoneTapTolPct;
    if (ctx.bias === "bull") {
      const zone = ctx.zones
        .filter((z) => z.type === "demand" && z.mitigations <= CONFIG.maxZoneMitigations) // (A) FRESH
        .filter((z) => c.low <= z.high * (1 + tol) && c.close > z.low * (1 - CONFIG.zoneInvalidationPct))
        .sort((a, b) => a.mitigations - b.mitigations || b.mid - a.mid)[0];
      if (!zone) return;
      if (CONFIG.requireLiquiditySweep && !sweptAndReclaimed(ltf, i, "long", CONFIG.sweepLookbackBars)) return;
      if (CONFIG.requireDiscountPremium && !inDiscountPremium(ctx, "long", c.close)) return;
      this.pending = { direction: "long", zone, armedIndex: i, extreme: c.low, extremeIndex: i };
    } else if (ctx.bias === "bear") {
      const zone = ctx.zones
        .filter((z) => z.type === "supply" && z.mitigations <= CONFIG.maxZoneMitigations) // (A) FRESH
        .filter((z) => c.high >= z.low * (1 - tol) && c.close < z.high * (1 + CONFIG.zoneInvalidationPct))
        .sort((a, b) => a.mitigations - b.mitigations || a.mid - b.mid)[0];
      if (!zone) return;
      if (CONFIG.requireLiquiditySweep && !sweptAndReclaimed(ltf, i, "short", CONFIG.sweepLookbackBars)) return;
      if (CONFIG.requireDiscountPremium && !inDiscountPremium(ctx, "short", c.close)) return;
      this.pending = { direction: "short", zone, armedIndex: i, extreme: c.high, extremeIndex: i };
    }
  }

  private buildLong(c: Candle, p: PendingSetup, volRatio: number, bosLevel: number, ctx: HtfContext): EntrySignal | null {
    const entry = c.close;
    const initialSL = Math.min(p.zone.low, p.extreme) * (1 - CONFIG.slBufferPct);
    const riskPct = (entry - initialSL) / entry;
    if (riskPct <= 0 || riskPct > CONFIG.maxStopPct) return null;
    const supplyAbove = ctx.zones.filter((z) => z.type === "supply" && z.low > entry).sort((a, b) => a.low - b.low)[0];
    const rrTarget = entry + CONFIG.targetRR * (entry - initialSL);
    let initialTarget = supplyAbove ? Math.max(supplyAbove.low, entry + (entry - initialSL)) : rrTarget;
    if (CONFIG.targetOppositeLiquidity) {
      // (#2) target = pool thanh khoản phía trên (swing-high 1h chưa lấy), tối thiểu 1R
      const liq = ctx.zoneHighs.filter((h) => h > entry + (entry - initialSL)).sort((a, b) => a - b)[0];
      if (liq) initialTarget = liq;
    }
    const rr = (initialTarget - entry) / (entry - initialSL);
    if (CONFIG.minEntryRR > 0 && rr < CONFIG.minEntryRR) return null;
    return {
      direction: "long",
      entry,
      initialSL,
      initialTarget,
      riskPct,
      rr,
      zone: p.zone,
      htfBias: ctx.bias,
      reason: `Tap demand FRESH $${p.zone.low.toFixed(0)}-${p.zone.high.toFixed(0)} (mitig ${p.zone.mitigations}) → pullback đáy $${p.extreme.toFixed(0)} → BOS phá $${bosLevel.toFixed(0)} +vol ${volRatio.toFixed(1)}x; HTF bull`,
    };
  }

  private buildShort(c: Candle, p: PendingSetup, volRatio: number, bosLevel: number, ctx: HtfContext): EntrySignal | null {
    const entry = c.close;
    const initialSL = Math.max(p.zone.high, p.extreme) * (1 + CONFIG.slBufferPct);
    const riskPct = (initialSL - entry) / entry;
    if (riskPct <= 0 || riskPct > CONFIG.maxStopPct) return null;
    const demandBelow = ctx.zones.filter((z) => z.type === "demand" && z.high < entry).sort((a, b) => b.high - a.high)[0];
    const rrTarget = entry - CONFIG.targetRR * (initialSL - entry);
    let initialTarget = demandBelow ? Math.min(demandBelow.high, entry - (initialSL - entry)) : rrTarget;
    if (CONFIG.targetOppositeLiquidity) {
      // (#2) target = pool thanh khoản phía dưới (swing-low 1h chưa lấy), tối thiểu 1R
      const liq = ctx.zoneLows.filter((l) => l < entry - (initialSL - entry)).sort((a, b) => b - a)[0];
      if (liq) initialTarget = liq;
    }
    const rr = (entry - initialTarget) / (initialSL - entry);
    if (CONFIG.minEntryRR > 0 && rr < CONFIG.minEntryRR) return null;
    return {
      direction: "short",
      entry,
      initialSL,
      initialTarget,
      riskPct,
      rr,
      zone: p.zone,
      htfBias: ctx.bias,
      reason: `Tap supply FRESH $${p.zone.low.toFixed(0)}-${p.zone.high.toFixed(0)} (mitig ${p.zone.mitigations}) → pullback đỉnh $${p.extreme.toFixed(0)} → BOS phá $${bosLevel.toFixed(0)} +vol ${volRatio.toFixed(1)}x; HTF bear`,
    };
  }
}
