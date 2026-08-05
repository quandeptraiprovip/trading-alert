/**
 * Swing Alert Bot — Swing setup (SMC đa khung), ĐA SYMBOL
 *
 * Mỗi symbol trong CONFIG.symbols chạy ĐỘC LẬP: buffer + tracker + vị thế + cooldown riêng,
 * cùng một logic ARM → MỞ LỆNH → RA LỆNH (SL/TP/trail/time) khớp backtest.
 */

import "./load-env";
import https from "https";
import axios from "axios";
import { fetchKlinesPaged } from "./backtest";
import {
  Candle,
  CONFIG,
  TF_MS,
  aggregate,
  findSwings,
  buildHtfContext,
  SetupTracker,
  htfClosedCount,
  EntrySignal,
} from "./strategy";

// Live data = POLL REST Futures (fapi). Trên nhiều IP cloud, WebSocket Futures bị chặn
// luồng data (handshake mở nhưng 0 message) trong khi REST fapi vẫn trả 200. Bot chỉ
// xử lý nến ĐÓNG nên poll fapi cho ĐÚNG dữ liệu Perpetual (volume/delta khớp backtest).
const FAPI_KLINES = "https://fapi.binance.com/fapi/v1/klines";
// Nhịp poll nến (giây) — cấu hình qua env POLL_INTERVAL_SEC. Mặc định 12s (bắt nến vừa đóng gần
// như tức thì). Tăng lên giảm số request nhưng vào lệnh TRỄ tới ngần ấy (lệch giá so với giá đóng
// nến); SL/TP trên sàn không bị ảnh hưởng. Khuyến nghị ≤ 60s. Chặn ở [5s, 600s].
const POLL_INTERVAL_MS = Math.min(600, Math.max(5, parseInt(process.env.POLL_INTERVAL_SEC ?? "12", 10) || 12)) * 1000;
// keepAlive tái dùng TCP/TLS connection — tránh lỗi "socket disconnected before TLS" trong Docker
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });
const fapiAxios = axios.create({ httpsAgent }); // nến 15m → poll 12s thừa sức bắt nến vừa đóng
import {
  buildArmMessage,
  buildEntryMessage,
  buildExitMessage,
  buildOfflineEntryMessage,
  buildStartupMessage,
  ExitReason,
  formatTimeVn,
  fmtPrice,
  formatSymbol,
  getTelegramUpdates,
  loadTelegramConfig,
  sendTelegram,
  sendTelegramReliable,
  flushPendingTelegram,
  escapeMarkdown,
} from "./telegram";
import { loadState, saveState, appendJournal, PersistedSymbol } from "./live-state";
import { createBinanceFromEnv } from "./binance-futures";
import { createMexcFromEnv } from "./mexc-futures";
import { LiveTrader, loadExecConfig, PosInfo, OpenResult } from "./live-trade";
import { TurtleLive } from "./turtle-live";
import { turtleConfigLine } from "./turtle";
import { FastTrendLive } from "./fast-trend-live";
import { MexcFastExecution } from "./mexc-fast-execution";

const telegram = loadTelegramConfig();

// ── Lớp THỰC THI lệnh thật (tùy chọn) ──────────────────────────────────────
// TRADING_ENABLED=false (mặc định) hoặc thiếu API key → bot chạy ALERT-ONLY y như cũ.
const TRADING_ENABLED = (process.env.TRADING_ENABLED ?? "false").toLowerCase() === "true";
// SMC tắt mặc định: không scan/tạo setup/mở lệnh mới. Nếu state cũ còn vị thế, bot chỉ
// khôi phục và quản lý vị thế đó tới khi thoát (drain-only), tránh bỏ rơi lệnh trên sàn.
const SMC_ENABLED = (process.env.SMC_ENABLED ?? "false").toLowerCase() === "true";
const execCfg = loadExecConfig();
const binance = TRADING_ENABLED ? createBinanceFromEnv() : null;
const trader = binance ? new LiveTrader(binance, execCfg) : null;
let tradingReady = false; // chỉ true sau khi init() (margin/đòn bẩy/filters) thành công
let binancePreflightPassed = false;
const MEXC_ENABLED = (process.env.MEXC_ENABLED ?? "false").toLowerCase() === "true";
const MEXC_TRADING_ENABLED = (process.env.MEXC_TRADING_ENABLED ?? "false").toLowerCase() === "true";
const mexc = MEXC_ENABLED ? createMexcFromEnv() : null;
let mexcTradingReady = false;

// Tiền tố MỌI log bằng giờ Việt Nam (kèm giây) để truy vết sự kiện theo thời gian khi đọc
// `docker logs`. Bọc console 1 lần thay vì sửa từng dòng log.
const logTimeVn = (): string =>
  new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(`[${logTimeVn()}]`, ...args);
}

const BUFFER_SIZE = 1500;
const COMMAND_POLL_MS = 5_000;
// Cảnh báo nếu KHÔNG nhận được phản hồi data nào quá ngưỡng này (vd fapi bị chặn 451).
// Bot poll fapi-only để giữ ĐÚNG dữ liệu Perpetual (volume/delta) — không tự ngầm fallback
// sang spot (sẽ làm lệch tín hiệu); thay vào đó báo Telegram để user xử lý.
// ~6 phút không có data → cảnh báo; nhưng luôn ≥ 2 nhịp poll + 1 phút để poll chậm không báo nhầm.
const HEALTH_TIMEOUT_MS = Math.max(6 * 60 * 1000, POLL_INTERVAL_MS * 2 + 60_000);
const MAX_CATCHUP_BARS = 120; // số nến tối đa fetch để bù gap (~30h nến 15m)
const ltfMs = TF_MS[CONFIG.entryTf];

const SYMBOLS = (CONFIG.symbols.length ? CONFIG.symbols : [CONFIG.symbol]).map((s) => s.toLowerCase());

type LivePosition = {
  dir: "long" | "short";
  entryTime: number;
  entry: number;
  initialSL: number;
  sl: number;
  target: number;
  zoneDesc: string;
  sizeMult?: number; // (#2) optional: state cũ rehydrate có thể thiếu
  quality?: string; // EntrySignal["quality"] khi mở mới; string khi rehydrate từ state cũ
  qty?: number; // khối lượng thật đã khớp (chỉ khi TRADING_ENABLED)
  realEntry?: number; // giá khớp thật (có thể lệch close do slippage)
  riskUsd?: number; // số USD rủi ro của lệnh này
  tpPlaced?: boolean; // false = TP algo không đặt được (SL vẫn bảo vệ, nhưng cần để ý)
};

// State ĐỘC LẬP cho từng symbol (tránh dùng biến toàn cục dùng chung).
type SymbolState = {
  symbol: string;
  buffer: Candle[];
  cooldownUntilTime: number;
  tracker: SetupTracker;
  livePos: LivePosition | null;
  lastOpenTime: number;
  silentMode: boolean; // true khi đang scan detect vị thế — không gửi Telegram
  ticking: boolean; // khoá chống tái-nhập: ngăn 2 tick xử lý song song 1 symbol (tránh double-open)
};

// Tất cả state symbol — module-level để command listener (/status) đọc được.
const states: SymbolState[] = [];

// ── Chia sẻ trần risk danh mục + loại trừ symbol GIỮA 3 lớp (SMC/Turtle/Fast) ──
// SL closePosition đóng CẢ vị thế symbol → 2 lớp không được giữ cùng symbol cùng lúc.
function smcOpenRiskFrac(): number {
  return trader ? states.reduce((sum, s) => sum + (s.livePos ? trader.riskFracOf(s.livePos as PosInfo) : 0), 0) : 0;
}
/** Chỉ các sleeve cùng Binance account mới loại trừ symbol; Fast/MEXC là venue độc lập. */
function otherHoldsSymbolExcept(sym: string, exclude: "turtle" | "fast"): boolean {
  if (isTrading() && states.some((s) => s.symbol === sym && s.livePos)) return true;
  if (exclude !== "turtle" && turtle?.hasRealPosition(sym)) return true;
  return false;
}

// KHÔNG khử trùng lặp xuyên sàn: đã đo (scripts/dedup-crossvenue-impact.ts) — chặn Fast khi Turtle
// giữ cùng symbol+hướng sẽ loại 89% vị thế Fast (phần mang +283,3R) và chỉ giữ nhánh −42,9R.
// Chấp nhận Fast và Turtle cùng cược: NET gộp +1.279,9R / maxDD 94,6R trên 1.050 ngày.

// ── Lớp chiến lược TURTLE (turtle.ts) chạy song song — xem turtle-live.ts ──
// Loại trừ theo symbol với SMC khi giao dịch thật (SL closePosition đóng cả symbol).
const TURTLE_ENABLED = (process.env.TURTLE_ENABLED ?? "true").toLowerCase() === "true";
const TURTLE_TRADING_ENABLED = (process.env.TURTLE_TRADING_ENABLED ?? "true").toLowerCase() === "true";
const TURTLE_RISK_PCT = (() => {
  const n = parseFloat(process.env.TURTLE_RISK_PCT ?? "0.5");
  return (Number.isFinite(n) && n > 0 ? n : 0.5) / 100; // % equity / UNIT (1 vị thế tối đa 4 unit)
})();
// Rổ turtle — HOÁN ĐỔI CHẤT LƯỢNG 2026-07 (giữ NGUYÊN 8 coin, KHÔNG mở rộng để tránh pha loãng
// expectancy như audit exp-turtle-levers.ts đã cảnh báo): BỎ BNB (rủi ro solvency exchange-token +
// đóng góp yếu, nửa OOS gần -4R) → THÊM DOT (robust cả 2 nửa OOS +9.7R). Audit 3-era + perturbation
// đậu (Era A exp +0.083, cả 3 era dương, 30/30 seed). LTC KHÔNG thêm (thua turtle -25R cả 2 nửa).
const TURTLE_SYMBOLS = (process.env.TURTLE_SYMBOLS ?? "btcusdt,ethusdt,solusdt,xrpusdt,dogeusdt,adausdt,avaxusdt,dotusdt")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const turtleTrader = binance && TURTLE_TRADING_ENABLED ? new LiveTrader(binance, { ...execCfg, riskPct: TURTLE_RISK_PCT }) : null;
const turtle: TurtleLive | null = TURTLE_ENABLED
  ? new TurtleLive({
      symbols: TURTLE_SYMBOLS,
      api: binance,
      trader: turtleTrader,
      telegram,
      riskPct: TURTLE_RISK_PCT,
      maxPortfolioRiskPct: execCfg.maxPortfolioRiskPct,
      leverage: execCfg.leverage,
      otherHoldsSymbol: (sym) => otherHoldsSymbolExcept(sym, "turtle"),
      otherOpenRiskFrac: () => smcOpenRiskFrac(),
      isTradingReady: () => tradingReady,
    })
  : null;

// ── Sleeve TREND NHANH (fast-trend-live.ts) — LONG high-breakout 10d; SHORT close-low 30d
// rồi chờ thêm 1 nến 4h xác nhận. Chandelier hai hướng, EMA50 + BTC gate + pyramiding.
// Mặc định shadow/alert-only; chỉ bật tiền thật sau forward-test độc lập.
const FAST_TREND_ENABLED = (process.env.FAST_TREND_ENABLED ?? "true").toLowerCase() === "true";
const FAST_TREND_TRADING_ENABLED = (process.env.FAST_TREND_TRADING_ENABLED ?? "false").toLowerCase() === "true";
const FAST_TREND_RISK_PCT = (() => {
  const n = parseFloat(process.env.FAST_TREND_RISK_PCT ?? "0.5");
  return (Number.isFinite(n) && n > 0 ? n : 0.5) / 100; // % equity / UNIT (1 vị thế tối đa 4 unit)
})();
const FAST_TREND_ENTRY_DAYS = (() => { const n = parseInt(process.env.FAST_TREND_ENTRY_DAYS ?? "10", 10); return Number.isFinite(n) && n >= 2 ? n : 10; })();
const FAST_TREND_SYMBOLS = (process.env.FAST_TREND_SYMBOLS ?? TURTLE_SYMBOLS.join(","))
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MEXC_MAX_PORTFOLIO_RISK_PCT = (() => {
  const n = parseFloat(process.env.MEXC_MAX_PORTFOLIO_RISK_PCT ?? "10");
  return (Number.isFinite(n) && n > 0 ? n : 10) / 100;
})();
const MEXC_LEVERAGE = (() => {
  const n = parseInt(process.env.MEXC_LEVERAGE ?? String(execCfg.leverage), 10);
  return Number.isFinite(n) && n > 0 ? n : execCfg.leverage;
})();
const MEXC_MARGIN_TYPE = (process.env.MEXC_MARGIN_TYPE ?? "ISOLATED").toUpperCase() === "CROSSED" ? "CROSSED" as const : "ISOLATED" as const;
const MEXC_MAX_BASIS_PCT = (() => {
  const n = parseFloat(process.env.MEXC_MAX_BASIS_PCT ?? "0.3");
  return (Number.isFinite(n) && n > 0 ? n : 0.3) / 100;
})();
const fastTrendExecution = mexc && MEXC_TRADING_ENABLED && FAST_TREND_TRADING_ENABLED
  ? new MexcFastExecution(mexc, {
      riskPct: FAST_TREND_RISK_PCT,
      maxPortfolioRiskPct: MEXC_MAX_PORTFOLIO_RISK_PCT,
      leverage: MEXC_LEVERAGE,
      marginType: MEXC_MARGIN_TYPE,
      maxBasisPct: MEXC_MAX_BASIS_PCT,
    })
  : null;
const fastTrend: FastTrendLive | null = FAST_TREND_ENABLED
  ? new FastTrendLive({
      symbols: FAST_TREND_SYMBOLS,
      entryDays: FAST_TREND_ENTRY_DAYS,
      telegram,
      execution: fastTrendExecution,
      riskPct: FAST_TREND_RISK_PCT,
      maxPortfolioRiskPct: MEXC_MAX_PORTFOLIO_RISK_PCT,
      leverage: MEXC_LEVERAGE,
      otherOpenRiskFrac: () => 0,
      isTradingReady: () => mexcTradingReady,
    })
  : null;

function createState(symbol: string, saved?: PersistedSymbol): SymbolState {
  return {
    symbol,
    buffer: [],
    cooldownUntilTime: saved?.cooldownUntilTime ?? 0,
    tracker: new SetupTracker(),
    livePos: saved?.livePos ? { ...saved.livePos } : null,
    lastOpenTime: saved?.lastOpenTime ?? 0,
    silentMode: false,
    ticking: false,
  };
}

/** Lưu toàn bộ state (atomic) — gọi sau mỗi thay đổi (entry/exit/cooldown/nến mới). */
function persist(): void {
  saveState(
    states.map((st) => ({
      symbol: st.symbol,
      lastOpenTime: st.lastOpenTime,
      cooldownUntilTime: st.cooldownUntilTime,
      livePos: st.livePos,
    }))
  );
}

function heldBarsSinceEntry(candle: Candle, entryTime: number): number {
  return Math.round((candle.openTime - entryTime) / ltfMs);
}

function tryExitAndTrail(
  pos: LivePosition,
  c: Candle,
  zoneTf: Candle[],
  zoneSwings: ReturnType<typeof findSwings>
): { exitPrice: number; reason: ExitReason } | null {
  const held = heldBarsSinceEntry(c, pos.entryTime);
  let exitPrice: number | null = null;
  let reason: ExitReason | null = null;

  if (pos.dir === "long") {
    if (c.low <= pos.sl) {
      exitPrice = pos.sl;
      reason = pos.sl > pos.initialSL ? "trail" : "sl";
    } else if (c.high >= pos.target) {
      exitPrice = pos.target;
      reason = "target";
    } else if (held >= CONFIG.maxHoldBars) {
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
    } else if (held >= CONFIG.maxHoldBars) {
      exitPrice = c.close;
      reason = "time";
    }
  }

  if (exitPrice !== null && reason !== null) {
    return { exitPrice, reason };
  }

  if (CONFIG.trailEnabled) {
    const closeTime = c.openTime + ltfMs;
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

  return null;
}

function openLivePosition(st: SymbolState, sig: EntrySignal, candle: Candle): void {
  st.livePos = {
    dir: sig.direction,
    entryTime: candle.openTime,
    entry: sig.entry,
    initialSL: sig.initialSL,
    sl: sig.initialSL,
    target: sig.initialTarget,
    zoneDesc: sig.reason,
    sizeMult: sig.sizeMult,
    quality: sig.quality,
  };
}

function evaluateNewEntry(st: SymbolState, candle: Candle): EntrySignal | null {
  if (st.buffer.length < 400) return null;
  if (candle.openTime < st.cooldownUntilTime) return null;

  const biasTf = aggregate(st.buffer, CONFIG.htfBiasTf, CONFIG.entryTf);
  const zoneTf = aggregate(st.buffer, CONFIG.htfZoneTf, CONFIG.entryTf);
  const biasSwings = findSwings(biasTf);
  const zoneSwings = findSwings(zoneTf);

  const i = st.buffer.length - 1;
  const closeTime = candle.openTime + ltfMs;
  const biasCount = htfClosedCount(biasTf, closeTime);
  const zoneCount = htfClosedCount(zoneTf, closeTime);
  if (biasCount < 5 || zoneCount < CONFIG.volAvgPeriod) return null;

  const ctx = buildHtfContext(biasTf, zoneTf, biasSwings, zoneSwings, biasCount - 1, zoneCount - 1);
  const hadPending = st.tracker.pending !== null;
  const sig = st.tracker.update(st.buffer, i, ctx);

  if (!sig && !hadPending && st.tracker.pending) {
    void maybeSendArmAlert(st, st.tracker.pending, candle);
  }

  return sig;
}

async function maybeSendArmAlert(
  st: SymbolState,
  setup: NonNullable<SetupTracker["pending"]>,
  candle: Candle
): Promise<void> {
  const tag = formatSymbol(st.symbol);
  if (st.silentMode) return;
  const msg = buildArmMessage(setup, candle, st.symbol);
  console.log(`\n[ARM] ${tag} ${setup.direction.toUpperCase()} tap vùng @ $${fmtPrice(candle.close)}`);
  await sendTelegram(telegram, msg);
}

async function notifyEntry(st: SymbolState, sig: EntrySignal, candle: Candle): Promise<void> {
  if (st.silentMode) {
    console.log(`[Scan] ${formatSymbol(st.symbol)} ENTRY ${sig.direction.toUpperCase()} @ $${fmtPrice(sig.entry)} — ${formatTimeVn(candle.openTime)}`);
    return;
  }
  // Vào lệnh là sự kiện quan trọng → LUÔN báo (không cooldown).
  let msg = buildEntryMessage(sig, candle, st.symbol);
  const p = st.livePos;
  if (p?.qty != null) {
    // Đã đặt lệnh THẬT — kèm khối lượng/giá khớp/risk/SL/TP
    msg += `\n\n💵 *Đã vào lệnh thật*: ${p.qty} @ $${fmtPrice(p.realEntry ?? sig.entry)}`;
    msg += `\n🛡 SL $${fmtPrice(sig.initialSL)} · 🎯 TP $${fmtPrice(sig.initialTarget)}`;
    if (p.riskUsd != null) msg += ` · risk $${p.riskUsd.toFixed(2)}`;
    if (p.tpPlaced === false) msg += `\n⚠️ *TP chưa đặt được trên sàn* — SL vẫn bảo vệ, nhưng hãy đặt TP thủ công.`;
  }
  console.log(`\n[ENTRY] ${formatSymbol(st.symbol)} ${sig.direction.toUpperCase()} @ $${fmtPrice(sig.entry)}${p?.qty != null ? ` · qty ${p.qty}` : ""}`);
  appendJournal({
    event: "entry",
    real: isTrading(), // true = lệnh THẬT đã đặt trên sàn; false = alert-only (paper)
    symbol: st.symbol,
    dir: sig.direction,
    time: candle.openTime,
    timeVn: formatTimeVn(candle.openTime),
    entry: sig.entry,
    initialSL: sig.initialSL,
    target: sig.initialTarget,
    rr: sig.rr,
    reason: sig.reason,
  });
  await sendTelegram(telegram, msg);
}

async function notifyExit(st: SymbolState, pos: LivePosition, c: Candle, exitPrice: number, reason: ExitReason): Promise<void> {
  if (st.silentMode) {
    const risk = Math.abs(pos.entry - pos.initialSL);
    const pnl = pos.dir === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
    const r = risk > 0 ? pnl / risk : 0;
    console.log(`[Scan] ${formatSymbol(st.symbol)} EXIT ${pos.dir.toUpperCase()} ${reason} @ $${fmtPrice(exitPrice)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R) — ${formatTimeVn(c.openTime)}`);
    return;
  }
  const risk = Math.abs(pos.entry - pos.initialSL);
  const pnl = pos.dir === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
  const grossR = risk > 0 ? pnl / risk : 0;
  const holdBars = heldBarsSinceEntry(c, pos.entryTime);
  const msg = buildExitMessage({
    dir: pos.dir,
    entryPrice: pos.entry,
    initialSL: pos.initialSL,
    exitPrice,
    exitReason: reason,
    grossR,
    holdBars,
    exitTime: c.openTime,
    symbol: st.symbol,
  });
  console.log(`\n[EXIT] ${formatSymbol(st.symbol)} ${pos.dir.toUpperCase()} ${reason} @ $${fmtPrice(exitPrice)} (${grossR >= 0 ? "+" : ""}${grossR.toFixed(2)}R)`);
  appendJournal({
    event: "exit",
    real: isTrading(), // true = lệnh THẬT trên sàn; false = alert-only (paper) → dashboard không tính
    symbol: st.symbol,
    dir: pos.dir,
    time: c.openTime,
    timeVn: formatTimeVn(c.openTime),
    entry: pos.entry,
    initialSL: pos.initialSL,
    exitPrice,
    reason,
    grossR,
    holdBars,
  });
  await sendTelegram(telegram, msg);
}

// ── Cầu nối THỰC THI: chỉ hoạt động khi có trader & KHÔNG ở chế độ silent (replay) ──
/** Bot đang ở chế độ GIAO DỊCH THẬT (đã preflight OK)? Dùng để gắn cờ `real` cho journal. */
function isTrading(): boolean {
  return !!trader && tradingReady;
}
function tradingActive(st: SymbolState): boolean {
  return isTrading() && !st.silentMode;
}

/** Tổng risk các vị thế ĐANG mở (trừ symbol đang xét) — để áp trần danh mục CHUNG với turtle. */
function openRiskFracExcluding(symbol: string): number {
  if (!trader) return 0;
  let sum = 0;
  for (const s of states) {
    if (s.symbol === symbol || !s.livePos) continue;
    sum += trader.riskFracOf(s.livePos as PosInfo);
  }
  return sum + (turtle?.openRiskFrac() ?? 0);
}

/** Mở lệnh thật. Trả OpenResult (placed true/false) hoặc null nếu LỖI (đã báo Telegram). */
async function execOpen(st: SymbolState, sig: EntrySignal): Promise<OpenResult | null> {
  if (!SMC_ENABLED || !trader || !st.livePos) return null;
  try {
    return await trader.open(st.symbol, sig.entry, st.livePos as PosInfo, openRiskFracExcluding(st.symbol));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Trade] ${formatSymbol(st.symbol)} LỖI mở lệnh:`, msg);
    await sendTelegram(telegram, `❌ *Lỗi đặt lệnh* ${formatSymbol(st.symbol)} — ${escapeMarkdown(msg)}\nBot KHÔNG vào lệnh này.`);
    return null;
  }
}

async function execSyncStops(st: SymbolState): Promise<void> {
  if (!trader || !st.livePos) return;
  try {
    await trader.syncStops(st.symbol, st.livePos as PosInfo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Trade] ${formatSymbol(st.symbol)} LỖI dời SL:`, msg);
    await sendTelegram(telegram, `⚠️ *Lỗi dời SL* ${formatSymbol(st.symbol)} — ${escapeMarkdown(msg)}\nKiểm tra lệnh chờ trên sàn.`);
  }
}

async function execFlatten(st: SymbolState, dir: "long" | "short"): Promise<void> {
  if (!trader) return;
  try {
    await trader.flatten(st.symbol, dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Trade] ${formatSymbol(st.symbol)} LỖI đóng lệnh:`, msg);
    await sendTelegram(telegram, `⚠️ *Lỗi đóng lệnh* ${formatSymbol(st.symbol)} — ${escapeMarkdown(msg)}\nKIỂM TRA vị thế trên sàn thủ công!`);
  }
}

/** Lưới an toàn: nếu sàn đã FLAT (SL/TP khớp lúc bot offline) mà bot tưởng còn giữ → chốt sổ. */
async function reconcileFlat(st: SymbolState, candle: Candle): Promise<boolean> {
  if (!trader || !st.livePos) return false;
  try {
    const p = await trader.reconcile(st.symbol);
    if (Math.abs(p.positionAmt) > 0) return false; // vẫn còn mở trên sàn
  } catch {
    return false; // lỗi mạng → để lần sau xử lý
  }
  const pos = st.livePos;
  const dTP = Math.abs(candle.close - pos.target);
  const dSL = Math.abs(candle.close - pos.sl);
  const reason: ExitReason = dTP < dSL ? "target" : pos.sl !== pos.initialSL ? "trail" : "sl";
  const exitPrice = dTP < dSL ? pos.target : pos.sl;
  console.log(`[Trade] ${formatSymbol(st.symbol)} sàn đã FLAT — chốt sổ (${reason} @ $${fmtPrice(exitPrice)})`);
  await execFlatten(st, pos.dir); // huỷ lệnh chờ còn sót
  await notifyExit(st, pos, candle, exitPrice, reason);
  st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
  st.livePos = null;
  st.tracker.reset();
  return true;
}

/** Đối soát LÚC KHỞI ĐỘNG: khớp state bot ↔ vị thế thật trên sàn (chống trần/orphan/desync). */
async function reconcileStartup(): Promise<void> {
  if (!trader) return;
  for (const st of states) {
    let p;
    try {
      p = await trader.reconcile(st.symbol);
    } catch (e) {
      console.warn(`[Reconcile] ${formatSymbol(st.symbol)} không đọc được vị thế: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const exHas = Math.abs(p.positionAmt) > 0;
    const exDir: "long" | "short" = p.positionAmt > 0 ? "long" : "short";

    if (st.livePos && exHas) {
      if (exDir !== st.livePos.dir) {
        await sendTelegram(telegram, `⚠️ *Lệch hướng* ${formatSymbol(st.symbol)}: bot=${st.livePos.dir.toUpperCase()} nhưng sàn=${exDir.toUpperCase()}. KIỂM TRA THỦ CÔNG.`);
        continue;
      }
      try {
        const prot = await trader.ensureProtection(st.symbol, st.livePos as PosInfo);
        console.log(`[Reconcile] ${formatSymbol(st.symbol)} khớp ${exDir} — SL ${prot.slPrice} TP ${prot.tpPrice}`);
      } catch (e) {
        console.warn(`[Reconcile] ${formatSymbol(st.symbol)} ensureProtection lỗi: ${e instanceof Error ? e.message : e}`);
      }
    } else if (st.livePos && !exHas) {
      const last = st.buffer[st.buffer.length - 1];
      if (last) await reconcileFlat(st, last); // bot giữ nhưng sàn đã flat → chốt sổ
    } else if (!st.livePos && exHas) {
      await adoptPosition(st, p); // sàn có vị thế mà bot không biết → nhận quản lý
    }
  }
}

/** Nhận quản lý vị thế "orphan" trên sàn (bot mất state). Đặt SL khẩn cấp nếu sàn thiếu SL. */
async function adoptPosition(st: SymbolState, p: { positionAmt: number; entryPrice: number }): Promise<void> {
  if (!trader) return;
  const dir: "long" | "short" = p.positionAmt > 0 ? "long" : "short";
  const entry = p.entryPrice;
  let prot: { slPrice: number | null; tpPrice: number | null };
  try {
    prot = await trader.readProtection(st.symbol);
  } catch {
    prot = { slPrice: null, tpPrice: null };
  }
  let sl = prot.slPrice;
  let emergency = false;
  if (sl == null) {
    try {
      sl = await trader.placeEmergencyStop(st.symbol, dir, entry);
      emergency = true;
    } catch (e) {
      await sendTelegram(telegram, `❌ *ORPHAN KHÔNG SL* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} @ $${fmtPrice(entry)} — đặt SL khẩn cấp THẤT BẠI. ĐÓNG THỦ CÔNG NGAY (${escapeMarkdown(e instanceof Error ? e.message : String(e))}).`);
      return;
    }
  }
  // Không có TP thật trên sàn → đặt mốc KHÔNG VỚI TỚI (JSON-safe) để CHỈ SL + thời-gian-giữ quản lý
  // orphan, tránh đóng nhầm tại một target bịa ra. (Dùng Infinity sẽ thành null khi lưu JSON → nguy hiểm.)
  const target = prot.tpPrice ?? (dir === "long" ? entry * 100 : entry * 0.01);
  const last = st.buffer[st.buffer.length - 1];
  st.livePos = {
    dir,
    entryTime: last ? last.openTime : Date.now(),
    entry,
    initialSL: sl,
    sl,
    target,
    zoneDesc: "adopted-on-restart",
    quality: "?",
    qty: Math.abs(p.positionAmt),
  };
  persist();
  await sendTelegram(telegram, `🔁 *ADOPT vị thế orphan* ${formatSymbol(st.symbol)} ${dir.toUpperCase()} @ $${fmtPrice(entry)}\nSL $${fmtPrice(sl)}${emergency ? " (KHẨN CẤP — sàn thiếu SL)" : ""} · TP $${fmtPrice(target)} · qty ${Math.abs(p.positionAmt)}`);
}

async function onCandleClose(st: SymbolState, candle: Candle): Promise<void> {
  st.lastOpenTime = candle.openTime;
  st.buffer.push(candle);
  if (st.buffer.length > BUFFER_SIZE) st.buffer.shift();

  const zoneTf = aggregate(st.buffer, CONFIG.htfZoneTf, CONFIG.entryTf);
  const zoneSwings = findSwings(zoneTf);

  if (st.livePos) {
    const oldSL = st.livePos.sl;
    const exit = tryExitAndTrail(st.livePos, candle, zoneTf, zoneSwings);
    if (exit) {
      if (tradingActive(st)) await execFlatten(st, st.livePos.dir);
      await notifyExit(st, st.livePos, candle, exit.exitPrice, exit.reason);
      st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
      st.livePos = null;
      st.tracker.reset();
      persist();
      return;
    }
    if (tradingActive(st)) {
      if (await reconcileFlat(st, candle)) {
        persist();
        return;
      }
      if (st.livePos.sl !== oldSL) await execSyncStops(st); // trail dời SL → cập nhật trên sàn
    }
    persist(); // sl/trail có thể đã dời (tryExitAndTrail mutate pos.sl)
    return;
  }

  // SMC đã tắt: state cũ chỉ được drain tới flat, tuyệt đối không ARM hay mở lệnh mới.
  if (!SMC_ENABLED) {
    st.tracker.reset();
    persist();
    return;
  }

  const sig = evaluateNewEntry(st, candle);
  if (!sig) {
    persist(); // lưu lastOpenTime tiến lên (để resume đúng sau restart)
    return;
  }

  // Loại trừ symbol với lớp Turtle: SL closePosition của 2 lớp trên cùng symbol đóng lẫn nhau.
  // Chỉ chặn khi turtle giữ vị thế THẬT (vị thế "giấy" không chặn).
  if (turtle?.hasRealPosition(st.symbol)) {
    console.log(`[Entry] ${formatSymbol(st.symbol)} bỏ tín hiệu ${sig.direction.toUpperCase()} — Turtle đang giữ symbol`);
    if (!st.silentMode) {
      await sendTelegram(telegram, `⏭️ *Bỏ qua lệnh* ${formatSymbol(st.symbol)} ${sig.direction.toUpperCase()} — lớp Turtle đang giữ symbol này.`);
    }
    st.tracker.reset();
    st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
    persist();
    return;
  }

  openLivePosition(st, sig, candle);
  const pos = st.livePos!; // vừa được gán ở openLivePosition

  if (tradingActive(st)) {
    const res = await execOpen(st, sig);
    if (!res || !res.placed) {
      // KHÔNG vào lệnh thật (lỗi/trần danh mục/min) → bỏ setup, giữ flat & cooldown để bot khớp sàn
      st.livePos = null;
      st.tracker.reset();
      st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
      if (res && res.reason) {
        await sendTelegram(telegram, `⏭️ *Bỏ qua lệnh* ${formatSymbol(st.symbol)} ${sig.direction.toUpperCase()} — ${escapeMarkdown(res.reason)}`);
      }
      persist();
      return;
    }
    pos.qty = res.qty;
    pos.realEntry = res.avgPrice;
    pos.riskUsd = res.riskUsd;
    pos.tpPlaced = res.tpPlaced;

    // Xác nhận ngay: sàn phải có positionAmt > 0 sau khi MARKET khớp
    try {
      const exchange = await trader!.reconcile(st.symbol);
      if (!(Math.abs(exchange.positionAmt) > 0)) {
        console.error(`[Trade] ${formatSymbol(st.symbol)} XÁC NHẬN THẤT BẠI — positionAmt=0 sau khi MARKET báo khớp`);
        await sendTelegram(telegram, `❌ *Lỗi xác nhận vị thế* ${formatSymbol(st.symbol)} — MARKET báo khớp nhưng sàn positionAmt=0\\. KIỂM TRA TÀI KHOẢN NGAY\\!`);
        st.livePos = null;
        st.tracker.reset();
        st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
        persist();
        return;
      }
    } catch (e) {
      // Lỗi mạng khi xác nhận → cảnh báo nhưng không huỷ state (SL đã đặt trên sàn)
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Trade] ${formatSymbol(st.symbol)} không xác nhận được vị thế: ${msg}`);
      await sendTelegram(telegram, `⚠️ *Không xác nhận được vị thế* ${formatSymbol(st.symbol)} — ${escapeMarkdown(msg)}\\nSL đã đặt\\. Bot tiếp tục theo dõi\\.`);
    }
  }

  await notifyEntry(st, sig, candle);
  persist();
}

// Tải lịch sử warmup. Nếu resumeFrom hữu hạn (rehydrate sau restart): nến <= resumeFrom là
// warmup tĩnh, nến > resumeFrom được REPLAY qua onCandleClose để bắt exit/entry đã xảy ra
// trong lúc bot tắt (downtime). resumeFrom = Infinity → khởi động sạch (toàn bộ là warmup).
async function prefetchHistory(st: SymbolState): Promise<void> {
  console.log(`[Init] ${formatSymbol(st.symbol)} — tải lịch sử 15m để warmup...`);
  const candles = await fetchKlinesPaged(st.symbol, CONFIG.entryTf, BUFFER_SIZE);
  candles.pop(); // bỏ nến hiện tại (chưa đóng)
  if (candles.length === 0) {
    console.warn(`[Init] ${formatSymbol(st.symbol)} không tải được nến nào.`);
    return;
  }

  if (!SMC_ENABLED) {
    st.buffer = candles.slice(-BUFFER_SIZE);
    st.lastOpenTime = st.buffer[st.buffer.length - 1]?.openTime ?? st.lastOpenTime;
    st.tracker.reset();
    console.log(`[Init] ${formatSymbol(st.symbol)} — SMC drain-only, giữ state vị thế cũ; không replay entry.`);
    return;
  }

  // Luôn chạy silent scan toàn bộ buffer — chart là source of truth, không phụ thuộc file.
  // Reset livePos + tracker trước để strategy tự phát hiện lại từ đầu.
  st.livePos = null;
  st.tracker = new SetupTracker();
  st.buffer = [];
  console.log(`[Init] ${formatSymbol(st.symbol)} — silent scan ${candles.length} nến để phát hiện vị thế đang mở...`);
  st.silentMode = true;
  for (const c of candles) await onCandleClose(st, c);
  st.silentMode = false;
  const tail = st.buffer[st.buffer.length - 1];
  const lp = st.livePos as LivePosition | null;
  const holding = lp
    ? ` · PHÁT HIỆN vị thế ${lp.dir.toUpperCase()} (entry $${fmtPrice(lp.entry)})`
    : " · flat";
  console.log(`[Init] ${formatSymbol(st.symbol)} OK — ${st.buffer.length} nến (tới ${tail ? formatTimeVn(tail.openTime) : "?"})${holding}`);
}

// Lấy MỌI nến 15m đã ĐÓNG mới hơn `since` từ Futures REST (sắp xếp tăng dần). limit lớn để
// bù gap khi bot lỡ vài nến (mạng chập / 429 / downtime ngắn) — backtest xử lý mọi nến nên
// live cũng phải replay đủ, tránh bỏ sót exit/entry trong nến bị nhỡ.
async function fetchClosedSince(symbol: string, since: number): Promise<Candle[]> {
  const res = await fapiAxios.get(FAPI_KLINES, {
    params: { symbol: symbol.toUpperCase(), interval: CONFIG.entryTf, limit: MAX_CATCHUP_BARS },
    timeout: 30000,
  });
  const arr = res.data as any[];
  if (!Array.isArray(arr)) return [];
  const nowMs = Date.now();
  return arr
    .map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVolume: parseFloat(k[7]), // dollar volume
      takerBuyVolume: parseFloat(k[9]), // taker-buy base (cho delta/CVD)
    }))
    .filter((c) => c.openTime + ltfMs <= nowMs) // chỉ nến ĐÃ đóng hoàn toàn
    .filter((c) => c.openTime > since) // chỉ nến mới hơn lần xử lý cuối
    .sort((a, b) => a.openTime - b.openTime);
}

// ── Health monitor: cảnh báo nếu mất luồng data quá lâu (fapi 451 / mất mạng) ──
let lastDataAt = Date.now();
let healthAlerted = false;

function markData(): void {
  lastDataAt = Date.now();
  if (healthAlerted) {
    healthAlerted = false;
    void sendTelegramReliable(telegram, `✅ *Bot phục hồi* — đã nhận lại dữ liệu nến.\n🕐 ${formatTimeVn(Date.now())}`);
  }
}

function startHealthMonitor(): void {
  setInterval(() => {
    void flushPendingTelegram(telegram); // thử gửi lại alert kẹt từ lúc mất mạng
    if (healthAlerted || Date.now() - lastDataAt <= HEALTH_TIMEOUT_MS) return;
    healthAlerted = true;
    const mins = Math.round((Date.now() - lastDataAt) / 60_000);
    console.error(`[Health] ⚠️ Không nhận được data ~${mins} phút.`);
    void sendTelegramReliable(
      telegram,
      `⚠️ *Bot mất dữ liệu* — không có nến mới ~${mins} phút.\nCó thể fapi bị chặn (451) hoặc mất mạng. Kiểm tra \`pm2 logs\`.\n🕐 ${formatTimeVn(Date.now())}`
    );
  }, 60_000);
}

// ── Giám sát KẾT NỐI BINANCE (API ký) — ping read-only định kỳ ──
// Bắt sớm trường hợp key/IP chết (đổi IP → -2015), mất mạng, 451… mà không cần đợi sự kiện trade.
let binanceDown = false;
let mexcDown = false;
const BINANCE_HEALTH_MS = 5 * 60 * 1000;
const MEXC_HEALTH_MS = 5 * 60 * 1000;

function startBinanceHealthMonitor(): void {
  if (!binance) return;
  const check = async (): Promise<void> => {
    void flushPendingTelegram(telegram); // thử gửi lại alert kẹt từ lúc mất mạng
    try {
      await binance.getEquity(); // signed read — xác thực kết nối + key + IP
      if (binanceDown) {
        binanceDown = false;
        tradingReady = binancePreflightPassed;
        console.log("[Health] ✅ Kết nối Binance phục hồi.");
        await sendTelegramReliable(telegram, `✅ *Kết nối Binance phục hồi*\n🕐 ${formatTimeVn(Date.now())}`);
      }
    } catch (err: any) {
      tradingReady = false;
      if (binanceDown) return; // đã báo rồi, không spam
      binanceDown = true;
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.msg ?? (err instanceof Error ? err.message : String(err));
      // Binance trả kèm "request ip: x.x.x.x" trong msg khi -2015 — bóc ra để chỉ thẳng IP cần whitelist
      // (thấy đúng scenario này đêm 16→17/7: ISP đổi IP nhà, key mất quyền cho tới khi cập nhật whitelist).
      const ipMatch = /request ip:\s*([\d.]+)/i.exec(String(msg));
      let hint = "";
      if (code === -2015 || code === -2014) {
        hint = ipMatch
          ? `\n⚠️ IP máy đã ĐỔI thành \`${ipMatch[1]}\` và chưa có trong whitelist API key. Vào Binance → API Management, thêm IP này.`
          : "\n⚠️ IP máy có thể đã ĐỔI và không còn trong whitelist API, hoặc key thiếu quyền Futures.";
      } else if (code === -1021) hint = "\n⚠️ Lệch đồng hồ máy (timestamp).";
      else if (!err?.response) hint = "\n⚠️ Mất mạng hoặc Binance bị chặn (451) từ IP này.";
      console.error(`[Health] 🔌 Mất kết nối Binance${code ? ` (code ${code})` : ""}: ${msg}`);
      await sendTelegramReliable(
        telegram,
        `🔌 *MẤT KẾT NỐI BINANCE*${code ? ` (code ${code})` : ""} — ${escapeMarkdown(msg)}${hint}\n\n` +
          `SL/TP đã đặt trên sàn VẪN bảo vệ vị thế, nhưng bot KHÔNG vào lệnh mới / trail / time-exit cho tới khi kết nối lại.\n🕐 ${formatTimeVn(Date.now())}`
      );
    }
  };
  setInterval(() => void check(), BINANCE_HEALTH_MS);
  console.log(`[Health] ✅ Giám sát kết nối Binance mỗi ${BINANCE_HEALTH_MS / 60000} phút`);
}

function startMexcHealthMonitor(): void {
  if (!mexc) return;
  const check = async (): Promise<void> => {
    void flushPendingTelegram(telegram);
    try {
      await mexc.getEquity();
      const recovered = mexcDown;
      mexcDown = false;
      if (fastTrendExecution && MEXC_TRADING_ENABLED && (recovered || !mexcTradingReady)) {
        try {
          mexcTradingReady = (await fastTrendExecution.preflight(FAST_TREND_SYMBOLS)).ok;
        } catch {
          mexcTradingReady = false;
        }
      }
      if (recovered) {
        console.log("[Health] ✅ Kết nối MEXC phục hồi.");
        await sendTelegramReliable(telegram, `✅ *Kết nối MEXC phục hồi* · entry readiness ${mexcTradingReady ? "BẬT" : "vẫn TẮT"}\n🕐 ${formatTimeVn(Date.now())}`);
      }
    } catch (err: any) {
      mexcTradingReady = false; // chỉ chặn exposure mới; Fast vẫn tiếp tục reconcile/exit
      if (mexcDown) return;
      mexcDown = true;
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.message ?? err?.response?.data?.msg ?? (err instanceof Error ? err.message : String(err));
      console.error(`[Health] 🔌 Mất kết nối MEXC${code ? ` (code ${code})` : ""}: ${msg}`);
      await sendTelegramReliable(
        telegram,
        `🔌 *MẤT KẾT NỐI MEXC*${code ? ` (code ${code})` : ""} — ${escapeMarkdown(String(msg))}\n\n` +
          `Fast không mở/add mới. Native stop trên MEXC vẫn bảo vệ vị thế; bot tiếp tục thử reconcile/exit.\n🕐 ${formatTimeVn(Date.now())}`,
      );
    }
  };
  setInterval(() => void check(), MEXC_HEALTH_MS);
  console.log(`[Health] ✅ Giám sát kết nối MEXC mỗi ${MEXC_HEALTH_MS / 60000} phút`);
}

/** /health: signed read-only account check; tuyệt đối không đặt/hủy lệnh. */
async function buildHealthMessage(): Promise<string> {
  const now = Date.now();
  const dataAgeMs = now - lastDataAt;
  const dataAgeSec = Math.max(0, Math.round(dataAgeMs / 1000));
  const dataFresh = dataAgeMs <= HEALTH_TIMEOUT_MS;
  const binanceMode = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() === "false" ? "MAINNET" : "TESTNET";
  const usd = (n: number): string =>
    Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "n/a";

  const lines = [
    `🩺 *HEALTH* — ${formatTimeVn(now)}`,
    `Telegram: ✅ nhận lệnh`,
    SMC_ENABLED
      ? `Data Futures SMC: ${dataFresh ? "✅" : "⚠️"} phản hồi gần nhất ${dataAgeSec}s trước`
      : `Data Futures SMC: ⚪ tắt`,
    `Routing: Turtle → Binance · Fast → MEXC`,
    `Binance entry: ${tradingReady ? "✅ READY" : "⚠️ OFF"} · MEXC entry: ${mexcTradingReady ? "✅ READY" : "⚠️ OFF"}`,
    `SMC ${SMC_ENABLED ? (trader && tradingReady ? "LIVE" : "alert-only") : states.some((s) => s.livePos) ? "DRAIN-ONLY" : "TẮT"} · Turtle ${turtleTrader && tradingReady ? "BINANCE LIVE" : "alert-only"} · Fast ${fastTrendExecution && mexcTradingReady ? "MEXC LIVE" : "alert-only"}`,
    // Luật ĐANG CHẠY của process này — để xác nhận deploy từ Telegram, không cần đọc log container.
    `Turtle rule: ${turtleConfigLine()}`,
    ``,
  ];

  lines.push(`🏦 *Binance / Turtle*`);
  if (!TRADING_ENABLED) lines.push("Signed API: ⚪ tắt bởi `TRADING_ENABLED=false`");
  else if (!binance) lines.push("Signed API: ❌ thiếu `BINANCE_API_KEY` / `BINANCE_API_SECRET`");
  else {
    try {
      const e = await binance.getEquity();
      const marginUsedPct = e.marginBalance > 0 ? (e.initialMargin / e.marginBalance) * 100 : 0;
      lines.push(
        `${binanceMode}: ✅ key / IP OK`,
        `Wallet/available: $${usd(e.walletBalance)} / $${usd(e.available)}`,
        `Unrealized: ${e.unrealized >= 0 ? "+" : ""}$${usd(e.unrealized)} · margin used ${marginUsedPct.toFixed(1)}%`,
      );
    } catch (err: any) {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.msg ?? (err instanceof Error ? err.message : String(err));
      lines.push(`❌ signed API${code ? ` code ${code}` : ""}: ${escapeMarkdown(String(msg))}`);
    }
  }

  lines.push(``, `🏦 *MEXC / Fast Trend*`);
  if (!MEXC_ENABLED) lines.push("Signed API: ⚪ tắt bởi `MEXC_ENABLED=false`");
  else if (!mexc) lines.push("Signed API: ❌ thiếu `MEXC_API_KEY` / `MEXC_API_SECRET`");
  else {
    try {
      const asset = await mexc.getEquity(); // proves key/IP/account-read independently of doc schema quirks
      const [mode, positions] = await Promise.all([
        mexc.getPositionMode().catch(() => 0),
        mexc.getOpenPositions().catch(() => []),
      ]);
      const runtime = fastTrend?.runtimeSummary();
      lines.push(
        `MAINNET: ✅ key / IP OK · ${mode === 2 ? "One-way ✅" : mode === 1 ? "Hedge ❌" : "position mode chưa xác minh ⚠️"}`,
        `Equity/available: $${usd(asset.equity)} / $${usd(asset.availableOpen)}`,
        `Unrealized: ${asset.unrealized >= 0 ? "+" : ""}$${usd(asset.unrealized)} · exchange positions ${positions.length}`,
        `Fast state: real ${runtime?.real ?? 0} · paper ${runtime?.paper ?? 0} · armed ${runtime?.armed ?? 0} · pending ${runtime?.pending ?? 0} · quarantine ${runtime?.quarantined ?? 0}`,
        `State storage: ${runtime?.persistenceHealthy !== false ? "✅ OK" : `❌ ERROR — ${escapeMarkdown(runtime.persistenceError ?? "không rõ")}`}`,
      );
    } catch (err: any) {
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.message ?? err?.response?.data?.msg ?? (err instanceof Error ? err.message : String(err));
      lines.push(`❌ signed API${code ? ` code ${code}` : ""}: ${escapeMarkdown(String(msg))}`);
    }
  }
  return lines.join("\n");
}

// Cổng rate-limit TOÀN CỤC: 429/418 là giới hạn theo IP (mọi symbol chung 1 IP).
// Khi dính, cho TẤT CẢ symbol cùng nghỉ tới mốc này — tránh thundering herd (4 symbol
// cùng retry sẽ giữ IP bị giới hạn, thậm chí leo thang 429→418 ban IP).
let rateLimitedUntil = 0;

function startPolling(st: SymbolState, initialDelayMs = 0): void {
  console.log(
    `[Poll] ✅ Theo dõi ${formatSymbol(st.symbol)} ${CONFIG.entryTf} (Futures REST, mỗi ${POLL_INTERVAL_MS / 1000}s)`
  );
  const tick = async (): Promise<void> => {
    if (!SMC_ENABLED && !st.livePos) return; // drain xong: ngừng fetch SMC, interval chỉ còn no-op
    if (Date.now() < rateLimitedUntil) return; // đang trong cửa sổ nghỉ rate-limit chung
    if (st.ticking) return; // tick trước CHƯA xong (đặt lệnh/replay chậm) → bỏ nhịp, tránh DOUBLE-OPEN
    st.ticking = true;
    try {
    let retryDelay = 5_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const candles = await fetchClosedSince(st.symbol, st.lastOpenTime);
        markData(); // phản hồi 200 = luồng data còn sống
        for (const c of candles) await onCandleClose(st, c); // replay TUẦN TỰ mọi nến đã đóng bị lỡ
        return;
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 429 || status === 418) {
          // Tôn trọng Retry-After của Binance; thiếu header thì backoff lũy thừa.
          const ra = parseInt(err?.response?.headers?.["retry-after"] ?? "", 10);
          const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : retryDelay;
          rateLimitedUntil = Date.now() + waitMs; // chặn MỌI symbol cùng nghỉ
          console.warn(`[Poll] ${formatSymbol(st.symbol)} ${status} rate-limit IP — TẤT CẢ nghỉ ${Math.round(waitMs / 1000)}s`);
          return; // không retry vòng trong: gate sẽ chặn các tick kế tiếp
        }
        const isRetryable = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET" || !status;
        if (isRetryable && attempt < 2) {
          console.warn(`[Poll] ${formatSymbol(st.symbol)} ${err?.code ?? "timeout"} — thử lại sau ${retryDelay / 1000}s`);
          await new Promise((r) => setTimeout(r, retryDelay));
          retryDelay *= 2;
        } else {
          console.error(`[Poll] ${formatSymbol(st.symbol)} Lỗi fetch:`, msg);
          return;
        }
      }
    }
    } finally {
      st.ticking = false; // luôn mở khoá dù tick thành công/lỗi/return giữa chừng
    }
  };
  // Stagger: delay khởi động để các symbol không poll cùng lúc
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, initialDelayMs);
}

// ── Heartbeat: tự đẩy cờ trading THỰC TẾ của process đang chạy (khắc phục A4) ──
// Sự cố 02/08/2026: .env.local tắt Fast/MEXC lúc 23:13 nhưng process cũ vẫn đặt 3 lệnh thật lúc
// 03:01 hôm sau. /health hiển thị đúng nhưng phải có người gõ mới thấy — nên đẩy chủ động.
const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
function startDailyHeartbeat(): void {
  const send = async (): Promise<void> => {
    try {
      await sendTelegram(telegram, await buildHealthMessage());
    } catch (err) {
      console.error("[Heartbeat] lỗi gửi:", err instanceof Error ? err.message : String(err));
    }
  };
  setInterval(() => void send(), HEARTBEAT_MS);
  console.log(`[Heartbeat] ✅ Tự báo cờ trading mỗi ${HEARTBEAT_MS / 3_600_000}h`);
}

// ── Lệnh /status: liệt kê lệnh đang giữ / chờ trên từng symbol ──
function buildStatusMessage(): string {
  const smcMode = SMC_ENABLED ? `${states.length} symbol` : states.some((s) => s.livePos) ? "TẮT · đang drain vị thế cũ" : "TẮT";
  const fastRuntime = fastTrend?.runtimeSummary();
  const lines = [
    `📊 *Trạng thái bot*`,
    `Routing: Turtle → Binance · Fast → MEXC`,
    `Binance ${tradingReady ? "✅ READY" : "⚠️ OFF"} · MEXC ${mexcTradingReady ? "✅ READY" : "⚠️ OFF"}`,
    `SMC: ${smcMode}`,
    `Fast/MEXC: real ${fastRuntime?.real ?? 0} · paper ${fastRuntime?.paper ?? 0} · armed ${fastRuntime?.armed ?? 0} · pending ${fastRuntime?.pending ?? 0} · quarantine ${fastRuntime?.quarantined ?? 0} · storage ${fastRuntime?.persistenceHealthy !== false ? "✅" : "❌"}`,
    ``,
  ];
  let open = 0;
  for (const st of states) {
    const tag = formatSymbol(st.symbol);
    const last = st.buffer[st.buffer.length - 1];
    const cur = last ? last.close : 0;
    if (st.livePos) {
      open++;
      const p = st.livePos;
      const risk = Math.abs(p.entry - p.initialSL);
      const r = risk > 0 ? (p.dir === "long" ? cur - p.entry : p.entry - cur) / risk : 0;
      const heldDays = ((Date.now() - p.entryTime) / TF_MS["1d"]).toFixed(1);
      const icon = p.dir === "long" ? "🟢 LONG" : "🔴 SHORT";
      lines.push(
        `${icon} *${tag}*`,
        `Entry $${fmtPrice(p.entry)} · SL $${fmtPrice(p.sl)} · TP $${fmtPrice(p.target)}`,
        `Hiện $${fmtPrice(cur)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R) · giữ ${heldDays}d`,
        ``,
      );
    } else if (st.tracker.pending) {
      const dir = st.tracker.pending.direction === "long" ? "CHỜ LONG" : "CHỜ SHORT";
      lines.push(`🟡 *${tag}* — ARM ${dir} (đã tap vùng, chờ BOS)`, ``);
    } else {
      const cd = st.cooldownUntilTime > Date.now() ? " · cooldown" : "";
      lines.push(`⚪ *${tag}* — flat${cd}`, ``);
    }
  }
  const tLines = turtle?.statusLines() ?? [];
  if (tLines.length) lines.push(`— 🐢 Turtle / Binance —`, ``, ...tLines);
  const fLines = fastTrend?.statusLines() ?? [];
  if (fLines.length) lines.push(`— ⚡ Fast Trend / MEXC —`, ``, ...fLines, ``);
  lines.push(`_Đang mở: ${open} SMC-drain + ${tLines.length ? Math.ceil(tLines.length / 3) : 0} turtle + ${(fastRuntime?.real ?? 0) + (fastRuntime?.paper ?? 0)} fast · ${formatTimeVn(Date.now())}_`);
  return lines.join("\n");
}

function startCommandListener(): void {
  if (!telegram.enabled) return;
  let offset = 0;
  let drained = false;
  let failStreak = 0;

  const tick = async (): Promise<void> => {
    const updates = await getTelegramUpdates(telegram, offset);
    if (updates === null) {
      // getTelegramUpdates trả null khi lỗi mạng — backoff theo streak
      failStreak++;
      const delay = Math.min(COMMAND_POLL_MS * Math.pow(2, failStreak - 1), 60_000);
      setTimeout(() => void tick(), delay);
      return;
    }
    failStreak = 0;
    for (const u of updates) {
      offset = Math.max(offset, u.id + 1);
      if (drained === false) continue; // bỏ qua backlog cũ ở lần đầu (chỉ để set offset)
      if (u.chatId !== telegram.chatId) continue; // chỉ trả lời chủ kênh
      const cmd = u.text.trim().toLowerCase().split(/[\s@]/)[0];
      if (cmd === "/health") {
        console.log(`[Cmd] ${cmd} từ ${u.chatId} (signed read-only)`);
        await sendTelegram(telegram, await buildHealthMessage());
      } else if (cmd === "/help") {
        console.log(`[Cmd] ${cmd} từ ${u.chatId}`);
        await sendTelegram(telegram, `🤖 *Lệnh bot*\n/status hoặc /positions — routing + vị thế Binance/MEXC\n/health — key/IP, readiness và số dư Futures của cả hai sàn`);
      } else if (["/status", "/positions", "/start"].includes(cmd)) {
        console.log(`[Cmd] ${cmd} từ ${u.chatId}`);
        await sendTelegram(telegram, buildStatusMessage());
      }
    }
    drained = true;
    setTimeout(() => void tick(), COMMAND_POLL_MS);
  };

  void tick();
  console.log(`[Cmd] ✅ Lắng nghe lệnh Telegram (/status, /health) mỗi ${COMMAND_POLL_MS / 1000}s`);
}

async function main(): Promise<void> {
  console.log("🤖 Swing Alert Bot khởi động...");
  if (SMC_ENABLED) {
    console.log(
      `📈 SMC: ${SYMBOLS.map(formatSymbol).join(", ")} | entry ${CONFIG.entryTf} | bias ${CONFIG.htfBiasTf}/${CONFIG.htfZoneTf}` +
        ` | vol ≥${CONFIG.ltfConfirmVolMult.toFixed(1)}x | delta ${CONFIG.deltaStrict ? "strict" : "soft"} ≥${CONFIG.deltaBuyMin.toFixed(2)}`,
    );
  } else {
    console.log("📈 SMC: TẮT — không scan/ARM/entry mới; chỉ drain state vị thế cũ nếu có.");
  }
  if (TURTLE_ENABLED) console.log(`🐢 Turtle Hybrid: ${TURTLE_SYMBOLS.map(formatSymbol).join(", ")} | 4h | risk ${(TURTLE_RISK_PCT * 100).toFixed(1)}%/unit${TURTLE_TRADING_ENABLED ? "" : " | KHÔNG trade (alert-only)"}`);
  if (FAST_TREND_ENABLED) console.log(`⚡ Fast Trend → MEXC: ${FAST_TREND_SYMBOLS.map(formatSymbol).join(", ")} | risk ${(FAST_TREND_RISK_PCT * 100).toFixed(2)}%/unit | ${fastTrendExecution ? "chờ preflight" : "ALERT-ONLY"}`);
  console.log(`📬 Telegram: ${telegram.enabled ? "Đã cấu hình ✅" : "Chưa cấu hình (log ra console)"}`);
  console.log(`   Luồng: ARM → MỞ LỆNH → RA LỆNH (logic thoát = backtest)`);
  console.log("");

  // Rehydrate state đã lưu (vị thế/cooldown/lastOpenTime) để không mất lệnh đang giữ khi restart.
  const saved = loadState();
  const rehydrated = Object.keys(saved).filter((s) => saved[s]?.livePos);
  if (rehydrated.length) {
    console.log(`[State] Khôi phục ${rehydrated.length} vị thế đang giữ: ${rehydrated.map(formatSymbol).join(", ")}`);
  }
  const activeSmcSymbols = SMC_ENABLED ? SYMBOLS : rehydrated;
  states.push(...activeSmcSymbols.map((s) => createState(s, saved[s])));

  for (const st of states) {
    await prefetchHistory(st);
  }
  persist(); // ghi ngay lastOpenTime/vị thế sau warmup để restart nhanh resume đúng (chưa cần đợi nến mới)

  // Khởi tạo lớp THỰC THI lệnh thật (nếu bật): preflight kết nối → đối soát vị thế → bật.
  if (trader && binance) {
    const testnet = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() !== "false";
    try {
      // Preflight cả symbol turtle (nếu turtle trade thật) — set margin/đòn bẩy/filter một lần
      const pfSymbols = [...new Set([...activeSmcSymbols, ...(turtle && turtleTrader ? TURTLE_SYMBOLS : [])])];
      const pf = await trader.preflight(pfSymbols);
      for (const w of pf.warnings) console.warn(`[Preflight] ⚠️ ${w}`);
      if (!pf.ok) {
        console.error(`[Preflight] ❌ ${pf.errors.join(" | ")} — chạy ALERT-ONLY.`);
        await sendTelegram(telegram, `❌ *Không bật được giao dịch*\n${pf.errors.map((e) => "• " + escapeMarkdown(e)).join("\n")}\nBot chạy ALERT-ONLY.`);
      } else {
        binancePreflightPassed = true;
        tradingReady = true;
        await reconcileStartup(); // khớp state bot ↔ sàn TRƯỚC khi nhận nến mới
        console.log(`[Trade] ✅ THỰC THI BẬT (${testnet ? "TESTNET" : "MAINNET ⚠️"}) · equity $${pf.equity.toFixed(2)} · risk ${(execCfg.riskPct * 100).toFixed(1)}%×sizeMult · trần ${(execCfg.maxPortfolioRiskPct * 100).toFixed(0)}% · ${execCfg.marginType} ${execCfg.leverage}x`);
        const warnTxt = pf.warnings.length ? `\n⚠️ ${pf.warnings.join("; ")}` : "";
        await sendTelegram(
          telegram,
          `💰 *Giao dịch thật: BẬT* (${testnet ? "TESTNET" : "⚠️ MAINNET"})\nEquity $${pf.equity.toFixed(2)} · risk ${(execCfg.riskPct * 100).toFixed(1)}%×sizeMult/lệnh · trần ${(execCfg.maxPortfolioRiskPct * 100).toFixed(0)}%\n${execCfg.marginType} ${execCfg.leverage}x${warnTxt}`
        );
        // Đồng bộ lại giờ định kỳ — chống lệch đồng hồ VM tích luỹ theo ngày (lỗi -1021).
        setInterval(() => void trader.syncTime().catch(() => {}), 30 * 60 * 1000);
        startBinanceHealthMonitor(); // báo Telegram khi mất/khôi phục kết nối Binance
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Trade] ❌ preflight thất bại — chuyển ALERT-ONLY:", msg);
      await sendTelegram(telegram, `❌ *Lỗi kết nối Binance* — ${escapeMarkdown(msg)}\nBot chạy ALERT-ONLY (không đặt lệnh).`);
    }
  } else {
    console.log(`[Trade] Alert-only (TRADING_ENABLED=${TRADING_ENABLED}${TRADING_ENABLED && !binance ? ", thiếu API key" : ""}).`);
  }

  // MEXC là venue độc lập chỉ dành cho Fast Trend. Không phụ thuộc TRADING_ENABLED/Binance.
  if (fastTrendExecution && mexc) {
    try {
      const pf = await fastTrendExecution.preflight(FAST_TREND_SYMBOLS);
      for (const warning of pf.warnings) console.warn(`[MEXC Preflight] ⚠️ ${warning}`);
      if (!pf.ok) {
        console.error(`[MEXC Preflight] ❌ ${pf.errors.join(" | ")} — Fast chạy ALERT-ONLY.`);
        await sendTelegram(
          telegram,
          `❌ *Không bật được Fast/MEXC*\n${pf.errors.map((e) => "• " + escapeMarkdown(e)).join("\n")}\nFast chạy ALERT-ONLY; Turtle/Binance không bị ảnh hưởng.`,
        );
      } else {
        mexcTradingReady = true;
        console.log(`[MEXC] ✅ FAST EXECUTION BẬT · equity $${pf.equity.toFixed(2)} · risk ${(FAST_TREND_RISK_PCT * 100).toFixed(2)}%/unit · trần ${(MEXC_MAX_PORTFOLIO_RISK_PCT * 100).toFixed(1)}% · ${MEXC_MARGIN_TYPE} ${MEXC_LEVERAGE}x`);
        await sendTelegram(
          telegram,
          `⚡💰 *Fast Trend → MEXC: BẬT*\nEquity $${pf.equity.toFixed(2)} · risk ${(FAST_TREND_RISK_PCT * 100).toFixed(2)}%/unit · trần ${(MEXC_MAX_PORTFOLIO_RISK_PCT * 100).toFixed(1)}%\n${MEXC_MARGIN_TYPE} ${MEXC_LEVERAGE}x · basis gate ${(MEXC_MAX_BASIS_PCT * 100).toFixed(2)}%`,
        );
        setInterval(() => void fastTrendExecution.syncTime().catch(() => {}), 30 * 60 * 1000);
      }
    } catch (err) {
      mexcTradingReady = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MEXC] ❌ preflight thất bại — Fast ALERT-ONLY:", msg);
      await sendTelegram(telegram, `❌ *Lỗi kết nối MEXC* — ${escapeMarkdown(msg)}\nFast chạy ALERT-ONLY; Turtle/Binance vẫn độc lập.`);
    }
  } else if (MEXC_ENABLED && MEXC_TRADING_ENABLED) {
    console.error("[MEXC] ❌ Đã bật trading nhưng thiếu MEXC_API_KEY/MEXC_API_SECRET hoặc Fast trading bị tắt.");
  } else {
    console.log(`[MEXC] Fast alert-only (MEXC_ENABLED=${MEXC_ENABLED}, MEXC_TRADING_ENABLED=${MEXC_TRADING_ENABLED}).`);
  }
  if (mexc) startMexcHealthMonitor();

  // Khởi động lớp TURTLE sau khi lớp thực thi & drain SMC cũ (nếu có) đã đối soát.
  if (turtle) {
    try {
      await turtle.start(activeSmcSymbols);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Turtle] ❌ khởi động thất bại — turtle tắt phiên này:", msg);
      await sendTelegram(telegram, `🐢❌ *Turtle không khởi động được* — ${escapeMarkdown(msg)}\nSMC đang tắt; kiểm tra bot ngay.`);
    }
  } else {
    console.log("[Turtle] Tắt (TURTLE_ENABLED=false).");
  }

  // Khởi động sleeve TREND NHANH (alert-only forward-test) — độc lập, lỗi ở đây KHÔNG ảnh hưởng SMC/turtle.
  if (fastTrend) {
    try {
      await fastTrend.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Fast] ❌ khởi động thất bại — sleeve nhanh tắt phiên này:", msg);
    }
  } else {
    console.log("[Fast] Tắt (FAST_TREND_ENABLED=false).");
  }

  // Lệnh phát hiện từ chart MỚI HƠN lệnh đã lưu = vào trong lúc bot offline → silent scan
  // đã nuốt alert "MỞ LỆNH", nên báo riêng để user không bị mất thông báo vào lệnh.
  // So sánh entryTime để KHÔNG spam lại lệnh đã biết từ trước mỗi lần restart.
  const openedWhileOffline = states.filter((st) => {
    if (!st.livePos) return false;
    const prev = saved[st.symbol]?.livePos;
    return !prev || st.livePos.entryTime > prev.entryTime;
  });

  // Gửi startup message SAU khi đã replay chart — trạng thái vị thế đã chính xác
  const startup = SMC_ENABLED
    ? buildStartupMessage(SYMBOLS)
    : `🤖 *Swing Bot* đã chạy\n\n📈 SMC: *TẮT* — không mở lệnh mới\n🐢 Turtle/Binance: ${TURTLE_ENABLED ? "BẬT" : "TẮT"}\n⚡ Fast/MEXC: ${mexcTradingReady ? "LIVE" : FAST_TREND_ENABLED ? "alert-only" : "TẮT"}`;
  await sendTelegram(telegram, startup + "\n\n" + buildStatusMessage());
  for (const st of openedWhileOffline) {
    await sendTelegram(telegram, buildOfflineEntryMessage(st.livePos!, st.symbol));
  }
  startCommandListener();
  startDailyHeartbeat();
  if (SMC_ENABLED) startHealthMonitor();
  for (let i = 0; i < states.length; i++) {
    startPolling(states[i], i * 3_000); // stagger 3s/symbol tránh 429
  }

  process.on("SIGINT", () => {
    console.log("\n⛔ Tắt bot...");
    process.exit(0);
  });
}

main().catch(console.error);
