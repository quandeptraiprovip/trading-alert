/**
 * fx-native.ts — fx-speed.ts cho thấy gross R ≈ 0 ở MỌI tốc độ trên major. Nhưng bộ máy Turtle có
 * hai thứ mà literature về momentum tiền tệ KHÔNG có: (1) stop 3×ATR, (2) tín hiệu là PHÁ KÊNH.
 * Trên một tài sản biến động thấp và hay hồi như FX, cả hai đều có thể tự tay huỷ một edge có thật.
 *
 * Nên phải tách bạch được:
 *   (a) FX KHÔNG có tính dự đoán được về hướng  → cả TSMOM cũng phẳng.
 *   (b) Có, nhưng bộ máy stop/breakout phá nó   → TSMOM dương còn Turtle âm.
 * Chỉ (b) mới cho ra một sản phẩm dùng được; (a) thì câu trả lời đúng là đừng trade FX theo hướng.
 *
 * PHƯƠNG PHÁP — bản chuẩn của Moskowitz–Ooi–Pedersen (2012), KHÔNG chỉnh gì cho hợp dữ liệu:
 *   tín hiệu = dấu của lợi suất L tháng trước · size = vol-target (rủi ro không đổi) ·
 *   rebalance đầu tháng · KHÔNG stop. L ∈ {1, 3, 6, 12} tháng — đúng bộ kinh điển, khai báo trước.
 *
 * Chạy: npx ts-node fx/fx-native.ts
 */

import { CROSSES, FX7, METALS, loadDaily } from "./fx-transfer";

/** L tháng → số ngày giao dịch. Bộ kinh điển, không phải kết quả tìm kiếm. */
const LOOKBACKS: [string, number][] = [["1m", 21], ["3m", 63], ["6m", 126], ["12m", 252]];
const VOL_WINDOW = 60;     // cửa sổ ước lượng biến động (ngày giao dịch)
const TARGET_VOL = 0.10;   // 10%/năm mỗi công cụ — chỉ là hằng số quy đổi, không đổi Sharpe
const SWAP_PCT_PER_DAY = 0.0042; // = 1,5%/năm trên notional, cùng giả định với fx-transfer.ts

interface Bar { openTime: number; close: number; spread: number }

/** P&L NGÀY của một công cụ theo luật TSMOM. Không nhìn trước: vị thế ngày i quyết bởi dữ liệu ≤ i−1. */
function tsmomPnl(bars: Bar[], lookback: number): { time: number; gross: number; net: number; w: number }[] {
  const ret: number[] = [0];
  for (let i = 1; i < bars.length; i++) ret.push(Math.log(bars[i].close / bars[i - 1].close));

  const out: { time: number; gross: number; net: number; w: number }[] = [];
  let w = 0; // tỉ trọng đang giữ
  const warm = Math.max(lookback, VOL_WINDOW) + 1;

  for (let i = warm; i < bars.length; i++) {
    // Rebalance khi SANG THÁNG mới (tính trên nến i−1 đã đóng).
    const isNewMonth =
      new Date(bars[i - 1].openTime).getUTCMonth() !== new Date(bars[i - 2].openTime).getUTCMonth();
    let turnover = 0;
    if (isNewMonth) {
      const sig = Math.sign(bars[i - 1].close / bars[i - 1 - lookback].close - 1);
      const win = ret.slice(i - VOL_WINDOW, i);
      const mean = win.reduce((s, x) => s + x, 0) / win.length;
      const sd = Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / (win.length - 1));
      const annVol = sd * Math.sqrt(252);
      const target = annVol > 0 ? sig * Math.min(TARGET_VOL / annVol, 10) : 0; // trần 10× chống chia cho vol ~0
      turnover = Math.abs(target - w);
      w = target;
    }
    const spreadFrac = bars[i - 1].spread / bars[i - 1].close;
    const cost = turnover * spreadFrac + Math.abs(w) * (SWAP_PCT_PER_DAY / 100);
    out.push({ time: bars[i].openTime, gross: w * ret[i], net: w * ret[i] - cost, w });
  }
  return out;
}

function stats(pnl: number[], times: number[]) {
  const n = pnl.length;
  const mean = pnl.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(pnl.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  let cum = 0, peak = 0, maxDD = 0;
  for (const x of pnl) { cum += x; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  // t-stat của trung bình — thước đo "có phân biệt được với 0 không", đúng câu hỏi ở đây.
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const byYear = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const y = new Date(times[i]).getUTCFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + pnl[i]);
  }
  const yrs = [...byYear.values()];
  return {
    annRet: mean * 252, annVol: sd * Math.sqrt(252), sharpe, maxDD, t,
    posYears: yrs.filter((v) => v > 0).length, nYears: yrs.length,
  };
}

/** Danh mục = trung bình đều các công cụ (mỗi công cụ đã vol-target nên đóng góp rủi ro tương đương). */
function portfolio(symbols: string[], lookback: number) {
  const perDay = new Map<number, { g: number; n: number; c: number }>();
  for (const s of symbols) {
    for (const p of tsmomPnl(loadDaily(s) as Bar[], lookback)) {
      const d = Math.floor(p.time / 86400e3);
      const e = perDay.get(d) ?? { g: 0, n: 0, c: 0 };
      e.g += p.gross; e.n += p.net; e.c++;
      perDay.set(d, e);
    }
  }
  const days = [...perDay.keys()].sort((a, b) => a - b);
  const times = days.map((d) => d * 86400e3);
  return {
    gross: stats(days.map((d) => perDay.get(d)!.g / symbols.length), times),
    net: stats(days.map((d) => perDay.get(d)!.n / symbols.length), times),
  };
}

function report(label: string, symbols: string[]) {
  console.log(`\n─── ${label} (${symbols.length} công cụ) ───`);
  console.log(
    "lookback".padEnd(10) + "annRet".padStart(8) + "annVol".padStart(8) + "Sharpe".padStart(8) +
    "maxDD".padStart(8) + "t-stat".padStart(8) + "năm+".padStart(8) + "   | GROSS Sharpe  t-stat",
  );
  for (const [name, L] of LOOKBACKS) {
    const r = portfolio(symbols, L);
    console.log(
      `TSMOM ${name}`.padEnd(10) +
      `${(r.net.annRet * 100).toFixed(1)}%`.padStart(8) +
      `${(r.net.annVol * 100).toFixed(1)}%`.padStart(8) +
      r.net.sharpe.toFixed(2).padStart(8) +
      `${(r.net.maxDD * 100).toFixed(0)}%`.padStart(8) +
      r.net.t.toFixed(2).padStart(8) +
      `${r.net.posYears}/${r.net.nYears}`.padStart(8) +
      `   | ${r.gross.sharpe.toFixed(2).padStart(6)}  ${r.gross.t.toFixed(2).padStart(6)}`,
    );
  }
}

async function main() {
  console.log("═══ TSMOM CHUẨN (không stop, vol-target, rebalance tháng) ═══");
  console.log("Đọc cột t-stat: |t| < 2 = KHÔNG phân biệt được với số 0, bất kể Sharpe trông thế nào.");
  report("FX7 — major USD", FX7);
  report("FX11 — major + cross", [...FX7, ...CROSSES]);
  report("Vàng + Bạc", METALS);
  report("FX7 + kim loại", [...FX7, ...METALS]);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
