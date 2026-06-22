/**
 * Sweep tham số EXIT/target/SL — đánh giá trên RỔ (BTC+SOL+XRP+DOGE), gate +44.79R NET.
 * Đa số experiment cũ (README) là filter ENTRY; đây thăm dò phía thoát lệnh.
 * Chạy: ./node_modules/.bin/ts-node scripts/exit-sweep.ts [days]
 */
import "../load-env";
import { CONFIG, TF_MS, Candle } from "../strategy";
import { fetchKlinesPaged, runBacktest } from "../backtest";

const BASELINE_NET = 44.79;
const SYMBOLS = ["btcusdt", "solusdt", "xrpusdt", "dogeusdt"];
const DAYS = parseInt(process.argv[2] ?? "250", 10);

type Variant = { name: string; o: Partial<typeof CONFIG> };

function basketNet(data: Map<string, Candle[]>): { net: number; n: number; wr: number; per: Record<string, number> } {
  let net = 0, n = 0, wins = 0;
  const per: Record<string, number> = {};
  for (const [sym, ltf] of data) {
    const trades = runBacktest(sym, ltf);
    const s = trades.reduce((a, t) => a + t.netR, 0);
    per[sym] = s;
    net += s;
    n += trades.length;
    wins += trades.filter((t) => t.netR > 0).length;
  }
  return { net, n, wr: n ? wins / n : 0, per };
}

async function main() {
  const barsPerDay = TF_MS["1d"] / TF_MS[CONFIG.entryTf];
  const totalBars = Math.ceil(DAYS * barsPerDay) + 400;
  console.log(`Tải ${DAYS}d × ${SYMBOLS.length} symbol (một lần)…`);
  const data = new Map<string, Candle[]>();
  for (const s of SYMBOLS) data.set(s, await fetchKlinesPaged(s, CONFIG.entryTf, totalBars));

  const saved = { ...CONFIG };
  const D = TF_MS["1d"] / TF_MS[CONFIG.entryTf]; // 96 nến/ngày

  const variants: Variant[] = [
    { name: "BASELINE (targetRR2.5, trail2.0, hold7d)", o: {} },
    // ── targetRR fallback (để winner chạy xa hơn khi không có zone đối diện) ──
    { name: "targetRR 2.0", o: { targetRR: 2.0 } },
    { name: "targetRR 3.0", o: { targetRR: 3.0 } },
    { name: "targetRR 3.5", o: { targetRR: 3.5 } },
    { name: "targetRR 4.0", o: { targetRR: 4.0 } },
    // ── trailStartR (trail sớm/muộn) ──
    { name: "trailStart 1.5", o: { trailStartR: 1.5 } },
    { name: "trailStart 2.5", o: { trailStartR: 2.5 } },
    { name: "trailStart 3.0", o: { trailStartR: 3.0 } },
    // ── "let winners run": trail sớm + target xa ──
    { name: "trail1.5 + targetRR4", o: { trailStartR: 1.5, targetRR: 4.0 } },
    { name: "trail2.0 + targetRR4", o: { trailStartR: 2.0, targetRR: 4.0 } },
    { name: "trail2.5 + targetRR3.5", o: { trailStartR: 2.5, targetRR: 3.5 } },
    // ── slBuffer (đệm SL ngoài vùng) ──
    { name: "slBuffer 0.0015", o: { slBufferPct: 0.0015 } },
    { name: "slBuffer 0.0035", o: { slBufferPct: 0.0035 } },
    { name: "slBuffer 0.0050", o: { slBufferPct: 0.005 } },
    // ── maxHold (thời gian giữ tối đa) ──
    { name: "maxHold 5d", o: { maxHoldBars: 5 * D } },
    { name: "maxHold 6d", o: { maxHoldBars: 6 * D } },
    { name: "maxHold 10d", o: { maxHoldBars: 10 * D } },
    { name: "maxHold 14d", o: { maxHoldBars: 14 * D } },
    // ── breakeven (README: thường giảm EV — xác nhận lại) ──
    { name: "BE @1.0R", o: { breakevenEnabled: true, breakevenAtR: 1.0 } },
    { name: "BE @1.5R", o: { breakevenEnabled: true, breakevenAtR: 1.5 } },
    // ── cooldown ──
    { name: "cooldown 24 (6h)", o: { cooldownBars: 24 } },
    { name: "cooldown 96 (1d)", o: { cooldownBars: 96 } },
  ];

  console.log("\nVariant                                  | Lệnh | NET R    | Δ vs 44.79 | WR  | per-coin BTC/SOL/XRP/DOGE");
  console.log("-".repeat(108));

  let best = { name: "", net: -Infinity, o: {} as Partial<typeof CONFIG> };
  for (const v of variants) {
    Object.assign(CONFIG, saved);
    Object.assign(CONFIG, v.o);
    const r = basketNet(data);
    const mark = r.net >= BASELINE_NET - 1e-9 ? "✓" : " ";
    const per = SYMBOLS.map((s) => (r.per[s] >= 0 ? "+" : "") + r.per[s].toFixed(1)).join("/");
    console.log(
      `${v.name.padEnd(40)} | ${String(r.n).padStart(4)} | ${((r.net >= 0 ? "+" : "") + r.net.toFixed(2)).padStart(8)}R | ${((r.net - BASELINE_NET >= 0 ? "+" : "") + (r.net - BASELINE_NET).toFixed(2)).padStart(7)}R ${mark} | ${(r.wr * 100).toFixed(0).padStart(2)}% | ${per}`
    );
    if (v.name !== "BASELINE (targetRR2.5, trail2.0, hold7d)" && r.net > best.net) best = { name: v.name, net: r.net, o: v.o };
  }
  Object.assign(CONFIG, saved);

  console.log("-".repeat(108));
  console.log(`Tốt nhất (≠baseline): "${best.name}" → ${best.net.toFixed(2)}R`);
  console.log(`Gate ${BASELINE_NET}R — ${best.net >= BASELINE_NET ? "PASS: validate tiếp bằng backtest.ts (walk-forward + p-value) trước khi đổi CONFIG" : "FAIL: GIỮ baseline"}`);
  if (best.net >= BASELINE_NET) console.log("CONFIG đề xuất:", JSON.stringify(best.o));
}

main().catch((e) => { console.error(e); process.exit(1); });
