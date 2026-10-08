import assert from "node:assert/strict";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeEntryPlan,
  KeyVolumeLevel,
  atrSeriesForward,
  canReenterKey,
  detectKeyVolumeLevels,
  directionAgainstKey,
  hasDoubleTopBottom,
  departedFromBlock,
  isProminentExtreme,
  orderBlockEntry,
  orderBlockFromCluster,
  reversalOrderBlock,
  rsiDivergenceAtKey,
  rsiSeries,
  findSweep,
  hasRisingSwings,
  matureKeyLevels,
  limitKeyTouches,
  capActiveKeyLevels,
  isWithinSession,
  isKeyVolumeLevelActive,
  medianAround,
  medianPrior,
  resolveEntryLevels,
  keyVolumeParamsFor,
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

  // Các nhánh vào lệnh đều bật.
  assert.equal(KEY_VOLUME_CONFIG.enableSweepBranch, true);
  assert.equal(KEY_VOLUME_CONFIG.enableVolumeReversalBranch, true);
  // User 03/10/26: trap qua key tối đa 16 nến M15 = 4 giờ, quay về "một đoạn" 0,5 ATR.
  assert.equal(KEY_VOLUME_CONFIG.enableKeyTrapBranch, true);
  assert.equal(KEY_VOLUME_CONFIG.keyTrapMaxBars, 16);
  assert.equal(KEY_VOLUME_CONFIG.keyTrapCloseAtr, 0.5);
  // User 04/10/26: nhánh 4 — một đỉnh thấp hơn sau phản ứng tại key, lệnh chờ ở mép OB.
  assert.equal(KEY_VOLUME_CONFIG.enableLowerHighBranch, true);
  assert.equal(KEY_VOLUME_CONFIG.lowerHighPivotBars, 1);
  // Volume của nhánh 2 phải NHẸ hơn hẳn ngưỡng sinh key.
  assert.ok(KEY_VOLUME_CONFIG.reversalVolumeMult > 1);
  assert.ok(KEY_VOLUME_CONFIG.reversalVolumeMult < KEY_VOLUME_CONFIG.volumeSpikeMult);

  // Cụm đảo chiều chỉ tính khi đảo chiều xảy ra NGAY TẠI key, và chỉ khi giá
  // thật sự QUAY VỀ key chứ không phải đi ngang đè lên nó.
  assert.equal(KEY_VOLUME_CONFIG.requireKeyInsideBlock, true);
  assert.equal(KEY_VOLUME_CONFIG.keyDepartureLookback, 20);
  assert.equal(KEY_VOLUME_CONFIG.keyDepartureAtr, 1);

  // Cụm đảo chiều là mũi nhọn, mức "vừa": V mỗi chân 2,0 ATR trong 3 nến, râu
  // dài 1,0 ATR, hai nến thân 0,8 ATR lấy lại 70%.
  assert.equal(KEY_VOLUME_CONFIG.vLegAtr, 2);
  assert.equal(KEY_VOLUME_CONFIG.vLegBars, 3);
  assert.equal(KEY_VOLUME_CONFIG.pinWickAtr, 1);
  assert.equal(KEY_VOLUME_CONFIG.twoBodyAtr, 0.8);
  assert.equal(KEY_VOLUME_CONFIG.twoRetrace, 0.7);

  // Tín hiệu A bật mặc định, song song với cụm: RSI(14), dung sai tại key 0,5
  // ATR, nhìn lại 96 nến tìm đáy 1, đáy 2 KHÔNG được cao hơn đáy 1.
  assert.equal(KEY_VOLUME_CONFIG.enableDivergenceSignal, true);
  assert.equal(KEY_VOLUME_CONFIG.rsiPeriod, 14);
  assert.equal(KEY_VOLUME_CONFIG.structureKeyAtr, 0.5);
  assert.equal(KEY_VOLUME_CONFIG.divergencePriceTolAtr, 0);
  assert.equal(KEY_VOLUME_CONFIG.divergenceLookbackBars, 96);
  // "Hai higher high rồi mới entry" là bước xác nhận, không còn là cò.
  assert.equal(KEY_VOLUME_CONFIG.requireSwingConfirmation, true);
  // Luật chín: rời 1 ATR -> chạm lại -> đóng bật 1 ATR trong 6 nến.
  assert.equal(KEY_VOLUME_CONFIG.requireKeyMaturation, true);
  assert.equal(KEY_VOLUME_CONFIG.keyMatureAwayAtr, 1);
  assert.equal(KEY_VOLUME_CONFIG.keyMatureBounceAtr, 1);
  assert.equal(KEY_VOLUME_CONFIG.keyMatureBars, 6);
  // Nhánh quét vào NGAY ở giá đóng nến rút râu / nến đóng lại, không ba bước hộp.
  assert.equal(KEY_VOLUME_CONFIG.sweepEntry, "order-block");
  // User 03/10/26: order block phải xong trong 4 giờ sau cú quét; vào ở mép hộp.
  assert.equal(KEY_VOLUME_CONFIG.sweepObWaitBars, 16);
  assert.equal(KEY_VOLUME_CONFIG.obLimitBars, 16);
  assert.equal(KEY_VOLUME_CONFIG.sweepMaxOutsideBars, 16);

  assert.equal(KEY_VOLUME_CONFIG.targetMode, "nearest-structure");
  assert.equal(KEY_VOLUME_CONFIG.requireStructuralTarget, true);
  // User 03/10/26: chạy được 1R thì chốt 0,33 khối lượng và dời SL về entry.
  assert.equal(KEY_VOLUME_CONFIG.partialAtR, 1);
  assert.equal(KEY_VOLUME_CONFIG.partialFraction, 0.33);
  assert.equal(KEY_VOLUME_CONFIG.trailMode, "none");
  // Cửa sổ dưới đếm bằng nến M15 nhưng phải giữ đúng độ dài THỜI GIAN cũ.
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
    maturedAt: 0,
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

/**
 * Fixture A được dựng cho luồng HỘP (rời hộp -> quay lại -> bật ra), nên các test
 * cơ chế hộp chạy nhánh quét ở luật cũ `box-retest`. Luật đang chạy — vào ngay ở
 * giá đóng nến rút râu — có test riêng `testSweepEntersAtReclaimClose`.
 */
const SWEEP_OVERRIDES = {
  ...KEY_VOLUME_CONFIG,
  minRR: 0,
  requireStructuralTarget: false,
  sweepEntry: "box-retest" as const,
};

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

/**
 * "SL sẽ đặt ở trên/dưới phần râu mới tạo": nhánh quét đặt SL ngay NGOÀI râu quét,
 * đệm 0,15 ATR của nến vào lệnh — không ở mép thân nến quét (mép đó nằm TRONG râu).
 * TP bám cụm thanh khoản đối diện.
 */
function testSweepBranchStopAndTarget(): void {
  const longBars = longSweepFixture();
  const longResult = runKeyVolume("synthetic", longBars, SWEEP_OVERRIDES);
  const longPlan = longResult.plans[0];
  assert.equal(longPlan.structuralStop, 99.0, "gốc SL là đáy râu quét");
  assert.equal(longPlan.sweepTarget, 101.0, "TP là ĐỈNH của đúng cửa sổ 480 nến đó");
  const longTrade = longResult.trades[0];
  const longAtr = atrSeriesForward(longBars)[SWEEP_ENTRY];
  assert.ok(
    Math.abs(longTrade.initialSL - (99.0 - KEY_VOLUME_CONFIG.stopBufferAtr * longAtr)) < 1e-9,
    "SL = đáy râu quét − 0,15 ATR",
  );
  assert.ok(longTrade.initialSL < 99.0, "SL nằm NGOÀI râu quét, không ở mép thân 100,2");
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
  const shortAtr = atrSeriesForward(shortBars)[SWEEP_ENTRY];
  assert.ok(
    Math.abs(shortTrade.initialSL - (102.0 + KEY_VOLUME_CONFIG.stopBufferAtr * shortAtr)) < 1e-9,
    "SL = đỉnh râu quét + 0,15 ATR",
  );
}

/** Nhánh quét vẫn phải qua cửa dư địa chung, không được miễn trừ. */
function testSweepBranchStillFacesRoomGate(): void {
  const bars = longSweepFixture();
  const strict = runKeyVolume("synthetic", bars, { ...KEY_VOLUME_CONFIG, sweepEntry: "reclaim-close" });
  // Cuối fixture còn một cú quét ĐỈNH kiểu chạy từ từ (nến 607 vượt 101,0, nến 608
  // đóng lại dưới) — vào thẳng thì không cần nến phía sau nên cú này cũng thành kế hoạch.
  assert.equal(strict.plans.filter((plan) => plan.direction === "long").length, 1, "kế hoạch vẫn hình thành");
  assert.equal(strict.trades.length, 0, "nhưng dư địa không qua nổi minRR=3");
  assert.ok(strict.diagnostics.rejectedRoom >= 1);
  assert.equal(strict.diagnostics.boxesArmed, 0, "vào thẳng ở nến rút râu nên không có hộp nào");
  assert.equal(strict.diagnostics.entries, 0, "cửa dư địa chấm ngay ở nến rút râu và chặn ở đó");

  // Luật cũ `box-retest`: cửa dư địa chấm ở NẾN XÁC NHẬN mới chặn được.
  const boxed = runKeyVolume("synthetic", bars, { ...KEY_VOLUME_CONFIG, sweepEntry: "box-retest" });
  assert.equal(boxed.trades.length, 0);
  assert.equal(boxed.diagnostics.boxesArmed, 1, "hộp vẫn được trang bị và canh retest");
  assert.equal(boxed.diagnostics.boxesRetouched, 1, "giá vẫn quay lại hộp");
}

/**
 * Luật cũ `reclaim-close` của nhánh quét: vào NGAY ở giá đóng của nến rút râu (hoặc
 * nến đóng trở lại vào trong ở kiểu chạy từ từ), không hộp, không chờ. SL ngoài
 * điểm xa nhất.
 */
function testSweepEntersAtReclaimClose(): void {
  const P = {
    ...KEY_VOLUME_CONFIG,
    minRR: 0,
    requireStructuralTarget: false,
    sweepEntry: "reclaim-close" as const,
  };
  const bars = longSweepFixture();
  const result = runKeyVolume("synthetic", bars, P);
  const plan = result.plans[0];
  assert.equal(plan.readyIndex, SWEEP_BAR, "vào ở chính nến rút râu");
  const trade = result.trades[0];
  assert.ok(trade);
  assert.equal(trade.entryTime, bars[SWEEP_BAR].openTime);
  assert.equal(trade.entryPrice, bars[SWEEP_BAR].close, "giá vào là giá ĐÓNG nến rút râu");
  const atr = atrSeriesForward(bars)[SWEEP_BAR];
  assert.ok(Math.abs(trade.initialSL - (99.0 - KEY_VOLUME_CONFIG.stopBufferAtr * atr)) < 1e-9);
  assert.equal(trade.exitReason, "target");
  assert.equal(result.diagnostics.boxesArmed, 0, "không có hộp nào được canh");
  assert.ok(trade.holdBars >= 1, "nến vào lệnh không tự chấm SL/TP trên chính nó");

  // Kiểu chạy từ từ: vào ở giá đóng của nến ĐÓNG TRỞ LẠI vào trong, SL ngoài đáy cả đoạn.
  const slow = buildSweepFixture(
    { open: 99.6, high: 99.7, low: 99.2, close: 99.3, volume: 100 },
    [
      { open: 99.3, high: 99.4, low: 98.6, close: 98.9, volume: 100 },
      { open: 98.9, high: 99.6, low: 98.85, close: 99.8, volume: 100 },
      { open: 99.8, high: 100.4, low: 99.75, close: 100.3, volume: 100 },
      { open: 100.3, high: 101.2, low: 100.25, close: 101.1, volume: 100 },
      BAND,
    ],
  );
  const slowResult = runKeyVolume("synthetic", slow, P);
  const slowTrade = slowResult.trades[0];
  assert.ok(slowTrade);
  assert.equal(slowTrade.entryTime, slow[SWEEP_BAR + 2].openTime, "nến đầu tiên đóng lại trên 99,5");
  assert.equal(slowTrade.entryPrice, 99.8);
  const slowAtr = atrSeriesForward(slow)[SWEEP_BAR + 2];
  assert.ok(Math.abs(slowTrade.initialSL - (98.6 - KEY_VOLUME_CONFIG.stopBufferAtr * slowAtr)) < 1e-9);
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

/** Cây quét = nến râu dài quét đáy 99,5, râu tới 98,0. */
const PIN_SWEEP: M15Bar = { open: 100.3, high: 100.6, low: 98.0, close: 100.4, volume: 100 };

/**
 * Luật ĐANG CHẠY `order-block`: thấy rút râu CHƯA vào — cây quét tự nó là nến râu
 * dài nhưng không tính. Hai nến sau, một nến đỏ quay lại CHẠM mức bị quét (99,2 <
 * 99,5) rồi nến xanh lấy lại: cụm hai nến, mũi nhọn là nến đỏ. Lệnh chờ mua ở mép
 * trên hộp 100,65, khớp ở nến kế tiếp; SL ngoài râu quét.
 */
function testSweepOrderBlockLimitEntry(): void {
  const P = { ...KEY_VOLUME_CONFIG, minRR: 0, requireStructuralTarget: false };
  const head: M15Bar[] = [
    { open: 100.4, high: 100.7, low: 100.3, close: 100.65, volume: 100 },
    { open: 100.65, high: 100.7, low: 99.2, close: 99.3, volume: 100 },
    { open: 99.3, high: 100.8, low: 99.25, close: 100.7, volume: 100 },
  ];
  const bars = buildSweepFixture(PIN_SWEEP, [
    ...head,
    // Lùi về chạm mép 100,65 -> khớp.
    { open: 100.7, high: 100.75, low: 100.6, close: 100.62, volume: 100 },
    { open: 100.62, high: 100.9, low: 100.55, close: 100.85, volume: 100 },
    BAND,
    BAND,
  ]);
  const result = runKeyVolume("synthetic", bars, P);
  assert.equal(result.plans.length, 1, "râu quét tự nó không phải order block");
  const plan = result.plans[0];
  assert.equal(plan.branch, "sweep-reclaim");
  assert.equal(plan.key, null);
  assert.equal(plan.clusterShape, "two-candle");
  assert.equal(plan.tipIndex, SWEEP_BAR + 2, "mũi nhọn là nến SAU cú quét chạm lại mức");
  assert.equal(plan.obEntryEdge, 100.65, "long: mép trên hộp");
  assert.equal(plan.readyIndex, SWEEP_BAR + 4, "lệnh chờ sống từ nến ngay sau cụm");
  assert.equal(plan.structuralStop, 98.0, "gốc SL vẫn là râu quét");
  assert.equal(result.diagnostics.limitsPlaced, 1);
  const trade = result.trades[0];
  assert.ok(trade);
  assert.equal(trade.entryTime, bars[SWEEP_BAR + 4].openTime);
  assert.equal(trade.entryPrice, 100.65, "khớp ở MÉP hộp, không ở giá đóng");
  const atr = atrSeriesForward(bars)[SWEEP_BAR + 3];
  assert.ok(
    Math.abs(trade.initialSL - (98.0 - P.stopBufferAtr * atr)) < 1e-9,
    "SL ngoài râu quét, đệm theo ATR lúc ĐẶT lệnh (nến cụm)",
  );

  // Nến khớp cũng chạm SL: mép nằm giữa giá và SL nên chắc chắn đã khớp trước -> thua ngay.
  const crash = runKeyVolume("synthetic", buildSweepFixture(PIN_SWEEP, [
    ...head,
    { open: 100.7, high: 100.75, low: 97.7, close: 97.8, volume: 100 },
    BAND,
  ]), P);
  const lost = crash.trades.find((item) => item.dir === "long");
  assert.ok(lost);
  assert.equal(lost.exitReason, "stop");
  assert.equal(lost.holdBars, 0, "thua ngay trong nến khớp");

  // Giá không quay về mép trong `obLimitBars` nến -> lệnh chờ hết hạn.
  const away: M15Bar = { open: 100.9, high: 100.98, low: 100.8, close: 100.9, volume: 100 };
  const missed = runKeyVolume("synthetic", buildSweepFixture(PIN_SWEEP, [
    ...head,
    ...Array.from({ length: P.obLimitBars + 2 }, () => away),
  ]), P);
  assert.equal(missed.trades.length + (missed.openTrade ? 1 : 0), 0);
  assert.equal(missed.diagnostics.limitsExpired, 1);
}

/** Cụm không chạm lại mức bị quét, hoặc giá vượt qua râu quét trước đó -> không lệnh. */
function testSweepOrderBlockNeedsRetestBelowWick(): void {
  const P = { ...KEY_VOLUME_CONFIG, minRR: 0, requireStructuralTarget: false };
  const noRetest = runKeyVolume("synthetic", buildSweepFixture(PIN_SWEEP, [
    { open: 100.4, high: 100.95, low: 100.35, close: 100.9, volume: 100 },
    // Đáy 99,55 vẫn trên mức 99,5: cụm hai nến dựng được nhưng không chạm lại mức.
    { open: 100.9, high: 100.95, low: 99.55, close: 99.6, volume: 100 },
    { open: 99.6, high: 100.95, low: 99.58, close: 100.9, volume: 100 },
    { open: 100.9, high: 100.95, low: 100.6, close: 100.62, volume: 100 },
    BAND,
    BAND,
  ]), P);
  assert.equal(noRetest.plans.length, 0, "mũi nhọn phải chạm lại mức bị quét");

  const wickBroken = runKeyVolume("synthetic", buildSweepFixture(PIN_SWEEP, [
    { open: 100.4, high: 100.7, low: 100.3, close: 100.65, volume: 100 },
    // Thủng 97,9 < râu 98,0: cú quét cũ chết; chính nến này thành cú quét mới.
    { open: 100.65, high: 100.7, low: 97.9, close: 99.3, volume: 100 },
    { open: 99.3, high: 100.8, low: 99.25, close: 100.7, volume: 100 },
    { open: 100.7, high: 100.75, low: 100.6, close: 100.62, volume: 100 },
    BAND,
    BAND,
  ]), P);
  assert.equal(wickBroken.plans.length, 0, "vượt râu quét thì cú quét cũ chết, râu mới không phải OB");

  // Râu quét 1,2 < 1 ATR và không có cụm nào sau đó: không lệnh, dù vẫn là cú quét.
  const noCluster = runKeyVolume("synthetic", longSweepFixture(), P);
  assert.ok(noCluster.diagnostics.sweeps >= 1);
  assert.equal(noCluster.plans.filter((item) => item.direction === "long").length, 0);
}

/**
 * Fixture A tới đúng nến vào lệnh (@ 100.45), thêm một đỉnh 106 trong cửa sổ quét
 * để mục tiêu (thanh khoản đối diện) nằm xa hơn 1R, rồi nối các nến `after`.
 */
function partialFixture(after: M15Bar[]): Candle[] {
  const bars = longSweepFixture().slice(0, SWEEP_ENTRY + 1);
  bars[200] = { ...bars[200], high: 106 };
  for (const bar of after) pushM15(bars, bar);
  return bars;
}

/**
 * User 03/10/26: chạy được 1R thì chốt 0,33 khối lượng, dời SL về entry; giá quay
 * ngược lại thì phần còn lại hoà vốn. Chạm 1R và mục tiêu cùng nến thì vẫn chốt
 * phần 1R trước — giá phải đi qua 1R mới tới được mục tiêu.
 */
function testPartialAtOneRMovesStopToEntry(): void {
  const back = runKeyVolume("synthetic", partialFixture([
    { open: 100.45, high: 102.5, low: 100.4, close: 102.3, volume: 100 },
    { open: 102.3, high: 102.4, low: 100.3, close: 100.4, volume: 100 },
    BAND,
  ]), SWEEP_OVERRIDES);
  const trade = back.trades.find((item) => item.dir === "long");
  assert.ok(trade);
  assert.ok(Math.abs(trade.entryPrice - SWEEP_ENTRY_PRICE) < 1e-9);
  assert.ok(trade.entryPrice + (trade.entryPrice - trade.initialSL) <= 102.5, "nến đầu chạm được 1R");
  assert.equal(trade.partialTaken, true);
  assert.equal(trade.exitReason, "positive-stop", "phần còn lại thoát ở SL đã dời");
  assert.equal(trade.exitPrice, trade.entryPrice, "SL dời về ĐÚNG giá vào");
  assert.ok(Math.abs(trade.grossR - 0.33) < 1e-9, "0,33 × 1R + 0,67 × 0R");

  const straight = runKeyVolume("synthetic", partialFixture([
    { open: 100.45, high: 106.5, low: 100.4, close: 106.2, volume: 100 },
    BAND,
  ]), SWEEP_OVERRIDES);
  const winner = straight.trades.find((item) => item.dir === "long");
  assert.ok(winner);
  assert.equal(winner.exitReason, "target");
  assert.equal(winner.partialTaken, true, "chạm mục tiêu cùng nến vẫn phải chốt phần 1R trước");
  const targetR = (winner.target - winner.entryPrice) / (winner.entryPrice - winner.initialSL);
  assert.ok(Math.abs(winner.grossR - (0.33 + 0.67 * targetR)) < 1e-9);

  const off = runKeyVolume("synthetic", partialFixture([
    { open: 100.45, high: 102.5, low: 100.4, close: 102.3, volume: 100 },
    { open: 102.3, high: 102.4, low: 100.3, close: 100.4, volume: 100 },
    BAND,
  ]), { ...SWEEP_OVERRIDES, partialFraction: 0 });
  assert.equal(off.trades.length, 0, "tắt chốt một phần: SL vẫn ở chỗ cũ, giá về entry không thoát");
  assert.equal(off.openTrade?.partialTaken, false, "partialFraction 0 là tắt");
}

/**
 * Lệnh còn mở lúc hết dữ liệu không được biến mất: engine trả nó ở `openTrade`,
 * chấm theo giá đóng nến cuối, và KHÔNG trộn vào `trades` của backtest.
 */
function testOpenPositionIsReported(): void {
  const result = runKeyVolume("synthetic", partialFixture([
    { open: 100.45, high: 101.0, low: 100.4, close: 100.9, volume: 100 },
  ]), SWEEP_OVERRIDES);
  assert.equal(result.trades.length, 0, "chưa thoát thì không phải lệnh đã đóng");
  assert.equal(result.diagnostics.entries, 1);
  const open = result.openTrade;
  assert.ok(open);
  assert.equal(open.exitReason, "open");
  assert.equal(open.exitPrice, 100.9, "tạm tính theo giá đóng nến cuối");
  assert.equal(open.holdBars, 1);
  assert.equal(open.partialTaken, false);

  const closed = runKeyVolume("synthetic", longSweepFixture(), SWEEP_OVERRIDES);
  assert.equal(closed.openTrade, null, "lệnh đã thoát thì không còn vị thế mở");
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
 * Cây bóp cò là nến RÂU DÀI (râu dưới 0,4, đóng sát đỉnh nến). Hai nến liền
 * trước có thân 100,95–101,05 nên hộp lấy cả 3 nến: 100,90–101,10.
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
 * đè lên key". `offKey: true` đẩy THÂN của nến râu dài và hai nến liền trước lên
 * hẳn TRÊN key, để hộp order block không còn chứa key.
 */
function buildKeyFixture(
  options: { withExcursion?: boolean; offKey?: boolean; excursionBelow?: boolean } = {},
): Candle[] {
  const { withExcursion = true, offKey = false, excursionBelow = false } = options;
  // Lật đoạn rời key qua đường 101,0: giá rời XUỐNG dưới rồi về.
  const mirror = (bar: M15Bar): M15Bar => ({
    open: 202 - bar.open,
    high: 202 - bar.low,
    low: 202 - bar.high,
    close: 202 - bar.close,
    volume: bar.volume,
  });
  const bars: Candle[] = [];
  for (let i = 0; i <= TRIGGER_BAR + RALLY_BARS; i++) {
    if (offKey && (i === TRIGGER_BAR - 2 || i === TRIGGER_BAR - 1)) {
      // Thân [101,15 – 101,25]: hộp sẽ nằm hẳn trên đường key 101,0.
      pushM15(bars, { open: 101.15, high: 101.3, low: 101.05, close: 101.25, volume: 100 });
    } else if (offKey && i === TRIGGER_BAR) {
      // Vẫn là nến râu dài (râu 0,5 chạm xuống tận key), vẫn đủ volume ×1,5, nhưng
      // THÂN của nó và hai nến trước đều nằm trên đường key 101,0.
      pushM15(bars, { open: 101.2, high: 101.35, low: 100.7, close: 101.3, volume: 150 });
    } else if (withExcursion && i >= EXCURSION_FROM && i < EXCURSION_FROM + EXCURSION.length) {
      const bar = EXCURSION[i - EXCURSION_FROM];
      pushM15(bars, excursionBelow ? mirror(bar) : bar);
    } else if (i === KEY_BAR) {
      // Nến volume đột biến: râu dài xuống, hai bên đều volume 100 -> ×20.
      pushM15(bars, { open: 101.0, high: 101.1, low: 100.0, close: 100.9, volume: 2000 });
    } else if (i === TRIGGER_BAR) {
      // Nến RÂU DÀI: râu dưới 0,4, đóng sát đỉnh nến, volume ×1.5.
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
  // Tắt nhánh quét để đo riêng nhánh key: nến bóp cò của fixture VỪA là nến râu
  // dài VỪA quét đáy biên, nên để bật cả hai thì không tách được công của ai.
  enableSweepBranch: false,
  // Tín hiệu A cũng tắt: các test dưới đây đo riêng CỤM, và A là đường bóp cò
  // song song nên sẽ ra kế hoạch ngay cả khi cụm bị chặn.
  enableDivergenceSignal: false,
  // Nhánh trap cũng tắt: giá fixture đóng qua lại đường key nên trap sẽ vào trước.
  enableKeyTrapBranch: false,
  // Nhánh 4 cũng tắt: fixture có đỉnh/đáy swing quanh key nên nó tự ra kế hoạch.
  enableLowerHighBranch: false,
  // Key của fixture chưa từng đi trọn chu trình chín, và sau nến đáy chỉ có một
  // đỉnh swing. Hai luật này có test riêng; ở đây tắt để đo đúng phần cụm/hộp.
  requireKeyMaturation: false,
  requireSwingConfirmation: false,
  // Giá fixture đi ngang đè lên key nên chạm quá 7 lần trước nến bóp cò; luật
  // chạm quá nhiều có test riêng.
  keyMaxTouches: Infinity,
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
  // Nến bóp cò là nến RÂU DÀI nên cũng là nến đáy; hộp là thân của nó cộng thân
  // hai nến liền trước (chồng nhau nên lấy đủ 3), râu không tính.
  assert.equal(plan.clusterShape, "long-wick");
  assert.equal(plan.clusterBars, 3);
  assert.ok(Math.abs(plan.obLow - 100.9) < 1e-9);
  assert.ok(Math.abs(plan.obHigh - 101.1) < 1e-9);
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

/**
 * "Hai nến đỉnh tăng" KHÔNG còn là cò: sau nến chạm, fixture có ba nến đỉnh tăng
 * liền nhau (luật B cũ từng bóp cò ở đây). Cụm bị chặn ở cửa volume thì phải hết
 * kế hoạch, kể cả khi tín hiệu A bật.
 */
function testRisingBarsAloneDoNotTrigger(): void {
  const bars = buildKeyFixture();
  const clusterBlocked = { ...KEY_OVERRIDES, reversalVolumeMult: 3, enableDivergenceSignal: true };
  const result = runKeyVolume("synthetic", bars, clusterBlocked);
  assert.equal(result.plans.length, 0, "cụm bị chặn, không có phân kỳ -> không kế hoạch nào");
  assert.equal(result.diagnostics.structureSignals, 0);
}

/**
 * Bước xác nhận cấu trúc: sau nến đáy fixture chỉ có MỘT đỉnh swing trước nến bật
 * ra khỏi hộp, nên bật luật này thì nến đó bị gạt và hộp không vào được.
 */
function testSwingConfirmationGate(): void {
  const bars = buildKeyFixture();
  const off = runKeyVolume("synthetic", bars, KEY_OVERRIDES);
  assert.equal(off.trades.length, 1);
  assert.equal(off.diagnostics.rejectedNoStructure, 0);

  const on = runKeyVolume("synthetic", bars, { ...KEY_OVERRIDES, requireSwingConfirmation: true });
  assert.equal(on.plans.length, off.plans.length, "luật này không đụng tới khâu dựng kế hoạch");
  assert.equal(on.trades.length, 0, "một đỉnh swing chưa đủ hai đỉnh tăng dần");
  assert.ok(on.diagnostics.rejectedNoStructure >= 1);

  // Nhánh quét luật cũ `box-retest` không có cụm nên không chịu luật này.
  const sweep = runKeyVolume("synthetic", longSweepFixture(), {
    ...SWEEP_OVERRIDES,
    requireSwingConfirmation: true,
  });
  assert.equal(sweep.trades.length, 1);
}

/** Hai đỉnh (đáy) swing LIỀN NHAU sau nến đáy, đỉnh sau cao hơn (đáy sau thấp hơn). */
function testHasRisingSwings(): void {
  const s = (index: number, price: number, type: "low" | "high") =>
    ({ index, price, type, confirmIndex: index + 2 });
  const rising = [s(12, 101, "high"), s(14, 99, "low"), s(17, 102, "high")];
  assert.equal(hasRisingSwings(rising, 10, 19, "long"), true);
  assert.equal(hasRisingSwings(rising, 10, 18, "long"), false, "đỉnh thứ hai chưa xác nhận ở nến 18");
  assert.equal(hasRisingSwings(rising, 12, 19, "long"), false, "đỉnh ở chính nến đáy không tính");
  // Đỉnh sau THẤP hơn rồi mới cao hơn: cặp liền nhau (102 -> 103) vẫn tính.
  const lowerThenHigher = [s(12, 102, "high"), s(15, 101, "high"), s(18, 103, "high")];
  assert.equal(hasRisingSwings(lowerThenHigher, 10, 20, "long"), true);
  assert.equal(hasRisingSwings(lowerThenHigher, 10, 19, "long"), false, "102 -> 101 là đỉnh thấp hơn");
  // SHORT: hai đáy swing, đáy sau thấp hơn.
  const falling = [s(12, 99, "low"), s(16, 98, "low")];
  assert.equal(hasRisingSwings(falling, 10, 18, "short"), true);
  assert.equal(hasRisingSwings(falling, 10, 18, "long"), false, "LONG đọc đỉnh, không đọc đáy");
}

/**
 * Nhãn phía về: fixture gốc rời key LÊN TRÊN rồi về, lệnh LONG -> `bounce`. Lật
 * đoạn rời xuống DƯỚI key thì cùng cụm đó là giá đi lên xuyên key -> `breakout`.
 */
function testApproachLabel(): void {
  const bounce = runKeyVolume("synthetic", buildKeyFixture(), KEY_OVERRIDES);
  assert.equal(bounce.plans[0].approach, "bounce");
  assert.equal(bounce.trades[0].approach, "bounce");

  const breakout = runKeyVolume("synthetic", buildKeyFixture({ excursionBelow: true }), KEY_OVERRIDES);
  const plan = breakout.plans.find((item) => item.branch === "volume-reversal");
  assert.ok(plan);
  assert.equal(plan.direction, "long");
  assert.equal(plan.approach, "breakout", "nhãn chỉ để tách báo cáo — kiểu phá vỡ vẫn được vào");

  const sweep = runKeyVolume("synthetic", longSweepFixture(), SWEEP_OVERRIDES);
  assert.equal(sweep.plans[0].approach, null, "nhánh quét không có key nên không có phía về");
}

/**
 * Luật CHÍN: rời > 1 ATR -> chạm lại -> đóng bật > 1 ATR trong 6 nến. Key chỉ dùng
 * được từ lúc nến bật ra đóng, và không sớm hơn lúc key biết được.
 */
function testKeyMaturation(): void {
  const m15 = TF_MS["15m"];
  const flat = (i: number) => candle(i, 100, 100.1, 99.9, 100, 100, m15);
  const head = Array.from({ length: 20 }, (_, i) => flat(i));
  const rally = [
    candle(20, 100, 101.0, 99.95, 100.9, 100, m15),
    candle(21, 100.9, 101.3, 100.8, 101.2, 100, m15), // rời lên trên
    candle(22, 101.2, 101.25, 100.4, 100.5, 100, m15),
    candle(23, 100.5, 100.55, 99.95, 100.1, 100, m15), // chạm lại
  ];
  const bounceBar = candle(24, 100.1, 101.2, 100.05, 101.1, 100, m15); // đóng bật lên
  const level: KeyVolumeLevel = {
    id: "15m:test",
    sourceTf: "15m",
    price: 100,
    zoneLow: 100,
    zoneHigh: 100,
    eventTime: head[5].openTime,
    confirmedAt: 12 * m15,
    maturedAt: 12 * m15,
    expiresAt: Number.MAX_SAFE_INTEGER,
    volumeRatio: 5,
  };
  const P = KEY_VOLUME_CONFIG;

  const matured = matureKeyLevels([...head, ...rally, bounceBar], [level], P);
  assert.equal(matured.length, 1);
  assert.equal(matured[0].maturedAt, 25 * m15, "dùng được từ lúc nến bật ra ĐÓNG");
  assert.equal(isKeyVolumeLevelActive(matured[0], 24 * m15), false);
  assert.equal(isKeyVolumeLevelActive(matured[0], 25 * m15), true);

  // Chưa có nến bật ra thì chưa chín — không được nhìn trước.
  assert.equal(matureKeyLevels([...head, ...rally], [level], P).length, 0);

  // Chạm rồi không bật kịp trong 6 nến -> key chết.
  const stall = Array.from({ length: 7 }, (_, k) => candle(24 + k, 100.1, 100.2, 100.05, 100.15, 100, m15));
  assert.equal(matureKeyLevels([...head, ...rally, ...stall], [level], P).length, 0);

  // Chạm rồi đóng xuyên xuống dưới key -> key chết, kể cả bật mạnh sau đó.
  const through = candle(24, 100.1, 100.15, 99.5, 99.6, 100, m15);
  const late = candle(25, 99.6, 101.5, 99.55, 101.4, 100, m15);
  assert.equal(matureKeyLevels([...head, ...rally, through, late], [level], P).length, 0);

  // Bật ra TRƯỚC lúc key biết được: key dùng được ngay khi biết, không sớm hơn.
  const lateKnown = { ...level, confirmedAt: 30 * m15, maturedAt: 30 * m15 };
  assert.equal(matureKeyLevels([...head, ...rally, bounceBar], [lateKnown], P)[0].maturedAt, 30 * m15);
}

/** User 08/10/26: SL gần hơn 0,2% giá vào thì không vào — cùng cửa rủi ro với trần 3%. */
function testMinStopPct(): void {
  const plan = { branch: "sweep-reclaim", direction: "long", key: null, sweepTarget: 110 } as unknown as KeyVolumeEntryPlan;
  const at = (structuralStop: number) =>
    resolveEntryLevels({ ...plan, structuralStop }, [], 100, 0, 0, KEY_VOLUME_CONFIG);
  assert.deepEqual(at(99.85), { ok: false, reason: "risk" }, "SL 0,15% bị loại");
  assert.equal(at(99.75).ok, true, "SL 0,25% vẫn vào");
  assert.deepEqual(at(96.5), { ok: false, reason: "risk" }, "trần 3% vẫn giữ");

  // Vàng tạm chưa áp cận dưới; BTC thì có.
  assert.equal(keyVolumeParamsFor("XAUUSDT").minStopPct, 0);
  assert.equal(keyVolumeParamsFor("xauusdt").minStopPct, 0);
  assert.equal(keyVolumeParamsFor("BTCUSDT").minStopPct, 0.002);
  assert.equal(
    resolveEntryLevels({ ...plan, structuralStop: 99.85 }, [], 100, 0, 0, keyVolumeParamsFor("XAUUSDT")).ok,
    true,
    "vàng: SL 0,15% vẫn vào",
  );
}

/**
 * Chạm 7 lần thì bỏ key; nến chạm trong 45 phút kể từ nến mở lần chạm là cùng
 * một lần. Lần thứ 7 vẫn dùng được trọn cửa sổ của nó, hết cửa sổ thì key chết.
 */
function testKeyTouchLimit(): void {
  const m15 = TF_MS["15m"];
  // Lần 1 = nến 5,6,7 (cùng cửa sổ); 8 mở lần 2; 12,16,20,24 là lần 3–6;
  // 28 là lần 7 (29 trong cùng cửa sổ); 32 là lần 8 — key đã chết trước đó.
  const touchAt = new Set([5, 6, 7, 8, 12, 16, 20, 24, 28, 29, 32]);
  const bars = Array.from({ length: 40 }, (_, i) =>
    i === 0
      ? candle(0, 100, 102.1, 99.9, 102, 500, m15)
      : touchAt.has(i)
        ? candle(i, 102, 102.1, 99.99, 102, 100, m15)
        : candle(i, 102, 102.1, 101.9, 102, 100, m15));
  const level: KeyVolumeLevel = {
    id: "15m:touch",
    sourceTf: "15m",
    price: 100,
    zoneLow: 100,
    zoneHigh: 100,
    eventTime: 0,
    confirmedAt: m15,
    maturedAt: m15,
    expiresAt: Number.MAX_SAFE_INTEGER,
    volumeRatio: 5,
  };
  const P = KEY_VOLUME_CONFIG;

  const [limited] = limitKeyTouches(bars, [level], P);
  assert.equal(limited.expiresAt, 31 * m15 - 1, "chết khi hết 45 phút của lần chạm thứ 7");
  assert.equal(isKeyVolumeLevelActive(limited, 29 * m15), true, "lần chạm thứ 7 vẫn dùng được");
  assert.equal(isKeyVolumeLevelActive(limited, 30 * m15), true);
  assert.equal(isKeyVolumeLevelActive(limited, 31 * m15), false);

  // Mới có 6 lần chạm thì key còn nguyên hạn — không nhìn trước lần thứ 7.
  assert.equal(limitKeyTouches(bars.slice(0, 28), [level], P)[0].expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(level.expiresAt, Number.MAX_SAFE_INTEGER, "không sửa key đầu vào");
}

/**
 * Đang giữ lệnh thì hộp vẫn phải được trang bị và cập nhật — chỉ việc VÀO lệnh
 * bị chặn. Chạy nhánh quét trên một đoạn giá ngẫu nhiên (cố định hạt giống), với
 * cửa sổ quét ngắn để có nhiều kế hoạch chồng lên các lệnh đang mở.
 */
function testBoxesArmedWhileHolding(): void {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const bars: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 3000; i++) {
    const open = price;
    price *= 1 + (random() - 0.5) * 0.006;
    const high = Math.max(open, price) * (1 + random() * 0.002);
    const low = Math.min(open, price) * (1 - random() * 0.002);
    pushM15(bars, { open, high, low, close: price, volume: 100 + random() * 50 });
  }
  const params = {
    ...KEY_VOLUME_CONFIG,
    enableVolumeReversalBranch: false,
    // Đo cơ chế CANH HỘP, nên nhánh quét chạy ở luật hộp `box-retest`.
    sweepEntry: "box-retest" as const,
    sweepLookback: 20,
    sweepProminenceBars: 0,
    minRR: 0,
    requireStructuralTarget: false,
  };
  const result = runKeyVolume("synthetic", bars, params);
  const spans = result.trades.map((t) => [t.entryTime, t.exitTime]);
  const duringPosition = result.plans.filter((plan) =>
    spans.some(([entry, exit]) => {
      const ready = bars[plan.readyIndex].openTime;
      return ready > entry && ready <= exit;
    }));
  assert.ok(duringPosition.length > 0, "fixture phải có kế hoạch chín đúng lúc đang giữ lệnh");
  assert.equal(
    result.diagnostics.boxesArmed,
    result.plans.filter((plan) => plan.readyIndex >= 20).length,
    "mọi kế hoạch đều được trang bị, kể cả kế hoạch rơi vào lúc đang giữ lệnh",
  );
}

/** Hai nhánh cùng bóp cò một nến: nhánh có score cao hơn được chọn. */
function testBothBranchesOnSameBar(): void {
  const result = runKeyVolume("synthetic", buildKeyFixture(), {
    ...KEY_OVERRIDES,
    enableSweepBranch: true,
    // Đoạn rời key của fixture vọt lên khỏi biên rồi chạy từ từ về — đúng là một
    // cú quét đỉnh kiểu chậm, sinh lệnh SHORT chiếm chỗ. Test này chỉ đo hai nhánh
    // bóp cò CÙNG một nến, nên tắt kiểu chậm.
    sweepMaxOutsideBars: 0,
    // Hai HỘP bật ra cùng một nến mới so score với nhau; nhánh quét vào thẳng thì
    // đã vào từ nến bóp cò, không còn cạnh tranh ở nến xác nhận.
    sweepEntry: "box-retest",
  });
  const ready = result.plans.filter((plan) => plan.readyIndex === KEY_READY);
  assert.equal(ready.length, 2, "nến bóp cò vừa là râu dài tại key vừa quét đáy biên");
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
 * Cụm đảo chiều là một MŨI NHỌN. Ba hình (V, hai nến, râu dài) đều đo bằng ATR,
 * và nến ĐÁY quyết định hộp: thân 2 nến kết thúc ở đáy, thêm nến thứ 3 nếu thân
 * nó chồng lên vùng thân của hai nến kia. Ở đây truyền ATR = 1 để ngưỡng ATR
 * đọc thẳng thành giá.
 */
function testReversalOrderBlockCases(): void {
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

  // ── V: lao xuống 2,4 rồi lao lên 2,1, đáy ở nến 2 (râu 8,0). ───────────────
  const v = [
    candle(0, 10.0, 10.4, 9.6, 9.9),
    candle(1, 9.8, 9.9, 9.0, 9.1),
    candle(2, 9.1, 9.2, 8.0, 8.2),
    candle(3, 8.2, 10.2, 8.1, 10.1),
  ];
  const vBox = reversalOrderBlock(v, 3, "long", 1);
  assert.ok(vBox);
  assert.equal(vBox.shape, "v-spike");
  assert.equal(vBox.tipIndex, 2, "nến đáy là nến có râu thấp nhất, không phải nến đảo chiều");
  near(vBox.obLow, 8.2, "mép dưới hộp = thân thấp nhất của nến 1-2");
  near(vBox.obHigh, 9.8, "mép trên hộp = open nến 1; râu không tính");
  assert.equal(vBox.boxBars, 2, "thân nến 0 [9,9–10,0] nằm hẳn trên vùng thân -> không chồng");
  assert.equal(vBox.clusterBars, 3, "từ nến 1 (đầu hộp) tới nến 3 (đảo chiều)");

  // Thân nến thứ 3 chồng lên vùng thân của hai nến kia -> hộp lấy cả 3.
  const vOverlap = v.map((bar, i) => (i === 0 ? candle(0, 9.7, 10.4, 9.6, 10.0) : bar));
  const vBox3 = reversalOrderBlock(vOverlap, 3, "long", 1);
  assert.ok(vBox3);
  assert.equal(vBox3.boxBars, 3);
  near(vBox3.obHigh, 10.0, "nến thứ 3 kéo mép trên hộp lên 10,0");
  assert.equal(vBox3.clusterBars, 4);

  // Cùng dữ liệu nhưng ATR lớn hơn thì mũi không còn đủ nhọn -> không xét.
  assert.equal(reversalOrderBlock(v, 3, "long", 1.3), null, "chân 2,1 < 2 × 1,3 ATR");
  // Chiều ngược: V hướng lên không thể là cụm SHORT.
  assert.equal(reversalOrderBlock(v, 3, "short", 1), null);

  // ── Hai nến: nến đỏ thân 0,9, nến xanh thân 0,85 lấy lại 94%. ────────────────
  const two = [
    candle(0, 10.3, 10.4, 10.2, 10.3),
    candle(1, 10.2, 10.25, 9.2, 9.3),
    candle(2, 9.3, 10.2, 9.25, 10.15),
  ];
  const twoBox = reversalOrderBlock(two, 2, "long", 1);
  assert.ok(twoBox);
  assert.equal(twoBox.shape, "two-candle", "đáy chỉ sâu 1,2 nên V (cần 2,0) không khớp");
  assert.equal(twoBox.tipIndex, 1, "đáy là nến ĐỎ, nơi có râu thấp hơn");
  near(twoBox.obLow, 9.3, "thân thấp nhất của nến 0-1");
  near(twoBox.obHigh, 10.3, "open nến 0 và open nến đỏ nằm trên");
  // Nến xanh vẫn đủ thân (0,85) nhưng chỉ lấy lại 67% thân nến đỏ -> không đủ.
  const weak = two.map((bar, i) => (i === 2 ? candle(2, 9.05, 9.95, 9.0, 9.9) : bar));
  assert.equal(reversalOrderBlock(weak, 2, "long", 1), null, "lấy lại 67% < 70%");

  // ── Râu dài: râu 1,2 trên biên độ 1,3, đóng cửa sát đỉnh nến. ────────────────
  const pin = [
    candle(0, 10.0, 10.2, 9.9, 10.1),
    candle(1, 10.1, 10.2, 10.0, 10.05),
    candle(2, 10.0, 10.1, 8.8, 10.05),
  ];
  const pinBox = reversalOrderBlock(pin, 2, "long", 1);
  assert.ok(pinBox);
  assert.equal(pinBox.shape, "long-wick");
  assert.equal(pinBox.tipIndex, 2, "nến râu dài tự là nến đáy");
  assert.equal(pinBox.boxBars, 3, "thân 3 nến đều quanh 10,0–10,1 nên chồng nhau");
  near(pinBox.obLow, 10.0, "râu KHÔNG vào hộp");
  near(pinBox.obHigh, 10.1, "râu KHÔNG vào hộp");
  // Râu dài không bắt buộc đúng màu: thân đỏ nhỏ vẫn là búa nếu đóng sát đỉnh.
  const redPin = pin.map((bar, i) => (i === 2 ? candle(2, 10.05, 10.1, 8.8, 10.0) : bar));
  assert.equal(reversalOrderBlock(redPin, 2, "long", 1)?.shape, "long-wick");
  // Râu chỉ 0,8 ATR thì chưa đủ nhọn.
  assert.equal(reversalOrderBlock(pin, 2, "long", 1.5), null, "râu 1,2 < 1,0 × 1,5 ATR");

  // ── Không phải mũi nhọn: nến thường, đi một chiều. ─────────────────────────
  const drift = [
    candle(0, 10.0, 10.1, 9.9, 10.05),
    candle(1, 10.05, 10.15, 9.95, 10.1),
    candle(2, 10.1, 10.2, 10.0, 10.15),
  ];
  assert.equal(reversalOrderBlock(drift, 2, "long", 1), null);

  // ── SHORT là gương của LONG: phản chiếu giá quanh 20 phải ra cùng hình. ──────
  const mirror = (bars: Candle[]): Candle[] =>
    bars.map((bar, i) => candle(i, 20 - bar.open, 20 - bar.low, 20 - bar.high, 20 - bar.close));
  const shortV = reversalOrderBlock(mirror(v), 3, "short", 1);
  assert.ok(shortV);
  assert.equal(shortV.shape, "v-spike");
  assert.equal(shortV.tipIndex, 2);
  near(shortV.obLow, 20 - 9.8, "mép dưới SHORT = gương mép trên LONG");
  near(shortV.obHigh, 20 - 8.2, "mép trên SHORT = gương mép dưới LONG");
  assert.equal(reversalOrderBlock(mirror(v), 3, "long", 1), null);
  assert.equal(reversalOrderBlock(mirror(two), 2, "short", 1)?.shape, "two-candle");
  assert.equal(reversalOrderBlock(mirror(pin), 2, "short", 1)?.shape, "long-wick");

  // Nhấn chìm không còn là tín hiệu: nến xanh phủ trọn thân hai nến trước nhưng
  // không có chân nào đủ dài thì bị bỏ.
  const engulfOnly = [
    candle(0, 10.0, 10.3, 9.8, 9.9),
    candle(1, 9.9, 10.2, 9.7, 10.1),
    candle(2, 9.5, 10.9, 9.3, 10.6),
  ];
  assert.equal(reversalOrderBlock(engulfOnly, 2, "long", 1), null, "nhấn chìm đơn thuần không còn là cụm");
}

/** RSI Wilder: số tay tính được với chu kỳ 3, và các biên 0/100. */
function testRsiSeries(): void {
  const closes = [10, 11, 12, 11, 10, 11];
  const bars = closes.map((close, i) => candle(i, close, close, close, close));
  const rsi = rsiSeries(bars, 3);
  assert.ok(rsi.slice(0, 3).every((value) => Number.isNaN(value)), "chưa đủ 3 thay đổi thì chưa có RSI");
  // i=3: lãi TB (1+1+0)/3, lỗ TB (0+0+1)/3 -> RS 2.
  assert.ok(Math.abs(rsi[3] - 200 / 3) < 1e-9, `rsi[3]=${rsi[3]}`);
  // i=4: lãi TB 4/9, lỗ TB 5/9 -> RS 0,8.
  assert.ok(Math.abs(rsi[4] - 100 * 0.8 / 1.8) < 1e-9, `rsi[4]=${rsi[4]}`);
  // i=5: lãi TB 17/27, lỗ TB 10/27 -> RS 1,7.
  assert.ok(Math.abs(rsi[5] - 100 * 1.7 / 2.7) < 1e-9, `rsi[5]=${rsi[5]}`);

  const rising = [1, 2, 3, 4, 5, 6].map((close, i) => candle(i, close, close, close, close));
  assert.equal(rsiSeries(rising, 3)[5], 100, "chỉ có nến tăng -> 100");
  const falling = [6, 5, 4, 3, 2, 1].map((close, i) => candle(i, close, close, close, close));
  assert.equal(rsiSeries(falling, 3)[5], 0, "chỉ có nến giảm -> 0");

  // Không nhìn trước: cắt bớt nến cuối không đổi các giá trị trước đó.
  const prefix = rsiSeries(bars.slice(0, 5), 3);
  assert.deepEqual(prefix.slice(3), rsi.slice(3, 5));
}

/**
 * Tín hiệu A, thử trực tiếp với swing và RSI dựng tay. Key ở 100, ATR = 1, nên
 * dung sai tại key 0,5 ATR là 0,5 giá. Đáy 1 ở nến 10, đáy 2 ở nến 20 (chạm key ở
 * nến 20), nến đang xét là 22 — đúng lúc pivot 2/2 của đáy 2 vừa xác nhận.
 */
function testRsiDivergenceAtKey(): void {
  const flat = Array.from({ length: 30 }, (_, i) => candle(i, 100.3, 100.5, 99.9, 100.2));
  const swing = (index: number, price: number, type: "low" | "high") =>
    ({ index, price, type, confirmIndex: index + 2 });
  const rsi = (first: number, second: number) => {
    const out = Array<number>(30).fill(50);
    out[10] = first;
    out[20] = second;
    return out;
  };
  const params = { structureKeyAtr: 0.5, divergencePriceTolAtr: 0, divergenceLookbackBars: 96 };
  const lows = [swing(10, 99.8, "low"), swing(20, 99.7, "low")];
  const run = (swings: ReturnType<typeof swing>[], rsiValues: number[], overrides = {}) =>
    rsiDivergenceAtKey(flat, swings, rsiValues, 1, 22, 20, "long", 100, { ...params, ...overrides });

  // Đáy 2 thấp hơn đáy 1 (99,7 < 99,8) mà RSI cao hơn (34 > 25) -> phân kỳ.
  const hit = run(lows, rsi(25, 34));
  assert.ok(hit);
  assert.equal(hit.shape, "rsi-divergence");
  assert.equal(hit.tipIndex, 20, "nến đáy là đáy 2");
  assert.ok(hit.divergence);
  assert.equal(hit.divergence.firstRsi, 25);
  assert.equal(hit.divergence.secondRsi, 34);
  assert.equal(hit.divergence.firstPrice, 99.8);
  assert.equal(hit.divergence.secondPrice, 99.7);
  assert.equal(hit.divergence.secondTime, flat[20].openTime);

  assert.equal(run(lows, rsi(34, 25)), null, "RSI đáy 2 thấp hơn -> không phân kỳ");
  assert.equal(run(lows, rsi(30, 30)), null, "RSI bằng nhau không phải phân kỳ");
  // Đáy 2 CAO hơn đáy 1 mà RSI cũng cao hơn: giá xác nhận RSI, không phải phân kỳ.
  assert.equal(run([swing(10, 99.8, "low"), swing(20, 99.9, "low")], rsi(25, 34)), null);
  // Hai đáy bằng nhau vẫn là hai đáy.
  assert.ok(run([swing(10, 99.8, "low"), swing(20, 99.8, "low")], rsi(25, 34)));
  // Có dung sai thì mới cho đáy 2 cao hơn trong dung sai đó.
  assert.ok(run([swing(10, 99.8, "low"), swing(20, 99.9, "low")], rsi(25, 34), { divergencePriceTolAtr: 0.5 }));
  // Đáy 1 là swing tại key LIỀN TRƯỚC đáy 2: nó không cho phân kỳ thì KHÔNG được
  // lùi tiếp về đáy cũ hơn (nến 5) để dò cho ra.
  const skipOld = (() => { const out = rsi(40, 34); out[5] = 25; return out; })();
  assert.equal(run([swing(5, 99.9, "low"), swing(10, 99.8, "low"), swing(20, 99.7, "low")], skipOld), null);
  // Đáy 1 cách key 1,0 > 0,5 ATR -> không nằm tại key.
  assert.equal(run([swing(10, 99.0, "low"), swing(20, 99.7, "low")], rsi(25, 34)), null);
  // Đáy 2 cách key quá xa thì không phải tín hiệu TẠI key.
  assert.equal(run([swing(10, 99.8, "low"), swing(20, 99.2, "low")], rsi(25, 34)), null);
  // Hai đáy sát nhau dưới 3 nến thì không phải hai đáy.
  assert.equal(run([swing(18, 99.8, "low"), swing(20, 99.7, "low")], rsi(25, 34)), null);
  // Đáy 1 nằm ngoài khoảng nhìn lại.
  assert.equal(run(lows, rsi(25, 34), { divergenceLookbackBars: 5 }), null);
  // Đáy 2 chưa xác nhận ở nến đang xét -> chưa được dùng (không nhìn trước).
  assert.equal(
    rsiDivergenceAtKey(flat, lows, rsi(25, 34), 1, 21, 20, "long", 100, params),
    null,
    "pivot 2/2 của đáy 2 chỉ xác nhận ở nến 22",
  );
  // Đáy 2 phải nằm từ nến liền trước nến chạm key trở đi.
  assert.equal(
    rsiDivergenceAtKey(flat, lows, rsi(25, 34), 1, 22, 25, "long", 100, params),
    null,
    "đáy 2 ở nến 20 đã trước nến chạm key 25",
  );

  // SHORT là gương: hai đỉnh, đỉnh 2 cao hơn, RSI đỉnh 2 thấp hơn.
  const highs = [swing(10, 100.2, "high"), swing(20, 100.3, "high")];
  const shortHit = rsiDivergenceAtKey(flat, highs, rsi(70, 62), 1, 22, 20, "short", 100.2, params);
  assert.ok(shortHit);
  assert.equal(shortHit.shape, "rsi-divergence");
  assert.equal(rsiDivergenceAtKey(flat, highs, rsi(62, 70), 1, 22, 20, "short", 100.2, params), null);
  // Hộp: thân 2 nến kết thúc ở nến đáy; nến thứ 3 (18) cùng thân nên được thêm vào.
  assert.equal(hit.boxBars, 3);
  assert.equal(hit.clusterBars, 22 - (20 - 2) + 1);
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

/** #23/#43: chạm key + kích volume lần nữa là vào lại được, kể cả sau khi dính SL (user 04/10/26). */
function testReentryModes(): void {
  assert.equal(canReenterKey("long", 95, "positive-stop", 90, true, "deeper-sweep"), false);
  assert.equal(canReenterKey("long", 85, "positive-stop", 90, true, "deeper-sweep"), true);
  assert.equal(canReenterKey("long", 95, "positive-stop", 90, true, "volume-retouch"), true);
  // User 04/10/26: dính SL thật vẫn giữ key.
  assert.equal(canReenterKey("long", 95, "stop", 90, true, "volume-retouch"), true);
  assert.equal(canReenterKey("long", 95, "stop", 90, false, "volume-retouch"), false);
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

/**
 * "Thủng rồi CHẠY TỪ TỪ LẠI": nến thủng đáy biên ĐÓNG dưới đáy, giá nằm dưới vài
 * nến, rồi một nến đóng trở lại trên đáy. Mức bị quét lấy từ cửa sổ trước NẾN
 * THỦNG, SL ở điểm thấp nhất cả đoạn, hộp là thân nến đóng lại.
 */
function testSlowSweepReturn(): void {
  const P = KEY_VOLUME_CONFIG;
  // Biên phẳng: đáy 99,5. Nến 600 thủng và đóng dưới; 601–602 vẫn đóng dưới,
  // 601 xuống sâu nhất 98,6; nến 603 đóng lại trên 99,5.
  const outside: M15Bar[] = [
    { open: 99.6, high: 99.7, low: 99.2, close: 99.3, volume: 100 },
    { open: 99.3, high: 99.4, low: 98.6, close: 98.9, volume: 100 },
    { open: 98.9, high: 99.45, low: 98.8, close: 99.4, volume: 100 },
  ];
  const reclaim: M15Bar = { open: 99.4, high: 99.9, low: 99.35, close: 99.8, volume: 100 };
  const bars = buildSweepFixture(outside[0], [outside[1], outside[2], reclaim]);
  const reclaimIndex = SWEEP_BAR + 3;

  // Hai nến đầu đóng dưới mọi mức nên chưa có cú quét nào.
  assert.equal(findSweep(bars, SWEEP_BAR, "long", P.sweepLookback, P.sweepProminenceBars, 16), null);
  assert.equal(findSweep(bars, SWEEP_BAR + 1, "long", P.sweepLookback, P.sweepProminenceBars, 16), null);
  // Nến 602 đóng 99,4: chưa lại trên 99,5, nhưng đã lại trên 99,2 — đáy của nến
  // thủng, tức đáy 5 ngày CUỘN lúc nến 601 thủng nó. Cửa sổ cuộn tính cả đáy vừa
  // tạo và lần nào cũng tính, nên đây cũng là một cú quét (nhỏ, lồng bên trong).
  const nested = findSweep(bars, SWEEP_BAR + 2, "long", P.sweepLookback, P.sweepProminenceBars, 16);
  assert.ok(nested);
  assert.equal(nested.breakIndex, SWEEP_BAR + 1);
  assert.equal(nested.level, 99.2);
  const event = findSweep(bars, reclaimIndex, "long", P.sweepLookback, P.sweepProminenceBars, 16);
  assert.ok(event, "nến đầu tiên đóng lại trên đáy hoàn tất cú quét");
  assert.equal(event.breakIndex, SWEEP_BAR, "nến thủng là nến đầu tiên xuống dưới đáy");
  assert.equal(event.level, 99.5, "mức là đáy biên TRƯỚC nến thủng, không phải đáy mới 98,6");
  assert.equal(event.extreme, 98.6);
  assert.equal(event.extremeIndex, SWEEP_BAR + 1);
  // Chỉ cho kiểu rút râu (0 nến nằm ngoài) thì đây không phải cú quét.
  assert.equal(findSweep(bars, reclaimIndex, "long", P.sweepLookback, P.sweepProminenceBars, 0), null);
  // Nằm ngoài 3 nến (600–602) mà hạn chỉ 2 nến thì quá hạn.
  assert.equal(findSweep(bars, reclaimIndex, "long", P.sweepLookback, P.sweepProminenceBars, 2), null);
  assert.ok(findSweep(bars, reclaimIndex, "long", P.sweepLookback, P.sweepProminenceBars, 3));

  // Engine: kế hoạch bóp cò ở nến đóng lại, SL gốc ở đáy cả đoạn, hộp = thân nến đóng lại.
  const after: M15Bar[] = [
    { open: 99.85, high: 100.1, low: 99.82, close: 100.0, volume: 100 },
    { open: 100.0, high: 100.2, low: 99.9, close: 100.1, volume: 100 },
    { open: 100.1, high: 100.3, low: 100.0, close: 100.2, volume: 100 },
    BAND,
    BAND,
  ];
  const run = buildSweepFixture(outside[0], [outside[1], outside[2], reclaim, ...after]);
  const result = runKeyVolume("synthetic", run, SWEEP_OVERRIDES);
  assert.equal(result.diagnostics.sweepsSlow, 2, "cú lồng ở 602 và cú chính ở 603");
  const plan = result.plans.find((item) => item.triggerTime === run[reclaimIndex].openTime);
  assert.ok(plan);
  assert.equal(plan.branch, "sweep-reclaim");
  assert.equal(plan.direction, "long");
  assert.equal(plan.triggerTime, run[reclaimIndex].openTime);
  assert.equal(plan.sweepBreakTime, run[SWEEP_BAR].openTime);
  assert.equal(plan.structuralStop, 98.6, "SL gốc ở điểm xa nhất của cả đoạn vượt mức");
  assert.equal(plan.obLow, 99.4);
  assert.equal(plan.obHigh, 99.8);
  assert.equal(plan.sweepTarget, 101.0, "TP là đỉnh của cùng cửa sổ cho ra mức bị quét");

  // Một nến đóng lại vào trong rồi giá thủng tiếp là cú quét MỚI, không nối dài cú cũ:
  // nến đóng lại kết thúc đoạn nằm ngoài.
  const twice = buildSweepFixture(
    { open: 100.3, high: 100.6, low: 99.0, close: 100.2, volume: 100 },
    [{ open: 100.2, high: 100.3, low: 98.8, close: 98.9, volume: 100 }, reclaim],
  );
  const second = findSweep(twice, SWEEP_BAR + 2, "long", P.sweepLookback, P.sweepProminenceBars, 16);
  assert.ok(second);
  assert.equal(second.breakIndex, SWEEP_BAR + 1, "lần thủng thứ hai tính riêng");
  assert.equal(second.level, 99.0, "mức lúc này là râu của cú quét trước — lần nào cũng tính");
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

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE C — NHÁNH 3: TRAP QUA KEY (user 03/10/26, ví dụ BTC 23/09: đóng trên
// key 10:30, đỉnh 87.247 lúc 11:30, đóng quay về dưới key 1,09 ATR lúc 12:45).
// ─────────────────────────────────────────────────────────────────────────────
const TRAP_KEY_BAR = 100;
// Engine chỉ bắt đầu xét từ nến 576 (cửa sổ quét + kiểm nổi bật), kể cả khi tắt nhánh quét.
const TRAP_BREAK = 700;
/** Đi ngang DƯỚI key 100,0 — TR 0,4 nên ATR fixture quanh 0,45. */
const TRAP_BELOW: M15Bar = { open: 99.3, high: 99.5, low: 99.1, close: 99.4, volume: 100 };
const TRAP_ABOVE: M15Bar = { open: 100.3, high: 100.6, low: 100.1, close: 100.35, volume: 100 };
const TRAP_PEAK: M15Bar = { open: 100.35, high: 101.0, low: 100.3, close: 100.4, volume: 100 };
/** Đóng dưới key 0,5 giá, hơn 0,5 ATR. */
const TRAP_BACK: M15Bar = { open: 100.35, high: 100.4, low: 99.45, close: 99.5, volume: 100 };
/** Đóng dưới key chỉ 0,05 giá — sát key, chưa phải "một đoạn". */
const TRAP_NEAR: M15Bar = { open: 100.3, high: 100.35, low: 99.9, close: 99.95, volume: 100 };

/** Key 100,0 (giá mở nến volume ×20), giá nằm dưới, nến TRAP_BREAK đóng lên trên. */
function buildTrapFixture(above: M15Bar[], back: M15Bar, after: M15Bar[] = [TRAP_BELOW, TRAP_BELOW]): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < TRAP_BREAK; i++) {
    pushM15(bars, i === TRAP_KEY_BAR
      ? { open: 100.0, high: 100.1, low: 99.0, close: 99.2, volume: 2000 }
      : TRAP_BELOW);
  }
  pushM15(bars, { open: 99.4, high: 100.5, low: 99.35, close: 100.3, volume: 100 });
  for (const bar of [...above, back, ...after]) pushM15(bars, bar);
  return bars;
}

const TRAP_OVERRIDES = {
  ...KEY_VOLUME_CONFIG,
  minRR: 0,
  requireStructuralTarget: false,
  // Key của fixture không đi chu trình chín; luật chín có test riêng.
  requireKeyMaturation: false,
  // Đo riêng nhánh trap.
  enableSweepBranch: false,
  enableVolumeReversalBranch: false,
  enableLowerHighBranch: false,
};

function testKeyTrapShortsTheFailedBreak(): void {
  const bars = buildTrapFixture([TRAP_ABOVE, TRAP_PEAK, TRAP_ABOVE, TRAP_ABOVE], TRAP_BACK);
  const backIndex = TRAP_BREAK + 5;
  const result = runKeyVolume("synthetic", bars, TRAP_OVERRIDES);
  assert.equal(result.levels.length, 1);
  assert.equal(result.diagnostics.keyTrapPlans, 1);
  const plan = result.plans.find((item) => item.branch === "key-trap");
  assert.ok(plan, "đóng qua key rồi đóng quay về đủ xa trong hạn -> trap");
  assert.equal(plan.direction, "short", "phá LÊN rồi quay về -> SHORT");
  assert.equal(plan.key?.price, 100);
  assert.equal(plan.readyIndex, backIndex, "vào ngay ở nến quay về, không chờ hộp");
  assert.equal(plan.sweepBreakTime, bars[TRAP_BREAK].openTime, "đếm từ nến ĐÓNG qua key");
  assert.equal(plan.structuralStop, 101.0, "SL bám cực trị cú phá");

  const trade = result.openTrade ?? result.trades[0];
  assert.ok(trade, "trap phải thành lệnh thật");
  assert.equal(trade.branch, "key-trap");
  assert.equal(trade.dir, "short");
  assert.equal(trade.entryPrice, 99.5, "vào ở giá ĐÓNG nến quay về");
  assert.equal(trade.entryTime, bars[backIndex].openTime);
  assert.ok(trade.initialSL > 101.0, "SL ngay ngoài đỉnh cú phá, có đệm");

  const off = runKeyVolume("synthetic", bars, { ...TRAP_OVERRIDES, enableKeyTrapBranch: false });
  assert.equal(off.plans.length, 0, "tắt nhánh trap thì fixture không sinh kế hoạch nào");
}

/** Đóng sát key chưa phải quay về: không vào, nhưng cũng không huỷ hay đếm lại trap. */
function testKeyTrapNeedsADistinctReturn(): void {
  const near = runKeyVolume(
    "synthetic",
    buildTrapFixture([TRAP_ABOVE], TRAP_NEAR, [TRAP_ABOVE, TRAP_ABOVE]),
    TRAP_OVERRIDES,
  );
  assert.equal(near.diagnostics.keyTrapPlans, 0, "đóng dưới key 0,05 giá (< 0,5 ATR) chưa tính");

  const bars = buildTrapFixture([TRAP_ABOVE, TRAP_NEAR, TRAP_ABOVE], TRAP_BACK);
  const later = runKeyVolume("synthetic", bars, TRAP_OVERRIDES);
  const plan = later.plans.find((item) => item.branch === "key-trap");
  assert.ok(plan, "nến sát key không huỷ trap; nến quay về đủ xa sau đó vẫn vào");
  assert.equal(plan.sweepBreakTime, bars[TRAP_BREAK].openTime, "đóng qua lại sát key không đếm lại từ đầu");
}

/** Tối đa 16 nến bên kia key, đếm từ nến phá: quay về ở nến thứ 16 vào, thứ 17 thì cú phá là thật. */
function testKeyTrapMaxBarsBoundary(): void {
  const max = KEY_VOLUME_CONFIG.keyTrapMaxBars;
  const inTime = runKeyVolume(
    "synthetic",
    buildTrapFixture(Array(max - 1).fill(TRAP_ABOVE), TRAP_BACK),
    TRAP_OVERRIDES,
  );
  assert.equal(inTime.diagnostics.keyTrapPlans, 1, `${max} nến bên kia key vẫn là trap`);
  const late = runKeyVolume(
    "synthetic",
    buildTrapFixture(Array(max).fill(TRAP_ABOVE), TRAP_BACK),
    TRAP_OVERRIDES,
  );
  assert.equal(late.diagnostics.keyTrapPlans, 0, `${max + 1} nến bên kia key: cú phá là thật`);
}

/**
 * BTC 02/10: râu 19:30 lên 87.249,6 nhưng đóng dưới key, 19:45 mới đóng trên key.
 * Cây râu đó thuộc đoạn trap, nên SL phải nằm ngoài nó chứ không chỉ ngoài phần
 * giá sau nến phá. Cây đóng hẳn phía bên kia từ trước thì không lùi qua.
 */
function testKeyTrapStopCoversWickBeforeBreak(): void {
  const bars = buildTrapFixture([TRAP_ABOVE, TRAP_PEAK, TRAP_ABOVE], TRAP_BACK);
  bars[TRAP_BREAK - 1] = { ...bars[TRAP_BREAK - 1], high: 101.5, close: 99.45 };
  const result = runKeyVolume("synthetic", bars, TRAP_OVERRIDES);
  const plan = result.plans.find((item) => item.branch === "key-trap");
  assert.ok(plan);
  assert.equal(plan.sweepBreakTime, bars[TRAP_BREAK].openTime, "vẫn đếm 16 nến từ nến ĐÓNG qua key");
  assert.equal(plan.structuralStop, 101.5, "SL ngoài cả cây râu thò qua key ngay trước nến phá");
  const trade = result.openTrade ?? result.trades[0];
  assert.ok(trade);
  assert.ok(trade.initialSL > 101.5);

  const without = runKeyVolume("synthetic", buildTrapFixture([TRAP_ABOVE, TRAP_PEAK, TRAP_ABOVE], TRAP_BACK), TRAP_OVERRIDES);
  assert.equal(
    without.plans.find((item) => item.branch === "key-trap")?.structuralStop,
    101.0,
    "không có râu trước nến phá thì SL vẫn ở đỉnh sau nến phá",
  );
}

/** Gương: phá XUỐNG rồi quay về -> LONG, SL dưới đáy cú phá. */
function testActiveKeyCapPushesOutOldest(): void {
  const day = TF_MS["1d"];
  const key = (n: number, maturedAt: number, expiresAt = maturedAt + 15 * day): KeyVolumeLevel => ({
    id: `k${n}`, sourceTf: "15m", price: 100 + n, zoneLow: 100 + n, zoneHigh: 100 + n,
    eventTime: maturedAt - day, confirmedAt: maturedAt - day, maturedAt, expiresAt, volumeRatio: 5,
  });
  // k0 hết hạn tự nhiên trước khi k5 chín nên nhường chỗ, không ai bị đẩy thêm.
  const input = [key(5, 10 * day), key(0, 0, 3 * day), key(1, day), key(2, 2 * day), key(3, 3 * day), key(4, 4 * day)];
  const capped = capActiveKeyLevels(input, 4);
  const byId = new Map(capped.map((level) => [level.id, level]));
  assert.equal(byId.get("k0")!.expiresAt, 3 * day, "k0 hết hạn tự nhiên trước khi k4 chín: giữ nguyên hạn");
  assert.equal(byId.get("k1")!.expiresAt, 10 * day - 1, "k5 chín khi đã đủ 4 key: k1 (chín sớm nhất) bị đẩy ra");
  assert.equal(byId.get("k2")!.expiresAt, 17 * day, "k2 còn chỗ nên giữ hạn 15 ngày");
  assert.equal(input[2].expiresAt, 16 * day, "không sửa mảng đầu vào");
  for (let t = 0; t <= 30 * day; t += day / 4) {
    const alive = capped.filter((level) => isKeyVolumeLevelActive(level, t)).length;
    assert.ok(alive <= 4, `tối đa 4 key sống cùng lúc (t=${t / day} ngày: ${alive})`);
  }
}

/**
 * Nhánh 4, dựng theo BTC 31/08: râu chạm key 100 tạo đỉnh phản ứng 100,3, giá rơi,
 * hồi bằng một nến XANH lên đỉnh thấp hơn 99,75, nến sau đóng thấp hơn xác nhận đỉnh
 * → lệnh chờ bán ở mép dưới thân nến xanh (99,3), giá hồi lên chạm thì khớp.
 */
function buildLowerHighFixture(confirmClose: number): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < TRAP_BREAK; i++) {
    pushM15(bars, i === TRAP_KEY_BAR
      ? { open: 100.0, high: 100.1, low: 99.0, close: 99.2, volume: 2000 }
      : TRAP_BELOW);
  }
  for (const bar of [
    { open: 99.4, high: 99.9, low: 99.35, close: 99.85, volume: 100 },
    { open: 99.85, high: 100.3, low: 99.8, close: 99.95, volume: 100 }, // đỉnh phản ứng, chạm key
    { open: 99.95, high: 100.0, low: 99.4, close: 99.45, volume: 100 },
    { open: 99.45, high: 99.5, low: 99.2, close: 99.3, volume: 100 },
    { open: 99.3, high: 99.75, low: 99.25, close: 99.7, volume: 100 }, // đỉnh thấp hơn = nến xanh OB
    { open: 99.7, high: 99.72, low: 99.1, close: confirmClose, volume: 100 }, // xác nhận đỉnh
    { open: 99.15, high: 99.35, low: 99.1, close: 99.2, volume: 100 }, // hồi lên chạm mép -> khớp
    TRAP_BELOW,
    TRAP_BELOW,
  ]) pushM15(bars, bar);
  return bars;
}

const LOWER_HIGH_OVERRIDES = {
  ...TRAP_OVERRIDES,
  enableKeyTrapBranch: false,
  enableLowerHighBranch: true,
};

function testLowerHighAfterKeyReaction(): void {
  const bars = buildLowerHighFixture(99.15);
  const result = runKeyVolume("synthetic", bars, LOWER_HIGH_OVERRIDES);
  const plan = result.plans.find((item) => item.branch === "key-lower-high");
  assert.ok(plan, "chạm key -> đỉnh thấp hơn -> kế hoạch lệnh chờ");
  assert.equal(result.diagnostics.lowerHighPlans, 1);
  assert.equal(plan.direction, "short");
  assert.equal(plan.structuralStop, 100.3, "SL gốc là đỉnh phản ứng liền trước");
  assert.equal(plan.priorExtremeTime, bars[TRAP_BREAK + 1].openTime);
  assert.equal(plan.obEntryEdge, 99.3, "mép dưới THÂN nến xanh cuối của nhịp hồi");
  assert.equal(plan.readyIndex, TRAP_BREAK + 6, "khớp được từ nến SAU nến xác nhận đỉnh");

  const trade = result.openTrade ?? result.trades[0];
  assert.ok(trade, "giá hồi chạm mép phải khớp");
  assert.equal(trade.branch, "key-lower-high");
  assert.equal(trade.entryPrice, 99.3, "khớp ở mép, không ở giá mở");
  assert.equal(trade.entryTime, bars[TRAP_BREAK + 6].openTime);
  assert.ok(trade.initialSL > 100.3, "SL ngoài đỉnh trước, có đệm");

  const off = runKeyVolume("synthetic", bars, { ...LOWER_HIGH_OVERRIDES, enableLowerHighBranch: false });
  assert.equal(off.plans.length, 0, "tắt nhánh 4 thì fixture không sinh kế hoạch nào");
}

/** Mép đã nằm dưới giá lúc đặt thì "lệnh chờ bán" là lệnh thị trường — bỏ. */
function testLowerHighNeedsARealLimit(): void {
  const result = runKeyVolume("synthetic", buildLowerHighFixture(99.35), LOWER_HIGH_OVERRIDES);
  assert.equal(result.diagnostics.lowerHighPlans, 0, "nến xác nhận đóng 99,35 trên mép 99,3");
}

function testKeyTrapMirrorsToLong(): void {
  const bars = buildTrapFixture([TRAP_ABOVE, TRAP_PEAK, TRAP_ABOVE, TRAP_ABOVE], TRAP_BACK)
    .map((bar) => ({ ...bar, open: 200 - bar.open, high: 200 - bar.low, low: 200 - bar.high, close: 200 - bar.close }));
  const result = runKeyVolume("synthetic", bars, TRAP_OVERRIDES);
  const plan = result.plans.find((item) => item.branch === "key-trap");
  assert.ok(plan);
  assert.equal(plan.direction, "long");
  assert.equal(plan.structuralStop, 99.0);
  const trade = result.openTrade ?? result.trades[0];
  assert.ok(trade);
  assert.equal(trade.entryPrice, 100.5);
  assert.ok(trade.initialSL < 99.0);
}

testMedians();
testSourceBackedDefaults();
testCenteredKeyWindowAndNoLookahead();
testDirectionAgainstKey();
testReversalOrderBlockCases();
testRsiSeries();
testRsiDivergenceAtKey();
testHasRisingSwings();
testKeyMaturation();
testKeyTouchLimit();
testMinStopPct();
testDepartureGate();
testDoubleTopBottom();
testSessionFilter();
testReentryModes();
testConditionalReentryAndLeverageCap();
testSweepAndReclaim();
testSweepBranchNeedsNoKey();
testSweepBranchStopAndTarget();
testSweepBranchStillFacesRoomGate();
testSweepEntersAtReclaimClose();
testAmbiguousSweepIsSkipped();
testSweepOrderBlockLimitEntry();
testSweepOrderBlockNeedsRetestBelowWick();
testPartialAtOneRMovesStopToEntry();
testOpenPositionIsReported();
testVolumeBranchStillNeedsKey();
testKeyTouchNeedsARealReturn();
testKeyMustBeInsideTheBlock();
testRisingBarsAloneDoNotTrigger();
testSwingConfirmationGate();
testApproachLabel();
testBoxesArmedWhileHolding();
testBothBranchesOnSameBar();
testStopOnFirstRiskBar();
testSameBarStopBeatsTarget();
testNoLookaheadOnPlans();
testSweepProminence();
testSlowSweepReturn();
testOrderBlockIgnoresWicks();
testSweepWithoutDepartureIsDropped();
testArmedBoxExpiresAfterTwoDays();
testRetouchDoesNotExtendTheClock();
testBoxWaitBoundaryIsExact();
testArmedBoxDiesOnCloseThroughBox();
testGreenCandleClosingInsideBoxDoesNotEnter();
testConfirmationMustStillTouchTheBox();
testEntryBarIsNotItsOwnRiskBar();
testKeyTrapShortsTheFailedBreak();
testKeyTrapNeedsADistinctReturn();
testKeyTrapMaxBarsBoundary();
testKeyTrapStopCoversWickBeforeBreak();
testKeyTrapMirrorsToLong();
testActiveKeyCapPushesOutOldest();
testLowerHighAfterKeyReaction();
testLowerHighNeedsARealLimit();
console.log("Key Volume tests: OK");
