import assert from "node:assert/strict";
import {
  FXDreamReviewContext,
  annotateCandidateContext,
  createCandidateFromPlan,
  createEmptyJournal,
  journalReport,
  recordCandidateExecution,
  recordCandidateOutcome,
  reviewCandidate,
  upsertCandidates,
} from "./fxdream-journal";
import { SignalPlan } from "./fxdream-research/strategy-engine-v2";

function plan(): SignalPlan {
  return {
    symbol: "BTCUSDT",
    dir: "long",
    sfpEvent: {
      keyLevel: {
        id: "1h-volume-1000",
        price: 100,
        zoneLow: 98,
        zoneHigh: 102,
        type: "neutral",
        tf: "1h",
        originTime: 1000,
        originIndex: 1,
        volumeRatio: 3.2,
        reactionsCount: 0,
        isConfluent: false,
      },
      dir: "long",
      sweepTime: 2000,
      sweepPrice: 97,
      reclaimPrice: 101,
      confirmTime: 3000,
      confirmClose: 101,
      patternName: "Engulfing",
      obLow: 99,
      obHigh: 101,
    },
    entryPrice: 101,
    initialSL: 96.9,
    targetPrice: 115,
    targetR: 3.4146,
    riskPct: 1,
    createdTime: 3000,
    expiryTime: 4000,
    partialAtR: 2,
    partialFraction: 0,
    estimatedFrictionRate: 0.0009,
  };
}

const completeContext: FXDreamReviewContext = {
  w1d1: "D1 tăng, đang ở discount của campaign",
  h4: "H4 giữ higher low, target là swing high chưa lấy",
  m5: "Có actual OB và cạnh HVN tại vùng entry",
  macro: "Không có veto macro; dữ liệu quan trọng đã qua",
  session: "New York",
  spread: "0.01%, nằm dưới budget của setup",
};

function testStableCandidateAndDedupe(): void {
  const first = createCandidateFromPlan(plan(), 5000, "binance-usdm", "binance-usdm");
  const second = createCandidateFromPlan(plan(), 9000, "binance-usdm", "binance-usdm");
  assert.equal(first.id, second.id, "cùng setup phải có ID ổn định dù scan lại");
  assert.equal(first.review.decision, "pending");
  assert.equal(first.key.type, "neutral");

  const journal = createEmptyJournal(0);
  assert.equal(upsertCandidates(journal, [first, second], 10), 1);
  assert.equal(journal.records.length, 1);
}

function testReviewIsPreCommittedAndImmutable(): void {
  const candidate = createCandidateFromPlan(plan(), 5000, "binance-usdm", "binance-usdm");
  const journal = createEmptyJournal(0);
  upsertCandidates(journal, [candidate], 10);

  assert.throws(
    () => reviewCandidate(journal, candidate.id, {
      decision: "accepted",
      modelId: "FT_SFP",
      executionMode: "confirmation-market",
      reason: "setup đẹp",
      reviewedAt: 20,
    }),
    /context/i,
  );

  annotateCandidateContext(journal, candidate.id, completeContext, 15);
  reviewCandidate(journal, candidate.id, {
    decision: "accepted",
    modelId: "FT_SFP",
    executionMode: "confirmation-market",
    reason: "Đúng model FT-SFP và còn room cấu trúc",
    reviewedAt: 20,
  });
  assert.equal(journal.records[0].review.decision, "accepted");
  assert.equal(journal.records[0].review.modelId, "FT_SFP");
  assert.throws(
    () => reviewCandidate(journal, candidate.id, {
      decision: "rejected",
      modelId: "FT_SFP",
      reason: "đổi ý sau kết quả",
      reviewedAt: 30,
    }),
    /đã được review/i,
  );
  assert.throws(
    () => annotateCandidateContext(journal, candidate.id, completeContext, 30),
    /sau khi review/i,
  );
}

function testExecutionOutcomeAndReport(): void {
  const accepted = createCandidateFromPlan(plan(), 5000, "binance-usdm", "binance-usdm");
  const rejectedPlan = {
    ...plan(),
    symbol: "XRPUSDT",
    createdTime: 6000,
    sfpEvent: {
      ...plan().sfpEvent,
      confirmTime: 6000,
      keyLevel: { ...plan().sfpEvent.keyLevel, id: "1h-volume-2000", originTime: 2000 },
    },
  };
  const rejected = createCandidateFromPlan(
    rejectedPlan,
    7000,
    "binance-usdm",
    "binance-usdm",
  );
  const journal = createEmptyJournal(0);
  upsertCandidates(journal, [accepted, rejected], 10);

  annotateCandidateContext(journal, accepted.id, completeContext, 11);
  reviewCandidate(journal, accepted.id, {
    decision: "accepted",
    modelId: "FT_SFP",
    executionMode: "confirmation-market",
    reason: "đủ checklist",
    reviewedAt: 12,
  });
  recordCandidateExecution(journal, accepted.id, {
    filledAt: 13,
    fillPrice: 101.1,
    feeRate: 0.0005,
    slippageRate: 0.0001,
  });
  recordCandidateOutcome(journal, accepted.id, {
    closedAt: 20,
    exitPrice: 109,
    grossR: 2,
    netR: 1.8,
    mfeR: 2.5,
    maeR: -0.4,
  });

  reviewCandidate(journal, rejected.id, {
    decision: "rejected",
    modelId: "DAILY_TRAP_SFP",
    reason: "H4 không còn room",
    reviewedAt: 12,
  });
  recordCandidateOutcome(journal, rejected.id, {
    closedAt: 20,
    exitPrice: 95,
    grossR: -1,
    netR: -1.2,
    mfeR: 0.2,
    maeR: -1,
  });

  assert.throws(
    () => recordCandidateExecution(journal, rejected.id, {
      filledAt: 13,
      fillPrice: 100,
      feeRate: 0,
      slippageRate: 0,
    }),
    /accepted/i,
  );

  const report = journalReport(journal);
  assert.equal(report.pending, 0);
  assert.equal(report.groups.length, 2);
  const acceptedGroup = report.groups.find((group) => group.decision === "accepted");
  const rejectedGroup = report.groups.find((group) => group.decision === "rejected");
  assert.equal(acceptedGroup?.netR, 1.8);
  assert.equal(acceptedGroup?.expectancy, 1.8);
  assert.equal(rejectedGroup?.netR, -1.2);
}

testStableCandidateAndDedupe();
testReviewIsPreCommittedAndImmutable();
testExecutionOutcomeAndReport();

console.log("FXDream journal tests: OK");
