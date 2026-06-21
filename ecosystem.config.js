/**
 * pm2 ecosystem — chạy cả BOT alert đa-symbol và CHART perpetual trên VM (Oracle).
 *
 * Trên VM:
 *   git pull && npm install
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup        # copy & chạy lệnh in ra để tự bật lại sau reboot
 *   pm2 logs           # xem log cả 2 tiến trình
 *
 * Chart phục vụ tại http://<IP-VM>:3847 (cần mở cổng 3847 ở Security List + firewall OS).
 * Nguồn nến = Binance Futures (fapi) = PERPETUAL; nếu fapi bị chặn 451 sẽ fallback spot
 * mirror — kiểm tra `pm2 logs swing-chart` KHÔNG có dòng "[Fetch] ... thử nguồn kế tiếp".
 */
module.exports = {
  apps: [
    {
      name: "swing-bot",
      script: "npm",
      args: "start",
      autorestart: true,
      max_restarts: 50,
      env: { TZ: "Asia/Ho_Chi_Minh" },
    },
    {
      name: "swing-chart",
      script: "npm",
      args: "run chart",
      autorestart: true,
      max_restarts: 50,
      env: { TZ: "Asia/Ho_Chi_Minh" },
    },
  ],
};
