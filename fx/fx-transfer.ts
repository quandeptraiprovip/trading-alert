/**
 * fx-transfer.ts — CÂU HỎI DUY NHẤT: luật Turtle đang chạy tiền thật trên crypto có tự sống được
 * trên cặp tiền KHÔNG CẦN chỉnh một tham số nào không?
 *
 * VÌ SAO HỎI THEO KIỂU NÀY: mọi kết quả "tìm ra tham số tốt cho FX" đều vô nghĩa cho tới khi biết
 * bản KHÔNG chỉnh gì hoạt động ra sao. Nếu bản zero-tuning đã dương trên 22 năm × 3 era, thì phần
 * còn lại chỉ là tinh chỉnh; nếu nó âm, thì mọi cấu hình dương tìm được sau đó gần như chắc chắn
 * là overfit — vì ta đã phải đi tìm nó.
 *
 * CHỈ ĐỔI NHỮNG THỨ KHÔNG CÓ ĐỐI ỨNG Ở FX (và mỗi cái đều được ablation riêng ở §3):
 *   - Khung nến 4h → 1d. FX đóng cửa cuối tuần nên "15 ngày" chỉ giữ nguyên nghĩa khi 1 nến = 1
 *     ngày giao dịch. Mọi tham số tính theo NGÀY (entryDays/longExitDays/maxHoldDays) do đó dịch
 *     nguyên vẹn; tham số tính theo NẾN (atrPeriod 20, trendLen 50) thành 20/50 ngày — đúng bằng
 *     bộ ATR20/EMA50 kinh điển của trend-following ngày, nên không phải là một lựa chọn được fit.
 *   - BTC regime gate: không có "BTC của FX". Bỏ hẳn, KHÔNG thay bằng chỉ số khác (thay = đi tìm).
 *   - Chi phí: taker fee + funding của sàn crypto → SPREAD ĐO ĐƯỢC từng cặp + swap qua đêm.
 *
 * Chạy: npx ts-node fx/fx-transfer.ts
 */

import { CONFIG, Candle } from "../strategy";
import { T } from "../turtle";
import { ExtParams } from "../scripts/portfolio-engine";
import { HEADER, Row, books, decayH, evaluate, printRow, windowOf } from "../scripts/rx-lab";
import { aggregateFx, loadH1, medianSpreadPct, ymd } from "./fx-data";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────
// RỔ — định nghĩa TRƯỚC khi nhìn kết quả, theo luật khách quan chứ không theo hiệu suất
// (bài học core8-selection-bias: chọn rổ sau khi thấy số = tự bịa ra Sharpe).
// ─────────────────────────────────────────────
export const FX7 = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"];
export const CROSSES = ["EURJPY", "GBPJPY", "EURGBP", "AUDJPY"];
export const METALS = ["XAUUSD", "XAGUSD"];

// ─────────────────────────────────────────────
// CHI PHÍ FX
// ─────────────────────────────────────────────
/**
 * SWAP qua đêm, quy về đúng ô `fundingPer8hPct` mà engine đã có.
 * 0,0014%/8h ≈ 1,5%/năm trên NOTIONAL — bằng phần markup broker thu trên cả hai chiều, nên đây là
 * mô hình DRAG đối xứng: không thưởng cho việc lệnh tình cờ nằm cùng chiều chênh lệch lãi suất.
 * Con số này bị stress ở §4.
 */
export const FX_SWAP_PER_8H_PCT = 0.0014;

/** Trượt giá một chiều ngoài spread (market order major giờ thanh khoản ≈ 0,2 pip). */
const FX_SLIP_PCT = 0.002;

/**
 * Spread dùng làm chi phí được ĐO tại giá đóng nến ngày = 00:00 UTC — đúng thời điểm rollover,
 * lúc spread RỘNG NHẤT trong ngày. Sai số vì thế nghiêng về phía BẤT LỢI cho chiến lược, đúng
 * hướng ta muốn sai.
 */
export function fxCostParams(candles: { close: number; spread: number }[]): {
  takerFeePct: number;
  slippagePct: number;
} {
  return { takerFeePct: medianSpreadPct(candles as never) / 2, slippagePct: FX_SLIP_PCT };
}

// ─────────────────────────────────────────────
// NẠP DỮ LIỆU
// ─────────────────────────────────────────────
const CACHE_DIR = path.join(process.cwd(), ".cache", "fx");

/**
 * Nến NGÀY. File `_day` của Dukascopy (2004→2025) là nguồn chính nhưng CÓ LỖ HỔNG thật — riêng
 * XAUUSD từng mất trọn 2013, đúng năm vàng sập 28%. Vì thế mọi ngày thiếu đều được vá từ cache H1
 * nếu có, chứ không chỉ nối phần đuôi. Nến ngày Dukascopy mốc 00:00 UTC nên phần vá dùng cùng mốc.
 */
export function loadDaily(symbol: string) {
  const dayPath = path.join(CACHE_DIR, `${symbol}_day.json`);
  const rows = JSON.parse(fs.readFileSync(dayPath, "utf8")) as {
    openTime: number; open: number; high: number; low: number; close: number; volume: number; spread: number;
  }[];
  const h1Path = path.join(CACHE_DIR, `${symbol}_h1.json`);
  if (!fs.existsSync(h1Path)) return rows;

  const have = new Set(rows.map((r) => r.openTime));
  for (const c of aggregateFx(loadH1(symbol), "1d", 0)) {
    if (!have.has(c.openTime)) rows.push(c);
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  return rows;
}

export function loadUniverse(symbols: string[]): Map<string, Candle[]> {
  const m = new Map<string, Candle[]>();
  for (const s of symbols) m.set(s, loadDaily(s) as Candle[]);
  return m;
}

/** Tham số theo TỪNG cặp (spread khác nhau một bậc giữa EURUSD và XAGUSD). */
export function fxBooks(symbols: string[], base: ExtParams, tag = "") {
  return symbols.flatMap((s) => {
    const candles = loadDaily(s);
    return books(new Map([[s, candles as Candle[]]]), { ...base, ...fxCostParams(candles) }, tag);
  });
}

// ─────────────────────────────────────────────
// CẤU HÌNH: production Turtle, chỉ dịch khung nến. KHÔNG chỉnh gì khác.
// ─────────────────────────────────────────────
export const FX_TURTLE: ExtParams = { ...T, tf: "1d" };

/**
 * Sharpe của repo annualize bằng √365, nhưng FX chỉ giao dịch ~252 ngày/năm ⇒ con số thô bị thổi
 * lên √(365/252) = 1,20 lần. Mọi so sánh với Sharpe crypto phải dùng bản đã hiệu chỉnh này.
 */
export const FX_SHARPE_ADJ = Math.sqrt(252 / 365);

function printFx(r: Row, baseNet?: number, baseDd?: number) {
  printRow({ ...r, sharpe: r.sharpe * FX_SHARPE_ADJ, eraSharpe: r.eraSharpe.map((s) => s * FX_SHARPE_ADJ) }, baseNet, baseDd);
}

async function main() {
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT; // = swap qua đêm (xem ghi chú trên)

  // ── §1. Chất lượng dữ liệu ──
  console.log("═══ §1. DỮ LIỆU ═══");
  const all = [...FX7, ...CROSSES, ...METALS];
  for (const s of all) {
    const d = loadDaily(s);
    const yrs = (d[d.length - 1].openTime - d[0].openTime) / (365.25 * 86400e3);
    const sp = medianSpreadPct(d as never);
    const atrPct = d.slice(-500).reduce((acc, c) => acc + (c.high - c.low) / c.close, 0) / 500 * 100;
    console.log(
      `${s.padEnd(8)} ${String(d.length).padStart(5)} nến  ${ymd(d[0].openTime)}→${ymd(d[d.length - 1].openTime)}` +
      `  ${yrs.toFixed(1)}y  ${(d.length / yrs).toFixed(0)} nến/năm` +
      `  spread ${sp.toFixed(4)}%  biên độ ngày ${atrPct.toFixed(2)}%  spread/biên độ ${(sp / atrPct * 100).toFixed(1)}%`,
    );
  }

  // ── §2. CHUYỂN GIAO ZERO-TUNING ──
  console.log("\n═══ §2. TURTLE PRODUCTION → FX, KHÔNG CHỈNH THAM SỐ ═══");
  console.log(`Luật: long ${T.entryDays}d/exit ${T.longExitDays}d · short ${T.shortEntryDays}d/chandelier ${T.chandelierMult}×ATR`);
  console.log(`      pyramid ${T.pyramidStepAtr}×ATR max${T.pyramidMaxUnits} · heat-decay k=${T.heatDecayK} · EMA${T.trendLen} · ATR${T.atrPeriod}`);
  console.log(`Chi phí: spread đo theo cặp (round-turn) + trượt ${FX_SLIP_PCT}%/chiều + swap ${FX_SWAP_PER_8H_PCT}%/8h\n`);
  console.log(HEADER);

  const heat = decayH(T.heatDecayK);
  const universes: [string, string[]][] = [
    ["FX7 (major USD)", FX7],
    ["FX11 (+4 cross)", [...FX7, ...CROSSES]],
    ["FX13 (+vàng/bạc)", all],
    ["chỉ vàng+bạc", METALS],
  ];
  for (const [label, syms] of universes) {
    const w = windowOf(loadUniverse(syms), 60);
    printFx(evaluate(label, fxBooks(syms, FX_TURTLE), heat, w));
  }

  // ── §3. Ablation: từng thứ buộc phải đổi khi sang FX ──
  console.log("\n═══ §3. ABLATION — mỗi dòng đổi ĐÚNG MỘT THỨ so với §2 (rổ FX7) ═══");
  console.log(HEADER);
  const w7 = windowOf(loadUniverse(FX7), 60);
  const base = evaluate("chuẩn (§2)", fxBooks(FX7, FX_TURTLE), heat, w7);
  printFx(base);
  const variants: [string, ExtParams | null, boolean][] = [
    ["không heat-decay", FX_TURTLE, false],
    ["không pyramid", { ...FX_TURTLE, pyramidStepAtr: 0 }, true],
    ["chỉ LONG", { ...FX_TURTLE, allowShort: false }, true],
    ["EMA8 thay EMA50 (bằng lịch crypto)", { ...FX_TURTLE, trendLen: 8, atrPeriod: 3 }, true],
    ["không lọc EMA", { ...FX_TURTLE, trendLen: 1 }, true],
    ["thoát chandelier cả 2 chiều", { ...FX_TURTLE, longExitMode: "chandelier" }, true],
    ["stop 3×ATR thuần (bỏ stop cấu trúc)", { ...FX_TURTLE, initialStopObLookback: 0 }, true],
  ];
  for (const [label, p, useHeat] of variants) {
    printFx(evaluate(label, fxBooks(FX7, p!), useHeat ? heat : undefined, w7), base.net, base.maxDD);
  }

  // ── §4. Chi phí: bao nhiêu thì chết? ──
  console.log("\n═══ §4. NGƯỠNG CHI PHÍ — spread ×k và swap ×k (rổ FX7) ═══");
  console.log(HEADER);
  for (const k of [1, 2, 3, 5]) {
    const bs = FX7.flatMap((s) => {
      const candles = loadDaily(s);
      const c = fxCostParams(candles);
      return books(new Map([[s, candles as Candle[]]]), {
        ...FX_TURTLE, takerFeePct: c.takerFeePct * k, slippagePct: c.slippagePct * k,
      }, `sp${k}`);
    });
    printFx(evaluate(`spread+trượt ×${k}`, bs, heat, w7), base.net, base.maxDD);
  }
  for (const k of [2, 4]) {
    CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT * k;
    printFx(evaluate(`swap ×${k} (${(FX_SWAP_PER_8H_PCT * k * 3 * 365).toFixed(1)}%/năm)`, fxBooks(FX7, FX_TURTLE, `sw${k}`), heat, w7), base.net, base.maxDD);
  }
  CONFIG.costs.fundingPer8hPct = FX_SWAP_PER_8H_PCT;

  // ── §5. Theo năm — nơi giấu xác của mọi chiến lược trend ──
  console.log("\n═══ §5. NET R THEO NĂM (rổ FX7, cấu hình §2) ═══");
  const res = base.res;
  const perYear = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const y = new Date(res.equity[i].time).getUTCFullYear();
    perYear.set(y, (perYear.get(y) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const years = [...perYear.keys()].sort();
  for (const y of years) {
    const v = perYear.get(y)!;
    console.log(`  ${y}  ${v >= 0 ? "+" : ""}${v.toFixed(1).padStart(7)}R  ${"█".repeat(Math.max(0, Math.round(Math.abs(v) / 2)))}${v < 0 ? " (âm)" : ""}`);
  }
  const pos = years.filter((y) => perYear.get(y)! > 0).length;
  console.log(`  → ${pos}/${years.length} năm dương`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
