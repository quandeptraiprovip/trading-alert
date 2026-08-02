/**
 * Offline runner for native small-cap research periods.
 *
 * Usage:
 *   npm run research:smallcap-native -- path/to/point-in-time-periods.json
 *
 * This script reads local data and prints signals/results. It has no exchange
 * credentials, network calls or order-placement path.
 */
import fs from "node:fs";
import {
  AggregateTrade,
  ReversalObservation,
  SMALLCAP_REVERSAL_DEFAULTS,
  SmallCapReversalParams,
  TopOfBook,
  buildSmallCapReversalSignals,
  quotePassiveOrder,
  simulateConservativeMakerFill,
} from "../smallcap-reversal";
import { evaluateSmallCapPeriod } from "../smallcap-research";
import {
  SMALLCAP_SUPPLY_DEFAULTS,
  SmallCapSupplyParams,
  SupplyObservation,
  buildSmallCapSupplySignals,
} from "../smallcap-supply";

type ReversalPeriod = {
  signalTime: number;
  observations: ReversalObservation[];
  params?: Partial<SmallCapReversalParams>;
  forwardReturns?: Record<string, number>;
  books?: Record<string, TopOfBook>;
  trades?: Record<string, AggregateTrade[]>;
  makerTtlMs?: number;
  roundTripCostBps?: number;
};

type SupplyPeriod = {
  observations: SupplyObservation[];
  params?: Partial<SmallCapSupplyParams>;
  forwardReturns?: Record<string, number>;
  roundTripCostBps?: number;
};

type Input = {
  reversalPeriods?: ReversalPeriod[];
  supplyPeriods?: SupplyPeriod[];
};

function compound(netReturns: number[]): number {
  return netReturns.reduce((equity, value) => equity * (1 + value), 1) - 1;
}

function returnMap(values: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(values).map(([symbol, value]) => [symbol.toLowerCase(), value]));
}

function reversalResult(period: ReversalPeriod) {
  const signals = buildSmallCapReversalSignals(period.observations, period.signalTime, {
    ...SMALLCAP_REVERSAL_DEFAULTS,
    ...period.params,
  });
  const fills = signals.map((signal) => {
    const book = period.books?.[signal.symbol];
    if (!book) return { symbol: signal.symbol, status: "missing-book" as const };
    const order = quotePassiveOrder(signal, book, period.makerTtlMs ?? 60_000);
    return {
      symbol: signal.symbol,
      ...simulateConservativeMakerFill(order, period.trades?.[signal.symbol] ?? []),
    };
  });
  const filledSymbols = new Set(
    fills.filter((fill) => fill.status === "filled").map((fill) => fill.symbol),
  );
  const evaluation = period.forwardReturns
    ? evaluateSmallCapPeriod(signals, returnMap(period.forwardReturns), {
      roundTripCostBps: period.roundTripCostBps ?? 10,
      filledSymbols,
    })
    : undefined;
  return { signalTime: period.signalTime, signals, fills, evaluation };
}

function supplyResult(period: SupplyPeriod) {
  const signals = buildSmallCapSupplySignals(period.observations, {
    ...SMALLCAP_SUPPLY_DEFAULTS,
    ...period.params,
  });
  const evaluation = period.forwardReturns
    ? evaluateSmallCapPeriod(signals, returnMap(period.forwardReturns), {
      roundTripCostBps: period.roundTripCostBps ?? 50,
    })
    : undefined;
  return {
    observedAt: period.observations[0]?.observedAt,
    signals,
    evaluation,
  };
}

function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error("Thiếu path tới point-in-time-periods.json");
  const input = JSON.parse(fs.readFileSync(file, "utf8")) as Input;
  const reversal = (input.reversalPeriods ?? []).map(reversalResult);
  const supply = (input.supplyPeriods ?? []).map(supplyResult);
  const reversalReturns = reversal.flatMap((period) => period.evaluation ? [period.evaluation.netReturn] : []);
  const supplyReturns = supply.flatMap((period) => period.evaluation ? [period.evaluation.netReturn] : []);
  console.log(JSON.stringify({
    reversal,
    supply,
    summary: {
      reversalPeriods: reversal.length,
      reversalEvaluated: reversalReturns.length,
      reversalCompoundedReturn: compound(reversalReturns),
      supplyPeriods: supply.length,
      supplyEvaluated: supplyReturns.length,
      supplyCompoundedReturn: compound(supplyReturns),
    },
  }, null, 2));
}

main();
