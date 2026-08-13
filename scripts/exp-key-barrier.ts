/**
 * exp-key-barrier.ts — đo phương pháp theo ĐÚNG CẤU TRÚC RÀO (stop/target), không theo trung bình.
 *
 * VÌ SAO PHẢI CÓ FILE NÀY — LỖ HỔNG TRONG CHÍNH HAI PHÉP ĐO TRƯỚC CỦA TÔI:
 * `fx-dream-placebo.ts` và `exp-key-premise.ts` đều đo **trung bình bước giá** sau cú chạm. Nhưng
 * lãi/lỗ của một hệ có stop sát và target xa KHÔNG do trung bình quyết định — nó là bài toán
 * FIRST-PASSAGE: xác suất chạm target trước khi chạm stop. Hai phân phối có CÙNG trung bình vẫn cho
 * kỳ vọng R khác hẳn nhau, vì stop cắt cụt đuôi trái còn target cắt cụt đuôi phải.
 *   ⇒ Một kết luận "trung bình ≈ 0 nên không có edge" là KHÔNG ĐỦ để bác bỏ hệ stop/target.
 * File này đóng đúng lỗ hổng đó, và nó là phép duy nhất tới giờ có thể CỨU phương pháp.
 *
 * MỐC NULL TỰ CHUẨN: với bước ngẫu nhiên không trôi, kỳ vọng gộp = 0 ở MỌI bội số target, và tỉ lệ
 * thắng = 1/(1+k). In sẵn cột "WR ngẫu nhiên" để so — lệch khỏi mốc đó mới là tín hiệu, chứ không
 * phải "WR 33% nghe thấp quá".
 *
 * Rào dựng đúng như production (`stopMode: "sweep-window"`): vào ở close nến sweep, stop ở cực trị
 * của chính nến sweep lùi thêm `stopBufferAtr` × ATR, target = k × R. Cùng nến chạm cả hai thì tính
 * CHẠM STOP TRƯỚC (giả định thận trọng, đúng hướng đã ghi nhận ở execution-fill-assumption-risk).
 *
 * Ba nhóm như các phép trước — spike / volume-thường / MỨC GIẢ — và nhóm giả vẫn là phép quyết định:
 * nếu mức giả cho cùng kỳ vọng thì thứ đo được không phải hiệu ứng của "mức".
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-barrier.ts
 */
import fs from "fs";
import path from "path";
import { Candle } from "../strategy";
import { KEY_VOLUME_CONFIG as P } from "../key-volume";
import { loadH1 } from "../fx/fx-data";

const MAX_LEVELS = 4000;
const MAX_HOLD = 200;      // nến; hết hạn thì thoát ở close
const TARGETS = [1, 2, 3]; // bội số R
const AWAY_ATR = 1.0;
const BOUNCE_ATR = 0.5;
const REACT_BARS = 6;
const MAX_WAIT = 24 * 60;
const CRYPTO_RT_PCT = 0.14; // khứ hồi: taker 0,05 + trượt 0,02, hai chiều

function atr14(c: Candle[]): number[] {
  const out = new Array(c.length).fill(0);
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    prev = i === 1 ? tr : prev + (tr - prev) / 14;
    out[i] = prev;
  }
  return out;
}

function medianOf(v: number[], from: number, to: number): number {
  const s = v.slice(from, to).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

type Kind = "spike" | "normal" | "syn";
type Rung = "R0" | "R4";

interface Acc { n: number; wins: number; grossR: number; costR: number; sumSq: number }
const acc = (): Acc => ({ n: 0, wins: 0, grossR: 0, costR: 0, sumSq: 0 });
function merge(d: Acc, s: Acc) {
  d.n += s.n; d.wins += s.wins; d.grossR += s.grossR; d.costR += s.costR; d.sumSq += s.sumSq;
}

/** Bậc định nghĩa Key. R0 = code hiện tại; R4 = luật người dùng (rời đi → chạm lại → BẬT RA). */
function usableFrom(c: Candle[], atr: number[], i: number, price: number, rung: Rung): number {
  if (rung === "R0") return i + 2;
  const tol = P.keyTouchAtr * atr[i];
  const hi = price + tol, lo = price - tol;
  const end = Math.min(c.length - 1, i + MAX_WAIT);
  let side = 0, j = i + 1;
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
      if (side === 1 && c[k].close < lo) return -1;
      if (side === -1 && c[k].close > hi) return -1;
      continue;
    }
    if (k - touched > REACT_BARS) return -1;
    if (side === 1 && c[k].close < lo) return -1;
    if (side === -1 && c[k].close > hi) return -1;
    const bounced = side === 1 ? c[k].close > hi + BOUNCE_ATR * atr[k] : c[k].close < lo - BOUNCE_ATR * atr[k];
    if (bounced) return k + 1;
  }
  return -1;
}

/**
 * Một công cụ → kết quả rào cho từng bội số target.
 * Chỉ tính những cú chạm là SWEEP (xuyên qua mức rồi đóng lại) — đúng khoảnh khắc phương pháp vào.
 */
function run(c: Candle[], kind: Kind, rung: Rung, rtPct: number): Map<number, Acc> {
  const vol = c.map((x) => x.volume * x.close);
  const atr = atr14(c);
  const maxAge = Math.ceil((P.keyMaxAgeDays * 86400e3) / 3600e3);
  const out = new Map<number, Acc>(TARGETS.map((k) => [k, acc()]));

  const events: number[] = [];
  for (let i = P.volumeLookback; i < c.length - MAX_HOLD - 1; i++) {
    const base = medianOf(vol, i - P.volumeLookback, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    if (kind === "spike" ? ratio >= P.volumeSpikeMult : ratio >= 0.9 && ratio <= 1.1) events.push(i);
  }
  const stride = Math.max(1, Math.ceil(events.length / MAX_LEVELS));

  for (let e = 0; e < events.length; e += stride) {
    const i = events[e];
    const price = kind === "syn" ? c[i].close + (e % 2 ? 0.7 : -0.7) * atr[i] : c[i].close;
    const from = usableFrom(c, atr, i, price, rung);
    if (from < 0) continue;
    const tol = P.keyTouchAtr * atr[i];
    const limit = Math.min(c.length - MAX_HOLD - 1, i + maxAge);

    for (let j = Math.max(from, i + 2); j <= limit; j++) {
      if (c[j].low > price + tol || c[j].high < price - tol) continue;
      const dir = c[j - 1].close >= price ? 1 : -1;
      const poked = dir > 0 ? c[j].low < price - tol : c[j].high > price + tol;
      const closedBack = dir > 0 ? c[j].close > price : c[j].close < price;
      if (!poked || !closedBack || !(atr[j] > 0)) break; // chạm nhưng không thành sweep ⇒ bỏ mức này

      const entry = c[j].close;
      const stop = dir > 0
        ? c[j].low - P.stopBufferAtr * atr[j]
        : c[j].high + P.stopBufferAtr * atr[j];
      const risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk / entry > P.maxStopPct) break; // luật maxStopPct của production
      const costR = (rtPct / 100) * entry / risk;

      for (const k of TARGETS) {
        const target = entry + dir * k * risk;
        let r = 0;
        for (let m = j + 1; m <= Math.min(c.length - 1, j + MAX_HOLD); m++) {
          const hitStop = dir > 0 ? c[m].low <= stop : c[m].high >= stop;
          const hitTgt = dir > 0 ? c[m].high >= target : c[m].low <= target;
          if (hitStop) { r = -1; break; }            // cùng nến chạm cả hai ⇒ tính stop trước
          if (hitTgt) { r = k; break; }
          if (m === Math.min(c.length - 1, j + MAX_HOLD)) r = (dir * (c[m].close - entry)) / risk;
        }
        const a = out.get(k)!;
        a.n++; a.grossR += r; a.costR += costR; a.sumSq += r * r;
        if (r > 0) a.wins++;
      }
      break;
    }
  }
  return out;
}

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT"];
const FX = ["XAUUSD", "XAGUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF",
  "EURJPY", "GBPJPY", "EURGBP", "AUDJPY"];

function loadCrypto(sym: string): Candle[] | null {
  const p = path.join(process.cwd(), ".cache", "klines", "futures", `${sym.toLowerCase()}_1h.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Candle[];
}

function table(title: string, series: Candle[][], rtPct: number) {
  console.log(`\n═══ ${title} ═══`);
  console.log(
    "bậc / nhóm".padEnd(24) + "target".padStart(7) + "lệnh".padStart(8) + "WR%".padStart(7) +
    "WR ngẫu".padStart(9) + "gộp R/lệnh".padStart(12) + "t".padStart(7) +
    "phí R/lệnh".padStart(12) + "ròng R/lệnh".padStart(13) + "biên ±".padStart(9),
  );
  for (const rung of ["R0", "R4"] as Rung[]) {
    for (const kind of ["spike", "normal", "syn"] as Kind[]) {
      const tot = new Map<number, Acc>(TARGETS.map((k) => [k, acc()]));
      for (const c of series) {
        const r = run(c, kind, rung, rtPct);
        for (const k of TARGETS) merge(tot.get(k)!, r.get(k)!);
      }
      for (const k of TARGETS) {
        const a = tot.get(k)!;
        if (a.n === 0) continue;
        const g = a.grossR / a.n;
        const sd = Math.sqrt(Math.max(0, a.sumSq / a.n - g * g));
        const t = sd > 0 ? g / (sd / Math.sqrt(a.n)) : 0;
        const cost = a.costR / a.n;
        const label = k === TARGETS[0] ? `${rung} ${kind}` : "";
        console.log(
          label.padEnd(24) + `${k}R`.padStart(7) + String(a.n).padStart(8) +
          ((a.wins / a.n) * 100).toFixed(1).padStart(7) + ((100 / (1 + k))).toFixed(1).padStart(9) +
          g.toFixed(4).padStart(12) + t.toFixed(2).padStart(7) +
          cost.toFixed(4).padStart(12) + (g - cost).toFixed(4).padStart(13) +
          ((1.96 * sd) / Math.sqrt(a.n)).toFixed(4).padStart(9),
        );
      }
    }
  }
}

function main() {
  console.log(
    "Đo theo CẤU TRÚC RÀO: vào ở close nến sweep, stop = cực trị nến sweep − 0,15 ATR, target = k×R.\n" +
    "Cùng nến chạm cả hai ⇒ tính CHẠM STOP TRƯỚC. Bỏ lệnh có stop > maxStopPct (3%), như production.\n" +
    "Cột quyết định: \"gộp R/lệnh\" phải DƯƠNG RÕ ở nhóm spike và PHẢI CAO HƠN nhóm mức GIẢ.\n" +
    "Mốc null: bước ngẫu nhiên cho gộp = 0 và WR = 1/(1+k) — cột \"WR ngẫu\".",
  );

  const crypto = CRYPTO.map(loadCrypto).filter((c): c is Candle[] => !!c && c.length > 20000);
  table(`CRYPTO — ${crypto.length} coin, H1 (thị trường ĐANG chạy thật)`, crypto, CRYPTO_RT_PCT);
  table(`FX + kim loại — ${FX.length} công cụ, H1, 22 năm`, FX.map((s) => loadH1(s) as unknown as Candle[]), 0.02);

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• gộp R/lệnh ≈ 0 và WR ≈ WR ngẫu ⇒ cấu trúc rào KHÔNG cứu được: hệ đang lấy đúng thứ mà một\n" +
    "  bước ngẫu nhiên cho, và phí là toàn bộ phần chênh lệch.\n" +
    "• gộp DƯƠNG ở spike nhưng nhóm mức GIẢ cũng dương bằng ⇒ vẫn không phải hiệu ứng của \"mức\".\n" +
    "• Chỉ khi spike > giả > 0 và ròng > 0 thì mới có thứ để xây.",
  );
}

if (require.main === module) main();
