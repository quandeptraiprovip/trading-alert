/**
 * exp-key-premise.ts — mệnh đề gốc của Key, kiểm ở BẢN MẠNH NHẤT của nó.
 *
 * BỐI CẢNH: `fx/fx-dream-placebo.ts` cho thấy mức giá sinh tại nến volume đột biến KHÔNG phản ứng
 * khác mức sinh tại nến volume bình thường — ở cả FX lẫn crypto. Nhưng phép đó dùng key THÔ, tức
 * bản YẾU NHẤT của giả thuyết. Người dùng đã nói rõ luật thật chặt hơn nhiều ("key phải đứng được
 * một thời gian", và khi hỏi kỹ: "giá đã quay lại chạm và BẬT RA"). Bác bỏ bản yếu mà tuyên bố đã
 * bác bỏ phương pháp là một lỗi lập luận. File này kiểm bản MẠNH.
 *
 * THANG ĐỊNH NGHĨA KEY (mỗi bậc chỉ thêm ĐÚNG một điều kiện, để biết điều kiện nào có tác dụng):
 *   R0 thô          — key dùng được ngay khi nến spike đóng (= đúng code production hiện tại).
 *   R1 rời đi       — giá phải rời vùng ≥ awayAtr × ATR rồi mới tính.
 *   R2 chín         — key phải đủ tuổi minAgeDays.
 *   R3 chín+sống    — thêm: trong lúc chờ KHÔNG có nến nào đóng xuyên qua mức.
 *   R4 ĐÃ BẬT MỘT LẦN — rời đi → quay lại chạm → bật ra. Đây là luật người dùng mô tả.
 *   R5 R4 + volume lần hai — cú chạm được đo phải kèm volume đột biến (touchVolumeSpikeMult).
 *
 * ĐIỂM MẤU CHỐT VỀ TÍNH CÔNG BẰNG: nhóm ĐỐI CHỨNG (volume bình thường 0,9–1,1× trung vị) đi qua
 * ĐÚNG THANG LỌC ẤY. Nếu chỉ lọc nhóm spike thì mọi bậc sẽ tự "tốt lên" nhờ chọn mẫu sống sót chứ
 * không nhờ volume. Vì thế KHÔNG dùng `detectKeyVolumeLevels` (nó chỉ sinh được nhóm spike) — cả
 * hai nhóm phải dựng bằng cùng một đoạn code.
 *
 * Đọc cột nào: "chênh" (spike − đối chứng). Nếu một bậc lọc làm CẢ HAI nhóm tốt lên như nhau thì
 * bậc đó chỉ đang chọn mẫu, không phải đang khai thác volume.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-premise.ts
 */
import fs from "fs";
import path from "path";
import { Candle } from "../strategy";
import { KEY_VOLUME_CONFIG as P } from "../key-volume";
import { loadH1 } from "../fx/fx-data";

const FWD = 12;          // nến đo phản ứng sau cú chạm
const MAX_LEVELS = 4000; // trần mỗi nhóm/công cụ, giữ hai nhóm cùng cỡ
const AWAY_ATR = 1.0;    // "rời đi" bao xa
const BOUNCE_ATR = 0.5;  // "bật ra" bao xa
const REACT_BARS = 6;    // bật ra trong bao nhiêu nến kể từ cú chạm
const AGE_BARS = 24 * 5; // "đứng được một thời gian" = 5 ngày ở khung H1
const MAX_WAIT = 24 * 60; // trần chờ hoàn tất chu trình

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

interface Group { n: number; sum: number; sumSq: number }
const empty = (): Group => ({ n: 0, sum: 0, sumSq: 0 });
const add = (g: Group, x: number) => { g.n++; g.sum += x; g.sumSq += x * x; };
const merge = (d: Group, s: Group) => { d.n += s.n; d.sum += s.sum; d.sumSq += s.sumSq; };
const mean = (g: Group) => (g.n ? g.sum / g.n : 0);
function sd(g: Group) { const m = mean(g); return Math.sqrt(Math.max(0, g.sumSq / g.n - m * m)); }
function tstat(g: Group) { return g.n < 2 || sd(g) === 0 ? 0 : mean(g) / (sd(g) / Math.sqrt(g.n)); }
function halfCi95(g: Group) { return g.n < 2 ? Infinity : (1.96 * sd(g)) / Math.sqrt(g.n); }

type Rung = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

/**
 * `usableFrom`: nến sớm nhất key được phép dùng, theo từng bậc. −1 = key bị LOẠI ở bậc này.
 * Không có lookahead ở đâu cả: mọi điều kiện đều đọc xong tại nến trả về.
 */
function usableFrom(c: Candle[], atr: number[], i: number, price: number, rung: Rung): number {
  const tol = P.keyTouchAtr * atr[i];
  const hi = price + tol, lo = price - tol;

  if (rung === "R0") return i + 2;

  if (rung === "R2" || rung === "R3") {
    const target = i + AGE_BARS;
    if (target >= c.length) return -1;
    if (rung === "R3") {
      // "Không bị đóng xuyên" phải hiểu theo PHÍA: mức bị phá khi giá đóng sang phía ĐỐI DIỆN với
      // phía nó đang đứng, chứ không phải khi giá rời xa về đúng phía cũ (đó là chuyện bình thường).
      // Bản đầu tiên loại cả hai phía và giết sạch mẫu (n=0) — đó là lỗi định nghĩa, không phải kết quả.
      const inval = P.invalidationAtr * atr[i];
      let held = 0;
      for (let j = i + 1; j <= target; j++) {
        const above = c[j].close > hi + inval, below = c[j].close < lo - inval;
        if (!above && !below) continue;
        const s = above ? 1 : -1;
        if (held === 0) held = s;
        else if (s !== held) return -1; // đã đóng sang phía đối diện ⇒ mức mất hiệu lực
      }
      if (held === 0) return -1; // chưa từng rời hẳn ⇒ chưa có mức nào để nói là "đứng được"
    }
    return target;
  }

  // R1/R4/R5 — cần bước "rời đi" trước
  let side = 0;
  const end = Math.min(c.length - 1, i + MAX_WAIT);
  let j = i + 1;
  for (; j <= end; j++) {
    if (!(atr[j] > 0)) continue;
    if (c[j].low > hi + AWAY_ATR * atr[j]) { side = 1; break; }
    if (c[j].high < lo - AWAY_ATR * atr[j]) { side = -1; break; }
  }
  if (side === 0) return -1;
  if (rung === "R1") return j + 1;

  // R4/R5 — quay lại chạm rồi BẬT RA về đúng phía đã rời
  let touched = -1;
  for (let k = j + 1; k <= end; k++) {
    if (!(atr[k] > 0)) continue;
    if (touched < 0) {
      if (c[k].low <= hi && c[k].high >= lo) { touched = k; continue; }
      if (side === 1 && c[k].close < lo) return -1;  // mất mức trước khi kịp chạm
      if (side === -1 && c[k].close > hi) return -1;
      continue;
    }
    if (k - touched > REACT_BARS) return -1;
    if (side === 1 && c[k].close < lo) return -1;    // xuyên thủng thay vì bật
    if (side === -1 && c[k].close > hi) return -1;
    const bounced = side === 1
      ? c[k].close > hi + BOUNCE_ATR * atr[k]
      : c[k].close < lo - BOUNCE_ATR * atr[k];
    if (bounced) return k + 1;
  }
  return -1;
}

/**
 * `spike`  — key thật của phương pháp (volume ≥ 2× trung vị).
 * `normal` — cùng cách dựng nhưng nến volume BÌNH THƯỜNG (placebo về volume).
 * `syn`    — mức TỔNG HỢP: lấy close của nến volume bình thường rồi DỜI 0,7 ATR, nên nó không
 *            trùng giá đóng của bất kỳ nến nào. Đây là placebo về CHÍNH KHÁI NIỆM MỨC GIÁ. Nếu
 *            `syn` cho cùng kết quả với `spike` thì thứ đang đo không phải "mức" gì cả, mà chỉ là
 *            quán tính giá ngắn hạn — và khi đó cả hai cột trên đều vô nghĩa.
 */
type Kind = "spike" | "normal" | "syn";

/** Một công cụ, một bậc, một nhóm → phân phối phản ứng tại CÚ CHẠM ĐẦU TIÊN sau khi key dùng được. */
function measure(c: Candle[], kind: Kind, rung: Rung): Group {
  const vol = c.map((x) => x.volume * x.close);
  const atr = atr14(c);
  const maxAge = Math.ceil((P.keyMaxAgeDays * 86400e3) / 3600e3);
  const g = empty();

  const events: number[] = [];
  for (let i = P.volumeLookback; i < c.length - FWD - 1; i++) {
    const base = medianOf(vol, i - P.volumeLookback, i);
    if (!(base > 0) || !(atr[i] > 0)) continue;
    const ratio = vol[i] / base;
    if (kind === "spike" ? ratio >= P.volumeSpikeMult : ratio >= 0.9 && ratio <= 1.1) events.push(i);
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
      if (rung === "R5") {
        const base = medianOf(vol, Math.max(0, j - P.touchVolumeLookback), j);
        if (!(base > 0) || vol[j] / base < P.volumeSpikeMult) break; // đòi volume lần hai THẬT SỰ đột biến
      }
      const dir = c[j - 1].close >= price ? 1 : -1;
      if (atr[j] > 0) add(g, (dir * (c[j + FWD].close - c[j].close)) / atr[j]);
      break;
    }
  }
  return g;
}

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT"];
const FX = ["XAUUSD", "XAGUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF",
  "EURJPY", "GBPJPY", "EURGBP", "AUDJPY"];

function loadCrypto(sym: string): Candle[] | null {
  const p = path.join(process.cwd(), ".cache", "klines", "futures", `${sym.toLowerCase()}_1h.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Candle[];
}

const LABEL: Record<Rung, string> = {
  R0: "R0 thô (= code hiện tại)",
  R1: "R1 + rời đi ≥1 ATR",
  R2: "R2 + chín 5 ngày",
  R3: "R3 + chín & không bị xuyên",
  R4: "R4 + ĐÃ BẬT MỘT LẦN",
  R5: "R5 + volume lần hai",
};

function table(title: string, series: Candle[][]) {
  console.log(`\n═══ ${title} ═══`);
  console.log(
    "định nghĩa Key".padEnd(29) + "n spike".padStart(9) + "pứ spike".padStart(10) + "t".padStart(7) +
    "pứ vol-thường".padStart(14) + "pứ mức-GIẢ".padStart(12) + "chênh vol".padStart(10) +
    "chênh mức".padStart(10) + "biên ±".padStart(9),
  );
  for (const rung of ["R0", "R1", "R2", "R3", "R4", "R5"] as Rung[]) {
    const sp = empty(), ct = empty(), sy = empty();
    for (const c of series) {
      merge(sp, measure(c, "spike", rung));
      merge(ct, measure(c, "normal", rung));
      merge(sy, measure(c, "syn", rung));
    }
    console.log(
      LABEL[rung].padEnd(29) + String(sp.n).padStart(9) + mean(sp).toFixed(4).padStart(10) +
      tstat(sp).toFixed(2).padStart(7) + mean(ct).toFixed(4).padStart(14) + mean(sy).toFixed(4).padStart(12) +
      (mean(sp) - mean(ct)).toFixed(4).padStart(10) + (mean(sp) - mean(sy)).toFixed(4).padStart(10) +
      halfCi95(sp).toFixed(4).padStart(9),
    );
  }
}

function main() {
  console.log(
    "Đơn vị: bước giá 12 nến sau cú chạm theo chiều BẬT LẠI, chia ATR tại cú chạm. Khung H1.\n" +
    "Giả thuyết cần: \"pứ spike\" DƯƠNG và \"chênh\" DƯƠNG, và phải LỚN LÊN theo bậc lọc.\n" +
    "\"biên ±\" = nửa khoảng tin cậy 95%: hiệu ứng nhỏ hơn mức này thì phép đo không phân biệt được 0.\n" +
    "Mốc đáng giao dịch: lệnh rủi ro ~1 ATR cần 0,1–0,3 ATR.",
  );

  const crypto = CRYPTO.map(loadCrypto).filter((c): c is Candle[] => !!c && c.length > 20000);
  table(`CRYPTO — ${crypto.length} coin, H1 (thị trường ĐANG chạy thật)`, crypto);
  table(`FX + kim loại — ${FX.length} công cụ, H1, 22 năm`, FX.map((s) => loadH1(s) as unknown as Candle[]));

  // Hiệu ứng đo được ở trên tính bằng ATR. Chi phí cũng phải quy về ATR thì mới so được — nếu
  // không sẽ kết luận "có hiệu ứng đáng giao dịch" cho một thứ nhỏ hơn phí vào/ra.
  console.log("\n═══ HIỆU ỨNG SO VỚI CHI PHÍ (quy cùng đơn vị ATR) ═══");
  for (const [name, series] of [["crypto", crypto], ["FX", FX.map((s) => loadH1(s) as unknown as Candle[])]] as [string, Candle[][]][]) {
    const atrPct: number[] = [];
    for (const c of series) {
      const a = atr14(c);
      const tail = Math.max(1, Math.floor(c.length * 0.5));
      for (let i = tail; i < c.length; i += 50) if (a[i] > 0) atrPct.push((a[i] / c[i].close) * 100);
    }
    atrPct.sort((x, y) => x - y);
    const medAtr = atrPct[Math.floor(atrPct.length / 2)];
    // crypto: taker 0,05% + trượt 0,02% mỗi chiều ⇒ khứ hồi 0,14%. FX: spread ~0,015% + trượt 0,002%.
    const roundTripPct = name === "crypto" ? 2 * (0.05 + 0.02) : 2 * (0.0158 / 2 + 0.002);
    console.log(
      `${name.padEnd(8)} ATR(H1) trung vị ${medAtr.toFixed(3)}% giá · khứ hồi ${roundTripPct.toFixed(3)}%` +
      ` = ${(roundTripPct / medAtr).toFixed(3)} ATR ⇒ NGƯỠNG phải vượt`,
    );
  }
  console.log(
    "Hiệu ứng lớn nhất đo được (crypto, R3/R5) là ~0,11–0,16 ATR theo chiều ĐI TIẾP.\n" +
    "So ngưỡng trên để biết nó có giao dịch được không — đây là phép so cuối cùng, không phải ý kiến.",
  );

  console.log(
    "\n═══ CÁCH ĐỌC ═══\n" +
    "• Nếu \"chênh\" vẫn ≈0 ở R4/R5: luật chặt nhất mà người dùng mô tả cũng KHÔNG tách được key\n" +
    "  volume khỏi mức giá ngẫu nhiên. Khi đó edge (nếu có) nằm ngoài mệnh đề Key.\n" +
    "• Nếu \"pứ\" tăng ở CẢ HAI nhóm theo bậc: bậc lọc chỉ đang chọn mẫu sống sót — một mức bất kỳ\n" +
    "  đã bật một lần thì bật tiếp, không liên quan volume. Đây vẫn là phát hiện dùng được, nhưng\n" +
    "  nó nói rằng nên bỏ điều kiện volume chứ không phải bỏ điều kiện phản ứng.\n" +
    "• Chỉ khi \"chênh\" DƯƠNG và LỚN DẦN theo bậc thì mệnh đề Key mới đứng vững.",
  );
}

if (require.main === module) main();
