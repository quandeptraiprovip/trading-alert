/**
 * fx-exotic.ts — khoảng trống cuối cùng trong phạm vi "cặp tiền". Năm bài trước chạy trên G10.
 * Nhưng phần bù carry trong literature FX chủ yếu là hiện tượng của các đồng NGOẠI VI/EM
 * (Lustig–Verdelhan), và đó cũng là các cặp trend mạnh nhất (USDTRY tăng gần như một chiều 22 năm).
 * Nếu không đo, câu "cặp tiền không có edge" là nói quá.
 *
 * ĐỐI TRỌNG PHẢI ĐO CHỨ KHÔNG BÀN: spread của nhóm này rộng gấp 5–15 lần major. Cột
 * `spread/biên độ` quyết định mọi thứ — nó là phần R bị mất ngay khi vào lệnh.
 *
 * Chạy: npx ts-node fx/fx-exotic.ts
 */

import { CONFIG } from "../strategy";
import { FX_SWAP_PER_8H_PCT, loadDaily } from "./fx-transfer";
import { medianSpreadPct } from "./fx-data";
import { sweep } from "./fx-speed";

/** Ba đồng EM lãi suất cao — nơi phần bù carry trong literature nằm. */
export const EXOTICS = ["USDTRY", "USDZAR", "USDMXN"];
/**
 * Mở rộng sang 3 đồng ngoại vi lãi suất THẤP (Bắc Âu + Ba Lan). Đây là phép kiểm quyết định cho
 * câu hỏi: kết quả ngoại vi là hiệu ứng của CẢ LỚP tài sản, hay chỉ là USDTRY? Nếu là hiệu ứng
 * lớp thì 6 công cụ phải cùng đóng góp; nếu chỉ là Thổ Nhĩ Kỳ thì 5 cái còn lại sẽ quanh 0.
 */
export const EXOTICS6 = [...EXOTICS, "USDNOK", "USDSEK", "USDPLN"];

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;

  console.log("═══ CẶP NGOẠI VI / EM — nơi carry và trend FX được cho là mạnh nhất ═══\n");
  console.log("công cụ".padEnd(10) + "nến".padStart(6) + "  khoảng" + "  spread".padStart(9) +
    "  biên độ ngày" + "  spread/biên độ" + "   biến động tổng");
  for (const s of EXOTICS) {
    const d = loadDaily(s);
    const sp = medianSpreadPct(d as never);
    const rng = d.slice(-1000).reduce((a, c) => a + (c.high - c.low) / c.close, 0) / 1000 * 100;
    const total = (d[d.length - 1].close / d[0].close - 1) * 100;
    console.log(
      s.padEnd(10) + String(d.length).padStart(6) +
      `  ${new Date(d[0].openTime).getUTCFullYear()}–${new Date(d[d.length - 1].openTime).getUTCFullYear()}` +
      `  ${sp.toFixed(4)}%`.padStart(9) + `  ${rng.toFixed(2)}%`.padStart(14) +
      `  ${(sp / rng * 100).toFixed(1)}%`.padStart(15) + `   ${total > 0 ? "+" : ""}${total.toFixed(0)}%`,
    );
  }
  console.log("\nSo sánh: major có spread/biên độ 0,8–3,9%. Nhóm này cao gấp mấy lần — mỗi lệnh mất");
  console.log("sẵn phần đó của R trước khi luật kịp đúng hay sai.\n");

  sweep("Ngoại vi USDTRY/ZAR/MXN", EXOTICS);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
