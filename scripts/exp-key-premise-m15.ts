/**
 * CỬA 2 — mệnh đề gốc của Key, đo lại ở ĐÚNG cấu hình mà artifact §11 chốt.
 *
 * VÌ SAO PHẢI ĐO LẠI: `scripts/exp-key-premise.ts` đã bác mệnh đề này, nhưng ở khung **H1** với
 * baseline retest là **trung vị 96 nến**. Artifact §11 chốt bỏ cả hai: Key phát hiện trên **M15**,
 * và volume lúc retest chỉ cần lớn hơn **vài nến liền trước**. Bác bản cũ rồi tuyên bố đã bác bản
 * mới là lỗi lập luận — nên đây là cùng phép đo, chạy ở cấu hình mới.
 *
 * Cửa 1b còn cho biết ngưỡng 2× trên M15 sinh ~20 key/ngày/coin và 100% điểm giá TUỲ Ý cũng có key
 * ở gần ⇒ ở ngưỡng đó "mức" không còn là mức. Vì vậy quét cả ngưỡng thưa (6×, 12×).
 *
 * BA NHÓM, dựng bằng CÙNG một đoạn code (nếu chỉ lọc nhóm thật thì mọi bậc tự đẹp lên nhờ chọn mẫu):
 *   spike  — nến volume ≥ mult × trung vị 96 nến (key thật)
 *   normal — nến volume bình thường 0,9–1,1× (đối chứng cùng thang lọc)
 *   syn    — close nến bình thường DỜI 0,7 ATR ⇒ không trùng close nến nào (placebo về KHÁI NIỆM mức)
 *
 * BA BẬC ĐỊNH NGHĨA:
 *   R0     — dùng được ngay khi nến đóng (= code production).
 *   R4     — rời đi → quay lại chạm → BẬT RA (luật user mô tả).
 *   R5loc  — R4 + cú chạm phải kèm volume lớn hơn TRUNG BÌNH N NẾN LIỀN TRƯỚC (baseline cục bộ mới).
 *
 * NGƯỠNG ĐẬU (chốt ở Cửa 0, không sửa sau khi thấy số): |spike − syn| > 0,246 ATR.
 * Null chỉ hợp lệ khi biên phát hiện 95% < 0,05 ATR.
 *
 * Chạy: ./node_modules/.bin/ts-node scripts/exp-key-premise-m15.ts [days] [symbols]
 */
import fs from "fs";
import path from "path";
import { KEY_VOLUME_CONFIG as P } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS, aggregate } from "../strategy";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];
const FWD = 12;            // nến đo phản ứng sau cú chạm (12 nến M15 = 3 giờ)
const MAX_LEVELS = 6000;   // trần mỗi nhóm/coin, giữ ba nhóm cùng cỡ
const AWAY_ATR = 1.0;
const BOUNCE_ATR = 0.5;
const REACT_BARS = 6;
const MAX_WAIT = 4 * 24 * 7;   // trần chờ hoàn tất chu trình: 7 ngày ở M15
const LOCAL_N = 5;             // baseline cục bộ mới: bao nhiêu nến liền trước
const DEFAULT_MULTS = [2, 6, 12];
/** Ngưỡng đậu đã chốt ở Cửa 0 — phí/R với R = 2,1×ATR(M15). Vàng rẻ hơn BTC perp 1,8 lần. */
export const PASS_BY_MARKET = { crypto: 0.246, gold: 0.140 };

/**
 * Nến M15 cho một công cụ. Vàng lấy từ cache Dukascopy đã có sẵn (`XAUUSD_m5.json`, cả năm 2024,
 * volume là tick volume — đúng thứ chart của kênh hiển thị); crypto lấy từ Binance futures.
 */
export async function loadM15(symbol: string, days: number): Promise<Candle[]> {
  if (symbol === "xauusd") {
    const file = path.resolve(".cache", "fx", "XAUUSD_m5.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Candle[];
    const cutoff = raw[raw.length - 1].openTime - days * TF_MS["1d"];
    return aggregate(raw.filter((candle) => candle.openTime >= cutoff), "15m", "5m");
  }
  const base = await fetchKlinesPaged(symbol, "5m", Math.ceil((days * TF_MS["1d"]) / TF_MS["5m"]));
  return aggregate(base, "15m", "5m");
}

export type Rung = "R0" | "R4" | "R5loc";
export type Kind = "spike" | "normal" | "syn";

interface Group { n: number; sum: number; sumSq: number }
const empty = (): Group => ({ n: 0, sum: 0, sumSq: 0 });
const add = (g: Group, x: number): void => { g.n += 1; g.sum += x; g.sumSq += x * x; };
const merge = (dst: Group, src: Group): void => { dst.n += src.n; dst.sum += src.sum; dst.sumSq += src.sumSq; };
const mean = (g: Group): number => (g.n ? g.sum / g.n : 0);
function sd(g: Group): number {
  const m = mean(g);
  return Math.sqrt(Math.max(0, g.sumSq / g.n - m * m));
}
const tstat = (g: Group): number => (g.n < 2 || sd(g) === 0 ? 0 : mean(g) / (sd(g) / Math.sqrt(g.n)));
const halfCi95 = (g: Group): number => (g.n < 2 ? Infinity : (1.96 * sd(g)) / Math.sqrt(g.n));

export function atr14(c: Candle[]): number[] {
  const out = new Array<number>(c.length).fill(0);
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close),
    );
    prev = i === 1 ? tr : prev + (tr - prev) / 14;
    out[i] = prev;
  }
  return out;
}

export function medianOf(values: number[], from: number, to: number): number {
  const slice = values.slice(Math.max(0, from), to).sort((a, b) => a - b);
  return slice.length ? slice[slice.length >> 1] : 0;
}

/** Nến sớm nhất mức được phép dùng theo từng bậc. −1 = mức bị LOẠI ở bậc này. Không lookahead. */
export function usableFrom(c: Candle[], atr: number[], i: number, price: number, rung: Rung): number {
  if (rung === "R0") return i + 2;

  const tol = P.keyTouchAtr * atr[i];
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
      if (side === 1 ? c[k].close < lo : c[k].close > hi) return -1; // mất mức trước khi kịp chạm
      continue;
    }
    if (k - touched > REACT_BARS) return -1;
    if (side === 1 ? c[k].close < lo : c[k].close > hi) return -1;   // xuyên thủng thay vì bật
    const bounced = side === 1
      ? c[k].close > hi + BOUNCE_ATR * atr[k]
      : c[k].close < lo - BOUNCE_ATR * atr[k];
    if (bounced) return k + 1;
  }
  return -1;
}

/** Một coin, một bậc, một nhóm, một ngưỡng → phân phối phản ứng tại CÚ CHẠM ĐẦU TIÊN. */
function measure(c: Candle[], kind: Kind, rung: Rung, mult: number): Group {
  const vol = c.map((candle) => candle.volume * candle.close);
  const atr = atr14(c);
  const maxAge = Math.ceil((P.keyMaxAgeDays * 86_400_000) / TF_MS["15m"]);
  const group = empty();

  const events: number[] = [];
  for (let i = P.volumeLookback; i < c.length - FWD - 1; i++) {
    const base = medianOf(vol, i - P.volumeLookback, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    if (kind === "spike" ? ratio >= mult : ratio >= 0.9 && ratio <= 1.1) events.push(i);
  }
  const stride = Math.max(1, Math.ceil(events.length / MAX_LEVELS));

  for (let e = 0; e < events.length; e += stride) {
    const i = events[e];
    // Dời luân phiên lên/xuống để nhóm tổng hợp không lệch một phía so với giá.
    const price = kind === "syn" ? c[i].close + (e % 2 ? 0.7 : -0.7) * atr[i] : c[i].close;
    const from = usableFrom(c, atr, i, price, rung);
    if (from < 0) continue;
    const tol = P.keyTouchAtr * atr[i];
    const limit = Math.min(c.length - FWD - 1, i + maxAge);
    for (let j = Math.max(from, i + 2); j <= limit; j++) {
      if (c[j].low > price + tol || c[j].high < price - tol) continue;
      if (rung === "R5loc") {
        // Baseline CỤC BỘ: chỉ cần lớn hơn trung bình N nến liền trước (artifact mục 01, def-item D).
        let sum = 0;
        for (let k = j - LOCAL_N; k < j; k++) sum += vol[Math.max(0, k)];
        const local = sum / LOCAL_N;
        if (!(local > 0) || vol[j] / local < 1) break;
      }
      const dir = c[j - 1].close >= price ? 1 : -1;
      if (atr[j] > 0) add(group, (dir * (c[j + FWD].close - c[j].close)) / atr[j]);
      break;
    }
  }
  return group;
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "730", 10);
  const symbols = (process.argv[3]?.split(",") ?? SYMBOLS).map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Ngưỡng spike phải hợp phân phối volume của từng thị trường: tick volume vàng mượt hơn hẳn
  // volume crypto nên 6×/12× gần như không tồn tại ở vàng (97 và 4 sự kiện/năm).
  const MULTS = process.argv[4]?.split(",").map(Number).filter((x) => x > 0) ?? DEFAULT_MULTS;
  const PASS_ATR = symbols.every((symbol) => symbol === "xauusd")
    ? PASS_BY_MARKET.gold
    : PASS_BY_MARKET.crypto;

  const series: { symbol: string; candles: Candle[] }[] = [];
  for (const symbol of symbols) {
    const m15 = await loadM15(symbol, days);
    series.push({ symbol, candles: m15 });
    console.log(`${symbol.toUpperCase()}: ${m15.length} nến 15m`);
  }

  console.log(
    `\nPhản ứng = bước giá ${FWD} nến sau cú chạm, theo chiều BẬT LẠI, chuẩn hoá bằng ATR TẠI CÚ CHẠM.`
    + `\nNgưỡng đậu (chốt ở Cửa 0): |spike − syn| > ${PASS_ATR} ATR.\n`,
  );

  for (const mult of MULTS) {
    console.log(`═══ spike ≥ ${mult}× trung vị ${P.volumeLookback} nến ═══`);
    console.log(
      `${"bậc".padEnd(7)} ${"n spike".padStart(8)} ${"spike".padStart(8)} ${"t".padStart(7)}`
      + ` ${"±95%".padStart(7)} ${"normal".padStart(8)} ${"syn(GIẢ)".padStart(9)}`
      + ` ${"spike−syn".padStart(10)} ${"biên±".padStart(8)} ${"phán".padStart(8)}`,
    );
    for (const rung of ["R0", "R4", "R5loc"] as Rung[]) {
      const totals: Record<Kind, Group> = { spike: empty(), normal: empty(), syn: empty() };
      for (const { candles } of series) {
        for (const kind of ["spike", "normal", "syn"] as Kind[]) {
          merge(totals[kind], measure(candles, kind, rung, mult));
        }
      }
      const diff = mean(totals.spike) - mean(totals.syn);
      const margin = halfCi95(totals.spike) + halfCi95(totals.syn);
      // Phép kiểm MỘT PHÍA: phương pháp đòi giá BẬT LẠI (chênh dương) đủ lớn để phủ phí.
      //   ĐẬU  — cả khoảng tin cậy nằm trên ngưỡng.
      //   NULL — cả khoảng tin cậy nằm dưới ngưỡng ⇒ loại trừ được một cú bật đáng giao dịch.
      //   thiếu n — khoảng tin cậy cưỡi lên ngưỡng, chưa kết luận được.
      const verdict = diff - margin > PASS_ATR
        ? "ĐẬU"
        : diff + margin < PASS_ATR ? "NULL" : "thiếu n";
      console.log(
        `${rung.padEnd(7)} ${String(totals.spike.n).padStart(8)}`
        + ` ${mean(totals.spike).toFixed(4).padStart(8)}`
        + ` ${tstat(totals.spike).toFixed(2).padStart(7)}`
        + ` ${halfCi95(totals.spike).toFixed(4).padStart(7)}`
        + ` ${mean(totals.normal).toFixed(4).padStart(8)}`
        + ` ${mean(totals.syn).toFixed(4).padStart(9)}`
        + ` ${diff.toFixed(4).padStart(10)}`
        + ` ${`±${margin.toFixed(3)}`.padStart(8)}`
        + ` ${verdict.padStart(8)}`,
      );
    }
    console.log();
  }
  console.log(
    `biên± = tổng nửa khoảng tin cậy 95% của hai nhóm. NULL = loại trừ được cú bật ≥ ${PASS_ATR} ATR;`
    + ` "thiếu n" = khoảng tin cậy còn cưỡi lên ngưỡng, KHÔNG phải "không có gì".`
    + `\nChênh ÂM = giá ĐI TIẾP QUA MỨC chứ không bật lại — ngược hẳn mệnh đề, và nhóm syn cũng âm`
    + ` ⇒ đó là quán tính giá, không phải tính chất của "mức".`,
  );
}

main().catch((error: unknown) => {
  console.error("Lỗi:", error);
  process.exit(1);
});
