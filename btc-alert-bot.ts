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
import { loadState, saveState, appendJournal, PersistedSymbol } from "./live-state";

const telegram = loadTelegramConfig();

const BUFFER_SIZE = 1500;
const ARM_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const COMMAND_POLL_MS = 5_000;
// Cảnh báo nếu KHÔNG nhận được phản hồi data nào quá ngưỡng này (vd fapi bị chặn 451).
// Bot poll fapi-only để giữ ĐÚNG dữ liệu Perpetual (volume/delta) — không tự ngầm fallback
// sang spot (sẽ làm lệch tín hiệu); thay vào đó báo Telegram để user xử lý.
const HEALTH_TIMEOUT_MS = 6 * 60 * 1000; // ~6 phút không có data → cảnh báo
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

function createState(symbol: string, saved?: PersistedSymbol): SymbolState {
  return {
    symbol,
    buffer: [],
    lastArmAlertAt: saved?.lastArmAlertAt ?? 0,
    cooldownUntilTime: saved?.cooldownUntilTime ?? 0,
    tracker: new SetupTracker(),
    livePos: saved?.livePos ? { ...saved.livePos } : null,
    lastOpenTime: saved?.lastOpenTime ?? 0,
  };
}

/** Lưu toàn bộ state (atomic) — gọi sau mỗi thay đổi (entry/exit/cooldown/nến mới). */
function persist(): void {
  saveState(
    states.map((st) => ({
      symbol: st.symbol,
      lastOpenTime: st.lastOpenTime,
      cooldownUntilTime: st.cooldownUntilTime,
      lastArmAlertAt: st.lastArmAlertAt,
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
  appendJournal({
    event: "entry",
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

async function onCandleClose(st: SymbolState, candle: Candle): Promise<void> {
  st.lastOpenTime = candle.openTime;
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
    persist(); // sl/trail có thể đã dời (tryExitAndTrail mutate pos.sl) hoặc vừa đóng lệnh
    return;
  }

  const sig = evaluateNewEntry(st, candle);
  if (!sig) {
    persist(); // lưu lastOpenTime tiến lên (để resume đúng sau restart)
    return;
  }

  openLivePosition(st, sig, candle);
  await notifyEntry(st, sig, candle);
  persist();
}

// Tải lịch sử warmup. Nếu resumeFrom hữu hạn (rehydrate sau restart): nến <= resumeFrom là
// warmup tĩnh, nến > resumeFrom được REPLAY qua onCandleClose để bắt exit/entry đã xảy ra
// trong lúc bot tắt (downtime). resumeFrom = Infinity → khởi động sạch (toàn bộ là warmup).
async function prefetchHistory(st: SymbolState, resumeFrom: number): Promise<void> {
  console.log(`[Init] ${formatSymbol(st.symbol)} — tải lịch sử 15m để warmup...`);
  const candles = await fetchKlinesPaged(st.symbol, CONFIG.entryTf, BUFFER_SIZE);
  candles.pop(); // bỏ nến hiện tại (chưa đóng)
  if (candles.length === 0) {
    console.warn(`[Init] ${formatSymbol(st.symbol)} không tải được nến nào.`);
    return;
  }

  let from = resumeFrom;
  // Downtime dài hơn cửa sổ buffer → không replay trung thực được; resync về hiện tại.
  // Vị thế rehydrate (nếu có) vẫn giữ và được poll quản lý tiếp từ giờ.
  if (from !== Infinity && from < candles[0].openTime) {
    console.warn(`[Init] ${formatSymbol(st.symbol)} downtime > ${BUFFER_SIZE} nến — resync hiện tại, KHÔNG replay.`);
    from = Infinity;
  }

  const warmup = from === Infinity ? candles : candles.filter((c) => c.openTime <= from);
  const replay = from === Infinity ? [] : candles.filter((c) => c.openTime > from);

  st.buffer.push(...warmup);
  if (warmup.length) st.lastOpenTime = warmup[warmup.length - 1].openTime;

  if (replay.length) {
    console.log(`[Init] ${formatSymbol(st.symbol)} replay ${replay.length} nến downtime (bắt exit/entry đã lỡ)...`);
    for (const c of replay) await onCandleClose(st, c); // tự advance lastOpenTime + persist
  }
  const tail = st.buffer[st.buffer.length - 1];
  const holding = st.livePos ? ` · ĐANG GIỮ ${st.livePos.dir.toUpperCase()} (entry $${fmtPrice(st.livePos.entry)})` : "";
  console.log(`[Init] ${formatSymbol(st.symbol)} OK — ${st.buffer.length} nến (tới ${tail ? formatTimeVn(tail.openTime) : "?"})${holding}`);
}

// Lấy MỌI nến 15m đã ĐÓNG mới hơn `since` từ Futures REST (sắp xếp tăng dần). limit lớn để
// bù gap khi bot lỡ vài nến (mạng chập / 429 / downtime ngắn) — backtest xử lý mọi nến nên
// live cũng phải replay đủ, tránh bỏ sót exit/entry trong nến bị nhỡ.
async function fetchClosedSince(symbol: string, since: number): Promise<Candle[]> {
  const res = await axios.get(FAPI_KLINES, {
    params: { symbol: symbol.toUpperCase(), interval: CONFIG.entryTf, limit: MAX_CATCHUP_BARS },
    timeout: 15000,
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
    void sendTelegram(telegram, `✅ *Bot phục hồi* — đã nhận lại dữ liệu nến.\n🕐 ${formatTimeVn(Date.now())}`);
  }
}

function startHealthMonitor(): void {
  setInterval(() => {
    if (healthAlerted || Date.now() - lastDataAt <= HEALTH_TIMEOUT_MS) return;
    healthAlerted = true;
    const mins = Math.round((Date.now() - lastDataAt) / 60_000);
    console.error(`[Health] ⚠️ Không nhận được data ~${mins} phút.`);
    void sendTelegram(
      telegram,
      `⚠️ *Bot mất dữ liệu* — không có nến mới ~${mins} phút.\nCó thể fapi bị chặn (451) hoặc mất mạng. Kiểm tra \`pm2 logs\`.\n🕐 ${formatTimeVn(Date.now())}`
    );
  }, 60_000);
}

function startPolling(st: SymbolState, initialDelayMs = 0): void {
  console.log(
    `[Poll] ✅ Theo dõi ${formatSymbol(st.symbol)} ${CONFIG.entryTf} (Futures REST, mỗi ${POLL_INTERVAL_MS / 1000}s)`
  );
  const tick = async (): Promise<void> => {
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
        if (status === 429 && attempt < 2) {
          console.warn(`[Poll] ${formatSymbol(st.symbol)} 429 — thử lại sau ${retryDelay / 1000}s`);
          await new Promise((r) => setTimeout(r, retryDelay));
          retryDelay *= 2;
        } else {
          console.error(`[Poll] ${formatSymbol(st.symbol)} Lỗi fetch:`, msg);
          return;
        }
      }
    }
  };
  // Stagger: delay khởi động để các symbol không poll cùng lúc
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), POLL_INTERVAL_MS);
  }, initialDelayMs);
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
    setTimeout(() => void tick(), COMMAND_POLL_MS);
  };

  void tick();
  console.log(`[Cmd] ✅ Lắng nghe lệnh Telegram (/status) mỗi ${COMMAND_POLL_MS / 1000}s`);
}

async function main(): Promise<void> {
  console.log("🤖 Swing Alert Bot khởi động...");
  console.log(`📈 ${SYMBOLS.map(formatSymbol).join(", ")} | entry ${CONFIG.entryTf} | bias ${CONFIG.htfBiasTf}/${CONFIG.htfZoneTf}`);
  console.log(`📬 Telegram: ${telegram.enabled ? "Đã cấu hình ✅" : "Chưa cấu hình (log ra console)"}`);
  console.log(`   Luồng: ARM → MỞ LỆNH → RA LỆNH (logic thoát = backtest)`);
  console.log("");

  // Rehydrate state đã lưu (vị thế/cooldown/lastOpenTime) để không mất lệnh đang giữ khi restart.
  const saved = loadState();
  const rehydrated = SYMBOLS.filter((s) => saved[s]?.livePos);
  if (rehydrated.length) {
    console.log(`[State] Khôi phục ${rehydrated.length} vị thế đang giữ: ${rehydrated.map(formatSymbol).join(", ")}`);
  }
  states.push(...SYMBOLS.map((s) => createState(s, saved[s])));

  await sendTelegram(telegram, buildStartupMessage(SYMBOLS));
  for (const st of states) {
    // resumeFrom = lastOpenTime đã lưu → replay nến downtime; chưa có state → Infinity (khởi động sạch)
    const resumeFrom = saved[st.symbol]?.lastOpenTime ?? Infinity;
    await prefetchHistory(st, resumeFrom);
  }
  persist(); // ghi ngay lastOpenTime/vị thế sau warmup để restart nhanh resume đúng (chưa cần đợi nến mới)
  startCommandListener();
  startHealthMonitor();
  for (let i = 0; i < states.length; i++) {
    startPolling(states[i], i * 3_000); // stagger 3s/symbol tránh 429
  }

  process.on("SIGINT", () => {
    console.log("\n⛔ Tắt bot...");
    process.exit(0);
  });
}

main().catch(console.error);
