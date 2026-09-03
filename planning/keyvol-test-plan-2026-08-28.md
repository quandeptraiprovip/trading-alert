# Kế hoạch KIỂM THỬ Key Volume — chốt 2026-08-28

Nguồn: artifact "Giải Phẫu Key Volume" (mục 01–11) + code thật trong repo + 6 kế hoạch tay của
user ở `trading-runtime/chart-playbook/btcusdt.json`. Không lấy số từ nguồn nào khác.

**Quyết định của user (28/08):** trade thật ở XAUUSD **và** BTCUSDT · ngưỡng đậu = NET dương sau
phí THẬT **và** thắng đối chứng · **BTC làm trước**, vàng để sau · lệnh tay đã có sẵn trong repo.

---

## 0. Vì sao vẫn còn gì để kiểm — ba khoảng trống

Phần lớn bài này đã chạy và ra âm (`fxdream-fx-application-2026-08-13.md` §2–§4). Chỉ ba chỗ chưa:

1. **Cấu hình đã chạy dùng key H1/H4, không phải M15.** Phễu lần chạy vàng tự tố: `key 1h 789 ·
   key 4h 234`. Cơ chế: `runKeyVolume` sinh `m15Levels` (`key-volume.ts:1815`) nhưng
   `buildEntryPlans` (`:1836`) chỉ nhận `h1Levels`/`h4Levels`. Baseline retest vẫn là trung vị 96
   nến (`:1134`). Đúng hai lệch mà artifact §11 chốt phải bỏ.
2. **Hai model mới chưa có một dòng code** — `breakout-retest` và `ftr-bulltrap` không neo vào "mức
   giá của cây volume", nên mệnh đề null KHÔNG phủ chúng.
3. **Lần chạy vàng thiếu lực:** n=155, SE gộp ≈ ±0,12R — không đủ để loại trừ hiệu ứng cỡ 0,27R
   đang cần. Phép null CHẶT (n=43k) chạy ở **H1 với baseline 96 nến**, tức đúng hai trục sắp đổi.

Ngược lại, ba thứ đã đóng, KHÔNG mở lại: mệnh đề "giá bật tại mức volume đột biến" ở H1
([[keyvol-key-premise-null]]), ghép key vào Turtle/Fast ([[fxdream-as-trend-input]]), và dùng H1/H4
làm nguồn Key (user bác 16/08).

## 1. Sàn chi phí — hiệu chỉnh bằng 6 lệnh tay THẬT

| | R trung vị | ×ATR(M15) | phí khứ hồi | **phí/R** | WR hoà vốn @ target 4,06R | mốc ngẫu nhiên |
|---|---:|---:|---:|---:|---:|---:|
| **BTCUSDT perp** | 0,57% | 2,1× | 0,140% | **0,246 R** | **24,6%** | 19,8% |
| **XAUUSD** (giả định cùng ×ATR) | 0,228% | 2,1× | 0,032% | **0,140 R** | 22,5% | 19,8% |

Đại số: hoà vốn ⇔ `WR = (1+c)/(1+k)`, ngẫu nhiên `= 1/(1+k)` ⇒ **phải thắng bước ngẫu nhiên đúng
(1+c) lần, không phụ thuộc target**. BTC: +24,6%. Vàng: +14,0%.

⚠️ Vàng dễ hơn BTC 1,8 lần. **Một kết quả null trên BTC KHÔNG chuyển sang vàng** — phải chạy riêng.

## 2. Bảy cửa, rẻ-giết-trước

### Cửa 0 — Chốt ngưỡng (30 phút, làm trước mọi backtest)
Viết bảng §1 vào file kết quả TRƯỚC khi chạy. Không sửa ngưỡng sau khi thấy số.

### Cửa 1 — Đối chiếu 6 lệnh tay với detector ⟵ **LÀM ĐẦU TIÊN**
Việc mới, chỉ có được vì user đã lưu kế hoạch tay. Ba phép, `scripts/exp-keyvol-vs-manual.ts`:
- **(a) Kết quả thật của 6 kế hoạch.** Chạy giá 5m qua entry/SL/TP. Quy ước bảo thủ: nến chạm cả
  hai ⇒ tính STOP trước ([[limit-backtest-lookahead-traps]] bẫy 2). Cần làm mới cache 5m (hết ở
  01/08, hai lệnh nằm sau đó).
- **(b) RECALL của detector.** Chạy `runKeyVolume` quanh ±48 nến mỗi entryTime: có sinh kế hoạch
  nào CÙNG CHIỀU, giá trong ±0,3×ATR không? In 6/6 dòng, kể cả dòng trượt.
- **(c) So mẫu số R.** R tay 0,45–3,44% vs R code (0,017% ở production, 0,468% khi bỏ minRR).

**Verify:** recall 0/6 ⇒ mọi backtest sau đó không nói gì về phương pháp user đang trade; phải sửa
detector trước khi chạy tiếp. **Giới hạn phải in kèm:** n=6 KHÔNG kết luận được về lợi nhuận, chỉ
kết luận về ĐỘ KHỚP.

### Cửa 2 — Đo lại MỆNH ĐỀ ở đúng cấu hình mới (1 ngày)
Sửa `scripts/exp-key-premise.ts`: key phát hiện trên **M15**, baseline retest **cục bộ N ∈ {3,5,8}
nến liền trước** (bỏ `medianPrior` 96). Chạy 8 coin, ~3,4 năm nến 15m.
Bắt buộc đủ ba phép của [[null-result-toolkit]]: **biên phát hiện**, **đối chứng đi qua CÙNG bộ
lọc**, **nhóm MỨC GIẢ** (dời 0,7 ATR).
**Verify đậu:** |spike − giả| > 0,246 ATR. **Verify null hợp lệ:** biên phát hiện < 0,05 ATR (nếu
rộng hơn thì kết quả là "chưa đủ dữ liệu", không phải "không có gì").

### Cửa 3 — Cấu trúc rào + hai đối chứng (1 ngày)
`scripts/exp-key-barrier.ts` ở M15, rào dựng đúng cấu hình tay: R = 2,1×ATR, target 4R, vào ở close
nến xác nhận. Trung bình bước giá KHÔNG thay được rào (first-passage).
Ba nhóm: **key thật** / **mức GIẢ** / **vào NGẪU NHIÊN cùng bộ máy thoát** — nhóm ba là bắt buộc vì
[[indicator-families-rejected]] vòng 4 cho thấy vào lệnh ngẫu nhiên + bộ máy thoát tốt đạt Sharpe
1,19; nếu key không vượt nhóm này thì "key" không đóng góp gì.
**Verify:** WR_key ≥ 1,246 × WR_ngẫu **và** WR_key > WR_giả ngoài biên phát hiện.

### Cửa 4 — Vá code + ablation từng luật (2 ngày) — chỉ khi cửa 2 và 3 đậu
- `buildEntryPlans` nhận `m15Levels`; bỏ H1/H4 khỏi đường entry; baseline cục bộ N (số từ cửa 2).
- Chạy trên **bàn thử sạch**: `minRR: 0`, `targetSourceTfs: []`, `requireStructuralTarget: false`
  — nếu không, sàn RR=3 lại CHỌN stop suy biến 0,017% ([[keyvol-degenerate-stop-gate]]).
- Ablation qua `scripts/key-volume-method-audit.ts`: **từng thay đổi một, không gộp**.
**Verify:** mỗi biến thể in N / gross/lệnh / **NET sau phí** + phễu đầy đủ; không bậc phễu nào rơi
về 0 mà không giải thích được; in tỉ lệ tra trượt ([[null-result-toolkit]] §5).

### Cửa 5 — Hai model mới (3–4 ngày) — chỉ khi có tín hiệu
`breakout-retest` trước (rẻ: tái dùng `bosPivotLeft/Right`, thêm trigger `breakout-volume`), rồi
`ftr-bulltrap` (cần FTR zone + equal-high/low + RSI phân kỳ — chưa có RSI trong file). Mỗi model đi
qua ĐÚNG bộ đối chứng cửa 3, tính riêng.

### Cửa 6 — Chống overfit (1 ngày)
Lệch pha nến (M15 có 3 pha từ nền 5m — [[bar-phase-overfit-test]]) · tập trung theo năm/công cụ
(`scripts/exp-concentration.ts`) · Hansen SPA nếu đã quét >5 biến thể (`scripts/exp-reality-check.ts`).
**Verify:** đậu 3/3 pha; không năm/coin nào chiếm >50% lợi nhuận.

### Cửa 7 — Vàng + khớp lệnh thật (sau)
Lặp cửa 2–6 trên XAUUSD (cache chỉ có M5 2024; muốn nhiều năm thì cần token OANDA — code
`oanda-fetch.ts` đã sẵn, chỉ thiếu `OANDA_ACCOUNT_ID`/`OANDA_API_TOKEN`). Rồi forward alert-only,
đối chiếu với lệnh tay cùng kỳ.

## 3. Chủ động KHÔNG kiểm
- Chọn Key nào giữa nhiều ứng viên — kênh tự nhận là kinh nghiệm nhìn chart.
- Macro làm gate cứng — video dùng macro để gồng lệnh, không phải để vào lệnh.
- "TP tuỳ lòng tham" — phát biểu discretionary, không ép thành số.
- Mọi biến thể dùng H1/H4 làm nguồn Key — user đã bác 16/08.

## 4. Điều kiện DỪNG
Dừng và báo cáo âm ngay khi: cửa 2 null với biên phát hiện < 0,05 ATR **và** cửa 3 cho WR_key
không vượt WR_giả. Lúc đó kết luận đúng phạm vi: *bản số hoá của Key Volume ở M15 không có edge trên
BTC perp sau phí* — không mở rộng thành phát biểu về phương pháp tay của user (cửa 1 mới nói được
điều đó), và không chuyển sang vàng (sàn chi phí khác 1,8 lần).
