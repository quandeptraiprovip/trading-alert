# Áp phương pháp FX Dream (Key + Volume) lên cặp tiền và vàng — 13/08/2026

**Câu hỏi:** "hãy áp dụng phương pháp fx dream vào thử xem".

**Kết luận: LOẠI.** Không phải vì chi phí, không phải vì thang thời gian, không phải vì tham số.
Điều kiện SINH RA Key — "giá phản ứng tại mức có volume đột biến" — **không đo được ở FX**, và
phép đo tương tự **cũng không thấy nó ở crypto**. Đây là kết quả đáng chú ý nhất của vòng này và
nó vượt ra ngoài câu hỏi FX.

Code: `fx/fx-dream.ts` (thang dịch), `fx/fetch-dukascopy-m5.py` + `fx/fx-dream-native.ts` (thang
gốc 5m), `fx/fx-dream-placebo.ts` (đo thẳng viên gạch đầu tiên).

---

## 1. Thang dịch một bậc — 22 năm × 13 công cụ

Nền 1h / xác nhận 4h / key 1d / hợp lưu 1w. Mọi tham số khác giữ nguyên (zero-tuning).

| rổ (minRR=0) | lệnh | WR% | gộp R | phí R | NET R | exp/lệnh |
|---|---|---|---|---|---|---|
| vàng+bạc | 141 | 23 | −6,3 | 26,1 | −32,4 | −0,230 |
| 7 major | 374 | 44 | −8,1 | 24,8 | −33,0 | −0,088 |
| 4 cross | 235 | 40 | −5,7 | 17,1 | −22,9 | −0,097 |
| **TẤT CẢ 13** | **750** | **39** | **−20,1** | **68,1** | **−88,2** | **−0,118** |

**GỘP đã âm trước khi trừ phí.** Không có tín hiệu để chi phí giết; không broker/spread nào cứu
được. Từng công cụ: 10/13 âm ở cột gộp; ba cái dương (USDJPY +7,5R, AUDJPY +3,2R, AUDUSD +2,8R)
đều nhỏ hơn phí của chính chúng.

**Cấu hình production (minRR=3) tái hiện đúng nợ kỹ thuật đã ghi nhận:** chỉ 3 lệnh vàng+bạc, gộp
−3,0R nhưng **phí 227,7R**. minRR=3 chọn ra những stop suy biến nhỏ đến mức chi phí quy theo R nổ
tung. Đây là bằng chứng thứ hai, độc lập, cho `keyvol-degenerate-stop-gate`.

## 2. Thang GỐC 5m — khép phản bác "dịch thang đã phá thứ đang đo"

Tải nến 1m Dukascopy theo ngày rồi gộp 5m (`fetch-dukascopy-m5.py`), chạy `KEY_VOLUME_CONFIG`
**không sửa một chữ**. Vàng, năm 2024, 71.193 nến:

```
spread 0,0158% · biên độ nến 5m 0,0690% · spread/biên độ 23%
production (minRR=3)     3 lệnh              gộp  −3,0R   phí  20,4R   ròng −23,4R
bỏ minRR               155 lệnh   WR 22%     gộp  +2,0R   phí  43,3R   ròng −41,3R
   phễu: key 1h 789 · key 4h 234 · chạm hợp lưu 6.203 · volume xác nhận 1.854
        · sweep 492 · mô hình nến 434 · vào lệnh 155
bỏ minRR + BOS trigger 114 lệnh   WR 17%     gộp  −8,1R   phí  23,8R   ròng −32,0R
```

Phễu **hoạt động bình thường** — không phải trường hợp "không có tín hiệu nào sinh ra". Nhưng
gộp chỉ **+0,0132R/lệnh** trong khi phí là **0,27R/lệnh**, tức chênh 20 lần. Đúng bằng tỉ lệ
spread/biên độ 23% đã ước lượng trước khi chạy.

*Giới hạn còn lại (ĐÃ CHỐT 14/08):* phần thang gốc **chỉ có một năm vàng (2024)** và sẽ ở nguyên như
vậy. Hai lần tải thêm 2022–2023 đều **THẤT BẠI 625/625 ngày** — Dukascopy chặn, kể cả khi hạ xuống 3
luồng. Guard trong `fx/fetch-dukascopy-m5.py` từ chối ghi file thiếu (đúng thiết kế: dữ liệu khuyết
âm thầm từng làm sai trọn một kết luận). Cache chỉ có `XAUUSD_m5.json` = calendar-2024.

Điều này **không** để lại lỗ hổng, vì §3 bác bỏ mệnh đề Key ở mức CƠ CHẾ trên 22 năm × 13 công cụ
(cộng đối chứng crypto) và **không phụ thuộc thang thời gian**. Ai muốn mở rộng phần 5m sau này thì
phải giải bài toán chặn của Dukascopy trước — đừng giả định chạy lại script là xong.

## 3. PHÉP QUYẾT ĐỊNH — đo thẳng viên gạch đầu tiên

Hai phép trên chạy TOÀN BỘ cỗ máy (key → hợp lưu → volume lần hai → sweep → mô hình nến →
stop/target). Khi cả cỗ máy ra số âm, ta không biết khâu nào hỏng và luôn còn chỗ để đổ cho tham
số. `fx-dream-placebo.ts` bỏ hết cỗ máy và hỏi đúng một câu:

> Mức giá sinh tại nến **volume đột biến** có phản ứng khác mức giá sinh tại nến **volume bình
> thường** (0,9–1,1× trung vị) không?

Đo: cú chạm đầu tiên trong hạn 180 ngày → bước giá 12 nến sau đó **theo chiều bật lại**, chuẩn hoá
bằng ATR **tại cú chạm** (không phải tại nến sinh key — nến spike có ATR cao hơn, chuẩn hoá sai chỗ
sẽ tự tạo ra chênh lệch giả). Cùng code, cùng khung H1, cho cả hai thị trường.

| | n spike | pứ spike | t | n đ.chứng | pứ đ.chứng | t | chênh |
|---|---|---|---|---|---|---|---|
| **GỘP FX** (13 công cụ, 22 năm) | 43.802 | −0,0051 | −0,49 | 48.110 | −0,0094 | −0,83 | +0,0043 |
| **GỘP crypto** (8 coin, H1) | 27.454 | −0,0041 | −0,28 | 27.723 | +0,0005 | +0,03 | −0,0046 |

**Không có gì ở cả hai thị trường.** Và chênh lệch spike−đối chứng ở crypto còn mang dấu ÂM.

Hai phản bác hợp lệ, cả hai đã đóng:

**(a) "Phương pháp không vào lệnh ở cú chạm trần, nó chờ SWEEP."** Lọc riêng những cú xuyên qua mức
rồi đóng lại về phía tiếp cận:

| | n | pứ spike | t | chênh so đ.chứng |
|---|---|---|---|---|
| FX | 7.271 | −0,0013 | −0,05 | −0,0103 |
| crypto | 4.571 | −0,0629 | −1,76 | −0,0471 |

Crypto sau sweep **đi tiếp qua mức**, không bật lại.

**(b) "Stop rất sát, hiệu ứng vài nến có thể bị trung bình 12 nến rửa sạch."** Quét cửa sổ đo:

| cửa sổ | FX pứ | t | crypto pứ | t |
|---|---|---|---|---|
| 1 nến | +0,0030 | 0,93 | −0,0109 | **−2,51** |
| 3 nến | −0,0052 | −0,92 | −0,0077 | −1,03 |
| 6 nến | −0,0019 | −0,25 | −0,0116 | −1,10 |
| 12 nến | −0,0051 | −0,49 | −0,0041 | −0,28 |
| 24 nến | −0,0009 | −0,05 | −0,0033 | −0,15 |

Không cửa sổ nào dương. Ô duy nhất có ý nghĩa thống kê (crypto, 1 nến, t=−2,51) mang **dấu ngược**
với giả thuyết: giá **đi tiếp**, không bật. Độ lớn 0,011 ATR — không giao dịch được.

**Biên phát hiện (làm cho số 0 có nghĩa):** với n như trên, loại trừ được mọi hiệu ứng lớn hơn
**±0,0204 ATR** (FX) và **±0,0287 ATR** (crypto) mỗi cú chạm. Một lệnh rủi ro ~1 ATR cần hiệu ứng
cỡ **0,1–0,3 ATR** mới sống nổi phí — lớn hơn biên phát hiện một bậc. Số 0 ở đây là **kết luận**,
không phải thiếu dữ liệu.

---

## 4. Điều phải nói về bản crypto đang chạy

Phép §3 **không** chứng minh bản key-volume trên crypto vô dụng. Nó chứng minh một điều hẹp hơn và
cụ thể hơn:

> Bất cứ edge nào bản crypto có, **nó không đến từ mệnh đề "giá phản ứng tại mức volume đột biến"**.

Vì mệnh đề đó chính là lý do phương pháp được kể ra như thế, đây là chỗ nên nghi trước tiên khi
đọc mọi con số cũ của key-volume. Nó khớp với hai ghi nhận đã có: `keyvol-degenerate-stop-gate`
(minRR=3 lọc ra stop suy biến chứ không lọc chất lượng) và `fxdream-as-trend-input` (đối chứng
chỉ-volume **đánh bại** bản dùng vị trí key ⇒ phần VỊ TRÍ GIÁ của "key" không có giá trị).

Ba ghi nhận độc lập, cùng một hướng: **phần "Key" — vị trí giá — là phần không đo được.**

## 5. Vì sao FX còn tệ hơn một bậc

`volume` ở FX/vàng CFD **không phải khối lượng khớp thật**. Thị trường ngoại hối phi tập trung,
không có sổ lệnh trung tâm; con số của Dukascopy là volume theo **tick** (số lần giá cập nhật) của
riêng feed đó. Với một phương pháp mà "volume đột biến" là điều kiện SINH ra Key, đây là thay thế
căn bản chứ không phải sai số nhỏ. Nhưng §3 cho thấy điều đó **không phải** nguyên nhân chính —
crypto có volume khớp thật và vẫn không đo được hiệu ứng.

## 6. Vòng bổ sung — kiểm BẢN MẠNH NHẤT của giả thuyết

§3 dùng key **thô**, tức bản yếu nhất. Bác bỏ bản yếu rồi tuyên bố đã bác bỏ phương pháp là lỗi lập
luận, nên `scripts/exp-key-premise.ts` dựng thang định nghĩa Key, mỗi bậc thêm đúng một điều kiện —
bao gồm **luật thật của người dùng** ("đứng được một thời gian"; khi hỏi kỹ: "giá đã quay lại chạm
và BẬT RA"). Điểm mấu chốt: **nhóm đối chứng đi qua ĐÚNG thang lọc ấy**, nếu không thì mọi bậc sẽ
tự "tốt lên" nhờ chọn mẫu sống sót. Thêm nhóm thứ ba — **mức GIẢ**, lấy close nến volume-thường rồi
dời 0,7 ATR nên không trùng giá đóng của bất kỳ nến nào — để kiểm chính khái niệm "mức".

**CRYPTO — 8 coin, H1** (thị trường đang chạy thật):

| định nghĩa Key | n spike | pứ spike | t | pứ vol-thường | **pứ mức GIẢ** | chênh vol | biên ± |
|---|---|---|---|---|---|---|---|
| R0 thô (= code hiện tại) | 27.454 | −0,0041 | −0,28 | +0,0005 | +0,0246 | −0,005 | 0,029 |
| R1 + rời đi ≥1 ATR | 26.140 | −0,0428 | −2,55 | −0,0768 | −0,0376 | +0,034 | 0,033 |
| R2 + chín 5 ngày | 23.822 | −0,0438 | −2,56 | −0,1058 | −0,0953 | +0,062 | 0,034 |
| **R3 + chín & không bị xuyên** | 5.642 | **−0,1166** | **−3,29** | −0,1554 | **−0,1351** | +0,039 | 0,069 |
| R4 + ĐÃ BẬT MỘT LẦN | 13.763 | −0,0706 | −3,23 | −0,1124 | −0,0390 | +0,042 | 0,043 |
| **R5 + volume lần hai** | 6.825 | **−0,1121** | **−3,54** | −0,1396 | −0,0403 | +0,028 | 0,062 |

FX: mọi bậc nằm trong nhiễu; ô âm nhất (R4, −0,0376, t=−2,17) được **mức GIẢ khớp gần y hệt**
(−0,0418) ⇒ không phải hiệu ứng của mức.

Ba điều đọc ra, theo thứ tự quan trọng:

1. **Có một hiệu ứng THẬT, và nó NGƯỢC CHIỀU giả thuyết.** Ở các bậc chặt, phản ứng âm mạnh với
   t = −3,3…−3,5: sau cú chạm vào key đã chín, giá **ĐI TIẾP QUA MỨC**, không bật lại. Phương pháp
   đang đặt cược ngược với một hiệu ứng có thật.
2. **Nhưng nó KHÔNG PHẢI hiệu ứng của "mức".** Nhóm **mức GIẢ** — những giá không trùng close của
   nến nào — cho gần đúng con số ấy (R3: −0,1351 so với −0,1166). Thứ các bậc lọc chọn ra thực chất
   là hình thái **hồi về trong xu hướng**, và sau một cú hồi thì giá đi tiếp. Đó là quán tính giá,
   không liên quan gì tới Key hay volume.
3. **Điều kiện volume gần như không thêm gì.** "chênh vol" = +0,03…+0,06 với biên ±0,03…±0,07 —
   chỉ một ô (R2) vượt biên của chính nó. Dấu dương ở đây nghĩa là key volume đi tiếp *ít hơn* key
   thường một chút, tức có chút "giữ giá" — nhưng không đủ để đảo dấu, nên **không giao dịch được
   như một cú đảo chiều**.

**Và ngay cả chiều ĐI TIẾP cũng không giao dịch được ở khung này:**

| | ATR(H1) trung vị | khứ hồi | ngưỡng phải vượt |
|---|---|---|---|
| crypto | 1,019% giá | 0,140% | **0,137 ATR** |
| FX | 0,153% giá | 0,020% | **0,129 ATR** |

Hiệu ứng lớn nhất đo được là 0,117 ATR (R3 spike) — **nhỏ hơn ngưỡng 0,137 ATR**. Nhóm đối chứng
0,155 ATR chỉ nhỉnh hơn ngưỡng, và nó là nhóm *không* có volume. Không có gì để xây ở đây.

*Ghi chú sửa lỗi:* bản R3 đầu tiên loại key khi giá đóng vượt ngưỡng ở **bất kỳ phía nào** → n = 0
(crypto) và n = 1 (FX). Đó là lỗi định nghĩa chứ không phải kết quả: "không bị đóng xuyên" phải hiểu
theo PHÍA — mức mất hiệu lực khi giá đóng sang phía ĐỐI DIỆN, còn rời xa về đúng phía cũ là bình
thường. Số trong bảng là sau khi sửa.

## 7. Phép cuối — CẤU TRÚC RÀO, thứ duy nhất còn có thể cứu phương pháp

**Lỗ hổng trong chính hai phép trên của tôi:** cả §3 lẫn §6 đo **trung bình bước giá**. Nhưng lãi/lỗ
của một hệ có stop sát và target xa KHÔNG do trung bình quyết định — đó là bài toán **first-passage**:
xác suất chạm target trước khi chạm stop. Hai phân phối cùng trung bình vẫn cho kỳ vọng R khác hẳn,
vì stop cắt cụt đuôi trái còn target cắt cụt đuôi phải. Kết luận "trung bình ≈ 0" **không đủ** để bác
bỏ một hệ stop/target. `scripts/exp-key-barrier.ts` đóng đúng lỗ hổng đó.

Rào dựng đúng production (`stopMode: "sweep-window"`): vào ở close nến sweep, stop ở cực trị nến
sweep lùi 0,15 ATR, target k×R, bỏ lệnh có stop > maxStopPct 3%. Cùng nến chạm cả hai ⇒ **tính stop
trước** (giả định thận trọng, đúng hướng [[execution-fill-assumption-risk]]).

**Mốc null tự chuẩn:** bước ngẫu nhiên không trôi cho kỳ vọng gộp = 0 và **WR = 1/(1+k)**. Đây là
cột so, chứ không phải cảm giác "WR 33% nghe thấp quá".

**CRYPTO — 8 coin, H1:**

| bậc / nhóm | target | lệnh | WR% | **WR ngẫu** | gộp R/lệnh | t | phí R/lệnh | ròng R/lệnh |
|---|---|---|---|---|---|---|---|---|
| R0 spike | 1R | 3.938 | 46,1 | **50,0** | −0,078 | −4,89 | 0,157 | −0,235 |
| | 2R | 3.938 | 31,0 | **33,3** | −0,072 | −3,25 | 0,157 | −0,229 |
| | 3R | 3.938 | 23,4 | **25,0** | −0,064 | −2,37 | 0,157 | −0,221 |
| R0 **mức GIẢ** | 1R | 4.431 | 46,5 | 50,0 | −0,071 | −4,71 | 0,161 | −0,231 |
| R4 spike (luật user) | 1R | 2.004 | 45,2 | 50,0 | −0,096 | −4,31 | 0,143 | −0,239 |
| | 3R | 2.004 | 24,0 | 25,0 | −0,041 | −1,06 | 0,143 | −0,184 |
| R4 **mức GIẢ** | 1R | 2.288 | 47,8 | 50,0 | −0,044 | −2,09 | 0,148 | −0,191 |

FX cùng hình: mọi WR nằm trong 47,7/31,5/23,3 so với mốc ngẫu 50/33,3/25.

**Ba kết luận, và lần này không còn đường lùi:**

1. **Tỉ lệ thắng bằng ĐÚNG mốc bước ngẫu nhiên** ở mọi bậc, mọi nhóm, cả hai thị trường — luôn thấp
   hơn mốc một chút, đúng bằng phần giả định "cùng nến thì stop trước". Cấu trúc rào **không** cứu
   được: hệ đang lấy chính xác thứ mà tung đồng xu cho.
2. **Nhóm mức GIẢ không thua nhóm spike.** R0: −0,071 (giả) so với −0,078 (spike). R4: −0,044 (giả)
   so với −0,096 (spike) — **giả còn tốt hơn**. Không có hiệu ứng của "mức" ở bất kỳ đâu.
3. **Phí là 0,143–0,180 R MỖI LỆNH.** Đây là con số cần nhớ nhất trong cả vòng: stop sát cú sweep
   khiến R chỉ là một phần nhỏ của giá, nên khứ hồi 0,14% biến thành **14–18% của R**. Một hệ
   stop-sát ở H1 phải thắng bước ngẫu nhiên **15–18%** chỉ để hoà vốn.

**Biên phát hiện:** ±0,031 R ở ô chặt nhất, trong khi cần vượt 0,157 R — **dư 5 lần**. Null này
không phải do thiếu dữ liệu.

## 8. Việc cần làm

- **Không** mở nhánh FX Dream. Vòng 5 này khép luôn nhánh FX: trend (vòng 1), nhân tố chéo (vòng 2),
  cặp phổ biến + vàng (vòng 4), phản ứng-tại-mức-giá (vòng 5) — đã quét hết bốn họ cơ chế.
- **Nên làm** với bản crypto: chạy `fx-dream-placebo.ts` + `scripts/exp-key-premise.ts` như phép
  kiểm thường trực. Nếu muốn giữ key-volume, cần chỉ ra khâu nào tạo ra edge, vì nó không nằm ở
  khâu Key — kể cả với định nghĩa Key chặt nhất mà người dùng mô tả.
- **KHÔNG** đảo chiều key-volume thành hệ đi-tiếp. Hiệu ứng đi tiếp có thật (t=−3,5) nhưng (a) mức
  GIẢ cho cùng con số ⇒ không phải hiệu ứng của mức, chỉ là quán tính giá; (b) 0,117 ATR < ngưỡng
  chi phí 0,137 ATR. Quán tính giá ở crypto đã được khai thác đúng chỗ rồi — bằng Turtle/Fast, ở
  khung chậm hơn nơi biên độ đủ phủ chi phí.
- **Bài học phương pháp giữ lại:** mọi kết luận "≈0" phải in kèm **biên phát hiện**, và mọi bộ lọc
  làm mẫu đẹp lên phải chạy trên **nhóm đối chứng đi qua đúng bộ lọc đó** — cộng thêm một nhóm
  **giả** để kiểm chính khái niệm đang đo. Ba lần trong vòng này, đúng ba phép ấy chặn được ba kết
  luận sai khác nhau.
