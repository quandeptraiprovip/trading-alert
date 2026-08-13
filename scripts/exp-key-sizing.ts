/**
 * exp-key-sizing.ts — dùng KEY VOLUME làm TỈ TRỌNG RISK cho Turtle/Fast, không phải làm bộ lọc.
 *
 * ĐƯỜNG ĐI TỚI ĐÂY:
 *   1. `exp-keylevel-room.ts` cho thấy dư địa NHIỀU thì tệ hơn, dư địa ÍT thì tốt hơn — ngược giả
 *      thuyết ban đầu. Nhưng cả hai chiều làm BỘ LỌC đều thua nặng (−29…−75%): hệ trend sống bằng
 *      đuôi phải, cắt nửa số vị thế là mất đuôi.
 *   2. `exp-key-identification.ts` cho thấy hiệu ứng RẤT bền: ở CẢ TÁM mức ngưỡng key (373 → 13
 *      key/coin/năm), unit vào sát key có exp cao gấp 2–3× unit vào xa key.
 *   ⇒ Công cụ đúng là SIZING: giữ TOÀN BỘ lệnh, chỉ đổi tỉ trọng. Đúng đòn bẩy đã thắng hai lần
 *     trong repo này (heat-decay), và không tốn thêm một đồng phí nào.
 *
 * KỸ THUẬT: `askAdmit` kẹp tỉ trọng vào [0;1] nên không "phóng to" được unit sát key. Thay vào đó
 * THU NHỎ unit xa key xuống λ; vì mọi cấu hình đều được chuẩn hoá về cùng maxDD, hai cách là tương
 * đương về mặt kinh tế.
 *
 * ĐỐI CHỨNG BẮT BUỘC (nếu thiếu thì kết luận vô giá trị): key = nến volume đột biến. Một unit "sát
 * key" phần lớn nghĩa là "vài nến gần đây có volume đột biến VÀ giá chưa đi xa khỏi đó". Phần
 * "volume đột biến gần đây" chính là `confirmVolMult` — thứ đã được thử và bỏ. Vì vậy phải so với
 * ĐỐI CHỨNG chỉ-volume (có spike gần đây, BỎ QUA khoảng cách giá). Nếu đối chứng cũng tốt ngang thì
 * bộ máy key của FX Dream không đóng góp gì ngoài xác nhận volume.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-key-sizing.ts [days]
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

type Flags = Map<string, Map<number, { nearLong: boolean; nearShort: boolean; recentSpike: boolean }>>;

/**
 * Cờ theo (symbol, openTime):
 *   nearLong/nearShort — có key ĐANG HIỆU LỰC nằm trong NEAR_ATR×ATR phía trước không
 *   recentSpike        — có key nào được xác nhận trong `spikeBars` nến gần đây không (bỏ qua giá)
 * Không lookahead: chỉ nhận key có confirmedAt <= openTime của nến đang xét.
 */
function buildFlags(data: Map<string, Candle[]>, mult: number, spikeBars: number): Flags {
  const out: Flags = new Map();
  for (const [sym, c] of data) {
    const levels: KeyVolumeLevel[] = detectKeyVolumeLevels(c, "4h", { ...KEY_VOLUME_CONFIG, volumeSpikeMult: mult });
    const atr = atrSeries(c, T.atrPeriod);
    const byTime = new Map<number, { nearLong: boolean; nearShort: boolean; recentSpike: boolean }>();
    const spikeWindowMs = spikeBars * TF_MS["4h"];
    let head = 0;
    const active: KeyVolumeLevel[] = [];
    for (let i = 0; i < c.length; i++) {
      const t = c[i].openTime;
      while (head < levels.length && levels[head].confirmedAt <= t) active.push(levels[head++]);
      for (let k = active.length - 1; k >= 0; k--) if (active[k].expiresAt <= t) active.splice(k, 1);
      if (!(atr[i] > 0)) continue;
      const px = c[i].close;
      const tol = NEAR_ATR * atr[i];
      let nl = false, ns = false, rs = false;
      for (const lv of active) {
        if (lv.confirmedAt > t - spikeWindowMs) rs = true;
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

function riskForDD(series: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of series) {
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
  let e365 = 1;
  for (let i = Math.max(0, s.length - 365); i < s.length; i++) e365 *= 1 + rho * s[i];
  const wf: number[] = [];
  for (let end = 365; end <= s.length; end += 30) wf.push(sharpeOf(s.slice(end - 365, end)));
  return {
    mult: e, sharpe: sharpeOf(s), eras, e365,
    wfAvg: wf.reduce((a, x) => a + x, 0) / wf.length,
    wfNeg: wf.filter((x) => x < 0).length,
    positions: new Set(res.trades.map((t) => `${t.book}#${t.positionId}`)).size,
  };
}

const HEADER = "biến thể                          vịthế   Sharpe   VỐN(×)   era A/B/C (×)         365d(×)   WF TB  WFâm";
function printRow(label: string, r: ReturnType<typeof score>, base?: number) {
  const d = base ? ` ${((r.mult - base) / base) * 100 >= 0 ? "+" : ""}${(((r.mult - base) / base) * 100).toFixed(0)}%` : "";
  console.log(
    `${label.padEnd(33)} ${String(r.positions).padStart(5)}   ${r.sharpe.toFixed(2).padStart(6)}   ${r.mult.toFixed(2).padStart(6)}   ` +
      `${r.eras.map((x) => x.toFixed(2)).join(" / ").padEnd(20)}   ${r.e365.toFixed(2).padStart(6)}   ${r.wfAvg.toFixed(2)}  ${String(r.wfNeg).padStart(3)}${d}`,
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
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${TARGET_DD * 100}% · "sát key" = trong ${NEAR_ATR}×ATR\n`);

  const near = (f: Flags, sym: string, t: number, dir: "long" | "short") => {
    const x = f.get(sym)?.get(t);
    return x ? (dir === "long" ? x.nearLong : x.nearShort) : false;
  };
  const spike = (f: Flags, sym: string, t: number) => f.get(sym)?.get(t)?.recentSpike ?? false;

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const base = score(runBooks(bk(p), heat), w);
    for (const mult of [2, 3, 5, 8]) {
      const flags = buildFlags(data, mult, 6);
      console.log("=".repeat(112));
      console.log(`  ${name} — key spike ≥${mult}× · unit XA key bị thu nhỏ xuống λ (unit sát key giữ nguyên 1)`);
      console.log("=".repeat(112));
      console.log(HEADER);
      console.log("-".repeat(112));
      printRow("λ = 1 (đang chạy, không đổi)", base);
      for (const lam of [0.75, 0.5, 0.35, 0.2]) {
        const admit: AdmitFn = (c) => heat(c) * (near(flags, c.symbol, c.time, c.dir) ? 1 : lam);
        printRow(`λ = ${lam}`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log("  ── ĐỐI CHỨNG chỉ-volume: có spike trong 6 nến gần đây, BỎ QUA khoảng cách giá ──");
      for (const lam of [0.5, 0.35]) {
        const admit: AdmitFn = (c) => heat(c) * (spike(flags, c.symbol, c.time) ? 1 : lam);
        printRow(`ĐỐI CHỨNG volume λ = ${lam}`, score(runBooks(bk(p), admit), w), base.mult);
      }
      console.log("  ── PLACEBO đảo chiều: thu nhỏ unit SÁT key ──");
      const admitP: AdmitFn = (c) => heat(c) * (near(flags, c.symbol, c.time, c.dir) ? 0.35 : 1);
      printRow("PLACEBO đảo λ = 0.35", score(runBooks(bk(p), admitP), w), base.mult);
      console.log();
    }
  }
}

if (require.main === module && /exp-key-sizing\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
