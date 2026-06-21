/**
 * Sweep tần suất vào lệnh — chỉ giữ variant NET > baseline (250d BTC).
 * Chạy: ./node_modules/.bin/ts-node scripts/entry-frequency-sweep.ts
 */
import "../load-env";
import { CONFIG, TF_MS } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const BASELINE_NET = 19.83;
const BASELINE_TRADES = 16;
const DAYS = 250;

type Variant = { name: string; o: Partial<typeof CONFIG> };

function netR(trades: ReturnType<typeof runBacktest>): number {
  return trades.reduce((s, t) => s + t.netR, 0);
}

async function main() {
  const totalBars = Math.ceil(DAYS * (TF_MS["1d"] / TF_MS[CONFIG.entryTf])) + 400;
  console.log("Tải nến BTC 15m…");
  const ltf = await fetchKlinesPaged("btcusdt", CONFIG.entryTf, totalBars);
  const saved = { ...CONFIG };

  const variants: Variant[] = [
    { name: "baseline", o: {} },
    // Cooldown — thường là nút thắt lớn nhất sau khi đóng lệnh
    { name: "cooldown 40", o: { cooldownBars: 40 } },
    { name: "cooldown 32", o: { cooldownBars: 32 } },
    { name: "cooldown 24", o: { cooldownBars: 24 } },
    { name: "cooldown 16", o: { cooldownBars: 16 } },
    // Chờ confirm lâu hơn
    { name: "setupExpiry 32", o: { setupExpiryBars: 32 } },
    { name: "setupExpiry 36", o: { setupExpiryBars: 36 } },
    { name: "setupExpiry 48", o: { setupExpiryBars: 48 } },
    // Nới confirm volume / delta
    { name: "ltfConfirm 1.25", o: { ltfConfirmVolMult: 1.25 } },
    { name: "ltfConfirm 1.2", o: { ltfConfirmVolMult: 1.2 } },
    { name: "delta 0.52", o: { deltaBuyMin: 0.52 } },
    { name: "delta 0.50", o: { deltaBuyMin: 0.5 } },
    // Vùng: tap rộng hơn / cho phép mitigate thêm 1 lần
    { name: "zoneTap 0.002", o: { zoneTapTolPct: 0.002 } },
    { name: "maxMitig 2", o: { maxZoneMitigations: 2 } },
    { name: "volSpike 1.8", o: { volSpikeMult: 1.8 } },
    // Kết hợp “nhiều lệnh”
    { name: "cd32 + exp36", o: { cooldownBars: 32, setupExpiryBars: 36 } },
    { name: "cd32 + vol1.25", o: { cooldownBars: 32, ltfConfirmVolMult: 1.25 } },
    { name: "cd24 + exp32 + vol1.25", o: { cooldownBars: 24, setupExpiryBars: 32, ltfConfirmVolMult: 1.25 } },
    { name: "cd32 + delta0.52", o: { cooldownBars: 32, deltaBuyMin: 0.52 } },
    { name: "cd40 + exp36 + vol1.25", o: { cooldownBars: 40, setupExpiryBars: 36, ltfConfirmVolMult: 1.25 } },
    // Exit (không thêm entry nhưng có thể tăng NET)
    { name: "trailStart 1.75", o: { trailStartR: 1.75 } },
    { name: "cd32 + trail1.75", o: { cooldownBars: 32, trailStartR: 1.75 } },
  ];

  console.log(`\nGate: NET > ${BASELINE_NET}R và ưu tiên nhiều lệnh hơn ${BASELINE_TRADES}\n`);
  console.log("Variant                              | Lệnh | NET R    | Δ NET    | WR");
  console.log("-".repeat(78));

  const pass: { v: Variant; net: number; n: number; wr: number }[] = [];

  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const trades = runBacktest("btcusdt", ltf);
    const net = netR(trades);
    const wr = trades.length ? trades.filter((t) => t.netR > 0).length / trades.length : 0;
    const mark = net > BASELINE_NET + 1e-9 ? "✓" : " ";
    if (net > BASELINE_NET + 1e-9) pass.push({ v, net, n: trades.length, wr });
    console.log(
      `${v.name.padEnd(36)} | ${String(trades.length).padStart(4)} | ${(net >= 0 ? "+" : "") + net.toFixed(2).padStart(7)}R | ${(net - BASELINE_NET >= 0 ? "+" : "") + (net - BASELINE_NET).toFixed(2).padStart(6)}R ${mark} | ${(wr * 100).toFixed(0)}%`,
    );
  }

  Object.assign(CONFIG, saved);

  pass.sort((a, b) => b.n - a.n || b.net - a.net);
  console.log("-".repeat(78));
  console.log(`Pass NET>${BASELINE_NET}R (${pass.length}):`);
  for (const p of pass) {
    const more = p.n > BASELINE_TRADES ? ` (+${p.n - BASELINE_TRADES} lệnh)` : "";
    console.log(`  ${p.net.toFixed(2)}R / ${p.n} lệnh WR ${(p.wr * 100).toFixed(0)}%${more} — ${p.v.name}`);
  }

  const moreTrades = pass.filter((p) => p.n > BASELINE_TRADES);
  moreTrades.sort((a, b) => b.net - a.net);
  if (moreTrades.length) {
    console.log("\nBest (NET cao nhất trong số có NHIỀU lệnh hơn baseline):");
    const b = moreTrades[0];
    console.log(`  ${b.v.name} → ${b.net.toFixed(2)}R, ${b.n} lệnh`, JSON.stringify(b.v.o));
  } else {
    console.log("\nKhông có variant nào vừa NET>baseline vừa nhiều lệnh hơn — cần chỉnh logic pipeline.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
