# Đo scanner ứng viên FXDream trên 1 năm gần nhất

Ngày đo lại: 2026-08-11  
Cửa sổ dữ liệu: 2025-08-11 → 2026-08-11  
Thị trường: BTCUSDT, SOLUSDT, XRPUSDT, DOGEUSDT  
Nguồn giá/volume: Binance, nến gốc 5 phút

> **Kết quả này supersede hoàn toàn bản `+28,8R` trước đó.** Bản cũ dùng limit 30% trên nến bị
> gọi nhầm là OB, target H4 xa nhất, chốt 30% tại 2R, trần 15R, deadline sáu nến và bộ pattern khác
> nguồn. Không được tiếp tục dùng số cũ để quyết định giao dịch hoặc mở alert.

> Bản `251` lệnh/`−31,6R` ngay trước chỉnh sửa này cũng đã bị thay thế: nó còn yêu cầu phản ứng giá
> tương lai để một volume spike được coi là Key.

> Bản `296` lệnh/`−22,8R` sau đó cũng đã bị thay thế. Bản đó còn nhân đôi mỗi Key thành hai hướng,
> chưa tách điểm đại diện khỏi full-candle zone và tính MFE thuận lợi trong cùng nến đã chạm stop.

## Kết luận

Scanner source-aligned hiện tại **không tạo lợi nhuận** trong mẫu một năm:

- 816 tín hiệu detector, 341 kế hoạch/entry tham chiếu và 341 lệnh đã đóng.
- Win rate `10,9%`, gross `−25,5R`, gross expectancy `−0,075R/lệnh`.
- Net khoảng `−40R` tại ma sát 0,02%; `−91R` tại 0,09%; `−127R` tại 0,14%.
- Train `−22,6R`, holdout `−2,9R`; không symbol nào dương trên toàn cửa sổ.
- Bootstrap CI90 của mean gross R/trade là `[-0,190R; 0,096R]`; xác suất bootstrap gross dương
  `24,4%`.

Vì gross đã âm, giảm phí không thể cứu cấu hình này. `validatedForLiveAlerts` được đặt `false`, nên
scanner fail-closed ở mọi mức phí.

Kết luận này chỉ bác bỏ **proxy tự động H1/D1/M15 hiện tại**. Nó không bác bỏ việc người dùng đang
có lợi nhuận khi đánh tay, vì proxy chưa có phần tạo edge nhiều khả năng quan trọng nhất: chọn model
và key bằng mắt, W1/H4, M5 Volume Profile + actual OB/FTR/Breaker, macro, session, re-entry và quản
trị campaign.

## Luật đã đo

Đây là một scanner ứng viên SFP, không phải toàn bộ phương pháp FXDream:

1. Nến H1 có volume tối thiểu `2x` median 96 nến tạo **một Key trung tính** ngay khi đóng; không đợi
   phản ứng tương lai và không nhân đôi demand/supply. Engine lưu `close` làm điểm đại diện và
   `low–high` làm range; backtest mặc định dùng điểm close. Full-candle zone là geometry riêng, còn
   vùng volume spike nhiều nến vẫn phải chỉnh thủ công.
2. Daily Trap Gate `#31`: bias chuỗi nến, mức tham chiếu chưa bị đóng xuyên và thanh khoản đã sweep.
3. Sweep phải xuyên key và nằm trong chính cụm ba nến M15 xác nhận.
4. Pattern gồm Engulfing đúng màu nến trước, Inside-bar breakout hoặc 3-bar reversal; không dùng
   Pinbar đơn lẻ.
5. Entry backtest tại giá đóng xác nhận; đây không phải actual OB hoặc khuyến nghị đặt limit.
6. Stop ngoài sweep wick, không có sàn stop 0,8%.
7. Target là swing H4 đối diện gần nhất, tối thiểu 1,5R; không fallback và không có trần R.
8. Không chốt 30% cố định. Khi MFE đã đạt 2R, backtest chỉ dời SL về BE từ cây sau.
9. Nến M15 đóng xuyên key làm setup mất hiệu lực. Không có deadline follow-through cố định.
10. Một symbol chỉ giữ một vị thế tại một thời điểm; đây là giới hạn của phép đo, không phải luật nguồn.
11. Signal chỉ tồn tại tại close nến M15; cây 5 phút bắt đầu ngay sau close đó được quản lý SL/TP,
    không bị bỏ qua.

## Kết quả tổng

| Chỉ số | Kết quả |
|---|---:|
| Tín hiệu | 816 |
| Kế hoạch/entry tham chiếu | 341 |
| Lệnh hoàn chỉnh | 341 |
| Win rate | 10,9% |
| Gross R | −25,5R |
| Gross expectancy | −0,075R/lệnh |
| Stop trung vị | 0,499% |
| Max drawdown gross | khoảng 52R |
| R thực thu lớn nhất | 14,85R |
| MFE lớn nhất | 15,62R |

### Độ nhạy chi phí

| Ma sát khứ hồi | Net R | Net R/lệnh | Kết luận |
|---:|---:|---:|---|
| 0,020% | −40R | khoảng −0,117R | Âm |
| 0,090% | −91R | khoảng −0,267R | Âm |
| 0,140% | −127R | khoảng −0,372R | Âm |

Phí là mô hình gộp theo tỷ lệ giá. Funding, gap, độ trễ thủ công và slippage đột biến chưa được mô
phỏng đầy đủ; thêm các thành phần này không làm kết luận âm tốt hơn.

## Train/holdout

Ngày chia theo thời gian: 2026-02-17.

| Tập | Lệnh | WR | Gross | Net @0,02% | PF gross | Stop trung vị |
|---|---:|---:|---:|---:|---:|---:|
| Train | 180 | 8% | −22,6R | −29,8R | 0,72 | 0,554% |
| Holdout | 161 | 14% | −2,9R | −10,3R | 0,96 | 0,463% |

Cả hai nửa đều âm trước chi phí, nên không có edge bị che bởi phí.

## Theo symbol

| Symbol | Lệnh | Gross | Nhận xét |
|---|---:|---:|---|
| BTCUSDT | 61 | −7,1R | Train −6,8R, holdout −0,3R |
| SOLUSDT | 89 | −5,4R | Train −0,1R, holdout −5,3R |
| XRPUSDT | 93 | −9,7R | Train +2,6R, holdout −12,3R |
| DOGEUSDT | 98 | −3,3R | Train −18,3R, holdout +15,0R |

Không symbol nào dương trên toàn cửa sổ hoặc ở cả train lẫn holdout. Chọn riêng một lát dương sau
khi nhìn dữ liệu là selection bias.

## Phần đuôi R

| Ngưỡng | Lệnh từng đạt MFE | Tỷ lệ | Lệnh thực thu đạt ngưỡng | Tỷ lệ |
|---:|---:|---:|---:|---:|
| 1R | 106 | 31,1% | 37 | 10,9% |
| 2R | 45 | 13,2% | 23 | 6,8% |
| 3R | 21 | 6,2% | 12 | 3,5% |
| 5R | 10 | 2,9% | 6 | 1,8% |
| 10R | 2 | 0,6% | 2 | 0,6% |
| 15R | 1 | 0,3% | 0 | 0,0% |

MFE p50 là 0,51R; MFE p75/p90/p95/p99 lần lượt là `1,25R/2,17R/3,53R/6,95R`; MFE lớn nhất
`15,62R`. MFE được tính bảo thủ: nếu một nến chạm stop, cực trị thuận lợi trong chính nến đó không
được tính. Scanner mới chưa tái hiện được các lệnh 20R–30R trong
video. Khác biệt hợp lý nhất là người đánh tay vào ở actual OB/M5 với stop chính xác hơn, dùng
runner/re-entry/campaign và bỏ nhiều ứng viên kém bằng bối cảnh chưa mã hóa. Đây là giả thuyết cần
đo bằng nhật ký trước lệnh, không phải kết luận đã chứng minh.

## Kiểm tra đồng bộ

Self-check đã so detector backtest với `detectSFPSignalsV2` trên 768 nến M15 và có `0` sai khác.
Self-check này chỉ xác minh **danh sách signal**; nó không chứng minh execution/management trùng với
quyết định thủ công của kênh.

Regression test khóa các điểm sau:

- Inside-bar breakout được nhận; Pinbar đơn lẻ bị loại.
- Một nến volume spike tự tạo Key candidate, không cần phản ứng tương lai.
- Mỗi spike chỉ tạo một Key trung tính; point/range được lưu và dùng theo geometry đã chọn.
- Khi nhiều Key cùng tạo sự kiện, chọn theo khoảng cách, volume ratio rồi thời gian thay vì thứ tự mảng.
- Entry bằng giá đóng xác nhận, không phải 30% nến giả OB.
- Target dùng cấu trúc đối diện gần nhất.
- Nến đã chạm stop không được đồng thời đóng góp cực trị thuận lợi vào MFE.
- Timestamp xác nhận là close M15 và backtest không bỏ qua cây 5 phút đầu sau entry.
- Card ghi rõ “ứng viên”, không khuyến nghị limit và yêu cầu checklist thủ công.
- Chưa có holdout dương thì alert vẫn đóng ngay cả khi phí cấu hình bằng 0.

## Cách tiếp tục mà không overfit

1. Giữ scanner làm công cụ thu thập **candidate**, không coi output là lệnh.
2. Trước mỗi candidate, ghi model ID và quyết định accept/reject cùng W1/D1, H4, M5
   VP/actual OB, macro, session và spread.
3. So sánh net R của nhóm accepted với rejected trên dữ liệu tiến tới. Đây là phép đo trực tiếp xem
   discretion đang có lợi nhuận của người dùng bổ sung edge ở đâu.
4. Chỉ mã hóa một lớp thủ công khi định nghĩa của nó có thể ghi trước lệnh và test độc lập.
5. Không bật alert/live cho đến khi một cấu hình đóng băng dương ở cả train và unseen holdout sau
   đúng chi phí thực tế.

## Lệnh tái hiện

```bash
rtk npm run test:fxdream
rtk ./node_modules/.bin/ts-node fxdream-research/measure-live-path.ts 365 --self-check
rtk ./node_modules/.bin/ts-node fxdream-research/analyze-r-tail.ts 365
rtk ./node_modules/.bin/ts-node fxdream-research/validate-profit-gates.ts 365
```

Đây là nghiên cứu định lượng, không bảo đảm lợi nhuận và không thay thế quản trị rủi ro.
