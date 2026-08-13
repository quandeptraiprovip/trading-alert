/**
 * exp-downtime.ts — CHI PHÍ CỦA VIỆC BOT DỪNG. Turtle dừng từ 2026-07-20, Fast từ 2026-07-22
 * (mtime của state file + `lastBarTime`), trong khi hôm nay là 2026-08-12.
 *
 * Mọi cải tiến luật đều vô nghĩa nếu process không chạy. Script này quy khoảng dừng ra R để biết
 * nó đắt hay rẻ so với các cải tiến đang bàn.
 *
 * Run: ./node_modules/.bin/ts-node scripts/exp-downtime.ts [days] [YYYY-MM-DD dừng]
 */
import { TF_MS } from "../strategy";
import { T, buildBtcGateLongs } from "../turtle";
import { Book, ExtParams, runBooks, UnitTrade } from "./portfolio-engine";
import { liveSleeves } from "./chop-diagnosis";
import { decayH, Gate, fmtD } from "./rx-lab";
import { CORE8, loadPool, coreWindow } from "./exp-breadth";

async function main() {
  const days = parseInt(process.argv[2] ?? "800", 10);
  const stopStr = process.argv[3] ?? "2026-07-20";
  const stop = Date.parse(stopStr + "T00:00:00Z");
  const data = await loadPool(days, CORE8);
  const gate: Gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);
  const { turtle, fast } = liveSleeves(gate);
  const w = coreWindow(data, T.btcGateSlow + 130);
  const downDays = (w.to - stop) / TF_MS["1d"];
  console.log(`Khoảng DỪNG: ${fmtD(stop)} → ${fmtD(w.to)} (${downDays.toFixed(0)} ngày)\n`);

  for (const [name, p] of [["TURTLE", turtle], ["FAST", fast]] as [string, ExtParams][]) {
    const bk: Book[] = [...data.entries()].map(([symbol, candles]) => ({ key: symbol, symbol, candles, p }));
    const res = runBooks(bk, decayH(T.heatDecayK));
    const inWin = res.trades.filter((t: UnitTrade) => t.entryTime >= stop);
    const net = inWin.reduce((s, t) => s + t.netR * t.weight, 0);
    const wins = inWin.filter((t) => t.netR > 0).length;
    const open = res.openAtEnd.filter((u) => u.entryTime >= stop);
    const byDir = (d: "long" | "short") => {
      const ts = inWin.filter((t) => t.dir === d);
      return `${d} ${ts.length}u ${ts.reduce((s, t) => s + t.netR * t.weight, 0).toFixed(1)}R`;
    };
    console.log(
      `${name}: ${inWin.length} unit đã đóng · WR ${inWin.length ? ((wins / inWin.length) * 100).toFixed(0) : "—"}% · ` +
        `NET ${net >= 0 ? "+" : ""}${net.toFixed(1)}R · ${byDir("long")} · ${byDir("short")} · còn mở ${open.length} unit`,
    );
    const bySym = new Map<string, number>();
    for (const t of inWin) bySym.set(t.symbol, (bySym.get(t.symbol) ?? 0) + t.netR * t.weight);
    console.log(
      "   theo coin: " +
        [...bySym.entries()].sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s.replace("usdt", "")} ${v >= 0 ? "+" : ""}${v.toFixed(1)}`).join(" · "),
    );
  }
  console.log(`\nĐể so sánh: NET R 365 ngày gần nhất là +31R (Turtle) / +52R (Fast).`);
}

if (require.main === module && /exp-downtime\.(ts|js)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => { console.error("Lỗi:", e?.message ?? e); process.exit(1); });
}
