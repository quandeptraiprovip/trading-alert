/**
 * fxdream-bot.ts — Bot Telegram CHỈ chạy FX Dream (key-volume.ts) trên Binance BTCUSDT + vàng XAUUSDT.
 *
 * User 04/10/26: bỏ mọi phương pháp khác (SMC, Turtle, Fast/MEXC). File này KHÔNG import chúng,
 * nên chúng không thể chạy dù `.env.local` còn bật cờ cũ. `btc-alert-bot.ts` giữ nguyên để quay lại.
 *
 * Mỗi tín hiệu gửi ẢNH + nút ✅/❌; đồng ý mới vào lệnh, trừ 00:00–06:00 tự vào — xem fxdream-live.ts.
 * Mỗi mã một FxDreamLive, mỗi mã giữ tối đa một lệnh (user 06/10/26). Vàng (TradFi perp, giao dịch
 * 24/7 trên Binance) bỏ nến lúc thị trường vàng thật đóng cửa cuối tuần — market-hours.ts.
 *
 * Env: TELEGRAM_*, TRADING_ENABLED, BINANCE_API_KEY/SECRET, BINANCE_TESTNET, LEVERAGE, MARGIN_TYPE,
 *      FXDREAM_RISK_USD (mặc định 5), FXDREAM_SYMBOLS (mặc định btcusdt,xauusdt), TRADING_DATA_DIR.
 */

import "./load-env";
import crypto from "crypto";
import { createBinanceFromEnv } from "./binance-futures";
import { LiveTrader, loadExecConfig } from "./live-trade";
import { KEY_VOLUME_CONFIG } from "./key-volume";
import { FxDreamLive } from "./fxdream-live";
import { dropsWeekendBars, goldClosedNy } from "./market-hours";
import { buildLine } from "./build-info";
import { answerTelegramCallback, escapeMarkdown, getTelegramUpdates, loadTelegramConfig, sendTelegram } from "./telegram";

const logTimeVn = (): string => new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(`[${logTimeVn()}]`, ...args);
}

const SYMBOLS = [...new Set((process.env.FXDREAM_SYMBOLS ?? "btcusdt,xauusdt")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
const TICK_MS = 10_000;
const COMMAND_POLL_MS = 3_000;
const DATA_STALE_MS = 6 * 60_000;

const telegram = loadTelegramConfig();
const TRADING_ENABLED = (process.env.TRADING_ENABLED ?? "false").toLowerCase() === "true";
const TESTNET = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() !== "false";
const RISK_USD = (() => {
  const n = parseFloat(process.env.FXDREAM_RISK_USD ?? "5");
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const execCfg = loadExecConfig();
/** Trần đòn bẩy (user 06/10/26). Mỗi lệnh tự chọn đòn bẩy ≤ trần theo khoảng SL; `LEVERAGE` chỉ còn là mức preflight đặt lúc khởi động. */
const MAX_LEVERAGE = 20;
const binance = TRADING_ENABLED ? createBinanceFromEnv() : null;
const trader = binance ? new LiveTrader(binance, execCfg) : null;
let tradingReady = false;

/** Mã cấu hình engine — `/health` in ra để xác nhận bản đang chạy đúng luật. */
const ENGINE_FP = crypto.createHash("sha256").update(JSON.stringify(KEY_VOLUME_CONFIG)).digest("hex").slice(0, 6);

const fxs = SYMBOLS.map((symbol) => new FxDreamLive({
  symbol,
  venue: binance,
  telegram,
  riskUsd: RISK_USD,
  maxLeverage: MAX_LEVERAGE,
  dataDir: process.env.TRADING_DATA_DIR?.trim() || process.cwd(),
  isTradingReady: () => tradingReady,
  // BTC giữ tên file state/journal cũ để bản deploy trước đọc tiếp được.
  stateName: symbol === "btcusdt" ? "fxdream" : `fxdream-${symbol}`,
  marketClosed: dropsWeekendBars(symbol) ? goldClosedNy : undefined,
}));
const symbolsLabel = SYMBOLS.map((s) => s.toUpperCase()).join(" + ");

function ownerOf(id: string): FxDreamLive | undefined {
  return fxs.find((f) => f.owns(id));
}

function engineLine(): string {
  const p = KEY_VOLUME_CONFIG;
  const branches = [
    p.enableSweepBranch ? "quét" : null,
    p.enableVolumeReversalBranch ? "key+cụm" : null,
    p.enableKeyTrapBranch ? "trap" : null,
    p.enableLowerHighBranch ? "đỉnh thấp dần" : null,
  ].filter(Boolean).join("/");
  return `M15 · key ×${p.volumeSpikeMult}, sống ${p.keyMaxAgeDays} ngày, tối đa ${p.maxActiveKeys} · nhánh ${branches} · fp ${ENGINE_FP}`;
}

async function healthText(): Promise<string> {
  const lines = [
    "🩺 *FX Dream bot*",
    `Code: ${buildLine()}`,
    `Engine: ${escapeMarkdown(engineLine())}`,
    `Sàn: ${binance ? (TESTNET ? "Binance TESTNET" : "Binance ⚠️ MAINNET") : "không có (alert-only)"} · ${execCfg.marginType} đòn bẩy tự chọn ≤${MAX_LEVERAGE}x · rủi ro $${RISK_USD}/lệnh (tự vào ban đêm $${RISK_USD / 2})`,
    `Mã: ${symbolsLabel}${SYMBOLS.some(dropsWeekendBars) ? " (vàng bỏ nến cuối tuần lúc thị trường đóng cửa)" : ""}`,
    `Dữ liệu nến: ${fxs.map((f, i) => `${SYMBOLS[i].toUpperCase()} ${f.lastDataAt ? `${Math.round((Date.now() - f.lastDataAt) / 1000)}s trước` : "chưa có"}`).join(" · ")}`,
  ];
  if (binance) {
    try {
      const eq = await binance.getEquity();
      lines.push(`Equity $${eq.walletBalance.toFixed(2)} · khả dụng $${eq.available.toFixed(2)}`);
    } catch (err) {
      lines.push(`⚠️ Không đọc được số dư: ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`);
    }
  }
  for (const f of fxs) lines.push("", escapeMarkdown(f.statusText()));
  return lines.join("\n");
}

/** Tin chữ (giá sửa tay) đi tới mã đang ở chế độ sửa — mỗi lúc tối đa một mã. */
async function handleTextAny(text: string): Promise<boolean> {
  for (const f of fxs) if (await f.handleText(text)) return true;
  return false;
}

function startCommandListener(): void {
  if (!telegram.enabled) return;
  let offset = 0;
  let drained = false;
  const tick = async (): Promise<void> => {
    const updates = await getTelegramUpdates(telegram, offset);
    if (updates) {
      for (const u of updates) {
        offset = Math.max(offset, u.id + 1);
        if (!drained) continue; // bỏ backlog cũ lúc khởi động (kể cả lượt bấm cũ)
        if (u.chatId !== telegram.chatId) continue;
        try {
          if (u.callback) {
            const cb = u.callback;
            const owner = fxs.find((f) => /^fx:[yne]:/.test(cb.data) && f.owns(cb.data.slice(5)));
            if (!owner) {
              await answerTelegramCallback(telegram, cb.id, "Không tìm thấy đề nghị này.");
              continue;
            }
            // Đang sửa đề nghị mã khác mà bấm ✏️ ở mã này: giá gõ sau đó thuộc về mã này.
            if (cb.data.startsWith("fx:e:")) for (const f of fxs) if (f !== owner) await f.cancelEdit();
            await owner.handleCallback(cb);
            continue;
          }
          const text = u.text.trim();
          const cmd = text.toLowerCase().split(/[\s@]/)[0];
          const yesNo = /^\/(yes|no|edit)_(\w+)$/.exec(cmd);
          const owner = yesNo ? ownerOf(yesNo[2]) : undefined;
          if (yesNo && !owner) await sendTelegram(telegram, "Không tìm thấy đề nghị này.", undefined);
          else if (yesNo?.[1] === "edit") {
            for (const f of fxs) if (f !== owner) await f.cancelEdit();
            await owner!.startEdit(yesNo[2]);
          } else if (yesNo) await owner!.decide(yesNo[2], yesNo[1] === "yes");
          else if (!cmd.startsWith("/") && (await handleTextAny(text))) continue;
          else if (cmd === "/health") await sendTelegram(telegram, await healthText());
          else if (cmd === "/status" || cmd === "/start") await sendTelegram(telegram, fxs.map((f) => f.statusText()).join("\n\n"), undefined);
          else if (cmd === "/help") {
            await sendTelegram(telegram, "🤖 FX Dream bot\n/status — vị thế, lệnh chờ, đề nghị đang chờ\n/health — code, engine, sàn, số dư\nẢnh đề nghị có nút ✅ Vào lệnh / ✏️ Sửa (gõ entry/sl/tp mới) / ❌ Bỏ qua.\nSàn báo lỗi lúc đặt lệnh → nút 🔁 Thử lại (còn trong hạn của đề nghị).", undefined);
          }
        } catch (err) {
          console.error("[Cmd] lỗi:", err);
        }
      }
      drained = true;
    }
    setTimeout(() => void tick(), COMMAND_POLL_MS);
  };
  void tick();
}

function startLoops(): void {
  const staleAlerted = fxs.map(() => false);
  const loop = async (): Promise<void> => {
    for (const [i, fx] of fxs.entries()) {
      const sym = SYMBOLS[i].toUpperCase();
      try {
        await fx.tick();
      } catch (err) {
        console.error(`[FX Dream ${sym}] tick lỗi:`, err);
      }
      const stale = fx.lastDataAt > 0 && Date.now() - fx.lastDataAt > DATA_STALE_MS;
      if (stale && !staleAlerted[i]) {
        staleAlerted[i] = true;
        await sendTelegram(telegram, `⚠️ FX Dream ${sym}: hơn 6 phút không lấy được nến từ Binance — bot không thấy tín hiệu mới.`, undefined);
      } else if (!stale && staleAlerted[i]) {
        staleAlerted[i] = false;
        await sendTelegram(telegram, `✅ FX Dream ${sym}: đã lấy lại được dữ liệu nến.`, undefined);
      }
    }
    setTimeout(() => void loop(), TICK_MS);
  };
  void loop();
}

async function main(): Promise<void> {
  console.log(`🎯 FX Dream bot · ${symbolsLabel} · ${engineLine()}`);
  if (trader && binance) {
    try {
      const pf = await trader.preflight(SYMBOLS);
      for (const w of pf.warnings) console.warn(`[Preflight] ⚠️ ${w}`);
      if (!pf.ok) {
        await sendTelegram(telegram, `❌ *Không bật được giao dịch*\n${pf.errors.map((e) => "• " + escapeMarkdown(e)).join("\n")}\nBot chạy ALERT-ONLY.`);
      } else {
        tradingReady = true;
        setInterval(() => void trader.syncTime().catch(() => {}), 30 * 60_000);
        console.log(`[Trade] ✅ THỰC THI BẬT (${TESTNET ? "TESTNET" : "MAINNET"}) · equity $${pf.equity.toFixed(2)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Trade] preflight lỗi — ALERT-ONLY:", msg);
      await sendTelegram(telegram, `❌ *Lỗi kết nối Binance* — ${escapeMarkdown(msg)}\nBot chạy ALERT-ONLY.`);
    }
  } else {
    console.log(`[Trade] Alert-only (TRADING_ENABLED=${TRADING_ENABLED}${TRADING_ENABLED && !binance ? ", thiếu API key" : ""}).`);
  }

  for (const fx of fxs) await fx.start();
  await sendTelegram(telegram, `🎯 *FX Dream bot đã chạy* · ${escapeMarkdown(symbolsLabel)}\n${escapeMarkdown(engineLine())}\nSMC/Turtle/Fast/MEXC: TẮT (không nạp)\nMỗi mã tối đa một lệnh. 00:00–06:00 tự vào lệnh với NỬA rủi ro, còn lại hỏi ý trước.\n\n${await healthText()}`);
  startCommandListener();
  startLoops();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log("⛔ Tắt bot...");
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Lỗi khởi động:", err);
  process.exit(1);
});
