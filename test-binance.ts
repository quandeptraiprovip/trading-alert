/**
 * test-binance.ts — Kiểm tra kết nối + đặt lệnh thử trên TESTNET.
 * Chạy: BINANCE_TESTNET=true ts-node test-binance.ts
 * (hoặc set trong .env.local rồi: ts-node -r dotenv/config test-binance.ts)
 */
import "dotenv/config";
import axios from "axios";
import { createBinanceFromEnv } from "./binance-futures";

const SYMBOL = "BTCUSDT";

async function main() {
  const testnet = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() !== "false";
  console.log(`\n=== Binance Futures Test ===`);
  console.log(`Môi trường : ${testnet ? "TESTNET (testnet.binancefuture.com)" : "⚠️  MAINNET (fapi.binance.com)"}`);
  console.log(`API key    : ${(process.env.BINANCE_API_KEY ?? "").slice(0, 8)}...`);

  const api = createBinanceFromEnv();
  if (!api) {
    console.error("❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong .env.local");
    process.exit(1);
  }

  // 1. Đồng bộ giờ
  console.log("\n[1] Đồng bộ giờ server...");
  await api.syncTime();
  console.log("    ✅ OK");

  // 2. Đọc số dư
  console.log("\n[2] Đọc số dư tài khoản...");
  const bal = await api.getEquity();
  console.log(`    ✅ walletBalance = ${bal.walletBalance} USDT`);
  if (bal.walletBalance <= 0) {
    console.warn("    ⚠️  Số dư = 0. Testnet: vào https://testnet.binancefuture.com → nhấn nút 'Assets' → 'Get' USDT.");
  }

  // 3. Chế độ vị thế
  console.log("\n[3] Kiểm tra position mode...");
  const hedge = await api.getPositionMode();
  console.log(`    ${hedge ? "❌ HEDGE mode — cần chuyển sang One-way trên Binance" : "✅ One-way mode (đúng)"}`);

  // 4. Load filters
  console.log(`\n[4] Load filter ${SYMBOL}...`);
  await api.loadFilters([SYMBOL]);
  const f = api.getFilters(SYMBOL);
  console.log(`    ✅ stepSize=${f.stepSize}, minQty=${f.minQty}, minNotional=${f.minNotional}`);

  // 5. Set leverage + margin
  console.log("\n[5] Set leverage=3 + ISOLATED margin...");
  try {
    await api.setMarginType(SYMBOL, "ISOLATED");
    console.log("    ✅ margin ISOLATED");
  } catch (e: any) {
    console.log(`    ⚠️  setMarginType: ${e?.response?.data?.msg ?? e.message}`);
  }
  try {
    await api.setLeverage(SYMBOL, 3);
    console.log("    ✅ leverage 3x");
  } catch (e: any) {
    console.log(`    ⚠️  setLeverage: ${e?.response?.data?.msg ?? e.message}`);
  }

  // 6. Đặt lệnh MARKET nhỏ nhất có thể
  if (bal.walletBalance <= 0) {
    console.log("\n[6] Bỏ qua đặt lệnh — số dư = 0");
    return;
  }

  // Lấy giá mark để tính qty thoả minNotional
  const baseUrl = (process.env.BINANCE_TESTNET ?? "true") !== "false"
    ? "https://testnet.binancefuture.com"
    : "https://fapi.binance.com";
  const ticker = await axios.get(`${baseUrl}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  const markPrice = parseFloat(ticker.data.price);
  console.log(`\n    Mark price: $${markPrice.toFixed(2)}`);
  // qty >= minNotional / markPrice, +1 stepSize để chắc đủ notional
  const rawQty = (f.minNotional * 1.05) / markPrice;
  const qty = api.roundQty(SYMBOL, rawQty + f.stepSize);
  console.log(`\n[6] Đặt MARKET BUY ${qty} ${SYMBOL}...`);
  try {
    const order = await api.marketOrder(SYMBOL, "BUY", qty, "test-" + Date.now());
    const entryPrice = order.avgPrice > 0 ? order.avgPrice : markPrice;
    console.log(`    ✅ orderId=${order.orderId}, avgPrice=${entryPrice.toFixed(2)}, qty=${order.executedQty}`);

    // 7. Đặt SL
    const slPrice = entryPrice * 0.95; // SL 5% dưới entry
    console.log(`\n[7] Đặt STOP_MARKET SELL SL@${slPrice.toFixed(2)}...`);
    const slId = await api.stopMarketClose(SYMBOL, "SELL", slPrice, "sl-test-" + Date.now());
    console.log(`    ✅ SL orderId=${slId}`);

    // 8. Đóng vị thế
    console.log(`\n[8] Đóng vị thế bằng MARKET SELL ${order.executedQty}...`);
    await api.cancelAllOpenOrders(SYMBOL);
    const close = await api.marketClose(SYMBOL, "SELL", order.executedQty, "close-" + Date.now());
    console.log(`    ✅ đóng tại avgPrice=${close.avgPrice}`);
  } catch (e: any) {
    const code = e?.response?.data?.code;
    const msg = e?.response?.data?.msg ?? e.message;
    console.error(`    ❌ Lỗi ${code}: ${msg}`);
    if (code === -2021) console.error("       → Giá SL sẽ kích hoạt ngay (would-immediately-trigger). Bình thường nếu thị trường biến động.");
    if (code === -1111) console.error("       → Sai precision qty/price.");
  }

  console.log("\n=== Xong ===");
}

main().catch((e) => {
  const code = e?.response?.data?.code;
  const msg = e?.response?.data?.msg ?? e.message;
  console.error(`\n❌ Lỗi ${code ?? ""}: ${msg}`);
  process.exit(1);
});
