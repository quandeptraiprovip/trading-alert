# Turtle + Fast — audit sâu, nghiên cứu thị trường và hướng tăng Net R (2026-08-12)

Mọi số là backtest/diagnostic trên **2.028 ngày (2021-01-22 → 2026-08-12)**, nến 4h, phí thật
(Turtle 0,05% taker + 0,02% slip; Fast 0,08% MEXC + 0,02%; funding 0,01%/8h). Tham số production,
đã chốt bằng hai gate parity chạy lại hôm nay. **Không phải cam kết lợi nhuận.**

---

## 0. Điều quan trọng hơn mọi cải tiến thuật toán: BOT ĐANG TẮT

| bằng chứng | giá trị |
|---|---|
| `trading-runtime/turtle-state.json` mtime | **20/07/2026 19:51** |
| `fast-trend-mexc-state.json` mtime | 22/07/2026 23:47 |
| docker daemon | không chạy (socket không tồn tại) |

Đã tắt **23 ngày**. Chi phí cơ hội đo được (`scripts/exp-downtime.ts`):

| sleeve | unit | WR | NET | long | short |
|---|---:|---:|---:|---:|---:|
| Turtle | 17 | 6% | **−7,2R** | 0u | 17u |
| Fast | 11 | 18% | **−4,3R** | 0u | 11u |

Khoảng dừng **tránh được lỗ**, nhưng đó là may chứ không phải lý do để tắt: 28/28 unit là SHORT
(gate LONG đóng suốt), tức đây đúng pha squeeze mà `live-losing-streak-forensics` đã ghi. Một hệ
trend kiếm tiền bằng vài trend lớn mỗi năm; tắt máy là tự loại mình khỏi đuôi phải.

**Việc số 1: bật lại bot.** Nhớ bẫy đã đăng ký: xoá `turtle-state.json` cũ trước khi `up`, nếu không
replay sẽ bắn lệnh thật.

---

## 1. Audit hai sleeve: KHÔNG có lỗi luật

- `scripts/turtle-live-parity.ts 200` → **PASS** (17 unit, thiếu 0 · lệch weight 0 · thừa 0)
- `scripts/fast-live-parity.ts 200` → **PASS** (11 unit, thiếu 0 · thừa 0)
- Baseline `chop-diagnosis base 2300` tái lập khớp tài liệu 10/08 tới từng chữ số.

Engine nghiên cứu = luật đang chạy. Mọi số dưới đây nói về bot thật.

**Một khoảng trống DUY NHẤT tìm thấy** (không phải bug, là việc chưa làm): `turtle-live.ts` có
`heatWeight` (dòng 61, 164, 256, 339) — Fast **không có gì tương đương**. Fast đang chạy ngoài chính
sách risk cấp danh mục. Đây là mục §6 của `chop-regime-diagnosis-2026-08.md`, vẫn chưa ship, và hoá
ra là thay đổi đáng giá nhất trong cả vòng nghiên cứu này (mục 5).

---

## 2. Thị trường 2026 khác ở chỗ nào — đo bằng đại lượng KHÔNG dính chiến lược

`scripts/exp-market-regime.ts`. Bốn thước đo đều không dùng luật Turtle/Fast, nên chúng tách được
"luật hỏng" khỏi "nguyên liệu thô yếu đi".

### 2.1 Variance ratio — điều kiện CẦN của mọi hệ trend

VR(q) = Var(lợi suất q ngày) / (q × Var(1 ngày)). Bước ngẫu nhiên ⇒ 1; >1 có động lượng; <1 quay đầu.

| năm | VR(5) | VR(10) | **VR(20)** | Sharpe Turtle | Sharpe Fast |
|---|---:|---:|---:|---:|---:|
| 2021 | 0,95 | 0,96 | 1,01 | 2,06 | 2,14 |
| 2022 | 0,96 | 0,90 | 0,83 | 0,47 | 0,15 |
| 2023 | 0,97 | 1,04 | 1,04 | 1,76 | 2,02 |
| 2024 | 1,11 | 1,17 | **1,39** | 2,26 | 1,84 |
| 2025 | 0,84 | 0,77 | **0,72** | 0,90 | 0,33 |
| 2026 | 0,83 | 0,85 | 0,87 | 1,22 | 1,42 |

Thứ tự VR(20) gần như trùng thứ tự Sharpe. **2025 là năm quay đầu mạnh nhất cả mẫu, 2026 thứ ba từ
dưới lên.** Đây là câu trả lời cơ học cho "vì sao năm nay ảm đạm": thứ mà hệ khai thác — giá đi tiếp
theo hướng đã đi — đang ở đáy chu kỳ, chứ không phải luật hỏng.

### 2.2 Chất lượng breakout THÔ (không stop, không pyramid, không phí)

Sau nến phá đỉnh/đáy close-15d (+ lọc EMA50), giá chạm +3×ATR trước hay −3×ATR trước:

| năm | LONG: tín hiệu | LONG thắng | SHORT: tín hiệu | SHORT thắng |
|---|---:|---:|---:|---:|
| 2021 | 1.140 | 57,5% | 554 | 46,9% |
| 2022 | 521 | 44,7% | 985 | 58,6% |
| 2023 | 891 | 57,0% | 582 | 53,8% |
| 2024 | 920 | 57,2% | 597 | 52,4% |
| 2025 | 648 | 55,9% | 783 | 51,5% |
| **2026** | **307** | **40,7%** | 634 | **62,5%** |

2026 vừa **ít tín hiệu long nhất** (307 so với 900+ các năm tốt) vừa **chất lượng long tệ nhất cả mẫu**
— tệ hơn cả 2022. Ngược lại short đang là năm **tốt nhất** cả mẫu. Điều này khớp chính xác với phân rã
P&L 365 ngày (Turtle long −29,1R / short +60,1R; Fast long −46,0R / short +97,7R): hệ đang phản ánh
đúng thị trường, không phải đang hỏng.

### 2.3 Biên độ và tương quan

| năm | ATR20%/giá | phí ăn mỗi 1R | **corr TB cặp trong rổ** | BTC năm |
|---|---:|---:|---:|---:|
| 2021 | 4,59% | 1,0% | 0,49 | +58% |
| 2022 | 3,05% | 1,5% | 0,76 | −65% |
| 2023 | 2,08% | 2,2% | 0,61 | +155% |
| 2024 | 2,60% | 1,8% | 0,66 | +112% |
| 2025 | 2,54% | 1,8% | 0,80 | −7% |
| 2026 | **2,00%** | **2,3%** | **0,81** | −28% |

Hai điều: (a) biên độ về đáy chu kỳ nên phí ăn gấp đôi 2021 — nhưng 2,3% vẫn nhỏ, **phí không phải
thủ phạm**; (b) **tương quan trong rổ 0,81** — 8 coin hiện hành xử như chưa tới 2 cược độc lập. Đây là
đầu mối dẫn tới mục 5.2.

---

## 3. Phát hiện phải nói thẳng: Sharpe 1,58 của rổ CORE8 KHÔNG phải kỳ vọng tương lai

`scripts/exp-breadth.ts` bốc **ngẫu nhiên** rổ 8 coin từ 46 perp USDT đã niêm yết trước 2021 (danh sách
không lọc theo hiệu suất, gồm cả coin nay đã tụt hạng: EOS, XLM, ALGO, IOST, ONT, ZIL…):

| rổ | Sharpe Turtle | Sharpe Fast |
|---|---:|---:|
| **CORE8 đang chạy** (btc eth sol xrp doge ada avax dot) | **1,58** | **1,58** |
| 8 coin ngẫu nhiên (trung vị 16 lần bốc) | 0,88 | 0,78 |
| top-8 theo thanh khoản, chọn point-in-time | 1,27 | 1,04 |
| top-10 theo thanh khoản | 1,40 | 1,18 |

Tháng 1/2021, top-8 thanh khoản thật sự là `btc eth xrp link ltc bch yfi sushi` — **không hề giống**
CORE8. CORE8 là danh sách ta biết được sau khi đã thấy ai sống tốt tới 2026.

**Hệ quả cho kỳ vọng:** Sharpe tái lập được bằng một LUẬT là **~1,2–1,4**, không phải 1,58. Đừng đặt
kế hoạch vốn theo 1,58.

---

## 4. Bốn hướng đã thử vòng này và LOẠI (số liệu để đừng lặp lại)

### 4.1 Mở rộng rổ (giữ CORE8, thêm K coin) — LOẠI

Làm lại vì lần loại 2026-07 chấm bằng "exp/lệnh bị pha loãng" — metric SAI cho câu hỏi này (thêm thị
trường luôn hạ exp/lệnh nhưng có thể nâng Sharpe danh mục). Lần này chấm bằng Sharpe + NET/maxDD +
walk-forward, heat-decay bật. `scripts/exp-core-plus.ts`:

| Turtle | Sharpe | NET R | maxDD | N/DD | era A/B/C | 365d | WF thắng/56 |
|---|---:|---:|---:|---:|---|---:|---:|
| CORE8 | **1,58** | 715 | 70,4 | 10,16 | 1,44/1,36/1,88 | 0,57 | — |
| +2 | 1,49 | 679 | 69,3 | 9,79 | 1,36/1,19/1,85 | 0,78 | 22 |
| +4 | 1,48 | 727 | 70,8 | 10,26 | 1,34/1,23/1,82 | 0,88 | 20 |
| +8 | 1,24 | 667 | 89,0 | 7,49 | 1,12/0,96/1,58 | 0,78 | 14 |
| +38 (46 coin) | 1,03 | 983 | 202,8 | 4,85 | 1,19/0,74/1,15 | 0,26 | 6 |

Sharpe giảm **đơn điệu**; không cấu hình nào thắng quá 22/56 cửa sổ. Kết luận cũ đúng, nay có bằng
chứng đúng loại. (365d có đẹp lên — đúng dạng bẫy "chỉ tốt ở regime gần đây" repo đã đăng ký.)

### 4.2 Thay rổ bằng luật thanh khoản point-in-time — LOẠI, dù cơ chế là THẬT

`scripts/exp-universe-robust.ts`, bốn cửa:

- **G1 plateau — ĐẬU rất mạnh.** Quét 3 N × 4 lookback × 4 chu kỳ tái cân bằng = 48 tổ hợp:
  **48/48 đều vượt CORE8 ở 365 ngày** (0,74–1,16 vs 0,57). Không phải một điểm may.
- **G2 placebo — ĐẬU dứt khoát.** Đảo xếp hạng (bottom-10 thanh khoản): Sharpe 0,55, maxDD 161,3,
  365d −0,30 (Fast: 0,53 / 140,4 / −1,05). Thanh khoản là cơ chế thật, không phải "rổ khác là được".
- **G3 walk-forward — RỚT.** Turtle top-10 thắng 22/56 cửa sổ, Sharpe TB **1,23 vs 1,22** (hoà);
  Fast 19/56, **0,97 vs 1,16** (thua).

Luật thanh khoản là một luật TỐT (thắng xa rổ ngẫu nhiên 0,88 và placebo 0,55) nhưng **không thắng
được rổ đã biết hậu nghiệm**. Không đủ để đổi. Giá trị thật của thí nghiệm này nằm ở mục 3.

> *Ghi chú kỹ thuật quan trọng:* lần chạy G3 đầu tiên chỉ tải được 30/46 symbol (lỗi mạng bị nuốt im
> lặng) và cho kết luận lệch hẳn (Sharpe TB 1,02 thay vì 1,23). `loadPool` nay **báo** symbol tải hỏng.
> Bất kỳ kết quả nào chạy trước sửa này đều phải chạy lại.

### 4.3 Ensemble đa tốc độ — LOẠI (nhưng có một điều đáng giữ)

`scripts/exp-multispeed.ts`, mỗi tốc độ mang 1/K risk:

| Turtle | Sharpe | NET R | N/DD | độ lệch era | WF TB |
|---|---:|---:|---:|---:|---:|
| 15d (đang chạy) | 1,58 | 715 | 10,16 | 0,229 | 1,22 |
| 10d | 1,57 | 768 | 10,16 | 0,145 | 1,20 |
| 25d | 1,41 | 565 | 9,16 | 0,348 | 1,10 |
| 40d | 1,28 | 459 | 7,46 | 0,328 | 0,97 |
| 10+15 | 1,58 | 740 | 10,22 | **0,172** | 1,21 |
| 10+15+25+40 | 1,50 | 631 | 9,82 | 0,228 | 1,15 |

Không tăng Sharpe (1,58 = 1,58) ⇒ không ship. **Điều đáng giữ:** tốc độ 10–15 ngày là một cao nguyên
phẳng (1,57–1,58), tốc độ chậm 25–40 ngày xấu rõ. Nghĩa là 15 ngày **không phải** con số mong manh —
một lo ngại overfit có thể gạch khỏi danh sách.

### 4.4 Gate LONG liên tục thay vì nhị phân — LOẠI

`scripts/exp-regime-sizing.ts`. Thiết kế sạch: `w = clamp((SMA60/SMA600 − 1)/s, 0, 1)`; **s → 0 cho lại
đúng gate đang chạy**, nên đây là một trục tham số chứa luật cũ ở gốc (không phải luật mới cạnh tranh).
Số vị thế không đổi theo s ⇒ thí nghiệm thuần tuý về sizing.

| s | vốn (×) @DD30 | era A/B/C | 365d | WF TB |
|---|---:|---|---:|---:|
| 0 (gate hiện tại) | 22,45 | 2,51/2,23/4,01 | 1,10 | 1,24 |
| 0,02 | **24,29** | 2,45/2,26/4,39 | 1,14 | 1,27 |
| 0,05 | 19,12 | 2,35/2,03/4,01 | 1,17 | 1,25 |
| 0,10 | 13,76 | 2,30/1,67/3,59 | 1,20 | 1,20 |
| 0,40 | 12,93 | 2,72/1,42/3,36 | 1,42 | 1,04 |

Một điểm hơn rồi rơi thẳng — **đỉnh nhọn cạnh vực, đúng chữ ký overfit**. Loại. (Cột 365d tăng đơn điệu
theo s: làm nhẹ long giúp ích ở regime hiện tại — lại đúng cái bẫy đó.)

---

## 5. Cái ĐƯỢC: hai thay đổi, không đụng một luật vào/ra nào

Chấm bằng **vốn cuối kỳ khi mọi cấu hình bị ép về cùng maxDD** — cách duy nhất công bằng, vì cấu hình
nào giảm dao động thì được phép chạy đòn bẩy cao hơn để về lại mức đau cũ. `scripts/exp-allocation.ts`.

### 5.1 SHIP: heat-decay k=4 cho Fast — thay đổi giá trị nhất cả vòng

| cấu hình danh mục | risk/unit | vốn @DD30 | CAGR | Sharpe | WF TB | WF âm |
|---|---:|---:|---:|---:|---:|---:|
| **ĐANG CHẠY** ½ Turtle + ½ Fast | 0,32% | **18,06×** | 68,4% | 1,53 | 1,13 | 10/56 |
| **½ Turtle + ½ Fast + heat k=4** | 0,52% | **23,69×** | 76,8% | 1,60 | 1,22 | 8/56 |
| chỉ Turtle | 0,49% | 22,45× | 75,1% | 1,59 | 1,23 | 8/56 |

**+31% vốn cuối kỳ ở cùng mức đau.** Ở DD 20%: 7,35× → 8,90× (+21%). Cùng chiều ở cả hai mức.

Cơ chế: Fast đang chạy ngoài chính sách risk danh mục nên nó tự bơm dao động, ép cả danh mục phải hạ
đòn bẩy để giữ DD mục tiêu. Vào khuôn là được thưởng đòn bẩy.

**Plateau (`scripts/exp-fast-heat.ts`) — dạng an toàn nhất có thể:**

| k | TẮT | 2 | 3 | 4 | 5 | 6 | 8 | 12 | 20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| vốn danh mục (×) | 18,06 | 25,03 | 24,25 | **23,69** | 23,24 | 22,89 | 22,33 | 21,57 | 20,70 |
| Sharpe Fast | 1,48 | 1,62 | 1,61 | 1,60 | 1,59 | 1,58 | 1,57 | 1,56 | 1,54 |

**Mọi k từ 2 đến 20 đều thắng TẮT**, đơn điệu, không đỉnh. Cái được xác nhận là **hướng** (có siết),
không phải một con số. Số vị thế giữ nguyên 1000 ở mọi k — heat chỉ đổi SIZE, không bao giờ bỏ lệnh
(giữ đúng bài học A1: trần cứng làm mất trend lớn).

**Chọn k = 4** vì đó đúng hằng số Turtle đang dùng ⇒ **không thêm tham số mới nào vào hệ**. k=2 tốt hơn
chút nhưng nằm ở mép dải đã quét; để dành cho vòng sau.

Việc phải làm: plumb trạng thái danh mục vào `FastTrendLive` giống `TurtleLive.heatWeight`, **tách
commit riêng**, chạy lại `scripts/fast-live-parity.ts`.

### 5.2 ỨNG VIÊN (chưa đủ để ship): chính sách risk nhận biết tương quan

Động cơ từ mục 2.3: corr rổ đi từ 0,49 → 0,81, nhưng `1/(1+H/k)` là hằng số theo thời gian nên mù với
điều đó. Lý thuyết danh mục cho dạng đúng: σ(H) ∝ √(H + H(H−1)ρ) ⇒ `w = 1/√(H + H(H−1)ρ)`.
`scripts/exp-risk-policy.ts`, vốn @DD30:

| chính sách | Turtle | Fast |
|---|---:|---:|
| heat k=4 (đang chạy) | 22,45 | 18,74 |
| heat k=2 | 22,42 | 20,20 |
| heat k=1 | 22,96 | 23,02 |
| 1/√H (giả định ρ=0) | 23,08 | 19,08 |
| 1/H (giả định ρ=1) | 22,96 | 23,02 |
| vol-target ρ **cố định** 0,7 | 22,78 | 22,14 |
| vol-target ρ **động** 90d | **25,64** | **23,96** |

Đối chứng quan trọng: phần lớn lợi ích đến từ **"siết mạnh hơn"** chứ không từ "biết tương quan" —
`1/H` đơn giản đã cho 22,96/23,02. ρ động thêm được +12% (Turtle) / +4% (Fast) nữa. Cả ba era đều
không xấu đi, WF 1,27 vs 1,24, cửa sổ âm 7 vs 8.

**Chưa ship** vì: (a) lợi ích trên đối chứng mạnh nhất chỉ là hạng hai; (b) đưa một đại lượng ước lượng
mới (ρ trượt) vào đường live cần vòng kiểm định riêng có placebo. Ghi lại làm ứng viên vòng sau.

### 5.3 Cái giá của việc tách sàn: nhỏ hơn tưởng

Fast ở MEXC trả 0,08% taker thay vì 0,05% của Binance. Nếu chạy được ở phí Binance: danh mục 23,69× →
**24,42× (+3%)**. Tách sàn đang giải quyết xung đột vị thế Turtle/Fast trên cùng symbol (README §Fast
Trend) — **3% không đáng để phá kiến trúc đó**. Câu hỏi đóng lại.

---

## 5b. Vòng hai: bốn trục KINH TẾ HỌC UNIT — đều LOẠI, nhưng xác nhận cấu hình hiện tại

Vòng một chỉ tìm được thay đổi ở tầng phân bổ vốn. Vòng hai đào vào bên trong phương pháp: bốn trục
không thêm bộ lọc, không thêm chỉ báo, chỉ chỉnh kinh tế học của những unit hệ VỐN ĐÃ vào.
`scripts/exp-unit-economics.ts`. Chấm bằng vốn cuối kỳ ở cùng maxDD 30%.

### E0 — Cơ chế CÓ THẬT: expectancy tăng đơn điệu theo thứ tự unit

| unit# | Turtle: số unit | exp/unit | exp era A/B/C | Fast: exp/unit | exp era A/B/C |
|---|---:|---:|---|---:|---|
| 0 | 1.041 | 0,492 | 0,354 / 0,395 / 0,731 | 0,485 | 0,502 / 0,344 / 0,636 |
| 1 | 666 | 0,557 | 0,405 / 0,395 / 0,941 | 0,637 | 0,461 / 0,570 / 0,882 |
| 2 | 446 | **0,803** | 0,620 / 0,613 / 1,200 | **0,761** | 0,511 / 0,756 / 1,015 |

Unit thứ ba có expectancy **cao hơn ~60%** unit đầu, đúng ở **cả ba era**. Cơ chế rõ: unit sau chỉ tồn
tại khi trend đã chạy, tức là một cược có ĐIỀU KIỆN tốt hơn.

### E1 — Nhưng dồn risk vào unit sau thì THUA (LOẠI)

| Turtle (tổng risk mỗi vị thế không đổi) | Sharpe | vốn (×) | vs mốc |
|---|---:|---:|---:|
| đều 1/1/1 (đang chạy) | 1,59 | **22,45** | — |
| tăng nhẹ 0,8/1,0/1,2 | 1,58 | 22,01 | −2% |
| tăng mạnh 0,6/1,0/1,4 | 1,57 | 21,50 | −4% |
| tăng rất mạnh 0,4/1,0/1,6 | 1,55 | 19,22 | −14% |
| PLACEBO giảm 1,2/1,0/0,8 | 1,59 | 22,31 | −1% |
| PLACEBO giảm mạnh 1,6/1,0/0,4 | 1,58 | 21,99 | −2% |

**Cả hai chiều đều xấu hơn ⇒ chia đều đang đúng.** Lý do: expectancy cao của unit sau **đã được thu
hoạch trọn vẹn chỉ bằng việc vào chúng**; dồn thêm risk vào chỉ cộng thêm rủi ro tương quan đúng lúc
danh mục đang phơi nhiễm nhất (Sharpe tụt 1,59 → 1,55). Ở Fast, placebo xấu rõ (−6%, −17%) trong khi
chiều thuận chỉ đi ngang (+0%) — chiều của hiệu ứng là thật, nhưng không khai thác thêm được.

### E2 — Mẫu số R: lần đầu được quét ĐỘC LẬP, 3,0×ATR giữ nguyên (LOẠI)

`chandelierMult` trong `turtle.ts` làm **hai** việc: khoảng stop ban đầu (mẫu số của mọi R) và khoảng
trail Chandelier của SHORT. Mọi lần quét trước đổi cả hai cùng lúc. Nay tách bằng `initialStopMult`:

| hệ số | Turtle Sharpe | Turtle vốn (×) | Fast Sharpe | Fast vốn (×) |
|---|---:|---:|---:|---:|
| 1,5×ATR | 1,51 | 13,62 | 1,31 | 8,05 |
| 2,0×ATR | 1,57 | 21,22 | 1,49 | 15,80 |
| 2,5×ATR | 1,58 | 20,62 | 1,55 | 12,82 |
| **3,0×ATR (đang chạy)** | **1,59** | **22,45** | **1,60** | 18,74 |
| 3,5×ATR | 1,59 | 21,94 | 1,59 | 14,50 |
| 4,0×ATR | 1,59 | 21,44 | 1,59 | 23,01 |

Siết stop để "mỗi winner đếm được nhiều R hơn" **không hoạt động**: phí chiếm phần lớn hơn mỗi R và số
lần bị quét tăng, ăn hết phần lợi. 3,0 nằm đúng đỉnh cao nguyên Sharpe. (Ô Fast 4,0 = 23,01 là nhiễu
của chuẩn hoá theo maxDD — hàng xóm 3,5 chỉ 14,50 và Sharpe 1,59 < 1,60; không phải cao nguyên.)

### E3 — Trần unit: chấm lại bằng TIỀN, vẫn là 3 (giữ nguyên)

Turtle: 1u 18,36× · 2u 18,00× · **3u 22,45×** · 4u 18,65× · 5u 13,46× · 6u 8,17×.
Fast: 1u 14,73× · 2u 13,86× · **3u 18,74×** · 4u 11,72× · 5u 9,08×.
Quyết định 4→3 ngày 04/08 (chốt bằng Sharpe) **đứng vững cả bằng tiền**.
*Ghi chú:* 1 unit cho walk-forward ổn định nhất (WF TB 1,34, chỉ 3/56 cửa sổ âm so với 8/56) — đó là
đánh đổi ổn-định-đổi-lợi-nhuận nếu có lúc cần, không phải một cải tiến.

### E4 — Bước pyramid: chiều NHANH HƠN chưa ai đo, và cũng không giúp (LOẠI)

Turtle: 0,20 → 18,86× · 0,30 → 21,36× · 0,40 → 20,48× · **0,50 → 22,45×** · 0,75 → 24,69× · 1,00 → 20,52×.
Fast: **0,50 → 18,74×** là cao nhất, 0,75 rơi xuống 13,49×.
Sharpe gần như phẳng (1,56–1,59) trên toàn dải. Ô Turtle 0,75 cao hơn nhưng Fast lại thấp hẳn ở chính
điểm đó ⇒ không nhất quán giữa hai sleeve, không phải hiệu ứng thật.

**Tổng kết vòng hai: bốn trục, không trục nào cho cải tiến.** Giá trị thu được là **âm bản có ích**:
cấu hình hiện tại (chia đều unit · 3,0×ATR · tối đa 3 unit · bước 0,5×ATR) nay đã được kiểm chứng là
nằm ở hoặc sát tối ưu trên chính trục của nó, trong đó **mẫu số R là trục lần đầu được đo tách bạch**.

## 5c. Vòng ba: lưới nến lệch pha — không cải tiến, nhưng tìm ra thước đo overfit tốt nhất repo có

Hệ đọc nến 4h căn theo 00/04/08/12/16/20 UTC. Đó là quy ước của sàn, không phải quy luật kinh tế.
Dựng lại nến 4h từ nến 1h với độ lệch 1h/2h/3h rồi chạy **đúng bộ luật đó** (`scripts/exp-bar-phase.ts`,
cần `scripts/exp-bar-phase-prefetch.ts` chạy trước để tránh 429):

| pha | Turtle Sharpe | Turtle vốn (×) | Fast Sharpe | Fast vốn (×) |
|---|---:|---:|---:|---:|
| **0h (đang chạy)** | **1,58** | **21,51** | **1,58** | **17,89** |
| 1h | 1,53 | 19,92 | 1,38 | 11,50 |
| 2h | 1,38 | 12,54 | 1,35 | 10,78 |
| 3h | 1,41 | 8,37 | 1,31 | 8,06 |
| trung bình | 1,47 | 15,59 | 1,40 | 12,06 |

**Chênh 157% (Turtle) / 122% (Fast) vốn cuối kỳ chỉ vì chọn mốc nến khác đi.** Và pha production là
pha **tốt nhất trong cả bốn, ở CẢ HAI sleeve** — xác suất 1/16 nếu là ngẫu nhiên.

Cách đọc trung thực: mọi tham số của hệ (15d, 20d, 30d, 3,0×ATR, bước 0,5, 3 unit, gate 60/600) đều
được chọn bằng cách tối ưu **trên pha 0h**. Ba pha kia chưa từng tham gia vào việc chọn gì cả. Việc
chúng kém hơn không chứng minh pha 0h tốt hơn về bản chất — nó đo phần hiệu suất **dính vào nhiễu
riêng của pha 0h**. (Có một cơ chế thật đứng về phía pha 0h: 00/08/16 UTC là mốc funding của Binance
và 00:00 UTC là mốc đóng ngày mà cả thị trường nhìn. Nhưng cơ chế đó khó giải thích nổi biên độ 157%.)

**Ensemble 4 pha (mỗi pha ¼ risk) — KHÔNG ship.** Turtle 1,55 | 17,31× · Fast 1,48 | 12,72×. Nó làm
đúng việc đa dạng hoá được kỳ vọng: **thắng pha TRUNG BÌNH** (Turtle +11%, Fast +5%), tức nếu mốc nến
là ngẫu nhiên thì ensemble là lựa chọn đúng. Nhưng nó **thua pha 0h đang chạy** (−20% / −29%), và chi
phí là 4× độ phức tạp thực thi. Không đủ để đổi.

**Giá trị thật của vòng này là phương pháp luận:** ba pha lệch là **dữ liệu giả-OOS gần như miễn phí**
cho mọi ứng viên sau này. Không hoàn toàn độc lập (cùng thị trường, chồng lấn cao) nhưng độc lập với
*quá trình tinh chỉnh*, và đó chính là thứ ta cần đề phòng.

### Áp dụng ngay cho khuyến nghị duy nhất còn sống

| pha | Fast KHÔNG heat | Fast + heat k=4 | thay đổi |
|---|---:|---:|---:|
| 0h | 1,46 \| 14,51× | 1,58 \| 17,89× | **+23%** |
| 1h | 1,32 \| 9,65× | 1,38 \| 11,50× | **+19%** |
| 2h | 1,33 \| 10,09× | 1,35 \| 10,78× | **+7%** |
| 3h | 1,24 \| 6,73× | 1,31 \| 8,06× | **+20%** |

**Thắng 4/4 pha.** Đây là bằng chứng mạnh nhất trong cả ba vòng: heat-decay không phải thứ hợp với
nhiễu của lưới nến hiện tại — nó là chính sách rủi ro đúng trên mọi lưới.

## 6. Trả lời thẳng câu hỏi "làm sao tăng Net R"

1. **Bật bot lại.** Không có gì khác quan trọng bằng. (mục 0)
2. **Ship heat-decay k=4 cho Fast** → +31% vốn cuối kỳ ở cùng maxDD, không đổi một luật tín hiệu nào,
   plateau an toàn nhất trong mọi thứ đã đo, và **thắng 4/4 lưới nến giả-OOS**. (mục 5.1, 5c)
3. **Hạ kỳ vọng xuống Sharpe ~1,2–1,4**, đừng lập kế hoạch theo 1,58 — hai đường bằng chứng độc lập
   cùng chỉ về đó: rổ CORE8 là hậu nghiệm (mục 3) và pha nến 0h là pha may nhất trong bốn (mục 5c).
4. **Không đổi rổ, không mở rổ, không đổi tốc độ, không làm mềm gate, không đổi trọng số unit, không
   siết mẫu số R, không đổi trần unit hay bước pyramid.** Tất cả đều có số liệu loại. (mục 4, 5b)

**Về cải tiến LUẬT: mười hai trục đã thử trong ba vòng, không trục nào sống sót.** Đó không phải thất
bại của việc tìm — đó là kết quả: phương pháp đã ở sát tối ưu trên chính họ luật của nó, và những gì
còn lại để giành đều nằm ở tầng **phân bổ vốn** (mục 5) chứ không ở tầng tín hiệu. Muốn thêm nguồn lợi
nhuận thật thì phải là một họ luật KHÁC HẲN có tương quan thấp với trend — và phải qua đúng cửa: cơ chế
trước, plateau, ba era, phí thật, **bốn pha nến**, rồi forward-test.

Về "khi nào hết ảm đạm": theo dõi **VR(20) của rổ** và **tỉ lệ follow-through của breakout LONG**
(`scripts/exp-market-regime.ts`). Hai năm 2025–2026 là hai năm quay đầu mạnh nhất mẫu; khi VR(20) về
lại ≥1 và long follow-through về ≥50%, sleeve long — nơi chứa toàn bộ edge lịch sử (+1,27R/unit toàn
kỳ) — sẽ tự bật lại. Không có nút bấm nào ép nó sớm hơn: mọi thứ thử để bắt sóng nhỏ trong chop đều đã
thất bại sau phí, ở vòng này và ba vòng trước.

Và ghi nhận cho đúng: **365 ngày qua danh mục vẫn DƯƠNG** — ở hiệu chuẩn maxDD 30% thì +10~12% vốn.
"Gần như không kiếm được gì", đúng; "thua lỗ", không.

---

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 200      # mục 1
./node_modules/.bin/ts-node scripts/fast-live-parity.ts 200        # mục 1
./node_modules/.bin/ts-node scripts/exp-downtime.ts 800 2026-07-20 # mục 0
./node_modules/.bin/ts-node scripts/exp-market-regime.ts 2300      # mục 2
./node_modules/.bin/ts-node scripts/exp-universe-probe.ts          # pool 46 coin
./node_modules/.bin/ts-node scripts/exp-breadth.ts 2300 16         # mục 3
./node_modules/.bin/ts-node scripts/exp-liquidity-universe.ts 2300 # mục 3, 4.2
./node_modules/.bin/ts-node scripts/exp-universe-robust.ts 2300    # mục 4.2 (G1/G2/G3/G4)
./node_modules/.bin/ts-node scripts/exp-core-plus.ts 2300          # mục 4.1
./node_modules/.bin/ts-node scripts/exp-multispeed.ts 2300         # mục 4.3
./node_modules/.bin/ts-node scripts/exp-regime-sizing.ts 2300 30   # mục 4.4
./node_modules/.bin/ts-node scripts/exp-allocation.ts 2300 30      # mục 5.1, 5.3
./node_modules/.bin/ts-node scripts/exp-fast-heat.ts 2300 30       # mục 5.1 plateau
./node_modules/.bin/ts-node scripts/exp-risk-policy.ts 2300 30     # mục 5.2
./node_modules/.bin/ts-node scripts/exp-unit-economics.ts all 2300 # mục 5b (E0–E4)
KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-bar-phase-prefetch.ts 2300
KLINE_FETCH_CONCURRENCY=1 ./node_modules/.bin/ts-node scripts/exp-bar-phase.ts 2300  # mục 5c (P1–P3)
```

Thay đổi engine trong vòng này: `ExtParams.initialStopMult` (tách mẫu số R khỏi `chandelierMult`).
Mặc định undefined ⇒ hành vi không đổi một bit; đã chạy lại **cả hai gate parity, cả hai PASS**.

## Giới hạn đã biết của nghiên cứu này

- Pool 46 coin gồm những coin **còn tải được hôm nay**; coin đã biến mất hẳn khỏi API (vd LUNA, FTT)
  không có mặt. Ước lượng ở mục 3 vì thế vẫn hơi **lạc quan**, dù đã kém CORE8 nhiều.
- EOS (hết 2025-05) và MATIC (hết 2024-09) được giữ để bớt survivorship bias; khi sổ hết dữ liệu mà
  còn vị thế mở thì phần chưa thực hiện của nó rời khỏi chuỗi mark-to-market — ảnh hưởng ≤3R, không
  đổi kết luận nào.
- maxDD là **một** quan sát cực trị nên rất nhiễu; vì vậy mọi bảng đều kèm Sharpe và walk-forward.
- Toàn bộ ứng viên được thử trên cùng bộ dữ liệu ⇒ mọi "winner" đơn lẻ đều chịu selection bias. Đó là
  lý do chỉ mục 5.1 được đề nghị ship: nó thắng ở **mọi** giá trị tham số đã quét, không phải ở một.
