/**
 * chart-keyvolume.ts — Đưa Key Volume lên chart UI dưới dạng ĐỌC-HIỂU-ĐƯỢC.
 *
 * Không sửa một luật nào trong key-volume.ts. Module này chỉ:
 *   1. chạy runKeyVolume trên nến M15,
 *   2. gắn trạng thái sống/chết cho từng key,
 *   3. dựng bằng chứng từng-điều-kiện cho mỗi lệnh đã vào.
 */

import { Candle, TF_MS } from "./strategy";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeDiagnostics,
  KeyVolumeEntryPlan,
  KeyVolumeLevel,
  KeyVolumeParams,
  KeyVolumeSourceTf,
  KeyVolumeTrade,
  runKeyVolume,
} from "./key-volume";

export type EvidenceGeometry = {
  kind: "level" | "zone" | "candle" | "segment";
  startTime: number;
  endTime: number;
  priceA: number;
  priceB?: number;
};

export type EvidenceItem = {
  label: string;
  value: string;
  threshold: string;
  pass: boolean;
  chart?: EvidenceGeometry;
};

export type KeyVolumeLevelView = {
  id: string;
  sourceTf: KeyVolumeSourceTf;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  eventTime: number;
  confirmedAt: number;
  endTime: number;
  status: "active" | "expired";
  volumeRatio: number;
  ageDays: number;
  /** Số nến M15 chạm lại vùng sau khi key được xác nhận. */
  touchCount: number;
  /** Số lần giá ĐÓNG CỬA xuyên qua vùng — luật "key phải đứng được" của user. */
  crossCount: number;
};

export type KeyVolumeEntryView = {
  id: string;
  dir: "long" | "short";
  branch: KeyVolumeTrade["branch"];
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  target: number;
  exitTime: number;
  exitPrice: number;
  exitReason: KeyVolumeTrade["exitReason"];
  exitReasonLabel: string;
  netR: number;
  holdBars: number;
  keyId: string | null;
  /** `null` với lệnh nhánh quét — nhánh đó không dùng key. */
  keyPrice: number | null;
  summary: string;
  evidence: EvidenceItem[];
  chartContext: EvidenceGeometry | null;
};

export type KeyVolumeView = {
  generatedAt: number;
  baseTf: string;
  days: number;
  configLine: string;
  levels: KeyVolumeLevelView[];
  entries: KeyVolumeEntryView[];
  diagnostics: KeyVolumeDiagnostics;
  note: string;
};

const EXIT_LABELS: Record<KeyVolumeTrade["exitReason"], string> = {
  stop: "Chạm SL",
  "positive-stop": "Stop dương (đã dời trên giá vào)",
  target: "Chạm mục tiêu cấu trúc",
  "entry-invalid": "Setup hỏng trước khi chạy",
  "key-invalid": "Key bị phá trong lúc giữ lệnh",
  "no-follow-through": "Vào xong giá không chạy tiếp",
};

const BRANCH_LABELS: Record<KeyVolumeTrade["branch"], string> = {
  "sweep-reclaim": "quét thanh khoản rồi giành lại",
  "volume-reversal": "mô hình nến đảo chiều có volume",
};

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function priceDigits(value: number): number {
  return value >= 1000 ? 1 : value >= 1 ? 2 : 5;
}

function fmtPrice(value: number): string {
  const digits = priceDigits(value);
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Đếm số lần giá chạm lại vùng và số lần ĐÓNG CỬA xuyên qua nó.
 * `crossCount` là hiện thân của luật user tự phát biểu: key phải đứng được một
 * thời gian và không bị đóng xuyên. Detector production KHÔNG dùng luật này để
 * loại key, nên đây là cột để bạn tự lọc bằng mắt.
 */
function levelReaction(
  level: KeyVolumeLevel,
  m15: Candle[],
  startIndex: number,
): { touchCount: number; crossCount: number } {
  let touchCount = 0;
  let crossCount = 0;
  let side = 0;
  for (let i = startIndex; i < m15.length; i++) {
    const candle = m15[i];
    if (candle.openTime > level.expiresAt) break;
    if (candle.low <= level.zoneHigh && candle.high >= level.zoneLow) touchCount++;
    const next = candle.close > level.zoneHigh ? 1 : candle.close < level.zoneLow ? -1 : 0;
    if (next !== 0) {
      if (side !== 0 && next !== side) crossCount++;
      side = next;
    }
  }
  return { touchCount, crossCount };
}

function firstIndexAtOrAfter(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].openTime < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Nối trade ngược về plan sinh ra nó — giờ chỉ là tra cứu theo `trade.planId`.
 *
 * Bản cũ dựng lại bộ lọc của cây entry và so `plan.readyIndex === bar vào lệnh`.
 * Điều kiện đó KHÔNG BAO GIỜ đúng với hộp có chờ: `readyIndex` là nến trang bị
 * hộp, còn giá vào là giá ĐÓNG của nến retest xác nhận, luôn muộn hơn. Hệ quả là
 * `plan` luôn `null` và bảng bằng chứng mất hai điều kiện (order block, gốc SL).
 */
function matchPlan(trade: KeyVolumeTrade, plans: KeyVolumeEntryPlan[]): KeyVolumeEntryPlan | null {
  return plans.find((plan) => plan.id === trade.planId) ?? null;
}

function buildEvidence(
  trade: KeyVolumeTrade,
  plan: KeyVolumeEntryPlan | null,
  params: KeyVolumeParams,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const key = plan?.key;
  const risk = Math.abs(trade.entryPrice - trade.initialSL);
  const confirmMs = TF_MS[params.confirmTf];
  const half = Math.floor(params.volumeLookback / 2);

  if (key) {
    items.push({
      label: `Key ${key.sourceTf} @ ${fmtPrice(key.price)}`,
      value: `volume ×${round(key.volumeRatio, 2)} so với trung vị ${half} nến trước + ${half} nến sau`,
      threshold: `≥ ×${params.volumeSpikeMult}`,
      pass: key.volumeRatio >= params.volumeSpikeMult,
      chart: {
        kind: "zone",
        startTime: key.eventTime,
        endTime: trade.entryTime,
        priceA: key.zoneLow,
        priceB: key.zoneHigh,
      },
    });

    const ageDays = (trade.entryTime - key.confirmedAt) / TF_MS["1d"];
    items.push({
      label: "Tuổi key lúc vào lệnh",
      value: `${round(ageDays, 2)} ngày kể từ lúc nến cuối cửa sổ đóng`,
      threshold: `≤ ${params.keyMaxAgeDays} ngày`,
      pass: ageDays <= params.keyMaxAgeDays,
      chart: { kind: "segment", startTime: key.confirmedAt, endTime: trade.entryTime, priceA: key.price },
    });

    const keyMid = (key.zoneLow + key.zoneHigh) / 2;
    items.push({
      label: "Hướng lệnh so với key",
      value: trade.dir === "long"
        ? `nến chạm đóng TRÊN đường key (${fmtPrice(keyMid)}) — key làm đỡ`
        : `nến chạm đóng DƯỚI đường key (${fmtPrice(keyMid)}) — key làm cản`,
      threshold: "trên → LONG, dưới → SHORT",
      pass: true,
      chart: { kind: "level", startTime: key.confirmedAt, endTime: trade.entryTime, priceA: keyMid },
    });
  }

  items.push({
    label: "Nhánh bóp cò",
    value: BRANCH_LABELS[trade.branch],
    threshold: trade.branch === "sweep-reclaim"
      ? `quét cực trị ${params.sweepLookback} nến ${params.confirmTf} (mức đó phải sạch ${params.sweepProminenceBars} nến về trước) rồi ĐÓNG lại trong biên — không cần key, không cần mô hình nến`
      : `mô hình nến đảo chiều tại key, volume ≥ ×${params.reversalVolumeMult}`,
    pass: true,
    chart: {
      kind: "candle",
      startTime: trade.entryTime - confirmMs,
      endTime: trade.entryTime,
      priceA: trade.entryPrice,
    },
  });

  items.push({
    label: "Volume cây bóp cò",
    value: `×${round(trade.triggerVolumeRatio, 2)} so với trung vị ${params.touchVolumeLookback} nến liền trước`,
    threshold: trade.branch === "volume-reversal"
      ? `≥ ×${params.reversalVolumeMult}`
      : `≥ ×${params.touchVolumeSpikeMult} (nhánh quét không đòi thêm volume)`,
    pass: trade.branch === "volume-reversal"
      ? trade.triggerVolumeRatio >= params.reversalVolumeMult
      : trade.triggerVolumeRatio >= params.touchVolumeSpikeMult,
  });

  if (plan) {
    const obRole = params.stopMode === "order-block"
      ? `vào ở mép ${trade.dir === "long" ? "TRÊN" : "DƯỚI"}, SL ngay ngoài mép kia`
      : "đóng xuyên thân này là setup hỏng";
    items.push({
      label: `Order block — cụm ${plan.clusterBars} nến (thân, bỏ râu)`,
      value: `${fmtPrice(plan.obLow)} – ${fmtPrice(plan.obHigh)}; ${obRole}`,
      threshold: params.stopMode === "order-block"
        ? `quay lại hộp rồi ĐÓNG vượt ${fmtPrice(plan.obEntryEdge)}; vào ở giá đóng đó`
        : "vùng vô hiệu hoá lệnh",
      pass: true,
      chart: {
        kind: "zone",
        // Hộp nằm ở CỤM NẾN, không nằm ở nến retest. Neo mép trái vào nến bóp cò
        // rồi lùi lại cho đủ `clusterBars`, và kéo tới lúc thoát vì hộp còn là
        // mức tham chiếu suốt thời gian giữ lệnh.
        startTime: plan.triggerTime - (Math.max(1, plan.clusterBars) - 1) * confirmMs,
        endTime: trade.exitTime,
        priceA: plan.obLow,
        priceB: plan.obHigh,
      },
    });

    const isSweep = trade.branch === "sweep-reclaim";
    items.push({
      label: isSweep ? "Râu vừa quét" : "Cực trị cửa sổ chạm key → bóp cò",
      value: `${fmtPrice(plan.structuralStop)} — ${isSweep ? "đầu mút cái râu vừa ăn stop" : "đáy/đỉnh cú trap"}`
        + (params.stopMode === "order-block" ? " (luật CŨ, SL hiện bám mép hộp)" : ", gốc của SL"),
      threshold: `stopMode = ${params.stopMode}`,
      pass: true,
      chart: {
        kind: "level",
        // Gốc SL cũng thuộc cụm/cửa sổ trap, nên neo theo nến bóp cò rồi kéo tới
        // giá vào — không neo theo nến vào lệnh.
        startTime: plan.triggerTime - (isSweep ? 1 : params.sweepWaitBars) * confirmMs,
        endTime: trade.entryTime,
        priceA: plan.structuralStop,
      },
    });
  }

  const riskPct = (risk / trade.entryPrice) * 100;
  const stopSource = params.stopMode === "order-block"
    ? `ngoài mép ${trade.dir === "long" ? "dưới" : "trên"} order block`
    : trade.branch === "sweep-reclaim"
    ? "ngoài râu vừa quét"
    : params.stopMode === "sweep-window"
      ? "cực trị cửa sổ trap"
      : params.stopMode === "confirmation"
        ? "cực trị nến bóp cò"
        : "biên key";
  items.push({
    label: "Stop loss",
    value: `${fmtPrice(trade.initialSL)} — ${stopSource}, đệm ${params.stopBufferAtr}×ATR, rủi ro ${round(riskPct, 2)}% giá`,
    threshold: `≤ ${round(params.maxStopPct * 100, 2)}% giá`,
    pass: riskPct <= params.maxStopPct * 100,
    chart: { kind: "level", startTime: trade.entryTime, endTime: trade.exitTime, priceA: trade.initialSL },
  });

  // targetMode "nearest-structure" → targetR CHÍNH LÀ dư địa tới mục tiêu cấu trúc.
  const targetR = risk > 0 ? Math.abs(trade.target - trade.entryPrice) / risk : 0;
  items.push({
    label: trade.branch === "sweep-reclaim"
      ? "Dư địa tới thanh khoản đối diện"
      : "Dư địa tới key đối diện",
    value: params.targetMode === "nearest-structure"
      ? `${round(targetR, 2)}R tới ${fmtPrice(trade.target)}`
      : `${round(targetR, 2)}R (đã chặn trần ${params.finalTargetR}R)`,
    threshold: `≥ ${params.minRR}R${params.requireStructuralTarget ? ", và bắt buộc phải có key đối diện" : ""}`,
    pass: targetR >= params.minRR,
    chart: { kind: "level", startTime: trade.entryTime, endTime: trade.exitTime, priceA: trade.target },
  });

  return items;
}

function summarize(trade: KeyVolumeTrade, plan: KeyVolumeEntryPlan | null): string {
  const key = plan?.key;
  const side = trade.dir === "long" ? "LONG" : "SHORT";
  const risk = Math.abs(trade.entryPrice - trade.initialSL);
  const targetR = risk > 0 ? Math.abs(trade.target - trade.entryPrice) / risk : 0;
  const tail = ` SL ${fmtPrice(trade.initialSL)}, dư địa ${round(targetR, 2)}R tới ${fmtPrice(trade.target)}.`;
  // Nhánh quét không có key: kể câu chuyện thanh khoản, đừng bịa ra một key.
  if (!key) {
    const swept = trade.dir === "long" ? "ĐÁY" : "ĐỈNH";
    return `${side} sau khi giá quét ${swept} một ngày rồi đóng lại trong biên;`
      + ` không dùng key ở bất kỳ khâu nào; SL ngoài râu vừa quét.${tail}`;
  }
  const position = trade.dir === "long" ? "giá đứng TRÊN key" : "giá nằm DƯỚI key";
  return `${side} tại key ${key.sourceTf} @ ${fmtPrice(key.price)}`
    + ` (volume ×${round(key.volumeRatio, 2)}); ${position};`
    + ` bóp cò bằng ${BRANCH_LABELS[trade.branch]}`
    + ` (volume cây bóp cò ×${round(trade.triggerVolumeRatio, 2)});${tail}`;
}

function configLine(params: KeyVolumeParams): string {
  const branches = [
    params.enableSweepBranch ? "quét+giành lại" : null,
    params.enableVolumeReversalBranch ? `nến đảo ×${params.reversalVolumeMult}` : null,
  ].filter(Boolean).join(" | ");
  return [
    `luật + mô phỏng trọn trên ${params.confirmTf}`,
    `key ×${params.volumeSpikeMult} / ${params.volumeLookback} nến xung quanh`,
    `hướng theo vị trí giá so với key`,
    `quét ${params.sweepLookback} nến (${round(params.sweepLookback / 96, 1)}d), không cần key · nhánh key chờ ${params.sweepWaitBars}`,
    `nhánh ${branches || "—"}`,
    `stop ${params.stopMode} +${params.stopBufferAtr}ATR ≤${round(params.maxStopPct * 100, 1)}%`,
    `minRR ${params.minRR} · target ${params.targetMode} · không có trần giữ lệnh`,
  ].join(" · ");
}

export function buildKeyVolumeView(
  symbol: string,
  m15: Candle[],
  displayStart: number,
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
): KeyVolumeView {
  const result = runKeyVolume(symbol, m15, params);
  const now = m15.at(-1)?.openTime ?? Date.now();

  const levels: KeyVolumeLevelView[] = result.levels
    .filter((level) => level.expiresAt >= displayStart)
    .map((level) => {
      const reaction = levelReaction(level, m15, firstIndexAtOrAfter(m15, level.confirmedAt));
      return {
        id: level.id,
        sourceTf: level.sourceTf,
        price: round(level.price, priceDigits(level.price)),
        zoneLow: round(level.zoneLow, priceDigits(level.zoneLow)),
        zoneHigh: round(level.zoneHigh, priceDigits(level.zoneHigh)),
        eventTime: level.eventTime,
        confirmedAt: level.confirmedAt,
        endTime: Math.min(level.expiresAt, now),
        status: now > level.expiresAt ? ("expired" as const) : ("active" as const),
        volumeRatio: round(level.volumeRatio, 2),
        ageDays: round((now - level.confirmedAt) / TF_MS["1d"], 2),
        touchCount: reaction.touchCount,
        crossCount: reaction.crossCount,
      };
    })
    .sort((a, b) => b.volumeRatio - a.volumeRatio);

  const entries: KeyVolumeEntryView[] = result.trades
    .filter((trade) => trade.entryTime >= displayStart)
    .map((trade) => {
      const plan = matchPlan(trade, result.plans);
      const key = plan?.key;
      return {
        id: `kv-${trade.entryTime}-${trade.dir}`,
        dir: trade.dir,
        branch: trade.branch,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        initialSL: trade.initialSL,
        target: trade.target,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        exitReasonLabel: EXIT_LABELS[trade.exitReason],
        netR: round(trade.netR, 3),
        holdBars: trade.holdBars,
        keyId: key?.id ?? null,
        keyPrice: trade.keyPrice,
        summary: summarize(trade, plan),
        evidence: buildEvidence(trade, plan, params),
        chartContext: key
          ? { kind: "zone" as const, startTime: key.eventTime, endTime: trade.entryTime, priceA: key.zoneLow, priceB: key.zoneHigh }
          : null,
      };
    })
    .sort((a, b) => b.entryTime - a.entryTime);

  return {
    generatedAt: Date.now(),
    baseTf: params.confirmTf,
    days: round((now - displayStart) / TF_MS["1d"], 1),
    configLine: configLine(params),
    levels,
    entries,
    diagnostics: result.diagnostics,
    note:
      "Key do detector sinh ra, KHÔNG phải key bạn tự vẽ — hai tập này từng đối chiếu và trùng 0/6. "
      + "Mọi con số R ở đây là replay của một mô hình chưa chứng minh được edge, đừng đọc như thành tích.",
  };
}
