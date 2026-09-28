# Đề xuất: đọc "dấu chân cá mập" bằng Open Interest thay vì volume nến — kèm protocol khoá trước

Ngày viết: 28/09/2026. Trạng thái: **ĐỀ XUẤT, CHƯA CHẠY.** Chưa có dòng nào của phần kết quả được nhìn.
File này là bản đăng ký trước. Mọi giả thuyết, ngưỡng và cửa dưới đây phải được chốt TRƯỚC khi tải
dữ liệu OI. Nếu sửa sau khi đã thấy số thì phép thử mất giá trị.

---

## 0. Tóm tắt

1. **"Gần đây toàn thua" phần lớn không phải do luật bị overfit.** Phần bị overfit là **kỳ vọng**:
   rổ CORE8 chọn theo hindsight, bot chạy đúng pha nến may nhất, và v4 nằm trên đỉnh tham số nhọn.
   Edge trend vẫn có thật (DSR 0,987). Khoản âm nằm ở sổ LONG trong regime 2026. Bot đã **tắt 70 ngày**.
2. **Không nên tìm luật mới trên dữ liệu giá 2021–2026 nữa.** Đã thử khoảng 130 biến thể qua 5 vòng.
   MinBTL cho thấy dữ liệu chỉ vừa đủ cho N≈500 phép thử. Luật nào tìm thêm trên cùng dữ liệu này đều
   không tách được khỏi may mắn.
3. **Volume nến không cho biết cá mập đang vào hay ra.** Một hợp đồng khớp luôn gồm một bên mua và một
   bên bán. Nến volume đột biến có thể là cá mập mở vị thế, cá mập chốt lời hoặc đám đông bị thanh lý.
   Vì thế mệnh đề Key đo ra 0 ở mọi phiên bản. Riêng hợp đồng vĩnh cửu crypto có công bố chính thứ đó:
   **Open Interest (OI)**. OI tăng nghĩa là có vị thế mới được mở, OI giảm nghĩa là vị thế đang bị đóng.
   **Repo chưa từng đo OI.** OI chỉ được dùng làm bộ lọc thanh khoản trong `alt-trend.ts`.
4. **Đề xuất:** không thêm luật vào lệnh hay luật thoát mới. Gắn **nhãn định danh** (OI tăng/giảm,
   funding đông/vắng) cho (A) từng Key Volume và (B) từng breakout của Turtle. Sau đó kiểm **3 giả thuyết
   đăng ký trước**, dùng lại đúng hai bàn thử đã có và các cửa đậu đã chốt từ trước. Rớt thì đóng cả họ.
   Không được nới cửa sổ hay ngưỡng để cứu.

---

## 1. Chẩn đoán: thua gần đây có phải overfit không?

| Nghi vấn | Bằng chứng trong repo | Kết luận |
|---|---|---|
| Luật trend bị overfit | DSR **0,987** ở N=2000 phép thử (`exp-deflated-sharpe.ts`); bootstrap P(Sharpe≤0) = **0,2%**; placebo test | Edge **có thật** |
| Kỳ vọng bị thổi phồng | Sharpe CORE8 1,58 so với rổ chọn point-in-time **1,2–1,4** và rổ 8 coin ngẫu nhiên **0,88**; pha 0h đang chạy là pha **may nhất trong 4** (vốn chênh 157% chỉ vì mốc nến); v4 chỉ **44%** biến thể ±15% giữ được ≥80% kết quả | **Đúng — đây là chỗ overfit thật** |
| "Gần đây toàn thua" | Live chỉ có **3 lệnh** thoát, cả 3 −1R (26/06–04/07). Với WR 30–40%, 3 lệnh thua liên tiếp xảy ra ~22–34% thời gian. Bot **tắt từ 20/07** (docker không chạy). Backtest 365 ngày Turtle v4 vẫn **+28,7R** (đo 12/08) | Mẫu quá nhỏ và hệ đang tắt |
| Vì sao 2026 yếu | Sổ LONG âm, SHORT gánh. Follow-through breakout LONG 2026 = **40,7%**, tệ nhất mẫu. VR(20) = 0,87 (thị trường quay đầu) | **Regime**, đo bằng thước không phụ thuộc chiến lược |
| Key Volume thua | Mệnh đề gốc null qua **4 vòng** (FX + crypto, H1 + M15). **Mức GIẢ cho kết quả bằng hoặc hơn key thật.** Code và 6 lệnh tay trùng **0/6**. Phí M15 BTC = **0,246R/lệnh** | Không phải overfit. Khâu Key **chưa từng có edge đo được** |

Hệ quả: đừng vá luật theo 12 tháng gần nhất ([[upgrades-vs-trailing-year]]). Hãy hạ kỳ vọng về Sharpe
khoảng 1,0–1,4, và coi năm chop cho **10–25%/năm** là bình thường (2022: +10%, 2025: +25%).

---

## 2. Vì sao volume nến không đọc được dấu chân cá mập

Mỗi đơn vị volume luôn có một bên mua và một bên bán. Nến volume gấp 4 lần trung vị chỉ cho biết
**có nhiều trao đổi**, không cho biết ai mở hay đóng vị thế, và ai chủ động. FX Dream dạy phương pháp
trên FX và vàng, nơi chỉ có tick volume, nên không có cách nào phân biệt các trường hợp này.

Hợp đồng vĩnh cửu Binance công bố ba lớp mà nến không có:

| Dữ liệu | Ý nghĩa | Nguồn (đã kiểm 28/09) |
|---|---|---|
| `sum_open_interest` (đơn vị coin, không phải USD) | Tổng vị thế đang mở. **Tăng = có vị thế mới, giảm = vị thế đang đóng hoặc bị thanh lý** | `data.binance.vision/data/futures/um/daily/metrics/`, mỗi file 288 dòng × 5 phút. Cả 8 coin CORE8 có dữ liệu **từ 01/12/2021**; BTC từ 09/2020 |
| `sum_toptrader_long_short_ratio` | Tỉ lệ long/short theo vị thế của **top 20% tài khoản có số dư ký quỹ lớn nhất**. Đây là cá mập theo định nghĩa của Binance, **không** phải "người giỏi nhất" | cùng file |
| `sum_taker_long_short_vol_ratio` + `takerBuyVolume` trong kline | Phe nào chủ động khớp lệnh | cùng file và kline |
| funding rate | Chi phí giữ vị thế, đo độ đông của một phía | `fapi/v1/fundingRate` từ 2020 |

Bảng giải mã một nến volume đột biến, viết bằng từ vựng FX Dream:

| Nến volume đột biến | Giá | OI | Cách đọc |
|---|---|---|---|
| | tăng | **tăng** | Có tiền mới mở long. Đây là "Key thật": có người **đang xây vị thế** và có lý do bảo vệ mức đó |
| | giảm | **tăng** | Có tiền mới mở short |
| | tăng | **giảm** | Short bị đóng hoặc bị ép thanh lý. Không có tiền mới |
| | giảm | **giảm** | Long bị thanh lý. Đây là cú **quét thanh khoản** thật |

Những gì đã thử và **không** lặp lại ở đây (`planning/independent-strategy-research-2026-08.md`):
funding dùng làm chiến lược đánh ngược độc lập (**−90R**), basis sort chéo (**−662R**), order flow
quarter-hour trên 5m (**−113…−249R**), absorption theo delta (có dấu vết nhưng không giao dịch được).
Tất cả đều là **chiến lược độc lập có stop sát**, nên chết vì phí. Đề xuất này khác ở chỗ OI và funding
chỉ được dùng làm **nhãn** trên các điểm vào đã có sẵn. Không thêm lệnh, stop hay tần suất nào.

---

## 3. Ba giả thuyết đăng ký trước

Bonferroni cho 3 giả thuyết xác nhận: α = 0,05/3 = **0,0167**, tức z ≥ **2,39**.
Mọi phép đo khác chỉ mang tính mô tả, không được dùng để ra quyết định.

### A1 — "Key có định danh" (giả thuyết chính, đúng trọng tâm Key Volume)

- **Bàn thử:** dùng nguyên `scripts/exp-key-premise-m15.ts` (Cửa 2) và `scripts/exp-key-barrier-m15.ts`
  (Cửa 3). Giữ M15, 8 coin, bậc R0/R4/R5loc, ngưỡng spike 2×/6×/12×.
- **Biến mới duy nhất:** ΔOI của nến tạo key = OI(snapshot 5 phút tại đóng nến) − OI(tại mở nến).
  Nhãn **MỞ** nếu ΔOI > 0, **ĐÓNG** nếu ΔOI < 0. ΔOI = 0 hoặc thiếu thì loại và **đếm lại**.
  Tách theo dấu nên không có ngưỡng để tinh chỉnh.
- **Đối chứng đi qua CÙNG bộ tách:** nhóm `normal` và `syn` cũng được tách MỞ/ĐÓNG theo ΔOI của chính
  nến của chúng. Nếu nhóm thường có OI tăng cũng phản ứng như vậy thì hiệu ứng là của OI, không phải
  của Key.
- **Giả thuyết (một phía):** key MỞ có phản ứng bật lại lớn hơn nhóm syn MỞ.
- **Cửa đậu dùng lại đúng số đã chốt 28/08, không đặt ngưỡng mới:**
  - Cửa 2: `spike_MỞ − syn_MỞ > 0,246 ATR` và biên phát hiện 95% < 0,05 ATR.
  - Cửa 3: `WR_keyMỞ ≥ 1,246 × WR_random` **và** `WR_keyMỞ > WR_synMỞ` vượt ngoài biên.
- **Mô tả, không phải cửa:** key ĐÓNG có "đi tiếp" không. Crypto sweep từng cho t = −1,76. Kết quả này
  được in ra nhưng không được biến thành chiến lược đi-tiếp ([[keyvol-key-premise-null]] đã giải thích
  vì sao).
- **Ước lượng trước:** trung bình gộp hiện tại gần 0 (−0,004 ATR). Muốn A1 đậu thì nhóm MỞ phải đạt
  ≥ +0,25 ATR, tức nhóm ĐÓNG phải khoảng −0,25 ATR. **Khả năng đậu thấp.** Giá trị của phép thử là
  đóng nốt phản bác cuối cùng: "volume nến mơ hồ, cần biết ai tạo ra nó".

### B1 — Breakout có tiền mới hay chỉ là short-covering (Turtle)

- Gắn nhãn cho mỗi **vị thế** Turtle live-params (không phải unit): ΔOI tính bằng OI đơn vị coin trên
  **đúng cửa sổ kênh vào lệnh của phía đó**. Không thêm cửa sổ mới.
- **Hai phía, vì có hai lý thuyết ngược nhau.** "Tiền mới thì trend bền" (kinh nghiệm futures cổ điển)
  đối lập với "đòn bẩy dồn thì dễ sập" (BIS WP 1087). Không có cơ sở để chọn trước một chiều.

### B2 — LONG khi funding đông (một phía, hướng lấy từ tài liệu)

- Chỉ áp cho **sổ LONG**, là sổ đang âm. Funding trung bình trên cửa sổ kênh vào lệnh, xếp hạng
  phân vị trong phân phối 365 ngày **trước đó** của chính symbol (nhân quả, không nhìn trước).
- **Giả thuyết:** LONG ở tercile funding cao nhất có kết quả tệ hơn tercile thấp nhất. Hướng này lấy từ
  Schmeling–Schrimpf–Todorov, *Crypto Carry*: carry cao dự báo sập giá.

### Kết cục của B1/B2, chốt trước vì đuôi quá dày

Đo trên baseline, không có nhãn (script tạm, đã xoá), Turtle live-params, CORE8, từ 01/12/2021:

| | vị thế | TB netR | sd | biên phát hiện chênh 50/50 |
|---|---:|---:|---:|---:|
| LONG | 312 | 1,18R | **8,21** | **±1,82R** (lớn hơn cả kỳ vọng) |
| SHORT | 596 | 0,23R | 1,84 | ±0,30R |

| kết cục nhị phân (gộp 908 vị thế) | tỉ lệ | phần NET mang theo | biên phát hiện 50/50 |
|---|---:|---:|---:|
| giữ ≥ 30 ngày | 1,5% (14) | 84% | ±1,6 điểm % |
| **net vị thế ≥ +3R** | **7,0% (64)** | **144%** | **±3,3 điểm %** |

- **64/908 vị thế mang 144% lợi nhuận ròng. 93% còn lại cộng lại thì lỗ.** Một bộ lọc vào lệnh chỉ có giá
  trị nếu tìm ra 64 vị thế này. So trung bình netR thì hoàn toàn không đủ lực. Đây cũng là lời giải thích
  vì sao mọi bộ lọc entry trước đây đều cho kết quả gần 0.
- **Kết cục chính:** P(net vị thế ≥ +3R). **Kết cục phụ:** TB netR, in kèm biên phát hiện, chỉ cần
  cùng dấu.
- **Vũ trụ chính:** top-30 perp theo thanh khoản point-in-time tại 01/12/2021 (theo luật của
  `exp-liquidity-universe.ts`), có dữ liệu metrics. Kỳ vọng n cao hơn khoảng 4 lần, biên phát hiện
  khoảng ±1,7 điểm %. **CORE8 là vũ trụ phụ**, chỉ cần cùng dấu.
  CORE8 riêng chỉ phát hiện được thay đổi khoảng ≥50% tương đối.

---

## 4. Các cửa, theo thứ tự. Rớt một cửa là dừng

**Cửa 0 — trước khi nhìn bất kỳ kết cục nào**
- Tải metrics và **in bộ đếm tra trượt**: tỉ lệ key/vị thế thiếu OI phải < 5%.
- Cân bằng nhãn: mỗi nhãn chiếm ≥ 15%. Nếu ≥ 85% breakout cùng một nhãn thì không có gì để lọc; bỏ,
  không backtest (quy tắc sàng lọc rẻ trong [[indicator-families-rejected]]).
- In biên phát hiện tính từ số lượng nhãn. Nếu biên > hiệu ứng tối thiểu có ý nghĩa thì ghi "không đủ
  lực" và dừng. **Không được đổi định nghĩa để tăng n.**

**Cửa 1 — tiền đề, chạy một lần**
- Hiệu ứng đúng hướng đăng ký, z ≥ 2,39 theo bootstrap khối tháng.
- **Nhãn ngẫu nhiên cùng tỉ lệ** (1000 lần rút): hiệu ứng thật phải vượt phân vị 99.
- **Nhãn GIẢ:** chuỗi OI của chính symbol dời +365 ngày. Hiệu ứng giả phải < ½ hiệu ứng thật.
- **Kiểm nhiễu động lượng:** OI tăng có thể chỉ phản ánh giá đã chạy mạnh. Chia tercile theo |lợi suất
  giá trên cùng cửa sổ|; hiệu ứng phải cùng dấu ở ≥ 2/3 tầng.

**Cửa 2 — độ vững (chỉ kiểm, không dùng để chọn)**
- 4 pha nến (`exp-bar-phase.ts`) đều cùng dấu. Không năm nào mang > 50% hiệu ứng (`exp-concentration.ts`).
  Hai nửa kỳ cùng dấu. CORE8 cùng dấu với vũ trụ chính.

**Cửa 3 — chỉ một cách cài đặt, khai báo sẵn**
- A1 đậu thì chỉ thêm nhãn MỞ/ĐÓNG làm **hiển thị** trên chart Key Volume (xem §5). Không tự động
  vào lệnh cho tới khi có cửa 4.
- B1/B2 đậu thì vị thế mang nhãn xấu **giảm size ×0,5**. Không bỏ hẳn, để giữ độ lồi và tránh bỏ lỡ
  một trong số ít vị thế lớn. So với placebo "×0,5 ngẫu nhiên cùng tỉ lệ" trên Sharpe và NET/DD, sau đó
  chạy `exp-reality-check.ts` trên cả 3 giả thuyết.

**Cửa 4 — forward, bắt buộc trước khi dùng tiền thật**
- Bot chỉ **ghi nhãn** vào journal ở mỗi lệnh thật, trong ≥ 4 tháng. Không đổi size. Chỉ bật khi chiều
  hiệu ứng forward trùng backtest.

**Luật dừng:** rớt bất kỳ cửa nào thì đóng họ OI/positioning và ghi vào memory. **Không** thử cửa sổ
khác, ngưỡng khác hay tổ hợp OI × taker × top-trader. Tổ hợp chính là cách 130 biến thể trước biến
thành nhiễu.

---

## 5. Cho phương pháp Key Volume đánh tay

Code đã chứng minh không bắt chước được tay (0/6), nên phần này hỗ trợ cách đánh tay chứ không thay nó:

1. **Nhãn OI trên chart** (`chart-keyvolume.ts`), chỉ hiển thị. Mỗi nến key ghi "MỞ vị thế +x% OI" hoặc
   "ĐÓNG/thanh lý −x% OI", kèm phe taker chủ động. Người đọc chart biết cá mập vào hay ra, thứ mà volume
   nến không nói được. Không có tham số nào bị fit.
2. **Đăng ký trước các lệnh tay.** Vẽ key, entry, SL, TP **trước** khi giá chạy (`createdAt` < entry).
   6 nhãn hiện có đều vẽ sau sự kiện nên không dùng làm bằng chứng được. Có **20–30 lệnh đăng ký
   trước** là đủ để lần đầu đo được phương pháp tay, bao gồm cả câu "key MỞ có tốt hơn key ĐÓNG không".
3. **Sàn chi phí:** BTC perp M15 cần WR ≥ 1,25 lần ngẫu nhiên chỉ để hoà vốn; vàng chỉ cần 1,14 lần.
   Nếu đánh tay trên M15 thì vàng dễ hơn 1,8 lần ([[tight-stop-cost-floor]]).

---

## 6. Việc không có tham số, làm TRƯỚC mọi nghiên cứu

1. **Bot tắt 70 ngày** (nến cuối 20/07/2026 08:00 UTC). Lỡ đúng cửa sổ 24 ngày tốt nhất thì mất khoảng
   8 lần lợi nhuận của cả 365 ngày gần nhất ([[return-concentration-uptime]]). Uptime quan trọng hơn mọi luật mới. Khởi động
   lại theo quy trình an toàn trong [[system-off-and-scale-limit]]: đối soát sàn, xử lý state và vị thế
   ma DOT của Fast, rồi mới bật `TRADING_ENABLED`.
2. **Ship phân bổ snapshot** ([[snap-allocation-verified]]). Đã qua đủ các cửa, không có tham số mới.
3. **Không revert v4 và không tinh chỉnh v4 thêm** ([[upgrades-vs-trailing-year]]).

---

## 7. Đề xuất này KHÔNG hứa gì

- Khả năng cao cả ba giả thuyết đều rớt, giống phần lớn lịch sử repo. Nếu vậy thì kết quả là **đóng
  được một họ dữ liệu mới bằng 3 phép thử**, thay vì 130.
- Dữ liệu OI bắt đầu từ 12/2021, nên không có 2021, năm từng mang 98–103% phần cải thiện của vài đề
  xuất cũ. Đây là điểm lợi cho độ sạch, nhưng mẫu ngắn hơn.
- Metrics là của riêng Binance. Chỉ số top-trader theo định nghĩa của Binance (số dư ký quỹ), không
  phải "người thắng". Dữ liệu này không chuyển sang FX hay vàng được.
- Khâu Volume Profile M5 (HVN/LVN) của FX Dream vẫn **chưa từng được đo**, vì cần aggTrades. Chi phí
  cao, để sau và chỉ làm nếu A1 dương.

## Nguồn

- Schmeling, Schrimpf, Todorov — *Crypto Carry*, BIS WP 1087: https://www.bis.org/publ/work1087.pdf
- Kim, Hansen — *The Quarter-Hour Effect*: https://arxiv.org/abs/2607.09426
- Binance — định nghĩa Top Trader Long/Short Ratio:
  https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Top-Trader-Long-Short-Ratio
- Dữ liệu metrics: https://data.binance.vision/?prefix=data/futures/um/daily/metrics/
