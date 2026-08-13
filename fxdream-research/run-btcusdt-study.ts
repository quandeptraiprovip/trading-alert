/**
 * fxdream-research/run-btcusdt-study.ts
 *
 * Script nghiên cứu chuyên sâu phương pháp FX Dream Trading trên BTCUSDT Binance Futures.
 * Tải dữ liệu nến 5m/15m/1h/4h/1d, thực hiện backtest song song nhiều kịch bản để giải mã
 * tại sao bản backtest cũ lỗ trong khi thực tế giao dịch lại lời.
 *
 * Chạy script:
 *   npx ts-node fxdream-research/run-btcusdt-study.ts [days]
 */

import "../load-env";
import fs from "fs";
import path from "path";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, aggregate } from "../strategy";
import { DEFAULT_FXDREAM_PARAMS, FXDreamParams } from "./strategy-engine";
import { runFXDreamBacktest, BacktestSummary } from "./backtest-runner";

const DEFAULT_DAYS = 365;

async function main() {
  const daysArg = parseInt(process.argv[2] || `${DEFAULT_DAYS}`, 10);
  const days = isNaN(daysArg) ? DEFAULT_DAYS : daysArg;
  const symbol = "BTCUSDT";
  const totalBars5m = days * 288; // 288 bars of 5m per day

  console.log(`================================================================`);
  console.log(` NGHIÊN CỨU PHƯƠNG PHÁP FX DREAM TRADING — CHART BTCUSDT BINANCE`);
  console.log(` Khoảng thời gian: ${days} ngày (~${totalBars5m} nến 5m)`);
  console.log(`================================================================\n`);

  // 1. Fetch 5m candles from Binance Futures API
  console.log(`[1/3] Đang tải dữ liệu nến 5m cho ${symbol} từ Binance Futures...`);
  const c5m = await fetchKlinesPaged(symbol, "5m", totalBars5m, "futures");
  if (!c5m || c5m.length === 0) {
    console.error(`Không tải được dữ liệu nến cho ${symbol}! Check kết nối internet hoặc API.`);
    process.exit(1);
  }

  console.log(` -> Đã tải ${c5m.length} nến 5m (từ ${new Date(c5m[0].openTime).toISOString()} tới ${new Date(c5m[c5m.length - 1].openTime).toISOString()}).`);

  // 2. Aggregate timeframes
  console.log(`[2/3] Gom nến đa khung thời gian (15m, 1h, 4h, 1d)...`);
  const c15m = aggregate(c5m, "15m", "5m");
  const c1h = aggregate(c5m, "1h", "5m");
  const c4h = aggregate(c5m, "4h", "5m");
  const c1d = aggregate(c5m, "1d", "5m");
  console.log(` -> Aggregated: ${c15m.length} nến 15m, ${c1h.length} nến 1h, ${c4h.length} nến 4h, ${c1d.length} nến 1d.`);

  // 3. Define Configurations for Comparative Study
  console.log(`\n[3/3] Đang chạy mô phỏng backtest trên các biến thể cấu hình...`);

  const configs: { name: string; description: string; params: FXDreamParams }[] = [
    {
      name: "1. FXDream-Standard (Tối Ưu Thực Tế)",
      description: "Limit Maker + SFP Pattern + Stop Wick SFP + Daily Trap Gate (#31)",
      params: {
        ...DEFAULT_FXDREAM_PARAMS,
        executionType: "limit-maker",
        entryTrigger: "sfp-pattern",
        stopMode: "sfp-wick",
        requireDailyTrapGate: true,
      },
    },
    {
      name: "2. Limit Maker + SFP (Không Trap Gate)",
      description: "Bỏ Daily Trap Gate, giữ Limit Maker + SFP Pattern",
      params: {
        ...DEFAULT_FXDREAM_PARAMS,
        executionType: "limit-maker",
        entryTrigger: "sfp-pattern",
        stopMode: "sfp-wick",
        requireDailyTrapGate: false,
      },
    },
    {
      name: "3. Market Taker + SFP Pattern",
      description: "Khớp Market Taker khi có SFP nến đảo chiều (Phí Taker + Slippage)",
      params: {
        ...DEFAULT_FXDREAM_PARAMS,
        executionType: "market-taker",
        entryTrigger: "sfp-pattern",
        stopMode: "sfp-wick",
        requireDailyTrapGate: true,
      },
    },
    {
      name: "4. Code Cũ Máy Móc (Market Taker + M15 BOS)",
      description: "Mô phỏng bản code cũ: Khớp Market + Bắt buộc M15 BOS",
      params: {
        ...DEFAULT_FXDREAM_PARAMS,
        executionType: "market-taker",
        entryTrigger: "m15-bos",
        stopMode: "confirmation-candle",
        requireDailyTrapGate: false,
        requireFollowThrough: false,
      },
    },
    {
      name: "5. Limit Maker + SL Rộng Hơn (Outer Key)",
      description: "Đặt Stop Loss ngoài biên Key Volume thay vì sát râu SFP",
      params: {
        ...DEFAULT_FXDREAM_PARAMS,
        executionType: "limit-maker",
        entryTrigger: "sfp-pattern",
        stopMode: "outer-key",
        requireDailyTrapGate: true,
      },
    },
  ];

  const results: { name: string; summary: BacktestSummary }[] = [];

  for (const cfg of configs) {
    const summary = runFXDreamBacktest(symbol, c5m, c15m, c1h, c4h, c1d, cfg.params);
    results.push({ name: cfg.name, summary });
  }

  // 4. Render Markdown Report & Terminal Output
  let markdownReport = `# KẾT QUẢ NGHIÊN CỨU PHƯƠNG PHÁP FX DREAM TRADING TRÊN BTCUSDT

> **Dữ liệu:** Binance Futures BTCUSDT (${days} ngày từ ${results[0].summary.startDate} tới ${results[0].summary.endDate})

## Bảng So Sánh Hiệu Năng Chi Tiết

| Biến Thể Cấu Hình | Lệnh | Win Rate | Gross R | Phí R (Cost) | Net R | Expectancy | Profit Factor | Max DD (R) |
|---|---|---|---|---|---|---|---|---|
`;

  console.log(`\n========================================================================================================`);
  console.log(`                               BẢNG KẾT QUẢ SO SÁNH HIỆU NĂNG ON BTCUSDT`);
  console.log(`========================================================================================================`);
  console.log(
    `| ${"Cấu Hình".padEnd(38)} | ${"Lệnh".padStart(5)} | ${"WinRate".padStart(8)} | ${"Gross R".padStart(9)} | ${"Phí R".padStart(8)} | ${"Net R".padStart(9)} | ${"Exp/Lệnh".padStart(9)} | ${"PF".padStart(6)} | ${"MaxDD".padStart(7)} |`
  );
  console.log(`--------------------------------------------------------------------------------------------------------`);

  for (const r of results) {
    const s = r.summary;
    const wrStr = `${s.winRate.toFixed(1)}%`;
    const grossStr = `${s.grossR >= 0 ? "+" : ""}${s.grossR.toFixed(1)}R`;
    const costStr = `-${s.costR.toFixed(1)}R`;
    const netStr = `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R`;
    const expStr = `${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(2)}R`;
    const pfStr = s.profitFactor.toFixed(2);
    const ddStr = `-${s.maxDrawdownR.toFixed(1)}R`;

    console.log(
      `| ${r.name.padEnd(38)} | ${s.totalTrades.toString().padStart(5)} | ${wrStr.padStart(8)} | ${grossStr.padStart(9)} | ${costStr.padStart(8)} | ${netStr.padStart(9)} | ${expStr.padStart(9)} | ${pfStr.padStart(6)} | ${ddStr.padStart(7)} |`
    );

    markdownReport += `| **${r.name}** | ${s.totalTrades} | ${wrStr} | ${grossStr} | ${costStr} | **${netStr}** | ${expStr} | ${pfStr} | ${ddStr} |\n`;
  }
  console.log(`========================================================================================================\n`);

  // Phân tích nguyên nhân & kết luận
  const std = results[0].summary;
  const oldCode = results[3].summary;

  markdownReport += `
---

## PHÂN TÍCH CHUYÊN SÂU NGUYÊN NHÂN KHÁC BIỆT (LIVE TRADING vs OLD BACKTEST)

### 1. Tác Động Phí Phế & Trượt Giá (Fee Impact & Execution Type)
- **Cấu hình cũ (Khớp Market Taker):** Phí khứ hồi 0.14% làm ăn mòn tới **-${oldCode.costR.toFixed(1)}R** tổng phí trên ${oldCode.totalTrades} lệnh. Phí trung bình mỗi lệnh chiếm **${oldCode.totalTrades > 0 ? (oldCode.costR / oldCode.totalTrades).toFixed(2) : 0}R**!
- **Cấu hình chuẩn thực tế (Limit Maker at OB):** Phí Maker chỉ 0.02% + 0 trượt giá, tổng phí giảm xuống còn **-${std.costR.toFixed(1)}R**. Phí trung bình mỗi lệnh giảm xuống **${std.totalTrades > 0 ? (std.costR / std.totalTrades).toFixed(2) : 0}R**, bảo toàn lợi nhuận Gross.

### 2. Kích Hoạt Entry SFP vs M15 BOS
- **SFP + Nến Đảo Chiều:** Cho phép vào lệnh ngay tại vùng cản khi có nến đảo chiều (Engulfing / Pinbar), giúp Stop Loss ngắn và R:R thắng lớn hơn hẳn.
- **Bắt buộc M15 BOS:** Khiến giá đã chạy quá xa khỏi vùng Key Volume, dẫn tới Stop Loss bị phình to (R:R kém) hoặc bị dính bẫy dội ngược.

### 3. Luật Cắt Lệnh Sớm (#31 & Follow Through)
- Kịch bản chuẩn có **${std.earlyExitCount}** lệnh được chủ động cắt sớm ở điểm hòa vốn (BE) hoặc lỗ nhẹ khi giá dừ lừ không chạy ngay theo kỳ vọng, cứu tài khoản khỏi các cú đảo chiều quét SL nặng.

---

## BÀI HỌC VẬN HÀNH THỰC TẾ TRÊN BINANCE FUTURES BTCUSDT

1. **Luôn dùng lệnh Limit (Maker) tại OB/FTR:** Tránh khớp Market để loại bỏ hoàn toàn trượt giá và hưởng mức phí Maker thấp nhất (0.02%).
2. **Kỷ luật với Daily Trap Gate (#31):** Chỉ đánh thuận theo chuỗi nến Daily và khi đã có cú quét thanh khoản trên Daily/H4.
3. **Quản lý lệnh linh hoạt:** Chốt 1/2 tại **2R**, dời SL về hòa vốn (BE), và thoát ngay nếu sau 1.5 tiếng (6 nến M15) giá không bứt phá.
`;

  // Save report to RESULTS.md inside fxdream-research/
  const resultsPath = path.join(__dirname, "RESULTS.md");
  fs.writeFileSync(resultsPath, markdownReport, "utf8");
  console.log(` -> Đã ghi báo cáo kết quả chi tiết vào: ${resultsPath}`);
}

main().catch((err) => {
  console.error("Lỗi thực thi nghiên cứu:", err);
  process.exit(1);
});
