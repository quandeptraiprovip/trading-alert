/**
 * Swing Alert Bot — Swing setup (SMC đa khung), ĐA SYMBOL
 *
 * Mỗi symbol trong CONFIG.symbols chạy ĐỘC LẬP: buffer + tracker + vị thế + cooldown riêng,
 * cùng một logic ARM → MỞ LỆNH → RA LỆNH (SL/TP/trail/time) khớp backtest.
 */

import "./load-env";
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
const POLL_INTERVAL_MS = 12_000; // nến 15m → poll 12s thừa sức bắt nến vừa đóng
import {
  buildArmMessage,
  buildEntryMessage,
  buildExitMessage,
  buildStartupMessage,
  ExitReason,
  formatTimeVn,
  fmtPrice,
  formatSymbol,
  getTelegramUpdates,
  loadTelegramConfig,
  sendTelegram,
} from "./telegram";

const telegram = loadTelegramConfig();

const BUFFER_SIZE = 1500;
const ARM_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const COMMAND_POLL_MS = 5_000;
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
};

// State ĐỘC LẬP cho từng symbol (tránh dùng biến toàn cục dùng chung).
type SymbolState = {
  symbol: string;
  buffer: Candle[];
  lastArmAlertAt: number;
  cooldownUntilTime: number;
  tracker: SetupTracker;
  livePos: LivePosition | null;
  lastOpenTime: number;
};

// Tất cả state symbol — module-level để command listener (/status) đọc được.
const states: SymbolState[] = [];

function createState(symbol: string): SymbolState {
  return {
    symbol,
    buffer: [],
    lastArmAlertAt: 0,
    cooldownUntilTime: 0,
    tracker: new SetupTracker(),
    livePos: null,
    lastOpenTime: 0,
  };
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
  if (Date.now() - st.lastArmAlertAt < ARM_COOLDOWN_MS) {
    console.log(`[${formatTimeVn(candle.openTime)}] ${tag} ARM ${setup.direction} nhưng đang cooldown ARM, bỏ qua Telegram.`);
    return;
  }
  st.lastArmAlertAt = Date.now();
  const msg = buildArmMessage(setup, candle, st.symbol);
  console.log(`\n[ARM] ${tag} ${setup.direction.toUpperCase()} tap vùng @ $${fmtPrice(candle.close)}`);
  await sendTelegram(telegram, msg);
}

async function notifyEntry(st: SymbolState, sig: EntrySignal, candle: Candle): Promise<void> {
  // Vào lệnh là sự kiện quan trọng → LUÔN báo (không cooldown).
  const msg = buildEntryMessage(sig, candle, st.symbol);
  console.log(`\n[ENTRY] ${formatSymbol(st.symbol)} ${sig.direction.toUpperCase()} @ $${fmtPrice(sig.entry)}`);
  await sendTelegram(telegram, msg);
}

async function notifyExit(st: SymbolState, pos: LivePosition, c: Candle, exitPrice: number, reason: ExitReason): Promise<void> {
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
  await sendTelegram(telegram, msg);
}

async function onCandleClose(st: SymbolState, candle: Candle): Promise<void> {
  st.buffer.push(candle);
  if (st.buffer.length > BUFFER_SIZE) st.buffer.shift();

  const zoneTf = aggregate(st.buffer, CONFIG.htfZoneTf, CONFIG.entryTf);
  const zoneSwings = findSwings(zoneTf);

  if (st.livePos) {
    const exit = tryExitAndTrail(st.livePos, candle, zoneTf, zoneSwings);
    if (exit) {
      await notifyExit(st, st.livePos, candle, exit.exitPrice, exit.reason);
      st.cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
      st.livePos = null;
      st.tracker.reset();
    }
    return;
  }

  const sig = evaluateNewEntry(st, candle);
  if (!sig) return;

  openLivePosition(st, sig, candle);
  await notifyEntry(st, sig, candle);
}

async function prefetchHistory(st: SymbolState): Promise<void> {
  console.log(`[Init] ${formatSymbol(st.symbol)} — tải lịch sử 15m để warmup...`);
  const candles = await fetchKlinesPaged(st.symbol, CONFIG.entryTf, BUFFER_SIZE);
  candles.pop(); // bỏ nến hiện tại (chưa đóng)
  st.buffer.push(...candles);
  st.lastOpenTime = st.buffer.length ? st.buffer[st.buffer.length - 1].openTime : 0;
  console.log(`[Init] ${formatSymbol(st.symbol)} OK — ${st.buffer.length} nến (tới ${formatTimeVn(st.buffer[st.buffer.length - 1].openTime)})`);
}

// Lấy nến 15m ĐÓNG gần nhất từ Futures REST. limit:2 → phần tử cuối là nến đang chạy,
// phần tử kế cuối là nến vừa đóng.
async function fetchLatestClosedCandle(symbol: string): Promise<Candle | null> {
  const res = await axios.get(FAPI_KLINES, {
    params: { symbol: symbol.toUpperCase(), interval: CONFIG.entryTf, limit: 2 },
    timeout: 15000,
  });
  const arr = res.data as any[];
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const k = arr[arr.length - 2]; // nến đã đóng
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7]), // dollar volume
    takerBuyVolume: parseFloat(k[9]), // taker-buy base (cho delta/CVD)
  };
}

function startPolling(st: SymbolState): void {
  console.log(
    `[Poll] ✅ Theo dõi ${formatSymbol(st.symbol)} ${CONFIG.entryTf} (Futures REST, mỗi ${POLL_INTERVAL_MS / 1000}s)`
  );
  const tick = async (): Promise<void> => {
    try {
      const c = await fetchLatestClosedCandle(st.symbol);
      if (c && c.openTime > st.lastOpenTime) {
        st.lastOpenTime = c.openTime;
        await onCandleClose(st, c);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Poll] ${formatSymbol(st.symbol)} Lỗi fetch:`, msg);
    }
  };
  void tick(); // chạy ngay 1 lần
  setInterval(() => void tick(), POLL_INTERVAL_MS);
}

// ── Lệnh /status: liệt kê lệnh đang giữ / chờ trên từng symbol ──
function buildStatusMessage(): string {
  const lines = [`📊 *Trạng thái bot* — ${states.length} symbol`, ``];
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
  lines.push(`_Đang mở: ${open}/${states.length} · ${formatTimeVn(Date.now())}_`);
  return lines.join("\n");
}

function startCommandListener(): void {
  if (!telegram.enabled) return;
  let offset = 0;
  let drained = false;

  const tick = async (): Promise<void> => {
    const updates = await getTelegramUpdates(telegram, offset);
    for (const u of updates) {
      offset = Math.max(offset, u.id + 1);
      if (drained === false) continue; // bỏ qua backlog cũ ở lần đầu (chỉ để set offset)
      if (u.chatId !== telegram.chatId) continue; // chỉ trả lời chủ kênh
      const cmd = u.text.trim().toLowerCase().split(/[\s@]/)[0];
      if (["/status", "/positions", "/start", "/help"].includes(cmd)) {
        await sendTelegram(telegram, buildStatusMessage());
      }
    }
    drained = true;
  };

  void tick();
  setInterval(() => void tick(), COMMAND_POLL_MS);
  console.log(`[Cmd] ✅ Lắng nghe lệnh Telegram (/status) mỗi ${COMMAND_POLL_MS / 1000}s`);
}

async function main(): Promise<void> {
  console.log("🤖 Swing Alert Bot khởi động...");
  console.log(`📈 ${SYMBOLS.map(formatSymbol).join(", ")} | entry ${CONFIG.entryTf} | bias ${CONFIG.htfBiasTf}/${CONFIG.htfZoneTf}`);
  console.log(`📬 Telegram: ${telegram.enabled ? "Đã cấu hình ✅" : "Chưa cấu hình (log ra console)"}`);
  console.log(`   Luồng: ARM → MỞ LỆNH → RA LỆNH (logic thoát = backtest)`);
  console.log("");

  states.push(...SYMBOLS.map(createState));
  for (const st of states) {
    await prefetchHistory(st);
  }
  await sendTelegram(telegram, buildStartupMessage(SYMBOLS));
  startCommandListener();
  for (const st of states) {
    startPolling(st);
  }

  process.on("SIGINT", () => {
    console.log("\n⛔ Tắt bot...");
    process.exit(0);
  });
}

main().catch(console.error);
