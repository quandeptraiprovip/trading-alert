/**
 * CỤM NẾN ĐẢO CHIỀU đang được chấm Ở ĐÂU so với key?
 *
 * Dựng lại đúng vòng lặp của `buildEntryPlans` (không sửa engine) rồi đo, với
 * mỗi cụm được đếm:
 *   · cách nến CHẠM key bao nhiêu cây (`setup` sống `sweepWaitBars` cây),
 *   · chính nến bóp cò có còn chạm key không,
 *   · thân hộp cách key bao nhiêu ATR,
 *   · trước khi chạm, giá đã thật sự RỜI key chưa (mới gọi là "quay về").
 *
 * Chạy: npx ts-node scripts/exp-keyvol-cluster-locus.ts [days]
 */
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeDirection,
  atrSeriesForward,
  detectKeyVolumeLevels,
  isKeyVolumeLevelActive,
  medianPrior,
  reversalOrderBlock,
} from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { Candle, TF_MS } from "../strategy";

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];
const P = KEY_VOLUME_CONFIG;

const qv = (c: Candle): number =>
  c.quoteVolume != null && c.quoteVolume > 0 ? c.quoteVolume : c.volume * c.close;

function pct(n: number, d: number): string {
  return d ? `${(100 * n / d).toFixed(1)}%` : "—";
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + 800;

  let clusters = 0, triggerTouches = 0, sameBar = 0;
  let hadLeftKey = 0;
  const lagCounts = new Map<number, number>();
  const gaps: number[] = [];

  for (const symbol of SYMBOLS) {
    const confirm = await fetchKlinesPaged(symbol, "15m", bars);
    const levels = detectKeyVolumeLevels(confirm, "15m", P);
    const atr = atrSeriesForward(confirm);
    const volumes = confirm.map(qv);
    const start = Math.max(P.touchVolumeLookback, P.sweepLookback + P.sweepProminenceBars, 1);
    let setup: { key: typeof levels[number]; dir: KeyVolumeDirection; touchIndex: number } | null = null;

    for (let i = start; i < confirm.length; i++) {
      const candle = confirm[i];
      const closeTime = candle.openTime + TF_MS["15m"];

      if (setup) {
        const dead = !isKeyVolumeLevelActive(setup.key, closeTime)
          || (setup.dir === "long" ? candle.close < setup.key.price : candle.close > setup.key.price);
        if (dead || i - setup.touchIndex > P.sweepWaitBars) setup = null;
      }

      if (!setup) {
        const tol = P.keyTouchAtr * atr[i];
        let best: typeof levels[number] | null = null;
        for (const key of levels) {
          if (!isKeyVolumeLevelActive(key, closeTime)) continue;
          if (!(candle.low <= key.price + tol && candle.high >= key.price - tol)) continue;
          if (!best || key.volumeRatio > best.volumeRatio) best = key;
        }
        if (best) {
          const baseline = medianPrior(volumes, i, P.touchVolumeLookback);
          const ratio = baseline > 0 ? volumes[i] / baseline : 0;
          if (ratio >= P.touchVolumeSpikeMult) {
            setup = { key: best, dir: best.price <= candle.close ? "long" : "short", touchIndex: i };
          }
        }
      }
      if (!setup) continue;

      const cluster = reversalOrderBlock(confirm, i, setup.dir);
      if (!cluster) continue;
      clusters++;

      const lag = i - setup.touchIndex;
      lagCounts.set(lag, (lagCounts.get(lag) ?? 0) + 1);
      if (lag === 0) sameBar++;

      const tol = P.keyTouchAtr * atr[i];
      const key = setup.key.price;
      if (candle.low <= key + tol && candle.high >= key - tol) triggerTouches++;

      // Khoảng cách từ THÂN hộp tới key, tính bằng ATR. 0 = key nằm trong hộp.
      const gap = key >= cluster.obLow && key <= cluster.obHigh
        ? 0
        : Math.min(Math.abs(key - cluster.obLow), Math.abs(key - cluster.obHigh)) / atr[i];
      gaps.push(gap);

      // "Quay về" thật: trong 20 cây TRƯỚC nến chạm, có ít nhất một cây rời hẳn
      // key quá 1 ATR (không cây nào chạm), rồi giá mới về.
      let left = false;
      for (let k = Math.max(0, setup.touchIndex - 20); k < setup.touchIndex; k++) {
        const far = confirm[k].low > key + atr[k] || confirm[k].high < key - atr[k];
        if (far) { left = true; break; }
      }
      if (left) hadLeftKey++;

      setup = null;
    }
  }

  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const inBox = gaps.filter((g) => g === 0).length;

  console.log(`\nCỤM NẾN ĐẢO CHIỀU · ${days} ngày · ${SYMBOLS.length} coin · ngưỡng key ×${P.volumeSpikeMult}\n`);
  console.log(`  tổng cụm được đếm                    ${clusters}`);
  console.log(`  ├─ nến bóp cò CÒN chạm key           ${triggerTouches}  (${pct(triggerTouches, clusters)})`);
  console.log(`  ├─ rơi ĐÚNG nến chạm key (lag 0)     ${sameBar}  (${pct(sameBar, clusters)})`);
  console.log(`  ├─ key nằm TRONG thân hộp            ${inBox}  (${pct(inBox, clusters)})`);
  console.log(`  └─ giá đã RỜI key rồi mới quay về    ${hadLeftKey}  (${pct(hadLeftKey, clusters)})`);
  console.log(`\n  khoảng cách hộp -> key, trung vị     ${med.toFixed(3)} ATR`);
  console.log(`  phân bố độ trễ sau nến chạm key (sweepWaitBars=${P.sweepWaitBars}):`);
  for (let lag = 0; lag <= P.sweepWaitBars; lag++) {
    const n = lagCounts.get(lag) ?? 0;
    console.log(`    lag ${lag}: ${String(n).padStart(5)}  (${pct(n, clusters)})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
