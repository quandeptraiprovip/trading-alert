/**
 * fxdream-alert.ts
 *
 * MÔ-ĐUN CẢNH BÁO TELEGRAM BÁN TỰ ĐỘNG CHO PHƯƠNG PHÁP FX DREAM TRADING.
 *
 * Nhiệm vụ:
 * 1. Quét bán tự động nhưng fail-closed: phép đo source-aligned mới chưa có
 *    cấu hình dương trên holdout sau chi phí.
 * 2. Chỉ tự động hóa phần có thể định nghĩa khách quan:
 *    - Daily Trap Gate #31 đúng ba câu hỏi.
 *    - Key candidate là nến H1 có volume bất thường; không đợi phản ứng tương lai.
 *    - Sweep/reclaim thật và mẫu nến xác nhận M15 đúng bộ mẫu đã đối chiếu.
 * 3. Luôn ghi rõ đây là ứng viên SFP; W1/H4, M5 Volume Profile, actual OB/FTR,
 *    vĩ mô và phiên giao dịch vẫn phải xác nhận thủ công.
 * 4. Fail-closed nếu chưa có holdout dương hoặc chi phí vượt mức đã kiểm chứng;
 *    không phát card target giả định khi không có cấu trúc đối diện.
 */

import fs from "fs";
import path from "path";
import "./load-env";
import { fetchKlinesPaged } from "./kline-fetch";
import { findSwings, TF_MS } from "./strategy";
import { loadTelegramConfig, sendTelegram, formatSymbol, fmtPrice, formatTimeVn } from "./telegram";
import {
  FXDREAM_V2_CONFIG,
  FXDreamV2Params,
  findKeyVolumeLevelsV2,
  evaluateDailyContextV2,
  detectSFPSignalsV2,
  buildSignalPlanV2,
  findNearestOpposingStructurePrice,
  getKeyZoneBounds,
  selectBestSFPEventV2,
  estimatedRoundTripFrictionRate,
  isExecutionCostSupported,
  SignalPlan,
} from "./fxdream-research/strategy-engine-v2";

const DATA_DIR = path.resolve(process.env.FXDREAM_DATA_DIR?.trim() || process.cwd());
const STATE_FILE = path.join(DATA_DIR, "fxdream-alert-state.json");

export interface FXDreamAlertState {
  sentAlerts: Record<string, number>; // alertId -> timestamp
}

export function loadAlertState(): FXDreamAlertState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Lỗi đọc state alert FXDream:", err);
  }
  return { sentAlerts: {} };
}

export function saveAlertState(state: FXDreamAlertState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("Lỗi ghi state alert FXDream:", err);
  }
}

export function buildFXDreamTelegramCard(plan: SignalPlan): string {
  const symbolStr = formatSymbol(plan.symbol);
  const dirStr = plan.dir === "long" ? "🟢 BUY / LONG" : "🔴 SELL / SHORT";
  const confirmTimeStr = formatTimeVn(plan.createdTime);

  const keyTf = plan.sfpEvent.keyLevel.tf.toUpperCase();
  const keyZone = getKeyZoneBounds(plan.sfpEvent.keyLevel);
  const keyZoneText = keyZone.low === keyZone.high
    ? `$${fmtPrice(keyZone.low)}`
    : `$${fmtPrice(keyZone.low)}–$${fmtPrice(keyZone.high)}`;
  const volSpike = plan.sfpEvent.keyLevel.volumeRatio.toFixed(1);
  const pattern = plan.sfpEvent.patternName;

  const entryPrice = fmtPrice(plan.entryPrice);
  const slPrice = fmtPrice(plan.initialSL);
  const stopPct = (Math.abs(plan.entryPrice - plan.initialSL) / plan.entryPrice * 100).toFixed(2);

  const target2Struct = fmtPrice(plan.targetPrice);
  const targetR2 = plan.targetR.toFixed(1);
  const frictionPct = (plan.estimatedFrictionRate * 100).toFixed(3);

  return (
    `🎯 *[FX DREAM — ỨNG VIÊN SFP]* — *${symbolStr}*\n` +
    `──────────────────────────────────\n` +
    `⚠️ *Cần xác nhận thủ công; đây chưa phải một lệnh FXDream hoàn chỉnh.*\n` +
    `📍 *Phần đã tự động hóa:* M15 SFP Sweep + ${pattern}\n` +
    `🏛️ *H1 abnormal-volume candle:* point \`$${fmtPrice(plan.sfpEvent.keyLevel.price)}\`, range ${keyZoneText} (Vol Spike ${volSpike}x)\n` +
    `🚪 *Daily Trap Gate #31:* PASSED (chuỗi nến → chưa đóng qua → đã sweep)\n` +
    `⏰ *Thời gian xác nhận:* ${confirmTimeStr}\n\n` +
    `📊 *MỐC THAM CHIẾU, KHÔNG PHẢI KHUYẾN NGHỊ ĐẶT LIMIT:*\n` +
    `• *Hướng:* ${dirStr}\n` +
    `• *Giá đóng xác nhận:* \`$${entryPrice}\`\n` +
    `• *SL ngoài SFP wick:* \`$${slPrice}\` (khoảng *${stopPct}%*)\n` +
    `• *Cấu trúc H4 đối diện gần nhất:* \`$${target2Struct}\` (headroom thô *${targetR2}R*)\n` +
    `• *Quản trị:* mốc 1–2R chỉ để cân nhắc BE/partial theo hành vi giá; nguồn không quy định chốt 30% cố định.\n` +
    `• *Vô hiệu định lượng:* nến M15 đóng xuyên key; nguồn không đặt deadline cố định.\n` +
    `• *Vô hiệu thủ công:* luận điểm cấu trúc/volume không còn đúng thì thoát, không chờ full SL.\n\n` +
    `🔎 *CHECKLIST THỦ CÔNG BẮT BUỘC:*\n` +
    `• W1/D1: cấu trúc, bias và vị trí trong campaign.\n` +
    `• H4: hợp lưu cấu trúc thật quanh key/target; chỉnh lại vùng Key nếu volume spike trải nhiều nến.\n` +
    `• M5 Volume Profile: HVN/LVN + actual OB/FTR/Breaker và trigger vào lệnh.\n` +
    `• Macro/news, phiên giao dịch, feed volume và spread.\n\n` +
    `💸 *Ma sát giả định:* ${frictionPct}% khứ hồi.\n` +
    `💡 *Risk cap nghiên cứu:* ${plan.riskPct.toFixed(1)}%; chỉ bấm lệnh sau khi checklist thủ công đạt.`
  );
}

/**
 * Quét candidate phục vụ journal/paper review. Hàm này cố ý KHÔNG kiểm tra
 * live-validation gate, nhưng cũng không gửi Telegram hay đặt lệnh.
 */
export async function scanFXDreamResearchCandidatesForSymbol(
  symbol: string,
  params: FXDreamV2Params = FXDREAM_V2_CONFIG
): Promise<SignalPlan[]> {
  const [c15m, c1h, c4h, c1d] = await Promise.all([
    fetchKlinesPaged(symbol, "15m", 45 * 96),
    fetchKlinesPaged(symbol, "1h", params.keyMaxAgeDays * 24 + params.volumeLookback + 21),
    fetchKlinesPaged(symbol, "4h", params.keyMaxAgeDays * 6),
    fetchKlinesPaged(symbol, "1d", 400),
  ]);
  if (c15m.length < 500 || c1h.length < params.volumeLookback + 1 || c1d.length < 20) return [];

  const nowTime = Date.now();
  const validH1 = c1h.filter((c) => c.openTime + TF_MS["1h"] <= nowTime);
  const h4Valid = c4h.filter((c) => c.openTime + TF_MS["4h"] <= nowTime);
  const allKeys = findKeyVolumeLevelsV2(validH1, h4Valid, params);
  if (allKeys.length === 0) return [];

  const valid15m = c15m.filter((c) => c.openTime + TF_MS["15m"] <= nowTime);
  const validDaily = c1d.filter((c) => c.openTime + TF_MS["1d"] <= nowTime);

  const dailyCtx = evaluateDailyContextV2(validDaily, nowTime, params);
  if (!dailyCtx.trapGatePassed) return [];

  const validKeys = allKeys.filter(
    (k) =>
      k.originTime <= nowTime &&
      nowTime - k.originTime <= params.keyMaxAgeDays * TF_MS["1d"]
  );
  if (validKeys.length === 0) return [];

  const sfpEvents = detectSFPSignalsV2(valid15m, validKeys, dailyCtx, params);
  if (sfpEvents.length === 0) return [];

  const latestEvent = selectBestSFPEventV2(sfpEvents, params.keyGeometry);
  if (!latestEvent) return [];

  // Chỉ lấy tín hiệu được xác nhận trong vòng 2 nến M15 gần nhất
  if (nowTime - latestEvent.confirmTime > 2 * TF_MS["15m"]) return [];

  const swings = findSwings(h4Valid.slice(-60), 2, 2);
  const opposingTarget = findNearestOpposingStructurePrice(
    latestEvent.dir,
    latestEvent.confirmClose,
    swings,
  );

  const plan = buildSignalPlanV2(symbol, latestEvent, opposingTarget, params);
  return plan ? [plan] : [];
}

/** Đường alert/live vẫn fail-closed độc lập với scanner nghiên cứu. */
export async function checkFXDreamAlertsForSymbol(
  symbol: string,
  params: FXDreamV2Params = FXDREAM_V2_CONFIG,
): Promise<SignalPlan[]> {
  if (!isExecutionCostSupported(params)) return [];
  return scanFXDreamResearchCandidatesForSymbol(symbol, params);
}

export async function runFXDreamAlertScanner() {
  const telegramConfig = loadTelegramConfig();
  const symbols = (process.env.FXDREAM_SYMBOLS?.trim() || "XRPUSDT")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const estimatedFriction = estimatedRoundTripFrictionRate(FXDREAM_V2_CONFIG);

  console.log(`================================================================`);
  console.log(` ROBOT CẢNH BÁO BÁN TỰ ĐỘNG FX DREAM TRADING IS RUNNING 24/7`);
  console.log(`================================================================`);
  console.log(`Telegram Bot Config: ${telegramConfig.enabled ? "BẬT ✅" : "TẮT (Chỉ in console) ⚠️"}\n`);

  if (!isExecutionCostSupported(FXDREAM_V2_CONFIG)) {
    if (!FXDREAM_V2_CONFIG.validatedForLiveAlerts) {
      console.error("FXDream fail-closed: chưa có cấu hình source-aligned dương trên holdout sau chi phí.");
    } else {
      console.error(
        `FXDream fail-closed: ma sát cấu hình ${(estimatedFriction * 100).toFixed(3)}% ` +
          `cao hơn mức đã kiểm chứng ${(FXDREAM_V2_CONFIG.maxValidatedRoundTripFrictionRate * 100).toFixed(3)}%.`,
      );
    }
    return;
  }

  const state = loadAlertState();
  const pruneBefore = Date.now() - 200 * TF_MS["1d"];
  state.sentAlerts = Object.fromEntries(
    Object.entries(state.sentAlerts).filter(([, sentAt]) => sentAt >= pruneBefore),
  );

  for (const sym of symbols) {
    try {
      console.log(`[Scan] Đang kiểm tra tín hiệu FX Dream trên ${sym}...`);
      const plans = await checkFXDreamAlertsForSymbol(sym);

      for (const plan of plans) {
        const alertId = `${sym}-${plan.dir}-${plan.createdTime}`;
        if (state.sentAlerts[alertId]) {
          console.log(` -> Tín hiệu ${alertId} đã được gửi cảnh báo trước đó, bỏ qua.`);
          continue;
        }

        const msgCard = buildFXDreamTelegramCard(plan);
        console.log(`\n=================== TELEGRAM ALERT CARD ===================`);
        console.log(msgCard);
        console.log(`===========================================================\n`);

        if (telegramConfig.enabled) {
          await sendTelegram(telegramConfig, msgCard);
          console.log(` -> Đã gửi Cảnh báo FX Dream thành công tới Telegram!`);
        }

        state.sentAlerts[alertId] = Date.now();
        saveAlertState(state);
      }
    } catch (err) {
      console.error(`Lỗi khi quét tín hiệu FX Dream trên ${sym}:`, err);
    }
  }
}

// Nếu chạy trực tiếp script: npx ts-node fxdream-alert.ts
if (require.main === module) {
  runFXDreamAlertScanner().catch((err) => {
    console.error("Lỗi khởi chạy FXDream Alert Scanner:", err);
    process.exit(1);
  });
}
