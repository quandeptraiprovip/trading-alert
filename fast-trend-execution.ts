export type FastDirection = "long" | "short";

export interface FastExecutionPositionIntent {
  dir: FastDirection;
  signalEntry: number;
  initialSL: number;
  signalStop: number;
  venueScale?: number;
  positionId?: string;
  protectionId?: string;
}

export interface FastExecutionResult {
  placed: boolean;
  reason?: string;
  qty?: number;
  avgPrice?: number;
  riskUsd?: number;
  equity?: number;
  positionId?: string;
  protectionId?: string;
  venueScale?: number;
  confirmedVenueSl?: number;
}

export interface FastVenuePosition {
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  positionId?: string;
}

export interface FastRecoveredOrder {
  filledQty: number;
  avgPrice: number;
  positionId?: string;
}

export interface FastProtectionResult {
  protectionId: string;
  stopPrice: number;
}

export interface FastExecutionPreflight {
  ok: boolean;
  equity: number;
  warnings: string[];
  errors: string[];
}

/**
 * Boundary used by Fast Trend. It intentionally models strategy actions instead of copying any
 * exchange's low-level order API.
 */
export interface FastExecution {
  readonly venueLabel: string;

  preflight(symbols: string[]): Promise<FastExecutionPreflight>;

  open(
    symbol: string,
    intent: FastExecutionPositionIntent,
    openRiskFrac: number,
    operationKey: string,
    maxRiskFrac: number,
  ): Promise<FastExecutionResult>;

  add(
    symbol: string,
    intent: FastExecutionPositionIntent,
    openRiskFrac: number,
    currentPositionRiskFrac: number,
    operationKey: string,
    maxPositionRiskFrac: number,
  ): Promise<FastExecutionResult>;

  syncStops(symbol: string, intent: FastExecutionPositionIntent): Promise<FastProtectionResult>;
  flatten(symbol: string, dir: FastDirection, operationKey: string): Promise<void>;
  reconcile(symbol: string): Promise<FastVenuePosition>;
  recoverOrder(symbol: string, operationKey: string): Promise<FastRecoveredOrder | null>;
  syncTime(): Promise<void>;

  /**
   * CHỈ ĐỌC, TUỲ CHỌN — giá khớp thật + trượt giá của lần thoát vừa rồi (xem exit-fill-audit.ts).
   * Tuỳ chọn để implementation nào chưa hỗ trợ vẫn hợp lệ; người gọi phải chịu được `undefined`/`null`.
   */
  realizedExit?(
    symbol: string,
    dir: FastDirection,
    assumedExit: number,
    positionId?: number,
    atrNow?: number,
  ): Promise<import("./exit-fill-audit").ExitFillAudit | null>;
}
