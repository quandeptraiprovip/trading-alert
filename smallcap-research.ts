/** Shared, research-only portfolio accounting for native small-cap signals. */

export type SmallCapDirection = "long" | "short";

export interface WeightedSmallCapSignal {
  symbol: string;
  direction: SmallCapDirection;
  /** Signed weight: positive for long, negative for short. */
  weight: number;
}

export interface SmallCapPeriodTrade {
  symbol: string;
  direction: SmallCapDirection;
  weight: number;
  assetReturn: number;
  grossContribution: number;
  costContribution: number;
  netContribution: number;
}

export interface SmallCapPeriodResult {
  targetGrossExposure: number;
  grossExposure: number;
  grossReturn: number;
  costReturn: number;
  netReturn: number;
  trades: SmallCapPeriodTrade[];
}

export function evaluateSmallCapPeriod(
  signals: WeightedSmallCapSignal[],
  realizedReturns: Map<string, number>,
  options: { roundTripCostBps: number; filledSymbols?: Set<string> },
): SmallCapPeriodResult {
  if (options.roundTripCostBps < 0) throw new Error("roundTripCostBps không được âm");
  const intended = signals.filter((signal) => Math.abs(signal.weight) > 0);
  for (const signal of intended) {
    const correctSign = signal.direction === "long" ? signal.weight > 0 : signal.weight < 0;
    if (!correctSign) throw new Error(`Weight sai dấu cho ${signal.symbol}`);
  }
  const targetGrossExposure = intended.reduce((sum, signal) => sum + Math.abs(signal.weight), 0);
  const usable = intended.filter((signal) => !options.filledSymbols
    || options.filledSymbols.has(signal.symbol));
  for (const signal of usable) {
    if (!Number.isFinite(realizedReturns.get(signal.symbol))) {
      throw new Error(`Thiếu realized return cho ${signal.symbol}`);
    }
  }
  const grossExposure = usable.reduce((sum, signal) => sum + Math.abs(signal.weight), 0);
  if (!(targetGrossExposure > 0) || !(grossExposure > 0)) {
    return {
      targetGrossExposure,
      grossExposure: 0,
      grossReturn: 0,
      costReturn: 0,
      netReturn: 0,
      trades: [],
    };
  }

  const costFraction = options.roundTripCostBps / 10_000;
  const trades = usable.map((signal): SmallCapPeriodTrade => {
    const assetReturn = realizedReturns.get(signal.symbol)!;
    const normalizedWeight = signal.weight / targetGrossExposure;
    const grossContribution = normalizedWeight * assetReturn;
    const costContribution = Math.abs(normalizedWeight) * costFraction;
    return {
      symbol: signal.symbol,
      direction: signal.direction,
      weight: normalizedWeight,
      assetReturn,
      grossContribution,
      costContribution,
      netContribution: grossContribution - costContribution,
    };
  });
  const grossReturn = trades.reduce((sum, trade) => sum + trade.grossContribution, 0);
  const costReturn = trades.reduce((sum, trade) => sum + trade.costContribution, 0);
  return {
    targetGrossExposure,
    grossExposure,
    grossReturn,
    costReturn,
    netReturn: grossReturn - costReturn,
    trades,
  };
}
