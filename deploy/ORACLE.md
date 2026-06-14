# Deploy BTC Alert Bot lên Oracle Cloud Always Free (24/7, miễn phí)

## 0. Đăng ký Oracle Cloud
- Vào https://www.oracle.com/cloud/free/ → **Start for free**.
- Cần email + **số thẻ để xác minh** (charge thử ~$1 rồi hoàn lại; **không tính phí** cho Always Free).
- Chọn **Home Region** gần bạn (vd: Singapore / Tokyo) — không đổi được sau này.

## 1. Tạo VM (Instance)
1. Console → **Compute → Instances → Create instance**.
2. **Image**: Ubuntu 22.04 (hoặc 24.04).
3. **Shape**: chọn **Always Free eligible**:
   - Khuyến nghị: **Ampere A1 (ARM)** — 1 OCPU + 6 GB RAM (free tới 4 OCPU/24GB).
   - Hoặc **VM.Standard.E2.1.Micro** (AMD, 1GB) cũng đủ cho bot này.
4. **SSH keys**: tải **Save private key** về máy (file `.key`/`.pem`).
5. **Create**. Đợi state = **Running**, ghi lại **Public IP**.

## 2. Mở quyền & SSH vào VM
```bash
chmod 400 ~/Downloads/ssh-key.key
ssh -i ~/Downloads/ssh-key.key ubuntu@<PUBLIC_IP>
```
> Bot **không cần mở port** (chỉ gọi ra Binance + Telegram), nên không phải chỉnh firewall.

## 3. Clone repo & chạy script (1 lệnh)
```bash
git clone https://github.com/quandeptraiprovip/trading-alert.git
cd trading-alert
bash deploy/oracle-setup.sh
```
Script sẽ hỏi `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, tự set `BINANCE_PUBLIC=1`,
rồi chạy bot bằng **pm2** (tự sống lại khi crash / reboot).

> Nếu pm2 in ra một dòng `sudo env PATH=...`, copy chạy đúng 1 lần để bot tự bật khi VM reboot.

## 4. Kiểm tra
```bash
pm2 logs btc-bot     # log realtime — sẽ thấy "[WS] ✅ Đã kết nối ... (Spot .vision)"
pm2 status
```
Telegram sẽ nhận tin nhắn startup nếu token/chat id đúng.

## Cập nhật code về sau
```bash
cd trading-alert && git pull && npm install --include=dev && pm2 restart btc-bot
```

## Lưu ý quan trọng
- **BINANCE_PUBLIC=1 là bắt buộc** trên cloud — thiếu nó Binance Futures trả lỗi 451 và bot chết.
- Oracle có thể "đòi lại" VM Always Free nếu **idle quá lâu** (chủ yếu với ARM khi thiếu capacity). Bot chạy liên tục nên thường không sao; nếu lo, dùng shape AMD Micro.
