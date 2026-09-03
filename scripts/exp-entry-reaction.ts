/**
 * exp-entry-reaction.ts — 15/08/2026. Hai câu hỏi của user, đo trên CÙNG bộ máy thoát.
 *
 * (1) CHẤT LƯỢNG "vùng F CONF 30D". Luật đang chạy (`decideFastShortConfirmation`) chỉ đòi nến kế
 *     tiếp ĐÓNG DƯỚI mức đã đóng băng. Nó KHÔNG ràng buộc giá đang cách mức bao xa ⇒ vào được ở
 *     bất kỳ đâu bên dưới. Cái vẽ trên chart là một MỨC + một khoảng thời gian, không phải một VÙNG
 *     có dung sai — nên trước hết phải đo phân bố "vào cách mức bao nhiêu ATR" và netR theo nó.
 *
 * (2) HAI luật vào của user: chờ PHẢN ỨNG tại vùng (volume lớn), hoặc chờ QUÉT THANH KHOẢN rút râu.
 *     Với SHORT sau khi thủng mức: giá phải QUAY LẠI chạm mức rồi bị đẩy xuống, thay vì đuổi theo.
 *
 * VÌ SAO ĐÂY KHÔNG PHẢI LẶP LẠI KẾT LUẬN NULL CŨ (đọc trước khi bỏ qua):
 *   - `liquidity-sweep-experiment`: sweep làm gate cho bot SMC swing (strategy.ts), luật pullback.
 *   - `keyvol-key-premise-null`: "giá phản ứng tại mức volume đột biến" — câu hỏi CHỌN MỨC.
 *   Ở đây MỨC đã cho sẵn (kênh Donchian 30 ngày, mức mà hệ đang thật sự dùng), và câu hỏi là CÁCH
 *   VÀO tại mức đó, trong bộ máy thoát Turtle/Fast. Khác cấu trúc ⇒ phải đo lại (xem
 *   `cross-sectional-vs-timeseries`).
 *
 * ĐỐI CHỨNG BẮT BUỘC (theo `null-result-toolkit` + `indicator-families-rejected` vòng 4, nơi vào
 * lệnh NGẪU NHIÊN cùng bộ máy thoát đạt Sharpe 1,19):
 *   - NGẪU NHIÊN cùng số lệnh  → biết luật vào có hơn tung đồng xu không.
 *   - MỨC GIẢ (dời 0,7×ATR)    → biết "vùng" có ý nghĩa hay chỉ là bộ lọc hình thái.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-entry-reaction.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, ema, priorDonchian, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { decayH } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";
import { CORE8, coreWindow, loadPool } from "./exp-breadth";

const BPD = TF_MS["1d"] / TF_MS["4h"]; // 6 nến/ngày
const SHORT_BARS = Math.max(2, Math.round(30 * BPD)); // kênh close 30 ngày = 180 nến
const LONG_BARS = Math.max(2, Math.round(10 * BPD)); // kênh high 10 ngày = 60 nến
const VOL_WIN = 96; // 16 ngày — mẫu so sánh "volume lớn"

// ─────────────────────────────────────────────────────────────────────────────
// ĐẶC TRƯNG mỗi symbol (tính một lần, dùng lại cho mọi biến thể)
// ─────────────────────────────────────────────────────────────────────────────
interface Feat {
  atr: number[];
  ema: number[];
  /** close-low của 30 ngày TRƯỚC nến i (mức breakout SHORT đóng băng tại nến i). */
  sLow: number[];
  /** high của 10 ngày TRƯỚC nến i (mức breakout LONG). */
  lHigh: number[];
  /** volume nến i / trung vị 96 nến trước. */
  volRatio: number[];
  /** râu trên / biên độ nến i. */
  upWick: number[];
}

function features(c: Candle[]): Feat {
  const n = c.length;
  const closes = c.map((x) => x.close);
  const atr = atrSeries(c, T.atrPeriod);
  const emaArr = ema(closes, T.trendLen);
  const sLow = new Array(n).fill(Infinity);
  const lHigh = new Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    if (i >= SHORT_BARS) sLow[i] = priorDonchian(c, i, SHORT_BARS).closeLow;
    if (i >= LONG_BARS) lHigh[i] = priorDonchian(c, i, LONG_BARS).high;
  }
  const volRatio = new Array(n).fill(0);
  for (let i = VOL_WIN; i < n; i++) {
    const w = c.slice(i - VOL_WIN, i).map((x) => x.volume).sort((a, b) => a - b);
    const med = w[w.length >> 1];
    volRatio[i] = med > 0 ? c[i].volume / med : 0;
  }
  const upWick = c.map((x) => {
    const range = x.high - x.low;
    return range > 0 ? (x.high - Math.max(x.open, x.close)) / range : 0;
  });
  return { atr, ema: emaArr, sLow, lHigh, volRatio, upWick };
}

// ─────────────────────────────────────────────────────────────────────────────
// LUẬT SHORT — mỗi biến thể trả true/false tại nến i, chỉ đọc c[0..i]
// `flatRun` = số nến LIÊN TIẾP tính đến i mà engine gọi ta (tức sổ đang RỖNG).
// Nhờ nó luật "nến trước phải là nến phá vỡ" tái tạo đúng production: nếu nến j đang có vị thế
// thì production không "arm" được setup nào cả.
// ─────────────────────────────────────────────────────────────────────────────
interface ShortCtx {
  c: Candle[];
  f: Feat;
  i: number;
  flatRun: number;
}
type ShortRule = (x: ShortCtx) => boolean;

/** Nến j có phải nến PHÁ VỠ (đóng dưới close-low 30d) và đang trong downtrend? */
function isBreakBar(x: ShortCtx, j: number): boolean {
  return j >= SHORT_BARS && x.c[j].close < x.f.sLow[j] && x.c[j].close < x.f.ema[j];
}

/** ĐANG CHẠY: nến i−k là nến phá vỡ, nến i vẫn đóng dưới mức đã đóng băng. k=0 ⇒ vào ngay. */
function chase(k: number): ShortRule {
  return (x) => {
    const j = x.i - k;
    if (k > 0 && x.flatRun <= k) return false; // sổ không rỗng liên tục ⇒ production không arm được
    if (!isBreakBar(x, j)) return false;
    if (x.c[x.i].close >= x.f.sLow[j]) return false;
    return x.c[x.i].close < x.f.ema[x.i];
  };
}

/** ĐANG CHẠY + trần đuổi giá: chỉ vào nếu còn cách mức ≤ capAtr×ATR. */
function chaseCapped(capAtr: number): ShortRule {
  const base = chase(1);
  return (x) => {
    if (!base(x)) return false;
    const L = x.f.sLow[x.i - 1];
    return x.f.atr[x.i] > 0 && (L - x.c[x.i].close) / x.f.atr[x.i] <= capAtr;
  };
}

interface RetestOpts {
  /** Số nến tối đa sau nến phá vỡ còn được phép vào. */
  window: number;
  /** Coi là "chạm vùng" nếu high ≥ mức − touchAtr×ATR. 0 = phải chạm hẳn. */
  touchAtr: number;
  /** Râu trên tối thiểu (tỉ lệ biên độ nến). 0 = không đòi. */
  wick: number;
  /** Volume tối thiểu so trung vị 96 nến. 0 = không đòi. */
  vol: number;
  /** Dời mức lên 0,7×ATR để dựng nhóm ĐỐI CHỨNG "mức giả". */
  fakeShift?: boolean;
}

/**
 * LUẬT CỦA USER: sau khi thủng mức, chờ giá QUAY LẠI chạm vùng rồi bị đẩy xuống (đóng dưới mức).
 * Tuỳ chọn thêm râu trên (quét thanh khoản) và volume lớn (phản ứng).
 */
function retest(o: RetestOpts): ShortRule {
  return (x) => {
    const bar = x.c[x.i];
    if (!(x.f.atr[x.i] > 0)) return false;
    if (bar.close >= x.f.ema[x.i]) return false;
    if (o.wick > 0 && x.f.upWick[x.i] < o.wick) return false;
    if (o.vol > 0 && x.f.volRatio[x.i] < o.vol) return false;
    // nến phá vỡ gần nhất trong cửa sổ, và sổ phải rỗng liên tục từ đó tới giờ
    for (let m = 1; m <= o.window; m++) {
      const j = x.i - m;
      if (x.flatRun <= m) return false;
      if (!isBreakBar(x, j)) continue;
      const L = o.fakeShift ? x.f.sLow[j] + 0.7 * x.f.atr[j] : x.f.sLow[j];
      if (bar.close >= L) return false; // đã reclaim ⇒ setup hỏng
      return bar.high >= L - o.touchAtr * x.f.atr[x.i];
    }
    return false;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LỆNH CHỜ (limit) đặt sẵn tại mức — dạng MẠNH NHẤT của cách vào user mô tả.
//
// ⚠️ RÀNG BUỘC CHỐNG LOOKAHEAD, đọc kỹ: lệnh chờ khớp TRONG nến, nên MỌI điều kiện phải biết được
// TRƯỚC nến đó. Không được đòi "nến khớp phải đóng dưới mức" hay "volume nến khớp phải lớn" — hai
// thứ đó chỉ biết khi nến ĐÃ đóng, tức đã sau lúc khớp. Điều kiện volume vì thế đặt ở nến PHÁ VỠ.
// ─────────────────────────────────────────────────────────────────────────────
interface LimitOpts {
  /** Số nến lệnh chờ còn hiệu lực sau nến phá vỡ. */
  window: number;
  /** Đặt lệnh tại mức − offsetAtr×ATR (0 = đúng mức; >0 = không cần hồi hết). */
  offsetAtr: number;
  /** Huỷ setup nếu có nến ĐÓNG lại trên mức (breakout hỏng). */
  cancelOnReclaim: boolean;
  /** Volume tối thiểu của nến PHÁ VỠ so trung vị 96 nến. 0 = không đòi. */
  breakVol: number;
  /** Dời mức lên 0,7×ATR ⇒ nhóm đối chứng "mức giả". */
  fakeShift?: boolean;
}

/** Trả mức khớp nếu lệnh chờ được kích hoạt ở nến i, ngược lại null. */
function limitLevel(x: ShortCtx, o: LimitOpts): number | null {
  if (!(x.f.atr[x.i] > 0)) return null;
  for (let m = 1; m <= o.window; m++) {
    const j = x.i - m;
    if (x.flatRun <= m) return null;
    if (!isBreakBar(x, j)) continue;
    if (o.breakVol > 0 && x.f.volRatio[j] < o.breakVol) return null;
    const L = o.fakeShift ? x.f.sLow[j] + 0.7 * x.f.atr[j] : x.f.sLow[j];
    if (o.cancelOnReclaim) for (let k = j + 1; k < x.i; k++) if (x.c[k].close >= L) return null;
    const price = L - o.offsetAtr * x.f.atr[x.i];
    return x.c[x.i].high >= price ? price : null; // chỉ dùng high — biết được ngay lúc khớp
  }
  return null;
}

/** ĐỐI CHỨNG: vào ngẫu nhiên khi downtrend, xác suất p — cùng bộ máy thoát. */
function randomShort(p: number, seed: number): ShortRule {
  let s = seed >>> 0;
  return (x) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return x.c[x.i].close < x.f.ema[x.i] && s / 0x100000000 < p;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dựng entrySignal: LONG giữ nguyên luật production, SHORT thay bằng `rule`
// ─────────────────────────────────────────────────────────────────────────────
function makeSignal(feats: Map<string, Feat>, rule: ShortRule) {
  const lastIdx = new Map<string, number>();
  const run = new Map<string, number>();
  return (symbol: string, i: number, c: Candle[]): "long" | "short" | null => {
    const f = feats.get(symbol)!;
    const prev = lastIdx.get(symbol);
    const flatRun = prev === i - 1 ? (run.get(symbol) ?? 0) + 1 : 1;
    lastIdx.set(symbol, i);
    run.set(symbol, flatRun);
    if (i < SHORT_BARS) return null;
    if (rule({ c, f, i, flatRun })) return "short";
    if (c[i].close > f.ema[i] && c[i].close > f.lHigh[i]) return "long";
    return null;
  };
}

/** Cặp {entrySignal, entryFillPrice} cho biến thể LỆNH CHỜ; hai hàm phải nhất quán về mức khớp. */
function makeLimit(feats: Map<string, Feat>, o: LimitOpts): Partial<ExtParams> {
  const lastIdx = new Map<string, number>();
  const run = new Map<string, number>();
  const fill = new Map<string, number>(); // mức đã quyết ở nến i, để entryFillPrice dùng lại
  return {
    entrySignal: (symbol, i, c) => {
      const f = feats.get(symbol)!;
      const prev = lastIdx.get(symbol);
      const flatRun = prev === i - 1 ? (run.get(symbol) ?? 0) + 1 : 1;
      lastIdx.set(symbol, i);
      run.set(symbol, flatRun);
      if (i < SHORT_BARS) return null;
      const px = limitLevel({ c, f, i, flatRun }, o);
      if (px !== null) {
        fill.set(symbol, px);
        return "short";
      }
      if (c[i].close > f.ema[i] && c[i].close > f.lHigh[i]) return "long";
      return null;
    },
    entryFillPrice: (symbol, _i, _c, dir) => (dir === "short" ? fill.get(symbol)! : NaN),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chạy + chấm điểm
// ─────────────────────────────────────────────────────────────────────────────
interface Row {
  label: string;
  shorts: number;
  net: number;
  netShort: number;
  sharpe: number;
  maxDD: number;
  netDd: number;
  era: number[];
}

function score(label: string, res: PortfolioResult, w: ReturnType<typeof coreWindow>): Row {
  const inWin = (t: UnitTrade) => t.entryTime >= w.from && t.entryTime <= w.to;
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const m = riskMetrics(eq);
  const shorts = res.trades.filter((t) => t.dir === "short" && t.unitIndex === 0 && inWin(t));
  const netShort = res.trades
    .filter((t) => t.dir === "short" && inWin(t))
    .reduce((s, t) => s + t.netR * t.weight, 0);
  const era = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)).sharpe);
  return { label, shorts: shorts.length, net: m.netR, netShort, sharpe: m.sharpe, maxDD: m.maxDD, netDd: m.netOverMaxDD, era };
}

function header() {
  console.log(
    "luật vào SHORT".padEnd(38) +
      "lệnh".padStart(6) + "NET R".padStart(8) + "NETshort".padStart(10) + "R/lệnh".padStart(9) +
      "Sharpe".padStart(8) + "maxDD_R".padStart(9) + "NET/DD".padStart(8) + "  era A/B/C",
  );
  console.log("─".repeat(126));
}

function printRow(r: Row, base?: Row) {
  const d = base && base !== r ? ` (${r.net >= base.net ? "+" : ""}${(r.net - base.net).toFixed(0)}R)` : "";
  console.log(
    r.label.padEnd(38) +
      String(r.shorts).padStart(6) +
      r.net.toFixed(0).padStart(8) +
      r.netShort.toFixed(0).padStart(10) +
      (r.shorts ? (r.netShort / r.shorts).toFixed(3) : "—").padStart(9) +
      r.sharpe.toFixed(3).padStart(8) +
      r.maxDD.toFixed(1).padStart(9) +
      r.netDd.toFixed(2).padStart(8) +
      "  " + r.era.map((x) => x.toFixed(2)).join(" / ") + d,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PHẦN A — giải phẫu vùng F CONF 30D trên chính các lệnh production
// ─────────────────────────────────────────────────────────────────────────────
function anatomy(res: PortfolioResult, data: Map<string, Candle[]>, feats: Map<string, Feat>, w: ReturnType<typeof coreWindow>) {
  interface Rec { chaseAtr: number; volRatio: number; upWick: number; touched: boolean; netR: number }
  const recs: Rec[] = [];
  for (const t of res.trades) {
    if (t.dir !== "short" || t.unitIndex !== 0) continue;
    if (t.entryTime < w.from || t.entryTime > w.to) continue;
    const c = data.get(t.symbol);
    const f = feats.get(t.symbol);
    if (!c || !f) continue;
    const i = c.findIndex((x) => x.openTime === t.entryTime);
    if (i < 1 || !(f.atr[i] > 0)) continue;
    const L = f.sLow[i - 1]; // mức đóng băng ở nến phá vỡ
    if (!Number.isFinite(L)) continue;
    recs.push({
      chaseAtr: (L - t.entryPrice) / f.atr[i],
      volRatio: f.volRatio[i],
      upWick: f.upWick[i],
      touched: c[i].high >= L,
      netR: t.netR,
    });
  }
  if (!recs.length) return console.log("PHẦN A: không có lệnh SHORT nào để giải phẫu.\n");

  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const chases = recs.map((r) => r.chaseAtr);
  console.log(`PHẦN A — GIẢI PHẪU ${recs.length} lệnh SHORT unit#1 do luật F CONF 30D sinh ra\n`);
  console.log(
    "Vào lệnh cách mức đã đóng băng bao nhiêu ATR (âm = vào TRÊN mức):\n" +
      `  p10 ${q(chases, 0.1).toFixed(2)}   p25 ${q(chases, 0.25).toFixed(2)}   ` +
      `trung vị ${q(chases, 0.5).toFixed(2)}   p75 ${q(chases, 0.75).toFixed(2)}   p90 ${q(chases, 0.9).toFixed(2)}   ` +
      `max ${Math.max(...chases).toFixed(2)}`,
  );
  const touched = recs.filter((r) => r.touched).length;
  console.log(
    `  Nến vào có QUAY LẠI chạm mức (high ≥ mức): ${touched}/${recs.length} = ${((100 * touched) / recs.length).toFixed(1)}%\n`,
  );

  const cuts = [0.25, 0.5, 0.75].map((p) => q(chases, p));
  const buckets = [
    { name: `≤ ${cuts[0].toFixed(2)} ATR (sát mức)`, lo: -Infinity, hi: cuts[0] },
    { name: `${cuts[0].toFixed(2)}–${cuts[1].toFixed(2)} ATR`, lo: cuts[0], hi: cuts[1] },
    { name: `${cuts[1].toFixed(2)}–${cuts[2].toFixed(2)} ATR`, lo: cuts[1], hi: cuts[2] },
    { name: `> ${cuts[2].toFixed(2)} ATR (đuổi xa)`, lo: cuts[2], hi: Infinity },
  ];
  console.log("netR trung bình theo khoảng cách vào lệnh:");
  for (const b of buckets) {
    const g = recs.filter((r) => r.chaseAtr > b.lo && r.chaseAtr <= b.hi);
    if (!g.length) continue;
    const mean = g.reduce((s, r) => s + r.netR, 0) / g.length;
    const sd = Math.sqrt(g.reduce((s, r) => s + (r.netR - mean) ** 2, 0) / Math.max(1, g.length - 1));
    const se = sd / Math.sqrt(g.length);
    const wr = (100 * g.filter((r) => r.netR > 0).length) / g.length;
    console.log(
      `  ${b.name.padEnd(26)} n=${String(g.length).padStart(4)}  netR ${mean >= 0 ? "+" : ""}${mean.toFixed(3)} ` +
        `± ${se.toFixed(3)}  tổng ${(mean * g.length).toFixed(0)}R  WR ${wr.toFixed(0)}%`,
    );
  }
  const hiVol = recs.filter((r) => r.volRatio >= 1.5);
  const loVol = recs.filter((r) => r.volRatio < 1.5);
  const mean = (g: Rec[]) => (g.length ? g.reduce((s, r) => s + r.netR, 0) / g.length : 0);
  console.log(
    `\nVolume nến vào (so trung vị 96 nến):  ≥1,5× n=${hiVol.length} netR ${mean(hiVol).toFixed(3)}   ` +
      `<1,5× n=${loVol.length} netR ${mean(loVol).toFixed(3)}`,
  );
  const hiWick = recs.filter((r) => r.upWick >= 0.4);
  console.log(
    `Râu trên nến vào ≥40%: n=${hiWick.length} netR ${mean(hiWick).toFixed(3)}   ` +
      `còn lại n=${recs.length - hiWick.length} netR ${mean(recs.filter((r) => r.upWick < 0.4)).toFixed(3)}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PHẦN C — KIỂU LỆNH CỦA USER, không phải kiểu lệnh của bot.
//
// Sample order trong playbook dùng stop 0,45–0,78% và ăn 2,7–7,2R. Bot dùng stop 3×ATR (≈4–5%) và
// trail. Đó là HAI hệ khác nhau; phần B chỉ đổi cò vào lệnh mà giữ stop/thoát của bot, nên chưa
// trả lời được "backtest đẹp" của user. Phần này dựng ĐÚNG hệ của user:
//   vào tại cú quét ngược về mức · stop ngay trên râu quét · target = k×R · cùng nến chạm cả hai
//   thì tính CHẠM STOP TRƯỚC (giả định thận trọng).
// MỐC NULL TỰ CHUẨN: bước ngẫu nhiên cho kỳ vọng gộp = 0 và WR = 1/(1+k) ở MỌI k. Lệch khỏi mốc đó
// mới là tín hiệu — "WR 30% nghe thấp" tự nó không nói gì.
// ─────────────────────────────────────────────────────────────────────────────
const RT_COST_PCT = 0.16 + 0.04; // khứ hồi: taker MEXC 0,08 × 2 chiều + trượt 0,02 × 2
const MAX_HOLD_BARS = 200;
const STOP_BUF_ATR = 0.15;

interface Outcome { r: number; riskFrac: number }

/**
 * `scanFrom` = nến đầu tiên có thể chạm rào. Vào ở CLOSE ⇒ i+1; vào bằng LIMIT trong nến ⇒ chính i.
 *
 * ⚠️ BẪY THỨ HAI ĐÃ MẮC Ở ĐÂY. Lệnh limit khớp khi `high` chạm mức, nhưng KHÔNG ai biết trong nến đó
 * `low` đến trước hay sau `high`. Bản đầu cho phép `low` của chính nến khớp chạm target ⇒ 27,1% số
 * lệnh "thắng" ngay trong nến vào, đẩy WR@2R lên 61,8% (mốc ngẫu nhiên 33,3%). Bỏ riêng phần đó ra
 * là còn 34,7% — tức TOÀN BỘ "edge" của lệnh chờ chỉ là quy ước tính trong nến.
 * Quy ước thận trọng, dùng từ đây: ở nến khớp CHỈ tính STOP, target phải từ nến sau.
 */
function barrier(c: Candle[], scanFrom: number, entry: number, stop: number, k: number, stopOnlyAt = -1): Outcome | null {
  const risk = stop - entry; // SHORT: stop nằm TRÊN entry
  if (!(risk > 0) || !(entry > 0)) return null;
  const riskFrac = risk / entry;
  const target = entry - k * risk;
  const end = Math.min(c.length - 1, scanFrom + MAX_HOLD_BARS);
  for (let i = scanFrom; i <= end; i++) {
    if (c[i].high >= stop) return { r: -1, riskFrac }; // stop trước trong cùng nến
    if (i !== stopOnlyAt && c[i].low <= target) return { r: k, riskFrac };
  }
  return { r: (entry - c[end].close) / risk, riskFrac };
}

type SweepMode = "close" | "limit";
interface Setup { i: number; entry: number; stop: number; scanFrom: number; stopOnlyAt?: number }
interface SweepOpts {
  window: number; wickMin: number; volMin: number; mode: SweepMode;
  /** Dời mức lên 0,7×ATR ⇒ mức vô nghĩa, cùng mọi luật khác. */
  fake?: boolean;
  /** Vào ở nến ngẫu nhiên trong downtrend ⇒ bỏ hẳn khái niệm mức. */
  random?: boolean;
  /** Đặt lệnh chờ ở close nến phá + k×ATR thay vì ở mức Donchian ⇒ mức TUỲ Ý. */
  arbitraryAtr?: number;
}

/** Liệt kê các cú vào lệnh kiểu user; không chồng lệnh trên cùng symbol. */
function sweepSetups(c: Candle[], f: Feat, o: SweepOpts, seed: number): { setups: Setup[]; breaks: number } {
  const out: Setup[] = [];
  let breaks = 0;
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 0x100000000);
  let busyUntil = -1;
  for (let j = SHORT_BARS; j < c.length - 2; j++) {
    if (j <= busyUntil) continue;
    if (o.random) {
      // ĐỐI CHỨNG: cùng hình học stop/target nhưng điểm vào KHÔNG liên quan mức nào
      if (!(c[j].close < f.ema[j]) || !(f.atr[j] > 0) || rnd() > 0.02) continue;
      out.push({ i: j, entry: c[j].close, stop: c[j].high + STOP_BUF_ATR * f.atr[j], scanFrom: j + 1 });
      busyUntil = j + MAX_HOLD_BARS;
      continue;
    }
    if (!(c[j].close < f.sLow[j] && c[j].close < f.ema[j] && f.atr[j] > 0)) continue;
    breaks++;
    const L = o.arbitraryAtr !== undefined
      ? c[j].close + o.arbitraryAtr * f.atr[j]
      : o.fake ? f.sLow[j] + 0.7 * f.atr[j] : f.sLow[j];
    for (let m = 1; m <= o.window && j + m < c.length - 1; m++) {
      const i = j + m;
      if (c[i].close >= L) break; // reclaim ⇒ setup hỏng
      if (c[i].high < L) continue; // chưa quét ngược về vùng
      if (o.wickMin > 0 && f.upWick[i] < o.wickMin) break;
      if (o.volMin > 0 && f.volRatio[i] < o.volMin) break;
      if (o.mode === "limit") {
        // ⚠️ BẪY ĐÃ MẮC MỘT LẦN Ở ĐÂY — đọc kỹ. Bản đầu đặt stop = high[i] + đệm, trong khi lệnh
        // limit khớp TRONG nến i, tức trước khi biết high[i]. Nó cho WR 64,9% và +0,643 R/lệnh
        // (risk trung vị 0,76%) — một "edge" hoàn toàn giả, sinh ra vì mẫu số R được đặt sau khi
        // đã thấy cực trị của chính nến đó. Stop của lệnh chờ BẮT BUỘC lấy từ cấu trúc đã đóng
        // TRƯỚC nến khớp, và nến khớp phải được tính là có thể quét stop ngay.
        let priorHigh = L;
        for (let q = j; q < i; q++) priorHigh = Math.max(priorHigh, c[q].high);
        // scanFrom = i: nến khớp ĐƯỢC PHÉP quét stop ngay. Bỏ các setup đó ra khỏi mẫu sẽ là loại
        // đúng những lệnh thua ⇒ thiên lệch sống sót; phải để chúng vào và tính −1R.
        out.push({ i, entry: L, stop: priorHigh + STOP_BUF_ATR * f.atr[i - 1], scanFrom: i, stopOnlyAt: i });
      } else {
        out.push({ i, entry: c[i].close, stop: c[i].high + STOP_BUF_ATR * f.atr[i], scanFrom: i + 1 });
      }
      busyUntil = i + MAX_HOLD_BARS;
      break;
    }
  }
  return { setups: out, breaks };
}

function partC(data: Map<string, Candle[]>, feats: Map<string, Feat>) {
  const K = [2, 3, 4];
  const groups: [string, SweepOpts][] = [
    ["quét về mức + đóng dưới (vào ở close)", { window: 12, wickMin: 0, volMin: 0, mode: "close" }],
    ["… + râu trên ≥40% (rút râu)", { window: 12, wickMin: 0.4, volMin: 0, mode: "close" }],
    ["… + râu ≥40% + vol ≥1,5×", { window: 12, wickMin: 0.4, volMin: 1.5, mode: "close" }],
    ["… vào bằng LIMIT đúng mức", { window: 12, wickMin: 0, volMin: 0, mode: "limit" }],
    ["ĐỐI CHỨNG mức GIẢ (+0,7 ATR)", { window: 12, wickMin: 0, volMin: 0, mode: "close", fake: true }],
    ["ĐỐI CHỨNG nến ngẫu nhiên", { window: 12, wickMin: 0, volMin: 0, mode: "close", random: true }],
    ["ĐỐI CHỨNG limit ở mức GIẢ (+0,7 ATR)", { window: 12, wickMin: 0, volMin: 0, mode: "limit", fake: true }],
    ["ĐỐI CHỨNG limit ở mức TUỲ Ý (+0,5 ATR)", { window: 12, wickMin: 0, volMin: 0, mode: "limit", arbitraryAtr: 0.5 }],
    ["ĐỐI CHỨNG limit ở mức TUỲ Ý (+1,0 ATR)", { window: 12, wickMin: 0, volMin: 0, mode: "limit", arbitraryAtr: 1.0 }],
  ];
  console.log("\n\nPHẦN C — KIỂU LỆNH CỦA USER: stop sát râu quét, target k×R (KHÔNG dùng stop/thoát của bot)\n");
  console.log(
    "nhóm".padEnd(40) + "khớp/phá".padStart(10) + "risk%".padStart(8) + "phí(R)".padStart(8) +
      "  │  " + K.map((k) => `WR@${k}R  R/lệnh net ±SE`).join("   "),
  );
  console.log("─".repeat(40 + 26) + "─┼─" + "─".repeat(3 * 24));
  for (const [label, o] of groups) {
    const rows: Outcome[][] = K.map(() => []);
    let riskFracs: number[] = [];
    let breaks = 0;
    for (const [sym, c] of data) {
      const f = feats.get(sym)!;
      const { setups: st, breaks: nb } = sweepSetups(c, f, o, 987654321 ^ sym.length * 7919);
      breaks += nb;
      for (const s of st) {
        K.forEach((k, ki) => {
          const r = barrier(c, s.scanFrom, s.entry, s.stop, k, s.stopOnlyAt ?? -1);
          if (r) rows[ki].push(r);
        });
      }
      const r0 = st.map((s) => (s.stop - s.entry) / s.entry).filter((x) => x > 0);
      riskFracs = riskFracs.concat(r0);
    }
    if (!rows[0].length) continue;
    const medRisk = [...riskFracs].sort((a, b) => a - b)[riskFracs.length >> 1];
    const costR = RT_COST_PCT / 100 / medRisk;
    const cells = K.map((k, ki) => {
      const rs = rows[ki];
      const wr = (100 * rs.filter((x) => x.r > 0).length) / rs.length;
      const net = rs.map((x) => x.r - RT_COST_PCT / 100 / x.riskFrac);
      const mean = net.reduce((a, b) => a + b, 0) / net.length;
      const sd = Math.sqrt(net.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, net.length - 1));
      const se = sd / Math.sqrt(net.length);
      return `${wr.toFixed(1).padStart(5)}%  ${(mean >= 0 ? "+" : "") + mean.toFixed(3)} ±${se.toFixed(3)}`;
    });
    console.log(
      label.padEnd(40) + `${rows[0].length}/${breaks}`.padStart(10) +
        `${(medRisk * 100).toFixed(2)}`.padStart(8) + costR.toFixed(3).padStart(8) +
        "  │  " + cells.join("   "),
    );
  }
  console.log(
    "─".repeat(126) + "\n" +
      `MỐC NGẪU NHIÊN (bước không trôi): WR = ${K.map((k) => `${(100 / (1 + k)).toFixed(1)}%@${k}R`).join(", ")}, ` +
      "kỳ vọng GỘP = 0 ở mọi k.\n" +
      "Cột phí(R) = khứ hồi 0,20% chia cho khoảng stop trung vị — đây là thứ phải thắng TRƯỚC khi nói đến edge.",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const btc = data.get("btcusdt");
  if (!btc) throw new Error("thiếu btcusdt — không dựng được BTC gate");
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const { fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 200);
  const feats = new Map<string, Feat>();
  for (const [s, c] of data) feats.set(s, features(c));
  console.log(
    `Cửa sổ ${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)} · ` +
      `${data.size} coin · sleeve FAST một mình (cô lập luật F CONF 30D)\n`,
  );

  const heat: AdmitFn = decayH(T.heatDecayK);
  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));
  const run = (rule: ShortRule, tag: string) =>
    runBooks(bk({ ...fast, entrySignal: makeSignal(feats, rule) }, tag), heat);

  // ── PARITY: entrySignal tái tạo production phải KHỚP. Không khớp thì mọi số dưới đây vô nghĩa.
  const prod = runBooks(bk(fast, "prod"), heat);
  const clone = run(chase(1), "clone");
  const sum = (r: PortfolioResult) => r.trades.reduce((s, t) => s + t.netR * t.weight, 0);
  const dTrades = clone.trades.length - prod.trades.length;
  const dNet = sum(clone) - sum(prod);
  console.log(
    `PARITY entrySignal vs engine production: lệnh ${prod.trades.length} → ${clone.trades.length} (Δ${dTrades}), ` +
      `NET ${sum(prod).toFixed(2)} → ${sum(clone).toFixed(2)} (Δ${dNet.toFixed(2)})` +
      `${Math.abs(dNet) < 0.01 && dTrades === 0 ? "  ✓ KHỚP" : "  ✗ LỆCH — đọc kỹ trước khi tin phần B"}\n`,
  );

  anatomy(prod, data, feats, w);

  // ── PHẦN B ──
  console.log("PHẦN B — THAY LUẬT VÀO SHORT, GIỮ NGUYÊN bộ máy thoát/pyramid/heat/phí\n");
  header();
  const base = score("ĐANG CHẠY: confirm 1 nến", prod, w);
  printRow(base);

  const variants: [string, ShortRule][] = [
    ["confirm 0 nến (vào ngay khi phá)", chase(0)],
    ["confirm 2 nến", chase(2)],
    ["confirm 3 nến", chase(3)],
    ["confirm 1 + trần đuổi ≤0,3 ATR", chaseCapped(0.3)],
    ["confirm 1 + trần đuổi ≤0,6 ATR", chaseCapped(0.6)],
    ["confirm 1 + trần đuổi ≤1,0 ATR", chaseCapped(1.0)],
    ["confirm 1 + trần đuổi ≤1,5 ATR", chaseCapped(1.5)],
    ["RETEST chạm mức ≤6 nến", retest({ window: 6, touchAtr: 0, wick: 0, vol: 0 })],
    ["RETEST chạm mức ≤12 nến", retest({ window: 12, touchAtr: 0, wick: 0, vol: 0 })],
    ["RETEST gần mức (0,5 ATR) ≤12 nến", retest({ window: 12, touchAtr: 0.5, wick: 0, vol: 0 })],
    ["RETEST + râu trên ≥40% ≤12 nến", retest({ window: 12, touchAtr: 0, wick: 0.4, vol: 0 })],
    ["RETEST + râu ≥40% + vol ≥1,5× ≤12", retest({ window: 12, touchAtr: 0, wick: 0.4, vol: 1.5 })],
    ["RETEST + vol ≥1,5× ≤12 nến", retest({ window: 12, touchAtr: 0, wick: 0, vol: 1.5 })],
    ["RETEST + vol ≥2,0× ≤12 nến", retest({ window: 12, touchAtr: 0, wick: 0, vol: 2.0 })],
  ];
  for (const [label, rule] of variants) printRow(score(label, run(rule, label), w), base);

  console.log("\nLỆNH CHỜ đặt sẵn TẠI MỨC — khớp đúng ở vùng, không vào ở giá đóng cửa:");
  const limits: [string, LimitOpts][] = [
    ["limit đúng mức, ≤6 nến", { window: 6, offsetAtr: 0, cancelOnReclaim: false, breakVol: 0 }],
    ["limit đúng mức, ≤12 nến", { window: 12, offsetAtr: 0, cancelOnReclaim: false, breakVol: 0 }],
    ["limit đúng mức, ≤24 nến", { window: 24, offsetAtr: 0, cancelOnReclaim: false, breakVol: 0 }],
    ["limit đúng mức, ≤12 + huỷ khi reclaim", { window: 12, offsetAtr: 0, cancelOnReclaim: true, breakVol: 0 }],
    ["limit mức −0,5 ATR, ≤12 nến", { window: 12, offsetAtr: 0.5, cancelOnReclaim: false, breakVol: 0 }],
    ["limit mức −1,0 ATR, ≤12 nến", { window: 12, offsetAtr: 1.0, cancelOnReclaim: false, breakVol: 0 }],
    ["limit đúng mức ≤12 + nến phá vol ≥1,5×", { window: 12, offsetAtr: 0, cancelOnReclaim: false, breakVol: 1.5 }],
  ];
  for (const [label, o] of limits) {
    printRow(score(label, runBooks(bk({ ...fast, ...makeLimit(feats, o) }, label), heat), w), base);
  }

  console.log("\nĐỐI CHỨNG (không có cái này thì mọi con số trên vô nghĩa):");
  printRow(
    score("MỨC GIẢ: limit mức +0,7 ATR ≤12", runBooks(bk({ ...fast, ...makeLimit(feats, { window: 12, offsetAtr: 0, cancelOnReclaim: false, breakVol: 0, fakeShift: true }) }, "fakelim"), heat), w),
    base,
  );
  const fakeRow = score("MỨC GIẢ: retest mức +0,7 ATR ≤12", run(retest({ window: 12, touchAtr: 0, wick: 0, vol: 0, fakeShift: true }), "fake"), w);
  printRow(fakeRow, base);
  // xác suất chọn sao cho số lệnh SHORT xấp xỉ bản đang chạy
  const target = base.shorts;
  let p = 0.01;
  for (let iter = 0; iter < 12; iter++) {
    const r = run(randomShort(p, 12345), `rnd${iter}`);
    const n = r.trades.filter((t) => t.dir === "short" && t.unitIndex === 0 && t.entryTime >= w.from && t.entryTime <= w.to).length;
    if (n === 0) { p *= 4; continue; }
    if (Math.abs(n - target) / target < 0.12) {
      printRow(score(`NGẪU NHIÊN cùng số lệnh (p=${p.toFixed(4)})`, r, w), base);
      break;
    }
    p *= target / n;
    if (iter === 11) printRow(score(`NGẪU NHIÊN n=${n} (p=${p.toFixed(4)})`, r, w), base);
  }

  partC(data, feats);

  console.log(
    "\nĐọc bảng: NET short tách riêng đóng góp của chiều SHORT — luật chỉ đổi chiều đó, phần LONG\n" +
      "giữ nguyên nên chênh lệch NET tổng phải giải thích được bằng NET short.\n" +
      "Biến thể nào ít lệnh hơn hẳn thì Sharpe cao KHÔNG đủ kết luận: phải xem NET và cả 3 era.",
  );
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
