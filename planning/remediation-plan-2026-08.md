# Kế hoạch khắc phục sau chuỗi thua 23/07–02/08 — kỷ luật chống overfit

Bổ sung cho `trend-method-remediation-research-2026-08.md`. Tài liệu đó trả lời "có nên sửa rule
không" (kết luận: không). Tài liệu này trả lời "vậy thì sửa cái gì, và làm sao để việc sửa không
biến thành overfit".

Số liệu forensic dùng ở đây lấy từ API sàn ngày 2026-08-02 (MEXC history_positions + Binance
income/allOrders/openAlgoOrders), không phải backtest.

## 0. Nguyên tắc: định tuyến sửa lỗi qua kênh không cần fit

Overfit xảy ra khi ta **chọn** một tham số/rule **dựa trên** dữ liệu vừa thua. Cách phòng vệ mạnh
nhất không phải là "test kỹ hơn", mà là **đưa phần lớn việc sửa sang loại thay đổi mà không có gì
để chọn**: kế toán rủi ro, khử trùng lặp, quan sát. Những thay đổi đó đúng vì cơ chế, không vì
chúng cải thiện đường equity quá khứ — nên không có bậc tự do để fit.

| Lớp | Bản chất | Điều kiện áp dụng | Được phép biện minh bằng |
|---|---|---|---|
| **A** | Cấu trúc / risk / vận hành | Áp dụng ngay | Cơ chế. **Cấm** dùng "NET backtest tăng" làm lý do |
| **B** | Thay đổi rule vào/ra lệnh | Đăng ký trước + shadow | Cơ chế **và** bằng chứng đa era + forward |
| **C** | Thêm bộ lọc để né chuỗi thua vừa rồi | Cấm | — |

Hệ quả quan trọng: **các thay đổi lớp A sẽ làm NET thấp hơn backtest** — cố ý. Phải tuyên bố trước
điều này, nếu không 3 tháng nữa sẽ có người nhìn NET giảm rồi "sửa lại cho giống backtest".

---

## Lớp A — sửa cấu trúc (không tuyên bố alpha)

### A0. Xác định instance nào đang thực sự chạy

**Bằng chứng vấn đề:** state/journal trong working copy này đóng băng từ 20/07:
`bot-state.json` lastOpenTime = 20/07, `fast-trend-state.json` còn kẹt vị thế DOT ngày 19–20/07,
`turtle-trades.jsonl` = 0 byte, `fast-trend-trades.jsonl` chỉ 2 dòng (19–20/07). Nhưng sàn có 10 lệnh
Fast thật từ 23/07 đến 02/08 và một stop DOGE được đặt lại lúc 15:01 hôm nay. Hiện `docker ps`,
`pm2 list`, `ps aux` đều trống.

⇒ Bot đang (hoặc vừa) chạy từ **một nơi khác**, không phải thư mục này. Đó là lý do gốc khiến việc
sửa `.env.local` lúc 23:13 01/08 (`FAST_TREND_TRADING_ENABLED=false`) không ngăn được 3 lệnh thật
lúc 03:01 02/08.

**Việc cần làm trước mọi thứ khác:** tìm host/checkout đang chạy, xác nhận **chỉ có một** instance
(hai instance cùng key = nhân đôi lệnh và tranh `getUpdates` Telegram), rồi mới deploy bất kỳ fix nào.
Mọi hạng mục dưới đây vô nghĩa nếu deploy vào sai chỗ.

### A1. Khử trùng lặp lệnh xuyên sàn

**Vấn đề:** `btc-alert-bot.ts:135` ghi rõ *"Chỉ các sleeve cùng Binance account mới loại trừ symbol;
Fast/MEXC là venue độc lập"*. Lý do loại trừ ban đầu là **cơ học** (SL `closePosition` đóng cả symbol
nên 2 lớp không được chung symbol). Khác venue thì không có xung đột cơ học — nên guard bị bỏ. Nhưng
rủi ro **kinh tế** thì vẫn cộng dồn: cùng underlying, cùng hướng, cùng lúc.

Thực tế 23/07–02/08: DOT short trên Binance 27–28/07 *và* MEXC 28/07; SOL và AVAX short trên cả hai
sàn ngày 02/08. Audit đã đo Fast trùng symbol+hướng với Turtle **96,1%** trong 180 ngày.

**Sửa:** truyền `otherHoldsSymbol` cho `FastTrendLive` (hiện chưa có tham số này ở
`btc-alert-bot.ts:206`), kiểm tra theo *underlying + hướng* xuyên sàn. Nếu Turtle đang giữ SOL short
thì Fast bỏ SOL short và báo Telegram.

**Đính chính 02/08 — đã ĐO, và A1 không đáng làm.** Phiên bản đầu của mục này viết "phần alpha bị bỏ
gần bằng 0, vì phần Fast không trùng đo được NET −37,2R". Đó là đọc sai con số: −37,2R là phần A1
**GIỮ LẠI**, không phải phần A1 bỏ đi. Đo trực tiếp (`scripts/dedup-crossvenue-impact.ts`, 1.050
ngày, 8 symbol, cost Binance 0,05% cho Turtle / MEXC 0,08% cho Fast):

| | NET R gộp | maxDD | NET/maxDD |
|---|---:|---:|---:|
| Trước A1 | **+1.279,9R** | 94,6R | 13,53 |
| Sau A1 | **+996,6R** | 68,7R | 14,51 |
| Δ | **−283,3R (−22,1%)** | −25,9R (−27,4%) | +7% |

A1 chặn **89% số vị thế Fast**, và đúng 89% đó mang **+283,3R**; phần giữ lại là **−42,9R**. Tức A1
vứt nhánh có lãi và giữ nhánh lỗ. (Nếu không coi "vào cùng nến" là trùng thì Δ NET = −111,8R / −8,7%,
DD −6,6% — kết quả rất nhạy với giả định này, thêm một lý do không nên dựa vào nó.)

A1 không phải cải thiện alpha, nó là **giảm đòn bẩy**: bỏ ~22% NET để bớt ~27% DD, tỷ lệ NET/DD gần
như đứng yên. Audit gốc đã cảnh báo không được biến attribution overlap thành rule — A1 chính là
phiên bản soi gương của điều bị cấm đó.

**Và câu hỏi đúng hơn: chạy Fast có đáng không?**

| | NET R | maxDD | NET/maxDD |
|---|---:|---:|---:|
| Turtle một mình | +1.039,6R | **62,6R** | **16,60** |
| Turtle + Fast | +1.279,9R | 94,6R | 13,53 |
| Turtle ×1,23 (bằng NET) | +1.279,9R | **77,1R** | **16,60** |

Muốn đạt +1.279,9R thì phóng to Turtle tốn maxDD 77,1R, còn thêm sleeve Fast tốn 94,6R — **Fast bị
trội hoàn toàn**: cùng NET, DD cao hơn 23%, lại còn cõng thêm venue thứ hai, phí taker cao hơn
(0,08% vs 0,05%) và toàn bộ bề mặt vận hành đã sinh ra sự cố 02/08.

**Kết luận:** không dùng A1. Việc đúng là **giữ Fast ở shadow** (`FAST_TREND_TRADING_ENABLED=false`,
đã là mặc định) và nếu muốn thêm exposure thì tăng size Turtle trên sàn rẻ hơn — đó là quyết định
sizing, thuộc [[live-trading]], không phải thay đổi rule.

### A2. Ngân sách rủi ro tính bằng USD trên tổng equity hai sàn

**Vấn đề:** `btc-alert-bot.ts:215` đặt `otherOpenRiskFrac: () => 0` cho Fast — sleeve MEXC hoàn toàn
mù với exposure Binance. Ngoài ra mỗi bên tính `riskFrac` theo equity **riêng** của sàn đó, nên hai
trần 20% (Binance) và 10% (MEXC) là hai ngân sách rời, không ghép được.

**Đính chính 02/08 (phát hiện khi bắt tay implement):** phiên bản đầu của mục này đề xuất "một trần
USD chung đặt đúng bằng mức ngụ ý hiện tại (0,20×eqBinance + 0,10×eqMexc ≈ 71 USD ≈ 13,8% tổng
equity), không đổi mức". **Cách đó vô dụng.** Vì trần chung bằng đúng tổng hai trần con, nó không bao
giờ ràng buộc: hai sleeve cùng đầy vẫn đúng 71 USD và vẫn được cho qua. Tệ hơn, nếu bỏ hai trần con
thì nó **nới lỏng** — Fast được mượn hạn mức Binance đang bỏ trống. Một pool chung đặt tại mức tổng
là no-op hoặc là nới, không có cửa thứ ba.

**Đính chính thứ hai (cùng ngày, khi bắt tay implement lựa chọn "phần dư"):** quy tắc "Binance ưu
tiên, Fast dùng phần dư" **cũng là no-op**, vì `capChung` được đặt bằng đúng tổng hai trần con:

```
capChung = 0,20·eqB + 0,10·eqM
Fast ≤ capChung − binanceĐangDùng,  với binanceĐangDùng ∈ [0 ; 0,20·eqB]
⇒ Fast ≤ 0,10·eqM + (0,20·eqB − binanceĐangDùng) ≥ 0,10·eqM   với MỌI mức tải của Binance
⇒ trần con 0,10·eqM luôn bind trước. Không có trạng thái nào bị siết.
```

Tổng quát: **mọi trần chung ≥ tổng hai trần con đều không ràng buộc.** Không có phiên bản "trung tính
mà vẫn siết". Muốn A2 có tác dụng thì bắt buộc phải **chọn một con số mới thấp hơn 71,4 USD**.

**Và dữ liệu live cho thấy A2 không phải chỗ đau.** Trong chuỗi 23/07–02/08, mỗi vị thế lỗ ~1,5 USDT
trên equity MEXC 321 ≈ 0,46%/vị thế; lúc căng nhất chỉ ~5 vị thế mở ≈ 2,5% equity — **trần 10% chưa
bao giờ chạm**. Cap chỉ có ý nghĩa cho kịch bản đuôi, không giải thích được chuỗi thua này.

**Kết luận A2:** hạ xuống ưu tiên thấp. Việc thực sự khử trùng lặp là **A1** (đã làm). Việc thực sự
kiểm soát tương quan là **A3**, và A3 chỉ có tác dụng khi kèm một mức được chọn tường minh theo khẩu
vị drawdown. Không implement A2 dưới dạng no-op để "trông như đã sửa".

### A3. Trần theo *cùng hướng*, thay cho hàng loạt luật vụn

**Vấn đề:** một nến 4h bắn ra nhiều lệnh cùng hướng: 07:01 28/07 mở XRP+ADA+DOT; 11:01 mở BTC+SOL;
03:01 02/08 mở ETH+SOL+AVAX. Mười "lệnh độc lập" thực chất là **ba** lần cược. Mô phỏng trong audit:
peak từng đạt 62 unit long / 64 unit short cùng hướng (31–32% nominal).

**Sửa:** một ràng buộc duy nhất — trần USD risk cho **tổng các vị thế cùng hướng** (long-book và
short-book tính riêng), áp xuyên hai sàn. Audit đã đo mốc 8 unit/cùng hướng: modeled DD 41,4% → 19,3%,
worst week −9,7% → −4,9%, đổi lại bỏ nhiều lợi nhuận.

**Cách chọn mức mà không fit:** chọn theo **DD chịu được**, không phải theo NET cao nhất. Viết ra
trước: "chấp nhận p95 DD ≤ X%" rồi lấy mức nhỏ nhất thoả — đọc bảng một lần, không quét tìm đỉnh.

**Chú ý chống overfit:** *không* thêm các luật riêng lẻ kiểu "tối đa 2 entry/nến", "tối đa 3 lệnh
alt". Mỗi luật như vậy là một tham số mới fit vào chuỗi thua vừa rồi. Một ràng buộc tổng quát (risk
cùng hướng) đã bao trùm tất cả chúng.

### A4. Journal đủ để forensic + cảnh báo lệch cấu hình

**Vấn đề:** hôm nay phải dựng lại toàn bộ chuỗi thua từ API sàn vì journal nội bộ trống
(`turtle-trades.jsonl` 0 byte). Không có journal thì mọi kết luận về live đều là suy đoán — và suy
đoán chính là môi trường nuôi overfit.

**Sửa:**
- Ghi `stop_move` (giá cũ/mới, nguồn trigger, read-back), fill thực, fee, funding, realised PnL,
  `strategy_version` + git hash trên mỗi bản ghi.
- Verify đường ghi file thật sự hoạt động sau deploy (đọc lại file, không chỉ tin log).
- **Phát hiện lệch cấu hình:** `/health` đã báo cờ hiệu lực (`btc-alert-bot.ts:895–897`) nhưng phải
  có người gõ mới thấy. Thêm heartbeat hằng ngày tự đẩy Telegram: cờ trading của **process đang
  chạy**, git hash, equity hai sàn. Sự cố 02/08 lẽ ra bị phát hiện trong 24h.

**Vì sao không overfit:** thuần quan sát, không đụng quyết định vào lệnh.

---

## Lớp B — thay đổi rule (phải đăng ký trước, chạy shadow)

Tối đa **một** ứng viên tại một thời điểm. Nhiều ứng viên song song trên cùng dữ liệu = selection
bias, và với ~30 biến thể đã thử thì một "winner" p<0,05 là điều gần như chắc chắn xảy ra do may rủi.

### B1. Cooldown 24h sau lệnh thua (Fast) — ứng viên đã đăng ký

Đã ghi trong audit. Bằng chứng backtest: NET +238 đến +251R, DD 49,8–60,8R (so với +243,7R / 66,1R),
nhưng **paired CI90 theo tuần chứa 0** → chưa đủ để gọi là alpha. Live thì mọi lần vào lại đều thua
(DOT 24/07 → vào lại 28/07; SOL 28/07 → vào lại 02/08; AVAX 24/07 → vào lại 02/08) — nhưng n=3, đây
là giai thoại, không phải bằng chứng.

Giữ nguyên: **24h, chỉ sau loss**. Không được đổi sang 18h/36h sau khi xem kết quả.

### B2. Giãn pyramid theo thời gian — ứng viên tiếp theo (chưa chạy)

XRP nhồi 3 unit trong 12 giờ (07:01 @1,0649 → 11:02 @1,0573 → 19:02 @1,0483) rồi stop cả cụm ở
1,0816: **−3,58 USDT, gấp 3 lần một lệnh đơn**. DOGE trên Binance nhồi 3 unit trong 8 giờ. Bước nhồi
0,5×ATR trên khung 4h cho phép dựng full exposure trong ~1 ngày, tức tăng size khi bằng chứng chưa
tăng.

Đăng ký trước: **tối đa 1 add / 24h**, giữ nguyên 0,5×ATR và max 4 unit. Cảnh báo: audit cho thấy
giãn bước theo ATR (0,75–1,5) làm NET giảm gần đơn điệu; nhiều khả năng giãn theo thời gian cũng vậy.
Vì thế phải chấm theo **NET/maxDD**, tuyên bố trước, và chấp nhận kết quả "không dùng".

### Giao thức bắt buộc cho mọi ứng viên lớp B

1. **Đăng ký trước:** commit vào repo rule + tham số + metric + ngưỡng + ngày kết thúc **trước** khi chạy.
2. **Cơ chế trước, số liệu sau:** phải giải thích được *vì sao* nó phải hoạt động, trước khi test.
3. **Plateau:** thắng ở cả vùng lân cận tham số. Thắng tại đúng một điểm = loại (đây chính là lý do
   `max hold 30 ngày` bị loại dù +1.204R).
4. **Ba era đều không xấu đi.** Không chấp nhận "tổng dương nhờ một era".
5. **Paired bootstrap theo tuần, CI90 không chứa 0.** Kèm hiệu chỉnh cho số biến thể đã thử
   (Deflated Sharpe / Bonferroni).
6. **Chi phí thật:** taker + slippage + funding của đúng venue sẽ chạy.
7. **Forward/shadow:** ≥14 ngày **và** ≥20 setup đã đóng, so paper signal với fill thật.
8. **Canary:** live tối đa 1 unit trước khi xét max2/max4.
9. **Tiêu chí rollback viết trước** khi bật, không nghĩ ra sau.
10. **Cấm chỉnh lại tham số sau khi xem live.** Muốn giá trị khác = ứng viên mới, đăng ký lại từ đầu.

---

## Lớp C — cấm làm

- Thêm ADX / efficiency ratio / volume filter / retest / breakeven / time-stop để né chuỗi thua này.
  Chẩn đoán là **thiếu follow-through** (không lệnh nào đạt 1R, MFE trung bình ~0,35R); các bộ lọc
  đó không chữa được nguyên nhân, chỉ khớp với 10 quan sát.
- Đổi `shortEntryDays` vì ADA/AVAX thua. Vùng 25–40 ngày là plateau phẳng (+235 đến +244R) — chọn lại
  điểm trong plateau dựa trên 10 lệnh là fit nhiễu thuần tuý.
- Tắt short, hoặc gate short bằng BTC regime. Đã test: gate short **hại** (`turtle.ts:74`).
- Nới stop. Bác bỏ bằng dữ liệu: nếu giữ tới hôm nay, 7/10 lệnh còn lỗ nặng hơn (ADA −20%, AVAX −8,2%,
  DOT −4,8%). Stop đã cứu tiền.
- Cắt rổ xuống "coin tốt" theo kết quả gần đây. Audit hoán đổi rổ đã cảnh báo pha loãng/lọc hậu nghiệm.
- Vol-target sizing. Đã rớt audit OOS trước đây.

---

## Thứ tự thực hiện

| # | Việc | Lớp | Trạng thái |
|---|---|---|---|
| 1 | Tìm instance đang chạy, đảm bảo duy nhất | A0 | ✅ user xác nhận chạy ở máy khác |
| 2 | Giữ Fast ở shadow (thay cho A1) | A1 | ⬜ đã đo: Fast bị Turtle×1,23 trội hoàn toàn |
| 3 | Heartbeat cờ trading hằng ngày | A4 | ✅ đã code, chờ deploy |
| 4 | Journal đầy đủ + verify ghi được | A4 | ⬜ chặn lớp B |
| 5 | Trần risk cùng hướng (chọn mức theo khẩu vị DD) | A3 | ⬜ cần user chọn mức |
| 6 | Shadow cooldown 24h sau loss | B1 | ⬜ chờ #4 |
| — | ~~Trần USD chung hai sàn~~ | ~~A2~~ | ❌ bỏ — no-op về số học, xem đính chính trên |

Bước 2–4 không cần bằng chứng alpha và không thể overfit. Chỉ sau khi #4 xong — tức là đã có journal
thật để chấm — mới có tư cách chạy lớp B.
