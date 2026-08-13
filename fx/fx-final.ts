/**
 * fx-final.ts — fx-defence.ts sửa lại một kết luận vội của tôi: rổ 10 công cụ có gross R DƯƠNG ở
 * mọi tốc độ (66→187R). Ở tốc độ crypto (s=1) chi phí nuốt hết; từ s≈2 trở đi net dương. Tức edge
 * tồn tại nhưng CHẬM HƠN NHIỀU so với crypto — đúng như mọi chương trình managed-futures.
 *
 * File này chốt bằng cách áp ĐÚNG cửa duyệt đã dùng cho crypto, ở vùng plateau.
 *
 * CHỌN TỐC ĐỘ — luật đặt ra TRƯỚC khi xem thêm số, để không cherry-pick:
 *   Vùng đủ điều kiện = mọi s có Sharpe DƯƠNG ở CẢ BA era trên rổ 10 công cụ, và láng giềng cũng
 *   vậy. Từ fx-defence.ts, vùng đó là s ∈ {2,67; 4; 5,33; 8} — bốn tốc độ LIỀN NHAU.
 *   Chọn s = 4 (vào 60 ngày / thoát 80 ngày). Lý do KHÔNG dựa vào điểm số:
 *     · nằm giữa vùng, không phải mép;
 *     · KHÔNG phải tốc độ tốt nhất ở bất kỳ rổ nào (s=8 cao hơn ở rổ 10 và kim loại; s=2,67 có
 *       Sharpe cao hơn) ⇒ không phải điểm được chọn vì đẹp;
 *     · kênh vào 60 ngày sát System 2 của Turtle gốc (55 ngày) — bộ số do người khác chọn, 40 năm
 *       trước, trên đúng lớp tài sản này.
 *   Cả bốn tốc độ đều được in để thấy lựa chọn này gần như không đổi kết quả.
 *
 * Chạy: npx ts-node fx/fx-final.ts
 */

import { CONFIG } from "../strategy";
import { T } from "../turtle";
import { ExtParams } from "../scripts/portfolio-engine";
import { HEADER, Window, decayH, evaluate, windowOf } from "../scripts/rx-lab";
import { FX7, FX_SHARPE_ADJ, FX_SWAP_PER_8H_PCT, fxBooks, loadUniverse } from "./fx-transfer";
import { atSpeed } from "./fx-speed";
import { BOOK10, ENERGY_METAL, INDICES, METALS_OIL, buyHold, corr, dailySeries, sharpeOf, show } from "./fx-validate";

/** Vùng plateau (từ fx-defence.ts) và lựa chọn cuối. */
const PLATEAU = [2.67, 4, 5.33, 8];
export const CHOSEN_SPEED = 4;
export const FX_SLOW: ExtParams = atSpeed(CHOSEN_SPEED);

const heat = decayH(T.heatDecayK);
const evalAt = (label: string, syms: string[], p: ExtParams, tag: string) =>
  evaluate(label, fxBooks(syms, p, tag), heat, windowOf(loadUniverse(syms), 60 * CHOSEN_SPEED));

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  console.log(`LUẬT CHỐT: hình dạng y hệt bản crypto đang chạy tiền thật, trục thời gian ×${CHOSEN_SPEED}`);
  console.log(`  vào ${FX_SLOW.entryDays}d · thoát ${FX_SLOW.longExitDays}d · short ${FX_SLOW.shortEntryDays}d · ` +
    `EMA${FX_SLOW.trendLen} · ATR${FX_SLOW.atrPeriod} · pyramid ≤${FX_SLOW.pyramidMaxUnits} · heat k=${FX_SLOW.heatDecayK} · giữ tối đa ${FX_SLOW.maxHoldDays}d\n`);

  // ── §1. Cả vùng plateau, trên mọi rổ ──
  console.log("═══ §1. TOÀN VÙNG PLATEAU × MỌI RỔ — chọn s nào cũng ra cùng kết luận ═══");
  for (const [label, syms] of [
    ["rổ triển khai 10 công cụ", BOOK10], ["chỉ số (OOS)", INDICES],
    ["Brent+Đồng (OOS)", ENERGY_METAL], ["kim loại+WTI (in-sample)", METALS_OIL],
    ["ĐỐI CHỨNG: 7 major USD", FX7],
  ] as [string, string[]][]) {
    console.log(`\n─── ${label} ───`);
    console.log(HEADER);
    for (const s of PLATEAU) show(evalAt(`s=${s} (vào ${Math.round(15 * s)}d)`, syms, atSpeed(s), `p${s}`));
  }

  // ── §2. Beta ──
  console.log(`\n═══ §2. CÓ PHẢI BETA MUA-VÀ-GIỮ KHÔNG? (s=${CHOSEN_SPEED}) ═══`);
  for (const [label, syms] of [["rổ 10", BOOK10], ["chỉ số (OOS)", INDICES], ["Brent+Đồng (OOS)", ENERGY_METAL], ["kim loại+WTI", METALS_OIL]] as [string, string[]][]) {
    const r = evalAt(label, syms, FX_SLOW, `b${label}`);
    const w = windowOf(loadUniverse(syms), 60 * CHOSEN_SPEED);
    const bh = buyHold(syms, w.from, w.to);
    const longs = r.res.trades.filter((t) => t.dir === "long");
    const shorts = r.res.trades.filter((t) => t.dir === "short");
    const sum = (a: typeof longs) => a.reduce((s, t) => s + t.netR * t.weight, 0);
    console.log(
      `${label.padEnd(18)} Sharpe CL ${(r.sharpe * FX_SHARPE_ADJ).toFixed(2).padStart(6)}` +
      ` · mua-giữ ${sharpeOf(bh).toFixed(2).padStart(6)} · tương quan ${corr(dailySeries(r.res), bh).toFixed(2).padStart(6)}` +
      ` · LONG ${sum(longs).toFixed(0).padStart(4)}R / SHORT ${sum(shorts).toFixed(0).padStart(4)}R`,
    );
  }

  // ── §3. Holdout ──
  console.log(`\n═══ §3. HOLDOUT THỜI GIAN (kim loại+WTI, lịch sử dài nhất 21 năm) ═══`);
  console.log(HEADER);
  const full = windowOf(loadUniverse(METALS_OIL), 60 * CHOSEN_SPEED);
  const mid = full.from + (full.to - full.from) / 2;
  for (const [label, from, to] of [["nửa đầu ~2005–2015", full.from, mid], ["nửa sau ~2015–2026", mid, full.to]] as [string, number, number][]) {
    const w: Window = { from, to, eras: [0, 1, 2].map((k) => ({ name: "ABC"[k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 })) };
    show(evaluate(label, fxBooks(METALS_OIL, FX_SLOW, `h${from}`), heat, w));
  }

  // ── §4. Nhiễu tham số ──
  console.log(`\n═══ §4. NHIỄU THAM SỐ ±25% (rổ 10, s=${CHOSEN_SPEED}) ═══`);
  console.log(HEADER);
  const base = show(evalAt("chuẩn", BOOK10, FX_SLOW, "base"));
  const knobs: [string, Partial<ExtParams>][] = [
    ["vào 60→45d", { entryDays: 45 }], ["vào 60→75d", { entryDays: 75 }],
    ["thoát 80→60d", { longExitDays: 60 }], ["thoát 80→100d", { longExitDays: 100 }],
    ["short 120→90d", { shortEntryDays: 90 }], ["short 120→150d", { shortEntryDays: 150 }],
    ["chandelier 3,0→2,25", { chandelierMult: 2.25 }], ["chandelier 3,0→3,75", { chandelierMult: 3.75 }],
    ["EMA200→150", { trendLen: 150 }], ["EMA200→250", { trendLen: 250 }],
    ["ATR20→15", { atrPeriod: 15 }], ["ATR20→25", { atrPeriod: 25 }],
    ["heat k4→2", { heatDecayK: 2 }], ["heat k4→6", { heatDecayK: 6 }],
    ["pyramid ≤3→≤1 (tắt)", { pyramidStepAtr: 0 }], ["pyramid ≤3→≤4", { pyramidMaxUnits: 4 }],
  ];
  let win = 0;
  for (const [label, patch] of knobs) {
    const r = evaluate(label, fxBooks(BOOK10, { ...FX_SLOW, ...patch }, label),
      patch.heatDecayK ? decayH(patch.heatDecayK) : heat, windowOf(loadUniverse(BOOK10), 60 * CHOSEN_SPEED));
    show(r, base.net, base.maxDD);
    if (r.net > 0) win++;
  }
  console.log(`→ ${win}/${knobs.length} biến thể vẫn DƯƠNG.`);

  // ── §5. Bỏ từng công cụ ──
  console.log(`\n═══ §5. BỎ TỪNG CÔNG CỤ (rổ 10, s=${CHOSEN_SPEED}) ═══`);
  console.log(HEADER);
  let loWin = 0;
  for (const drop of BOOK10) {
    const syms = BOOK10.filter((s) => s !== drop);
    const r = evalAt(`bỏ ${drop}`, syms, FX_SLOW, `d${drop}`);
    show(r, base.net, base.maxDD);
    if (r.net > 0) loWin++;
  }
  console.log(`→ ${loWin}/${BOOK10.length} vẫn dương khi bỏ bất kỳ công cụ nào.`);

  // ── §6. Theo năm ──
  console.log(`\n═══ §6. NET R THEO NĂM (rổ 10, s=${CHOSEN_SPEED}) ═══`);
  const perYear = new Map<number, number>();
  for (let i = 1; i < base.res.equity.length; i++) {
    const y = new Date(base.res.equity[i].time).getUTCFullYear();
    perYear.set(y, (perYear.get(y) ?? 0) + (base.res.equity[i].mtm - base.res.equity[i - 1].mtm));
  }
  const years = [...perYear.keys()].sort();
  for (const y of years) {
    const v = perYear.get(y)!;
    console.log(`  ${y}  ${v >= 0 ? "+" : ""}${v.toFixed(1).padStart(7)}R  ${"█".repeat(Math.max(0, Math.round(Math.abs(v) / 2)))}${v < 0 ? " (âm)" : ""}`);
  }
  console.log(`  → ${years.filter((y) => perYear.get(y)! > 0).length}/${years.length} năm dương`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
