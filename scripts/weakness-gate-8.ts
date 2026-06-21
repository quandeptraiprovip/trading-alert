/**
 * Sweep premium-trap long filter — gate NET > 26.03R.
 * npx ts-node scripts/weakness-gate-8.ts
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const GATE = 26.03;
const DAYS = 250;

async function main() {
  const totalBars = Math.ceil(DAYS * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);
  const saved = { ...CONFIG };
  console.log(`Baseline file NET (trap=${CONFIG.useLongPremiumTrapFilter}):`);
  Object.assign(CONFIG, saved);
  let t = runBacktest("btcusdt", ltf);
  console.log(" ", t.reduce((s, x) => s + x.netR, 0).toFixed(2) + "R", t.length, "lệnh\n");
}

main();
