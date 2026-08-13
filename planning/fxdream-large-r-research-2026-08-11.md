# FXDream — vì sao các lệnh đẹp có R rất lớn?

Ngày nghiên cứu: `2026-08-11`.

## 1. Kết luận ngắn

Các lệnh 20R–50R của FXDream **có cơ sở hình học**, nhưng là phần đuôi hiếm của phân phối, không phải kết quả bình thường của mọi setup.

Chúng xuất hiện khi đồng thời có:

1. quãng giá mục tiêu của khung W1/D1/H4 rất xa;
2. entry M5/M15 nằm cực sát điểm vô hiệu hóa;
3. stop đúng cấu trúc và rất nhỏ;
4. giá chạy gần như ngay sau entry;
5. trader đủ kiên nhẫn giữ một phần vị thế qua nhiều nhịp nhỏ;
6. đôi khi kết quả được tính theo cả chuỗi vào lại/nhồi lệnh, không chỉ một entry.

Công thức quyết định là:

```text
R = quãng giá thuận lợi / khoảng cách entry–stop
```

Vì vậy, R lớn thường đến từ **cả tử số lớn lẫn mẫu số nhỏ**. Chỉ bóp stop nhỏ mà không có bối cảnh và invalidation đúng sẽ làm tăng stop-out và chi phí tính theo R, không tự tạo edge.

## 2. Bằng chứng trực tiếp từ video

### 2.1. LiveTrade `+50R`

Nguồn: [Phân tích kèo LiveTrade +50R](https://www.youtube.com/watch?v=aPu9ojfAJY0).

Transcript cho biết:

- đây là “một lệnh trong rất nhiều lệnh” được chọn để review;
- tại thời điểm nói, lệnh đang khoảng `30R`;
- entry được chờ sau key, volume, cấu trúc và timing;
- nếu sau entry giá không chạy thì phải bỏ ngay;
- stop rất ngắn nhưng tác giả nhấn mạnh nó phải có căn cứ;
- cùng quãng giá đó, người đặt stop xa hơn chỉ được khoảng `10R–15R` thay vì `30R`.

Điểm quan trọng: tiêu đề nói `+50R`, còn phần thuyết minh tại thời điểm review nói khoảng `30R`. Điều này không phủ định lệnh có thể chạy tiếp sau đó, nhưng cho thấy không nên dùng tiêu đề làm con số khớp lệnh đã xác minh.

### 2.2. Hệ thống trade hoàn chỉnh #22

Nguồn: [#22 Hệ thống trade hoàn chỉnh](https://www.youtube.com/watch?v=HjSCQkSSCPs).

Video mô tả đúng cơ chế tạo R lớn:

- entry M5 tại cạnh vùng Volume Profile/Order Block;
- stop ngay ngoài Order Block, “không thể ngắn hơn” theo logic của setup;
- TP tại các vùng quan trọng trên M15;
- nếu giá chui ngược trở lại phía sai của vùng profile thì bỏ lệnh;
- mục tiêu xa có thể lên tới `26R`, nhưng tác giả nói rất ít người giữ được tới đó và đa số chốt ở các vùng gần hơn.

Do đó, `26R` là runner hiếm sau khi đã có nhiều lựa chọn TP gần, không phải target mặc định.

### 2.3. Tư duy tìm stoploss #31

Nguồn: [#31 Tư duy tìm stoploss](https://www.youtube.com/watch?v=DE5HuvHfMvk).

Case “căn bản, an toàn” trong video được tính khoảng `2,6R`; tác giả cũng nói nếu `2R` là đủ thì có thể chốt sớm khi thị trường bắt đầu có ý đảo chiều.

Điều này xác nhận hai tầng kết quả:

- `2R–3R`: kết quả cơ bản, thường dùng được;
- `10R–30R+`: phần runner khi bối cảnh lớn và hành vi sau entry cho phép.

### 2.4. Tư duy trade R:R lớn

Nguồn: [Tư duy để trade lệnh R:R lớn](https://www.youtube.com/watch?v=fIujEO1y8gA).

Video nêu case short BTC quanh `116.000`, stop khoảng `300` giá và mục tiêu lớn quanh `100.000`.

Nếu chỉ dùng các con số được nói trong video:

```text
stop = 300 / 116.000 = 0,259%
quãng tới 100.000 = 16.000
R lý thuyết = 16.000 / 300 = 53,3R
```

Đây là minh họa rõ nhất cho cơ chế: target khung lớn cách xa 13,8% nhưng stop chỉ khoảng 0,26%. Video cũng nhắc tới các lệnh nhồi sau entry, vì vậy “R của cả campaign” cần tách khỏi “R của entry đầu tiên”.

### 2.5. Quản lý một chuỗi lệnh

Nguồn: [Phương pháp winrate 80% – RR 1:5](https://www.youtube.com/watch?v=Hip4HA22xdQ).

Trong một case, tác giả chốt một nửa khi giá tới vùng dưới và có dấu hiệu muốn đảo, rồi để phần còn lại chạy theo chuỗi nến. Sau đó giá đi tiếp nhưng tác giả thừa nhận chỉ biết điều đó sau khi sự việc xảy ra.

Điểm này ủng hộ cách quản trị partial + runner, đồng thời cho thấy giữ trọn vị thế tới cực xa là quyết định khó và chịu hindsight.

## 3. Kết quả đo phần đuôi R trong project

Công cụ: `fxdream-research/analyze-r-tail.ts` trên đường scanner source-aligned, không lookahead.

Hai khái niệm phải tách riêng:

- **MFE:** quãng thuận lợi tối đa đã xuất hiện trước khi V7 thoát; không chắc trader khớp được ở đó.
- **R thực thu:** R theo entry xác nhận, target H4 gần nhất, stop/BE của backtest.

### 3.1. Rổ BTC/SOL/XRP/DOGE — 365 ngày

Tổng cộng 341 lệnh, gross `−25,5R`.

| Ngưỡng | Lệnh có MFE đạt ngưỡng | Tỷ lệ | Lệnh thực thu đạt ngưỡng | Tỷ lệ |
|---|---:|---:|---:|---:|
| 2R | 45 | 13,2% | 23 | 6,8% |
| 3R | 21 | 6,2% | 12 | 3,5% |
| 5R | 10 | 2,9% | 6 | 1,8% |
| 10R | 2 | 0,6% | 2 | 0,6% |
| 15R | 1 | 0,3% | 0 | 0,0% |
| 20R | 0 | 0% | 0 | 0% |

Phân vị MFE:

```text
p50 0,51R · p75 1,25R · p90 2,17R · p95 3,53R · p99 6,95R · max 15,62R
```

Mức tập trung lợi nhuận:

- top 3 lệnh tạo `+33,6R`; bỏ chúng đi, gross còn `−59,2R`;
- top 10 lệnh tạo `+68,6R`, tương đương 55,0% tổng gross thắng; bỏ chúng đi, gross còn `−94,1R`;
- ngay cả khi giữ được các runner lớn nhất, proxy vẫn âm tổng.

### 3.2. Vì sao 10R+ vẫn rất hiếm trong proxy

Bản mới đã bỏ limit 30% giả OB và vào tại giá đóng M15; đồng thời target là swing H4 đối diện gần
nhất thay vì swing xa nhất. Hai thay đổi này làm mẫu số risk lớn hơn và tử số target ngắn hơn — đúng
với cách mô phỏng trung thực hơn, nhưng không tái hiện độ chính xác M5/actual OB của trader.

Sau khi Key chỉ cần volume spike, proxy xuất hiện một lệnh thực thu `14,85R` trên 341 lệnh. Một
ngoại lệ `0,3%` không đủ biến gross tổng `−25,5R` thành edge.

Kết quả XRP 1.095 ngày `+23,5R`/MFE `33,8R` của V7 cũ vì vậy đã bị **supersede** và không được
dùng làm bằng chứng. Muốn kiểm tra 20R–30R đúng phương pháp phải đo entry M5 actual OB, runner,
re-entry và campaign trên các lệnh được trader chấp nhận trước khi biết kết quả.

## 4. Stop càng ngắn không đồng nghĩa càng tốt

Kết quả 365 ngày của proxy source-aligned theo độ rộng stop:

| Stop | Lệnh | Tỷ lệ MFE ≥5R | Tỷ lệ MFE ≥10R | Gross |
|---|---:|---:|---:|---:|
| `<0,25%` | 18 | 5,6% | 5,6% | `−0,7R` |
| `0,25–0,50%` | 154 | 3,2% | 0,6% | `−9,0R` |
| `0,50–1,00%` | 134 | 3,0% | 0% | `−14,5R` |
| `≥1,00%` | 35 | 0% | 0% | `−1,4R` |

Không được biến bảng này thành luật “stop phải 0,25–0,50%”: các bucket được xem sau dữ liệu và có thể overfit. Điều có thể kết luận an toàn hơn là:

> Stop phải ở điểm cấu trúc sai. Độ ngắn là hệ quả của entry chính xác, không phải mục tiêu độc lập.

## 5. Vì sao các lệnh trên video trông đặc biệt đẹp?

### 5.1. Positive skew thật

Phương pháp có dạng nhiều lệnh nhỏ/BE và một số ít lệnh thắng rất lớn. Đây là đặc tính hợp lý của entry sát invalidation kết hợp target khung cao.

### 5.2. Selection bias cũng thật

Video `+50R` tự nói đây là một lệnh được chọn trong rất nhiều lệnh. Nguồn công khai không có ledger đầy đủ để biết:

- bao nhiêu setup tương tự đã stop;
- bao nhiêu limit không khớp;
- bao nhiêu lần thoát sớm rồi giá mới chạy;
- spread/slippage thực tế;
- kết quả lệnh vào lại và lệnh nhồi được cộng như thế nào.

Do đó, ta có thể học cơ chế tạo R từ video nhưng không thể suy ra expectancy của toàn phương pháp chỉ từ các case đẹp.

### 5.3. R campaign có thể lớn hơn R của một entry

Khi thêm vị thế sau khi lệnh đầu đã dương, người trình bày có thể cộng R của nhiều entry. Nếu mỗi entry có stop riêng, con số tổng campaign không tương đương với một lệnh duy nhất risk 1R từ đầu.

Cần ghi bốn số riêng:

1. `initial-entry R`;
2. `add-on R` của từng lần nhồi;
3. `campaign R` sau khi cộng tất cả vị thế;
4. phần trăm tài khoản thực tăng/giảm.

## 6. Audit báo cáo “Infinite R” cũ trong project

`fxdream-research/RESULTS.md` và `run-infinite-r-study.ts` không nên được dùng làm bằng chứng rằng mỗi lệnh thắng đạt 20R–50R.

Các vấn đề chính:

- bảng 80 lệnh và `+205R` trong báo cáo là ví dụ số học giả định, không phải ledger backtest;
- key được tìm trên toàn bộ chuỗi bằng phản ứng tương lai rồi cho phép dùng từ `originTime`: lookahead;
- thiếu cấu trúc đối diện vẫn tự tạo target `50R`;
- Daily gate, sweep và engulfing dùng định nghĩa lỏng đã bị audit bác bỏ;
- nến fill đồng thời chạm stop không bị xử theo hướng bất lợi;
- trong cùng nến 5 phút, code có thể thấy high đạt BE/TP trước rồi mới xét low chạm stop;
- slippage cấu hình nhưng không được cộng đầy đủ vào `costR`;
- mô hình giữ 100% tới 50R không khớp video #22 về TP theo M15 và mốc 26R hiếm.

Kết quả top `26,1R` của study cũ vì vậy không phải bằng chứng độc lập hợp lệ.

## 7. Cách khai thác phần đuôi R mà không biến nó thành ảo tưởng

### Luật vận hành nên giữ

1. Xác định stop/invalidation trước khi tối ưu entry.
2. Chỉ entry tại vùng đã có context W1/D1/H4 và còn khoảng trống tới cấu trúc đối diện.
3. Không chạy như luận điểm thì giảm/bỏ vị thế theo invalidation hành vi đã định trước; nguồn không
   cho một deadline số nến cố định.
4. TP cơ sở theo M15/H1; không in sẵn 25R/50R.
5. Có thể giữ một runner nhỏ khi chuỗi nến và cấu trúc tiếp tục đồng thuận.
6. Mọi add-on phải có risk budget riêng; tổng campaign risk không được tăng âm thầm.
7. Đo R sau phí, spread và slippage.

### Giả thuyết nên forward-test, chưa được bật live

- chốt 30%–50% tại TP cơ sở 2R–3R;
- giữ 10%–30% làm runner nếu giá có follow-through và chưa gặp cản khung cao;
- trail runner theo invalidation cấu trúc đã đóng nến, không theo một khoảng R tùy ý;
- so sánh ba policy cố định: thoát toàn bộ tại cấu trúc, partial + runner, và giữ 100%;
- không thay policy giữa lệnh dựa trên việc đã nhìn thấy giá tương lai.

Không nên chuyển engine sang “giữ 100% tới 50R”. Proxy hiện âm gross, chỉ 2/341 lệnh thực thu đạt
10R và không có lệnh 20R; chưa có bằng chứng rằng đổi exit policy sẽ tạo edge thay cho các lớp chọn
setup đang thiếu.

## 8. Nhật ký cần bổ sung cho giao dịch tay

Vì người dùng đang đánh tay có lãi, dữ liệu cá nhân có giá trị hơn việc tiếp tục tối ưu trên Binance:

- ảnh chart trước entry, ghi rõ key và model ID;
- entry, structural stop, stop %;
- R tới TP M15, H1, H4/D1 trước khi vào;
- MFE, MAE và R thực chốt;
- thời gian đạt 0,5R, 1R, 2R;
- có/không follow-through;
- phần trăm chốt ở từng mốc;
- từng lệnh nhồi và tổng campaign risk;
- phí/spread/slippage;
- lý do thoát đã viết trước hay quyết định sau khi thấy giá.

Sau tối thiểu 100 lệnh, có thể trả lời bằng dữ liệu cá nhân:

- tỷ lệ MFE ≥5R/10R/20R;
- tỷ lệ capture `R thực thu / MFE`;
- lợi nhuận còn dương không nếu bỏ ba lệnh lớn nhất;
- policy partial nào giữ được expectancy tốt nhất;
- stop cực ngắn đang tạo edge hay chỉ làm tăng stop-out.

## 9. Tái lập phép đo

```bash
rtk ./node_modules/.bin/ts-node fxdream-research/analyze-r-tail.ts 365
```

Kết luận cuối cùng:

> Cơ chế tạo R lớn của FXDream có cơ sở hình học, nhưng proxy tự động hiện tại chưa tái hiện được nó
> và đang âm gross. Muốn xác minh edge 20R–50R phải đo entry M5/actual OB, accept/reject thủ công,
> runner, re-entry và campaign bằng dữ liệu trước lệnh; video case đẹp không đủ để suy ra expectancy.
