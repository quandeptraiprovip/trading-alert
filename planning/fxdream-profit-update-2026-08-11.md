# Cập nhật phương pháp FXDream theo mục tiêu lợi nhuận — 2026-08-11

## 1. Kết luận vận hành

Engine đã được source-align lại và thu hẹp thành **scanner ứng viên SFP**, không phải bản tự động hóa
toàn bộ phương pháp FXDream. Scanner **chưa được bật giao dịch hoặc alert thật**.

Đo lại 365 ngày cho thấy proxy mới âm ngay trước chi phí: `341` lệnh, gross `−25,5R`.
Train `−22,6R`, holdout `−2,9R`; không symbol nào dương trên toàn cửa sổ. Vì vậy không còn sleeve hay ngưỡng phí
nào được coi là đã xác thực. Hệ thống fail-closed bằng cờ `validatedForLiveAlerts = false`, kể cả khi
người dùng cấu hình phí bằng 0.

## 2. Bộ quy tắc đã đưa vào engine

### 2.1. Key Volume H1

- Tìm nến H1 có volume bất thường so với 96 nến trước, mặc định từ `2,0x` trở lên.
- Key candidate xuất hiện ngay khi chính nến volume H1 đóng; không cần phản ứng tương lai.
- Engine tạo **một Key trung tính**, không nhân đôi demand/supply. Daily bias + sweep/reclaim mới
  quyết định hướng; màu nến volume không quyết định hướng lệnh.
- Engine lưu `close` làm điểm đại diện và `low–high` làm range của nến spike. Backtest mặc định dùng
  điểm close; full-candle zone là geometry riêng. Vùng volume spike nhiều nến phải chỉnh thủ công.
- Không còn gắn cứng `H4 confluence = true`. Chưa chứng minh hợp lưu H4 thì ghi là chưa có.
- Key phải còn trong tuổi tối đa 180 ngày; phản ứng lịch sử là điểm cộng thủ công, không phải gate.

### 2.2. Daily Trap Gate theo video #31

Tín hiệu chỉ hợp lệ khi trả lời đủ ba câu hỏi:

1. Chuỗi nến Daily đang thiên về hướng nào?
2. Giá đã đóng cửa xuyên mức tham chiếu ngược hướng chưa?
3. Sau mức tham chiếu, thanh khoản đã bị rút/sweep nhưng chưa bị đóng xuyên chưa?

Thiếu dữ liệu Daily, bias trung tính hoặc đóng xuyên mức tham chiếu đều bị loại. Đây là gate bắt buộc, không phải điểm cộng tùy chọn.

### 2.3. Sweep, reclaim và nến xác nhận M15

- Long phải thật sự xuyên xuống dưới key rồi đóng lấy lại phía trên; short làm ngược lại.
- Chỉ chạm key không được tính là sweep.
- Sweep phải nằm trong chính cụm ba nến M15 xác nhận; không ghép pattern hiện tại với sweep cũ cách 20 nến.
- Bộ pattern gồm Engulfing đúng màu nến trước, Inside-bar breakout và 3-bar reversal. Pinbar đơn lẻ bị loại.
- Entry backtest dùng giá đóng xác nhận. Đây là **giá tham chiếu**, không phải actual OB và không phải khuyến nghị limit.
- Tín hiệu quá hai nến M15 kể từ lúc xác nhận bị bỏ.

### 2.4. Stop, target và quản lý lệnh

- Stop đặt ngoài râu sweep theo cấu trúc.
- Đã bỏ sàn stop `0,8%`; engine không được tự nới stop chỉ để tạo cảm giác an toàn.
- Không có cấu trúc đối diện H4 đúng hướng thì không có lệnh.
- Dùng **cấu trúc H4 đối diện gần nhất** và yêu cầu tối thiểu `1,5R`; không chọn swing xa nhất.
- Không còn target dự phòng, trần `15R`, chốt 30% tại 2R hoặc deadline follow-through sáu nến.
- Backtest dời SL về BE sau khi đã đạt 2R; tỷ lệ partial vẫn là quyết định thủ công theo hành vi giá.
- Nến M15 đóng xuyên key là invalidation định lượng. Invalidation cấu trúc/volume còn lại phải đánh giá thủ công.
- Signal chỉ được biết khi nến M15 đóng; cây 5 phút bắt đầu tại thời điểm đó được xử lý SL/TP ngay.
- Nếu nhiều Key cùng hợp lệ, chọn theo khoảng cách đến geometry, volume ratio rồi thời gian tạo Key,
  không dựa vào thứ tự mảng.

### 2.5. Gate chi phí

Ma sát khứ hồi được mô hình hóa bằng:

```text
maker fee + taker fee + slippage
```

Cấu hình ma sát vẫn là `0,02% + 0,05% + 0,02% = 0,09%`, nhưng gate hiện không còn phụ thuộc
chỉ vào so sánh phí. Do gross đã âm, `validatedForLiveAlerts = false` khiến scanner trả về rỗng trước
khi tải dữ liệu hoặc gửi Telegram ở **mọi mức phí**.

## 3. Kết quả định lượng

### 3.1. Đối chiếu 365 ngày — rổ symbol hiện có

Khoảng dữ liệu: `2025-08-11` đến `2026-08-11`.

| Biến thể | Số lệnh | WR | Gross R | Net R @0,14% | Net R @0,09% | Net R @0,02% |
|---|---:|---:|---:|---:|---:|---:|
| V7 source-aligned | 341 | 10,9% | -25,5R | -127R | -91R | -40R |

Thông tin rủi ro của V7:

- Median stop: `0,499%`.
- Max drawdown gross: khoảng `52R`.
- Bootstrap CI90 của mean gross R/trade: `[-0,190R; 0,096R]`.
- Xác suất bootstrap `gross > 0`: `24,4%`.

Mean gross âm và cả ba kịch bản chi phí đều âm. Không có cơ sở vận hành để promote scanner.

### 3.2. Chia đôi theo thời gian và theo symbol

Ngày chia: `2026-02-17`.

| Tập | Lệnh | WR | Gross R | Net @0,02% |
|---|---:|---:|---:|---:|
| Train | 180 | 8% | -22,6R | -29,8R |
| Holdout | 161 | 14% | -2,9R | -10,3R |

Gross theo symbol: BTC `−7,1R`, SOL `−5,4R`, XRP `−9,7R`, DOGE `−3,3R`. Không symbol nào dương
trên toàn cửa sổ hoặc ở cả train lẫn holdout. Kết quả XRP-only/1.095 ngày của
V7 cũ đã bị **supersede** vì entry, target, pattern và management đã thay đổi.

## 4. Những giả thuyết đã thử nhưng không đưa vào sản phẩm

- Lọc theo mức chi phí/độ rộng stop đơn giản không ổn định giữa train và holdout.
- Lọc riêng phiên Mỹ không lặp lại lợi thế ở holdout.
- Dùng toàn range high–low của nến volume làm vùng kích hoạt cho gross `−43,3R`, kém hơn điểm
  `close` (`−25,5R`). Vì vậy geometry được tách rõ thay vì trộn hai định nghĩa.
- Trail H1 (`−13,3R`) và sàn stop `0,8%` (`−14,5R`) làm kết quả bớt âm trong ablation, nhưng vẫn
  không tạo edge và không được bật vì mâu thuẫn với stop/invalidation nguồn và chỉ được thấy sau mẫu.
- Bỏ Daily gate cho gross `−30,7R` trên 3.193 lệnh nhưng net khoảng `−173R` ngay ở ma sát `0,02%`.
  Số lệnh tăng mạnh không tạo lợi thế vận hành.

Các bộ lọc trên không được thêm vào chỉ vì đẹp ở một lát dữ liệu. Đây là nguyên tắc chống overfit của bản cập nhật.

## 5. Điều kiện trước khi cho phép giao dịch thật

Chỉ xem xét mở gate khi đồng thời thỏa các điều kiện sau:

1. Đóng băng một model ID đầy đủ, gồm cả W1/H4, M5 actual OB/Volume Profile, macro và session có
   thể ghi nhận trước lệnh; không dùng riêng proxy hiện tại.
2. Feed dùng tạo Key Volume phải khớp với feed kiểm định. Không lấy volume Binance thay cho FX/CFD.
3. Chạy paper/forward test tuần tự tối thiểu 100 tín hiệu hợp lệ, không chỉnh luật giữa chừng.
4. Ghi cả ứng viên bị trader loại, setup được nhận, giá khớp thực, slippage và lý do thoát.
5. Cả train lẫn unseen holdout phải có gross/net expectancy dương; profit factor trên `1,15` và
   max drawdown nằm trong ngưỡng định trước.
6. Chỉ sau bước 5 mới đặt `validatedForLiveAlerts = true` cùng trần ma sát đo từ chính holdout.
7. Bắt đầu dưới `1%` risk/lệnh và giới hạn tổng risk của các vị thế tương quan.

Nếu chưa thỏa toàn bộ điều kiện thì giữ scanner fail-closed, không hạ chuẩn để ép hệ thống tạo lệnh.

## 6. Phạm vi kỳ vọng thực tế

Bản cập nhật này cải thiện các phần có thể kiểm soát:

- loại lookahead và sai khác giữa giá key được xác thực với giá key được giao dịch;
- buộc sweep/reclaim liền với bộ pattern nguồn;
- không tạo actual OB, target xa hoặc hợp lưu không tồn tại;
- sửa timestamp xác nhận và không bỏ qua 5 phút rủi ro đầu tiên sau entry;
- tách point/zone, Key trung tính và lựa chọn event ổn định;
- dừng alert khi chưa có edge holdout, thay vì chỉ hy vọng phí thấp cứu được gross âm.

Nó **không tạo ra lợi nhuận trong phép đo hiện tại**. Kết quả đánh tay còn phụ thuộc phần chưa mã hóa:
chọn model/key, W1/H4, M5 actual OB/Volume Profile, macro/session, feed, spread và kỹ năng quản trị.

## 7. File và lệnh tái kiểm tra

Các file chính:

- `fxdream-research/strategy-engine-v2.ts`: luật chiến lược đã sửa.
- `fxdream-alert.ts`: scanner, card Telegram và fail-closed.
- `fxdream-research/measure-live-path.ts`: đối chiếu legacy/V7 và self-check.
- `fxdream-research/validate-profit-gates.ts`: train/holdout theo mức chi phí.
- `test-fxdream-v2.ts`: test hồi quy cho các định nghĩa quan trọng.

Lệnh kiểm tra:

```bash
npm run test:fxdream
npm run test:key-volume
./node_modules/.bin/ts-node fxdream-research/measure-live-path.ts 365 --self-check
./node_modules/.bin/ts-node fxdream-research/analyze-r-tail.ts 365
./node_modules/.bin/ts-node fxdream-research/validate-profit-gates.ts 365
npm run alert:fxdream
```

Kỳ vọng của lệnh cuối với cấu hình mặc định hiện nay:

```text
FXDream fail-closed: chưa có cấu hình source-aligned dương trên holdout sau chi phí.
```

## 8. Quyết định hiện tại

- **Cho phép:** nghiên cứu và ghi paper candidate để thu thập lớp discretionary còn thiếu.
- **Chưa cho phép:** auto-entry hoặc tích hợp vào luồng live chính.
- **Ứng viên đã xác thực:** không có; XRP cũ đã bị supersede.
- **Bước tiếp theo:** đo chính quy tắc accept/reject của người đang đánh tay có lãi, theo model ID.
