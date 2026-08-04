/**
 * exp-joint-audit.ts — Chọn tham số theo GIAO THỨC CHỐNG OVERFIT, không phải theo đỉnh bảng.
 *
 * Giao thức:
 *   1. Quét lưới (kênh thoát long × trần unit pyramid) — hai hướng đã nêu cơ chế trước ở
 *      exp-exit-pyramid.ts. Chấm bằng Sharpe.
 *   2. CHỌN chỉ bằng ERA A+B (2/3 dữ liệu cũ nhất). Era C bị NIÊM PHONG.
 *   3. Mở niêm phong: biến thể đã chọn phải KHÔNG xấu đi ở era C. Nếu xấu đi → loại.
 *   4. Kiểm tra plateau: các ô lân cận trong lưới phải cùng tốt (không phải một đỉnh nhọn).
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-joint-audit.ts [days]
 */
import { TF_MS } from "../strategy";
import { T } from "../turtle";
import { AdmitFn, ExtParams, riskMetrics, runBooks } from "./portfolio-engine";
import { buildGate, loadBasket } from "./portfolio-equivalence";

const fmtD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const decay4: AdmitFn = (c) => 1 / (1 + c.sameDirHeat / 4);

async function main() {
  const days = parseInt(process.argv[2] ?? "2000", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const base: ExtParams = { ...T, gate };

  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const warmup = Math.max(Math.round(90 * bpd), T.trendLen, T.atrPeriod) + 1;
  let from = -Infinity, to = Infinity;
  for (const c of data.values()) {
    from = Math.max(from, c[Math.min(warmup, c.length - 1)].openTime);
    to = Math.min(to, c[c.length - 1].openTime);
  }
  const cutAB = from + ((to - from) * 2) / 3;
  const eras = [0, 1, 2].map((k) => ({ name: ["A", "B", "C"][k], from: from + ((to - from) * k) / 3, to: from + ((to - from) * (k + 1)) / 3 }));
  console.log(`Cửa sổ ${fmtD(from)} → ${fmtD(to)} | chọn trên A+B (${fmtD(from)}→${fmtD(cutAB)}), niêm phong C (${fmtD(cutAB)}→${fmtD(to)})\n`);

  const EXITS = [0, 18, 20, 22, 25, 28, 30];
  const UNITS = [2, 3, 4, 5];

  const evalOne = (p: ExtParams, admit?: AdmitFn) => {
    const books = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    const res = runBooks(books, admit);
    return {
      ab: riskMetrics(res.equity.filter((e) => e.time >= from && e.time < cutAB)),
      c: riskMetrics(res.equity.filter((e) => e.time >= cutAB && e.time <= to)),
      full: riskMetrics(res.equity.filter((e) => e.time >= from && e.time <= to)),
      era: eras.map((e) => riskMetrics(res.equity.filter((x) => x.time >= e.from && x.time <= e.to))),
    };
  };

  for (const [polName, admit] of [["BASELINE", undefined], ["decay 1/(1+h/4)", decay4]] as [string, AdmitFn | undefined][]) {
    console.log(`\n══ ${polName} — Sharpe trên A+B (dùng để CHỌN) ══`);
    console.log("exit\\units" + UNITS.map((u) => String(u).padStart(9)).join(""));
    const grid: Record<string, { ab: number; c: number; full: number }> = {};
    for (const ex of EXITS) {
      const row: string[] = [];
      for (const mu of UNITS) {
        const r = evalOne({ ...base, longExitDays: ex, pyramidMaxUnits: mu }, admit);
        grid[`${ex}|${mu}`] = { ab: r.ab.sharpe, c: r.c.sharpe, full: r.full.sharpe };
        row.push(r.ab.sharpe.toFixed(2).padStart(9));
      }
      console.log((ex === 0 ? "15(nay)" : `${ex}d`).padEnd(10) + row.join(""));
    }
    console.log(`\n   Sharpe trên C (NIÊM PHONG — chỉ để kiểm chứng, không dùng để chọn)`);
    console.log("exit\\units" + UNITS.map((u) => String(u).padStart(9)).join(""));
    for (const ex of EXITS) {
      console.log(
        (ex === 0 ? "15(nay)" : `${ex}d`).padEnd(10) +
          UNITS.map((mu) => grid[`${ex}|${mu}`].c.toFixed(2).padStart(9)).join(""),
      );
    }
    const cur = grid[`0|4`];
    let bestKey = "0|4";
    for (const k of Object.keys(grid)) if (grid[k].ab > grid[bestKey].ab) bestKey = k;
    const [bex, bmu] = bestKey.split("|");
    console.log(`\n   Hiện tại (15d, 4 unit): A+B ${cur.ab.toFixed(2)} | C ${cur.c.toFixed(2)} | full ${cur.full.toFixed(2)}`);
    console.log(`   Tốt nhất theo A+B     : exit ${bex === "0" ? "15" : bex}d, ${bmu} unit → A+B ${grid[bestKey].ab.toFixed(2)} | C ${grid[bestKey].c.toFixed(2)} | full ${grid[bestKey].full.toFixed(2)}`);
    console.log(`   → C ${grid[bestKey].c >= cur.c ? "KHÔNG xấu đi ✅" : "XẤU ĐI ❌"} so với hiện tại`);
  }

  // Chi tiết cho vài ứng viên
  console.log("\n\n══ CHI TIẾT ỨNG VIÊN (chính sách decay 1/(1+h/4)) ══");
  console.log("biến thể".padEnd(28) + "NET R".padStart(8) + "Sharpe".padStart(8) + "NET/Ulc".padStart(8) +
    "NET/DD".padStart(8) + "skew".padStart(7) + "wMon".padStart(7) + " | SharpeA      B      C");
  console.log("-".repeat(104));
  const cands: [string, ExtParams, AdmitFn | undefined][] = [
    ["HIỆN TẠI (không policy)", { ...base }, undefined],
    ["+decay4", { ...base }, decay4],
    ["+decay4 +exit20", { ...base, longExitDays: 20 }, decay4],
    ["+decay4 +exit25", { ...base, longExitDays: 25 }, decay4],
    ["+decay4 +exit20 +u3", { ...base, longExitDays: 20, pyramidMaxUnits: 3 }, decay4],
    ["+decay4 +exit25 +u3", { ...base, longExitDays: 25, pyramidMaxUnits: 3 }, decay4],
    ["+exit20 (không policy)", { ...base, longExitDays: 20 }, undefined],
    ["+exit20 +u3 (không policy)", { ...base, longExitDays: 20, pyramidMaxUnits: 3 }, undefined],
  ];
  for (const [label, p, admit] of cands) {
    const r = evalOne(p, admit);
    console.log(
      label.padEnd(28) + r.full.netR.toFixed(0).padStart(8) + r.full.sharpe.toFixed(2).padStart(8) +
        r.full.netOverUlcer.toFixed(1).padStart(8) + r.full.netOverMaxDD.toFixed(2).padStart(8) +
        r.full.skew.toFixed(2).padStart(7) + r.full.worstMonthR.toFixed(0).padStart(7) + " |" +
        r.era.map((e) => e.sharpe.toFixed(2).padStart(7)).join(""),
    );
  }
}

main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
