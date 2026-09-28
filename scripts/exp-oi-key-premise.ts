/**
 * A1 — "KEY CÓ ĐỊNH DANH": mệnh đề gốc của Key, tách theo Open Interest của nến tạo key.
 * Protocol (khoá trước, commit 8dbfadd + phụ lục 4e20545): planning/oi-footprint-preregistration-2026-09-28.md
 *
 * Câu hỏi: volume nến không nói được ai tạo ra nó. ΔOI thì nói được — OI TĂNG trong nến volume đột
 * biến = có người MỞ vị thế mới (có lý do bảo vệ mức); OI GIẢM = vị thế bị ĐÓNG/thanh lý. Nếu Key có
 * giá trị thì nó phải nằm ở nhóm MỞ.
 *
 * Sao y logic của `exp-key-premise-m15.ts` (Cửa 2) và `exp-key-barrier-m15.ts` (Cửa 3) — không import
 * được vì file đó gọi main() khi bị import. Cấu hình CỐ ĐỊNH đúng lần chạy 28/08 (phụ lục 1), không lấy
 * từ KEY_VOLUME_CONFIG hiện tại (đã đổi volumeLookback 96→12 sau 01/09).
 *
 * ĐỐI CHỨNG ĐI QUA CÙNG BỘ TÁCH: nhóm normal và syn cũng được tách MỞ/ĐÓNG theo ΔOI của chính nến gốc
 * của chúng — nếu nến thường có OI tăng cũng "phản ứng" như vậy thì đó là hiệu ứng của OI, không của Key.
 *
 * Chạy:
 *   ./node_modules/.bin/ts-node scripts/exp-oi-key-premise.ts gate0   ← chỉ đếm nhãn + biên, KHÔNG in kết cục
 *   ./node_modules/.bin/ts-node scripts/exp-oi-key-premise.ts gate1
 */
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS, aggregate } from "../strategy";
import { MetricRow, daysBetween, loadMetricsDays, rowAt } from "./oi-metrics";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const DAYS = 400;
const MULTS = [2, 6, 12];
// ── cấu hình 28/08 (phụ lục 1) ──
const VOL_LOOKBACK = 96;
const KEY_TOUCH_ATR = 0.2;
const KEY_MAX_AGE_DAYS = 180;
const FWD = 12;
const MAX_LEVELS = 6000;
const AWAY_ATR = 1.0;
const BOUNCE_ATR = 0.5;
const REACT_BARS = 6;
const MAX_WAIT = 4 * 24 * 7;
const LOCAL_N = 5;
// ── cửa đậu (chốt 28/08) + Bonferroni 3 giả thuyết ──
const PASS_ATR = 0.246;
const Z = 2.39;
const STOP_ATR = 2.1;
const TARGET_R = 4;
const COST_R = 0.246;
const MAX_HOLD = 4 * 24 * 7;

type Rung = "R0" | "R4" | "R5loc";
type Kind = "spike" | "normal" | "syn";
type Label = "MO" | "DONG";

interface Group { n: number; sum: number; sumSq: number; wins: number }
const empty = (): Group => ({ n: 0, sum: 0, sumSq: 0, wins: 0 });
const add = (g: Group, x: number): void => { g.n++; g.sum += x; g.sumSq += x * x; if (x > 0) g.wins++; };
const merge = (d: Group, s: Group): void => { d.n += s.n; d.sum += s.sum; d.sumSq += s.sumSq; d.wins += s.wins; };
const mean = (g: Group) => (g.n ? g.sum / g.n : 0);
const sd = (g: Group) => Math.sqrt(Math.max(0, g.sumSq / Math.max(1, g.n) - mean(g) ** 2));
const half = (g: Group, z = Z) => (g.n < 2 ? Infinity : (z * sd(g)) / Math.sqrt(g.n));
const wr = (g: Group) => (g.n ? (100 * g.wins) / g.n : 0);
const ciWr = (g: Group, z = Z) => {
  if (!g.n) return Infinity;
  const p = g.wins / g.n;
  return 100 * z * Math.sqrt(Math.max(1e-9, (p * (1 - p)) / g.n));
};

function atr14(c: Candle[]): number[] {
  const out = new Array<number>(c.length).fill(0);
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    prev = i === 1 ? tr : prev + (tr - prev) / 14;
    out[i] = prev;
  }
  return out;
}

function medianOf(values: number[], from: number, to: number): number {
  const s = values.slice(Math.max(0, from), to).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

/** Sao y exp-key-premise-m15.ts: nến sớm nhất mức được dùng theo bậc; −1 = loại. */
function usableFrom(c: Candle[], atr: number[], i: number, price: number, rung: Rung): number {
  if (rung === "R0") return i + 2;
  const tol = KEY_TOUCH_ATR * atr[i];
  const hi = price + tol;
  const lo = price - tol;
  const end = Math.min(c.length - 1, i + MAX_WAIT);
  let side = 0;
  let j = i + 1;
  for (; j <= end; j++) {
    if (!(atr[j] > 0)) continue;
    if (c[j].low > hi + AWAY_ATR * atr[j]) { side = 1; break; }
    if (c[j].high < lo - AWAY_ATR * atr[j]) { side = -1; break; }
  }
  if (side === 0) return -1;
  let touched = -1;
  for (let k = j + 1; k <= end; k++) {
    if (!(atr[k] > 0)) continue;
    if (touched < 0) {
      if (c[k].low <= hi && c[k].high >= lo) { touched = k; continue; }
      if (side === 1 ? c[k].close < lo : c[k].close > hi) return -1;
      continue;
    }
    if (k - touched > REACT_BARS) return -1;
    if (side === 1 ? c[k].close < lo : c[k].close > hi) return -1;
    const bounced = side === 1 ? c[k].close > hi + BOUNCE_ATR * atr[k] : c[k].close < lo - BOUNCE_ATR * atr[k];
    if (bounced) return k + 1;
  }
  return -1;
}

/** Sao y exp-key-barrier-m15.ts. Nến chạm cả hai ⇒ STOP trước. */
function walkBarrier(c: Candle[], entryIndex: number, dir: number, risk: number): number | null {
  if (!(risk > 0)) return null;
  const entry = c[entryIndex].close;
  const stop = entry - dir * risk;
  const target = entry + dir * TARGET_R * risk;
  const end = Math.min(c.length - 1, entryIndex + MAX_HOLD);
  for (let i = entryIndex + 1; i <= end; i++) {
    if (dir > 0 ? c[i].low <= stop : c[i].high >= stop) return -1;
    if (dir > 0 ? c[i].high >= target : c[i].low <= target) return TARGET_R;
  }
  return (dir * (c[end].close - entry)) / risk;
}

interface Series { symbol: string; c: Candle[]; atr: number[]; vol: number[]; label: (Label | null)[] }

/** ΔOI của nến M15 = OI(open+15m) − OI(open). null = thiếu snapshot hoặc ΔOI = 0 (bị loại, có đếm). */
function labelBars(c: Candle[], byTime: Map<number, MetricRow>): (Label | null)[] {
  return c.map((bar) => {
    const a = rowAt(byTime, bar.openTime);
    const b = rowAt(byTime, bar.openTime + TF_MS["15m"]);
    if (!a || !b || !(a.oi > 0) || !(b.oi > 0) || b.oi === a.oi) return null;
    return b.oi > a.oi ? "MO" : "DONG";
  });
}

interface Tally { MO: Group; DONG: Group; excluded: number }
const emptyTally = (): Tally => ({ MO: empty(), DONG: empty(), excluded: 0 });

/**
 * Cùng bộ chọn sự kiện + stride như bản 28/08 (nên phần GỘP phải tái lập được kết quả cũ), rồi tách
 * theo nhãn của NẾN GỐC. mode "premise" = bước giá FWD nến theo chiều bật; "barrier" = rào R/4R.
 */
function run(s: Series, kind: Kind, rung: Rung, mult: number, mode: "premise" | "barrier"): Tally {
  const { c, atr, vol } = s;
  const maxAge = Math.ceil((KEY_MAX_AGE_DAYS * 86_400_000) / TF_MS["15m"]);
  const tail = mode === "premise" ? FWD : MAX_HOLD;
  const out = emptyTally();
  const events: number[] = [];
  for (let i = VOL_LOOKBACK; i < c.length - tail - 1; i++) {
    const base = medianOf(vol, i - VOL_LOOKBACK, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    if (kind === "spike" ? ratio >= mult : ratio >= 0.9 && ratio <= 1.1) events.push(i);
  }
  const stride = Math.max(1, Math.ceil(events.length / MAX_LEVELS));
  for (let e = 0; e < events.length; e += stride) {
    const i = events[e];
    const price = kind === "syn" ? c[i].close + (e % 2 ? 0.7 : -0.7) * atr[i] : c[i].close;
    const from = usableFrom(c, atr, i, price, rung);
    if (from < 0) continue;
    const tol = KEY_TOUCH_ATR * atr[i];
    const limit = Math.min(c.length - tail - 1, i + maxAge);
    for (let j = Math.max(from, i + 2); j <= limit; j++) {
      if (c[j].low > price + tol || c[j].high < price - tol) continue;
      if (mode === "premise" && rung === "R5loc") {
        let sum = 0;
        for (let k = j - LOCAL_N; k < j; k++) sum += vol[Math.max(0, k)];
        const local = sum / LOCAL_N;
        if (!(local > 0) || vol[j] / local < 1) break;
      }
      const dir = c[j - 1].close >= price ? 1 : -1;
      let x: number | null = null;
      if (mode === "premise") x = atr[j] > 0 ? (dir * (c[j + FWD].close - c[j].close)) / atr[j] : null;
      else x = walkBarrier(c, j, dir, STOP_ATR * atr[j]);
      if (x !== null) {
        const lab = s.label[i];
        if (lab === null) out.excluded++;
        else add(out[lab], x);
      }
      break;
    }
  }
  return out;
}

function runRandom(s: Series, count: number, seedBase: number): Group {
  const g = empty();
  let seed = seedBase;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const lo = VOL_LOOKBACK;
  const hi = s.c.length - MAX_HOLD - 2;
  for (let k = 0; k < count && hi > lo; k++) {
    const j = lo + Math.floor(rnd() * (hi - lo));
    const dir = rnd() < 0.5 ? 1 : -1;
    const r = walkBarrier(s.c, j, dir, STOP_ATR * s.atr[j]);
    if (r !== null) add(g, r);
  }
  return g;
}

const f = (x: number, d = 4, w = 8) => x.toFixed(d).padStart(w);

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "gate0";
  if (mode !== "gate0" && mode !== "gate1") throw new Error("mode: gate0 | gate1");

  const series: Series[] = [];
  let totalBars = 0;
  let unlabeled = 0;
  for (const symbol of SYMBOLS) {
    const base = await fetchKlinesPaged(symbol, "5m", Math.ceil((DAYS * TF_MS["1d"]) / TF_MS["5m"]));
    const c = aggregate(base, "15m", "5m");
    const { byTime, missingDays } = await loadMetricsDays(symbol, daysBetween(c[0].openTime, c[c.length - 1].openTime + TF_MS["15m"]));
    const label = labelBars(c, byTime);
    const miss = label.filter((x) => x === null).length;
    totalBars += c.length;
    unlabeled += miss;
    const mo = label.filter((x) => x === "MO").length;
    console.log(
      `${symbol.toUpperCase().padEnd(9)} ${c.length} nến 15m · ${new Date(c[0].openTime).toISOString().slice(0, 10)}→`
      + `${new Date(c[c.length - 1].openTime).toISOString().slice(0, 10)} · ngày thiếu metrics ${missingDays.length}`
      + ` · nến không nhãn ${(100 * miss / c.length).toFixed(2)}% · MỞ ${(100 * mo / (c.length - miss)).toFixed(1)}%`,
    );
    series.push({ symbol, c, atr: atr14(c), vol: c.map((x) => x.volume * x.close), label });
  }
  console.log(`\nBỘ ĐẾM TRA TRƯỢT: ${unlabeled}/${totalBars} nến (${(100 * unlabeled / totalBars).toFixed(2)}%) không có nhãn OI.`
    + ` Cửa 0 đòi < 5%.\n`);

  // ── CỬA 2: phản ứng trung bình ──
  console.log(`═══ CỬA 2 — bước giá ${FWD} nến theo chiều BẬT, đơn vị ATR · đậu khi (spike_MỞ − syn_MỞ) − biên(z=${Z}) > ${PASS_ATR} ═══`);
  const cells: { mult: number; rung: Rung; pass2: boolean }[] = [];
  for (const mult of MULTS) {
    for (const rung of ["R0", "R4", "R5loc"] as Rung[]) {
      const T: Record<Kind, Tally> = { spike: emptyTally(), normal: emptyTally(), syn: emptyTally() };
      for (const s of series) {
        for (const kind of ["spike", "normal", "syn"] as Kind[]) {
          const t = run(s, kind, rung, mult, "premise");
          merge(T[kind].MO, t.MO);
          merge(T[kind].DONG, t.DONG);
          T[kind].excluded += t.excluded;
        }
      }
      const nSp = T.spike.MO.n + T.spike.DONG.n;
      const share = nSp ? (100 * T.spike.MO.n) / nSp : 0;
      const margin = half(T.spike.MO) + half(T.syn.MO);
      if (mode === "gate0") {
        console.log(
          `${String(mult).padStart(3)}× ${rung.padEnd(6)} spike MỞ ${String(T.spike.MO.n).padStart(6)} ĐÓNG ${String(T.spike.DONG.n).padStart(6)}`
          + ` (MỞ ${share.toFixed(1)}%, loại ${T.spike.excluded}) · syn MỞ ${String(T.syn.MO.n).padStart(6)}`
          + ` · normal MỞ ${String(T.normal.MO.n).padStart(6)} · biên phát hiện MỞ ±${margin.toFixed(3)} ATR`
          + ` ${margin < 0.05 ? "(đủ lực)" : "(THIẾU LỰC)"}`,
        );
        continue;
      }
      const diff = mean(T.spike.MO) - mean(T.syn.MO);
      const pass2 = diff - margin > PASS_ATR;
      cells.push({ mult, rung, pass2 });
      const pooled = empty();
      merge(pooled, T.spike.MO); merge(pooled, T.spike.DONG);
      const pooledSyn = empty();
      merge(pooledSyn, T.syn.MO); merge(pooledSyn, T.syn.DONG);
      console.log(
        `${String(mult).padStart(3)}× ${rung.padEnd(6)}`
        + ` spike MỞ ${f(mean(T.spike.MO))} (n ${T.spike.MO.n}) ĐÓNG ${f(mean(T.spike.DONG))} (n ${T.spike.DONG.n})`
        + ` | normal MỞ ${f(mean(T.normal.MO))} ĐÓNG ${f(mean(T.normal.DONG))}`
        + ` | syn MỞ ${f(mean(T.syn.MO))} ĐÓNG ${f(mean(T.syn.DONG))}`
        + ` | MỞ−syn ${f(diff)} ±${margin.toFixed(3)} ⇒ ${pass2 ? "ĐẬU" : diff + margin < PASS_ATR ? "NULL" : "thiếu n"}`
        + ` | gộp spike−syn ${f(mean(pooled) - mean(pooledSyn))} (tái lập 28/08)`,
      );
    }
  }
  if (mode === "gate0") {
    console.log("\n(gate0: không in kết cục. Chạy gate1 khi Cửa 0 ổn.)");
    return;
  }

  // ── CỬA 3: cấu trúc rào ──
  console.log(`\n═══ CỬA 3 — rào R=${STOP_ATR}×ATR, target ${TARGET_R}R, phí ${COST_R}R · đậu khi WR_MỞ/WR_random ≥ ${(1 + COST_R).toFixed(3)} VÀ WR_MỞ vượt WR_synMỞ ngoài biên (z=${Z}) ═══`);
  let anyPass = false;
  for (const mult of MULTS) {
    for (const rung of ["R0", "R4"] as Rung[]) {
      const T: Record<Kind, Tally> = { spike: emptyTally(), normal: emptyTally(), syn: emptyTally() };
      for (const s of series) {
        for (const kind of ["spike", "normal", "syn"] as Kind[]) {
          const t = run(s, kind, rung, mult, "barrier");
          merge(T[kind].MO, t.MO);
          merge(T[kind].DONG, t.DONG);
        }
      }
      const rand = empty();
      const perCoin = Math.ceil((T.spike.MO.n + T.spike.DONG.n) / series.length);
      series.forEach((s, k) => merge(rand, runRandom(s, perCoin, 20260828 + k * 7919)));
      const ratio = wr(rand) > 0 ? wr(T.spike.MO) / wr(rand) : 0;
      const pass3 = ratio >= 1 + COST_R && wr(T.spike.MO) - ciWr(T.spike.MO) > wr(T.syn.MO) + ciWr(T.syn.MO);
      const pass2 = cells.find((x) => x.mult === mult && x.rung === rung)?.pass2 ?? false;
      if (pass2 && pass3) anyPass = true;
      const cell = (g: Group) => `${wr(g).toFixed(1)}% net ${(mean(g) - COST_R >= 0 ? "+" : "")}${(mean(g) - COST_R).toFixed(3)} (n ${g.n})`;
      console.log(`${String(mult).padStart(3)}× ${rung}`);
      console.log(`     spike MỞ   ${cell(T.spike.MO)}    spike ĐÓNG ${cell(T.spike.DONG)}`);
      console.log(`     syn   MỞ   ${cell(T.syn.MO)}    syn   ĐÓNG ${cell(T.syn.DONG)}`);
      console.log(`     normal MỞ  ${cell(T.normal.MO)}    random     ${cell(rand)}`);
      console.log(`     ⇒ WR_MỞ/WR_random ${ratio.toFixed(3)} · Cửa 3 ${pass3 ? "ĐẬU" : "RỚT"} · Cửa 2 cùng ô ${pass2 ? "ĐẬU" : "RỚT"}`);
    }
  }
  console.log(`\nTiêu chí phụ lục 1 (một ô đậu CẢ HAI cửa): ${anyPass ? "có ô đậu" : "không ô nào đậu"}`);
  // Văn bản khoá (§3 A1) còn đòi "biên phát hiện 95% < 0,05 ATR" — chép từ bộ thử 28/08, KHÔNG thể đạt
  // khi tách đôi mẫu (Cửa 0: biên nhỏ nhất 0,103). Lỗi đăng ký được xử lý theo phía BẢO THỦ: phán quyết
  // cố định là RỚT; số ở trên chỉ mô tả, không được dùng để đổi phán quyết.
  console.log("PHÁN QUYẾT A1 theo văn bản đã khoá: RỚT (tiêu chí biên < 0,05 ATR không đạt ở ô nào — xem Cửa 0)");
}

main().catch((e: unknown) => {
  console.error("Lỗi:", e);
  process.exit(1);
});
