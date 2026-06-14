# BTC Swing Alert Bot + Backtest

Bot báo tín hiệu **swing** (giữ lệnh 1-2 ngày+) cho **BTCUSDT Perpetual** trên Binance,
theo phong cách **SMC / price-action đa khung**, kèm **backtest** để kiểm chứng lợi nhuận.

## Chiến lược (file `strategy.ts`)

| Bước | Khung | Việc |
|------|-------|------|
| 1. Bias | **4h** + **1h** | Market structure (HH/HL = bull, LH/LL = bear). 2 khung phải **đồng thuận** |
| 2. Vùng | **1h** | "Vùng order block" = nến kích **dollar (quote) volume** mạnh (≥2x avg) + **delta (CVD) cùng hướng**. **Ưu tiên vùng FRESH** (chưa bị giá quay lại "mitigate"; `maxZoneMitigations`) — đây là vùng mạnh nhất theo lý thuyết SMC |
| 3a. ARM | **15m** | Giá **tap vào vùng FRESH** cùng hướng bias → ghi nhận setup chờ (chưa vào lệnh) |
| 3b. CONFIRM | **15m** | Sau pullback tạo đáy/đỉnh, nến đóng cửa **phá cấu trúc (BOS) swing 15m** + có **volume** + **delta cùng hướng** → mới vào lệnh. Huỷ nếu thủng vùng / bias đảo / quá hạn (24 nến) |
| 4. SL/TP | — | SL dưới đáy pullback/vùng. (Tùy chọn `breakevenEnabled`, **mặc định TẮT** vì giảm EV.) Sau +1.5R → **trail theo swing 1h** (kéo SL vào vùng hỗ trợ thật) |

> **Entry 2 bước (`SetupTracker`)** là điểm mấu chốt: tách "chạm vùng" và "xác nhận đảo chiều"
> qua nhiều nến thay vì gộp vào 1 nến.
>
> **5 cải tiến đã áp dụng** (chi tiết bên dưới):
> **(A)** Ưu tiên vùng **FRESH** thay vì bắt buộc đã reactivate (đảo lại logic cho đúng SMC) ·
> **(B)** Backtest **trừ chi phí thật** (phí + slippage + funding) → con số **NET** ·
> **(C)** Volume nâng cấp: **dollar volume + delta/CVD** xác nhận hướng ·
> **(D)** **Tắt breakeven** mặc định (giảm EV) — bật lại qua `breakevenEnabled` ·
> **(F)** Backtest **đa-symbol + walk-forward + bootstrap CI + Monte Carlo** kiểm định edge.

Toàn bộ tham số nằm ở `CONFIG` trong `strategy.ts`. Bot live và backtest **dùng chung** logic này → alert khớp với kết quả backtest.

---

## Backtest — kiểm tra điểm vào/ra & lợi nhuận

```bash
npm install
npx ts-node backtest.ts [soNgay] [riskPctMoiLenh]

# ví dụ:
npx ts-node backtest.ts 120 1     # 120 ngày, risk 1%/lệnh
npx ts-node backtest.ts 250 1     # 250 ngày
```

In ra: số lệnh, tần suất, win rate, tổng R, equity (compounding), max drawdown,
và **danh sách từng lệnh kèm thời điểm + giá VÀO/RA** để đối chiếu TradingView.

### Kết quả thật sau 5 cải tiến — **NET (đã trừ chi phí)**, 254 ngày, tính tới 14/06/2026

Chi phí mô hình: taker 0.05% + slippage 0.02% mỗi chiều + funding 0.01%/8h.

| Phạm vi | Số lệnh | Win rate | Gross R | Chi phí | **NET R** | Equity (risk 1%) | Max DD |
|---------|---------|----------|---------|---------|-----------|------------------|--------|
| **BTC** | 18 | 72% | +19.29R | -1.71R | **+17.58R** | +18.9% | -3.2% |
| **4 coin** (BTC/ETH/SOL/BNB) | 70 | 46% | +27.24R | -6.78R | **+20.46R** | +21.6% | -15.9% |

**Theo từng coin (NET):** BTC **+17.58R**, SOL **+10.02R**, BNB **-1.94R**, ETH **-5.20R (WR 20%)**.

**Kiểm định trên mẫu 4 coin:**
- **Walk-forward 4 cửa sổ:** W1..W3 đều **dương** (+13.0 / +11.5 / +5.5R), nhưng **W4 (~2 tháng gần nhất) -9.5R / WR 21%** → regime gần đây bất lợi.
- **Bootstrap:** P(tổng NET R > 0) = **93.9%**, 90% CI = **[-1.25R, +42R]** (cận dưới hơi âm).
- **Monte Carlo random-entry:** mean **0.292R/lệnh** vs random **-0.057R**, **p = 0.025** → vượt random ở mức 5%.

> ⚠️ **Đọc kỹ trước khi tin:** edge **dương trên tổng thể nhưng KHÔNG đồng đều** — tập trung ở
> BTC/SOL, còn **ETH âm nặng** và **2 tháng gần nhất (W4) âm**. Mẫu vẫn nhỏ (70 lệnh, 1 chu kỳ
> thị trường). Equity compounding tính **tuần tự** nên **chưa phản ánh rủi ro khi nhiều lệnh mở
> đồng thời** giữa các coin (max DD thực có thể cao hơn -15.9%). Hãy **forward-test** và đối
> chiếu TradingView trước khi đặt tiền thật.

### 5 cải tiến (A, B, C, D, F) — bật/tắt qua `CONFIG` trong `strategy.ts`

- **(A) Vùng FRESH** — `maxZoneMitigations` (0 = chỉ vùng chưa bị chạm; 1 = cho phép chạm 1 lần).
  Đã **bỏ** yêu cầu `reactivations>=1` cũ (vốn ngược lý thuyết SMC: vùng càng bị chạm càng yếu).
- **(B) Chi phí** — `CONFIG.costs` (`takerFeePct`, `slippagePct`, `fundingPer8hPct`). Backtest in **Gross / Chi phí / NET**.
- **(C) Volume** — `useQuoteVolume` (dollar volume), `useDelta` + `deltaBuyMin` (CVD xác nhận hướng), `useTimeOfDayRVOL` + `rvolLookbackDays` (chuẩn hoá theo giờ, mặc định tắt).
- **(D) Breakeven** — `breakevenEnabled` (mặc định **false**), `breakevenAtR`. A/B test BE vs no-BE.
- **(F) Validation** — `CONFIG.symbols` (đa coin) + backtest tự in walk-forward, bootstrap CI, Monte Carlo p-value.

```bash
npx ts-node backtest.ts 250 1                  # 4 coin trong CONFIG.symbols
npx ts-node backtest.ts 250 1 btcusdt          # chỉ BTC
npx ts-node backtest.ts 250 1 btcusdt,ethusdt  # chọn coin tùy ý
```

Sau **mỗi** thay đổi → chạy lại trên **nhiều coin + nhiều khoảng thời gian** và xem walk-forward/p-value để tránh overfit.

---

## Bot live (forward-test / alert thật)

### 1. Telegram (tuỳ chọn — không có thì log ra console)
1. Nhắn **@BotFather** → `/newbot` → lấy **Bot Token**
2. Nhắn cho bot vài chữ, mở `https://api.telegram.org/bot<TOKEN>/getUpdates` → lấy **Chat ID**
3. Tạo `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```

### 2. Chạy
```bash
npx ts-node btc-alert-bot.ts   # hoặc: npm start
```

Bot prefetch lịch sử 15m, kết nối Binance Futures WebSocket, và mỗi khi nến 15m đóng sẽ
đánh giá setup. Có tín hiệu → gửi alert kèm **Entry / SL / TP / lý do**:

```
🟢 LONG  BTC/USDT Perp

🎯 Entry : $67,420
🛑 SL    : $66,800  (0.92%)
✅ TP    : $68,970  (2.30%, ~2.5R)

📐 Lý do : Tap demand FRESH $66,750-66,980 (mitig 0) → pullback đáy $66,720
          → BOS phá $67,180 +vol 1.6x; HTF bull
🕐 14/06 15:30
```

> Lưu ý: alert mặc định **không** dời SL về hoà vốn (breakeven tắt) — chỉ trail theo swing 1h sau +1.5R.

### Chạy 24/7
```bash
npm install -g pm2
pm2 start "npx ts-node btc-alert-bot.ts" --name btc-swing-bot
pm2 save
```

---

## File

- `strategy.ts` — logic chiến lược dùng chung (chỉnh tham số ở đây)
- `backtest.ts` — engine backtest + báo cáo
- `btc-alert-bot.ts` — bot live gửi alert
