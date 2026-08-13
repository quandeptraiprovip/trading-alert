# FX Dream / Key Volume: tận dụng được gì cho Turtle-Fast, và có xác định Key như mắt người được không (2026-08-12)

Nối tiếp `planning/turtle-fast-deep-audit-2026-08-12.md`. Cùng khung đo: 2.028 ngày, rổ 8 coin, nến 4h,
phí thật, chấm bằng vốn cuối kỳ khi ép mọi cấu hình về cùng maxDD 30%.

---

## 0. Điều kiện để một họ luật "bổ trợ" được — và vì sao FX Dream không đạt trên Binance perp

Bổ trợ đòi HAI thứ cùng lúc: **kỳ vọng NET dương** và **tương quan thấp**. Tương quan thấp mà kỳ vọng
âm thì chỉ là cách thua tiền theo nhịp khác.

Kỳ vọng NET của FX Dream trên rổ perp này đã được đo hai lần, kết luận trùng nhau:

| bản đo | lệnh | gross | net @0,14% (Binance) | net @0,02% (Vàng/Forex) |
|---|---:|---:|---:|---:|
| scanner source-aligned 1 năm (`fxdream-1y-measurement`) | 341 | **−25,5R** | ≈ −127R | ≈ −40R |
| bản sửa đủ tốt nhất (`measure-live-path`) | 257 | +28,4R | **−33R** | **+20R** |

Bản tốt nhất hoà vốn ở ma sát **<0,088%**; Binance perp là 0,140%. Bootstrap CI90 của mean gross
R/lệnh chứa 0. **Ràng buộc là VENUE, không phải luật** — trùng kết luận §13.7 và
`keyvolume-manual-vs-code`. Vì gross của bản source-aligned đã âm, giảm phí cũng không cứu được nó.

⇒ Làm sleeve riêng: **không**, trừ khi đổi sang thị trường ma sát 0,01–0,02%.

---

## 1. Cửa duy nhất còn lại: dùng làm INPUT cho Turtle/Fast (bộ lọc/sizing không tốn phí)

Lý do đáng thử: **bộ lọc không thêm một lệnh nào** — nó chỉ bỏ hoặc thu nhỏ lệnh hai sleeve vốn đã
vào. Nên ma sát 0,14%, thứ giết FX Dream khi đứng riêng, **hoàn toàn không áp dụng**. Và về cơ chế,
Turtle/Fast mù hoàn toàn với cấu trúc NGANG (chúng chỉ biết kênh Donchian + EMA), nên thông tin vị trí
vùng volume là thông tin ĐỘC LẬP.

Key phát hiện bằng `detectKeyVolumeLevels` của `key-volume.ts` (engine đã qua hai vòng audit 20 luật),
chạy trên chính nến 4h hai sleeve dùng. Không lookahead: chỉ nhận key có `confirmedAt <= openTime` của
nến đang xét, nên key sinh bởi CHÍNH nến vào lệnh bị loại trừ.

### 1.1 Chẩn đoán: hiệu ứng có thật, nhưng NGƯỢC giả thuyết

`scripts/exp-keylevel-room.ts diag` — chia unit theo dư địa tới key gần nhất phía trước:

| ngũ phân vị dư địa | Turtle exp/unit | Fast exp/unit |
|---|---:|---:|
| Q1 0,00–0,06×ATR | **1,136** | 0,852 |
| Q2 0,06–0,15 | **1,143** | **1,246** |
| Q3 0,15–0,30 | 0,424 | 0,398 |
| Q4 0,30–0,60 | 0,210 | 0,357 |
| Q5 0,60–17,6 | 0,466 | 0,489 |
| không có key phía trước | 0,242 | 0,287 |

Dư địa **ÍT** thì tốt hơn, không phải nhiều hơn. Giả thuyết "đâm vào vùng volume thì hết chỗ chạy" SAI
ở đây; đọc đúng hơn là "phá vỡ ngay tại vùng volume lớn = phá vỡ có hấp thụ thật".

`scripts/exp-key-identification.ts` xác nhận hiệu ứng cực bền — ở **cả tám** mức ngưỡng key
(373 → 13 key/coin/năm), unit vào sát key luôn có exp cao gấp 2–3× unit vào xa key:

| ngưỡng spike | key/coin/năm | exp sát key | exp xa key | chênh |
|---|---:|---:|---:|---:|
| 2× | 373 | 0,971 | 0,280 | +0,692 |
| 3× | 157 | 1,051 | 0,265 | +0,786 |
| 5× | 48 | 0,971 | 0,405 | +0,566 |
| 8× | 19 | **1,398** | 0,514 | **+0,884** |

### 1.2 Làm BỘ LỌC — LOẠI (cả hai chiều)

| Turtle | vị thế | Sharpe | vốn (×) | vs mốc |
|---|---:|---:|---:|---:|
| không lọc | 1.159 | 1,59 | 22,45 | — |
| dư địa ≥1×ATR | 597 | 1,12 | 7,01 | **−69%** |
| dư địa ≥2×ATR | 479 | 1,18 | 7,56 | −66% |
| chỉ lấy dư địa <1×ATR | 844 | 1,54 | 15,89 | −29% |
| chỉ lấy dư địa <2×ATR | 865 | 1,53 | 15,22 | −32% |

Cả hai chiều đều thua vì cùng một lý do: chúng cắt gần nửa số vị thế, và **hệ trend sống bằng đuôi
phải** — mất vị thế là mất cơ hội trúng trend lớn. Fast y hệt (−34% … −74%).

### 1.3 Làm SIZING — LOẠI, và đối chứng chỉ ra vì sao

`scripts/exp-key-sizing.ts`: giữ TOÀN BỘ lệnh, chỉ thu nhỏ unit xa key xuống λ (vì `askAdmit` kẹp
tỉ trọng ≤1, thu nhỏ nhóm kia tương đương phóng to nhóm này sau khi chuẩn hoá maxDD).

**Đối chứng bắt buộc:** key = nến volume đột biến, nên "sát key" phần lớn nghĩa là "gần đây có volume
đột biến VÀ giá chưa đi xa". Phải so với đối chứng **chỉ-volume** (có spike gần đây, BỎ QUA khoảng cách
giá). Kết quả ở Fast:

| biến thể (key spike ≥2×) | Sharpe | vốn (×) | vs mốc |
|---|---:|---:|---:|
| λ = 1 (đang chạy) | 1,60 | 18,74 | — |
| dùng khoảng cách key, λ=0,35 | 1,58 | 13,07 | **−30%** |
| **ĐỐI CHỨNG chỉ-volume, λ=0,35** | 1,60 | **25,94** | **+38%** |

**Đối chứng đánh bại hẳn bản thật.** Kết luận thẳng: phần "key" của FX Dream — **VỊ TRÍ GIÁ** của vùng
volume — không đóng góp gì cho hai sleeve. Thứ mang tin chỉ là volume có nở hay không.

### 1.4 Truy tiếp phần còn sống (volume-sizing) — cũng LOẠI

`scripts/exp-volume-sizing.ts`, thu nhỏ unit không có volume nở gần đây (λ=0,35):

| mult \ cửa sổ | 3 nến | 6 nến | 12 nến | 18 nến |
|---|---:|---:|---:|---:|
| **Turtle** 2,0 | −14% | −14% | −9% | −1% |
| **Turtle** 2,5 | −12% | −0% | +0% | −19% |
| **Fast** 2,0 | +12% | **+42%** | +6% | +18% |
| **Fast** 2,5 | +24% | **+59%** | +35% | −5% |

**Turtle không có ô nào dương.** Tiêu chí đặt trước: phải thắng CẢ HAI sleeve, vì cả hai đọc cùng một
chuỗi giá — thắng một, thua một nghĩa là không có cơ chế. Cửa giả-OOS 4 pha nến xác nhận:
**Turtle 2/4 pha · Fast 3/4 pha** (so với heat-decay: 4/4 pha, cả hai sleeve).

Đây cũng chính là `T.confirmVolMult` ở dạng sizing — luật từng bị bỏ với ghi chú "cải thiện nhỏ,
không giữ". Kết quả này tái xác nhận quyết định đó.

---

## 2. "Có xác định Key Volume chính xác như mắt người không?"

**Không đo trực tiếp được, vì chưa có dữ liệu key do người đánh dấu.** `fxdream-journal.ts` và
`scripts/fxdream-journal-cli.ts` đã có sẵn hạ tầng nhưng chưa có một bản ghi nào. Không có nhãn người
thì không có precision/recall — mọi phát biểu về "chính xác như người" đều là phỏng đoán.

Ba thứ đo được thay thế, và cả ba nói cùng một điều:

### K1 — Mật độ sai một bậc độ lớn

| ngưỡng spike | key/coin/năm | khoảng cách TB giữa 2 key |
|---|---:|---:|
| 2× (**đang dùng**) | **373** | **1,0 ngày** |
| 3× | 157 | 2,3 ngày |
| 5× | 48 | 7,6 ngày |
| 8× | 19 | 19,7 ngày |
| 10× | 13 | 28,7 ngày |

Tác giả kênh giao dịch **~60 kèo/năm trên toàn bộ thị trường của mình**. Định nghĩa đang dùng sinh key
mỗi ngày một cái, **mỗi coin**. Muốn về thang người thì cần ngưỡng 8–10×, tức **ít hơn 20–30 lần**.
Đây là cùng một bệnh mà `fxdream-integration-audit` đã đo ở tầng alert (90 alert/ngày ≈ sai 400×).

### K2 — "Key" chưa phải một VẬT THỂ sắc nét

Jaccard trên tập nến sự kiện, giữa hai định nghĩa cạnh nhau:

| đổi | Jaccard |
|---|---:|
| mult 2 → 2,5 | 63% |
| mult 3 → 4 | **52%** |
| mult 6 → 8 | 55% |
| lookback 96 → 192 | 70% |
| lookback 96 → 48 | 71% |

**Một thay đổi tham số ±25% hoán đổi 30–48% tập key.** Một khái niệm sắc nét không hành xử như vậy.
Nghĩa là: rào cản KHÔNG phải "mô hình chưa đủ giỏi để bắt chước mắt người" — mà là **định nghĩa hiện có
chưa đủ ràng buộc để chỉ ra một tập key duy nhất.**

Điều này khớp với thứ đã biết là còn thiếu, ghi trong `fxdream-profit-and-method-2026-08-10.md`:
các video cốt lõi (**#14 key, #15/#29/#33 entry, #30 volume**) vẫn members-only KEYVOLUME PRO; entry
thật là **Volume Profile HVN/LVN trên M5** (chưa số hoá); còn chọn model/W1/H4, macro, session,
re-entry và quản trị campaign đều chưa có trong proxy.

### K3 — Nhưng key CÓ mang tin

Xem bảng ở §1.1: ở mọi mật độ, sát-key có exp gấp 2–3× xa-key. Nên câu trả lời đầy đủ là:
**detector đang bắt được ĐÚNG HƯỚNG nhưng SAI ĐỘ PHÂN GIẢI** — nó chỉ ra vùng đáng chú ý, nhưng chỉ
quá nhiều vùng nên mỗi cái mất hết giá trị chọn lọc; và thông tin nó thêm vào (vị trí giá) không sống
sót qua đối chứng chỉ-volume (§1.3).

### Cách BIẾN câu hỏi này thành đo được

Hạ tầng đã có sẵn, chỉ thiếu nhãn:

1. Đánh dấu key bằng tay trong `scripts/fxdream-journal-cli.ts` — 30–50 key trên 2–3 coin là đủ để
   bắt đầu (chỉ cần symbol + thời điểm nến + giá vùng).
2. Đo precision/recall của detector so với nhãn đó, quét ngưỡng spike và lookback.
3. Nếu recall cao ở ngưỡng chặt (8–10×) ⇒ khác biệt chỉ là ĐỘ PHÂN GIẢI, chỉnh ngưỡng là xong.
   Nếu recall thấp ở mọi ngưỡng ⇒ người đang dùng thông tin detector KHÔNG có (M5 Volume Profile,
   context W1/H4), và không ngưỡng nào cứu được — phải số hoá thứ còn thiếu trước.

Đây là bước duy nhất biến "chính xác như mắt người?" từ câu hỏi phỏng đoán thành câu hỏi có số.

---

## 2b. BỔ SUNG: luật "Key phải đứng được một thời gian" — từ mô tả của chính người dùng

Người dùng mô tả cách chọn thật: *chọn cột volume to đột biến **khi nó đã xuất hiện một thời gian
rồi***, chứ không phải ngay lúc nến đó vừa đóng.

**Điều kiện này thiếu hẳn trong code.** `isKeyVolumeLevelActive` (`key-volume.ts:685`) chỉ đòi
`confirmedAt <= time`, mà `confirmedAt = eventTime + 1 nến` ⇒ key có hiệu lực NGAY. Chỉ có tuổi TỐI
ĐA (`keyMaxAgeDays = 180`), không có tuổi TỐI THIỂU.

`scripts/exp-key-maturation.ts` đo hai cách đọc:

- **M1 chỉ chờ đủ tuổi — KHÔNG đổi gì.** Số key y hệt ở mọi mức tuổi 1–14 ngày (16.581 ở spike 2×),
  và khoảng cách exp sát/xa key không nhúc nhích. Chờ suông vô nghĩa vì key vẫn dày như cũ.
- **M2 chờ đủ tuổi VÀ giá không đóng xuyên mức trong lúc chờ — đổi hẳn:**

| spike | tuổi tối thiểu | key/coin/năm | exp sát key | exp xa key | **chênh** |
|---|---|---:|---:|---:|---:|
| 3× | 0 (hiện tại) | 157 | 1,051 | 0,265 | 0,786 |
| 3× | 1 ngày | **75** | 1,326 | 0,399 | **0,926** |
| 3× | 3 ngày | 49 | 1,320 | 0,462 | 0,858 |
| 3× | 7 ngày | **36** | 1,362 | 0,505 | 0,857 |
| 3× | 14 ngày | **29** | 1,452 | 0,517 | **0,935** |
| 3× | 30 ngày | 23 | 1,357 | 0,556 | 0,801 |

**Đây là luật đầu tiên khép được khoảng cách MẬT ĐỘ.** 157 → 29–75 key/coin/năm, tức lần đầu vào
đúng thang người (§K1), trong khi khoảng cách tín hiệu **RỘNG RA** chứ không hẹp lại, và tạo cao
nguyên qua mọi mức tuổi 1–30 ngày. Cơ chế hợp lý: một mức bị giá đóng xuyên ngay thì không phải mức
đáng nhớ; mức nào đứng được nhiều ngày mới là mức thị trường thật sự tôn trọng.

*(Định nghĩa "đóng xuyên" dùng ở đây: close vượt sang phía đối diện so với phía giá đứng lúc key hình
thành. Đó là một cách đọc hợp lý, không phải cách duy nhất.)*

### Nhưng vẫn KHÔNG khai thác được cho Turtle/Fast (`scripts/exp-matured-key-sizing.ts`)

Tập key mới hoàn toàn khác tập đã bị loại ở §1.3, nên phải chấm lại bằng đúng bộ cửa đã giết bản trước:

| TURTLE | Sharpe | vốn (×) | vs mốc |
|---|---:|---:|---:|
| λ=1 (đang chạy) | 1,59 | 22,45 | — |
| chín 3d · λ=0,5 | 1,61 | 18,92 | −16% |
| chín 7d · λ=0,5 | 1,60 | 17,73 | −21% |
| chín 14d · λ=0,35 | 1,60 | 13,98 | −38% |
| **ĐỐI CHỨNG chỉ-volume λ=0,35** | 1,59 | **24,37** | **+9%** |
| PLACEBO đảo chiều | 1,56 | 19,63 | −13% |

| FAST | Sharpe | vốn (×) | vs mốc |
|---|---:|---:|---:|
| λ=1 (đang chạy) | 1,60 | 18,74 | — |
| chín 7d · λ=0,5 | 1,55 | 14,61 | −22% |
| ĐỐI CHỨNG chỉ-volume λ=0,35 | 1,64 | 18,31 | −2% |
| **PLACEBO đảo chiều** | 1,60 | **22,01** | **+17%** |

Hai chữ ký của "không có hiệu ứng thật", cùng lúc:
- **Đối chứng chỉ-volume lại thắng ở Turtle** (+9%) trong khi bản dùng vị trí key thua −16…−38% —
  y hệt kết quả §1.3 với key thô.
- **Placebo đảo chiều THẮNG ở Fast** (+17%) trong khi bản thuận thua. Dấu của hiệu ứng lật giữa hai
  sleeve đọc cùng một chuỗi giá ⇒ không phải cơ chế.

⇒ Ngay cả với định nghĩa key ĐÚNG hơn (mật độ thang người, khoảng cách chẩn đoán rộng hơn), **vị trí
giá của key vẫn không chuyển thành tiền cho hệ trend**. Đây là lần thứ ba cùng một cánh cửa đóng lại,
lần này với tập key tốt nhất tìm được.

### Nhưng nó có giá trị THẬT ở chỗ khác

Nếu có ngày muốn engine FX Dream phản ánh đúng phương pháp bạn đang đánh tay, thì **điều kiện chín +
sống sót là thay đổi đáng giá nhất** trong mọi thứ đã đo: nó một mình kéo detector từ 373 xuống ~36
key/coin/năm và làm sắc thêm khả năng phân tách. Nó tấn công đúng khoảng cách lớn nhất (§K1) mà
không cần một nhãn tay nào.

## 2c. Định nghĩa Key ĐÚNG NHẤT (người dùng xác nhận) — và ứng viên suýt đậu

Hỏi lại "đứng được" nghĩa là gì, người dùng trả lời rõ: **giá đã quay lại chạm và bật ra**. Chặt hơn
hẳn §2b.

**Tình trạng code:** `KEY_VOLUME_CONFIG` CÓ cơ chế đếm phản ứng (`minKeyReactions`, `keyReactionAtr`,
`keyHistoryDays`) nhưng (a) đang TẮT (`minKeyReactions: 0`) và (b) nó đếm phản ứng **LỊCH SỬ TRƯỚC**
khi key hình thành — **ngược chiều** với điều người dùng mô tả.

Cài đúng chiều (`scripts/exp-key-reaction.ts`): rời ≥`awayAtr`×ATR → chạm lại vùng → bật ra
≥`bounceAtr`×ATR trong `reactBars` nến, về đúng phía đã rời; đóng xuyên sang phía kia ⇒ key chết.

| spike 3× | key/coin/năm | exp sát key | exp xa key | chênh |
|---|---:|---:|---:|---:|
| key thô (hiện tại) | 157 | 1,051 | 0,265 | 0,786 |
| rời 1,0 · bật 0,5 · 6 nến | 80 | 1,272 | 0,285 | 0,988 |
| **rời 1,0 · bật 1,0 · 6 nến** | **57** | 1,292 | 0,289 | **1,003** |
| rời 0,5 · bật 1,0 · 6 nến | 58 | 1,330 | 0,288 | **1,042** |

Tham số "rời đi bao xa" gần như không ảnh hưởng (0,5 và 1,0 cho kết quả gần bằng nhau) — dấu hiệu
tốt. **Đây là định nghĩa key tốt nhất đo được**: mật độ thang người VÀ phân tách rộng nhất.

### Ứng viên phái sinh: đây KHÔNG phải "vào lệnh gần key"

`scripts/exp-reaction-key-sizing.ts` cho thấy "vào lệnh sát key phản ứng" vẫn THUA cả hai sleeve
(−24…−51%). Nhưng **đối chứng chỉ-volume lại thắng LỚN ở CẢ HAI** — lần đầu trong cả đợt. Tín hiệu đó
bỏ qua hoàn toàn khoảng cách giá; nó chỉ hỏi: *trong 6 nến vừa rồi, thị trường có vừa chạm một vùng
volume lớn rồi bật ra không?* Tức một tín hiệu **REGIME**: "thị trường đang tôn trọng cấu trúc".

Ứng viên này qua được ba cửa đầu, tất cả:

| | Turtle | Fast |
|---|---:|---:|
| λ=1 (đang chạy) | 22,45× · Sharpe 1,59 | 18,74× · Sharpe 1,60 |
| **ứng viên λ=0,5** | **34,97× (+56%) · 1,62** | **28,89× (+54%) · 1,69** |
| PLACEBO đảo chiều | 17,08× (−24%) | 14,03× (−25%) |
| ĐỐI CHỨNG biến động thô | 18,03× (−20%) | 19,70× (+5%) |

- **Cao nguyên:** λ = 0,5–0,65 dương ở **10/10 ô** trên cả hai sleeve, mọi cửa sổ 3–30 nến.
- **Placebo đậu:** đảo chiều xấu rõ ở cả hai.
- **Không phải proxy biến động:** đối chứng "ATR% trên trung vị 90 ngày" chỉ −20%/+5%.
- Ba era đều tăng ở cả hai sleeve; Sharpe tăng ở cả hai.

### Nhưng RỚT cửa lệch pha — và rớt theo cách không thể bào chữa

| pha | Turtle | Fast |
|---|---:|---:|
| **0h (pha mọi tham số được chọn trên đó)** | **+54%** | **+53%** |
| 1h | −31% | −3% |
| 2h | −12% | +5% |
| 3h | +9% | +5% |

Turtle 2/4 · Fast 3/4. **Toàn bộ hiệu ứng nằm ở đúng lưới nến đã tinh chỉnh.** Bỏ pha 0h: Turtle
trung bình −11%, Fast +2% — khoảng không. Đối chiếu: heat-decay cho Fast thắng **4/4** pha
(+23/+19/+7/+20%). Chênh lệch giữa hai hồ sơ này chính là ranh giới giữa cơ chế thật và trùng hợp.

⇒ **LOẠI.** Và đây là ca đắt nhất trong cả đợt: một ứng viên có cao nguyên 10/10 ô, placebo đậu, đối
chứng đậu, ba era đều tăng, Sharpe tăng ở cả hai sleeve — vẫn chết ở cửa lệch pha. Nếu không có cửa
đó thì nó đã được ship.

## 3. Kết luận

- **Làm sleeve bổ trợ trên Binance perp: không.** Ràng buộc là venue (cần ma sát <0,088%), không phải luật.
- **Làm input cho Turtle/Fast: không.** Ba cách (lọc dư địa · sizing theo khoảng cách key · sizing theo
  volume) đều rớt; riêng cách thứ ba rớt vì Turtle không hưởng lợi ở bất kỳ ô nào và chỉ qua 2/4 pha nến.
- **Phần vị trí giá của "key" không sống sót qua đối chứng chỉ-volume** — đây là kết quả rõ ràng nhất
  và nó khép lại hướng "ghép FX Dream vào hệ trend".
- **Xác định key như mắt người: chưa, và rào cản là định nghĩa chứ không phải kỹ thuật.** Việc cần làm
  là ghi nhãn tay trước, rồi mới nói tiếp.
- Nơi FX Dream còn cửa vẫn là nơi §13.7 đã chỉ từ đầu: **thị trường ma sát thấp (Vàng/Forex)**, nơi
  chính tác giả giao dịch — không phải crypto perp.

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/exp-keylevel-room.ts diag 2300
./node_modules/.bin/ts-node scripts/exp-keylevel-room.ts filter 2300
./node_modules/.bin/ts-node scripts/exp-key-identification.ts 2300      # K1/K2/K3
./node_modules/.bin/ts-node scripts/exp-key-sizing.ts 2300              # gồm đối chứng chỉ-volume
./node_modules/.bin/ts-node scripts/exp-volume-sizing.ts grid 2300
KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-volume-sizing.ts phase 2300
```
