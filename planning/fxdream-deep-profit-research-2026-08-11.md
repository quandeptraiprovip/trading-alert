# Nghiên cứu sâu FXDream và bản sửa theo mục tiêu lợi nhuận — 2026-08-11

## Kết luận vận hành

Phần định lượng được của FXDream **chưa tạo được lợi nhuận bền vững để tự động vào lệnh** trên dữ
liệu đang có. Bản sửa đúng quy tắc chọn Key của người dùng — một nến/vùng volume đột biến là đủ —
âm ở cả train và holdout. Vì vậy scanner phải tiếp tục fail-closed; không được đổi luật hoặc hạ phí
giả định chỉ để làm bảng kết quả dương.

Điều tích cực là nghiên cứu đã tìm đúng chỗ có khả năng giải thích vì sao đánh tay có lãi nhưng máy
không có lãi: người giao dịch không trade mọi Key volume. Edge còn nằm ở bước phân loại model,
location W1/D1/H4, actual OB/FTR và Volume Profile M5, macro/session, giá khớp limit thật, cách chọn
target và quyết định bỏ lệnh.

Kết luận này chỉ áp dụng cho proxy tự động trên Binance crypto, không phủ định kết quả giao dịch thủ
công của người dùng và không phải đánh giá toàn bộ framework FXDream.

## 1. Những cách FXDream thực sự dùng

Đối chiếu các video dài chính thức cho thấy không có một pipeline duy nhất để chồng mọi điều kiện:

1. **Follow-trend retest:** Daily tạo hướng; H1 có Key Volume; chờ giá retest, volume xuất hiện đúng
   vị trí, sweep/reclaim và trigger nến. Đây là model gần nhất với
   [LiveTrade +50R](https://www.youtube.com/watch?v=aPu9ojfAJY0),
   [#22 hệ thống hoàn chỉnh](https://www.youtube.com/watch?v=HjSCQkSSCPs) và
   [#23 Entry–Keyvol](https://www.youtube.com/watch?v=m8r6zunAN34).
2. **Follow-trend an toàn bằng BOS:** sau cú sweep cuối, chờ phá cấu trúc rồi vào ở nhịp sau. Đây là
   entry muộn hơn, không phải gate bắt buộc cho mọi SFP.
3. **SFP/Quasimodo:** tại đúng Key, chờ stop-hunt rồi vào theo một trong ba mẫu nến được kênh dùng:
   engulfing, inside-bar/in3 hoặc 3-bar reversal.
4. **Daily trap:** ba câu hỏi Daily trong video #31 tạo một luận điểm trap riêng. Nó không phải gate
   bắt buộc để gắn lên mọi setup thuận xu hướng.
5. **OB/FTR/HVN chủ động:** có thể limit tại actual OB hoặc cạnh vùng Volume Profile khi có căn cứ.
   Đây là model discretionary; không được gọi 30% thân nến là OB rồi giả định chắc chắn khớp.
6. **Breakout–retest:** kênh cũng có model breakout Key Volume rồi chờ retest, xác nhận framework có
   nhiều entry model. Xem
   [Breakout Keyvolume + Retest](https://www.youtube.com/watch?v=hDc66Ig0Tnk).

Website chính chủ cũng mô tả framework rộng hơn signal kỹ thuật, gồm macro, liquidity, Keyvolume
Zones, hành vi Market Maker, quản trị rủi ro và tâm lý. Do đó chỉ số hóa H1–M15 không thể được gọi là
toàn bộ phương pháp. Nguồn: [KeyVolume Group](https://keyvolume.com.vn/).

## 2. Quy tắc Key đã sửa đúng yêu cầu

### Quy tắc hiện tại

- Một nến H1 có volume đột biến hoặc một vùng volume đột biến là đủ để tạo **Key candidate**.
- Engine định lượng trường hợp một nến bằng `volume >= 2 × median 96 nến H1 trước`.
- Key xuất hiện ngay khi nến volume đóng; không chờ phản ứng giá tương lai.
- Key chỉ được tạo **một lần và trung tính**. Màu nến volume, displacement tương lai hoặc kết quả sau
  Key không được dùng để bí mật gán sẵn long/short.
- Point đại diện là close; zone của một nến là toàn bộ high–low.
- Daily bias và sweep/reclaim tại lần retest mới quyết định hướng giao dịch.
- Lịch sử phản ứng tại Key là context thủ công, không còn là gate sinh Key.

### Phần chưa tự động hóa

Vùng volume gồm nhiều nến vẫn chưa có quy tắc khách quan về điểm bắt đầu/kết thúc, HVN/LVN, gộp
spike hay cách chọn open/close. Scanner phải hiển thị candidate để trader chỉnh vùng trước lệnh;
không được âm thầm phát minh geometry mới.

## 3. Thiết kế phép đo

| Thuộc tính | Giá trị |
|---|---|
| Cửa sổ đánh giá | `2025-08-11 → 2026-08-11` |
| Warm-up | 120 ngày trước cửa sổ |
| Thị trường | BTCUSDT, SOLUSDT, XRPUSDT, DOGEUSDT |
| Dữ liệu | Binance USD-M OHLCV 5 phút, tổng hợp lên M15/H1/H4/D1/W1 |
| Train / holdout | 2/3 đầu thời gian / 1/3 cuối; split `2026-04-11` |
| Risk mô phỏng | 1%/lệnh, chặn notional ở 10x leverage |
| Ma sát khứ hồi | 0,02%, 0,10%, 0,14%; funding mô phỏng cộng riêng |
| Quy tắc intrabar | Nếu cùng nến chạm SL và TP thì ưu tiên SL |

Các model được ghi rõ trước khi chạy; không grid-search volume multiplier, session, symbol hoặc stop
để chọn kết quả đẹp. Ba mức ma sát chỉ là kịch bản nghiên cứu. Cần thay bằng phí, slippage và funding
thực đo từ tài khoản trước khi ra quyết định.

## 4. Kết quả cuối với Key spike-only

### 4.1 Kết quả chính

| Model | Lệnh | Gross | Net 0,02% | Net 0,10% | Net 0,14% | Holdout gross / net 0,02% |
|---|---:|---:|---:|---:|---:|---:|
| Follow-trend + SFP + target cấu trúc | 12 | −1,6R | −3,9R | −13,4R | −18,2R | −0,3R / −1,1R |
| Follow-trend + SFP + fallback 5R chẩn đoán | 13 | +3,4R | +1,0R | −8,5R | −13,3R | −0,3R / −1,1R |
| Follow-trend + BOS + target cấu trúc | 3 | −1,2R | −1,8R | −4,2R | −5,4R | 0 lệnh |
| Daily-trap + SFP + target cấu trúc | 0 | 0R | 0R | 0R | 0R | 0 lệnh |

Fallback 5R chỉ dương nhẹ trên toàn mẫu vì một lệnh train, còn holdout vẫn âm. Target 5R này không
có cấu trúc đối diện nên không được dùng làm mặc định hoặc bằng chứng lợi nhuận.

### 4.2 Vì sao số lệnh giảm mạnh

Model follow-trend ghi nhận:

```text
8.060 H1 Key → 58.136 touch → 20.328 touch có volume
→ 5.549 sweep → 5.159 pattern/plan → 25 entry toàn dữ liệu
→ 13 entry nằm trong cửa sổ đánh giá
```

`4.070` lần thử entry bị loại vì vùng đối diện gần hơn `3R`. Nhiều plan cùng thời điểm cũng hết hạn
ngay ở next-open trong khi engine chỉ giữ một vị thế/symbol. Kết quả cho thấy scanner phát hiện rất
nhiều hiện tượng kỹ thuật nhưng phần lớn không có dư địa hoặc execution hợp lệ.

Model Daily-trap có `8.060` Key, `1.882` touch-volume, `501` sweep và `471` pattern, nhưng gate Daily
loại `122.920` lần chạm; chỉ một entry xảy ra trong warm-up. Đây là dấu hiệu kiến trúc: Daily trap
cần detector theo **event Daily riêng**, không nên tái dùng loop retest thuận xu hướng rồi gắn thêm
một boolean gate.

### 4.3 Đối chứng displacement

Nếu đợi displacement/BOS tương lai để phân loại Key demand/supply, cùng quản lý source-neutral cho
`167` lệnh và `+45,1R gross`. Tuy nhiên holdout chỉ `+0,6R gross`, `−8,4R` ở ma sát 0,02%; tại 0,10%
là `−91,6R`. Quan trọng hơn, detector này **không còn tuân thủ** yêu cầu “volume spike là đủ”, nên chỉ
được giữ làm đối chứng. Nó không được dùng để quảng bá kết quả của bản spike-only.

## 5. Các điểm yếu tìm thấy và sửa đổi

| Điểm yếu | Sửa trong code | Trạng thái |
|---|---|---|
| Trộn follow-trend, Daily trap, BOS và SFP thành một setup | Tách variant/model ID; default là follow-trend SFP | Đã sửa |
| Key đợi phản ứng tương lai mới tồn tại | Thêm `spike-only`, Key trung tính tại close nến volume | Đã sửa + test |
| Đòi lịch sử phản ứng dù người dùng chỉ yêu cầu volume spike | `minKeyReactions = 0` | Đã sửa |
| Tự gán target 5R khi không thấy cấu trúc | `requireStructuralTarget = true` | Đã sửa |
| Chỉ dùng H1/H4 làm target dù video dùng M15 | Target source gồm M15/H1/H4 | Đã sửa |
| Partial 50% tại 2R và trail M5 bị hard-code | Default `partialFraction = 0`, `trailMode = none` | Đã sửa |
| Bỏ qua nến 5 phút đầu sau next-open entry | Reprocess chính nến entry qua quản lý vị thế | Đã sửa + test |
| Dùng ATR high/low của chính nến entry | Entry next-open chỉ dùng ATR nến đã đóng trước | Đã sửa + test |
| Dùng close-time để kiểm Key cho entry ở open | Kiểm activation tại đúng open-time | Đã sửa + test |
| Daily trap bị dùng như boolean gate trong loop khác | Đã tách config; detector event riêng chưa có | Còn thiếu; không live |
| Binance OHLCV không có volume-at-price M5 thật | Giữ proxy, bắt buộc xác nhận VP/OB thủ công | Không thể sửa bằng kline |

## 6. Bản phương pháp cập nhật để bảo toàn edge đánh tay

Đây là protocol **bán tự động**, không phải cam kết tạo lợi nhuận.

### Bước 1 — Ghi model trước khi nhìn entry

Chỉ chọn một trong các model: `FT-SFP`, `FT-BOS`, `DAILY-TRAP`, `OB-HVN` hoặc `BREAKOUT-RETEST`.
Không được đổi model sau khi lệnh thua để giải thích lại chart.

### Bước 2 — Key tối thiểu

Khoanh một nến/vùng volume đột biến. Ghi point và zone trước khi giá retest. Không bắt buộc Key đã có
ba phản ứng; lịch sử phản ứng chỉ là ghi chú context.

### Bước 3 — Context bắt buộc do người thực hiện

- W1/D1: hướng campaign, vị trí premium/discount và còn room không.
- H4: cấu trúc đang bảo vệ hướng nào; target/liquidity đối diện gần nhất.
- M15: cách giá tiếp cận Key mạnh hay yếu, sweep/reclaim thuộc model nào.
- M5: actual OB/FTR/Breaker và Volume Profile HVN/LVN; không dùng proxy thân nến.
- Macro/news/session/spread: ghi trước lệnh, đặc biệt với vàng/forex.

Nếu thiếu một mục, scanner chỉ lưu candidate, không biến thành lệnh.

### Bước 4 — Trigger và execution

- `FT-SFP`: retest Key + volume đúng vị trí + sweep/reclaim + một mẫu nến hợp lệ.
- `FT-BOS`: chỉ dùng khi chủ động chấp nhận entry muộn; backtest hiện không ủng hộ làm default.
- `DAILY-TRAP`: phải được arm từ event Daily riêng rồi mới tìm trigger LTF.
- Limit tại actual OB chỉ được ghi là fill khi thị trường thật sự khớp. Không giả định limit fill để
  làm đẹp R hoặc phí.
- Không đuổi giá nếu khoảng entry–invalidation đã làm mất room tối thiểu.

### Bước 5 — Stop, target và thoát sớm

- Stop ở điểm luận điểm sai: ngoài trap/actual OB/Key tùy model, không nới stop chỉ để giảm phí/R.
- TP1 là cấu trúc/volume M15 đối diện; runner chỉ giữ khi H4/Daily còn room.
- Nếu sau entry giá không follow-through như luận điểm, thoát/giảm vị thế theo kế hoạch đã ghi trước.
- Partial, BE, trail và re-entry phải được ghi thành rule của model; không quyết định lại theo kết quả.

### Bước 6 — Quản trị và chi phí

- Trong giai đoạn xác thực, dùng risk nhỏ hơn mức tối đa cá nhân; tổng risk của các coin tương quan
  phải được tính như một cụm, không phải bốn lệnh độc lập.
- Đo phí khớp thực tế từ ledger. Với stop rất ngắn, vài basis point có thể lớn hơn toàn expectancy.
- Không bật auto-entry chỉ vì gross dương; phải xét net, drawdown và leverage cap.

## 7. Điều kiện để thật sự gọi là có lợi nhuận

Một model chỉ được promote khi thỏa đồng thời:

1. Có tối thiểu 100 candidate liên tiếp được ghi trước kết quả, gồm cả candidate bị từ chối.
2. Model ID, Key zone, context, trigger, giá khớp, stop và target không đổi định nghĩa giữa mẫu.
3. Net expectancy dương ở train và unseen holdout bằng đúng phí/slippage thực tế.
4. Profit factor trên `1,15` ở cả hai phần và drawdown nằm dưới giới hạn đã định trước.
5. Kết quả không phụ thuộc một symbol, một tháng hoặc vài lệnh R cực lớn.
6. Paper/forward test tiếp theo không làm edge biến mất.

Chưa model tự động nào trong phép đo hiện tại đạt các điều kiện này. Vì thế thay đổi hợp lý nhất để
hướng tới lợi nhuận là **thu thập chính quyết định accept/reject của trader đang có lãi**, không tiếp
tục thêm indicator hoặc tối ưu threshold trên cùng một năm dữ liệu.

## 8. File và lệnh tái lập

- `key-volume.ts`: Key spike-only trung tính, model retest, target/SL/management.
- `test-key-volume.ts`: regression test Key tại close, no-lookahead và nến entry đầu tiên.
- `scripts/fxdream-source-model-research.ts`: ma trận model có train/holdout và ba mức ma sát.

```bash
npm run test:key-volume
npm run test:fxdream
npm run research:fxdream-source-models -- 365 btcusdt,solusdt,xrpusdt,dogeusdt 1
```

## 9. Forward journal đã triển khai

Để sửa trực tiếp ba điểm yếu lớn nhất — hindsight, trộn model và không biết vì sao trader thủ công
accept/reject — project có thêm một pipeline **chỉ chạy cục bộ**:

```text
candidate khách quan → ghi context trước kết quả → accept/reject/missed bất biến
→ ghi fill/phí/slippage thật → ghi outcome → so sánh accepted với rejected theo từng model
```

Pipeline này không gửi Telegram và không đặt lệnh. Đường alert cũ vẫn fail-closed cho đến khi một
model vượt đủ tiêu chí tại mục 7. Scanner journal hiện tái sử dụng bộ phát hiện V2 để thu thập ứng
viên; do detector Daily-event riêng chưa hoàn thành, nhãn gợi ý `DAILY_TRAP_SFP` **không phải** bằng
chứng candidate đã đạt toàn bộ model Daily-trap. Người review phải chọn model từ định nghĩa đã khóa.

### 9.1 Quy trình sử dụng

Quét và xem candidate đang chờ:

```bash
npm run journal:fxdream -- scan BTCUSDT,XRPUSDT
npm run journal:fxdream -- list pending
```

Ghi đủ sáu nhóm context trước khi accept:

```bash
npm run journal:fxdream -- context <candidate-id> \
  '{"w1d1":"...","h4":"...","m5":"...","macro":"...","session":"...","spread":"..."}'
```

Khóa quyết định và model trước khi biết kết quả:

```bash
npm run journal:fxdream -- review <candidate-id> accepted FT_SFP confirmation-market "lý do"
npm run journal:fxdream -- review <candidate-id> rejected FT_SFP "lý do"
npm run journal:fxdream -- review <candidate-id> missed FT_SFP "không kịp entry"
```

Với candidate accepted, ghi fill và chi phí thực; `feePct` và `slippagePct` là phần trăm, ví dụ
`0.05` nghĩa là `0,05%`:

```bash
npm run journal:fxdream -- execution <candidate-id> <fillPrice> 0.05 0.01
npm run journal:fxdream -- outcome <candidate-id> <exitPrice> <grossR> <netR> <mfeR> <maeR>
npm run journal:fxdream -- report
```

Rejected/missed cũng cần outcome giả định theo đúng plan đã chụp lúc phát hiện để đo chi phí cơ hội
và xem bộ lọc thủ công có thật sự tạo edge hay chỉ bỏ lỡ winner. Không được sửa context, quyết định,
execution hoặc outcome sau khi đã khóa; sửa dữ liệu nhập sai phải được ghi bằng một record hiệu chỉnh
riêng trong phiên bản journal sau, không overwrite lịch sử.

### 9.2 File triển khai

- `fxdream-journal.ts`: schema, ID ổn định, khóa quyết định và báo cáo accepted/rejected theo model.
- `scripts/fxdream-journal-cli.ts`: scan/list/context/review/execution/outcome/report cục bộ.
- `test-fxdream-journal.ts`: regression test dedupe, context bắt buộc, bất biến và báo cáo net-R.
- File dữ liệu mặc định `fxdream-candidate-journal.json` được ignore khỏi Git vì là nhật ký cá nhân.

Nội dung này phục vụ giáo dục và nghiên cứu, không phải tư vấn đầu tư hay bảo đảm lợi nhuận.
