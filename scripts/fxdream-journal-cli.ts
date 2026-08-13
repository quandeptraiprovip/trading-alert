import path from "node:path";
import "../load-env";
import {
  FXDREAM_MODEL_IDS,
  FXDreamExecutionMode,
  FXDreamModelId,
  FXDreamReviewContext,
  annotateCandidateContext,
  createCandidateFromPlan,
  journalReport,
  loadFXDreamJournal,
  recordCandidateExecution,
  recordCandidateOutcome,
  reviewCandidate,
  saveFXDreamJournal,
  upsertCandidates,
} from "../fxdream-journal";
import { scanFXDreamResearchCandidatesForSymbol } from "../fxdream-alert";

const journalPath = path.resolve(
  process.env.FXDREAM_JOURNAL_FILE?.trim() || "fxdream-candidate-journal.json",
);

function usage(): never {
  console.log(`
FXDream forward journal (local-only, không gửi lệnh)

  scan [BTCUSDT,XRPUSDT]
  list [pending|accepted|rejected|missed|all]
  context <id> '<json w1d1,h4,m5,macro,session,spread>'
  review <id> accepted <model> <confirmation-market|ob-limit> <reason...>
  review <id> rejected|missed <model> <reason...>
  execution <id> <fillPrice> <feePct> <slippagePct> [filledAtMs]
  outcome <id> <exitPrice> <grossR> <netR> <mfeR> <maeR> [closedAtMs]
  report

Models: ${FXDREAM_MODEL_IDS.join(", ")}
Journal: ${journalPath}
`);
  process.exit(1);
}

function numberArg(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} phải là số`);
  return parsed;
}

function modelArg(value: string | undefined): FXDreamModelId {
  if (!value || !FXDREAM_MODEL_IDS.includes(value as FXDreamModelId)) {
    throw new Error(`Model không hợp lệ; dùng một trong: ${FXDREAM_MODEL_IDS.join(", ")}`);
  }
  return value as FXDreamModelId;
}

function executionModeArg(value: string | undefined): FXDreamExecutionMode {
  if (value !== "confirmation-market" && value !== "ob-limit") {
    throw new Error("Execution mode phải là confirmation-market hoặc ob-limit");
  }
  return value;
}

function printCandidate(record: ReturnType<typeof loadFXDreamJournal>["records"][number]): void {
  console.log([
    record.id,
    record.review.decision,
    record.review.modelId ?? record.suggestedModelId,
    record.symbol,
    record.direction,
    `key=${record.key.point}`,
    `vol=${record.key.volumeRatio.toFixed(2)}x`,
    `R=${record.proposed.targetR.toFixed(2)}`,
    new Date(record.trigger.confirmTime).toISOString(),
  ].join(" | "));
}

async function scan(args: string[]): Promise<void> {
  const symbols = (args[0] || process.env.FXDREAM_SYMBOLS || "BTCUSDT,XRPUSDT")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const venue = process.env.FXDREAM_VENUE?.trim() || "binance-usdm";
  const feed = process.env.FXDREAM_FEED?.trim() || venue;
  const journal = loadFXDreamJournal(journalPath);
  const detectedAt = Date.now();
  const candidates = [];
  for (const symbol of symbols) {
    const plans = await scanFXDreamResearchCandidatesForSymbol(symbol);
    candidates.push(...plans.map((plan) =>
      createCandidateFromPlan(plan, detectedAt, venue, feed),
    ));
  }
  const added = upsertCandidates(journal, candidates);
  if (added) saveFXDreamJournal(journalPath, journal);
  console.log(`Scan xong: phát hiện ${candidates.length}, thêm mới ${added}, journal ${journalPath}`);
  candidates.forEach(printCandidate);
}

function list(args: string[]): void {
  const filter = args[0] ?? "pending";
  if (!["pending", "accepted", "rejected", "missed", "all"].includes(filter)) usage();
  const journal = loadFXDreamJournal(journalPath);
  const records = filter === "all"
    ? journal.records
    : journal.records.filter((record) => record.review.decision === filter);
  console.log(`${records.length} candidate (${filter})`);
  records.forEach(printCandidate);
}

function context(args: string[]): void {
  const [id, ...jsonParts] = args;
  if (!id || !jsonParts.length) usage();
  const parsed = JSON.parse(jsonParts.join(" ")) as FXDreamReviewContext;
  const journal = loadFXDreamJournal(journalPath);
  annotateCandidateContext(journal, id, parsed);
  saveFXDreamJournal(journalPath, journal);
  console.log(`Đã khóa context trước review cho ${id}`);
}

function review(args: string[]): void {
  const [id, decision, modelValue, ...rest] = args;
  if (!id || !["accepted", "rejected", "missed"].includes(decision)) usage();
  const modelId = modelArg(modelValue);
  let executionMode: FXDreamExecutionMode | undefined;
  let reasonParts = rest;
  if (decision === "accepted") {
    executionMode = executionModeArg(rest[0]);
    reasonParts = rest.slice(1);
  }
  const reason = reasonParts.join(" ").trim();
  if (!reason) throw new Error("Review phải có reason");
  const journal = loadFXDreamJournal(journalPath);
  reviewCandidate(journal, id, {
    decision: decision as "accepted" | "rejected" | "missed",
    modelId,
    executionMode,
    reason,
    reviewedAt: Date.now(),
  });
  saveFXDreamJournal(journalPath, journal);
  console.log(`Đã khóa quyết định ${decision} cho ${id}`);
}

function execution(args: string[]): void {
  const [id, fillPriceValue, feePctValue, slippagePctValue, filledAtValue] = args;
  if (!id) usage();
  const journal = loadFXDreamJournal(journalPath);
  recordCandidateExecution(journal, id, {
    fillPrice: numberArg(fillPriceValue, "fillPrice"),
    feeRate: numberArg(feePctValue, "feePct") / 100,
    slippageRate: numberArg(slippagePctValue, "slippagePct") / 100,
    filledAt: filledAtValue ? numberArg(filledAtValue, "filledAtMs") : Date.now(),
  });
  saveFXDreamJournal(journalPath, journal);
  console.log(`Đã ghi execution thật cho ${id}`);
}

function outcome(args: string[]): void {
  const [id, exitPriceValue, grossRValue, netRValue, mfeRValue, maeRValue, closedAtValue] = args;
  if (!id) usage();
  const journal = loadFXDreamJournal(journalPath);
  recordCandidateOutcome(journal, id, {
    exitPrice: numberArg(exitPriceValue, "exitPrice"),
    grossR: numberArg(grossRValue, "grossR"),
    netR: numberArg(netRValue, "netR"),
    mfeR: numberArg(mfeRValue, "mfeR"),
    maeR: numberArg(maeRValue, "maeR"),
    closedAt: closedAtValue ? numberArg(closedAtValue, "closedAtMs") : Date.now(),
  });
  saveFXDreamJournal(journalPath, journal);
  console.log(`Đã ghi outcome cho ${id}`);
}

function report(): void {
  const journal = loadFXDreamJournal(journalPath);
  const value = journalReport(journal);
  console.log(`Total ${value.total} | pending ${value.pending}`);
  for (const group of value.groups) {
    console.log([
      group.modelId,
      group.decision,
      `N=${group.candidates}`,
      `outcome=${group.outcomes}`,
      `gross=${group.grossR.toFixed(2)}R`,
      `net=${group.netR.toFixed(2)}R`,
      `exp=${group.expectancy.toFixed(3)}R`,
      `PF=${Number.isFinite(group.profitFactor) ? group.profitFactor.toFixed(2) : "inf"}`,
      `MFE=${group.averageMfeR.toFixed(2)}R`,
      `MAE=${group.averageMaeR.toFixed(2)}R`,
    ].join(" | "));
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "scan") await scan(args);
  else if (command === "list") list(args);
  else if (command === "context") context(args);
  else if (command === "review") review(args);
  else if (command === "execution") execution(args);
  else if (command === "outcome") outcome(args);
  else if (command === "report") report();
  else usage();
}

main().catch((error: unknown) => {
  console.error("FXDream journal error:", error);
  process.exit(1);
});
