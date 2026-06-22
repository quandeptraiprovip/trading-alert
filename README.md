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

> 🔬 **Nghiên cứu dấu chân nhà tạo lập, overfit & domain coin** — đã thử nhiều ý tưởng SMC/MM nâng cao, **không cái nào tăng NET bền** + đã audit overfit. Tóm tắt + cách tái lập ở mục **[Nghiên cứu đã làm & giới hạn](#nghiên-cứu-đã-làm--giới-hạn-overfit--domain-coin)** bên dưới. Đọc trước khi định thêm tính năng mới.

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

Chi phí mô hình: taker 0.05% + slippage 0.02% mỗi chiều + funding 0.01%/8h. Pipeline: **`minBarsAfterArm: 3`**, **`trailStartR: 2`**, **`maxHoldBars` ~10 ngày**.

| Phạm vi | Số lệnh | Win rate | Gross R | Chi phí | **NET R** | Equity (risk 1%) |
|---------|---------|----------|---------|---------|-----------|------------------|
| **BTC** | 15 | 80% | +22.96R | -1.46R | **+21.50R** | +23.6% |
| **Rổ BTC+SOL+XRP+DOGE** (mặc định) | 45 | 64% | +51.72R | -4.22R | **+47.51R** | +59.5% |

Rổ 4 coin là **CONFIG mặc định** hiện tại: corr P&L giữa các coin ≈ 0 (dù corr giá ~0.84) vì chiến lược
flat ~71% thời gian + vào lệnh bất đồng bộ → **breadth thật ~3.3 bet độc lập**, Sharpe ngày **4.16** (vs
BTC-only 3.28). Đo bằng `scripts/symbol-correlation.ts` và `scripts/portfolio-basket.ts`.

Chạy lại sau mỗi đổi `CONFIG`:

```bash
npx ts-node backtest.ts 250 1 btcusdt 15m
./scripts/baseline-gate.sh 250 1 btcusdt 15m   # PASS nếu NET >= BASELINE_NET_R (mặc định 21.50R)
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
| **BTCUSDT** | 15 | 80% | **+21.50** | Core — tune baseline trên coin này |
| **SOLUSDT** | 11 | 64% | **+10.97** | Dương, ít lệnh hơn BTC |
| **XRPUSDT** | 8 | 63% | **+9.58** | Dương, mẫu nhỏ |
| **DOGEUSDT** | 11 | 45% | **+5.46** | Dương nhẹ |
| LINKUSDT | 11 | 36% | -0.45 | Gần hòa vốn |
| AVAXUSDT | 23 | 30% | -4.14 | Nhiều lệnh, WR thấp |
| BNBUSDT | 19 | 26% | -5.60 | Âm |
| **ETHUSDT** | 13 | 15% | **-7.32** | Âm mạnh — không dùng chung CONFIG BTC |

**Gộp 8 coin:** 112 lệnh, WR 42%, **NET +27.28R**, equity compounding +29.5%, max DD ~12.3%. Monte Carlo vs random **p ≈ 0.03**.

**Gộp chỉ coin NET dương (BTC+SOL+XRP+DOGE):** ~45 lệnh, **~+47.5R** (cộng R, không compounding chéo).

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

## Nghiên cứu đã làm & giới hạn (overfit + domain coin)

Mục này ghi lại các hướng **đã thử nghiệm có hệ thống và KẾT LUẬN**, để không lặp lại. Quy tắc xuyên suốt: **chỉ nâng baseline khi NET vượt baseline hiện tại (+47.51R, rổ 4 coin, 250d) và sống sót OOS.**

### A. Dấu chân nhà tạo lập / SMC nâng cao — ĐÃ THỬ, ĐỀU KHÔNG TĂNG NET

| Ý tưởng | Cách test | Kết quả | Vì sao |
|---|---|---|---|
| Liquidity **sweep + reclaim** (gate ARM) | `scripts/liquidity-experiments.ts` | ❌ −25R | Lọc thêm → giảm lệnh > tăng chất |
| **Discount/Premium** (long nửa dưới range) | nt | ❌ −25R | nt |
| **Target = pool thanh khoản** đối diện | nt | ❌ −19R | Chốt non, mất đuôi lời |
| **FTR displacement-gate** (Kudakwashe) | `scripts/ftr-experiments.ts` | ❌ −37R (giết gần hết vùng) | Vùng có displacement R/lệnh CAO hơn nhưng quá ít lệnh |
| **FTB strict** (`maxZoneMitigations=0`) | nt | ❌ −8R | nt |
| **FVG / imbalance** làm nguồn vùng | `scripts/mm-experiments.ts` | ❌ −9…−38R | FVG nhiễu hơn order-block vol-spike |
| **Position-sizing theo volume-spike** | `scripts/mm-sizing.ts` | ⚠️ +5R in-sample, **gỡ** | corr feature↔R chỉ **+0.03** (nhiễu), không qua OOS |

**Bài học chung:** baseline đã **rất chọn lọc** (bias đa khung + vol-spike + delta + BOS). Chồng thêm filter lên hệ đã lọc kỹ → luôn **giảm lượng > tăng chất → NET giảm**. Dùng FVG làm nguồn vùng thì **thêm lượng nhưng thêm nhiễu**. Đòn bẩy duy nhất từng nhỉnh hơn (sizing) lại là **nhiễu** (không qua OOS) → đã gỡ.

### A2. Tham số EXIT (hướng ít thử hơn entry) — `scripts/exit-sweep.ts`, `scripts/maxhold-validate.ts`

Sweep phía thoát lệnh trên **rổ 4 coin** (gate +44.79R): targetRR, trailStartR, slBuffer, breakeven, cooldown, maxHold.

| Tham số | Kết quả | Ghi chú |
|---|---|---|
| targetRR (2.0–4.0) | ❌ đều ≤ baseline | Nới target xa → nhiều lần đảo trước TP |
| trailStartR (1.5/2.5/3.0) | ≈ ±0.1R | Trung tính, giữ 2.0 |
| slBuffer / breakeven / cooldown | ❌ giảm NET | BE giết DOGE/XRP (xác nhận lại mục D) |
| **`maxHoldBars` 7d → 10d** | ✅ **+2.72R** (rổ 250d) | **ĐÃ ÁP DỤNG** — xem dưới |

**`maxHoldBars` 7→10 ngày — ĐÃ NÂNG BASELINE** (cải tiến duy nhất qua được gate OOS):
- 250d rổ **+44.79 → +47.51R**; 500d rổ **+63.50 → +65.90R** — **10d là đỉnh trên CẢ 2 cửa sổ**.
- Plateau **trơn** 9–14d (không phải spike 1 điểm như `deltaBuyMin`); dương ở **cả nửa cũ & nửa mới**.
- Walk-forward 4 cửa sổ **đều dương** (W4 +14.61R, WR 80%); p-value <0.001; maxDD −4.2%.
- Bản chất: **nới ràng buộc thoát** (không phải thêm filter) → để winner swing chạy hết thay vì bị cắt non bởi time-exit. Hiệu ứng tập trung ở BTC (+1.7R) & DOGE (+1.1R); SOL/XRP không có lệnh chạm cửa sổ này.

### B. Audit overfit (`scripts/overfit-audit.ts`)

- **OOS thời gian** ✅ yếu: edge dương ở **cả 2 nửa** lịch sử (nửa cũ +18.7R, nửa mới +44.8R) — nhưng nửa cũ yếu hơn rõ (phụ thuộc regime).
- **OOS symbol** ⚠️: gộp 8 coin ngoài rổ → NET ≈ **+0R/lệnh**, 5/8 âm. Rổ được chọn **in-sample** → con số +44.8R **phóng đại** edge thật.
- **Độ nhạy tham số** ⚠️: không knob nào làm NET âm khi nhiễu, **trừ `deltaBuyMin`** (0.55 → +44.8R; **0.60 → ≈ 0R**, đứng sát vách).
- **Cấu trúc**: ~15 tham số entry fit trên **46 lệnh** → tỉ lệ quan sát/bậc-tự-do thấp.

### C. "Phương pháp chỉ hợp một số coin?" — ĐÚNG, là tính chất THẬT (`scripts/coin-fit.ts`)

Chia lịch sử 500d thành nửa cũ/mới, xét **nhất quán dấu** mỗi coin (9/12 coin nhất quán — nhiễu thuần sẽ ~50% lật):

| Nhóm | Coin |
|---|---|
| **GOOD** (dương cả 2 nửa) | **BTC, SOL, XRP, DOGE** (= rổ hiện tại) |
| **BAD** (âm cả 2 nửa) | BNB, ADA, AVAX, LINK, LTC |
| Nhiễu (lật dấu) | ETH, TRX, DOT |

→ Chiến lược **thật sự** ăn ở một lớp coin và **thật sự** thua lớp khác — không phải nhiễu mẫu nhỏ. Toàn rổ nằm trong nhóm GOOD ổn định.

### D. Đặc trưng phân biệt? Volume tách good/bad nhưng **KHÔNG vững OOS** (`scripts/coin-features.ts`, `liquidity-rule-validate.ts`)

- Trên 9 coin labeled: **chỉ volume$/ngày tách sạch** (good đều >$1.1B, bad đều <$650M); trending/volatility/beta **không** tách.
- Validate luật "volume >$700M → trade" trên **14 coin MỚI**: ❌ **không vững** — (1) không coin mới nào đạt ngưỡng → "high-vol" chỉ là vài majors đã biết; (2) trong nhóm volume thấp, coin **thanh khoản cao nhất (SUI) lại thua**, vài coin thấp nhất (SHIB/PEPE) lại thắng. Volume **không** là predictor liên tục. Tách-sạch-9-coin là **ảo giác mẫu nhỏ + confound "độ major"**.

### Kết luận thực dụng (domain)

1. **Baseline** — flat 1× risk, không sizing, entry logic gốc, `maxHoldBars` 10 ngày (+47.51R rổ 4 coin / 250d).
2. **Domain = chỉ majors thanh khoản cao nhất** (rổ `["btcusdt","solusdt","xrpusdt","dogeusdt"]`). Coi là **tập hẹp đã kiểm chứng**; **KHÔNG ngoại suy** sang đuôi dài altcoin (nhóm này OOS net âm).
3. **Không thêm tham số / filter mới** — đã chứng minh giảm NET. Cách giảm overfit thật sự **duy nhất** là **tích lũy thêm dữ liệu/lệnh theo thời gian**, rồi re-validate.
4. **Kỳ vọng forward thận trọng**: dùng cận dưới bootstrap (~+27R 90% CI) chứ không phải con số điểm; theo dõi `deltaBuyMin` (sát vách) và walk-forward cửa sổ gần nhất.

### Script nghiên cứu (đều fetch data, in NET so sánh; KHÔNG đổi baseline)

```bash
npx ts-node scripts/liquidity-experiments.ts 250   # sweep / discount / target-pool
npx ts-node scripts/ftr-experiments.ts 250         # FTR displacement / FTB strict
npx ts-node scripts/mm-experiments.ts 250          # FVG làm nguồn vùng
npx ts-node scripts/mm-sizing.ts 400               # position-sizing theo dấu chân MM
npx ts-node scripts/overfit-audit.ts 250 500       # OOS thời gian + symbol + độ nhạy param
npx ts-node scripts/coin-fit.ts 500                # nhất quán theo coin (good/bad/nhiễu)
npx ts-node scripts/coin-features.ts 500           # đặc trưng nào tách good/bad
npx ts-node scripts/liquidity-rule-validate.ts 500 700  # validate luật volume trên coin mới
```

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

**Độ bền live (khớp backtest dù mạng/restart):**
- **Bù nến nhỡ (gap replay)** — mỗi tick lấy MỌI nến đã đóng mới hơn lần xử lý cuối và replay **tuần tự**, không chỉ nến gần nhất. Mạng chập / 429 / downtime ngắn không còn làm bỏ sót exit/entry như backtest.
- **Giữ vị thế qua restart** — vị thế/cooldown lưu `bot-state.json` (atomic). pm2 restart / reboot VM khi đang giữ lệnh swing → bot **khôi phục** vị thế và **replay nến trong lúc tắt** để bắt SL/TP đã chạm (không quên báo exit).
- **Nhật ký lệnh** — mỗi entry/exit ghi `trades-live.jsonl` để đối chiếu live vs backtest.
- **Cảnh báo mất data** — không nhận nến mới > ~6 phút (vd fapi bị chặn 451) → bot gửi cảnh báo Telegram (bot **không** tự ngầm fallback sang spot để giữ đúng dữ liệu Perpetual).
- **Retry alert** — gửi Telegram entry/exit retry 3 lần (tránh mất alert do mạng chập chờn).

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

### Chạy 24/7 (VM Oracle, pm2) — bot + chart
Dùng `ecosystem.config.js` để chạy **cả bot alert và chart perpetual** cùng lúc:
```bash
npm install -g pm2
pm2 start ecosystem.config.js   # swing-bot + swing-chart
pm2 save
pm2 startup                     # copy & chạy lệnh in ra để tự bật lại sau reboot VM
pm2 logs                        # xem log cả 2; pm2 restart swing-bot sau khi đổi CONFIG
```

**Chart perpetual** phục vụ tại `http://<IP-VM>:3847` (nến **Binance Futures / fapi = perpetual**).
Trên Oracle Cloud cần mở cổng 3847 ở **2 nơi**:
```bash
# 1) VCN → Security List → Ingress: cho phép TCP 3847 từ 0.0.0.0/0 (hoặc IP của bạn)
# 2) Firewall OS trên VM (Oracle Linux/Ubuntu):
sudo iptables -I INPUT -p tcp --dport 3847 -j ACCEPT       # Oracle Linux
sudo netfilter-persistent save 2>/dev/null || true
# hoặc Ubuntu ufw:  sudo ufw allow 3847/tcp
```
> Kiểm tra chart đúng **perpetual**: `pm2 logs swing-chart` **không** có dòng `[Fetch] ... thử nguồn kế tiếp`
> (dòng đó nghĩa là fapi bị chặn 451 → fallback sang **spot mirror**, không còn là perpetual).

---

## File

- `strategy.ts` — logic chiến lược dùng chung (`CONFIG`, `SetupTracker`, HTF zones)
- `backtest.ts` — engine backtest + báo cáo
- `btc-alert-bot.ts` — bot live đa-symbol (alert vào/ra lệnh + lệnh `/status`); gap replay + khôi phục vị thế
- `live-state.ts` — persist vị thế qua restart (`bot-state.json`) + nhật ký lệnh (`trades-live.jsonl`)
- `scripts/baseline-gate.sh` — so NET 250d BTC với baseline trước khi merge thay đổi strategy
- `scripts/confirm-quality-gate.ts`, `scripts/pullback-zone-gate.ts` — sweep filter CONFIRM / pullback
- `scripts/exit-sweep.ts`, `scripts/maxhold-validate.ts` — sweep tham số EXIT/target + validate maxHold (OOS)
- `scripts/symbol-correlation.ts` — corr return ngày giữa symbol + đề xuất rổ NET dương
- `scripts/portfolio-basket.ts` — breadth thật (corr P&L) + backtest rổ như portfolio (Sharpe/maxDD)
