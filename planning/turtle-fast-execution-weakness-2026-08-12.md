# Turtle + Fast — điểm yếu ở tầng KHỚP LỆNH và chính sách risk (2026-08-12, vòng bốn)

Tiếp ngay sau `turtle-fast-deep-audit-2026-08-12.md` (12 trục luật, không trục nào sống). Vòng này
KHÔNG quét thêm tham số luật. Nó hỏi hai câu khác:

1. **Những con số ta đang tin có thật không?** — tức các giả định khớp lệnh của engine.
2. **Chính sách risk có nhìn đúng cái đang phơi nhiễm không?**

Mọi số: 2.028 ngày (2021-01-22 → 2026-08-12), nến 4h, rổ CORE8, phí thật (Turtle 0,05% + Fast 0,08%
MEXC + funding). Chấm bằng **vốn cuối kỳ khi mọi cấu hình bị ép về cùng maxDD 30%**. Không phải cam
kết lợi nhuận.

**Chốt chặn:** cả hai gate parity chạy lại sau mọi thay đổi engine — `turtle-live-parity 200` PASS
(17 unit, lệch weight 0), `fast-live-parity 200` PASS (11 unit). Baseline `exp-allocation` tái lập
đúng tới chữ số (18,06× / 23,69× / corr 0,954). Mọi tham số mới mặc định `undefined` ⇒ hành vi
production không đổi một bit.

---

## 0. Phát hiện lớn nhất: điểm yếu số một của hệ KHÔNG PHẢI một luật

`scripts/exp-execution-risk.ts w1`. Engine cho lệnh stop khớp **đúng bằng `pos.sl`** mỗi khi
`bar.low <= pos.sl`, và cho `mid`/`time` khớp **đúng giá đóng nến** — dù live thức dậy 90 giây SAU khi
nến đóng (`SETTLE_MS`) rồi mới gửi market order. `CONFIG.costs.slippagePct` = 0,02% là một hằng số
không phụ thuộc biên độ nên không mô hình hoá được cả hai điều đó.

**Hệ phơi nhiễm vào giả định đó tới mức nào** (tỉ trọng risk, không phải số lệnh):

| sleeve | trail (stop) | mid (close) | LONG qua stop | SHORT qua stop |
|---|---:|---:|---:|---:|
| Turtle | **88%** | 12% | 67% | **100%** |
| Fast | **81%** | 18% | 57% | **100%** |

**Toàn bộ sổ SHORT thoát 100% qua stop** — và sổ short chính là nơi chứa tất cả lợi nhuận 12 tháng
qua (Turtle +60,1R / Fast +97,7R, trong khi long âm). Nhánh mang tiền về đang đứng trọn trên giả định
chưa ai kiểm tra.

**Cái giá của trượt giá thêm** (ATR20 rổ = 2,83% giá ⇒ 0,10×ATR ≈ 28 bps ≈ 0,033R):

| trượt thêm ở nhánh stop | vốn (×) | Sharpe | WF TB | vs mốc |
|---|---:|---:|---:|---:|
| 0 (số đang công bố) | **18,06** | 1,53 | 1,13 | — |
| 0,05×ATR ≈ 14 bps | 15,69 | 1,49 | 1,07 | **−13%** |
| 0,10×ATR ≈ 28 bps | 12,38 | 1,45 | 1,02 | **−31%** |
| 0,20×ATR ≈ 57 bps | 8,27 | 1,38 | 0,91 | −54% |
| 0,50×ATR ≈ 141 bps | 3,56 | 1,14 | 0,59 | −80% |

Trượt ở nhánh close nhẹ hơn nhiều (0,10×ATR chỉ −11%) vì chỉ 12-18% risk đi qua đó.

**14 bps là một con số rất nhỏ.** Để so: thay đổi giá trị nhất mà cả vòng audit trước tìm được
(heat-decay cho Fast) là +31%; chênh lệch giữa bốn pha nến là 157%. Trượt giá nằm **cùng một cấp độ
lớn** với mọi thứ khác trong repo — nhưng nó là đại lượng duy nhất chưa từng được đo.

### 0.1 Môi trường khớp lệnh bạo lực đến mức nào (`r6`)

Với mỗi lệnh thoát `trail`, `exitPrice` CHÍNH LÀ mức stop. Tra lại nến kích hoạt:

| sleeve/hướng | lệnh trail | bị RÂU NẾN quét | tỉ lệ | vượt stop TB (×ATR) | p90 |
|---|---:|---:|---:|---:|---:|
| Turtle LONG | 276 | 170 | **62%** | 0,69 | 1,59 |
| Turtle SHORT | 656 | 345 | **53%** | 0,56 | 1,21 |
| Fast LONG | 227 | 142 | **63%** | 0,74 | 1,64 |
| Fast SHORT | 509 | 279 | **55%** | 0,52 | 1,13 |

Hai điều:

- **Hơn nửa số lần bị stop là râu nến quét** — nến đó ĐÓNG về lại phía có lợi. Stop trong nến đang
  trả tiền cho nhiễu.
- Giá đi **0,52-0,74×ATR vượt qua mức stop** ngay trong nến kích hoạt (p90 tới 1,1-1,6×ATR). Với
  ATR 2,83% thì đó là ~1,5-2% giá. Một lệnh STOP_MARKET khớp trong môi trường như vậy rất khó chỉ
  trượt 14 bps. Đây không phải phép đo trượt giá thật, nhưng nó nói rằng **ngưỡng 14 bps gần như
  chắc chắn đã bị vượt.**

---

## 1. Vì sao chưa ai biết: hệ KHÔNG THỂ tự đo trượt giá của mình

| chiều | có ghi giá khớp thật? | có dùng để tính R? |
|---|---|---|
| ENTRY | **CÓ** — `realEntry = res.avgPrice` (turtle-live.ts:310, fast-trend-live.ts:411) | **KHÔNG** |
| EXIT | **KHÔNG** — `exitPrice` luôn là giá tín hiệu (`pos.sl` hoặc `bar.close`) | — |

Bằng chứng trong `trading-runtime/trades-live.jsonl`: cả ba bản ghi exit đều có
`"exitPrice"` **đúng bằng** `"initialSL"` và `"grossR":-1` chằn chặn. Đó là giá giả định, không phải
giá khớp. `mexc-fast-execution.ts` và `binance-futures.ts` ĐÃ trả về `dealAvgPrice`/`avgPrice` ở
đường đóng lệnh — thông tin có sẵn, chỉ là không được ghi lại.

**Hệ quả:** đại lượng có thể lấy đi 13-54% vốn là đại lượng duy nhất mà hệ không có một điểm dữ liệu
nào. Và nó rẻ để sửa.

**Việc cần làm (nhỏ, độc lập, không đụng luật):**
1. Ghi `realExit = avgPrice` của lệnh đóng vào journal, cạnh `exitPrice` tín hiệu.
2. Tính thêm `netR_real` dùng `realEntry`/`realExit` song song với `netR` tín hiệu.
3. Sau ~50 lệnh có phân phối trượt giá thật ⇒ mục 3 dưới đây tự có đáp án.

---

## 2. Câu hỏi sàn KHÔNG hề đóng — nó bị chấm sai trục

Audit 12/08 §5.3 kết luận "tách sàn MEXC chỉ tốn ~3% vốn ⇒ không đáng phá kiến trúc". Con số 3% đó
chấm bằng **PHÍ** (0,08% vs 0,05%). Nó không chứa trượt giá, mà MEXC có sổ mỏng hơn Binance.

`scripts/exp-stop-mechanics.ts r1`:

| cấu hình | vốn (×) | vs mốc |
|---|---:|---:|
| mốc, không trượt thêm | 18,06 | — |
| chỉ Turtle trượt 0,10×ATR | 16,12 | −11% |
| chỉ Fast trượt 0,10×ATR | 15,28 | −15% |
| cả hai trượt 0,10×ATR | 12,38 | −31% |
| **Turtle 0,10 · Fast 0,20** (MEXC mỏng gấp đôi) | **9,81** | **−46%** |
| ↑ nhưng Fast về phí+sổ Binance (0,10) | **13,21** | −27% |

Nếu MEXC thật sự trượt gấp đôi thì tách sàn tốn **(13,21−9,81)/13,21 = 26%**, không phải 3%. Chưa
chứng minh được vì chưa có số đo (mục 1) — nhưng "câu hỏi đóng lại" là một kết luận đã hết hiệu lực.

---

## 3. ỨNG VIÊN: hard stop XÁC NHẬN BẰNG CLOSE — đáp án phụ thuộc con số chưa đo

Đổi kích hoạt stop từ "chạm trong nến, khớp tại giá stop" sang "nến ĐÓNG vượt stop, khớp tại giá
close". Biến một fill không đo được thành một market order tại thời điểm biết trước — **đúng cơ chế
nhánh `mid` của LONG đang chạy live**, nên không thêm kiểu thực thi mới nào.

`scripts/exp-stop-mechanics.ts r2`, giả định fill của STOP_MARKET xấu **gấp 2×** market order hẹn trước:

| kịch bản (stop / close) | stop trong nến | stop xác nhận close | chênh | Sharpe | lỗ vị thế tệ nhất |
|---|---:|---:|---:|---|---:|
| 0 / 0 *(giả định đang dùng)* | **18,06×** | 15,20× | **−16%** | 1,53 → 1,46 | −2,5R → −4,5R |
| 0,05 / 0,025 | 15,20× | 13,89× | −9% | 1,49 → 1,43 | −2,6R → −4,5R |
| **0,10 / 0,05** | 11,69× | **12,16×** | **+4%** | 1,44 → 1,40 | −2,6R → −4,5R |
| 0,20 / 0,10 | 7,52× | **9,54×** | **+27%** | 1,34 → 1,35 | −2,8R → −4,6R |
| 0,50 / 0,25 | 3,10× | **5,22×** | **+68%** | 1,06 → 1,20 | −3,1R → −4,7R |

**Giao điểm ở ~0,07-0,10×ATR (20-28 bps).** Dưới ngưỡng đó stop-trong-nến thắng (nó thoát sớm hơn ở
giá tốt hơn); trên ngưỡng đó thua ngày càng nhiều. R6 nói môi trường thực tế gần như chắc chắn nằm
**trên** ngưỡng này.

**Cửa giả-OOS 4 pha nến** (`r4`, đã bật trượt giá 0,10/0,05):

| pha | ĐANG CHẠY | heat k=1 | stop-close | k=1 + stop-close |
|---|---:|---:|---:|---:|
| 0h | 11,21 | 14,95 | 11,60 | 13,86 |
| 1h | 7,58 | 10,30 | 8,52 | 10,62 |
| 2h | 7,57 | 9,69 | 8,34 | 10,82 |
| 3h | 5,43 | 6,48 | 7,50 | 8,79 |
| **TB** | **7,95** | **10,36** | **8,99** | **11,02** |

Cả hai ứng viên **thắng mốc ở 4/4 pha**.

**VẪN CHƯA ĐỦ ĐỂ SHIP**, ba lý do phải nói thẳng:
- Lỗ vị thế tệ nhất đi từ −2,5R lên **−4,5R** (gần gấp đôi rủi ro đuôi): bỏ chốt chặn trong nến thì
  một nến 4h có thể chạy hết trước khi mình phản ứng.
- Sharpe **giảm** ở hầu hết kịch bản kể cả nơi vốn tăng (1,44 → 1,40 tại giao điểm); era C và 365d
  đều xấu đi (2,83→2,66 · 1,07→1,02). Cái được là tiền, cái mất là hình dạng phân phối.
- Toàn bộ dấu của kết luận phụ thuộc một tham số **chưa có phép đo nào**.

⇒ Không ship. **Đo trước (mục 1), rồi trục này tự trả lời.** Nếu cần bản trung dung: giữ stop trên
sàn nhưng dời ra xa làm chốt chặn thảm hoạ, còn thoát chính bằng xác nhận close — chưa đo, ghi lại
làm ứng viên.

---

## 4. CÁI ĐƯỢC RÕ NHẤT: chính sách heat đang siết quá LỎNG (k=4 → k≈1)

Audit trước đề nghị ship "heat k=4 cho Fast" (+31%) và ghi nhận đường k đơn điệu 2→20. Vòng này quét
tiếp xuống dưới (`r3`, `w2`) — cả hai sleeve cùng k:

| k | risk/unit | vốn (×) | Sharpe | era A/B/C | 365d | WF TB | WF âm |
|---|---:|---:|---:|---|---:|---:|---:|
| ĐANG CHẠY (Turtle k4 · Fast TẮT) | 0,32% | 18,06 | 1,53 | 2,67/2,04/3,32 | 1,11 | 1,13 | 10/56 |
| 4 *(ứng viên đã chốt)* | 0,52% | 23,69 | 1,60 | 2,75/2,29/3,76 | 1,11 | 1,22 | 8/56 |
| 2 | 0,69% | 26,21 | 1,62 | 2,83/2,40/3,85 | 1,12 | 1,25 | 8/56 |
| **1** | **0,93%** | **28,70** | **1,65** | 2,93/2,51/3,90 | 1,13 | 1,28 | 8/56 |
| 0,5 | 1,24% | 30,87 | 1,67 | 3,02/2,63/3,89 | 1,14 | 1,33 | 6/56 |
| 0,25 | 1,68% | 33,84 | 1,69 | 3,15/2,79/3,85 | 1,17 | 1,37 | 5/56 |
| 0,15 | 2,08% | 36,19 | 1,70 | 3,27/2,93/3,78 | 1,19 | 1,40 | 2/56 |
| 0,1 | 2,39% | 35,35 | 1,70 | 3,29/2,99/3,60 | 1,21 | 1,43 | 1/56 |
| 0,05 | 2,78% | 27,85 | 1,67 | 3,09/2,94/3,06 | 1,23 | 1,44 | 0/56 |

Đỉnh ở k ≈ 0,10-0,15 (+100%). **Nhưng con số đó phần lớn là HIỆN VẬT** — xem mục 5.

Cơ chế thật thì đơn giản và là sách giáo khoa: corr TB cặp trong rổ 0,81 và corr chéo sleeve 0,954 ⇒
24 unit cùng hướng không phải 24 cược. Khi corr → 1, tổng risk theo hướng nên gần như **hằng số**.
`1/(1+heat/k)` với k nhỏ chính là cái đó. Audit trước đã thấy nửa đầu của kết luận này (`1/H` cho
22,96) nhưng chưa bao giờ chấm nó ở cấp **danh mục hai sleeve**.

**k có đổi khi bật trượt giá không? Không** — thứ tự giữ nguyên (đang chạy 11,69× · k=4 12,50× ·
k=2 13,58× · k=1 15,53× · k=0,5 19,16×).

---

## 5. ĐỐI CHỨNG bác bỏ con số "+100%": kết quả phụ thuộc THỨ TỰ MẢNG SYMBOL

`runBooks` duyệt symbol theo thứ tự mảng `CORE8`. Khi nhiều symbol phá vỡ **cùng một nến**, symbol
đứng trước gặp heat=0 (size đầy), symbol đứng sau nhận phần còn lại. Thang size cho các unit cùng
hướng liên tiếp:

| k | unit 1 / 2 / 3 / 4 |
|---|---|
| 4 | 1,00 / 0,80 / 0,69 / 0,62 |
| 1 | 1,00 / 0,50 / 0,40 / 0,34 |
| 0,25 | 1,00 / 0,20 / 0,17 / 0,15 |
| 0,1 | 1,00 / **0,09** / 0,08 / 0,08 |

Ở k=0,1, symbol đứng đầu lấy gần như toàn bộ vốn. Mà thứ tự đó là **BTC, ETH, SOL, XRP, DOGE, ADA,
AVAX, DOT** — một chi tiết cài đặt, không phải một luật. Chạy lại cùng luật, cùng k, chỉ đổi thứ tự
mảng (`r5`):

| k | CORE8 gốc | đảo ngược | xoay 4 | abc | **biên độ** | **worst case** |
|---|---:|---:|---:|---:|---:|---:|
| 4 | 23,69 | 21,69 | 22,63 | 22,33 | 9% | 21,69 |
| 2 | 26,21 | 22,67 | 24,57 | 23,96 | 16% | 22,67 |
| **1** | 28,70 | 23,94 | 27,46 | 26,43 | 20% | **23,94** |
| **0,5** | 30,87 | 25,57 | 29,46 | 28,36 | 21% | **25,57** |
| 0,25 | 33,84 | 24,09 | 30,73 | 28,51 | 40% | 24,09 |
| 0,1 | 35,35 | **20,99** | 30,43 | 27,81 | **68%** | 20,99 |

**Hai kết luận:**

1. **"+100% ở k=0,1" là hiện vật thứ tự.** Ở worst case nó cho 20,99× — **kém cả k=4**. Gradient đơn
   điệu biến mất khi không cho thứ tự mảng chọn người thắng.
2. **Nhưng k ∈ {0,5 ; 1} vẫn ĐỨNG VỮNG theo dạng bằng chứng mạnh nhất có thể:** worst case của
   chúng (23,94 / 25,57) vẫn **cao hơn best case của k=4** (23,69). Tức chúng thắng ở **mọi** thứ tự
   đã thử, không phải ở một.

**Và bản thân sự phụ thuộc thứ tự là một điểm yếu chưa từng ghi nhận.** Cách sửa đúng là phân bổ theo
trạng thái đầu nến cho các tín hiệu cùng nến thay vì tuần tự — đã kiểm ở vòng năm
(`turtle-fast-solutions-2026-08-12.md` §S3), và nó thắng.

> ⚠️ **SỬA 2026-08-12 (cùng ngày, sau khi chạy `exp-solutions.ts cmp`):** bảng trên chạy với **CẢ HAI**
> sleeve dưới heat k, tức nó đo cấu hình **ỨNG VIÊN**, không phải cấu hình đang chạy. Cấu hình LIVE
> hôm nay (Turtle k4 · Fast KHÔNG heat) chỉ lệch **2%** theo thứ tự, vì Fast nằm ngoài chính sách heat
> nên không góp phần nhạy cảm nào. Nói "kể cả ở k=4 đang chạy đã lệch 9%" là SAI.
>
> Cách đọc đúng, và nó mạnh hơn: phụ thuộc thứ tự **chưa phải vấn đề của live hôm nay**, nhưng nó trở
> thành vấn đề **ngay khi** đưa Fast vào heat và siết k — đúng hai việc đang được đề nghị. Nên bản phân
> bổ đầu nến là **điều kiện tiên quyết** của việc siết heat, không phải một bản vá cho lỗi hiện tại.

---

## 6. HAI TRỤC ĐÃ THỬ VÀ LOẠI (số liệu để đừng lặp lại)

### 6.1 Heat pool CHUNG hai sleeve — LOẠI, đối chứng đánh bại

Động cơ đúng: `decayH` đọc `sameDirHeat` từ `snapshotOpen()`, mà snapshot chỉ thấy các sổ trong CÙNG
một lời gọi `runBooks`. `exp-allocation.ts` gọi hai lần riêng ⇒ kể cả bản "Fast + heat k=4" thì mỗi
sleeve vẫn chỉ thấy heat của chính nó, dù corr chéo 0,954 và 91% unit trùng symbol+hướng.

| cấu hình | vốn (×) | vs đang chạy |
|---|---:|---:|
| ĐANG CHẠY | 18,06 | — |
| mỗi sleeve heat k4 RIÊNG *(ứng viên đã chốt)* | 23,69 | +31% |
| **POOL CHUNG k=4** | 24,26 | +34% |
| POOL CHUNG k=2 | 25,67 | +42% |
| *đối chứng:* separate k=3 | 24,69 | +37% |
| *đối chứng:* separate k=2 | **26,21** | **+45%** |

Pool chung ở k làm heat lớn ~2× ⇒ nó **chính là** "siết mạnh hơn". Phải so với separate ở k/2 — và khi
so đúng, **pool chung LUÔN kém hơn** (joint k=4 24,26 < separate k=3 24,69; joint k=2 25,67 <
separate k=2 26,21). ⇒ "Biết tương quan chéo sleeve" không mang thêm giá trị nào; toàn bộ lợi ích là
độ siết. Cùng một bài học §5.2 của audit trước, nay xác nhận trên trục khác.

### 6.2 Pyramid KHÔNG kéo hard stop chung — LOẠI, hành vi hiện tại đúng

Khi thêm unit ở nhánh `longExitMode="mid"`, engine kéo hard stop chung lên `max(pos.sl, initialSL)`.
Nghĩa là add unit làm **chặt** stop của cả vị thế, kể cả unit đầu đang có đệm dày. Chưa từng đo tách
bạch. (Chỉ ảnh hưởng LONG — short dùng chandelier.)

| cấu hình | vốn (×) | Sharpe | WF TB | WF âm | vs mốc |
|---|---:|---:|---:|---:|---:|
| danh mục: add kéo stop *(đang chạy)* | 18,06 | 1,53 | 1,13 | 10/56 | — |
| danh mục: add KHÔNG kéo stop | 16,52 | 1,51 | 1,12 | 10/56 | **−9%** |
| Turtle riêng: kéo stop | 22,45 | 1,59 | 1,23 | 8/56 | — |
| Turtle riêng: KHÔNG kéo | 17,52 | 1,58 | 1,25 | 5/56 | **−22%** |

Bỏ siết stop đẩy tỉ lệ thoát `mid` lên (Turtle 12%→19%, Fast 18%→27%) và mất tiền. Đúng dạng đánh
đổi "ổn định hơn, ít lợi nhuận hơn" như E3 của audit trước (WF nhúc nhích tốt lên, vốn giảm mạnh).
**Giữ nguyên.**

---

## 7. Trả lời thẳng: điểm yếu là gì và làm gì

**Điểm yếu, xếp theo độ lớn đo được:**

1. **Giả định khớp lệnh chưa ai kiểm tra, ở đúng nhánh mang tiền về.** 81-88% risk thoát qua stop;
   sổ SHORT 100%. Chỉ 14 bps trượt thêm = −13% vốn, 57 bps = −54%. Và 53-63% lần bị stop là râu nến
   quét, giá vượt stop 0,5-0,7×ATR trong nến kích hoạt ⇒ 14 bps là giả định rất lạc quan.
2. **Hệ không thể tự đo điều đó.** Exit journal ghi giá tín hiệu; `avgPrice` có sẵn ở đường đóng lệnh
   nhưng không được ghi. Entry có `realEntry` nhưng R không dùng.
3. **Chính sách heat siết quá lỏng** — k=4 bị k=1 và k=0,5 đánh bại ở MỌI thứ tự symbol đã thử.
4. **Phân bổ vốn phụ thuộc thứ tự mảng symbol** (9% ở k=4, 68% ở k=0,1).
5. **Kết luận "câu hỏi sàn đã đóng" hết hiệu lực** — nó được chấm bằng phí, không bằng trượt giá.

**Làm gì, theo thứ tự:**

1. **Bật lại bot.** Vẫn tắt từ 20/07 (23 ngày). Không có gì khác quan trọng bằng, và mọi phép đo dưới
   đây cần dòng lệnh thật để chạy. Nhớ xoá `turtle-state.json` cũ trước khi `up`.
2. **Ghi giá khớp thật ở chiều exit** (mục 1) — nhỏ, độc lập, không đụng luật, và nó là **điều kiện
   tiên quyết** cho quyết định ở mục 3 lẫn cho việc biết con số 18,06× thật là bao nhiêu.
3. **Siết heat k từ 4 xuống 1** (thận trọng) hoặc **0,5** (mạnh hơn), áp cho **cả hai** sleeve — thay
   vì chỉ "thêm heat k=4 cho Fast" như audit trước đề nghị. Bằng chứng: thắng k=4 ở mọi thứ tự
   symbol, thắng 4/4 pha nến, cả ba era tốt lên, WF âm 8/56 → 6/56.
   ⚠️ **Cái giá phải nói rõ:** risk/unit để giữ maxDD 30% đi từ 0,32% lên 0,93% (k=1) hoặc 1,24%
   (k=0,5) — tức tăng risk danh nghĩa mỗi unit ~3-4×, dù tổng risk theo hướng thì GIẢM. Đây là quyết
   định tiền thật, không phải một hằng số kỹ thuật.
4. **Chưa đổi cơ chế stop.** Chờ số đo ở bước 2. Nếu trượt giá thật > 0,07×ATR thì xác nhận-bằng-close
   thắng; nếu < thì không. Đừng đoán.
5. **Không đụng:** trọng số unit, mẫu số R, trần unit, bước pyramid, siết-stop-khi-add, rổ, tốc độ,
   gate — đã có số liệu loại ở vòng này hoặc ba vòng trước.

**Ghi nhận cho đúng:** vòng này không tìm được một luật vào/ra nào tốt hơn — giống ba vòng trước.
Nhưng nó tìm ra rằng **câu hỏi "luật nào tốt hơn" không còn là câu hỏi đắt nhất**. Đắt nhất là một
đại lượng mà hệ chưa có một điểm dữ liệu nào, và một hằng số risk đang đặt sai chỗ.

---

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 200          # chốt chặn
./node_modules/.bin/ts-node scripts/fast-live-parity.ts 200            # chốt chặn
./node_modules/.bin/ts-node scripts/exp-allocation.ts 2300 30          # baseline không đổi
./node_modules/.bin/ts-node scripts/exp-execution-risk.ts w1 2300 30   # mục 0
./node_modules/.bin/ts-node scripts/exp-execution-risk.ts w2 2300 30   # mục 6.1
./node_modules/.bin/ts-node scripts/exp-execution-risk.ts w3 2300 30   # mục 6.2
./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r1 2300 30   # mục 2
./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r2 2300 30   # mục 3
./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r3 2300 30   # mục 4
./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r5 2300 30   # mục 5
./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r6 2300 30   # mục 0.1
KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-stop-mechanics.ts r4 2300 30  # cửa 4 pha
```

Thay đổi engine vòng này (`scripts/portfolio-engine.ts`, `ExtParams`, tất cả mặc định `undefined`):
`slipTrailAtr`, `slipCloseAtr`, `pyramidTightensStop`, `stopOnCloseOnly`. Hai gate parity PASS sau
thay đổi.

## Giới hạn đã biết

- **Trượt giá là tham số đưa vào, không phải số đo.** Toàn bộ mục 0/2/3 là phân tích độ nhạy. Chúng
  cho biết hệ mong manh tới đâu và ngưỡng lật quyết định ở đâu — không cho biết ta đang ở phía nào
  của ngưỡng. Đó chính là lý do mục 1 là việc phải làm.
- Giả định "MEXC trượt gấp đôi Binance" (mục 2) là giả định, dựa trên độ sâu sổ, không có phép đo.
- Bốn thứ tự symbol ở mục 5 không phải một phép thử đầy đủ (8! = 40.320 thứ tự); chúng chỉ đủ để
  bác bỏ k=0,1 và để phát biểu dạng dominance cho k ∈ {0,5 ; 1}.
- maxDD là một quan sát cực trị nên nhiễu; mọi bảng đều kèm Sharpe + walk-forward 56 cửa sổ.
- Mọi ứng viên đều thử trên cùng bộ dữ liệu ⇒ chịu selection bias. Vì thế chỉ mục 4 được đề nghị
  (thắng ở mọi thứ tự VÀ mọi pha nến), còn mục 3 bị giữ lại chờ đo.
