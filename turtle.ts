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
 *   2. LONG Hybrid: close phá đỉnh CLOSE 15d; SHORT close phá đáy CLOSE 30d rồi giữ
 *      Chandelier exit. Close-channel giảm nhiễu râu nến/short-squeeze giả.
 *   3. Stop ban đầu: ngoài nến ngược hướng 4h gần nhất nếu cách entry 1.5-4×ATR;
 *      ngoài envelope đó fallback 3×ATR. Mỗi unit dùng stop riêng làm mẫu số R.
 *   4. LONG thoát khi nến đóng dưới midpoint của kênh close THOÁT `longExitDays` (midpoint chỉ
 *      ratchet lên), đồng thời giữ hard stop 3×ATR trên sàn. SHORT giữ Chandelier 3×ATR; cả hai
 *      có time-stop. Kênh thoát TÁCH RỜI kênh vào (Turtle gốc cũng vậy) — xem `longExitDays`.
 *   5. 1 VỊ THẾ / symbol, nhưng PYRAMIDING kiểu Turtle: thêm unit mỗi 0.5×ATR chạy có lợi
 *      (tối đa `pyramidMaxUnits`, mỗi unit có SL/R riêng, trail chandelier chung). Unit thêm có
 *      expectancy CAO hơn lệnh mới (điều kiện = trend đang chạy).
 *   6. BTC REGIME GATE: chỉ vào LONG khi SMA10d>SMA100d trên BTC 4h (đại diện regime cả rổ);
 *      short tự do. Audit 2026-07-04 (exp-turtle-levers.ts, 1015d): NET +233R vs +80R baseline,
 *      exp 0.207 vs 0.142, era & perturbation đậu; mở rộng rổ >8 coin thì LOẠI (pha loãng exp).
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
  entryDays: 15, // Hybrid LONG dùng close-channel 15 ngày.
  // Kênh THOÁT của LONG (midpoint ratchet) — TÁCH khỏi kênh VÀO như Turtle gốc (vào 20d / ra 10d là
  // hai số khác nhau). Trước 2026-08-04 code buộc chúng bằng nhau, tức chưa bao giờ tinh chỉnh tham
  // số quan trọng nhất của hệ: attribution cho thấy 100% lợi nhuận đến từ nhánh thoát "mid".
  // Kênh thoát RỘNG hơn kênh vào ⇒ midpoint thấp hơn ⇒ cho winner chạy lâu hơn. 0 = dùng entryDays.
  // Audit 2.026 ngày: plateau ở 20-25d với MỌI entryDays thử (12/15/18d đều muốn kênh thoát ~22-25d);
  // chọn 20 = cạnh bảo thủ của plateau, cải thiện CẢ BA era. Chi tiết: planning/portfolio-risk-and-exit-2026-08.md
  longExitDays: 20,
  shortEntryDays: 30, // SHORT dùng close-channel chậm hơn để lọc wick/squeeze; 0 = dùng entryDays.
  chandelierMult: 3.0, // fallback initial SL; SHORT/legacy LONG còn dùng làm Chandelier trail
  initialStopObLookback: 6, // tìm nến ngược hướng gần nhất trong 6 nến 4h đã đóng
  initialStopObPadAtr: 0.1, // đệm SL ngoài wick của nến đó
  initialStopObMinAtr: 1.5, // stop cấu trúc quá gần → fallback 3×ATR
  initialStopObMaxAtr: 4.0, // stop cấu trúc quá xa → fallback 3×ATR
  // Audit 2026-07-22: short close 20/25/30d tạo plateau; chọn 30d vì cùng tăng NET và exp
  // trên 1.050d lẫn 2.000d. Bản 1.050d: 1.038,8R / 0,800R-unit, Era C 112,9R;
  // perturbation ±15% dương 30/30. Đây là backtest, không phải cam kết lợi nhuận tương lai.
  // Hai cờ explicit để script regression/Fast-trend vẫn có thể ghim đúng engine cũ.
  longEntrySource: "close" as "close" | "high",
  longExitMode: "mid" as "mid" | "chandelier",
  // SHORT chỉ đổi entry sang close-low 30d; midpoint exit đã audit là hại nên vẫn Chandelier.
  shortEntrySource: "close" as "close" | "low",
  shortExitMode: "chandelier" as "mid" | "chandelier",
  atrPeriod: 20, // ATR theo nến TF
  trendLen: 50, // EMA lọc xu hướng (50 nến 4h ≈ 8 ngày) — chỉ long khi trên, short khi dưới
  maxHoldDays: 60, // time-stop (trend dài có thể giữ lâu)
  cooldownBars: 0, // breakout re-enter nhanh
  allowShort: true,

  // ── Đòn bẩy tùy chọn (0 = tắt) — audit 2026-07-04: exp-turtle-levers.ts ──
  entryBufferAtr: 0, // vào lệnh cần close vượt kênh Donchian + buffer×ATR (đã test: +exp nhưng thừa khi có gate)
  trendLen2: 0, // EMA lọc xu hướng THỨ HAI dài hơn (đã test: thừa khi có BTC gate)
  confirmVolMult: 0, // volume nến breakout ≥ k × SMA20(volume) nến trước (đã test: cải thiện nhỏ, không giữ)
  // PYRAMIDING kiểu Turtle — BẬT (audit 1015d: NET +79.6R→+233.3R, exp 0.142→0.207, ~1.1 lệnh/ngày,
  // maxDD 20.2%→23.5% @1%/unit vì 1 vị thế chứa tối đa 4R risk; perturbation 30/30 thắng baseline):
  pyramidStepAtr: 0.5, // thêm 1 unit mỗi khi giá chạy 0.5×ATR có lợi kể từ fill gần nhất
  // 4 → 3 (2026-08-04): các unit TRONG CÙNG một symbol có tương quan ĐÚNG BẰNG 1, nên unit thứ 4
  // gần như chỉ thêm rủi ro chứ không thêm đa dạng hoá. Sharpe 3 unit > 4 > 5 ở mọi mức heatDecayK
  // (2..8) và perturbation 30/30; NET R gần như không đổi. Xem planning/portfolio-risk-and-exit-2026-08.md
  pyramidMaxUnits: 3, // tổng unit tối đa mỗi vị thế
  // ── Chính sách rủi ro CẤP DANH MỤC (turtle-live.ts + scripts/portfolio-engine.ts dùng; runTurtle
  // chạy từng symbol nên không thấy được và bỏ qua tham số này) ──
  // Size mỗi unit mới nhân với 1/(1 + heat/heatDecayK), heat = tổng tỉ trọng unit đang mở CÙNG HƯỚNG
  // trên cả rổ. Cơ chế: 8 symbol × 3 unit cùng hướng trên rổ crypto tương quan ~0,85 KHÔNG phải 24
  // cược độc lập — để risk danh mục dao động 0→24 đơn vị làm hỏng tỉ số lợi nhuận/rủi ro (vol
  // targeting, Harvey et al. 2018). Đo được: Spearman(heat, netR) = −0,025 ⇒ unit vào lúc đông KHÔNG
  // kém hơn — lợi ích thuần tuý đến từ ổn định rủi ro, không phải từ việc né lệnh xấu.
  // KHÔNG BAO GIỜ bỏ lệnh (chỉ nhỏ size): trần cứng làm mất cả trend lớn — bài học A1 (−22% NET).
  heatDecayK: 4, // 0 = tắt chính sách
  // BTC REGIME GATE cho LONG (mọi symbol): chỉ long khi SMA10d > SMA100d trên BTC 4h.
  // Short KHÔNG gate (gate short đã test là hại). Cùng audit trên: exp +46%, era 0.19/0.20/0.24 phẳng.
  btcGateFast: 60, // SMA nhanh, nến 4h (= 10 ngày)
  btcGateSlow: 600, // SMA chậm, nến 4h (= 100 ngày); 0 = tắt gate
};

/**
 * Một dòng mô tả LUẬT đang chạy + fingerprint 6 ký tự, để `/health` (và heartbeat hằng ngày) chứng
 * minh được process đang chạy ĐÚNG cấu hình nào — không cần SSH đọc log.
 *
 * Sự cố 02/08/2026 xảy ra vì không có cách nào xác nhận từ xa rằng bot đang chạy code gì; đổi luật
 * mà không có kênh xác nhận thì lần sau lại phải dựng lại từ API sàn.
 */
export function turtleConfigLine(): string {
  const f = {
    e: T.entryDays, x: T.longExitDays, s: T.shortEntryDays, c: T.chandelierMult,
    u: T.pyramidMaxUnits, p: T.pyramidStepAtr, k: T.heatDecayK,
    a: T.atrPeriod, t: T.trendLen, h: T.maxHoldDays, g: `${T.btcGateFast}/${T.btcGateSlow}`,
  };
  // FNV-1a 32-bit trên JSON cấu hình — đổi bất kỳ tham số nào là fingerprint đổi.
  let hash = 0x811c9dc5;
  const s = JSON.stringify(f);
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const bpd = 6; // nến 4h/ngày
  return (
    `long ${T.entryDays}d/exit ${T.longExitDays || T.entryDays}d · short ${T.shortEntryDays || T.entryDays}d/chand ${T.chandelierMult}×ATR · ` +
    `pyramid ${T.pyramidStepAtr}×ATR max${T.pyramidMaxUnits} · heat-decay k=${T.heatDecayK || "TẮT"} · ` +
    `gate ${T.btcGateFast / bpd}/${T.btcGateSlow / bpd}d · fp \`${hash.toString(16).padStart(8, "0").slice(0, 6)}\``
  );
}

const VOL_SMA_LEN = 20;

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

// ─────────────────────────────────────────────
// INDICATORS (forward-only, không lookahead)
// ─────────────────────────────────────────────
export function ema(values: number[], len: number): number[] {
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
export function atrSeries(c: Candle[], len: number): number[] {
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
  exitReason: "trail" | "mid" | "time";
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
}

// ─────────────────────────────────────────────
// BACKTEST 1 symbol
// ─────────────────────────────────────────────
/** Tham số runTurtle = T + hook tuỳ chọn cho thí nghiệm (gate entry theo thời điểm/hướng). */
export type TurtleParams = typeof T & { gate?: (barOpenTime: number, dir: "long" | "short") => boolean };

/**
 * BTC regime gate cho LONG: chỉ cho vào lệnh LONG (mọi symbol) khi SMA(fast) > SMA(slow)
 * trên nến BTC 4h ĐÃ ĐÓNG gần nhất trước thời điểm entry (không lookahead). SHORT tự do —
 * gate short đã test là HẠI (short có lời của hệ nằm ở pha BTC còn bull/chop).
 * Chưa đủ lịch sử cho SMA slow → cho qua (permissive).
 */
export function buildBtcGateLongs(btc: Candle[], fastLen: number, slowLen: number) {
  const sma = (len: number) => {
    const out = new Array(btc.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < btc.length; i++) {
      s += btc[i].close;
      if (i >= len) s -= btc[i - len].close;
      if (i >= len - 1) out[i] = s / len;
    }
    return out;
  };
  const fast = sma(fastLen), slow = sma(slowLen);
  const times = btc.map((c) => c.openTime);
  return (barOpenTime: number, dir: "long" | "short"): boolean => {
    if (dir === "short") return true;
    // nến BTC cuối cùng có openTime < barOpenTime (đã đóng khi bar hiện tại mở) — binary search
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < barOpenTime) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0 || !Number.isFinite(fast[idx]) || !Number.isFinite(slow[idx])) return true;
    return fast[idx] > slow[idx];
  };
}

/** Kênh của đúng `len` nến trước `i`; loại nến i nên không có lookahead. */
export function priorDonchian(c: Candle[], i: number, len: number): {
  high: number;
  low: number;
  closeHigh: number;
  closeLow: number;
} {
  let high = -Infinity, low = Infinity, closeHigh = -Infinity, closeLow = Infinity;
  for (let k = i - len; k < i; k++) {
    high = Math.max(high, c[k].high);
    low = Math.min(low, c[k].low);
    closeHigh = Math.max(closeHigh, c[k].close);
    closeLow = Math.min(closeLow, c[k].close);
  }
  return { high, low, closeHigh, closeLow };
}

export type TurtleInitialStop = {
  price: number;
  source: "ob" | "atr";
  distanceAtr: number;
};

/**
 * Initial SL khách quan, không lookahead: dùng wick xa của nến ngược hướng gần nhất trước entry,
 * thêm ATR buffer. Chỉ nhận cấu trúc trong ATR envelope; ngoài ra giữ fallback Chandelier.
 */
export function turtleInitialStop(
  c: Candle[],
  i: number,
  dir: "long" | "short",
  entry: number,
  atr: number,
  p: TurtleParams = T,
): TurtleInitialStop {
  const fallback = dir === "long" ? entry - p.chandelierMult * atr : entry + p.chandelierMult * atr;
  if (!(atr > 0)) return { price: fallback, source: "atr", distanceAtr: p.chandelierMult };

  let origin: Candle | null = null;
  for (let k = i - 1; k >= Math.max(0, i - p.initialStopObLookback); k--) {
    const opposite = dir === "long" ? c[k].close < c[k].open : c[k].close > c[k].open;
    if (opposite) {
      origin = c[k];
      break;
    }
  }
  if (!origin) return { price: fallback, source: "atr", distanceAtr: p.chandelierMult };

  const structural = dir === "long"
    ? origin.low - p.initialStopObPadAtr * atr
    : origin.high + p.initialStopObPadAtr * atr;
  const distanceAtr = Math.abs(entry - structural) / atr;
  const validSide = dir === "long" ? structural > 0 && structural < entry : structural > entry;
  const inEnvelope = distanceAtr >= p.initialStopObMinAtr && distanceAtr <= p.initialStopObMaxAtr;
  return validSide && inEnvelope
    ? { price: structural, source: "ob", distanceAtr }
    : { price: fallback, source: "atr", distanceAtr: p.chandelierMult };
}

export function runTurtle(symbol: string, c: Candle[], p: TurtleParams = T): Trade[] {
  const closes = c.map((x) => x.close);
  const emaArr = ema(closes, p.trendLen);
  const ema2Arr = p.trendLen2 > 0 ? ema(closes, p.trendLen2) : null;
  const atr = atrSeries(c, p.atrPeriod);
  // SMA volume (không gồm nến i khi so sánh — dùng volSma[i-1]) — chỉ khi confirmVolMult bật
  let volSma: number[] | null = null;
  if (p.confirmVolMult > 0) {
    volSma = new Array(c.length).fill(0);
    let s = 0;
    for (let i = 0; i < c.length; i++) {
      s += c[i].volume;
      if (i >= VOL_SMA_LEN) s -= c[i - VOL_SMA_LEN].volume;
      volSma[i] = s / Math.min(i + 1, VOL_SMA_LEN);
    }
  }
  const trades: Trade[] = [];
  const barsPerDay = TF_MS["1d"] / TF_MS[p.tf];
  const dcEntry = Math.max(2, Math.round(p.entryDays * barsPerDay)); // lookback LONG theo NGÀY → nến
  const dcShortEntry = p.shortEntryDays > 0
    ? Math.max(2, Math.round(p.shortEntryDays * barsPerDay))
    : dcEntry;
  const dcLongExit = p.longExitDays > 0 ? Math.max(2, Math.round(p.longExitDays * barsPerDay)) : dcEntry;
  const maxHoldBars = Math.round(p.maxHoldDays * barsPerDay);

  // Vị thế = 1..maxUnits UNIT (pyramiding kiểu Turtle): mỗi unit có entry/SL-gốc/R riêng,
  // SHORT/legacy LONG: trail chandelier chung. Hybrid LONG: hard SL chung + midTrail close-based.
  type Unit = { entryIndex: number; entry: number; initialSL: number };
  let pos: { dir: "long" | "short"; units: Unit[]; sl: number; extreme: number; midTrail: number | null } | null = null;
  let cooldownUntil = -1;
  const warmup = Math.max(dcEntry, dcShortEntry, dcLongExit, p.trendLen, p.trendLen2, p.atrPeriod) + 1;

  for (let i = warmup; i < c.length; i++) {
    const bar = c[i];
    const longChannel = priorDonchian(c, i, dcEntry);
    const shortChannel = dcShortEntry === dcEntry ? longChannel : priorDonchian(c, i, dcShortEntry);
    // midpoint LONG lấy trên kênh THOÁT (có thể rộng hơn kênh vào); SHORT vẫn dùng kênh vào của nó.
    const longExitCh = dcLongExit === dcEntry ? longChannel : priorDonchian(c, i, dcLongExit);
    const longMidClose = (longExitCh.closeHigh + longExitCh.closeLow) / 2;
    const shortMidClose = (shortChannel.closeHigh + shortChannel.closeLow) / 2;

    // ─── Quản lý lệnh mở ───
    if (pos) {
      const held = i - pos.units[0].entryIndex;
      let exitPrice: number | null = null;
      let reason: Trade["exitReason"] | null = null;

      if (pos.dir === "long") {
        if (bar.low <= pos.sl) { exitPrice = pos.sl; reason = "trail"; }
        else if (p.longExitMode === "mid" && pos.midTrail !== null && bar.close <= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        }
        else if (held >= maxHoldBars) { exitPrice = bar.close; reason = "time"; }
      } else {
        if (bar.high >= pos.sl) { exitPrice = pos.sl; reason = "trail"; }
        else if (p.shortExitMode === "mid" && pos.midTrail !== null && bar.close >= pos.midTrail) {
          exitPrice = bar.close;
          reason = "mid";
        }
        else if (held >= maxHoldBars) { exitPrice = bar.close; reason = "time"; }
      }

      if (exitPrice !== null && reason !== null) {
        const exitTime = bar.openTime;
        for (const u of pos.units) {
          const risk = Math.abs(u.entry - u.initialSL);
          const pnl = pos.dir === "long" ? exitPrice - u.entry : u.entry - exitPrice;
          const grossR = risk > 0 ? pnl / risk : 0;
          const entryTime = c[u.entryIndex].openTime;
          const costR = tradeCostR(u.entry, u.initialSL, entryTime, exitTime);
          trades.push({
            symbol, dir: pos.dir, entryTime, entryPrice: u.entry, initialSL: u.initialSL,
            exitTime, exitPrice, exitReason: reason, grossR, costR, netR: grossR - costR, holdBars: i - u.entryIndex,
          });
        }
        cooldownUntil = i + p.cooldownBars;
        pos = null;
        continue;
      }

      // ─── Trailing ratchet: Hybrid LONG theo midpoint close; SHORT/legacy theo Chandelier ───
      if (pos.dir === "long") {
        if (p.longExitMode === "mid") {
          pos.midTrail = Math.max(pos.midTrail ?? pos.sl, longMidClose);
        } else {
          pos.extreme = Math.max(pos.extreme, bar.high);
          const trail = pos.extreme - p.chandelierMult * atr[i];
          if (trail > pos.sl) pos.sl = trail;
        }
      } else {
        if (p.shortExitMode === "mid") {
          pos.midTrail = Math.min(pos.midTrail ?? pos.sl, shortMidClose);
        } else {
          pos.extreme = Math.min(pos.extreme, bar.low);
          const trail = pos.extreme + p.chandelierMult * atr[i];
          if (trail < pos.sl) pos.sl = trail;
        }
      }

      // ─── Pyramiding: thêm unit khi giá chạy pyramidStepAtr×ATR có lợi so với fill gần nhất ───
      if (p.pyramidStepAtr > 0 && pos.units.length < p.pyramidMaxUnits && atr[i] > 0) {
        const last = pos.units[pos.units.length - 1];
        if (pos.dir === "long" && bar.close >= last.entry + p.pyramidStepAtr * atr[i]) {
          const initialSL = turtleInitialStop(c, i, "long", bar.close, atr[i], p).price;
          if (initialSL > 0) {
            pos.units.push({ entryIndex: i, entry: bar.close, initialSL });
            // Unit mới không được làm tổng vị thế rủi ro hơn hard stop danh nghĩa của chính unit đó.
            if (p.longExitMode === "mid") pos.sl = Math.max(pos.sl, initialSL);
          }
        } else if (pos.dir === "short" && bar.close <= last.entry - p.pyramidStepAtr * atr[i]) {
          const initialSL = turtleInitialStop(c, i, "short", bar.close, atr[i], p).price;
          pos.units.push({ entryIndex: i, entry: bar.close, initialSL });
          if (p.shortExitMode === "mid") pos.sl = Math.min(pos.sl, initialSL);
        }
      }
      continue;
    }

    // ─── Tìm lệnh mới ───
    if (i < cooldownUntil) continue;

    const uptrend = bar.close > emaArr[i] && (!ema2Arr || bar.close > ema2Arr[i]);
    const downtrend = bar.close < emaArr[i] && (!ema2Arr || bar.close < ema2Arr[i]);
    const buf = p.entryBufferAtr > 0 ? p.entryBufferAtr * atr[i] : 0;
    const volOk = !volSma || (i > 0 && volSma[i - 1] > 0 && bar.volume >= p.confirmVolMult * volSma[i - 1]);

    const longBreakout = p.longEntrySource === "close" ? longChannel.closeHigh : longChannel.high;
    const shortBreakout = p.shortEntrySource === "close" ? shortChannel.closeLow : shortChannel.low;
    if (uptrend && volOk && (!p.gate || p.gate(bar.openTime, "long")) && bar.close > longBreakout + buf) {
      const entry = bar.close;
      const initialSL = turtleInitialStop(c, i, "long", entry, atr[i], p).price;
      if (initialSL > 0 && initialSL < entry) {
        pos = {
          dir: "long",
          units: [{ entryIndex: i, entry, initialSL }],
          sl: initialSL,
          extreme: bar.high,
          midTrail: p.longExitMode === "mid" ? Math.max(initialSL, longMidClose) : null,
        };
      }
    } else if (p.allowShort && downtrend && volOk && (!p.gate || p.gate(bar.openTime, "short")) && bar.close < shortBreakout - buf) {
      const entry = bar.close;
      const initialSL = turtleInitialStop(c, i, "short", entry, atr[i], p).price;
      if (initialSL > entry) {
        pos = {
          dir: "short",
          units: [{ entryIndex: i, entry, initialSL }],
          sl: initialSL,
          extreme: bar.low,
          midTrail: p.shortExitMode === "mid" ? Math.min(initialSL, shortMidClose) : null,
        };
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
/** `p` = cấu hình ĐÃ DÙNG để sinh `trades` (sweep dùng biến thể riêng — KHÔNG được sửa `T`). */
function report(trades: Trade[], data: Map<string, Candle[]>, riskPct: number, t0: number, t1: number, p: TurtleParams = T) {
  trades.sort((a, b) => a.entryTime - b.entryTime);
  const s = summarize(trades);
  const periodDays = (t1 - t0) / TF_MS["1d"];
  const avgHoldDays = s.n ? (trades.reduce((a, t) => a + t.holdBars, 0) / s.n) * (TF_MS[p.tf] / TF_MS["1d"]) : 0;

  console.log("=".repeat(72));
  console.log(`  TURTLE HYBRID — tf ${p.tf} | initial SL OB${p.initialStopObLookback} trong ${p.initialStopObMinAtr}-${p.initialStopObMaxAtr}ATR, fallback ${p.chandelierMult}ATR | LONG close ${p.entryDays}d/mid ${p.longExitDays || p.entryDays}d | SHORT close ${p.shortEntryDays || p.entryDays}d/Chandelier | EMA${p.trendLen}`);
  console.log(`  Pyramid: ${p.pyramidStepAtr > 0 ? `+1 unit / ${p.pyramidStepAtr}×ATR, tối đa ${p.pyramidMaxUnits} (mỗi unit = 1 lệnh)` : "TẮT"} | BTC gate LONG: ${p.btcGateSlow > 0 ? `SMA ${p.btcGateFast / 6}d>${p.btcGateSlow / 6}d` : "TẮT"}`);
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

  // BTC regime gate cho LONG — cần nến BTC kể cả khi rổ không chứa BTC
  let gate: TurtleParams["gate"];
  if (T.btcGateSlow > 0) {
    let btcC = data.get("btcusdt");
    if (!btcC) {
      if (T.tf === "1h") btcC = await fetchKlinesPaged("btcusdt", "1h", totalBars);
      else { const ltf = await fetchKlinesPaged("btcusdt", "15m", totalBars * (TF_MS[T.tf] / TF_MS["15m"]) + 400); btcC = aggregate(ltf, T.tf, "15m"); }
    }
    gate = buildBtcGateLongs(btcC, T.btcGateFast, T.btcGateSlow);
  }

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
      const p: TurtleParams = { ...T, entryDays: ed, chandelierMult: ch, gate };
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
    for (const [sym, c] of data) all.push(...runTurtle(sym, c, { ...T, gate }));
    report(all, data, riskPct, t0, t1);
    return;
  }

  console.log(`→ Chọn breakout=${best.p.entryDays}d / chandelier=${best.p.chandelierMult}×ATR (EDGE mạnh nhất, freq>=0.4/ngày). Báo cáo chi tiết:\n`);
  // TUYỆT ĐỐI không gán vào `T`: đó là cấu hình LIVE dùng chung (turtle-live.ts + fast-trend-live.ts
  // đọc T.chandelierMult ở runtime). Sự cố 2026-08-05: bundle esbuild làm `main()` này chạy TRONG
  // bot, và hai dòng gán ở đây đã đổi chandelier 3.0→4.0 trên tiền thật.
  report(best.trades, data, riskPct, t0, t1, best.p);
}

// `require.main === module` KHÔNG đủ: trong bundle esbuild (--format=cjs), mọi module ESM đều thấy
// `module` là module gốc của bundle nên điều kiện này ĐÚNG với mọi file → main() backtest chạy trong
// bot production. Phải kiểm tra thêm rằng process thực sự được khởi chạy bằng CHÍNH file này.
if (require.main === module && /[\\/]turtle\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
}
