# Fast — kênh thoát cho LONG (2026-08-09)

Rà soát lại HAI phương pháp đang chạy (Turtle/Binance và Fast/MEXC) trên cùng một engine danh mục,
cùng cửa sổ, cùng phí thật. Kết quả: **Turtle không đổi gì**, **Fast đổi luật thoát của LONG**.

Mọi số dưới đây là backtest/diagnostic trên 2.025 ngày (2021-01-22 → 2026-08-09, rổ 8 coin, nến 4h
Binance Futures), KHÔNG phải cam kết lợi nhuận. Script: `scripts/rx-lab.ts` (`base|diag|fast|turtle|
joint|verify|recent|grid|ship`). Phí: Turtle 0,05% taker + 0,02% slippage mỗi chiều; Fast 0,08% taker
(MEXC) + 0,02%; funding 0,01%/8h cả hai.

## Chẩn đoán — điểm yếu thật của từng sleeve

| | Turtle | Fast (trước) |
|---|---:|---:|
| Sharpe (P&L ngày) | 1,58 | **0,64** |
| Sharpe era A / B / C | 1,44 / 1,36 / 1,89 | **0,13 / 0,16 / 1,39** |
| NET/maxDD | 10,19 | 2,54 |
| exp/unit | 0,564 | 0,103 |
| Phí ăn bao nhiêu % gross | 8% | **27%** |
| Top-5 winner / tổng R dương | 24,6% | **10,9%** |
| Giữ TB lệnh thắng | 8,8 ngày | **3,9 ngày** |

**Turtle khỏe, Fast mới là chỗ hỏng.** Và Fast hỏng ở ĐUÔI PHẢI, không phải ở tín hiệu vào:

- Tỉ lệ loss gần như nhau giữa hai sleeve (loss có MFE <0,5R: 49,7% vs 53,2%) ⇒ chất lượng entry
  không phải nguyên nhân.
- Fast thoát ở mức giveback trung vị **4%** (Turtle 49%) — nghe như "thoát hiệu quả", nhưng đi kèm
  hold 3,9 ngày và top-5 winner chỉ 10,9%: đó là mô tả của một hệ **cắt trend sớm**. Trend-following
  sống bằng vài winner lớn; Fast không có chúng.
- 100% lợi nhuận của Turtle đến từ nhánh thoát `mid` (269 unit, +664R) trong khi nhánh `trail` của nó
  âm (−82R trên 1.872 unit). Fast **không có nhánh mid nào cả** — toàn bộ exit là chandelier.

## Thay đổi đã ship

`fast-trend-live.ts`:

1. `FAST_LONG_EXIT_DAYS = 20` — LONG thoát khi nến 4h **đóng dưới midpoint kênh close 20 ngày**
   (chỉ ratchet lên); hard SL 3×ATR vẫn nằm trên sàn và được nâng khi có unit mới. SHORT giữ nguyên
   Chandelier 3×ATR (mid cho short đã test là **hại**, xem dưới).
2. `FAST_MAX_UNITS` 4 → 3.

Đây là cơ chế **đã chứng minh trên Turtle** (nghiên cứu 2026-08-04), không phải chỉ báo mới.

| | TRƯỚC | SAU |
|---|---:|---:|
| NET R (cùng risk/unit) | 268 | **1.337** |
| NET R quy đổi cùng maxDD | 268 | **1.035 (+287%)** |
| Sharpe | 0,64 | **1,46** |
| NET/maxDD | 2,54 | **9,84** |
| NET/Ulcer | 6,5 | **16,5** |
| exp/unit | 0,103 | **0,635** |
| Sharpe era A / B / C | 0,13 / 0,16 / 1,39 | **1,48 / 1,27 / 1,62** |
| LONG NET R | 106 | **1.028** |
| SHORT NET R (không đổi luật) | 162 | 155 |
| Top-5 winner / R dương | 10,9% | **32,6%** |
| Giữ TB lệnh thắng | 3,9 ngày | **10,1 ngày** |

## Vì sao tin đây là cơ chế chứ không phải fit

1. **Cả HỌ luật đều thắng, không phải một điểm.** Mọi `longExitDays` từ 8 đến 40 ngày cho Sharpe
   1,30–1,47. Trong khi 40 lần bốc ngẫu nhiên chandelier k ∈ [2;8] cho p50 0,89 và **max 1,00** —
   thành viên TỆ NHẤT của họ mid (1,30) vẫn hơn thành viên TỐT NHẤT của họ chandelier. `0/40` lần bốc
   chạm được bản ship.
2. **Cơ chế cạnh tranh đã bị loại.** Giả thuyết đơn giản hơn là "trail quá chật" — nhưng nới chandelier
   lên 4/5/6/8×ATR chỉ cho +37…+66% và **xấu đi ở era gần nhất** (Sharpe C ~1,0 so với base 1,39).
   Thứ tạo ra khác biệt là **cấu trúc kênh** (một mức bám theo biên độ của chính trend, chỉ thoát khi
   giá ĐÓNG dưới nó), không phải độ rộng stop.
3. **Cả ba era đều tăng**, kể cả era yếu nhất (B: 0,16 → 1,27).
4. **Walk-forward 6 cửa sổ: thắng 5/6.**
5. **Perturbation ±15% × 30 seed** (entry/exit/chandelier/ATR/EMA/maxHold): Sharpe p10 1,46 · p50 1,51;
   **30/30 seed vẫn hơn Fast hiện tại**.
6. **Không tập trung vào một coin**: 6/8 coin tốt lên; hai coin xấu đi là BTC (55→54R) và ETH (79→64R),
   mức xấu đi nhỏ.
7. **Bền với phí xấu hơn**: đẩy phí lên 0,12+0,05% và cả 0,2+0,05% mỗi chiều, ưu thế còn nguyên
   (+381% / +551% do bản cũ suy sụp nhanh hơn khi phí tăng).

### Chọn 20 ngày như thế nào (và vì sao KHÔNG theo luật tỉ lệ 1,33×)

Nghiên cứu 2026-08-04 đăng ký luật "đổi `entryDays` thì đổi `longExitDays` theo tỉ lệ ~1,33×", tức
Fast (vào 10d) phải dùng ~13d. Lưới 2 chiều `entryDays × longExitDays` **bác bỏ luật đó**: với MỌI
kênh vào 6/8/10/13/15 ngày, argmax đều rơi đúng vào **20 ngày** (tỉ lệ tương ứng 3,33× … 1,33×).

```
entry\exit    8     10     13     15     18     20     25     30    argmax
6          1.29   1.31   1.27   1.31   1.37   1.45   1.41   1.39    20d
8          1.31   1.33   1.27   1.30   1.37   1.46   1.45   1.43    20d
10         1.35   1.36   1.30   1.33   1.40   1.47   1.45   1.43    20d
13         1.36   1.36   1.30   1.37   1.43   1.50   1.42   1.41    20d
15         1.33   1.36   1.31   1.37   1.36   1.44   1.37   1.35    20d
```

⇒ Độ rộng kênh thoát là một đại lượng **tuyệt đối** (~3 tuần — đúng độ dài trend crypto điển hình),
không phải hàm của tốc độ vào lệnh. Điều này khớp với chính dữ liệu của nghiên cứu cũ ("MỌI entryDays
đều muốn kênh thoát ≈ 22–25 ngày") và giải thích vì sao cả hai sleeve hội tụ về cùng một con số dù
kênh vào khác nhau (15d vs 10d). Cao nguyên 18–25d phẳng nên giá trị chính xác không nhạy.

## CẢNH BÁO TRUNG THỰC — ưu thế này KHÔNG có ở 12–18 tháng gần nhất

Đây là điều quan trọng nhất phải nhớ trước khi bật tiền thật.

| cửa sổ | Fast cũ (chandelier) | Fast mới (mid 20d) |
|---|---:|---:|
| 180 ngày | Sharpe 1,31 · 61R | 1,02 · 49R |
| 365 ngày | 0,96 · 87R | 0,66 · 61R |
| 545 ngày | 1,12 · 151R | 0,79 · 141R |
| 730 ngày | 1,32 · 229R | **1,51 · 672R** |
| 1.095 ngày | 1,15 · 289R | **1,76 · 1.160R** |

Theo năm (cùng chính sách risk): mid thắng đậm 2021/2023/2024, **thua nhẹ 2022/2025/2026**.

Hai điều làm mình vẫn ship:

1. **Hiện tượng này KHÔNG riêng của Fast — Turtle cũng vậy.** Chạy Turtle với chandelier cho LONG:
   365 ngày gần nhất Sharpe 1,03 vs 0,77 của bản mid đang chạy; nhưng toàn kỳ là 424R vs **1.583R**.
   Tức là "gần đây chandelier tốt hơn" là một pha thị trường tác động lên CẢ HAI sleeve, không phải
   bằng chứng rằng kênh thoát sai. Đổi luật theo cửa sổ 12 tháng chính là cái bẫy mà
   `live-losing-streak-forensics` và `trend-method-remediation-research` đã ghi lại.
2. Cửa sổ 365 ngày chỉ có ~140 vị thế và nằm gọn trong một regime; chênh lệch NET ở 545 ngày đã gần
   như biến mất (151R vs 141R).

Nhưng phải nói thẳng: **nếu regime "trend ngắn dần" là thật và kéo dài, thay đổi này sẽ không giúp
gì trong ngắn hạn.** Cách kiểm chứng đúng là forward-test trên shadow, không phải đổi lại luật.

## Đã thử và LOẠI (đừng lặp lại)

- **Kênh mid cho SHORT của Fast** (10/15/20/25/30d): −71% … −92% NET quy đổi, era B âm. Trùng kết luận
  cũ của Turtle. Short phải giữ Chandelier.
- **Turtle: xác nhận 1–2 nến cho SHORT** (cơ chế mượn ngược từ Fast): 1 nến −2%, 2 nến −29%. exp/unit
  tăng (0,564 → 0,621) nhưng NET/maxDD giảm — lọc bớt lệnh không bù được phần trend bỏ lỡ. **Không đổi.**
- **Turtle: kênh thoát LONG 12/15/18/22/25/30d** — 20d vẫn là điểm tốt nhất theo NET/maxDD trên cửa sổ
  dài hơn. Không đổi.
- **Turtle: chandelier 2,5×ATR** (+4% quy đổi, Sharpe 1,65) — nằm trong nhiễu và audit 2026-08 đã loại
  vì era C yếu đi; giữ 3,0.
- **Turtle: heat k = 2/3/6/8, max 2/4 unit** — tất cả ≤ +1% quy đổi. Cấu hình hiện tại đang ở cao nguyên.
- **Fast: heat-decay k=4** — có cải thiện (Sharpe 1,46 → 1,58 khi cộng với mid-20d) nhưng CHƯA ship:
  cần plumb trạng thái danh mục vào `FastTrendLive` như `TurtleLive.heatWeight`, là thay đổi ở tầng
  sizing của một lớp đặt lệnh thật. Đây là ứng viên tiếp theo, có bằng chứng, nhưng tách commit.
- **Fast: đổi entry sang close-channel 13/15d** (+23…26%): làm Fast **giống hệt Turtle** hơn nữa trong
  khi trùng lặp đã 95%. Không đổi — muốn giữ Fast là một tốc độ khác.

## Fast có đáng chạy không? (câu hỏi danh mục, không phải câu hỏi luật)

Trùng lặp Fast↔Turtle: 89,3% toàn kỳ, **95,8% trong 365 ngày, 100% trong 90 ngày gần nhất**; tương
quan P&L tuần 0,90 (365d) → 0,97 (180d). Fast không phải nguồn alpha độc lập, nó là **lớp tăng
exposure** cho Turtle.

Ghép hai sổ risk RIÊNG (đúng production: Binance và MEXC không chia heat), chuẩn hoá về cùng maxDD:

| danh mục | Sharpe | NET quy đổi cùng DD |
|---|---:|---:|
| Turtle một mình | 1,57 | 715R |
| + Fast **cũ** (risk ×1) | 1,25 | 443R (**−38%**) |
| + Fast cũ (risk ×0,5) | 1,40 | 570R (−20%) |
| + Fast **mới** (risk ×0,5) | 1,58 | 745R (+4%) |
| + Fast **mới** (risk ×1) | 1,58 | 762R (+7%) |

Nói thẳng: Fast phiên bản cũ **làm hỏng danh mục** (−38% NET tại cùng drawdown) — bật nó lên tiền thật
sẽ là một quyết định tệ. Fast phiên bản mới chuyển từ "có hại" sang "hơi có lợi" (+7%). Với tương quan
0,97, đừng kỳ vọng nó là công cụ đa dạng hoá; giá trị thật của nó là chạy trên vốn MEXC riêng.

## Chốt chặn hồi quy

```bash
./node_modules/.bin/ts-node scripts/portfolio-equivalence.ts 1050   # engine danh mục ≡ runTurtle
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 300       # TurtleLive ≡ engine (lệnh + weight)
./node_modules/.bin/ts-node scripts/fast-live-parity.ts 400         # FastTrendLive ≡ engine (MỚI)
./node_modules/.bin/ts-node scripts/rx-lab.ts ship 2300             # bảng TRƯỚC/SAU + placebo
```

`fast-live-parity.ts` đã bắt được một lỗi thật ngay lần chạy đầu: `runBooks` chỉ sinh `trades` lúc
THOÁT, nên vị thế còn mở ở nến cuối bị coi là "live thừa lệnh". Đã thêm `PortfolioResult.openAtEnd`
và sửa cả `turtle-live-parity.ts` (script đó đang đỏ vì đúng lý do này, không phải vì Turtle sai).

## Ghi chú migration

State Fast ghi trước 2026-08-09 không có `midTrail`. Lần chạy đầu, mỗi vị thế LONG đang mở sẽ khởi
tạo `midTrail = max(hard SL, midpoint kênh 20d hiện tại)` và **không bao giờ nới hard SL**. Nếu giá đã
nằm dưới midpoint thì lệnh đó sẽ thoát ngay ở nến kế — đúng theo luật mới. Hiện `fast-trend-mexc-state.json`
đang rỗng nên không có gì để migrate.

`/health` giờ in thêm dòng `Fast rule: … fp <fingerprint>` để xác nhận từ Telegram rằng process đang
chạy đúng luật mới (cùng lý do đã thêm `Turtle rule` ở commit 8ede369).
