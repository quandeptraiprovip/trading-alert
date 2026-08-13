# Turtle + Fast — vì sao 12 tháng qua yếu, và cái gì thật sự sửa được (2026-08-10)

Mọi số là backtest/diagnostic trên **2.026 ngày (2021-01-22 → 2026-08-10)**, rổ 8 coin, nến 4h, phí thật
(Turtle 0,05% taker + 0,02% slip; Fast 0,08% MEXC + 0,02%; funding 0,01%/8h). Không phải cam kết lợi nhuận.

Tham số dùng để đo là **tham số production**, đã chốt bằng hai gate parity (`scripts/turtle-live-parity.ts`,
`scripts/fast-live-parity.ts` — cả hai PASS ngày 2026-08-10). Lưu ý: `sleeveParams()` trong
`scripts/rx-lab.ts` đã CŨ (Fast ở đó vẫn chandelier/max4, tức bản TRƯỚC lần ship 09/08). Script mới
`scripts/chop-diagnosis.ts` đọc hằng số thẳng từ `fast-trend-live.ts` nên số liệu áp dụng cho bot thật.

## 0. Điều phải nói trước: bot đã DỪNG từ 20/07/2026

| bằng chứng | giá trị |
|---|---|
| `trading-runtime/turtle-state.json` → `lastBarTime` | 2026-07-20T08:00Z (nến 4h cuối được xử lý) |
| mtime `turtle-state.json` / `bot-state.json` | 20/07 19:51 · 20/07 20:00 |
| mtime `fast-trend-mexc-state.json` | 22/07 23:47 |
| docker daemon | không chạy (`unix:///Users/quanton/.docker/run/docker.sock` không tồn tại) |
| `trades-live.jsonl` | **3** exit, cả 3 đều `sl` −1R (26/06 XRP short, 29/06 XRP short, 04/07 SOL long) |
| `turtle-trades.jsonl` | 0 byte |

Nghĩa là **không có 12 tháng dữ liệu live nào để đánh giá**. Con số "âm Net R" mà mắt thường thấy đến từ
một mẫu 3 lệnh đều thua, cộng chuỗi 10/10 short thua 23/07–02/08 đã ghi trong
`live-losing-streak-forensics`, trên **luật CŨ** (mid-20d chỉ ship 04/08 và 09/08). Đó là mẫu quá nhỏ và
sai luật để kết luận về phương pháp. Việc cần làm trước mọi thay đổi rule: bật lại bot và ghi journal.

## 1. Đo lại bằng luật production: 12 tháng qua DƯƠNG nhưng yếu ~3×

Sharpe | NET R theo năm:

| sleeve | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|
| Turtle | 2,06 \| 191 | 0,47 \| 20 | 1,76 \| 137 | 2,26 \| 273 | 0,90 \| 53 | 1,26 \| 42 |
| Fast | 2,14 \| 463 | 0,15 \| 10 | 2,02 \| 315 | 1,84 \| 434 | 0,33 \| 34 | 1,45 \| 80 |

Cửa sổ trượt tính từ nến cuối (Sharpe | NET R | số vị thế):

| sleeve | 180d | 365d | 545d | 730d | 1.095d |
|---|---:|---:|---:|---:|---:|
| Turtle | 0,59 \| 14 \| 66 | **0,60 \| 30 \| 185** | 1,10 \| 96 \| 266 | 1,75 \| 313 \| 340 | 1,96 \| 536 \| 557 |
| Fast | 0,88 \| 35 \| 49 | **0,63 \| 50 \| 140** | 0,82 \| 123 \| 233 | 1,50 \| 526 \| 301 | 1,76 \| 927 \| 492 |

**Không sleeve nào âm Net R trong 365 ngày.** Nhưng Sharpe 0,60/0,63 so với 1,96/1,76 của cửa sổ 1.095
ngày — yếu đi khoảng ba lần. Đây là "gần như không kiếm được gì", đúng cảm nhận, chỉ khác dấu.

## 2. Chỗ ÂM là sổ LONG, không phải cả hệ

Phân rã 365 ngày gần nhất (có nhân trọng số risk):

| sleeve | bên | unit | GROSS | phí | NET | exp/unit |
|---|---|---:|---:|---:|---:|---:|
| Turtle | long | 75 | −27,4 | 2,4 | **−29,8R** | **−0,660** |
| Turtle | short | 284 | +68,6 | 7,4 | +61,2R | +0,376 |
| Fast | long | 64 | −43,4 | 4,0 | **−47,5R** | **−0,741** |
| Fast | short | 235 | +109,2 | 10,4 | +98,7R | +0,420 |

Short đang GÁNH cả danh mục; long bào mòn. Nhìn theo năm thì rõ đây là cấu trúc, không phải may rủi
(exp/unit):

| sleeve · bên | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---:|---:|---:|---:|---:|---:|
| Turtle long | +1,65 | −0,69 | +0,81 | +3,10 | +0,23 | −0,49 |
| Turtle short | −0,22 | +0,18 | +0,26 | −0,05 | +0,21 | +0,60 |
| Fast long | +1,72 | −0,74 | +1,30 | +2,36 | +0,09 | −0,65 |
| Fast short | −0,28 | +0,11 | +0,28 | −0,07 | +0,08 | +0,77 |

Toàn kỳ: **long 834 unit exp +1,27R · short 1.316 unit exp +0,16R** (Fast: 810u +1,27 · 1.057u +0,15).
Tức **toàn bộ edge lịch sử nằm ở LONG trong regime tăng**; short gần như hoà và chỉ có giá trị hedge.

## 3. Cơ chế: bên có edge bị regime TẮT đi, không phải luật hỏng

| năm | ER30 (rổ) | ATR20% (rổ) | % thời gian BTC gate MỞ | BTC return | swing ≥10%/coin/năm | swing ≥25% |
|---|---:|---:|---:|---:|---:|---:|
| 2021 | 0,160 | 3,83 | 69% | +40% | 196 | 38,7 |
| 2022 | 0,169 | 2,73 | 6% | −65% | 97 | 18,8 |
| 2023 | 0,168 | 1,88 | 74% | +156% | 52 | 6,1 |
| 2024 | 0,177 | 2,31 | 78% | +121% | 78 | 12,1 |
| 2025 | 0,165 | 2,43 | 54% | −7% | 68 | 12,3 |
| 2026 | 0,151 | 1,92 | **20%** | −26% | 43 | 6,2 |

Gate LONG chỉ mở 20% thời gian 2026 (so 74–78% ở 2023/24), ATR% về đáy chu kỳ, số sóng ≥10% giảm còn
~55% của 2024/25. **Sóng nhỏ vẫn còn (43 sóng ≥10% mỗi coin mỗi năm) — nhận định của bạn đúng** — nhưng
hệ Donchian 10–15 ngày không được thiết kế để bắt chúng, và mọi thử nghiệm bắt chúng đều đã thất bại
sau phí (mục 5).

Đồng thời loại ba nghi phạm phổ biến:

- **Phí: KHÔNG phải nguyên nhân.** Phí chỉ ăn 2,0–4,4% gross (Turtle) và 2,5–6,0% (Fast) theo từng năm.
- **Trả lại lợi nhuận (giveback): KHÔNG phải.** Lệnh thua 365d giữ trung bình chỉ 2,0–2,3 ngày; 58–61%
  chưa từng đạt 0,5R. Chúng chết nhanh, không có gì để cứu bằng trailing/breakeven.
- **Kênh thoát mid-20d: không phải nguyên nhân gốc**, dù đúng là nó kém hơn chandelier trong regime này —
  điều đã được ghi thẳng ở `fast-exit-channel-2026-08.md` mục "CẢNH BÁO TRUNG THỰC". Xác nhận lại:
  Turtle CŨ (chand, 4u, no-heat) 365d Sharpe 1,06/+126R vs SHIP 0,60/+30R; Fast CŨ 1,02/+92R vs SHIP
  0,63/+50R. Nhưng 1.095d thì SHIP thắng đậm (1,96 vs 1,41 · 1,76 vs 1,15). Đổi lại theo cửa sổ 12
  tháng chính là cái bẫy đã đăng ký.

## 4. BỐN hướng khắc phục đã thử và LOẠI (số liệu để đừng lặp lại)

### 4.1 Gate SHORT theo regime BTC — LOẠI

Phát hiện gốc rất mạnh: short vào lúc BTC regime TĂNG có exp **+0,30R/unit** (509u), lúc regime GIẢM chỉ
**+0,07R/unit** (807u); riêng 365d là +1,19 vs +0,06. Cơ chế hợp lý (alt phá đáy khi BTC còn mạnh = yếu
riêng, còn khi BTC tự rơi thì breakout xuống đông đúc, dễ squeeze). Nhưng **không khai thác được**:

| Turtle | NET R | maxDD | NET/DD | Sharpe | era A/B/C | NET tđ |
|---|---:|---:|---:|---:|---|---:|
| BASE short tự do | 716 | 70,4 | 10,18 | 1,58 | 1,44/1,36/1,89 | — |
| short chỉ khi BTC ↑ | 688 | **78,0** | 8,87 | 1,59 | 1,53/1,33/1,87 | 624 (**−13%**) |
| PLACEBO short khi BTC ↓ | 644 | 65,0 | 9,98 | 1,46 | 1,48/1,26/1,61 | 702 |

Fast tương tự: N/DD 9,83 → 8,14, NET tđ −17%. **exp/unit tăng gấp đôi nhưng maxDD TĂNG** — vì chính
những short "chất lượng thấp" trong regime giảm là hedge cho sổ long. Placebo xấu rõ ⇒ chiều của hiệu ứng
là thật, nhưng cắt short vẫn sai. Trùng kết luận cũ "two-sided gate → loại" và ghi chú
`portfolio-risk-policy` ("đừng cắt short!").

### 4.2 Đổi TỈ TRỌNG RISK giữa hai bên (không lọc) — LOẠI

`short×0,25…0,75` cho Turtle: NET tđ −14%…−1%; 365d Sharpe 0,60 → 0,20 (×0,50). Fast: NET tđ −13%…−3%;
365d 0,63 → 0,01. Không có plateau dương nào. *Cảnh báo kỹ thuật: `runBooks` kẹp weight vào [0;1]
(`Math.max(0, Math.min(1, w))`), nên các dòng hệ số >1 trong sweep là no-op — chiều TĂNG size chưa được đo.*

### 4.3 Lọc vào lệnh theo ATR (biến động chưa phình) — LOẠI

Hiệu ứng gross rất lớn: chia 2.150 unit Turtle theo ATR20%/giá lúc vào, net/unit là
**1,072 / 0,853 / 0,839 / 0,309 / 0,298** từ Q1 (0,6–1,7%) đến Q5 (3,5–21%); Fast gần y hệt. Nhưng:

- Bản **tương đối** (ATR ≤ m × median 90 nến trước): m=1,0 → Turtle NET tđ **−59%**, era 0,98/0,86/1,01
  (base 1,44/1,36/1,89); Fast −69%. Loại thẳng.
- Bản **tuyệt đối** ATR% ≤ 2,5: NET tđ −14%, **era A sụp 1,44 → 0,73**, dù cửa sổ gần đây có đẹp hơn
  (365d 0,60→0,64; 545d 1,10→1,22; 1.095d 1,96→2,05). Đây đúng dạng "chỉ tốt ở regime gần đây" mà
  `trend-method-remediation-research` đã dặn không promote.

Kết luận: chênh lệch exp theo ATR là **trade-off exp/unit vs tổng lợi nhuận**, không phải alpha lọc được.

### 4.4 "No-progress exit" — loại bằng lập luận từ số liệu, không cần chạy

Lệnh thua đã tự chết trong 2,0–2,3 ngày và 58–61% chưa tới 0,5R. Không còn vốn nào bị treo để giải phóng.

## 5. Cái DUY NHẤT vững: hai sleeve KHÔNG đa dạng hoá — đó là đòn bẩy, không phải giảm rủi ro

Tương quan P&L **ngày** Turtle↔Fast: 0,96 toàn kỳ; 0,94–0,98 theo từng năm; 91% unit Fast vào khi Turtle
đang giữ **cùng symbol cùng hướng**.

Trộn w·Turtle + (1−w)·Fast ở TỔNG risk không đổi (cả hai đang 0,5%/unit nên R cộng được):

| w(Turtle) | Sharpe | NET R | maxDD | NET/DD |
|---|---:|---:|---:|---:|
| 1,00 (chỉ Turtle) | **1,57** | 714 | 70,4 | 10,14 |
| 0,75 | 1,54 | 868 | 81,2 | 10,68 |
| 0,50 (**đang chạy**) | 1,51 | 1.022 | 98,7 | 10,36 |
| 0,25 | 1,48 | 1.176 | 117,3 | 10,03 |
| 0,00 (chỉ Fast) | 1,46 | 1.330 | 135,9 | 9,79 |

Sharpe **đơn điệu** giữa hai đầu mút — dấu hiệu kinh điển của "không có đa dạng hoá". Kiểm định ổn định
trên **56 cửa sổ 365 ngày trượt theo tháng**:

- Sharpe trung bình: **chỉ Turtle 1,22 · 50/50 1,11 · chỉ Fast 1,04**
- Số cửa sổ thắng: Turtle **44** · 50/50 3 · Fast 9
- Số cửa sổ mà 50/50 **vượt CẢ HAI** đầu mút (bằng chứng đa dạng hoá thật): **3/56 = 5%**

Theo era (Sharpe): A 1,42/1,46/1,46 · B 1,36/1,32/1,27 · C **1,89**/1,72/1,62.

**Ý nghĩa cho Net R:** chia risk cho hai sleeve gần-trùng-nhau không giảm rủi ro, chỉ hạ Sharpe. Muốn
nhiều Net R hơn ở cùng mức drawdown thì **dồn risk vào MỘT sleeve**, và đó là quyết định phân bổ —
không phải đổi luật, nên không mang rủi ro overfit.

## 6. Ứng viên đã có bằng chứng, CHƯA ship: Fast + heat-decay k=4

Kiểm chứng lại con số của `fast-exit-channel-2026-08.md` (mục "đã thử"):

| Fast | Sharpe | NET R | maxDD | NET/DD | era A/B/C |
|---|---:|---:|---:|---:|---|
| hiện tại (không heat) | 1,46 | 1.337 | 135,9 | 9,83 | 1,48/1,27/1,62 |
| + heat k=4 | **1,58** | 650 | **64,2** | 10,12 | **1,61/1,39/1,71** |

Cả ba era đều tăng. Phần lớn tác dụng là **giảm đòn bẩy** (maxDD 136→64) cộng thêm +0,12 Sharpe thật.
Sau khi thêm heat, Fast ≈ Turtle về chất lượng (1,58 vs 1,57; N/DD 10,12 vs 10,14) và corr vẫn 0,98 ⇒
**chọn sleeve nào ít quan trọng; đừng chia đôi mới là điều quan trọng.**

Việc cần làm là plumb trạng thái danh mục vào `FastTrendLive` giống `TurtleLive.heatWeight` — thay đổi ở
tầng sizing của lớp đặt lệnh thật, phải tách commit và chạy lại `scripts/fast-live-parity.ts`.

## 7. Trả lời thẳng câu "làm sao có lãi khi khung lớn không có sóng"

Trong họ luật này, **không có**. Đã thử và loại, ở vòng này và các vòng trước:

- vòng này: gate short theo regime · tỉ trọng risk hai bên · lọc ATR (tuyệt đối + tương đối) · no-progress exit
- vòng trước (`trend-method-remediation-research`, `fast-exit-channel`): chandelier 2,5/3,5/4 · kênh thoát
  12–30d · mid cho short · xác nhận 1–2 nến cho short · cooldown 1–5 ngày · pyramid step · max unit ·
  max hold 25–40d · gate chặt hơn/bỏ gate · mở rổ >8 coin · heat k=2/3/6/8
- chiến lược khác (`independent-strategy-research`): XS momentum (forward-test only, 2026 YTD −3,5R) ·
  spot–perp carry (edge đã decay, holdout 0 lệnh) · funding-tail (−90R) · cross-sectional basis (−662R) ·
  quarter-hour order flow (−113…−249R) · mean-reversion (thua sau phí)

Kết luận trung thực: **im lặng trong chop là thuộc tính của phương pháp trend, không phải lỗi cần vá.**
Hai đòn bẩy thật sự còn lại đều là quản trị vốn, không phải tín hiệu:

1. **Không chia risk cho hai sleeve gần-trùng** (mục 5) — nâng Sharpe từ ~1,11 lên ~1,22 trên trung bình
   56 cửa sổ 365 ngày.
2. **Ship heat-decay cho Fast** nếu vẫn giữ Fast (mục 6).

Muốn thêm nguồn lợi nhuận trong chop thì phải là **một họ luật khác hẳn, có corr thấp với trend**, và
phải qua đúng cửa: cơ chế trước, plateau, ba era, phí thật, rồi forward-test — không phải thêm bộ lọc vào
Turtle/Fast.

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/chop-diagnosis.ts base 2300     # mục 1, 2
./node_modules/.bin/ts-node scripts/chop-diagnosis.ts why 2300      # mục 2, 3 (cũ vs ship)
./node_modules/.bin/ts-node scripts/chop-diagnosis.ts regime 2300   # mục 3 (bối cảnh, sóng nhỏ)
./node_modules/.bin/ts-node scripts/chop-diagnosis.ts cost 2300     # mục 3 (phí), 4.3 (ATR quintile)
./node_modules/.bin/ts-node scripts/chop-diagnosis.ts gate 2300     # mục 4.1 (phát hiện gốc)
./node_modules/.bin/ts-node scripts/exp-short-gate.ts main 2300     # mục 4.1 (kiểm định + placebo)
./node_modules/.bin/ts-node scripts/exp-side-risk.ts 2300           # mục 4.2
./node_modules/.bin/ts-node scripts/exp-vol-entry-filter.ts 2300    # mục 4.3
./node_modules/.bin/ts-node scripts/exp-sleeve-blend.ts 2300        # mục 5, 6
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 200       # chốt: đo đúng luật đang chạy
./node_modules/.bin/ts-node scripts/fast-live-parity.ts 200
```
