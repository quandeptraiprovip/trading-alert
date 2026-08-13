/**
 * fx-speed.ts — §2 của fx-transfer.ts cho thấy luật Turtle nguyên bản ÂM trên major. Câu hỏi kế
 * tiếp chỉ có hai khả năng, và phải phân biệt được trước khi làm bất cứ gì khác:
 *
 *   (a) CHI PHÍ giết một edge có thật  → gross R dương, net R âm.
 *   (b) KHÔNG CÓ edge ở tốc độ này     → gross R cũng ≈ 0.
 *
 * Nếu là (b) thì mọi việc chỉnh chi phí/thực thi đều vô ích, và câu hỏi đúng là: edge trend của FX
 * (nếu tồn tại) nằm ở TỐC ĐỘ nào?
 *
 * KỶ LUẬT CHỐNG OVERFIT — quét ĐÚNG MỘT biến, khai báo trước khi chạy:
 *   `s` nhân đồng thời MỌI tham số thời gian của luật (entry/exit/short/maxHold/EMA) theo cùng tỉ
 *   lệ, giữ nguyên hình dạng luật production. s ∈ {0,67; 1; 1,33; 2; 2,67; 4; 5,33; 8} — dải này
 *   phủ từ nhanh hơn production tới kênh ~120 ngày (khoảng mà literature time-series momentum
 *   dùng cho tiền tệ). Mọi giá trị đều được IN RA, kể cả xấu.
 *   ATR20 giữ nguyên ở mọi tốc độ: nó là thước đo biến động để tính size, không phải tốc độ tín
 *   hiệu — mọi hệ trend kinh điển đều để cố định.
 *
 * Điều kiện để một tốc độ được coi là ỨNG VIÊN (không phải để kết luận):
 *   dương ở CẢ BA era, và các tốc độ LÁNG GIỀNG cũng dương (plateau, không phải đỉnh nhọn).
 *
 * Chạy: npx ts-node fx/fx-speed.ts
 */

import { CONFIG } from "../strategy";
import { T } from "../turtle";
import { ExtParams, PortfolioResult } from "../scripts/portfolio-engine";
import { HEADER, decayH, evaluate, printRow, windowOf } from "../scripts/rx-lab";
import {
  CROSSES, FX7, FX_SHARPE_ADJ, FX_SWAP_PER_8H_PCT, FX_TURTLE, METALS, fxBooks, loadUniverse,
} from "./fx-transfer";

/** Dải tốc độ — KHAI BÁO TRƯỚC KHI CHẠY. */
export const SPEEDS = [0.67, 1, 1.33, 2, 2.67, 4, 5.33, 8];

/** Cùng một luật, chỉ kéo giãn trục thời gian. */
export function atSpeed(s: number, base: ExtParams = FX_TURTLE): ExtParams {
  return {
    ...base,
    entryDays: Math.round(T.entryDays * s),
    longExitDays: Math.round(T.longExitDays * s),
    shortEntryDays: Math.round(T.shortEntryDays * s),
    maxHoldDays: Math.round(T.maxHoldDays * s),
    trendLen: Math.round(T.trendLen * s),
  };
}

function grossCost(res: PortfolioResult) {
  let g = 0, c = 0;
  for (const t of res.trades) { g += t.grossR * t.weight; c += t.costR * t.weight; }
  return { gross: g, cost: c };
}

function winStats(res: PortfolioResult) {
  const w = res.trades.filter((t) => t.netR > 0);
  const l = res.trades.filter((t) => t.netR <= 0);
  const avg = (a: typeof w) => (a.length ? a.reduce((s, t) => s + t.netR, 0) / a.length : 0);
  const byReason = new Map<string, number>();
  for (const t of res.trades) byReason.set(t.exitReason, (byReason.get(t.exitReason) ?? 0) + 1);
  return {
    wr: res.trades.length ? w.length / res.trades.length : 0,
    avgWin: avg(w), avgLoss: avg(l),
    hold: res.trades.reduce((s, t) => s + t.holdBars, 0) / Math.max(1, res.trades.length),
    reasons: [...byReason.entries()].map(([k, v]) => `${k} ${((v / res.trades.length) * 100).toFixed(0)}%`).join(" "),
  };
}

export function sweep(label: string, symbols: string[]) {
  const w = windowOf(loadUniverse(symbols), 60 * 8);
  const heat = decayH(T.heatDecayK);
  console.log(`\n─── ${label} (${symbols.length} công cụ, cửa sổ ${new Date(w.from).getUTCFullYear()}–${new Date(w.to).getUTCFullYear()}) ───`);
  console.log(HEADER + "   | grossR  costR   WR%  hold");
  for (const s of SPEEDS) {
    const p = atSpeed(s);
    const r = evaluate(`s=${s} (vào ${p.entryDays}d/ra ${p.longExitDays}d)`, fxBooks(symbols, p, `s${s}`), heat, w);
    const gc = grossCost(r.res);
    const ws = winStats(r.res);
    printRow({ ...r, sharpe: r.sharpe * FX_SHARPE_ADJ, eraSharpe: r.eraSharpe.map((x) => x * FX_SHARPE_ADJ) });
    console.log(
      " ".repeat(34) + `   | ${gc.gross.toFixed(0).padStart(6)} ${gc.cost.toFixed(0).padStart(6)}` +
      ` ${(ws.wr * 100).toFixed(0).padStart(4)}% ${ws.hold.toFixed(0).padStart(4)}d  ${ws.reasons}`,
    );
  }
}

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;

  console.log("═══ CHI PHÍ HAY KHÔNG CÓ EDGE? — gross R vs cost R theo TỐC ĐỘ ═══");
  console.log("Nếu gross ≈ 0 ở mọi tốc độ ⇒ FX major không có edge trend, không phải lỗi chi phí.");

  sweep("FX7 — major USD", FX7);
  sweep("FX11 — major + cross", [...FX7, ...CROSSES]);
  sweep("Vàng + Bạc", METALS);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
