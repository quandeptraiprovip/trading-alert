/**
 * Telegram — gửi thông báo bot (startup, ARM setup, vào lệnh).
 * Cấu hình qua .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import axios from "axios";
import { CONFIG, TF_MS } from "./strategy";
import type { Candle, EntrySignal, PendingSetup } from "./strategy";

export type TelegramConfig = {
  botToken: string;
  chatId: string;
  enabled: boolean;
};

export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  return {
    botToken,
    chatId,
    enabled: Boolean(botToken && chatId),
  };
}

export function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** "btcusdt" -> "BTC/USDT" (nhãn hiển thị trong alert). */
export function formatSymbol(sym: string): string {
  const s = sym.toUpperCase();
  return s.endsWith("USDT") ? `${s.slice(0, -4)}/USDT` : s;
}

export function formatTimeVn(ms: number): string {
  return new Date(ms).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "short",
  });
}

export async function sendTelegram(
  cfg: TelegramConfig,
  message: string,
  parseMode: "Markdown" | undefined = "Markdown"
): Promise<boolean> {
  if (!cfg.enabled) {
    console.log("\n" + "=".repeat(54) + "\n[Telegram — chưa cấu hình, log console]\n" + message + "\n" + "=".repeat(54) + "\n");
    return false;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      chat_id: cfg.chatId,
      text: message,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    return true;
  } catch (err: unknown) {
    const data = axios.isAxiosError(err) ? err.response?.data : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Telegram] Lỗi:", data ?? msg);
    return false;
  }
}

/** Đọc tin nhắn đến (lệnh) từ Telegram. Trả [] nếu chưa cấu hình / lỗi. */
export async function getTelegramUpdates(
  cfg: TelegramConfig,
  offset: number
): Promise<{ id: number; text: string; chatId: string }[]> {
  if (!cfg.enabled) return [];
  try {
    const res = await axios.get(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`, {
      params: { offset, timeout: 0, allowed_updates: JSON.stringify(["message"]) },
      timeout: 15000,
    });
    const result = (res.data?.result ?? []) as any[];
    return result.map((u) => ({
      id: u.update_id as number,
      text: (u.message?.text ?? "") as string,
      chatId: String(u.message?.chat?.id ?? ""),
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Telegram] getUpdates lỗi:", msg);
    return [];
  }
}

export function buildStartupMessage(symbols: string[]): string {
  return [
    `🤖 *Swing Bot* đã chạy`,
    ``,
    `📈 *${symbols.map(formatSymbol).join(", ")}* Perpetual (Binance Futures)`,
    `⏱ Entry *${CONFIG.entryTf}* · Bias *${CONFIG.htfBiasTf}* / Vùng *${CONFIG.htfZoneTf}*`,
    ``,
    `*Luồng alert:*`,
    `1️⃣ *ARM* — giá tap vùng FRESH, chờ BOS 15m`,
    `2️⃣ *MỞ LỆNH* — xác nhận BOS + volume/delta`,
    `3️⃣ *RA LỆNH* — chạm SL / TP / trail / hết hạn giữ`,
    ``,
    `💬 Gõ */status* để xem lệnh đang giữ.`,
    ``,
    `_Thời gian: ${formatTimeVn(Date.now())}_`,
  ].join("\n");
}

export function buildArmMessage(setup: PendingSetup, candle: Candle, symbol: string): string {
  const dir = setup.direction === "long" ? "🟡 *CHỜ LONG*" : "🟠 *CHỜ SHORT*";
  const z = setup.zone;
  const zoneLabel = z.type === "demand" ? "Demand" : "Supply";
  return [
    `${dir}  *${formatSymbol(symbol)}* Perp`,
    ``,
    `📍 *Bước 1 — ARM* (tap vùng)`,
    `${zoneLabel} FRESH $${fmtPrice(z.low)}-${fmtPrice(z.high)} (mitig ${z.mitigations})`,
    `Giá đóng: $${fmtPrice(candle.close)}`,
    ``,
    `⏳ Chờ *BOS 15m* + volume/delta cùng hướng để vào lệnh.`,
    `Huỷ nếu thủng vùng / bias đảo / quá ${CONFIG.setupExpiryBars} nến.`,
    `🕐 ${formatTimeVn(candle.openTime)}`,
  ].join("\n");
}

export function buildEntryMessage(sig: EntrySignal, candle: Candle, symbol: string): string {
  const dir = sig.direction === "long" ? "🟢 *MỞ LONG*" : "🔴 *MỞ SHORT*";
  const slPct = (Math.abs(sig.entry - sig.initialSL) / sig.entry) * 100;
  const tpPct = (Math.abs(sig.initialTarget - sig.entry) / sig.entry) * 100;
  const qv = candle.quoteVolume ?? 0;
  const volLine = qv > 0 ? `📊 Vol nến: $${(qv / 1e6).toFixed(1)}M USDT` : "";
  const lines = [
    `${dir}  *${formatSymbol(symbol)}* Perp`,
    ``,
    `✅ *Bước 2 — MỞ LỆNH* (confirm)`,
    `🎯 Entry : $${fmtPrice(sig.entry)}`,
    `🛑 SL    : $${fmtPrice(sig.initialSL)}  (${slPct.toFixed(2)}%)`,
    `🎯 TP    : $${fmtPrice(sig.initialTarget)}  (${tpPct.toFixed(2)}%, ~${sig.rr.toFixed(1)}R)`,
  ];
  if (volLine) lines.push(volLine);
  lines.push(``, `📐 ${sig.reason}`, `🕐 ${formatTimeVn(candle.openTime)}`, ``);
  lines.push(
    `_Quản lý: ${CONFIG.breakevenEnabled ? `dời SL về hoà vốn @ +${CONFIG.breakevenAtR}R, ` : ""}trail swing 1h sau +${CONFIG.trailStartR}R._`
  );
  return lines.join("\n");
}

export type ExitReason = "sl" | "trail" | "time" | "target";

export function buildExitMessage(params: {
  dir: "long" | "short";
  entryPrice: number;
  initialSL: number;
  exitPrice: number;
  exitReason: ExitReason;
  grossR: number;
  holdBars: number;
  exitTime: number;
  symbol: string;
}): string {
  const { dir, entryPrice, initialSL, exitPrice, exitReason, grossR, holdBars, exitTime, symbol } = params;
  const win = grossR > 0;
  const head =
    dir === "long"
      ? win
        ? "💰 *RA LONG* (lãi)"
        : "📤 *RA LONG*"
      : win
        ? "💰 *RA SHORT* (lãi)"
        : "📤 *RA SHORT*";
  const reasonVi: Record<ExitReason, string> = {
    sl: "Cắt SL",
    trail: "Trail SL",
    target: "Chạm TP",
    time: "Hết hạn giữ",
  };
  const holdDays = ((holdBars * TF_MS[CONFIG.entryTf]) / TF_MS["1d"]).toFixed(1);
  const rStr = `${grossR >= 0 ? "+" : ""}${grossR.toFixed(2)}R`;
  return [
    `${head}  *${formatSymbol(symbol)}* Perp`,
    ``,
    `📤 *Bước 3 — RA LỆNH*`,
    `Vào: $${fmtPrice(entryPrice)} → Ra: $${fmtPrice(exitPrice)}`,
    `SL ban đầu: $${fmtPrice(initialSL)}`,
    `Lý do: *${reasonVi[exitReason]}* (${exitReason})`,
    `Kết quả: *${rStr}* (gross, trước phí)`,
    `Giữ: ~${holdDays} ngày (${holdBars} nến ${CONFIG.entryTf})`,
    `🕐 ${formatTimeVn(exitTime)}`,
  ].join("\n");
}

export function buildTestMessage(): string {
  return [
    `✅ *Test Telegram* — BTC Swing Alert`,
    ``,
    `Kênh hoạt động. Bot gửi ARM → mở lệnh → ra lệnh (SL/TP/trail) khi nến ${CONFIG.entryTf} đóng.`,
    `🕐 ${formatTimeVn(Date.now())}`,
  ].join("\n");
}
