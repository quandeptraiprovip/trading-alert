/**
 * exp-matured-key-sizing.ts — Key ĐÃ CHÍN có khai thác được cho Turtle/Fast không?
 *
 * BỐI CẢNH: `exp-key-sizing.ts` từng thử dùng key thô làm tỉ trọng risk và RỚT — bị chính ĐỐI CHỨNG
 * chỉ-volume đánh bại (Fast +38% vs −30%), tức phần VỊ TRÍ GIÁ của key không đóng góp gì.
 *
 * CÁI ĐỔI: `exp-key-maturation.ts` cho thấy điều kiện người dùng mô tả — cây volume chỉ thành Key
 * sau khi đã "đứng được một thời gian" — khi cài đúng (chờ đủ tuổi VÀ giá không đóng xuyên trong lúc
 * chờ) thì mật độ rơi 157 → 29–75 key/coin/năm (vào đúng thang người) và khoảng cách exp sát/xa key
 * RỘNG RA (0,79 → 0,86–0,94), tạo cao nguyên qua mọi mức tuổi 1–30 ngày.
 *
 * Vậy đây là một TẬP KEY KHÁC HẲN tập đã bị loại. Phải chấm lại bằng đúng cửa đã giết bản trước:
 *   1. ĐỐI CHỨNG chỉ-volume — nếu nó lại thắng thì vị trí giá vẫn vô dụng, kết thúc.
 *   2. PLACEBO đảo chiều phải xấu.
 *   3. Phải thắng ở CẢ HAI sleeve (cùng đọc một chuỗi giá).
 *   4. Cao nguyên theo tuổi chín, không phải một điểm.
 *
 * Kỹ thuật: `askAdmit` kẹp tỉ trọng ≤1 nên không phóng to được unit sát key; thay vào đó THU NHỎ
 * unit xa key xuống λ. Vì mọi cấu hình đều chuẩn hoá về cùng maxDD, hai cách tương đương về kinh tế.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-matured-key-sizing.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, atrSeries, buildBtcGateLongs } from "../turtle";
import { detectKeyVolumeLevels, KEY_VOLUME_CONFIG, KeyVolumeLevel } from "../key-volume";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];
const TARGET_DD = 0.3;
const NEAR_ATR = 0.25;
const SPIKE = 3;

type Matured = KeyVolumeLevel & { matureAt: number };

/** Chín = đủ tuổi VÀ giá không đóng xuyên mức trong lúc chờ. Chỉ đọc nến đã đóng trước `matureAt`. */
export function matureKeys(c: Candle[], levels: KeyVolumeLevel[], minAgeDays: number): Matured[] {
  if (minAgeDays <= 0) return levels.map((l) => ({ ...l, matureAt: l.confirmedAt }));
  const out: Matured[] = [];
  const ageMs = minAgeDays * DAY;
  for (const lv of levels) {
    const matureAt = lv.confirmedAt + ageMs;
    if (matureAt >= lv.expiresAt) continue;
    let side = 0, broken = false;
    for (const bar of c) {
      if (bar.openTime < lv.confirmedAt) continue;
      if (bar.openTime >= matureAt) break;
      const s = Math.sign(bar.close - lv.price);
      if (s === 0) continue;
      if (side === 0) side = s;
      else if (s !== side) { broken = true; break; }
    }
    if (!broken) out.push({ ...lv, matureAt });
  }
  return out;
}

type Flags = Map<string, Map<number, { nearLong: boolean; nearShort: boolean; recentSpike: boolean }>>;

function buildFlags(data: Map<string, Candle[]>, minAgeDays: number, spikeBars: number): Flags {
  const out: Flags = new Map();
  for (const [sym, c] of data) {
    const raw = detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: SPIKE });
    const levels = matureKeys(c, raw, minAgeDays).sort((a, b) => a.matureAt - b.matureAt);
    const atr = atrSeries(c, T.atrPeriod);
    const byTime = new Map<number, { nearLong: boolean; nearShort: boolean; recentSpike: boolean }>();
    const winMs = spikeBars * TF_MS["4h"];
    let head = 0;
    const active: Matured[] = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i].openTime;
      while (head < levels.length && levels[head].matureAt <= t) active.push(levels[head++]);
      for (let k = active.length - 1; k >= 0; k--) if (active[k].expiresAt <= t) active.splice(k, 1);
      if (!(atr[i] > 0)) continue;
      const px = c[i].close;
      const tol = NEAR_ATR * atr[i];
      let nl = false, ns = false, rs = false;
      for (const lv of active) {
        if (lv.matureAt > t - winMs) rs = true;
        const d = lv.price - px;
        if (d > 0 && d <= tol) nl = true;
        if (d < 0 && -d <= tol) ns = true;
      }
      byTime.set(t, { nearLong: nl, nearShort: ns, recentSpike: rs });
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
    `${label.padEnd(34)} ${r.sharpe.toFixed(2).padStart(6)}   ${r.mult.toFixed(2).padStart(6)}   ` +
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
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}% · key spike ≥${SPIKE}×, "sát key" ≤${NEAR_ATR}×ATR\n`);

  const near = (f: Flags, s: string, t: number, d: "long" | "short") => {
    const x = f.get(s)?.get(t);
    return x ? (d === "long" ? x.nearLong : x.nearShort) : false;
  };
  const spike = (f: Flags, s: string, t: number) => f.get(s)?.get(t)?.recentSpike ?? false;

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const base = score(runBooks(bk(p), heat), w);
    console.log("=".repeat(112));
    console.log(`  ${name} — thu nhỏ unit XA key-đã-chín xuống λ (unit sát key giữ 1)`);
    console.log("=".repeat(112));
    console.log("biến thể                           Sharpe   VỐN(×)   era A/B/C (×)         WF TB  WFâm");
    console.log("-".repeat(112));
    row("λ = 1 (đang chạy)", base);
    for (const age of [3, 7, 14]) {
      const flags = buildFlags(data, age, 6);
      for (const lam of [0.5, 0.35]) {
        const admit: AdmitFn = (c) => heat(c) * (near(flags, c.symbol, c.time, c.dir) ? 1 : lam);
        row(`chín ${age}d · λ=${lam}`, score(runBooks(bk(p), admit), w), base.mult);
      }
    }
    console.log("  ── ĐỐI CHỨNG chỉ-volume (có key chín gần đây, BỎ QUA khoảng cách giá) ──");
    {
      const flags = buildFlags(data, 7, 6);
      for (const lam of [0.5, 0.35]) {
        const admit: AdmitFn = (c) => heat(c) * (spike(flags, c.symbol, c.time) ? 1 : lam);
        row(`ĐỐI CHỨNG volume λ=${lam}`, score(runBooks(bk(p), admit), w), base.mult);
      }
      const admitP: AdmitFn = (c) => heat(c) * (near(flags, c.symbol, c.time, c.dir) ? 0.35 : 1);
      console.log("  ── PLACEBO đảo chiều ──");
      row("PLACEBO chín 7d · đảo λ=0.35", score(runBooks(bk(p), admitP), w), base.mult);
    }
    console.log();
  }
}

if (require.main === module && /exp-matured-key-sizing\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
