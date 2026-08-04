/**
 * portfolio-equivalence.ts — CHỐT CHẶN: engine danh mục (lockstep) phải sinh ra ĐÚNG cùng chuỗi
 * trade với `runTurtle` chạy từng symbol, khi không áp ràng buộc nào.
 *
 * Nếu test này đỏ thì mọi kết luận thí nghiệm bên trên đều vô giá trị.
 *
 * Run: ./node_modules/.bin/ts-node scripts/portfolio-equivalence.ts [days]
 */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, runTurtle, buildBtcGateLongs, TurtleParams } from "../turtle";
import { runTurtlePortfolio } from "./portfolio-engine";

export const BASKET = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "adausdt", "avaxusdt", "dotusdt"];

export async function loadBasket(days: number, symbols = BASKET): Promise<Map<string, Candle[]>> {
  const bpd = TF_MS["1d"] / TF_MS[T.tf];
  const totalBars = Math.ceil(days * bpd) + T.btcGateSlow + 100;
  const data = new Map<string, Candle[]>();
  for (const s of symbols) {
    const c = await fetchKlinesPaged(s, T.tf, totalBars);
    if (c.length >= T.trendLen + 100) data.set(s, c);
  }
  return data;
}

export async function buildGate(data: Map<string, Candle[]>, days: number): Promise<TurtleParams["gate"]> {
  if (T.btcGateSlow <= 0) return undefined;
  let btc = data.get("btcusdt");
  if (!btc) {
    const bpd = TF_MS["1d"] / TF_MS[T.tf];
    btc = await fetchKlinesPaged("btcusdt", T.tf, Math.ceil(days * bpd) + T.btcGateSlow + 100);
  }
  return buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
}

async function main() {
  const days = parseInt(process.argv[2] ?? "1050", 10);
  const data = await loadBasket(days);
  const gate = await buildGate(data, days);
  const p: TurtleParams = { ...T, gate };

  const perSymbol: { key: string; netR: number }[] = [];
  for (const [sym, c] of data) {
    for (const t of runTurtle(sym, c, p)) {
      perSymbol.push({ key: `${sym}|${t.dir}|${t.entryTime}|${t.entryPrice.toFixed(8)}|${t.exitTime}|${t.exitReason}`, netR: t.netR });
    }
  }
  const res = runTurtlePortfolio(data, p);
  const portfolio = res.trades.map((t) => ({
    key: `${t.symbol}|${t.dir}|${t.entryTime}|${t.entryPrice.toFixed(8)}|${t.exitTime}|${t.exitReason}`,
    netR: t.netR,
  }));

  const sortKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  perSymbol.sort(sortKey);
  portfolio.sort(sortKey);

  const sum = (xs: { netR: number }[]) => xs.reduce((s, x) => s + x.netR, 0);
  console.log(`per-symbol runTurtle : ${perSymbol.length} unit, NET ${sum(perSymbol).toFixed(4)}R`);
  console.log(`portfolio lockstep   : ${portfolio.length} unit, NET ${sum(portfolio).toFixed(4)}R`);

  let mismatch = 0;
  const nMax = Math.max(perSymbol.length, portfolio.length);
  for (let i = 0; i < nMax; i++) {
    const a = perSymbol[i], b = portfolio[i];
    if (!a || !b || a.key !== b.key || Math.abs(a.netR - b.netR) > 1e-9) {
      if (mismatch < 5) console.log(`  ✗ [${i}] A=${a?.key ?? "—"} (${a?.netR.toFixed(4)})  B=${b?.key ?? "—"} (${b?.netR.toFixed(4)})`);
      mismatch++;
    }
  }
  console.log(mismatch === 0 ? "\n✅ TRÙNG KHỚP 100% — engine danh mục hợp lệ." : `\n❌ LỆCH ${mismatch}/${nMax} unit — KHÔNG dùng engine này.`);
  if (mismatch > 0) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error("Lỗi:", e?.response?.data ?? e.message); process.exit(1); });
