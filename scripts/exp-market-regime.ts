/**
 * exp-market-regime.ts — thị trường 2026 khác các năm trước ở CHỖ NÀO, đo bằng đại lượng
 * ĐỘC LẬP VỚI CHIẾN LƯỢC (không dùng luật Turtle/Fast), để tách "luật hỏng" khỏi "hiện tượng yếu đi".
 *
 * Bốn thước đo, mỗi cái trả lời một câu hỏi khác nhau:
 *
 *   M1 VARIANCE RATIO — thước đo kinh điển của "giá có xu hướng hay quay đầu" (Lo & MacKinlay 1988).
 *      VR(q) = Var(lợi suất q ngày) / (q × Var(lợi suất 1 ngày)). Bước ngẫu nhiên ⇒ VR = 1;
 *      VR > 1 ⇒ có động lượng (trend-following có đất sống); VR < 1 ⇒ quay đầu (trend chết).
 *      Đây là điều kiện CẦN của mọi hệ trend, đo mà không cần biết luật vào lệnh nào.
 *
 *   M2 FOLLOW-THROUGH — sau MỘT tín hiệu phá vỡ thô (close vượt đỉnh close 15 ngày), giá chạm
 *      +3×ATR trước hay −3×ATR trước? Tỉ lệ này là "chất lượng nguyên liệu thô" của breakout,
 *      không dính stop/pyramid/phí của hệ. Nếu tỉ lệ này tụt thì lỗi ở thị trường, không ở luật.
 *
 *   M3 BIÊN ĐỘ & PHÍ TƯƠNG ĐỐI — ATR%/giá quyết định phí ăn bao nhiêu phần của mỗi R.
 *
 *   M4 TƯƠNG QUAN RỔ — corr trung bình cặp trong rổ. Corr cao ⇒ 8 coin chỉ là 1 cược,
 *      đa dạng hoá biến mất đúng lúc cần nhất.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-market-regime.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, ema } from "../turtle";
import { CORE8, loadPool } from "./exp-breadth";

const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

/** Gộp nến 4h thành nến ngày (UTC). */
function toDaily(c: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curDay = -1;
  for (const b of c) {
    const d = Math.floor(b.openTime / TF_MS["1d"]);
    if (d !== curDay) {
      if (cur) out.push(cur);
      cur = { ...b, openTime: d * TF_MS["1d"] };
      curDay = d;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.quoteVolume += b.quoteVolume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const yearOf = (t: number) => new Date(t).getUTCFullYear();

/** M1 — Variance ratio trên lợi suất log NGÀY. */
function varianceRatio(rets: number[], q: number): number {
  const n = rets.length;
  if (n < q * 4) return NaN;
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const v1 = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  if (v1 <= 0) return NaN;
  // lợi suất q ngày chồng lấn (overlapping) + hiệu chỉnh mẫu chuẩn Lo-MacKinlay
  const agg: number[] = [];
  for (let i = 0; i + q <= n; i++) {
    let s = 0;
    for (let k = 0; k < q; k++) s += rets[i + k];
    agg.push(s);
  }
  const m = agg.reduce((s, x) => s + x, 0) / agg.length;
  const vq = agg.reduce((s, x) => s + (x - m) ** 2, 0) / (agg.length - 1);
  return vq / (q * v1);
}

/**
 * M2 — chất lượng breakout THÔ: tại nến phá đỉnh close 15 ngày (và trên EMA50), theo dõi tới khi
 * chạm +mult×ATR (thắng) hoặc −mult×ATR (thua) trước. Không stop, không pyramid, không phí.
 * Làm cả chiều SHORT bằng gương đối xứng.
 */
function followThrough(c: Candle[], dir: "long" | "short", lookbackDays = 15, mult = 3, maxBars = 90) {
  const bpd = TF_MS["1d"] / TF_MS["4h"];
  const len = Math.round(lookbackDays * bpd);
  const atr = atrSeries(c, T.atrPeriod);
  const emaArr = ema(c.map((x) => x.close), T.trendLen);
  const byYear = new Map<number, { win: number; loss: number; open: number; sumBars: number }>();
  for (let i = len + T.trendLen; i < c.length; i++) {
    let ext = dir === "long" ? -Infinity : Infinity;
    for (let k = i - len; k < i; k++) ext = dir === "long" ? Math.max(ext, c[k].close) : Math.min(ext, c[k].close);
    const trendOk = dir === "long" ? c[i].close > emaArr[i] : c[i].close < emaArr[i];
    const brk = dir === "long" ? c[i].close > ext : c[i].close < ext;
    if (!brk || !trendOk || !(atr[i] > 0)) continue;
    const e = c[i].close;
    const up = e + mult * atr[i];
    const dn = e - mult * atr[i];
    const y = yearOf(c[i].openTime);
    if (!byYear.has(y)) byYear.set(y, { win: 0, loss: 0, open: 0, sumBars: 0 });
    const rec = byYear.get(y)!;
    let done = false;
    for (let j = i + 1; j < Math.min(c.length, i + maxBars * bpd); j++) {
      const hitUp = c[j].high >= up;
      const hitDn = c[j].low <= dn;
      // chạm cả hai trong cùng nến ⇒ tính là THUA (bảo thủ, không biết thứ tự intrabar)
      if (hitUp && hitDn) { dir === "long" ? rec.loss++ : rec.loss++; rec.sumBars += j - i; done = true; break; }
      if (hitUp) { dir === "long" ? rec.win++ : rec.loss++; rec.sumBars += j - i; done = true; break; }
      if (hitDn) { dir === "long" ? rec.loss++ : rec.win++; rec.sumBars += j - i; done = true; break; }
    }
    if (!done) rec.open++;
  }
  return byYear;
}

function mean(a: number[]) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  console.log(`Rổ: ${[...data.keys()].join(", ")}\n`);

  const daily = new Map<string, Candle[]>();
  for (const [s, c] of data) daily.set(s, toDaily(c));

  // ── M1: VARIANCE RATIO theo năm ──
  console.log("=".repeat(104));
  console.log("  M1 — VARIANCE RATIO (lợi suất log ngày). >1 = có xu hướng · =1 bước ngẫu nhiên · <1 = quay đầu");
  console.log("=".repeat(104));
  console.log("năm     VR(5)   VR(10)  VR(20)   |  BTC riêng: VR(5)/VR(10)/VR(20)   |  số coin");
  console.log("-".repeat(104));
  for (const y of YEARS) {
    const vrs: Record<number, number[]> = { 5: [], 10: [], 20: [] };
    let btcCell = "—";
    for (const [sym, c] of daily) {
      const yr = c.filter((b) => yearOf(b.openTime) === y);
      if (yr.length < 120) continue;
      const rets: number[] = [];
      for (let i = 1; i < yr.length; i++) rets.push(Math.log(yr[i].close / yr[i - 1].close));
      const cell: number[] = [];
      for (const q of [5, 10, 20]) {
        const v = varianceRatio(rets, q);
        if (Number.isFinite(v)) vrs[q].push(v);
        cell.push(v);
      }
      if (sym === "btcusdt") btcCell = cell.map((x) => x.toFixed(2)).join("/");
    }
    console.log(
      `${y}   ${mean(vrs[5]).toFixed(2).padStart(5)}   ${mean(vrs[10]).toFixed(2).padStart(5)}   ${mean(vrs[20]).toFixed(2).padStart(5)}` +
        `   |         ${btcCell.padEnd(20)}  |    ${vrs[5].length}`,
    );
  }

  // ── M2: FOLLOW-THROUGH của breakout thô ──
  for (const dir of ["long", "short"] as const) {
    console.log("\n" + "=".repeat(104));
    console.log(`  M2 — FOLLOW-THROUGH ${dir.toUpperCase()} thô: sau phá vỡ close-15d (+ lọc EMA50), chạm ±3×ATR bên nào trước?`);
    console.log("=".repeat(104));
    console.log("năm    tín hiệu   thắng   thua   chưa xong   TỈ LỆ THẮNG   (kỳ vọng bước ngẫu nhiên ≈ 50%)");
    console.log("-".repeat(104));
    for (const y of YEARS) {
      let win = 0, loss = 0, open = 0;
      for (const [, c] of data) {
        const m = followThrough(c, dir);
        const r = m.get(y);
        if (!r) continue;
        win += r.win; loss += r.loss; open += r.open;
      }
      const n = win + loss;
      const bar = n ? "█".repeat(Math.round((win / n) * 40)) : "";
      console.log(
        `${y}   ${String(win + loss + open).padStart(6)}   ${String(win).padStart(5)}  ${String(loss).padStart(5)}   ${String(open).padStart(9)}   ` +
          `${n ? ((win / n) * 100).toFixed(1).padStart(6) : "   —  "}%   ${bar}`,
      );
    }
  }

  // ── M3 + M4: biên độ và tương quan ──
  console.log("\n" + "=".repeat(104));
  console.log("  M3/M4 — BIÊN ĐỘ (ATR20%/giá, nến 4h) và TƯƠNG QUAN TRUNG BÌNH CẶP (lợi suất ngày)");
  console.log("=".repeat(104));
  console.log("năm    ATR%    phí/1R (*)   corr TB cặp   BTC lợi suất năm");
  console.log("-".repeat(104));
  for (const y of YEARS) {
    const atrs: number[] = [];
    for (const [, c] of data) {
      const a = atrSeries(c, T.atrPeriod);
      for (let i = 0; i < c.length; i++) if (yearOf(c[i].openTime) === y && a[i] > 0) atrs.push((a[i] / c[i].close) * 100);
    }
    // corr trung bình cặp trên lợi suất NGÀY
    const series: number[][] = [];
    const keys = [...daily.keys()];
    let common: number[] = [];
    for (const s of keys) {
      const yr = daily.get(s)!.filter((b) => yearOf(b.openTime) === y);
      if (yr.length < 120) continue;
      const r: number[] = [];
      for (let i = 1; i < yr.length; i++) r.push(Math.log(yr[i].close / yr[i - 1].close));
      series.push(r);
      common.push(r.length);
    }
    const L = series.length ? Math.min(...common) : 0;
    let corrSum = 0, pairs = 0;
    for (let i = 0; i < series.length; i++) {
      for (let j = i + 1; j < series.length; j++) {
        const a = series[i].slice(-L), b = series[j].slice(-L);
        const ma = mean(a), mb = mean(b);
        let num = 0, da = 0, db = 0;
        for (let k = 0; k < L; k++) { num += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
        if (da > 0 && db > 0) { corrSum += num / Math.sqrt(da * db); pairs++; }
      }
    }
    const btcY = daily.get("btcusdt")!.filter((b) => yearOf(b.openTime) === y);
    const btcRet = btcY.length > 1 ? (btcY[btcY.length - 1].close / btcY[0].close - 1) * 100 : NaN;
    const atrPct = mean(atrs);
    // phí một vòng = 2×(taker+slip) = 0,14%; R danh nghĩa = 3×ATR ⇒ phí/1R
    const feePerR = (0.14 / (3 * atrPct)) * 100;
    console.log(
      `${y}   ${atrPct.toFixed(2).padStart(5)}   ${feePerR.toFixed(1).padStart(8)}%   ${(pairs ? corrSum / pairs : NaN).toFixed(2).padStart(11)}   ${btcRet.toFixed(0).padStart(12)}%`,
    );
  }
  console.log("\n(*) phí/1R = phí vòng 0,14% giá chia cho R danh nghĩa 3×ATR — phần mỗi R bị phí ăn mất.");
}

if (require.main === module && /exp-market-regime\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
