/**
 * fx-defence.ts — fx-validate.ts kết luận âm. Trước khi chốt, phải bác cho hết hai lời bào chữa
 * chuẩn mà bất kỳ ai (kể cả tôi) cũng sẽ đưa ra khi không thích một kết quả âm:
 *
 *   BÀO CHỮA 1 — "chi phí mô hình quá nặng".  Kiểm bằng cách in GROSS R. Nếu gross cũng ≈ 0 thì
 *                 không có gì để chi phí giết, và mọi bàn luận về broker rẻ hơn đều vô nghĩa.
 *   BÀO CHỮA 2 — "sai tốc độ, chỉ cần chậm/nhanh hơn".  Kiểm bằng chính dải tốc độ đã khai báo
 *                 trước ở fx-speed.ts, chạy trên các rổ OOS. Nếu KHÔNG tốc độ nào dương thì
 *                 không phải vấn đề hiệu chỉnh.
 *
 * Chạy: npx ts-node fx/fx-defence.ts
 */

import { CONFIG } from "../strategy";
import { FX_SWAP_PER_8H_PCT } from "./fx-transfer";
import { sweep } from "./fx-speed";
import { BOOK10, ENERGY_METAL, INDICES, METALS_OIL } from "./fx-validate";

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  console.log("═══ BÁC HAI LỜI BÀO CHỮA: gross R (chi phí) × dải tốc độ (hiệu chỉnh) ═══");
  console.log("Đọc cột grossR: nếu ≈ 0 hoặc âm ở mọi tốc độ ⇒ không có edge để mà cứu.\n");
  sweep("Chỉ số — OOS về loại công cụ", INDICES);
  sweep("Brent + Đồng — OOS về loại công cụ", ENERGY_METAL);
  sweep("Rổ triển khai 10 công cụ", BOOK10);
  sweep("Kim loại + WTI — rổ CÓ thiên lệch chọn (đối chiếu)", METALS_OIL);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
