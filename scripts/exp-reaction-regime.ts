/**
 * exp-reaction-regime.ts — cửa duyệt đầy đủ cho ứng viên DUY NHẤT thắng cả hai sleeve.
 *
 * ỨNG VIÊN: thu nhỏ tỉ trọng risk khi GẦN ĐÂY KHÔNG CÓ key nào được XÁC NHẬN BẰNG PHẢN ỨNG.
 * Chú ý: đây KHÔNG phải "vào lệnh gần key" — bản đó thua ở cả hai sleeve (−24…−51%). Tín hiệu ở đây
 * bỏ qua hoàn toàn khoảng cách giá; nó chỉ hỏi: **trong N nến vừa rồi, thị trường có vừa chạm một
 * vùng volume lớn rồi bật ra không?** Tức "thị trường đang tôn trọng cấu trúc" — một tín hiệu REGIME.
 *
 * Kết quả sơ bộ (`exp-reaction-key-sizing.ts`): Turtle 22,45× → 34,97× (+56%), Fast 18,74× → 28,89×
 * (+54%), Sharpe tăng ở cả hai. Đó là lần đầu trong cả đợt nghiên cứu có thứ thắng CẢ HAI sleeve.
 *
 * NGHI NGỜ CHÍNH phải loại: cú bật ≥1×ATR trong 6 nến tự nó là dấu hiệu thị trường ĐANG ĐỘNG. Nếu
 * tín hiệu chỉ là proxy cho biến động/hoạt động thì nó sẽ (a) không có cao nguyên, (b) rớt ở lưới
 * nến lệch pha, hoặc (c) bị chính ĐỐI CHỨNG BIẾN ĐỘNG THÔ đánh bại. Đo cả ba.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-reaction-regime.ts [grid|placebo|phase] [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG } from "../key-volume";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";
import { confirmByReaction, ConfirmedKey, ReactionParams } from "./exp-key-reaction";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;
const SPIKE = 3;
const P: ReactionParams = { awayAtr: 1.0, bounceAtr: 1.0, reactBars: 6, maxWaitDays: 60 };

/** "Trong `recentBars` nến vừa rồi có key nào được xác nhận bằng phản ứng không" theo (symbol, time). */
function buildRecent(data: Map<string, Candle[]>, recentBars: number, p = P, spike = SPIKE): Map<string, Map<number, boolean>> {
  const out = new Map<string, Map<number, boolean>>();
  for (const [sym, c] of data) {
    const raw = detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: spike });
    const keys: ConfirmedKey[] = confirmByReaction(c, raw, p).sort((a, b) => a.usableAt - b.usableAt);
    const m = new Map<number, boolean>();
    const winMs = recentBars * TF_MS["4h"];
    let head = 0;
    const seen: number[] = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i].openTime;
      while (head < keys.length && keys[head].usableAt <= t) seen.push(keys[head++].usableAt);
      while (seen.length && seen[0] <= t - winMs) seen.shift();
      m.set(t, seen.length > 0);
    }
    out.set(sym, m);
  }
  return out;
}

/** ĐỐI CHỨNG BIẾN ĐỘNG THÔ: ATR% có nằm trên trung vị 90 ngày trước không — không dùng key gì cả. */
function buildVolRegime(data: Map<string, Candle[]>): Map<string, Map<number, boolean>> {
  const out = new Map<string, Map<number, boolean>>();
  const LOOK = 540; // 90 ngày nến 4h
  for (const [sym, c] of data) {
    const atr = atrSeries(c, T.atrPeriod);
    const pct = c.map((b, i) => (b.close > 0 ? atr[i] / b.close : 0));
    const m = new Map<number, boolean>();
    for (let i = 0; i < c.length; i++) {
      if (i < LOOK) { m.set(c[i].openTime, true); continue; }
      const prior = pct.slice(i - LOOK, i).sort((a, b) => a - b);
      m.set(c[i].openTime, pct[i] >= prior[Math.floor(LOOK / 2)]);
    }
    out.set(sym, m);
  }
  return out;
}

function dailySeries(res: PortfolioResult, from: number, to: number): number[] {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(m.get(d) ?? 0);
  return out;
}

function riskForDD(s: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of s) {
      e *= 1 + rho * r;
      if (e <= 0) return 1;
      peak = Math.max(peak, e);
      m = Math.max(m, (peak - e) / peak);
    }
    return m;
  };
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}

const sharpeOf = (s: number[]) => {
  const mean = s.reduce((a, x) => a + x, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
  return sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
};

function score(res: PortfolioResult, from: number, to: number, eras: { from: number; to: number }[]) {
  const s = dailySeries(res, from, to);
  const rho = riskForDD(s, TARGET_DD);
  let e = 1;
  for (const x of s) e *= 1 + rho * x;
  const eraCells = eras.map((era) => {
    const a = Math.floor(era.from / DAY) - Math.floor(from / DAY);
    const b = Math.floor(era.to / DAY) - Math.floor(from / DAY);
    let v = 1;
    for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) v *= 1 + rho * s[i];
    return v;
  });
  const wf: number[] = [];
  for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
  return { mult: e, sharpe: sharpeOf(s), eras: eraCells, wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length, wfNeg: wf.filter((x) => x < 0).length };
}

async function main() {
  const mode = (process.argv[2] ?? "grid").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);

  if (mode === "grid" || mode === "placebo") {
    const data = await loadPool(days, CORE8);
    const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
    const { turtle, fast } = liveSleeves(gate);
    const w = coreWindow(data, T.btcGateSlow + 130);
    const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}%\n`);

    if (mode === "grid") {
      for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
        const base = score(runBooks(bk(p), heat), w.from, w.to, w.eras);
        console.log("=".repeat(100));
        console.log(`  ${name} — CAO NGUYÊN: VỐN(×) theo (cửa sổ "gần đây" × λ). Mốc λ=1: ${base.mult.toFixed(2)}× (Sharpe ${base.sharpe.toFixed(2)})`);
        console.log("=".repeat(100));
        console.log("nến \\ λ        0.65           0.5            0.35           0.2");
        for (const rb of [3, 6, 12, 18, 30]) {
          const rec = buildRecent(data, rb);
          const cells: string[] = [];
          for (const lam of [0.65, 0.5, 0.35, 0.2]) {
            const admit: AdmitFn = (c) => heat(c) * (rec.get(c.symbol)?.get(c.time) ? 1 : lam);
            const r = score(runBooks(bk(p), admit), w.from, w.to, w.eras);
            const d = ((r.mult - base.mult) / base.mult) * 100;
            cells.push(`${r.mult.toFixed(1)}× ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`.padStart(14));
          }
          console.log(`${String(rb).padStart(4)}   ${cells.join(" ")}`);
        }
        console.log();
      }
      return;
    }

    // placebo + đối chứng biến động thô
    const volReg = buildVolRegime(data);
    const rec = buildRecent(data, 6);
    for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
      const base = score(runBooks(bk(p), heat), w.from, w.to, w.eras);
      console.log("=".repeat(104));
      console.log(`  ${name} — PLACEBO và ĐỐI CHỨNG`);
      console.log("=".repeat(104));
      console.log("biến thể                              Sharpe   VỐN(×)   era A/B/C (×)         WF TB  WFâm");
      console.log("-".repeat(104));
      const row = (label: string, r: ReturnType<typeof score>, b?: number) => {
        const d = b ? ` ${((r.mult - b) / b) * 100 >= 0 ? "+" : ""}${(((r.mult - b) / b) * 100).toFixed(0)}%` : "";
        console.log(
          `${label.padEnd(37)} ${r.sharpe.toFixed(2).padStart(6)}   ${r.mult.toFixed(2).padStart(6)}   ` +
            `${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${r.wfAvg.toFixed(2)}  ${String(r.wfNeg).padStart(3)}${d}`,
        );
      };
      row("λ=1 (đang chạy)", base);
      row("ỨNG VIÊN: có phản ứng gần đây, λ=0.5",
        score(runBooks(bk(p), (c) => heat(c) * (rec.get(c.symbol)?.get(c.time) ? 1 : 0.5)), w.from, w.to, w.eras), base.mult);
      row("PLACEBO đảo chiều λ=0.5",
        score(runBooks(bk(p), (c) => heat(c) * (rec.get(c.symbol)?.get(c.time) ? 0.5 : 1)), w.from, w.to, w.eras), base.mult);
      row("ĐỐI CHỨNG biến động thô λ=0.5",
        score(runBooks(bk(p), (c) => heat(c) * (volReg.get(c.symbol)?.get(c.time) ? 1 : 0.5)), w.from, w.to, w.eras), base.mult);
      row("ĐỐI CHỨNG biến động ĐẢO λ=0.5",
        score(runBooks(bk(p), (c) => heat(c) * (volReg.get(c.symbol)?.get(c.time) ? 0.5 : 1)), w.from, w.to, w.eras), base.mult);
      console.log();
    }
    return;
  }

  // ── PHASE: lưới nến 4h lệch pha, cửa giả-OOS ──
  const bars1h = days * 24 + 3000;
  const h1 = new Map<string, Candle[]>();
  for (const s of CORE8) {
    const c = await fetchFuturesKlinesPaged(s, "1h", bars1h);
    if (c.length > 5000) h1.set(s, c);
  }
  const agg = (c: Candle[], offH: number): Candle[] => {
    const b = new Map<number, Candle[]>();
    for (const x of c) {
      const k = Math.floor((x.openTime - offH * TF_MS["1h"]) / TF_MS["4h"]);
      if (!b.has(k)) b.set(k, []);
      b.get(k)!.push(x);
    }
    const out: Candle[] = [];
    for (const k of [...b.keys()].sort((p1, q) => p1 - q)) {
      const g = b.get(k)!.sort((p1, q) => p1.openTime - q.openTime);
      if (g.length !== 4) continue;
      out.push({
        openTime: k * TF_MS["4h"] + offH * TF_MS["1h"],
        open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[3].close,
        volume: g.reduce((s, x) => s + x.volume, 0), quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
        takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
      });
    }
    return out;
  };

  console.log(`Cửa giả-OOS: cùng luật trên 4 lưới nến 4h lệch pha · λ=0.5, cửa sổ 6 nến\n`);
  console.log("sleeve   pha    λ=1 (đang chạy)      + ứng viên             thay đổi");
  console.log("-".repeat(80));
  for (const sleeve of ["TURTLE", "FAST"] as const) {
    let wins = 0;
    for (const ph of [0, 1, 2, 3]) {
      const data = new Map<string, Candle[]>();
      for (const [s, c] of h1) data.set(s, agg(c, ph));
      const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const params = liveSleeves(gate);
      const p: ExtParams = sleeve === "TURTLE" ? params.turtle : params.fast;
      const w = coreWindow(data, T.btcGateSlow + 130);
      const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
      const rec = buildRecent(data, 6);
      const b = score(runBooks(bk, heat), w.from, w.to, w.eras);
      const v = score(runBooks(bk, (c) => heat(c) * (rec.get(c.symbol)?.get(c.time) ? 1 : 0.5)), w.from, w.to, w.eras);
      const d = ((v.mult - b.mult) / b.mult) * 100;
      if (d > 0) wins++;
      console.log(
        `${sleeve.padEnd(8)} ${(ph === 0 ? "0h*" : `${ph}h`).padEnd(6)} ${b.sharpe.toFixed(2)} / ${b.mult.toFixed(2).padStart(6)}×` +
          `        ${v.sharpe.toFixed(2)} / ${v.mult.toFixed(2).padStart(6)}×        ${d >= 0 ? "+" : ""}${d.toFixed(0)}%`,
      );
    }
    console.log(`  → ${sleeve}: thắng ${wins}/4 pha\n`);
  }
}

if (require.main === module && /exp-reaction-regime\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
