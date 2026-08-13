# Sàn minNotional: đo, rồi TỰ BÁC BỎ chính kết luận "chỗ rò lớn nhất"

> ## ⚠️ ĐỌC MỤC §8 TRƯỚC
> Tiêu đề gốc và §2–§6 dựng trên giả định **live TỪ CHỐI unit dưới sàn**. Giả định đó **SAI** —
> `turtle-live.ts:313-317` bật `minQtyFloor: true`, `live-trade.ts:181-193` **NÂNG qty lên sàn**.
> Số đúng ở §8: sàn chỉ ăn **~6% lãi/sụt**, BTC vào được **125/247** lệnh chứ không phải 6.
> Đây KHÔNG phải chỗ rò lớn nhất. Giữ §2–§6 để thấy sai ở đâu.

# (tiêu đề gốc) sổ live chỉ thực thi được 57% số lệnh — BTC gần như KHÔNG giao dịch

**13/08/2026.** Tìm ra khi đi trả lời câu "vì sao chưa siết được k". Hoá ra chặn min-notional không
chỉ cản bước siết k — **nó đang ăn mất một phần lớn của hệ ĐANG CHẠY, ngay hôm nay.**

Code: `scripts/exp-floor-k.ts`. Sàn minNotional lấy trực tiếp từ Binance `fapi/v1/exchangeInfo`:
BTC **$50** · ETH **$20** · SOL/XRP/DOGE/ADA/AVAX/DOT **$5**.

---

## 1. Lỗ hổng mô hình đang bịt

Mọi bảng đo trước trong repo — kể cả con số "+95% vốn" của cấu hình đầu-nến + k=0,5 — **giả định
size đúng tuyệt đối**. Ở equity thật, unit nào có notional dưới sàn sẽ bị `live-trade.ts` nâng qty
lên sàn rồi TỪ CHỐI nếu risk hiệu dụng vượt ngân sách. Vì

$$\text{notional} = \frac{\text{equity} \times \text{risk\%} \times \text{weight}}{|\text{entry}-\text{SL}|/\text{entry}}$$

nên unit có **stop RỘNG** cho notional NHỎ và bị chặn — và siết k làm `weight` nhỏ đi nên càng nhạy.

## 2. Số: cấu hình ĐANG CHẠY (k=4, risk 0,5%, equity $192,68)

| symbol | sàn | % chặn (5,5 năm) | % chặn (365 ngày) | n lọt / n chặn |
|---|---|---|---|---|
| **BTC** | $50 | **98%** | **93%** | **4 / 243** |
| **ETH** | $20 | **90%** | 85% | 25 / 220 |
| SOL | $5 | 34% | 23% | 171 / 87 |
| XRP | $5 | 24% | 29% | 190 / 61 |
| DOGE | $5 | 30% | 32% | 183 / 77 |
| ADA | $5 | 23% | 21% | 204 / 62 |
| AVAX | $5 | 31% | 15% | 202 / 91 |
| DOT | $5 | 26% | 17% | 237 / 83 |

**BTC lọt đúng 4/247 unit.** Sổ Turtle đang chạy trên thực tế **không phải rổ 8 coin — nó là rổ 6
altcoin.** Gate BTC vẫn dùng BTC để lọc hướng, nhưng BTC gần như không bao giờ được vào lệnh.

Toàn rổ, tỉ lệ Net R lý thuyết giữ lại được:

| equity | risk 0,5% | risk 1,0% |
|---|---|---|
| **$193 (đang chạy)** | **65%** | 88% |
| $513 (gộp hai sổ) | 91% | 100% |
| $1000 | 99% | 100% |
| $2000 | 100% | 100% |

## 3. Một giả thuyết của tôi đã BỊ BÁC BỎ

Tôi đã nghĩ sàn là **bộ lọc chọn ngược**: nó chỉ nhận unit stop hẹp, mà stop hẹp thì dễ bị quét, nên
phần lọt phải tệ hơn phần bị chặn. Cơ chế nửa đầu đúng (stopFrac lọt 6,20% vs chặn 9,46%), nhưng
**kết luận sai**: gộp cả rổ, netR trung bình unit LỌT **0,667** so với unit CHẶN **0,550** — phần lọt
còn *tốt hơn* chút.

Vậy con số "BTC +89R lý thuyết → −4R thực tế" **không phải chọn ngược**, mà đơn giản là **n = 4**:
bốn unit sống sót là một phép tung đồng xu. Kết luận đúng phải phát biểu là *loại trừ gần như hoàn
toàn*, không phải *chọn lọc ngược*.

## 4. Gỡ thế nào — % unit LỌT sàn

| cấu hình | BTC | ETH | cả rổ |
|---|---|---|---|
| **ĐANG CHẠY: $193 · risk 0,5%** | **2%** | **10%** | **57%** |
| $193 · risk 1,0% | 15% | 46% | 81% |
| **gộp sổ $513 · risk 0,5%** | 28% | 61% | **86%** |
| gộp sổ $513 · risk 1,0% | 68% | 93% | 95% |
| $1000 · risk 1,0% | 92% | 99% | 99% |

**Xếp hạng hành động:**

1. **GỘP HAI SỔ ($192,68 Binance + $320,43 MEXC → $513).** Đây là đòn bẩy DUY NHẤT **không tăng rủi
   ro**: cùng số vốn, cùng risk%, mà cả rổ đi từ 57% → 86% và BTC từ 2% → 28%. Cần cân nhắc mặt vận
   hành (sleeve Fast đang ở MEXC), nhưng về vốn thì không đánh đổi gì.
2. **Nâng risk/unit 0,5% → 1,0%.** Hiệu quả mạnh (57% → 81% ngay ở $193) nhưng **KHÔNG miễn phí**:
   nhân đôi risk/unit thì nhân đôi cả Net R lẫn maxDD tính theo $. Đây là quyết định khẩu vị rủi ro,
   phải đo maxDD ở mức mới trước khi chọn — tôi chưa đo.
3. **Siết k=0,5** chỉ nên sau (1)+(2). Ở $193 nó làm cả rổ tụt xuống **40%** (risk 0,5%) — tức phần
   "+95% vốn" biến thành thua thiệt. Ở $1000 · risk 1,0% mới lấy được ~99%.

## 5. Vì sao điều này quan trọng hơn mọi cải tiến đã tìm trong phiên

Bốn vòng nghiên cứu FX cho kết quả null. Mệnh đề Key cho kết quả null. Phân bổ đầu nến (đã ship) cho
Net/maxDD đi ngang. **Còn chỗ này đang mất 35% Net R lý thuyết mỗi ngày mà không ai đo.**

Và nó khớp đúng cảnh báo tự viết trong header `exp-min-notional.ts`: *"có thể cả một symbol đang bị
loại im lặng — và nếu đó là BTC thì nó là chỗ rò lớn hơn mọi cải tiến tìm được trong ba vòng nghiên
cứu."* Lúc đó script chỉ kiểm unit 1 ở ATR hôm nay nên báo "✅ không symbol nào bị loại". Kiểm đúng
phải chạy trên TỪNG unit thật (unit 2, 3 có weight nhỏ hơn) qua nhiều chế độ vol — và khi làm thế thì
kết luận đảo ngược hoàn toàn.

## 6. ĐO LẠI CHÍNH XÁC — sàn áp TRONG vòng lặp (`scripts/exp-floor-exact.ts`)

Giới hạn "lọc sau" ở §7 đã được bịt: thêm `entryPrice`/`initialSL` (optional) vào `AdmitCtx` để hàm
`admit` trả 0 ngay tại chỗ, nên heat tự điều chỉnh và phần còn lại của phiên chạy đúng như một tài
khoản cỡ đó. `portfolio-equivalence.ts` vẫn **TRÙNG KHỚP 100%** ⇒ thay đổi không đụng hành vi.

Bảng dưới quy Net R và maxDD về **% vốn** (lãi ≈ NetR × risk/unit, sụt ≈ maxDD_R × risk/unit) —
bắt buộc, vì Net R và maxDD_R **không so được giữa các mức risk/unit**.

| k | cấu hình | lệnh | %lý thuyết | Sharpe | BTC | lãi %vốn | **SỤT %vốn** | lãi/sụt |
|---|---|---|---|---|---|---|---|---|
| **4** | **ĐANG CHẠY $193 · 0,5%** | 1479 | **82%** | **1,50** | **6** | 256% | **33%** | 7,70 |
| 4 | $193 · 1,0% | 1808 | 101% | 1,70 | 50 | 633% | **78%** ⚠️ | 8,14 |
| 4 | $513 · 0,5% | 1894 | 101% | 1,66 | 90 | 318% | 36% | 8,90 |
| 1 | $513 · 0,5% | 1695 | 103% | 1,76 | 46 | 201% | 21% | 9,69 |
| 0,5 | $193 · 0,5% | 727 | 77% | 1,63 | 6 | 119% | 15% | 7,92 |
| **0,5** | **$513 · 1,0%** | 1816 | 101% | **1,80** | 79 | **310%** | **33%** | **9,30** |
| 0,5 | $1000 · 1,0% | 2005 | 99% | 1,75 | 157 | 304% | 33% | 9,26 |

**Ba điều bảng này nói, mà bản lọc-sau không nói được:**

1. **Ước lượng cũ BI QUAN đúng như đã cảnh báo.** Cấu hình đang chạy giữ **82%** Net R lý thuyết,
   không phải 65%. Bỏ một unit làm heat giảm nên unit sau to hơn và tự vượt sàn — hiệu ứng bậc hai
   đó bù lại một phần. Con số 82% là con số đúng; 65% phải bỏ.
2. **Cái giá thật của sàn hôm nay là SHARPE, không phải Net R.** 1,50 so với 1,67 lý thuyết — mất
   0,17 Sharpe, và BTC vào được **6/247** lệnh. Sổ vẫn đang là rổ 6 alt.
3. **"Nâng risk/unit" MỘT MÌNH là cái bẫy.** Ở k=4, risk 1,0% cho lãi 633% nhưng **sụt 78% vốn** —
   không chấp nhận được. Nó chỉ an toàn khi ĐI KÈM siết k.

**Gói tốt nhất, so ở CÙNG mức sụt ~33%:**

| | lãi %vốn | sụt %vốn | Sharpe | BTC |
|---|---|---|---|---|
| ĐANG CHẠY (k=4 · $193 · 0,5%) | 256% | 33% | 1,50 | 6 |
| **k=0,5 · gộp sổ $513 · risk 1,0%** | **310%** | **33%** | **1,80** | 79 |

**+21% lợi nhuận ở ĐÚNG cùng mức đau, Sharpe 1,50 → 1,80.** Và ba thay đổi này là một gói không tách
rời: ảnh chụp đầu nến (đã ship) là điều kiện để siết k an toàn; siết k là điều kiện để nâng risk/unit
an toàn; nâng risk/unit là điều kiện để thoát sàn minNotional. Bỏ bất kỳ mảnh nào thì mảnh còn lại
phản tác dụng.

## 7. Giới hạn của phép đo LỌC SAU (§2–§4, đã được §6 thay thế)

- **Lọc SAU, không lọc trong vòng lặp.** Bỏ một unit làm heat giảm nên unit sau đáng lẽ to hơn một
  chút. Ước lượng vì thế **thận trọng** (hơi bi quan), không phải chính xác tuyệt đối.
- Equity giữ CỐ ĐỊNH, không cộng dồn. Đúng cho câu hỏi "hôm nay có bị chặn không", không đúng cho
  đường tăng trưởng dài hạn.
- Sàn MEXC (sleeve Fast) chưa đo ở đây; bảng này là Binance.

---

## 8. SỬA LỖI: mô hình "live từ chối unit dưới sàn" là SAI

Đường thực thi thật:
- `turtle-live.ts:313-317` truyền `minQtyFloor: true` và `maxRiskFrac = positionRiskBudget()`
  (= `pyramidMaxUnits × riskPct`, tức weight 3,0 cho cả vị thế).
- `live-trade.ts:181-193` **nâng qty lên sàn** (`needQty`, đệm +1%), tính lại `riskUsd` hiệu dụng,
  và **chỉ từ chối** nếu risk hiệu dụng vượt ngân sách vị thế hoặc trần danh mục.

Tức live **đã** làm gần đúng chính sách tốt nhất. Đo lại bằng luật đúng (`admitLiveRule` trong
`scripts/exp-floor-policy.ts`), k=4 · $193 · 0,5%:

| mô hình | lệnh | BTC | Sharpe | lãi %vốn | sụt %vốn | lãi/sụt | 365d |
|---|---|---|---|---|---|---|---|
| TỪ CHỐI (mô hình cũ của tôi — SAI) | 1479 | **6** | 1,50 | 256% | 33% | 7,70 | 0,69 |
| **LUẬT LIVE THẬT (đang chạy)** | 1960 | **125** | 1,57 | 310% | 38% | **8,16** | **1,19** |
| không có sàn (lý thuyết) | 2140 | 247 | 1,67 | 314% | 36% | 8,70 | 0,86 |
| **ĐỀ XUẤT k=0,5 · $513 · 1,0%** | 2138 | 245 | 1,67 | 313% | 35% | **9,03** | **1,31** |
| ĐỀ XUẤT ở vốn HIỆN TẠI ($193 · 1,0%) | 2094 | 211 | 1,60 | 385% | **49%** | 7,92 | 1,51 |

**Ba đính chính:**

1. **Sàn chỉ ăn ~6% lãi/sụt** (8,16 so với 8,70 lý thuyết), không phải 18–35%. BTC vào được
   **125/247** lệnh. Câu "sổ đang chạy là rổ 6 alt" — SAI, bỏ.
2. **Đề xuất hơn +11% risk-adjusted**, không phải +21%. Lãi tuyệt đối gần như KHÔNG đổi
   (310% → 313%); phần được là **sụt 38% → 35%** và cửa sổ 365 ngày 1,19 → 1,31.
3. **Làm đề xuất mà KHÔNG gộp sổ thì XẤU HƠN hiện tại**: ở $193 · 1,0% ratio tụt còn 7,92 và sụt
   vọt lên **49%**. Gộp sổ không phải "một trong ba mảnh" — nó là điều kiện bắt buộc.

**Nguyên nhân sai:** tôi mô hình một RÀNG BUỘC (minNotional) mà không đọc đoạn code xử lý ràng buộc
đó trước. Khi đọc `live-trade.ts` thì kết luận đảo ngược. Quy tắc rút ra: **đọc đường thực thi
trước khi mô hình hoá nó.**
