/**
 * fxdream-bot.ts — Bot Telegram CHỈ chạy FX Dream (key-volume.ts) trên Binance BTCUSDT.
 *
 * User 04/10/26: bỏ mọi phương pháp khác (SMC, Turtle, Fast/MEXC). File này KHÔNG import chúng,
 * nên chúng không thể chạy dù `.env.local` còn bật cờ cũ. `btc-alert-bot.ts` giữ nguyên để quay lại.
 *
 * Mỗi tín hiệu gửi ẢNH + nút ✅/❌; đồng ý mới vào lệnh, trừ 00:00–06:00 tự vào — xem fxdream-live.ts.
 *
 * Env: TELEGRAM_*, TRADING_ENABLED, BINANCE_API_KEY/SECRET, BINANCE_TESTNET, LEVERAGE, MARGIN_TYPE,
 *      FXDREAM_RISK_USD (mặc định 5), TRADING_DATA_DIR.
 */

import "./load-env";
import crypto from "crypto";
import { createBinanceFromEnv } from "./binance-futures";
import { LiveTrader, loadExecConfig } from "./live-trade";
import { KEY_VOLUME_CONFIG } from "./key-volume";
import { FxDreamLive } from "./fxdream-live";
import { buildLine } from "./build-info";
import { escapeMarkdown, getTelegramUpdates, loadTelegramConfig, sendTelegram } from "./telegram";

const logTimeVn = (): string => new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(`[${logTimeVn()}]`, ...args);
}

const SYMBOL = "btcusdt";
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
const binance = TRADING_ENABLED ? createBinanceFromEnv() : null;
const trader = binance ? new LiveTrader(binance, execCfg) : null;
let tradingReady = false;

/** Mã cấu hình engine — `/health` in ra để xác nhận bản đang chạy đúng luật. */
const ENGINE_FP = crypto.createHash("sha256").update(JSON.stringify(KEY_VOLUME_CONFIG)).digest("hex").slice(0, 6);

const fx = new FxDreamLive({
  symbol: SYMBOL,
  venue: binance,
  telegram,
  riskUsd: RISK_USD,
  leverage: execCfg.leverage,
  dataDir: process.env.TRADING_DATA_DIR?.trim() || process.cwd(),
  isTradingReady: () => tradingReady,
});

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
    `Sàn: ${binance ? (TESTNET ? "Binance TESTNET" : "Binance ⚠️ MAINNET") : "không có (alert-only)"} · ${execCfg.marginType} ${execCfg.leverage}x · rủi ro $${RISK_USD}/lệnh`,
    `Dữ liệu nến: ${fx.lastDataAt ? `${Math.round((Date.now() - fx.lastDataAt) / 1000)}s trước` : "chưa có"}`,
  ];
  if (binance) {
    try {
      const eq = await binance.getEquity();
      lines.push(`Equity $${eq.walletBalance.toFixed(2)} · khả dụng $${eq.available.toFixed(2)}`);
    } catch (err) {
      lines.push(`⚠️ Không đọc được số dư: ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`);
    }
  }
  lines.push("", escapeMarkdown(fx.statusText()));
  return lines.join("\n");
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
            await fx.handleCallback(u.callback);
            continue;
          }
          const text = u.text.trim();
          const cmd = text.toLowerCase().split(/[\s@]/)[0];
          const yesNo = /^\/(yes|no|edit)_(\w+)$/.exec(cmd);
          if (yesNo?.[1] === "edit") await fx.startEdit(yesNo[2]);
          else if (yesNo) await fx.decide(yesNo[2], yesNo[1] === "yes");
          else if (!cmd.startsWith("/") && (await fx.handleText(text))) continue;
          else if (cmd === "/health") await sendTelegram(telegram, await healthText());
          else if (cmd === "/status" || cmd === "/start") await sendTelegram(telegram, fx.statusText(), undefined);
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
  let staleAlerted = false;
  const loop = async (): Promise<void> => {
    try {
      await fx.tick();
    } catch (err) {
      console.error("[FX Dream] tick lỗi:", err);
    }
    const stale = fx.lastDataAt > 0 && Date.now() - fx.lastDataAt > DATA_STALE_MS;
    if (stale && !staleAlerted) {
      staleAlerted = true;
      await sendTelegram(telegram, "⚠️ FX Dream: hơn 6 phút không lấy được nến từ Binance — bot không thấy tín hiệu mới.", undefined);
    } else if (!stale && staleAlerted) {
      staleAlerted = false;
      await sendTelegram(telegram, "✅ FX Dream: đã lấy lại được dữ liệu nến.", undefined);
    }
    setTimeout(() => void loop(), TICK_MS);
  };
  void loop();
}

async function main(): Promise<void> {
  console.log(`🎯 FX Dream bot · ${SYMBOL.toUpperCase()} · ${engineLine()}`);
  if (trader && binance) {
    try {
      const pf = await trader.preflight([SYMBOL]);
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

  await fx.start();
  await sendTelegram(telegram, `🎯 *FX Dream bot đã chạy*\n${escapeMarkdown(engineLine())}\nSMC/Turtle/Fast/MEXC: TẮT (không nạp)\n00:00–06:00 tự vào lệnh, còn lại hỏi ý trước.\n\n${await healthText()}`);
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
