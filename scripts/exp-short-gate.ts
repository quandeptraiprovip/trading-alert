/**
 * exp-short-gate.ts — 2026-08-10. Phát hiện từ `chop-diagnosis.ts gate`:
 *
 *   SHORT vào lúc BTC ở regime TĂNG (SMA10d>SMA100d) có exp ~0,30R/unit toàn kỳ và ~1,19R/unit trong
 *   365 ngày qua; SHORT vào lúc regime GIẢM chỉ ~0,06R/unit. Ngược hoàn toàn với trực giác — nhưng có
 *   cơ chế: khi BTC còn mạnh mà một alt vẫn phá đáy close 30 ngày thì đó là YẾU RIÊNG (idiosyncratic),
 *   nó tiếp tục rơi. Khi BTC tự rơi thì tất cả rơi cùng nhau, breakout xuống đông đúc → dễ bị squeeze.
 *
 * Hiện tại luật live để SHORT TỰ DO (`buildBtcGateLongs` trả true cho mọi short).
 *
 * Kiểm định theo đúng kỷ luật repo: cả 3 era dương + plateau tham số + placebo hướng ngược +
 * chấm bằng Sharpe và NET/maxDD (bất biến đòn bẩy), KHÔNG chỉ NET R thô.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-short-gate.ts <main|plateau|years> [days]
 */
import { Candle, TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { ExtParams, PortfolioResult, UnitTrade, riskMetrics, runBooks } from "./portfolio-engine";
import { loadData, windowOf, decayH, books, fmtD, Gate } from "./rx-lab";
import { liveSleeves } from "./chop-diagnosis";

/** SMA nhanh/chậm của BTC tại nến đã ĐÓNG trước `t` (căn giống buildBtcGateLongs — không lookahead). */
function btcRegimeOn(btc: Candle[], fastLen: number, slowLen: number): (t: number) => boolean {
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
  const f = sma(fastLen), s = sma(slowLen);
  const times = btc.map((c) => c.openTime);
  return (t: number) => {
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx < 0 || !Number.isFinite(f[idx]) || !Number.isFinite(s[idx])) return true;
    return f[idx] > s[idx];
  };
}

/** Gate hai chiều: long theo luật cũ, short theo `shortRule`. */
function makeGate(btc: Candle[], shortRule: (t: number) => boolean): Gate {
  const longGate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  return (t: number, dir: "long" | "short") => (dir === "long" ? longGate(t, "long") : shortRule(t));
}

interface Res {
  label: string;
  sharpe: number;
  net: number;
  maxDD: number;
  netDd: number;
  units: number;
  shortUnits: number;
  expShort: number;
  eraSharpe: number[];
  eraNet: number[];
  res: PortfolioResult;
}

function score(label: string, res: PortfolioResult, w: ReturnType<typeof windowOf>): Res {
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const m = riskMetrics(eq);
  const tr = res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
  const sh = tr.filter((t) => t.dir === "short");
  const shNet = sh.reduce((s, t) => s + t.netR * t.weight, 0);
  const shW = sh.reduce((s, t) => s + t.weight, 0);
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  return {
    label,
    sharpe: m.sharpe,
    net: m.netR,
    maxDD: m.maxDD,
    netDd: m.netOverMaxDD,
    units: tr.length,
    shortUnits: sh.length,
    expShort: shW ? shNet / shW : 0,
    eraSharpe: eras.map((x) => x.sharpe),
    eraNet: eras.map((x) => x.netR),
    res,
  };
}

const HDR =
  "biến thể".padEnd(30) + "unit".padStart(6) + "short".padStart(7) + "expS".padStart(7) +
  "NET R".padStart(8) + "maxDD".padStart(7) + "N/DD".padStart(7) + "Sharpe".padStart(8) +
  "  | Sharpe A/B/C           | NET A/B/C";

function row(r: Res, base?: Res) {
  const norm = base && r.maxDD > 0 ? (r.net * base.maxDD) / r.maxDD : undefined;
  console.log(
    r.label.padEnd(30) + String(r.units).padStart(6) + String(r.shortUnits).padStart(7) +
      r.expShort.toFixed(2).padStart(7) + r.net.toFixed(0).padStart(8) + r.maxDD.toFixed(0).padStart(7) +
      r.netDd.toFixed(2).padStart(7) + r.sharpe.toFixed(2).padStart(8) + "  |" +
      r.eraSharpe.map((s) => s.toFixed(2).padStart(7)).join("") + "   |" +
      r.eraNet.map((s) => s.toFixed(0).padStart(6)).join("") +
      (norm !== undefined ? `   NETtđ ${norm.toFixed(0).padStart(5)}` : ""),
  );
}

const WINDOWS = [180, 365, 545, 730, 1095];
function winCells(res: PortfolioResult, to: number): string {
  return WINDOWS.map((d) => {
    const from = to - d * TF_MS["1d"];
    const m = riskMetrics(res.equity.filter((e) => e.time >= from));
    return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(14);
  }).join("");
}

async function cmdMain(days: number) {
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const w = windowOf(data, T.btcGateSlow + 130);
  const always = () => true;
  const on = btcRegimeOn(btc, T.btcGateFast, T.btcGateSlow);
  const off = (t: number) => !on(t);

  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${((w.to - w.from) / TF_MS["1d"]).toFixed(0)} ngày, ${data.size} coin)`);
  console.log(`Era A ${fmtD(w.eras[0].from)}→${fmtD(w.eras[0].to)} · B →${fmtD(w.eras[1].to)} · C →${fmtD(w.eras[2].to)}\n`);

  for (const sleeve of ["turtle", "fast"] as const) {
    console.log("=".repeat(132));
    console.log(`  ${sleeve.toUpperCase()} — luật SHORT (long giữ nguyên gate cũ). expS = exp/unit của riêng SHORT`);
    console.log("=".repeat(132));
    console.log(HDR);
    console.log("-".repeat(132));
    const admit = sleeve === "turtle" ? decayH(T.heatDecayK) : undefined;
    const mk = (rule: (t: number) => boolean, extra?: Partial<ExtParams>) => {
      const p = { ...liveSleeves(makeGate(btc, rule))[sleeve], ...extra } as ExtParams;
      return runBooks(books(data, p), admit);
    };
    const base = score("BASE short tự do (live)", mk(always), w);
    row(base);
    const gated = score("short CHỈ khi BTC regime ↑", mk(on), w);
    row(gated, base);
    const placebo = score("PLACEBO: short khi BTC ↓", mk(off), w);
    row(placebo, base);

    console.log("\n  cửa sổ trượt (Sharpe|NET R):");
    console.log("  " + "biến thể".padEnd(28) + WINDOWS.map((d) => `${d}d`.padStart(14)).join(""));
    console.log("  " + "BASE short tự do".padEnd(28) + winCells(base.res, w.to));
    console.log("  " + "short chỉ khi BTC ↑".padEnd(28) + winCells(gated.res, w.to));
    console.log("  " + "PLACEBO short khi BTC ↓".padEnd(28) + winCells(placebo.res, w.to));
    console.log();
  }
}

/** Plateau: luật có sống với MỌI cặp (fast,slow) quanh 60/600 hay chỉ đúng ở một điểm? */
async function cmdPlateau(days: number) {
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const w = windowOf(data, T.btcGateSlow + 130);
  const fasts = [30, 45, 60, 90, 120];
  const slows = [300, 450, 600, 750, 900];

  for (const sleeve of ["turtle", "fast"] as const) {
    const admit = sleeve === "turtle" ? decayH(T.heatDecayK) : undefined;
    const baseRes = runBooks(books(data, liveSleeves(makeGate(btc, () => true))[sleeve]), admit);
    const b = score("base", baseRes, w);
    console.log("\n" + "=".repeat(110));
    console.log(`  ${sleeve.toUpperCase()} — PLATEAU của gate SHORT. Ô = Sharpe toàn kỳ (base short tự do = ${b.sharpe.toFixed(2)})`);
    console.log("  hàng = SMA nhanh (nến 4h), cột = SMA chậm");
    console.log("=".repeat(110));
    console.log("fast\\slow".padEnd(11) + slows.map((s) => `${s / 6}d`.padStart(9)).join(""));
    for (const f of fasts) {
      const cells = slows.map((s) => {
        if (f >= s) return "—".padStart(9);
        const res = runBooks(books(data, liveSleeves(makeGate(btc, btcRegimeOn(btc, f, s)))[sleeve]), admit);
        return riskMetrics(res.equity.filter((e) => e.time >= w.from)).sharpe.toFixed(2).padStart(9);
      });
      console.log(`${f / 6}d`.padEnd(11) + cells.join(""));
    }
    console.log("\n  cùng lưới, chấm bằng NET/maxDD (base = " + b.netDd.toFixed(2) + "):");
    console.log("fast\\slow".padEnd(11) + slows.map((s) => `${s / 6}d`.padStart(9)).join(""));
    for (const f of fasts) {
      const cells = slows.map((s) => {
        if (f >= s) return "—".padStart(9);
        const res = runBooks(books(data, liveSleeves(makeGate(btc, btcRegimeOn(btc, f, s)))[sleeve]), admit);
        return riskMetrics(res.equity.filter((e) => e.time >= w.from)).netOverMaxDD.toFixed(2).padStart(9);
      });
      console.log(`${f / 6}d`.padEnd(11) + cells.join(""));
    }
  }
}

/** Theo năm — luật mới có làm hỏng năm gấu 2022 (lúc gate gần như luôn TẮT) không? */
async function cmdYears(days: number) {
  const data = await loadData(days);
  const btc = data.get("btcusdt")!;
  const w = windowOf(data, T.btcGateSlow + 130);
  const on = btcRegimeOn(btc, T.btcGateFast, T.btcGateSlow);
  const years = [2021, 2022, 2023, 2024, 2025, 2026];

  for (const sleeve of ["turtle", "fast"] as const) {
    const admit = sleeve === "turtle" ? decayH(T.heatDecayK) : undefined;
    const variants: [string, (t: number) => boolean][] = [
      ["BASE short tự do", () => true],
      ["short chỉ khi BTC ↑", on],
    ];
    console.log("\n" + "=".repeat(120));
    console.log(`  ${sleeve.toUpperCase()} theo NĂM (Sharpe | NET R | số unit)`);
    console.log("=".repeat(120));
    console.log("biến thể".padEnd(24) + years.map((y) => String(y).padStart(16)).join(""));
    for (const [label, rule] of variants) {
      const res = runBooks(books(data, liveSleeves(makeGate(btc, rule))[sleeve]), admit);
      const cells = years.map((y) => {
        const lo = Math.max(Date.UTC(y, 0, 1), w.from);
        const hi = Date.UTC(y + 1, 0, 1);
        const eq = res.equity.filter((e) => e.time >= lo && e.time < hi);
        if (eq.length < 3) return "—".padStart(16);
        const m = riskMetrics(eq);
        const n = res.trades.filter((t) => t.entryTime >= lo && t.entryTime < hi).length;
        return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}|${n}`.padStart(16);
      });
      console.log(label.padEnd(24) + cells.join(""));
    }
    // SHORT tách riêng theo năm × trạng thái gate — kiểm tra 2022 và độ ổn định qua era
    const res = runBooks(books(data, liveSleeves(makeGate(btc, () => true))[sleeve]), admit);
    const sh = res.trades.filter((t) => t.dir === "short" && t.entryTime >= w.from);
    console.log(`\n  SHORT tách theo năm × regime (NET R | exp | unit):`);
    console.log("  " + "regime".padEnd(14) + years.map((y) => String(y).padStart(18)).join(""));
    for (const [tag, f] of [["BTC ↑ (gate ON)", (t: UnitTrade) => on(t.entryTime)], ["BTC ↓ (gate OFF)", (t: UnitTrade) => !on(t.entryTime)]] as [string, (t: UnitTrade) => boolean][]) {
      const cells = years.map((y) => {
        const lo = Math.max(Date.UTC(y, 0, 1), w.from);
        const hi = Date.UTC(y + 1, 0, 1);
        const xs = sh.filter((t) => f(t) && t.entryTime >= lo && t.entryTime < hi);
        if (!xs.length) return "—".padStart(18);
        const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
        const wt = xs.reduce((s, t) => s + t.weight, 0);
        return `${net.toFixed(0)}|${(net / wt).toFixed(2)}|${xs.length}`.padStart(18);
      });
      console.log("  " + tag.padEnd(14) + cells.join(""));
    }
  }
}

async function main() {
  const cmd = process.argv[2] ?? "main";
  const days = parseInt(process.argv[3] ?? "2300", 10);
  if (cmd === "main") await cmdMain(days);
  else if (cmd === "plateau") await cmdPlateau(days);
  else if (cmd === "years") await cmdYears(days);
  else console.log("cmd: main | plateau | years");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
