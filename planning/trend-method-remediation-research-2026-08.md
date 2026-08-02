# Turtle/Fast — nghiên cứu điểm yếu và hướng khắc phục (2026-08)

## Trạng thái quyết định

- **Đã áp dụng:** Fast SHORT dùng close-low 30 ngày, arm ở nến phá vỡ và chỉ entry khi nến 4h kế
  tiếp vẫn đóng dưới mức breakout đã đóng băng; Fast live mặc định shadow.
- **Giữ nguyên:** entry/exit/stop/pyramiding của Turtle. Các biến thể mới không cho thấy cải thiện
  đủ rộng và ổn định để biện minh cho thay đổi production.
- **Chưa áp dụng:** cooldown cho Fast, shared risk cap xuyên Binance–MEXC, Fast canary max một unit,
  và journal đầy đủ stop/fill/PnL thực. Đây là các action tiếp theo, không phải rule alpha đã xác nhận.

Kết luận không phải là “không làm gì”. Kết luận là **không tiếp tục thêm indicator hoặc chỉnh Turtle
theo chuỗi thua gần đây**; thay đổi entry Fast đã làm, còn các thay đổi tiếp theo nên nằm ở forward-test,
sizing/risk và observability.

## Phạm vi và giao thức

- Dữ liệu Binance Futures 4h của 8 symbol hiện tại: BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, DOT.
- Cửa sổ đánh giá: 1.050 ngày kết thúc 2026-08-01; mỗi symbol chạy liên tục rồi mới gán kết quả vào
  ba era lịch bằng nhau để tránh reset/censor ở biên era.
- Turtle dùng cost model Binance: 0,05% taker + 0,02% slippage mỗi chiều; Fast dùng 0,08% taker
  MEXC + 0,02% slippage mỗi chiều; cả hai tính funding drag 0,01% mỗi 8 giờ.
- Pyramid units có cùng exit được gom thành một vị thế phụ thuộc. MFE bảo thủ, bỏ nến exit vì không
  biết thứ tự intrabar giữa extreme và stop.
- Ứng viên được kiểm tra theo tổng kỳ, ba era, vùng tham số lân cận và paired bootstrap theo tuần.
- Sai lệch venue được kiểm tra thêm trên 180 ngày nến public MEXC transaction/fair-price cho 8 coin.

Các số liệu là backtest/diagnostic, không phải cam kết lợi nhuận. Nhiều biến thể đã được thử trên cùng
dữ liệu nên mọi “winner” đơn lẻ phải chịu selection bias; không promote nếu chỉ thắng tại một điểm
tham số hoặc CI paired vẫn bao gồm 0.

## Lệnh thua thực tế làm khởi phát audit

- MEXC: 8 vị thế thuộc Fast trong khoảng hai tuần, đều SHORT và đều thua; realised PnL tổng
  **-12,3896 USDT** (price PnL -11,7343; fee -0,6403; funding xấp xỉ -0,0149).
- Một vị thế BTC MEXC lỗ -10,9269 USDT không có `externalOid` thuộc Fast nên bị loại khỏi attribution.
- Binance/Turtle: các sequence đã hoàn tất khoảng **-1,1886 USDT trước funding**; SOL/DOGE còn mở
  lúc audit và đã được stop bảo vệ.
- Các loss tập trung vào 2–3 sự kiện thị trường, không phải các quan sát độc lập.
- Journal production cũ không có đủ `stop_move`, strategy version và actual realised PnL để forensic
  chính xác từng lần dời stop; vì vậy không được suy diễn quá mức từ replay.

## Turtle: điểm yếu và kết quả khắc phục

### Bản chất loss

Exact current Turtle trong cửa sổ 1.050 ngày:

- 528 vị thế / 1.268 unit; NET +1.045,5R; +1,98R/vị thế; maxDD 62,6R.
- Era A/B/C: +286,2R / +641,0R / +118,2R — cả ba dương nhưng era gần nhất yếu hơn rõ.
- 399/528 vị thế thua. Trong các loss: 49,4% có MFE <0,5R; 22,8% có MFE 0,5–1R;
  19,0% có MFE 1–2R; chỉ 8,8% từng đạt >=2R rồi trả lại.
- Ở era gần nhất, 80,9% loss chưa từng đạt 1R; MFE trung bình giảm từ khoảng 2,77R/3,45R ở hai
  era trước xuống khoảng 1,40R.
- Top 5 winner tạo 35,8% toàn bộ positive R; ở era gần nhất là 40,5%.

**Chẩn đoán:** điểm yếu chính là thiếu follow-through và phụ thuộc right tail, không phải trailing trả
lại quá nhiều lợi nhuận. Trend-following phải trả nhiều loss nhỏ để giữ quyền sở hữu vài trend lớn.

### Biến thể đã kiểm tra

| Biến thể | Kết quả chính | Quyết định |
|---|---:|---|
| Current hybrid: long close/mid, short close-30d/Chandelier | +1.045,5R; ba era dương | Giữ |
| Long đổi sang Chandelier | +406,7R | Loại |
| Short đổi sang midpoint | +877,7R; cả ba era kém current | Loại |
| Fixed 3ATR initial stop thay structural OB | Kém structural stop ở cả ba era trong audit trước | Loại |
| Chandelier 2,5ATR | +1.069,1R, DD thấp hơn nhưng Era C chỉ +51,4R vs +118,2R | Loại |
| Chandelier 3,5–4ATR | NET thấp hơn, DD cao hơn | Loại |
| Cooldown 1–2 ngày | Tổng delta chỉ +4,6R/+8,9R; cooldown 2d CI90 tuần [-0,152; +0,264]R | Không đủ bằng chứng |
| Cooldown 3–5 ngày | Bỏ quá nhiều trend, NET giảm mạnh | Loại |
| Pyramid step 0,75–1,5ATR | DD giảm nhưng NET giảm gần đơn điệu | Chỉ là trade-off risk |
| Max 1/2/3 unit | Giảm NET và DD gần tương ứng; mỗi unit index vẫn dương cả ba era | Không sửa core |
| Max hold 30 ngày | +1.204,4R nhưng 25/30/35/40d = +1.104/+1.204/+1.086/+1.046R; không giúp Era C | Đỉnh hẹp, loại vì overfit |
| BTC gate chặt hơn / two-sided gate / bỏ gate | Không cải thiện đồng đều; two-sided làm Era C âm trong audit trước | Loại |

## Fast: điểm yếu và kết quả khắc phục

### Bản chất loss

Exact paper mirror của rule Fast hiện tại (long high-10d; short close-30d + một nến xác nhận):

- 562 vị thế / 1.352 unit; NET +243,7R; +0,43R/vị thế; maxDD 66,1R.
- Era A/B/C: +12,8R / +132,9R / +98,0R. Era A dương rất mỏng, nên edge yếu hơn Turtle.
- 416/562 vị thế thua. Trong các loss: 55,3% có MFE <0,5R; 25,5% có MFE 0,5–1R;
  18,8% có MFE 1–2R; chỉ 0,5% từng đạt >=2R rồi trả lại.
- Ở era gần nhất, 85,6% loss chưa từng đạt 1R và không có loss nào từng đạt >=2R.

**Chẩn đoán:** Fast thua vì breakout không follow-through. Breakeven sớm, take-profit gần hoặc trailing
chặt hơn không đánh đúng bệnh và có nguy cơ cắt winner.

### Biến thể đã kiểm tra

| Biến thể | NET / maxDD hoặc nhận xét | Quyết định |
|---|---:|---|
| Không chờ xác nhận SHORT | +246,7R / 76,9R | Nhiều lệnh và DD hơn |
| Chờ đúng 1 nến 4h | +243,7R / 66,1R | Giữ: gần như giữ NET, giảm DD |
| Chờ 2 nến 4h | +188,6R / 70,3R | Quá chậm, loại |
| Short close 25/30/35/40d | NET xấp xỉ +235 đến +244R; cả ba era dương | Plateau; 30d hợp lệ |
| Structural OB initial stop (audit gần-current, chưa có confirm) | +290,7R nhưng Era A -3,9R và DD 85,8R | Loại |
| Cooldown 1–3 ngày sau mọi exit | NET +238 đến +251R; DD 49,8–60,8R | Candidate risk-only |
| Cooldown 3 ngày chỉ sau loss | +247,2R / DD 48,7R; CI90 delta tuần [-0,335; +0,319]R | Chưa đủ bằng chứng alpha |
| Cooldown 5 ngày | Era A âm | Loại |
| Pyramid step 0,75/1/1,5ATR | +227,6/+196,2/+179,0R; DD giảm theo | Trade-off risk, không thêm edge |
| Max 1/2/3/4 unit | +85,1/+162,2/+210,7/+243,7R; DD 25,5/43,4/55,7/66,1R | Dùng max1 cho canary, không gọi là alpha fix |
| Chandelier 2,5/3,5/4ATR | Không biến thể nào tăng NET và giảm DD ổn định cả ba era | Loại |
| Max hold 30–90 ngày | Không khác current vì Fast exit sớm hơn | Không liên quan |

Cooldown 1–3 ngày làm DD đẹp hơn nhưng paired CI đều chứa 0. Nếu thử tiếp, phải đăng ký trước một
giá trị đơn giản (ưu tiên 24h sau loss) và chạy shadow; không được chọn lại thời gian sau khi xem live.

## Hai sleeve có thực sự đa dạng hóa không?

- 87,2% vị thế Fast xuất hiện khi Turtle đang giữ cùng symbol và cùng hướng.
- Tỷ lệ này là 93,8% trong 365 ngày và 96,1% trong 180 ngày gần nhất.
- Correlation PnL tuần Turtle/Fast: 0,98 trong 365 ngày, 0,99 trong 180 ngày và 1,00 trong 90 ngày.
- Fast không overlap cùng symbol/hướng chỉ có 72 vị thế trong 1.050 ngày và tổng NET -37,2R; đây là
  diagnostic attribution, **không** được biến thành rule “chỉ trade khi overlap”.

**Chẩn đoán:** Fast hiện giống một lớp tăng exposure cho Turtle hơn là nguồn alpha độc lập. Hai account
cap riêng không tạo ra một economic portfolio cap chung.

Mô phỏng unit-equivalent 0,5% risk/unit cho thấy peak cùng hướng từng đạt 62 unit long và 64 unit short
(31–32% nominal risk). Giới hạn 8 unit/cùng hướng làm modeled DD giảm từ 41,4% xuống 19,3% và worst
week từ -9,7% xuống -4,9%, nhưng cũng bỏ nhiều lợi nhuận. Đây là policy risk, không phải free alpha;
production phải tính USD risk trên tổng equity hai sàn thay vì đếm unit nếu balance hai account khác nhau.

## Binance signal / MEXC execution

Trên 54 vị thế Fast align được trong 180 ngày public data:

- Không có venue-only stop touch nào theo transaction path hoặc fair-price path.
- Adverse divergence p95: 0,099ATR theo transaction price và 0,055ATR theo fair price.
- Không có fair-price divergence >0,10ATR; transaction path có 3/54 vị thế >0,10ATR và không có
  vị thế nào >0,25ATR.

**Quyết định:** chưa có bằng chứng để chuyển signal engine sang MEXC hoặc thêm basis buffer. Vấn đề
production thật là thiếu log từng stop move/trigger source/fill, không phải fixed venue scale trong mẫu này.

## Action đã chấp nhận và action còn chờ

### Đã làm

1. Fast SHORT close-low 30d + một nến 4h persistence confirmation.
2. Fast trading mặc định shadow: `FAST_TREND_TRADING_ENABLED=false`.
3. Test cho arm/persist/confirm/cancel/missing-bar và các guard EMA/gate.

### Nên làm tiếp, nhưng chưa triển khai trong vòng nghiên cứu này

1. **Observability:** journal `stop_move` gồm signal old/new, venue old/new, read-back, trigger source,
   strategy version/git hash, protection/order id; exit ghi actual fill, fee, funding và realised PnL.
2. **Forward gate:** ít nhất 14 ngày và 20 setup đã đóng; so paper signal với actual MEXC sau phí.
3. **Canary:** khi đủ gate, Fast live tối đa một unit trước khi xét max2/max4.
4. **Shared risk manager:** cap theo underlying và cùng hướng trên tổng equity Binance+MEXC; Turtle
   core được ưu tiên, Fast chỉ dùng capacity còn lại.
5. **Shadow candidate duy nhất:** cooldown 24h sau Fast loss. Không bật live nếu chưa có forward evidence.

## Tài liệu phương pháp

- Hurst, Ooi, Pedersen, *A Century of Evidence on Trend-Following Investing*:
  https://doi.org/10.3905/jpm.2017.44.1.015
- Grebenkov, Serror, *Optimal Allocation of Trend Following Strategies*:
  https://arxiv.org/abs/1410.8409
- Bailey, López de Prado, *The Deflated Sharpe Ratio*:
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- MEXC Contract API:
  https://mexcdevelop.github.io/apidocs/contract_v1_en/

## Kết luận cuối

- **Turtle:** có edge lịch sử rõ, cấu trúc hiện tại hợp lý; không sửa rule vì chuỗi thua hai tuần.
- **Fast:** edge mỏng hơn và gần đây gần như trùng exposure với Turtle; giữ shadow và confirmation một
  nến, chưa đủ điều kiện chạy full-risk/pyramid live.
- **Không theo hướng overfit:** không thêm ADX/ER/volume/retest/breakeven/time-stop chỉ vì chúng lọc
  được vài loss gần đây. Chỉ promote thay đổi khi có cơ chế, plateau, nhiều era, chi phí thật và forward data.
