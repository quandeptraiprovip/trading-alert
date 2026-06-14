/**
 * BTC Alert Bot — Swing setup (SMC đa khung)
 *
 * Luồng Telegram: startup → ARM → MỞ LỆNH → RA LỆNH (SL/TP/trail/time).
 */

import "./load-env";
import WebSocket from "ws";
import axios from "axios";
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
import {
  buildArmMessage,
  buildEntryMessage,
  buildExitMessage,
  buildStartupMessage,
  ExitReason,
  formatTimeVn,
  fmtPrice,
  loadTelegramConfig,
  sendTelegram,
} from "./telegram";

const telegram = loadTelegramConfig();

const BUFFER_SIZE = 1500;
const ENTRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ARM_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const ltfMs = TF_MS[CONFIG.entryTf];

const buffer: Candle[] = [];
let lastEntryAlertAt = 0;
let lastArmAlertAt = 0;
let cooldownUntilTime = 0;
const tracker = new SetupTracker();

type LivePosition = {
  dir: "long" | "short";
  entryTime: number;
  entry: number;
  initialSL: number;
  sl: number;
  target: number;
  zoneDesc: string;
};

let livePos: LivePosition | null = null;

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

function openLivePosition(sig: EntrySignal, candle: Candle): void {
  livePos = {
    dir: sig.direction,
    entryTime: candle.openTime,
    entry: sig.entry,
    initialSL: sig.initialSL,
    sl: sig.initialSL,
    target: sig.initialTarget,
    zoneDesc: sig.reason,
  };
}

function evaluateNewEntry(candle: Candle): EntrySignal | null {
  if (buffer.length < 400) return null;
  if (candle.openTime < cooldownUntilTime) return null;

  const biasTf = aggregate(buffer, CONFIG.htfBiasTf, CONFIG.entryTf);
  const zoneTf = aggregate(buffer, CONFIG.htfZoneTf, CONFIG.entryTf);
  const biasSwings = findSwings(biasTf);
  const zoneSwings = findSwings(zoneTf);

  const i = buffer.length - 1;
  const closeTime = candle.openTime + ltfMs;
  const biasCount = htfClosedCount(biasTf, closeTime);
  const zoneCount = htfClosedCount(zoneTf, closeTime);
  if (biasCount < 5 || zoneCount < CONFIG.volAvgPeriod) return null;

  const ctx = buildHtfContext(biasTf, zoneTf, biasSwings, zoneSwings, biasCount - 1, zoneCount - 1);
  const hadPending = tracker.pending !== null;
  const sig = tracker.update(buffer, i, ctx);

  if (!sig && !hadPending && tracker.pending) {
    void maybeSendArmAlert(tracker.pending, candle);
  }

  return sig;
}

async function maybeSendArmAlert(setup: NonNullable<SetupTracker["pending"]>, candle: Candle): Promise<void> {
  if (Date.now() - lastArmAlertAt < ARM_COOLDOWN_MS) {
    console.log(`[${formatTimeVn(candle.openTime)}] ARM ${setup.direction} nhưng đang cooldown ARM, bỏ qua Telegram.`);
    return;
  }
  lastArmAlertAt = Date.now();
  const msg = buildArmMessage(setup, candle);
  console.log(`\n[ARM] ${setup.direction.toUpperCase()} tap vùng @ $${fmtPrice(candle.close)}`);
  await sendTelegram(telegram, msg);
}

async function notifyEntry(sig: EntrySignal, candle: Candle): Promise<void> {
  if (Date.now() - lastEntryAlertAt < ENTRY_COOLDOWN_MS) {
    console.log(`[${formatTimeVn(candle.openTime)}] Mở ${sig.direction} — Telegram entry cooldown, vẫn theo dõi ra lệnh.`);
    return;
  }
  lastEntryAlertAt = Date.now();
  const msg = buildEntryMessage(sig, candle);
  console.log(`\n[ENTRY] ${sig.direction.toUpperCase()} @ $${fmtPrice(sig.entry)}`);
  await sendTelegram(telegram, msg);
}

async function notifyExit(pos: LivePosition, c: Candle, exitPrice: number, reason: ExitReason): Promise<void> {
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
  });
  console.log(`\n[EXIT] ${pos.dir.toUpperCase()} ${reason} @ $${fmtPrice(exitPrice)} (${grossR >= 0 ? "+" : ""}${grossR.toFixed(2)}R)`);
  await sendTelegram(telegram, msg);
}

async function onCandleClose(candle: Candle): Promise<void> {
  buffer.push(candle);
  if (buffer.length > BUFFER_SIZE) buffer.shift();

  const zoneTf = aggregate(buffer, CONFIG.htfZoneTf, CONFIG.entryTf);
  const zoneSwings = findSwings(zoneTf);

  if (livePos) {
    const exit = tryExitAndTrail(livePos, candle, zoneTf, zoneSwings);
    if (exit) {
      await notifyExit(livePos, candle, exit.exitPrice, exit.reason);
      cooldownUntilTime = candle.openTime + CONFIG.cooldownBars * ltfMs;
      livePos = null;
      tracker.reset();
    }
    return;
  }

  const sig = evaluateNewEntry(candle);
  if (!sig) return;

  openLivePosition(sig, candle);
  await notifyEntry(sig, candle);
}

async function prefetchHistory(): Promise<void> {
  const url = "https://fapi.binance.com/fapi/v1/klines";
  console.log("[Init] Tải lịch sử 15m để warmup...");
  const res = await axios.get(url, {
    params: { symbol: CONFIG.symbol.toUpperCase(), interval: CONFIG.entryTf, limit: BUFFER_SIZE },
  });
  const candles: Candle[] = (res.data as any[]).map((k: any[]) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7]),
    takerBuyVolume: parseFloat(k[9]),
  }));
  candles.pop();
  buffer.push(...candles);
  console.log(`[Init] OK — ${buffer.length} nến (tới ${formatTimeVn(buffer[buffer.length - 1].openTime)})`);
}

function connect(): void {
  const url = `wss://fstream.binance.com/ws/${CONFIG.symbol}@kline_${CONFIG.entryTf}`;
  const ws = new WebSocket(url);

  ws.on("open", () => console.log(`[WS] ✅ Đã kết nối ${CONFIG.symbol} ${CONFIG.entryTf} (Futures)`));

  ws.on("message", async (raw: Buffer) => {
    try {
      const k = JSON.parse(raw.toString()).k;
      if (k.x !== true) return;
      await onCandleClose({
        openTime: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        quoteVolume: parseFloat(k.q),
        takerBuyVolume: parseFloat(k.V),
      });
    } catch (err) {
      console.error("[WS] Parse error:", err);
    }
  });

  ws.on("error", (err) => console.error("[WS] Error:", err.message));
  ws.on("close", () => {
    console.log("[WS] Mất kết nối, thử lại sau 5s...");
    setTimeout(connect, 5000);
  });
}

async function main(): Promise<void> {
  console.log("🤖 BTC Swing Alert Bot khởi động...");
  console.log(`📈 ${CONFIG.symbol.toUpperCase()} | entry ${CONFIG.entryTf} | bias ${CONFIG.htfBiasTf}/${CONFIG.htfZoneTf}`);
  console.log(`📬 Telegram: ${telegram.enabled ? "Đã cấu hình ✅" : "Chưa cấu hình (log ra console)"}`);
  console.log(`   Luồng: ARM → MỞ LỆNH → RA LỆNH (logic thoát = backtest)`);
  console.log("");

  await prefetchHistory();
  await sendTelegram(telegram, buildStartupMessage());
  connect();

  process.on("SIGINT", () => {
    console.log("\n⛔ Tắt bot...");
    process.exit(0);
  });
}

main().catch(console.error);
