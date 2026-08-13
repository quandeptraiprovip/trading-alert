# Turtle + Fast — hướng giải quyết, đối chiếu tài liệu rồi kiểm bằng dữ liệu (2026-08-12, vòng năm)

Tiếp `turtle-fast-execution-weakness-2026-08-12.md`, vòng đó để mở ba vấn đề: (a) trượt giá ở nhánh
stop có thể lấy 13-54% vốn và chưa ai đo, (b) chính sách heat siết quá lỏng, (c) phân bổ vốn phụ thuộc
thứ tự mảng symbol. Vòng này đi tìm **giải pháp** — mỗi giải pháp lấy từ một kết quả nghiên cứu, rồi
kiểm trên dữ liệu của chính hệ.

Script: `scripts/exp-solutions.ts` (`s1|s2|s3|s4|s5`). Cùng nền như trước: 2.028 ngày, CORE8, nến 4h,
phí thật, chấm bằng vốn cuối kỳ khi ép mọi cấu hình về maxDD 30%. Hai gate parity PASS lại sau thay
đổi engine. Không phải cam kết lợi nhuận.

## Tài liệu đã đọc

| nguồn | điều dùng được |
|---|---|
| Kaminski & Lo, *When Do Stop-Loss Rules Stop Losses?* (SSRN 968338, JFinMkts 2014) | Dưới random walk, luật stop-loss **luôn** giảm kỳ vọng; chỉ AR(1) **dương** (động lượng) mới làm nó có giá trị; mean-reversion thì nó gây hại |
| Bouchaud và cộng sự — định luật căn bậc hai của market impact | `I(Q) = Y·σ·√(Q/V)`, Y ~ O(1), đã kiểm chứng trên cả Bitcoin ⇒ cho phép **ước lượng** trượt giá do kích thước từ dữ liệu có sẵn |
| *Stop-loss rules and momentum payoffs in cryptocurrencies* (J. Behav. Exp. Finance 39, 2023) | 147 coin 2015-2022: stop-loss cắt đuôi trái rất mạnh (trung bình 10 lỗ tệ nhất −75,1% → +11,5% với stop ±30%) ⇒ **đừng bỏ stop**, chỉ đổi cơ chế |
| Harvey và cộng sự — volatility targeting; tài liệu correlation-adjusted sizing | Hạ size khi các vị thế tương quan cao là chuẩn mực, không phải thủ thuật ⇒ nền lý thuyết cho việc siết heat |
| Tài liệu stop-hunting / liquidation cascade (10/10/2025: $19B, 1,6M tài khoản) | Stop dồn cục ở các mức **hiển nhiên** (đáy/đỉnh swing) và bị chạy qua ⇒ giả thuyết kiểm được về CÁCH ĐẶT stop |

---

## S1 — Trượt giá là vấn đề KÍCH THƯỚC hay THỜI ĐIỂM? (dứt điểm: thời điểm)

`I(Q) = Y·σ·√(Q/V)` với Y=1 (cạnh bảo thủ), V = khối lượng quote/ngày **thật** của từng symbol, σ = độ
lệch chuẩn lợi suất ngày, cả hai lấy từ cache 2.028 ngày:

| symbol | vol quote/ngày (trung vị) | σ ngày | ATR20% | impact @ $10k / $100k / $1M (bps) |
|---|---:|---:|---:|---:|
| BTCUSDT | $13.600M | 2,96% | 1,72% | 0,25 / 0,80 / 2,54 |
| ETHUSDT | $7.377M | 3,97% | 2,29% | 0,46 / 1,46 / 4,62 |
| SOLUSDT | $1.547M | 5,76% | 3,32% | 1,46 / 4,63 / 14,64 |
| XRPUSDT | $736M | 4,99% | 2,71% | 1,84 / 5,82 / 18,39 |
| DOGEUSDT | $566M | 6,94% | 3,27% | 2,92 / 9,23 / 29,19 |
| ADAUSDT | $343M | 4,90% | 2,91% | 2,64 / 8,36 / 26,45 |
| AVAXUSDT | $248M | 5,80% | 3,42% | 3,68 / 11,63 / 36,77 |
| DOTUSDT | $174M | 4,93% | 2,97% | 3,74 / 11,82 / 37,38 |

Ngưỡng nguy hiểm đã đo ở vòng trước: trượt **0,05×ATR ⇒ −13% vốn**. Với DOT (mỏng nhất rổ) ngưỡng đó
= 15 bps, và để impact-do-kích-thước đạt 15 bps cần **notional một lệnh $0,2M**, tức:

| risk/unit | equity để MỘT unit đạt ngưỡng |
|---|---:|
| 0,32% (đang chạy) | **$4M** |
| 0,93% (k=1) | **$2M** |
| 1,24% (k=0,5) | **$1M** |

**Hai kết luận:**

1. **Trượt giá KHÔNG phải vấn đề kích thước.** Ở cỡ lệnh $10k, impact là 0,25-3,74 bps — thấp hơn
   ngưỡng nguy hiểm 4-60 lần. Điều này **loại bỏ cả một họ giải pháp**: giao dịch nhỏ hơn, chia lệnh,
   TWAP/VWAP hoá lệnh thoát, đổi sang sàn sâu hơn *vì lý do độ sâu*. Không cái nào chạm vào vấn đề.
   Thủ phạm là **THỜI ĐIỂM**: stop kích hoạt đúng lúc giá đang chạy và sổ đang mỏng đi (chính là cái
   R6 đo được — giá vượt stop 0,52-0,74×ATR ngay trong nến kích hoạt). ⇒ Chỉ có đổi **CƠ CHẾ THOÁT**
   mới cứu được, và đó đúng là hai trục S4 + xác-nhận-close.
2. **Capacity (câu chưa ai hỏi trong repo):** hệ chạy được tới cỡ **$1-4M vốn** trước khi riêng
   impact-kích-thước bắt đầu ăn 13% vốn cuối kỳ. Đây là giới hạn mềm — nó tăng nếu bỏ các coin mỏng.

---

## S2 — Dự đoán của Kaminski & Lo: KHÔNG ĐỨNG (đừng làm luật chuyển theo regime)

Lý thuyết cố định **dấu trước khi xem số**: cơ chế stop ít nhạy nhiễu hơn (xác nhận bằng close) phải
thắng ở năm **VR thấp** (quay đầu) và thua ở năm **VR cao** (động lượng) ⇒ corr(VR, lợi thế của close)
phải **ÂM**.

| năm | VR(20) | CÓ trượt giá: trong nến → close | chênh | KHÔNG trượt | chênh |
|---|---:|---|---:|---|---:|
| 2021 | 1,34 | 2,13 → 2,14 | +0,01 | 2,22 → 2,20 | −0,02 |
| 2022 | 0,64 | 0,09 → 0,24 | **+0,15** | 0,27 → 0,31 | +0,05 |
| 2023 | 1,23 | 1,87 → 1,79 | −0,09 | 1,98 → 1,84 | −0,14 |
| 2024 | 1,63 | 1,93 → 1,93 | −0,00 | 2,00 → 1,97 | −0,03 |
| 2025 | 0,92 | 0,37 → 0,11 | **−0,27** | 0,52 → 0,18 | −0,33 |
| 2026 | 1,10 | 1,22 → 1,14 | −0,08 | 1,35 → 1,20 | −0,15 |

**corr(VR, lợi thế close) = −0,08 (có trượt giá) / +0,12 (không).** Tức bằng không. Và 2025 — năm VR
thấp thứ hai — là năm close **tệ nhất** (−0,27), ngược hẳn dự đoán.

56 cửa sổ 365d trượt, chia đôi theo VR đo trong cửa sổ:

| nửa | VR TB | Sharpe trong-nến → close | chênh | close thắng |
|---|---:|---|---:|---:|
| VR THẤP (quay đầu) | 0,78 | 0,42 → 0,40 | −0,02 | **17/28** |
| VR CAO (động lượng) | 1,34 | 1,58 → 1,56 | −0,02 | **9/28** |

Hướng đúng **chỉ hiện ở tỉ lệ thắng** (17/28 vs 9/28) nhưng **độ lớn thì bằng nhau** (−0,02 ở cả hai
nửa) ⇒ không khai thác được.

**Cảnh báo thêm, quan trọng:** VR tôi tính ở đây (block không chồng lấn trên lợi suất ngày của rổ)
KHÔNG khớp `scripts/exp-market-regime.ts` — nó cho 2021 = 1,34 vs 1,01 và 2026 = 1,10 vs 0,87, và
**thứ hạng các năm cũng khác**. Nghĩa là chính biến điều kiện là đại lượng không ổn định theo cách
ước lượng. Xây luật chuyển theo nó là xây trên cát.

⇒ **LOẠI.** Không làm stop chuyển theo regime. Đây là một ý tưởng nghe rất hợp lý, có lý thuyết chống
lưng, và vẫn sai — đúng lý do phải kiểm chứ đừng suy diễn.

---

## S3 — GIẢI PHÁP TỐT NHẤT: phân bổ bất biến thứ tự (`admitBarSnapshot`)

Vấn đề (đo ở vòng trước): `runBooks` duyệt symbol theo thứ tự mảng, nên symbol đứng trước gặp heat
thấp hơn và được size lớn hơn. Đổi thứ tự mảng làm lệch 9% vốn ở k=4 và tới 68% ở k=0,1.

Giải pháp: mọi tín hiệu trong **cùng một nến** chấm heat theo ảnh chụp trạng thái **đầu nến**, nên
chúng không nhìn thấy nhau ⇒ bất biến thứ tự **theo cấu tạo**, không phải theo may mắn.

| k | chế độ | gốc | đảo | xoay | abc | **biên độ** | **worst case** |
|---|---|---:|---:|---:|---:|---:|---:|
| 4 | tuần tự | 23,69 | 21,69 | 22,63 | 22,33 | 9% | 21,69 |
| 4 | **ĐẦU NẾN** | 24,09 | 24,09 | 24,09 | 24,09 | **0%** | **24,09** |
| 1 | tuần tự | 28,70 | 23,94 | 27,46 | 26,43 | 20% | 23,94 |
| 1 | **ĐẦU NẾN** | 30,84 | 30,84 | 30,84 | 30,84 | **0%** | **30,84** |
| 0,5 | tuần tự | 30,87 | 25,57 | 29,46 | 28,36 | 21% | 25,57 |
| 0,5 | **ĐẦU NẾN** | **35,26** | 35,26 | 35,26 | 35,26 | **0%** | **35,26** |
| 0,25 | tuần tự | 33,84 | 24,09 | 30,73 | 28,51 | 40% | 24,09 |
| 0,25 | **ĐẦU NẾN** | 33,55 | 33,55 | 33,55 | 33,55 | **0%** | 33,55 |

**Ba điều, mỗi điều đều đáng giá riêng:**

1. **Biên độ về đúng 0% ở mọi k.** Hệ trở thành xác định, không còn phụ thuộc một chi tiết cài đặt.
2. **Đồng thời TĂNG tiền ở mọi k** (worst case: +11% ở k=4, +29% ở k=1, +38% ở k=0,5). Không phải
   đánh đổi — cái hiện vật kia vừa gây bất định vừa phá giá trị. Và nó không thể thắng nhờ "ăn thêm
   risk": mọi cấu hình đã bị ép về cùng maxDD 30%.
3. **Đỉnh k trở thành đỉnh THẬT.** Ở chế độ tuần tự, đường k đơn điệu tới cạnh dải quét (dấu hiệu
   overfit). Ở chế độ đầu nến, k=0,5 (35,26) > k=0,25 (33,55) ⇒ có cực đại nội, không còn ở mép vực.

**Cửa giả-OOS 4 pha nến** (`s5`, đã bật trượt giá 0,10/0,05×ATR):

| pha | ĐANG CHẠY | snap k=1 | snap k=0,5 | snap k=0,5 + stop 3ATR |
|---|---:|---:|---:|---:|
| 0h | 11,21 | 16,64 | 22,50 | 21,63 |
| 1h | 7,58 | 10,40 | 12,05 | 11,93 |
| 2h | 7,57 | 10,25 | 10,99 | 10,27 |
| 3h | 5,43 | 6,27 | 6,81 | 7,98 |
| **TB** | **7,95** | 10,89 | **13,09** | 12,95 |

**Thắng mốc ở 4/4 pha, cả ba biến thể.** Trên trung bình bốn pha (số trung thực hơn pha 0h),
snap k=0,5 hơn mốc **+65%**.

**Đây là khuyến nghị mạnh nhất cả hai vòng, vì nó KHÔNG phụ thuộc con số trượt giá chưa đo.** Nó thắng
cả khi bật lẫn khi tắt trượt giá, ở mọi k, ở mọi thứ tự, ở mọi pha nến.

⚠️ **Cái giá:** risk/unit phải tăng để giữ maxDD 30% (chế độ tuần tự k=0,5 cần 1,24% so với 0,32% hiện
tại; bản đầu nến sẽ nằm giữa hai mức đó vì nó cho tổng risk cao hơn ở cùng k — **đọc lại con số chính
xác khi ship**). Tổng risk theo hướng thì GIẢM, nhưng risk danh nghĩa mỗi unit tăng. Quyết định tiền
thật, không phải hằng số kỹ thuật.

---

## S4 — Stop tại CẤU TRÚC vs MÁY MÓC: dấu đảo khi tính trượt giá

Giả thuyết từ tài liệu stop-hunting: stop bị săn ở mức **hiển nhiên**. `turtleInitialStop` đặt stop
đúng ngoài wick của nến ngược hướng gần nhất — một đáy/đỉnh swing hiển nhiên. Fast thì không (luôn
3×ATR máy móc, vì `initialStopObLookback: 0`). Nên tắt stop cấu trúc của Turtle là so được trực tiếp.

| | vốn (×) | Sharpe | era A/B/C | 365d | vs mốc |
|---|---:|---:|---|---:|---:|
| **KHÔNG trượt giá** | | | | | |
| Turtle: stop CẤU TRÚC (đang chạy) | 22,45 | 1,59 | 2,51/2,23/4,01 | 1,12 | — |
| Turtle: stop MÁY MÓC 3×ATR | 21,65 | 1,59 | 3,11/2,06/3,37 | 1,08 | **−4%** |
| **CÓ trượt giá (0,10/0,05×ATR)** | | | | | |
| Turtle: stop CẤU TRÚC (đang chạy) | 13,64 | 1,47 | 2,14/1,92/3,32 | 1,07 | — |
| Turtle: stop MÁY MÓC 3×ATR | 15,96 | 1,48 | 2,80/1,87/3,05 | 1,04 | **+17%** |
| danh mục: Turtle cũng dùng 3×ATR | 12,58 | 1,43 | 2,53/1,79/2,78 | 1,06 | **+8%** |

**Dấu đảo.** Dưới giả định fill hoàn hảo, stop cấu trúc hơn 4%. Dưới trượt giá thực tế, stop máy móc
hơn **17%** (Turtle) / 8% (danh mục). Giả thuyết săn-stop được ủng hộ **có điều kiện** — và điều kiện
lại chính là con số chưa đo.

Đây là lần thứ **ba** trong hai vòng mà cùng một dấu hiện ra: dưới fill thực tế, mọi cơ chế thoát
**nhạy nhiễu hoặc nằm ở mức hiển nhiên** đều tệ hơn backtest nói. Ba đường độc lập (xác nhận close,
stop máy móc, tỉ lệ râu nến 53-63%) cùng chỉ một hướng.

⇒ **Chưa ship** (cùng lý do S4 và xác-nhận-close phụ thuộc phép đo), nhưng ghi vào danh sách chờ đo,
và lưu ý: nếu phép đo cho trượt giá > ~0,07×ATR thì **hai** thay đổi này cùng bật, không phải một.

---

## Kết luận: làm gì, theo thứ tự

1. **Bật lại bot.** Vẫn tắt từ 20/07. Mọi phép đo dưới đây cần dòng lệnh thật.
2. **Ghi giá khớp thật ở chiều exit** (`realExit = avgPrice`, tính thêm `netR_real`). Không đụng luật.
   Đây là chốt quyết định cho **hai** ứng viên đang chờ (S4 + xác-nhận-close), và là cách duy nhất
   biết 18,06× thật là bao nhiêu. S1 đã chứng minh vấn đề không nằm ở kích thước, nên phép đo này là
   đường duy nhất còn lại.
3. **Ship S3: `admitBarSnapshot` + siết k.** Bất biến thứ tự theo cấu tạo, thắng 4/4 pha nến, thắng ở
   mọi k và mọi thứ tự, có đỉnh nội. Đề nghị **k=1 (thận trọng)** hoặc **k=0,5 (mạnh hơn)**; xác nhận
   lại risk/unit trước khi bật tiền thật. Đây là thay đổi duy nhất **không** phụ thuộc ẩn số trượt giá.
4. **Chờ đo với hai trục stop** (máy móc 3×ATR cho Turtle, xác nhận bằng close). Ngưỡng lật là
   ~0,07×ATR. Đừng đoán.
5. **KHÔNG làm:** luật chuyển theo regime VR (S2 — corr ≈ 0 và biến điều kiện không ổn định);
   chia nhỏ/TWAP lệnh thoát hay đổi sàn *vì độ sâu* (S1 — impact 0,25-3,74 bps, sai vấn đề);
   bỏ stop (tài liệu crypto: stop cắt đuôi trái rất mạnh, đừng bỏ — chỉ đổi cơ chế).

**Ghi nhận cho đúng:** vòng này vẫn không tìm ra luật vào/ra nào tốt hơn. Cái tìm được là ở tầng
**phân bổ vốn** (S3) và ở việc **loại bỏ** ba hướng nghe hợp lý nhưng sai (S1 loại họ giải pháp kích
thước, S2 loại luật theo regime, và vòng trước loại pool heat chung).

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 200        # chốt chặn (PASS)
./node_modules/.bin/ts-node scripts/fast-live-parity.ts 200          # chốt chặn (PASS)
./node_modules/.bin/ts-node scripts/exp-solutions.ts s1 2300 30      # S1 impact + capacity
./node_modules/.bin/ts-node scripts/exp-solutions.ts s2 2300 30      # S2 Kaminski-Lo
./node_modules/.bin/ts-node scripts/exp-solutions.ts s3 2300 30      # S3 bất biến thứ tự
./node_modules/.bin/ts-node scripts/exp-solutions.ts s4 2300 30      # S4 cấu trúc vs máy móc
KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-solutions.ts s5 2300 30  # cửa 4 pha
```

Thay đổi engine vòng này: `ExtParams.admitBarSnapshot` (mặc định undefined ⇒ tuần tự như production).

## Giới hạn đã biết

- **S1 dùng định luật cho metaorder.** Với một market order lẻ, chi phí thật là spread + đi bộ qua sổ,
  không hẳn là `Y·σ·√(Q/V)`. Kết luận chỉ dùng ở mức **cấp độ lớn** (1-4 bps vs ngưỡng 15 bps) — biên
  đủ rộng để kết luận đứng, nhưng đừng coi các con số bps là chính xác.
- Y=1 là cạnh bảo thủ; nếu Y thật nhỏ hơn thì capacity còn cao hơn nữa.
- **VR là đại lượng không ổn định theo cách ước lượng** (S2) — đã ghi rõ vì nó cũng làm yếu đi những
  chỗ khác trong repo có dùng VR để kể chuyện regime.
- Bốn thứ tự symbol không phải phép thử đầy đủ (8! khả năng); chúng đủ để chứng minh bản đầu nến bất
  biến (0% ở cả bốn, theo cấu tạo) nhưng không đo hết được biên độ của bản tuần tự.
- Trượt giá vẫn là **tham số đưa vào**, không phải số đo. S4 và xác-nhận-close vẫn treo vì lý do đó.
