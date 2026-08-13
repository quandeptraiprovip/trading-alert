/**
 * exp-year-report.ts — BÁO CÁO Net R của PHƯƠNG PHÁP ĐANG CHẠY trên cửa sổ N ngày gần nhất.
 *
 * Cấu hình đo = đúng cấu hình `/health` xác nhận ngày 12/08/2026:
 *   Turtle @ Binance : heat-decay k=4, duyệt tuần tự   (fp ebc86f)
 *   Fast   @ MEXC    : KHÔNG heat-decay                (fp dbe0cf)
 * Hai sổ RIÊNG, mỗi sổ risk 0,5%/unit trên equity riêng của nó — không phải danh mục ½+½ như các
 * script nghiên cứu; ở đây báo cáo từng sổ rồi mới quy ra tiền theo equity thật.
 *
 * ⚠️ ĐÂY LÀ BACKTEST LUẬT HIỆN TẠI trên 365 ngày qua, KHÔNG phải P&L thực tế của tài khoản. Nó trả lời
 * "luật này lẽ ra kiếm được bao nhiêu", không trả lời "tài khoản đã kiếm được bao nhiêu" — muốn số sau
 * thì phải đọc journal của máy đang chạy bot.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-year-report.ts [days=365] [eqBinance] [eqMexc]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { AdmitFn, Book, ExtParams, PortfolioResult, UnitTrade, runBooks } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool } from "./exp-breadth";

const DAY = TF_MS["1d"];
const RISK_PCT = 0.005; // TURTLE_RISK_PCT = FAST_TREND_RISK_PCT = 0,5%

/** Net R theo mark-to-market trong cửa sổ (xử lý đúng vị thế mở vắt qua biên). */
function mtmNetR(res: PortfolioResult, from: number, to: number): { netR: number; maxDD: number } {
  const eq = res.equity.filter((e) => e.time >= from && e.time <= to);
  if (eq.length < 2) return { netR: 0, maxDD: 0 };
  let net = 0, peak = -Infinity, dd = 0, cum = 0;
  for (let i = 1; i < eq.length; i++) {
    net += eq[i].mtm - eq[i - 1].mtm;
    cum = net;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return { netR: net, maxDD: dd };
}

function statsOf(ts: UnitTrade[]) {
  const wsum = ts.reduce((s, t) => s + t.weight, 0);
  const net = ts.reduce((s, t) => s + t.netR * t.weight, 0);
  const raw = ts.reduce((s, t) => s + t.netR, 0);
  const wins = ts.filter((t) => t.netR > 0);
  const losses = ts.filter((t) => t.netR <= 0);
  return {
    n: ts.length,
    wsum,
    net,
    raw,
    wr: ts.length ? (wins.length / ts.length) * 100 : 0,
    avgWin: wins.length ? wins.reduce((s, t) => s + t.netR, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.netR, 0) / losses.length : 0,
    exp: wsum ? net / wsum : 0,
  };
}

async function main() {
  const days = parseInt(process.argv[2] ?? "365", 10);
  const eqBin = parseFloat(process.argv[3] ?? "192.68");
  const eqMexc = parseFloat(process.argv[4] ?? "320.43");

  // tải đủ warmup cho gate SMA100d + kênh 30d
  const data = await loadPool(days + T.btcGateSlow / 6 + 160, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);

  let last = -Infinity;
  for (const [, c] of data) last = Math.max(last, c[c.length - 1].openTime);
  const to = last, from = to - days * DAY;

  const bk = (p: ExtParams, tag: string): Book[] =>
    [...data.entries()].map(([symbol, candles]) => ({ key: `${symbol}@${tag}`, symbol, candles, p }));

  const SLEEVES: [string, PortfolioResult, number][] = [
    ["TURTLE @ Binance (heat k=4)", runBooks(bk(turtle, "t"), decayH(T.heatDecayK) as AdmitFn), eqBin],
    ["FAST @ MEXC (không heat)", runBooks(bk(fast, "f"), undefined), eqMexc],
  ];

  console.log(`\nPHƯƠNG PHÁP ĐANG CHẠY — Net R ${days} ngày: ${fmtD(from)} → ${fmtD(to)}`);
  console.log(`⚠️  BACKTEST luật hiện tại, KHÔNG phải P&L thực tế của tài khoản.\n`);

  let totalUsd = 0;
  for (const [label, res, equity] of SLEEVES) {
    const m = mtmNetR(res, from, to);
    // unit ĐÓNG trong cửa sổ — dùng cho WR/expectancy
    const closed = res.trades.filter((t) => t.exitTime >= from && t.exitTime <= to);
    const s = statsOf(closed);
    const usd = m.netR * RISK_PCT * equity;
    totalUsd += usd;

    console.log("=".repeat(104));
    console.log(`  ${label} · equity $${equity.toFixed(2)} · risk ${(RISK_PCT * 100).toFixed(2)}%/unit`);
    console.log("=".repeat(104));
    console.log(`NET R (mark-to-market)   : ${m.netR >= 0 ? "+" : ""}${m.netR.toFixed(2)}R    maxDD trong cửa sổ: ${m.maxDD.toFixed(2)}R`);
    console.log(`Quy ra tiền (xấp xỉ)     : ${usd >= 0 ? "+" : ""}$${usd.toFixed(2)}   (= NET R × 0,5% × equity, không compounding)`);
    console.log(`Unit đã đóng             : ${s.n}  (${(s.n / days * 30).toFixed(1)}/tháng) · Σ tỉ trọng ${s.wsum.toFixed(1)}`);
    console.log(`NET R từ unit đã đóng    : ${s.net >= 0 ? "+" : ""}${s.net.toFixed(2)}R · exp ${s.exp.toFixed(3)}R/đơn vị tỉ trọng`);
    console.log(`ΣnetR thô (không tỉ trọng): ${s.raw >= 0 ? "+" : ""}${s.raw.toFixed(2)}R`);
    console.log(`Win rate                 : ${s.wr.toFixed(1)}% · avg win ${s.avgWin >= 0 ? "+" : ""}${s.avgWin.toFixed(2)}R · avg loss ${s.avgLoss.toFixed(2)}R`);

    console.log(`\n  — theo HƯỚNG —`);
    for (const dir of ["long", "short"] as const) {
      const d = statsOf(closed.filter((t) => t.dir === dir));
      console.log(`  ${dir.toUpperCase().padEnd(6)}: ${String(d.n).padStart(4)} unit · NET ${d.net >= 0 ? "+" : ""}${d.net.toFixed(1)}R · exp ${d.exp.toFixed(3)} · WR ${d.wr.toFixed(0)}%`);
    }
    console.log(`  — theo LÝ DO THOÁT —`);
    for (const r of ["trail", "mid", "time"] as const) {
      const d = statsOf(closed.filter((t) => t.exitReason === r));
      if (!d.n) continue;
      console.log(`  ${r.padEnd(6)}: ${String(d.n).padStart(4)} unit · NET ${d.net >= 0 ? "+" : ""}${d.net.toFixed(1)}R · exp ${d.exp.toFixed(3)} · WR ${d.wr.toFixed(0)}%`);
    }
    console.log(`  — theo SYMBOL —`);
    const bySym = new Map<string, UnitTrade[]>();
    for (const t of closed) {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
      bySym.get(t.symbol)!.push(t);
    }
    for (const sym of CORE8) {
      const d = statsOf(bySym.get(sym) ?? []);
      console.log(`  ${sym.toUpperCase().padEnd(10)}: ${String(d.n).padStart(4)} unit · NET ${d.net >= 0 ? "+" : ""}${d.net.toFixed(1)}R · exp ${d.exp.toFixed(3)}`);
    }
    console.log();
  }

  // ── SO SÁNH VỚI CÁC PHIÊN BẢN CŨ ────────────────────────────────────────────
  // Ở live, risk/unit luôn là 0,5% qua mọi phiên bản, nên Net R ở đây SO ĐƯỢC trực tiếp bằng tiền —
  // khác với việc so hai chính sách heat khác nhau (chỗ đó Net R vô nghĩa, xem `exp-solutions.ts netr`).
  // maxDD in kèm vì heat-decay vừa giảm Net R vừa giảm DD.
  console.log("=".repeat(104));
  console.log(`  LỊCH SỬ NÂNG CẤP — Net R ${days} ngày, cùng risk 0,5%/unit (nên so được bằng tiền)`);
  console.log("=".repeat(104));
  console.log("phiên bản".padEnd(46) + "NET R".padStart(9) + "maxDD(R)".padStart(10) +
    "NET/DD".padStart(8) + "unit".padStart(7) + "  quy tiền");
  console.log("-".repeat(104));

  const LADDER: [string, ExtParams, AdmitFn | undefined, number][] = [
    // — TURTLE, theo mốc ship thật —
    ["T v1 · trước 04/07: không pyramid, không gate",
      { ...turtle, entryDays: 20, pyramidStepAtr: 0, pyramidMaxUnits: 1, longExitMode: "chandelier", longExitDays: 0, gate: undefined }, undefined, eqBin],
    ["T v2 · 04/07: +pyramid 4u +BTC gate",
      { ...turtle, entryDays: 20, pyramidMaxUnits: 4, longExitMode: "chandelier", longExitDays: 0 }, undefined, eqBin],
    // Xác minh bằng git: 04/07 bccc38f chưa có longExitMode (⇒ chandelier); 02/08 1e657c1 đã có
    // longExitMode "mid" nhưng chưa có longExitDays (⇒ kênh thoát = kênh vào 15d).
    ["T v2b · 19/07: entry 20d→15d (vẫn chandelier)",
      { ...turtle, pyramidMaxUnits: 4, longExitMode: "chandelier", longExitDays: 0 }, undefined, eqBin],
    ["T v3 · 02/08: mid-exit = kênh vào 15d, 4u",
      { ...turtle, pyramidMaxUnits: 4, longExitMode: "mid", longExitDays: 0 }, undefined, eqBin],
    ["T v4 · 04/08: +heat k4 +mid-exit 20d +3u  ⟵ ĐANG CHẠY",
      turtle, decayH(T.heatDecayK) as AdmitFn, eqBin],
    // — FAST, theo mốc ship thật —
    ["F v1 · trước 09/08: chandelier exit, 4 unit",
      { ...fast, longExitMode: "chandelier", longExitDays: 0, pyramidMaxUnits: 4 }, undefined, eqMexc],
    ["F v2 · 09/08: mid-exit 20d + 3 unit  ⟵ ĐANG CHẠY",
      fast, undefined, eqMexc],
  ];

  for (const [label, p, admit, equity] of LADDER) {
    const res = runBooks(bk(p, `L${label}`), admit);
    const m = mtmNetR(res, from, to);
    const nUnit = res.trades.filter((t) => t.exitTime >= from && t.exitTime <= to).length;
    const usd = m.netR * RISK_PCT * equity;
    console.log(
      label.padEnd(46) + `${m.netR >= 0 ? "+" : ""}${m.netR.toFixed(1)}R`.padStart(9) +
        m.maxDD.toFixed(1).padStart(10) + (m.maxDD > 0 ? m.netR / m.maxDD : 0).toFixed(2).padStart(8) +
        String(nUnit).padStart(7) + `  ${usd >= 0 ? "+" : ""}$${usd.toFixed(2)}`,
    );
  }
  console.log("-".repeat(104));
  console.log("Lưu ý: v4 có heat-decay nên tỉ trọng unit < 1 ⇒ Net R nhỏ hơn v3 là ĐÚNG THIẾT KẾ;");
  console.log("phải đọc cột NET/DD, và nhớ rằng heat cho phép nâng risk/unit ở cùng mức đau.\n");

  // ── ABLATION: v3→v4 đổi BA thứ cùng lúc; cái nào làm xấu cửa sổ 365 ngày? ──
  console.log("=".repeat(104));
  console.log(`  ABLATION v3→v4 (Turtle): tách từng thay đổi để biết cái nào chịu trách nhiệm`);
  console.log("=".repeat(104));
  console.log("cấu hình".padEnd(46) + "NET R".padStart(9) + "maxDD(R)".padStart(10) + "NET/DD".padStart(8) + "unit".padStart(7));
  console.log("-".repeat(104));
  const v3: ExtParams = { ...turtle, pyramidMaxUnits: 4, longExitMode: "chandelier", longExitDays: 0 };
  const ABL: [string, ExtParams, AdmitFn | undefined][] = [
    ["v3 (mốc): chandelier · 4 unit · không heat", v3, undefined],
    ["  + CHỈ heat k=4", v3, decayH(T.heatDecayK) as AdmitFn],
    ["  + CHỈ mid-exit 20d", { ...v3, longExitMode: "mid", longExitDays: 20 }, undefined],
    ["  + CHỈ trần 3 unit", { ...v3, pyramidMaxUnits: 3 }, undefined],
    ["v4 = cả ba (ĐANG CHẠY)", turtle, decayH(T.heatDecayK) as AdmitFn],
  ];
  for (const [label, p, admit] of ABL) {
    const res = runBooks(bk(p, `A${label}`), admit);
    const m = mtmNetR(res, from, to);
    const nUnit = res.trades.filter((t) => t.exitTime >= from && t.exitTime <= to).length;
    console.log(
      label.padEnd(46) + `${m.netR >= 0 ? "+" : ""}${m.netR.toFixed(1)}R`.padStart(9) +
        m.maxDD.toFixed(1).padStart(10) + (m.maxDD > 0 ? m.netR / m.maxDD : 0).toFixed(2).padStart(8) +
        String(nUnit).padStart(7),
    );
  }
  console.log();

  console.log("=".repeat(104));
  console.log(`  TỔNG HAI SỔ`);
  console.log("=".repeat(104));
  const eqTotal = eqBin + eqMexc;
  console.log(`Tiền (xấp xỉ)  : ${totalUsd >= 0 ? "+" : ""}$${totalUsd.toFixed(2)} trên tổng vốn $${eqTotal.toFixed(2)} = ${((totalUsd / eqTotal) * 100).toFixed(1)}%`);
  console.log(`\nLưu ý: hai sổ có risk 0,5%/unit RIÊNG trên equity RIÊNG, nên không cộng Net R của chúng`);
  console.log(`lại được — R của mỗi sổ có giá trị tiền khác nhau ($${(RISK_PCT * eqBin).toFixed(2)} vs $${(RISK_PCT * eqMexc).toFixed(2)}).`);
}

if (require.main === module && /exp-year-report\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error("Lỗi:", e?.message ?? e);
    process.exit(1);
  });
}
