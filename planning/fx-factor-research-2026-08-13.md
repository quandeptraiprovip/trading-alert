# Nhân tố FX theo văn liệu học thuật — vòng nghiên cứu thứ hai

**Ngày:** 13/08/2026
**Câu hỏi:** đọc bài báo nghiên cứu về trade cặp tiền và các yếu tố ảnh hưởng, để dựng một phương
pháp toàn vẹn nhất.
**Kết luận ngắn:** không mở nhánh FX. Nhưng lý do đã ĐỔI so với vòng trước, và phần đổi đó mới là
nội dung đáng giá của báo cáo này.

---

## 1. Vì sao vòng trước chưa đủ để kết luận

Vòng nghiên cứu ngày 13/08 (`planning/fx-branch-research-2026-08-13.md`) đo 6 họ phương pháp và ra
null. Nhưng nhìn lại, cả 6 đều dùng CHUNG một cấu trúc:

> chuỗi thời gian · từng cặp một · có stop · khung ngày/giờ

Trong khi gần như toàn bộ kết quả dương đã được tái lập trong văn liệu FX lại dùng một cấu trúc
khác hẳn:

> **sort chéo** cả rổ · **dollar-neutral** long-short · **tái cân bằng tháng** · **không stop** ·
> tính trên **excess return đã gồm chênh lãi suất**

Bốn khác biệt đó cộng lại là một **cơ chế** khác, không phải một bộ tham số khác. Kết luận null theo
chuỗi thời gian không bao hàm null theo lát cắt chéo. Đó là khoảng trống thật, và vòng này lấp nó.

---

## 2. Văn liệu: bốn nhân tố và số gốc

| Nhân tố | Bài gốc | Cấu trúc | Kết quả gốc |
|---|---|---|---|
| **Carry** | Lustig–Verdelhan 2007; Lustig–Roussanov–Verdelhan 2011 | sort theo chênh lãi suất | Sharpe ~1,0 trước GFC |
| **Momentum** | Menkhoff–Sarno–Schmeling–Schrimpf, *JFE* 2012 | sort theo lợi suất f tháng, 6 rổ, long/short 1/6 | ~10%/năm **gộp** |
| **Value** | Asness–Moskowitz–Pedersen, *JF* 2013 §A.3 | đảo chiều PPP 5 năm | Sharpe 0,34 |
| **Tổ hợp 50/50** | AMP 2013, bảng I dòng *Currencies* | trộn value + momentum | **Sharpe 0,63** |

**Điểm mấu chốt của văn liệu** không phải nhân tố nào mạnh nhất, mà là tổ hợp: value và momentum
tương quan **−0,42** trên cặp tiền, nên trộn 50/50 đẩy Sharpe từ 0,34 lên 0,63 mà không cần nhân tố
nào khoẻ hơn. Đó chính là "phương pháp toàn vẹn" mà văn liệu chỉ ra, và nó phải được đo.

**Ba cảnh báo có sẵn ngay trong chính các bài đó:**

1. **Chi phí ăn phần lớn momentum.** Menkhoff, bảng 7: gộp ~10%/năm, nhưng trừ spread niêm yết đầy
   đủ thì chiến lược tốt nhất còn **3,92%** — và trong lưới 25 tổ hợp (f × h), **chỉ 2 ô còn
   t > 2**. Với 25 phép thử, kỳ vọng ngẫu nhiên đã là ~1,25 ô. Vòng quay lên tới **70%/tháng**, và
   chính đồng thắng/thua lại là đồng có spread cao hơn trung bình.
2. **Carry đã sập sau 2008.** Sharpe hiệu quả **1,08 trước GFC → 0,25 sau GFC** (Fan–Paseka–Qi–Zhang,
   *JIFMIM* 2022). Nguyên nhân các tác giả kết luận: phần bù rủi ro giảm (rủi ro đuôi biến mất khỏi
   danh mục hậu khủng hoảng), chứ không phải do đa dạng hoá kém.
3. **Bào mòn sau công bố.** McLean–Pontiff (2016): ~26% ngoài mẫu, ~58% sau công bố. Các bài FX trên
   công bố 2007–2013.

**Vì sao dữ liệu tôi có là phép thử ĐÚNG, không phải phép tái lập:** mẫu AMP dừng 07/2011, Menkhoff
dừng 01/2010. Dữ liệu Dukascopy là 2004→2025. Phần chồng lấn nhỏ; phần lớn là **ngoài mẫu và hậu
công bố** — đúng chế độ mà người dùng sẽ giao dịch từ 2026.

---

## 3. Cài đặt

`fx/fx-factors.ts` — engine sort chéo, độc lập với engine trade theo lệnh (ép nhân tố vào `runBooks`
sẽ sai, vì nhân tố không có stop và không có khái niệm "lệnh").

- **Rổ chính G9** = AUD CAD CHF EUR GBP JPY NOK NZD SEK — **trùng khớp rổ AMP 2013 §A.3**, chọn
  trước khi nhìn kết quả. Rổ mở rộng G13 thêm MXN PLN TRY ZAR.
- Mọi tỉ giá quy về **USD trên một đơn vị ngoại tệ** để giá tăng luôn nghĩa là ngoại tệ lên giá.
- Excess return = biến động tỉ giá + chênh lãi suất/12 (ngang giá lãi suất có bảo hiểm ⇒ bằng đúng
  lợi suất hợp đồng kỳ hạn mà văn liệu dùng).
- **Chống nhìn trước:** lãi suất dùng bản tháng trước; CPI năm lùi 1 năm; tín hiệu tại cuối tháng
  *i*, lợi suất ăn từ *i* sang *i+1*.
- Chi phí = vòng quay × nửa spread **đo từ Dukascopy** theo từng đồng (spread NOK/SEK 15 bps so với
  EUR 0,9 bps — lệch 17 lần, không được dùng một con số chung).
- Dữ liệu bổ sung: lãi suất liên ngân hàng 3 tháng (FRED, đã có), CPI năm (World Bank `FP.CPI.TOTL`,
  tải mới cho vòng này).

### 3b. Bằng chứng engine cài đúng

Không được tin kết quả âm nếu chưa loại trừ khả năng tự cài sai. Bốn phép kiểm độc lập
(`fx/fx-factors-check.ts`):

| Phép kiểm | Kỳ vọng độc lập | Đo được | |
|---|---|---|---|
| Chênh lãi suất từng đồng | AUD/NZD dương, JPY/CHF âm | AUD **+1,50%** NZD **+1,82%** · JPY **−1,75%** CHF **−1,80%** | ✅ |
| Tương quan value↔mom | AMP báo −0,42 | **−0,47** (lợi suất) · −0,50 (tín hiệu) | ✅ |
| Skew của carry | văn liệu: âm mạnh | **−0,72** (G9) · **−1,01** (G13) | ✅ |
| Mức Sharpe carry | hậu-GFC: 0,25 | **0,22 / 0,25** | ✅ |
| Tín hiệu ngẫu nhiên, 5 hạt | ≈0, hơi âm do phí | −0,39…−0,03 (bq ≈ −0,28) | ✅ |
| Nhân tố đô-la | ≈0 | −0,10 | ✅ |

Bốn con số đầu khớp văn liệu **mà không hề được nhắm vào**. Engine đúng.

> **Mốc null quan trọng:** tín hiệu ngẫu nhiên cho Sharpe ≈ **−0,28** vì phí vòng quay. Nên
> "momentum Sharpe −0,10" KHÔNG có nghĩa momentum dự báo ngược — nó có nghĩa momentum **bằng đúng
> mức ngẫu nhiên**. Đây là mốc phải nhớ khi đọc bảng dưới.

---

## 4. Kết quả — G9, 2004–2025 (264 tháng), ròng chi phí

| Nhân tố | annRet | annVol | Sharpe | t-stat | maxDD | skew |
|---|---|---|---|---|---|---|
| carry | 1,6% | 7,5% | **0,22** | 1,00 | 36% | −0,72 |
| mom 1 tháng | −0,7% | 7,1% | −0,10 | −0,47 | 47% | 0,17 |
| mom 3 tháng | −2,8% | 7,3% | −0,39 | −1,79 | 89% | 0,39 |
| mom 6 tháng | −2,1% | 6,4% | −0,33 | −1,49 | 62% | −0,44 |
| mom 12 tháng | −1,0% | 7,5% | −0,14 | −0,60 | 43% | 0,24 |
| value (PPP 5 năm) | 0,2% | 5,8% | 0,03 | 0,12 | 20% | 0,12 |
| **value + mom12 (50/50)** | −0,4% | **3,7%** | −0,10 | −0,47 | 16% | 0,47 |
| carry + value + mom12 | 0,3% | 3,6% | 0,08 | 0,39 | 12% | −0,50 |

### Trong mẫu gốc vs hậu công bố (cắt tại 2012)

| Nhân tố | ≤2011 | ≥2012 | |
|---|---|---|---|
| carry | 0,21 | **0,22** | ổn định |
| mom 1 tháng | 0,12 | −0,29 | sập |
| mom 3 tháng (G9) | 0,19 | **−0,84** | sập |
| mom 3 tháng (G13) | 0,64 | **−0,27** | sập |
| value | −0,38 | 0,11 | ≈0 cả hai |
| value + mom12 | −0,25 | 0,00 | ≈0 |

### Phát hiện chính xác về tổ hợp 50/50

Đây là chỗ dễ kết luận sai nhất, nên nói cho rõ:

**Cơ chế đa dạng hoá CÒN NGUYÊN VẸN.** Tương quan value↔momentum đo được **−0,47**, khớp gần đúng
−0,42 mà AMP báo. Và nó hoạt động đúng như quảng cáo: annVol của tổ hợp là **3,7%** so với 7,5% của
từng chân — giảm một nửa rủi ro, y hệt lý thuyết.

**Cái mất là LỢI SUẤT, không phải quan hệ.** Tổ hợp đang trộn hai nhân tố có kỳ vọng bằng 0 một cách
rất hiệu quả. Kết quả là một đường gần phẳng, độ lệch nhỏ. Sharpe 0,63 của AMP không tái lập được
không phải vì hết đa dạng hoá, mà vì hai thứ được đa dạng hoá đã không còn sinh lời.

> Ghi lại để khỏi lặp: **tôi đã suýt kết luận sai ở đây.** Bản đầu của `fx-factors.ts` in tương quan
> ≈0 và tôi gần như viết "cơ chế tổ hợp đã mất". Thực ra hàm `corr()` so phần tử thứ *i* của hai
> mảng có mốc bắt đầu khác nhau (value cần 5,5 năm mồi nên bắt đầu 2009; momentum bắt đầu 2005) —
> lệch pha 4 năm. Sau khi ghép theo nhãn tháng (`corrAligned`) thì ra −0,47. Cùng họ lỗi với hai
> bug tôi từng mắc trong `exp-concentration.ts`.

---

## 5. Cửa duyệt cho ứng viên duy nhất: CARRY

Carry là thứ ĐẦU TIÊN trong hai vòng nghiên cứu FX vượt được mọi phép kiểm vững:

| Phép | Kết quả | |
|---|---|---|
| Nhiễu số đồng mỗi chân (2/3/4) | Sharpe 0,23 / 0,25 / 0,26 | ✅ ổn định |
| Lệch pha (dịch ngày chốt 0…21 ngày) | Sharpe 0,22…0,25, **không đổi dấu** | ✅ |
| Era (≤2011 vs ≥2012) | 0,21 vs 0,22 | ✅ |
| Bỏ từng đồng (13 lần) | 0,16…0,37, không lần nào âm | ✅ |
| Tập trung (G13) | năm tốt nhất 33%, đồng lớn nhất JPY 39% | ✅ |
| Tập trung (G9) | **JPY 59% tổng lợi nhuận** | ❌ |
| Tương quan với Turtle CORE8 | **0,010** | ✅ thật sự độc lập |

Nó là một hiệu ứng **THẬT**. Và vẫn không dùng được, vì bốn lý do dưới đây — mỗi lý do đủ để loại
một mình.

### 5.1 Markup broker — phép giết nhanh nhất

Carry là nhân tố duy nhất mà nguồn lợi nhuận là **một dòng tiền broker trực tiếp kiểm soát**. Họ
công bố swap của riêng họ và cắt trên **cả hai chiều**. Danh mục 3 long + 3 short có tổng |trọng số|
= 2,0, nên markup *m*%/năm tốn *2m*%/năm.

| Markup mỗi chiều | G9 annRet | G13 annRet | G13 Sharpe |
|---|---|---|---|
| 0% (quỹ có quan hệ ngân hàng) | 1,60% | 2,58% | 0,25 |
| 0,5% | 0,60% | 1,58% | 0,15 |
| **1,0%** (bán lẻ điển hình) | **−0,40%** | **0,58%** | 0,06 |
| 1,5% | −1,40% | **−0,42%** | −0,04 |

Đây không phải chi phí thương lượng được bằng cách đổi broker tốt hơn — nó **là** mô hình kinh doanh
của broker bán lẻ.

### 5.2 Không phân biệt được với số 0

**t = 1,13 sau 22 năm.** Ngay cả ở markup 0%, không bác bỏ được giả thuyết lợi suất bằng 0. Muốn
t = 2 với Sharpe 0,25 cần khoảng **64 năm** dữ liệu.

### 5.3 Hình dạng rủi ro sai

skew **−1,01**; 3 tháng tệ nhất −13,4% / −12,0% / −11,1%; **12 tháng tệ nhất −24,9%**; maxDD 29%.
Tức là kiếm 2,6%/năm để đổi lấy rủi ro mất 25% trong một năm — đúng mô tả kinh điển của
Brunnermeier–Nagel–Pedersen (2008): *nhặt xu trước xe lu*. Sharpe không mô tả được hình dạng này.

### 5.4 So trực tiếp với hệ đang chạy

Dùng **cùng một thước** (`recovery` = R/năm sau khi bỏ năm tốt nhất, chia maxDD):

| Sổ | hồi phục |
|---|---|
| **Turtle CORE8 (tiền thật)** | **0,86** |
| Carry FX G13 (markup 0%) | 0,06 |
| Carry FX G9 (markup 0%) | 0,02 |

Kém **14 lần** ngay ở giả định markup bằng 0 — mức người dùng không thể có.

### 5.5 Quy về vốn thật

Với **$513**, carry ở mức markup bán lẻ thực tế (1%/năm) kỳ vọng **0,58%/năm ≈ $3/năm**, kèm rủi ro
sụt 25% trong một năm xấu. Không có cách sắp xếp nào làm con số này đáng công.

---

## 6. Vì sao — cơ chế, không phải xui rủi

Ba lời giải thích, mỗi cái có bằng chứng trong chính số liệu:

1. **Ngang giá lãi suất là thật.** Vòng trước đo được: thu +1,5%/năm lãi suất, mất −2,0%/năm qua tỉ
   giá. Vòng này USDTRY đóng góp **−13%** cho rổ carry — bỏ TRY ra thì Sharpe TĂNG từ 0,25 lên 0,37.
   Đồng lãi suất cao mất giá đúng bằng phần lãi, theo thiết kế.
2. **Momentum bị chi phí và đám đông ăn.** Chính Menkhoff đã cho thấy chỉ 2/25 tổ hợp sống sót spread
   niêm yết với vòng quay 70%/tháng. Thêm bào mòn hậu công bố (McLean–Pontiff 58%) là hết.
3. **Phần bù carry co lại cùng độ phân tán lãi suất.** 2004–2025 phần lớn là kỷ nguyên lãi suất
   ~0 đồng loạt ở G10. Không có phân tán thì không có carry để thu.

Và bối cảnh chung: **74–89% tài khoản bán lẻ CFD/FX thua lỗ** (công bố bắt buộc theo ESMA, ~20
broker EU). Đó là môi trường mà nhánh này sẽ phải sống trong.

---

## 7. Khuyến nghị

**Không mở nhánh FX.** Giữ nguyên vốn ở hệ crypto.

Lý do đã đổi so với vòng trước, và nên ghi nhận cho đúng:

- **Vòng trước:** "không tìm thấy gì trên cặp tiền."
- **Vòng này:** "tìm thấy đúng một thứ có thật — carry — nó vượt mọi phép kiểm vững, nhưng
  không phân biệt được với 0 về mặt thống kê (t = 1,13), chết ở chi phí bán lẻ, có hình dạng rủi ro
  sai, và kém hệ đang chạy 14 lần trên cùng một thước."

Đó là một kết luận âm **mạnh hơn**, vì nó biết chính xác cái gì có và cái gì không.

**Giữ lại:** toàn bộ `fx/` (hạ tầng Dukascopy + engine nhân tố + CPI/lãi suất). Nếu sau này độ phân
tán lãi suất G10 quay lại mức 2005–2007, carry đáng đo lại — `fx/fx-factors-gate.ts` chạy lại trong
một lệnh. Chỉ báo theo dõi: độ lệch chuẩn chênh lãi suất giữa 13 đồng.

---

## 8. Ranh giới của khẳng định

Vòng này đo **nhân tố sort chéo trên khung tháng**. Vẫn **chưa đo**:

- dưới khung giờ (tick/M5/M15) và order flow — Evans–Lyons cho thấy dòng lệnh giải thích >60% biến
  động ngày, nhưng dữ liệu đó bán lẻ không có
- nhân tố dựa trên độ biến động ngụ ý / quyền chọn FX
- carry có phòng hộ đuôi (mua quyền chọn OTM chống crash)
- basis-momentum (Fan 2025) và các nhân tố mới hậu-2020
- phương pháp theo tin/sự kiện, và các hướng học máy

Khẳng định đúng là: **trong họ nhân tố giá/lãi suất theo vị thế mà văn liệu FX đã tái lập, không có
cái nào còn dùng được ở quy mô và chi phí bán lẻ sau 2012.**

---

## 9. Tệp

| Tệp | Vai trò |
|---|---|
| `fx/fx-factors.ts` | engine sort chéo, 4 nhân tố + tổ hợp, tách mẫu |
| `fx/fx-factors-check.ts` | 4 phép kiểm chứng engine + rổ 13 đồng |
| `fx/fx-factors-gate.ts` | cửa duyệt carry: markup, đuôi, tập trung, nhiễu, bỏ-từng-đồng, lệch pha, tương quan crypto |
| `.cache/fx/cpi.json` | CPI năm 14 nước (World Bank), mới cho vòng này |

Cả ba đều sạch dưới `--strict --noUnusedLocals`.
