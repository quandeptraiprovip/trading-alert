/**
 * fx-concentration.ts — chạy ĐÚNG hàm `concentration()` của scripts/exp-concentration.ts (bản đã
 * dùng cho hệ crypto đang có tiền thật) lên các rổ FX/hàng hoá, để hai bên so được trên cùng một
 * đường tính chứ không phải bằng cách nhẩm lại từ hai bảng khác nhau.
 *
 * Chạy: npx ts-node fx/fx-concentration.ts
 */

import { CONFIG } from "../strategy";
import { T } from "../turtle";
import { runBooks } from "../scripts/portfolio-engine";
import { decayH, windowOf } from "../scripts/rx-lab";
import { concentration } from "../scripts/exp-concentration";
import { FX7, FX_SWAP_PER_8H_PCT, FX_TURTLE, fxBooks, loadUniverse } from "./fx-transfer";
import { atSpeed } from "./fx-speed";
import { BOOK10, METALS_OIL } from "./fx-validate";
import { EXOTICS6 } from "./fx-exotic";

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  const heat = decayH(T.heatDecayK);

  for (const [label, syms, speed] of [
    ["FX — rổ 10 hàng hoá+chỉ số, trend chậm s=4", BOOK10, 4],
    ["FX — kim loại+WTI (21 năm), trend chậm s=4", METALS_OIL, 4],
    ["FX — 6 đồng ngoại vi, s=5,33", EXOTICS6, 5.33],
    ["FX — 7 major USD, cấu hình production s=1", FX7, 1],
  ] as [string, string[], number][]) {
    const p = speed === 1 ? FX_TURTLE : atSpeed(speed);
    // Math.round bắt buộc: warmup không nguyên (60 × 5,33) làm `windowOf` index vào mảng bằng số lẻ.
    const w = windowOf(loadUniverse(syms), Math.round(60 * Math.max(1, speed)));
    concentration(label, runBooks(fxBooks(syms, p, `c${speed}`), heat), w.from, w.to);
  }

  console.log(
    "\nSo sánh trực tiếp với hệ crypto (scripts/exp-concentration.ts): Turtle CORE8 hồi phục\n" +
    "0,86 drawdown/năm SAU KHI đã bỏ năm tốt nhất. Đó là con số phải đặt cạnh nhau khi cân nhắc\n" +
    "chia vốn — không phải Sharpe, vì Sharpe không cho biết lợi nhuận dồn vào đâu.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
