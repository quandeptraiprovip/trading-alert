# Khai thác corpus YouTube Short của @fxdreamtrading (2026-08-12)

Các vòng trước chỉ bóc video DÀI (#10, #11, #22, #23, #28, #31, #50 — 17–19 transcript). Corpus
**Short** chưa từng được khai thác. Vòng này thử, và kết quả chủ yếu là **âm bản** — ghi lại để
không ai phải làm lại.

## 0. Thu được bao nhiêu: 9 / 399 — bị YouTube chặn

| bước | kết quả |
|---|---|
| liệt kê channel | **399 short** (`yt-dlp --flat-playlist`, `player_client=android`) |
| tải phụ đề | **9 clip** lấy được, rồi tường 429 |
| lỗi HTTP 429 | 18 lần trên 7 URL cuối; nghỉ 4 giây/request vẫn bị chặn |

Phụ đề là **bản dịch máy tự động từ tiếng Việt sang tiếng Anh**, thuật ngữ hỏng nặng
("volume tree" = cây volume, "Block order" = Order Block, "Maker" = cá mập). Đủ để nhận ý, không đủ
để trích dẫn chính xác.

Muốn lấy hết 399 clip thì phải: rải nhiều giờ với nhịp rất chậm, hoặc dùng cookies của phiên đăng
nhập, hoặc chia nhỏ qua nhiều phiên. Không phải việc chạy một lệnh là xong.

Công cụ để lần sau dùng lại: `scripts/fxdream-shorts-mine.ts` (VTT → văn bản sạch, khử caption lăn,
gom cụm từ khoá theo chủ đề: key / volume / entry / stop / target / timeframe / filter / liquidity).

## 1. Nội dung 9 clip: gần như TRÙNG với thứ repo đã đúc kết

| nội dung trong short | đã có trong `fxdream-keyvolume-method.md` chưa |
|---|---|
| Cây volume lớn = dấu chân cá mập rời vùng sau khi phá cấu trúc | ĐÃ CÓ (mục Order Block / FTR / Breaker) |
| Key volume làm ranh giới HƯỚNG: giữ trên key thì trend tiếp, xuyên qua thì cấu trúc đảo | ĐÃ CÓ (câu hỏi Daily: "giá nằm trên hay dưới key") |
| OB bị phá → thành **breaker**; hai đỉnh mà đỉnh sau quét stop; chờ retest sau xác nhận rồi vào | ĐÃ CÓ |
| Checklist đủ bộ: key volume + phá cấu trúc + OB xác nhận + OB thuận xu hướng | ĐÃ CÓ (checklist hợp lưu) |
| Không thích đặt limit sẵn trong OB; chờ cây nến xác nhận | ĐÃ CÓ (`confirmation-market` là mặc định) |
| Khung tư duy xác suất: không cầu đúng luôn, cầu lợi thế + thoát sớm khi sai | ĐÃ CÓ |
| Bối cảnh vĩ mô (thanh khoản Fed) trong một clip | ĐÃ ghi là mảnh còn thiếu, không cơ học hoá được |
| **Retest phải KÈM volume lớn mới tính xác nhận** | có model `volume-retest`, nhưng **tham số đang TẮT** ↓ |

Đọc theo cách khác: **volume phải xuất hiện HAI lần** — một lần tạo key (phá cấu trúc), một lần bảo
vệ key (retest). Trong 9 clip, ý "lần hai" được nhấn nhiều lần.

## 2. Chỗ duy nhất lệch giữa video và code

```
KEY_VOLUME_CONFIG.touchVolumeSpikeMult = 1     // ⇒ cú chạm chỉ cần volume ≥ 1× trung vị = KHÔNG yêu cầu gì
KEY_VOLUME_DOCUMENT_V1_CONFIG.touchVolumeSpikeMult = 2
```

Cấu hình mặc định **tắt hẳn điều kiện volume lần hai**. Đây là lệch thật giữa nguồn và code, và nó
đáng chú ý vì nối thẳng vào khoảng cách MẬT ĐỘ đã đo hôm nay
(`planning/fxdream-as-trend-input-2026-08-12.md` §K1: detector dày hơn thang người 20–30 lần).

## 3. Nhưng KHÔNG kiểm chứng được bằng engine hiện có — và đây là kết quả cần ghi

Quét `touchVolumeSpikeMult` = 1 → 4 trên `runKeyVolume` (4 coin, nến 5m, 1,05 năm):

| ngưỡng | setup | **lệnh** | lệnh/coin/năm | **stop trung bình** |
|---|---:|---:|---:|---:|
| 1,0× (mặc định) | 4.144 | **13** | 3,1 | **0,029%** |
| 2,0× | 2.334 | 8 | 1,9 | 0,037% |
| 3,0× | 1.392 | 4 | 1,0 | 0,035% |
| 4,0× | 863 | 1 | 0,2 | 0,059% |

**Số liệu này vô giá trị, và lý do quan trọng hơn bản thân số liệu:** stop trung bình 0,03% là
**nhánh stop suy biến** — đúng lỗi đã ghi trong `keyvolume-manual-vs-code` (`nearestOpposingTarget`
quét toàn bộ level M15 nên chỉ lệnh có stop suy biến mới lọt qua). Với 1–13 lệnh mỗi năm thì mọi cột
WR/gross/exp chỉ là nhiễu; đừng đọc chúng.

Điều này cũng tái xác nhận `fxdream-integration-audit`: `key-volume.ts` và các engine trong
`fxdream-research/` là **hai bộ luật khác nhau**, và con số 341 lệnh/năm của bản đo 1 năm đến từ
scanner source-aligned bên `fxdream-research/`, không phải từ `key-volume.ts`.

⇒ Muốn kiểm chứng điều kiện volume lần hai thì phải cắm nó vào **scanner source-aligned**, và phải
sửa nhánh stop suy biến trước. Đó là việc riêng, không làm ké được ở đây.

## 3b. VÒNG HAI — gỡ nút thắt và kiểm chứng được luật "volume hai lần"

Mục 3 dừng ở "không kiểm chứng được". Vòng này gỡ, và thu được hai phát hiện kỹ thuật độc lập với
kết quả P&L.

### Phát hiện 1 — sàn RR là bộ lọc CHỌN stop suy biến (cơ chế, đã đọc code xác nhận)

Phễu `runKeyVolume` trên cấu hình production (`scripts/exp-keyvol-funnel.ts`, 4 coin, 1 năm):

```
key H1 6.501 → chạm hợp lưu 47.118 → volume xác nhận 16.510 → sweep 4.436
             → mô hình nến 4.145 → PLAN 4.145 → ENTRY 13  (0,3%)
   bị loại:  dư địa 3.215  ·  risk/stop 444
```

Gate "dư địa" giết **3.215/4.145**. Cơ chế nằm ở `key-volume.ts`:

```ts
opposingR = |target − entry| / risk      // :1754   ← risk ở MẪU SỐ
if (opposingR < params.minRR) reject     // :1761   minRR = 3
```

Rổ level M15/H1/H4 rất dày nên target cấu trúc gần nhất luôn ở sát ⇒ muốn `opposingR ≥ 3` thì
**`risk` phải cực nhỏ**. Sàn RR ở đây không lọc chất lượng, nó **CHỌN stop suy biến**. Bằng chứng số:

| cấu hình | lệnh | stop trung vị |
|---|---:|---:|
| production | **13** | **0,017%** |
| bỏ sàn RR (`minRR = 0`) | **787** | **0,468%** |

Đây đúng họ lỗi đã ghi trong `keyvolume-manual-vs-code`, và nó **VẪN CÒN** trong cấu hình mặc định
của `key-volume.ts`. Nhưng bỏ sàn RR không thôi cũng sai: `resolveTargetR` trả
`min(finalTargetR, opposingR)` (`:1461`) nên lệnh có target cách 0,05R vẫn được nhận.

### Phát hiện 2 — model production KHÔNG có phần Volume Profile

`hvnEdge` và bộ đếm `profileAccepted` chỉ xuất hiện trong nhánh `model: "document-v1"`
(`key-volume.ts:1368–1394`). Production dùng `entryModel: "volume-retest"` ⇒ **phần Volume Profile
HVN/LVN không tham gia gì cả** (nên `profileAccepted = 0` ở mọi biến thể, đúng chứ không phải lỗi đếm).

Đây là một mảnh CỤ THỂ của khoảng cách người-máy: tác giả nói entry thật nằm ở M5 Volume Profile,
còn đường mặc định của code không có nó.

### Bàn thử sạch, và kết quả của luật "volume hai lần"

Bàn thử: stop = cực trị cửa sổ touch→sweep (đúng nguồn) · **target 5R cố định**
(`targetSourceTfs: []` ⇒ không tìm thấy level đối diện ⇒ `resolveTargetR` trả thẳng `finalTargetR`)
· không gate cấu trúc. Đây KHÔNG phải cấu hình đề nghị giao dịch — nó là môi trường để câu hỏi trả
lời được.

| touchVolumeSpikeMult | lệnh | lệnh/coin/năm | WR | gross R | exp/lệnh | **CI90 exp** | net @0,14% | net @0,02% |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| 1,0× (production) | 770 | 184 | 17,8% | +51,2 | +0,067 | [−0,027; 0,169] | −180 | +18 |
| 1,5× | 658 | 157 | 16,7% | +35,6 | +0,054 | [−0,048; 0,158] | −136 | +11 |
| 2,0× | 590 | 141 | 17,3% | +45,6 | +0,077 | [−0,028; 0,186] | −102 | +24 |
| **2,5×** | 497 | 119 | 18,7% | +69,4 | +0,140 | **[0,020; 0,263]** | −45 | +53 |
| 3,0× | 439 | 105 | 19,1% | +37,6 | +0,086 | [−0,032; 0,211] | −60 | +24 |
| 4,0× | 320 | 76 | 17,8% | −26,0 | −0,081 | [−0,195; 0,043] | −92 | −35 |
| 5,0× | 220 | 53 | 18,6% | −3,3 | −0,015 | [−0,155; 0,134] | −46 | −9 |

**Kết luận: KHÔNG có bằng chứng.** Bảy ngưỡng được thử, đúng **một** ô (2,5×) có CI90 không chứa 0 —
đúng bằng thứ kiểm định đa giả thuyết dự đoán ngẫu nhiên (0,10 × 7 ≈ 0,7 ô). Hai ô kề nó (2,0× và
3,0×) đều chứa 0 ⇒ **không có cao nguyên**. Luật "volume hai lần" không tự nó tạo edge đo được.

Hai điều phụ nhưng nhất quán với mọi vòng trước:
- **net @0,14% (Binance perp) ÂM ở MỌI ngưỡng.** Chỉ ở ma sát 0,02% (Vàng/Forex) mới dương — và ngay
  cả khi đó cũng không vượt ngưỡng ý nghĩa thống kê.
- **Mật độ vẫn sai bậc.** Ở ngưỡng 5,0× vẫn còn ~210 lệnh/năm trên 4 coin, so với ~60 kèo/năm trên
  TOÀN BỘ thị trường của tác giả. Điều kiện volume lần hai **không** giải thích được khoảng cách mật
  độ đã đo ở `fxdream-as-trend-input-2026-08-12.md` §K1.

## 4. Kết luận

- Corpus Short **không chứa mảnh còn thiếu**. Chín clip lấy được đều là diễn giải lại thứ các video
  dài đã nói và repo đã đúc kết. Điều này hợp lý: phần cốt lõi (#14 key, #15/#29/#33 entry, #30
  volume) nằm sau tường members-only KEYVOLUME PRO, và Short là nội dung quảng bá — nhiều clip kết
  thúc bằng lời mời mua khoá học.
- Luật "volume hai lần" rút từ short đã được **kiểm chứng và không có bằng chứng edge** (mục 3b):
  bảy ngưỡng, một ô đạt ý nghĩa — đúng mức nhiễu của kiểm định đa giả thuyết, không có cao nguyên.
- **Không có kết luận giao dịch nào thay đổi.** Ràng buộc của FX Dream vẫn là venue
  (cần ma sát <0,088%, Binance perp 0,140%), và hướng ghép nó vào Turtle/Fast vẫn đã đóng
  (`planning/fxdream-as-trend-input-2026-08-12.md`).

**Hai món nợ kỹ thuật cần ghi sổ** (chỉ động tới nếu có ngày quay lại nhánh FX Dream — hôm nay
KHÔNG sửa, vì sửa mà không có ai dùng thì chỉ thêm rủi ro):

1. `KEY_VOLUME_CONFIG` mặc định **chọn stop suy biến** qua sàn `minRR: 3` (mục 3b, phát hiện 1).
   Bất kỳ số liệu nào sinh từ cấu hình mặc định của `key-volume.ts` đều phải bị nghi ngờ trước.
2. Model production `volume-retest` **không có phần Volume Profile**; `hvnEdge`/`profileAccepted`
   chỉ sống trong nhánh `document-v1` (phát hiện 2). Đây là một mảnh cụ thể, định vị được bằng số
   dòng, của khoảng cách người-máy — khác với phần "chưa biết vì video members-only".

## Tái lập

```bash
# venv riêng vì hệ thống chỉ có Python 3.9 và pip chặn --user
python3 -m venv /tmp/ytenv && /tmp/ytenv/bin/pip install -U yt-dlp
/tmp/ytenv/bin/yt-dlp --flat-playlist --print "%(id)s" \
  --extractor-args "youtube:player_client=android" \
  "https://www.youtube.com/@fxdreamtrading/shorts" > shorts_ids.txt   # 399 id

# CHẬM, và vẫn sẽ dính 429 — chia nhỏ qua nhiều phiên
/tmp/ytenv/bin/yt-dlp --skip-download --write-auto-subs --sub-langs "vi,en" --sub-format vtt \
  --extractor-args "youtube:player_client=android" --sleep-requests 4 --ignore-errors \
  -o "subs/%(id)s.%(ext)s" --batch-file <(sed 's|^|https://www.youtube.com/watch?v=|' shorts_ids.txt)

./node_modules/.bin/ts-node scripts/fxdream-shorts-mine.ts subs stats
./node_modules/.bin/ts-node scripts/fxdream-shorts-mine.ts subs key

# vòng hai — chẩn đoán và kiểm chứng (mục 3b)
./node_modules/.bin/ts-node scripts/exp-keyvol-funnel.ts 365     # phễu: gate nào giết 99,7% setup
./node_modules/.bin/ts-node scripts/exp-retest-volume.ts 365     # luật "volume hai lần" trên bàn thử sạch
```
