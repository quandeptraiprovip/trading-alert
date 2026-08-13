/**
 * chop-diagnosis.ts — 2026-08-10: vì sao HAI sleeve đang live (Turtle/Binance, Fast/MEXC) âm Net R
 * trong ~1 năm gần nhất, dù khung lớn đi ngang vẫn có sóng nhỏ?
 *
 * KHÁC rx-lab.ts ở một điểm QUAN TRỌNG: `sleeveParams()` trong rx-lab đã CŨ (Fast ở đó vẫn là
 * chandelier/max4 — bản TRƯỚC lần ship 09/08). Ở đây tham số Fast đọc thẳng từ hằng số của
 * `fast-trend-live.ts` (giống `scripts/fast-live-parity.ts`), nên số liệu áp dụng cho bot thật.
 *
 * Run: ./node_modules/.bin/ts-node scripts/chop-diagnosis.ts <base|cost|regime> [days]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { T, buildBtcGateLongs, atrSeries } from "../turtle";
import { FAST_LONG_EXIT_DAYS, FAST_SHORT_ENTRY_DAYS, FAST_SHORT_CONFIRM_BARS } from "../fast-trend-live";
import { ExtParams, PortfolioResult, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { loadData, windowOf, decayH, books, positionDiag, fmtD, Gate, PosDiag } from "./rx-lab";

const MEXC_TAKER = 0.08;

/** Tham số ĐÚNG như production hôm nay (chốt bởi turtle-live-parity + fast-live-parity). */
export function liveSleeves(gate: Gate): { turtle: ExtParams; fast: ExtParams } {
  const turtle: ExtParams = { ...T, gate };
  const fast: ExtParams = {
    ...T,
    gate,
    entryDays: 10,
    longEntrySource: "high",
    longExitMode: "mid",
    longExitDays: FAST_LONG_EXIT_DAYS,
    shortEntryDays: FAST_SHORT_ENTRY_DAYS,
    shortEntrySource: "close",
    shortExitMode: "chandelier",
    shortConfirmBars: FAST_SHORT_CONFIRM_BARS,
    initialStopObLookback: 0,
    pyramidMaxUnits: 3,
    takerFeePct: MEXC_TAKER,
  };
  return { turtle, fast };
}

const YEARS = [2021, 2022, 2023, 2024, 2025, 2026];
const WINDOWS = [180, 365, 545, 730, 1095];

function yearCells(res: PortfolioResult, from: number): string {
  return YEARS.map((y) => {
    const lo = Math.max(Date.UTC(y, 0, 1), from);
    const hi = Date.UTC(y + 1, 0, 1);
    const eq = res.equity.filter((e) => e.time >= lo && e.time < hi);
    if (eq.length < 3) return "—".padStart(15);
    const m = riskMetrics(eq);
    return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(15);
  }).join("");
}

function windowCells(res: PortfolioResult, to: number): string {
  return WINDOWS.map((d) => {
    const from = to - d * TF_MS["1d"];
    const m = riskMetrics(res.equity.filter((e) => e.time >= from));
    const pos = new Set(res.trades.filter((t) => t.entryTime >= from).map((t) => `${t.book}#${t.positionId}`)).size;
    return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}|${pos}`.padStart(17);
  }).join("");
}

/** Cùng cửa sổ nhưng chấm bằng Sharpe | NET/maxDD | maxDD — bất biến đòn bẩy, so cấu hình khác số unit. */
function windowCellsDd(res: PortfolioResult, to: number): string {
  return WINDOWS.map((d) => {
    const from = to - d * TF_MS["1d"];
    const m = riskMetrics(res.equity.filter((e) => e.time >= from));
    return `${m.sharpe.toFixed(2)}|${m.netOverMaxDD.toFixed(2)}|${m.maxDD.toFixed(0)}`.padStart(17);
  }).join("");
}

/**
 * Đặc trưng REGIME của BTC tại thời điểm t, căn đúng như `buildBtcGateLongs`: chỉ dùng nến BTC
 * đã ĐÓNG trước t (không lookahead).
 */
export function btcRegime(btc: Candle[]) {
  const sma = (len: number) => {
    const out = new Array(btc.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < btc.length; i++) {
      s += btc[i].close;
      if (i >= len) s -= btc[i - len].close;
      if (i >= len - 1) out[i] = s / len;
    }
    return out;
  };
  const fast = sma(T.btcGateFast);
  const slow = sma(T.btcGateSlow);
  const times = btc.map((c) => c.openTime);
  const idxBefore = (t: number) => {
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  };
  return (t: number, slopeBars = 60) => {
    const i = idxBefore(t);
    if (i < 0 || !Number.isFinite(slow[i])) return null;
    const j = i - slopeBars;
    return {
      gateOn: fast[i] > slow[i],
      slowRising: j >= 0 && Number.isFinite(slow[j]) ? slow[i] > slow[j] : false,
      slowSlopePct: j >= 0 && Number.isFinite(slow[j]) ? (slow[i] / slow[j] - 1) * 100 : 0,
      aboveSlow: btc[i].close > slow[i],
    };
  };
}

async function cmdBase(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const tRes = runBooks(books(data, turtle), decayH(T.heatDecayK));
  const fRes = runBooks(books(data, fast));

  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · ${data.size} coin`);
  console.log(`Phí: Turtle ${CONFIG.costs.takerFeePct}%+${CONFIG.costs.slippagePct}% slip · Fast ${MEXC_TAKER}%+${CONFIG.costs.slippagePct}% · funding ${CONFIG.costs.fundingPer8hPct}%/8h`);
  console.log(`Turtle: long ${turtle.entryDays}d→mid ${turtle.longExitDays}d · short ${turtle.shortEntryDays}d chand ${turtle.chandelierMult} · max${turtle.pyramidMaxUnits}u · heat k=${T.heatDecayK}`);
  console.log(`Fast  : long high-${fast.entryDays}d→mid ${fast.longExitDays}d · short ${fast.shortEntryDays}d+${fast.shortConfirmBars} chand · max${fast.pyramidMaxUnits}u · KHÔNG heat\n`);

  console.log("=".repeat(120));
  console.log("  D1 — NET R & Sharpe THEO NĂM (Sharpe|NET R)");
  console.log("=".repeat(120));
  console.log("sleeve".padEnd(14) + YEARS.map((y) => String(y).padStart(15)).join(""));
  console.log("TURTLE live".padEnd(14) + yearCells(tRes, w.from));
  console.log("FAST live".padEnd(14) + yearCells(fRes, w.from));

  console.log("\n" + "=".repeat(120));
  console.log("  D2 — CỬA SỔ TRƯỢT tính từ nến cuối (Sharpe|NET R|số vị thế)");
  console.log("=".repeat(120));
  console.log("sleeve".padEnd(14) + WINDOWS.map((d) => `${d}d`.padStart(17)).join(""));
  console.log("TURTLE live".padEnd(14) + windowCells(tRes, w.to));
  console.log("FAST live".padEnd(14) + windowCells(fRes, w.to));

  console.log("\n" + "=".repeat(120));
  console.log("  D3 — 365 NGÀY GẦN NHẤT: phân rã (đơn vị R, có nhân trọng số risk)");
  console.log("=".repeat(120));
  const from365 = w.to - 365 * TF_MS["1d"];
  for (const [name, res] of [["TURTLE", tRes], ["FAST", fRes]] as [string, PortfolioResult][]) {
    const tr = res.trades.filter((t) => t.entryTime >= from365);
    const grp = (xs: UnitTrade[]) => {
      const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
      const wsum = xs.reduce((s, t) => s + t.weight, 0);
      const gross = xs.reduce((s, t) => s + t.grossR * t.weight, 0);
      const cost = xs.reduce((s, t) => s + t.costR * t.weight, 0);
      return `${String(xs.length).padStart(4)}u  GROSS ${gross.toFixed(1).padStart(7)}  phí ${cost.toFixed(1).padStart(6)}  NET ${net.toFixed(1).padStart(7)}R  exp ${(wsum ? net / wsum : 0).toFixed(3).padStart(7)}`;
    };
    console.log(`\n${name}  (tổng ${grp(tr)})`);
    console.log(`  long        ${grp(tr.filter((t) => t.dir === "long"))}`);
    console.log(`  short       ${grp(tr.filter((t) => t.dir === "short"))}`);
    for (const r of ["trail", "mid", "time"]) {
      const xs = tr.filter((t) => t.exitReason === r);
      if (xs.length) console.log(`  exit=${r.padEnd(6)} ${grp(xs)}`);
    }
    for (let u = 0; u < 4; u++) {
      const xs = tr.filter((t) => t.unitIndex === u);
      if (xs.length) console.log(`  unit#${u}      ${grp(xs)}`);
    }
    const bySym = new Map<string, UnitTrade[]>();
    for (const t of tr) {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
      bySym.get(t.symbol)!.push(t);
    }
    const rows = [...bySym.entries()].map(([s, xs]) => [s, xs.reduce((a, t) => a + t.netR * t.weight, 0), xs.length] as [string, number, number]);
    rows.sort((a, b) => b[1] - a[1]);
    console.log(`  theo coin   ${rows.map(([s, n, k]) => `${s.replace("usdt", "")} ${n.toFixed(0)}R/${k}u`).join(" · ")}`);
  }

  console.log("\n" + "=".repeat(120));
  console.log("  D4 — GIẢI PHẪU VỊ THẾ 365d: MFE của lệnh thua, giveback của lệnh thắng");
  console.log("=".repeat(120));
  for (const [name, res] of [["TURTLE", tRes], ["FAST", fRes]] as [string, PortfolioResult][]) {
    for (const [tag, lo] of [["toàn kỳ", w.from], ["365d", from365]] as [string, number][]) {
      const ps = positionDiag(res, data).filter((p) => p.entryTime >= lo && p.entryTime <= w.to);
      const wins = ps.filter((p) => p.netR > 0);
      const losses = ps.filter((p) => p.netR <= 0);
      const bucket = (xs: PosDiag[], a: number, b: number) => ((xs.filter((p) => p.mfeR >= a && p.mfeR < b).length / (xs.length || 1)) * 100).toFixed(0);
      const gb = wins.filter((p) => p.mfeR > 0).map((p) => 1 - p.netR / p.mfeR).sort((a, b) => a - b);
      const posSum = wins.reduce((s, p) => s + p.netR, 0);
      const top3 = [...ps].sort((a, b) => b.netR - a.netR).slice(0, 3).reduce((s, p) => s + p.netR, 0);
      console.log(
        `${name} ${tag.padEnd(8)} ${String(ps.length).padStart(4)} vị thế · WR ${((wins.length / (ps.length || 1)) * 100).toFixed(0)}% · ` +
          `LOSS-MFE <0,5R ${bucket(losses, 0, 0.5)}% / 0,5-1R ${bucket(losses, 0.5, 1)}% / >1R ${bucket(losses, 1, Infinity)}% · ` +
          `giveback p50 ${gb.length ? (gb[Math.floor(gb.length / 2)] * 100).toFixed(0) : "-"}% · ` +
          `top3 = ${posSum > 0 ? ((top3 / posSum) * 100).toFixed(0) : "-"}% R+ · ` +
          `giữ T/L ${(wins.reduce((s, p) => s + p.holdDays, 0) / (wins.length || 1)).toFixed(1)}/${(losses.reduce((s, p) => s + p.holdDays, 0) / (losses.length || 1)).toFixed(1)}d`,
      );
    }
  }
}

/** Chi phí quy ra R phụ thuộc biến động: stop 3×ATR mà ATR% co lại ⇒ notional/R phình ⇒ phí ăn nhiều R hơn. */
async function cmdCost(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);

  console.log("\n" + "=".repeat(116));
  console.log("  C1 — PHÍ TÍNH THEO R theo năm: costR/unit, khoảng stop (%giá), số chu kỳ funding");
  console.log("=".repeat(116));
  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const res = runBooks(books(data, p), name === "TURTLE" ? decayH(T.heatDecayK) : undefined);
    console.log(`\n${name}`);
    console.log("  năm".padEnd(8) + "unit".padStart(6) + "costR/u".padStart(9) + "stop%giá".padStart(10) + "hold(h)".padStart(9) + "gross/u".padStart(9) + "net/u".padStart(8) + "  phí/|gross|");
    for (const y of YEARS) {
      const lo = Math.max(Date.UTC(y, 0, 1), w.from);
      const hi = Date.UTC(y + 1, 0, 1);
      const xs = res.trades.filter((t) => t.entryTime >= lo && t.entryTime < hi);
      if (!xs.length) continue;
      const n = xs.length;
      const cost = xs.reduce((s, t) => s + t.costR, 0) / n;
      const stopPct = (xs.reduce((s, t) => s + Math.abs(t.entryPrice - t.initialSL) / t.entryPrice, 0) / n) * 100;
      const hold = (xs.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / n) / 3600e3;
      const gross = xs.reduce((s, t) => s + t.grossR, 0) / n;
      const net = xs.reduce((s, t) => s + t.netR, 0) / n;
      const grossAbs = xs.reduce((s, t) => s + Math.abs(t.grossR), 0);
      console.log(
        `  ${y}`.padEnd(8) + String(n).padStart(6) + cost.toFixed(3).padStart(9) + stopPct.toFixed(2).padStart(10) +
          hold.toFixed(0).padStart(9) + gross.toFixed(3).padStart(9) + net.toFixed(3).padStart(8) +
          `  ${((xs.reduce((s, t) => s + t.costR, 0) / grossAbs) * 100).toFixed(1)}%`,
      );
    }
  }

  console.log("\n" + "=".repeat(116));
  console.log("  C2 — costR theo NHÓM BIẾN ĐỘNG lúc vào lệnh (ATR20%/giá): phí có thật sự phình khi vol thấp?");
  console.log("=".repeat(116));
  const atrPctAt = new Map<string, Map<number, number>>();
  for (const [sym, c] of data) {
    const a = atrSeries(c, T.atrPeriod);
    const m = new Map<number, number>();
    for (let i = 0; i < c.length; i++) m.set(c[i].openTime, (a[i] / c[i].close) * 100);
    atrPctAt.set(sym, m);
  }
  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const res = runBooks(books(data, p), name === "TURTLE" ? decayH(T.heatDecayK) : undefined);
    const tr = res.trades.filter((t) => t.entryTime >= w.from).map((t) => ({ t, v: atrPctAt.get(t.symbol)!.get(t.entryTime) ?? 0 }));
    tr.sort((a, b) => a.v - b.v);
    const q = Math.floor(tr.length / 5);
    console.log(`\n${name}  (${tr.length} unit, chia 5 nhóm theo ATR% tăng dần)`);
    console.log("  nhóm".padEnd(9) + "ATR%".padStart(8) + "unit".padStart(6) + "costR/u".padStart(9) + "gross/u".padStart(9) + "net/u".padStart(8) + "NET R".padStart(9) + "  WR");
    for (let k = 0; k < 5; k++) {
      const xs = tr.slice(k * q, k === 4 ? tr.length : (k + 1) * q);
      const n = xs.length;
      const wr = (xs.filter((x) => x.t.netR > 0).length / n) * 100;
      console.log(
        `  Q${k + 1}`.padEnd(9) +
          `${xs[0].v.toFixed(1)}-${xs[n - 1].v.toFixed(1)}`.padStart(8) +
          String(n).padStart(6) +
          (xs.reduce((s, x) => s + x.t.costR, 0) / n).toFixed(3).padStart(9) +
          (xs.reduce((s, x) => s + x.t.grossR, 0) / n).toFixed(3).padStart(9) +
          (xs.reduce((s, x) => s + x.t.netR, 0) / n).toFixed(3).padStart(8) +
          xs.reduce((s, x) => s + x.t.netR * x.t.weight, 0).toFixed(1).padStart(9) +
          `  ${wr.toFixed(0)}%`,
      );
    }
  }
}

/** Bối cảnh: khung lớn "đi ngang" đo được bằng gì, và 365d gần nhất khác các era trước ra sao? */
async function cmdRegime(days: number) {
  const data = await loadData(days);
  const w = windowOf(data, T.btcGateSlow + 130);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);

  /** Kaufman efficiency ratio trên `len` nến: |Δnet| / Σ|Δ| ∈ (0;1]. 1 = trend sạch, ~0 = chop. */
  const er = (c: Candle[], i: number, len: number) => {
    if (i < len) return 0;
    let path = 0;
    for (let k = i - len + 1; k <= i; k++) path += Math.abs(c[k].close - c[k - 1].close);
    return path > 0 ? Math.abs(c[i].close - c[i - len].close) / path : 0;
  };

  console.log("\n" + "=".repeat(112));
  console.log("  R1 — BỐI CẢNH theo năm: ER(30 nến 4h = 5d) & ER(90 nến = 15d), ATR20%, % thời gian BTC gate MỞ");
  console.log("  ER trung vị trên cả rổ; ATR% trung vị cả rổ; gate = SMA10d>SMA100d trên BTC");
  console.log("=".repeat(112));
  console.log("  năm".padEnd(8) + "ER30".padStart(8) + "ER90".padStart(8) + "ATR%".padStart(8) + "gate ON".padStart(9) + "BTC ret".padStart(9) + "  |Δ| rổ TB");
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  for (const y of YEARS) {
    const lo = Math.max(Date.UTC(y, 0, 1), w.from);
    const hi = Math.min(Date.UTC(y + 1, 0, 1), w.to);
    if (hi <= lo) continue;
    const er30: number[] = [], er90: number[] = [], atrs: number[] = [];
    let gateOn = 0, gateN = 0;
    const btc = data.get("btcusdt")!;
    for (const [, c] of data) {
      const a = atrSeries(c, T.atrPeriod);
      for (let i = 90; i < c.length; i++) {
        if (c[i].openTime < lo || c[i].openTime >= hi) continue;
        er30.push(er(c, i, 30));
        er90.push(er(c, i, 90));
        atrs.push((a[i] / c[i].close) * 100);
      }
    }
    for (const b of btc) {
      if (b.openTime < lo || b.openTime >= hi) continue;
      gateN++;
      if (gate(b.openTime, "long")) gateOn++;
    }
    const bIn = btc.filter((b) => b.openTime >= lo && b.openTime < hi);
    const btcRet = bIn.length > 1 ? ((bIn[bIn.length - 1].close / bIn[0].close - 1) * 100) : 0;
    // biên độ trung bình của rổ trong năm: (max-min)/min theo từng coin
    const spans = [...data.values()].map((c) => {
      const xs = c.filter((b) => b.openTime >= lo && b.openTime < hi);
      if (xs.length < 10) return 0;
      const hiP = Math.max(...xs.map((x) => x.high)), loP = Math.min(...xs.map((x) => x.low));
      return ((hiP - loP) / loP) * 100;
    }).filter((x) => x > 0);
    console.log(
      `  ${y}`.padEnd(8) + med(er30).toFixed(3).padStart(8) + med(er90).toFixed(3).padStart(8) +
        med(atrs).toFixed(2).padStart(8) + `${((gateOn / (gateN || 1)) * 100).toFixed(0)}%`.padStart(9) +
        `${btcRet.toFixed(0)}%`.padStart(9) + `  ${(spans.reduce((s, x) => s + x, 0) / spans.length).toFixed(0)}%`,
    );
  }

  console.log("\n" + "=".repeat(112));
  console.log("  R2 — 'Sóng nhỏ vẫn có' — đo bằng số swing ≥X% trên mỗi coin/năm (đỉnh-đáy ZigZag theo % )");
  console.log("=".repeat(112));
  /** Số CHÂN sóng ≥pct% (ZigZag): đảo chiều khi giá hồi pct% khỏi cực trị của chân đang chạy. */
  const zigzag = (c: Candle[], pct: number) => {
    if (c.length < 2) return 0;
    let n = 0;
    let dir: 1 | -1 | 0 = 0;
    let ext = c[0].close;
    for (const b of c) {
      if (dir === 1) {
        if (b.high > ext) ext = b.high;
        else if (b.low <= ext * (1 - pct / 100)) { n++; dir = -1; ext = b.low; }
      } else if (dir === -1) {
        if (b.low < ext) ext = b.low;
        else if (b.high >= ext * (1 + pct / 100)) { n++; dir = 1; ext = b.high; }
      } else {
        if (b.high >= ext * (1 + pct / 100)) { dir = 1; ext = b.high; }
        else if (b.low <= ext * (1 - pct / 100)) { dir = -1; ext = b.low; }
      }
    }
    return n;
  };
  console.log("  năm".padEnd(8) + [5, 10, 15, 25].map((p) => `swing≥${p}%`.padStart(11)).join("") + "   (trung bình mỗi coin / năm)");
  for (const y of YEARS) {
    const lo = Math.max(Date.UTC(y, 0, 1), w.from);
    const hi = Math.min(Date.UTC(y + 1, 0, 1), w.to);
    if (hi <= lo) continue;
    const frac = (hi - lo) / (365 * TF_MS["1d"]);
    const cells = [5, 10, 15, 25].map((p) => {
      const per = [...data.values()].map((c) => zigzag(c.filter((b) => b.openTime >= lo && b.openTime < hi), p));
      return ((per.reduce((s, x) => s + x, 0) / per.length) / frac).toFixed(1).padStart(11);
    });
    console.log(`  ${y}`.padEnd(8) + cells.join(""));
  }
}

/**
 * W — hai câu hỏi: (1) bên NÀO hỏng (long/short) theo từng năm, (2) cấu hình CŨ mà bot thật đã chạy
 * gần hết năm qua cho ra gì, so với cấu hình vừa ship 04/08+09/08.
 */
async function cmdWhy(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);

  console.log("\n" + "=".repeat(118));
  console.log("  W1 — LONG vs SHORT theo năm (NET R | exp/unit | số unit). Đây là chỗ hỏng, không phải 'chop chung'");
  console.log("=".repeat(118));
  for (const [name, p, admit] of [
    ["TURTLE", turtle, decayH(T.heatDecayK)],
    ["FAST", fast, undefined],
  ] as [string, ExtParams, any][]) {
    const res = runBooks(books(data, p), admit);
    console.log(`\n${name}`);
    console.log("  bên".padEnd(8) + YEARS.map((y) => String(y).padStart(18)).join(""));
    for (const dir of ["long", "short"] as const) {
      const cells = YEARS.map((y) => {
        const lo = Math.max(Date.UTC(y, 0, 1), w.from);
        const hi = Date.UTC(y + 1, 0, 1);
        const xs = res.trades.filter((t) => t.dir === dir && t.entryTime >= lo && t.entryTime < hi);
        if (!xs.length) return "—".padStart(18);
        const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
        const wsum = xs.reduce((s, t) => s + t.weight, 0);
        return `${net.toFixed(0)}|${(net / wsum).toFixed(2)}|${xs.length}`.padStart(18);
      });
      console.log(`  ${dir}`.padEnd(8) + cells.join(""));
    }
  }

  console.log("\n" + "=".repeat(118));
  console.log("  W2 — LONG: gate BTC có chặn đúng lúc không? (unit long chia theo trạng thái gate lúc vào)");
  console.log("  Gate chỉ chặn MỞ MỚI; unit pyramid vào sau vẫn chạy dù gate đã tắt.");
  console.log("=".repeat(118));
  for (const [name, p, admit] of [
    ["TURTLE", turtle, decayH(T.heatDecayK)],
    ["FAST", fast, undefined],
  ] as [string, ExtParams, any][]) {
    const res = runBooks(books(data, p), admit);
    const longs = res.trades.filter((t) => t.dir === "long" && t.entryTime >= w.from);
    const from365 = w.to - 365 * TF_MS["1d"];
    const grp = (xs: UnitTrade[]) => {
      if (!xs.length) return "—";
      const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
      const wsum = xs.reduce((s, t) => s + t.weight, 0);
      return `${String(xs.length).padStart(4)}u NET ${net.toFixed(1).padStart(7)}R exp ${(net / wsum).toFixed(3).padStart(7)}`;
    };
    console.log(`\n${name}`);
    for (const [tag, lo] of [["toàn kỳ", w.from], ["365d", from365]] as [string, number][]) {
      const xs = longs.filter((t) => t.entryTime >= lo);
      console.log(`  ${tag.padEnd(8)} tất cả long  ${grp(xs)}`);
      console.log(`  ${" ".repeat(8)} gate ON      ${grp(xs.filter((t) => gate(t.entryTime, "long")))}`);
      console.log(`  ${" ".repeat(8)} gate OFF(add)${grp(xs.filter((t) => !gate(t.entryTime, "long")))}`);
    }
  }

  console.log("\n" + "=".repeat(118));
  console.log("  W3 — CẤU HÌNH CŨ (bot thật chạy gần hết 12 tháng qua) vs CẤU HÌNH VỪA SHIP");
  console.log("  Turtle cũ = chandelier long, max4 unit, KHÔNG heat · Fast cũ = chandelier long, max4 unit");
  console.log("=".repeat(118));
  const turtleOld: ExtParams = { ...turtle, longExitMode: "chandelier", longExitDays: 0, pyramidMaxUnits: 4 };
  const fastOld: ExtParams = { ...fast, longExitMode: "chandelier", longExitDays: 0, pyramidMaxUnits: 4 };
  console.log("cấu hình".padEnd(26) + WINDOWS.map((d) => `${d}d`.padStart(17)).join(""));
  const rows: [string, ExtParams, any][] = [
    ["Turtle CŨ (chand,4u,no-heat)", turtleOld, undefined],
    ["Turtle SHIP (mid20,3u,heat)", turtle, decayH(T.heatDecayK)],
    ["Fast CŨ (chand,4u)", fastOld, undefined],
    ["Fast SHIP (mid20,3u)", fast, undefined],
  ];
  for (const [label, p, admit] of rows) {
    console.log(label.padEnd(26) + windowCells(runBooks(books(data, p), admit), w.to));
  }
}

/**
 * G — điều kiện REGIME nào tách được unit lãi khỏi unit lỗ? Đo exp/unit theo trạng thái BTC lúc VÀO.
 * Câu hỏi cốt lõi: gate hiện tại (SMA10d>SMA100d) đủ chưa, và SHORT có nên bị gate ngược lại không?
 */
async function cmdGate(days: number) {
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const reg = btcRegime(btc);
  const { turtle, fast } = liveSleeves(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const from365 = w.to - 365 * TF_MS["1d"];

  const cell = (xs: UnitTrade[]) => {
    if (!xs.length) return "        —      ";
    const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
    const wsum = xs.reduce((s, t) => s + t.weight, 0);
    return `${net.toFixed(0).padStart(6)}R ${(net / wsum).toFixed(2).padStart(6)} ${String(xs.length).padStart(4)}u`;
  };

  for (const [name, p, admit] of [
    ["TURTLE", turtle, decayH(T.heatDecayK)],
    ["FAST", fast, undefined],
  ] as [string, ExtParams, any][]) {
    const res = runBooks(books(data, p), admit);
    const tr = res.trades.filter((t) => t.entryTime >= w.from);
    console.log("\n" + "=".repeat(118));
    console.log(`  ${name} — exp/unit theo REGIME BTC lúc vào (NET R | exp | số unit).  slope = SMA100d so với 10 ngày trước`);
    console.log("=".repeat(118));
    console.log("  điều kiện".padEnd(44) + "toàn kỳ LONG".padStart(19) + "365d LONG".padStart(19) + "toàn kỳ SHORT".padStart(19) + "365d SHORT".padStart(19));
    const conds: [string, (t: UnitTrade) => boolean][] = [
      ["tất cả", () => true],
      ["gate ON (SMA10d>SMA100d)", (t) => reg(t.entryTime)?.gateOn === true],
      ["gate OFF", (t) => reg(t.entryTime)?.gateOn === false],
      ["SMA100d ĐANG LÊN", (t) => reg(t.entryTime)?.slowRising === true],
      ["SMA100d ĐANG XUỐNG", (t) => reg(t.entryTime)?.slowRising === false],
      ["gate ON + SMA100d LÊN", (t) => { const r = reg(t.entryTime); return !!r && r.gateOn && r.slowRising; }],
      ["gate ON + SMA100d XUỐNG", (t) => { const r = reg(t.entryTime); return !!r && r.gateOn && !r.slowRising; }],
      ["gate OFF + SMA100d XUỐNG", (t) => { const r = reg(t.entryTime); return !!r && !r.gateOn && !r.slowRising; }],
      ["giá BTC > SMA100d", (t) => reg(t.entryTime)?.aboveSlow === true],
      ["giá BTC < SMA100d", (t) => reg(t.entryTime)?.aboveSlow === false],
    ];
    for (const [label, f] of conds) {
      const L = tr.filter((t) => t.dir === "long" && f(t));
      const S = tr.filter((t) => t.dir === "short" && f(t));
      console.log(
        `  ${label}`.padEnd(44) +
          cell(L).padStart(19) +
          cell(L.filter((t) => t.entryTime >= from365)).padStart(19) +
          cell(S).padStart(19) +
          cell(S.filter((t) => t.entryTime >= from365)).padStart(19),
      );
    }
    // phân bố slope: chia 5 nhóm theo slopeSlowPct để xem có plateau hay chỉ 1 điểm may
    console.log(`\n  ${name} — chia 5 nhóm theo slope SMA100d (10 ngày), exp/unit:`);
    for (const dir of ["long", "short"] as const) {
      const xs = tr.filter((t) => t.dir === dir).map((t) => ({ t, s: reg(t.entryTime)?.slowSlopePct ?? 0 })).sort((a, b) => a.s - b.s);
      const q = Math.floor(xs.length / 5);
      const parts = [0, 1, 2, 3, 4].map((k) => {
        const g = xs.slice(k * q, k === 4 ? xs.length : (k + 1) * q);
        const net = g.reduce((s, x) => s + x.t.netR * x.t.weight, 0);
        const wsum = g.reduce((s, x) => s + x.t.weight, 0);
        return `[${g[0].s.toFixed(1)}..${g[g.length - 1].s.toFixed(1)}%] exp ${(net / wsum).toFixed(2)}`;
      });
      console.log(`    ${dir.padEnd(6)} ${parts.join("  ")}`);
    }
  }
}

async function main() {
  const cmd = process.argv[2] ?? "base";
  const days = parseInt(process.argv[3] ?? "2300", 10);
  if (cmd === "base") await cmdBase(days);
  else if (cmd === "cost") await cmdCost(days);
  else if (cmd === "regime") await cmdRegime(days);
  else if (cmd === "why") await cmdWhy(days);
  else if (cmd === "gate") await cmdGate(days);
  else console.log("cmd: base | cost | regime | why | gate");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
