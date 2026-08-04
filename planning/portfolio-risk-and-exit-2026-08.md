# Turtle — chính sách rủi ro cấp danh mục + tách kênh thoát (2026-08-04)

Nghiên cứu này KHÔNG thêm chỉ báo, KHÔNG đổi tín hiệu vào lệnh, và KHÔNG phản ứng với chuỗi thua
23/07–02/08. Nó sửa hai thứ ở tầng dưới tín hiệu: **cách phân bổ rủi ro giữa các vị thế tương quan**
và **độ dài kênh thoát của LONG** — tham số quan trọng nhất của hệ mà trước nay bị buộc cứng bằng
kênh vào nên chưa từng được tinh chỉnh.

## Kết quả (2.086 ngày, 2020-11-17 → 2026-08-04, rổ 8 coin, phí thật)

|  | TRƯỚC | SAU |
|---|---:|---:|
| Sharpe (P&L ngày) | 1,36 | **1,65** (+21%) |
| Sortino | 1,41 | 1,66 |
| NET R **quy đổi cùng maxDD** | 1.571 | **2.211** (+41%) |
| CAGR tại maxDD 30% | 43% | **77%** |
| NET/maxDD | 8,15 | 11,47 |
| NET/Ulcer | 17,1 | 23,1 |
| Tháng tệ nhất | −33R | −18R |
| Sharpe era A / B / C | 1,48 / 0,82 / 1,66 | **1,76 / 1,32 / 1,81** |
| Walk-forward 6 cửa sổ | — | SAU thắng **5/6** |
| Risk cùng hướng đỉnh | 32,0 unit | 10,6 unit |
| **maxDD tại risk 0,5%/unit (mức LIVE hiện tại)** | **76%** | **32%** |

NET R thô giảm (1.571 → 807) vì bản mới cố ý chạy đòn bẩy thấp hơn nhiều. Risk/unit là env var tự
do nên **NET R thô không so trực tiếp được**; ba cột so được là Sharpe, NET-quy-đổi-cùng-maxDD, và
CAGR-tại-cùng-maxDD. Cả ba đều tăng.

### NET R tăng bao nhiêu? — phải chốt mức drawdown trước

NET R tỉ lệ THUẬN với risk/unit, mà risk/unit là env var. Nên câu "NET R tăng X%" chỉ có nghĩa sau khi
ghim mức drawdown. Chuẩn hoá bằng maxDD **compounding** (thứ tài khoản thật chịu):

| maxDD ghim | CŨ risk/unit → NET R (CAGR) | MỚI risk/unit → NET R (CAGR) | NET R | CAGR |
|---:|---|---|---:|---:|
| 20% | 0,095% → 1.571 (27%) | 0,304% → 2.581 (48%) | **+64%** | +75% |
| 25% | 0,121% → 1.571 (35%) | 0,386% → 2.570 (62%) | **+64%** | +77% |
| 30% | 0,148% → 1.571 (43%) | 0,471% → 2.560 (77%) | **+63%** | +79% |
| 40% | 0,207% → 1.571 (60%) | 0,650% → 2.541 (110%) | **+62%** | +82% |
| 50% | 0,272% → 1.571 (79%) | 0,849% → 2.522 (145%) | **+61%** | +83% |
| 76% | 0,500% → 1.571 (124%) | 1,531% → 2.472 (215%) | **+57%** | +73% |

**NET R tăng ~60% ở mọi mức DD** — không phụ thuộc điểm vận hành. (Bảng trên dùng maxDD compounding;
nếu chuẩn hoá bảo thủ hơn bằng maxDD trong không gian R cộng dồn thì mức tăng là +41%. Khoảng
**+41% … +64%** tuỳ cách chuẩn hoá; con số thực tế nằm ở đầu trên vì tài khoản compounding.)

**Nếu GIỮ NGUYÊN `TURTLE_RISK_PCT=0,5%` (không đổi gì):** NET R **giảm** 1.571 → 807, CAGR 124% → 82%,
đổi lại maxDD 76% → 32%. Tức là bản mới ở mức risk cũ = ít lợi nhuận hơn nhưng an toàn hơn nhiều.
Muốn hiện thực hoá phần "+60% NET R" thì phải NÂNG `TURTLE_RISK_PCT` — quyết định vận hành của user,
nghiên cứu này không đụng vào (xem trần khuyến nghị trong nghiên cứu đòn bẩy cũ).

Điểm vận hành đáng chú ý: giữ nguyên `TURTLE_RISK_PCT=0.5%`, maxDD lịch sử tụt **76% → 32%** trong khi
CAGR vẫn 82%. Mức 76% trên tài khoản vài trăm USD thực tế là ngưỡng bỏ cuộc, không phải một điểm vận
hành. Muốn đổi lại DD cũ lấy lợi nhuận thì nâng `TURTLE_RISK_PCT` — nhưng đó là env var và là quyết
định của user, nghiên cứu này KHÔNG đụng vào.

## Ba thay đổi

### 1. Chính sách rủi ro theo "heat" cùng hướng (`T.heatDecayK = 4`) — lớp A

Size mỗi unit mới nhân `w = 1/(1 + heat/4)`, `heat` = tổng tỉ trọng unit đang mở **cùng hướng** trên
cả rổ. **Không bao giờ bỏ lệnh**, chỉ nhỏ size.

**Cơ chế (nêu trước khi test):** 8 symbol × 4 unit = 32 unit cùng hướng trên rổ crypto tương quan
~0,85 KHÔNG phải 32 cược độc lập. Rủi ro danh mục dao động 0 → 32 đơn vị, và chính sự dao động đó
làm hỏng tỉ số lợi nhuận/rủi ro (vol targeting — Harvey et al. 2018).

**Đã đo để loại giả thuyết cạnh tranh:** nếu lợi ích đến từ "unit vào lúc sổ đông là unit kém" thì đây
là một bộ lọc trá hình và rất dễ overfit. Kết quả: **Spearman(heat, netR) = −0,025** trên 2.699 unit —
expectancy KHÔNG giảm theo mức đông đúc (thậm chí nhóm heat ≥24 có exp cao nhất, +1,42R). Vậy lợi ích
là **thuần tuý ổn định rủi ro**, không phải né lệnh xấu.

**Vì sao giảm size chứ không đặt trần cứng:** trần cứng bỏ hẳn lệnh → mất luôn những trend lớn. Đo
được: trần cứng 8 unit cho Sharpe 1,32 (thua cả baseline 1,36), trong khi mọi dạng suy giảm mềm đều
thắng. Đây cũng là bài học A1 trong `remediation-plan-2026-08.md` (khử trùng lặp bằng cách bỏ lệnh
làm mất −22% NET).

### 2. Kênh THOÁT của LONG tách khỏi kênh VÀO (`T.longExitDays = 20`) — lớp B

`longMidClose` trước đây tính trên `dcEntry` (15d). Turtle gốc tách hai kênh (vào 20d / ra 10d);
bản trong repo vô tình buộc chúng bằng nhau, nên độ rộng exit chưa bao giờ được tinh chỉnh.

**Cơ chế:** attribution cho thấy **100% lợi nhuận đến từ 316 unit thoát bằng "mid"** (exp +6,01R,
giữ 17,9 ngày), còn 882 unit long thoát bằng hard stop có exp −0,63R. Kênh thoát rộng hơn ⇒ midpoint
thấp hơn ⇒ winner được chạy lâu hơn.

**Plateau 2 chiều** (không phải một điểm): thử entryDays 12/15/18d × ratio exit/entry 1,0…2,5 — MỌI
entryDays đều muốn kênh thoát ≈ 22–25 ngày. Chọn **20d** = cạnh bảo thủ của plateau, và là giá trị duy
nhất cải thiện **cả ba era** (25d cho Sharpe cao hơn nhưng làm era C xấu đi).

### 3. Pyramid ≤3 unit thay vì ≤4 (`T.pyramidMaxUnits = 3`) — lớp A/B

**Cơ chế:** các unit trong CÙNG một symbol có tương quan đúng bằng 1,0 — đây là chỗ lập luận đa dạng
hoá yếu nhất trong cả danh mục. Unit thứ 4 gần như chỉ thêm rủi ro.

Sharpe theo trần unit: 2 ≈ 3 > 4 > 5 > 6 ở **mọi** mức `heatDecayK` từ 2 đến 8. Chọn 3 vì 2 kém hơn 3
rõ ở era gần nhất. NET R gần như không đổi (1.333 vs 1.439) trong khi DD giảm mạnh.

## Kiểm định (`scripts/audit-candidates.ts`)

| | ΔSharpe | CI90 | CI99 | WF | Perturbation | Bỏ 1 coin |
|---|---:|---|---|---:|---:|---|
| chỉ heat-decay | +0,075 | chứa 0 | chứa 0 | 4/6 | **30/30** | 8/8 dương |
| chỉ exit20 | +0,076 | chứa 0 | chứa 0 | 5/6 | 19/30 ⚠️ | 8/8 dương |
| chỉ ≤3 unit | +0,125 | **[0,004; 0,276]** | chứa 0 | 5/6 | 28/30 | 8/8 dương |
| **cả ba (đang ship)** | **+0,253** | **[0,006; 0,484]** | chứa 0 | **5/6** | **29/30** | 8/8 dương |

**Nói thẳng về giới hạn thống kê:** CI90 của bản ship không chứa 0 (P(Δ>0) = 95,5%), nhưng **CI99 thì
có**. Nghiên cứu này đã thử ~100 biến thể nên sau hiệu chỉnh đa kiểm định, đây **chưa phải bằng chứng
ở mức 99%**. Cơ sở để vẫn áp dụng là bề rộng chứng cứ chứ không phải một khoảng tin cậy:

- Chính sách heat cải thiện Sharpe trên **3 vũ trụ coin khác nhau** (U8 1,38→1,48; U22 1,15→1,34;
  U14 tier-2 0,69→0,88).
- Cải thiện trên **4 khung thời gian** (4h/8h/12h/1d).
- Cải thiện với **10 dạng hàm khác nhau** (1/(1+h/k), exp(−h/k), (1−h/k)⁺, 1/√·, theo số symbol,
  theo heat hai chiều…) — kết quả không phụ thuộc dạng hàm ⇒ là cơ chế, không phải fit.
- Kênh thoát tạo plateau trên lưới 2 chiều entryDays × ratio.
- Cả ba era đều tốt lên, kể cả era yếu nhất (B: 0,82 → 1,32).

`chỉ exit20` một mình perturbation 19/30 — mong manh khi để `longExitDays` là số ngày TUYỆT ĐỐI. Tham
số hoá lại theo **tỉ lệ với kênh vào** thì lên 30/30 (`scripts/exp-exit-ratio.ts`). Điều đó nói rằng
đại lượng có ý nghĩa là "kênh thoát rộng hơn kênh vào bao nhiêu", nên nếu sau này đổi `entryDays` thì
**phải đổi `longExitDays` theo cùng tỉ lệ ~1,33×**, đừng giữ nguyên 20.

## Kết quả ÂM (đừng lặp lại)

- **Mở rộng rổ — LOẠI lần hai, lần này bằng metric đúng.** Audit cũ loại vì "pha loãng expectancy/lệnh",
  một metric sai cho danh mục. Chấm lại bằng Sharpe: U22 (8 + toàn bộ 14 coin tier-2) = 1,34 vs U8
  1,48; U14 solo chỉ 0,88. Solo từng coin tier-2 hầu hết Sharpe 0–0,5, LTC/BCH/APT âm. Kết luận cũ
  đúng vì lý do khác. `scripts/exp-portfolio-levers.ts l1`
- **Đa tốc độ (ensemble nhiều lookback) — không đáng.** ×1+×2 cho Sharpe 1,38 vs ×1 một mình 1,36 —
  nằm trong nhiễu, đổi lại gấp đôi số sổ và không thể thực thi trên một tài khoản (SL closePosition).
  Có lợi ích thật nhưng chỉ là **thu hẹp chênh lệch giữa các era**, không nâng mức trung bình.
  `scripts/exp-portfolio-levers.ts l2`
- **Khung thời gian lớn hơn — LOẠI.** 8h/12h/1d đều thua 4h ở era gần nhất (C: 1,66 → 1,25/1,16/0,87)
  dù tốt hơn ở era A. Trend crypto đã nhanh dần. Giữ 4h. `scripts/exp-portfolio-levers.ts l3`
- **Giảm risk cho SHORT — LOẠI, và đây là kết quả quan trọng nhất trong nhóm âm.** Sổ short chiếm 56%
  số unit nhưng chỉ tạo 15% NET (exp +0,153 vs long +1,120), yếu ở cả ba era. Trực giác nói nên cắt.
  Đo thì **ngược lại**: Sharpe giảm ĐƠN ĐIỆU khi hạ tỉ trọng short (1,36 → 1,25 khi bỏ hẳn short; có
  heat-decay thì 1,46 → 1,28). Short có expectancy thấp nhưng **tương quan âm với long** nên là bộ
  phận chịu lực của danh mục. Đừng đụng vào short vì nó "trông tệ" theo từng lệnh.
  `scripts/exp-direction.ts`
- **Lối thoát của SHORT** — chandelier 3,0×ATR vẫn tốt nhất; đổi sang midpoint (1,12) hoặc nới 4,0/5,0
  (1,22/1,12) đều tệ hơn. Xác nhận cấu hình hiện tại.
- **Bước pyramid** 0,25–1,0×ATR: phẳng (Sharpe 1,39–1,41). Giữ 0,5.

## Hạ tầng mới

- `scripts/portfolio-engine.ts` — chạy engine Turtle trên cả rổ **theo thời gian**, cho phép áp ràng
  buộc cấp danh mục tại đúng thời điểm mỗi unit mở. Có `riskMetrics` (Sharpe/Sortino/Ulcer/skew/
  tháng tệ nhất) và `compoundedEquity`/`riskForTargetDD` để chuẩn hoá đòn bẩy.
- `scripts/portfolio-equivalence.ts` — **chốt chặn**: khi không áp ràng buộc, engine danh mục phải
  sinh ra ĐÚNG chuỗi trade của `runTurtle` từng symbol. Chạy trước mọi kết luận.
- `scripts/turtle-live-parity.ts` — **chốt chặn thứ hai**: chạy `TurtleLive` chế độ giấy từng nến một
  và đối chiếu từng unit (symbol/hướng/thời điểm **và tỉ trọng risk**) với engine đã audit. Đây là thứ
  bảo đảm "cái được audit = cái chạy tiền thật".
- `scripts/turtle-attribution.ts` — R được tạo/mất ở đâu (hướng, lý do thoát, thứ tự unit, thời gian
  giữ, symbol, mức đông đúc).

Kèm theo, `TurtleLive.cycle()` đổi từ replay **nối tiếp từng symbol** sang replay **theo thời gian**
(`replay()`). Ở nhịp bình thường (1 nến mới/chu kỳ) hai cách như nhau; khi cold-start hoặc bot offline
nhiều nến thì khác — và vì heat phụ thuộc trạng thái cả rổ, trật tự sai sẽ cho tỉ trọng risk sai. Đây
là lỗi thật đã bị parity test bắt được (lệch 10/26 unit) trước khi sửa.

## Tiêu chí ROLLBACK (viết TRƯỚC khi bật)

Rollback = `git revert` commit này (trả `longExitDays` về 0, `pyramidMaxUnits` về 4, `heatDecayK` về 0).
Bật lại rollback nếu **bất kỳ** điều nào sau xảy ra:

1. Sau 3 tháng live: Sharpe thực (P&L ngày, tính trên journal) < 0 trong khi cùng kỳ bản TRƯỚC
   (chạy song song trên giấy) > 0.
2. maxDD thực vượt 40% equity — bản mới lẽ ra phải giảm DD, nếu tăng là dấu hiệu mô hình sai.
3. Parity test (`scripts/turtle-live-parity.ts`) đỏ sau bất kỳ deploy nào.
4. Số lệnh thực/tháng lệch > 40% so với backtest cùng kỳ.

**Cấm:** chỉnh lại `longExitDays`/`heatDecayK`/`pyramidMaxUnits` sau khi xem kết quả live. Muốn giá
trị khác = ứng viên mới, đăng ký lại từ đầu theo giao thức lớp B trong `remediation-plan-2026-08.md`.

## Tái lập

```bash
./node_modules/.bin/ts-node scripts/portfolio-equivalence.ts 1050   # chốt chặn engine
./node_modules/.bin/ts-node scripts/turtle-live-parity.ts 700       # chốt chặn live
./node_modules/.bin/ts-node scripts/turtle-before-after.ts 2000     # bảng trước/sau
./node_modules/.bin/ts-node scripts/audit-candidates.ts 2000        # bootstrap + WF + perturbation
./node_modules/.bin/ts-node scripts/turtle-attribution.ts 2000      # chẩn đoán
./node_modules/.bin/ts-node scripts/exp-portfolio-caps.ts 2000      # quét chính sách risk
./node_modules/.bin/ts-node scripts/exp-heat-shape.ts 2000          # cơ chế + độc lập dạng hàm
./node_modules/.bin/ts-node scripts/exp-direction.ts 2000           # ngân sách theo hướng (kết quả âm)
./node_modules/.bin/ts-node scripts/exp-portfolio-levers.ts all     # rổ / đa tốc độ / khung TF
./node_modules/.bin/ts-node scripts/exp-exit-pyramid.ts 2000        # kênh thoát, trần unit, bước pyramid
./node_modules/.bin/ts-node scripts/exp-exit-ratio.ts 2000          # tham số hoá theo tỉ lệ
./node_modules/.bin/ts-node scripts/exp-joint-audit.ts 2000         # lưới, chọn trên A+B, niêm phong C
```

## Tài liệu

- Harvey, Hoyle, Rattray, Sargaison, Sim, van Hemert, *The Impact of Volatility Targeting* (2018) —
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538
- Hurst, Ooi, Pedersen, *A Century of Evidence on Trend-Following Investing* —
  https://doi.org/10.3905/jpm.2017.44.1.015
- Bailey, López de Prado, *The Deflated Sharpe Ratio* —
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
