import assert from "node:assert/strict";
import {
  KEY_VOLUME_CONFIG,
  KEY_VOLUME_DOCUMENT_V1_CONFIG,
  approximateHvnEdge,
  canReenterKey,
  candleChainBias,
  dailyTrapGate,
  detectKeyVolumeLevels,
  hasDoubleTopBottom,
  hasReversalCandlePattern,
  hasShortHigherLowPressure,
  isEngulfing,
  isInsideBar,
  isThreeBarReversal,
  isWithinSession,
  isKeyVolumeLevelActive,
  medianPrior,
  persistentCandleChainBias,
  resolveTargetR,
  runKeyVolume,
  structuralCandleChainBias,
  strictCandleChainBias,
  sweptAndReclaimed,
} from "./key-volume";
import { applyLeverageCap } from "./key-volume-backtest";
import { Candle, TF_MS, aggregate } from "./strategy";

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  tf = TF_MS["1h"],
): Candle {
  return {
    openTime: index * tf,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: volume,
    takerBuyVolume: volume / 2,
  };
}

function testMedianExcludesCurrent(): void {
  assert.equal(medianPrior([1, 3, 2, 100], 3, 3), 2);
  assert.equal(medianPrior([1, 2, 100], 2, 2), 1.5);
  assert.equal(medianPrior([1, 2], 1, 2), 0);
}

function testSourceBackedDefaults(): void {
  assert.equal(KEY_VOLUME_CONFIG.touchVolumeSpikeMult, 1);
  assert.equal(KEY_VOLUME_CONFIG.persistDailyBias, true);
  assert.equal(KEY_VOLUME_CONFIG.allowKeyReentry, true);
  // #10 chọn key "có 3 điểm xoay chiều" và loại mức "không có lịch sử giá";
  // #26 loại mức "không có phản ứng". 0 = không ràng buộc gì.
  assert.equal(KEY_VOLUME_CONFIG.minKeyReactions, 1);
  assert.equal(KEY_VOLUME_DOCUMENT_V1_CONFIG.minKeyReactions, 0);
  assert.equal(KEY_VOLUME_CONFIG.requireHigherKey, false);
  assert.equal(KEY_VOLUME_CONFIG.targetMode, "nearest-structure");
  assert.equal(KEY_VOLUME_CONFIG.partialFraction, 0.5);
  assert.equal(KEY_VOLUME_CONFIG.maxHoldBars, 7 * 24 * 12);
  assert.equal(resolveTargetR(12, KEY_VOLUME_CONFIG), 12);
  assert.equal(resolveTargetR(null, KEY_VOLUME_CONFIG), KEY_VOLUME_CONFIG.finalTargetR);

  assert.equal(KEY_VOLUME_DOCUMENT_V1_CONFIG.targetMode, "capped-r");
  assert.equal(KEY_VOLUME_DOCUMENT_V1_CONFIG.partialFraction, 0.5);
  assert.equal(resolveTargetR(12, KEY_VOLUME_DOCUMENT_V1_CONFIG), 5);
}

function testKeyActivationAndNoLookahead(): void {
  const params = {
    ...KEY_VOLUME_CONFIG,
    volumeLookback: 5,
    volumeSpikeMult: 2,
    reactionLookback: 3,
    reactionBars: 2,
    reactionAtr: 0.5,
    minKeyReactions: 0,
    keyMaxAgeDays: 90,
  };
  const prefix: Candle[] = [
    candle(0, 100, 101, 99, 100, 100),
    candle(1, 100, 101, 99, 100, 100),
    candle(2, 100, 101, 99, 100, 100),
    candle(3, 100, 101, 99, 100, 100),
    candle(4, 100, 101, 99, 100, 100),
    candle(5, 100, 101, 99.5, 100.5, 300),
    candle(6, 100.5, 103.5, 100, 103, 120),
    candle(7, 103, 104, 102, 103.5, 100),
  ];
  const levelsAtPrefix = detectKeyVolumeLevels(prefix, "1h", params);
  assert.equal(levelsAtPrefix.length, 1);
  const level = levelsAtPrefix[0];
  assert.equal(level.type, "demand");
  assert.equal(level.price, 100);
  assert.equal(level.confirmedAt, prefix[6].openTime + TF_MS["1h"]);
  assert.equal(isKeyVolumeLevelActive(level, prefix[5].openTime + TF_MS["1h"]), false);
  assert.equal(isKeyVolumeLevelActive(level, level.confirmedAt), true);

  const full = [
    ...prefix,
    candle(8, 103.5, 104, 102, 103, 100),
    candle(9, 103, 103, 97, 98, 100),
  ];
  const levelsAtFull = detectKeyVolumeLevels(full, "1h", params);
  const sameEvent = levelsAtFull.find((candidate) => candidate.eventTime === level.eventTime);
  assert.ok(sameEvent);
  assert.equal(sameEvent.confirmedAt, level.confirmedAt);
  const beforeFutureInvalidation = prefix[7].openTime + TF_MS["1h"];
  assert.equal(isKeyVolumeLevelActive(level, beforeFutureInvalidation), true);
  assert.equal(isKeyVolumeLevelActive(sameEvent, beforeFutureInvalidation), true);
  assert.equal(isKeyVolumeLevelActive(sameEvent, full[9].openTime + TF_MS["1h"]), false);
  const flipped = levelsAtFull.find((candidate) =>
    candidate.eventTime === level.eventTime
    && candidate.direction === "short"
    && candidate.confirmedAt === full[9].openTime + TF_MS["1h"],
  );
  assert.ok(flipped, "demand bị phá phải đổi vai thành supply, không bị xóa khỏi hệ thống");
  assert.equal(isKeyVolumeLevelActive(flipped, flipped.confirmedAt), true);
}

function testCandleChainBias(): void {
  const bars = [
    candle(0, 100, 103, 99, 102),
    candle(1, 102, 104, 101, 103),
    candle(2, 103, 104, 101, 102),
    candle(3, 102, 103, 99, 100),
    candle(4, 100, 101, 97, 98),
    candle(5, 98, 100, 96, 97),
  ];
  assert.equal(candleChainBias(bars, 2, 3), "bull");
  assert.equal(candleChainBias(bars, 5, 3), "bear");
  assert.equal(candleChainBias(bars, 1, 3), "neutral");
  assert.equal(strictCandleChainBias(bars, 2, 3), "neutral");
  assert.equal(strictCandleChainBias(bars, 5, 3), "bear");
  assert.equal(persistentCandleChainBias(bars, 2, 3), "neutral");
  assert.equal(persistentCandleChainBias(bars, 3, 3), "neutral");
  assert.equal(persistentCandleChainBias(bars, 5, 3), "bear");

  const establishedTrend = [
    candle(0, 100, 102, 99, 101),
    candle(1, 101, 103, 100, 102),
    candle(2, 102, 104, 101, 103),
    candle(3, 103, 104, 101, 102),
    candle(4, 102, 103, 100, 101),
  ];
  assert.equal(strictCandleChainBias(establishedTrend, 4, 3), "neutral");
  assert.equal(
    persistentCandleChainBias(establishedTrend, 4, 3),
    "bull",
    "bias đã xác lập phải được giữ tới khi có chuỗi ngược chiều",
  );

  const structural = [
    candle(0, 100, 101, 98, 99),
    candle(1, 99, 100.2, 98.8, 100),
    candle(2, 100, 101.2, 99.8, 101),
    candle(3, 101, 102.2, 100.5, 102),
    candle(4, 102, 102.1, 101.4, 101.5),
    candle(5, 101.5, 101.6, 100.7, 101),
    candle(6, 101, 101.1, 100, 100.2),
  ];
  assert.equal(structuralCandleChainBias(structural, 3, 3), "bull");
  assert.equal(
    structuralCandleChainBias(structural, 5, 3),
    "bull",
    "hai nến đỏ chưa phá cấu trúc không được đảo bias",
  );
  assert.equal(
    structuralCandleChainBias(structural, 6, 3),
    "bear",
    "chuỗi đỏ phá low nến xanh cuối phải đảo bias",
  );
}

function testConditionalReentryAndLeverageCap(): void {
  assert.equal(canReenterKey("long", 98, "positive-stop", 99, true), true);
  assert.equal(canReenterKey("long", 100, "positive-stop", 99, true), false);
  assert.equal(canReenterKey("short", 102, "positive-stop", 101, true), true);
  assert.equal(canReenterKey("short", 102, "stop", 101, true), false);
  assert.equal(canReenterKey("short", 102, "positive-stop", 101, false), false);

  const tinyStop = {
    symbol: "test",
    dir: "long" as const,
    entryTime: 0,
    entryPrice: 100,
    initialSL: 99.98,
    exitTime: 1,
    grossR: 5,
    costR: 2,
    netR: 3,
  };
  const capped = applyLeverageCap(tinyStop, 1, 10);
  assert.ok(Math.abs(capped.grossR - 1) < 1e-9);
  assert.ok(Math.abs(capped.costR - 0.4) < 1e-9);
  assert.ok(Math.abs(capped.netR - 0.6) < 1e-9);
  const wideStop = { ...tinyStop, initialSL: 99 };
  assert.deepEqual(applyLeverageCap(wideStop, 1, 10), wideStop);
}

function testSweepAndReclaim(): void {
  const longBars = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 98, 99),
    candle(2, 99, 100, 97, 98),
    candle(3, 98, 101, 96, 99),
  ];
  assert.equal(sweptAndReclaimed(longBars, 3, "long", 3), true);

  const shortBars = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 102, 99, 101),
    candle(2, 101, 103, 100, 102),
    candle(3, 102, 104, 99, 101),
  ];
  assert.equal(sweptAndReclaimed(shortBars, 3, "short", 3), true);
  const pressureBars = [
    candle(0, 100, 101, 97, 100),
    candle(1, 100, 102, 98, 101),
    candle(2, 101, 103, 99, 102),
  ];
  assert.equal(hasShortHigherLowPressure(pressureBars, 2, "short", 3), true);
  assert.equal(hasShortHigherLowPressure(pressureBars, 2, "long", 3), false);
}

function testHvnProxyAndWeeklyAlignment(): void {
  const m5 = [
    candle(0, 100, 102, 99, 101, 1000, TF_MS["5m"]),
    candle(1, 101, 102, 100, 101, 1000, TF_MS["5m"]),
    candle(2, 101, 110, 109, 109.5, 10, TF_MS["5m"]),
  ];
  const longEdge = approximateHvnEdge(m5, 0, 2, "long", 10, 0.6);
  const shortEdge = approximateHvnEdge(m5, 0, 2, "short", 10, 0.6);
  assert.ok(longEdge != null && shortEdge != null);
  assert.ok(longEdge < shortEdge);
  assert.ok(longEdge >= 99 && shortEdge <= 110);

  const monday = Date.UTC(2026, 6, 27);
  const daily: Candle[] = Array.from({ length: 8 }, (_, i) => ({
    ...candle(i, 100 + i, 102 + i, 99 + i, 101 + i, 100, TF_MS["1d"]),
    openTime: monday + i * TF_MS["1d"],
  }));
  const weekly = aggregate(daily, "1w", "1d");
  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].openTime, monday);
}

function appendM15(
  base: Candle[],
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): void {
  for (let part = 0; part < 3; part++) {
    const partOpen = open + (close - open) * (part / 3);
    const partClose = open + (close - open) * ((part + 1) / 3);
    base.push({
      openTime: base.length * TF_MS["5m"],
      open: partOpen,
      high: part === 0 ? Math.max(high, partOpen, partClose) : Math.max(partOpen, partClose),
      low: part === 0 ? Math.min(low, partOpen, partClose) : Math.min(partOpen, partClose),
      close: partClose,
      volume: volume / 3,
      quoteVolume: volume / 3,
      takerBuyVolume: volume / 6,
    });
  }
}

function testVolumeRetestStateMachine(): void {
  const base: Candle[] = [];
  const eventBar = 4 * 96 + 4;
  let previousClose = 100;
  for (let index = 0; index < 7 * 96; index++) {
    const day = Math.floor(index / 96);
    const within = index % 96;
    const baseline = 100 + day * 4 + 3 * (within / 96);
    let open = baseline;
    let close = baseline + 3 / 96;
    let volume = 100;
    if (index === eventBar) {
      open = baseline;
      close = baseline + 1.5;
      volume = 1000;
    } else if (index > eventBar && day === 4) {
      open = baseline + 1.5;
      close = baseline + 1.5 + 3 / 96;
    }
    previousClose = close;
    appendM15(base, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close, volume);
  }

  const h1 = aggregate(base, "1h", "5m");
  const keys = detectKeyVolumeLevels(h1, "1h", {
    ...KEY_VOLUME_CONFIG,
    minKeyReactions: 0,
    requireHigherKey: false,
  });
  const key = keys.find((level) =>
    level.direction === "long"
    && level.eventTime === Math.floor(eventBar / 4) * TF_MS["1h"],
  );
  assert.ok(key, "synthetic H1 volume event must create a demand key");

  for (let index = 0; index < 36; index++) {
    const close = previousClose + (key.price + 1.5 - previousClose) / (36 - index);
    appendM15(
      base,
      previousClose,
      Math.max(previousClose, close) + 0.05,
      Math.min(previousClose, close) - 0.05,
      close,
    );
    previousClose = close;
  }
  const pattern = [
    [key.price + 1.5, key.price + 1.8],
    [key.price + 1.8, key.price + 2.1],
    [key.price + 2.1, key.price + 1.7],
    [key.price + 1.7, key.price + 1.3],
    [key.price + 1.3, key.price + 0.8],
  ] as const;
  for (const [open, close] of pattern) {
    appendM15(base, open, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, close);
  }
  appendM15(
    base,
    key.price + 0.8,
    key.price + 1.1,
    key.price - 0.3,
    key.price + 1,
    1000,
  );
  appendM15(
    base,
    key.price + 1,
    key.price + 2.6,
    key.price + 0.1,
    key.price + 2.5,
  );
  previousClose = key.price + 2.5;
  for (let index = 0; index < 12; index++) {
    const close = previousClose + 1.5;
    appendM15(base, previousClose, close + 0.05, previousClose - 0.05, close);
    previousClose = close;
  }

  // Fixture này kiểm tra riêng pipeline touch -> volume -> sweep -> BOS, nên
  // phải pin trigger BOS và tắt gate Daily trap (mặc định mới dùng mô hình nến).
  const result = runKeyVolume("synthetic", base, {
    ...KEY_VOLUME_CONFIG,
    entryTrigger: "bos",
    requireDailyTrapGate: false,
    keyMaxAgeDays: 90,
    minRR: 0,
    minKeyReactions: 0,
    requireHigherKey: false,
    persistDailyBias: false,
  });
  assert.ok(result.diagnostics.touchVolumeConfirmed >= 1);
  assert.ok(result.diagnostics.sweeps >= 1);
  assert.ok(result.diagnostics.firstBos >= 1);
  assert.ok(result.plans.some((plan) => plan.model === "volume-retest"));
  assert.ok(result.trades.some((trade) => trade.model === "volume-retest"));
  assert.ok(
    result.trades.every(
      (trade) =>
        trade.exitReason !== "no-follow-through"
        && trade.exitReason !== "opposite-pressure",
    ),
    // Luật "không chạy liền là bỏ" CÓ trong nguồn (LiveTrade +50R, #26, #43) nên
    // không còn bị coi là luật tự chế. Fixture này là kèo chạy ngay sau entry,
    // vì vậy nó vẫn không được thoát bằng no-follow-through.
    "a trade that runs immediately must not exit via the no-follow-through rule",
  );

  const prefixLength = base.length - 6 * 3;
  const prefixResult = runKeyVolume("synthetic", base.slice(0, prefixLength), {
    ...KEY_VOLUME_CONFIG,
    entryTrigger: "bos",
    requireDailyTrapGate: false,
    keyMaxAgeDays: 90,
    minRR: 0,
    minKeyReactions: 0,
    requireHigherKey: false,
    persistDailyBias: false,
  });
  assert.deepEqual(
    result.plans
      .filter((plan) => plan.readyIndex < prefixLength)
      .map((plan) => plan.id),
    prefixResult.plans.map((plan) => plan.id),
    "adding future candles must not change plans already observable at the cutoff",
  );
}

/** #50: chỉ ba mô hình nến — nhấn chìm, in3, 3-bar reversal. */
function testReversalCandlePatterns(): void {
  // Nhấn chìm tăng: nến đỏ rồi nến xanh bao trọn thân.
  const bullEngulf = [candle(0, 10, 10.2, 9.4, 9.5), candle(1, 9.4, 10.6, 9.3, 10.5)];
  assert.equal(isEngulfing(bullEngulf, 1, "long"), true);
  assert.equal(isEngulfing(bullEngulf, 1, "short"), false);
  // Cùng dữ liệu nhưng thân không bao trọn -> không phải nhấn chìm.
  const notEngulf = [candle(0, 10, 10.2, 9.4, 9.5), candle(1, 9.6, 10.1, 9.5, 9.9)];
  assert.equal(isEngulfing(notEngulf, 1, "long"), false);

  const inside = [candle(0, 10, 11, 9, 10.5), candle(1, 10.2, 10.8, 9.6, 10.1)];
  assert.equal(isInsideBar(inside, 1), true);
  assert.equal(isInsideBar(bullEngulf, 1), false);

  // 3-bar reversal tăng: nến giữa thủng đáy hai bên, nến ba đóng trên high nến một.
  const threeBar = [
    candle(0, 10, 10.5, 9.8, 10.1),
    candle(1, 10.1, 10.2, 9.0, 9.3),
    candle(2, 9.3, 10.9, 9.2, 10.8),
  ];
  assert.equal(isThreeBarReversal(threeBar, 2, "long"), true);
  assert.equal(isThreeBarReversal(threeBar, 2, "short"), false);
  assert.equal(hasReversalCandlePattern(threeBar, 2, "long"), true);
}

/** #22/#23: mô hình hai đỉnh / hai đáy tại key. */
function testDoubleTopBottom(): void {
  const swings = [
    { index: 5, confirmIndex: 7, type: "low" as const, price: 100 },
    { index: 20, confirmIndex: 22, type: "low" as const, price: 100.3 },
    { index: 30, confirmIndex: 32, type: "high" as const, price: 120 },
  ];
  // Hai đáy cách nhau 0.3 -> trong dung sai 1.0 là hai đáy.
  assert.equal(hasDoubleTopBottom(swings, 40, "long", 1, 50), true);
  // Dung sai 0.1 thì hai đáy đó không còn coi là bằng nhau.
  assert.equal(hasDoubleTopBottom(swings, 40, "long", 0.1, 50), false);
  // Chỉ có một đỉnh -> chưa thành hai đỉnh.
  assert.equal(hasDoubleTopBottom(swings, 40, "short", 1, 50), false);
  // Swing chưa được confirm thì không được dùng (chống nhìn trước).
  assert.equal(hasDoubleTopBottom(swings, 6, "long", 1, 50), false);
}

/** Q&A006: ưu tiên phiên Mỹ. Kiểm tra cả khoảng vắt qua nửa đêm. */
function testSessionFilter(): void {
  const at = (hour: number) => Date.UTC(2026, 0, 5, hour, 30);
  assert.equal(isWithinSession(at(14), 13, 21), true);
  assert.equal(isWithinSession(at(9), 13, 21), false);
  assert.equal(isWithinSession(at(21), 13, 21), false);
  assert.equal(isWithinSession(at(23), 22, 4), true);
  assert.equal(isWithinSession(at(2), 22, 4), true);
  assert.equal(isWithinSession(at(10), 22, 4), false);
}

/**
 * #31: chuỗi tăng -> low nến xanh cuối CHƯA bị đóng qua, nhưng ĐÃ bị trap.
 */
function testDailyTrapGate(): void {
  const d = TF_MS["1d"];
  // Nến xanh cuối ở index 0 (low 100), sau đó thọt râu xuống 99 rồi đóng trên.
  const trapped = [
    candle(0, 101, 105, 100, 104, 100, d),
    candle(1, 104, 106, 99, 103, 100, d),
  ];
  assert.equal(dailyTrapGate(trapped, 1, "long"), true);

  // Chưa thọt râu xuống dưới low -> chưa trap -> chưa vào.
  const notTrapped = [
    candle(0, 101, 105, 100, 104, 100, d),
    candle(1, 104, 106, 100.5, 103, 100, d),
  ];
  assert.equal(dailyTrapGate(notTrapped, 1, "long"), false);

  // Đã ĐÓNG dưới low nến xanh cuối -> chuỗi gãy -> loại.
  const closedThrough = [
    candle(0, 101, 105, 100, 104, 100, d),
    candle(1, 104, 106, 98, 99, 100, d),
  ];
  assert.equal(dailyTrapGate(closedThrough, 1, "long"), false);
}

/** #23/#43: sau stop dương, chạm key + kích volume lần nữa là vào lại được. */
function testReentryModes(): void {
  // deeper-sweep: cần cú quét sâu hơn, quét nông hơn thì không cho vào lại.
  assert.equal(
    canReenterKey("long", 95, "positive-stop", 90, true, "deeper-sweep"),
    false,
  );
  assert.equal(
    canReenterKey("long", 85, "positive-stop", 90, true, "deeper-sweep"),
    true,
  );
  // volume-retouch: không đòi quét sâu hơn.
  assert.equal(
    canReenterKey("long", 95, "positive-stop", 90, true, "volume-retouch"),
    true,
  );
  // Nhưng vẫn chỉ sau stop DƯƠNG, không phải sau stop thường.
  assert.equal(
    canReenterKey("long", 95, "stop", 90, true, "volume-retouch"),
    false,
  );
}

testMedianExcludesCurrent();
testSourceBackedDefaults();
testReversalCandlePatterns();
testDoubleTopBottom();
testSessionFilter();
testDailyTrapGate();
testReentryModes();
testKeyActivationAndNoLookahead();
testCandleChainBias();
testConditionalReentryAndLeverageCap();
testSweepAndReclaim();
testHvnProxyAndWeeklyAlignment();
testVolumeRetestStateMachine();
console.log("Key Volume tests: OK");
