/**
 * coin-features.ts — Đặc trưng BIẾT-TRƯỚC nào tách nhóm coin GOOD khỏi BAD?
 *
 * Nhãn (từ coin-fit.ts, nhất quán 2 nửa thời gian):
 *   GOOD: BTC SOL XRP DOGE   BAD: BNB ADA AVAX LINK LTC   (noisy: ETH TRX DOT — bỏ qua khi xét tách)
 *
 * Đặc trưng tính từ GIÁ/VOLUME (không dùng P&L chiến lược) → dùng để chọn coin a-priori:
 *   - vol      : độ lệch chuẩn return ngày (biến động)
 *   - ER       : Kaufman Efficiency Ratio (độ trending; cao = trend sạch, thấp = choppy)
 *   - ac1      : autocorrelation lag-1 của return ngày (dương = momentum, âm = mean-revert)
 *   - vol$/d   : volume USDT trung bình/ngày (thanh khoản)
 *   - betaBTC  : beta return ngày với BTC
 *
 * Báo cáo coin nào, và đặc trưng nào TÁCH SẠCH good/bad (khoảng giá trị không chồng lấn).
 * Run: npx ts-node scripts/coin-features.ts [days=500]
 */
import { Candle, CONFIG, TF_MS, aggregate } from "../strategy";
import { fetchKlinesPaged } from "../backtest";

const LABEL: Record<string, "good" | "bad" | "noisy"> = {
  btcusdt: "good", solusdt: "good", xrpusdt: "good", dogeusdt: "good",
  bnbusdt: "bad", adausdt: "bad", avaxusdt: "bad", linkusdt: "bad", ltcusdt: "bad",
  ethusdt: "noisy", trxusdt: "noisy", dotusdt: "noisy",
};
const COINS = Object.keys(LABEL);

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

function dailyReturns(daily: Candle[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < daily.length; i++) r.push(daily[i].close / daily[i - 1].close - 1);
  return r;
}

/** Kaufman Efficiency Ratio trung bình (window ngày): |Δ ròng| / Σ|Δ| — trong [0,1]. */
function efficiencyRatio(daily: Candle[], win = 10): number {
  const ers: number[] = [];
  for (let i = win; i < daily.length; i++) {
    const net = Math.abs(daily[i].close - daily[i - win].close);
    let path = 0;
    for (let k = i - win + 1; k <= i; k++) path += Math.abs(daily[k].close - daily[k - 1].close);
    if (path > 0) ers.push(net / path);
  }
  return mean(ers);
}

function autocorr1(r: number[]): number {
  if (r.length < 3) return 0;
  const m = mean(r);
  let num = 0, den = 0;
  for (let i = 0; i < r.length; i++) den += (r[i] - m) ** 2;
  for (let i = 1; i < r.length; i++) num += (r[i] - m) * (r[i - 1] - m);
  return den > 0 ? num / den : 0;
}

function beta(rCoin: number[], rBtc: number[]): number {
  const n = Math.min(rCoin.length, rBtc.length);
  const a = rCoin.slice(-n), b = rBtc.slice(-n);
  const mb = mean(b);
  let cov = 0, varb = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - mean(a)) * (b[i] - mb); varb += (b[i] - mb) ** 2; }
  return varb > 0 ? cov / varb : 0;
}

type Feat = { sym: string; label: string; vol: number; er: number; ac1: number; vold: number; beta: number };

async function main() {
  const days = parseInt(process.argv[2] ?? "500", 10);
  const bars = Math.ceil((days * TF_MS["1d"]) / TF_MS[CONFIG.entryTf]) + 400;

  console.log(`Tải ${COINS.length} coin × ~${days}d...\n`);
  const dailyBy = new Map<string, Candle[]>();
  for (const sym of COINS) {
    const ltf = await fetchKlinesPaged(sym, CONFIG.entryTf, bars);
    if (ltf.length >= 1000) dailyBy.set(sym, aggregate(ltf, "1d", CONFIG.entryTf));
  }
  console.log();

  const btcR = dailyReturns(dailyBy.get("btcusdt")!);
  const feats: Feat[] = [];
  for (const [sym, daily] of dailyBy) {
    const r = dailyReturns(daily);
    feats.push({
      sym, label: LABEL[sym],
      vol: std(r) * 100,
      er: efficiencyRatio(daily),
      ac1: autocorr1(r),
      vold: mean(daily.map((d) => d.quoteVolume ?? 0)) / 1e6,
      beta: beta(r, btcR),
    });
  }

  console.log("=".repeat(80));
  console.log(`  ĐẶC TRƯNG COIN (forward-knowable) — ~${days}d`);
  console.log("=".repeat(80));
  console.log(`${"coin".padEnd(7)} ${"nhãn".padEnd(6)} ${"vol%/d".padStart(7)} ${"ER".padStart(6)} ${"ac1".padStart(7)} ${"vol$M/d".padStart(9)} ${"betaBTC".padStart(8)}`);
  console.log("-".repeat(80));
  const order = { good: 0, bad: 1, noisy: 2 } as Record<string, number>;
  for (const f of [...feats].sort((a, b) => order[a.label] - order[b.label] || b.er - a.er)) {
    console.log(`${f.sym.replace("usdt", "").toUpperCase().padEnd(7)} ${f.label.padEnd(6)} ${f.vol.toFixed(2).padStart(7)} ${f.er.toFixed(3).padStart(6)} ${(f.ac1 >= 0 ? "+" : "") + f.ac1.toFixed(3)} ${f.vold.toFixed(0).padStart(9)} ${f.beta.toFixed(2).padStart(8)}`);
  }
  console.log("-".repeat(80));

  // Khả năng tách good vs bad (bỏ noisy): khoảng [min,max] có chồng lấn không?
  const G = feats.filter((f) => f.label === "good");
  const B = feats.filter((f) => f.label === "bad");
  const metrics: [string, (f: Feat) => number][] = [
    ["vol%/d", (f) => f.vol], ["ER", (f) => f.er], ["ac1", (f) => f.ac1], ["vol$M/d", (f) => f.vold], ["betaBTC", (f) => f.beta],
  ];
  console.log("\nKHẢ NĂNG TÁCH good vs bad (4 good / 5 bad — mẫu NHỎ, đọc thận trọng):");
  for (const [name, fn] of metrics) {
    const g = G.map(fn), b = B.map(fn);
    const gMin = Math.min(...g), gMax = Math.max(...g), bMin = Math.min(...b), bMax = Math.max(...b);
    const cleanHigh = gMin > bMax; // good luôn CAO hơn bad
    const cleanLow = gMax < bMin;  // good luôn THẤP hơn bad
    const verdict = cleanHigh ? `TÁCH SẠCH: good > ${bMax.toFixed(3)} > bad ✅`
      : cleanLow ? `TÁCH SẠCH: good < ${bMin.toFixed(3)} < bad ✅`
      : "chồng lấn (không tách được)";
    console.log(`  ${name.padEnd(9)} good[${gMin.toFixed(2)}..${gMax.toFixed(2)}]  bad[${bMin.toFixed(2)}..${bMax.toFixed(2)}]  → ${verdict}`);
  }
  console.log("\nGhi chú: tách sạch trên 9 coin là gợi ý, KHÔNG phải bằng chứng mạnh. Cần xác nhận");
  console.log("trên coin mới (ngoài 12) trước khi dùng đặc trưng đó làm luật chọn rổ.\n");
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
