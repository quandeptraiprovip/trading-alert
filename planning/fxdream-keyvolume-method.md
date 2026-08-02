# Phương pháp "Key Volume" — FX Dream Trading

> Đúc kết từ kênh YouTube [@fxdreamtrading](https://www.youtube.com/@fxdreamtrading)
> (kênh hiển thị 795 video tại lần audit 2026-07-30) và website chính chủ
> [keyvolume.com.vn](https://keyvolume.com.vn/).
> Nguồn dữ liệu: transcript tiếng Việt của hơn 15 video cốt lõi, gồm các video entry, quản lý lệnh
> và live-trade được audit chéo
> (xem [Nguồn](#nguồn) cuối file).
> Ngày đúc kết: 2026-07-30.

Áp dụng cho: Forex, **Vàng**, **Crypto**, Chứng khoán (kênh khẳng định cùng một bộ logic).

---

## Mục lục

1. [Triết lý gốc](#1-triết-lý-gốc)
2. [Key Volume — hạt nhân hệ thống](#2-key-volume--hạt-nhân-hệ-thống)
3. [Từ vựng phải nắm](#3-từ-vựng-phải-nắm)
4. [Quy trình 4 bước top-down](#4-quy-trình-4-bước-top-down)
5. [Checklist vào lệnh](#5-checklist-vào-lệnh)
6. [Ba dạng setup](#6-ba-dạng-setup)
7. [Entry / SL / TP / quản lý lệnh](#7-entry--sl--tp--quản-lý-lệnh)
8. [Quản trị vốn](#8-quản-trị-vốn)
9. [Lớp vĩ mô — chi phí vốn](#9-lớp-vĩ-mô--chi-phí-vốn)
10. [Lộ trình học](#10-lộ-trình-học)
11. [Đánh giá thẳng thắn](#11-đánh-giá-thẳng-thắn)
12. [Ghi chú số hoá / code hoá](#12-ghi-chú-số-hoá--code-hoá)
13. [Audit lại từ transcript gốc — 2026-08-01](#13-audit-lại-từ-transcript-gốc--2026-08-01)
14. [Audit toàn bộ + cài đặt phần còn thiếu — vòng 2](#14-audit-toàn-bộ--cài-đặt-phần-còn-thiếu--2026-08-01-vòng-2)
15. [Nguồn](#nguồn)

---

## 1. Triết lý gốc

Ba câu chi phối toàn bộ hệ thống:

- **"Giá không đi ngẫu nhiên. Giá luôn đi tìm thanh khoản."**
  Mọi cú chạy đều là hành trình đi lấy lệnh chưa khớp (stoploss của phe kia).
- **"Đừng sợ mất cơ hội, hãy sợ mất tiền."**
- **"Không bao giờ vào lệnh khi chưa hiểu bối cảnh."**
  Vào lệnh mà không biết mình đang đứng ở đâu trong bức tranh lớn = thua vì mù, không phải vì xui.

Trường phái: **Price Action + Liquidity + hành vi Market Maker** ("nhà cái", "cá mập", "bigboy"),
cộng thêm một **lớp vĩ mô** đè lên trên — điểm khác biệt so với đa số kênh SMC/ICT thuần kỹ thuật.

---

## 2. Key Volume — hạt nhân hệ thống

> "Key là một **điểm**, không phải một vùng."

**Key Volume** = mức giá hội tụ **đồng thời hai điều kiện**:

1. Từng có **một cây volume rất lớn** (dấu chân dòng tiền lớn — gom hàng hoặc xả hàng), và
2. **Giá đã phản ứng thật** tại đó (bật, đỡ, hoặc đảo vai trò hỗ trợ ↔ kháng cự).

### Cách xác định trong thực tế

- Tìm **"điểm xuất phát lực"** — nơi *bắt đầu* một cú Break of Structure, không phải nơi giá đã chạy xa.
- Vùng từng là hỗ trợ mà bị một cây volume lớn xả thủng → đánh dấu; nó **đổi vai** thành kháng cự.
  *"Những nơi có câu chuyện của nó thì tôi đánh dấu lại và theo dõi."*
- Lấy giá đóng cửa, mở cửa hay râu nến **đều được** — không quan trọng bằng việc **có phản ứng hay không**.
  Khung càng nhỏ / size càng nhỏ thì lấy cả vùng cũng ổn.

### Bộ lọc phủ định (quan trọng)

Một mức hỗ trợ/kháng cự **không liên quan tới volume** thì **bỏ qua**, kể cả nó đẹp về cấu trúc.
Trong video `#26` họ loại một mức vì *"không có phản ứng, và không có gì liên quan tới vol hết"*.

---

## 3. Từ vựng phải nắm

| Khái niệm | Nghĩa trong hệ thống này |
|---|---|
| **Mod 3 / Mother bar** | Cây nến mẹ bao trùm; high/low của nó là key mạnh trên khung tuần/ngày |
| **In 3 / Inside bar** | Nến nằm trong nến mẹ. Nếu khoảng cách high Mod3 ↔ high Inside bar quá xa → lấy high Inside bar làm key, **nhưng bắt buộc phải có hợp lưu thêm** (breaker / OB) |
| **Điểm xuất phát lực** | Gốc của cú phá cấu trúc — nơi đặt key, không phải đỉnh/đáy của cú chạy |
| **Order Block / FTR / Breaker** | Vùng tích luỹ cuối trước khi giá quay xe; nơi đặt entry và SL |
| **Quasimodo / SFP** | Mẫu hình quét thanh khoản rồi đảo — kênh gọi là "tỷ lệ win cao nhất" |
| **Trap (bull/bear trap)** | Cú dụ vào lệnh trước khi đảo. Là **điều kiện vào lệnh**, không phải rủi ro |
| **HVN / LVN (Volume Profile)** | Đo profile trọn con sóng trên M5. Giá **từ ngoài LVN đi vào cạnh HVN** = điểm mua/bán |
| **Chuỗi nến** | Chuỗi nến xanh/đỏ liên tiếp trên Daily = trend. Bộ lọc trend chính — **không dùng MA** |
| **Dư địa** | Khoảng còn liquidity chưa bị lấy ở phía trước. Hết dư địa → không vào |
| **Chặn tàu** | Vào lệnh ngược nhịp hiện tại tại key, biết rõ mình đang chặn (chỉ dành cho người có kinh nghiệm) |

---

## 4. Quy trình 4 bước top-down

**Khung tuần → Khung ngày → M15 → M5.** Không được đảo thứ tự.

> "Khung lớn cho mình câu chuyện, khung nhỏ chỉ là công cụ để vào lệnh cho đẹp hơn."

### Bước 1 — Tuần: xác định bias

- Đọc **chuỗi nến**. Chưa có cây nến ngược đủ mạnh phủ định xu hướng → xu hướng chính vẫn giữ.
- Xác định **Mod 3** đang chi phối.
- Bắt đáy/bắt đỉnh trong bối cảnh này = *"bơi ngược dòng, sớm muộn cũng sặc nước."*

### Bước 2 — Ngày: xác nhận cấu trúc + tìm key

- Cấu trúc tăng đã gãy chưa? Giá nằm trên hay dưới key / kháng cự cứng?
- Điều kiện phát biểu dạng if/else rất rõ:
  *"Nếu nó giữ được trên cây nến xanh này thì tôi long. Nó nằm dưới high của nến xanh → plan vẫn là short."*

### Bước 3 — M15: xác nhận + chờ trap

- Phải thấy **phá cấu trúc 2 lần** (2 lower low / 2 higher high) mới tin là phá thật.
  *"Phá lần một rất dễ ăn trap."*
- Chờ **cú quét thanh khoản**: giá rướn lên đá hết stoploss rồi mới sập.
- **Chỉ vào sau khi đã quét.**

### Bước 4 — M5: tìm entry

- Kéo **Volume Profile trọn con sóng** (từ đầu sóng đến cuối sóng).
- Tìm **cạnh HVN** nơi giá đi từ ngoài (LVN) vào.
- Vào ở cạnh **OB / FTR** trùng với key volume. SL cực ngắn ngay sau mẫu hình.

---

## 5. Checklist vào lệnh

Nguyên tắc: **thiếu một yếu tố là không vào.**

> "Các bạn nhìn mỗi cái nhỏ xíu này không á, cắm đầu tray là toang."

- [ ] Bias khung tuần/ngày rõ ràng, lệnh **thuận** bias
- [ ] Có **key volume** (cây vol lớn + phản ứng giá) tại vùng dự định vào
- [ ] **Hợp lưu ≥ 2–3 khung thời gian** trên cùng một mức giá
- [ ] Đã có **cú quét thanh khoản / trap** ở phía ngược lại
- [ ] Có **cấu trúc M15 xác nhận** (BOS 2 lần)
- [ ] Có **OB / FTR / breaker** để entry sát và SL ngắn
- [ ] **Dư địa** phía trước còn nhiều (còn liquidity gap chưa lấy)
- [ ] Bối cảnh **vĩ mô** không chống lại lệnh

---

## 6. Ba dạng setup

### A. Follow trend — khuyến nghị cho người mới, an toàn nhất

Đi theo chuỗi nến ngày. Chờ hồi về key, vào tại OB, SL sau key.

### B. Trap / đảo chiều — nâng cao

Quasimodo, SFP, bull/bear trap tại key volume khung lớn.
Yêu cầu bắt buộc: cú quét phải xảy ra **rồi mới** vào, và **giá phải chạy ngay lập tức**.

### C. Sideway

Trade cạnh biên vùng tích luỹ, hoặc — mặc định — **đứng ngoài**.

> "Tôi tuyệt đối không trade trong sideway khi chưa đủ tín hiệu rõ ràng."

---

## 7. Entry / SL / TP / quản lý lệnh

### Stop loss

> **"Stoploss là điểm sai của bạn, không phải mức lỗ bạn chịu được."**

- Đặt sau OB / FTR / key. **Ngắn nhất có thể.**
- **Luôn luôn phải có**, vì đòn bẩy cao — giá nhích một tí là cháy tài khoản.

### Take profit

- Đặt tại **key / OB quan trọng của khung M15**.
- **Chốt 1/2 tại TP1**, phần còn lại gồng.
- Nếu giá xả rất mạnh → **gỡ TP2 ra, thả trôi**, chỉ chốt khi thấy dấu hiệu quay xe.
  *"Muốn TP vô cực thì phải thả TP ra."*

### Điều kiện bỏ lệnh sớm (không đợi SL)

Phần giá trị nhất của hệ thống, và ít kênh nào dạy:

| Tình huống vào lệnh | Tín hiệu thoát ngay |
|---|---|
| Vào theo kỳ vọng "lên nhanh thì phải xuống nhanh" | **Không sập liền → thoát liền** |
| Vào theo HVN từ ngoài vào | Giá **chui ngược ra ngoài** → bỏ lệnh, không tiếc |
| Đang short | Giá liên tục **tạo đáy cao hơn, dồn giá lên** → chạy ngay |
| Bất kỳ | Nến **đóng ngược qua key** → bỏ, không cần nhìn nữa |

*"Không chạy thì ăn stoploss dương thôi."*

Chấp nhận **stoploss dương** (dời SL sớm bị quét) như chi phí bình thường,
và **vào lại** khi có entry đẹp hơn sau cú quét sâu hơn.

---

## 8. Quản trị vốn

> "Thiếu macro không sao. Thiếu phân tích kỹ thuật không sao.
> **Thiếu quản trị vốn là coi như công cốc.**"

| Tham số | Giá trị |
|---|---|
| Risk / lệnh | **2–5% tài khoản** |
| Risk / lệnh (chưa chắc tay) | **1–2% tài khoản** |
| Tư duy R | Thua 1, thắng 5 / 10 / 20 |
| Kỳ vọng lợi nhuận | **10–20% / năm**, tính theo **năm** chứ không theo ngày/tháng |

Lý do: đây là game xác suất — *"ăn 99 kèo thua 1 kèo cũng thua tất cả."*

Ghi chú quan trọng: hai setup **giống hệt nhau như hai giọt nước**, một cái chạy một cái không.
Đó là bản chất thị trường, và đó chính là lý do phải quản vốn.

---

## 9. Lớp vĩ mô — chi phí vốn

> "Học macro để làm gì? Để hiểu **chi phí vốn**. Hết. Không còn gì cả."

- Long AUDUSD = đang **vay USD** để mua AUD → chi phí vay bao nhiêu, lợi suất AUD bao nhiêu.
- Mua vàng → chi phí vốn là gì, lợi nhuận đến từ đâu.

### Bộ công cụ

Lạm phát · lãi suất · tỷ giá · công cụ chính sách tiền tệ · cung tiền · lợi suất trái phiếu · cơ chế truyền dẫn.

### Ví dụ thực tế kênh dùng

- ECB hút 40 tỷ EUR/tháng vs Fed chỉ 5 tỷ USD → cung USD nhiều hơn → EUR/USD nghiêng tăng.
- Fed nới SLR → USD quay vòng nhiều hơn → USD yếu.
- Chiến tranh Mỹ–Iran → dòng tiền cắt về USD tiền mặt → **mọi tài sản đều giảm**, kể cả vàng đang uptrend mạnh.
  Đây là lý do họ tự tin short vàng ngược trend ngắn hạn.
- Cấu phần DXY: **EUR 57%, JPY 13%, GBP 11%** → "USD tăng" thực chất là mấy đồng kia giảm.

### Về tin tức

**Không trade tin.** Tin chỉ là cái cò kích hoạt cú quét thanh khoản;
sau khi quét xong giá chạy theo hướng vĩ mô đúng của nó.
Vai trò của tin là **xác nhận hợp lưu**, không phải tín hiệu vào lệnh.

---

## 10. Lộ trình học

```
Mẫu giáo   → Khái niệm cơ bản (lot, margin, SL/TP, chọn sàn) + nhận diện chiêu lừa
Cấp 1      → Đọc nến → Mô hình giá + 3 mô hình nến
Cấp 2      → Market Structure + Liquidity  ← chỗ giải thích TẠI SAO mọi mô hình hoạt động
           → Setup + tư duy đa khung
           → QUẢN TRỊ VỐN  (bắt buộc, không bỏ qua)
Cấp 3      → Macro / vĩ mô → chi phí vốn
Đại học    → Năng lực tự học
```

Họ nhấn: học mô hình trước vì **nó dễ và tạo hứng thú**, nhưng **hiểu liquidity mới là thứ
giải thích được tại sao mọi mô hình kia hoạt động**.

> "Mô hình nào cũng chuẩn. Nó sai khi bạn máy móc."

---

## 11. Đánh giá thẳng thắn

### Điểm mạnh thật sự

- Quy trình top-down bắt buộc + checklist "thiếu một yếu tố là không vào" — kỷ luật này tự nó
  đã lọc bỏ phần lớn lệnh xấu.
- Định nghĩa **SL = điểm sai, không phải mức lỗ**. Chuẩn.
- Bộ điều kiện **bỏ lệnh sớm dựa trên hành vi giá** thay vì ngồi đợi SL — hiếm kênh Việt nào
  dạy phần này rõ như vậy.
- Trung thực về xác suất: review cả lệnh thua, nói rõ hai setup y hệt mà một cái không chạy,
  đặt kỳ vọng 10–20%/năm chứ không bán giấc mơ.
- Lớp vĩ mô quy về "chi phí vốn" là góc nhìn gọn và đúng.

### Cần thận trọng

- Con số **winrate 80–90%** và các kèo **23R, 50R, 160R** đều là **tự báo cáo** qua review chart
  sau khi xong (họ có nói đã post trước trong group, nhưng **không có track record được kiểm chứng độc lập**).
- Phương pháp **thuần discretionary**. "Cây volume rất lớn", "phản ứng tốt", "đủ hợp lưu" đều
  **không có ngưỡng định lượng** → không backtest được, và hai người nhìn cùng một chart sẽ vẽ key khác nhau.
- Câu *"hệ thống này đã hoàn chỉnh, bạn phải reset hết kiến thức bên ngoài, thêm bất kỳ cái gì
  vào cũng hỏng"* là **cờ đỏ về mặt nhận thức luận** — hệ thống nào không cho phép kiểm chứng
  từ bên ngoài thì cũng không tự sửa được.
  Đáng ghi nhận là chính họ nói ngược lại ở chỗ khác:
  *"không chắc 6 tháng hay 1–2 năm tới nó còn đúng, hỏng chỗ nào thì sửa chỗ đó."*
- Có **bán khoá học** (7–12 buổi, macro + keyvolume), và có rất nhiều bên **bán lại lậu + mạo danh**.
  Nếu định mua thì kiểm tra kỹ kênh chính chủ.

---

## 12. Ghi chú số hoá / code hoá

### Số hoá được

- Chuỗi nến xanh/đỏ Daily làm **trend filter**
- **Mod3 / Inside bar** — thuần OHLC, rất dễ
- Phát hiện **nến volume ngoại lai** (vd. `volume > k × median(100 nến)`) làm ứng viên key
- **Sweep / SFP** — phá đỉnh cũ rồi đóng lại bên trong
- **BOS 2 lần** trước khi tin là phá thật
- **HVN / LVN** từ volume profile
- **SL sau swing/OB** + thoát khi cấu trúc hoặc cạnh HVN kỳ vọng bị xuyên thủng

### Không số hoá được

- "Phản ứng giá tốt"
- Chọn key nào trong nhiều ứng viên
- Toàn bộ lớp vĩ mô

Đây là phần tạo ra phần lớn edge họ tuyên bố → **đừng kỳ vọng bản code hoá đạt cùng thống kê**.

### Hai giả thuyết nghiên cứu, không phải luật định lượng của kênh

Kênh có nói lệnh chuẩn thường phải chạy sớm, nhưng không công bố số nến cố định. Vì vậy:

1. `n nến không đi → cắt` chỉ là giả thuyết backtest, không được bật trong model mặc định.
2. `higher-low liên tiếp → cắt short` xuất hiện trong bản đặc tả ban đầu, chưa đủ nguồn để áp dụng
   đối xứng hoặc dùng làm exit cứng cho model live-trade.

Model mặc định chỉ thoát theo stop/cấu trúc-key bị vô hiệu, target cấu trúc kế tiếp và time-stop
an toàn 7 ngày.

### Audit nguồn chính chủ bổ sung — 2026-07-30

Không nên hiểu checklist phía trên là một setup duy nhất phải nhét tất cả điều kiện vào cùng lúc.
Kênh đang dạy nhiều **entry model** theo bối cảnh:

- [`#10. My Trading Setup - Key Level - Volume`](https://www.youtube.com/watch?v=eBxQ_MrIbMw):
  Key Level Daily được chọn từ lịch sử giá, nhiều phản ứng và điểm xoay chiều; sau đó hạ H1 để
  đọc swing/cấu trúc và M15 để đọc volume bảo vệ vị thế.
- [`#11. Confluence of 3 Timeframes`](https://www.youtube.com/watch?v=jFIOG6L3O5g):
  mô hình nến chỉ hợp lệ khi cùng hướng với bối cảnh; Daily → H1 structure → M15 volume tại vùng
  hồi. BOS đứng một mình chưa đủ.
- [`#23. ENTRY - KEYVOL`](https://www.youtube.com/watch?v=m8r6zunAN34):
  chọn key và entry đều được tác giả nói rõ là tùy biến, không máy móc. Volume lần sau có thể nhỏ
  hơn lần đầu nhưng vẫn hợp lệ nếu kích đúng nơi đang chờ; TP theo FTR/vùng cấu trúc, không theo
  một trần R cố định.
- [`Phân tích kèo LiveTrade +50R`](https://www.youtube.com/watch?v=aPu9ojfAJY0):
  chuỗi ba nến Daily cùng màu → key có volume lớn → lần quay lại key có volume kích tiếp
  → chờ cú dìm/quét cuối → phá cấu trúc → vào sau nến xác nhận; không chạy ngay thì bỏ.
- [`#22. HỆ THỐNG TRADE HOÀN CHỈNH`](https://www.youtube.com/watch?v=HjSCQkSSCPs):
  Daily → M15 → M5; ở M5 đo volume profile của cả nhịp hồi, chờ giá đi từ LVN/ngoài profile vào
  cạnh HVN, hợp lưu OB và mô hình hai đáy/hai đỉnh. Invalidation là giá đi ngược trở ra khỏi vùng
  kỳ vọng, không phải hết một số phút cố định.
- [`#28. Phương Pháp Keyvolume Hoạt Động Thế Nào?`](https://www.youtube.com/watch?v=ooS9Ons67O4):
  macro/data và session là một phần của bối cảnh; tác giả có thể bỏ lệnh quanh tin dù kỹ thuật đúng.
- [`FTR × OB × Bulltrap × Volume`](https://www.youtube.com/watch?v=b-zNRg90nQw):
  FTR đổi vai hỗ trợ/kháng cự → bull/bear trap → RSI phân kỳ → engulfing/OB
  → thêm xác nhận hai lower-low/higher-high trên M15 rồi mới entry.

Các video này không mâu thuẫn; chúng mô tả nhiều model theo bối cảnh. Vì vậy code không được ép RSI, FTR,
HVN, hai BOS và volume-retest thành một chuỗi bắt buộc. `key-volume.ts` giữ `document-v1` để tái lập
bản đặc tả ban đầu, còn `volume-retest` là model mặc định có transcript trực tiếp.

Các sửa lỗi sau audit:

- Trigger M15 tại key dùng `>= median` thay vì ép `2×`; key gốc vẫn cần volume ngoại lai + displacement.
- Một lần volume/touch sai chỗ không làm key bị tiêu thụ; có thể chờ lần sau đúng vị trí.
- Chuỗi Daily chỉ xác lập/đảo bias khi phá cực trị nến ngược màu gần nhất; không dùng màu của đúng
  ba nến cuối làm hard gate tại mọi thời điểm.
- Key đổi vai demand ↔ supply sau khi bị phá bằng close; đoạn vai mới chỉ khả dụng sau nến phá,
  tránh nhìn trước.
- Không cho tái vào cùng key một cách vô hạn. `#26` chỉ chứng minh trường hợp vào lại sau khi lệnh
  trước đã được bảo vệ bằng stop dương và xuất hiện cú sweep sâu hơn; code áp đúng hai điều kiện đó.
- `volume-retest` vào ở open ngay sau nến M15 phá cấu trúc, đúng live-trade `+50R`. Entry chờ
  OB/HVN limit là model riêng `document-v1`, không nhập chung.
- Nếu giá đóng ngược qua thân nến xác nhận thì thoát `entry-invalid`; sau đó stop bám swing M5 đã
  xác nhận. Mọi swing dùng để trail đều phải qua đủ pivot-right nên không nhìn trước.
- Chốt 1/2 tại `2R`, kéo phần còn lại ít nhất về hòa vốn rồi tiếp tục theo swing; đây là cách số hoá
  tối thiểu từ các ví dụ “chốt 1/2, còn lại kệ nó” và stop dương.
- Chỉ vào nếu vùng đối diện gần nhất còn ít nhất `3R`; `#23` mô tả entry bình thường khoảng `3–5R`.
  TP tới vùng cấu trúc đối diện; `5R` chỉ là fallback khi không tìm được vùng, không phải trần.
- Số phản ứng lịch sử của key và hợp lưu H4 được đưa vào ablation nhưng không ép mặc định:
  `#10/#11` mô tả setup top-down riêng, còn live-trade `+50R` không công bố hard gate định lượng đó.
- Backtest chặn notional theo `risk%` và `LEVERAGE` (mặc định `10x`); gross R và cost R cùng được
  scale. Kết quả cũ giả định đủ size cho stop cực ngắn nên tương đương đòn bẩy không giới hạn.

Các ngưỡng median, lookback và ATR vẫn là **quy ước lượng hoá**, không phải con số kênh công bố.
Quan trọng hơn, backtest Binance chỉ kiểm tra phần kỹ thuật OHLCV, không kiểm tra toàn bộ phương pháp
FX Dream do thiếu macro, tick-volume Forex/Gold và quyết định chọn key.

### Audit tần suất bổ sung — 2026-07-30

Kênh không công bố nhật ký giao dịch đầy đủ để suy ra một con số lệnh/ngày đáng tin cậy. Số video
vào lệnh cũng không phải trade log. Audit mới phân biệt hai đại lượng:

- **Setup kỹ thuật:** touch + volume + sweep + BOS xuất hiện khá nhiều.
- **Lệnh được phép vào:** setup còn phải có stop hợp lệ và tối thiểu `3R` dư địa tới vùng đối diện.

Việc bỏ hẳn giới hạn tái vào từng đẩy benchmark lên `268` lệnh, nhưng đó là diễn giải quá rộng:
`#26` chỉ vào lại sau stop dương và cú quét sâu hơn. Vì vậy `268` không còn được coi là tần suất
đúng của phương pháp.

Funnel cùng kỳ 2025-03-17 → 2026-07-30 trên BTC/SOL/XRP/DOGE (có warmup trong funnel):
`42,557 touch → 16,041 volume@key → 4,437 sweep → 2,739 BOS/plan → 58 entry`; trong đó
`2,364` plan bị loại vì không còn `3R` dư địa và `255` plan bị loại vì stop/risk. Sau khi bỏ warmup,
còn `35` trade, tương đương `0.070` lệnh/ngày trên rổ hoặc `0.122` lệnh/tuần/symbol.

Điều này xác nhận nhận xét của người dùng rằng **tần suất setup** cao hơn bản cũ, nhưng không cho
phép biến mọi setup thành trade. Video `#9/#23` nhấn mạnh dư địa và vùng TP; bỏ gate này cho ra
`672` lệnh nhưng gross vẫn âm trong sensitivity audit. Benchmark cũng chỉ quét bốn crypto, trong khi:

- Kênh có nhiều model công khai: follow-trend, breakout/retest, Keyvolume × OB, trap/FTR; code hiện
  mới backtest pipeline `volume-retest`. Kênh còn quét Vàng, Forex, Bitcoin và các thị trường khác,
  còn benchmark chỉ có bốn crypto.

> **Đã bị thay thế bởi [§13](#13-audit-lại-từ-transcript-gốc--2026-08-01) (2026-08-01).** Con số
> `35` lệnh dưới đây là hệ quả của một **lỗi trong gate dư địa**, không phải tần suất thật của
> pipeline. Giữ lại để đối chiếu lịch sử.

Benchmark `10x` cùng kỳ của technical subset: Key Volume `35` trade, gross `+1.7R`, cost
`-30.2R`, net `-28.5R`; SMC `98` trade / `+56.4R` net; Turtle `268` / `+76.6R`; Fast Trend
`365` / `+26.1R`. Con số Key Volume vẫn âm, nhưng có ý nghĩa hẹp:

1. Nó bác bỏ **bản lượng hoá OHLCV hiện tại** trên bốn crypto, không bác bỏ kết quả giao dịch tay.
2. Reward price-R của trade thắng vẫn lớn hơn fail; phí và cap đòn bẩy phải được báo riêng, không
   được trộn để nói phương pháp có reward nhỏ.
3. Không biến một ngưỡng chưa được kênh công bố thành hard gate chỉ để làm NET đẹp hơn. Ablation
   volume `2×`, lịch sử key `1/2/3` phản ứng, H4 bắt buộc và bỏ room gate đều chưa cho edge bền.
4. Phần khác biệt nhiều khả năng nằm ở chọn key/chất lượng phản ứng, session/macro và universe
   Gold/Forex — chính những biến discretionary mà code chưa quan sát được.

---

## 13. Audit lại từ transcript gốc — 2026-08-01

Lần audit này bóc lại transcript tiếng Việt trực tiếp bằng `yt-dlp` thay vì dựa trên bản đúc kết
cũ, và đối chiếu từng phát biểu với `key-volume.ts`. Kết quả: bản số hoá **lệch khỏi phương pháp
ở bốn chỗ**, trong đó một chỗ là lỗi lập trình thực sự.

### 13.1 Lỗi nghiêm trọng — gate "dư địa 3R" bị đảo ngược

`nearestOpposingTarget()` có sẵn tham số `sourceTfs` nhưng **chưa bao giờ được truyền vào**, nên
gate dư địa quét toàn bộ rổ level, gồm cả **26.953 level M15**. Với mật độ đó, luôn tồn tại một
level ngược hướng nằm sát entry.

Đo trên 2.706 plan cùng kỳ:

| Nhóm plan | n | risk trung vị (\|entry−SL\|/entry) | dư địa trung vị |
|---|---|---|---|
| Tất cả plan | 2.706 | 0,914% | — |
| **Qua** gate 3R | 72 | **0,115%** (p10 = 0,018%) | 7,43R |
| Bị loại vì gate | 2.481 | 0,873% | **0,054R** |

Dư địa trung vị của nhóm bị loại là `0,054R` — tức level đối diện gần nhất nằm gần như ngay trên
giá vào. Vì vậy điều kiện `opposingR ≥ 3` **chỉ có thể thoả khi risk nhỏ đến mức suy biến**. Gate
này không lọc "còn dư địa" mà lọc "stop siêu ngắn": nó giữ lại đúng nhóm lệnh nhiễu nhất và loại
97,9% plan còn lại. Đây là nguyên nhân trực tiếp của 34 lệnh / WR 17,6% / phần lớn thoát trong 5–35
phút ở benchmark cũ.

Kênh đo dư địa và TP theo **cấu trúc lớn**, không theo level gần nhất:

- `#10`: *"nó đi lên nó chưa có chạm cái kháng cự thì khả năng lên tiếp"* → dư địa tới kháng cự Daily.
- `#22`: *"TP thì các bạn phải TP theo m15"*, mục tiêu xa hơn là kháng cự Daily (`26R`).
- `#19`: TP đặt tại `Mod3` / kháng cự khung lớn, *"cũng được 5R"*.

Đã sửa: thêm `targetSourceTfs`, mặc định `["1h","4h"]`.

### 13.2 Đặt stop sai chỗ

Bản cũ (`volume-retest`) đặt SL tại cực trị **cả cửa sổ touch→sweep trên M15**. Kênh nói ngược lại,
nhất quán qua bốn video:

- `LiveTrade +50R`: *"mình để stop nó rất là ngắn như vậy thôi... nó cũng có một cái mô hình nến
  nhấn chìm nhỏ nhỏ ở dưới"*, và định lượng luôn hệ quả: *"cái kèo này là 30R... còn nếu mà bạn nào
  mà đặt stop loss xa xa xíu thì tầm khoảng chục R 15R"*.
- `#22`: *"đặt stoploss dưới cái Order Block luôn, stoploss rất là ngắn luôn, không thể nào mà ngắn
  hơn được"*; và *"stop l ở dưới key này thôi là ok, không cần mà phải quá xa như vậy"*.
- `#23`: *"stop l lúc này trên cái Block là được rồi"*.
- `#43`: *"vào lệnh thì mình sẽ để stoploss an toàn là mình sẽ để ở dưới cái Order Block"*.

Đã sửa: thêm `stopMode` với ba lựa chọn `sweep-window` (cũ) / `confirmation` (sau nến xác nhận) /
`key` (ngoài vùng key, đúng phát biểu `#22`).

### 13.3 Thiếu luật "không chạy liền là bỏ"

Bản đúc kết cũ xếp luật này vào "giả thuyết nghiên cứu, không bật mặc định". Transcript bác bỏ điều
đó — luật được phát biểu thẳng, ba lần độc lập, đúng cho model này:

- `LiveTrade +50R`: *"Hầu như là lon xong là giá sẽ chạy. Ở đây mà giá không chạy nữa là các bạn
  phải bỏ ngay lập tức luôn."*
- `#26`: *"mình kỳ vọng là nó sập liền... Nó không sập liền mà nó còn quay lên nữa thì mình phải
  thoát ra liền."*
- `#43`: *"bạn vào theo cái mô hình này mà nó không chạy nữa mà sệ tiếp là bạn thoát ra ngoài luôn,
  nguyên tắc của mình là vậy."*

Đã sửa: `requireFollowThrough` áp cho mọi model, không riêng `document-v1`.

### 13.4 Key không có yêu cầu lịch sử phản ứng

`minKeyReactions` mặc định `0`, nên code sinh 6.777 key H1 + 26.953 key M15 trên 4 symbol / 620
ngày. Đó không phải "key". Kênh chọn key theo **lịch sử phản ứng nhiều lần**:

- `#10`: *"nó có 3 cái keyvol, có 3 cái điểm xoay chiều"*; và loại thẳng một mức vì
  *"nếu mình lấy trên này nó không có lịch sử giá"*.
- `#28`: *"nó cũng có phản ứng rất là nhiều nè. Đây một chạm nè, hai chạm nè, ba chạm nè."*
- `#26`: loại một mức vì *"không có phản ứng, và không có gì liên quan tới vol hết"*.

### 13.5 Những phần kênh dạy mà code vẫn chưa có

- **Mô hình hai đỉnh / hai đáy là trigger chính**, và **chạm lần đầu không được vào**:
  `#22` — *"cái phát đầu tiên là không thể nào mà tray được... mình phải canh tín hiệu hai đáy mới
  được"*; `#23` — *"mô hình hai đỉnh hai đáy là đủ tray rồi, đủ kiếm tiền rồi"*.
- **Vào bằng lệnh Limit tại OB** (`#23`: *"các bạn có thể Limit cũng được"*), trong khi code vào
  market ở open kế tiếp → chịu taker + slippage cả hai chiều.
- **Phiên giao dịch**: `+50R` tính việc volume kích đúng **phiên Mỹ** là một điểm cộng.
- **Vào lại nhiều lần trên cùng một key** là thao tác thường quy sau stop dương (`#23`, `#43`),
  không phải ngoại lệ hiếm như code đang giả định.

### 13.6 Kết quả ablation — tách riêng từng sai lệch

BTC/SOL/XRP/DOGE, 2025-03-19 → 2026-08-01, risk 1%, cap 10x, cùng `CONFIG.costs`:

| Biến thể | N | WR | GROSS R | NET R | exp | SL trung vị |
|---|---|---|---|---|---|---|
| legacy (trước audit) | 34 | 18% | +1,2 | −27,6 | −0,812 | 0,136% |
| +dư địa theo H1/H4 | 130 | 22% | +2,2 | −88,7 | −0,682 | 0,271% |
| +SL sau nến xác nhận | 32 | 34% | +0,8 | −15,3 | −0,479 | 0,439% |
| +bỏ nếu không chạy | 34 | 12% | −0,5 | −29,3 | −0,863 | 0,136% |
| cả ba | 203 | 27% | +10,0 | −106,9 | −0,527 | 0,316% |
| **cả ba + key ≥1 phản ứng** | 249 | 31% | **+31,2** | −108,0 | −0,434 | 0,309% |
| **SL ngoài key + key ≥1 (mặc định mới)** | 61 | 28% | +0,7 | **−8,8** | **−0,144** | 1,418% |
| − bỏ trail M5 | 60 | 20% | −3,1 | −12,4 | −0,207 | 1,435% |
| − bỏ trail, bỏ TP1 | 60 | 13% | −7,5 | −16,9 | −0,281 | 1,435% |
| − bỏ trail, không cắt sớm | 59 | 15% | −5,5 | −14,8 | −0,251 | 1,435% |

Hai điều đáng chú ý:

**Giả thuyết "trail M5 giết mất đuôi lãi" bị bác bỏ.** Suy luận ban đầu là code bám swing M5 quá
chặt nên cắt mất các cú `5–20R` mà phương pháp sống nhờ đó. Số liệu ngược lại: bỏ trail làm GROSS
tụt từ `+0,7R` xuống `−3,1R`, bỏ luôn TP1 còn tệ hơn (`−7,5R`). Trail M5 đang **đóng góp dương**,
giữ nguyên.

**Edge nằm ở nhánh stop ngắn, nhưng nhánh đó không trả nổi phí.** Có một sự đánh đổi rất rõ:

| | SL trung vị | GROSS/lệnh | Chi phí/lệnh | NET/lệnh |
|---|---|---|---|---|
| SL sau nến xác nhận + key ≥1 | 0,309% | **+0,125R** | −0,559R | −0,434R |
| SL ngoài key + key ≥1 | 1,418% | +0,011R | −0,155R | −0,144R |

Bản stop ngắn **có edge gộp thật** (`+0,125R/lệnh` trên 249 lệnh) — đúng như kênh tuyên bố về độ
chính xác của entry — nhưng ma sát Binance `0,14%` giá mỗi vòng quy ra `0,559R/lệnh` ở độ rộng stop
đó và ăn sạch. Bản stop rộng trả phí thoải mái nhưng gần như không còn edge gộp.

### 13.7 Ràng buộc thật: chi phí thực thi, không phải logic tín hiệu

Ngưỡng hoà vốn của nhánh có edge: cần ma sát khứ hồi `< 0,125 × 0,309% ≈ 0,039%` giá. Đối chiếu:

| Kịch bản thực thi | Ma sát khứ hồi |
|---|---|
| Binance taker 2 chiều + slippage (đang mô hình hoá) | ~0,14% |
| Binance maker vào / taker ra | ~0,09% |
| Binance maker cả 2 chiều (không thực tế cho SL) | ~0,04% |
| Vàng/Forex qua broker phổ thông | ~0,01–0,02% |

Nghĩa là cùng một chuỗi tín hiệu **có lãi trên Vàng/Forex và lỗ trên perp Binance**. Điều này khớp
với thực tế của kênh: họ trade chủ yếu **Vàng/Forex**, vào bằng **limit** tại OB (`#23`:
*"các bạn có thể Limit cũng được"*), trong khi code vào **market ở open kế tiếp** → taker + slippage
cả hai chiều. Benchmark hiện tại là 4 crypto perp, tức đang test phương pháp ở đúng venue bất lợi nhất
cho nó.

### 13.8 Benchmark sau khi sửa

Mặc định mới: `targetSourceTfs ["1h","4h"]` · `stopMode "key"` · `minKeyReactions 1` ·
`requireFollowThrough true` · `trailMode "m5-swing"`.

| Phương pháp | N | WR | exp | GROSS R | NET R | maxDD | P(NET>0) |
|---|---|---|---|---|---|---|---|
| KeyVol OHLCV (trước) | 34 | 17,6% | −0,812 | +1,2 | −27,6 | 25,7% | 0,2% |
| **KeyVol OHLCV (sau)** | 61 | 27,9% | **−0,144** | +0,7 | **−8,8** | 12,6% | 8,4% |
| SMC | 98 | 53,1% | +0,576 | +64,8 | +56,4 | 8,3% | 99,9% |
| Turtle | 268 | 39,6% | +0,286 | +90,8 | +76,6 | 28,8% | 86,8% |
| Fast Trend | 365 | 35,6% | +0,071 | +40,5 | +26,1 | 23,8% | 68,0% |

Funnel mới: `key M15/H1/H4 24534/5646/869 → touch 35509 → volume@key 13633 → sweep 3903 →
BOS 2384 → entry 81` (trước: chỉ 55 entry, trong đó 2.344 plan bị gate dư địa loại oan).
Khoảng tin cậy bootstrap chuyển từ `[−43,7; −12,0]` sang `[−18,7; +2,1]`.

Kết luận không đổi về mặt quyết định: **vẫn không nên bật Key Volume live trên rổ crypto này** —
SMC/Turtle đang vượt trội rõ. Nhưng lý do đã khác: trước đây con số âm phần lớn là **artefact của
gate lỗi**, giờ nó phản ánh đúng ràng buộc chi phí thực thi ở §13.7.

### 13.9 Vì sao bản code vẫn thua kết quả giao dịch tay

Bản lượng hoá OHLCV **không tái lập được kết quả giao dịch tay**, và phần chênh nằm ở đúng những
biến kênh nhấn mạnh là không máy móc hoá được:

> `#23`: *"cái cách vẽ key của mình, mình vẽ là tùy biến thị trường cho nên mình không có vẽ một
> cách máy móc"* — và — *"tại sao mình vẽ cái key rất là đúng nhưng mà bạn vẽ key là sai? Tại vì
> các bạn thiếu kiến thức, kinh nghiệm và trải nghiệm thôi."*

Công cụ tái lập: `scripts/key-volume-method-audit.ts` (tách riêng từng sai lệch để biết cái nào
thực sự gây hại, thay vì sửa gộp rồi đoán).

---

## 14. Audit toàn bộ + cài đặt phần còn thiếu — 2026-08-01 (vòng 2)

Bóc thêm 8 transcript công khai (tổng 19). **7 video liên quan trực tiếp nhất là members-only trả
phí** (`#39 Mô hình 2 đỉnh đáy + SFP`, `#52 Entry Steps`, `#26 KEY VOLUME & ENTRY = SFP`,
`#14/#42 Xác định Keyvol`, `#30 Phân tích volume - xác nhận entry`, `#15 Mô hình vào lệnh win cao`)
— không truy cập, nên phần đặc tả của chúng vẫn là lỗ hổng đã biết.

### 14.1 Sai lệch lớn nhất còn lại: entry chờ BOS

`Q&A 003` hỏi đúng câu "giá tiếp cận keyvolume thì dấu hiệu nào vào lệnh". Trả lời nguyên văn:

> *"Cứ việc coi theo những cái mô hình đảo chiều cơ bản thôi. **SFP** nè, **Quasimodo** nè, hai cái
> mô hình đó là dư sức xài rồi."*

`#50 SFP` cho luôn cấu trúc định lượng được: swing high/low → vùng tích luỹ → **stop-hunt** → vào
lệnh. Và:

> *"Sau khi mà stop hunt xong thì mình sẽ vào lệnh theo cái mô hình nến **hoặc là vào luôn cũng
> được**... mình chỉ sử dụng **ba mô hình nến** thôi: **nhấn chìm, in3 và 3 bar reversal**."*

Tức **BOS không phải điều kiện vào lệnh** của model này — đó là gate code tự thêm (lấy từ `#26`,
vốn nói về việc xác nhận một con sóng mới, bối cảnh khác). Hệ quả đo được: chờ BOS đẩy entry ra xa
cú trap, nên `SL trung vị` giãn từ `0,247%` lên `1,418%` (~5,7×) và số setup rớt từ `667` xuống `61`.

`#31` xác nhận hình học đúng phải là: **stop trước, entry sau** —
*"bạn đã thấy được một cái stop l của mình khá là an toàn rồi... stop loss ở đây rồi, bây giờ chỉ là
tìm entry thôi. Entry của bạn ở đâu mình cũng không cần quan tâm."*

### 14.2 `#31` — quy trình Daily định lượng được mà code chưa có

Đây là phát biểu rõ ràng nhất của cả kênh, ba câu hỏi trên Daily:

1. Chuỗi nến đang là chuỗi gì?
2. **Low của cây nến xanh cuối cùng đã bị ĐÓNG qua chưa?** → phải là *chưa*.
3. **Low đó đã bị TRAP (thọt râu) chưa?** → phải là *rồi*.

Rồi xuống M15 với đúng một câu: *"khung M15 này nó có dấu hiệu gì của một setup Trap chưa"*.
Đã cài thành `dailyTrapGate()` + `requireDailyTrapGate`. Đây là **bộ lọc chất lượng tốt nhất tìm
được**: gross/lệnh tăng từ `+0,134R` lên `+0,281R` (gấp đôi).

### 14.3 Ablation các luật mới

| Biến thể | N | WR | GROSS R | NET R | exp | SL trung vị |
|---|---|---|---|---|---|---|
| legacy (trước audit) | 32 | 16% | −1,5 | −24,1 | −0,754 | 0,577% |
| mặc định vòng 1 (chờ BOS) | 61 | 28% | +0,7 | −8,8 | −0,144 | 1,418% |
| +chạm lần 2 mới vào | 57 | 26% | −0,1 | −9,9 | −0,174 | 1,236% |
| +hai đỉnh/hai đáy | 59 | 25% | −0,2 | −9,0 | −0,152 | 1,435% |
| +phiên Mỹ | 35 | 20% | −1,7 | −6,0 | −0,172 | 1,638% |
| +vào lại khi retouch | 61 | 28% | +0,7 | −8,8 | −0,144 | 1,418% |
| **SFP: vào theo mô hình nến** | **667** | 22% | **+89,6** | −384,3 | −0,576 | 0,247% |
| **SFP + gate Daily trap (mặc định mới)** | **74** | 27% | **+20,8** | −36,4 | −0,492 | 0,204% |
| SFP + phiên Mỹ | 321 | 24% | +40,0 | −170,3 | −0,530 | 0,257% |
| SFP + hai đỉnh/hai đáy | 617 | 23% | +89,0 | −350,1 | −0,567 | 0,246% |
| SFP + tất cả luật mới | 28 | 18% | −2,3 | −24,6 | −0,877 | 0,188% |

Đọc bảng này:

- **Entry theo SFP là thay đổi có ý nghĩa nhất từ đầu tới giờ**: `+89,6R` gross trên `667` lệnh
  (`+0,134R/lệnh`) — edge gộp lớn nhất tìm được, và đúng model tác giả trả lời trực tiếp.
- **Gate Daily `#31` nhân đôi chất lượng**: `+0,281R/lệnh`. Đây là bằng chứng ủng hộ tuyên bố của
  kênh rằng bối cảnh khung lớn mới là thứ quyết định.
- **Ba luật user yêu cầu cài (chạm lần 2, hai đỉnh/hai đáy, phiên Mỹ) đều KHÔNG cải thiện** trong
  benchmark này — đã cài đặt đầy đủ và bật được qua tham số, nhưng **không bật mặc định**, vì bật
  theo niềm tin mà số liệu không ủng hộ thì đúng là overfit ngược.
- **Chồng hết mọi luật vào nhau thì phá sản** (`28` lệnh, gross `−2,3R`). Kênh nói "thiếu một yếu tố
  là không vào", nhưng đó là với một người chọn key bằng mắt; chồng đủ 6 gate máy móc chỉ còn lại
  nhiễu.

### 14.4 Bảng đối chiếu từng luật với nguồn

| Luật trong code | Nguồn | Kết luận |
|---|---|---|
| Bias chuỗi nến Daily | `+50R`, `#26` | ✅ đúng |
| Key = volume ngoại lai + displacement | `#10`, `#28` | ✅ đúng |
| Key phải có lịch sử phản ứng | `#10`, `#26`, `#28` | ✅ đã bật (`minKeyReactions 1`) |
| Phải chạm key mới tin | `#23` | ✅ đúng |
| Volume lần sau nhỏ hơn vẫn hợp lệ | `#23` | ✅ đúng |
| Sweep/stop-hunt rồi mới vào | `#50`, `#26`, `+50R` | ✅ đúng |
| Vào theo mô hình nến sau sweep | `Q&A003`, `#50` | ✅ **đã sửa vòng 2** |
| SL dưới cú trap / OB / key | `#31`, `#22`, `#43` | ✅ đã sửa |
| Không chạy liền là bỏ | `+50R`, `#26`, `#43` | ✅ đã bật |
| Chốt 1/2, dời SL dương 1–2R | `#22`, `#43` | ✅ đúng |
| TP theo vùng M15 / kháng cự Daily | `#22`, `#19`, `#10` | ✅ đã sửa |
| Ba câu hỏi Daily | `#31` | ✅ **mới cài vòng 2** |
| Vào lại sau stop dương | `#23`, `#43` | ✅ **mới cài vòng 2** |
| Hai đỉnh / hai đáy | `#22`, `#23` | ⚠️ đã cài, không cải thiện |
| Chạm lần đầu không vào | `#22` | ⚠️ đã cài, không cải thiện |
| Phiên Mỹ | `Q&A006` | ⚠️ đã cài, không cải thiện |
| Weekly veto bias | — | ❌ **không có nguồn** — code tự thêm |
| `cooldownBars` 1 giờ | — | ❌ không có nguồn |
| Một vị thế / symbol | — | ❌ kênh vào nhiều lệnh chồng nhau |
| Macro / chi phí vốn | `#25`, `#28`, `#44` | ❌ **không thể số hoá** |
| Chọn key bằng kinh nghiệm | `#23`, `#10` | ❌ **không thể số hoá** |

### 14.5 Điều `#25` nói mà code không bao giờ đạt được

Tuyên bố winrate 80–90% được phát biểu **có điều kiện**:

> *"Khi vol mà anh chị em trade hoàn chỉnh á thì nó phải cần **tất cả** những thứ này. Khi mà đầy đủ
> hết thì chúng ta sẽ có tỷ lệ win hầu như là 80–90%."*

Và ngay trong video đó tác giả lấy một setup **kỹ thuật hoàn hảo** (cấu trúc giảm, retest, Quasimodo)
rồi **từ chối vào** vì macro ngược:

> *"Rất là đẹp để mà sale ở ngay những cái điểm này... **nhưng mà nó sẽ không đúng về cái mặt macro.
> Cái mặt macro là chúng ta phải bay lên.**"*

Đây là điểm mấu chốt: code **không có macro**, nên nó sẽ vào đúng những lệnh mà tác giả loại. Bản số
hoá vì vậy không chỉ thiếu một bộ lọc — nó thiếu đúng bộ lọc mà kênh nói là quyết định winrate.

### 14.6 Benchmark cuối và cách đọc đúng

Mặc định cuối: `entryTrigger "candle-pattern"` · `requireDailyTrapGate true` ·
`stopMode "sweep-window"` · `reentryMode "volume-retouch"` · `targetSourceTfs ["1h","4h"]` ·
`minKeyReactions 1` · `requireFollowThrough true` · `trailMode "m5-swing"`.

|  | N | WR | exp | GROSS R | **gross/lệnh** | NET R |
|---|---|---|---|---|---|---|
| legacy (đầu phiên) | 34 | 17,6% | −0,812 | +1,2 | +0,035R | −27,6 |
| sau vòng 1 | 61 | 27,9% | −0,144 | +0,7 | +0,011R | −8,8 |
| **sau vòng 2** | 76 | 26,3% | −0,516 | **+20,6** | **+0,271R** | −39,2 |

**NET tệ hơn nhưng tín hiệu tốt hơn 25 lần**, và hai điều đó không mâu thuẫn: gross/lệnh mới là
thước đo chất lượng tín hiệu, còn NET trên Binance chủ yếu là hàm của độ rộng stop. Backtest giờ in
thẳng ngưỡng quyết định:

```
Ngưỡng hoà phí: gross 0.271R/lệnh × stop 0.202%
  => chịu được ma sát khứ hồi < 0.055% · đang mô hình hoá 0.140%
```

Payoff `1,92R / 0,80R` (`2,40x`) trên price-R. Tức chuỗi tín hiệu **có lãi thật**, chỉ là cần venue
có ma sát dưới `0,055%`. Binance perp `0,140%` → lỗ. Vàng/Forex `0,01–0,02%` → lãi rõ.

> Quyết định vận hành **không đổi**: vẫn không bật Key Volume live trên rổ crypto này; SMC/Turtle
> vẫn vượt trội. Nhưng lý do đã chuyển hẳn từ "logic tín hiệu sai" sang "sai venue".

### 14.7 Điều đã cài nhưng cố ý KHÔNG bật mặc định

`requireSecondTouch`, `requireDoubleTopBottom`, `sessionHoursUtc` đều có nguồn trực tiếp và đã cài
đặt đầy đủ, nhưng ablation cho thấy không cải thiện gross/lệnh trên rổ này. Bật chúng theo niềm tin
vào nguồn mà số liệu không ủng hộ sẽ là overfit theo hướng ngược lại. Chúng nằm sau tham số, đổi một
dòng là bật được, và `scripts/key-volume-method-audit.ts` đo lại được bất cứ lúc nào.

---

## Nguồn

- Kênh: <https://www.youtube.com/@fxdreamtrading>
- Website chính chủ hiện tại: <https://keyvolume.com.vn/>
- Playlist học A–Z: <https://www.youtube.com/playlist?list=PL6KkAkfaii1qLSaJDQMj4DZZnhoIXBsZT>
- Playlist phân tích vào lệnh: <https://www.youtube.com/playlist?list=PL6KkAkfaii1rUDggg_Sw4oAX5uFfWahpY>

Transcript các video đã bóc để đúc kết:

| Video | Nội dung khai thác |
|---|---|
| [`#10. My Trading Setup - Key Level - Volume`](https://www.youtube.com/watch?v=eBxQ_MrIbMw) | Key Daily từ lịch sử giá → H1 swing → M15 volume |
| [`#11. Confluence of 3 Timeframes`](https://www.youtube.com/watch?v=jFIOG6L3O5g) | Bối cảnh + mô hình nến + structure + volume đa khung |
| [`#23. ENTRY - KEYVOL`](https://www.youtube.com/watch?v=m8r6zunAN34) | Key/entry tùy biến, volume đúng vị trí, OB/FTR/2 đỉnh-2 đáy |
| [`#28. Phương Pháp Keyvolume Hoạt Động Thế Nào?`](https://www.youtube.com/watch?v=ooS9Ons67O4) | Định nghĩa key volume, kết hợp data vĩ mô |
| [`#22. HỆ THỐNG TRADE HOÀN CHỈNH - VIDEO TÂM HUYẾT`](https://www.youtube.com/watch?v=HjSCQkSSCPs) | Quy trình Daily→M15→M5, volume profile HVN/LVN, invalidation |
| `#25. Bản Full Của Keyvolume?` | Checklist đầy đủ, cấu phần DXY, xác suất |
| [`#26. Cách Vào Lệnh A-Z - Đọc thanh khoản`](https://www.youtube.com/watch?v=mhy0vT_owCM) | BOS 2 lần, vùng short hợp lệ, stoploss dương, vào lại |
| [`#43. Keyvolume × Order Block`](https://www.youtube.com/watch?v=CAUGW6AA1Ts) | Một entry model Keyvolume hợp lưu Order Block |
| [`#19. Tìm điểm vào lệnh - Entry`](https://www.youtube.com/watch?v=8Cu0rUkqbYs) | Video riêng về tìm entry |
| [`Breakout Keyvolume + Retest Keyvolume`](https://www.youtube.com/watch?v=hDc66Ig0Tnk) | Xác nhận kênh dùng cả breakout/retest, không chỉ một pipeline |
| `#53. Lộ Trình Trở Thành Trader Chuyên Nghiệp` | Lộ trình học, quản trị vốn 1–5%, macro = chi phí vốn |
| `Phương pháp trade winrate 80% - RR 1:5` | Review 5 lệnh BTC/Gold, Mod3, breaker, entry/SL cụ thể |
| `6 phút học setup trade 5 năm tôi nghiên cứu` | Tư duy top-down, Quasimodo, không trade ngược trend |
| `Thế nào là một lệnh trade hoàn hảo?` | Hợp lưu Mod3 + điểm xuất phát lực + key volume + FTR |
| `#12. Setup Trade Sideway` | Tích luỹ, quét stoploss, TP1 1/2 + gồng, không trade sideway |
| `#9. Setup Trade Follow Trend` | Liquidity gap, dư địa, hai setup giống nhau kết quả khác nhau |
| `Tư duy quản lý lệnh` | Phân biệt đánh thuận / ngược cấu trúc, đặt SL đúng cấu trúc |
| `CƠ CHẾ VẬN HÀNH THẬT CỦA THỊ TRƯỜNG - Liquidity & Market Maker` | Vi cấu trúc thị trường, rủi ro tồn kho của MM |
| `#31. Sự hợp lưu tất cả các timeframe` | Retest high Mod3 tuần, cược trap, "được thì ăn không được thì chấp nhận" |
| [`Phân tích kèo LiveTrade +50R`](https://www.youtube.com/watch?v=aPu9ojfAJY0) | Daily chain, volume-retest tại key, sweep cuối, structure break, thoát nếu không chạy ngay |
| [`Setup FTR × OB × Bulltrap × Volume`](https://www.youtube.com/watch?v=b-zNRg90nQw) | Entry model FTR/RSI/engulfing riêng, xác nhận hai lower-low/higher-high trên M15 |
