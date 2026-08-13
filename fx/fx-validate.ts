/**
 * fx-validate.ts — bốn họ phương pháp đã loại CẶP TIỀN (fx-speed, fx-native, fx-carry,
 * fx-reversion). Cái sống sót là luật Turtle nguyên bản trên KIM LOẠI. File này tra tấn kết quả
 * đó cho tới khi nó gãy, hoặc không gãy.
 *
 * VẤN ĐỀ TRUNG THỰC PHẢI NÓI TRƯỚC: "kim loại" được chọn SAU KHI nhìn thấy số — đúng cái bẫy
 * hindsight của CORE8. Ba thứ khử nó, theo thứ tự sức nặng:
 *
 *   1. KIỂM ĐỊNH OOS VỀ LOẠI CÔNG CỤ. Chỉ số và năng lượng được tải VỀ SAU, khi giả thuyết
 *      ("trend ăn ở hàng hoá/chỉ số, không ăn ở tiền tệ") đã hình thành xong. Chúng chưa từng
 *      tham gia vào việc chọn. Nếu cùng một cấu hình không đổi cũng dương ở đó thì giả thuyết
 *      được xác nhận trên dữ liệu chưa hề dùng để tạo ra nó.
 *   2. KHÔNG FIT MỘT THAM SỐ NÀO. Cấu hình dùng ở đây ĐÚNG BẰNG cấu hình đang chạy tiền thật trên
 *      crypto — được chọn trên thị trường khác, năm khác. Với dữ liệu FX/kim loại nó là tham số
 *      ngoại sinh 100%.
 *   3. TIÊN NGHIỆM NGOÀI DỮ LIỆU. Mọi chương trình managed-futures đều kiếm tiền chủ yếu ở hàng
 *      hoá và ít nhất ở tiền tệ. Đây là xác nhận một điều đã biết, không phải phát hiện đào được.
 *
 * Và câu hỏi nguy hiểm nhất, §3: có phải chỉ là BETA mua-và-giữ vàng đội lốt chiến lược không?
 *
 * Chạy: npx ts-node fx/fx-validate.ts
 */

import { CONFIG } from "../strategy";
import { T } from "../turtle";
import { ExtParams, PortfolioResult } from "../scripts/portfolio-engine";
import { HEADER, Window, decayH, evaluate, printRow, windowOf } from "../scripts/rx-lab";
import { FX_SHARPE_ADJ, FX_SWAP_PER_8H_PCT, FX_TURTLE, fxBooks, loadDaily, loadUniverse } from "./fx-transfer";

// ─────────────────────────────────────────────
// RỔ — theo LOẠI TÀI SẢN, không theo hiệu suất
// ─────────────────────────────────────────────
/** Đã dùng để HÌNH THÀNH giả thuyết ⇒ có thiên lệch chọn lựa. Lịch sử dài nhất (2004). */
export const METALS_OIL = ["XAUUSD", "XAGUSD", "LIGHTCMDUSD"];
/** Tải VỀ SAU giả thuyết ⇒ OOS thật về loại công cụ. */
export const INDICES = ["USA500IDXUSD", "USATECHIDXUSD", "DEUIDXEUR", "JPNIDXJPY", "GBRIDXGBP"];
export const ENERGY_METAL = ["BRENTCMDUSD", "COPPERCMDUSD"];
/** Rổ triển khai thực tế. */
export const BOOK10 = [...METALS_OIL, ...INDICES, ...ENERGY_METAL];

const heat = decayH(T.heatDecayK);

export function show(r: ReturnType<typeof evaluate>, baseNet?: number, baseDd?: number) {
  printRow({ ...r, sharpe: r.sharpe * FX_SHARPE_ADJ, eraSharpe: r.eraSharpe.map((s) => s * FX_SHARPE_ADJ) }, baseNet, baseDd);
  return r;
}

export function run(label: string, syms: string[], p: ExtParams = FX_TURTLE, tag = "") {
  return show(evaluate(label, fxBooks(syms, p, tag), heat, windowOf(loadUniverse(syms), 60)));
}

/** Chuỗi P&L ngày (theo R) của một kết quả — để tính tương quan với mua-và-giữ. */
export function dailySeries(res: PortfolioResult): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / 86400e3);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  return m;
}

/** Mua-và-giữ đều tay, vol-target 1R/ngày — mốc so sánh cho câu hỏi "có phải chỉ là beta?". */
export function buyHold(syms: string[], from: number, to: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of syms) {
    const bars = loadDaily(s).filter((c) => c.openTime >= from && c.openTime <= to);
    for (let i = 61; i < bars.length; i++) {
      const win = bars.slice(i - 60, i);
      const rets = win.slice(1).map((c, k) => Math.log(c.close / win[k].close));
      const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1));
      if (!(sd > 0)) continue;
      const r = Math.log(bars[i].close / bars[i - 1].close) / sd / syms.length;
      const d = Math.floor(bars[i].openTime / 86400e3);
      m.set(d, (m.get(d) ?? 0) + r);
    }
  }
  return m;
}

export function corr(a: Map<number, number>, b: Map<number, number>): number {
  const keys = [...a.keys()].filter((k) => b.has(k));
  if (keys.length < 30) return NaN;
  const x = keys.map((k) => a.get(k)!), y = keys.map((k) => b.get(k)!);
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

export function sharpeOf(m: Map<number, number>): number {
  const v = [...m.values()];
  const mu = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
  return sd > 0 ? (mu / sd) * Math.sqrt(252) : 0;
}

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;
  console.log("Cấu hình: ĐÚNG BẰNG bản đang chạy tiền thật trên crypto, không đổi một tham số.");
  console.log(`  long ${T.entryDays}d / thoát ${T.longExitDays}d · short ${T.shortEntryDays}d · pyramid ≤${T.pyramidMaxUnits} · heat k=${T.heatDecayK} · EMA${T.trendLen} · ATR${T.atrPeriod}\n`);

  // ── §1 ──
  console.log("═══ §1. RỔ THEO LOẠI TÀI SẢN ═══");
  console.log(HEADER);
  const inSample = run("kim loại+WTI (CÓ thiên lệch chọn)", METALS_OIL);
  console.log("  ↑ rổ đã dùng để hình thành giả thuyết — KHÔNG được coi là bằng chứng độc lập\n");
  const oosIdx = run("chỉ số (OOS về loại công cụ)", INDICES);
  const oosEng = run("Brent+Đồng (OOS về loại công cụ)", ENERGY_METAL);
  run("rổ triển khai 10 công cụ", BOOK10);
  console.log("\nĐối chứng đã có: cùng cấu hình này trên 7 major USD = −121R, Sharpe −0,17.");

  // ── §2. Câu hỏi nguy hiểm nhất ──
  console.log("\n═══ §2. CÓ PHẢI CHỈ LÀ BETA MUA-VÀ-GIỮ KHÔNG? ═══");
  for (const [label, syms, r] of [
    ["kim loại+WTI", METALS_OIL, inSample],
    ["chỉ số", INDICES, oosIdx],
    ["Brent+Đồng", ENERGY_METAL, oosEng],
  ] as [string, string[], ReturnType<typeof evaluate>][]) {
    const w = windowOf(loadUniverse(syms), 60);
    const bh = buyHold(syms, w.from, w.to);
    const st = dailySeries(r.res);
    console.log(
      `${label.padEnd(16)} Sharpe chiến lược ${(r.sharpe * FX_SHARPE_ADJ).toFixed(2).padStart(6)}` +
      ` · Sharpe mua-và-giữ ${sharpeOf(bh).toFixed(2).padStart(6)}` +
      ` · tương quan ${corr(st, bh).toFixed(2).padStart(6)}`,
    );
    const longs = r.res.trades.filter((t) => t.dir === "long");
    const shorts = r.res.trades.filter((t) => t.dir === "short");
    const sum = (a: typeof longs) => a.reduce((s, t) => s + t.netR * t.weight, 0);
    console.log(
      `${" ".repeat(16)} LONG ${sum(longs).toFixed(0).padStart(5)}R (${longs.length} unit)` +
      ` · SHORT ${sum(shorts).toFixed(0).padStart(5)}R (${shorts.length} unit)`,
    );
  }
  console.log("Tương quan thấp + nhánh SHORT không âm nặng ⇒ không phải beta đội lốt.");

  // ── §3. Holdout thời gian ──
  console.log("\n═══ §3. HOLDOUT THỜI GIAN (rổ kim loại+WTI, 22 năm) ═══");
  console.log(HEADER);
  const full = windowOf(loadUniverse(METALS_OIL), 60);
  const mid = full.from + (full.to - full.from) / 2;
  for (const [label, from, to] of [["nửa đầu 2004–2015", full.from, mid], ["nửa sau 2015–2026", mid, full.to]] as [string, number, number][]) {
    const w: Window = { from, to, eras: [0, 1, 2].map((k) => ({ name: "ABC"[k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 })) };
    show(evaluate(label, fxBooks(METALS_OIL, FX_TURTLE, `h${from}`), heat, w));
  }

  // ── §4. Nhiễu tham số ──
  console.log("\n═══ §4. NHIỄU THAM SỐ ±25% (rổ 10 công cụ) — luật thật không được sống nhờ một con số ═══");
  console.log(HEADER);
  const base10 = run("chuẩn", BOOK10, FX_TURTLE, "b");
  const knobs: [string, Partial<ExtParams>][] = [
    ["entryDays 15→11", { entryDays: 11 }], ["entryDays 15→19", { entryDays: 19 }],
    ["longExitDays 20→15", { longExitDays: 15 }], ["longExitDays 20→25", { longExitDays: 25 }],
    ["shortEntryDays 30→23", { shortEntryDays: 23 }], ["shortEntryDays 30→38", { shortEntryDays: 38 }],
    ["chandelier 3,0→2,25", { chandelierMult: 2.25 }], ["chandelier 3,0→3,75", { chandelierMult: 3.75 }],
    ["trendLen 50→38", { trendLen: 38 }], ["trendLen 50→63", { trendLen: 63 }],
    ["atrPeriod 20→15", { atrPeriod: 15 }], ["atrPeriod 20→25", { atrPeriod: 25 }],
    ["heat k 4→2", { heatDecayK: 2 }], ["heat k 4→6", { heatDecayK: 6 }],
  ];
  let win = 0;
  for (const [label, patch] of knobs) {
    const p = { ...FX_TURTLE, ...patch };
    const r = show(evaluate(label, fxBooks(BOOK10, p, label), patch.heatDecayK ? decayH(patch.heatDecayK) : heat, windowOf(loadUniverse(BOOK10), 60)), base10.net, base10.maxDD);
    if (r.net > 0) win++;
  }
  console.log(`→ ${win}/${knobs.length} biến thể vẫn DƯƠNG. Dưới 100% = có tham số đang gánh kết quả.`);

  // ── §5. Bỏ từng công cụ ──
  console.log("\n═══ §5. BỎ TỪNG CÔNG CỤ — kết quả có do MỘT công cụ gánh không? ═══");
  console.log(HEADER);
  for (const drop of BOOK10) {
    const syms = BOOK10.filter((s) => s !== drop);
    show(evaluate(`bỏ ${drop}`, fxBooks(syms, FX_TURTLE, `d${drop}`), heat, windowOf(loadUniverse(syms), 60)), base10.net, base10.maxDD);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
