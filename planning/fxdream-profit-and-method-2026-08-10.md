# FX Dream — đo lợi nhuận thật + đúc kết phương pháp từ transcript gốc (2026-08-10)

> **TÀI LIỆU LỊCH SỬ — ĐÃ BỊ SUPERSEDE (2026-08-11).** Phần transcript vẫn hữu ích, nhưng mọi
> kết quả V0–V9, `+29R`, XRP/0,02%, limit 30%, target/cooldown và kết luận vận hành trong file này
> không còn mô tả engine hiện tại. Dùng
> [`fxdream-1y-measurement-2026-08-11.md`](./fxdream-1y-measurement-2026-08-11.md) và
> [`fxdream-profit-update-2026-08-11.md`](./fxdream-profit-update-2026-08-11.md) làm nguồn hiện hành.

## Nguồn lần này: đã bóc được transcript, nhưng phần cốt lõi vẫn bị chặn

Dùng `yt-dlp` (venv riêng trong scratchpad, `--extractor-args youtube:player_client=android` — client
mặc định bị YouTube chặn SABR). **Lấy được 17 transcript tiếng Việt.** Nhưng phải nói rõ:

| Nhóm | Video | Trạng thái |
|---|---|---|
| Lấy được | `#22` Hệ thống trade hoàn chỉnh · `#23` ENTRY-KEYVOL · `#26` Cách vào lệnh A-Z · `#31` Tư duy tìm stoploss · `#32` Stoploss-Quản trị vốn · `#43` Keyvolume×OB · `LiveTrade +50R` · `#10`, `#19`, `#20`, `#21`, `#18`, `#28`, Trade Management, Order Entry-Risk Mgmt… | ✅ 17 bản |
| **KHÔNG lấy được** | `#14` Cách xác định Key Volume · `#15` Mô hình win cao · `#26` Trading system SFP (bản khác) · `#29` SFP High Win Rate · `#30` Phân tích volume-xác nhận entry · `#33` Entering trades A-Z · `#32` Place orders · `#31` Live trade · `#11` Order Block · `#24` Xác định key follow trend · `#27`, `#34` | ❌ **members-only "KEYVOLUME PRO"** |

Đúng như `fxdream-keyvolume-method.md` §14 đã ghi: các video định nghĩa key và entry chính xác nhất đều
trả phí. Chúng xuất hiện trong danh sách kênh nhưng `yt-dlp` trả
*"available to this channel's members on level: KEYVOLUME PRO"*. **Phần đặc tả của chúng vẫn là lỗ hổng.**

## 1. Transcript xác nhận đặc tả cũ — và bổ sung ba điểm

`#31` (`DE5HuvHfMvk`) là bản phát biểu rõ nhất, khớp từng chữ với §14.2:

> *"các bạn hãy đặt ra cho mình ba câu hỏi: câu hỏi đầu tiên là cái chuỗi nến đó là chuỗi nến gì…
> câu hỏi thứ hai là cái **lâu của cái nến xanh cuối cùng có bị đóng qua chưa** — cái trường hợp này là
> **chưa** — câu hỏi thứ ba là cái lâu của cái nến xanh cuối cùng nó **có tráp chưa** — cái trường hợp
> này là **có rồi**, tại vì nó thọt cái râu xuống nó tráp rồi."*

Rồi xuống M15 với đúng một câu, và **stop trước entry sau**:

> *"bạn đã thấy được một cái stop l của mình khá là an toàn rồi… bây giờ chỉ là tìm entry thôi.
> **Entry của bạn ở đâu mình cũng không cần quan tâm.**"*

`#22` (`HjSCQkSSCPs`) xác nhận phần SL/TP và bổ sung:

> *"đặt stoploss dưới cái A Block luôn, **stoploss rất là ngắn luôn không thể nào mà ngắn hơn được**
> luôn á… **TP thì các bạn phải TP theo m15**."*

**Ba điểm BỔ SUNG mà đặc tả cũ chưa nêu đủ:**

1. **Kỳ vọng R thật của một kèo là ~2–3R, không phải 25R.** `#31`: *"một cái lệnh ở đây là **2.6 r**…
   nếu mà bạn cảm thấy 2R là đủ rồi thì bạn có thể chốt sớm hơn"*. `#22` nói mốc `26R` là mốc **hiếm**:
   *"mình nghĩ là **ít có bạn nào mà TP được tới đây á 26r lắm**, cho nên đa số là sẽ ở đây thôi"*.
   ⇒ Card Telegram đang in "Target 3 (TP Vô Cực Daily): +25.0R" như một mốc thường quy là **sai tinh thần nguồn**.
2. **Entry thật ở M5 là Volume Profile HVN/LVN**, và invalidation gắn với nó: `#22` — *"giá nó từ ở ngoài
   (LVN) nó đi vào… bạn canh mua ở cái cạnh"*, và *"nếu mà giá nó chui xuống lại… **thì bạn sẽ bỏ cái lệnh
   này luôn, không có tiếc gì**"*. Engine hiện KHÔNG có volume profile ⇒ thiếu đúng cơ chế entry.
3. **Tác giả cấm thêm gì vào hệ thống** — `#22`: *"mình đã khắc phục tất cả những cái nhược điểm hết rồi
   cho nên **bạn thêm bất kỳ cái gì vào cũng không được**… bạn thêm tầm bậy tầm bạ vào là chắc chắn là
   bạn tray không được"*. Sàn SL 0,8% ("NÂNG CẤP 1") chính là một thứ được thêm vào — và đo được nó là
   sai lệch **tai hại thứ hai** (mục 2).

## 2. ĐO LỢI NHUẬN — 365 ngày, BTC/SOL/XRP/DOGE, nến 5m futures

Công cụ: `fxdream-research/measure-live-path.ts`. Chạy đúng đường live (`trapGatePassed`, limit-at-OB,
expiry 12 nến, cooldown 6 nến), **không lookahead** (key chỉ dùng sau khi cửa sổ phản ứng 20 nến H1 đã
đóng), và **nến fill trùng SL xử theo hướng bất lợi**. `--self-check` chứng minh bản tái hiện tín hiệu
**trùng khớp 100%** `detectSFPSignalsV2` trên 9.369 nến M15 khi tắt hết cờ sửa lỗi.

`1R = |entry − SL|`; `costR = ma sát khứ hồi / stopPct`. Báo NET ở ba mức ma sát đã đăng ký ở §13.7.

| biến thể | lệnh | WR | GROSS | gr/lệnh | SL tv | maxDD | NET @0,140% | @0,090% | @0,020% | hoà phí |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **V0 live nguyên trạng** | 1.979 | 37% | **−78,7R** | −0,040 | 0,862% | 126 | **−344** | −250 | −117 | — |
| V1 +bỏ lookahead | 1.995 | 37% | −71,0 | −0,036 | 0,839% | 117 | −343 | −246 | −110 | — |
| V2 +key đúng giá | 2.060 | 36% | −92,7 | −0,045 | 0,842% | 141 | −372 | −272 | −133 | — |
| V3 +nhấn chìm đúng | 2.005 | 37% | −172,7 | −0,086 | 0,800% | 205 | −450 | −351 | −212 | — |
| V4 +sweep thật | 1.949 | 37% | −182,5 | −0,094 | 0,832% | 206 | −449 | −354 | −221 | — |
| V5 +gate #31 đúng | 236 | 30% | −10,7 | −0,045 | 0,829% | 42 | −44 | −32 | −15 | — |
| V6 +bắt buộc dư địa | 227 | 30% | −10,8 | −0,047 | 0,824% | 42 | −43 | −32 | −15 | — |
| V7 +bỏ sàn SL 0,8% | 247 | 32% | **+29,2** | +0,118 | 0,795% | 24 | −30 | −9 | **+21** | <0,094% |
| **V8 +trail H1** | 257 | 33% | **+28,4** | +0,110 | 0,794% | 22 | −33 | −11 | **+20** | <0,088% |

**Kết luận số 1: bản đang chạy live LỖ cả trước phí.** Gross −78,7R trên 1.979 lệnh. Không phải "đúng
luật nhưng sai sàn" như §14.6 kết luận cho `key-volume.ts` — bản engine-v2 này **âm cả gross**.

### Leave-one-out: cái gì thật sự tạo ra chênh lệch

Cộng dồn theo thứ tự dễ gây ngộ nhận (V3 làm xấu đi vì lúc đó chưa có gate Daily). Bảng dưới tắt **đúng
một** cờ khỏi V8:

| tắt cờ nào khỏi V8 | lệnh | GROSS | Δ so V8 | đọc |
|---|---:|---:|---:|---|
| `strictDailyGate` | 2.180 | −152,2 | **−180,6R** | **Gate #31 đúng là yếu tố áp đảo.** Cũng cắt 2.180→257 lệnh |
| `noStopFloor` (trả sàn 0,8% về) | 242 | −2,4 | **−30,8R** | **Sàn SL "NÂNG CẤP 1" chính là thứ giết edge** |
| `strictEngulf` | 277 | +15,9 | −12,5R | định nghĩa nhấn chìm đúng có giá trị thật |
| `requireHeadroom` | 269 | +23,9 | −4,5R | bắt buộc còn dư địa: dương nhẹ |
| `strictSweep` | 274 | +27,7 | −0,7R | không đáng kể |
| `keyAtClose` | 254 | +32,6 | **+4,2R** | sửa giá key **làm P&L xấu hơn** (vẫn là lỗi đúng-sai, không phải lỗi P&L) |
| `trailH1` | 247 | +29,2 | +0,8R | trail H1 hơi âm ⇒ **đừng thêm** |
| `noLookahead` | 269 | +30,1 | +1,7R | lookahead của study chỉ thổi phồng ~1,7R |
| `requireSecondTouch` | 257 | +28,4 | 0 | **vô hiệu** — xem ghi chú |

*Ghi chú `requireSecondTouch`:* proxy của tôi (đếm lượt chạm key trước nến hiện tại) **luôn được thoả**
vì bản thân cú sweep trong cửa sổ 20 nến đã là một lượt chạm. Nên đây là **thử nghiệm bất phân định**,
không phải "luật không hiệu quả". Muốn test đúng ý `#22` ("chờ hai đáy") phải đếm số lần **bị từ chối**
riêng biệt tại key, không phải số lần chạm.

### Ý nghĩa thống kê — chưa đủ

```
Bootstrap 5.000 lần trên 257 lệnh của V8:
  gr/lệnh CI90 [−0,060 ; +0,326]R   ·   P(gross > 0) = 83,3%
⇒ CI CÒN chứa 0 — chưa đủ bằng chứng để promote.
```

## 3. Đúc kết: phương pháp tốt nhất mà bằng chứng ủng hộ

Xếp theo giá trị đo được, không theo mức độ nổi bật trong video:

1. **Gate bối cảnh Daily `#31` — ba câu hỏi, đúng nguyên văn.** Chuỗi nến → low nến xanh cuối **chưa bị
   đóng qua** → low đó **đã bị thọt râu**. Giá trị đo được **+180R/365 ngày** và giảm tần suất 8,5×.
   Đây là thứ duy nhất trong cả hệ đủ mạnh để gọi là bộ lọc.
2. **SL ngắn nhất có thể, ngay ngoài cú trap/OB. TUYỆT ĐỐI không nới, không đặt sàn.** +30,8R. Trùng cả
   nguồn (`#22`, `#31`) lẫn số. Padding SL để "giảm phí/R" là tự phá cơ chế: R phình lên làm mục tiêu
   cấu trúc teo lại theo R, gate dư địa loại thêm lệnh, và phần đuôi lãi mất luôn.
3. **Stop trước, entry sau.** `#31` nói thẳng entry ở đâu không quan trọng. Phù hợp với việc `keyAtClose`
   và `strictSweep` gần như không ảnh hưởng P&L — **độ chính xác của SL quan trọng hơn độ chính xác của entry**.
4. **Mẫu nến đúng định nghĩa** (nhấn chìm phải là thân bao thân, nến trước ngược màu). +12,5R.
5. **Bắt buộc còn dư địa tới cấu trúc H4/Daily**, không fallback 15R khi không có gì phía trước. +4,5R.
6. **Kỳ vọng 2–3R/kèo, không phải 25R.** Sửa card Telegram.
7. **Không thêm gì nữa.** Trail H1 (−0,8R) và các gate chồng thêm đều không cải thiện — trùng với chính
   lời tác giả và với §14.3 ("chồng hết mọi luật vào nhau thì phá sản").
8. **Venue quyết định, không phải luật.** Chuỗi tín hiệu đã sửa cần ma sát khứ hồi **< 0,088%**:

| kịch bản | ma sát | NET 365 ngày |
|---|---:|---:|
| Binance perp taker 2 chiều | 0,140% | **−33R** |
| maker vào / taker ra | 0,090% | −11R |
| Vàng/Forex broker phổ thông | 0,020% | **+20R** |

Đây là lần tái lập **độc lập** của §13.7/§14.6 — engine khác, cửa sổ 365 ngày mới, và ra cùng kết luận:
phương pháp này có edge gộp mỏng, và Binance perp là venue bất lợi nhất cho nó.

## 4. Quyết định đề xuất

- **KHÔNG chạy live trên rổ crypto perp này.** Cả bản nguyên trạng (gross âm) lẫn bản đã sửa (CI chứa 0,
  NET âm ở phí Binance) đều không đạt.
- **Nếu vẫn giữ scanner làm công cụ cảnh báo cho đánh tay:** áp 5 sửa đổi (1)–(5) + (6) sửa card. Riêng
  gate `#31` đã đưa tần suất từ **~90 alert/ngày về ~0,7/ngày (257/năm)** — cùng cấp độ với ~60 kèo/năm
  của tác giả, tức lần đầu tiên nó dùng được như một cảnh báo thật.
- **Muốn nghiên cứu tiếp thì đổi venue**, không phải đổi luật: cùng chuỗi tín hiệu, ma sát 0,02% cho +20R.
- **Hai lỗ hổng đặc tả không đóng được bằng dữ liệu công khai:** định nghĩa key chính xác (`#14`, `#30`)
  và mô hình entry win cao (`#15`, `#29`, `#33`) đều members-only; và Volume Profile HVN/LVN trên M5 —
  cơ chế entry thật — chưa được số hoá.

## Tái lập

```bash
./node_modules/.bin/ts-node fxdream-research/measure-live-path.ts 365 --self-check
./node_modules/.bin/ts-node fxdream-research/audit-live-path.ts 30

# transcript (venv riêng, không cài vào hệ thống)
python3 -m venv ytenv && ./ytenv/bin/pip install yt-dlp
./ytenv/bin/yt-dlp --flat-playlist --print "%(id)s|%(title)s" \
  "https://www.youtube.com/@fxdreamtrading/videos"
./ytenv/bin/yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs "vi.*" \
  --convert-subs srt --extractor-args "youtube:player_client=android" "https://www.youtube.com/watch?v=DE5HuvHfMvk"
```
