/**
 * fx-barphase.ts — bản FX của phép thử LỆCH PHA NẾN (planning/…bar-phase…), món cuối còn thiếu
 * trong cửa duyệt.
 *
 * VÌ SAO Ở ĐÂY NÓ KIỂM CHÍNH KẾT LUẬN ÂM, KHÔNG PHẢI MỘT KẾT LUẬN DƯƠNG: toàn bộ phân tích khung
 * ngày dùng nến của Dukascopy, mốc 00:00 UTC. Nhưng quy ước ngày của ngành FX là đóng lúc 22:00
 * UTC (17:00 New York) — đó mới là nến người dùng thấy trên MT5. Nếu kết quả đảo dấu khi dịch mốc
 * vài giờ thì mọi kết luận trước đó chỉ là hiện vật của một quy ước dữ liệu, chứ không phải tính
 * chất của thị trường.
 *
 * Dựng lại nến ngày TỪ NẾN GIỜ ở 6 mốc đóng khác nhau và chạy lại cùng một luật. Dùng 3 major có
 * nến giờ (đối chứng âm) và vàng (đối chứng dương) — nếu phép thử đúng, vàng phải dương ở mọi mốc
 * còn major phải âm ở mọi mốc.
 *
 * Chạy: npx ts-node fx/fx-barphase.ts
 */

import { CONFIG, Candle } from "../strategy";
import { T } from "../turtle";
import { Book, ExtParams } from "../scripts/portfolio-engine";
import { decayH, evaluate, windowOf } from "../scripts/rx-lab";
import { FX_SHARPE_ADJ, FX_SWAP_PER_8H_PCT, FX_TURTLE, fxCostParams } from "./fx-transfer";
import { aggregateFx, loadH1 } from "./fx-data";
import { atSpeed } from "./fx-speed";

/** Mốc đóng nến ngày, giờ UTC. 22 = quy ước FX (17:00 New York); 0 = quy ước file Dukascopy. */
const PHASES = [0, 4, 8, 12, 18, 22];
const MAJORS = ["EURUSD", "GBPUSD", "USDJPY"];
const heat = decayH(T.heatDecayK);

/** Nến ngày dựng từ H1 ở mốc `hour`, kèm tham số chi phí đo trên chính bộ nến đó. */
function booksAt(symbols: string[], hour: number, p: ExtParams): Book[] {
  return symbols.map((s) => {
    const candles = aggregateFx(loadH1(s), "1d", hour);
    return { key: `${s}@h${hour}`, symbol: s, candles: candles as Candle[], p: { ...p, ...fxCostParams(candles) } };
  });
}

function row(label: string, symbols: string[], p: ExtParams) {
  const cells: string[] = [];
  const nets: number[] = [];
  for (const h of PHASES) {
    const bs = booksAt(symbols, h, p);
    const data = new Map(bs.map((b) => [b.key, b.candles]));
    const r = evaluate(label, bs, heat, windowOf(data, 60 * 8));
    nets.push(r.net);
    cells.push(`${r.net.toFixed(0).padStart(6)}/${(r.sharpe * FX_SHARPE_ADJ).toFixed(2).padStart(5)}`);
  }
  const lo = Math.min(...nets), hi = Math.max(...nets);
  const flip = lo < 0 && hi > 0 ? "  ← ĐỔI DẤU" : "";
  console.log(label.padEnd(26) + cells.join(" ") + `   biên độ ${lo.toFixed(0)}…${hi.toFixed(0)}R${flip}`);
}

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  console.log("═══ LỆCH PHA NẾN — nến ngày dựng lại từ H1 ở 6 mốc đóng khác nhau ═══");
  console.log("Mỗi ô = NET R / Sharpe. Mốc 22h = quy ước FX thật (17:00 New York); 0h = file Dukascopy.\n");
  console.log("luật / rổ".padEnd(26) + PHASES.map((h) => `${h}h UTC`.padStart(12)).join(" "));

  console.log("\n─── 3 major (kỳ vọng: ÂM ở mọi mốc) ───");
  row("tốc độ crypto s=1", MAJORS, FX_TURTLE);
  row("chậm s=4 (vào 60d)", MAJORS, atSpeed(4));

  console.log("\n─── Vàng (đối chứng — kỳ vọng: DƯƠNG ở mọi mốc) ───");
  row("tốc độ crypto s=1", ["XAUUSD"], FX_TURTLE);
  row("chậm s=4 (vào 60d)", ["XAUUSD"], atSpeed(4));

  console.log("\nĐọc bảng: dấu phải GIỮ NGUYÊN qua cả 6 mốc. Nếu đổi dấu thì kết luận tương ứng là");
  console.log("hiện vật của quy ước chia nến chứ không phải tính chất thị trường.");
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
