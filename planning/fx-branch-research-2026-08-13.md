# Nhánh trade CẶP TIỀN — nghiên cứu đầy đủ, 13/08/2026

## Kết luận

**Không mở nhánh FX.** Sáu họ phương pháp khác nhau về cơ chế, 31 cấu hình khai báo trước khi
chạy, 22 năm dữ liệu broker thật, 11 cặp G10 + 6 cặp ngoại vi: không họ nào tìm được edge trên
cặp tiền. Hai thứ có vẻ dương đều chết vì TẬP TRUNG — trend chậm trên hàng hoá/chỉ số có **66% lợi
nhuận nằm trong đúng MỘT năm**, còn nhóm ngoại vi có **USDTRY chiếm 104% tổng** (5 đồng ngoại vi
còn lại cộng lại = −5R).

Giá trị của nghiên cứu này là chặn được một nhánh sắp lỗ, không phải mở ra một nhánh mới.

---

## 1. Hạ tầng đã dựng (dùng lại được)

| Thành phần | Nội dung |
|---|---|
| `fx/fetch-dukascopy.py` | Tải nến từ datafeed Dukascopy — broker THẬT, có cả BID và ASK ⇒ spread được **đo** chứ không giả định. 26 công cụ, 2004→2026 |
| `.cache/fx/*.json` | 7 major + 4 cross + vàng/bạc + 5 chỉ số + 3 năng lượng/đồng + 6 cặp ngoại vi, nến ngày; 3 major + vàng có nến giờ 22,5 năm; lãi suất 11 đồng tiền (FRED) |
| `fx/fx-data.ts` | Gộp nến theo **ngày giao dịch FX** (đóng 22:00 UTC = 17:00 New York), có tham số dịch mốc để chạy phép thử lệch pha nến |
| `fx/fx-transfer.ts` | Mô hình chi phí FX (spread đo được theo từng cặp + swap) cắm vào đúng engine danh mục đang chạy production |
| 10 script thí nghiệm | `fx-speed`, `fx-native`, `fx-carry`, `fx-reversion`, `fx-session`, `fx-exotic*`, `fx-barphase`, `fx-validate`/`fx-final`/`fx-defence` |

Hạ tầng này khiến mọi ý tưởng FX/CFD tương lai kiểm được trong vài phút, trên cùng cửa duyệt đã
dùng cho crypto.

### Ba cái bẫy đã gặp và xử lý

1. **Nến cuối tuần.** Dukascopy vẫn phát nến giờ khi thị trường đóng, volume 0, OHLC bằng nhau.
   Không lọc thì ~48 nến phẳng mỗi tuần bóp ATR và tạo tín hiệu phá kênh giả.
2. **Lỗi mạng bị nuốt** (đúng bẫy đã ghi trong `universe-expansion-rejected`). Một lỗi 503 làm mất
   trọn năm 2013 của XAUUSD — **đúng năm vàng sập 28%**, tức mất cú trend lớn nhất mẫu, mà không
   có thông báo nào. Đã thêm `--repair` (tự dò lỗ hổng > 5 ngày) và chuyển lỗi tải thành exception
   thay vì log im lặng.
3. **Swap hằng số là SAI với ngoại vi** (§8). Long USDTRY nghĩa là trả lãi suất TRY 20–35%/năm.
   Không tính theo chiều lệnh và theo thời điểm thì ngang giá lãi suất sẽ trông y hệt một edge.

### Một hiệu chỉnh phải nhớ khi so số FX với số crypto

`riskMetrics` của repo annualize Sharpe bằng √365. FX chỉ giao dịch ~252 ngày/năm, nên Sharpe thô
trên FX **bị thổi lên √(365/252) = 1,20 lần**. Mọi con số trong tài liệu này đã nhân 0,83 để so
được trực tiếp với Sharpe crypto.

---

## 2. Chuyển giao ZERO-TUNING: luật đang chạy tiền thật → cặp tiền

Chạy **đúng** cấu hình production (`vào 15d / thoát 20d / short 30d / pyramid ≤3 / heat k=4 /
EMA50 / ATR20`), chỉ đổi những thứ không có đối ứng ở FX: khung 4h→1d (vì FX đóng cửa cuối tuần,
"15 ngày" chỉ giữ nguyên nghĩa khi 1 nến = 1 ngày giao dịch), bỏ BTC gate (không có "BTC của FX",
và **không** thay bằng chỉ số khác — thay tức là đi tìm), chi phí sàn crypto → spread + swap.

| Rổ | unit | NET R | exp/unit | Sharpe | Sharpe A/B/C |
|---|---|---|---|---|---|
| FX7 (major USD) | 3423 | **−121** | −0,060 | −0,17 | −0,08 / −0,12 / −0,31 |
| FX11 (+4 cross) | 5461 | **−208** | −0,077 | −0,23 | −0,17 / −0,09 / −0,45 |
| Vàng + bạc | 900 | +88 | +0,120 | +0,25 | +0,14 / +0,24 / +0,38 |

10/23 năm dương trên FX7. Mọi ablation (bỏ heat-decay, bỏ pyramid, chỉ long, EMA8 thay EMA50,
chandelier hai chiều, stop 3×ATR thuần) đều vẫn âm — không phải một bộ phận hỏng, mà cả cách tiếp
cận không ăn.

---

## 3. Chi phí giết edge, hay không có edge? — câu hỏi phải trả lời trước mọi thứ khác

Quét **một** biến duy nhất (hệ số `s` kéo giãn đồng thời mọi tham số thời gian, giữ nguyên hình
dạng luật), dải khai báo trước `s ∈ {0,67; 1; 1,33; 2; 2,67; 4; 5,33; 8}`:

**FX7 — gross R theo tốc độ:** −30, −8, +20, +43, +67, −12, +7, −3 (chi phí 66–127R)

Gross dao động quanh 0 và **không đơn điệu** — s=2,67 cho +67R rồi s=4 quay lại −12R. Đó là hình
dạng của nhiễu, không phải của một edge. Kết luận: **không có gì để chi phí giết**. Mọi bàn luận
về broker rẻ hơn, spread tốt hơn, sàn khác… đều không liên quan.

---

## 4. TSMOM chuẩn — loại trừ khả năng "bộ máy stop phá edge"

Bộ máy Turtle có hai thứ literature về momentum tiền tệ không có: stop 3×ATR và tín hiệu phá kênh.
Trên tài sản biến động thấp, cả hai đều có thể tự tay huỷ một edge có thật. Nên chạy bản chuẩn
Moskowitz–Ooi–Pedersen: dấu lợi suất L tháng, vol-target, rebalance tháng, **không stop**.

| Rổ | GROSS Sharpe theo L = 1m / 3m / 6m / 12m | t-stat |
|---|---|---|
| FX7 | −0,14 / −0,01 / −0,01 / −0,06 | −0,68 … −0,04 |
| FX11 | −0,20 / +0,04 / +0,02 / +0,06 | −0,96 … +0,28 |
| Vàng+bạc | −0,27 / +0,03 / +0,25 / **+0,44** | tới **+2,07** |

Hai họ phương pháp khác hẳn nhau cho **cùng một câu trả lời**. Không phải lỗi stop.

---

## 5. Carry — nhân tố FX có bằng chứng học thuật mạnh nhất

Lãi suất liên ngân hàng 3 tháng (FRED) của 8 đồng tiền; long đồng lãi cao / short đồng lãi thấp,
vol-target, rebalance tháng. Điểm quyết định sống chết mà mô hình phải chứa: người bán lẻ **không**
nhận chênh lệch liên ngân hàng — broker ăn markup cả hai chiều.

| Markup mỗi chiều | annRet | Sharpe | t-stat | phần carry | phần tỉ giá |
|---|---|---|---|---|---|
| 0,0%/năm (không thực tế) | −0,5% | −0,09 | −0,44 | +1,5% | **−2,0%** |
| 1,0%/năm (bán lẻ điển hình) | −1,6% | −0,31 | −1,51 | +0,4% | −2,0% |
| 1,5%/năm | −2,2% | −0,42 | −2,05 | −0,2% | −2,0% |

Âm **ngay cả khi markup = 0**. Thu đều 1,5%/năm tiền lãi rồi trả lại 2,0%/năm qua tỉ giá — đúng
bản chất đã biết của carry (ăn từng thìa, trả cả bát). Giai đoạn 2004–2026 là đúng giai đoạn phần
bù carry G10 biến mất.

---

## 6. Hồi quy về trung bình — chiều ngược lại

"Major không trend" và "major hồi quy" là hai mệnh đề khác nhau. Lưới khai báo trước: z-score,
L ∈ {10, 20, 50} ngày × k ∈ {1,5; 2,0; 2,5}σ, vào ngược, thoát khi z về 0. **Không stop** — cố ý,
vì reversion mà cắt lỗ theo biến động thì tự cắt đúng lúc luận điểm đang đúng nhất; bỏ stop làm
kết quả ĐẸP HƠN thực tế.

9/9 tổ hợp: gross Sharpe từ −0,33 đến +0,18, mọi |t| < 1,7. Net đều âm.

**Đối chứng quan trọng:** cùng phép đo đó chạy trên vàng/bạc cho gross Sharpe **−0,47 (t = −2,30)**
— đúng ảnh gương của trend dương ở đó. Tức phép đo *có* khả năng phát hiện tín hiệu; nó chỉ không
tìm thấy gì ở cặp tiền.

---

## 7. Intraday theo phiên — họ mà người trade FX bán lẻ thật sự dùng

Phá vỡ biên độ phiên Á (22:00→07:00 UTC) trong cửa sổ London (07:00–12:00), stop = đầu kia biên
độ, thoát 21:00 UTC. 3 major, 22,5 năm nến giờ, lưới 2 (lọc biên độ) × 3 (target).

| Biến thể | lệnh | NET R | exp/lệnh | t-stat |
|---|---|---|---|---|
| không lọc · giữ tới 21h | 12 453 | −20 | **−0,0016** | −0,17 |
| không lọc · 1R | 12 453 | −247 | −0,0198 | −2,72 |
| Á ≤ 0,8×ATR · giữ tới 21h | 11 448 | −52 | −0,0046 | −0,45 |

**12.453 lệnh, expectancy −0,0016R.** Đây là mẫu lớn nhất trong cả nghiên cứu và cũng là số 0 sạch
nhất. Từng cặp: EURUSD +1R, GBPUSD −61R, USDJPY +40R — nhiễu thuần.

---

## 8. Cặp ngoại vi / EM — nơi carry và trend FX được cho là mạnh nhất

Phần bù carry trong literature chủ yếu là hiện tượng của đồng EM, và đó cũng là các cặp trend rõ
nhất. Không đo thì kết luận "cặp tiền không có edge" là nói quá. USDTRY / USDZAR / USDMXN,
2004–2025.

Chạy lần đầu cho kết quả rất mạnh — Sharpe 0,46–0,50, plateau ở cả 8 tốc độ. **Nhưng có một lỗi mô
hình phải sửa trước khi tin:** chi phí giữ lệnh đang là hằng số đối xứng 1,5%/năm. Điều đó hợp lý
với G10 (chênh lệch 0–4%) nhưng sai hoàn toàn ở đây. USDTRY tăng **+2987%** trong 22 năm chính là
lệnh "short lira", và giữ lệnh đó nghĩa là **trả lãi suất TRY** (trung bình ~20%/năm, hiện tại
35,5%) để nhận lãi suất USD (~2%). Đó không phải chi tiết kế toán — nó gần bằng toàn bộ mức tăng
của tỉ giá, đúng như ngang giá lãi suất có phòng hộ mô tả.

Tính lại swap **theo chiều lệnh và theo thời điểm** từ lãi suất thật:

| Tốc độ | NET R (swap hằng số) | carry thật | NET đúng | Sharpe |
|---|---|---|---|---|
| s=1 (vào 15d) | +244 | **−167** | +77 | 0,17 |
| s=4 (vào 60d) | +332 | −143 | +190 | 0,29 |
| s=5,33 (vào 80d) | +350 | −113 | +237 | 0,34 |

*(Cùng phép hiệu chỉnh trên 7 major biến các số dương biên thành âm — xác nhận lại kết luận §2.)*

Còn Sharpe ~0,3. Nhưng phép kiểm tập trung kết thúc câu chuyện:

| | Đóng góp |
|---|---|
| USDTRY | **+192R = 108% tổng** |
| USDMXN | +8R = 4% |
| USDZAR | **−23R = −13%** |
| **Bỏ USDTRY ra** | **−15R** trên 320 unit |

Toàn bộ kết quả là **một công cụ duy nhất**.

Câu hỏi còn lại: đó là hiệu ứng của cả LỚP tài sản ngoại vi, hay chỉ riêng Thổ Nhĩ Kỳ? Mở rộng
sang 6 đồng (thêm USDNOK, USDSEK, USDPLN — ngoại vi lãi suất thấp):

| | Đóng góp |
|---|---|
| USDTRY | +147R = **104%** tổng |
| USDSEK | +41R |
| USDNOK | +1R · USDMXN −4R · USDZAR −20R · USDPLN −23R |
| **5 đồng KHÔNG phải lira, cộng lại** | **−5R** |

Không phải hiệu ứng lớp tài sản. Đây là một vị thế vĩ mô đơn lẻ — cược vào việc chính sách tiền tệ
Thổ Nhĩ Kỳ tiếp tục rối loạn. Không đa dạng hoá được (n=1), và điều kiện thực thi tệ nhất đúng vào
lúc nó kiếm tiền: 08/2018 và 11–12/2021 spread giãn nhiều lần, margin bị nâng, một số broker ngừng
nhận lệnh ngoại vi. Kết quả có bền với stress chi phí (còn +56R ở spread ×5 và markup 5%/năm)
nhưng điều đó không cứu được một mẫu n=1.

---

## 9. Cái sống sót — và vì sao vẫn bị loại

Trend **chậm** (s=4: vào 60 ngày / thoát 80 ngày, kênh vào sát System 2 của Turtle gốc) trên rổ 10
công cụ hàng hoá + chỉ số đậu **toàn bộ** cửa duyệt tiêu chuẩn:

- nhiễu tham số ±25%: **16/16** biến thể vẫn dương
- bỏ từng công cụ: **10/10** vẫn dương
- holdout hai nửa thời gian: cả hai dương
- Sharpe cả ba era đều dương (0,08 / 0,17 / 0,16)
- tương quan với mua-và-giữ chỉ 0,15 ⇒ **không** phải beta đội lốt

Rồi một phép kiểm cuối làm nó gãy:

| Rổ | NET R | năm tốt nhất | % tổng lãi | Bỏ năm đó ra |
|---|---|---|---|---|
| 10 công cụ (2014–2025) | +89R | 2025: +59R | **66%** | +30R/11 năm = 2,8R/năm, maxDD 61R |
| kim loại+WTI (2004–2025) | +140R | 2025: +77R | **55%** | +62R/21 năm = 3,0R/năm, maxDD 56R |
| chỉ số (OOS) | +6R | 2017: +19R | 287% | **−12R** |

Hai năm tốt nhất chiếm 96% lợi nhuận rổ 10. Mọi cửa duyệt ở trên đều đậu **vì tất cả chúng đều bao
gồm 2025** — đợt tăng của vàng. Đây chính xác là loại kết quả trông vững trong backtest rồi làm
người ta thất vọng sau khi vào tiền thật.

Thêm hai điểm bất lợi: Sharpe 0,14 so với **1,36–1,65** của hệ crypto đang chạy (đo cùng cách), và
**mua-và-giữ vol-target thắng chiến lược** trên chính rổ đó (Sharpe 0,54 vs 0,14).

---

## 9. Vì sao crypto khác

Không phải vì luật, mà vì tài sản. Biên độ ngày của major là 0,43–1,02% giá; của BTC/alt là 3–6%.
Cùng một luật trend cần biên độ để phủ chi phí và để winner đủ lớn bù cho 30% tỉ lệ thắng. Đó cũng
là lý do mọi chương trình managed-futures đều kiếm tiền chủ yếu ở hàng hoá và ít nhất ở tiền tệ —
nghiên cứu này chỉ xác nhận một điều ngành đã biết, trên đúng dữ liệu và đúng chi phí của mình.

---

## 10. Lệch pha nến — kiểm chính KẾT LUẬN ÂM

Toàn bộ phân tích khung ngày dùng nến Dukascopy mốc 00:00 UTC. Nhưng quy ước ngày của ngành FX là
đóng lúc **22:00 UTC (17:00 New York)** — đó mới là nến hiện trên MT5. Nếu kết quả đổi dấu khi dịch
mốc vài giờ thì mọi kết luận trên chỉ là hiện vật của một quy ước dữ liệu. Dựng lại nến ngày từ
nến giờ ở 6 mốc (`fx/fx-barphase.ts`), NET R / Sharpe:

| Luật / rổ | 0h | 4h | 8h | 12h | 18h | 22h | |
|---|---|---|---|---|---|---|---|
| 3 major, s=1 | −45 | −58 | −56 | −62 | −38 | −23 | **âm 6/6** |
| 3 major, s=4 | +4 | −6 | −16 | −21 | −20 | +11 | **đổi dấu** |
| Vàng, s=1 | +37 | +41 | +66 | +73 | +57 | +37 | **dương 6/6** |
| Vàng, s=4 | +116 | +99 | +83 | +90 | +134 | +117 | **dương 6/6** |

Ba điều rút ra:
1. Kết luận "major âm ở tốc độ production" **không** phụ thuộc mốc chia nến — âm ở cả 6 pha.
2. Ở tốc độ chậm, major **đổi dấu theo mốc nến**. Đó chính xác là hình dạng của nhiễu: dấu do một
   quy ước tuỳ ý quyết định, không phải do thị trường.
3. Đối chứng dương hoạt động — vàng dương ở cả 6 pha, và mốc FX thật (22h) cho kết quả gần như
   trùng mốc 0h đã dùng suốt nghiên cứu (117 vs 116R), nên lựa chọn dữ liệu không làm lệch gì.

Vẫn nên nhớ: biên độ 83…134R của vàng ở s=4 là **61% chênh lệch chỉ do mốc nến** — cùng bậc với
157% từng đo trên crypto. Mọi ước lượng điểm trong tài liệu này phải đọc như một khoảng, không phải
một con số.

---

## 11. Cái CHƯA test (ranh giới của kết luận)

Kết luận "cặp tiền không có edge" chỉ đúng trong phạm vi đã đo:

- **Đã đo:** trend (8 tốc độ), TSMOM (4 lookback), carry (4 mức markup), reversion (9 tổ hợp),
  intraday phiên (6 tổ hợp) — trên 11 cặp G10 và 6 cặp ngoại vi, khung ngày và khung giờ, và mọi
  kết luận khung ngày đã được kiểm lại ở 6 mốc chia nến khác nhau (§10).
- **Chưa đo:** dưới khung giờ (tick/M5/M15), order-flow và dữ liệu độ sâu sổ lệnh, phương pháp
  theo tin/sự kiện, quyền chọn FX, và các hướng học máy. Không có tiên nghiệm nào cho thấy chúng
  sẽ khác, nhưng đó là chỗ kết luận này chưa vươn tới.

---

## 12. Khuyến nghị

1. **Không mở nhánh FX.** Với $513 vốn, tách sang venue thứ hai còn thêm ràng buộc min-notional
   (xem `min-notional-feasibility`) trong khi đổi lại một Sharpe 0,14 phụ thuộc một năm.
2. **Giữ hạ tầng.** Dữ liệu và script ở lại repo; ý tưởng FX/CFD sau này kiểm được ngay trên cùng
   cửa duyệt.
3. **Đã bổ sung PHÉP KIỂM TẬP TRUNG vào cửa duyệt chung** (`scripts/exp-concentration.ts`), và đã
   chạy lên hệ crypto đang có tiền thật:

   | Sổ | năm tốt nhất | công cụ lớn nhất | hồi phục* | |
   |---|---|---|---|---|
   | **Turtle CORE8 — tiền thật** | 2024: 47% | doge 18% | **0,86** | ✅ (sát ngưỡng) |
   | Fast CORE8 (shadow) | 2024: 42% | avax 20% | 0,91 | ✅ |
   | FX rổ 10 hàng hoá+chỉ số | 2025: 66% | XAUUSD 115% | 0,05 | ❌ |
   | FX kim loại+WTI | 2025: 55% | XAUUSD 92% | 0,05 | ❌ |
   | FX 6 đồng ngoại vi | 2014: 28% | USDTRY 95% | 0,12 | ❌ |

   *hồi phục = R/năm sau khi bỏ năm tốt nhất, chia maxDD. Hệ crypto **hơn 17 lần** mọi rổ FX trên
   chỉ số này, dù rổ FX kim loại có Sharpe 0,17 không quá xa. Đó chính là lý do phải đo tập trung
   chứ không chỉ đọc Sharpe.

   Nói thẳng cả phần bất lợi: Turtle đậu nhưng **sát ngưỡng** (47%, hai năm tốt nhất = 71%) và mẫu
   chỉ 6 năm.

4. **Bài học phương pháp lớn nhất của vòng này:** perturbation, leave-one-out, holdout và
   era-split **đều đậu** trên một kết quả mà 66% lợi nhuận nằm trong một năm — bởi vì cả bốn phép
   đều tính cả năm đó. Chúng đo độ bền của luật, không đo lợi nhuận dồn vào đâu.

   Chính công cụ mới cũng mắc hai lỗi ở bản đầu và đã sửa, ghi lại để không lặp: ngưỡng công cụ
   100% quá lỏng (cho ĐẬU rổ mà USDTRY chiếm 95%), và khi NET âm thì mọi tỉ lệ % đổi dấu khiến một
   sổ đang LỖ được chấm ĐẬU. Nay ngưỡng là 50% cho cả hai chiều, và NET ≤ 0 trả "không áp dụng".
