# Checklist deploy bản Fast mid-exit (2026-08-09)

Ghi lại để lần sau `docker compose up` không phải nhớ lại. Nội dung luật mới:
`planning/fast-exit-channel-2026-08.md`.

## Trạng thái lúc viết note

- Code đã sửa xong trong working tree, **chưa commit, chưa build, chưa deploy**.
- Đã verify: typecheck sạch · `portfolio-equivalence` ✅ · `turtle-live-parity` ✅ · `fast-live-parity` ✅.
- Bot **không chạy trên máy này**: Docker daemon tắt; `trading-runtime/` đứng yên từ 20/07/2026.
- Luật đổi CHỈ ở sleeve Fast (đang shadow). **Turtle không đổi luật** → vị thế Turtle đang mở không
  bị thay đổi này đụng tới.
- Cờ hiện tại trong `.env.local`: `TRADING_ENABLED=true`, `TURTLE_TRADING_ENABLED=true`,
  `BINANCE_TESTNET=false` (mainnet), `FAST_TREND_TRADING_ENABLED=false`, `MEXC_TRADING_ENABLED=false`.

---

## ⚠️ BẪY 1 — state cũ sẽ bắn LỆNH THẬT hàng loạt lúc khởi động

Đây là hành vi có sẵn của bot, **không phải do thay đổi hôm nay**, nhưng nguy hiểm hơn nó.

`turtle-live.ts:744` — `cold = silentColdStart && st.lastBarTime === 0`. Cold-start chỉ chạy IM LẶNG
khi `lastBarTime === 0`. Hiện `turtle-state.json` có `lastBarTime = 20/07/2026`, tức KHÁC 0, nên bot sẽ
replay ~120 nến 4h đã lỡ ở chế độ **không im lặng**: mỗi tín hiệu cũ được đặt **lệnh MARKET thật ở giá
hôm nay** với SL tính theo nến 3 tuần trước, rồi phần lớn bị đóng ngay trong cùng vòng replay.
`openPosition` KHÔNG có guard tuổi nến.

**Cách chặn — cold-start sạch** (mọi `pos` trong state hiện đã là `null` nên không mất gì):

```bash
cd ~/Desktop/alert
mkdir -p .state-backup
cp trading-runtime/*.json .state-backup/ 2>/dev/null
mv trading-runtime/turtle-state.json .state-backup/turtle-state.$(date +%F).json
# SMC đang TẮT (SMC_ENABLED=false) nên bot-state.json không cần đụng.
```

Thiếu file state → `loadState()` tự tạo state mới `lastBarTime = 0` → replay IM LẶNG dựng lại vị thế
trên giấy → `reconcileStartup()` mới đối soát với sàn. Đây đúng là đường cold-start đã thiết kế.

## ⚠️ BẪY 2 — có thể còn một instance khác đang chạy

Forensic 02/08 kết luận state local đóng băng nhưng sàn vẫn có lệnh tới 02/08 ⇒ **bot chạy từ nơi
khác**. Hai instance cùng token Telegram sẽ giành `getUpdates` và đặt lệnh chồng nhau.

**Trước khi start, gõ `/health` trên Telegram.** Có phản hồi = còn instance sống ở đâu đó → phải tắt
nó trước. Đọc dòng `Turtle rule: … fp <hash>` để biết nó đang chạy luật nào.

---

## Trình tự chạy

```bash
# 1. Xác nhận không còn instance nào khác
#    → Telegram: /health   (không ai trả lời = an toàn)

# 2. Xem vị thế thật đang mở trên Binance/MEXC (app sàn hoặc npm run dashboard)

# 3. Cold-start sạch (xem BẪY 1 ở trên)

# 4. Commit + build + chạy
git add -A && git commit -m "Fast: kênh thoát mid-close 20d cho LONG + trần 3 unit"
docker compose up -d --build
docker compose logs -f swing-bot     # tìm "🐢 Turtle" và "⚡ Fast Trend"

# 5. Xác nhận đúng bản mới đang chạy
#    → Telegram: /health
```

Ở bước 5, `/health` phải có **dòng mới `Fast rule: long high-10d/exit mid-close 20d · … fp <hash>`**.
Bản cũ KHÔNG có dòng này — đó là cách xác nhận deploy thành công mà không cần đọc log container.
Dòng `Turtle rule:` phải giữ nguyên fingerprint như trước (Turtle không đổi luật).

## Điều gì xảy ra với vị thế đang mở

| | Hành vi lúc khởi động |
|---|---|
| Turtle — state có, sàn đã flat | `reconcileHeld()` chốt sổ tại SL |
| Turtle — sàn có, state không có | `reconcileStartup()` **ADOPT**: đọc SL từ algo order; thiếu thì đặt SL khẩn cấp 3×ATR; báo Telegram `ADOPT` |
| Turtle — replay và sàn lệch hướng | Chỉ theo dõi GIẤY + cảnh báo Telegram → xử tay |
| Fast | Đang shadow + state rỗng → cold-start im lặng, **không đặt lệnh nào** |
| Fast — LONG đang mở (khi nào bật live) | State cũ không có `midTrail` → khởi tạo `= max(hard SL, midpoint 20d hiện tại)`, KHÔNG nới hard SL. Giá đã dưới midpoint thì thoát ở nến kế — đúng luật mới |

## Rollback

```bash
git revert HEAD && docker compose up -d --build
```

Vì Fast đang shadow, rollback không ảnh hưởng tiền thật. Nếu cần quay lại state cũ thì lấy trong
`.state-backup/` — nhưng nhớ BẪY 1: state cũ càng để lâu thì replay càng dài.

## Ghi chú dọn dẹp (chưa làm, không gấp)

- `docker-compose.yml` còn bind-mount `./fast-trend-state.json` và `./fast-trend-trades.jsonl` —
  vô dụng từ khi Fast chuyển sang `FAST_TREND_DATA_DIR=/app/fast-trend-mexc-runtime`.
- `btc-alert-bot.ts:159` comment còn ghi Turtle "tối đa 4 unit"; thực tế là 3 từ 04/08.
- Ứng viên tiếp theo có bằng chứng nhưng chưa ship: heat-decay k=4 cho Fast (Sharpe 1,46 → 1,58).
