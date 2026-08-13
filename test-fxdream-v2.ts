import assert from "node:assert/strict";
import { buildFXDreamTelegramCard } from "./fxdream-alert";
import { Candle, TF_MS } from "./strategy";
import {
  FXDREAM_V2_CONFIG,
  KeyLevel,
  SFPEvent,
  buildSignalPlanV2,
  detectSFPSignalsV2,
  evaluateDailyContextV2,
  findKeyVolumeLevelsV2,
  findNearestOpposingStructurePrice,
  isExecutionCostSupported,
  selectBestSFPEventV2,
} from "./fxdream-research/strategy-engine-v2";

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
  tf = TF_MS["15m"],
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

function testStrictDailyGate(): void {
  const prefix = Array.from({ length: 6 }, (_, i) =>
    candle(i, 100, 102, 99, i % 2 === 0 ? 101 : 100, 100, TF_MS["1d"]),
  );
  const longPass = [
    ...prefix,
    candle(6, 100, 103, 99.5, 102, 100, TF_MS["1d"]),
    candle(7, 102, 104, 99, 103, 100, TF_MS["1d"]),
    candle(8, 103, 103.5, 98, 100, 100, TF_MS["1d"]),
  ];
  const longTime = longPass[longPass.length - 1].openTime + TF_MS["1d"];
  assert.deepEqual(evaluateDailyContextV2(longPass, longTime, FXDREAM_V2_CONFIG), {
    bias: "long",
    trapGatePassed: true,
  });

  const longClosedThrough = [...longPass];
  longClosedThrough[8] = candle(8, 103, 103.5, 98, 98.5, 100, TF_MS["1d"]);
  assert.equal(
    evaluateDailyContextV2(longClosedThrough, longTime, FXDREAM_V2_CONFIG).trapGatePassed,
    false,
  );

  const shortPass = [
    ...prefix,
    candle(6, 103, 103.5, 100, 101, 100, TF_MS["1d"]),
    candle(7, 102, 103, 99, 100, 100, TF_MS["1d"]),
    candle(8, 100, 104, 99.5, 102, 100, TF_MS["1d"]),
  ];
  const shortTime = shortPass[shortPass.length - 1].openTime + TF_MS["1d"];
  assert.deepEqual(evaluateDailyContextV2(shortPass, shortTime, FXDREAM_V2_CONFIG), {
    bias: "short",
    trapGatePassed: true,
  });
}

function testKeyUsesSpikeCloseAsRepresentative(): void {
  const h1 = Array.from({ length: 117 }, (_, i) =>
    candle(i, 100, 101, 99.5, 100, 100, TF_MS["1h"]),
  );
  h1[96] = candle(96, 100, 102, 99, 101, 300, TF_MS["1h"]);
  const levels = findKeyVolumeLevelsV2(h1, [], FXDREAM_V2_CONFIG);
  const key = levels.find((level) => level.originIndex === 96);
  assert.ok(key);
  assert.equal(key.type, "neutral", "Key volume chưa có hướng tại lúc được chọn");
  assert.equal(key.price, 101, "code dùng close của nến volume làm điểm đại diện cho Key");
  assert.equal(key.zoneLow, 99);
  assert.equal(key.zoneHigh, 102);
  assert.equal(key.isConfluent, false, "không được hard-code hợp lưu H4");
}

function testVolumeSpikeAloneCreatesKeyCandidate(): void {
  const h1 = Array.from({ length: 45 }, (_, i) =>
    candle(i, 100, 100.4, 99.6, 100, 100, TF_MS["1h"]),
  );
  h1[20] = candle(20, 100, 100.4, 99.6, 100, 300, TF_MS["1h"]);

  const levels = findKeyVolumeLevelsV2(h1, [], {
    ...FXDREAM_V2_CONFIG,
    volumeLookback: 20,
  }).filter((level) => level.originIndex === 20);

  assert.equal(levels.length, 1, "một nến volume spike chỉ được tạo một Key trung tính");
  assert.equal(levels[0].type, "neutral");
  assert.equal(levels[0].zoneLow, 99.6);
  assert.equal(levels[0].zoneHigh, 100.4);
  assert.ok(levels.every((level) => level.reactionsCount === 0));
}

function demandKey(): KeyLevel {
  return {
    id: "demand-test",
    price: 100,
    type: "demand",
    tf: "1h",
    originTime: 0,
    originIndex: 0,
    volumeRatio: 3,
    reactionsCount: 2,
    isConfluent: false,
  };
}

function testStrictSweepAndEngulfing(): void {
  const bars = Array.from({ length: 25 }, (_, i) => candle(i, 100.1, 100.4, 100, 100.2));
  bars[22] = candle(22, 100.1, 100.5, 99.9, 100.2);
  bars[23] = candle(23, 100.4, 100.5, 99.6, 99.8);
  bars[24] = candle(24, 99.7, 100.6, 100, 100.5);
  const ctx = { bias: "long" as const, trapGatePassed: true };
  const lowerKey = { ...demandKey(), price: 99 };
  assert.equal(
    detectSFPSignalsV2(bars, [lowerKey], ctx, FXDREAM_V2_CONFIG).length,
    0,
    "chạm key nhưng không xuyên không phải sweep",
  );

  bars[24] = candle(24, 99.7, 100.6, 98.5, 100.5);
  const events = detectSFPSignalsV2(bars, [lowerKey], ctx, FXDREAM_V2_CONFIG);
  assert.equal(events.length, 1);
  assert.equal(events[0].patternName, "Engulfing");
  assert.equal(
    events[0].confirmTime,
    bars[24].openTime + TF_MS["15m"],
    "tín hiệu chỉ được xác nhận sau khi nến M15 đóng",
  );

  bars[23] = candle(23, 99.7, 100.2, 99.5, 100.1);
  assert.equal(
    detectSFPSignalsV2(bars, [lowerKey], ctx, FXDREAM_V2_CONFIG).some(
      (event) => event.patternName === "Engulfing",
    ),
    false,
    "engulfing long phải bao thân một nến giảm",
  );
}

function testNeutralKeyUsesZoneEdgeAndDailyDirection(): void {
  const bars = Array.from({ length: 25 }, (_, i) => candle(i, 100, 100.4, 99.6, 100.1));
  bars[22] = candle(22, 99.8, 100.2, 98.5, 99.7);
  bars[23] = candle(23, 99.4, 99.5, 98.7, 98.8);
  bars[24] = candle(24, 98.7, 99.7, 98.6, 99.6);
  const key: KeyLevel = {
    ...demandKey(),
    id: "neutral-zone",
    type: "neutral",
    price: 100,
    zoneLow: 99,
    zoneHigh: 101,
  };

  const events = detectSFPSignalsV2(
    bars,
    [key],
    { bias: "long", trapGatePassed: true },
    { ...FXDREAM_V2_CONFIG, keyGeometry: "full-candle-zone" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].dir, "long");
  assert.equal(events[0].sweepPrice, 98.5);
}

function testInsideBarBreakoutAndNoPinbarShortcut(): void {
  const bars = Array.from({ length: 25 }, (_, i) => candle(i, 100, 100.4, 99.6, 100.1));
  const ctx = { bias: "long" as const, trapGatePassed: true };
  const key = { ...demandKey(), price: 99 };

  // Mother bar quét key, nến kế nằm hoàn toàn bên trong, nến cuối đóng vượt mother bar.
  bars[22] = candle(22, 100, 101, 98.5, 99.6);
  bars[23] = candle(23, 99.7, 100.5, 99.1, 99.9);
  bars[24] = candle(24, 99.9, 101.4, 99.7, 101.2);
  const insideBarEvents = detectSFPSignalsV2(bars, [key], ctx, FXDREAM_V2_CONFIG);
  assert.equal(insideBarEvents.length, 1);
  assert.equal(insideBarEvents[0].patternName, "Inside-bar-breakout");

  // Râu dài đơn thuần không nằm trong bộ mẫu nến đã được kênh nêu cho setup này.
  bars[22] = candle(22, 100.1, 100.5, 99.3, 100.2);
  bars[23] = candle(23, 100.2, 100.7, 99.4, 100.3);
  bars[24] = candle(24, 100.3, 100.6, 98.5, 100.4);
  assert.equal(detectSFPSignalsV2(bars, [key], ctx, FXDREAM_V2_CONFIG).length, 0);
}

function planEvent(): SFPEvent {
  return {
    keyLevel: demandKey(),
    dir: "long",
    sweepTime: 1,
    sweepPrice: 99.9,
    reclaimPrice: 100.5,
    confirmTime: 2,
    confirmClose: 100.5,
    patternName: "Engulfing",
    obHigh: 101,
    obLow: 100,
  };
}

function testStructuralStopAndHeadroom(): void {
  const plan = buildSignalPlanV2("TEST", planEvent(), 102, {
    ...FXDREAM_V2_CONFIG,
    minStopPct: 0.008,
  });
  assert.ok(plan);
  assert.equal(plan.entryPrice, planEvent().confirmClose, "entry phải là giá xác nhận, không phải 30% nến giả OB");
  assert.ok(Math.abs(plan.initialSL - 99.8001) < 1e-9, "không được nới stop lên sàn 0,8%");
  const card = buildFXDreamTelegramCard(plan);
  assert.match(card, /ỨNG VIÊN/);
  assert.match(card, /xác nhận thủ công/i);
  assert.match(card, /W1\/D1/);
  assert.match(card, /M5 Volume Profile/);
  assert.doesNotMatch(card, /RECOMMENDED LIMIT ENTRY|30% OB/);
  assert.doesNotMatch(card, /trước \d{2}:\d{2}/, "nguồn không đặt deadline follow-through cố định");
  assert.doesNotMatch(card, /25\.0R/, "không được quảng bá target 25R không có cấu trúc");
  assert.equal(buildSignalPlanV2("TEST", planEvent(), null, FXDREAM_V2_CONFIG), null);
  assert.equal(buildSignalPlanV2("TEST", planEvent(), 100.8, FXDREAM_V2_CONFIG), null);

  const largeRPlan = buildSignalPlanV2("TEST", planEvent(), 120, FXDREAM_V2_CONFIG);
  assert.ok(largeRPlan);
  assert.equal(largeRPlan.targetPrice, 120, "không được cắt cấu trúc thật bằng trần 15R nhân tạo");
  assert.ok(largeRPlan.targetR > 15);
}

function testNearestOpposingStructure(): void {
  const swings = [
    { index: 1, confirmIndex: 3, type: "high" as const, price: 105 },
    { index: 2, confirmIndex: 4, type: "high" as const, price: 110 },
    { index: 3, confirmIndex: 5, type: "low" as const, price: 95 },
    { index: 4, confirmIndex: 6, type: "low" as const, price: 90 },
  ];
  assert.equal(findNearestOpposingStructurePrice("long", 100, swings), 105);
  assert.equal(findNearestOpposingStructurePrice("short", 100, swings), 95);
  assert.equal(findNearestOpposingStructurePrice("long", 111, swings), null);
}

function testBestEventSelectionIsNotArrayOrder(): void {
  const weak = planEvent();
  const strong: SFPEvent = {
    ...planEvent(),
    keyLevel: { ...planEvent().keyLevel, id: "strong", volumeRatio: 6 },
  };
  assert.equal(selectBestSFPEventV2([strong, weak])?.keyLevel.id, "strong");
  assert.equal(selectBestSFPEventV2([weak, strong])?.keyLevel.id, "strong");
  assert.equal(selectBestSFPEventV2([]), null);
}

function testExecutionCostFailClosed(): void {
  assert.equal(isExecutionCostSupported(FXDREAM_V2_CONFIG), false);
  assert.equal(
    isExecutionCostSupported({
      ...FXDREAM_V2_CONFIG,
      makerFeeRate: 0,
      takerFeeRate: 0,
      slippageRate: 0,
    }),
    false,
    "chưa có holdout dương thì phí bằng 0 cũng không được tự mở alert",
  );
  assert.equal(
    isExecutionCostSupported({
      ...FXDREAM_V2_CONFIG,
      validatedForLiveAlerts: true,
      maxValidatedRoundTripFrictionRate: 0.0002,
      makerFeeRate: 0.0001,
      takerFeeRate: 0.0001,
      slippageRate: 0,
    }),
    true,
  );
}

testStrictDailyGate();
testKeyUsesSpikeCloseAsRepresentative();
testVolumeSpikeAloneCreatesKeyCandidate();
testStrictSweepAndEngulfing();
testNeutralKeyUsesZoneEdgeAndDailyDirection();
testInsideBarBreakoutAndNoPinbarShortcut();
testStructuralStopAndHeadroom();
testNearestOpposingStructure();
testBestEventSelectionIsNotArrayOrder();
testExecutionCostFailClosed();

console.log("FXDream V2 tests: OK");
