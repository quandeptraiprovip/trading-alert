/**
 * Telegram — gửi thông báo bot (startup, ARM setup, vào lệnh).
 * Cấu hình qua .env: TELEGRAM_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import axios from "axios";
import * as https from "https";
import * as dns from "dns";

// Force IPv4 — IPv6 bị block bởi Telegram API trên nhiều môi trường
dns.setDefaultResultOrder("ipv4first");
const httpsAgent = new https.Agent({ family: 4, keepAlive: true, keepAliveMsecs: 30_000 });


export type TelegramConfig = {
  botToken: string;
  chatId: string;
  enabled: boolean;
};

export function loadTelegramConfig(): TelegramConfig {
  const enabled = process.env.TELEGRAM_ENABLED?.trim().toLowerCase() === "true";
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  return {
    botToken,
    chatId,
    enabled: enabled && Boolean(botToken && chatId),
  };
}

/**
 * Escape các ký tự đặc biệt của Telegram legacy Markdown (_ * ` [) trong text ĐỘNG/không kiểm
 * soát được (message lỗi exception, msg trả về từ Binance API...) trước khi chèn vào template
 * alert. Thiếu bước này: 1 ký tự lẻ (vd "MIN_NOTIONAL" chỉ có 1 dấu "_") khiến Telegram không
 * tìm được entity đóng → toàn bộ tin nhắn bị từ chối với lỗi "can't parse entities".
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, "\\$1");
}

export function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumSignificantDigits: 8 });
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
  // Retry vì entry/exit là sự kiện quan trọng: mất alert do mạng chập chờn = state lệch ngầm
  // (bot tracking lệnh user không hề biết). 3 lần, backoff 2s/4s.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        chat_id: cfg.chatId,
        text: message,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }, { timeout: 15000, httpsAgent });
      return true;
    } catch (err: unknown) {
      lastErr = err;
      // 4xx (vd sai chat_id, markdown lỗi) thì retry vô ích — dừng ngay
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status && status >= 400 && status < 500) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  const data = axios.isAxiosError(lastErr) ? lastErr.response?.data : undefined;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.error("[Telegram] Lỗi (đã thử 3 lần):", data ?? msg);
  return false;
}

// ── Retry bền bỉ cho cảnh báo quan trọng (mất kết nối / phục hồi) ──
// sendTelegram() chỉ thử 3 lần trong ~6s rồi bỏ — không đủ nếu đúng lúc đó mạng đang đứt
// (trường hợp thực tế: cả 2 alert "mất kết nối" đêm 16/7 gửi thất bại và mất luôn, không ai biết
// tới khi kiểm tra log thủ công). Các hàm dưới giữ lại tin thất bại, thử lại ở tick giám sát kế
// tiếp cho tới khi gửi được — dùng cho alert sức khỏe kết nối, KHÔNG áp dụng cho alert vào/ra lệnh.
const pendingAlerts: string[] = [];

/** Gửi tin quan trọng; nếu thất bại thì giữ lại để flushPendingTelegram() thử lại sau. */
export async function sendTelegramReliable(cfg: TelegramConfig, message: string): Promise<void> {
  if (!cfg.enabled) return;
  const ok = await sendTelegram(cfg, message);
  if (!ok) pendingAlerts.push(message);
}

/** Gọi định kỳ (mỗi tick health-check) để thử gửi lại các tin đã kẹt vì mất mạng lúc gửi. */
export async function flushPendingTelegram(cfg: TelegramConfig): Promise<void> {
  if (!cfg.enabled || pendingAlerts.length === 0) return;
  const queue = pendingAlerts.splice(0, pendingAlerts.length);
  for (const msg of queue) {
    const ok = await sendTelegram(cfg, msg);
    if (!ok) pendingAlerts.push(msg); // vẫn chưa gửi được — giữ lại, thử tiếp lần sau
  }
}

/** Một lượt bấm nút inline (callback_query). */
export type TelegramCallback = { id: string; data: string; messageId: number };

/**
 * Đọc tin nhắn đến (lệnh) và lượt bấm nút từ Telegram. Trả [] nếu chưa cấu hình, null nếu lỗi.
 * Lượt bấm nút có `text` rỗng và `callback` khác undefined.
 */
export async function getTelegramUpdates(
  cfg: TelegramConfig,
  offset: number
): Promise<{ id: number; text: string; chatId: string; callback?: TelegramCallback }[] | null> {
  if (!cfg.enabled) return [];
  try {
    const res = await axios.get(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`, {
      params: { offset, timeout: 0, allowed_updates: JSON.stringify(["message", "callback_query"]) },
      timeout: 15000,
      httpsAgent,
    });
    const result = (res.data?.result ?? []) as any[];
    return result.map((u) => {
      const cq = u.callback_query;
      return {
        id: u.update_id as number,
        text: (u.message?.text ?? "") as string,
        chatId: String(cq?.message?.chat?.id ?? u.message?.chat?.id ?? ""),
        callback: cq
          ? { id: String(cq.id), data: String(cq.data ?? ""), messageId: Number(cq.message?.message_id ?? 0) }
          : undefined,
      };
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const data = err.response?.data;
      console.error("[Telegram] getUpdates lỗi:", err.code ?? err.message, status ? `HTTP ${status}` : "", data ? JSON.stringify(data) : "");
    } else {
      console.error("[Telegram] getUpdates lỗi:", String(err));
    }
    return null;
  }
}

export type InlineButton = { text: string; data: string };

/**
 * Gửi ảnh PNG kèm chú thích (văn bản thường, ≤1024 ký tự) và hàng nút bấm. Trả message_id,
 * hoặc null khi chưa cấu hình / lỗi. Thử lại 3 lần như `sendTelegram`.
 */
export async function sendTelegramPhoto(
  cfg: TelegramConfig,
  png: Buffer,
  caption: string,
  buttons?: InlineButton[],
): Promise<number | null> {
  if (!cfg.enabled) {
    console.log("\n[Telegram — chưa cấu hình, ảnh không gửi]\n" + caption + "\n");
    return null;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const form = new FormData();
      form.append("chat_id", cfg.chatId);
      form.append("caption", caption.slice(0, 1024));
      if (buttons?.length) {
        form.append("reply_markup", JSON.stringify({
          inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))],
        }));
      }
      form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "fxdream.png");
      const res = await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendPhoto`, form, {
        timeout: 30000,
        httpsAgent,
      });
      return Number(res.data?.result?.message_id ?? 0) || null;
    } catch (err: unknown) {
      lastErr = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status && status >= 400 && status < 500) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  const data = axios.isAxiosError(lastErr) ? lastErr.response?.data : undefined;
  console.error("[Telegram] sendPhoto lỗi:", data ?? (lastErr instanceof Error ? lastErr.message : String(lastErr)));
  return null;
}

/**
 * Thay chú thích ảnh đã gửi và GỠ hàng nút (bấm xong thì nút không còn bấm lại được),
 * hoặc thay bằng hàng nút `buttons` nếu có.
 */
export async function editTelegramCaption(cfg: TelegramConfig, messageId: number, caption: string, buttons?: InlineButton[]): Promise<void> {
  if (!cfg.enabled || !messageId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${cfg.botToken}/editMessageCaption`, {
      chat_id: cfg.chatId,
      message_id: messageId,
      caption: caption.slice(0, 1024),
      reply_markup: { inline_keyboard: buttons?.length ? [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] : [] },
    }, { timeout: 15000, httpsAgent });
  } catch (err: unknown) {
    const data = axios.isAxiosError(err) ? err.response?.data : undefined;
    console.error("[Telegram] editMessageCaption lỗi:", data ?? (err instanceof Error ? err.message : String(err)));
  }
}

/** Trả lời lượt bấm nút (tắt vòng xoay trên app, hiện một dòng ngắn). */
export async function answerTelegramCallback(cfg: TelegramConfig, callbackId: string, text: string): Promise<void> {
  if (!cfg.enabled) return;
  try {
    await axios.post(`https://api.telegram.org/bot${cfg.botToken}/answerCallbackQuery`, {
      callback_query_id: callbackId,
      text: text.slice(0, 190),
    }, { timeout: 15000, httpsAgent });
  } catch {
    /* chỉ là phản hồi giao diện */
  }
}

export function buildTestMessage(): string {
  return [
    `✅ *Test Telegram* — FX Dream & Bot Chart`,
    ``,
    `Kênh hoạt động bình thường. Bot kết nối thành công tới Telegram.`,
    `🕐 ${formatTimeVn(Date.now())}`,
  ].join("\n");
}
