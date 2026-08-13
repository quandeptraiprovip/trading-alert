# BÀN GIAO PHIÊN 13/08/2026 — đọc file này trước khi làm gì khác

Mục đích: mở phiên mới là làm việc được ngay, không phải đọc lại 30 báo cáo.
Thứ tự trong file này là thứ tự **quan trọng**, không phải thứ tự thời gian.

---

## 0. TÌNH TRẠNG HỆ THỐNG — kiểm trước tiên

| | |
|---|---|
| **Bot** | **ĐANG TẮT.** Nến cuối xử lý 20/07/2026 08:00 UTC. Docker daemon không chạy. |
| Vốn | $192,68 Binance (Turtle) · $320,43 MEXC (Fast) = **$513** |
| Turtle state | cả 8 symbol `pos: null` — phẳng, sạch |
| Fast state | **`dotusdt` còn SHORT 2 unit "ma"** trong `fast-trend-state.json`, sl 0,8418 đã bị xuyên từ 21/07. `fast-trend-mexc-state.json` = `[]` ⇒ **không có exposure thật trên sàn** |
| Deploy | `docker compose up -d --build` đóng gói **thư mục làm việc local**. KHÔNG có bước `git pull`, không CI/CD. Git không phải nguồn sự thật cho thứ đang chạy. |

**Bẫy khởi động lại** (`oracle-deployment`): `lastBarTime` cách hiện tại ~144 nến 4h. Trước khi
`up`: (1) đối soát sàn xem thực sự đang giữ gì và còn lệnh SL/TP nào treo; (2) quyết định xoá state
để khởi động phẳng hay sửa state cho khớp sàn — **đừng để nguyên**; (3) xoá vị thế ma `dotusdt`;
(4) chỉ bật `TRADING_ENABLED` sau khi xong (1)-(3).

---

## 1. KẾT LUẬN LỚN NHẤT CỦA PHIÊN

**Uptime đáng hơn mọi tinh chỉnh tham số khoảng hai bậc độ lớn.**

`scripts/exp-year-cagr.ts`:
- **1% ngày tốt nhất mang 68%** tổng lợi nhuận; 5% ngày mang 191% (95% ngày còn lại lỗ ròng)
- Mọi cửa sổ 24 ngày: **trung vị −1,4R** · TB +7,8R · max **+251,6R**
- Quy ra tiền: tắt 24 ngày kỳ vọng mất **$8**, ca xấu mất **$242** = **8 lần lợi nhuận cả năm ($30)**
- Trong khi cải tiến tham số tốt nhất tìm được ≈ **$3/năm**

**Cái bẫy hành vi:** vì trung vị 24 ngày ÂM, người dùng sẽ liên tục trải qua giai đoạn lỗ và bị cám
dỗ tắt máy — đúng lúc phải bật. Bot đã tắt 24 ngày (lần này may, tránh −11,5R, nhưng kỳ vọng ÂM).

**Ràng buộc thứ hai: quy mô vốn.** Ở $513, hệ ra ~$113/năm (~22%). Mọi cải tiến % đều nhân với một
mẫu số nhỏ. Tỉ lệ tốt, tuyệt đối bé.

---

## 2. ĐÃ SHIP (commit `9c77bf9`)

`turtle-live.ts` — **phân bổ heat theo ảnh chụp ĐẦU NẾN**. Trước đó `heatWeight()` đọc `this.states`
ngay lúc gọi, nên trong `replay()` symbol đứng trước trong mảng được size to hơn: đổi thứ tự symbol
làm vốn cuối chênh **9% (k=4) đến 40% (k=0,25)**. Nay biên độ = **0%**.

- `T.heatDecayK` **GIỮ NGUYÊN = 4** (siết k là bước riêng, xem §4)
- Kiểm chứng: parity 182 unit / 200 ngày lệch 0 · `turtle-live-order.ts` 95 unit trùng khít 3 thứ tự
- **Tác động lợi nhuận ≈ 0** (Net R +2,5%, maxDD +2,8%, Net/maxDD −0,3%). Đây là sửa hiện vật để có
  tính xác định, và là **điều kiện cần** cho bước siết k.

---

## 3. NỀN TẢNG THỐNG KÊ — đã kiểm, đọc trước khi tin bất kỳ con số nào

`scripts/exp-deflated-sharpe.ts` (Bailey & López de Prado).

| phép | kết quả |
|---|---|
| **Deflated Sharpe** | **ĐẬU** — DSR 0,987 ngay ở N=2000 phép thử ⇒ edge KHÔNG phải hiện vật chọn lọc |
| **MinBTL** | 5,5 năm **vừa đủ, không dư**: N=500 cần 5,2 ✅ · N=1000 cần 5,7 ❌ |
| **Bootstrap khối** | Sharpe 1,55 nhưng **KTC 90% = [0,62 ; 2,21]** · maxDD quan sát 72R vs **phân vị 95% = 148R** |

**Hệ quả bắt buộc nhớ: ĐỪNG NÂNG RISK/UNIT.** Bootstrap 2000 đường, sụt cộng dồn:

| risk/unit | P(sụt>50%) | P(sụt>80%) |
|---|---|---|
| **0,50% (đang chạy)** | **13%** | 0% |
| 1,00% | **94%** | 11% |
| 1,50% ("đỉnh Kelly") | 100% | **68%** |

⇒ 0,5% đã gần đúng mức. Khuyến nghị "nâng risk" ở `growth-frontier-kelly` **ĐÃ BỊ RÚT LẠI**.
Bài học: đường giá đơn lẻ đo *cái đã xảy ra*; bootstrap đo *cái có thể xảy ra*. **Không bao giờ
chọn đòn bẩy từ một quan sát maxDD.**

---

## 4. CÒN TRÊN BÀN (chưa làm, theo thứ tự)

1. **Bật lại hệ** — lớn nhất, xem §0.
2. **Gộp hai sổ về $513** — miễn phí, không tăng rủi ro. **Bắt buộc** trước bước 3: làm bước 3 mà
   không gộp thì XẤU HƠN hiện tại (lãi/sụt 7,92 < 8,16, sụt vọt lên 49%).
3. **`heatDecayK` 4 → 0,5** — cùng gói với (2), cho **+11% risk-adjusted** (lãi/sụt 8,16 → 9,03,
   365d 1,19 → 1,31). Đã đậu lệch pha 4/4, tập trung, era, 365d.
4. **KHÔNG nâng risk/unit** — xem §3.
5. **Ensemble 4 pha nến** — cải tiến **không thể overfit** (0 tham số, không chọn gì, chỉ trung bình
   hoá quy ước lưới nến). Giữ CAGR, **sụt 24% → 14%** ⇒ CAGR/sụt **+75%**. NHƯNG chia ¼ risk đâm vào
   sàn minNotional: cần **~$2.000–5.000** mới chạy đúng ý đồ. Ở $513 thì méo hoàn toàn.

**Cảnh báo kèm ensemble:** pha 0h đang chạy là **pha MAY nhất trong 4** (vốn 17,89× vs TB 4 pha
12,06×). Kỳ vọng tương lai gần hàng "TB 4 pha" hơn hàng "pha 0h" ⇒ mọi backtest pha-0h đang đọc
lạc quan.

---

## 5. ĐÃ LOẠI — đừng làm lại

| hướng | kết quả |
|---|---|
| **Nhánh FX** (4 họ cơ chế: chuỗi thời gian, sort chéo, cặp phổ biến+vàng, phản ứng-tại-mức-giá) | KHÉP. Carry có thật nhưng t=1,13 và chết ở markup bán lẻ |
| **FX Dream / Key+Volume trên FX** | gộp −20,1R **trước** phí trên 750 lệnh |
| **Mệnh đề Key nói chung** | "giá phản ứng tại mức volume đột biến" = **0 ở CẢ crypto**, kể cả với luật chặt nhất của user (chín + đã bật một lần); hiệu ứng thật là ĐI TIẾP (t=−3,5) nhưng **mức GIẢ cho cùng số** ⇒ chỉ là quán tính giá, và dưới ngưỡng phí 0,137 ATR |
| **Đảo chiều key-volume thành hệ đi-tiếp** | LOẠI, xem trên |
| **Sàn minNotional là "chỗ rò lớn nhất"** | **SAI, tôi tự bác bỏ** — live đã bật `minQtyFloor` nên chỉ mất ~6% lãi/sụt, BTC vào 125/247 lệnh chứ không phải 6 |

---

## 6. BẪY PHƯƠNG PHÁP ĐÃ TRẢ GIÁ TRONG PHIÊN (đọc kỹ — đều là lỗi thật của tôi)

1. **Mô hình một RÀNG BUỘC mà không đọc code XỬ LÝ ràng buộc đó.** Tôi giả định live "từ chối" unit
   dưới sàn suốt ba lượt. Đọc `live-trade.ts:181-193` thì thấy nó **NÂNG lên sàn**. Kết luận đảo
   ngược. ⇒ **Đọc đường thực thi trước khi mô hình hoá nó.**
2. **`AdmitCtx.symbol` thực ra là BOOK KEY.** Đặt key = `symbol@tag` làm tra bảng sàn luôn trượt →
   bảng ra 100% ở mọi cỡ vốn, trông y như "không có vấn đề". Lỗi im lặng cho ra kết quả *hợp lý*.
3. **V[SR] cho DSR phải đo trên phép thử ĐỘC LẬP.** Đo trên 7 biến thể `k` gần trùng nhau → sd 0,04
   → DSR = 1,000 ở mọi N, vô nghĩa. Chiều chọn lọc thật là **rổ coin**.
4. **`loadPool` gọi API và NUỐT lỗi mạng.** 192 lần gọi → Binance 429 rồi **418 cấm IP**, rổ khuyết
   vẫn chạy tiếp. ⇒ Đọc thẳng cache, và **bỏ hẳn rổ thiếu** thay vì chạy với ít coin hơn.
5. **`n = 0` sau khi thêm điều kiện ⇒ luôn nghi lỗi định nghĩa trước.** Bản R3 đầu loại key khi giá
   đóng vượt ngưỡng ở BẤT KỲ phía nào → n=0. "Không bị đóng xuyên" phải hiểu theo PHÍA.
6. **Chữ ký thật là `addUnit(st, pos, candles, i, …)`** — thiếu `pos` làm lệch mọi tham số một bậc
   và nuốt mất 52/95 unit.
7. **Trung bình KHÔNG thay được cấu trúc rào.** Hệ stop/target là bài toán first-passage; "trung
   bình ≈ 0" không đủ để bác bỏ. Phải dựng rào rồi đếm chạm rào, kèm mốc null WR = 1/(1+k).
8. **Xấp xỉ tuyến tính `lãi ≈ NetR × risk` sai với tài khoản cộng dồn** — phải dùng `compoundedEquity`.

---

## 7. CÔNG CỤ MỚI CỦA PHIÊN

| script | dùng để |
|---|---|
| `scripts/turtle-live-order.ts` | chứng minh live bất biến thứ tự symbol (chạy 3 thứ tự, đối chiếu weight) |
| `scripts/exp-deflated-sharpe.ts` | DSR + MinBTL + bootstrap khối + P(sụt/cháy) theo risk |
| `scripts/exp-year-cagr.ts` | lợi nhuận theo năm + tập trung theo thời gian + chi phí downtime |
| `scripts/exp-floor-exact.ts` | sàn minNotional áp TRONG vòng lặp |
| `scripts/exp-floor-policy.ts` | luật sàn live thật vs các mô hình giả định |
| `scripts/exp-growth-frontier.ts` | đường cong Kelly cộng dồn (⚠️ đọc kèm §3) |
| `scripts/exp-phase-ensemble-floor.ts` | ensemble 4 pha + ngưỡng vốn |
| `scripts/exp-key-premise.ts`, `exp-key-barrier.ts`, `fx/fx-dream-placebo.ts` | bác bỏ mệnh đề Key |
| `scripts/exp-snap-gate.ts`, `exp-snap-netr.ts` | cửa tập trung + Net R cho thay đổi đã ship |

**Bộ ba chống kết luận sai, áp cho MỌI phép đo sau này:** (1) in **biên phát hiện** kèm mọi kết quả
"≈0"; (2) **đối chứng phải đi qua CÙNG bộ lọc**; (3) thêm **nhóm GIẢ** để kiểm chính khái niệm đang
đo; (4) đo đúng **cấu trúc trả thưởng**, kèm mốc null tự chuẩn.

---

## 8. GHI CHÚ REPO

- Đồ thị runtime của bot = **16 module, tất cả tracked, không phụ thuộc untracked**. `key-volume.ts`
  và `strategy-engine-v2` KHÔNG được wire (lo ngại cũ trong `fxdream-integration-audit` đã hết).
- `scripts/portfolio-engine.ts` mang theo công việc chưa commit từ các phiên TRƯỚC
  (`initialStopMult`, `slipTrailAtr`, `slipCloseAtr`, `pyramidTightensStop`, `closeConfirmStop`,
  `admitBarSnapshot`). Đã commit kèm trong `9c77bf9` vì parity phụ thuộc; file này **không** nằm
  trong runtime nên bán kính ảnh hưởng tới tiền thật = 0.
- Dead code có sẵn, không phải của phiên này, **chưa đụng**: `key-volume.ts:385` (`prefix`),
  `strategy.ts:292` (`tfMsOf`), `scripts/chop-diagnosis.ts:64` (`windowCellsDd`).
- Binance có thể còn **cấm IP tạm thời** (418) sau loạt fetch của phiên này. Ưu tiên đọc `.cache/`.
