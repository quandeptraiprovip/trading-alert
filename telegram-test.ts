/**
 * Gửi tin test Telegram — kiểm tra TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * Run: npx ts-node telegram-test.ts
 */

import "./load-env";
import { buildTestMessage, loadTelegramConfig, sendTelegram } from "./telegram";

async function main(): Promise<void> {
  const cfg = loadTelegramConfig();
  if (!cfg.enabled) {
    console.error("Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env hoặc .env.local");
    process.exit(1);
  }
  const ok = await sendTelegram(cfg, buildTestMessage());
  console.log(ok ? "Đã gửi tin test ✅" : "Gửi thất bại ❌");
  process.exit(ok ? 0 : 1);
}

main();
