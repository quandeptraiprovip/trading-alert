import fs from "node:fs";
import path from "node:path";
import { SignalPlan } from "./fxdream-research/strategy-engine-v2";

export const FXDREAM_MODEL_IDS = [
  "FT_SFP",
  "FT_BOS",
  "DAILY_TRAP_SFP",
  "OB_HVN",
  "BREAKOUT_RETEST",
] as const;

export type FXDreamModelId = typeof FXDREAM_MODEL_IDS[number];
export type FXDreamReviewDecision = "pending" | "accepted" | "rejected" | "missed";
export type FXDreamExecutionMode = "confirmation-market" | "ob-limit";

export interface FXDreamReviewContext {
  w1d1: string;
  h4: string;
  m5: string;
  macro: string;
  session: string;
  spread: string;
}

export interface FXDreamCandidateRecord {
  id: string;
  detectedAt: number;
  symbol: string;
  venue: string;
  feed: string;
  suggestedModelId: FXDreamModelId;
  direction: "long" | "short";
  key: {
    id: string;
    type: "neutral" | "demand" | "supply";
    tf: "1h" | "4h";
    point: number;
    zoneLow: number;
    zoneHigh: number;
    originTime: number;
    volumeRatio: number;
  };
  trigger: {
    type: string;
    sweepTime: number;
    confirmTime: number;
    confirmPrice: number;
  };
  proposed: {
    entryPrice: number;
    initialSL: number;
    targetPrice: number;
    targetR: number;
    riskPct: number;
    estimatedFrictionRate: number;
  };
  context?: FXDreamReviewContext;
  review: {
    decision: FXDreamReviewDecision;
    reviewedAt?: number;
    modelId?: FXDreamModelId;
    executionMode?: FXDreamExecutionMode;
    reason?: string;
  };
  execution?: {
    filledAt: number;
    fillPrice: number;
    feeRate: number;
    slippageRate: number;
  };
  outcome?: {
    closedAt: number;
    exitPrice: number;
    grossR: number;
    netR: number;
    mfeR: number;
    maeR: number;
  };
}

export interface FXDreamJournal {
  version: 1;
  updatedAt: number;
  records: FXDreamCandidateRecord[];
}

export interface FXDreamReviewInput {
  decision: Exclude<FXDreamReviewDecision, "pending">;
  modelId: FXDreamModelId;
  executionMode?: FXDreamExecutionMode;
  reason: string;
  reviewedAt: number;
}

export interface FXDreamExecutionInput {
  filledAt: number;
  fillPrice: number;
  feeRate: number;
  slippageRate: number;
}

export interface FXDreamOutcomeInput {
  closedAt: number;
  exitPrice: number;
  grossR: number;
  netR: number;
  mfeR: number;
  maeR: number;
}

export interface FXDreamJournalReportGroup {
  decision: Exclude<FXDreamReviewDecision, "pending">;
  modelId: FXDreamModelId;
  candidates: number;
  outcomes: number;
  grossR: number;
  netR: number;
  expectancy: number;
  profitFactor: number;
  averageMfeR: number;
  averageMaeR: number;
}

export interface FXDreamJournalReport {
  total: number;
  pending: number;
  groups: FXDreamJournalReportGroup[];
}

const CONTEXT_FIELDS: Array<keyof FXDreamReviewContext> = [
  "w1d1",
  "h4",
  "m5",
  "macro",
  "session",
  "spread",
];

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} phải là số hữu hạn`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (!(value > 0)) throw new Error(`${label} phải > 0`);
}

function findRecord(journal: FXDreamJournal, id: string): FXDreamCandidateRecord {
  const record = journal.records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Không tìm thấy candidate ${id}`);
  return record;
}

function assertCompleteContext(context: FXDreamReviewContext | undefined): void {
  if (!context) throw new Error("Thiếu context trước khi accept candidate");
  for (const field of CONTEXT_FIELDS) {
    if (!context[field].trim()) throw new Error(`Context thiếu trường ${field}`);
  }
}

function candidateId(plan: SignalPlan): string {
  return [
    "FXD",
    plan.symbol.toUpperCase(),
    plan.dir,
    plan.createdTime,
    plan.sfpEvent.keyLevel.originTime,
  ].join("-");
}

export function createEmptyJournal(now = Date.now()): FXDreamJournal {
  return { version: 1, updatedAt: now, records: [] };
}

export function createCandidateFromPlan(
  plan: SignalPlan,
  detectedAt = Date.now(),
  venue = "binance-usdm",
  feed = "binance-usdm",
): FXDreamCandidateRecord {
  const key = plan.sfpEvent.keyLevel;
  return {
    id: candidateId(plan),
    detectedAt,
    symbol: plan.symbol.toUpperCase(),
    venue,
    feed,
    // Scanner V2 hiện arm bằng Daily trap; reviewer vẫn phải xác nhận model.
    suggestedModelId: "DAILY_TRAP_SFP",
    direction: plan.dir,
    key: {
      id: key.id,
      type: key.type,
      tf: key.tf,
      point: key.price,
      zoneLow: Math.min(key.zoneLow ?? key.price, key.zoneHigh ?? key.price),
      zoneHigh: Math.max(key.zoneLow ?? key.price, key.zoneHigh ?? key.price),
      originTime: key.originTime,
      volumeRatio: key.volumeRatio,
    },
    trigger: {
      type: plan.sfpEvent.patternName,
      sweepTime: plan.sfpEvent.sweepTime,
      confirmTime: plan.sfpEvent.confirmTime,
      confirmPrice: plan.sfpEvent.confirmClose,
    },
    proposed: {
      entryPrice: plan.entryPrice,
      initialSL: plan.initialSL,
      targetPrice: plan.targetPrice,
      targetR: plan.targetR,
      riskPct: plan.riskPct,
      estimatedFrictionRate: plan.estimatedFrictionRate,
    },
    review: { decision: "pending" },
  };
}

export function upsertCandidates(
  journal: FXDreamJournal,
  candidates: FXDreamCandidateRecord[],
  now = Date.now(),
): number {
  const known = new Set(journal.records.map((record) => record.id));
  let added = 0;
  for (const candidate of candidates) {
    if (known.has(candidate.id)) continue;
    journal.records.push(candidate);
    known.add(candidate.id);
    added++;
  }
  if (added) journal.updatedAt = now;
  return added;
}

export function annotateCandidateContext(
  journal: FXDreamJournal,
  id: string,
  context: FXDreamReviewContext,
  now = Date.now(),
): void {
  const record = findRecord(journal, id);
  if (record.review.decision !== "pending") {
    throw new Error("Không được sửa context sau khi review");
  }
  const normalized = Object.fromEntries(
    CONTEXT_FIELDS.map((field) => [field, context[field]?.trim() ?? ""]),
  ) as unknown as FXDreamReviewContext;
  record.context = normalized;
  journal.updatedAt = now;
}

export function reviewCandidate(
  journal: FXDreamJournal,
  id: string,
  input: FXDreamReviewInput,
): void {
  const record = findRecord(journal, id);
  if (record.review.decision !== "pending") {
    throw new Error(`Candidate ${id} đã được review; quyết định là bất biến`);
  }
  if (!FXDREAM_MODEL_IDS.includes(input.modelId)) throw new Error("Model ID không hợp lệ");
  if (!input.reason.trim()) throw new Error("Review phải có lý do");
  requirePositive(input.reviewedAt, "reviewedAt");
  if (input.decision === "accepted") {
    assertCompleteContext(record.context);
    if (!input.executionMode) throw new Error("Accepted candidate phải chọn execution mode");
  }
  record.review = {
    decision: input.decision,
    reviewedAt: input.reviewedAt,
    modelId: input.modelId,
    executionMode: input.executionMode,
    reason: input.reason.trim(),
  };
  journal.updatedAt = input.reviewedAt;
}

export function recordCandidateExecution(
  journal: FXDreamJournal,
  id: string,
  input: FXDreamExecutionInput,
): void {
  const record = findRecord(journal, id);
  if (record.review.decision !== "accepted") {
    throw new Error("Chỉ candidate accepted mới được ghi execution thật");
  }
  if (record.execution) throw new Error("Execution đã được ghi; không được overwrite");
  requirePositive(input.filledAt, "filledAt");
  requirePositive(input.fillPrice, "fillPrice");
  requireFinite(input.feeRate, "feeRate");
  requireFinite(input.slippageRate, "slippageRate");
  if (input.feeRate < 0 || input.slippageRate < 0) {
    throw new Error("Fee và slippage không được âm");
  }
  record.execution = { ...input };
  journal.updatedAt = input.filledAt;
}

export function recordCandidateOutcome(
  journal: FXDreamJournal,
  id: string,
  input: FXDreamOutcomeInput,
): void {
  const record = findRecord(journal, id);
  if (record.review.decision === "pending") {
    throw new Error("Phải review trước khi ghi outcome để tránh hindsight");
  }
  if (record.outcome) throw new Error("Outcome đã được ghi; không được overwrite");
  requirePositive(input.closedAt, "closedAt");
  requirePositive(input.exitPrice, "exitPrice");
  requireFinite(input.grossR, "grossR");
  requireFinite(input.netR, "netR");
  requireFinite(input.mfeR, "mfeR");
  requireFinite(input.maeR, "maeR");
  record.outcome = { ...input };
  journal.updatedAt = input.closedAt;
}

export function journalReport(journal: FXDreamJournal): FXDreamJournalReport {
  const groups = new Map<string, FXDreamCandidateRecord[]>();
  for (const record of journal.records) {
    if (record.review.decision === "pending" || !record.review.modelId) continue;
    const key = `${record.review.decision}:${record.review.modelId}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }

  const reportGroups: FXDreamJournalReportGroup[] = [...groups.values()].map((records) => {
    const outcomes = records.flatMap((record) => record.outcome ? [record.outcome] : []);
    const grossR = outcomes.reduce((sum, outcome) => sum + outcome.grossR, 0);
    const netR = outcomes.reduce((sum, outcome) => sum + outcome.netR, 0);
    const gains = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.netR), 0);
    const losses = Math.abs(
      outcomes.reduce((sum, outcome) => sum + Math.min(0, outcome.netR), 0),
    );
    return {
      decision: records[0].review.decision as Exclude<FXDreamReviewDecision, "pending">,
      modelId: records[0].review.modelId!,
      candidates: records.length,
      outcomes: outcomes.length,
      grossR,
      netR,
      expectancy: outcomes.length ? netR / outcomes.length : 0,
      profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : 0,
      averageMfeR: outcomes.length
        ? outcomes.reduce((sum, outcome) => sum + outcome.mfeR, 0) / outcomes.length
        : 0,
      averageMaeR: outcomes.length
        ? outcomes.reduce((sum, outcome) => sum + outcome.maeR, 0) / outcomes.length
        : 0,
    };
  });
  reportGroups.sort((a, b) =>
    a.modelId.localeCompare(b.modelId) || a.decision.localeCompare(b.decision),
  );
  return {
    total: journal.records.length,
    pending: journal.records.filter((record) => record.review.decision === "pending").length,
    groups: reportGroups,
  };
}

export function loadFXDreamJournal(filePath: string, now = Date.now()): FXDreamJournal {
  if (!fs.existsSync(filePath)) return createEmptyJournal(now);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as FXDreamJournal;
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Journal không đúng schema version 1: ${filePath}`);
  }
  return parsed;
}

export function saveFXDreamJournal(
  filePath: string,
  journal: FXDreamJournal,
  now = Date.now(),
): void {
  journal.updatedAt = now;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}
