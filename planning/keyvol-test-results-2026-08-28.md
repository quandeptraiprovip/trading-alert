# Kết quả kiểm thử Key Volume — 2026-08-28

Kế hoạch: `planning/keyvol-test-plan-2026-08-28.md`.

---

## CỬA 0 — NGƯỠNG ĐẬU (viết TRƯỚC khi chạy backtest đầu tiên)

Đại số: hoà vốn ⇔ `WR = (1+c)/(1+k)`; bước ngẫu nhiên `WR₀ = 1/(1+k)`; tỉ số = **(1+c)**, độc lập k.
c = phí khứ hồi / R. R lấy từ 6 lệnh tay của user (`trading-runtime/chart-playbook/btcusdt.json`).

| Công cụ | R trung vị | ×ATR(M15) | phí khứ hồi | **c** | WR hoà vốn @k=4,06 | mốc ngẫu nhiên |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSDT perp | 0,57% giá | 2,1× | 0,140% | **0,246 R** | **24,6%** | 19,8% |
| XAUUSD | 0,228% giá | 2,1× | 0,032% | **0,140 R** | 22,5% | 19,8% |

**Ngưỡng chốt, không sửa sau khi thấy số:**
1. **Cửa 2 (mệnh đề):** đậu ⇔ |phản ứng spike − phản ứng mức GIẢ| > **0,246 ATR** trên BTC.
   Null chỉ hợp lệ khi **biên phát hiện 95% < 0,05 ATR**; rộng hơn ⇒ "chưa đủ dữ liệu".
2. **Cửa 3 (rào):** đậu ⇔ **WR_key ≥ 1,246 × WR_ngẫu-nhiên** VÀ WR_key > WR_mức-GIẢ ngoài biên.
3. **Cửa 4 (pipeline):** đậu ⇔ **NET R dương sau phí thật** (không đọc gross), N ≥ 100 lệnh.
4. **Cửa 6:** đậu 3/3 pha nến M15; không năm/coin nào > 50% lợi nhuận.

**Điều kiện dừng:** cửa 2 null với biên < 0,05 ATR VÀ cửa 3 WR_key ≤ WR_giả ⇒ dừng, kết luận đúng
phạm vi "bản số hoá ở M15 không có edge trên BTC perp sau phí", KHÔNG suy sang vàng, KHÔNG suy sang
phương pháp tay.

*Ghi lúc: trước khi chạy script đầu tiên của đợt này.*

---

## CỬA 1 — ĐỐI CHIẾU 6 LỆNH TAY VỚI DETECTOR

Công cụ: `scripts/exp-keyvol-vs-manual.ts` · BTCUSDT, 72.000 nến 5m (2025-12-21 → 2026-08-28).

### (a) 6 kế hoạch tay chạy thật — KHÔNG đọc như thành tích

| # | chiều | vào lúc | R% | chờ khớp | thoát | giữ (h) | gộp R | NET R |
|---|---|---|---:|---:|---|---:|---:|---:|
| 2 | long | 10/06 09:00 | 3,44% | 0,3h | tp | 123,5 | +2,73 | +2,64 |
| 3 | long | 17/07 08:00 | 0,78% | 0,1h | tp | 79,8 | +5,55 | +5,26 |
| 1 | short | 27/07 21:45 | 0,61% | 0,1h | tp | 3,3 | +4,35 | +4,10 |
| 4 | short | 02/08 23:45 | 0,48% | 0,3h | tp | 8,4 | +3,77 | +3,46 |
| 0 | short | 10/08 07:15 | 0,45% | 0,3h | tp | 35,7 | +7,20 | +6,78 |
| 5 | long | 11/08 18:00 | 0,53% | 0,5h | tp | 18,1 | +2,96 | +2,66 |

n=6 · WR 100% · gộp +26,56R · **NET +24,90R (+4,15/lệnh)**.

**⚠ Con số này KHÔNG phải track record.** `createdAt` của cả 6 đều là **2026-08-15**, `status`
vẫn là `"planned"` — chúng được vẽ SAU sự kiện (cách entry từ 4 ngày tới 2 tháng), tức là ví dụ
minh hoạ chọn từ quá khứ. WR 100% chính là thứ mà minh hoạ hậu nghiệm luôn sinh ra.
Giá trị thật của 6 mức này là **NHÃN** (chỗ user coi là setup), không phải kết quả.

Điều chúng có nói: entry là mức CHỜ chứ không phải giá thị trường (5/6 nằm ngoài biên độ nến tại
mốc vẽ, lệch ≤0,47R), và cả 6 đều khớp trong 0,1–0,5h. Backtest đã tính đúng kiểu lệnh chờ: chờ
chạm mới khớp, nến khớp chỉ được tính STOP, chạm cả hai ⇒ STOP trước.

### (b) Detector có nhìn thấy chỗ user vẽ không — **KHÔNG**

| | production | bàn thử sạch |
|---|---|---|
| phễu (250d) | key 15m 5.162 · 1h 1.338 · 4h 283 · plan 597 · **vào lệnh 3** | … · **vào lệnh 133** |
| PLAN cùng chiều trong ±4h, ±0,3 ATR | **0/6** | **0/6** |
| TRADE cùng chiều trong ±4h | **0/6** | **0/6** |

**Biên phát hiện cho "0/6":** trong ±24h chỉ **2/6** ca có PLAN cùng chiều tồn tại, và cái gần nhất
lệch **0,85 ATR** (ngưỡng khớp 0,3). Nới dung sai gấp ba cũng chỉ được 1/6 ⇒ đây là TRƯỢT THẬT,
không phải do dung sai chặt.

**Tầng mức key thì "6/6" nhưng VÔ NGHĨA** — đối chứng giả 500 điểm (thời gian, giá) tuỳ ý cũng
đạt **100,0%**, trung vị 81 key trong ±0,3 ATR. Không có đối chứng này thì "6/6" đã bị đọc thành
"detector nhìn thấy đúng chỗ".

### (c) Mẫu số R — lệch thang

| | R trung vị code | R trung vị tay | lệch |
|---|---:|---:|---:|
| production | **0,006%** (n=3) | 0,606% | **96×** |
| bàn thử sạch | 0,399% (n=133) | 0,606% | 1,5× |

Production tái hiện lại đúng `keyvol-degenerate-stop-gate` với số còn nặng hơn trước (0,006% so với
0,017% ghi tháng 8): sàn minRR=3 CHỌN stop suy biến. Bàn thử sạch về đúng thang người.

## CỬA 1b — MẬT ĐỘ KEY: "có key gần đây" có phải phát biểu có nội dung không?

Công cụ: `scripts/exp-keyvol-density.ts`. Mốc người: user vẽ 6 mức trong 62 ngày = **1 mức/10,4 ngày**.

| spike× | key thô | key/ngày | GIẢ có key | GIẢ số key gần | USER có key | chênh |
|---:|---:|---:|---:|---:|---:|---:|
| 2 (đang chạy) | 5.161 | 20,64 | 100,0% | 81 | 100,0% | 0,0 |
| 4 | 1.863 | 7,45 | 100,0% | 35 | 100,0% | 0,0 |
| 6 | 843 | 3,37 | 100,0% | 18 | 100,0% | 0,0 |
| 8 | 438 | 1,75 | 98,4% | 11 | 100,0% | +1,6 |
| 10 | 256 | 1,02 | 98,0% | 7 | 100,0% | +2,0 |
| 12 | 157 | 0,63 | 83,6% | 4 | 83,3% | −0,3 |

Thêm định nghĩa CHẶT NHẤT repo từng đo (rời 1×ATR → quay lại chạm → bật 1×ATR trong 6 nến) — nó
loại ~51% key ở mọi ngưỡng:

| spike× | key chín | key/ngày | GIẢ có key | USER có key | chênh |
|---:|---:|---:|---:|---:|---:|
| 2 | 2.546 | 10,18 | 100,0% | 100,0% | 0,0 |
| 6 | 408 | 1,63 | 98,0% | 100,0% | +2,0 |
| 8 | 215 | 0,86 | 88,8% | 83,3% | −5,5 |
| 10 | 116 | 0,46 | 80,4% | 83,3% | +2,9 |
| **12** | **77** | **0,31** | **63,2%** | **83,3%** | **+20,1** |

**Đọc đúng:** ở n=6, mỗi ca đáng 16,7 điểm phần trăm ⇒ **không đọc được chênh nhỏ hơn ~33 điểm**.
Ô tốt nhất (+20,1) nằm TRONG nhiễu. Kết luận đúng phạm vi: **chưa đo được khác biệt nào** giữa chỗ
user vẽ và một điểm tuỳ ý, ở mọi định nghĩa key đã thử.

## PHÁN QUYẾT CỬA 1 — DỪNG THEO ĐÚNG ĐIỀU KIỆN ĐÃ CHỐT

Tiêu chí đã viết trước: *"Recall 0/6 ⇒ mọi backtest phía sau không nói gì về phương pháp user đang
trade; phải sửa detector trước khi chạy tiếp."* Điều kiện này **đã kích**.

Ba việc kèm theo, xếp theo giá trị:
1. **Cần thêm nhãn người.** n=6 chỉ phân giải được chênh ≥33 điểm; chênh đang thấy là 20. Cần
   **20–30 mức** (ước lượng từ chính phương sai này) mới kết luận được khâu Key có mang tin không.
   Đây là ràng buộc DỮ LIỆU, không phải ràng buộc mô hình — không quét tham số nào thay thế được.
2. **Cửa 2 chưa đo được ở cấu hình hiện tại.** Ngưỡng 2× phủ kín mặt phẳng giá (100% điểm tuỳ ý có
   key gần). Muốn cửa 2 có nghĩa thì key phải thưa tới mức đối chứng giả rời khỏi 100% — tức
   spike ≥ 10–12× kèm luật chín, chứ không phải 2×.
3. **Vá `buildEntryPlans` là cần nhưng không đủ.** Kể cả nối đúng `m15Levels`, tầng mức bên dưới
   vẫn chưa phân biệt được chỗ user vẽ với chỗ tuỳ ý.

---

## CỬA 2 — MỆNH ĐỀ Ở ĐÚNG CẤU HÌNH §11 (M15 + baseline cục bộ): **NULL 9/9 ô**

Công cụ: `scripts/exp-key-premise-m15.ts` · 8 coin × 38.401 nến 15m (400 ngày) · phản ứng = bước giá
12 nến sau cú chạm theo chiều BẬT LẠI, chuẩn hoá bằng ATR **tại cú chạm**.
Ba nhóm dựng bằng CÙNG một đoạn code: spike / normal (0,9–1,1×) / **syn** (mức GIẢ dời 0,7 ATR).

| spike× | bậc | n | spike | t | normal | syn | spike−syn | biên± | phán |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 2 | R0 | 30.232 | −0,0015 | −0,10 | −0,0142 | −0,0191 | +0,018 | ±0,059 | NULL |
| 2 | R4 | 14.357 | −0,0960 | −4,00 | −0,0560 | −0,0122 | −0,084 | ±0,091 | NULL |
| 2 | R5loc | 9.951 | −0,1461 | −4,85 | −0,1217 | −0,0419 | −0,104 | ±0,114 | NULL |
| 6 | R5loc | 2.030 | −0,2133 | −3,04 | −0,1217 | −0,0419 | −0,171 | ±0,193 | NULL |
| 12 | R0 | 1.227 | −0,2450 | −2,65 | −0,0142 | −0,0191 | −0,226 | ±0,210 | NULL |
| 12 | R5loc | 384 | −0,2713 | −1,52 | −0,1217 | −0,0419 | −0,229 | ±0,405 | NULL |

R0 = dùng ngay khi nến đóng (code production) · R4 = rời → chạm lại → BẬT RA (luật user) ·
R5loc = R4 + cú chạm kèm volume > trung bình **5 nến liền trước** (baseline cục bộ MỚI của §11).

**Phán quyết một phía:** NULL = cả khoảng tin cậy nằm DƯỚI ngưỡng +0,246 ATR ⇒ loại trừ được một cú
bật đủ lớn để giao dịch. Đúng 9/9 ô, kể cả ở ngưỡng thưa và định nghĩa chặt nhất.

**Dấu ÂM ở mọi ô:** giá **ĐI TIẾP QUA MỨC** chứ không bật lại — ngược hẳn mệnh đề. Nhưng nhóm
**syn (mức GIẢ) cũng âm** và nhóm normal cũng âm: ở ô mạnh nhất (2×/R5loc, t=−4,85) chênh spike so
với normal chỉ −0,024. ⇒ thứ đang đo là **quán tính giá**, không phải tính chất của "mức", đúng như
vòng H1 năm ngoái. Đây là ghi nhận thứ hai, độc lập, ở thang thời gian khác.

## CỬA 3 — CẤU TRÚC RÀO (first-passage): **RỚT 6/6 ô**

Công tụ: `scripts/exp-key-barrier-m15.ts`. Rào dựng đúng cấu hình TAY của user: R = 2,1×ATR(M15),
target 4R, chạm cả hai ⇒ STOP trước, trần giữ 7 ngày, phí 0,246 R/lệnh.
Mốc bước ngẫu nhiên tự chuẩn: WR = 1/(1+k) = **20,0%**, gộp R = 0.

| spike× | bậc | nhóm | n | WR | ±95% | gộp R | NET R |
|---:|---|---|---:|---:|---:|---:|---:|
| 2 | R0 | spike | 29.755 | 20,6% | ±0,5 | +0,022 | −0,224 |
| | | **random** | 29.760 | **20,8%** | ±0,5 | +0,034 | −0,212 |
| | | syn | 35.105 | 20,2% | ±0,4 | +0,006 | −0,240 |
| 2 | R4 | spike | 14.130 | 19,3% | ±0,7 | −0,042 | −0,288 |
| | | **random** | 14.136 | **20,6%** | ±0,7 | +0,028 | −0,218 |
| 12 | R0 | spike | 1.218 | **22,7%** | ±2,4 | +0,074 | −0,172 |
| | | **random** | 1.224 | 20,6% | ±2,3 | +0,027 | −0,219 |
| 12 | R4 | spike | 538 | 19,0% | ±3,3 | −0,064 | −0,310 |

**WR_key / WR_random = 0,889 … 1,105 ở cả 6 ô — cần ≥ 1,246.** Ô tốt nhất (12×/R0) đạt 1,105 và NET
vẫn −0,172 R/lệnh. Vào lệnh **NGẪU NHIÊN** đạt WR bằng hoặc hơn key ở 5/6 ô.

Kiểm tra tính đúng của bàn thử: mọi nhóm cho gộp R ≈ 0 và WR ≈ 20% — đúng bằng mốc bước ngẫu nhiên
lý thuyết. Một lỗi rào thường lệch xa mốc này, nên sự trùng khớp là dấu hiệu bàn thử chạy đúng.

---

## KẾT LUẬN ĐỢT 28/08 — đúng phạm vi, không nới

**Trả lời câu hỏi "Key Volume có chạy tốt không":** với BẢN SỐ HOÁ, trên crypto perp khung M15,
**KHÔNG** — và ba phép độc lập cùng chỉ một hướng:
1. Mệnh đề "giá bật tại mức volume đột biến" **null** ở cấu hình §11 (M15 + baseline cục bộ), loại
   trừ được mọi cú bật ≥ 0,246 ATR, ở cả 3 ngưỡng × 3 định nghĩa.
2. Hệ stop/target dựng đúng cấu hình tay **không thắng nổi vào lệnh ngẫu nhiên** cùng bộ máy thoát.
3. Cái "mức" mà code tạo ra **không phân biệt được** với một mức bịa (syn) hay một điểm giá tuỳ ý.

**KHÔNG được suy rộng thành ba điều sau** (mỗi điều đã có bằng chứng ngược hoặc chưa đo):
- ❌ *"Phương pháp tay của bạn không chạy"* — Cửa 1 cho thấy code và bạn **không trùng nhau** (0/6
  PLAN, biên phát hiện 0,85 ATR). Bác cái code không bác được cái bạn làm.
- ❌ *"Vàng cũng vậy"* — sàn chi phí vàng thấp hơn 1,8 lần; ngưỡng đậu là 1,140× chứ không phải
  1,246×. Chưa chạy. Ô 12×/R0 đạt 1,105 — vẫn rớt cả hai ngưỡng, nhưng khoảng cách khác hẳn.
- ❌ *"Hai model mới cũng vậy"* — `breakout-retest` và `ftr-bulltrap` không neo vào mức volume, ba
  phép trên không phủ chúng.

**Việc tiếp theo, xếp theo giá trị trên công bỏ ra:**
1. **Chạy lại Cửa 2+3 trên XAUUSD M15** (dữ liệu 2024 đã có sẵn trong `.cache/fx/XAUUSD_m5.json`).
   Ngưỡng 1,140×, và đây là thị trường chính của kênh. Rẻ: đổi nguồn dữ liệu, giữ nguyên hai script.
2. **20–30 nhãn tay** để đo được khâu Key có mang tin không (n=6 chỉ phân giải được chênh ≥33 điểm).
3. Model `breakout-retest` — rẻ nhất trong hai model mới, tái dùng BOS detector có sẵn.

---

## VÀNG — Cửa 2 & Cửa 3 trên XAUUSD M15 (2024, `.cache/fx/XAUUSD_m5.json`)

Ngưỡng vàng: |spike − syn| > **0,140** ATR · WR_key/WR_random ≥ **1,140** (phí 0,032%/R 0,228%).

**Phát hiện cấu trúc trước tiên:** tick volume vàng MƯỢT hơn hẳn volume crypto — ngưỡng 6× chỉ cho
**97** sự kiện/năm và 12× cho **4**. Ngưỡng calibrate trên crypto KHÔNG chuyển sang vàng được; phải
quét 1,5×/2×/3×.

### Cửa 2 (vàng): **thiếu n ở cả 9 ô** — 1 năm không đủ

| spike× | bậc | n | spike | syn | spike−syn | biên± | phán |
|---:|---|---:|---:|---:|---:|---:|---|
| 1,5 | R0 | 5.617 | −0,016 | −0,020 | +0,004 | ±0,176 | thiếu n |
| 2 | R0 | 3.060 | +0,031 | −0,020 | +0,051 | ±0,198 | thiếu n |
| 3 | R4 | 470 | +0,086 | +0,033 | +0,053 | ±0,494 | thiếu n |

Hiệu ứng đều gần 0, nhưng biên (±0,18 → ±0,49) vẫn cưỡi lên ngưỡng 0,140 ⇒ **chưa kết luận được**.
Muốn kết luận phải có thêm lịch sử M5 vàng (Dukascopy đã chặn 2022–23; đường còn lại là token OANDA).

### Cửa 3 (vàng): **RỚT 6/6** — và mức GIẢ ĐÁNH BẠI key thật

| spike× | bậc | nhóm | n | WR | ±95% | gộp R | NET R |
|---:|---|---|---:|---:|---:|---:|---:|
| 1,5 | R0 | spike | 5.474 | 20,2% | ±1,1 | +0,006 | −0,134 |
| | | random | 5.474 | 20,4% | ±1,1 | +0,018 | −0,122 |
| | | **syn (GIẢ)** | 2.982 | **21,7%** | ±1,5 | +0,079 | −0,061 |
| 1,5 | R4 | spike | 2.446 | 19,6% | ±1,6 | −0,020 | −0,160 |
| | | random | 2.446 | 21,5% | ±1,6 | +0,074 | −0,066 |
| | | **syn (GIẢ)** | 1.300 | **23,4%** | ±2,3 | +0,168 | **+0,028** |
| 2 | R4 | spike | 1.357 | 20,7% | ±2,2 | +0,035 | −0,105 |
| 3 | R4 | spike | 459 | 19,4% | ±3,6 | −0,031 | −0,171 |

WR_key/WR_random = **0,913 … 1,041**, cần ≥ 1,140. Cửa 3 có đủ lực (n 459–5.474, biên WR ±1,1–3,6
điểm) nên đây là RỚT thật, không phải thiếu dữ liệu như Cửa 2.

**Ô dương duy nhất của cả nghiên cứu là nhóm MỨC GIẢ** (vàng, 1,5×/R4, NET +0,028 R/lệnh). Mức GIẢ
đánh bại key thật ở cả 3 ngưỡng × 2 bậc. Đây chính là ca mà [[null-result-toolkit]] §3 dựng ra để
bắt: hình học "chờ giá quay lại một mức rồi vào theo chiều bật" có chút giá trị, nhưng phần
**VOLUME** không đóng góp gì — thậm chí làm xấu đi.

**Ghi nhận ĐỘC LẬP THỨ TƯ cùng hướng** (sau H1-crypto, H1-FX, và M15-crypto ở trên).
