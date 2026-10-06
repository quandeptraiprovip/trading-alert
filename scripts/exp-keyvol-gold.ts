/**
 * FX Dream (key-volume.ts) trên VÀNG Binance XAUUSDT (TradFi perpetual, mở 12/2025).
 *
 * Câu hỏi (user 06/10/26): thêm vàng vào bot FX Dream có đáng không? Engine giữ NGUYÊN
 * cấu hình live; so cùng cửa sổ thời gian với BTCUSDT.
 *
 * Binance cho giao dịch XAUUSDT cả cuối tuần nhưng thị trường vàng thật đóng
 * (Fri 17:00 → Sun 18:00 giờ New York). Bot sẽ KHÔNG xét tín hiệu vàng trong khung đó,
 * nên lệnh vào trong khung được tách riêng. Lọc sau-khi-chạy là xấp xỉ: engine giữ
 * một vị thế mỗi lúc, nên bỏ một lệnh cuối tuần có thể mở chỗ cho lệnh khác.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-gold.ts
 */
import { KEY_VOLUME_CONFIG, KeyVolumeTrade, runKeyVolume } from "../key-volume";
import { fetchFuturesKlinesPaged } from "../kline-fetch";
import { goldClosedNy } from "../market-hours";

const XAU_LISTED = Date.UTC(2025, 11, 11, 8, 0);
const BARS = 32_000;

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function bootstrapCi(xs: number[], seed = 20261006): [number, number] {
  if (!xs.length) return [NaN, NaN];
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const means: number[] = [];
  for (let b = 0; b < 4000; b++) {
    let t = 0;
    for (let i = 0; i < xs.length; i++) t += xs[Math.floor(rnd() * xs.length)];
    means.push(t);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * means.length)], means[Math.floor(0.975 * means.length)]];
}

function line(label: string, ts: KeyVolumeTrade[]): string {
  const g = ts.map((t) => t.grossR);
  const n = ts.map((t) => t.netR);
  const wins = ts.filter((t) => t.grossR > 0).length;
  const [lo, hi] = bootstrapCi(n);
  const avgCost = ts.length ? sum(ts.map((t) => t.costR)) / ts.length : 0;
  return `${label.padEnd(28)} ${String(ts.length).padStart(4)} lệnh · thắng ${ts.length ? ((100 * wins) / ts.length).toFixed(0) : "–"}%`
    + ` · gross ${sum(g).toFixed(1).padStart(6)}R · net ${sum(n).toFixed(1).padStart(6)}R`
    + ` (95% CI ${lo.toFixed(1)}…${hi.toFixed(1)}) · phí TB ${avgCost.toFixed(3)}R/lệnh`;
}

/** dropClosed: xoá hẳn nến lúc vàng đóng cửa trước khi đưa vào engine (như dữ liệu FX). */
async function runOne(symbol: string, dropClosed = false): Promise<KeyVolumeTrade[]> {
  const raw = await fetchFuturesKlinesPaged(symbol, "15m", BARS);
  const c = raw.filter((k) => k.openTime >= XAU_LISTED - 8 * 86_400_000 && !(dropClosed && goldClosedNy(k.openTime)));
  const res = runKeyVolume(symbol, c, KEY_VOLUME_CONFIG);
  console.log(`${symbol.toUpperCase()}: ${c.length} nến M15 từ ${new Date(c[0].openTime).toISOString().slice(0, 10)}`
    + ` · key chín ${res.diagnostics.keysMatured}${res.openTrade ? " · còn 1 lệnh mở (không tính)" : ""}`);
  return res.trades.filter((t) => t.entryTime >= XAU_LISTED + 7 * 86_400_000);
}

async function main(): Promise<void> {
  const xau = await runOne("xauusdt");
  const xauDropped = await runOne("xauusdt", true);
  const btc = await runOne("btcusdt");

  console.log("\n── Cùng cửa sổ, cấu hình live, phí taker 0,05% + trượt 0,02% mỗi chiều ──");
  console.log(line("BTCUSDT (tham chiếu)", btc));
  console.log(line("XAUUSDT tất cả", xau));
  const open = xau.filter((t) => !goldClosedNy(t.entryTime));
  console.log(line("XAUUSDT bỏ cuối tuần", open));
  console.log(line("XAUUSDT chỉ cuối tuần", xau.filter((t) => goldClosedNy(t.entryTime))));
  console.log(line("XAUUSDT XOÁ NẾN cuối tuần", xauDropped));

  console.log("\n── XAUUSDT xoá nến cuối tuần, theo nhánh ──");
  for (const br of [...new Set(xauDropped.map((t) => t.branch))].sort()) {
    console.log(line(br, xauDropped.filter((t) => t.branch === br)));
  }
  console.log("\n── XAUUSDT xoá nến cuối tuần, hai nửa thời gian ──");
  const midD = xauDropped.length ? xauDropped[Math.floor(xauDropped.length / 2)].entryTime : 0;
  console.log(line(`trước ${new Date(midD).toISOString().slice(0, 10)}`, xauDropped.filter((t) => t.entryTime < midD)));
  console.log(line("sau", xauDropped.filter((t) => t.entryTime >= midD)));

  console.log("\n── XAUUSDT (bỏ cuối tuần) theo nhánh ──");
  for (const br of [...new Set(open.map((t) => t.branch))].sort()) {
    console.log(line(br, open.filter((t) => t.branch === br)));
  }

  console.log("\n── XAUUSDT (bỏ cuối tuần) hai nửa thời gian ──");
  const mid = open.length ? open[Math.floor(open.length / 2)].entryTime : 0;
  console.log(line(`trước ${new Date(mid).toISOString().slice(0, 10)}`, open.filter((t) => t.entryTime < mid)));
  console.log(line("sau", open.filter((t) => t.entryTime >= mid)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
