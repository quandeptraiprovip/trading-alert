/**
 * mm-sizing.ts — Thử position-sizing theo dấu chân MM (KHÔNG lọc bớt lệnh)
 *
 * Ý tưởng: giữ NGUYÊN tập lệnh baseline, nhưng phân bổ rủi ro KHÁC nhau theo "độ mạnh
 * dấu chân nhà tạo lập" tại entry (displacement theo ATR, baseVolRatio, độ fresh).
 *
 * CÔNG BẰNG: mọi scheme được chuẩn hóa về trọng số TRUNG BÌNH = 1 ⇒ tổng rủi ro
 * triển khai ≈ baseline (flat). Chỉ khi đó weighted-NET mới so trực tiếp với +baseline.
 * (Nếu không chuẩn hóa, chỉ cần nhân đôi size là "thắng" giả tạo bằng đòn bẩy.)
 *
 * Chẩn đoán trước: tương quan Pearson(feature, netR) + mean netR theo tercile.
 * Nếu feature không dự báo R ⇒ không scheme nào vượt flat.
 *
 * Run: npx ts-node scripts/mm-sizing.ts [soNgay] [symbols]
 */
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest, Trade } from "../backtest";

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Chuẩn hóa trọng số về trung bình = 1 rồi tính weighted netR + maxDD (compounding 1%/unit). */
function weightedNet(trades: Trade[], rawW: number[]): { net: number; wMin: number; wMax: number; maxDD: number } {
  const m = mean(rawW);
  const w = m > 0 ? rawW.map((x) => x / m) : rawW.map(() => 1); // mean(w) = 1
  // sắp theo thời gian để tính equity/drawdown trung thực
  const order = trades.map((t, i) => [t.entryTime, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  let net = 0, equity = 100, peak = 100, maxDD = 0;
  const r = 0.01;
  for (const [, i] of order) {
    net += w[i] * trades[i].netR;
    equity *= 1 + w[i] * trades[i].netR * r;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  return { net, wMin: Math.min(...w), wMax: Math.max(...w), maxDD };
}

/** Trọng số tercile: thấp→0.5, giữa→1.0, cao→1.5 theo score (cao = mạnh). */
function tercileWeights(scores: number[]): number[] {
  const sorted = [...scores].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  const lo = q(1 / 3), hi = q(2 / 3);
  return scores.map((s) => (s <= lo ? 0.5 : s >= hi ? 1.5 : 1.0));
}

function meanNetByTercile(trades: Trade[], scores: number[]): [number, number, number] {
  const idx = scores.map((s, i) => [s, i] as [number, number]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const third = Math.floor(idx.length / 3) || 1;
  const grp = (a: number, b: number) => mean(idx.slice(a, b).map((i) => trades[i].netR));
  return [grp(0, third), grp(third, 2 * third), grp(2 * third, idx.length)];
}

async function main() {
  const days = parseInt(process.argv[2] ?? "250", 10);
  const symbols = (process.argv[3] ? process.argv[3].split(",") : CONFIG.symbols).map((s) => s.trim().toLowerCase());
  const totalBars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;

  console.log(`Tải ~${days} ngày × ${symbols.length} symbol...\n`);
  const trades: Trade[] = [];
  for (const sym of symbols) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, totalBars);
    if (ltf.length >= 500) trades.push(...runBacktest(sym, ltf));
  }
  console.log();
  if (trades.length === 0) { console.log("Không có lệnh."); return; }

  const netR = trades.map((t) => t.netR);
  const baseNet = sum(netR);

  // Feature (cao = dấu chân MM mạnh hơn). Fresh: ít mitigation hơn = mạnh hơn.
  const fDisp = trades.map((t) => t.displAtr);
  const fVol = trades.map((t) => t.baseVolRatio);
  const fFresh = trades.map((t) => 1 / (1 + t.mitigations));
  // Combo: chuẩn hóa z-score rồi cộng
  const z = (a: number[]) => { const m = mean(a); const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1; return a.map((x) => (x - m) / sd); };
  const zd = z(fDisp), zv = z(fVol), zf = z(fFresh);
  const fCombo = trades.map((_, i) => zd[i] + zv[i] + zf[i]);

  console.log("=".repeat(78));
  console.log(`  MM POSITION-SIZING — ${days} ngày — ${symbols.map((s) => s.toUpperCase()).join(", ")}`);
  console.log(`  Baseline FLAT: ${trades.length} lệnh, NET ${baseNet.toFixed(2)}R (${(baseNet / trades.length).toFixed(3)}R/lệnh)`);
  console.log("=".repeat(78));

  console.log("\nCHẨN ĐOÁN — feature có dự báo netR không?");
  console.log(`${"feature".padEnd(14)} ${"corr".padStart(7)}   mean netR theo tercile [thấp | giữa | cao]`);
  for (const [name, f] of [["displAtr", fDisp], ["baseVolRatio", fVol], ["freshness", fFresh], ["combo", fCombo]] as [string, number[]][]) {
    const c = pearson(f, netR);
    const [lo, mi, hi] = meanNetByTercile(trades, f);
    console.log(`${name.padEnd(14)} ${(c >= 0 ? "+" : "") + c.toFixed(3)}   [ ${lo.toFixed(3)} | ${mi.toFixed(3)} | ${hi.toFixed(3)} ]`);
  }

  console.log("\nSIZING SCHEMES (chuẩn hóa mean weight = 1 → so trực tiếp baseline):");
  console.log(`${"scheme".padEnd(22)} ${"NET R".padStart(10)} ${"Δ base".padStart(10)} ${"maxDD".padStart(7)} ${"w[min..max]".padStart(13)}`);
  console.log("-".repeat(78));
  const schemes: [string, number[]][] = [
    ["flat (sanity)", trades.map(() => 1)],
    ["∝ displAtr", fDisp.map((x) => Math.max(0.3, x))],
    ["∝ baseVolRatio", fVol.slice()],
    ["tercile displAtr", tercileWeights(fDisp)],
    ["tercile baseVolRatio", tercileWeights(fVol)],
    ["tercile freshness", tercileWeights(fFresh)],
    ["tercile combo", tercileWeights(fCombo)],
    // Ngưỡng CỐ ĐỊNH (triển khai live được, không cần biết phân phối tương lai)
    ["fixed vol <3/3-5/>5", fVol.map((x) => (x < 3 ? 0.5 : x >= 5 ? 1.5 : 1.0))],
    ["fixed vol >=4 →1.5", fVol.map((x) => (x >= 4 ? 1.5 : 1.0))],
  ];
  // phân phối baseVolRatio để chọn ngưỡng
  const vs = [...fVol].sort((a, b) => a - b);
  const qq = (p: number) => vs[Math.floor((vs.length - 1) * p)];
  console.log(`baseVolRatio phân phối: min ${vs[0].toFixed(1)} | p25 ${qq(0.25).toFixed(1)} | p50 ${qq(0.5).toFixed(1)} | p75 ${qq(0.75).toFixed(1)} | max ${vs[vs.length - 1].toFixed(1)}`);
  const baseDD = weightedNet(trades, trades.map(() => 1)).maxDD;
  for (const [name, raw] of schemes) {
    const { net, wMin, wMax, maxDD } = weightedNet(trades, raw);
    const d = net - baseNet;
    const mark = name.startsWith("flat") ? "" : d > 0.01 ? " ✅" : d < -0.01 ? " ❌" : " ≈";
    console.log(`${name.padEnd(22)} ${((net >= 0 ? "+" : "") + net.toFixed(2) + "R").padStart(10)} ${((d >= 0 ? "+" : "") + d.toFixed(2) + "R").padStart(10)} ${(maxDD * 100).toFixed(1).padStart(6)}% ${(wMin.toFixed(2) + ".." + wMax.toFixed(2)).padStart(13)}${mark}`);
  }
  console.log(`(baseline maxDD = ${(baseDD * 100).toFixed(1)}% @ risk 1%/unit)`);
  console.log("-".repeat(78));
  console.log("\nLưu ý: weighted-NET cao hơn ở mean-weight=1 nghĩa là dồn risk đúng vào lệnh thắng,");
  console.log("       nhưng phương sai trọng số làm tăng drawdown — cần soi cả maxDD trước khi chốt.\n");
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
