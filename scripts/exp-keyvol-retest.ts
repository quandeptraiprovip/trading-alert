/**
 * Đo PHỄU của key-volume.ts trên nến M15 thật, để so sánh TRƯỚC/SAU khi đổi
 * luật vào lệnh (lệnh chờ ở mép hộp -> retest + nến bật ra khỏi hộp).
 *
 * In ba khối:
 *   1. MẬT ĐỘ KEY  — key/ngày/coin, và mốc người (user vẽ ~1 mức / 10 ngày).
 *   2. PHỄU        — key -> chạm -> cụm nến -> qua cửa rời hộp -> vào lệnh.
 *   3. KẾT QUẢ     — số lệnh, win rate, gross/net R.
 *
 * Chạy: npx ts-node scripts/exp-keyvol-retest.ts [days] [symbols...]
 */
import { KEY_VOLUME_CONFIG, KeyVolumeParams, runKeyVolume } from "../key-volume";
import { fetchKlinesPaged } from "../kline-fetch";
import { TF_MS } from "../strategy";

const DEFAULT_SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "adausdt"];
const WARMUP_BARS = 480 + 96 + 200;

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
  const symbols = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_SYMBOLS;
  const bars = Math.ceil(days * TF_MS["1d"] / TF_MS["15m"]) + WARMUP_BARS;
  const params: KeyVolumeParams = KEY_VOLUME_CONFIG;

  console.log(`\nCẤU HÌNH: obDepartMode=${params.obDepartMode} obDepartBars=${params.obDepartBars}`
    + ` volumeSpikeMult=${params.volumeSpikeMult} volumeLookback=${params.volumeLookback}`
    + ` boxWaitBars=${params.boxWaitBars}`);
  console.log(`KHOẢNG: ${days} ngày M15, ${symbols.length} coin\n`);

  let keys = 0, touches = 0, clusters = 0, rejDepart = 0;
  let rejNoDepart = 0, rejKeyOutside = 0;
  let armed = 0, retouched = 0, broken = 0, expired = 0, unresolved = 0;
  let entries = 0, trades = 0, wins = 0, gross = 0, net = 0, costs = 0;
  const stopPcts: number[] = [];
  const exitReasons = new Map<string, number>();
  const byBranch = new Map<string, number>();
  const byBranchR = new Map<string, number>();
  const holdBars: number[] = [];
  let sweepPlans = 0, volPlans = 0, rejRoom = 0, rejRisk = 0;

  for (const symbol of symbols) {
    const m15 = await fetchKlinesPaged(symbol, "15m", bars);
    const result = runKeyVolume(symbol, m15, params);
    const d = result.diagnostics;
    const spanDays = (m15[m15.length - 1].openTime - m15[0].openTime) / TF_MS["1d"];
    const keysPerDay = d.m15Levels / spanDays;
    const symNet = result.trades.reduce((sum, t) => sum + t.netR, 0);

    console.log(
      `${symbol.padEnd(9)} key ${String(d.m15Levels).padStart(6)}`
      + ` (${keysPerDay.toFixed(1)}/ngày)`
      + ` · chạm ${String(d.keyTouches).padStart(5)}`
      + ` · cụm ${String(d.candlePatterns).padStart(4)}`
      + ` · rớt rời-hộp ${String(d.rejectedDepart).padStart(4)}`
      + ` · kế hoạch ${String(d.plans).padStart(4)}`
      + ` · vào ${String(d.entries).padStart(4)}`
      + ` · netR ${symNet.toFixed(1)}`,
    );

    keys += d.m15Levels; touches += d.keyTouches; clusters += d.candlePatterns;
    rejNoDepart += d.rejectedNoDeparture; rejKeyOutside += d.rejectedKeyOutsideBlock;
    rejDepart += d.rejectedDepart; entries += d.entries;
    armed += d.boxesArmed; retouched += d.boxesRetouched;
    broken += d.boxesBroken; expired += d.boxesExpired;
    unresolved += d.boxesUnresolved;
    sweepPlans += d.sweepBranchPlans; volPlans += d.volumeBranchPlans;
    rejRoom += d.rejectedRoom; rejRisk += d.rejectedRisk;
    trades += result.trades.length;
    wins += result.trades.filter((t) => t.netR > 0).length;
    gross += result.trades.reduce((sum, t) => sum + t.grossR, 0);
    costs += result.trades.reduce((sum, t) => sum + t.costR, 0);
    for (const t of result.trades) {
      stopPcts.push(100 * Math.abs(t.entryPrice - t.initialSL) / t.entryPrice);
      holdBars.push(t.holdBars);
      exitReasons.set(t.exitReason, (exitReasons.get(t.exitReason) ?? 0) + 1);
      byBranch.set(t.branch, (byBranch.get(t.branch) ?? 0) + 1);
      byBranchR.set(t.branch, (byBranchR.get(t.branch) ?? 0) + t.grossR);
    }
    net += symNet;
  }

  console.log(`\nPHỄU CỘNG DỒN (${symbols.length} coin)`);
  console.log(`  key phát hiện        ${keys}`);
  console.log(`  nến chạm key         ${touches}`);
  console.log(`  bỏ: chưa RỜI key     ${rejNoDepart}`);
  console.log(`  bỏ: key NGOÀI hộp    ${rejKeyOutside}`);
  console.log(`  cụm HỢP LỆ           ${clusters}`);
  console.log(`  rớt cửa RỜI HỘP      ${rejDepart}`);
  console.log(`  kế hoạch: quét ${sweepPlans} + key ${volPlans}`);
  console.log(`  rớt dư địa ${rejRoom} · rớt risk ${rejRisk}`);
  console.log(`  hộp TRANG BỊ         ${armed}   (kế hoạch bị hộp khác chiếm chỗ: ${sweepPlans + volPlans - armed})`);
  console.log(`  hộp thấy giá QUAY LẠI ${retouched}`);
  console.log(`  hộp bị PHÁ            ${broken}`);
  console.log(`  hộp HẾT HẠN canh      ${expired}   (${params.boxWaitBars} nến = ${params.boxWaitBars / 96} ngày)`);
  console.log(`  hộp còn TREO cuối kỳ  ${unresolved}`);
  console.log(`  VÀO LỆNH             ${entries}`);
  const med = (xs: number[]) => {
    if (!xs.length) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  console.log(`\nKẾT QUẢ  ${trades} lệnh · WR ${trades ? (100 * wins / trades).toFixed(1) : "0.0"}%`
    + ` · gross ${gross.toFixed(1)}R · net ${net.toFixed(1)}R`);
  console.log(`  chi phí ${trades ? (costs / trades).toFixed(3) : "0"} R/lệnh`
    + ` · SL trung vị ${med(stopPcts).toFixed(3)}% giá`
    + ` · giữ trung vị ${med(holdBars)} nến M15`);
  console.log(`  theo nhánh: quét ${byBranch.get("sweep-reclaim") ?? 0} lệnh (${(byBranchR.get("sweep-reclaim") ?? 0).toFixed(1)}R gross)`
    + ` · key+nến ${byBranch.get("volume-reversal") ?? 0} lệnh (${(byBranchR.get("volume-reversal") ?? 0).toFixed(1)}R gross)`);
  console.log("  lý do thoát: "
    + [...exitReasons.entries()].sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ${n}`).join(" · "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
