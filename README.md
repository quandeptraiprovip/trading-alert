# BTC Swing Alert Bot + Backtest

Bot báo tín hiệu **swing** (giữ lệnh 1-2 ngày+) cho **rổ Perpetual** trên Binance
(**BTC + SOL + XRP + DOGE**, chỉnh tại `CONFIG.symbols`), theo phong cách
**SMC / price-action đa khung**, kèm **backtest** để kiểm chứng lợi nhuận.

> Bot live theo dõi **đồng thời nhiều symbol** (mỗi coin một state độc lập: vùng/bias/vị thế/cooldown
> riêng), nên có thể mở tối đa N lệnh cùng lúc (N = số symbol). Gõ **`/status`** trên Telegram để xem
> bot đang giữ/chờ lệnh nào.

## Chiến lược (file `strategy.ts`)

| Bước | Khung | Việc |
|------|-------|------|
| 1. Bias | **4h** + **1h** | Market structure (HH/HL = bull, LH/LL = bear). 2 khung phải **đồng thuận** |
| 2. Vùng | **1h** | "Vùng order block" = nến kích **dollar (quote) volume** mạnh (≥2x avg) + **delta (CVD) cùng hướng**. **Ưu tiên vùng FRESH** (chưa bị giá quay lại "mitigate"; `maxZoneMitigations`) — đây là vùng mạnh nhất theo lý thuyết SMC |
| 3a. ARM | **15m** | Giá **tap vào vùng FRESH** cùng hướng bias → ghi nhận setup chờ (chưa vào lệnh). Bot/backtest dùng **`SetupTracker`** |
| 3b. CONFIRM | **15m** | Sau ARM, chờ **≥ `minBarsAfterArm` nến** (mặc định **3** ≈ 45 phút) rồi mới xét vào lệnh. Trong lúc chờ: cập nhật đáy/đỉnh pullback; huỷ nếu **close** thủng vùng / bias đảo / quá **`setupExpiryBars`** (24 nến). CONFIRM = nến **fresh BOS** (phá swing 15m vừa xác nhận) + **volume** + **delta** cùng hướng |
| 4. SL/TP | — | SL dưới đáy pullback/vùng. (Tùy chọn `breakevenEnabled`, **mặc định TẮT** vì giảm EV.) Sau **`trailStartR` (2R)** → **trail theo swing 1h** (kéo SL vào vùng hỗ trợ thật) |

> **Entry 2 bước (`SetupTracker`)** là pipeline **duy nhất** cho bot live và backtest: tách "chạm vùng" (ARM)
> và "xác nhận BOS" (CONFIRM) qua nhiều nến. Hàm `evaluateEntry` trong cùng file là bản gộp 1 nến (legacy,
> không được gọi).
>
> **Lọc CONFIRM tùy chọn** (mặc định tắt trừ `minBarsAfterArm`): CLV (`confirmCloseLocationMin`), wick
> (`confirmRequireWickRejection`), trap body, `minEntryRR`, retest vùng, pullback tối thiểu theo R, anti-chase,
> invalidate theo wick, BOS chỉ swing sau ARM — sweep qua `scripts/confirm-quality-gate.ts` / `pullback-zone-gate.ts`.
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

### Kết quả tham chiếu — **NET (đã trừ chi phí)**, 250 ngày **BTC only** (15m entry)

Chi phí mô hình: taker 0.05% + slippage 0.02% mỗi chiều + funding 0.01%/8h. Pipeline: **`minBarsAfterArm: 3`**, **`trailStartR: 2`**, **`maxHoldBars` ~7 ngày**.

| Phạm vi | Số lệnh | Win rate | Gross R | Chi phí | **NET R** | Equity (risk 1%) |
|---------|---------|----------|---------|---------|-----------|------------------|
| **BTC** | 16 | 75% | +21.35R | -1.51R | **+19.83R** | +21.6% |
| **Rổ BTC+SOL+XRP+DOGE** (mặc định) | 46 | 63% | +49.04R | -4.25R | **+44.79R** | +55.3% |

Rổ 4 coin là **CONFIG mặc định** hiện tại: corr P&L giữa các coin ≈ 0 (dù corr giá ~0.84) vì chiến lược
flat ~71% thời gian + vào lệnh bất đồng bộ → **breadth thật ~3.3 bet độc lập**, Sharpe ngày **4.16** (vs
BTC-only 3.28). Đo bằng `scripts/symbol-correlation.ts` và `scripts/portfolio-basket.ts`.

Chạy lại sau mỗi đổi `CONFIG`:

```bash
npx ts-node backtest.ts 250 1 btcusdt 15m
./scripts/baseline-gate.sh 250 1 btcusdt 15m   # PASS nếu NET >= BASELINE_NET_R (mặc định 19.83R)
```

### So sánh đa coin — **Binance USDⓈ-M Perpetual** (250 ngày, cùng `CONFIG`)

Nguồn nến: **`https://fapi.binance.com/fapi/v1/klines`** (15m, có `quoteVolume` + `takerBuyVolume` cho delta) — khớp chart **Perpetual** trên TradingView (Binance USD-M).

```bash
npx ts-node scripts/cross-asset-baseline.ts 250
# hoặc tùy chọn symbol:
npx ts-node backtest.ts 250 1 btcusdt,ethusdt,solusdt,xrpusdt
```

| Symbol | Lệnh | WR (NET) | **NET R** | Nhận xét nhanh |
|--------|------|----------|-----------|----------------|
| **BTCUSDT** | 16 | 75% | **+19.83** | Core — tune baseline trên coin này |
| **SOLUSDT** | 11 | 64% | **+10.97** | Dương, ít lệnh hơn BTC |
| **XRPUSDT** | 8 | 63% | **+9.58** | Dương, mẫu nhỏ |
| **DOGEUSDT** | 11 | 45% | **+4.41** | Dương nhẹ |
| LINKUSDT | 11 | 36% | -0.45 | Gần hòa vốn |
| AVAXUSDT | 23 | 30% | -4.14 | Nhiều lệnh, WR thấp |
| BNBUSDT | 19 | 26% | -5.60 | Âm |
| **ETHUSDT** | 13 | 15% | **-7.32** | Âm mạnh — không dùng chung CONFIG BTC |

**Gộp 8 coin:** 112 lệnh, WR 42%, **NET +27.28R**, equity compounding +29.5%, max DD ~12.3%. Monte Carlo vs random **p ≈ 0.03**.

**Gộp chỉ coin NET dương (BTC+SOL+XRP+DOGE):** ~46 lệnh, **~+44.8R** (cộng R, không compounding chéo).

**Walk-forward (8 coin):** W1 +4.5R · W2 +20.3R · W3 +4.0R · **W4 −1.6R** (WR ~32%) — giai đoạn gần nhất yếu hơn.

> ⚠️ Cùng một `CONFIG` **không portable**: ETH/BNB/AVAX/LINK kéo tổng xuống nên **không** nằm trong rổ. Bot mặc định `CONFIG.symbols = ["btcusdt","solusdt","xrpusdt","dogeusdt"]` (4 coin NET dương); tránh thêm ETH cho đến khi có profile riêng.

### 5 cải tiến (A, B, C, D, F) — bật/tắt qua `CONFIG` trong `strategy.ts`

- **(A) Vùng FRESH** — `maxZoneMitigations` (0 = chỉ vùng chưa bị chạm; 1 = cho phép chạm 1 lần).
  Đã **bỏ** yêu cầu `reactivations>=1` cũ (vốn ngược lý thuyết SMC: vùng càng bị chạm càng yếu).
- **(B) Chi phí** — `CONFIG.costs` (`takerFeePct`, `slippagePct`, `fundingPer8hPct`). Backtest in **Gross / Chi phí / NET**.
- **(C) Volume** — `useQuoteVolume` (dollar volume), `useDelta` + `deltaBuyMin` (CVD xác nhận hướng), `useTimeOfDayRVOL` + `rvolLookbackDays` (chuẩn hoá theo giờ, mặc định tắt).
- **(D) Breakeven** — `breakevenEnabled` (mặc định **false**), `breakevenAtR`. A/B test BE vs no-BE.
- **(F) Validation** — `CONFIG.symbols` (đa coin) + backtest tự in walk-forward, bootstrap CI, Monte Carlo p-value.
- **Entry pipeline** — `minBarsAfterArm`, `setupExpiryBars`, `zoneInvalidationPct`, và các flag CONFIRM (xem `CONFIG` trong `strategy.ts`).

```bash
npx ts-node backtest.ts 250 1                  # coin trong CONFIG.symbols
npx ts-node backtest.ts 250 1 btcusdt          # chỉ BTC
npx ts-node backtest.ts 250 1 btcusdt,ethusdt  # chọn coin tùy ý

# Sweep thay đổi entry (chỉ merge CONFIG khi NET > baseline):
npx ts-node scripts/confirm-quality-gate.ts
npx ts-node scripts/pullback-zone-gate.ts
```

Sau **mỗi** thay đổi → chạy lại trên **nhiều coin + nhiều khoảng thời gian** và xem walk-forward/p-value để tránh overfit. Chỉ nâng baseline khi NET 250d BTC **cao hơn** pipeline trước (`baseline-gate.sh`).

---

## Hướng tiếp theo (ưu tiên)

1. **Đa coin sau đổi entry** — Đã chạy 8 perp (bảng trên). Tiếp: forward-test **SOL/XRP**; **không** thêm ETH/BNB vào bot cho đến khi tune riêng.
2. **BOS gắn pullback** — `bosSwingMinPivotAfterArm: true` đã sweep: **giảm NET** (~10R) — **không bật**. Có thể thử swing trong cửa sổ `[armedIndex, i]` thay vì min pivot.
3. **Chất lượng nến CONFIRM** — CLV / wick / `minEntryRR` đã có hook; sweep cho thấy thường **giảm** NET trên BTC — có thể hữu ích hơn trên alt hoặc kết hợp `minBarsAfterArm` cao hơn.
4. **Forward-test live** — So khớp ARM → CONFIRM trên chart với log bot; kiểm tra delta REST Futures có đủ field `takerBuyVolume` (`deltaStrict` nếu muốn fail-closed).
5. **Regime / W4** — Theo dõi walk-forward cửa sổ gần nhất; cân nhắc giảm size hoặc tắt symbol khi W4 âm kéo dài (chưa code — cần định nghĩa rule trước khi implement).

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

Bot prefetch lịch sử 15m cho **từng symbol** trong `CONFIG.symbols`, **poll REST Binance Futures**
mỗi ~12s, và khi nến 15m **đóng** sẽ đánh giá setup (ARM → CONFIRM giống backtest). Mỗi symbol chạy
độc lập (vùng/bias/vị thế/cooldown riêng). Có tín hiệu → **luôn** gửi alert kèm **Entry / SL / TP / lý do**:

```
🟢 MỞ LONG  SOL/USDT Perp

🎯 Entry : $167
🛑 SL    : $163  (2.30%)
🎯 TP    : $176  (5.40%, ~2.4R)

📐 Tap demand FRESH $164-166 (mitig 0) → pullback đáy $163
   → BOS phá $166 +vol 1.6x; HTF bull
🕐 14/06 15:30
```

### Lệnh Telegram
- **`/status`** (hoặc `/positions`) — bot trả về danh sách **đang giữ / đang chờ (ARM) / flat** trên mọi symbol,
  kèm R hiện tại và thời gian giữ. Bot chỉ trả lời đúng **Chat ID** đã cấu hình.

```
📊 Trạng thái bot — 4 symbol

🟢 LONG BTC/USDT
Entry $67,420 · SL $67,800 · TP $68,970
Hiện $68,100 (+1.1R) · giữ 1.2d

🟡 XRP/USDT — ARM CHỜ LONG (đã tap vùng, chờ BOS)
⚪ SOL/USDT — flat
⚪ DOGE/USDT — flat · cooldown
```

> Lưu ý: alert mặc định **không** dời SL về hoà vốn (breakeven tắt) — trail theo swing 1h sau **+2R** (`trailStartR`).

### Chạy 24/7 (VM Oracle, pm2)
```bash
npm install -g pm2
pm2 start "npx ts-node btc-alert-bot.ts" --name swing-bot
pm2 save
pm2 startup           # in ra lệnh để bot tự chạy lại sau reboot VM (copy & chạy theo hướng dẫn)
pm2 logs swing-bot    # xem log; pm2 restart swing-bot sau khi đổi CONFIG
```

---

## File

- `strategy.ts` — logic chiến lược dùng chung (`CONFIG`, `SetupTracker`, HTF zones)
- `backtest.ts` — engine backtest + báo cáo
- `btc-alert-bot.ts` — bot live đa-symbol (alert vào/ra lệnh + lệnh `/status`)
- `scripts/baseline-gate.sh` — so NET 250d BTC với baseline trước khi merge thay đổi strategy
- `scripts/confirm-quality-gate.ts`, `scripts/pullback-zone-gate.ts` — sweep filter CONFIRM / pullback
- `scripts/symbol-correlation.ts` — corr return ngày giữa symbol + đề xuất rổ NET dương
- `scripts/portfolio-basket.ts` — breadth thật (corr P&L) + backtest rổ như portfolio (Sharpe/maxDD)
