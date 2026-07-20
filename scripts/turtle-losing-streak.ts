/** Chuỗi thua dài nhất của config turtle đã áp dụng (pyr4+gateL), cửa sổ audit 1015d. */
import { Candle, TF_MS } from "../strategy";
import { fetchKlinesPaged } from "../kline-fetch";
import { T, runTurtle, Trade, TurtleParams, buildBtcGateLongs } from "../turtle";

const BASE8 = ["btcusdt", "ethusdt", "solusdt", "xrpusdt", "dogeusdt", "bnbusdt", "adausdt", "avaxusdt"];

function streak(ts: { netR: number; label: string; t: number }[]) {
  let cur = 0, curR = 0, best = 0, bestR = 0, bestEnd = 0;
  for (const x of ts) {
    if (x.netR <= 0) {
      cur++; curR += x.netR;
      if (cur > best) { best = cur; bestR = curR; bestEnd = x.t; }
    } else { cur = 0; curR = 0; }
  }
  return { best, bestR, bestEnd };
}

async function main() {
  const totalBars = Math.ceil(1100 * (TF_MS["1d"] / TF_MS[T.tf])) + T.trendLen + 50;
  const data = new Map<string, Candle[]>();
  for (const s of BASE8) data.set(s, await fetchKlinesPaged(s, T.tf, totalBars));
  const btc = data.get("btcusdt")!;
  const gate = buildBtcGateLongs(btc, T.btcGateFast, T.btcGateSlow);
  const t0 = btc[610].openTime;
  const p: TurtleParams = { ...T, gate };

  const all: Trade[] = [];
  for (const [s, c] of data) all.push(...runTurtle(s, c, p));
  const ts = all.filter((t) => t.entryTime >= t0).sort((a, b) => a.exitTime - b.exitTime);

  // per-LỆNH (unit)
  const perUnit = streak(ts.map((t) => ({ netR: t.netR, label: t.symbol, t: t.exitTime })));
  // per-VỊ THẾ (gộp unit cùng symbol+exitTime)
  const posMap = new Map<string, { netR: number; t: number }>();
  for (const t of ts) {
    const k = `${t.symbol}|${t.exitTime}`;
    const e = posMap.get(k) ?? { netR: 0, t: t.exitTime };
    e.netR += t.netR; posMap.set(k, e);
  }
  const poss = [...posMap.values()].sort((a, b) => a.t - b.t);
  const perPos = streak(poss.map((x) => ({ netR: x.netR, label: "", t: x.t })));

  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  console.log(`Lệnh (unit): ${ts.length} | Vị thế: ${poss.length}`);
  console.log(`Chuỗi thua dài nhất theo LỆNH   : ${perUnit.best} lệnh liên tiếp, tổng ${perUnit.bestR.toFixed(1)}R (kết thúc ~${fmt(perUnit.bestEnd)})`);
  console.log(`Chuỗi thua dài nhất theo VỊ THẾ : ${perPos.best} vị thế liên tiếp, tổng ${perPos.bestR.toFixed(1)}R (kết thúc ~${fmt(perPos.bestEnd)})`);
}
main().catch((e) => { console.error(e?.response?.data ?? e.message); process.exit(1); });
