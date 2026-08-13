/**
 * measure-live-path.ts — 2026-08-10. ĐO LỢI NHUẬN của đúng bộ luật FX Dream đang chạy live
 * (`fxdream-alert.ts` → `strategy-engine-v2.ts`), rồi ablation từng lỗi đã tìm ra trong
 * `planning/fxdream-integration-audit-2026-08-10.md`.
 *
 * Vì sao phải viết mới thay vì dùng `run-v2-study.ts`:
 *   - study đọc `params.requireDailyExpansion` / `dailyCtx.isExpansion` — HAI FIELD KHÔNG TỒN TẠI
 *     ⇒ gate bị bỏ âm thầm; và study KHÔNG kiểm `trapGatePassed` mà live CÓ kiểm.
 *   - study cũ dùng execution/management khác đường alert và không còn theo định nghĩa Key hiện tại.
 *   - study không xử lý trường hợp nến fill limit cũng chạm SL (repo quy định phải xử theo hướng BẤT LỢI).
 *
 * MÔ HÌNH R: 1R = |entry − SL|. costR = ma sát khứ hồi (%) / stopPct. Báo NET ở nhiều mức ma sát +
 * ngưỡng hoà phí — đúng cách §13.7/§14.6 đã đăng ký, để không tranh luận về một con phí duy nhất.
 *
 * `--self-check`: chỉ chứng minh DETECTOR trong file này trùng `detectSFPSignalsV2` khi bật bộ cờ
 * vận hành. Execution/management được kiểm riêng và phải đọc cùng các giả định báo cáo.
 *
 * Run: ./node_modules/.bin/ts-node fxdream-research/measure-live-path.ts [days] [--self-check]
 */
import { Candle, TF_MS, aggregate, findSwings } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import {
  FXDREAM_V2_CONFIG,
  FXDreamV2Params,
  KeyLevel,
  SFPEvent,
  findKeyVolumeLevelsV2,
  evaluateDailyContextV2,
  detectSFPSignalsV2,
  findNearestOpposingStructurePrice,
  getKeyZoneBounds,
  selectBestSFPEventV2,
  calculateATR,
  median,
} from "./strategy-engine-v2";

const SYMBOLS = ["BTCUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
const P = FXDREAM_V2_CONFIG;
const M15_WINDOW = 400; // cửa sổ M15 truyền vào engine; ATR Wilder đã hội tụ (sai số ~1e-6)
const LEGACY_MIN_STOP_PCT = 0.008;

export interface Flags {
  label: string;
  noLookahead: boolean; // key chỉ dùng sau khi chính nến volume H1 đã đóng
  keyAtClose: boolean; // true = geometry trong config; false = geometry đối chứng còn lại
  strictEngulf: boolean; // dùng bộ mẫu nguồn: Engulfing / Inside bar / 3-bar reversal
  strictSweep: boolean; // bắt buộc XUYÊN QUA key và nến xác nhận LẤY LẠI được key
  strictDailyGate: boolean; // #31 đúng: low nến XANH cuối chưa bị đóng qua VÀ đã bị thọt râu
  noStopFloor: boolean; // bỏ sàn 0,8% — trả SL về "ngắn nhất có thể"
  requireHeadroom: boolean; // không có cấu trúc đối diện đủ minRR ⇒ BỎ, không fallback 15R
  trailH1: boolean; // cài thật nhánh trail h1-swing (config đang trỏ vào nhánh không tồn tại)
  /**
   * #22 nguyên văn: "cái phát đầu tiên là không thể nào mà tray được... mình phải canh tín hiệu
   * hai đái mới được". Tức chạm LẦN ĐẦU vào key thì KHÔNG vào; phải là lần chạm thứ 2 trở lên.
   */
  requireSecondTouch: boolean;
}

const OFF: Flags = {
  label: "live nguyên trạng",
  noLookahead: false,
  keyAtClose: false,
  strictEngulf: false,
  strictSweep: false,
  strictDailyGate: false,
  noStopFloor: false,
  requireHeadroom: false,
  trailH1: false,
  requireSecondTouch: false,
};

export interface Data {
  symbol: string;
  c5m: Candle[];
  c15m: Candle[];
  c1h: Candle[];
  c4h: Candle[];
  c1d: Candle[];
  keys: KeyLevel[];
  keyUsableFrom: Map<string, number>;
  keyClosePrice: Map<string, number>;
  keyLegacyPrice: Map<string, number>;
  atr15: number[];
  h1Swings: { time: number; type: "high" | "low"; price: number }[];
  touchCache: Map<string, number[]>;
}

function keyGeometryForFlags(f: Flags): FXDreamV2Params["keyGeometry"] {
  const configuredUsesZone = P.keyGeometry === "full-candle-zone";
  const useFullZone = f.keyAtClose ? configuredUsesZone : !configuredUsesZone;
  return useFullZone ? "full-candle-zone" : "representative-point";
}

function keyZoneForFlags(key: KeyLevel, f: Flags): { low: number; high: number } {
  return keyGeometryForFlags(f) === "full-candle-zone"
    ? getKeyZoneBounds(key)
    : { low: key.price, high: key.price };
}

export async function load(symbol: string, days: number): Promise<Data> {
  const c5m = await fetchKlinesPaged(symbol, "5m", days * 288);
  const c15m = aggregate(c5m, "15m", "5m");
  const c1h = aggregate(c5m, "1h", "5m");
  const c4h = aggregate(c5m, "4h", "5m");
  const c1d = aggregate(c5m, "1d", "5m");
  const keys = findKeyVolumeLevelsV2(c1h, c4h, P);

  // Key candidate được biết ngay khi chính nến volume H1 đóng; không cần phản ứng tương lai.
  const keyUsableFrom = new Map<string, number>();
  const keyClosePrice = new Map<string, number>();
  const keyLegacyPrice = new Map<string, number>();
  const idxH1 = new Map(c1h.map((c, i) => [c.openTime, i]));
  for (const k of keys) {
    const i = idxH1.get(k.originTime)!;
    keyUsableFrom.set(k.id, c1h[i].openTime + TF_MS["1h"]);
    keyClosePrice.set(k.id, c1h[i].close);
    keyLegacyPrice.set(k.id, c1h[i].close);
  }
  const sw = findSwings(c1h, 3, 3);
  return {
    symbol,
    c5m,
    c15m,
    c1h,
    c4h,
    c1d,
    keys,
    keyUsableFrom,
    keyClosePrice,
    keyLegacyPrice,
    atr15: calculateATR(c15m, 14),
    h1Swings: sw.map((s) => ({ time: c1h[s.index].openTime, type: s.type, price: s.price })),
    touchCache: new Map(),
  };
}

/** #31 đúng nguồn: tìm nến XANH gần nhất; low của nó (a) chưa bị nến nào ĐÓNG dưới, (b) đã bị thọt râu. */
function strictDailyTrap(daily: Candle[]): { bias: "long" | "short" | "neutral"; pass: boolean } {
  if (daily.length < 8) return { bias: "neutral", pass: false };
  const last3 = daily.slice(-3);
  const green = last3.filter((c) => c.close > c.open).length;
  const red = last3.filter((c) => c.close < c.open).length;
  const bias: "long" | "short" | "neutral" = green >= 2 ? "long" : red >= 2 ? "short" : "neutral";
  if (bias === "neutral") return { bias, pass: false };

  if (bias === "long") {
    let gi = -1;
    for (let i = daily.length - 1; i >= 0; i--) if (daily[i].close > daily[i].open) { gi = i; break; }
    if (gi < 0) return { bias, pass: false };
    const ref = daily[gi].low;
    let closedThrough = false, wicked = false;
    for (let i = gi + 1; i < daily.length; i++) {
      if (daily[i].close < ref) closedThrough = true;
      if (daily[i].low < ref) wicked = true;
    }
    return { bias, pass: !closedThrough && wicked };
  }
  let ri = -1;
  for (let i = daily.length - 1; i >= 0; i--) if (daily[i].close < daily[i].open) { ri = i; break; }
  if (ri < 0) return { bias, pass: false };
  const ref = daily[ri].high;
  let closedThrough = false, wicked = false;
  for (let i = ri + 1; i < daily.length; i++) {
    if (daily[i].close > ref) closedThrough = true;
    if (daily[i].high > ref) wicked = true;
  }
  return { bias, pass: !closedThrough && wicked };
}

/** Đóng băng gate sai của V0 để báo cáo trước/sau vẫn tái lập được sau khi engine live đã sửa. */
function legacyDailyTrap(daily: Candle[]): { bias: "long" | "short" | "neutral"; pass: boolean } {
  if (daily.length < P.dailyBiasBars + 5) return { bias: "neutral", pass: true };
  const lastBars = daily.slice(-P.dailyBiasBars);
  const green = lastBars.filter((c) => c.close > c.open).length;
  const red = lastBars.filter((c) => c.close < c.open).length;
  const bias: "long" | "short" | "neutral" =
    green >= P.dailyBiasBars - 1 ? "long" : red >= P.dailyBiasBars - 1 ? "short" : "neutral";
  const prev = daily[daily.length - 1];
  const ante = daily[daily.length - 2];
  if (bias === "long") {
    return { bias, pass: (prev.low < ante.low && prev.close > ante.low) || prev.close > ante.high };
  }
  if (bias === "short") {
    return { bias, pass: (prev.high > ante.high && prev.close < ante.high) || prev.close < ante.low };
  }
  return { bias, pass: true };
}

/**
 * Số lần giá ĐÃ chạm key TRƯỚC nến hiện tại, tính trên M15 và gộp các lần chạm liền nhau thành MỘT
 * lượt (rời key ≥1×ATR mới tính lượt mới) — nếu không thì một lần đứng lâu ở key bị đếm thành N lượt.
 */
function priorTouches(d: Data, key: KeyLevel, f: Flags, nowOpen: number): number {
  const cache = d.touchCache;
  const zone = keyZoneForFlags(key, f);
  const ck = `${key.id}|${zone.low.toFixed(10)}|${zone.high.toFixed(10)}`;
  let list = cache.get(ck);
  if (!list) {
    list = [];
    const from = key.originTime;
    let inside = false;
    for (let i = 0; i < d.c15m.length; i++) {
      const b = d.c15m[i];
      if (b.openTime <= from) continue;
      const tol = (d.atr15[i] || b.high - b.low) * 0.25;
      const touching = b.low <= zone.high + tol && b.high >= zone.low - tol;
      if (touching && !inside) { list.push(b.openTime); inside = true; }
      else if (!touching && inside) {
        const away = b.high < zone.low ? zone.low - b.high : b.low > zone.high ? b.low - zone.high : 0;
        if (away > (d.atr15[i] || 0)) inside = false;
      }
    }
    cache.set(ck, list);
  }
  let n = 0;
  for (const t of list) { if (t < nowOpen) n++; else break; }
  return n;
}

/** Bản tái hiện detector có cờ ablation. Bộ cờ V7 ⇒ phải trùng engine (xem --self-check). */
function detectEvents(d: Data, n: number, keys: KeyLevel[], bias: string, f: Flags, full: Data = d): SFPEvent[] {
  const out: SFPEvent[] = [];
  const lastIdx = n - 1;
  const cCurr = d.c15m[lastIdx], cPrev = d.c15m[lastIdx - 1], cAnte = d.c15m[lastIdx - 2];
  const atr = d.atr15[lastIdx] || cCurr.high - cCurr.low;

  for (const key of keys) {
    const canLong = key.type !== "supply" && bias !== "short";
    const canShort = key.type !== "demand" && bias !== "long";
    if (!canLong && !canShort) continue;
    const zone = keyZoneForFlags(key, f);
    const distance = cCurr.close < zone.low
      ? zone.low - cCurr.close
      : cCurr.close > zone.high ? cCurr.close - zone.high : 0;
    if (distance > atr * 3.0) continue;
    if (f.requireSecondTouch && priorTouches(full, key, f, cCurr.openTime) < 1) continue;

    const lo = Math.max(0, lastIdx - P.sfpLookbackBars);
    const win = f.strictSweep ? [cAnte, cPrev, cCurr] : d.c15m.slice(lo, lastIdx + 1);

    if (canLong) {
      const sweepBars = win.filter((b) => f.strictSweep ? b.low < zone.low : b.low <= zone.low * 1.002);
      const sweepBar = sweepBars[sweepBars.length - 1];
      const swept = Boolean(sweepBar);
      const reclaimed = f.strictSweep ? cCurr.close > zone.low : cCurr.close >= zone.low * 0.998;
      if (!swept || !reclaimed) continue;
      const isGreen = cCurr.close > cCurr.open;
      let patternName = "";
      const engulf = f.strictEngulf
        ? isGreen && cPrev.close < cPrev.open && cCurr.close > cPrev.open && cCurr.open < cPrev.close
        : isGreen && cCurr.close > cPrev.open;
      if (engulf) patternName = "Engulfing";
      else if (f.strictEngulf && cPrev.high < cAnte.high && cPrev.low > cAnte.low && cCurr.close > cAnte.high) {
        patternName = "Inside-bar-breakout";
      }
      else if (cPrev.low < cAnte.low && cCurr.close > cAnte.close) patternName = "3-bar-reversal";
      else if (!f.strictEngulf) {
        const bodySize = Math.abs(cCurr.close - cCurr.open);
        const rangeSize = cCurr.high - cCurr.low;
        const lowerWick = Math.min(cCurr.open, cCurr.close) - cCurr.low;
        if (lowerWick >= rangeSize * 0.4 && lowerWick > bodySize) patternName = "Pinbar";
      }
      if (!patternName) continue;
      out.push({
        keyLevel: key, dir: "long", sweepTime: sweepBar!.openTime,
        sweepPrice: Math.min(...win.map((b) => b.low)), reclaimPrice: cCurr.close,
        confirmTime: cCurr.openTime + TF_MS["15m"], confirmClose: cCurr.close, patternName,
        obHigh: Math.max(cCurr.open, cCurr.close), obLow: cCurr.low,
      });
    }

    if (canShort) {
      const sweepBars = win.filter((b) => f.strictSweep ? b.high > zone.high : b.high >= zone.high * 0.998);
      const sweepBar = sweepBars[sweepBars.length - 1];
      const swept = Boolean(sweepBar);
      const reclaimed = f.strictSweep ? cCurr.close < zone.high : cCurr.close <= zone.high * 1.002;
      if (!swept || !reclaimed) continue;
      const isRed = cCurr.close < cCurr.open;
      let patternName = "";
      const engulf = f.strictEngulf
        ? isRed && cPrev.close > cPrev.open && cCurr.close < cPrev.open && cCurr.open > cPrev.close
        : isRed && cCurr.close < cPrev.open;
      if (engulf) patternName = "Engulfing";
      else if (f.strictEngulf && cPrev.high < cAnte.high && cPrev.low > cAnte.low && cCurr.close < cAnte.low) {
        patternName = "Inside-bar-breakout";
      }
      else if (cPrev.high > cAnte.high && cCurr.close < cAnte.close) patternName = "3-bar-reversal";
      else if (!f.strictEngulf) {
        const bodySize = Math.abs(cCurr.close - cCurr.open);
        const rangeSize = cCurr.high - cCurr.low;
        const upperWick = cCurr.high - Math.max(cCurr.open, cCurr.close);
        if (upperWick >= rangeSize * 0.4 && upperWick > bodySize) patternName = "Pinbar";
      }
      if (!patternName) continue;
      out.push({
        keyLevel: key, dir: "short", sweepTime: sweepBar!.openTime,
        sweepPrice: Math.max(...win.map((b) => b.high)), reclaimPrice: cCurr.close,
        confirmTime: cCurr.openTime + TF_MS["15m"], confirmClose: cCurr.close, patternName,
        obHigh: cCurr.high, obLow: Math.min(cCurr.open, cCurr.close),
      });
    }
  }
  return out;
}

export interface Trade {
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  stopPct: number;
  grossR: number;
  maxR: number;
  reason: string;
  holdBars5m: number;
}

export function runSymbol(d: Data, f: Flags): { trades: Trade[]; signals: number; fills: number } {
  const trades: Trade[] = [];
  let signals = 0, fills = 0;
  const idx15Of = new Map(d.c15m.map((c, i) => [c.openTime, i]));

  let pos: {
    dir: "long" | "short"; entry: number; sl: number; risk0: number; target: number; entryIdx: number;
    protected: boolean; hi: number; lo: number; entryTime: number; keyPrice: number;
  } | null = null;

  for (let i = 300; i < d.c5m.length; i++) {
    const bar = d.c5m[i];
    const now = bar.openTime;

    // ── quản lý vị thế ──
    if (pos) {
      const risk = pos.risk0; // R gốc lúc vào — KHÔNG lấy theo sl hiện tại (sl dời về BE ⇒ chia 0)
      const hold = i - pos.entryIdx;
      let closed = false, gross = 0, reason = "";

      // SL trước TP trong cùng nến — hướng bất lợi (quy định của repo)
      const hitSL = pos.dir === "long" ? bar.low <= pos.sl : bar.high >= pos.sl;
      const hitTP = pos.dir === "long" ? bar.high >= pos.target : bar.low <= pos.target;
      const isM15Close = (bar.openTime + TF_MS["5m"]) % TF_MS["15m"] === 0;
      // Nếu cây hiện tại chạm SL, không được dùng cực trị thuận lợi của chính cây đó để thổi phồng MFE.
      if (!hitSL) {
        pos.hi = Math.max(pos.hi, bar.high);
        pos.lo = Math.min(pos.lo, bar.low);
      }
      const mfeR = pos.dir === "long" ? (pos.hi - pos.entry) / risk : (pos.entry - pos.lo) / risk;
      if (hitSL) {
        const slR = pos.dir === "long" ? (pos.sl - pos.entry) / risk : (pos.entry - pos.sl) / risk;
        gross = slR;
        closed = true;
        reason = pos.protected ? "SL_after_BE" : "SL";
      } else if (hitTP) {
        const fullR = pos.dir === "long" ? (pos.target - pos.entry) / risk : (pos.entry - pos.target) / risk;
        gross = fullR;
        closed = true;
        reason = "TP";
      } else if (isM15Close && (pos.dir === "long" ? bar.close < pos.keyPrice : bar.close > pos.keyPrice)) {
        gross = pos.dir === "long" ? (bar.close - pos.entry) / risk : (pos.entry - bar.close) / risk;
        closed = true;
        reason = "CLOSE_THROUGH_KEY";
      }

      if (!closed) {
        // Chỉ dời stop sau khi cây hiện tại không chạm SL/TP; tránh dùng thứ tự intrabar có lợi.
        if (!pos.protected && mfeR >= P.partialAtR) {
          pos.protected = true;
          pos.sl = pos.dir === "long" ? Math.max(pos.sl, pos.entry) : Math.min(pos.sl, pos.entry);
        }
        if (f.trailH1 && pos.protected) {
          const sws = d.h1Swings.filter((s) => s.time + TF_MS["1h"] <= now);
          if (pos.dir === "long") {
            const ls = sws.filter((s) => s.type === "low");
            if (ls.length && ls[ls.length - 1].price > pos.sl) pos.sl = ls[ls.length - 1].price;
          } else {
            const hs = sws.filter((s) => s.type === "high");
            if (hs.length && hs[hs.length - 1].price < pos.sl) pos.sl = hs[hs.length - 1].price;
          }
        }
      }
      if (closed) {
        trades.push({
          symbol: d.symbol, dir: pos.dir, entryTime: pos.entryTime,
          stopPct: risk / pos.entry, grossR: gross, maxR: mfeR, reason, holdBars5m: hold,
        });
        pos = null;
      }
      continue;
    }

    // ── sinh tín hiệu tại biên nến M15 (giống live: chỉ xét nến M15 vừa đóng) ──
    if (now % TF_MS["15m"] !== 0) continue;
    const n = idx15Of.get(now - TF_MS["15m"]);
    if (n === undefined || n < M15_WINDOW) continue;
    const n15 = n + 1; // số nến M15 đã đóng

    const validDaily = d.c1d.filter((c) => c.openTime + TF_MS["1d"] <= now);
    let bias: string;
    if (f.strictDailyGate) {
      const g = strictDailyTrap(validDaily);
      if (!g.pass) continue;
      bias = g.bias;
    } else {
      const g = legacyDailyTrap(validDaily);
      if (!g.pass) continue;
      bias = g.bias;
    }

    const usable = d.keys.filter((k) => {
      const from = f.noLookahead ? d.keyUsableFrom.get(k.id)! : k.originTime;
      return from <= now && now - k.originTime <= P.keyMaxAgeDays * TF_MS["1d"];
    });
    if (!usable.length) continue;

    const sub: Data = { ...d, c15m: d.c15m.slice(n15 - M15_WINDOW, n15), atr15: d.atr15.slice(n15 - M15_WINDOW, n15) };
    const events = detectEvents(sub, M15_WINDOW, usable, bias, f, d);
    const e = selectBestSFPEventV2(events, keyGeometryForFlags(f));
    if (!e) continue;
    signals++;

    // ── target theo cấu trúc H4 ──
    const h4v = d.c4h.filter((c) => c.openTime + TF_MS["4h"] <= now);
    const sws = findSwings(h4v.slice(-60), 2, 2);
    const opposing = findNearestOpposingStructurePrice(e.dir, e.confirmClose, sws);

    const entry = e.confirmClose;
    let sl: number;
    if (e.dir === "long") {
      sl = e.sweepPrice * 0.999;
      if (!f.noStopFloor && (entry - sl) / entry < LEGACY_MIN_STOP_PCT) {
        sl = entry * (1 - LEGACY_MIN_STOP_PCT);
      }
    } else {
      sl = e.sweepPrice * 1.001;
      if (!f.noStopFloor && (sl - entry) / entry < LEGACY_MIN_STOP_PCT) {
        sl = entry * (1 + LEGACY_MIN_STOP_PCT);
      }
    }
    const risk = Math.abs(entry - sl);
    if (risk <= 0 || risk / entry > 0.05) continue;

    let target: number;
    if (opposing && opposing > 0) {
      const structR = Math.abs(opposing - entry) / risk;
      if (structR >= P.minRR) target = opposing;
      else if (f.requireHeadroom) continue;
      else target = e.dir === "long" ? entry + risk * P.minRR : entry - risk * P.minRR;
    } else {
      if (f.requireHeadroom) continue;
      const legacyFallbackR = P.maxTargetR > 0 ? P.maxTargetR : 15;
      target = e.dir === "long" ? entry + risk * legacyFallbackR : entry - risk * legacyFallbackR;
    }
    let tR = Math.abs(target - entry) / risk;
    if (P.maxTargetR > 0 && tR > P.maxTargetR) {
      tR = P.maxTargetR;
      target = e.dir === "long" ? entry + risk * tR : entry - risk * tR;
    }
    fills++;
    pos = {
      dir: e.dir,
      entry,
      sl,
      risk0: risk,
      target,
      entryIdx: i,
      protected: false,
      hi: entry,
      lo: entry,
      entryTime: now,
      keyPrice: e.dir === "long"
        ? keyZoneForFlags(e.keyLevel, f).low
        : keyZoneForFlags(e.keyLevel, f).high,
    };
    // Entry ở close M15, tức đúng đầu cây 5m hiện tại. Quay lại một bước để cây đầu tiên sau entry
    // cũng được kiểm SL/TP/invalidation; nếu không backtest vô tình bỏ qua 5 phút rủi ro đầu tiên.
    i--;
  }
  return { trades, signals, fills };
}

const FRICTIONS: [string, number][] = [
  ["Binance taker 2 chiều 0,140%", 0.0014],
  ["maker vào / taker ra 0,090%", 0.0009],
  ["Vàng/Forex 0,020%", 0.0002],
];

function report(label: string, trades: Trade[], signals: number, fills: number) {
  const n = trades.length;
  if (!n) {
    console.log(`${label.padEnd(34)} ${String(signals).padStart(6)} ${String(fills).padStart(6)}      0 lệnh`);
    return;
  }
  const gross = trades.reduce((s, t) => s + t.grossR, 0);
  const wr = (trades.filter((t) => t.grossR > 0).length / n) * 100;
  const medStop = median(trades.map((t) => t.stopPct));
  const perTrade = gross / n;
  // maxDD trên chuỗi gross theo thứ tự thời gian
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let cum = 0, peak = 0, dd = 0;
  for (const t of sorted) { cum += t.grossR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const nets = FRICTIONS.map(([, fr]) => gross - trades.reduce((s, t) => s + fr / t.stopPct, 0));
  const inverseStopSum = trades.reduce((sum, trade) => sum + 1 / trade.stopPct, 0);
  const breakeven = gross > 0 ? gross / inverseStopSum : 0;
  console.log(
    label.padEnd(34) + String(signals).padStart(6) + String(fills).padStart(6) + String(n).padStart(6) +
      `${wr.toFixed(0)}%`.padStart(6) + gross.toFixed(1).padStart(9) + perTrade.toFixed(3).padStart(8) +
      `${(medStop * 100).toFixed(3)}%`.padStart(9) + dd.toFixed(0).padStart(7) +
      nets.map((x) => x.toFixed(0).padStart(9)).join("") +
      (breakeven > 0 ? `   <${(breakeven * 100).toFixed(3)}%` : "      —"),
  );
}

async function selfCheck(ds: Data[]) {
  const live: Flags = {
    ...OFF,
    label: "detector vận hành đã sửa",
    noLookahead: true,
    keyAtClose: true,
    strictEngulf: true,
    strictSweep: true,
    strictDailyGate: true,
    noStopFloor: true,
    requireHeadroom: true,
  };
  console.log("\n--self-check: detector V7 có trùng detectSFPSignalsV2?\n");
  let checked = 0, mismatch = 0;
  for (const d of ds) {
    for (let n15 = M15_WINDOW; n15 <= Math.min(d.c15m.length, M15_WINDOW + 4000); n15++) {
      const now = d.c15m[n15 - 1].openTime + TF_MS["15m"];
      const validDaily = d.c1d.filter((c) => c.openTime + TF_MS["1d"] <= now);
      const ctx = evaluateDailyContextV2(validDaily, now, P);
      if (!ctx.trapGatePassed) continue;
      const usable = d.keys.filter((k) =>
        d.keyUsableFrom.get(k.id)! <= now && now - k.originTime <= P.keyMaxAgeDays * TF_MS["1d"]
      );
      if (!usable.length) continue;
      const sub: Data = { ...d, c15m: d.c15m.slice(n15 - M15_WINDOW, n15), atr15: d.atr15.slice(n15 - M15_WINDOW, n15) };
      const mine = detectEvents(sub, M15_WINDOW, usable, ctx.bias, live, d);
      const theirs = detectSFPSignalsV2(d.c15m.slice(0, n15), usable, ctx, P);
      checked++;
      const a = mine.map((e) => `${e.keyLevel.id}|${e.dir}|${e.patternName}`).join(",");
      const b = theirs.map((e) => `${e.keyLevel.id}|${e.dir}|${e.patternName}`).join(",");
      if (a !== b) {
        if (mismatch < 3) console.log(`  ✗ ${d.symbol} @${new Date(now).toISOString()}\n    mine  : ${a}\n    engine: ${b}`);
        mismatch++;
      }
    }
  }
  console.log(`\n  đã so ${checked} nến M15 · lệch ${mismatch}`);
  console.log(mismatch === 0
    ? "  ✅ DETECTOR TRÙNG KHỚP — self-check này không xác minh execution/management.\n"
    : "  ❌ DETECTOR LỆCH — không dùng số bên dưới.\n");
}

async function main() {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const doCheck = process.argv.includes("--self-check");
  const ds: Data[] = [];
  for (const s of SYMBOLS) ds.push(await load(s, days));

  console.log(`\nCửa sổ ${days} ngày · ${SYMBOLS.join(", ")} · nến 5m`);
  console.log(`Từ ${new Date(ds[0].c5m[0].openTime).toISOString().slice(0, 10)} → ${new Date(ds[0].c5m[ds[0].c5m.length - 1].openTime).toISOString().slice(0, 10)}`);
  console.log(`Key H1 tìm được: ${ds.map((d) => `${d.symbol.replace("USDT", "")} ${d.keys.length}`).join(" · ")}`);

  if (doCheck) await selfCheck(ds);

  const variants: Flags[] = [
    { ...OFF, label: "V0 baseline (execution mới)" },
    { ...OFF, label: "V1 = V0 + bỏ lookahead", noLookahead: true },
    { ...OFF, label: "V2 = V1 + geometry Key", noLookahead: true, keyAtClose: true },
    { ...OFF, label: "V3 = V2 + mẫu nến nguồn", noLookahead: true, keyAtClose: true, strictEngulf: true },
    { ...OFF, label: "V4 = V3 + sweep thật", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true },
    { ...OFF, label: "V5 = V4 + gate #31 đúng", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true, strictDailyGate: true },
    { ...OFF, label: "V6 = V5 + bắt buộc dư địa", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true, strictDailyGate: true, requireHeadroom: true },
    { ...OFF, label: "V7 = V6 + bỏ sàn SL 0,8%", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true, strictDailyGate: true, requireHeadroom: true, noStopFloor: true },
    { ...OFF, label: "V8 = V7 + trail H1 thật", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true, strictDailyGate: true, requireHeadroom: true, noStopFloor: true, trailH1: true },
    { ...OFF, label: "V9 = V8 + chạm lần 2 (#22)", noLookahead: true, keyAtClose: true, strictEngulf: true, strictSweep: true, strictDailyGate: true, requireHeadroom: true, noStopFloor: true, trailH1: true, requireSecondTouch: true },
  ];

  console.log("\n" + "=".repeat(134));
  console.log("  tín hiệu → entry tham chiếu → lệnh. GROSS R theo 1R = |entry−SL|. NET R ở ba mức ma sát.");
  console.log("=".repeat(134));
  console.log(
    "biến thể".padEnd(34) + "t.hiệu".padStart(6) + "entry".padStart(6) + "lệnh".padStart(6) + "WR".padStart(6) +
      "GROSS".padStart(9) + "gr/lệnh".padStart(8) + "SL tv".padStart(9) + "maxDD".padStart(7) +
      FRICTIONS.map(([l]) => l.split(" ").pop()!.padStart(9)).join("") + "   hoà phí",
  );
  console.log("-".repeat(134));

  for (const f of variants) {
    let all: Trade[] = [], sig = 0, fil = 0;
    for (const d of ds) {
      const r = runSymbol(d, f);
      all = all.concat(r.trades);
      sig += r.signals;
      fil += r.fills;
    }
    report(f.label, all, sig, fil);
  }

  console.log("\nGhi chú: 'hoà phí' = gross R / Σ(1 / stopPct), tính đúng trên từng lệnh.");
  console.log("Cột NET dùng đúng ba kịch bản đã đăng ký ở planning/fxdream-keyvolume-method.md §13.7.");

  // ── LEAVE-ONE-OUT: cái nào thật sự tạo ra thay đổi, không phải thứ tự cộng dồn ──
  const best = variants.find((variant) => variant.label.startsWith("V7"))!;
  const keys: (keyof Flags)[] = [
    "noLookahead", "keyAtClose", "strictEngulf", "strictSweep", "strictDailyGate", "requireHeadroom", "noStopFloor", "trailH1", "requireSecondTouch",
  ];
  const runAll = (f: Flags) => {
    let all: Trade[] = [], sig = 0, fil = 0;
    for (const d of ds) {
      const r = runSymbol(d, f);
      all = all.concat(r.trades);
      sig += r.signals;
      fil += r.fills;
    }
    return { all, sig, fil };
  };
  console.log("\n" + "=".repeat(134));
  console.log("  LEAVE-ONE-OUT từ biến thể vận hành V7: TẮT đúng một cờ để biết cờ đó đóng góp bao nhiêu");
  console.log("=".repeat(134));
  console.log(
    "biến thể".padEnd(34) + "t.hiệu".padStart(6) + "entry".padStart(6) + "lệnh".padStart(6) + "WR".padStart(6) +
      "GROSS".padStart(9) + "gr/lệnh".padStart(8) + "SL tv".padStart(9) + "maxDD".padStart(7) +
      FRICTIONS.map(([l]) => l.split(" ").pop()!.padStart(9)).join("") + "   hoà phí",
  );
  console.log("-".repeat(134));
  const b = runAll(best);
  report("V7 (đầy đủ)", b.all, b.sig, b.fil);
  for (const k of keys) {
    const f = { ...best, [k]: !best[k], label: `  − ${k}` } as Flags;
    const r = runAll(f);
    report(`  TẮT ${k}`, r.all, r.sig, r.fil);
  }

  // ── Bootstrap CI cho gr/lệnh của biến thể tốt nhất ──
  const gs = b.all.map((t) => t.grossR);
  if (gs.length > 10) {
    const B = 5000;
    const means: number[] = [];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < B; i++) {
      let s = 0;
      for (let j = 0; j < gs.length; j++) s += gs[Math.floor(rnd() * gs.length)];
      means.push(s / gs.length);
    }
    means.sort((a, x) => a - x);
    const lo = means[Math.floor(B * 0.05)], hi = means[Math.floor(B * 0.95)];
    const pPos = means.filter((m) => m > 0).length / B;
    console.log(
      `\nBootstrap ${B} lần trên ${gs.length} lệnh của V7: gr/lệnh CI90 [${lo.toFixed(3)}; ${hi.toFixed(3)}]R · P(gross>0) = ${(pPos * 100).toFixed(1)}%`,
    );
    console.log(`⇒ CI ${lo > 0 ? "KHÔNG chứa 0" : "CÒN chứa 0"} — ${lo > 0 ? "edge gộp có ý nghĩa thống kê ở mức 90%" : "chưa đủ bằng chứng, đừng promote"}.`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
