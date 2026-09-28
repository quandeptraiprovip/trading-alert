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

---

## Phụ lục 1 — làm rõ TRƯỚC khi tải dữ liệu OI (28/09, sau commit `8dbfadd`, trước mọi lần tải metrics)

Các điểm dưới đây bản gốc chưa nói rõ. Chúng được chốt khi CHƯA có dòng dữ liệu OI nào trên máy.

**A1**
- Cấu hình cố định đúng như lần chạy 28/08, **không** lấy theo `KEY_VOLUME_CONFIG` hiện tại. Bản hiện
  tại đã đổi `volumeLookback` 96→12 và `volumeSpikeMult` 2→4 sau ngày 01/09. Cố định: trung vị
  **96 nến**, `keyTouchAtr` 0,2, `keyMaxAgeDays` 180, FWD 12, **400 ngày**, CORE8, ngưỡng 2×/6×/12×.
  Cửa 2 dùng R0/R4/R5loc, Cửa 3 dùng R0/R4.
- ΔOI của nến M15 = OI(snapshot tại openTime + 15 phút) − OI(snapshot tại openTime), lấy trên lưới
  5 phút. Thiếu snapshot hoặc ΔOI = 0 thì loại và **in số bị loại**.
- **Tiêu chí đậu A1:** có ít nhất một ô (ngưỡng, bậc) đậu **cả hai** cửa.
  - Cửa 2: `spike_MỞ − syn_MỞ − biên > 0,246 ATR`. Biên dùng **z = 2,39** (Bonferroni), không dùng 1,96.
  - Cửa 3 cùng ô: `WR_MỞ / WR_random ≥ 1,246` và `WR_MỞ − ci > WR_synMỞ + ci`.

**B1/B2**
- R của vị thế = tổng `netR` các unit với **trọng số 1**. Nhãn là thuộc tính của lệnh, còn heat là
  phép co giãn cấp danh mục; với rổ 30 coin, heat làm trọng số méo không liên quan tới nhãn.
- Vũ trụ chính = luật `buildLiquidityUniverse` (top-**30**, trung vị quoteVolume 90 ngày, tái cân bằng
  30 ngày) trên `POOL46`, chỉ tính vị thế vào từ **01/12/2021**. `loadPool` phải báo 0 symbol lỗi, nếu
  không thì dừng.
- OI dùng snapshot 5 phút có `create_time` ≤ giờ đóng nến vào lệnh, và snapshot ≤ (giờ đó − cửa sổ).
  Cửa sổ LONG = 15 ngày, SHORT = 30 ngày (`T.entryDays`, `T.shortEntryDays`).
- B2: funding quy về đơn vị 8 giờ (rate × 8 / khoảng giờ giữa hai kỳ thanh toán). Lấy trung bình trên
  cửa sổ 15 ngày trước giờ vào lệnh. Phân vị của nó so với chuỗi trung bình-15-ngày tính tại mỗi kỳ
  funding trong 365 ngày trước đó. Đông = phân vị ≥ 2/3, vắng = phân vị < 1/3.
- **Thống kê:** D = P(net ≥ +3R | nhãn A) − P(net ≥ +3R | nhãn B).
  - Bootstrap 2.000 lần theo khối **tháng dương lịch của giờ vào lệnh**; z = D / sd_bootstrap.
  - B1 hai phía: |z| ≥ 2,39. B2 một phía: z ≤ −2,39.
- **Nhãn ngẫu nhiên:** hoán vị nhãn 1.000 lần, giữ nguyên số lượng. |D| thật phải vượt phân vị 99 của
  |D_hoán vị| (B2: D thật dưới phân vị 1).
- **Nhãn giả:** OI/funding dời **−365 ngày**; nếu thiếu dữ liệu thì dời +365. Yêu cầu |D_giả| < ½|D thật|.
- **Nhiễu động lượng:** chia tercile theo |ln(close lúc vào / close lúc bắt đầu cửa sổ)|. D phải cùng dấu
  ở ≥ 2/3 tầng.
- **Chỉ cần cùng dấu:** TB netR và CORE8.

**Thứ tự chạy:** Cửa 0 (chỉ in số lượng nhãn, số thiếu, biên phát hiện; KHÔNG in kết cục) trước, rồi
mới Cửa 1. Không sửa gì giữa hai bước, trừ khi Cửa 0 báo lỗi dữ liệu.

---

## KẾT QUẢ — 28/09/2026 (chạy đúng một lần sau hai commit khoá `8dbfadd`, `4e20545`)

Công cụ: `scripts/oi-metrics.ts` (tải/cache metrics + funding), `scripts/exp-oi-key-premise.ts` (A1),
`scripts/exp-oi-breakout.ts` (B1/B2). Mỗi script có hai chế độ `gate0` (chỉ đếm) và `gate1`.

### Phán quyết: RỚT 3/3. Đóng họ OI/funding/positioning theo luật dừng.

| | Cửa 0 | Cửa 1 | lý do chính |
|---|---|---|---|
| A1 key có định danh | dữ liệu ✓ (thiếu 0,14%), cân bằng ✓ | **RỚT** | không ô nào đậu dù chỉ một cửa. Chiều hiệu ứng **ngược** giả thuyết |
| B1 ΔOI breakout | ✓ (thiếu 2,6%, A 58%) | **RỚT** | z = 1,82 < 2,39; nhãn giả −1,44 điểm % ≈ ½ hiệu ứng thật |
| B2 funding LONG | ✓ (A 71%) | **RỚT** | z = −1,43; nhãn giả cho hiệu ứng **cùng độ lớn, ngược dấu** (+6,47) |

**Lỗi đăng ký, xử lý theo phía bảo thủ:** §3 A1 đòi "biên phát hiện 95% < 0,05 ATR". Tiêu chí này chép
từ bộ thử 28/08, và không thể đạt khi tách đôi mẫu: Cửa 0 cho biên nhỏ nhất là 0,103 ATR. Vì vậy phán
quyết A1 bị cố định là RỚT trước khi chạy Cửa 1. Kết quả Cửa 1 cũng rớt độc lập theo tiêu chí của phụ
lục 1, nên lỗi này không đổi kết luận.

### A1 — số chính (CORE8, M15, 400 ngày tới 28/09/2026)

Nến volume đột biến chia **đúng 50/50** giữa OI tăng và OI giảm ở mọi ngưỡng 2×/6×/12×. Tự điều này
đã nói volume đột biến không nghiêng về phía "cá mập mở vị thế".

| ô | spike MỞ | spike ĐÓNG | syn MỞ | MỞ − syn (±biên z=2,39) |
|---|---:|---:|---:|---:|
| 2× R0 | −0,039 | −0,021 | +0,002 | −0,041 ±0,103 |
| 6× R0 | −0,107 | −0,086 | +0,002 | −0,108 ±0,175 |
| 6× R4 | **−0,334** | +0,009 | +0,002 | −0,336 ±0,277 |
| 6× R5loc | **−0,422** | +0,007 | −0,006 | −0,417 ±0,353 |
| 12× R0 | −0,385 | −0,122 | +0,002 | −0,387 ±0,417 |

(Đơn vị: bước giá 12 nến theo chiều BẬT, tính bằng ATR. Âm nghĩa là giá **đi tiếp qua mức**.)

Cửa 3, cấu trúc rào: WR_MỞ / WR_random = 0,82–1,17, không ô nào đạt 1,246. Ở 6× R4, WR bật tại key MỞ
là **15,9%**, thấp hơn cả vào lệnh ngẫu nhiên (19,5%).

**Phát hiện mô tả, KHÔNG phải kết luận** (hậu nghiệm, chỉ thấy ở ô thưa, và R4/R5loc lồng nhau):
key do **mở vị thế** tạo ra bị giá **xuyên qua** nhiều hơn key do đóng vị thế. Ở 6× R4, MỞ − ĐÓNG =
−0,34 ATR, z ≈ −3,0 (ước từ sd ≈ 3,2). Điều này ngược với câu chuyện "cá mập bảo vệ key". Nó khớp với
cách đọc thông thường: vị thế mới mở kéo theo xu hướng tiếp diễn. Muốn thành luật thì phải đăng ký
trước và đo trên dữ liệu **sau 28/09/2026**. Không được đo lại trên 400 ngày này.

### B1/B2 — số chính (Turtle live-params, top-30 point-in-time, 3.481 vị thế từ 01/12/2021)

| | P(net ≥ +3R) A | B | D | z (bootstrap tháng) | TB netR A / B | CORE8 D |
|---|---:|---:|---:|---:|---:|---:|
| B1 (A = OI tăng) | 12,6% | 9,7% | +2,87 | 1,82 | 0,643 / 0,623 | +5,49 |
| B2 (A = funding đông) | 6,6% | 13,4% | −6,72 | −1,43 | **0,004 / 1,950** | −14,09 |

- **Phép hoán vị nhãn đậu ở cả hai nhưng không đáng tin:** nó bỏ qua việc lệnh trend dồn cụm theo
  thời gian. sd bootstrap theo tháng lớn hơn sd ngầm của phép hoán vị khoảng 1,5 lần (B1: 1,58 so với
  ≈1,09 điểm %) và 2 lần (B2: 4,70 so với ≈2,37).
  Đây là lý do protocol chọn bootstrap tháng làm phép chính.
- **B2 là trường hợp đáng nhớ nhất.** Chênh 1,95R/vị thế là con số trông rất hấp dẫn, và chiều khớp với
  BIS WP 1087. Nhưng funding của **năm trước** (nhãn giả) cho D = +6,47, cùng độ lớn và ngược dấu. Nhãn
  funding thực chất đang đo "đang ở đâu trong chu kỳ tăng giá": funding thấp so với năm trước tức là đầu
  chu kỳ, nơi có các lệnh LONG lớn nhất. 4,8 năm dữ liệu chỉ chứa vài chu kỳ. Không có cách nào tách
  được hiệu ứng thật khỏi thời điểm với dữ liệu hiện có, và thêm tham số cũng không cứu được.
- B1 đúng chiều "tiền mới thì trend bền" nhưng yếu. Chênh TB netR gần bằng 0 (0,643 so với 0,623R),
  nên nó không đáng tiền kể cả khi có thật.

### Hệ quả

1. Vòng này kiểm được lời phản bác cuối cùng cho mệnh đề Key: "volume nến mơ hồ, phải biết ai tạo ra
   nó". Biết ai tạo ra nó (qua OI) **vẫn không làm key có phản ứng bật**. Key volume dạng số hoá được
   coi là đóng trên crypto perp.
2. Thông tin định vị (OI, funding) **không** thêm được gì đo được vào Turtle. Giữ nguyên v4. Không thêm
   bộ lọc nào.
3. Tổng số phép thử của họ này là 3. Nó không làm xấu thêm ngưỡng Reality Check của các họ khác.
