import assert from "node:assert/strict";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeLevel,
  canReenterKey,
  detectKeyVolumeLevels,
  directionAgainstKey,
  hasDoubleTopBottom,
  bodyEngulfs,
  departedFromBlock,
  isProminentExtreme,
  orderBlockEntry,
  orderBlockFromCluster,
  reversalOrderBlock,
  isWithinSession,
  isKeyVolumeLevelActive,
  medianAround,
  medianPrior,
  resolveTargetR,
  runKeyVolume,
  sweptAndReclaimed,
} from "./key-volume";
import { applyLeverageCap } from "./key-volume-backtest";
import { Candle, TF_MS } from "./strategy";

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

function testMedians(): void {
  assert.equal(medianPrior([1, 3, 2, 100], 3, 3), 2);
  assert.equal(medianPrior([1, 2, 100], 2, 2), 1.5);
  assert.equal(medianPrior([1, 2], 1, 2), 0);

  // Cửa sổ CÓ TÂM: 2 giá trị mỗi bên, bỏ chính nó.
  assert.equal(medianAround([1, 1, 99, 3, 3], 2, 4), 2);
  // Thiếu nửa sau cửa sổ thì chưa chấm được — đây là điều buộc key phải chờ.
  assert.equal(medianAround([1, 1, 99, 3], 2, 4), 0);
  assert.equal(medianAround([99, 1, 1, 3, 3], 0, 4), 0);
}

function testSourceBackedDefaults(): void {
  // Đúng MỘT khung. M5 đã bị bỏ hẳn, không phải đổi tên.
  assert.equal(KEY_VOLUME_CONFIG.confirmTf, "15m");
  assert.ok(!("baseTf" in KEY_VOLUME_CONFIG));
  assert.ok(!("keyTf" in KEY_VOLUME_CONFIG));
  assert.ok(!("confluenceTf" in KEY_VOLUME_CONFIG));
  assert.ok(!("dailyTf" in KEY_VOLUME_CONFIG));
  assert.ok(!("weeklyTf" in KEY_VOLUME_CONFIG));
  // Trần giữ 7 ngày đã bị bỏ hẳn, không phải nới ra.
  assert.ok(!("maxHoldBars" in KEY_VOLUME_CONFIG));

  // Key M15: ×4 trung vị của ~12 nến xung quanh. ×2 sinh 12,25 key/ngày/coin —
  // dày 122 lần thang người và 93% điểm tuỳ ý cũng "có key ở gần".
  assert.equal(KEY_VOLUME_CONFIG.volumeSpikeMult, 4);
  assert.equal(KEY_VOLUME_CONFIG.volumeLookback, 12);
  assert.equal(KEY_VOLUME_CONFIG.minKeyReactions, 0);

  // Stop hunt: cực trị NĂM ngày trên M15, và mức đó phải sạch một ngày về trước.
  assert.equal(KEY_VOLUME_CONFIG.sweepLookback, 5 * TF_MS["1d"] / TF_MS["15m"]);
  assert.equal(KEY_VOLUME_CONFIG.sweepProminenceBars, TF_MS["1d"] / TF_MS["15m"]);

  // Vào và thoát cùng bám một hộp order block.
  assert.equal(KEY_VOLUME_CONFIG.stopMode, "order-block");
  // Dựng hộp xong phải chờ 3 nến ĐÓNG ngoài hộp rồi mới canh giá quay lại.
  assert.equal(KEY_VOLUME_CONFIG.obDepartBars, 3);
  assert.equal(
    KEY_VOLUME_CONFIG.obDepartMode, "close",
    "chỉ GIÁ ĐÓNG phải ra ngoài hộp; râu được phép thò lại",
  );
  // Rời hộp xong thì canh giá quay lại đúng HAI ngày rồi bỏ hộp.
  assert.equal(
    KEY_VOLUME_CONFIG.boxWaitBars * TF_MS["15m"], 2 * TF_MS["1d"],
    "hộp được canh retest đúng 2 ngày",
  );

  // Hai nhánh vào lệnh, cả hai đều bật.
  assert.equal(KEY_VOLUME_CONFIG.enableSweepBranch, true);
  assert.equal(KEY_VOLUME_CONFIG.enableVolumeReversalBranch, true);
  // Volume của nhánh 2 phải NHẸ hơn hẳn ngưỡng sinh key.
  assert.ok(KEY_VOLUME_CONFIG.reversalVolumeMult > 1);
  assert.ok(KEY_VOLUME_CONFIG.reversalVolumeMult < KEY_VOLUME_CONFIG.volumeSpikeMult);

  // Cụm đảo chiều chỉ tính khi đảo chiều xảy ra NGAY TẠI key, và chỉ khi giá
  // thật sự QUAY VỀ key chứ không phải đi ngang đè lên nó.
  assert.equal(KEY_VOLUME_CONFIG.requireKeyInsideBlock, true);
  assert.equal(KEY_VOLUME_CONFIG.keyDepartureLookback, 20);
  assert.equal(KEY_VOLUME_CONFIG.keyDepartureAtr, 1);

  assert.equal(KEY_VOLUME_CONFIG.targetMode, "nearest-structure");
  assert.equal(KEY_VOLUME_CONFIG.requireStructuralTarget, true);
  assert.equal(KEY_VOLUME_CONFIG.partialFraction, 0);
  assert.equal(KEY_VOLUME_CONFIG.trailMode, "none");
  // Hai cửa sổ dưới đếm bằng nến M15 nhưng phải giữ đúng độ dài THỜI GIAN cũ.
  assert.equal(KEY_VOLUME_CONFIG.followThroughBars * 15, 30, "vẫn là 30 phút");
  assert.equal(KEY_VOLUME_CONFIG.cooldownBars * 15, 60, "vẫn là 1 giờ");
  assert.equal(KEY_VOLUME_CONFIG.allowKeyReentry, true);
  assert.equal(resolveTargetR(12, KEY_VOLUME_CONFIG), 12);
  assert.equal(resolveTargetR(null, KEY_VOLUME_CONFIG), KEY_VOLUME_CONFIG.finalTargetR);
  assert.equal(resolveTargetR(12, { targetMode: "capped-r", finalTargetR: 5 }), 5);
}

/**
 * Cửa sổ có tâm: key chỉ tồn tại khi đã có đủ nến hai bên, và `confirmedAt`
 * phải là lúc nến CUỐI cửa sổ đóng — nếu không replay sẽ nhìn trước.
 */
function testCenteredKeyWindowAndNoLookahead(): void {
  const params = { ...KEY_VOLUME_CONFIG, volumeLookback: 6, volumeSpikeMult: 2 };
  const m15 = TF_MS["15m"];
  const bars: Candle[] = [
    candle(0, 100, 101, 99, 100, 100, m15),
    candle(1, 100, 101, 99, 100, 100, m15),
    candle(2, 100, 101, 99, 100, 100, m15),
    candle(3, 100, 103, 98, 102, 300, m15),
    candle(4, 102, 103, 101, 102, 100, m15),
    candle(5, 102, 103, 101, 102, 100, m15),
  ];

  // Thiếu đúng một nến của nửa sau cửa sổ -> chưa có key nào.
  assert.equal(detectKeyVolumeLevels(bars, "15m", params).length, 0);

  const complete = [...bars, candle(6, 102, 103, 101, 102, 100, m15)];
  const levels = detectKeyVolumeLevels(complete, "15m", params);
  assert.equal(levels.length, 1);
  const level = levels[0];
  assert.equal(level.eventTime, complete[3].openTime);
  // Key là ĐƯỜNG THẲNG tại giá MỞ CỬA của nến volume, không phải close, và
  // không dày bằng biên độ nến nữa.
  assert.equal(level.price, complete[3].open);
  assert.equal(level.zoneLow, level.price);
  assert.equal(level.zoneHigh, level.price);
  assert.notEqual(level.price, complete[3].close);
  assert.equal(level.volumeRatio, 3);
  assert.equal(
    level.confirmedAt,
    complete[6].openTime + m15,
    "key phải được xác nhận đúng lúc nến cuối cửa sổ có tâm đóng",
  );
  assert.equal(isKeyVolumeLevelActive(level, complete[5].openTime + m15), false);
  assert.equal(isKeyVolumeLevelActive(level, level.confirmedAt), true);

  // Thêm nến tương lai không được đổi key đã quan sát được.
  const withFuture = detectKeyVolumeLevels(
    [...complete, candle(7, 102, 110, 101, 109, 100, m15), candle(8, 109, 110, 108, 109, 100, m15)],
    "15m",
    params,
  );
  assert.deepEqual(withFuture[0], level);
}

/** "Nến đang ở trên volume thì long, ở dưới thì short." */
function testDirectionAgainstKey(): void {
  // Key là một ĐƯỜNG: không còn "bên trong vùng", chỉ còn trên hoặc dưới.
  const level: KeyVolumeLevel = {
    id: "15m:0",
    sourceTf: "15m",
    price: 100.5,
    zoneLow: 100.5,
    zoneHigh: 100.5,
    eventTime: 0,
    confirmedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    volumeRatio: 3,
  };
  assert.equal(directionAgainstKey(101.5, level), "long");
  assert.equal(directionAgainstKey(100.4, level), "short");
  assert.equal(directionAgainstKey(100.5, level), "long", "đóng đúng trên đường -> đỡ");
  assert.equal(directionAgainstKey(99, level), "short");
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

/** Stop hunt: vượt cực trị rồi rút râu đóng lại trong biên. */
function testSweepAndReclaim(): void {
  const longBars = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 98, 99),
    candle(2, 99, 100, 97, 98),
    candle(3, 98, 101, 96, 99),
  ];
  assert.equal(sweptAndReclaimed(longBars, 3, "long", 3), true);
  // Thủng đáy mà ĐÓNG luôn dưới đáy thì là phá thật, không phải săn thanh khoản.
  const brokeDown = [...longBars.slice(0, 3), candle(3, 98, 98.5, 96, 96.5)];
  assert.equal(sweptAndReclaimed(brokeDown, 3, "long", 3), false);

  const shortBars = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 102, 99, 101),
    candle(2, 101, 103, 100, 102),
    candle(3, 102, 104, 99, 101),
  ];
  assert.equal(sweptAndReclaimed(shortBars, 3, "short", 3), true);
  const brokeUp = [...shortBars.slice(0, 3), candle(3, 102, 104, 102.5, 103.5)];
  assert.equal(sweptAndReclaimed(brokeUp, 3, "short", 3), false);
}

type M15Bar = { open: number; high: number; low: number; close: number; volume: number };

/** Engine chạy thẳng trên M15 nên fixture đẩy đúng MỘT nến mỗi lần. */
function pushM15(bars: Candle[], bar: M15Bar): void {
  bars.push({
    openTime: bars.length * TF_MS["15m"],
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    quoteVolume: bar.volume,
    takerBuyVolume: bar.volume / 2,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE A — NHÁNH QUÉT. Cố ý KHÔNG có một nến volume đột biến nào, để chứng
// minh nhánh này chạy được khi trong dữ liệu không tồn tại một key nào cả.
// ─────────────────────────────────────────────────────────────────────────────
// 480 nến cửa sổ quét + 96 nến kiểm nổi bật = 576 nến lịch sử tối thiểu.
const SWEEP_BAR = 600;
/** Biên phẳng: mọi nến cùng OHLC nên không nến nào tự phá cực trị của chính nó. */
const BAND: M15Bar = { open: 100.2, high: 101.0, low: 99.5, close: 100.3, volume: 100 };

function buildSweepFixture(sweepBar: M15Bar, after: M15Bar[]): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < SWEEP_BAR; i++) pushM15(bars, BAND);
  pushM15(bars, sweepBar);
  for (const bar of after) pushM15(bars, bar);
  return bars;
}

/**
 * Quét ĐÁY biên rồi đóng lại trong biên -> LONG. Hộp = thân cây quét
 * [100.2, 100.3]. Ba nến kế phải ĐÓNG trên 100.3 (cửa rời hộp), rồi giá QUAY
 * LẠI chạm hộp, rồi một nến XANH dính hộp và ĐÓNG vượt 100.3 -> vào ở giá đóng
 * đó, rồi chạy lên 101.0.
 */
function longSweepFixture(): Candle[] {
  return buildSweepFixture(
    { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 },
    [
      { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
      { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
      { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
      // Quay lại hộp: đóng cửa HẲN bên trong [100.2, 100.3].
      { open: 100.6, high: 100.62, low: 100.24, close: 100.26, volume: 100 },
      // Nến xác nhận: dính hộp, XANH, đóng vượt mép trên -> vào @ 100.45.
      { open: 100.24, high: 100.5, low: 100.22, close: 100.45, volume: 100 },
      { open: 100.45, high: 100.9, low: 100.4, close: 100.85, volume: 100 },
      { open: 100.85, high: 101.3, low: 100.8, close: 101.2, volume: 100 },
      BAND,
      BAND,
    ],
  );
}

/** Cây đầu tiên sau cửa rời hộp — chỗ hộp được TRANG BỊ và bắt đầu canh retest. */
const SWEEP_READY = SWEEP_BAR + 1 + KEY_VOLUME_CONFIG.obDepartBars;
/** Nến xác nhận bật ra khỏi hộp — nến ngay sau nến quay lại. */
const SWEEP_ENTRY = SWEEP_READY + 1;
/** Giá đóng của nến xác nhận, tức GIÁ VÀO thật. */
const SWEEP_ENTRY_PRICE = 100.45;

const SWEEP_OVERRIDES = { ...KEY_VOLUME_CONFIG, minRR: 0, requireStructuralTarget: false };

/**
 * Yêu cầu chính của đợt sửa này: nhánh quét KHÔNG cần key volume. Fixture không
 * chứa key nào, nên nếu nhánh này vẫn ra lệnh thì nó thật sự đứng độc lập.
 */
function testSweepBranchNeedsNoKey(): void {
  const bars = longSweepFixture();
  const result = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES);

  assert.equal(result.levels.length, 0, "fixture cố ý không có nến volume đột biến nào");
  assert.equal(result.diagnostics.keyTouches, 0, "không có key thì không thể có nến chạm key");
  assert.equal(result.diagnostics.candlePatterns, 0, "nhánh quét không đi qua gate mô hình nến");
  assert.equal(result.diagnostics.volumeBranchPlans, 0);

  assert.equal(result.plans.length, 1, "đúng một cú quét trong fixture");
  const plan = result.plans[0];
  assert.equal(plan.branch, "sweep-reclaim");
  assert.equal(plan.key, null, "nhánh quét không được mang key nào");
  assert.equal(plan.direction, "long", "quét ĐÁY thì vào LONG");
  assert.equal(
    plan.readyIndex, SWEEP_READY,
    "hộp được trang bị sau khi giá rời hộp trọn obDepartBars nến, không phải ngay nến sau nến quét",
  );

  const trade = result.trades[0];
  assert.ok(trade, "kế hoạch phải thành lệnh thật");
  assert.equal(trade.branch, "sweep-reclaim");
  assert.equal(trade.keyPrice, null);
  assert.equal(trade.keyVolumeRatio, null);
  const sweep = bars[SWEEP_BAR];
  assert.equal(plan.clusterBars, 1, "nhánh quét: cụm là đúng cây nến quét");
  assert.equal(plan.obLow, Math.min(sweep.open, sweep.close));
  assert.equal(plan.obHigh, Math.max(sweep.open, sweep.close));
  assert.equal(plan.obEntryEdge, plan.obHigh, "long phải đóng vượt mép TRÊN hộp");
  // Giá vào là GIÁ ĐÓNG nến xác nhận, KHÔNG phải mép hộp: mép là 100.3 nhưng
  // nến bật ra đóng ở 100.45, và đó mới là chỗ lệnh thật vào được.
  assert.ok(
    Math.abs(trade.entryPrice - SWEEP_ENTRY_PRICE) < 1e-9,
    "vào ở giá ĐÓNG nến xác nhận",
  );
  assert.ok(trade.entryPrice > plan.obEntryEdge, "giá vào lùi xa mép hộp, không bằng mép");
  assert.equal(
    trade.entryTime, bars[SWEEP_ENTRY].openTime,
    "vào ở nến BẬT RA, không phải nến quay lại hộp",
  );
  assert.equal(result.diagnostics.boxesArmed, 1);
  assert.equal(result.diagnostics.boxesRetouched, 1);
}

/** SL bám mép ĐỐI DIỆN của hộp order block, TP bám cụm thanh khoản đối diện. */
function testSweepBranchStopAndTarget(): void {
  const longResult = runKeyVolume("synthetic", longSweepFixture(), SWEEP_OVERRIDES);
  const longPlan = longResult.plans[0];
  assert.equal(longPlan.structuralStop, 99.0, "gốc SL của luật CŨ là đáy râu quét");
  assert.equal(longPlan.sweepTarget, 101.0, "TP là ĐỈNH của đúng cửa sổ 480 nến đó");
  const longTrade = longResult.trades[0];
  // Luật mới: SL dưới mép THÂN (100.2) một chút, tức NẰM TRONG vùng râu quét
  // (99.0). Đây là đánh đổi đã chọn của hộp bỏ râu, không phải lỗi.
  assert.ok(longTrade.initialSL < longPlan.obLow, "SL phải nằm ngoài mép dưới hộp");
  assert.ok(longTrade.initialSL > 99.0, "SL mới nằm TRONG râu quét, không còn ngoài râu");
  assert.ok(Math.abs(longTrade.target - 101.0) < 1e-9, "chạm đúng mức thanh khoản đối diện");
  assert.equal(longTrade.exitReason, "target");

  // Gương lại: quét ĐỈNH biên rồi đóng lại trong biên -> SHORT.
  const shortBars = buildSweepFixture(
    { open: 100.3, high: 102.0, low: 100.2, close: 100.4, volume: 100 },
    [
      { open: 100.25, high: 100.28, low: 100.0, close: 100.05, volume: 100 },
      { open: 100.05, high: 100.1, low: 99.9, close: 99.95, volume: 100 },
      { open: 99.95, high: 100.0, low: 99.85, close: 99.9, volume: 100 },
      // Quay lại hộp: đóng cửa HẲN bên trong [100.3, 100.4].
      { open: 99.95, high: 100.38, low: 99.9, close: 100.34, volume: 100 },
      // Nến xác nhận: dính hộp, ĐỎ, đóng dưới mép dưới -> vào @ 100.15.
      { open: 100.36, high: 100.38, low: 100.1, close: 100.15, volume: 100 },
      { open: 100.15, high: 100.2, low: 99.7, close: 99.75, volume: 100 },
      { open: 99.75, high: 99.8, low: 99.2, close: 99.3, volume: 100 },
      BAND,
      BAND,
    ],
  );
  const shortResult = runKeyVolume("synthetic", shortBars, SWEEP_OVERRIDES);
  assert.equal(shortResult.levels.length, 0);
  const shortPlan = shortResult.plans[0];
  assert.equal(shortPlan.direction, "short", "quét ĐỈNH thì vào SHORT");
  assert.equal(shortPlan.structuralStop, 102.0, "gốc SL của luật CŨ là đỉnh râu quét");
  assert.equal(shortPlan.sweepTarget, 99.5, "TP là ĐÁY của đúng cửa sổ 480 nến đó");
  assert.equal(shortPlan.obEntryEdge, shortPlan.obLow, "short phải đóng thủng mép DƯỚI hộp");
  const shortTrade = shortResult.trades[0];
  assert.ok(Math.abs(shortTrade.entryPrice - 100.15) < 1e-9, "vào ở giá ĐÓNG nến xác nhận");
  assert.ok(shortTrade.entryPrice < shortPlan.obEntryEdge, "giá vào lùi xa mép hộp");
  assert.ok(shortTrade.initialSL > shortPlan.obHigh, "SL phải nằm ngoài mép trên hộp");
  assert.ok(shortTrade.initialSL < 102.0, "SL mới nằm TRONG râu quét");
}

/** Nhánh quét vẫn phải qua cửa dư địa chung, không được miễn trừ. */
function testSweepBranchStillFacesRoomGate(): void {
  const bars = longSweepFixture();
  const strict = runKeyVolume("synthetic", bars, KEY_VOLUME_CONFIG);
  assert.equal(strict.plans.length, 1, "kế hoạch vẫn hình thành");
  assert.equal(strict.trades.length, 0, "nhưng dư địa không qua nổi minRR=3");
  assert.ok(strict.diagnostics.rejectedRoom >= 1);
  assert.equal(strict.diagnostics.boxesArmed, 1, "hộp vẫn được trang bị và canh retest");
  assert.equal(strict.diagnostics.boxesRetouched, 1, "giá vẫn quay lại hộp");
  assert.equal(strict.diagnostics.entries, 0, "cửa dư địa chấm ở NẾN XÁC NHẬN mới chặn được");
}

/** Nến quét cả hai đầu rồi đóng vào trong không nói được chiều nào -> bỏ. */
function testAmbiguousSweepIsSkipped(): void {
  const bars = buildSweepFixture(
    { open: 100.3, high: 102.0, low: 99.0, close: 100.2, volume: 100 },
    [BAND, BAND, BAND, BAND, BAND],
  );
  const result = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES);
  assert.equal(result.diagnostics.sweeps, 1, "vẫn phải ĐẾM là một cú quét");
  assert.equal(result.diagnostics.sweepBranchPlans, 0, "nhưng không được sinh kế hoạch");
  assert.equal(result.plans.length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE B — NHÁNH 2 vẫn dùng key như cũ.
// ─────────────────────────────────────────────────────────────────────────────
function rangeBar(index: number): M15Bar {
  return index % 2 === 0
    ? { open: 100.95, high: 101.1, low: 100.9, close: 101.05, volume: 100 }
    : { open: 101.05, high: 101.1, low: 100.9, close: 100.95, volume: 100 };
}

const KEY_BAR = 100;
// Phải nằm NGOÀI cửa sổ quét 480 nến của nến bóp cò, nếu không râu dài của nến
// key sẽ thành cực trị cửa sổ và nuốt mất cú quét mà fixture muốn dựng.
const TRIGGER_BAR = 700;
const RALLY_BARS = 14;

/**
 * key M15 -> giá quay lại chạm -> cụm nến đảo chiều -> giá ĐÓNG ngoài hộp 3 nến
 * -> quay lại hộp -> nến xanh bật ra khỏi hộp -> vào ở giá đóng -> chạy tới mục
 * tiêu.
 *
 * Cây bóp cò nhấn chìm thân CẢ HAI nến trước (cả hai đều là thân
 * 100,95–101,05), nên rơi vào TH1: hộp là thân của đúng hai nến BỊ nhấn chìm.
 */
const AFTER_TRIGGER: M15Bar[] = [
  // Ba nến rời hộp: close phải trên 101,05 (nhánh key) và 101,1 (nhánh quét).
  { open: 101.15, high: 101.4, low: 101.13, close: 101.35, volume: 100 },
  { open: 101.35, high: 101.55, low: 101.3, close: 101.5, volume: 100 },
  { open: 101.5, high: 101.65, low: 101.45, close: 101.6, volume: 100 },
  // Quay lại hộp: đóng cửa HẲN bên trong [100,95 – 101,05].
  { open: 101.55, high: 101.6, low: 101.0, close: 101.02, volume: 100 },
  // Nến xác nhận: dính hộp, XANH, đóng vượt 101,05 -> vào @ 101.55.
  { open: 101.0, high: 101.6, low: 100.98, close: 101.55, volume: 100 },
  { open: 101.55, high: 101.95, low: 101.5, close: 101.9, volume: 100 },
  { open: 101.9, high: 102.4, low: 101.85, close: 102.35, volume: 100 },
  { open: 102.35, high: 102.85, low: 102.3, close: 102.8, volume: 100 },
  { open: 102.8, high: 103.3, low: 102.75, close: 103.25, volume: 100 },
  { open: 103.25, high: 103.75, low: 103.2, close: 103.7, volume: 100 },
  // Vào ở giá đóng thì R tính bằng GIÁ to hơn hẳn luật lệnh chờ cũ (0,61 thay
  // vì 0,18), nên mục tiêu 5R nằm ở 104,6 chứ không còn ở 101,9. Đợt chạy phải
  // dài ra đúng theo — đây là hệ quả kinh tế thật của luật mới, không phải nhồi
  // fixture cho vừa.
  { open: 103.7, high: 104.2, low: 103.65, close: 104.15, volume: 100 },
  { open: 104.15, high: 104.65, low: 104.1, close: 104.6, volume: 100 },
  { open: 104.6, high: 105.1, low: 104.55, close: 105.05, volume: 100 },
  { open: 105.05, high: 105.55, low: 105.0, close: 105.5, volume: 100 },
];

/**
 * Đoạn giá RỜI HẲN key rồi quay lại — điều kiện `departedFromKey`. Không có nó
 * thì fixture chỉ là một đoạn đi ngang đè lên key, đúng thứ luật mới loại.
 * Đặt trước nến chạm và nằm trong cửa sổ nhìn lại 20 nến.
 */
const EXCURSION_FROM = TRIGGER_BAR - 14;
const EXCURSION: M15Bar[] = [
  { open: 101.05, high: 101.6, low: 101.0, close: 101.55, volume: 100 },
  { open: 101.55, high: 102.1, low: 101.5, close: 102.05, volume: 100 },
  { open: 102.05, high: 102.2, low: 101.95, close: 102.1, volume: 100 },
  { open: 102.1, high: 102.15, low: 101.9, close: 101.95, volume: 100 },
  { open: 101.95, high: 102.0, low: 101.4, close: 101.45, volume: 100 },
  { open: 101.45, high: 101.5, low: 101.0, close: 101.05, volume: 100 },
];

/**
 * `withExcursion: false` bỏ đoạn rời key -> fixture thành đúng ca "giá đi ngang
 * đè lên key". `offKey: true` đẩy THÂN hai nến bị nhấn chìm lên hẳn TRÊN key,
 * để hộp order block không còn chứa key.
 */
function buildKeyFixture(
  options: { withExcursion?: boolean; offKey?: boolean } = {},
): Candle[] {
  const { withExcursion = true, offKey = false } = options;
  const bars: Candle[] = [];
  for (let i = 0; i <= TRIGGER_BAR + RALLY_BARS; i++) {
    if (offKey && (i === TRIGGER_BAR - 2 || i === TRIGGER_BAR - 1)) {
      // Thân [101,15 – 101,25]: hộp sẽ nằm hẳn trên đường key 101,0.
      pushM15(bars, { open: 101.15, high: 101.3, low: 101.05, close: 101.25, volume: 100 });
    } else if (offKey && i === TRIGGER_BAR) {
      // Vẫn nhấn chìm trọn hai thân đó, vẫn xanh, vẫn đủ volume ×1,5.
      pushM15(bars, { open: 101.1, high: 101.4, low: 100.95, close: 101.3, volume: 150 });
    } else if (withExcursion && i >= EXCURSION_FROM && i < EXCURSION_FROM + EXCURSION.length) {
      pushM15(bars, EXCURSION[i - EXCURSION_FROM]);
    } else if (i === KEY_BAR) {
      // Nến volume đột biến: râu dài xuống, hai bên đều volume 100 -> ×20.
      pushM15(bars, { open: 101.0, high: 101.1, low: 100.0, close: 100.9, volume: 2000 });
    } else if (i === TRIGGER_BAR) {
      // Nhấn chìm thân hai nến liền trước, volume ×1.5.
      pushM15(bars, { open: 100.9, high: 101.15, low: 100.5, close: 101.1, volume: 150 });
    } else if (i > TRIGGER_BAR) {
      pushM15(bars, AFTER_TRIGGER[i - TRIGGER_BAR - 1]);
    } else {
      pushM15(bars, rangeBar(i));
    }
  }
  return bars;
}

/** Cây đầu tiên sau cửa rời hộp của fixture B — chỗ hộp được trang bị. */
const KEY_READY = TRIGGER_BAR + 1 + KEY_VOLUME_CONFIG.obDepartBars;
/** Nến xác nhận bật ra khỏi hộp của fixture B. */
const KEY_ENTRY = KEY_READY + 1;

const KEY_OVERRIDES = {
  ...KEY_VOLUME_CONFIG,
  minRR: 0,
  requireStructuralTarget: false,
  // Tắt nhánh quét để đo riêng nhánh key: nến bóp cò của fixture VỪA nhấn chìm
  // VỪA quét đáy biên, nên để bật cả hai thì không tách được công của ai.
  enableSweepBranch: false,
};

function testVolumeBranchStillNeedsKey(): void {
  const bars = buildKeyFixture();
  const result = runKeyVolume("synthetic", bars, KEY_OVERRIDES);
  assert.equal(result.levels.length, 1, "chỉ một nến volume đủ ngưỡng ×2 trong fixture");
  assert.equal(result.diagnostics.sweeps, 0, "tắt nhánh quét thì không chấm cú quét nào");

  const plan = result.plans.find((item) => item.branch === "volume-reversal");
  assert.ok(plan, "nhánh nến đảo + volume phải bóp cò được");
  assert.ok(plan.key, "nhánh 2 BẮT BUỘC có key");
  assert.equal(plan.sweepTarget, null, "nhánh 2 không dùng thanh khoản đối diện");
  assert.equal(plan.direction, "long", "giá đóng trên đường key -> LONG");
  assert.equal(plan.readyIndex, KEY_READY);
  // TH1: nhấn chìm thân CẢ HAI nến trước -> hộp là thân của đúng hai nến đó.
  assert.equal(plan.clusterBars, 3);
  assert.ok(Math.abs(plan.obLow - 100.95) < 1e-9);
  assert.ok(Math.abs(plan.obHigh - 101.05) < 1e-9);
  assert.equal(plan.obEntryEdge, plan.obHigh);
  assert.ok(Math.abs(plan.structuralStop - 100.5) < 1e-9, "SL bám cửa sổ chạm->bóp cò");
  assert.ok(plan.triggerVolumeRatio >= KEY_VOLUME_CONFIG.reversalVolumeMult);

  const trade = result.trades[0];
  assert.ok(trade, "kế hoạch phải thành lệnh thật");
  assert.equal(trade.branch, "volume-reversal");
  assert.equal(trade.keyPrice, plan.key.price);
  assert.ok(
    Math.abs(trade.entryPrice - 101.55) < 1e-9,
    "vào ở giá ĐÓNG nến bật ra khỏi hộp, không phải mép hộp 101,05",
  );
  assert.equal(trade.entryTime, bars[KEY_ENTRY].openTime);
  assert.equal(trade.exitReason, "target");

  // Nâng ngưỡng volume lên trên ×1.5 thì nhánh 2 phải im.
  const tooHigh = runKeyVolume("synthetic", bars, { ...KEY_OVERRIDES, reversalVolumeMult: 3 });
  assert.equal(tooHigh.plans.length, 0);
}

/**
 * "Khi mà nến quay về": chạm key chỉ tính khi giá đã TỪNG rời hẳn key. Bỏ đoạn
 * rời key ra khỏi fixture thì nó thành một đoạn đi ngang đè lên mức — và luật
 * phải im hoàn toàn.
 */
function testKeyTouchNeedsARealReturn(): void {
  const withReturn = runKeyVolume("synthetic", buildKeyFixture(), KEY_OVERRIDES);
  assert.equal(withReturn.plans.length, 1, "có cú rời-rồi-về thì vẫn ra kế hoạch");
  assert.ok(withReturn.diagnostics.candlePatterns > 0);

  const sideways = runKeyVolume(
    "synthetic",
    buildKeyFixture({ withExcursion: false }),
    KEY_OVERRIDES,
  );
  assert.ok(
    sideways.diagnostics.keyTouches > 100,
    "giá vẫn chạm key liên tục — cửa mới không phải chặn ở khâu chạm",
  );
  assert.ok(
    sideways.diagnostics.rejectedNoDeparture > sideways.diagnostics.keyTouches * 0.9,
    "gần như mọi lần chạm đều bị loại vì chưa từng rời key",
  );
  assert.equal(sideways.plans.length, 0, "đi ngang đè lên key thì KHÔNG ra kế hoạch nào");

  // Tắt cửa thì fixture đi ngang phải ra lệnh trở lại — chứng minh chính cửa
  // này là thứ chặn, không phải một thay đổi nào khác của fixture.
  const gateOff = runKeyVolume(
    "synthetic",
    buildKeyFixture({ withExcursion: false }),
    { ...KEY_OVERRIDES, keyDepartureLookback: 0 },
  );
  assert.ok(gateOff.plans.length > 0, "tắt cửa rời-key thì đoạn đi ngang lại ra kế hoạch");
}

/**
 * "Cụm chỉ detect ở khu vực key volume": đường key phải chạy XUYÊN thân hộp
 * order block. Cụm hình thành sát key nhưng hộp nằm hẳn một bên là KHÔNG tính.
 */
function testKeyMustBeInsideTheBlock(): void {
  const bars = buildKeyFixture({ offKey: true });

  const gateOn = runKeyVolume("synthetic", bars, KEY_OVERRIDES);
  assert.ok(
    gateOn.diagnostics.rejectedKeyOutsideBlock > 0,
    "hộp nằm hẳn trên key phải bị đếm là loại",
  );
  assert.equal(gateOn.plans.length, 0, "key ngoài hộp thì không thành kế hoạch");

  const gateOff = runKeyVolume(
    "synthetic",
    bars,
    { ...KEY_OVERRIDES, requireKeyInsideBlock: false },
  );
  assert.equal(gateOff.diagnostics.rejectedKeyOutsideBlock, 0);
  assert.ok(
    gateOff.plans.length > 0,
    "tắt cửa thì CÙNG dữ liệu đó ra kế hoạch — chính cửa này là thứ chặn",
  );
  assert.ok(
    gateOff.diagnostics.candlePatterns > gateOn.diagnostics.candlePatterns,
    "tắt cửa thì đếm được nhiều cụm hơn",
  );
}

/** Hai nhánh cùng bóp cò một nến: nhánh có score cao hơn được chọn. */
function testBothBranchesOnSameBar(): void {
  const result = runKeyVolume("synthetic", buildKeyFixture(), {
    ...KEY_OVERRIDES,
    enableSweepBranch: true,
  });
  const ready = result.plans.filter((plan) => plan.readyIndex === KEY_READY);
  assert.equal(ready.length, 2, "nến bóp cò vừa nhấn chìm tại key vừa quét đáy biên");
  assert.deepEqual(
    ready.map((plan) => plan.branch).sort(),
    ["sweep-reclaim", "volume-reversal"],
  );
  assert.equal(result.trades.length, 1, "một thời điểm chỉ vào một lệnh");
  assert.equal(result.trades[0].branch, "volume-reversal", "score có key cao hơn");
}

/** Nến M15 đầu tiên sau entry phải được mô phỏng, không được bỏ qua. */
/**
 * 15 phút rủi ro ĐẦU TIÊN là cây ngay SAU nến vào lệnh — vào ở giá đóng thì nến
 * vào lệnh đã đóng xong, không được lấy high/low của chính nó ra chấm SL/TP.
 */
function testStopOnFirstRiskBar(): void {
  const bars = longSweepFixture();
  const plan = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES).plans[0];
  const adverse = bars.map((bar) => ({ ...bar }));
  adverse[SWEEP_ENTRY + 1].low = plan.obLow - 5;
  const result = runKeyVolume("synthetic", adverse, SWEEP_OVERRIDES);
  const stopped = result.trades[0];
  assert.ok(stopped, "cây ngay sau entry phải được đưa qua mô phỏng");
  assert.equal(stopped.exitReason, "stop");
  assert.equal(stopped.entryTime, bars[SWEEP_ENTRY].openTime);
  assert.equal(stopped.exitTime, bars[SWEEP_ENTRY + 1].openTime);
  assert.equal(stopped.holdBars, 1);
}

/** Một nến chạm CẢ SL lẫn mục tiêu: không có M5 để phân xử -> tính STOP. */
function testSameBarStopBeatsTarget(): void {
  const bars = longSweepFixture();
  const plan = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES).plans[0];
  const both = bars.map((bar) => ({ ...bar }));
  const riskBar = both[SWEEP_ENTRY + 1];
  riskBar.low = plan.obLow - 5;
  riskBar.high = (plan.sweepTarget as number) + 5;
  const result = runKeyVolume("synthetic", both, SWEEP_OVERRIDES);
  assert.equal(result.trades[0].exitReason, "stop", "chạm cả hai thì phải tính STOP");
}

function testNoLookaheadOnPlans(): void {
  const bars = longSweepFixture();
  const full = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES);
  const cutoff = SWEEP_READY + 1;
  const prefix = runKeyVolume("synthetic", bars.slice(0, cutoff), SWEEP_OVERRIDES);
  assert.deepEqual(
    full.plans.filter((plan) => plan.readyIndex < cutoff).map((plan) => plan.id),
    prefix.plans.map((plan) => plan.id),
  );
  assert.ok(prefix.plans.length >= 1);
}

/**
 * Luật cụm MỚI: chỉ xét thân cây đảo chiều nhấn chìm thân mấy nến liền trước.
 * Số nến bị nhấn chìm quyết định luôn hộp order block.
 */
function testReversalOrderBlockCases(): void {
  // TH1 — nhấn chìm thân CẢ HAI nến trước -> hộp là thân của đúng hai nến ĐÓ.
  const two = [
    candle(0, 10.0, 10.3, 9.8, 9.9),
    candle(1, 9.9, 10.2, 9.7, 10.1),
    candle(2, 9.5, 10.9, 9.3, 10.6),
  ];
  assert.equal(bodyEngulfs(two, 2, 1), true);
  assert.equal(bodyEngulfs(two, 2, 0), true);
  const first = reversalOrderBlock(two, 2, "long");
  assert.ok(first);
  assert.equal(first.engulfed, 2);
  assert.equal(first.clusterBars, 3);
  assert.equal(first.obHigh, 10.1, "mép trên = max open/close của hai nến BỊ nhấn chìm");
  assert.equal(first.obLow, 9.9, "mép dưới = min open/close của hai nến BỊ nhấn chìm");
  assert.notEqual(first.obHigh, 10.6, "KHÔNG lấy thân cây đảo chiều ở TH1");

  // TH2 — chỉ nhấn chìm nến liền trước -> hộp là thân cây ĐANG nhấn chìm.
  const one = [
    candle(0, 10.0, 10.3, 9.0, 9.2),
    candle(1, 9.9, 10.2, 9.7, 10.1),
    candle(2, 9.5, 10.9, 9.3, 10.6),
  ];
  assert.equal(bodyEngulfs(one, 2, 0), false, "thân nến 0 xuống 9,2 nên nằm ngoài thân nến 2");
  const second = reversalOrderBlock(one, 2, "long");
  assert.ok(second);
  assert.equal(second.engulfed, 1);
  assert.equal(second.clusterBars, 2);
  assert.equal(second.obHigh, 10.6, "mép trên = close cây đảo chiều");
  assert.equal(second.obLow, 9.5, "mép dưới = open cây đảo chiều");

  // TH3 — không nhấn chìm nến nào -> không xét.
  const none = [
    candle(0, 10.0, 10.3, 9.8, 9.9),
    candle(1, 9.2, 10.4, 9.1, 10.3),
    candle(2, 9.5, 10.9, 9.3, 10.2),
  ];
  assert.equal(reversalOrderBlock(none, 2, "long"), null);

  // Sai màu thì không xét, dù nhấn chìm hoàn hảo.
  assert.equal(reversalOrderBlock(two, 2, "short"), null, "LONG bắt buộc nến XANH");
  const bear = [
    candle(0, 10.0, 10.3, 9.8, 9.9),
    candle(1, 9.9, 10.2, 9.7, 10.1),
    candle(2, 10.6, 10.9, 9.3, 9.5),
  ];
  const shortBox = reversalOrderBlock(bear, 2, "short");
  assert.ok(shortBox);
  assert.equal(shortBox.engulfed, 2);
  assert.equal(shortBox.obLow, 9.9);
  assert.equal(shortBox.obHigh, 10.1);
  assert.equal(reversalOrderBlock(bear, 2, "long"), null);

  // In3 và 3-bar reversal đã bị BỎ khỏi đường vào lệnh.
  const inside = [
    candle(0, 10.0, 10.3, 9.8, 9.9),
    candle(1, 10.0, 11.0, 9.0, 10.5),
    candle(2, 10.2, 10.8, 9.6, 10.4),
  ];
  assert.equal(reversalOrderBlock(inside, 2, "long"), null, "in3 không còn là tín hiệu");
}

/** Cửa RỜI HỘP: cả cây nến phải ra ngoài, râu cũng không được thò lại. */
function testDepartureGate(): void {
  const m15 = TF_MS["15m"];
  const obLow = 100, obHigh = 101;
  const above = (n: number) => candle(n, 101.5, 101.8, 101.2, 101.6, 100, m15);
  const clean = [above(0), above(1), above(2), above(3)];
  assert.equal(departedFromBlock(clean, 0, 3, "long", obLow, obHigh), true);

  const dip = clean.map((bar, i) =>
    i === 1 ? candle(1, 101.5, 101.8, 100.9, 101.6, 100, m15) : bar);
  assert.equal(
    departedFromBlock(dip, 0, 3, "long", obLow, obHigh), false,
    "một cây thò râu lại vào hộp là hỏng cả cửa",
  );

  assert.equal(
    departedFromBlock([above(0), above(1)], 0, 3, "long", obLow, obHigh), false,
    "thiếu nến để kiểm thì KHÔNG được coi như đã kiểm xong",
  );
  assert.equal(departedFromBlock(clean, 0, 0, "long", obLow, obHigh), true, "tắt cửa thì luôn qua");

  // Mode `close` chỉ đòi giá đóng cửa ra ngoài — râu được phép thò lại vào hộp.
  assert.equal(departedFromBlock(dip, 0, 3, "long", obLow, obHigh, "close"), true);
  const closeIn = clean.map((bar, i) =>
    i === 2 ? candle(2, 101.5, 101.8, 100.5, 100.9, 100, m15) : bar);
  assert.equal(departedFromBlock(closeIn, 0, 3, "long", obLow, obHigh, "close"), false);

  const below = [
    candle(0, 99.5, 99.9, 99.2, 99.4, 100, m15),
    candle(1, 99.4, 99.8, 99.1, 99.3, 100, m15),
    candle(2, 99.3, 99.7, 99.0, 99.2, 100, m15),
  ];
  assert.equal(departedFromBlock(below, 0, 3, "short", obLow, obHigh), true);
  const touch = below.map((bar, i) =>
    i === 1 ? candle(1, 99.4, 100.05, 99.1, 99.3, 100, m15) : bar);
  assert.equal(departedFromBlock(touch, 0, 3, "short", obLow, obHigh), false);
}

/** #22/#23: mô hình hai đỉnh / hai đáy tại key. */
function testDoubleTopBottom(): void {
  const swings = [
    { index: 5, confirmIndex: 7, type: "low" as const, price: 100 },
    { index: 20, confirmIndex: 22, type: "low" as const, price: 100.3 },
    { index: 30, confirmIndex: 32, type: "high" as const, price: 120 },
  ];
  assert.equal(hasDoubleTopBottom(swings, 40, "long", 1, 50), true);
  assert.equal(hasDoubleTopBottom(swings, 40, "long", 0.1, 50), false);
  assert.equal(hasDoubleTopBottom(swings, 40, "short", 1, 50), false);
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

/** #23/#43: sau stop dương, chạm key + kích volume lần nữa là vào lại được. */
function testReentryModes(): void {
  assert.equal(canReenterKey("long", 95, "positive-stop", 90, true, "deeper-sweep"), false);
  assert.equal(canReenterKey("long", 85, "positive-stop", 90, true, "deeper-sweep"), true);
  assert.equal(canReenterKey("long", 95, "positive-stop", 90, true, "volume-retouch"), true);
  assert.equal(canReenterKey("long", 95, "stop", 90, true, "volume-retouch"), false);
}


/**
 * Luật MỚI của phần quét: mức bị quét phải NỔI BẬT — đi ngược về trước 96 nến
 * tính từ chính cây tạo ra cực trị, không nến nào được vượt qua nó.
 *
 * Lọc này chỉ CẮN khi cực trị nằm sát ĐẦU cửa sổ quét: cây phá mức phải nằm
 * trước cửa sổ, vì nếu nó nằm trong cửa sổ thì chính nó đã là cực trị.
 */
function testSweepProminence(): void {
  const m15 = TF_MS["15m"];
  const bars: Candle[] = [];
  for (let i = 0; i < 600; i++) bars.push(candle(i, 100, 101, 99.5, 100, 100, m15));
  // Cửa sổ quét của nến 600 là [120, 600). Đáy cửa sổ nằm ở 150, sát đầu cửa sổ.
  bars[150] = candle(150, 100, 101, 99.0, 100, 100, m15);
  // Nến quét: thủng 99.0 rồi ĐÓNG lại trên nó.
  bars.push(candle(600, 100, 100.5, 98.5, 99.6, 100, m15));

  assert.equal(sweptAndReclaimed(bars, 600, "long", 480, 0), true, "tắt lọc thì đây là cú quét");
  assert.equal(
    sweptAndReclaimed(bars, 600, "long", 480, 96),
    true,
    "96 nến trước đáy 99.0 đều dừng ở 99.5 -> đáy nổi bật, cú quét được nhận",
  );

  // Cắm một đáy SÂU HƠN ở nến 100 — nằm NGOÀI cửa sổ quét nhưng nằm TRONG đoạn
  // 96 nến kiểm nổi bật của đáy 150. Đáy 150 mất tư cách.
  const shadowed = bars.map((bar) => ({ ...bar }));
  shadowed[100] = candle(100, 100, 101, 98.8, 100, 100, m15);
  assert.equal(shadowed[100].openTime, bars[100].openTime);
  assert.equal(
    sweptAndReclaimed(shadowed, 600, "long", 480, 96),
    false,
    "một nến trước đó đã xuống 98.8 -> đáy 99.0 không nổi bật, bỏ cú quét",
  );
  assert.equal(
    sweptAndReclaimed(shadowed, 600, "long", 480, 0),
    true,
    "vẫn đúng là cú quét, chỉ trượt cửa NỔI BẬT",
  );

  // Không đủ lịch sử để kiểm thì KHÔNG được coi như đã kiểm xong.
  assert.equal(isProminentExtreme(bars, 50, "low", 96), false);
  assert.equal(isProminentExtreme(bars, 50, "low", 0), true);
  // Bằng nhau không phải là "vượt qua": hai đáy ngang nhau vẫn nổi bật.
  assert.equal(isProminentExtreme(bars, 300, "low", 96), true);
}

/** Hộp luôn là THÂN nến, râu không bao giờ được tính. */
function testOrderBlockIgnoresWicks(): void {
  const bars = [
    candle(0, 10.0, 10.4, 9.4, 9.5),
    candle(1, 9.4, 10.6, 9.2, 10.5),
  ];
  const box = orderBlockFromCluster(bars, 1, 2);
  assert.equal(box.obHigh, 10.5, "không phải râu 10,6");
  assert.equal(box.obLow, 9.4, "không phải râu 9,2");
  assert.equal(orderBlockEntry(box, "long"), box.obHigh);
  assert.equal(orderBlockEntry(box, "short"), box.obLow);

  const single = orderBlockFromCluster(bars, 0, 1);
  assert.equal(single.obHigh, 10.0);
  assert.equal(single.obLow, 9.5);
}

/** Cú quét hợp lệ nhưng giá ĐÓNG chưa rời hộp -> không có order block, không có lệnh. */
function testSweepWithoutDepartureIsDropped(): void {
  const bars = buildSweepFixture(
    { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 },
    [
      { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
      // Râu thò lại vào hộp KHÔNG còn làm hỏng cửa nữa (mode "close")...
      { open: 100.55, high: 100.7, low: 100.28, close: 100.6, volume: 100 },
      // ...nhưng cây này ĐÓNG ở 100,28, tức HẲN trong hộp [100,2 – 100,3].
      { open: 100.6, high: 100.75, low: 100.22, close: 100.28, volume: 100 },
      BAND, BAND, BAND,
    ],
  );
  const result = runKeyVolume("synthetic", bars, SWEEP_OVERRIDES);
  assert.equal(result.diagnostics.sweeps, 1, "vẫn đếm là một cú quét");
  assert.equal(result.diagnostics.rejectedDepart, 1);
  assert.equal(result.plans.length, 0, "không rời hộp thì không sinh kế hoạch");
  assert.equal(result.trades.length, 0);
}

/**
 * Hộp đã trang bị mà giá không quay lại thì im lặng chờ, và HẾT ĐÚNG
 * `boxWaitBars` nến là bỏ — không được lén thành lệnh, và cũng không được sống
 * quá hạn. Đây là chi phí bỏ lỡ có thật của luật retest, nên `boxesArmed` /
 * `boxesRetouched` / `boxesExpired` phải tách được ba trạng thái đó ra.
 */
function testArmedBoxExpiresAfterTwoDays(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  // Mép trên hộp = max(open, close) = 100.3. Mấy nến này vừa qua cửa rời hộp
  // vừa không bao giờ hồi lại chạm 100.3.
  const away: M15Bar = { open: 100.5, high: 100.9, low: 100.4, close: 100.85, volume: 100 };
  const wait = KEY_VOLUME_CONFIG.boxWaitBars;

  // Chưa tới hạn: hộp còn TREO, chưa hết hạn.
  const stillWatching = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, Array.from({ length: KEY_VOLUME_CONFIG.obDepartBars + 5 }, () => away)),
    SWEEP_OVERRIDES,
  );
  assert.equal(stillWatching.diagnostics.rejectedDepart, 0, "giá đã rời hộp đàng hoàng");
  assert.equal(stillWatching.diagnostics.boxesArmed, 1);
  assert.equal(stillWatching.diagnostics.boxesRetouched, 0, "giá bỏ chạy, không nến nào hồi về hộp");
  assert.equal(stillWatching.diagnostics.boxesExpired, 0, "chưa hết 2 ngày thì chưa bỏ hộp");
  assert.equal(stillWatching.diagnostics.boxesUnresolved, 1, "hộp còn treo khi hết dữ liệu");
  assert.equal(stillWatching.trades.length, 0);

  // Đủ dữ liệu vượt hạn: hộp phải HẾT HẠN, không còn treo.
  const timedOut = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, Array.from({ length: KEY_VOLUME_CONFIG.obDepartBars + wait + 2 }, () => away)),
    SWEEP_OVERRIDES,
  );
  assert.equal(timedOut.diagnostics.boxesArmed, 1);
  assert.equal(timedOut.diagnostics.boxesExpired, 1, "hết 2 ngày canh thì bỏ hộp");
  assert.equal(timedOut.diagnostics.boxesUnresolved, 0, "hết hạn rồi thì không còn treo");
  assert.equal(timedOut.diagnostics.entries, 0, "không quay lại thì không có lệnh nào");
  assert.equal(timedOut.diagnostics.boxesBroken, 0, "hết hạn KHÁC với bị phá");
  assert.equal(timedOut.trades.length, 0);
}

/**
 * Trần chờ là MỘT đồng hồ cho cả hai bước: giá quay lại hộp rồi vẫn phải bật ra
 * trước hạn, không được cộng thêm giờ. Nến xác nhận đến ĐÚNG cây hết hạn là
 * MUỘN — hộp đã bị dọn ở đầu cây đó.
 */
function testRetouchDoesNotExtendTheClock(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  const depart: M15Bar[] = [
    { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
    { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
    { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
  ];
  // Quay lại hộp ngay, rồi lởn vởn TRONG hộp cho tới quá hạn mà không bao giờ
  // đóng vượt mép trên (và cũng không đóng thủng mép dưới).
  const loiter: M15Bar = { open: 100.28, high: 100.29, low: 100.22, close: 100.24, volume: 100 };
  const wait = KEY_VOLUME_CONFIG.boxWaitBars;
  const after: M15Bar[] = [...depart, ...Array.from({ length: wait + 2 }, () => loiter)];

  const result = runKeyVolume("synthetic", buildSweepFixture(sweepBar, after), SWEEP_OVERRIDES);
  assert.equal(result.diagnostics.boxesRetouched, 1, "giá có quay lại hộp");
  assert.equal(result.diagnostics.boxesBroken, 0, "lởn vởn trong hộp KHÔNG phải bị phá");
  assert.equal(
    result.diagnostics.boxesExpired, 1,
    "quay lại rồi vẫn hết hạn đúng 2 ngày kể từ lúc trang bị",
  );
  assert.equal(result.diagnostics.entries, 0);
}

/**
 * BIÊN của trần chờ, đo bằng đúng hai lần chạy lệch nhau MỘT nến. Cây cuối còn
 * vào được là `readyIndex + boxWaitBars - 1`; cây sau đó hộp đã bị dọn.
 */
function testBoxWaitBoundaryIsExact(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  const depart: M15Bar[] = [
    { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
    { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
    { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
  ];
  // Nến quay lại hộp, rồi lởn vởn TRONG hộp, rồi nến xác nhận bật ra.
  const retouch: M15Bar = { open: 100.6, high: 100.62, low: 100.24, close: 100.26, volume: 100 };
  const loiter: M15Bar = { open: 100.28, high: 100.29, low: 100.22, close: 100.24, volume: 100 };
  const confirm: M15Bar = { open: 100.24, high: 100.5, low: 100.22, close: 100.45, volume: 100 };
  const runUp: M15Bar[] = [
    { open: 100.45, high: 100.9, low: 100.4, close: 100.85, volume: 100 },
    { open: 100.85, high: 101.3, low: 100.8, close: 101.2, volume: 100 },
    BAND, BAND,
  ];

  // `offset` = nến xác nhận nằm cách nến trang bị bao nhiêu cây.
  const runAtOffset = (offset: number) => runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, [
      ...depart,
      retouch,
      ...Array.from({ length: offset - 1 }, () => loiter),
      confirm,
      ...runUp,
    ]),
    SWEEP_OVERRIDES,
  );

  const wait = KEY_VOLUME_CONFIG.boxWaitBars;
  const inTime = runAtOffset(wait - 1);
  assert.equal(inTime.diagnostics.entries, 1, `cây thứ ${wait} vẫn còn trong hạn`);
  assert.equal(inTime.diagnostics.boxesExpired, 0);

  const tooLate = runAtOffset(wait);
  assert.equal(tooLate.diagnostics.entries, 0, `cây thứ ${wait + 1} là MUỘN`);
  assert.equal(tooLate.diagnostics.boxesExpired, 1, "hộp bị dọn ở đầu đúng cây đó");
}

/** Giá ĐÓNG xuyên hộp ngược chiều là hộp chết — không đuổi theo, không vào lệnh. */
function testArmedBoxDiesOnCloseThroughBox(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  const depart: M15Bar[] = [
    { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
    { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
    { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
  ];
  const result = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, [
      ...depart,
      // Rơi thẳng qua hộp: đóng ở 99.6, dưới hẳn obLow = 100.2.
      { open: 100.2, high: 100.25, low: 99.5, close: 99.6, volume: 100 },
      BAND, BAND, BAND,
    ]),
    SWEEP_OVERRIDES,
  );
  assert.equal(result.diagnostics.boxesArmed, 1);
  assert.equal(result.diagnostics.boxesBroken, 1, "đóng thủng hộp ngược chiều -> hộp chết");
  assert.equal(result.diagnostics.entries, 0);
  assert.equal(result.diagnostics.boxesUnresolved, 0, "hộp đã chết thì không còn treo");
  assert.equal(result.trades.length, 0);
}

/**
 * NẾN XANH mà vẫn ĐÓNG TRONG hộp thì CHƯA vào: hộp chưa đẩy được giá đi. Đây là
 * ranh giới sắc nhất của luật mới, và cũng là chỗ dễ cài lỏng nhất.
 */
function testGreenCandleClosingInsideBoxDoesNotEnter(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  const depart: M15Bar[] = [
    { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
    { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
    { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
  ];
  const insideOnly = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, [
      ...depart,
      // Quay lại hộp.
      { open: 100.6, high: 100.62, low: 100.24, close: 100.26, volume: 100 },
      // XANH, dính hộp, nhưng đóng ở 100.29 -> vẫn TRONG hộp [100.2, 100.3].
      { open: 100.24, high: 100.5, low: 100.22, close: 100.29, volume: 100 },
      BAND, BAND,
    ]),
    SWEEP_OVERRIDES,
  );
  assert.equal(insideOnly.diagnostics.boxesRetouched, 1, "giá có quay lại hộp");
  assert.equal(insideOnly.diagnostics.entries, 0, "xanh mà đóng trong hộp thì CHƯA vào");

  // Nến ĐỎ đóng vượt mép trên cũng không được: sai màu là sai chiều.
  const wrongColour = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, [
      ...depart,
      { open: 100.6, high: 100.62, low: 100.24, close: 100.26, volume: 100 },
      { open: 100.5, high: 100.55, low: 100.22, close: 100.45, volume: 100 },
      BAND, BAND,
    ]),
    SWEEP_OVERRIDES,
  );
  assert.equal(wrongColour.diagnostics.boxesRetouched, 1);
  assert.equal(wrongColour.diagnostics.entries, 0, "nến ĐỎ không mở được lệnh LONG");
}

/**
 * Nến xác nhận phải CÒN DÍNH hộp. Thiếu điều kiện này thì cờ "đã quay lại" treo
 * mãi, và một nến xanh cách hộp rất xa vẫn bóp cò được — cho ra giá vào vô nghĩa
 * và R khổng lồ.
 */
function testConfirmationMustStillTouchTheBox(): void {
  const sweepBar: M15Bar = { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 };
  const result = runKeyVolume(
    "synthetic",
    buildSweepFixture(sweepBar, [
      { open: 100.35, high: 100.6, low: 100.32, close: 100.55, volume: 100 },
      { open: 100.55, high: 100.7, low: 100.45, close: 100.6, volume: 100 },
      { open: 100.6, high: 100.75, low: 100.5, close: 100.65, volume: 100 },
      // Quay lại chạm hộp bằng râu, rồi đóng lại trên hộp.
      { open: 100.6, high: 100.65, low: 100.25, close: 100.4, volume: 100 },
      // XANH, đóng vượt mép trên, nhưng đáy 100.35 KHÔNG còn dính hộp.
      { open: 100.4, high: 100.9, low: 100.35, close: 100.85, volume: 100 },
      { open: 100.85, high: 101.3, low: 100.8, close: 101.2, volume: 100 },
      BAND, BAND,
    ]),
    SWEEP_OVERRIDES,
  );
  assert.equal(result.diagnostics.boxesRetouched, 1, "râu đã chạm hộp");
  assert.equal(
    result.diagnostics.entries, 0,
    "nến xanh rời hẳn hộp không được coi là BẬT RA khỏi hộp",
  );
}

/** Nến vào lệnh KHÔNG được tự chấm SL/TP trên chính high/low của nó. */
function testEntryBarIsNotItsOwnRiskBar(): void {
  const result = runKeyVolume("synthetic", longSweepFixture(), SWEEP_OVERRIDES);
  const trade = result.trades[0];
  assert.ok(trade, "fixture phải ra đúng một lệnh");
  assert.ok(trade.holdBars >= 1, "thoát sớm nhất là cây KẾ TIẾP nến vào lệnh");
  assert.ok(
    trade.exitTime > trade.entryTime,
    "vào ở giá đóng thì không thể thoát trong cùng cây nến đó",
  );
}

testMedians();
testSourceBackedDefaults();
testCenteredKeyWindowAndNoLookahead();
testDirectionAgainstKey();
testReversalOrderBlockCases();
testDepartureGate();
testDoubleTopBottom();
testSessionFilter();
testReentryModes();
testConditionalReentryAndLeverageCap();
testSweepAndReclaim();
testSweepBranchNeedsNoKey();
testSweepBranchStopAndTarget();
testSweepBranchStillFacesRoomGate();
testAmbiguousSweepIsSkipped();
testVolumeBranchStillNeedsKey();
testKeyTouchNeedsARealReturn();
testKeyMustBeInsideTheBlock();
testBothBranchesOnSameBar();
testStopOnFirstRiskBar();
testSameBarStopBeatsTarget();
testNoLookaheadOnPlans();
testSweepProminence();
testOrderBlockIgnoresWicks();
testSweepWithoutDepartureIsDropped();
testArmedBoxExpiresAfterTwoDays();
testRetouchDoesNotExtendTheClock();
testBoxWaitBoundaryIsExact();
testArmedBoxDiesOnCloseThroughBox();
testGreenCandleClosingInsideBoxDoesNotEnter();
testConfirmationMustStillTouchTheBox();
testEntryBarIsNotItsOwnRiskBar();
console.log("Key Volume tests: OK");
