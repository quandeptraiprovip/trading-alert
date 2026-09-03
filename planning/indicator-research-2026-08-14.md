# Nghiên cứu chỉ báo cho Turtle/Fast — 2026-08-14

Câu hỏi đặt ra: **cải tiến phương pháp đang chạy; nghiên cứu tài liệu về các chỉ báo, hiểu chúng đo
cái gì; áp dụng mà không overfit.**

Kết quả một câu (sau BỐN vòng): **79 luật chỉ báo dạng bộ lọc + 28 chiến lược mới dùng chỉ báo làm tín
hiệu chính + 4 cách gộp + 3 hướng tầng-rủi-ro — không có gì áp dụng được.** Hai con số quyết định:
luật-lọc thắng nhất cần ΔSharpe +0,63 để vượt hiệu chỉnh data-snooping mà chỉ đạt +0,030 (mục 7-8);
và không chiến lược mới nào đạt Sharpe của sổ đang chạy, trong khi **vào lệnh NGẪU NHIÊN với cùng bộ
máy thoát đã cho Sharpe tới 1,19** (mục 11) — tức edge nằm ở luật THOÁT, không ở luật VÀO.

**Vòng 5 (mục 12)** đào đúng luật thoát và tìm được gói mạnh nhất cả session — time-stop 30 ngày +
trail SHORT 2,0×ATR, Sharpe 1,345 → **1,769**, đậu holdout ba-cửa-vào và **4/4 pha nến**. Nhưng phân
rã theo năm giết nó: 98% phần cải thiện nằm ở **2021**, và nó cắt **−31,5R của năm 2026** (hơn nửa
năm hiện tại). **KHÔNG SHIP.**

Kết quả vòng 1: **ba hướng đo, ba kết quả null — nhưng lần này null có CƠ CHẾ và có ĐỐI CHỨNG, nên
chúng đóng lại cả một họ ý tưởng chứ không chỉ đóng lại ba ý tưởng.** Không có thay đổi nào được đề
xuất cho production.

---

## 1. Tài liệu nói gì — và vì sao nó dự đoán đúng kết quả null

### 1.1 Levine & Pedersen (2016), *Which Trend Is Your Friend?* (Financial Analysts Journal 72(3))

Chứng minh rằng time-series momentum, giao cắt trung bình động, breakout, bộ lọc Hodrick-Prescott,
bộ lọc Kalman — **và mọi bộ lọc tuyến tính khác** — là các biểu diễn TƯƠNG ĐƯƠNG của cùng một tín
hiệu, chỉ khác cách đặt trọng số lên giá quá khứ theo chân trời thời gian.

Hệ quả trực tiếp cho hệ này: Donchian close-channel + EMA50 **đã là** một bộ lọc tuyến tính. Thêm
ADX, RSI, Efficiency Ratio, MACD hay bất kỳ chỉ báo trend nào khác không phải là "thêm một góc nhìn"
— nó là **cùng một góc nhìn viết lại bằng trọng số khác**. Đây là lý do LÝ THUYẾT cho điều repo đã
kết luận bằng thực nghiệm từ trước (`planning/trend-method-remediation-research-2026-08.md`:
"không thêm ADX/ER/volume/retest/breakeven/time-stop").

Chỗ tài liệu nói còn dư địa **không nằm ở tầng tín hiệu mà ở tầng rủi ro**. Đó là hai bài dưới.

### 1.2 Baltas & Kosowski (2013), *Demystifying Time-Series Momentum Strategies* + Baltas (2015), *Trend-Following, Risk-Parity and the influence of Correlations*

Ba thành phần nâng cấp một hệ trend, không đụng tín hiệu:

| Thành phần | Nội dung | Kết quả công bố |
|---|---|---|
| Ước lượng biến động hiệu quả | Dùng Yang-Zhang thay vol close-to-close | giảm >⅓ turnover, hiệu suất không giảm có ý nghĩa |
| TREND rule | Size theo t-stat độ dốc thay vì dấu nhị phân | tăng risk-adjusted |
| Correlation factor | Đòn bẩy ∝ 1/√(1+(N−1)ρ̄), ρ̄ = tương quan cặp TB **có dấu** | Sharpe 1,31→1,48 toàn kỳ; 0,31→0,78 hậu 2008 |

Cả ba đều được đo trong vòng này (mục 2, 3, 4).

### 1.3 Ước lượng biến động: hiệu suất tương đối so với close-to-close

| Ước lượng | Hiệu suất | Dùng gì | Điểm yếu |
|---|---|---|---|
| Parkinson (1980) | ~5,2× | H, L | bỏ qua drift → **ước lượng thấp khi đang có trend** |
| Garman-Klass (1980) | ~7,4× | O,H,L,C | giả định drift = 0 |
| Rogers-Satchell (1991) | ~8× | O,H,L,C | **độc lập với drift** — đúng lý thuyết cho hệ trend |
| Yang-Zhang (2000) | ~14× | + gap qua đêm | lợi thế chính là gap, crypto 24/7 gần như không có |

### 1.4 Bối cảnh: trend nhanh đã chết ở nơi khác

*Is Trend Still Your Friend? A Microstructural Account* (arXiv 2607.01550) đo được tín hiệu trend
nhanh (5–20 ngày) sụp từ Sharpe ~0,84 xuống ~0,12 sau 2008/09, còn tín hiệu chậm (50 ngày) giữ ~0,40.
Cơ chế: HFT rút thanh khoản trước dòng lệnh CTA đoán được, và tác động này tàn phá hợp đồng
**tick nhỏ** chứ không phải tick lớn (biến phân loại là Ψ/σ — tick size chuẩn hoá theo biến động).

Đọc cho hệ này: đây là lý lẽ **chống** việc rút ngắn kênh vào để tăng tần suất, và là một biến số cần
theo dõi nếu sau này mở rộng sang sàn/tài sản khác.

---

## 2. Ứng viên 1 — Heat có tương quan (`scripts/exp-corr-heat.ts`)

### Vấn đề tìm thấy trong code live

`turtle-live.ts:167-190` chạy `w = 1/(1 + heat/k)` với `heat` = **tổng tỉ trọng unit đang mở cùng
hướng**. Comment ngay trên hàm giải thích cơ chế bằng tương quan ("rổ 8 large-cap crypto tương quan
~0,85"), nhưng công thức thì **không chứa tương quan** — nó ngầm định ρ = 1 cho mọi cặp, mọi thời
điểm, và bù bằng cách chỉnh tay `k`. Hai hệ quả: (a) không phân biệt chế độ tương quan cao/thấp,
(b) vị thế ngược hướng bị bỏ qua hoàn toàn dù nó thực sự làm phẳng danh mục.

**Tương quan thật của rổ (cửa sổ 90 ngày, 2021-02 → 2026-08):** trung bình **0,697**, p5 0,512,
trung vị 0,721, p95 0,851. Giả định ρ=1 sai một khoảng lớn và khoảng đó **thay đổi theo thời gian**.

### Hai dạng thay thế, cả hai chứa luật hiện tại làm trường hợp riêng

- `proj` : H = Σᵢ wᵢ·dᵢdc·ρ(sᵢ,sc) — đóng góp biên vào rủi ro danh mục
- `tot`  : H = √(Σᵢ Σⱼ wᵢwⱼ dᵢdⱼ ρ(sᵢ,sⱼ)) — tổng rủi ro danh mục, dạng Baltas

ρ ≡ 1 và mọi unit cùng hướng ⇒ cả hai về đúng Σw = heat hiện tại.

### Kết quả (CORE8, hai sleeve chạy chung, 2.000 ngày)

| biến thể | Sharpe | NET R | maxDD | NET/DD | era A/B/C | w TB |
|---|---|---|---|---|---|---|
| **BASE live (Σw, k=4)** | **1,35** | 838 | 98 | 8,54 | 0,69/1,38/1,81 | 0,438 |
| corr-proj L=90 | 1,32 | 955 | 107 | 8,93 | 0,68/1,37/1,79 | 0,489 |
| corr-tot L=90 | 1,33 | 872 | 101 | 8,65 | 0,67/1,38/1,80 | 0,449 |
| *đối chứng* const ρ=0,69 proj | 1,34 | 938 | 110 | 8,52 | 0,65/1,39/1,80 | 0,490 |
| *nhóm giả* hoán vị nhãn proj | 1,31 | 929 | 105 | 8,83 | 0,59/1,40/1,80 | 0,494 |

**LOẠI.** Sharpe giảm ở mọi biến thể, mọi k (0,5/1/2/4/8) và mọi cửa sổ ước lượng L (30…250).
NET R tăng chỉ vì ρ<1 làm heat nhỏ đi ⇒ size to hơn (w TB 0,438→0,489) — đó là **đòn bẩy, không phải
alpha**. NET/DD nhích lên nhưng **nhóm giả (hoán vị nhãn symbol) tái tạo gần hết mức nhích đó**
(8,83 vs 8,93), nghĩa là phần "biết cặp nào tương quan với cặp nào" đáng giá ~0.

**Cơ chế giải thích:** rổ CORE8 gần như ĐỒNG NHẤT về tương quan — mọi cặp đều ~0,7. Ma trận tương
quan của một rổ đồng nhất chỉ mang đúng MỘT con số (mức trung bình), và một con số thì hấp thụ được
hết vào `k`. Đối chứng `const ρ` chứng minh điều đó. Công thức Baltas thắng trên rổ 35 hợp đồng
**đa lớp tài sản** (trái phiếu vs năng lượng vs FX), nơi ma trận tương quan có cấu trúc thật.

> Kết luận rộng hơn: **mọi biến thể "phân bổ rủi ro theo tương quan" đều bị đóng lại** trên rổ crypto
> large-cap, cho tới khi rổ có nhóm tài sản thật sự khác nhau.

---

## 3. Ứng viên 2 — Ước lượng biến động thay ATR (`scripts/exp-vol-estimator.ts`)

ATR(20) không phải chỉ báo phụ: nó là **mẫu số R**. Nó định nghĩa stop 3×ATR (mẫu số R của Fast ở
*mọi* lệnh), biên chấp nhận stop cấu trúc 1,5–4×ATR, Chandelier của SHORT, và bước pyramid 0,5×ATR.

### Chỗ dễ đo sai, đã xử lý

Hằng số lý thuyết √(8/π) để lại **lệch thang 12–18%** trên nến 4h crypto (đuôi dày + bất đẳng thức
Jensen). Vòng đo đầu tiên vì thế cho Rogers-Satchell "thua 10,6%" — nhưng cột `stop%` cho thấy stop
đã rộng thêm 20% (7,97% → 9,58%), tức đang đo *stop rộng hơn*, thứ đã quét bằng `chandelierMult`.
Bản cuối chuẩn hoá thang bằng **cửa sổ mở rộng nhân quả** (không lookahead, không tham số tự do),
đưa mọi bản về ±0,7% cùng thang và `stop%` về 8,0–8,1% cho tất cả.

### Tầng 2 — sức dự báo (không liên quan lời lỗ)

| ước lượng | corr (đã khử mức coin) | bias(log) | **sd sai số** |
|---|---|---|---|
| ATR Wilder | 0,9392 | +0,0106 | **0,3333** |
| Parkinson | 0,9344 | +0,0020 | 0,3461 |
| Garman-Klass | 0,9326 | −0,0019 | 0,3504 |
| Rogers-Satchell | 0,9283 | −0,0102 | 0,3614 |
| Yang-Zhang | 0,9300 | −0,0070 | 0,3572 |
| close-to-close (ĐC âm) | 0,9336 | +0,0087 | 0,3507 |

Đích đo là "ATR thực hiện 20 nến sau" nên ATR có lợi thế sân nhà — đừng đọc bảng này như bằng chứng
ATR thắng. **Điều đáng đọc là mức tuyệt đối:** sai số dự báo ~0,33–0,36 (log) nghĩa là biến động 20
nến tới **không đoán được trong khoảng ±35%** với BẤT KỲ ước lượng nào. Chênh lệch giữa các ước
lượng (~8%) nhỏ hơn một bậc so với phần không đoán được.

### Tầng 3 — lời lỗ, thang đã chuẩn hoá

| ước lượng | Sharpe | NET R | maxDD | NET/DD | era A/B/C | stop% |
|---|---|---|---|---|---|---|
| **ATR Wilder (đang chạy)** | **1,35** | 838 | 98 | 8,54 | 0,69/1,38/1,81 | 7,97 |
| Parkinson | 1,34 | 813 | 101 | 8,03 | 0,71/1,37/1,79 | 8,11 |
| Garman-Klass | 1,32 | 820 | 99 | 8,30 | 0,68/1,33/1,80 | 8,04 |
| Rogers-Satchell | 1,31 | 823 | 104 | 7,94 | 0,72/1,31/1,77 | 8,04 |
| Yang-Zhang | 1,32 | 826 | 100 | 8,24 | 0,72/1,30/1,80 | 8,08 |
| **close-to-close (ĐC ÂM)** | **1,37** | 803 | 92 | 8,72 | 0,81/1,42/1,76 | 8,13 |

**LOẠI CẢ HỌ.** Ước lượng **tệ nhất về lý thuyết lại cho Sharpe cao nhất**, còn các ước lượng "hiệu
quả gấp 5–14 lần" đều thấp hơn baseline. Toàn bộ biên độ ±2,5% nằm trong nhiễu.

**Cơ chế:** hiệu suất ước lượng nói về việc đo biến động **hiện tại** chính xác hơn. Nhưng stop cần
biết biến động **tương lai suốt vòng đời lệnh**, và tầng 2 đo được rằng phần đó không đoán được ở mức
±35% — lớn gấp hơn 4 lần toàn bộ chênh lệch giữa các ước lượng. Cải thiện phép đo ở chỗ nhiễu chỉ
chiếm 1/4 tổng nhiễu thì không thể hiện ra ở kết quả.

---

## 4. Ứng viên 3 — Kiểm toán thông tin của 17 chỉ báo (`scripts/exp-indicator-info.ts`)

Thay vì "thêm chỉ báo → backtest → xem NET R" (mỗi lần thử là một lần rút thăm; đủ số lần sẽ luôn ra
một biến thể thắng), script này ghi giá trị chỉ báo **tại đúng thời điểm vào** của 3.982 unit mà hệ
THẬT SỰ đã mở, rồi hỏi một câu: chỉ báo có mang thông tin về netR không. Một lần thử, một bảng.

**Hai đối chứng nằm trong bảng.** [ĐC+] `atrPct` — repo đã đo hiệu ứng rất mạnh, bảng này phải thấy
lại. [ĐC−] `giờ UTC` và `số ngẫu nhiên` — không có cơ chế nào, chúng cho biết sàn nhiễu thật.

**Hai thống kê, vì chúng trả lời hai câu khác nhau.** netR của hệ có đuôi phải cực dày (1% số ngày
mang 68% lợi nhuận). Spearman chạy trên HẠNG ⇒ đo "dự báo tần suất thắng". Trung bình ngũ phân vị
⇒ đo "dự báo ĐỘ LỚN". `atrPct` là ca minh hoạ hoàn hảo: **ρ = −0,001** (không thông tin về tần suất)
nhưng **Q5−Q1 = −0,97R** (thông tin rất mạnh về độ lớn). Chỉ dùng Spearman là bỏ lọt đúng thứ ra tiền.

### Kết quả

| chỉ báo | ρ Spearman | Q5−Q1 netR | Q1→Q5 |
|---|---|---|---|
| [ĐC+] ATR%/giá lúc vào | −0,001 | **−0,97 ◆** | +1,02 +0,75 +0,85 +0,34 +0,05 |
| ATR / trung vị 90 nến | −0,026 | +1,07 | +0,09 +0,49 +0,29 +0,98 +1,16 |
| ADX(14) | +0,006 | −0,46 | +0,79 +0,41 +0,60 +0,88 +0,33 |
| Efficiency Ratio 20 | −0,007 | +0,63 | +0,35 +0,38 +0,55 +0,75 +0,98 |
| Efficiency Ratio 50 | −0,072 | −0,41 | +0,75 +0,65 +0,66 +0,62 +0,33 |
| t-stat độ dốc 50 (B&K) | **−0,102 ◆** | −0,79 | +0,99 +0,72 +0,32 +0,77 +0,21 |
| Variance Ratio q=5 | −0,024 | +0,28 | … |
| Variance Ratio q=10 | −0,052 | +0,38 | … |
| RSI(14) theo hướng | −0,026 | +0,16 | … |
| Skew 20 nến | +0,064 | +0,32 | … |
| Độ giãn khỏi EMA50 | −0,034 | −0,30 | … |
| Tuổi trend | −0,077 | −0,48 | … |
| log(volume/SMA20) | −0,019 | −0,14 | … |
| heat cùng hướng | −0,043 | +0,66 | … |
| số unit đang mở | −0,049 | +0,59 | … |
| tương quan TB rổ | +0,080 | +0,45 | … |
| pyramid hay lệnh mới | −0,021 | +0,80 | … |
| [ĐC−] giờ UTC | +0,032 | +0,08 | … |
| [ĐC−] **số ngẫu nhiên** | **−0,035 ◆** | +0,09 | … |

Sàn nhiễu từ đối chứng âm: |ρ| ≤ 0,035 · |Q5−Q1| ≤ 0,09R.

- Vượt cửa 95% (**chưa** chỉnh đa phép thử): `atrPct`, `tstat50`
- **Vượt cửa Bonferroni cho 19 phép thử: KHÔNG CÓ CHỈ BÁO NÀO**

**Đối chứng âm `số ngẫu nhiên` ĐẬU cửa 95%.** Đây là minh hoạ sống của vấn đề: với 19 phép thử, một
"phát hiện" mức 95% là chuyện PHẢI xảy ra. Bất kỳ ai chạy 19 ý tưởng chỉ báo rồi giữ lại cái p<0,05
đang làm đúng thao tác vừa tạo ra `rand` ở bảng này.

**Ghi chú về `t-stat độ dốc`:** đây là biến của TREND rule (Baltas & Kosowski) — và dấu đo được là
**ÂM**: vào lệnh khi xu hướng ĐÃ mạnh về mặt thống kê thì netR THẤP hơn. Ngược hẳn khuyến nghị của
bài báo. Không đủ mạnh để hành động (rớt Bonferroni), nhưng đủ để nói rằng **áp TREND rule theo chiều
bài báo đề xuất là sai hướng trên hệ này.**

---

## 5. Hai lỗi tìm được trong hạ tầng nghiên cứu

1. **`AdmitCtx.symbol` là KHOÁ SỔ, không phải mã coin** (`"btcusdt@t"` khi chạy hai sleeve), trong khi
   `OpenUnit.symbol` là mã thô. Tra bảng theo mã coin bằng trường này trượt hết về nhánh mặc định,
   **lặng lẽ**, tạo ra một kết quả "không đổi" trông hệt null thật. Vòng đo đầu của ứng viên 1 đã ra
   null giả vì lỗi này (100% lần tra ρ trả về fallback = 1). Bẫy này từng cắn ở `exp-floor-exact.ts`.
   → Đã thêm `AdmitCtx.rawSymbol` (luôn là mã thô) + cảnh báo trên trường cũ.

2. **Fallback im lặng khi chưa đủ lịch sử.** ρ trả 1 ở đầu mẫu làm một phần cửa sổ đánh giá chạy bằng
   luật CŨ mà bảng số không nói ra. → Đã thay bằng cửa sổ mở rộng + **bộ đếm biên phát hiện** in ra
   tỉ lệ fallback và cảnh báo nếu >5%.

> Bài học chung: mọi thí nghiệm dùng bảng tra theo symbol/thời gian phải in ra **tỉ lệ tra trượt**.
> Không có con số đó thì "không có gì thay đổi" và "code chưa bao giờ chạy" là hai thứ không phân biệt được.

---

## 6. Kết luận và việc KHÔNG nên làm tiếp

**Không có thay đổi nào được đề xuất cho production trong vòng này.**

Ba họ giải pháp bị đóng lại, kèm cơ chế nên kết luận có thể mở rộng chứ không chỉ đúng cho ba biến thể đã thử:

| Họ | Trạng thái | Cơ chế |
|---|---|---|
| Thêm chỉ báo trend (ADX/ER/RSI/MACD/…) | **LOẠI** | Levine-Pedersen: tương đương toán học với bộ lọc đang chạy. Đo lại: 0/17 vượt Bonferroni |
| Phân bổ rủi ro theo tương quan | **LOẠI trên rổ crypto** | rổ đồng nhất ⇒ ma trận tương quan chỉ mang 1 số ⇒ hấp thụ hết vào `k`. Nhóm giả tái tạo được |
| Ước lượng biến động hiệu quả hơn | **LOẠI** | biến động tương lai không đoán được ở ±35%, gấp >4× toàn bộ chênh lệch giữa các ước lượng |

**Điều được xác nhận lại một cách độc lập:** quét `k` trong vòng này cho Sharpe **đơn điệu tăng khi
siết k** — k=8 → 1,33 · k=4 (đang chạy) → 1,35 · k=2 → 1,36 · k=1 → 1,38 · k=0,5 → **1,40**, và cải
thiện ở **cả ba era** (0,69/1,38/1,81 → 0,78/1,44/1,83). Trùng khớp với kết luận đã có trong
`fast-heat-decay-ship.md` và `snap-allocation-verified.md`. Đây là thay đổi phương pháp duy nhất có
bằng chứng, và nó đã nằm sẵn trong hàng đợi — không cần nghiên cứu thêm, cần **ship**.

**Thứ tự ưu tiên thật, theo độ lớn tác động** (không có cái nào là "chỉ báo"):
1. Hệ đang **TẮT** — `system-off-and-scale-limit.md`. Uptime hơn tối ưu tham số hai bậc độ lớn.
2. Rò **min-notional** — `min-notional-leak.md`. Gộp hai sổ là đòn bẩy duy nhất không tăng rủi ro.
3. Siết `k` + snapshot cho **cả hai** sleeve (Fast live hiện không có chính sách heat nào).
4. Ensemble 4 pha nến — đã kiểm đủ cửa, chặn bởi vốn.

---

---

## 7. Vòng hai — MACD, EMA và 35 biến thể khác, dùng làm LUẬT VÀO LỆNH THẬT

Vòng 1 chỉ đo tương quan chỉ báo ↔ netR. Vòng này biến chỉ báo thành **bộ lọc chặn lệnh** trên đúng
hai sleeve đang chạy (`scripts/exp-classic-indicators.ts`), 37 biến thể: MACD (7), EMA (6), ADX (3),
RSI (3), Stochastic (2), CCI (2), MFI (1), Bollinger (3), SuperTrend (3), Ichimoku (2), OBV (1), kết
hợp (4).

**Nhóm giả bắt buộc:** mỗi biến thể được so với **9 bộ lọc NGẪU NHIÊN loại đi đúng cùng tỉ lệ lệnh**.
Lý do: mọi bộ lọc đều bỏ bớt lệnh, mà bỏ bớt lệnh tự nó đã đổi phương sai và đổi heat trung bình
(lệnh còn lại được size to hơn). Câu hỏi đúng không phải "MACD có làm Sharpe tăng không" mà "nó có
tăng nhiều hơn một bộ lọc VÔ NGHĨA cùng tỉ lệ không".

### Kết quả thô

Baseline Sharpe 1,345. **MACD là họ DUY NHẤT qua cả ba cửa**, và qua ở 5/6 biến thể tham số:

| bộ lọc | giữ% | Sharpe | Δ | NET/DD | era A/B/C |
|---|---|---|---|---|---|
| baseline | 100% | 1,35 | — | 8,54 | 0,69/1,38/1,81 |
| MACD hist cùng hướng | 97% | **1,38** | +0,03 | 8,83 | 0,70/1,43/1,84 |
| MACD line vượt signal | 97% | 1,38 | +0,03 | 8,83 | 0,70/1,43/1,84 |
| MACD hist (19,39,9) | 98% | 1,37 | +0,02 | 8,60 | 0,70/1,42/1,83 |
| MACD hist đang mở rộng | 95% | 1,37 | +0,02 | 8,94 | 0,67/1,41/1,86 |
| **MACD hist NGƯỢC (đối chứng đảo)** | 20% | **0,47** | −0,88 | 1,73 | 0,04/0,96/0,40 |

Ba dấu hiệu tích cực: có **plateau tham số** (5,13,5 / 12,26,9 / 19,39,9 cùng thắng), **cả ba era đều
tốt lên**, và **đối chứng đảo ngược sụp hoàn toàn** (Sharpe 0,47) — tức tín hiệu có chiều, không phải nhiễu.

Mọi họ khác THUA baseline: ADX≥25 → 1,23 · RSI 30-70 → 1,01 · Bollinger trong biên → 1,05 ·
Stochastic 20-80 → 0,94 · EMA50>EMA200 → 1,18 · SuperTrend → 1,34 · OBV → 1,32.
Đáng chú ý: `MACD + RSI` cho số liệu **giống hệt** `MACD` một mình ⇒ RSI đóng góp bằng 0, đúng như
Levine-Pedersen dự đoán.

### Nhưng: 37 biến thể trên cùng một bộ dữ liệu

Đây chính xác là tình huống của **Sullivan, Timmermann & White (1999)**, *Journal of Finance* 54(5):
họ mở rộng 26 luật của Brock-Lakonishok-LeBaron thành ~8.000 tham số hoá, chạy trên 100 năm Dow Jones,
và hỏi luật thắng có thật không. Họ trích Jensen & Bennington (1970) rất đúng chỗ:

> *"given enough computer time, we are sure that we can find a mechanical trading rule which 'works'
> on a table of random numbers — provided of course that we are allowed to test the rule on the same
> table of numbers which we used to discover the rule."*

Kết quả của họ, ba ý: (1) trên mẫu 1897–1986, luật tốt nhất VẪN vượt được sau hiệu chỉnh data-snooping;
(2) chính luật đó **THẤT BẠI ngoài mẫu 1987–1996** (p ≈ 0,12); (3) trên S&P 500 futures 13 năm,
**không luật nào** vượt nổi sau hiệu chỉnh.

### Áp đúng phép kiểm đó lên 37 biến thể (`scripts/exp-reality-check.ts`)

Bootstrap tĩnh (Politis & Romano 1994, khối trung bình 10 ngày — giữ tự tương quan P&L của hệ trend),
2.000 lần lặp, trên 2.001 ngày:

| cách đọc | p-value | kết luận |
|---|---|---|
| **NGÂY THƠ** — chỉ kiểm riêng luật thắng | **0,0230** | «có ý nghĩa» |
| **White's Reality Check** — max trên cả 37 luật | **0,9820** | KHÔNG có ý nghĩa |
| **Hansen SPA (2005)** — student hoá, loại 2 luật vô vọng | **0,3105** | KHÔNG có ý nghĩa |

- ΔSharpe cần đạt để p<0,05 theo RC: **+0,61**. Thực tế đạt: **+0,028** — kém 22 lần.
- Thống kê student hoá của luật thắng: t = 2,046. Một mình thì "có ý nghĩa"; giữa 37 luật thì không.
- SPA là phép công bằng nhất ở đây (RC mất lực vì rổ chứa đối chứng đảo có phương sai lớn), và SPA
  vẫn cho **p = 0,31**.

**KẾT LUẬN: MACD KHÔNG được áp dụng.** Cải thiện +0,028 Sharpe (2%) không phân biệt được với việc
đã bới qua 37 luật. Đây không phải "MACD vô dụng" — mà là "với dữ liệu đang có, không thể phân biệt
MACD với may mắn chọn lọc". Muốn kết luận khác thì cần dữ liệu mới, không phải phân tích lại dữ liệu cũ.

---

## 8. Trong các bài báo, chỉ báo được dùng NHƯ THẾ NÀO

Đây là phần đáng giá nhất của vòng nghiên cứu: **cách dùng của giới học thuật KHÁC HẲN cách dùng của
bán lẻ**, và khác đúng ở chỗ giải thích vì sao vòng test trên ra null.

| Bài báo | Chỉ báo được dùng làm gì |
|---|---|
| Brock, Lakonishok & LeBaron (1992) | MA làm **tín hiệu mua/bán ĐỘC LẬP** trên chỉ số DJIA — cách dùng "kinh điển", và là cách bị STW 1999 bác |
| Sullivan, Timmermann & White (1999) | ~8.000 luật, nhưng dùng để **đo chi phí data-snooping**, không phải để tìm luật tốt |
| Park & Irwin (2007), *J. Economic Surveys* — khảo sát 95 nghiên cứu hiện đại | 56 dương / 20 âm / 19 hỗn hợp; nhưng lợi nhuận **phần lớn biến mất sau phí giao dịch**, và chủ yếu chỉ tồn tại **tới đầu thập niên 1990** |
| **Neely, Rapach, Tu & Zhou (2014)**, *Management Science* 60(7) | **14 chỉ báo** (MA ngắn 1/2/3 tháng vs dài 9/12 tháng, momentum, on-balance volume) KHÔNG dùng làm luật giao dịch mà làm **BIẾN DỰ BÁO trong hồi quy phần bù rủi ro cổ phiếu**, gộp bằng **thành phần chính**. Sức dự báo ngang hoặc hơn biến vĩ mô, mạnh nhất trong suy thoái NBER |
| Han, Yang & Zhou (2013) | MA timing áp lên **danh mục đã sắp theo biến động**, tức chỉ báo là **biến sắp xếp chéo cấp danh mục**, không phải bộ lọc lệnh |
| Levine & Pedersen (2016) | Chứng minh mọi bộ lọc trend tuyến tính là **cùng một tín hiệu** |

**Ba điều rút ra, và cả ba đều áp thẳng vào hệ này:**

1. **Gần như không bài nào dùng chỉ báo làm BỘ LỌC CHỒNG LÊN một hệ trend đã có.** Chúng được dùng
   làm (a) chính tín hiệu, (b) biến dự báo trong hồi quy, (c) biến sắp xếp chéo. Chồng MACD lên
   Donchian+EMA50 đúng là cách dùng dư thừa mà Levine-Pedersen chỉ ra — và số liệu vòng này khớp:
   MACD lọc đúng 3% số lệnh, RSI thêm vào MACD đóng góp bằng 0.

2. **Cách dùng hiện đại là GỘP NHIỀU chỉ báo bằng thành phần chính, không phải chọn cái tốt nhất.**
   Neely et al. gộp 14 chỉ báo vì mỗi cái quá nhiễu để dùng riêng. Chọn-cái-tốt-nhất chính là thao
   tác STW 1999 chứng minh là không có giá trị ngoài mẫu.

3. **Sức mạnh của chỉ báo giảm dần theo thời gian và phần lớn chết vì phí** (Park & Irwin), khớp với
   *Is Trend Still Your Friend?* (arXiv 2607.01550): trend nhanh sụp từ Sharpe 0,84 xuống 0,12 sau 2008.
   Hệ này chạy trên khung ngày-tới-tuần, tức phía còn sống của phổ đó — nhưng đó là lý lẽ để KHÔNG
   rút ngắn kênh vào, không phải lý lẽ để thêm chỉ báo.

---

## 9. Vòng ba — 27 chỉ báo NỮA, và GỘP chúng lại (`scripts/exp-indicator-combos.ts`)

Vòng 2 chọn-cái-tốt-nhất và bị Reality Check bác. Vòng này làm theo cách tài liệu hiện đại thật sự
dùng: **gộp nhiều chỉ báo, không chọn cái nào** (Neely-Rapach-Tu-Zhou 2014 gộp 14 chỉ báo). Gộp đều
trọng số là kiểu kết hợp DUY NHẤT không có tham số tự do ⇒ miễn nhiễm data-snooping.

Thêm 27 chỉ báo chưa từng test: Aroon, Vortex, TRIX, PPO, TSI, CMO, Williams %R, Ultimate Oscillator,
Awesome Oscillator, KST, Coppock, Fisher Transform, DPO, RVI, Balance of Power, Hull MA, KAMA,
Elder Ray, Choppiness, VHF, R² trend, Mass Index, Chaikin MF, Force Index, Ease of Movement,
Squeeze (BB⊂KC), Donchian width.

### 9.1 Chỉ báo lẻ — ba nhóm kết quả rất khác nhau

| nhóm | kết quả | ví dụ |
|---|---|---|
| momentum | ≈ 0 (biên độ ±0,03) | PPO **+0,030** · Fisher +0,023 · TRIX −0,013 · Ultimate Osc −0,035 |
| **"chất lượng trend"** | **HẠI RÕ RỆT** | R² trend>0,5 **−0,287** · Mass Index **−0,170** · Choppiness −0,030 |
| **nén biến động** | **HẠI RẤT NẶNG** | Squeeze BB⊂KC **−0,518** (giữ 32% lệnh) · Donchian width −0,130 |
| volume | ≈ 0 | Force Index +0,003 · Chaikin MF −0,030 |

**PPO(12,26,9) cho +0,030 — cao nhất trong cả 79 luật.** Nhưng PPO **chính là MACD chia cho giá**, nên
đây không phải phát hiện thứ hai: nó là cùng một hiệu ứng đo lại, và trùng khớp độ lớn (+0,030 vs
+0,028). Cả 79 luật thực chất chỉ chứa MỘT hiệu ứng.

**Nhóm "chất lượng trend" hại một cách nhất quán** — và khớp với ba số đã đo độc lập ở mục 4:
t-stat độ dốc ρ=−0,102 · tuổi trend ρ=−0,077 · ER50 ρ=−0,072. Cùng một cơ chế: đòi hỏi xu hướng phải
"sạch/mạnh/đã xác lập" trước khi vào = vào MUỘN hơn. Hệ này ăn tiền ở breakout SỚM.

### 9.2 Gộp — bốn cách, kết quả

| cách gộp | giữ lệnh | ΔSharpe | NET/DD |
|---|---|---|---|
| vote TẤT CẢ 27, S ≥ −0,4 … +0,4 | **100% ở MỌI ngưỡng** | +0,000 … +0,003 | 8,47–8,54 |
| gộp riêng họ momentum (18) | 100% | ±0,002 | 8,46–8,54 |
| gộp riêng họ trendiness (4) | 83–99% | −0,031 … −0,214 | 6,25–8,26 |
| gộp riêng họ volume (3) | 100% | +0,000 | 8,54 |
| **size × (1+λ·S), KHÔNG chặn lệnh** | 100% | +0,008 → **+0,028** (λ 0,25→1,0) | **8,53–8,54 (PHẲNG)** |

Hai điều đáng đọc:

- **Bản vote giữ 100% lệnh ở MỌI ngưỡng** ⇒ nó không phải bộ lọc, nó là hàm hằng. Điểm gộp S gần như
  luôn ≈ +0,73 nên không ngưỡng nào cắt được gì.
- **Bản sizing tăng Sharpe đơn điệu theo λ nhưng NET/DD PHẲNG TUYỆT ĐỐI** (8,53 vs baseline 8,54),
  còn NET R tăng 838→1010. Hai thước bất biến đòn bẩy nói ngược nhau ⇒ đúng dấu hiệu của nhiễu, và
  phần NET R tăng là ĐÒN BẨY (S dương ⇒ nhân size lên).

### 9.3 Reality Check trên CẢ RỔ 79 luật

| cách đọc | 37 luật (vòng 2) | **79 luật (cả hai vòng)** |
|---|---|---|
| ngây thơ, chỉ luật thắng | 0,023 | **0,031** «có ý nghĩa» |
| White's Reality Check | 0,982 | **0,994** |
| Hansen SPA | 0,311 | **0,528** |

**Càng thử nhiều luật thì bằng chứng cho luật thắng càng YẾU** — SPA đi từ 0,31 lên 0,53 dù luật thắng
còn khá hơn một chút (+0,030 vs +0,028). Đó là toàn bộ nội dung của STW 1999, hiện ra bằng hai lần
chạy trên chính hệ này. Ngưỡng cần đạt: **+0,63**; đạt được: **+0,030**.

---

## 10. TRẢ LỜI TRỰC TIẾP: "nhiều chỉ báo có kết hợp được với nhau không?"

Đo bằng `scripts/exp-indicator-independence.ts` — số tín hiệu ĐỘC LẬP tương đương trong 27 chỉ báo,
tại đúng thời điểm hệ vào lệnh, kèm đối chứng trên nến ngẫu nhiên.

| | tại nến VÀO LỆNH | nến NGẪU NHIÊN (đối chứng) |
|---|---|---|
| tỉ lệ chỉ báo ủng hộ hướng lệnh | **86,7%** | 51,2% |
| tương quan cặp TB giữa các phiếu ρ̄ | **0,044** | 0,283 |
| **N_eff = N/(1+(N−1)ρ̄)** | **12,56** / 27 | 3,23 / 27 |
| thành phần chính đầu giải thích | 13,7% | **40,4%** |
| số PC cần cho 90% phương sai | 21 | 15 |

**Kết quả này SỬA giả thuyết ban đầu của tôi.** Tôi đã đoán các chỉ báo trùng nhau nặng nên gộp vô
nghĩa. Sai: tại nến vào lệnh chúng chỉ tương quan 0,044, tương đương **12,6 tín hiệu độc lập** —
tức về lý thuyết vẫn còn √12,6 = **3,5× khả năng giảm nhiễu**. Tiền đề của việc gộp KHÔNG chết về
mặt cấu trúc.

Vấn đề nằm ở chỗ khác, và cột đối chứng chỉ ra chính xác chỗ đó:

- Ở nến **ngẫu nhiên**, 27 chỉ báo có một **nhân tố chung rất mạnh** (PC1 = 40,4%, ρ̄ = 0,283, N_eff
  chỉ 3,2). Nói cách khác: nói chung thì chúng ĐÚNG LÀ gần như một tín hiệu — đúng như Levine-Pedersen.
- Nhưng ở nến **vào lệnh**, nhân tố chung đó biến mất (PC1 chỉ 13,7%) và 86,7% chỉ báo đã đồng thanh
  nói "có". ⇒ **Nhân tố chung của cả 27 chỉ báo chính là thứ mà Donchian + EMA50 ĐÃ trích xuất hết.**
  Phần còn lại là 12,6 chiều nhiễu riêng biệt — độc lập thật, nhưng không mang thông tin về kết quả
  (đúng như mọi bảng P&L ở mục 9).

Đây là câu trả lời chính xác cho câu hỏi: **kết hợp được, về mặt toán học. Nhưng không có gì để kết
hợp, vì phần thông tin dùng được đã bị luật vào lệnh hiện tại hấp thụ.** Và đó là kết luận mạnh hơn
"các chỉ báo trùng nhau" — nó định vị được thông tin đã đi đâu.

> Suy ra điều kiện để hướng này mở lại: chỉ khi có một chỉ báo mà tại nến breakout nó **KHÔNG** đồng ý
> với Donchian phần lớn thời gian (tỉ lệ đồng ý gần 50% chứ không phải 87%). Cả 27 cái vừa thử đều
> không phải. Đó là một tiêu chí sàng lọc RẺ cho mọi ý tưởng chỉ báo tương lai: đo tỉ lệ đồng ý trước,
> nếu nó ≥ 85% thì bỏ luôn, không cần backtest.

---

---

## 11. Vòng bốn — XÂY CHIẾN LƯỢC MỚI, CHỈ BÁO LÀ TÍN HIỆU VÀO LỆNH (`scripts/exp-indicator-strategy.ts`)

Ba vòng trước dùng chỉ báo làm **bộ lọc** chồng lên Donchian, và kết luận null có một phản biện mạnh:
tại nến breakout thì 86,7% chỉ báo đã đồng ý sẵn nên chúng không còn gì để nói. **Phản biện đó không
áp dụng khi chỉ báo TỰ NÓ là cái cò** — lúc đó nó vào lệnh ở chỗ khác, thời điểm khác. Đây cũng đúng
cách Brock-Lakonishok-LeBaron (1992) và phần lớn tài liệu dùng chúng.

Cài đặt: thêm hook `entrySignal` vào `portfolio-engine.ts` — thay ĐÚNG MỘT thứ (cái cò vào lệnh), giữ
nguyên toàn bộ bộ máy rủi ro đã audit (stop 3×ATR/cấu trúc, kênh thoát mid-close 20d, pyramid 0,5×ATR
≤3 unit, heat k=4, phí + funding, BTC gate). `portfolio-equivalence.ts` vẫn khớp 100% sau refactor.

### 11.1 ĐỐI CHỨNG QUAN TRỌNG NHẤT — vào lệnh NGẪU NHIÊN với cùng bộ máy thoát

| tần suất | vị thế | Sharpe (3 seed) | **TỐT NHẤT** |
|---|---|---|---|
| p=0,004 | 251 | 0,231 / 0,451 / 0,673 | 0,673 |
| p=0,01 | 654 | 0,621 / 0,628 / 0,862 | 0,862 |
| p=0,02 | 1.079 | 0,509 / 0,595 / **1,193** | **1,193** |
| p=0,05 | 2.023 | 0,756 / 0,804 / 0,903 | 0,903 |

**Vào lệnh HOÀN TOÀN NGẪU NHIÊN gắn vào bộ máy thoát này cho Sharpe tới 1,19.** Toàn bộ con số đó
đến từ luật THOÁT (trail midpoint kênh close 20d + pyramiding + BTC gate), không một chút nào từ tín
hiệu vào. Đây là mức sàn thật mà mọi "chiến lược chỉ báo" phải vượt — và biên độ giữa các seed
(0,51–1,19 ở cùng tần suất) cho biết sàn đó rất nhiễu.

> Đây là kết quả có giá trị độc lập với câu hỏi chỉ báo: **edge của hệ nằm ở luật THOÁT nhiều hơn ở
> luật VÀO.** Nó cũng giải thích vì sao mọi bộ lọc entry ba vòng trước đều ≈ 0.

### 11.2 Kết quả 28 chiến lược

| nhóm | Sharpe tốt nhất | corr với sổ hiện tại | nhận xét |
|---|---|---|---|
| giao cắt chỉ báo (16 bản) | Ichimoku **1,044** · Aroon 1,038 · Awesome 0,960 | 0,46–0,77 | **era B sụp** ở gần hết: MACD 0,50/−0,16/1,79 · SuperTrend 0,78/−0,23/1,69 |
| hồi về trung bình (5 bản) | CCI 0,498 · Bollinger-đảo 0,303 · **RSI −0,313** | **−0,22…0,25** | tương quan thấp THẬT, nhưng không có lợi nhuận để đa dạng hoá |
| phá biên Bollinger | 1,136 | **0,91** | trùng lặp gần hoàn toàn với Donchian |
| **GỘP 27 chỉ báo làm tín hiệu chính** | **1,272** (ngưỡng 0,7) | **0,90–0,93** | xem 11.3 |

**Không chiến lược nào đạt Sharpe của sổ đang chạy (1,345).** Chỉ 12/28 vượt sàn ngẫu nhiên, và bản
vượt nhiều nhất (1,04 vs sàn 0,90) vẫn nằm trong biên độ seed của chính sàn đó.

**Chỉ 1/28 làm TĂNG Sharpe danh mục gộp: CMO × 0, +0,017.** Với 28 lần thử, một ứng viên dương biên
+0,017 là đúng những gì ngẫu nhiên sinh ra.

### 11.3 Phát hiện ỦNG HỘ việc gộp — và vì sao nó vẫn không đủ

Đây là kết quả đáng chú ý nhất của vòng này, và nó **ngược chiều** với ba vòng trước:

| | Sharpe | era A/B/C | vị thế |
|---|---|---|---|
| chỉ báo LẺ, trung bình 16 bản giao cắt | ~0,85 | thường era B ≈ 0 hoặc ÂM | 1.100–3.400 |
| **GỘP 27 chỉ báo, ngưỡng 0,7** | **1,272** | **0,97/1,10/1,66 — đều cả ba** | 2.834 |
| sổ đang chạy (Donchian) | 1,345 | 0,69/1,38/1,81 | 1.918 |

**Việc gộp HOẠT ĐỘNG đúng như tài liệu dự đoán:** trung bình 27 chỉ báo cho tín hiệu tốt hơn hẳn bất
kỳ chỉ báo lẻ nào (1,27 vs ~0,85–1,04), và nó còn **sửa được sự bất ổn theo era** — chỉ báo lẻ sụp ở
era B, bản gộp thì đều cả ba. Đó chính là hiệu ứng giảm nhiễu theo √N của Neely-Rapach-Tu-Zhou.

Nhưng nó hội tụ về đâu? **Tương quan 0,90–0,93 với sổ Donchian đang chạy, Sharpe thấp hơn một chút
(1,27 vs 1,35), và giao dịch nhiều hơn 48% (2.834 vs 1.918 vị thế ⇒ phí cao hơn.)**

⇒ Đây là **Levine-Pedersen được chứng minh bằng thực nghiệm trên chính hệ này**: gộp tất cả bộ lọc
trend lại thì bạn hội tụ về *chính tín hiệu trend*, tức về đúng thứ Donchian đang làm — chỉ là bản
kém hơn một chút và đắt hơn. Không phải "gộp vô ích": gộp có tác dụng thật, nhưng **đích đến của nó
là chỗ hệ đang đứng rồi.**

### 11.4 Nhóm hồi-về-trung-bình: đa dạng hoá có thật, lợi nhuận không

Giả thuyết cấu trúc đúng: 5 chiến lược mean-reversion cho tương quan **−0,22 đến 0,25** — thấp đúng
như dự đoán, và thấp hơn nhiều so với tương quan 0,96 giữa Turtle và Fast. Nếu có edge thì đây sẽ là
sleeve thứ ba đáng giá nhất trong repo.

Nhưng cả 5 đều yếu hoặc âm (RSI **−0,313** · Stoch 0,244 · Bollinger-đảo 0,303 · Williams 0,244 ·
CCI 0,498), và không bản nào làm tăng Sharpe gộp. Kết luận: **hướng đa dạng hoá đúng, công cụ sai.**
Khớp với [[strategy-diversification-research]] (mean-reversion crypto thua sau phí) — nay có thêm bằng
chứng rằng vấn đề KHÔNG phải tương quan mà là expectancy.

---

---

## 12. Vòng năm — LUẬT THOÁT (`exp-exit-rules.ts` → `exp-exit-winners.ts` → `exp-exit-gates.ts`)

Vòng 4 chỉ ra chỗ đáng đào: vào lệnh ngẫu nhiên + bộ máy thoát này = Sharpe tới 1,19 ⇒ edge nằm ở
luật THOÁT. Vòng này đào đúng chỗ đó.

### 12.1 Công cụ mới — HOLDOUT TRONG KHÔNG GIAN TÍN HIỆU

Vấn đề khi quét luật thoát trên đúng tín hiệu vào đang chạy: cải thiện có thể là **tương tác** khớp
với đặc thù của breakout Donchian — overfit ở dạng khó thấy nhất vì nó không phải overfit tham số mà
là overfit *cặp* (vào, ra). Nên mỗi luật thoát được chấm trên ba tín hiệu vào khác hẳn nhau:
**REAL** (Donchian đang chạy) · **RANDOM** (p=0,02, ba seed, lấy trung vị) · **VOTE** (gộp 27 chỉ báo).
Một cải tiến thật phải tốt lên ở cả ba. Bổ sung cho holdout thời gian và lệch pha nến.

### 12.2 Bốn chiều chưa từng quét — hai qua, hai rớt

Đã quét trước đó thì không lặp: `longExitDays` 12–30d · exit-ratio · mid-cho-SHORT · `initialStopMult`
1,5–4,0 · maxUnits 1–6 · heat k 2–8.

| chiều mới | kết quả | REAL Δ | RANDOM Δ | VOTE Δ |
|---|---|---|---|---|
| E1 VỊ TRÍ mức thoát trong kênh (pct 0…0,8) | 0,5 đang chạy là tốt nhất | tất cả âm | — | — |
| **E2 trail SHORT tách khỏi mẫu số R** | **2,0×ATR qua ba cửa** | **+0,087** | +0,340 | +0,049 |
| E3 sàn trail cho LONG (mid + chandelier) | chỉ tốt ở REAL ⇒ tương tác | +0,023 (5×ATR) | +0,333 | **−0,177** |
| **E4 time-stop maxHoldDays** | **30 ngày qua ba cửa** | **+0,304** | +0,648 | +0,213 |
| E5 stop xác nhận bằng close (có trượt giá) | rớt REAL | −0,034 | +0,337 | +0,046 |

Kết hợp E2+E4 **cộng dồn**: Sharpe 1,345 → **1,769**, NET/DD 8,54 → 10,59, ba era 0,69/1,38/1,81 →
1,48/1,53/2,24. Có trượt giá thực tế vẫn giữ: 1,225 → 1,607.

### 12.3 Kiểm CƠ CHẾ — ra kết quả XẤU, và đó là chỗ phải dừng

Time-stop cắt ngắn thời gian giữ trong một hệ sống nhờ đuôi phải. Phân rã netR theo độ dài giữ lệnh
ở cấu hình gốc:

| giữ lệnh | %unit | tổng netR | netR/unit |
|---|---|---|---|
| 0–5 ngày | 77,5% | **−258,0** | −0,084 |
| 5–10 | 11,0% | +103,2 | +0,236 |
| 10–30 | 8,9% | +283,3 | +0,66…+1,39 |
| **30–40** | 1,7% | **+320,6** | **+4,71** |
| **40–60** | 0,9% | **+360,8** | **+10,31** |
| **>60** | 0,1% | +69,2 | +17,30 |

**Unit giữ ≥30 ngày là 2,7% số unit nhưng mang +750,6R = 89,6% tổng NET R.** Time-stop 30 ngày cắt
ĐÚNG chỗ toàn bộ tiền nằm. Ba giả thuyết, phân biệt bằng số:

| | GỐC | ỨNG VIÊN | thay đổi |
|---|---|---|---|
| NET R (tiền) | 837,8 | 937,5 | **+12%** |
| sd P&L ngày (rủi ro) | 5,933 | 5,050 | **−15%** |
| Sharpe | 1,345 | 1,769 | +32% |
| số vị thế | 1.918 | 2.355 | +23% |

⇒ **H1 (tái neo) và H2 (Sharpe mark-to-market) đều đúng một phần:** vị thế bị cắt được vào lại
(+23% vị thế) với stop neo lại ở giá hiện tại; và hơn nửa mức tăng Sharpe nằm ở MẪU SỐ (đường MTM
mượt hơn), không ở tử số. Sharpe +32% nhưng tiền chỉ +12% — **đây không phải "kiếm thêm 32%"**.

### 12.4 Hai cửa cuối: một ĐẬU, một RỚT ⇒ KHÔNG SHIP

**G1 lệch pha nến 4h — ĐẬU 4/4, biên độ lớn:**

| pha | GỐC Sharpe | ỨV Sharpe | Δ |
|---|---|---|---|
| 0h (đang chạy) | 1,348 | 1,772 | +0,424 |
| 1h | 1,244 | 1,754 | +0,510 |
| 2h | 1,132 | 1,581 | +0,449 |
| 3h | 1,176 | 1,629 | +0,454 |

**G2 tập trung theo năm — RỚT cả ba gói, theo HAI kiểu khác nhau:**

| gói | tổng chênh | 2021 | 2022 | 2023 | 2024 | 2025 | **2026** |
|---|---|---|---|---|---|---|---|
| A) chỉ time-stop 30 | +76,0R | **+78,0** | +0,0 | **−60,8** | +55,3 | +3,4 | +0,0 |
| B) chỉ trail SHORT 2,0 | +23,8R | +19,6 | −3,2 | +14,3 | +14,4 | +10,2 | **−31,5** |
| C) cả hai | +99,8R | **+97,6** | −3,2 | −46,5 | +69,7 | +13,7 | **−31,5** |

- **A rớt kiểu kinh điển:** 103% phần cải thiện nằm ở 2021, và nó **phá 2023 (−60,8R)**. Đúng dạng
  hiện vật một-giai-đoạn mà cửa tập trung được dựng ra để bắt (memory `year-concentration-test`).
- **B rớt kiểu KHÁC và nghiêm trọng hơn cho quyết định:** phần cải thiện phân bố khá đều (4/6 năm
  dương: +19,6/+14,3/+14,4/+10,2) — nhưng **2026 âm −31,5R, tức hơn HAI PHẦN BA năm hiện tại
  (gốc 56,0R → 24,5R)**. Đây là chế độ thị trường ta sắp giao dịch. Cơ chế khớp: memory
  `market-regime-2026` ghi follow-through SHORT 2026 là **62,5% — tốt nhất toàn mẫu**; siết trail
  short trong đúng chế độ mà short đang chạy tốt là cắt sớm chính những lệnh đang lãi.

**Quyết định: KHÔNG SHIP gói nào.** Một luật làm Sharpe +32% trên 5,5 năm nhưng cắt hơn nửa lợi nhuận
của năm hiện tại không phải cải tiến — nó là một cược vào việc 2021 sẽ lặp lại.

### 12.5 Thu hoạch dùng được từ vòng này

1. **Bản đồ tập trung ở cấp LỆNH** (mới): 2,7% unit giữ ≥30 ngày mang 89,6% NET R, còn 77,5% unit
   giữ 0–5 ngày mang **−258R**. Bổ sung cho con số đã biết ở cấp NGÀY (1% ngày = 68% lợi nhuận,
   memory `return-concentration-uptime`). Hệ quả vận hành: **uptime trong lúc đang giữ một trend dài
   là điều quan trọng nhất**, và mọi ý tưởng "cắt lệnh cho gọn" đều đang nhắm vào 2,7% unit đó.
2. **Holdout trong không gian tín hiệu** — công cụ mới, đã bắt được E3 và E5 (tốt ở REAL, âm ở VOTE).
3. **Đã thử ~130 biến thể trên cùng bộ dữ liệu qua năm vòng.** Bản thân việc tiếp tục tìm kiếm giờ là
   vấn đề: ngưỡng Reality Check tăng theo số biến thể đã thử. Dừng đúng lúc là một quyết định.

---

## Lệnh chạy lại

```bash
./node_modules/.bin/ts-node scripts/exp-corr-heat.ts 2000       # ứng viên 1 + đối chứng + nhóm giả
./node_modules/.bin/ts-node scripts/exp-vol-estimator.ts 2000   # ứng viên 2, 3 tầng đo
./node_modules/.bin/ts-node scripts/exp-indicator-info.ts 2000  # kiểm toán 17 chỉ báo + Bonferroni
./node_modules/.bin/ts-node scripts/exp-classic-indicators.ts 2000   # MACD/EMA/RSI/… làm LUẬT + nhóm giả
./node_modules/.bin/ts-node scripts/exp-reality-check.ts 2000 2000   # White RC + Hansen SPA trên 37 luật
./node_modules/.bin/ts-node scripts/exp-missed-window.ts 400         # 25 ngày tắt máy đáng bao nhiêu
./node_modules/.bin/ts-node scripts/exp-indicator-combos.ts 2000      # 27 chỉ báo nữa + 4 cách GỘP
./node_modules/.bin/ts-node scripts/exp-reality-check.ts 2000 2000 --all  # RC/SPA trên CẢ 79 luật
./node_modules/.bin/ts-node scripts/exp-indicator-independence.ts 2000    # N_eff: có bao nhiêu tín hiệu độc lập
./node_modules/.bin/ts-node scripts/exp-indicator-strategy.ts 2000    # 28 CHIẾN LƯỢC MỚI + đối chứng vào lệnh ngẫu nhiên
./node_modules/.bin/ts-node scripts/portfolio-equivalence.ts          # bất biến engine sau mỗi lần thêm hook
./node_modules/.bin/ts-node scripts/exp-exit-rules.ts 2000            # 5 chiều luật THOÁT + holdout ba-cửa-vào
./node_modules/.bin/ts-node scripts/exp-exit-winners.ts 2000          # cơ chế + plateau + trượt giá + kết hợp
./node_modules/.bin/ts-node scripts/exp-exit-gates.ts 2000            # lệch pha nến + tập trung theo năm
```

## Tài liệu tham khảo

- Levine & Pedersen (2016), *Which Trend Is Your Friend?*, Financial Analysts Journal 72(3) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2603731
- Baltas & Kosowski (2013), *Demystifying Time-Series Momentum Strategies: Volatility Estimators, Trading Rules and Pairwise Correlations* — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2140091
- Baltas (2015), *Trend-Following, Risk-Parity and the influence of Correlations*, in *Risk-Based and Factor Investing*
- Yang & Zhang (2000), *Drift-Independent Volatility Estimation Based on High, Low, Open, and Close Prices*, Journal of Business 73(3)
- Rogers & Satchell (1991); Garman & Klass (1980); Parkinson (1980)
- *Is Trend Still Your Friend? A Microstructural Account of the Demise of Short-Term Trend-Following* — https://arxiv.org/abs/2607.01550
- Sullivan, Timmermann & White (1999), *Data-Snooping, Technical Trading Rule Performance, and the Bootstrap*, Journal of Finance 54(5) — https://onlinelibrary.wiley.com/doi/10.1111/0022-1082.00163
- Brock, Lakonishok & LeBaron (1992), *Simple Technical Trading Rules and the Stochastic Properties of Stock Returns*, Journal of Finance 47(5)
- Park & Irwin (2007), *What Do We Know About the Profitability of Technical Analysis?*, Journal of Economic Surveys 21(4), 786-826
- Neely, Rapach, Tu & Zhou (2014), *Forecasting the Equity Risk Premium: The Role of Technical Indicators*, Management Science 60(7) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1787554
- Han, Yang & Zhou (2013), *A New Anomaly: The Cross-Sectional Profitability of Technical Analysis*
- Hansen (2005), *A Test for Superior Predictive Ability*, JBES 23(4) — bản cải tiến của Reality Check
- Politis & Romano (1994), *The Stationary Bootstrap*, JASA 89
- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio* — đã có trong repo, là lý do cột Bonferroni tồn tại
