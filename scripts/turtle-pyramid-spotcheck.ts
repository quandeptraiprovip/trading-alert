/**
 * Spot-check pyramiding turtle.ts: bất biến vị thế + expectancy theo THỨ TỰ unit.
 * Run: ./node_modules/.bin/ts-node scripts/turtle-pyramid-spotcheck.ts
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, runTurtle, Trade, buildBtcGateLongs } from "../turtle";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];

async function main() {
  const totalBars = Math.ceil(1100 * (TF_MS["1d"] / TF_MS[T.tf])) + T.trendLen + 50;
  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) data.set(s, await fetchKlinesPaged(s, T.tf, totalBars));
  const gate = buildBtcGateLongs(data.get("btcusdt")!, T.btcGateFast, T.btcGateSlow);

  const all: Trade[] = [];
  for (const [s, c] of data) all.push(...runTurtle(s, c, { ...T, gate }));

  // group thành vị thế theo (symbol, exitTime)
  const posMap = new Map<string, Trade[]>();
  for (const t of all) {
    const k = `${t.symbol}|${t.exitTime}`;
    (posMap.get(k) ?? posMap.set(k, []).get(k)!).push(t);
  }
  let bad = 0;
  const unitStats: { n: number; net: number; win: number }[] = [[], [], [], []].map(() => ({ n: 0, net: 0, win: 0 }));
  const sizeDist: Record<number, number> = {};
  for (const units of posMap.values()) {
    units.sort((a, b) => a.entryTime - b.entryTime);
    sizeDist[units.length] = (sizeDist[units.length] ?? 0) + 1;
    if (units.length > T.pyramidMaxUnits) { bad++; console.log("❌ >maxUnits", units[0].symbol, units.length); }
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (i > 0) {
        const prev = units[i - 1];
        const ok = u.dir === "long" ? u.entryPrice > prev.entryPrice : u.entryPrice < prev.entryPrice;
        if (!ok) { bad++; console.log("❌ thứ tự entry sai", u.symbol, prev.entryPrice, "→", u.entryPrice, u.dir); }
        if (u.exitPrice !== prev.exitPrice) { bad++; console.log("❌ exit lệch trong vị thế", u.symbol); }
        if (u.holdBars >= prev.holdBars) { bad++; console.log("❌ holdBars không giảm", u.symbol); }
      }
      const st = unitStats[Math.min(i, 3)];
      st.n++; st.net += u.netR; if (u.netR > 0) st.win++;
    }
  }
  console.log(`Vị thế: ${posMap.size} | lệnh(unit): ${all.length} | vi phạm bất biến: ${bad}`);
  console.log(`Phân bố #unit/vị thế: ${Object.entries(sizeDist).map(([k, v]) => `${k}u=${v}`).join("  ")}`);
  console.log("\nExpectancy theo THỨ TỰ unit (toàn rổ, toàn kỳ):");
  unitStats.forEach((s, i) => {
    if (s.n) console.log(`  unit ${i + 1}: ${String(s.n).padStart(4)} lệnh | WR ${((s.win / s.n) * 100).toFixed(0)}% | exp ${(s.net / s.n).toFixed(3)}R | NET ${s.net >= 0 ? "+" : ""}${s.net.toFixed(1)}R`);
  });

  // ví dụ 2 vị thế nhiều unit
  console.log("\nVí dụ vị thế 4-unit:");
  let shown = 0;
  for (const units of posMap.values()) {
    if (units.length < 4 || shown >= 2) continue;
    shown++;
    for (const u of units) console.log(`  ${u.symbol} ${u.dir} entry=${u.entryPrice.toFixed(4)} SL0=${u.initialSL.toFixed(4)} exit=${u.exitPrice.toFixed(4)} netR=${u.netR.toFixed(2)} hold=${u.holdBars}`);
  }
}
main().catch((e) => { console.error(e?.response?.data ?? e.message); process.exit(1); });
