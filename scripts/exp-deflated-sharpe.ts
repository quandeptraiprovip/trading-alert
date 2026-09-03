/**
 * exp-deflated-sharpe.ts — BA LỖ HỔNG NỀN TẢNG của mọi con số trong repo, đo bằng văn liệu.
 *
 * Mọi bảng tôi (và repo) đưa ra đều là ƯỚC LƯỢNG ĐIỂM, lấy từ MỘT đường giá, trên MỘT rổ chọn bằng
 * hindsight, SAU hàng trăm lần thử. Ba lỗ hổng đó có công cụ định lượng sẵn trong văn liệu:
 *
 * ─── L1. THIÊN LỆCH CHỌN LỌC — Deflated Sharpe Ratio ───
 * Bailey & López de Prado (2014), "The Deflated Sharpe Ratio". Chạy N cấu hình rồi giữ cái tốt nhất
 * thì Sharpe cao nhất là một THỐNG KÊ CỰC TRỊ, không phải kỳ vọng. Kỳ vọng của max dưới N phép thử:
 *     E[max SR] ≈ √V[SR] · [ (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ] ,  γ = Euler–Mascheroni
 * DSR là xác suất Sharpe quan sát được vượt ngưỡng đó, ĐÃ hiệu chỉnh cho skew/kurtosis:
 *     DSR = Z[ (SR − SR₀)·√(T−1) / √(1 − γ₃·SR + ((γ₄−1)/4)·SR²) ]
 * DSR < 0,95 nghĩa là KHÔNG bác bỏ được giả thuyết "đây chỉ là cái tốt nhất trong N lần thử ngẫu nhiên".
 *
 * ─── L2. ĐỘ DÀI BACKTEST TỐI THIỂU — MinBTL ───
 * Bailey và cộng sự (2014), "Pseudo-Mathematics and Financial Charlatanism". Với N phép thử, cần
 *     MinBTL ≈ 2·ln(N) / SR_năm²   (năm)
 * để Sharpe quan sát không phải hiện vật chọn lọc. So với 5,5 năm dữ liệu đang có.
 *
 * ─── L3. MỘT ĐƯỜNG GIÁ — bootstrap khối ───
 * maxDD và CAGR là thống kê CỰC TRỊ trên MỘT lịch sử; sai số chuẩn của chúng rất lớn và chưa bao giờ
 * được báo cáo. Bootstrap KHỐI (giữ block 20 ngày) để bảo toàn tự tương quan của chuỗi trend-following,
 * rồi lấy phân vị. Bootstrap iid sẽ phá cấu trúc chuỗi và cho khoảng tin cậy HẸP GIẢ TẠO.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-deflated-sharpe.ts [days]
 */
import fs from "fs";
import path from "path";
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitCtx, AdmitFn, Book, ExtParams, EquityPoint, compoundedEquity, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow } from "./exp-breadth";

const EULER = 0.5772156649015329;
/** Rổ ứng viên có cache 4h — dùng để lấy mẫu rổ ngẫu nhiên cho V[SR]. */
const ALT_POOL = ["adausdt","avaxusdt","bchusdt","btcusdt","dogeusdt","dotusdt","eosusdt","etcusdt","ethusdt","filusdt","linkusdt","ltcusdt","nearusdt","neousdt","solusdt","thetausdt","trxusdt","uniusdt","vetusdt","xlmusdt","xmrusdt","xrpusdt","zecusdt","atomusdt","algousdt","aaveusdt","compusdt","crvusdt","dashusdt","egldusdt","grtusdt","hbarusdt","iotausdt","ksmusdt","manausdt","omgusdt","ontusdt","qtumusdt","sandusdt","snxusdt","sushiusdt","zilusdt"];
const DAY = 86400e3;
const cachePath = (s: string) => path.join(process.cwd(), ".cache", "klines", "futures", `${s}_4h.json`);
const readCached = (s: string): Candle[] => JSON.parse(fs.readFileSync(cachePath(s), "utf8")) as Candle[];

/** erf theo Abramowitz–Stegun 7.1.26 (sai số < 1,5e-7). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-ax * ax);
  return sign * y;
}
/** Φ(x) = ½(1 + erf(x/√2)). */
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
/** Nghịch đảo CDF chuẩn — Acklam. Sai số < 1,15e-9, thừa đủ cho mục đích ở đây. */
function normInv(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

interface Moments { n: number; mean: number; sd: number; skew: number; kurt: number; sharpeD: number; sharpeA: number }
function moments(r: number[]): Moments {
  const n = r.length;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  const m2 = r.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const m3 = r.reduce((s, x) => s + (x - mean) ** 3, 0) / n;
  const m4 = r.reduce((s, x) => s + (x - mean) ** 4, 0) / n;
  const sd = Math.sqrt(m2);
  const sharpeD = sd > 0 ? mean / sd : 0;
  return { n, mean, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3, sharpeD, sharpeA: sharpeD * Math.sqrt(365) };
}

/** E[max SR] dưới N phép thử độc lập, mỗi phép có độ lệch chuẩn Sharpe = sdSR (đơn vị NGÀY). */
function expectedMaxSharpe(N: number, sdSR: number): number {
  if (N <= 1) return 0;
  return sdSR * ((1 - EULER) * normInv(1 - 1 / N) + EULER * normInv(1 - 1 / (N * Math.E)));
}

/** DSR: xác suất Sharpe thật > SR₀, hiệu chỉnh skew/kurtosis (Bailey & López de Prado 2014). */
function deflatedSharpe(m: Moments, sr0: number): number {
  const denom = Math.sqrt(Math.max(1e-12, 1 - m.skew * m.sharpeD + ((m.kurt - 1) / 4) * m.sharpeD ** 2));
  return normCdf(((m.sharpeD - sr0) * Math.sqrt(m.n - 1)) / denom);
}

/** Bootstrap KHỐI: giữ block liền kề để bảo toàn tự tương quan. */
function blockBootstrap(r: number[], blockLen: number, iters: number, rnd: () => number): number[][] {
  const out: number[][] = [];
  const nBlocks = Math.ceil(r.length / blockLen);
  for (let i = 0; i < iters; i++) {
    const s: number[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rnd() * Math.max(1, r.length - blockLen));
      for (let j = 0; j < blockLen && s.length < r.length; j++) s.push(r[start + j]);
    }
    out.push(s);
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
}

/** Chuỗi P&L NGÀY theo R từ equity mark-to-market. */
function dailyR(eq: EquityPoint[], from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < eq.length; i++) {
    if (eq[i].time < from || eq[i].time > to) continue;
    const d = Math.floor(eq[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
  }
  return [...m.keys()].sort((a, b) => a - b).map((d) => m.get(d)!);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  void days;
  // Đọc CORE8 từ cache (Binance đang chặn IP sau loạt fetch trước — và phép đo này không cần dữ liệu mới).
  const data = new Map<string, Candle[]>();
  for (const s of CORE8) data.set(s, readCached(s));
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { turtle } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const years = (w.to - w.from) / (365.25 * DAY);
  const snap: Partial<ExtParams> = { admitBarSnapshot: true };
  const books = (): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));
  const heat = (k: number): AdmitFn => (c: AdmitCtx) => (k > 0 ? 1 / (1 + c.sameDirHeat / k) : 1);

  console.log(`Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} (${years.toFixed(1)} năm)\n`);

  const base = dailyR(runBooks(books(), heat(T.heatDecayK)).equity, w.from, w.to);
  const m = moments(base);
  console.log("═══ CHUỖI GỐC (sổ Turtle, k=4, CORE8) ═══");
  console.log(`n = ${m.n} ngày · Sharpe năm ${m.sharpeA.toFixed(2)} · skew ${m.skew.toFixed(2)} · kurtosis ${m.kurt.toFixed(1)}`);
  console.log(`  (kurtosis > 3 và skew ≠ 0 ⇒ Sharpe thường bị THỔI, DSR hiệu chỉnh đúng chỗ này)\n`);

  // ── V[SR] GIỮA CÁC PHÉP THỬ ──
  // BẪY ĐÃ MẮC: đo V[SR] trên các biến thể `k` cho sd ≈ 0,04/năm và DSR = 1,000 ở MỌI N — vô nghĩa,
  // vì 7 biến thể đó gần như trùng nhau (cùng luật, cùng rổ, khác một tham số). DSR đòi phương sai
  // giữa các phép thử ĐỘC LẬP. Chiều chọn lọc THẬT của repo là RỔ COIN: [[core8-selection-bias]] ghi
  // CORE8 = 1,58 còn rổ 8 coin ngẫu nhiên = 0,88. Nên V[SR] phải đo trên các rổ ngẫu nhiên.
  // ĐỌC THẲNG CACHE, KHÔNG GỌI MẠNG. `loadPool` gọi API cho từng symbol; 24 rổ × 8 symbol làm
  // Binance trả 429 rồi 418 (cấm IP tạm thời), và nó NUỐT lỗi mạng — rổ thiếu symbol vẫn chạy tiếp
  // và cho ra Sharpe sai. Đúng bẫy đã ghi trong universe-expansion-rejected.
  const rndU = mulberry32(777);
  const pool = ALT_POOL.filter((s) => !CORE8.includes(s) && fs.existsSync(cachePath(s)));
  const basketSharpes: number[] = [];
  let skipped = 0;
  for (let i = 0; i < 24; i++) {
    const shuffled = [...pool];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const t2 = Math.floor(rndU() * (j + 1));
      [shuffled[j], shuffled[t2]] = [shuffled[t2], shuffled[j]];
    }
    const pick = shuffled.slice(0, 8);
    const d = new Map<string, Candle[]>();
    for (const s of pick) {
      const c = readCached(s);
      if (c.length > 2000) d.set(s, c);
    }
    if (d.size < 8) { skipped++; continue; } // rổ thiếu ⇒ BỎ, không âm thầm chạy với ít coin hơn
    const from = Math.max(...[...d.values()].map((c) => c[0].openTime)) + (T.btcGateSlow + 200) * TF_MS["4h"];
    const to = Math.min(...[...d.values()].map((c) => c[c.length - 1].openTime));
    const bk: Book[] = [...d.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p: { ...turtle, ...snap } }));
    const s = moments(dailyR(runBooks(bk, heat(T.heatDecayK)).equity, from, to));
    if (s.n > 300) basketSharpes.push(s.sharpeD);
  }
  if (skipped) console.log(`  (bỏ ${skipped} rổ vì thiếu cache — KHÔNG chạy với rổ khuyết)`);
  const meanB = basketSharpes.reduce((a, b) => a + b, 0) / basketSharpes.length;
  const sdSR = Math.sqrt(basketSharpes.reduce((s, x) => s + (x - meanB) ** 2, 0) / basketSharpes.length);
  const annB = basketSharpes.map((x) => x * Math.sqrt(365)).sort((a, b) => a - b);
  console.log(
    `V[SR] đo trên ${basketSharpes.length} RỔ 8 COIN NGẪU NHIÊN (chiều chọn lọc thật):\n` +
    `  Sharpe năm: TB ${(meanB * Math.sqrt(365)).toFixed(2)} · min ${annB[0].toFixed(2)} · max ${annB[annB.length - 1].toFixed(2)}\n` +
    `  độ lệch chuẩn Sharpe NGÀY = ${sdSR.toFixed(4)} (≈ ${(sdSR * Math.sqrt(365)).toFixed(2)} theo năm)\n` +
    `  ⇒ CORE8 (${m.sharpeA.toFixed(2)}) cao hơn rổ ngẫu nhiên trung bình ${(m.sharpeA - meanB * Math.sqrt(365)).toFixed(2)} Sharpe\n`,
  );

  console.log("═══ L1 — DEFLATED SHARPE RATIO theo số phép thử N ═══");
  console.log("N".padStart(7) + "SR₀ kỳ vọng (năm)".padStart(20) + "DSR".padStart(10) + "  kết luận");
  for (const N of [1, 10, 50, 100, 500, 1000, 2000]) {
    const sr0 = expectedMaxSharpe(N, sdSR);
    const dsr = deflatedSharpe(m, sr0);
    console.log(
      String(N).padStart(7) + (sr0 * Math.sqrt(365)).toFixed(2).padStart(20) + dsr.toFixed(3).padStart(10) +
      (dsr >= 0.95 ? "  ✅ vượt ngưỡng chọn lọc" : dsr >= 0.9 ? "  ⚠️ ranh giới" : "  ❌ KHÔNG phân biệt được với may mắn"),
    );
  }

  console.log("\n═══ L2 — ĐỘ DÀI BACKTEST TỐI THIỂU (MinBTL) ═══");
  console.log("N".padStart(7) + "MinBTL (năm)".padStart(16) + "  có 5,5 năm — đủ chưa?");
  for (const N of [10, 50, 100, 500, 1000, 2000]) {
    const minbtl = (2 * Math.log(N)) / m.sharpeA ** 2;
    console.log(String(N).padStart(7) + minbtl.toFixed(1).padStart(16) + (minbtl <= years ? "  ✅ đủ" : `  ❌ THIẾU ${(minbtl - years).toFixed(1)} năm`));
  }

  console.log("\n═══ L3 — BOOTSTRAP KHỐI (block 20 ngày, 2000 lần) ═══");
  const rnd = mulberry32(20260813);
  const samples = blockBootstrap(base, 20, 2000, rnd);
  const shs = samples.map((s) => moments(s).sharpeA).sort((a, b) => a - b);
  const dds = samples.map((s) => {
    let e = 0, peak = 0, dd = 0;
    for (const x of s) { e += x; peak = Math.max(peak, e); dd = Math.max(dd, peak - e); }
    return dd;
  }).sort((a, b) => a - b);
  const nets = samples.map((s) => s.reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  let e0 = 0, pk0 = 0, dd0 = 0;
  for (const x of base) { e0 += x; pk0 = Math.max(pk0, e0); dd0 = Math.max(dd0, pk0 - e0); }
  console.log("thước".padEnd(14) + "quan sát".padStart(10) + "5%".padStart(10) + "50%".padStart(10) + "95%".padStart(10) + "  bề rộng KTC");
  console.log("Sharpe năm".padEnd(14) + m.sharpeA.toFixed(2).padStart(10) + pct(shs, 0.05).toFixed(2).padStart(10) +
    pct(shs, 0.5).toFixed(2).padStart(10) + pct(shs, 0.95).toFixed(2).padStart(10) +
    `  ±${((pct(shs, 0.95) - pct(shs, 0.05)) / 2).toFixed(2)}`);
  console.log("maxDD (R)".padEnd(14) + dd0.toFixed(0).padStart(10) + pct(dds, 0.05).toFixed(0).padStart(10) +
    pct(dds, 0.5).toFixed(0).padStart(10) + pct(dds, 0.95).toFixed(0).padStart(10) +
    `  ×${(pct(dds, 0.95) / Math.max(1, pct(dds, 0.05))).toFixed(1)} giữa hai đầu`);
  console.log("NET R".padEnd(14) + base.reduce((a, b) => a + b, 0).toFixed(0).padStart(10) + pct(nets, 0.05).toFixed(0).padStart(10) +
    pct(nets, 0.5).toFixed(0).padStart(10) + pct(nets, 0.95).toFixed(0).padStart(10));
  console.log(`  P(Sharpe ≤ 0) = ${(shs.filter((x) => x <= 0).length / shs.length * 100).toFixed(1)}%`);

  // ── L4. HỆ QUẢ TRỰC TIẾP LÊN KHUYẾN NGHỊ RISK/UNIT ──
  // `exp-growth-frontier.ts` chọn risk/unit dựa trên MỘT quan sát maxDD (72R). Nếu ca xấu thực tế là
  // 148R thì mọi mức risk ở đó đều quá cao. Đây là phép đo lại đúng: chạy CỘNG DỒN trên từng mẫu
  // bootstrap để lấy PHÂN PHỐI của mức sụt và xác suất cháy tài khoản.
  const ruinTable = (title: string, ss: number[][], risks: number[]) => {
    console.log(title);
    console.log("risk/unit".padEnd(11) + "sụt 50%".padStart(10) + "sụt 95%".padStart(10) +
      "P(sụt>50%)".padStart(12) + "P(sụt>80%)".padStart(12) + "P(CHÁY)".padStart(10));
    for (const r of risks) {
      const dd: number[] = [];
      let ruin = 0, over50 = 0, over80 = 0;
      for (const s of ss) {
        let e = 1, peak = 1, mx = 0, dead = false;
        for (const x of s) {
          e *= 1 + x * r;
          if (e <= 0) { dead = true; break; }
          peak = Math.max(peak, e);
          mx = Math.max(mx, (peak - e) / peak);
        }
        if (dead || mx >= 0.999) { ruin++; mx = 1; }
        dd.push(mx);
        if (mx > 0.5) over50++;
        if (mx > 0.8) over80++;
      }
      dd.sort((a, b) => a - b);
      console.log(
        `${(r * 100).toFixed(2)}%`.padEnd(11) + `${(pct(dd, 0.5) * 100).toFixed(0)}%`.padStart(10) +
        `${(pct(dd, 0.95) * 100).toFixed(0)}%`.padStart(10) +
        `${(over50 / ss.length * 100).toFixed(0)}%`.padStart(12) +
        `${(over80 / ss.length * 100).toFixed(0)}%`.padStart(12) +
        `${(ruin / ss.length * 100).toFixed(1)}%`.padStart(10),
      );
    }
  };
  ruinTable("\n═══ L4 — SỤT CỘNG DỒN & XÁC SUẤT CHÁY, trên 2000 đường giá bootstrap (k=4 đang chạy) ═══",
    samples, [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02]);

  // ── L4b — ỨNG VIÊN SIẾT k ──
  // `exp-floor-policy` cho thấy siết k chỉ hơn ở LÃI/SỤT; muốn đổi ra tiền phải nâng risk/unit để
  // kéo mức sụt về ngang cấu hình đang chạy (k=1 sụt 23% vs 38% ⇒ hệ số ~1,65 ⇒ risk ~0,83%).
  // Câu hỏi quyết định: mức risk đó có sống qua bootstrap không?
  for (const k of [1, 0.5]) {
    const cand = dailyR(runBooks(books(), heat(k)).equity, w.from, w.to);
    ruinTable(`\n═══ L4b — cùng phép đó cho ỨNG VIÊN k=${k} ═══`,
      blockBootstrap(cand, 20, 2000, mulberry32(20260813)), [0.005, 0.0075, 0.0083, 0.01, 0.0125, 0.015]);
  }

  void compoundedEquity;
  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• DSR trả lời: \"sau N lần thử, Sharpe này có phân biệt được với cái tốt nhất của N chuỗi vô\n" +
    "  dụng không?\". N thật của repo này KHÔNG nhỏ — 77 file thí nghiệm, mỗi file quét hàng chục cấu\n" +
    "  hình. Hãy đọc hàng N = 500–2000, đừng đọc hàng N = 10.\n" +
    "• MinBTL trả lời: \"5,5 năm có đủ dài để kết luận không?\". Thiếu thì mọi phép kiểm khác đều yếu.\n" +
    "• Bootstrap khối trả lời: \"ước lượng điểm này rộng cỡ nào?\". Bề rộng KTC của maxDD là con số\n" +
    "  cần nhất — mọi quyết định risk/unit ở các bảng trước đều dựa trên MỘT quan sát maxDD.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
