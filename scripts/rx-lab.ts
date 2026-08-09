/**
 * rx-lab.ts — bàn thí nghiệm 2026-08-09: đo lại HAI sleeve đang chạy (Turtle/Binance,
 * Fast/MEXC) trên cùng một engine danh mục, rồi thử các hướng khắc phục điểm yếu.
 *
 * Nguyên tắc (theo bài học repo):
 *   - Metric chính BẤT BIẾN ĐÒN BẨY: Sharpe P&L ngày, NET/maxDD, và NET quy đổi cùng maxDD.
 *     NET R thô chỉ có nghĩa khi hai cấu hình chạy cùng risk/unit VÀ cùng maxDD.
 *   - Mọi ứng viên phải qua: cả 3 era dương + plateau tham số + walk-forward, chứ không phải
 *     một điểm tối ưu.
 *   - Fast dùng phí MEXC (0,08 taker), Turtle dùng phí Binance (0,05 taker).
 *
 * Run: ./node_modules/.bin/ts-node scripts/rx-lab.ts <base|diag|...> [days]
 */
import { Candle, CONFIG, TF_MS } from "../strategy";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { T, TurtleParams, buildBtcGateLongs } from "../turtle";
import {
  Book,
  EquityPoint,
  ExtParams,
  PortfolioResult,
  UnitTrade,
  AdmitFn,
  portfolioStats,
  riskMetrics,
  runBooks,
} from "./portfolio-engine";
import { BASKET } from "./portfolio-equivalence";

export const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const MEXC_TAKER = 0.08; // % một chiều (Fast chạy trên MEXC)

export async function loadData(days: number, symbols = BASKET): Promise<Map<string, Candle[]>> {
  const bpd = TF_MS["1d"] / TF_MS["4h"];
  const bars = Math.ceil(days * bpd) + T.btcGateSlow + 200;
  const data = new Map<string, Candle[]>();
  for (const s of symbols) {
    const c = await fetchFuturesKlinesPaged(s, "4h", bars);
    if (c.length >= 500) data.set(s, c);
  }
  return data;
}

export type Gate = NonNullable<TurtleParams["gate"]>;

/** Bộ tham số của HAI sleeve đang chạy production (đọc thẳng từ code live). */
export function sleeveParams(gate: Gate): { turtle: ExtParams; fast: ExtParams } {
  const turtle: ExtParams = { ...T, gate };
  const fast: ExtParams = {
    ...T,
    gate,
    entryDays: 10,
    longEntrySource: "high",
    longExitMode: "chandelier",
    longExitDays: 0,
    shortEntryDays: 30,
    shortEntrySource: "close",
    shortExitMode: "chandelier",
    shortConfirmBars: 1,
    initialStopObLookback: 0, // Fast dùng thẳng 3×ATR, không có structural stop
    pyramidMaxUnits: 4,
    takerFeePct: MEXC_TAKER,
  };
  return { turtle, fast };
}

export interface Window {
  from: number;
  to: number;
  eras: { name: string; from: number; to: number }[];
}

export function windowOf(data: Map<string, Candle[]>, warmupBars: number): Window {
  let from = -Infinity;
  let to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmupBars, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const eras = [0, 1, 2].map((k) => ({
    name: ["A", "B", "C"][k],
    from: from + ((to - from) * k) / 3,
    to: from + ((to - from) * (k + 1)) / 3,
  }));
  return { from, to, eras };
}

export const decayH = (k: number): AdmitFn => (c) => 1 / (1 + c.sameDirHeat / k);

export function books(data: Map<string, Candle[]>, p: ExtParams, tag = ""): Book[] {
  return [...data.entries()].map(([symbol, candles]) => ({
    key: tag ? `${symbol}@${tag}` : symbol,
    symbol,
    candles,
    p,
  }));
}

export interface Row {
  label: string;
  units: number;
  positions: number;
  net: number;
  exp: number;
  sharpe: number;
  netOverUlcer: number;
  netOverDd: number;
  maxDD: number;
  eraSharpe: number[];
  eraNet: number[];
  res: PortfolioResult;
}

export function evaluate(label: string, bs: Book[], admit: AdmitFn | undefined, w: Window): Row {
  const res = runBooks(bs, admit);
  const eq = res.equity.filter((e) => e.time >= w.from && e.time <= w.to);
  const rm = riskMetrics(eq);
  const st = portfolioStats(res, { from: w.from, to: w.to });
  const eras = w.eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to)));
  return {
    label,
    units: st.n,
    positions: st.positions,
    net: rm.netR,
    exp: st.exp,
    sharpe: rm.sharpe,
    netOverUlcer: rm.netOverUlcer,
    netOverDd: rm.netOverMaxDD,
    maxDD: rm.maxDD,
    eraSharpe: eras.map((e) => e.sharpe),
    eraNet: eras.map((e) => e.netR),
    res,
  };
}

export const HEADER =
  "biến thể".padEnd(34) +
  "unit".padStart(6) +
  "vị thế".padStart(7) +
  "NET R".padStart(8) +
  "exp/u".padStart(8) +
  "Sharpe".padStart(8) +
  "N/Ulc".padStart(7) +
  "N/DD".padStart(7) +
  "  | Sharpe A / B / C";

export function printRow(r: Row, baseNet?: number, baseDd?: number) {
  const norm = baseDd !== undefined && r.maxDD > 0 ? (r.net * baseDd) / r.maxDD : undefined;
  console.log(
    r.label.padEnd(34) +
      String(r.units).padStart(6) +
      String(r.positions).padStart(7) +
      r.net.toFixed(0).padStart(8) +
      r.exp.toFixed(3).padStart(8) +
      r.sharpe.toFixed(2).padStart(8) +
      r.netOverUlcer.toFixed(1).padStart(7) +
      r.netOverDd.toFixed(2).padStart(7) +
      "  |" +
      r.eraSharpe.map((s) => s.toFixed(2).padStart(7)).join("") +
      (norm !== undefined ? `   NETtđ ${norm.toFixed(0).padStart(5)}` : "") +
      (baseNet !== undefined && norm !== undefined
        ? ` (${norm >= baseNet ? "+" : ""}${(((norm - baseNet) / Math.abs(baseNet)) * 100).toFixed(0)}%)`
        : ""),
  );
}

// ─────────────────────────────────────────────
// Chẩn đoán: MFE/giveback theo VỊ THẾ (không phải unit)
// ─────────────────────────────────────────────
export interface PosDiag {
  book: string;
  symbol: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  netR: number; // tổng netR có trọng số của cả vị thế
  units: number;
  mfeR: number; // MFE của unit ĐẦU tiên, tính theo R của unit đó (bảo thủ: bỏ nến exit)
  holdDays: number;
  exitReason: string;
}

export function positionDiag(res: PortfolioResult, data: Map<string, Candle[]>): PosDiag[] {
  const byPos = new Map<string, UnitTrade[]>();
  for (const t of res.trades) {
    const k = `${t.book}#${t.positionId}`;
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k)!.push(t);
  }
  const out: PosDiag[] = [];
  for (const [, us] of byPos) {
    us.sort((a, b) => a.unitIndex - b.unitIndex);
    const u0 = us[0];
    const c = data.get(u0.symbol);
    if (!c) continue;
    const risk = Math.abs(u0.entryPrice - u0.initialSL);
    let mfe = 0;
    for (const bar of c) {
      if (bar.openTime <= u0.entryTime) continue;
      if (bar.openTime >= u0.exitTime) break; // bỏ nến exit — không biết thứ tự intrabar
      const fav = u0.dir === "long" ? bar.high - u0.entryPrice : u0.entryPrice - bar.low;
      mfe = Math.max(mfe, fav / risk);
    }
    out.push({
      book: u0.book,
      symbol: u0.symbol,
      dir: u0.dir,
      entryTime: u0.entryTime,
      exitTime: u0.exitTime,
      netR: us.reduce((s, t) => s + t.netR * t.weight, 0),
      units: us.length,
      mfeR: mfe,
      holdDays: (u0.exitTime - u0.entryTime) / TF_MS["1d"],
      exitReason: u0.exitReason,
    });
  }
  return out.sort((a, b) => a.entryTime - b.entryTime);
}

// ─────────────────────────────────────────────
// COMMANDS
// ─────────────────────────────────────────────
async function cmdBase(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const totalDays = (w.to - w.from) / TF_MS["1d"];
  console.log(`\nCửa sổ chung: ${fmtD(w.from)} → ${fmtD(w.to)} (${totalDays.toFixed(0)} ngày, ${data.size} coin)`);
  console.log(`Era A ${fmtD(w.eras[0].from)}→${fmtD(w.eras[0].to)} · B →${fmtD(w.eras[1].to)} · C →${fmtD(w.eras[2].to)}`);
  console.log(`Phí: Turtle ${CONFIG.costs.takerFeePct}% + ${CONFIG.costs.slippagePct}% slip · Fast ${MEXC_TAKER}% + ${CONFIG.costs.slippagePct}% slip · funding ${CONFIG.costs.fundingPer8hPct}%/8h\n`);

  console.log("=".repeat(120));
  console.log("  BASELINE — hai sleeve ĐANG CHẠY (mỗi sleeve một sổ risk riêng, đúng như production)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  const tBase = evaluate("TURTLE live (heat k=4)", books(data, turtle), decayH(T.heatDecayK), w);
  printRow(tBase);
  const tNoHeat = evaluate("  turtle không heat-decay", books(data, turtle), undefined, w);
  printRow(tNoHeat, tBase.net, tBase.maxDD);
  const fBase = evaluate("FAST live (không heat)", books(data, fast), undefined, w);
  printRow(fBase);
  const fHeat = evaluate("  fast + heat-decay k=4", books(data, fast), decayH(T.heatDecayK), w);
  printRow(fHeat, fBase.net, fBase.maxDD);

  console.log("\n— phân rã theo HƯỚNG và theo NHÁNH THOÁT —");
  for (const [name, r] of [["TURTLE", tBase], ["FAST", fBase]] as [string, Row][]) {
    const tr = r.res.trades.filter((t) => t.entryTime >= w.from && t.entryTime <= w.to);
    const grp = (f: (t: UnitTrade) => boolean) => {
      const xs = tr.filter(f);
      const net = xs.reduce((s, t) => s + t.netR * t.weight, 0);
      const wsum = xs.reduce((s, t) => s + t.weight, 0);
      return `${String(xs.length).padStart(5)} unit  NET ${net.toFixed(0).padStart(6)}R  exp ${(wsum ? net / wsum : 0).toFixed(3).padStart(7)}`;
    };
    console.log(`${name}:`);
    console.log(`  long          ${grp((t) => t.dir === "long")}`);
    console.log(`  short         ${grp((t) => t.dir === "short")}`);
    for (const reason of ["trail", "mid", "time"]) {
      const xs = tr.filter((t) => t.exitReason === reason);
      if (xs.length) console.log(`  exit=${reason.padEnd(9)} ${grp((t) => t.exitReason === reason)}`);
    }
    for (let u = 0; u < 4; u++) {
      const xs = tr.filter((t) => t.unitIndex === u);
      if (xs.length) console.log(`  unit#${u}        ${grp((t) => t.unitIndex === u)}`);
    }
    const gross = tr.reduce((s, t) => s + t.grossR * t.weight, 0);
    const cost = tr.reduce((s, t) => s + t.costR * t.weight, 0);
    console.log(`  GROSS ${gross.toFixed(0)}R − phí ${cost.toFixed(0)}R = NET ${(gross - cost).toFixed(0)}R  (phí ăn ${((cost / Math.abs(gross)) * 100).toFixed(0)}% gross)`);
  }
}

async function cmdDiag(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const tRes = runBooks(books(data, turtle), decayH(T.heatDecayK));
  const fRes = runBooks(books(data, fast));

  for (const [name, res] of [["TURTLE", tRes], ["FAST", fRes]] as [string, PortfolioResult][]) {
    const ps = positionDiag(res, data).filter((p) => p.entryTime >= w.from && p.entryTime <= w.to);
    const wins = ps.filter((p) => p.netR > 0);
    const losses = ps.filter((p) => p.netR <= 0);
    console.log(`\n${"=".repeat(110)}\n  ${name} — giải phẫu ${ps.length} vị thế (${wins.length} thắng / ${losses.length} thua)`);
    console.log("=".repeat(110));
    const bucket = (xs: PosDiag[], lo: number, hi: number) => xs.filter((p) => p.mfeR >= lo && p.mfeR < hi).length;
    console.log(
      `  LOSS theo MFE: <0,5R ${((bucket(losses, 0, 0.5) / losses.length) * 100).toFixed(1)}% · ` +
        `0,5-1R ${((bucket(losses, 0.5, 1) / losses.length) * 100).toFixed(1)}% · ` +
        `1-2R ${((bucket(losses, 1, 2) / losses.length) * 100).toFixed(1)}% · ` +
        `>=2R ${((bucket(losses, 2, Infinity) / losses.length) * 100).toFixed(1)}%`,
    );
    const sorted = [...ps].sort((a, b) => b.netR - a.netR);
    const posSum = ps.filter((p) => p.netR > 0).reduce((s, p) => s + p.netR, 0);
    console.log(
      `  Top 5 winner = ${((sorted.slice(0, 5).reduce((s, p) => s + p.netR, 0) / posSum) * 100).toFixed(1)}% tổng R dương · ` +
        `giữ TB thắng ${(wins.reduce((s, p) => s + p.holdDays, 0) / (wins.length || 1)).toFixed(1)}d, thua ${(losses.reduce((s, p) => s + p.holdDays, 0) / (losses.length || 1)).toFixed(1)}d`,
    );
    // giveback: winner trả lại bao nhiêu % MFE
    const gb = wins.filter((p) => p.mfeR > 0).map((p) => 1 - p.netR / p.mfeR).sort((a, b) => a - b);
    if (gb.length) {
      console.log(`  Giveback winner (1 − netR/MFE): p50 ${(gb[Math.floor(gb.length / 2)] * 100).toFixed(0)}% · p90 ${(gb[Math.floor(gb.length * 0.9)] * 100).toFixed(0)}%`);
    }
    // theo era
    for (const e of w.eras) {
      const xs = ps.filter((p) => p.entryTime >= e.from && p.entryTime <= e.to);
      const l = xs.filter((p) => p.netR <= 0);
      const never1R = l.filter((p) => p.mfeR < 1).length;
      console.log(
        `  Era ${e.name}: ${String(xs.length).padStart(4)} vị thế · NET ${xs.reduce((s, p) => s + p.netR, 0).toFixed(0).padStart(6)}R · ` +
          `loss chưa từng đạt 1R ${((never1R / (l.length || 1)) * 100).toFixed(1)}% · MFE TB loss ${(l.reduce((s, p) => s + p.mfeR, 0) / (l.length || 1)).toFixed(2)}R`,
      );
    }
  }

  // ── Trùng lặp giữa hai sleeve ──
  const tPos = positionDiag(tRes, data).filter((p) => p.entryTime >= w.from);
  const fPos = positionDiag(fRes, data).filter((p) => p.entryTime >= w.from);
  const overlap = (from: number) => {
    const fs = fPos.filter((p) => p.entryTime >= from);
    let same = 0;
    for (const f of fs) {
      const hit = tPos.some(
        (t) => t.symbol === f.symbol && t.dir === f.dir && t.entryTime <= f.entryTime && t.exitTime >= f.entryTime,
      );
      if (hit) same++;
    }
    return fs.length ? { pct: (same / fs.length) * 100, n: fs.length } : { pct: 0, n: 0 };
  };
  const last = w.to;
  console.log(`\n${"=".repeat(110)}\n  TRÙNG LẶP — Fast vào khi Turtle ĐANG GIỮ cùng symbol/hướng`);
  console.log("=".repeat(110));
  for (const d of [Infinity, 365, 180, 90]) {
    const o = overlap(d === Infinity ? -Infinity : last - d * TF_MS["1d"]);
    console.log(`  ${d === Infinity ? "toàn kỳ" : `${d}d gần nhất`}: ${o.pct.toFixed(1)}% (${o.n} vị thế Fast)`);
  }
  // tương quan P&L tuần
  const weekly = (eq: EquityPoint[], from: number) => {
    const m = new Map<number, number>();
    for (let i = 1; i < eq.length; i++) {
      if (eq[i].time < from) continue;
      const wk = Math.floor(eq[i].time / (7 * TF_MS["1d"]));
      m.set(wk, (m.get(wk) ?? 0) + (eq[i].mtm - eq[i - 1].mtm));
    }
    return m;
  };
  for (const d of [Infinity, 365, 180]) {
    const from = d === Infinity ? w.from : last - d * TF_MS["1d"];
    const a = weekly(tRes.equity, from);
    const b = weekly(fRes.equity, from);
    const keys = [...a.keys()].filter((k) => b.has(k));
    const xs = keys.map((k) => a.get(k)!);
    const ys = keys.map((k) => b.get(k)!);
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const mx = mean(xs), my = mean(ys);
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
    const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
    console.log(`  corr P&L tuần Turtle↔Fast ${d === Infinity ? "toàn kỳ" : `${d}d`}: ${(cov / (sx * sy)).toFixed(2)} (${keys.length} tuần)`);
  }
}

/** F — lưới ứng viên cho sleeve FAST (điểm yếu đo được: không có đuôi phải). */
async function cmdFast(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const base = evaluate("BASE fast live", books(data, fast), undefined, w);
  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)}\n`);

  const run = (label: string, patch: Partial<ExtParams>, admit?: AdmitFn) =>
    printRow(evaluate(label, books(data, { ...fast, ...patch }), admit, w), base.net, base.maxDD);

  console.log("=".repeat(120));
  console.log("  F1 — KÊNH THOÁT MIDPOINT cho LONG (cơ chế đã chứng minh trên Turtle: 100% lợi nhuận đến từ nhánh mid)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  for (const x of [10, 12, 15, 18, 20, 25, 30]) {
    run(`  long exit = mid ${x}d`, { longExitMode: "mid", longExitDays: x });
  }

  console.log("\n" + "=".repeat(120));
  console.log("  F2 — KÊNH THOÁT MIDPOINT cho SHORT (Turtle đã loại, nhưng short của Fast có xác nhận → test lại)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  for (const x of [10, 15, 20, 25, 30]) {
    run(`  short exit = mid ${x}d`, { shortExitMode: "mid", shortExitDays: x });
  }

  console.log("\n" + "=".repeat(120));
  console.log("  F3 — nguồn breakout LONG (high-channel hiện tại vs close-channel như Turtle)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  run("  long entry = close-10d", { longEntrySource: "close" });
  for (const d of [7, 10, 13, 15]) run(`  long entry = close-${d}d`, { longEntrySource: "close", entryDays: d });

  console.log("\n" + "=".repeat(120));
  console.log("  F4 — trần unit + heat-decay (chính sách risk, không đụng tín hiệu)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  for (const u of [1, 2, 3]) run(`  max ${u} unit`, { pyramidMaxUnits: u });
  for (const k of [2, 4, 6]) run(`  heat-decay k=${k}`, {}, decayH(k));
  run("  max 3 unit + heat k=4", { pyramidMaxUnits: 3 }, decayH(4));
}

/** X — lưới ứng viên cho TURTLE (nhánh yếu đo được: short exp 0,165 với trail chandelier). */
async function cmdTurtle(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const heat = decayH(T.heatDecayK);
  const base = evaluate("BASE turtle live", books(data, turtle), heat, w);
  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)}\n`);

  const run = (label: string, patch: Partial<ExtParams>, admit: AdmitFn | undefined = heat) =>
    printRow(evaluate(label, books(data, { ...turtle, ...patch }), admit, w), base.net, base.maxDD);

  console.log("=".repeat(120));
  console.log("  X1 — SHORT: kênh thoát midpoint thay Chandelier (short hiện exp 0,165 vs long 1,274)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  for (const x of [10, 15, 20, 25, 30, 40]) run(`  short exit = mid ${x}d`, { shortExitMode: "mid", shortExitDays: x });

  console.log("\n" + "=".repeat(120));
  console.log("  X2 — kênh thoát LONG: kiểm lại plateau trên cửa sổ dài hơn (production = 20d)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  for (const x of [12, 15, 18, 20, 22, 25, 30]) run(`  long exit ${x}d`, { longExitDays: x });

  console.log("\n" + "=".repeat(120));
  console.log("  X3 — chandelier của SHORT + trần unit + heat");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(base);
  for (const m of [2.5, 3.5, 4]) run(`  chandelier ${m}×ATR`, { chandelierMult: m });
  for (const u of [2, 4]) run(`  max ${u} unit`, { pyramidMaxUnits: u });
  for (const k of [2, 3, 6, 8]) run(`  heat k=${k}`, {}, decayH(k));
}

/** J — kiểm định ứng viên đã lọc: cơ chế cạnh tranh, cấu hình khớp, walk-forward, perturbation. */
async function cmdJoint(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const heat = decayH(T.heatDecayK);
  const fBase = evaluate("BASE fast live", books(data, fast), undefined, w);
  const tBase = evaluate("BASE turtle live", books(data, turtle), heat, w);
  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)}\n`);

  console.log("=".repeat(120));
  console.log("  J1 — CƠ CHẾ CẠNH TRANH: có phải chỉ vì 'trail quá chật' không? (nới Chandelier thay vì đổi sang kênh)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(fBase);
  for (const m of [4, 5, 6, 8]) {
    printRow(evaluate(`  chandelier ${m}×ATR (long+short)`, books(data, { ...fast, chandelierMult: m }), undefined, w), fBase.net, fBase.maxDD);
  }
  printRow(evaluate("  long exit = mid 13d (ratio 1,33)", books(data, { ...fast, longExitMode: "mid", longExitDays: 13 }), undefined, w), fBase.net, fBase.maxDD);

  console.log("\n" + "=".repeat(120));
  console.log("  J2 — CẤU HÌNH KHỚP: mid-exit × trần unit × heat-decay");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(fBase);
  for (const x of [13, 20]) {
    for (const u of [3, 4]) {
      for (const [hl, h] of [["", undefined], [" + heat k=4", heat]] as [string, AdmitFn | undefined][]) {
        printRow(
          evaluate(`  mid ${x}d · max${u}${hl}`, books(data, { ...fast, longExitMode: "mid", longExitDays: x, pyramidMaxUnits: u }), h, w),
          fBase.net,
          fBase.maxDD,
        );
      }
    }
  }

  console.log("\n" + "=".repeat(120));
  console.log("  J3 — TURTLE: xác nhận 1 nến cho SHORT (cơ chế đã dùng ở Fast, Turtle chưa có)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  printRow(tBase);
  for (const sc of [1, 2]) {
    printRow(evaluate(`  short xác nhận ${sc} nến`, books(data, { ...turtle, shortConfirmBars: sc }), heat, w), tBase.net, tBase.maxDD);
  }

  console.log("\n" + "=".repeat(120));
  console.log("  J4 — WALK-FORWARD 6 cửa sổ (Sharpe từng cửa sổ, base → ứng viên)");
  console.log("=".repeat(120));
  const cands: [string, ExtParams, AdmitFn | undefined][] = [
    ["fast mid13 max3 heat4", { ...fast, longExitMode: "mid", longExitDays: 13, pyramidMaxUnits: 3 }, heat],
    ["fast mid20 max3 heat4", { ...fast, longExitMode: "mid", longExitDays: 20, pyramidMaxUnits: 3 }, heat],
    ["fast mid13 max4 (chỉ đổi exit)", { ...fast, longExitMode: "mid", longExitDays: 13 }, undefined],
  ];
  const nW = 6;
  const wins: number[] = cands.map(() => 0);
  console.log("cửa sổ".padEnd(26) + "BASE".padStart(8) + cands.map((c) => c[0].slice(0, 14).padStart(16)).join(""));
  for (let k = 0; k < nW; k++) {
    const from = w.from + ((w.to - w.from) * k) / nW;
    const to = w.from + ((w.to - w.from) * (k + 1)) / nW;
    const sh = (bs: Book[], admit: AdmitFn | undefined) =>
      riskMetrics(runBooks(bs, admit).equity.filter((e) => e.time >= from && e.time <= to)).sharpe;
    const b = sh(books(data, fast), undefined);
    const row = cands.map(([, p, a], i) => {
      const s = sh(books(data, p), a);
      if (s > b) wins[i]++;
      return s;
    });
    console.log(
      `${fmtD(from)}→${fmtD(to)}`.padEnd(26) + b.toFixed(2).padStart(8) + row.map((s) => s.toFixed(2).padStart(16)).join(""),
    );
  }
  console.log("thắng base".padEnd(26) + "".padStart(8) + wins.map((x) => `${x}/${nW}`.padStart(16)).join(""));

  console.log("\n" + "=".repeat(120));
  console.log("  J5 — PERTURBATION ±15% × 30 seed (entryDays, exitDays, chandelier, ATR, EMA, maxHold)");
  console.log("=".repeat(120));
  const perturb = (label: string, p: ExtParams, admit: AdmitFn | undefined) => {
    const baseSharpe = riskMetrics(runBooks(books(data, p), admit).equity.filter((e) => e.time >= w.from)).sharpe;
    const out: number[] = [];
    for (let s = 0; s < 30; s++) {
      const f = (m: number) => 1 + ((((s + 1) * 2654435761) % 1000) / 1000) * 2 * m * 0.15 - m * 0.15;
      const q: ExtParams = {
        ...p,
        entryDays: Math.max(2, Math.round(p.entryDays * f(1))),
        longExitDays: p.longExitDays ? Math.max(2, Math.round(p.longExitDays * f(1))) : p.longExitDays,
        shortEntryDays: Math.max(2, Math.round(p.shortEntryDays * f(0.8))),
        chandelierMult: p.chandelierMult * f(0.7),
        atrPeriod: Math.max(5, Math.round(p.atrPeriod * f(0.5))),
        trendLen: Math.max(10, Math.round(p.trendLen * f(0.9))),
        maxHoldDays: Math.max(5, Math.round(p.maxHoldDays * f(1.1))),
      };
      out.push(riskMetrics(runBooks(books(data, q), admit).equity.filter((e) => e.time >= w.from)).sharpe);
    }
    out.sort((a, b) => a - b);
    const baseFastSharpe = fBase.sharpe;
    console.log(
      `${label.padEnd(34)} Sharpe base ${baseSharpe.toFixed(2)} | seed p10 ${out[3].toFixed(2)} p50 ${out[15].toFixed(2)} p90 ${out[27].toFixed(2)} | ` +
        `> fast-live hiện tại (${baseFastSharpe.toFixed(2)}): ${out.filter((x) => x > baseFastSharpe).length}/30`,
    );
  };
  perturb("fast mid13 max3 heat4", { ...fast, longExitMode: "mid", longExitDays: 13, pyramidMaxUnits: 3 }, heat);
  perturb("fast mid20 max3 heat4", { ...fast, longExitMode: "mid", longExitDays: 20, pyramidMaxUnits: 3 }, heat);
  perturb("fast LIVE hiện tại", fast, undefined);

  console.log("\n" + "=".repeat(120));
  console.log("  J6 — DANH MỤC HAI SLEEVE: Fast có cộng thêm gì cho Turtle không? (cùng sổ risk, phí riêng từng sàn)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  const tOnly = evaluate("Turtle một mình", books(data, turtle), heat, w);
  printRow(tOnly);
  const combo = (label: string, fp: ExtParams) =>
    printRow(evaluate(label, [...books(data, turtle, "T"), ...books(data, fp, "F")], heat, w), tOnly.net, tOnly.maxDD);
  combo("+ Fast hiện tại", fast);
  combo("+ Fast mid13 max3", { ...fast, longExitMode: "mid", longExitDays: 13, pyramidMaxUnits: 3 });
  combo("+ Fast mid20 max3", { ...fast, longExitMode: "mid", longExitDays: 20, pyramidMaxUnits: 3 });
}

/** V — soi ứng viên Fast theo NĂM, theo COIN, theo phí, và ở dạng danh mục thật (hai sổ risk riêng). */
async function cmdVerify(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const heat = decayH(T.heatDecayK);
  const cand: ExtParams = { ...fast, longExitMode: "mid", longExitDays: 20, pyramidMaxUnits: 3 };
  const cand13: ExtParams = { ...fast, longExitMode: "mid", longExitDays: 13, pyramidMaxUnits: 3 };

  const runF = (p: ExtParams, admit: AdmitFn | undefined = heat) => runBooks(books(data, p), admit);
  const rBase = runBooks(books(data, fast));
  const rCand = runF(cand);
  const rCand13 = runF(cand13);

  console.log("\n" + "=".repeat(104));
  console.log("  V1 — THEO NĂM (Sharpe P&L ngày; NET R đã chuẩn hoá không so được giữa cột nên chỉ xem dấu/độ lớn)");
  console.log("=".repeat(104));
  console.log("năm".padEnd(8) + "BASE Sharpe".padStart(13) + "mid20 max3".padStart(13) + "mid13 max3".padStart(13) + "   BASE NET".padStart(13) + "mid20 NET".padStart(12));
  const years = new Set<number>();
  for (const e of rBase.equity) if (e.time >= w.from) years.add(new Date(e.time).getUTCFullYear());
  for (const y of [...years].sort()) {
    const from = Date.UTC(y, 0, 1), to = Date.UTC(y + 1, 0, 1);
    const m = (r: PortfolioResult) => riskMetrics(r.equity.filter((e) => e.time >= Math.max(from, w.from) && e.time < to));
    const b = m(rBase), c = m(rCand), c13 = m(rCand13);
    console.log(
      String(y).padEnd(8) + b.sharpe.toFixed(2).padStart(13) + c.sharpe.toFixed(2).padStart(13) + c13.sharpe.toFixed(2).padStart(13) +
        b.netR.toFixed(0).padStart(13) + c.netR.toFixed(0).padStart(12),
    );
  }

  console.log("\n" + "=".repeat(104));
  console.log("  V2 — GẦN ĐÂY (cửa sổ trượt tính ngược từ nến cuối)");
  console.log("=".repeat(104));
  for (const d of [90, 180, 365, 545, 730]) {
    const from = w.to - d * TF_MS["1d"];
    const m = (r: PortfolioResult) => riskMetrics(r.equity.filter((e) => e.time >= from));
    const b = m(rBase), c = m(rCand), c13 = m(rCand13);
    console.log(
      `${String(d).padStart(4)}d gần nhất  BASE Sharpe ${b.sharpe.toFixed(2).padStart(6)} NET ${b.netR.toFixed(0).padStart(5)}R  |  ` +
        `mid20 ${c.sharpe.toFixed(2).padStart(6)} NET ${c.netR.toFixed(0).padStart(5)}R  |  mid13 ${c13.sharpe.toFixed(2).padStart(6)} NET ${c13.netR.toFixed(0).padStart(5)}R`,
    );
  }

  console.log("\n" + "=".repeat(104));
  console.log("  V3 — THEO COIN (NET R có trọng số; lợi ích có tập trung vào 1-2 coin không?)");
  console.log("=".repeat(104));
  const perSym = (r: PortfolioResult) => {
    const m = new Map<string, number>();
    for (const t of r.trades) if (t.entryTime >= w.from) m.set(t.symbol, (m.get(t.symbol) ?? 0) + t.netR * t.weight);
    return m;
  };
  const pb = perSym(rBase), pc = perSym(rCand);
  console.log("coin".padEnd(10) + "BASE NET".padStart(10) + "mid20 NET".padStart(11) + "   thắng?");
  for (const s of BASKET) {
    const b = pb.get(s) ?? 0, c = pc.get(s) ?? 0;
    console.log(s.padEnd(10) + b.toFixed(0).padStart(10) + c.toFixed(0).padStart(11) + (c > b ? "     ✅" : "     ❌"));
  }

  console.log("\n" + "=".repeat(104));
  console.log("  V4 — ĐỘ NHẠY PHÍ (MEXC taker + slippage xấu hơn giả định)");
  console.log("=".repeat(104));
  console.log(HEADER);
  console.log("-".repeat(104));
  for (const [taker, slip] of [[0.08, 0.02], [0.1, 0.03], [0.12, 0.05], [0.2, 0.05]] as [number, number][]) {
    const b = evaluate(`BASE   phí ${taker}+${slip}%`, books(data, { ...fast, takerFeePct: taker, slippagePct: slip }), undefined, w);
    printRow(b);
    printRow(evaluate(`  mid20 phí ${taker}+${slip}%`, books(data, { ...cand, takerFeePct: taker, slippagePct: slip }), heat, w), b.net, b.maxDD);
  }

  console.log("\n" + "=".repeat(104));
  console.log("  V5 — DANH MỤC THẬT: hai sổ risk RIÊNG (đúng production: Binance và MEXC không chia heat)");
  console.log("=".repeat(104));
  const tRes = runBooks(books(data, turtle), heat);
  const daily = (r: PortfolioResult, scale: number) => {
    const m = new Map<number, number>();
    for (let i = 1; i < r.equity.length; i++) {
      if (r.equity[i].time < w.from) continue;
      const d = Math.floor(r.equity[i].time / TF_MS["1d"]);
      m.set(d, (m.get(d) ?? 0) + (r.equity[i].mtm - r.equity[i - 1].mtm) * scale);
    }
    return m;
  };
  const mix = (a: Map<number, number>, b: Map<number, number>) => {
    const keys = new Set([...a.keys(), ...b.keys()]);
    const days = [...keys].sort((x, y) => x - y);
    const rs = days.map((d) => (a.get(d) ?? 0) + (b.get(d) ?? 0));
    const n = rs.length, mean = rs.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
    let cum = 0, peak = 0, dd = 0;
    for (const x of rs) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { sharpe: (mean / sd) * Math.sqrt(365), net: cum, dd, netOverDd: dd > 0 ? cum / dd : 0 };
  };
  const tD = daily(tRes, 1);
  const solo = mix(tD, new Map());
  console.log(`Turtle một mình              Sharpe ${solo.sharpe.toFixed(2)}  NET ${solo.net.toFixed(0)}R  maxDD ${solo.dd.toFixed(0)}R  NET/DD ${solo.netOverDd.toFixed(2)}`);
  for (const [label, r] of [["Fast hiện tại", rBase], ["Fast mid20 max3", rCand]] as [string, PortfolioResult][]) {
    for (const scale of [0.25, 0.5, 1]) {
      const m = mix(tD, daily(r, scale));
      const norm = (m.net * solo.dd) / m.dd;
      console.log(
        `+ ${label.padEnd(16)} risk ×${scale}  Sharpe ${m.sharpe.toFixed(2)}  NET ${m.net.toFixed(0)}R  maxDD ${m.dd.toFixed(0)}R  ` +
          `NET/DD ${m.netOverDd.toFixed(2)}  → NET quy đổi cùng DD ${norm.toFixed(0)}R (${norm >= solo.net ? "+" : ""}${(((norm - solo.net) / solo.net) * 100).toFixed(0)}%)`,
      );
    }
  }
}

/**
 * R — CÂU HỎI QUYẾT ĐỊNH: mid-exit thắng lớn toàn kỳ nhưng THUA ~18 tháng gần nhất.
 * Là regime (trend crypto ngắn dần) hay là nhiễu cửa sổ nhỏ? So sánh với CÙNG chính sách risk
 * (không heat cho mọi biến thể) để NET R có thể so trực tiếp.
 */
async function cmdRecent(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);

  const variants: [string, ExtParams][] = [
    ["BASE chandelier 3ATR", fast],
    ["mid 10d", { ...fast, longExitMode: "mid", longExitDays: 10 }],
    ["mid 13d", { ...fast, longExitMode: "mid", longExitDays: 13 }],
    ["mid 20d", { ...fast, longExitMode: "mid", longExitDays: 20 }],
    ["mid 25d", { ...fast, longExitMode: "mid", longExitDays: 25 }],
    ["mid 13d + chandelier 3ATR", { ...fast, longExitMode: "mid", longExitDays: 13, chandelierMult: 3 }],
  ];
  const runs = variants.map(([label, p]) => [label, runBooks(books(data, p))] as [string, PortfolioResult]);
  // biến thể cuối: mid + chandelier chạy SONG SONG chưa hỗ trợ trong engine → bỏ khỏi bảng
  runs.pop();

  console.log("\n" + "=".repeat(112));
  console.log("  R1 — CÙNG chính sách risk (KHÔNG heat) → NET R so trực tiếp được. Sharpe | NET R theo năm");
  console.log("=".repeat(112));
  const years = [...new Set(runs[0][1].equity.filter((e) => e.time >= w.from).map((e) => new Date(e.time).getUTCFullYear()))].sort();
  console.log("biến thể".padEnd(24) + years.map((y) => String(y).padStart(14)).join(""));
  for (const [label, r] of runs) {
    const cells = years.map((y) => {
      const m = riskMetrics(r.equity.filter((e) => e.time >= Math.max(Date.UTC(y, 0, 1), w.from) && e.time < Date.UTC(y + 1, 0, 1)));
      return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(14);
    });
    console.log(label.padEnd(24) + cells.join(""));
  }

  console.log("\n" + "=".repeat(112));
  console.log("  R2 — cửa sổ trượt (Sharpe | NET R | số vị thế)");
  console.log("=".repeat(112));
  console.log("biến thể".padEnd(24) + [180, 365, 545, 730, 1095].map((d) => `${d}d`.padStart(18)).join(""));
  for (const [label, r] of runs) {
    const cells = [180, 365, 545, 730, 1095].map((d) => {
      const from = w.to - d * TF_MS["1d"];
      const m = riskMetrics(r.equity.filter((e) => e.time >= from));
      const pos = new Set(r.trades.filter((t) => t.entryTime >= from).map((t) => `${t.book}#${t.positionId}`)).size;
      return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}|${pos}`.padStart(18);
    });
    console.log(label.padEnd(24) + cells.join(""));
  }

  console.log("\n" + "=".repeat(112));
  console.log("  R3 — 545 ngày gần nhất: vì sao khác? (nhánh thoát, thời gian giữ, giveback)");
  console.log("=".repeat(112));
  const from545 = w.to - 545 * TF_MS["1d"];
  for (const [label, r] of runs) {
    const ps = positionDiag(r, data).filter((p) => p.entryTime >= from545);
    const wins = ps.filter((p) => p.netR > 0);
    const gb = wins.filter((p) => p.mfeR > 0).map((p) => 1 - p.netR / p.mfeR).sort((a, b) => a - b);
    const byReason = new Map<string, number>();
    for (const t of r.trades.filter((t) => t.entryTime >= from545)) byReason.set(t.exitReason, (byReason.get(t.exitReason) ?? 0) + t.netR * t.weight);
    console.log(
      label.padEnd(26) +
        `${String(ps.length).padStart(4)} vị thế · WR ${((wins.length / (ps.length || 1)) * 100).toFixed(0)}% · ` +
        `giữ thắng ${(wins.reduce((s, p) => s + p.holdDays, 0) / (wins.length || 1)).toFixed(1)}d · ` +
        `giveback p50 ${gb.length ? (gb[Math.floor(gb.length / 2)] * 100).toFixed(0) : "-"}% · ` +
        [...byReason.entries()].map(([k, v]) => `${k} ${v.toFixed(0)}R`).join(" · "),
    );
  }

  console.log("\n" + "=".repeat(112));
  console.log("  R4 — CÙNG câu hỏi cho TURTLE: kênh thoát mid của nó có yếu đi gần đây không?");
  console.log("=".repeat(112));
  const tVariants: [string, ExtParams][] = [
    ["turtle mid 20d (live)", turtle],
    ["turtle mid 13d", { ...turtle, longExitDays: 13 }],
    ["turtle chandelier long", { ...turtle, longExitMode: "chandelier" }],
  ];
  console.log("biến thể".padEnd(24) + [180, 365, 545, 730, 1095, 99999].map((d) => (d > 9999 ? "toàn kỳ" : `${d}d`).padStart(16)).join(""));
  for (const [label, p] of tVariants) {
    const r = runBooks(books(data, p));
    const cells = [180, 365, 545, 730, 1095, 99999].map((d) => {
      const from = d > 9999 ? w.from : w.to - d * TF_MS["1d"];
      const m = riskMetrics(r.equity.filter((e) => e.time >= from));
      return `${m.sharpe.toFixed(2)}|${m.netR.toFixed(0)}`.padStart(16);
    });
    console.log(label.padEnd(24) + cells.join(""));
  }
}

/**
 * G — lưới 2 chiều entryDays × longExitDays cho FAST: đỉnh nằm ở TỈ LỆ exit/entry (⇒ 13d cho
 * entry 10d, theo luật đã đăng ký ở nghiên cứu 2026-08) hay ở ĐỘ RỘNG TUYỆT ĐỐI ~20-25d?
 */
async function cmdGrid(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const entries = [6, 8, 10, 13, 15, 20];
  const exits = [8, 10, 13, 15, 18, 20, 25, 30];
  console.log("\nSharpe toàn kỳ — hàng = entryDays (long), cột = longExitDays (mid). Không heat.\n");
  console.log("entry\\exit".padEnd(11) + exits.map((x) => String(x).padStart(7)).join("") + "   argmax");
  for (const e of entries) {
    const row = exits.map((x) => {
      const r = runBooks(books(data, { ...fast, entryDays: e, longExitMode: "mid", longExitDays: x }));
      return riskMetrics(r.equity.filter((q) => q.time >= w.from)).sharpe;
    });
    const best = exits[row.indexOf(Math.max(...row))];
    console.log(
      String(e).padEnd(11) + row.map((s) => s.toFixed(2).padStart(7)).join("") + `   ${String(best).padStart(3)}d (tỉ lệ ${(best / e).toFixed(2)}×)`,
    );
  }
  console.log("\nCùng lưới, chấm bằng NET/maxDD (bất biến đòn bẩy):\n");
  console.log("entry\\exit".padEnd(11) + exits.map((x) => String(x).padStart(7)).join("") + "   argmax");
  for (const e of entries) {
    const row = exits.map((x) => {
      const r = runBooks(books(data, { ...fast, entryDays: e, longExitMode: "mid", longExitDays: x }));
      return riskMetrics(r.equity.filter((q) => q.time >= w.from)).netOverMaxDD;
    });
    const best = exits[row.indexOf(Math.max(...row))];
    console.log(
      String(e).padEnd(11) + row.map((s) => s.toFixed(1).padStart(7)).join("") + `   ${String(best).padStart(3)}d (tỉ lệ ${(best / e).toFixed(2)}×)`,
    );
  }
}

/** S — số liệu CHỐT của cấu hình đã ship + placebo cho "họ luật thoát". */
async function cmdShip(days: number) {
  const data = await loadData(days);
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { fast } = sleeveParams(gate);
  const w = windowOf(data, T.btcGateSlow + 130);
  const shipped: ExtParams = { ...fast, longExitMode: "mid", longExitDays: 20, pyramidMaxUnits: 3 };

  console.log(`\nCửa sổ ${fmtD(w.from)} → ${fmtD(w.to)} (${((w.to - w.from) / TF_MS["1d"]).toFixed(0)} ngày)\n`);
  console.log("=".repeat(120));
  console.log("  S1 — TRƯỚC vs SAU (cùng risk/unit, không heat — đúng như Fast production hôm nay)");
  console.log("=".repeat(120));
  console.log(HEADER);
  console.log("-".repeat(120));
  const before = evaluate("TRƯỚC (chandelier, max4)", books(data, fast), undefined, w);
  printRow(before);
  printRow(evaluate("SAU (mid-close 20d, max3)", books(data, shipped), undefined, w), before.net, before.maxDD);

  const bTr = before.res.trades.filter((t) => t.entryTime >= w.from);
  const aRes = runBooks(books(data, shipped));
  const aTr = aRes.trades.filter((t) => t.entryTime >= w.from);
  const sum = (xs: UnitTrade[], f: (t: UnitTrade) => boolean) => xs.filter(f).reduce((s, t) => s + t.netR * t.weight, 0);
  console.log(
    `\nLONG:  trước ${sum(bTr, (t) => t.dir === "long").toFixed(0)}R → sau ${sum(aTr, (t) => t.dir === "long").toFixed(0)}R` +
      `   ·   SHORT (không đổi luật): trước ${sum(bTr, (t) => t.dir === "short").toFixed(0)}R → sau ${sum(aTr, (t) => t.dir === "short").toFixed(0)}R`,
  );
  const bp = positionDiag(before.res, data).filter((p) => p.entryTime >= w.from);
  const ap = positionDiag(aRes, data).filter((p) => p.entryTime >= w.from);
  const tail = (ps: PosDiag[]) => {
    const wins = ps.filter((p) => p.netR > 0);
    const pos = wins.reduce((s, p) => s + p.netR, 0);
    const top5 = [...ps].sort((a, b) => b.netR - a.netR).slice(0, 5).reduce((s, p) => s + p.netR, 0);
    return `top5 = ${((top5 / pos) * 100).toFixed(1)}% R dương · giữ TB thắng ${(wins.reduce((s, p) => s + p.holdDays, 0) / wins.length).toFixed(1)}d`;
  };
  console.log(`ĐUÔI PHẢI: trước ${tail(bp)}  |  sau ${tail(ap)}`);

  console.log("\n" + "=".repeat(120));
  console.log("  S2 — PLACEBO: 'đổi luật thoát' có phải chỉ là bốc trúng một tham số may không?");
  console.log("  Bốc ngẫu nhiên 40 luật thoát khác cùng họ (chandelier k∈[2;8]) và so với mid-20d.");
  console.log("=".repeat(120));
  const shipSharpe = riskMetrics(aRes.equity.filter((e) => e.time >= w.from)).sharpe;
  const draws: number[] = [];
  for (let s = 0; s < 40; s++) {
    const k = 2 + ((s * 2654435761) % 1000) / 1000 * 6;
    draws.push(riskMetrics(runBooks(books(data, { ...fast, chandelierMult: k })).equity.filter((e) => e.time >= w.from)).sharpe);
  }
  draws.sort((a, b) => a - b);
  console.log(
    `Chandelier ngẫu nhiên: p05 ${draws[2].toFixed(2)} · p50 ${draws[20].toFixed(2)} · p95 ${draws[38].toFixed(2)} · max ${draws[39].toFixed(2)}` +
      `  |  mid-20d = ${shipSharpe.toFixed(2)} · số lần bốc ≥ bản ship: ${draws.filter((x) => x >= shipSharpe).length}/40`,
  );
  const midDraws: number[] = [];
  for (const x of [8, 10, 12, 13, 15, 16, 18, 20, 22, 25, 28, 30, 35, 40]) {
    midDraws.push(riskMetrics(runBooks(books(data, { ...fast, longExitMode: "mid", longExitDays: x })).equity.filter((e) => e.time >= w.from)).sharpe);
  }
  console.log(
    `Toàn HỌ mid-close (8..40d): min ${Math.min(...midDraws).toFixed(2)} · median ${midDraws.sort((a, b) => a - b)[7].toFixed(2)} · max ${Math.max(...midDraws).toFixed(2)}` +
      `  ⇒ mọi thành viên của họ đều > mọi chandelier: ${Math.min(...midDraws) > draws[39] ? "ĐÚNG" : "SAI"}`,
  );
}

async function main() {
  const cmd = process.argv[2] ?? "base";
  const days = parseInt(process.argv[3] ?? "2300", 10);
  if (cmd === "base") await cmdBase(days);
  else if (cmd === "diag") await cmdDiag(days);
  else if (cmd === "fast") await cmdFast(days);
  else if (cmd === "turtle") await cmdTurtle(days);
  else if (cmd === "joint") await cmdJoint(days);
  else if (cmd === "verify") await cmdVerify(days);
  else if (cmd === "recent") await cmdRecent(days);
  else if (cmd === "grid") await cmdGrid(days);
  else if (cmd === "ship") await cmdShip(days);
  else console.log("cmd: base | diag | fast | turtle");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Lỗi:", e?.response?.data ?? e);
    process.exit(1);
  });
}
