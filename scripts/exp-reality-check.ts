/**
 * exp-reality-check.ts — PHÉP KIỂM CHÍNH THỨC CHO CÂU "TÔI VỪA THỬ 37 BIẾN THỂ, CÁI THẮNG CÓ THẬT KHÔNG?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BÀI BÁO GỐC
 *
 * Sullivan, Timmermann & White (1999), "Data-Snooping, Technical Trading Rule Performance, and the
 * Bootstrap", *Journal of Finance* 54(5), 1647-1691.
 *
 * Họ mở rộng 26 luật của Brock-Lakonishok-LeBaron (1992) thành **7.846 luật kỹ thuật** (moving
 * average, filter, support-resistance, channel breakout, on-balance volume) chạy trên 100 năm dữ
 * liệu Dow Jones, rồi hỏi đúng câu ta đang hỏi: luật TỐT NHẤT trong ngần ấy luật có thật sự tốt,
 * hay chỉ là cực trị của một mẫu hữu hạn?
 *
 * Kết quả của họ, ba ý — cả ba đều áp thẳng vào tình huống này:
 *   1. Trên đúng giai đoạn BLL đã xem, luật tốt nhất VẪN vượt được cả sau hiệu chỉnh data-snooping.
 *   2. Nhưng chính luật đó **THẤT BẠI ở 10 năm ngoài mẫu tiếp theo**.
 *   3. Trên hợp đồng tương lai S&P 500, **không luật nào** vượt nổi sau hiệu chỉnh.
 *
 * Công cụ họ dùng là **White's Reality Check**: thay vì hỏi "luật này có p < 0,05 không" (câu hỏi
 * SAI khi ta đã bới qua N luật), nó hỏi "hiệu suất của luật TỐT NHẤT có vượt được phân phối của
 * MAX trên N luật dưới giả thuyết không có luật nào có edge không". Phân phối của max lệch phải rất
 * mạnh — đó chính là lý do một p-value đơn lẻ 0,03 sau 37 lần thử không có nghĩa gì.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÀI ĐẶT
 *
 *   d_k   = Sharpe(biến thể k) − Sharpe(baseline)      ← chấm trên ĐÚNG tiêu chí đã dùng để chọn
 *   V     = max_k d_k                                   ← thống kê kiểm định
 *   bootstrap TĨNH (Politis & Romano 1994, độ dài khối trung bình 10 ngày — giữ tự tương quan)
 *   V*_b  = max_k ( d*_k − d_k )                        ← TÁI TÂM về giả thuyết H0: không ai có edge
 *   p     = tỉ lệ V*_b ≥ V
 *
 * In kèm **p-value NGÂY THƠ** của riêng luật thắng (không hiệu chỉnh) để thấy khoảng cách giữa hai
 * cách đọc — đó là toàn bộ nội dung của bài báo.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-reality-check.ts [days=2000] [B=2000]
 */

import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, EquityPoint, ExtParams, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";
import { buildPre, candidates, type Filter } from "./exp-classic-indicators";
import { buildComboPre, comboVariants } from "./exp-indicator-combos";

const DAY = TF_MS["1d"];
const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

/** Chuỗi P&L THEO NGÀY (R) trên một lưới ngày CHUNG cho mọi biến thể. */
function dailySeries(eq: EquityPoint[], from: number, to: number, grid: number[]): number[] {
  const per = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    const d = Math.floor(eq[i].time / DAY);
    per.set(d, (per.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return grid.map((d) => per.get(d) ?? 0);
}

const sharpeOf = (r: number[]): number => {
  const n = r.length;
  if (n < 3) return 0;
  const m = r.reduce((s, x) => s + x, 0) / n;
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};

function rng(seed: number) {
  let s = seed;
  return () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Bootstrap TĨNH (Politis & Romano): khối có độ dài ngẫu nhiên hình học, trung bình `meanBlock`.
 * Cần thiết vì P&L ngày của hệ trend có tự tương quan (một trend chạy nhiều ngày) — bootstrap iid
 * sẽ cho khoảng tin cậy hẹp giả và biến mọi thứ thành "có ý nghĩa".
 */
function stationaryIndices(n: number, meanBlock: number, rand: () => number): number[] {
  const p = 1 / meanBlock;
  const idx = new Array(n);
  let cur = Math.floor(rand() * n);
  for (let i = 0; i < n; i++) {
    if (i > 0 && rand() < p) cur = Math.floor(rand() * n);
    else if (i > 0) cur = (cur + 1) % n;
    idx[i] = cur;
  }
  return idx;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const B = parseInt(process.argv[3] ?? "2000", 10);
  const MEAN_BLOCK = 10;

  console.log(`Nạp ${CORE8.length} symbol CORE8, ${days} ngày nến 4h...`);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const pre = buildPre(data);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const both = [...bk(turtle, "t"), ...bk(fast, "f")];

  const heat = decayH(T.heatDecayK);
  type Sz = (sym: string, time: number, dir: "long" | "short") => number;
  const admitWith = (f: Filter | null, sizer: Sz | null = null): AdmitFn => (c: AdmitCtx) => {
    if (c.kind !== "entry") return heat(c);
    if (f && !f(c.rawSymbol, c.time, c.dir)) return 0;
    return heat(c) * (sizer ? sizer(c.rawSymbol, c.time, c.dir) : 1);
  };

  // Lưới ngày chung
  const baseRes = runBooks(both, admitWith(null));
  const gridSet = new Set<number>();
  for (const e of baseRes.equity) if (e.time >= w.from && e.time <= w.to) gridSet.add(Math.floor(e.time / DAY));
  const grid = [...gridSet].sort((a, b) => a - b);
  const baseSeries = dailySeries(baseRes.equity, w.from, w.to, grid);
  const baseSharpe = sharpeOf(baseSeries);

  // `--all` = chấm CHUNG rổ 37 biến thể vòng 1 + 41 biến thể vòng 2 (chỉ báo mới + các bản gộp).
  // Reality Check chỉ đúng khi nó nhìn thấy MỌI luật đã từng thử trên cùng bộ dữ liệu; bỏ sót luật
  // nào là tự hạ ngưỡng cho mình.
  const useAll = process.argv.includes("--all");
  const variants: { label: string; f: Filter | null; sizer: Sz | null }[] =
    candidates(pre).map((c) => ({ label: c.label, f: c.f, sizer: null as Sz | null }));
  if (useAll) {
    const cpre = buildComboPre(data);
    for (const v of comboVariants(cpre)) variants.push({ label: v.label, f: v.f, sizer: v.sizer });
  }
  console.log(`Cửa sổ: ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ${grid.length} ngày · ${variants.length} biến thể${useAll ? " (CẢ HAI VÒNG)" : ""} · B=${B}\n`);

  const series: number[][] = [];
  const labels: string[] = [];
  for (const c of variants) {
    series.push(dailySeries(runBooks(both, admitWith(c.f, c.sizer)).equity, w.from, w.to, grid));
    labels.push(c.label);
  }
  const cands = variants;

  const d = series.map((s) => sharpeOf(s) - baseSharpe);
  let bestK = 0;
  for (let k = 1; k < d.length; k++) if (d[k] > d[bestK]) bestK = k;
  const V = d[bestK];

  console.log("═".repeat(104));
  console.log(`  WHITE'S REALITY CHECK — Sullivan, Timmermann & White (1999)`);
  console.log("═".repeat(104));
  console.log(`  Baseline Sharpe          : ${baseSharpe.toFixed(4)}`);
  console.log(`  Luật TỐT NHẤT trong ${String(cands.length).padStart(2)} : ${labels[bestK]}`);
  console.log(`  ΔSharpe của nó (V)       : ${V >= 0 ? "+" : ""}${V.toFixed(4)}`);
  console.log(`  Bootstrap tĩnh, khối TB  : ${MEAN_BLOCK} ngày (giữ tự tương quan P&L trend)\n`);

  const rand = rng(20260814);
  let ge = 0, geNaive = 0;
  const maxDist: number[] = [];
  // Lưu toàn bộ giá trị đã tái tâm để tính SPA của Hansen ở lượt sau (cần ω̂_k của từng luật).
  const cent: number[][] = series.map(() => new Array(B).fill(0));
  for (let b = 0; b < B; b++) {
    const idx = stationaryIndices(grid.length, MEAN_BLOCK, rand);
    const bs = sharpeOf(idx.map((i) => baseSeries[i]));
    let mx = -Infinity;
    for (let k = 0; k < series.length; k++) {
      const sk = series[k];
      const dk = sharpeOf(idx.map((i) => sk[i])) - bs;
      const centered = dk - d[k];
      cent[k][b] = centered;
      if (centered > mx) mx = centered;
      if (k === bestK && centered >= V) geNaive++;
    }
    maxDist.push(mx);
    if (mx >= V) ge++;
  }
  maxDist.sort((a, b) => a - b);
  const q = (p: number) => maxDist[Math.min(maxDist.length - 1, Math.floor(maxDist.length * p))];

  const pRC = ge / B;
  const pNaive = geNaive / B;

  // ── HANSEN (2005) SPA — bản cải tiến chính thức của Reality Check ──
  // Vấn đề của RC: nó lấy MAX trên TOÀN BỘ rổ luật, nên chỉ cần một luật RẤT TỆ nhưng phương sai lớn
  // (ở đây: "MACD hist NGƯỢC" giữ 20% lệnh, "Stoch 20-80" giữ 47%) là phân phối max phình ra và phép
  // kiểm mất lực. Hansen sửa bằng hai việc: (1) STUDENT HOÁ mỗi luật bằng độ lệch chuẩn bootstrap
  // của chính nó, (2) LOẠI khỏi tái tâm những luật tệ đến mức không thể là luật tốt nhất.
  const sd = cent.map((row) => {
    const m = row.reduce((s, x) => s + x, 0) / row.length;
    return Math.sqrt(row.reduce((s, x) => s + (x - m) ** 2, 0) / (row.length - 1));
  });
  const t = d.map((x, k) => (sd[k] > 0 ? x / sd[k] : 0));
  const tObs = Math.max(0, ...t);
  const dropCut = -Math.sqrt(2 * Math.log(Math.log(grid.length))); // ngưỡng loại của Hansen
  const keep = t.map((x) => x >= dropCut);
  let geSPA = 0;
  for (let b = 0; b < B; b++) {
    let mx = 0;
    for (let k = 0; k < cent.length; k++) {
      if (!keep[k] || !(sd[k] > 0)) continue;
      const v = cent[k][b] / sd[k];
      if (v > mx) mx = v;
    }
    if (mx >= tObs) geSPA++;
  }
  const pSPA = geSPA / B;
  const nDropped = keep.filter((x) => !x).length;

  console.log("  " + "cách đọc".padEnd(52) + "p-value".padStart(10) + "   kết luận");
  console.log("-".repeat(104));
  console.log("  " + `NGÂY THƠ — chỉ kiểm riêng luật thắng`.padEnd(52) + pNaive.toFixed(4).padStart(10) +
    `   ${pNaive < 0.05 ? "«có ý nghĩa»" : "không có ý nghĩa"}`);
  console.log("  " + `REALITY CHECK — kiểm MAX trên cả ${cands.length} luật`.padEnd(52) + pRC.toFixed(4).padStart(10) +
    `   ${pRC < 0.05 ? "CÓ Ý NGHĨA" : "KHÔNG có ý nghĩa"}`);
  console.log("  " + `HANSEN SPA — student hoá + loại ${nDropped} luật vô vọng`.padEnd(52) + pSPA.toFixed(4).padStart(10) +
    `   ${pSPA < 0.05 ? "CÓ Ý NGHĨA" : "KHÔNG có ý nghĩa"}`);
  console.log("-".repeat(104));
  console.log(`  Ngưỡng ΔSharpe cần đạt để p<0,05 theo RC: +${q(0.95).toFixed(4)}   (thực tế đạt: ${V >= 0 ? "+" : ""}${V.toFixed(4)})`);
  console.log(`  Phân phối MAX dưới H0 (RC): trung vị +${q(0.5).toFixed(4)} · p90 +${q(0.9).toFixed(4)} · p99 +${q(0.99).toFixed(4)}`);
  console.log(`  SPA: thống kê student hoá của luật thắng t = ${tObs.toFixed(3)} (ΔSharpe ${V.toFixed(4)} / sd bootstrap ${sd[bestK].toFixed(4)})`);
  console.log(
    `\n  Đọc: cột "ngây thơ" là con số ta sẽ tự báo cáo nếu chỉ nhìn luật thắng. Cột Reality Check là\n` +
    `  con số ĐÚNG khi đã bới qua ${cands.length} luật. Khoảng cách giữa hai cột chính là chi phí data-snooping —\n` +
    `  và nó là toàn bộ nội dung bài báo 1999.`,
  );

  // Bảng top-5 để thấy cả nhóm dẫn đầu, không chỉ một luật
  const order = d.map((x, i) => [x, i] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, 6);
  console.log(`\n  Sáu luật dẫn đầu (ΔSharpe so với baseline ${baseSharpe.toFixed(3)}):`);
  for (const [v, i] of order) console.log(`    ${(v >= 0 ? "+" : "") + v.toFixed(4)}  ${labels[i]}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
