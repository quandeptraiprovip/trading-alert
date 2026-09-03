/**
 * Chẩn đoán các giả định tự suy diễn trong bản số hoá Key Volume.
 *
 * Run:
 *   npx ts-node scripts/key-volume-ablation.ts [days] [symbols] [riskPct]
 */
import "../load-env";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeDiagnostics,
  KeyVolumeParams,
  KeyVolumeResult,
  KeyVolumeTrade,
  runKeyVolume,
} from "../key-volume";
import { applyLeverageCap } from "../key-volume-backtest";
import { fetchKlinesPaged } from "../kline-fetch";
import { CONFIG, Candle, TF_MS, aggregate } from "../strategy";

type Variant = {
  name: string;
  overrides: Partial<KeyVolumeParams>;
};

const WARMUP_DAYS = 120;

function summarize(trades: KeyVolumeTrade[], start: number, end: number): string {
  const selected = trades.filter((trade) => trade.entryTime >= start && trade.entryTime < end);
  const gross = selected.reduce((sum, trade) => sum + trade.grossR, 0);
  const cost = selected.reduce((sum, trade) => sum + trade.costR, 0);
  const exits = new Map<string, number>();
  for (const trade of selected) {
    exits.set(trade.exitReason, (exits.get(trade.exitReason) ?? 0) + 1);
  }
  return [
    `N=${selected.length}`,
    `gross=${gross >= 0 ? "+" : ""}${gross.toFixed(2)}R`,
    `cost=-${cost.toFixed(2)}R`,
    `net=${gross - cost >= 0 ? "+" : ""}${(gross - cost).toFixed(2)}R`,
    `exits=${[...exits].map(([reason, count]) => `${reason}:${count}`).join(",") || "none"}`,
  ].join(" · ");
}

function frequencyDetail(
  results: KeyVolumeResult[],
  start: number,
  end: number,
  symbolCount: number,
): string {
  const selected = results.flatMap((result) =>
    result.trades.filter((trade) => trade.entryTime >= start && trade.entryTime < end),
  );
  const days = (end - start) / TF_MS["1d"];
  const diagnostics = results.reduce<KeyVolumeDiagnostics>(
    (sum, result) => {
      for (const key of Object.keys(sum) as Array<keyof KeyVolumeDiagnostics>) {
        sum[key] += result.diagnostics[key];
      }
      return sum;
    },
    {
      m15Levels: 0,
      h1Levels: 0,
      h4Levels: 0,
      confluentTouches: 0,
      touchVolumeConfirmed: 0,
      sweeps: 0,
      firstBos: 0,
      secondBos: 0,
      profileAccepted: 0,
      plans: 0,
      entries: 0,
      rejectedRisk: 0,
      rejectedRoom: 0,
    },
  );
  return [
    `N/day basket=${(selected.length / days).toFixed(3)}`,
    `N/week/symbol=${(selected.length * 7 / days / symbolCount).toFixed(3)}`,
    `touch=${diagnostics.keyTouches}`,
    `volume=${diagnostics.touchVolumeConfirmed}`,
    `sweep=${diagnostics.sweeps}`,
    `nến đảo=${diagnostics.candlePatterns}`,
    `plan=${diagnostics.plans} (quét ${diagnostics.sweepBranchPlans}/vol ${diagnostics.volumeBranchPlans})`,
    `entry=${diagnostics.entries}`,
    `reject risk/room=${diagnostics.rejectedRisk}/${diagnostics.rejectedRoom}`,
  ].join(" · ");
}

function payoffDetail(trades: KeyVolumeTrade[], start: number, end: number): string {
  const selected = trades.filter((trade) => trade.entryTime >= start && trade.entryTime < end);
  const winners = selected.filter((trade) => trade.grossR > 0);
  const failures = selected.filter((trade) => trade.grossR <= 0);
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const avgGrossWin = average(winners.map((trade) => trade.grossR));
  const avgGrossFail = Math.abs(average(failures.map((trade) => trade.grossR)));
  const avgNetWin = average(winners.map((trade) => trade.netR));
  const avgNetFail = Math.abs(average(failures.map((trade) => trade.netR)));
  const allInR = (trade: KeyVolumeTrade) => trade.netR / (1 + trade.costR);
  const avgAllInWin = average(winners.map(allInR));
  const avgAllInFail = Math.abs(average(failures.map(allInR)));
  const targetRewards = selected
    .filter((trade) => trade.exitReason === "target")
    .map((trade) => trade.grossR)
    .sort((a, b) => a - b);
  const stopFailures = selected
    .filter((trade) => trade.exitReason === "stop")
    .map((trade) => trade.grossR)
    .sort((a, b) => a - b);
  const costs = selected.map((trade) => trade.costR).sort((a, b) => a - b);
  const median = (values: number[]) =>
    values.length ? values[Math.floor(values.length / 2)] : 0;
  return [
    `gross avg reward/fail=${avgGrossWin.toFixed(2)}R/${avgGrossFail.toFixed(2)}R`
      + ` (${avgGrossFail > 0 ? (avgGrossWin / avgGrossFail).toFixed(2) : "n/a"}x)`,
    `net avg reward/fail=${avgNetWin.toFixed(2)}R/${avgNetFail.toFixed(2)}R`
      + ` (${avgNetFail > 0 ? (avgNetWin / avgNetFail).toFixed(2) : "n/a"}x)`,
    `all-in-risk reward/fail=${avgAllInWin.toFixed(2)}R/${avgAllInFail.toFixed(2)}R`
      + ` (${avgAllInFail > 0 ? (avgAllInWin / avgAllInFail).toFixed(2) : "n/a"}x)`,
    `target gross range=${targetRewards[0]?.toFixed(2) ?? "n/a"}R`
      + `..${targetRewards.at(-1)?.toFixed(2) ?? "n/a"}R`,
    `stop gross range=${stopFailures[0]?.toFixed(2) ?? "n/a"}R`
      + `..${stopFailures.at(-1)?.toFixed(2) ?? "n/a"}R`,
    `cost median/max=${median(costs).toFixed(2)}R/${(costs.at(-1) ?? 0).toFixed(2)}R`,
  ].join(" · ");
}

async function main(): Promise<void> {
  const days = parseInt(process.argv[2] ?? "500", 10);
  const riskPct = parseFloat(process.argv[4] ?? "1");
  const maxLeverage = parseFloat(process.env.LEVERAGE ?? "10");
  const symbols = (process.argv[3]?.split(",") ?? CONFIG.symbols)
    .map((symbol) => symbol.trim().toLowerCase())
    .filter(Boolean);
  const totalBars = Math.ceil((days + WARMUP_DAYS) * TF_MS["1d"] / TF_MS["5m"]) + 12;
  const baseBySymbol = new Map<string, Candle[]>();

  for (const symbol of symbols) {
    const candles = (await fetchKlinesPaged(symbol, "5m", totalBars))
      .filter((candle) => candle.openTime + TF_MS["5m"] <= Date.now());
    if (candles.length >= totalBars * 0.8) baseBySymbol.set(symbol, candles);
  }
  if (!baseBySymbol.size) throw new Error("Không có symbol đủ dữ liệu");
  if (!(riskPct > 0) || !(maxLeverage > 0)) {
    throw new Error("riskPct và LEVERAGE phải > 0");
  }

  const periodEnd = Math.min(
    ...[...baseBySymbol.values()].map(
      (candles) => candles[candles.length - 1].openTime + TF_MS["5m"],
    ),
  );
  const periodStart = periodEnd - days * TF_MS["1d"];
  const variants: Variant[] = [
    { name: "source-default", overrides: {} },
    {
      name: "trigger-volume-2x",
      overrides: { touchVolumeSpikeMult: 2 },
    },
    {
      name: "key-volume-3x",
      overrides: { volumeSpikeMult: 3 },
    },
    {
      name: "key-volume-4x",
      overrides: { volumeSpikeMult: 4 },
    },
    {
      name: "one-historical-reaction",
      overrides: { minKeyReactions: 1 },
    },
    {
      name: "two-historical-reactions",
      overrides: { minKeyReactions: 2 },
    },
    {
      name: "three-historical-reactions",
      overrides: { minKeyReactions: 3 },
    },
    {
      name: "stop-at-key",
      overrides: { stopMode: "key" },
    },
    {
      name: "no-room-gate",
      overrides: { minRR: 0 },
    },
    {
      name: "legacy-target+partial",
      overrides: {
        targetMode: "capped-r",
        partialFraction: 0.5,
      },
    },
    {
      name: "stop-at-pattern",
      overrides: { stopMode: "confirmation" },
    },
    {
      name: "trigger-volume-1.5x",
      overrides: { touchVolumeSpikeMult: 1.5 },
    },
    {
      name: "sweep-branch-only",
      overrides: { enableVolumeReversalBranch: false },
    },
    {
      name: "volume-branch-only",
      overrides: { enableSweepBranch: false },
    },
    {
      name: "single-use-key",
      overrides: { allowKeyReentry: false },
    },
    {
      name: "reversal-volume-2x",
      overrides: {
        reversalVolumeMult: 2,
      },
    },
    {
      name: "sweep-wait-4h",
      overrides: { sweepWaitBars: 16 },
    },
    {
      name: "key-age-90d",
      overrides: { keyMaxAgeDays: 90 },
    },
    {
      name: "key-touch-0.5atr",
      overrides: { keyTouchAtr: 0.5 },
    },
    {
      name: "no-cooldown",
      overrides: { cooldownBars: 0 },
    },
    {
      name: "sweep-window-2d",
      overrides: { sweepLookback: 192 },
    },
    {
      name: "key-window-24",
      overrides: { volumeLookback: 24 },
    },
  ];

  for (const variant of variants) {
    const params: KeyVolumeParams = { ...KEY_VOLUME_CONFIG, ...variant.overrides };
    const results = [...baseBySymbol].map(([symbol, candles]) =>
      runKeyVolume(symbol, aggregate(candles, "15m", "5m"), params),
    );
    const rawTrades = results.flatMap((result) => result.trades);
    const trades = rawTrades.map(
      (trade) => applyLeverageCap(trade, riskPct, maxLeverage),
    );
    console.log(`${variant.name.padEnd(27)} ${summarize(trades, periodStart, periodEnd)}`);
    if (variant.name === "source-default") {
      console.log(`${"price-R payoff".padEnd(27)} ${payoffDetail(rawTrades, periodStart, periodEnd)}`);
      console.log(
        `${`execution ${maxLeverage}x`.padEnd(27)} risk=${riskPct}%/lệnh`,
      );
      console.log(
        `${"frequency audit".padEnd(27)} `
        + frequencyDetail(results, periodStart, periodEnd, baseBySymbol.size),
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
