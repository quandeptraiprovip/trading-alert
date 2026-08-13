# Người trade cặp tiền có hồ sơ kiểm chứng thực sự làm gì

**Ngày:** 13/08/2026
**Câu hỏi:** nghiên cứu chia sẻ về cách đánh cặp tiền từ những người **được chứng minh** đã kiếm
được tiền từ thị trường.
**Kết luận ngắn:** những người có hồ sơ kiểm chứng đều nói gần như cùng một thứ — và thứ đó **không
phải** cách vào lệnh. Điều quan trọng hơn: khi phân rã lợi nhuận của họ bằng số, phần lớn là beta
với đúng những nhân tố tôi đã đo, và phần còn lại nằm ở chỗ **không có mặt trong lệnh lúc nó sập**.

---

## 1. Vấn đề xác minh phải giải trước

Không gian dạy trade FX gần như toàn tuyên bố không kiểm chứng được. Nên trước hết phải định nghĩa
"được chứng minh". Bốn mức, độ tin cậy giảm dần:

| Mức | Nghĩa | Ví dụ |
|---|---|---|
| **A** | Kiểm toán độc lập, nhiều năm, có cơ quan quản lý | chương trình CTA/quỹ tiền tệ trong chỉ số Barclay |
| **B** | Sao kê broker được bên thứ ba xác minh | World Cup Trading Championships |
| **C** | Hồ sơ tự công bố nhưng dài và nhất quán, có người ngoài kiểm chứng từng phần | Peter Brandt |
| **D** | Danh tiếng nghề nghiệp, không có hồ sơ quỹ công khai | Bill Lipschutz |

Mọi thứ dưới mức D — khoá học, tín hiệu, ảnh chụp màn hình — bỏ qua hoàn toàn.

**Một cảnh báo về mức B:** WCTC xác minh thật (sao kê broker, Robbins Trading từ 1984), nhưng xếp
hạng theo **% lợi nhuận**. Cơ chế đó chọn ra người dùng đòn bẩy lớn nhất *và* gặp may, không phải
người có kỳ vọng cao nhất. Với hàng trăm người thi, quán quân 600%/năm gần như chắc chắn là cực trị
của phân phối, không phải bằng chứng edge. Chỉ số đáng tin ở đây là **tính bền** — Andrea Unger vô
địch 4 lần (2008–2012) là thứ khó quy cho may mắn.

---

## 2. Mức A — ngành làm được bao nhiêu, và bằng cách nào

### 2.1 Chỉ số Barclay Currency Traders, 2008–2025

Bình quân **+3,43%/năm**, độ lệch 3,17%, **16/18 năm dương**. Nghe rất tốt — cho tới khi đọc kèm
ba con số kia:

- số chương trình trong chỉ số: **117 (2011) → 16 (2026)**
- tài sản quỹ tiền tệ định lượng: **$35 tỉ (2008) → $6 tỉ (2013)**
- **FX Concepts**, quỹ FX lớn nhất thế giới, **$14 tỉ (2007) → phá sản (2013)**

Chỉ số chỉ gồm người **còn sống**. Ai chết thì rời chỉ số. Với mức đào thải ~86%, độ mượt của đường
cong gần như chắc chắn có phần lớn là thiên lệch sống sót. Và độ lệch 3,17% là của **bình quân
nhiều chương trình** — từng chương trình riêng lẻ biến động cao hơn nhiều. Không ai đầu tư được vào
chỉ số.

### 2.2 Họ kiếm tiền bằng cái gì — phân rã bằng số

Levich–Pojarliev (NBER w13714) hồi quy lợi suất quỹ FX chuyên nghiệp lên bốn nhân tố — **carry,
trend, value, volatility** — và kết luận: bốn nhân tố này giải thích phần lớn biến động; chỉ *một
số* nhà quản lý còn alpha ngoài đó. **Trend chiếm R² lớn nhất**; vai trò carry tăng sau 2000.

Tôi tái lập ý đó độc lập (`fx/fx-industry.ts`), đặt chỉ số ngành cạnh hai nhân tố tự đo trên dữ
liệu Dukascopy:

| | tương quan năm (n=18) |
|---|---|
| Barclay ↔ **TSMOM 12 tháng** | **0,467** |
| Barclay ↔ carry sort chéo | 0,128 |
| Barclay ↔ (carry+TSMOM)/2 | 0,353 |

Tương quan 0,467 với trend khớp đúng kết luận "trend là nhân tố trội" của Levich, đo bằng dữ liệu
khác và phương pháp khác. **Nghĩa là: phần lớn cái mà "người thắng có hồ sơ" làm, tôi đã đo rồi ở
`fx-factors.ts` — và toàn bộ phân tích chi phí ở `fx-factors-gate.ts` áp thẳng vào được.**

### 2.3 Phát hiện quan trọng nhất: họ dương đúng lúc nhân tố sập

| năm | carry trần trụi | Barclay CTI |
|---|---|---|
| 2008 | **−24,9%** | +3,50% |
| 2011 | −9,1% | +2,25% |
| 2013 | −5,3% | +0,87% |
| 2015 | −12,5% | +4,65% |
| 2020 | −12,1% | +4,01% |
| 2021 | −7,8% | +1,99% |

**6/6 năm carry sập, ngành vẫn dương**, bình quân +2,88%.

Đây là con số đáng giá nhất trong cả vòng nghiên cứu. Tín hiệu carry ai cũng tính được trong ba dòng
code. Cái nhà quản lý chuyên nghiệp có **không nằm ở tín hiệu** — nó nằm ở chỗ họ **không có mặt
trong lệnh lúc nó sập**.

Nhưng phải nêu cách đọc thứ hai, và tôi **không phân định được** hai cách này từ bên ngoài: với mức
đào thải 117→16, phần lớn "kỹ năng tránh sập" có thể chỉ là *người sập đã biến mất khỏi chỉ số*.
Sự thật nhiều khả năng nằm giữa. Cả hai cách đọc đều dẫn tới cùng một hệ quả thực tế cho người dùng,
nên không cần phân định: **rủi ro đuôi là thứ quyết định sống chết, không phải tín hiệu vào lệnh.**

---

## 3. Mức C & D — cá nhân có hồ sơ dài

### Peter Brandt (mức C — hồ sơ ~30 năm, có chứng thực từng phần)
- CAGR ~41,6% trong 30 năm, chỉ 3–4 năm âm
- **Tỉ lệ thắng chỉ ~30–40%** — thua nhiều hơn thắng
- Rủi ro cố định **~1%/lệnh**
- Câu của chính ông: điều quan trọng hơn tỉ lệ thắng nhiều lần là **tỉ số giữa cỡ thắng bình quân
  và cỡ thua bình quân**

### Jerry Parker (mức A — Chesapeake Capital, kiểm toán, từ 1988)
- Học trò khoá Turtle của Richard Dennis, 35+ năm
- Phương pháp tự mô tả: **"trend following plus nothing — forever"**, mô hình cổ điển, ít bộ phận
  chuyển động, ít tối ưu tham số
- **Và điều đáng chú ý nhất cho câu hỏi của bạn: ông KHÔNG trade FX riêng.** Danh mục ~50% hàng hoá,
  phần còn lại là FX + trái phiếu + cổ phiếu đơn lẻ. FX là **một ngăn**, không phải một nhánh độc lập.

### Bill Lipschutz (mức D — danh tiếng nghề, không có quỹ công khai)
- Nguyên văn: *"Bạn phải trade ở cỡ mà nếu bạn không hoàn toàn đúng về thời điểm, bạn vẫn không bị
  văng khỏi vị thế. Cách của tôi là xây lên cỡ lớn hơn KHI thị trường đi theo mình. Tôi chắc chắn
  là kiểu trader vào lệnh từng phần."*
- Trọng tâm: kiểm soát rủi ro và cỡ lệnh, **hơn là dự đoán hướng**
- Cảnh báo bắt buộc: ông có dòng lệnh khách hàng của Salomon, bảng cân đối ngân hàng và giá liên
  ngân hàng. Phần lớn lợi thế đó **không tái lập được** ở tài khoản bán lẻ.

---

## 4. Đối chiếu với dữ liệu bán lẻ — chỗ tương phản sắc nhất

Từ 23 cuộc thi FX (Davidson, NTU), **41.529 người tham gia**:

| | |
|---|---|
| Tài khoản có lãi cuối kỳ | **21,9%** |
| **Tỉ lệ LỆNH thắng** | **66,8%** |
| Bị margin call | 50,0% |

Và dữ liệu CFTC: qua **14 quý liên tiếp, không một broker nào trong 19 broker** từng có số tài khoản
lãi nhiều hơn tài khoản lỗ (bình quân 103.437 tài khoản/quý). ESMA: **74–89% tài khoản bán lẻ thua lỗ.**

> **Đặt hai con số cạnh nhau — đây là toàn bộ bài học của vòng này:**
>
> | | tỉ lệ thắng | kết quả |
> |---|---|---|
> | Peter Brandt (kiểm chứng, 30 năm) | **~30–40%** | +41,6%/năm |
> | Bán lẻ (41.529 người) | **66,8%** | 21,9% có lãi |
>
> Người bán lẻ thắng **gần gấp đôi** số lệnh và vẫn cháy tài khoản. Nguyên nhân duy nhất có thể:
> lãi nhỏ, lỗ to. Họ chốt lời sớm và ôm lỗ — đúng ngược với thứ mọi hồ sơ kiểm chứng đều làm.

---

## 5. Điểm chung của mọi người có hồ sơ kiểm chứng

Cái họ **đều** nói:

1. **Bất đối xứng, không phải độ chính xác.** Thắng ít hơn nửa số lệnh là bình thường và không sao.
2. **Cỡ lệnh cố định và nhỏ.** Brandt 1%/lệnh. Đây là con số duy nhất họ nói cụ thể.
3. **Ít bộ phận chuyển động, không tối ưu.** Parker: "trend following plus nothing".
4. **Đa dạng hoá qua nhiều thị trường**, không dồn vào một lớp tài sản.
5. **Sống sót qua đuôi** quan trọng hơn kiếm được nhiều lúc thuận.

Cái họ **không** nói — và sự vắng mặt này mới là thông tin:

- không ai đưa ra bộ chỉ báo hay cách vào lệnh cụ thể như bí quyết
- không ai coi cặp tiền là một nhánh đứng riêng
- không ai tuyên bố tỉ lệ thắng cao

---

## 6. Ý nghĩa cho hệ đang chạy

Điều đáng chú ý: **hệ Turtle bạn đang chạy tiền thật đã nằm đúng trong khuôn mẫu này.** Trend
following, tỉ lệ thắng ~30%, rủi ro cố định mỗi đơn vị, đa dạng hoá qua 8 coin, ít tham số, có trần
đơn vị và heat-decay để sống qua đuôi. Đó chính là thứ Parker và Brandt mô tả — chỉ khác lớp tài sản.

Nên câu trả lời cho "người thắng làm gì" hoá ra là: **họ làm thứ bạn đang làm, và họ áp nó lên một
rổ đa dạng trong đó FX chỉ là một ngăn nhỏ — chứ không mở FX thành một nhánh riêng.**

Cộng với hai vòng nghiên cứu trước:
- nhân tố FX bán lẻ chết ở chi phí (`fx-factor-research`, carry: 2,58% → 0,58% ở markup 1%)
- trend FX theo chuỗi thời gian null (`fx-branch-research`)
- và giờ: chỉ số ngành 3,43%/năm với 86% đào thải, tương quan 0,467 với đúng nhân tố trend tôi đã đo

⇒ **Giữ nguyên khuyến nghị: không mở nhánh FX.** Nếu muốn tiến gần hơn tới cách người có hồ sơ làm,
hướng đúng không phải thêm FX mà là **thêm chiều đa dạng hoá cho luật trend đang chạy** — Parker
chạy trend trên hàng hoá, trái phiếu, cổ phiếu và FX cùng lúc, và chính sự đa dạng đó tạo ra độ mượt,
chứ không phải chất lượng tín hiệu ở bất kỳ thị trường nào.

---

## 7. Ranh giới

- Hồ sơ của Brandt là **chứng thực**, không phải kiểm toán độc lập đầy đủ mọi giai đoạn.
- Lipschutz **không có** hồ sơ quỹ công khai; xếp mức D vì lý do đó.
- Chỉ số Barclay có thiên lệch sống sót và tự báo cáo, không sửa được từ ngoài.
- WCTC xác minh sao kê nhưng cơ chế xếp hạng chọn đòn bẩy.
- Số liệu bán lẻ đến từ cuộc thi (một phần dùng tài khoản demo) và dữ liệu broker Mỹ; hành vi trên
  demo có thể liều hơn tiền thật, nên 21,9% là **giới hạn dưới**. Dữ liệu CFTC trên tài khoản thật
  cho hình ảnh cùng chiều.
- Mâu thuẫn chưa khép được: Abbey–Doukas (JIMF 2015) báo cá nhân trade FX *có* lãi sau phí trên một
  tập dữ liệu broker, ngược với Heimer–Simon (−$6,20/lệnh trên 2,15 triệu lệnh). Không tiếp cận
  được toàn văn Abbey–Doukas để đối chiếu phương pháp.

## 8. Tệp

`fx/fx-industry.ts` — phân rã chỉ số Barclay Currency Traders theo carry và TSMOM tự đo, kèm phép
kiểm "ngành làm gì trong năm carry sập". Sạch dưới `--strict --noUnusedLocals`.
