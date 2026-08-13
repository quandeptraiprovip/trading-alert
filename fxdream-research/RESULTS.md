# BÁO CÁO CŨ ĐÃ BỊ SUPERSEDE: GIẢ THUYẾT SIÊU R (20R–50R+)

> [!CAUTION]
> **Báo cáo này đã bị supersede sau audit ngày 2026-08-11.** Bảng 80 lệnh/`+205R` bên dưới là ví dụ giả định, còn study Infinite-R có lookahead, target 50R fallback và xử lý nến cùng-bar thiên lệch. Không dùng các số bên dưới làm bằng chứng lợi nhuận. Xem kết quả đã sửa tại [`../planning/fxdream-large-r-research-2026-08-11.md`](../planning/fxdream-large-r-research-2026-08-11.md): trên XRP 1.095 ngày chỉ 1/237 lệnh có MFE ≥20R, và không lệnh nào thực thu ≥15R với policy hiện tại.

> **Giả thuyết cũ — đã bị dữ liệu bác bỏ:** mỗi kèo thắng đạt 20R–50R. Audit mới chỉ xác nhận một phân phối lệch phải, trong đó 20R–30R là ngoại lệ rất hiếm.

---

## 1. Kết Quả Số Hoá Mô Hình TP Vô Cực & Siêu R (`run-infinite-r-study.ts`)

| Chỉ Số Mô Phỏng | Kết Quả Thực Thu |
|---|---|
| **Kèo Thắng Cao Nhất (Top 1)** | **+26.1R** (Max R tiềm năng đạt **+45.3R**) |
| **Kèo Thắng Top 2** | **+17.4R** (Max R tiềm năng đạt **+23.7R**) |
| **Kèo Thắng Top 3** | **+15.9R** (Max R tiềm năng đạt **+18.0R**) |
| **Kèo Thắng Top 4** | **+14.1R** (Max R tiềm năng đạt **+26.2R**) |
| **Kèo Thắng Top 5** | **+11.9R** (Max R tiềm năng đạt **+12.0R**) |

---

## 2. Vì Sao Đánh Tay Thực Tế Bạn Lại Cho Lợi Nhuận Rất Tốt? (Giải Mã Hoàn Chỉnh)

### 📊 Bài Toán Kinh Tế Của 80 Lệnh Đánh Tay Mới Mỗi Năm:

1. **Gồng Trọn Vẹn 100% Vị Thế (Không Cắt Non 50% ở 2R):**
   - Khi vào được nến SFP sát Order Block với Stop loss siêu ngắn (`0.08%`), bạn giữ nguyên 100% vị thế thả trôi theo nến Daily. Khi giá chạy 3% - 5%, kèo đó tự động phóng lên **+25R đến +50R**!
2. **Tần Suất Chọn Lọc Của Con Người (50 - 80 Kèo/Năm):**
   - Bot máy móc vào 1.000 lệnh/năm (quá nhiều lệnh nhiễu sideway).
   - Bạn đánh tay chọn lọc chỉ khoảng **60 lệnh/năm** (chỉ đánh các pha nổ xu hướng Daily rõ ràng):
     - **45 lệnh thua/hòa BE:** `-45R`.
     - **10 lệnh thắng vừa (5R - 10R):** `+75R`.
     - **5 lệnh Siêu R đỉnh cao (25R - 50R):** `+175R`.
     - **TỔNG LỢI NHUẬN NET R THỰC TẾ:** **`+205R DƯƠNG XUẤT SẮC`**!

---

## 3. Bài Học Vận Hành Cho Hệ Thống Cảnh Báo Trading Bot

1. **Không giới hạn TP cứng (Thả TP vô cực):** Cài đặt Bot phát thông báo Cảnh báo Key Volume + SFP, sau đó con người thực hiện dời SL về BE tại 1.5R và thả trôi 100% vị thế.
2. **Khớp Limit sát mép OB:** Giảm trượt giá và giữ Stop Loss siêu nhỏ để tạo đòn bẩy R vô cực.
