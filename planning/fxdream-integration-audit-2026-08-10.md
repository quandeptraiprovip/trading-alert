# Audit: bản FX Dream đã tích hợp vào bot có đúng phương pháp tác giả không? (2026-08-10)

> **SNAPSHOT LỊCH SỬ — NHIỀU LỖI DƯỚI ĐÂY ĐÃ ĐƯỢC SỬA.** Không dùng line number, trạng thái live
> hay P&L trong file này để mô tả code hiện tại. Kết luận source-aligned và số đo mới nằm tại
> [`fxdream-profit-update-2026-08-11.md`](./fxdream-profit-update-2026-08-11.md) và
> [`fxdream-1y-measurement-2026-08-11.md`](./fxdream-1y-measurement-2026-08-11.md).

## Phạm vi và giới hạn của audit này

Tôi **không xem video** của kênh. Chuẩn đối chiếu là `planning/fxdream-keyvolume-method.md` — bản đặc tả
do chính repo này đúc kết từ 19 transcript `yt-dlp` của [@fxdreamtrading](https://www.youtube.com/@fxdreamtrading),
có trích nguyên văn từng luật. Bản đặc tả đó tự ghi rằng **7 video liên quan nhất là members-only và
chưa truy cập được** (§14, dòng 595–598), nên phần đó vẫn là lỗ hổng đã biết — không audit được.

Kết luận ngắn: **chưa đúng.** Bộ xương thì giống, nhưng đường chạy live là một engine KHÁC, chưa từng
qua audit, và nó lệch phương pháp ở đúng những chỗ định lượng được.

---

## 1. Phát hiện quan trọng nhất: bot đang gọi engine CHƯA từng được audit

| | file | trạng thái git | có trong tsconfig? | đã audit? |
|---|---|---|---|---|
| Engine **đang chạy live** | `fxdream-alert.ts` → `fxdream-research/strategy-engine-v2.ts` | **untracked (`??`)** | alert: có · engine-v2: **KHÔNG** | **chưa** |
| Engine **đã audit 2 vòng** | `key-volume.ts` | committed, sạch | có | §13 + §14, đối chiếu 20 luật |

`/usr/bin/grep -ni "key-volume\|keyVolume" btc-alert-bot.ts` → **không có kết quả**. Nghĩa là toàn bộ
phần sửa của hai vòng audit (`entryTrigger "candle-pattern"`, `stopMode`, `minKeyReactions`,
`targetSourceTfs`, `requireFollowThrough`, `reentryMode`, ba câu hỏi Daily `#31`) nằm trong một file
**bot không bao giờ gọi tới**.

Và §14.6 đã chốt: *"Quyết định vận hành không đổi: vẫn không bật Key Volume live trên rổ crypto này"*.
Bản tích hợp mới **bật nó lên vô điều kiện**: `btc-alert-bot.ts:1259-1262` gọi `runFXDreamAlertScanner()`
lúc khởi động và mỗi 15 phút, **không có cờ env nào** — khác mọi chiến lược còn lại trong repo.

### Hệ quả 1a — engine-v2 không hề được typecheck

`tsconfig.json` `include: ["*.ts", "app/**/*.ts", ...]`. Pattern `*.ts` chỉ khớp file ở **gốc**, nên
`fxdream-research/**` nằm ngoài. Cộng thêm `"ts-node": { "transpileOnly": true }` ⇒ **không typecheck cả
lúc build lẫn lúc chạy**. Bằng chứng lỗi đã lọt qua:

- `fxdream-research/run-v2-study.ts:274` đọc `params.requireDailyExpansion` và `dailyCtx.isExpansion` —
  **hai field không tồn tại** trên `FXDreamV2Params` / `DailyContextV2` hiện tại. Ở runtime chúng là
  `undefined` ⇒ `if (undefined && ...)` ⇒ **gate bị bỏ qua âm thầm**, không crash.
- Ngược lại, study **không bao giờ kiểm `dailyCtx.trapGatePassed`**, trong khi live path *có* kiểm
  (`fxdream-alert.ts:120`).
- `fxdream-alert.ts:104` gọi `fetchKlinesPaged(symbol, "5m", totalBars5m, "futures")` — hàm chỉ nhận
  **3 tham số**. Đây là lỗi duy nhất của repo lọt vào `tsc --noEmit` hiện tại (không đổi hành vi vì
  `fetchKlinesPaged` mặc định đã là futures, nhưng nó làm typecheck đỏ).

⇒ **Mọi con số V2 trong `fxdream-research/RESULTS.md` được sinh bởi bộ luật KHÁC bộ luật đang chạy live.
Đường chạy live chưa từng được backtest ở dạng hiện tại.**

### Hệ quả 1b — backtest V2 còn có lookahead

`run-v2-study.ts:37` tính **toàn bộ** key một lần trên cả chuỗi H1, rồi vòng lặp chỉ lọc
`k.originTime <= nowTime` (dòng 278). Nhưng `findKeyVolumeLevelsV2` xác thực key bằng
`futureWindow = candlesH1.slice(i+1, i+20)` — **20 nến H1 SAU** nó. Tức key được dùng từ chính thời điểm
nó xuất hiện, trong khi bằng chứng "đã có phản ứng" lấy từ 20 giờ tương lai. Live không bị (dữ liệu
dừng ở hiện tại, `futureWindow.length < 3 → continue`), nhưng backtest thì lạc quan.

---

## 2. Đối chiếu từng luật với nguồn — có đo bằng số

Chạy `./node_modules/.bin/ts-node fxdream-research/audit-live-path.ts 30` (BTC/SOL/XRP/DOGE, 30 ngày —
đúng lượng dữ liệu live scanner nạp).

| # | Luật của tác giả (nguồn) | engine-v2 làm gì | Kết luận |
|---|---|---|---|
| 1 | Key = **một điểm** có vol lớn **và giá đã phản ứng thật** (§2) | Xác thực phản ứng + đếm reaction tại **`close`**, nhưng **công bố key tại `low`/`high`** | ❌ **364/571 key (63,7%) công bố lệch >0,5×ATR khỏi giá được xác thực, lệch TB 1,18×ATR** |
| 2 | Ba câu hỏi Daily `#31`: low nến xanh **cuối cùng** (a) chưa bị **đóng qua**, (b) **đã bị thọt râu** (§14.2) | So **hai nến ngày cuối**; pass nếu thọt râu **HOẶC** `close > ante.high` | ❌ **64,1% lượt pass là nhờ nhánh "đóng vượt đỉnh/đáy" = breakout, không phải trap**. Điều kiện "chưa bị đóng qua" **không có** |
| 3 | Hợp lưu **≥ 2–3 khung** trên cùng mức giá (§5) | `candlesH4` là tham số **không bao giờ được đọc**; `isConfluent: true` hard-code | ❌ **không có hợp lưu H4**. Docstring quảng cáo "H4 + H1 Confluence… Displacement ≥ 1.2 ATR" trong khi code dùng 0,8×ATR trên H1 |
| 4 | **Sweep/stop-hunt rồi mới vào** (§50, §26, +50R) | `low <= key*1.002` / `high >= key*0.998`, dung sai **0,2% cố định** | ⚠️ **83,0% có xuyên qua key thật** — phần lớn đúng. Nhưng **17,0% chỉ chạm gần (không sweep)** và **18,6% nến xác nhận không lấy lại được key** |
| 5 | Ba mô hình nến: **nhấn chìm, in3, 3-bar reversal** (`Q&A003`, §50) | Engulfing = `isGreen && close > prev.open` — **không xét `open` hiện tại, không đòi nến trước ngược màu** | ❌ trong trend gần như nến xanh nào cũng đạt; đây lại là nhánh **kiểm đầu tiên** nên nó chiếm hết nhãn pattern |
| 6 | **"SL ngắn nhất có thể"**, đặt sau OB/key (§7, §13.2) | `minStopPct = 0.8%` **NỚI RỘNG** stop | ❌ **7.976/12.401 plan (64,3%) bị nới stop lên sàn 0,8%** — ngược hẳn tinh thần. Ví dụ +50R của tác giả có SL **0,08%** (RESULTS.md), tức chặt hơn **10×** |
| 7 | **Dư địa** phía trước còn nhiều (§5, §13.1) | Nếu `structR < minRR` → gán `target = entry ± riskDist*minRR` ⇒ `targetR === minRR` ⇒ `targetR < minRR` **không bao giờ đúng**. Nếu **không có** swing H4 đối diện → target = `maxTargetR` **15R** | ❌ **`minRR` là dead code**; và trường hợp *không còn dư địa nào* lại nhận target **tham vọng nhất** |
| 8 | **"Không chạy liền là bỏ"** (§7, §13.3 — 3 nguồn độc lập) | `requireFollowThrough`, `followThroughBars` xuất hiện **đúng 2 lần** trong engine-v2 (khai báo interface + config), **không nơi nào đọc**. Card Telegram cũng không nhắc | ❌ thiếu — dù §14.4 xếp luật này là "✅ đã bật" cho `key-volume.ts` |
| 9 | Chốt 1/2 tại TP1, dời SL, gồng phần còn lại (§7) | `partialAtR`/`partialFraction`/`trailMode` cũng chỉ 2 lần (dead trong engine). Card ghi **"Target 1 (1.5R – Dời BE)"** còn config test là **2,0R** | ⚠️ live là alert cho người bấm nên chấp nhận được, nhưng **số trên card lệch số đã test** |
| 10 | Trail theo swing | `trailMode: "h1-swing"`, nhưng `run-v2-study.ts` chỉ cài nhánh `=== "h4-swing"` | ❌ **trail không chạy ngay cả trong backtest**. §13.6 đã đo trail là đóng góp **dương** |
| 11 | Trình tự **Tuần → Ngày → M15 → M5**, "không được đảo thứ tự" (§4) | Không có khung **Tuần**. Không có **M5 volume profile HVN/LVN** (§4 Bước 4). Không có Mod3 / Inside bar | ❌ thiếu 2 trong 4 bước |
| 12 | Chọn lọc, "thiếu một yếu tố là không vào" (§5) — tác giả ~**60 kèo/năm** (RESULTS.md) | — | ❌ xem §3 |

Hai điều tôi **kiểm rồi và KHÔNG phải lỗi** (nói cho công bằng):
- `minKeyReactions = 1` — có yêu cầu lịch sử phản ứng, **đúng** §13.4 (dù đếm ở sai giá, xem #1).
- Bias Daily = `neutral` cho phép cả hai hướng: sau warmup xảy ra **0 lần**; 2.508 lượt là do cửa sổ
  30 ngày chưa đủ nến ngày, không phải lỗi luật.

---

## 3. Sai lệch có tính quyết định: TẦN SUẤT

| | |
|---|---|
| nến M15 (×4 coin) qua được gate Daily | 5.475 |
| nến có ≥1 sự kiện SFP ⇒ alert sẽ bắn | **2.710 = 49,5%** |
| quy đổi nếu chạy đúng như đã wire (mỗi 15 phút) | **~90 alert/ngày ≈ 33.000 alert/năm** |
| tác giả (RESULTS.md, §5, §6) | **~60 kèo/năm**, "thiếu một yếu tố là không vào" |

Sai khoảng **400×**. Đây không phải chuyện tinh chỉnh tham số — nó nói rằng bộ lọc chọn lọc nhất của
phương pháp (kinh nghiệm vẽ key + macro + "đủ mọi yếu tố") chưa được thay bằng bất cứ thứ gì tương đương.

Bằng chứng nó đã chạy thật: `fxdream-alert-state.json` ghi lúc **10/08 15:10**, có đúng **1** alert
(`XRPUSDT-short`, tín hiệu 07:45Z, gửi 08:10Z) — một lần quét là ra ngay một alert. `sentAlerts` **không
bao giờ được prune** ⇒ phình vô hạn.

---

## 4. Việc nên làm, theo thứ tự

1. **Đặt cờ env cho scanner** (`FXDREAM_ALERT_ENABLED`, mặc định `false`). Hiện nó chạy vô điều kiện,
   trái với quyết định đã ghi ở §14.6 và trái quy ước của mọi sleeve khác.
2. **Chọn MỘT engine.** Hoặc trỏ alert vào pipeline `key-volume.ts` đã audit, hoặc nâng engine-v2 lên
   đúng bộ luật đó. Duy trì hai engine Key Volume phân kỳ là cách chắc chắn nhất để mọi audit hết giá trị.
3. **Thêm `fxdream-research/**` (và `scripts/**`) vào `tsconfig.include`.** Chỉ việc này đã bắt được
   `requireDailyExpansion`/`isExpansion`. Sửa luôn `fetchKlinesPaged` 4 tham số.
4. **Sửa 4 lỗi code-level:** (a) xác thực và công bố key ở **cùng một giá**; (b) engulfing đúng định
   nghĩa; (c) `minRR` dead code + nhánh "không có dư địa → 15R"; (d) `trailMode` trỏ tới nhánh không tồn tại.
5. **Backtest lại đúng đường chạy live** trước khi tin bất kỳ con số nào — study hiện tại chạy luật khác
   và có lookahead 20 giờ.
6. **Quyết định rõ về sàn stop 0,8%.** §13.7/§14.6 đã xác định ràng buộc thật là **ma sát venue**: chuỗi
   tín hiệu cần `< 0,055%` khứ hồi, Binance perp là `0,140%`. Nới stop lên 0,8% chỉ **che** ràng buộc đó
   (và biến phương pháp thành thứ khác), không giải quyết nó. Muốn chạy đúng phương pháp thì phải đổi
   venue (Vàng/Forex `0,01–0,02%`) hoặc vào bằng maker thật.
7. **Commit hoặc bỏ.** `fxdream-alert.ts` + `fxdream-research/` đang **untracked** mà đã chạy trong bot.

## Tái lập

```bash
./node_modules/.bin/ts-node fxdream-research/audit-live-path.ts 30
/usr/bin/grep -ni "key-volume\|keyVolume" btc-alert-bot.ts     # → rỗng: engine đã audit KHÔNG được gọi
./node_modules/.bin/tsc --noEmit -p tsconfig.json              # → fxdream-alert.ts(104,65)
git status --short fxdream-alert.ts fxdream-research/          # → ?? (untracked)
```
