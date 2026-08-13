/**
 * exp-reaction-key-sizing.ts — Key XÁC NHẬN BẰNG PHẢN ỨNG (rời → chạm lại → bật ra) có khai thác
 * được cho Turtle/Fast không?
 *
 * Đây là lần thứ BA cùng một cửa, với tập key khác nhau mỗi lần:
 *   1. key thô (`exp-key-sizing.ts`)             → RỚT, đối chứng chỉ-volume thắng
 *   2. key chín + sống sót (`exp-matured-key-sizing.ts`) → RỚT, placebo đảo chiều thắng ở Fast
 *   3. key xác nhận bằng PHẢN ỨNG — đây, và là định nghĩa người dùng mô tả CHÍNH XÁC nhất
 *
 * Tập key lần này tốt nhất trong ba: mật độ 57 key/coin/năm (thang người) và khoảng cách phân tách
 * exp sát/xa key rộng nhất (1,003 so với 0,786 của key thô) — xem `scripts/exp-key-reaction.ts`.
 * Nếu vẫn rớt thì kết luận không còn là "chưa tìm đúng định nghĩa key" nữa.
 *
 * Cửa duyệt giữ nguyên: đối chứng chỉ-volume · placebo đảo chiều · phải thắng CẢ HAI sleeve.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-reaction-key-sizing.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG } from "../key-volume";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";
import { confirmByReaction, ConfirmedKey, ReactionParams } from "./exp-key-reaction";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;
const NEAR_ATR = 0.25;
const SPIKE = 3;
const P: ReactionParams = { awayAtr: 1.0, bounceAtr: 1.0, reactBars: 6, maxWaitDays: 60 };

type Flags = Map<string, Map<number, { nearLong: boolean; nearShort: boolean; recent: boolean }>>;

function buildFlags(data: Map<string, Candle[]>, recentBars: number): Flags {
  const out: Flags = new Map();
  for (const [sym, c] of data) {
    const raw = detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: SPIKE });
    const keys = confirmByReaction(c, raw, P).sort((a, b) => a.usableAt - b.usableAt);
    const atr = atrSeries(c, T.atrPeriod);
    const byTime = new Map<number, { nearLong: boolean; nearShort: boolean; recent: boolean }>();
    const winMs = recentBars * TF_MS["4h"];
    let head = 0;
    const active: ConfirmedKey[] = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i].openTime;
      while (head < keys.length && keys[head].usableAt <= t) active.push(keys[head++]);
      for (let k = active.length - 1; k >= 0; k--) if (active[k].expiresAt <= t) active.splice(k, 1);
      if (!(atr[i] > 0)) continue;
      const px = c[i].close;
      const tol = NEAR_ATR * atr[i];
      let nl = false, ns = false, rc = false;
      for (const lv of active) {
        if (lv.usableAt > t - winMs) rc = true;
        const d = lv.price - px;
        if (d > 0 && d <= tol) nl = true;
        if (d < 0 && -d <= tol) ns = true;
      }
      byTime.set(t, { nearLong: nl, nearShort: ns, recent: rc });
    }
    out.set(sym, byTime);
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

type Win = ReturnType<typeof coreWindow>;

function score(res: PortfolioResult, w: Win) {
  const s = dailySeries(res, w.from, w.to);
  const rho = riskForDD(s, TARGET_DD);
  let e = 1;
  for (const x of s) e *= 1 + rho * x;
  const eras = w.eras.map((era) => {
    const a = Math.floor(era.from / DAY) - Math.floor(w.from / DAY);
    const b = Math.floor(era.to / DAY) - Math.floor(w.from / DAY);
    let v = 1;
    for (let i = Math.max(0, a); i < Math.min(s.length, b); i++) v *= 1 + rho * s[i];
    return v;
  });
  const wf: number[] = [];
  for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
  return { mult: e, sharpe: sharpeOf(s), eras, wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length, wfNeg: wf.filter((x) => x < 0).length };
}

function row(label: string, r: ReturnType<typeof score>, base?: number) {
  const d = base ? ` ${((r.mult - base) / base) * 100 >= 0 ? "+" : ""}${(((r.mult - base) / base) * 100).toFixed(0)}%` : "";
  console.log(
    `${label.padEnd(32)} ${r.sharpe.toFixed(2).padStart(6)}   ${r.mult.toFixed(2).padStart(6)}   ` +
      `${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${r.wfAvg.toFixed(2)}  ${String(r.wfNeg).padStart(3)}${d}`,
  );
}

async function main() {
  const days = parseInt(process.argv[2] ?? "2300", 10);
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const heat: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / T.heatDecayK);
  const bk = (p: ExtParams): Book[] => [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
  const flags = buildFlags(data, 6);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}%`);
  console.log(`Key: spike ≥${SPIKE}× · rời ${P.awayAtr}ATR → chạm lại → bật ${P.bounceAtr}ATR trong ${P.reactBars} nến\n`);

  const near = (s: string, t: number, d: "long" | "short") => {
    const x = flags.get(s)?.get(t);
    return x ? (d === "long" ? x.nearLong : x.nearShort) : false;
  };
  const recent = (s: string, t: number) => flags.get(s)?.get(t)?.recent ?? false;

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const base = score(runBooks(bk(p), heat), w);
    console.log("=".repeat(110));
    console.log(`  ${name}`);
    console.log("=".repeat(110));
    console.log("biến thể                         Sharpe   VỐN(×)   era A/B/C (×)         WF TB  WFâm");
    console.log("-".repeat(110));
    row("λ = 1 (đang chạy)", base);
    for (const lam of [0.5, 0.35]) {
      const admit: AdmitFn = (c) => heat(c) * (near(c.symbol, c.time, c.dir) ? 1 : lam);
      row(`sát key-phản-ứng · λ=${lam}`, score(runBooks(bk(p), admit), w), base.mult);
    }
    console.log("  ── ĐỐI CHỨNG chỉ-volume (có key phản ứng gần đây, BỎ QUA khoảng cách giá) ──");
    for (const lam of [0.5, 0.35]) {
      const admit: AdmitFn = (c) => heat(c) * (recent(c.symbol, c.time) ? 1 : lam);
      row(`ĐỐI CHỨNG λ=${lam}`, score(runBooks(bk(p), admit), w), base.mult);
    }
    console.log("  ── PLACEBO đảo chiều ──");
    const admitP: AdmitFn = (c) => heat(c) * (near(c.symbol, c.time, c.dir) ? 0.35 : 1);
    row("PLACEBO đảo λ=0.35", score(runBooks(bk(p), admitP), w), base.mult);
    console.log();
  }
}

if (require.main === module && /exp-reaction-key-sizing\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
