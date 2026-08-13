/**
 * exp-version-audit.ts — BẢN 04/07 (T v2) CÓ THẬT SỰ TỐT HƠN, HAY CHỈ THẮNG MỘT CỬA SỔ?
 *
 * Bối cảnh: `exp-year-report.ts` đo được trên 365 ngày qua, T v2 (pyramid 4u + BTC gate + chandelier
 * exit + entry 20d) cho +126,7R / NET-DD 2,26 trong khi bản ĐANG CHẠY v4 chỉ +28,7R / 0,70. Câu hỏi
 * đúng không phải "bản nào thắng năm nay" mà là "thắng đó là LUẬT TỐT HƠN hay là REGIME".
 *
 * Chạy đúng bộ cửa repo dùng để bắt overfit:
 *   G1 toàn kỳ 2.028 ngày — vốn @maxDD30 (bất biến đòn bẩy), Sharpe, NET R
 *   G2 ba era theo lịch — một luật tốt phải không sụp ở era nào
 *   G3 walk-forward 56 cửa sổ 365d trượt theo tháng — Sharpe TB, số cửa sổ âm, cửa sổ tệ nhất
 *   G4 LƯỚI NẾN LỆCH PHA 0h/1h/2h/3h — thước đo giả-OOS tốt nhất repo có, vì ba pha lệch KHÔNG tham
 *      gia vào việc chọn bất kỳ tham số nào (audit §5c)
 *   G5 perturbation ±15% các tham số chính — luật thật thì chịu được nhiễu tham số
 *
 * LƯU Ý VỀ TÍNH IN-SAMPLE: v2 được chọn bằng dữ liệu tới 04/07/2026 và v4 bằng dữ liệu tới 04/08/2026.
 * Cửa sổ "365 ngày qua" NẰM TRONG cả hai tập chọn, nên nó không phải OOS cho bản nào. G4 là thứ gần
 * OOS nhất ở đây.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-version-audit.ts [g1|g4|g5|all] [days] [targetDDpct]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

const DAY = TF_MS["1d"];
const H = TF_MS["1h"];

function dailyR(res: PortfolioResult): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 1; i < res.equity.length; i++) {
    const d = Math.floor(res.equity[i].time / DAY);
    m.set(d, (m.get(d) ?? 0) + (res.equity[i].mtm - res.equity[i - 1].mtm));
  }
  return m;
}
function series(s: Map<number, number>, from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) out.push(s.get(d) ?? 0);
  return out;
}
function riskForDD(x: number[], target: number): number {
  const dd = (rho: number) => {
    let e = 1, peak = 1, m = 0;
    for (const r of x) { e *= 1 + rho * r; if (e <= 0) return 1; peak = Math.max(peak, e); m = Math.max(m, (peak - e) / peak); }
    return m;
  };
  let lo = 1e-5, hi = 0.5;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dd(mid) > target) hi = mid; else lo = mid; }
  return lo;
}
const grow = (x: number[], rho: number) => { let e = 1; for (const r of x) e *= 1 + rho * r; return e; };
const sharpeOf = (x: number[]) => {
  if (x.length < 3) return 0;
  const m = x.reduce((s, v) => s + v, 0) / x.length;
  const sd = Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(365) : 0;
};

async function main() {
  const part = (process.argv[2] ?? "all").toLowerCase();
  const days = parseInt(process.argv[3] ?? "2300", 10);
  const targetDD = parseFloat(process.argv[4] ?? "30") / 100;
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  console.log(`Cửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} · maxDD ép về ${(targetDD * 100).toFixed(0)}%\n`);

  const bk = (p: ExtParams, tag: string, d = data): Book[] =>
    [...d.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  // Các phiên bản theo mốc ship thật. v2 = "phương pháp 4/7".
  // Xác minh bằng git (bccc38f 04/07 và 1e657c1 02/08):
  //   04/07 bccc38f : entryDays 20 · KHÔNG có longExitMode/longExitDays ⇒ exit = chandelier · 4 unit
  //   02/08 1e657c1 : entryDays 15 · longExitMode "mid" ĐÃ CÓ · KHÔNG có longExitDays ⇒ thoát = vào 15d
  //                   · 4 unit · KHÔNG có heatDecayK
  //   04/08 4231253 : + heatDecayK=4 · + longExitDays=20 · 4→3 unit  ⟵ bản đang chạy
  const chand = { longExitMode: "chandelier" as const, longExitDays: 0 };
  const versionsOf = (t: ExtParams, f: ExtParams): [string, ExtParams, AdmitFn | undefined][] => [
    ["T v2 · 04/07 chand 20d 4u", { ...t, ...chand, entryDays: 20, pyramidMaxUnits: 4 }, undefined],
    ["T v2b · 19/07 chand 15d 4u", { ...t, ...chand, pyramidMaxUnits: 4 }, undefined],
    ["T v3 · 02/08 mid=vào 15d 4u", { ...t, longExitMode: "mid", longExitDays: 0, pyramidMaxUnits: 4 }, undefined],
    ["T v4 · ĐANG CHẠY heat4 mid20 3u", t, decayH(T.heatDecayK) as AdmitFn],
    ["F v1 · trước 09/08 chand 4u", { ...f, ...chand, pyramidMaxUnits: 4 }, undefined],
    ["F v2 · ĐANG CHẠY mid20 3u", f, undefined],
  ];
  const VER = versionsOf(turtle, fast);

  if (part === "g1" || part === "all") {
    console.log("=".repeat(128));
    console.log("  G1+G2+G3 — toàn kỳ, ba era, walk-forward 56 cửa sổ");
    console.log("=".repeat(128));
    console.log("phiên bản".padEnd(40) + "risk/u".padStart(8) + "vốn(×)".padStart(9) + "Sharpe".padStart(8) +
      "  era A/B/C".padEnd(22) + "365d".padStart(7) + "WF TB".padStart(7) + "WFâm".padStart(6) + "WFtệ".padStart(7));
    console.log("-".repeat(128));
    for (const [label, p, admit] of VER) {
      const s = dailyR(runBooks(bk(p, `g1${label}`), admit));
      const full = series(s, w.from, w.to);
      const rho = riskForDD(full, targetDD);
      const sh: number[] = [];
      for (let end = w.from + 365 * DAY; end <= w.to; end += 30 * DAY) sh.push(sharpeOf(series(s, end - 365 * DAY, end)));
      console.log(
        label.padEnd(40) + `${(rho * 100).toFixed(2)}%`.padStart(8) + grow(full, rho).toFixed(2).padStart(9) +
          sharpeOf(full).toFixed(2).padStart(8) + "  " +
          w.eras.map((e) => grow(series(s, e.from, e.to), rho).toFixed(2)).join(" / ").padEnd(20) +
          grow(series(s, w.to - 365 * DAY, w.to), rho).toFixed(2).padStart(7) +
          (sh.reduce((a, x) => a + x, 0) / sh.length).toFixed(2).padStart(7) +
          `${sh.filter((x) => x < 0).length}/56`.padStart(6) + Math.min(...sh).toFixed(2).padStart(7),
      );
    }
  }

  if (part === "g4" || part === "all") {
    console.log("\n" + "=".repeat(128));
    console.log("  G4 — LƯỚI NẾN LỆCH PHA (giả-OOS: ba pha lệch chưa từng tham gia chọn tham số nào)");
    console.log("=".repeat(128));
    const aggPhase = (h1: Candle[], off: number): Candle[] => {
      const b = new Map<number, Candle[]>();
      for (const x of h1) {
        const k = Math.floor((x.openTime - off * H) / TF_MS["4h"]);
        if (!b.has(k)) b.set(k, []);
        b.get(k)!.push(x);
      }
      const out: Candle[] = [];
      for (const k of [...b.keys()].sort((a, z) => a - z)) {
        const g = b.get(k)!.sort((a, z) => a.openTime - z.openTime);
        if (g.length !== 4) continue;
        out.push({
          openTime: k * TF_MS["4h"] + off * H, open: g[0].open,
          high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
          close: g[3].close, volume: g.reduce((s, x) => s + x.volume, 0),
          quoteVolume: g.reduce((s, x) => s + x.quoteVolume, 0),
          takerBuyVolume: g.reduce((s, x) => s + x.takerBuyVolume, 0),
        });
      }
      return out;
    };
    const h1 = new Map<string, Candle[]>();
    for (const s of CORE8) h1.set(s, await fetchFuturesKlinesPaged(s, "1h", Math.ceil(days * 24) + 700));

    const acc = new Map<string, number[]>();
    console.log("pha".padEnd(6) + VER.map(([l]) => l.slice(0, 14).padStart(16)).join(""));
    console.log("-".repeat(128));
    for (const ph of [0, 1, 2, 3]) {
      const dp = new Map<string, Candle[]>();
      for (const s of CORE8) dp.set(s, aggPhase(h1.get(s)!, ph));
      const gp: Gate = buildBtcGateLongs(dp.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
      const sl = liveSleeves(gp);
      const wp = coreWindow(dp, T.btcGateSlow + 130);
      const VP = versionsOf(sl.turtle, sl.fast);
      const cells: string[] = [];
      for (const [label, p, admit] of VP) {
        const s = dailyR(runBooks(bk(p, `g4${ph}${label}`, dp), admit));
        const f = series(s, wp.from, wp.to);
        const v = grow(f, riskForDD(f, targetDD));
        if (!acc.has(label)) acc.set(label, []);
        acc.get(label)!.push(v);
        cells.push(v.toFixed(2).padStart(16));
      }
      console.log(`${ph}h`.padEnd(6) + cells.join(""));
    }
    console.log("-".repeat(128));
    const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
    console.log("TB".padEnd(6) + [...acc.values()].map((v) => mean(v).toFixed(2).padStart(16)).join(""));
    console.log("phân tán (max/min)".padEnd(6) + [...acc.values()].map((v) => `${(Math.max(...v) / Math.min(...v)).toFixed(2)}×`.padStart(16)).join(""));
  }

  if (part === "g5" || part === "all") {
    console.log("\n" + "=".repeat(128));
    console.log("  G5 — PERTURBATION ±15%: luật thật chịu được nhiễu tham số; luật overfit thì không");
    console.log("=".repeat(128));
    const JIT = [0.85, 0.925, 1.0, 1.075, 1.15];
    console.log("phiên bản".padEnd(40) + "n biến thể".padStart(11) + "vốn TB".padStart(9) +
      "min".padStart(8) + "max".padStart(8) + "min/mốc".padStart(10) + "  % biến thể ≥ 80% mốc");
    console.log("-".repeat(128));
    for (const [label, p, admit] of VER) {
      const base = (() => {
        const f = series(dailyR(runBooks(bk(p, `g5b${label}`), admit)), w.from, w.to);
        return grow(f, riskForDD(f, targetDD));
      })();
      const vals: number[] = [];
      for (const je of JIT) {
        for (const jc of JIT) {
          const q: ExtParams = {
            ...p,
            entryDays: Math.max(2, Math.round(p.entryDays * je)),
            chandelierMult: +(p.chandelierMult * jc).toFixed(3),
            ...(p.longExitDays ? { longExitDays: Math.max(2, Math.round(p.longExitDays * jc)) } : {}),
          };
          const f = series(dailyR(runBooks(bk(q, `g5${label}${je}${jc}`), admit)), w.from, w.to);
          vals.push(grow(f, riskForDD(f, targetDD)));
        }
      }
      const ok = vals.filter((v) => v >= 0.8 * base).length;
      console.log(
        label.padEnd(40) + String(vals.length).padStart(11) +
          (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2).padStart(9) +
          Math.min(...vals).toFixed(2).padStart(8) + Math.max(...vals).toFixed(2).padStart(8) +
          (Math.min(...vals) / base).toFixed(2).padStart(10) +
          `  ${ok}/${vals.length} (${((ok / vals.length) * 100).toFixed(0)}%)`,
      );
    }
  }
}

if (require.main === module && /exp-version-audit\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
