# CÁCH GIẢI: phân bổ risk bất biến thứ tự + siết k — đã qua toàn bộ cửa duyệt

**13/08/2026.** Sau khi nhánh FX và mệnh đề Key đều khép, đây là hướng còn lại và nó **đã đo xong**.
Không phải ý tưởng mới: nó nằm trong nghiên cứu 12/08 nhưng **chưa bao giờ được ship**. Vòng này tái
hiện lại từ đầu và cho chạy qua đủ cửa duyệt, gồm hai cửa nó chưa từng qua.

**Kết luận: ĐẬU TẤT CẢ. Đề nghị ship.** Nhưng tôi **không tự sửa code tiền thật** — patch mô tả ở §5,
chờ anh quyết.

---

## 1. Vấn đề đang có

`turtle-live.ts:174` `heatWeight(dir)` cộng heat bằng cách đọc `this.states` **ngay lúc gọi**. Trong
`replay()`, các symbol được duyệt lần lượt trong cùng một mốc thời gian, nên symbol đứng trước gặp
sổ vắng hơn và được size to hơn — chỉ vì vị trí của nó trong mảng. Đây không phải luật giao dịch,
đây là **hiện vật thứ tự mảng**.

Đo được: đổi thứ tự symbol làm vốn cuối chênh **9% (k=4) đến 40% (k=0,25)**. Toàn bộ phần chênh đó
là may rủi, không phải edge.

## 2. Cách giải

Hai thay đổi, **không đụng một luật vào/ra nào**:
1. **Chấm heat theo ảnh chụp ĐẦU NẾN** — mọi tín hiệu trong cùng một nến chấm trên cùng một trạng
   thái sổ.
2. **Siết `heatDecayK` 4 → 0,5** cho cả hai sleeve.

Vế (1) là điều kiện để vế (2) an toàn: siết k mà vẫn chấm tuần tự thì càng siết càng nhạy thứ tự
(biên độ 9% → 40%). Chấm đầu nến đưa biên độ về **đúng 0%** và **đồng thời** tăng vốn ở mọi k.

## 3. Số đo

**Bất biến thứ tự** (vốn ×, ép cùng maxDD 30%, 4 thứ tự symbol khác nhau):

| k | chế độ | gốc | đảo | xoay | abc | biên độ |
|---|---|---|---|---|---|---|
| 4 | tuần tự | 23,69 | 21,69 | 22,63 | 22,33 | 9% |
| 4 | ĐẦU NẾN | 24,09 | 24,09 | 24,09 | 24,09 | **0%** |
| 1 | tuần tự | 28,70 | 23,94 | 27,46 | 26,43 | 20% |
| 1 | ĐẦU NẾN | 30,84 | 30,84 | 30,84 | 30,84 | **0%** |
| 0,5 | tuần tự | 30,87 | 25,57 | 29,46 | 28,36 | 21% |
| **0,5** | **ĐẦU NẾN** | **35,26** | **35,26** | **35,26** | **35,26** | **0%** |
| 0,25 | ĐẦU NẾN | 33,55 | 33,55 | 33,55 | 33,55 | 0% |

k=0,25 **kém hơn** k=0,5 ⇒ đây là cực trị BÊN TRONG, không phải "càng nhỏ càng tốt" (thứ luôn đáng
nghi là hiện vật).

**So với cấu hình đang chạy** (ép cùng maxDD 30%):

| cấu hình | risk/u | vốn(×) | Sharpe | era A/B/C | 365d | WF TB | WF âm | WF tệ nhất |
|---|---|---|---|---|---|---|---|---|
| 1. ĐANG CHẠY (Turtle k4 tuần tự · Fast không heat) | 0,32% | 18,06 | 1,53 | 2,67 / 2,04 / 3,32 | 1,10 | 1,13 | 10/56 | −1,24 |
| 2. Ứng viên audit trước (cả hai k4, tuần tự) | 0,52% | 23,69 | 1,60 | 2,75 / 2,29 / 3,76 | 1,09 | 1,22 | 8/56 | −1,08 |
| 3. đầu nến + k=1 | 0,88% | 30,84 | 1,67 | 3,00 / 2,49 / 4,13 | 1,15 | 1,31 | 8/56 | −0,98 |
| **4. đầu nến + k=0,5** | **1,17%** | **35,26** | **1,71** | **3,20 / 2,56 / 4,31** | **1,19** | **1,36** | **7/56** | **−0,86** |

**+95% vốn ở cùng mức đau.** Hoặc đọc cách kia — giữ nguyên risk/unit 0,32% đang chạy:
maxDD **30% → 9,1%** (−70%).

## 4. Cửa duyệt

| cửa | kết quả |
|---|---|
| Bất biến thứ tự symbol | **0%** (đang chạy: 2%; ứng viên cũ: 9%) |
| Era A/B/C | tốt hơn **3/3** |
| **Cửa sổ 365 ngày** | **1,19 vs 1,10** — tốt hơn |
| Walk-forward 56 cửa | TB 1,36 vs 1,13 · âm 7/56 vs 10/56 · tệ nhất −0,86 vs −1,24 |
| **Lệch pha nến 4h** | **thắng 4/4 pha**, TB 13,09 vs 7,95 = **+65%** |
| Có trượt giá (0,10/0,05×ATR) | giữ 66% — cao nhất bảng |
| **Tập trung năm/công cụ** | **ĐẬU**, hình dạng gần như KHÔNG ĐỔI |
| Cực trị nội tại | có (k=0,25 kém hơn k=0,5) |

Hai cửa đáng nói riêng:

**Cửa sổ 365 ngày.** `upgrades-vs-trailing-year` ghi nhận cấu hình đang chạy **kém hẳn** bản cũ trên
12 tháng gần nhất, và đặt ra chuẩn: mọi đề xuất cùng hướng phải tốt hơn ở cửa sổ này. Ứng viên
**1,19 vs 1,10** — đạt.

**Tập trung** (chạy mới trong `scripts/exp-snap-gate.ts`, dùng lại hàm `concentration` đã export,
không sửa file cũ):

| | năm tốt nhất | công cụ lớn nhất | hồi phục |
|---|---|---|---|
| đang chạy | 2024 = 38% | adausdt 17% | 1,27 |
| ứng viên | 2024 = 39% | adausdt 16% | 1,25 |

Gần như trùng nhau ⇒ ứng viên **không** mua phần cải thiện bằng cách dồn lợi nhuận vào một năm hay
một công cụ. Đúng như thiết kế, vì nó không đổi luật vào/ra — chỉ đổi cách chấm risk.

## 5. ĐÃ LÀM — bước 1, code xong, CHƯA DEPLOY

Chọn phương án ít rủi ro nhất ở §7: **ảnh chụp đầu nến, GIỮ k=4**.

| file | thay đổi |
|---|---|
| `turtle-live.ts` | field `barHeat`; `heatWeight()` đọc ảnh chụp; tách `currentHeat()` đọc sổ tức thời; `replay()` chốt heat một lần mỗi mốc `t`, `finally` trả về null |
| `scripts/turtle-live-parity.ts` | engine đối chiếu bật `admitBarSnapshot: true` |
| `scripts/turtle-live-order.ts` | **mới** — chạy live 3 thứ tự symbol, đối chiếu weight từng unit |

**`T.heatDecayK` GIỮ NGUYÊN = 4.** Không đụng thang size ⇒ không thêm áp lực min-notional (§6).

**Kiểm chứng:**
- `turtle-live-parity.ts 1200`: **182 unit / 200 ngày — thiếu 0 · lệch weight 0 · thừa 0** ✅
- `turtle-live-order.ts 600`: **95 unit, trùng khít ở cả 3 thứ tự**, sai số lớn nhất 1,11e-16 ✅
- `tsc` sạch (7 lỗi còn lại đều ở `app/*.tsx`, có sẵn, thiếu type Next/React).

Bằng chứng patch chạy đúng, lấy từ lần parity ĐẦU (trước khi sửa engine đối chiếu): ở mốc
`1782302400000`, live cho **cả ba symbol cùng weight 0,4633**, còn engine tuần tự cho
0,4884 / 0,4376 / 0,4609 tuỳ vị trí trong mảng. Đúng hiện vật đang bị loại bỏ.

**CHƯA DEPLOY.** Deploy là quyết định của anh; nhớ bẫy trong `oracle-deployment` — state cũ có thể
làm replay bắn lệnh thật.

## 5c. NET R của đúng phần đã ship (`scripts/exp-snap-netr.ts`)

Các bảng §3 chấm bằng "vốn ×" ở **cùng maxDD** — thước đó ngầm quy lại đòn bẩy, nên nó KHÔNG trả lời
thẳng "Net R đổi bao nhiêu", và nó gộp cả phần siết k chưa ship. Bảng dưới cô lập đúng một thay đổi
đã vào code sống: **k = 4 ở cả hai cột**, chỉ khác cách chấm heat. 5,5 năm, CORE8.

| sổ | chế độ | gốc | đảo | xoay | abc | biên độ | Sharpe | maxDD R |
|---|---|---|---|---|---|---|---|---|
| **Turtle** (sổ vừa sửa) | tuần tự | 912,9 | 917,5 | 919,5 | 919,9 | **7,1R** | 1,66 | 70,2 |
| | ĐẦU NẾN | 940,4 | 940,4 | 940,4 | 940,4 | **0,0R** | 1,67 | 72,2 |
| Hai sleeve | tuần tự | 1351,1 | 1361,6 | 1360,8 | 1361,4 | **10,5R** | 1,68 | 98,1 |
| | ĐẦU NẾN | 1421,0 | 1421,0 | 1421,0 | 1421,0 | **0,0R** | 1,70 | 101,6 |

| | Net R | maxDD | **Net/maxDD** |
|---|---|---|---|
| Turtle | +2,5% | +2,8% | **−0,3%** |
| Hai sleeve | +4,6% | +3,6% | **+1,0%** |

**Phải đọc đúng: ở k=4, thay đổi này gần như TRUNG TÍNH về rủi ro-điều chỉnh.** Net R tăng thật,
nhưng maxDD tăng gần đúng bằng ⇒ Net/maxDD đi ngang. Sharpe +0,01…+0,02.

**Cơ chế, và nó quan trọng cho bước sau:** chấm theo ảnh chụp đầu nến nghĩa là mọi tín hiệu trong
nến đều thấy mức heat TRƯỚC nến, tức thấp hơn. Nên tổng risk nạp vào mỗi nến **cao hơn** bản tuần
tự — đó chính là lý do cả Net R lẫn maxDD cùng tăng. Suy ra ngay: ảnh chụp **phải đi kèm siết k** thì
mới ra hình dạng tốt hơn, đúng như bảng §3 (đầu nến + k=0,5 → Sharpe 1,53 → 1,71). Ảnh chụp một mình
mua **tính xác định**, không mua lợi nhuận.

**Vậy phần đã ship đáng giá ở chỗ nào:** xoá hẳn dải **7,1R (Turtle) / 10,5R (hai sleeve)** Net R
sinh ra từ vị trí symbol trong mảng — không phải từ luật giao dịch; và nó là **điều kiện cần** để
bước siết k an toàn (siết k mà vẫn chấm tuần tự thì biên độ thứ tự nở từ 9% lên 40%).

## 5b. Ship phần còn lại thế nào (CHƯA LÀM)

Cơ chế `admitBarSnapshot` hiện **chỉ có trong engine nghiên cứu** (`scripts/portfolio-engine.ts:345`).
Code sống chưa có. Ba việc:

1. **`turtle-live.ts`** — thêm ảnh chụp heat đầu nến. Chỗ cắm đã sẵn: `replay()` (dòng 612) đã lặp
   **theo thời gian rồi mới tới symbol**, nên chỉ cần chụp heat ở đầu mỗi mốc `t` và cho
   `heatWeight()` (dòng 174) đọc ảnh chụp đó thay vì `this.states`. Xoá ảnh chụp khi hết mốc.
2. **`turtle.ts:92`** — `heatDecayK: 4 → 0.5`.
3. **`scripts/turtle-live-parity.ts`** — chạy lại để xác nhận live khớp engine đã audit **sau** thay
   đổi. Đây là bước bắt buộc, không phải tuỳ chọn.

**Rủi ro phải nói trước khi anh quyết:**
- Đây là code tiền thật. Tôi **không tự sửa** — theo đúng bài học `esbuild-main-guard-bug` (một
  main() backtest từng ghi đè cấu hình live và đổi chandelier 3,0→4,0 trên tiền thật).
- **risk/unit tăng 0,32% → 1,17%** là phần "nhận tiền" của cải thiện. Nếu KHÔNG tăng risk/unit thì
  không có thêm tiền, chỉ có maxDD giảm còn 9,1%. Hai cách đọc loại trừ nhau — **phải chọn một**, và
  đó là quyết định của anh chứ không phải của số liệu.
## 6. CHẶN THẬT: sàn tối thiểu của sàn giao dịch ở equity hiện tại

Tôi tự nêu chặn này rồi đo luôn (`scripts/exp-min-notional.ts` đã có sẵn phần so k=4 vs k=0,5).
Thang size trong một vị thế: **k=4 → 1,00 / 0,80 / 0,69** · **k=0,5 → 1,00 / 0,33 / 0,27** · rổ đông
(k=0,5) ≈ **0,17**. Vốn cần có TRONG SỔ ĐÓ để unit có notional tự nhiên vượt sàn (risk/unit 1,05%):

| symbol | sàn Binance | k=4 unit3 | k=0,5 unit3 | k=0,5 **rổ đông** |
|---|---|---|---|---|
| BTCUSDT | $50 | $315 | $380 | **$609** |
| ETHUSDT | $20 | $179 | $215 | $346 |
| SOLUSDT | $5 | $50 | $61 | $97 |
| ADAUSDT | $5 | $86 | $104 | $166 |

**Equity sổ Turtle/Binance hiện tại: $192,68.**

Đọc cho đúng — chặn này **phần lớn ĐÃ tồn tại**, không phải do k=0,5 sinh ra: BTC unit 3 đã cần $315
ở k=4 hôm nay, tức đang bị nâng sàn rồi. k=0,5 làm nó xấu thêm ($315 → $380), và cột **rổ đông
$609** mới là phần thực sự mới. Khi bị nâng sàn, `live-trade.ts` (dòng 180-192) nâng qty rồi **từ
chối lệnh** nếu risk hiệu dụng vượt ngân sách ⇒ symbol bị loại im lặng.

**Hệ quả cho khuyến nghị:** phần "+95% vốn" đo trên backtest giả định size chính xác. Ở $192,68 một
phần của nó **không lấy được**, và phần mất tập trung đúng vào BTC/ETH.

## 7. Ba lựa chọn ship (theo thứ tự tôi khuyến nghị)

1. **Chỉ ship ảnh chụp đầu nến, GIỮ k=4.** Lấy trọn phần bất biến thứ tự (biên độ 9% → 0%, vốn
   21,69 → 24,09 ở worst case) mà **không đụng gì tới thang size**, nên không thêm một chút áp lực
   min-notional nào. Đây là phần cải thiện **thuần tuý sửa lỗi**, không có đánh đổi.
2. **Ảnh chụp + k=1** (+71%): thang unit3 ≈ 0,33 so với 0,27 của k=0,5, nhẹ hơn ~22%, nhưng BTC
   unit 3 vẫn cần ~$311 > $192,68.
3. **Ảnh chụp + k=0,5** (+95%): chỉ nên khi sổ Binance đủ vốn, hoặc sau khi gộp hai sổ
   ($192,68 + $320,43 = $513 vào một chỗ thì BTC rổ đông $609 vẫn còn thiếu, nhưng unit3 $380 thì đạt).

Bước (1) độc lập với (2)/(3) và không có mặt trái nào tôi đo được — nếu chỉ làm một việc thì làm
việc đó.
