# Điểm yếu và các sửa đổi của scanner FXDream — 2026-08-11

## Kết luận ngắn

Các lỗi có thể sửa một cách khách quan đã được sửa trong code và khóa bằng regression test. Sau khi
đo lại BTC/SOL/XRP/DOGE từ `2025-08-11` đến `2026-08-11`, scanner tự động vẫn âm: `341` lệnh,
win rate `10,9%`, gross `−25,5R`. Vì vậy hệ thống tiếp tục **fail-closed** và không gửi tín hiệu live,
kể cả khi cấu hình phí bằng 0.

Kết quả này không phủ định việc đánh tay đang có lợi nhuận. Nó cho thấy phần tạo edge của người thực
thi nhiều khả năng nằm ở các quyết định chưa được mã hóa: chọn vùng volume nhiều nến, đọc W1/H4,
M5 Volume Profile và actual OB/FTR/Breaker, macro/session, loại setup và quản lý runner/re-entry.

## 1. Điểm yếu đã tìm thấy và đã sửa

| Điểm yếu cũ | Hậu quả | Sửa đổi hiện tại |
|---|---|---|
| Đòi phản ứng giá tương lai mới công nhận volume spike là Key | Lookahead; scanner chỉ “biết” Key sau khi kết quả đã xảy ra | Nến H1 đạt `volume ≥ 2x median 96 nến trước` tạo candidate ngay khi đóng |
| Nhân đôi một Key thành demand và supply | Tạo hai cơ hội giả từ cùng dữ liệu; hướng bị ngầm biết trước | Mỗi spike chỉ tạo **một Key trung tính**; Daily bias + sweep/reclaim mới quyết định long/short |
| Trộn “một nến volume lớn” với “toàn vùng nến” | Sweep, invalidation và khoảng cách Key thay đổi tùy cách hiểu | Lưu cả `price = close` và `zoneLow/zoneHigh`; cấu hình geometry tách rõ `representative-point` và `full-candle-zone` |
| Dùng thứ tự mảng để chọn Key khi nhiều sự kiện cùng hợp lệ | Kết quả phụ thuộc thứ tự tải dữ liệu, không phụ thuộc chất lượng ứng viên | Chọn sự kiện gần geometry nhất, sau đó volume ratio lớn hơn, rồi Key mới hơn |
| MFE lấy cực trị thuận lợi trong cùng nến đã chạm stop | Phóng đại đuôi R vì không biết high hay low xảy ra trước | Nếu nến chạm stop, bỏ cực trị thuận lợi của chính nến đó; quy ước SL-first bảo thủ |
| Ghi `confirmTime` bằng thời điểm mở nến M15 | Alert sớm hơn dữ liệu thật 15 phút và expiry sai | Timestamp xác nhận là thời điểm nến M15 đóng |
| Bỏ qua cây 5 phút đầu sau entry trong backtest | Không tính SL/TP/invalidation ngay sau khi tín hiệu được biết | Cây 5 phút bắt đầu tại close M15 được đưa qua engine quản lý ngay lập tức |
| Gọi 30% nến xác nhận là Order Block rồi giả lập limit | Giá entry đẹp nhưng không có bằng chứng đó là actual OB hoặc lệnh được khớp | Backtest dùng close nến xác nhận và card ghi rõ đây chỉ là entry tham chiếu |
| Chọn swing H4 xa nhất và đặt trần 15R | Tạo target đẹp tùy ý rồi cắt các case lớn không theo nguồn | Dùng cấu trúc đối diện H4 gần nhất đủ `1,5R`, không fallback và không trần R |
| Partial 30% ở 2R, deadline sáu nến được hard-code | Quản lý lệnh giả làm thay đổi expectancy | Bỏ hai luật không đủ nguồn; chỉ mô phỏng BE sau khi đã đạt 2R |
| Ghép pattern mới với sweep cũ | Pattern không còn xác nhận chính cú quét đang giao dịch | Sweep phải nằm trong cụm ba nến M15 xác nhận |
| Pinbar đơn lẻ và engulfing lỏng | Nhận quá nhiều mẫu không đúng định nghĩa đã đối chiếu | Chỉ giữ Engulfing đúng màu nến trước, Inside-bar breakout và 3-bar reversal |
| Alert có thể chạy khi chưa có edge | Biến nghiên cứu âm thành hành động tài chính | `validatedForLiveAlerts = false`; fail-closed trước cả bước tải dữ liệu/gửi Telegram |

## 2. Điểm yếu còn tồn tại, chưa nên “sửa” bằng phỏng đoán

### 2.1. Chọn Key vẫn chỉ là proxy

Yêu cầu tối thiểu của người dùng đã được khóa: chọn một vùng volume đột biến hoặc một nến volume
đột biến. Code hiện tự động hóa tốt trường hợp **một nến** và lấy close làm điểm đại diện. Nhưng vùng
volume gồm nhiều nến chưa có quy tắc khách quan về:

- nến bắt đầu và kết thúc vùng;
- dùng open/close, body, wick, HVN hay LVN làm biên;
- gộp hai spike gần nhau hay giữ tách biệt;
- khi nào vùng cũ hết hiệu lực ngoài giới hạn tuổi 180 ngày.

Không nên tự phát minh các luật này. Cần ghi lại vùng mà trader thực tế chọn **trước khi biết kết quả**,
sau đó mới tìm quy tắc có thể kiểm định.

### 2.2. Point hay full-candle zone chưa có xác nhận nguồn đủ chặt

Backtest mặc định dùng close của nến spike làm điểm đại diện. Dùng toàn range high–low cho `302`
lệnh và gross `−43,3R`, kém hơn point (`341` lệnh, `−25,5R`). Đây chỉ là bằng chứng rằng full range
không cải thiện proxy trên mẫu này; không chứng minh close là định nghĩa cuối cùng của FXDream.

### 2.3. Các lớp discretionary quan trọng chưa được mã hóa

- W1/D1 location và cấu trúc H4 cụ thể;
- M5 Volume Profile, actual OB/FTR/Breaker và chất lượng displacement;
- macro/news, session, spread và feed volume đúng venue;
- phân loại model, thuận/ngược cấu trúc và quyết định không trade;
- re-entry, add-on, partial và runner theo hành vi giá.

Scanner chỉ nên đưa ra **candidate** để người dùng accept/reject; chưa được gọi là bản sao đầy đủ của
phương pháp.

### 2.4. Các giả định định lượng chưa được xác thực độc lập

Ngưỡng `2x`, cửa sổ 96 nến, tuổi Key 180 ngày, execution ở close M15, một vị thế mỗi symbol và target
H4 gần nhất đều là cách đóng băng proxy để đo. Chúng không phải các hằng số đã được nguồn hoặc ledger
giao dịch chứng minh. Tối ưu chúng trên cùng một năm dữ liệu sẽ làm tăng nguy cơ curve-fit.

### 2.5. Volume và chi phí phụ thuộc venue

Phép đo dùng volume Binance crypto. Nó không đại diện cho tick volume Forex, futures tập trung hoặc
feed CFD mà người dùng có thể giao dịch. Funding, gap, độ trễ thủ công và slippage đột biến cũng chưa
được mô phỏng đầy đủ; các thiếu sót này thường làm net performance tệ hơn.

## 3. Đo lại sau sửa lỗi

| Chỉ số | Kết quả |
|---|---:|
| Detector signals | 816 |
| Lệnh hoàn chỉnh | 341 |
| Win rate | 10,9% |
| Gross R | −25,5R |
| Gross expectancy | −0,075R/lệnh |
| Net @0,02% | khoảng −40R |
| Net @0,09% | khoảng −91R |
| Net @0,14% | khoảng −127R |
| Gross max drawdown | khoảng 52R |
| Train / holdout gross | −22,6R / −2,9R |
| Bootstrap CI90 mean gross/trade | `[-0,190R; 0,096R]` |
| Bootstrap P(gross > 0) | 24,4% |

Theo symbol, BTC `−7,1R`, SOL `−5,4R`, XRP `−9,7R`, DOGE `−3,3R`. Không symbol nào dương trên
toàn cửa sổ hoặc đồng thời dương ở cả train và holdout.

Đuôi R vẫn tồn tại nhưng hiếm: 10/341 lệnh từng đạt MFE 5R, 2/341 đạt 10R, MFE lớn nhất `15,62R`
và R thực thu lớn nhất `14,85R`. Top 10 lệnh tạo `+68,6R`, bằng 55% tổng gross thắng; bỏ chúng đi,
gross còn `−94,1R`. Điều này xác nhận payoff lệch phải nhưng chưa tạo expectancy dương.

## 4. Những thay đổi trông tốt hơn nhưng cố ý không bật

- H1 trail cho gross `−13,3R`, tốt hơn `−25,5R` nhưng vẫn âm và được phát hiện sau khi xem mẫu.
- Sàn stop `0,8%` cho gross `−14,5R`, nhưng nới stop trái với nguyên tắc invalidation cấu trúc.
- Bỏ Daily gate cho gross `−30,7R` trên 3.193 lệnh, nhưng net khoảng `−173R` ngay ở ma sát 0,02%.
- Full-candle zone cho gross `−43,3R`, kém point close.

Không biến các ablation này thành luật live. H1 trail và stop floor chỉ đáng thử trong một protocol
forward-test đã đăng ký trước, không được dùng để sửa lại cùng tập dữ liệu.

## 5. Cách sửa phần còn thiếu mà không overfit

1. Giữ scanner fail-closed và lưu mọi candidate, kể cả candidate bị trader từ chối.
2. Trước lệnh, bắt buộc ghi: model ID, biên Key trader chọn, point hay zone, W1/D1, H4, M5
   VP/actual OB, macro, session, spread và lý do accept/reject.
3. Ghi giá khớp, stop cấu trúc, partial, re-entry/add-on và R của từng entry; không trộn R campaign
   với R của lệnh đầu.
4. Đóng băng form và luật trong tối thiểu 100 candidate liên tiếp. Không đổi threshold giữa chừng.
5. So sánh accepted và rejected trên dữ liệu tiến tới. Chỉ mã hóa một tiêu chí khi nó được ghi trước
   lệnh và cải thiện cả gross lẫn net trên holdout chưa nhìn thấy.
6. Chỉ mở alert/live khi một model cố định có expectancy dương ở cả train và holdout sau đúng chi phí
   thực tế, profit factor trên 1,15 và drawdown nằm trong giới hạn định trước.

## 6. Quyết định vận hành

- **Được dùng:** scanner candidate + checklist thủ công + nhật ký forward-test.
- **Chưa được dùng:** auto-entry, tín hiệu Telegram live hoặc chọn riêng symbol/gate sau khi xem kết quả.
- **Điểm cần nghiên cứu tiếp:** chính quy tắc accept/reject của người dùng đang giao dịch có lợi nhuận,
  đặc biệt là cách khoanh vùng Key và chọn actual entry M5.

Đây là nghiên cứu định lượng, không bảo đảm lợi nhuận và không thay thế quản trị rủi ro.
