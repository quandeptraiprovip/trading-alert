# Nghiên cứu chiến lược crypto độc lập — 2026-08-01

## Kết luận ngắn

Chưa tìm thấy chiến lược mới nào đủ bằng chứng để gọi là **“siêu có lãi”** hoặc nối vào bot live.
Ứng viên tốt nhất là **cross-sectional momentum market-neutral** trên 8 perpetual majors, nhưng chỉ đạt:

- `+72.1R` theo tổng leg-R đã scale qua 7 cohort;
- `+18.0R` theo risk của toàn basket (4 legs = 1 portfolio-R);
- equity `+19.2%`, max drawdown `8.8%` với tổng risk mục tiêu 1%;
- block-bootstrap 28 ngày: CI90 leg-R `[-50.2R, +199.4R]`, tương đương portfolio-R
  `[-12.6R, +49.9R]`; `P(NET>0)=82.5%`;
- năm 2026 đến thời điểm test: `-3.5R` leg-equivalent.

Đây là edge đáng **forward-test**, không phải edge đủ mạnh để trade tiền thật. Một family cấu trúc mới,
**random-maturity spot–perpetual carry**, tạo `+23.48 portfolio-R` trên development 2019–2023 nhưng gần
như biến mất hoàn toàn ngoài mẫu: validation 2024–2025 chỉ có 1 lệnh (`+0.03R`) và holdout 2026 không có
lệnh. Các family còn lại đều net âm rõ sau phí. Turtle hiện tại vẫn mạnh hơn rất nhiều và không bị thay
thế bởi nghiên cứu này.

## Khác gì với bot hiện tại?

Bot hiện có SMC/order-block, Key Volume, Turtle/Donchian breakout và Fast Trend. Ứng viên mới:

1. Không dự báo direction riêng từng coin.
2. Mỗi ngày xếp hạng **return tương đối** giữa các coin.
3. Long nhóm mạnh nhất và short nhóm yếu nhất cùng lúc, nên market beta gần trung tính theo notional/risk.
4. Không dùng order block, BOS, volume spike, delta gate, EMA filter hay Donchian breakout.
5. Giữ cố định 7 ngày; 7 cohort vào so le hằng ngày để loại phụ thuộc ngày rebalance.

Nó vẫn thuộc họ momentum rộng, nhưng là **cross-sectional/relative momentum**, khác với time-series
breakout của Turtle.

## Dữ liệu và giả định chung

- Binance USDⓈ-M Perpetual public market data.
- Phí taker `0.05%` + slippage `0.02%` mỗi chiều (`0.14%` round-trip).
- Momentum và quarter-hour dùng funding bảo thủ `0.01%/8h` như `CONFIG`; basis dùng funding lịch sử thực.
- Tín hiệu chỉ dùng nến/dữ liệu đã đóng; entry trễ 1 giờ với daily signal hoặc một bar với 5m signal.
- Nếu SL và đường giá khác cùng nằm trong một bar, backtest xử lý stop theo hướng bất lợi.
- Các cohort/trades chồng lấn không được xem là mẫu độc lập; CI dùng moving-block 28 ngày.
- Không thay đổi bot live hay baseline production.

## 1. Ứng viên tốt nhất: staggered cross-sectional momentum

### Luật

- Universe gốc: BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, DOT.
- Mỗi ngày 00:00 UTC, tính return trailing 14 ngày.
- Long top 2, short bottom 2.
- Entry 01:00 UTC; emergency stop `2 × ATR(24)` trên 1h; time-exit sau 7 ngày.
- Chạy 7 cohort lệch nhau một ngày; mỗi cohort dùng `1/7` risk để không chọn một weekday đẹp.

### Kết quả 2.000 ngày, 8 majors

| Cohort | Legs | WR | Gross R | Costs | Net leg-R | R/leg | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| All | 8,000 | 19.6% | +182.0 | -109.9 | **+72.1** | +0.063 | 8.8% |
| Long | 4,000 | 18.0% | +85.5 | -52.7 | +32.8 | +0.057 | 12.5% |
| Short | 4,000 | 21.2% | +96.5 | -57.2 | +39.3 | +0.069 | 9.7% |

`+72.1R` là tổng leg-R sau khi chia đều 7 phase. Vì mỗi cohort có 4 legs, con số tương đương theo
tổng risk basket là **`+18.0 portfolio-R`**, không phải `+72.1 portfolio-R`.

Ba era liên tục: `+17.2R / +15.7R / +39.2R`. Theo năm:

| Năm | Net leg-R |
|---|---:|
| 2021 | +1.6 |
| 2022 | +13.4 |
| 2023 | +31.1 |
| 2024 | +23.4 |
| 2025 | +6.1 |
| 2026 YTD | **-3.5** |

### Robustness quan trọng

- Lookback 7 ngày: `+74.3 leg-R` (`+18.6 portfolio-R`), DD `8.3%`, CI90 leg-R
  `[-35.3, +188.6]`, `P>0=85.6%`.
- Lookback 14 ngày: `+72.1 leg-R` (`+18.0 portfolio-R`), DD `8.8%`, CI90 leg-R
  `[-50.2, +199.4]`, `P>0=82.5%`.
- 7 phase rebalance riêng của lookback 7 ngày: `+156.0, +116.7, +208.8, +95.8, +127.2,
  -113.3, -71.3R`. Chọn một phase đẹp là overfit; portfolio bắt buộc phải stagger cả 7.
- Mở universe theo quy tắc cố định lên 16 coin làm edge yếu đi: net `+37.3 leg-R`
  (`+6.2 portfolio-R`), DD `14.3%`,
  CI90 `[-128.0, +211.7]`, `P>0=63.6%`; era đầu âm. Không được cherry-pick các coin thắng.

### Verdict

**Forward-test only.** Tổng net dương và horizon 7–14 ngày tạo plateau, nhưng CI vẫn cắt 0, broad-universe
không generalize, và 2026 YTD âm. Multiple-testing penalty còn làm độ tin cậy thấp hơn con số bootstrap.

Tái lập:

```bash
./node_modules/.bin/ts-node scripts/daily-relative-momentum.ts 2000 14 7 all major8
./node_modules/.bin/ts-node scripts/daily-relative-momentum.ts 2000 7 7 all major8
./node_modules/.bin/ts-node scripts/daily-relative-momentum.ts 2000 14 7 all broad16
```

## 2. Random-maturity spot–perpetual carry — lợi nhuận cũ cao, edge hiện tại đã decay

Đây là bản theory-motivated một chiều từ He, Manela, Ross & von Wachter: long spot và short perpetual khi
positive basis vượt toàn bộ chi phí round-trip; đóng khi basis trở về fair value. Protocol được khóa
trước khi chạy tại `planning/random-maturity-carry-protocol-2026-08.md`:

- đủ 5 coin của paper: BTC, ETH, BNB, DOGE, ADA; không chọn coin theo kết quả;
- 1h UTC; signal ở close, cả hai legs chỉ fill tại next open;
- cùng base quantity cho spot/perp; actual funding và mark price tại settlement;
- spot taker 10 bps + perp taker 5 bps + slippage 2 bps/leg, tổng basis cần vượt khoảng 38 bps;
- financing baseline 10% APR; không stop, không max-hold và không sweep threshold;
- P&L gồm bốn fee legs, bốn adverse-slippage legs, funding và financing;
- `1R = 1%` spot-leg notional chỉ là đơn vị chuẩn hóa, không được gọi là stop-defined R.

### Kết quả time-isolated

| Cửa sổ | Trades | Net portfolio | Portfolio-R | Sharpe | Max DD | Cost 1.5× | Bootstrap CI90 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Development 2019–2023 | 162 | **+26.37%** | **+23.48R** | 2.95 | 1.26% | +18.71% | [+9.09%, +51.54%] |
| Validation 2024–2025 | 1 | +0.03% | +0.03R | 0.26 | 0.04% | ~0.00% âm | [0.00%, +0.09%] |
| Holdout 2026-01-08 → 2026-07-31 | 0 | 0.00% | 0.00R | 0.00 | 0.00% | 0.00% | [0.00%, 0.00%] |

Development vẫn dương ở cost 2× (`+11.52%`, `+10.98R`) và không tập trung vào một coin (coin lớn nhất
chiếm 23.8% positive P&L). Tuy nhiên edge chỉ thực sự hoạt động trong 2020–2021; 2023, 2025 và holdout
2026 không có lệnh. Validation chỉ có một trade DOGE và 100% P&L nằm ở trade đó; tại cost 1.5× trade này
đã âm nhẹ. Đây là market-efficiency decay, không phải bằng chứng cho edge hiện tại.

Trong development, API funding cũ trả `markPrice=0`. Lỗi được phát hiện trước validation; implementation
dùng Binance mark-price kline tại đúng settlement hour làm fallback và đối soát tổng P&L trade khớp chuỗi
equity theo giờ. Funding ở cùng entry/exit hour bị loại để không giả định fill trước settlement.

### Verdict

**Loại khỏi live và không forward-test ở cấu hình retail taker.** Không hạ threshold, đổi sang maker giả
định, hoặc chỉ giữ DOGE để tạo thêm trades—các thay đổi đó đều dùng validation/holdout để fit. Kết quả này
giải thích vì sao Sharpe cao trong paper không còn chuyển thành cơ hội thực tế: basis lớn hơn retail cost
gần như không còn xuất hiện.

```bash
./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --self-test
./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=dev
./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=validation
./node_modules/.bin/ts-node scripts/random-maturity-carry.ts --phase=holdout --unseal-holdout=CONFIRM
```

## 3. Funding-tail reversal — loại

Giả thuyết: funding z-score cực đoan biểu hiện vị thế crowded; fade sau khi funding đã công bố.

- 1.200 ngày, 8 majors, 1,387 trades.
- Gross `-7.7R`, fee `-91.9R`, actual funding `+9.5R`, **net `-90.1R`**.
- Era: `+23.6R / -51.8R / -61.9R`.

Edge decay rõ và phí lớn hơn funding thu được. Không tối ưu threshold để “cứu” giả thuyết.

```bash
./node_modules/.bin/ts-node scripts/funding-tail-reversal.ts 1200 2 2 2 24
```

## 4. Cross-sectional perpetual basis — loại

Tái lập factor `B=(Spot-Futures)/Futures`: long perpetual discount, short perpetual premium, daily sort
trên 16 coin, actual funding.

- 12,000 trades.
- Gross `+296.9R`, fee `-970.2R`, funding `+11.0R`.
- **Net `-662.2R`**; ba era đều âm.
- CI90 `[-944.8R, -373.7R]`; `P(NET>0)=0%`.

Factor từng được công bố cho dated/quarterly futures không chuyển nguyên vẹn sang perpetual taker strategy.

```bash
./node_modules/.bin/ts-node scripts/cross-sectional-basis.ts 1200
```

## 5. Quarter-hour order-flow — proxy 5m bị loại

Paper dùng aggTrades 10 giây; repo chỉ có 5m taker-buy volume. Proxy dùng nến 5m mở đúng mốc 15 phút,
entry ở 5m kế tiếp, risk bằng `2σ` realized volatility 24h.

| Hold | Gross R | Costs | Net R |
|---|---:|---:|---:|
| 4h | +4.7 | -253.9 | **-249.2** |
| 8h | +20.1 | -140.4 | **-120.3** |
| 12h | -17.9 | -95.4 | **-113.3** |

Kết luận: predictability thống kê ở cửa sổ 10 giây không đồng nghĩa với taker strategy từ bar 5m có lãi.
Muốn nghiên cứu tiếp phải lấy aggTrades/tick data và mô hình maker execution; không được dùng proxy này live.

```bash
./node_modules/.bin/ts-node scripts/quarter-hour-order-flow.ts 400 4
./node_modules/.bin/ts-node scripts/quarter-hour-order-flow.ts 400 8
./node_modules/.bin/ts-node scripts/quarter-hour-order-flow.ts 400 12
```

## Tài liệu chính

- Liu, Tsyvinski & Wu, *Common Risk Factors in Cryptocurrency*:
  https://www.nber.org/papers/w25882
- Zaremba et al., *Up or down? Short-term reversal, momentum, and liquidity effects*:
  https://www.sciencedirect.com/science/article/pii/S1057521921002349
- Han, Kang & Ryu, *Momentum in the Cryptocurrency Market: A Comprehensive Analysis under Realistic Assumptions*:
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565
- He, Manela, Ross & von Wachter, *Fundamentals of Perpetual Futures*:
  https://arxiv.org/abs/2212.06888
- Chi et al., *An empirical investigation on risk factors in cryptocurrency futures*:
  https://www.repository.cam.ac.uk/items/3a556482-574b-42cd-af07-fe5c9f9db91c
- Kim & Hansen, *The Quarter-Hour Effect*:
  https://arxiv.org/abs/2607.09426
- Binance funding-rate history API:
  https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-history

## Đề xuất hành động

1. Không nối bất kỳ strategy mới nào vào live bot.
2. Forward-test `major8 / lookback 14d / hold 7d / all phases` trong ít nhất 6 tháng, ghi planned fill,
   actual fill, funding và net portfolio-R.
3. Gate tiếp tục nghiên cứu: forward net > 0, chi phí thực không vượt model, rolling 6 tháng không âm sâu,
   và correlation P&L với Turtle đủ thấp.
4. Nếu muốn nghiên cứu quarter-hour thật, thu thập aggTrades 10 giây + maker fill probability trước;
   backtest thêm trên nến không giải quyết được sai lệch dữ liệu.
