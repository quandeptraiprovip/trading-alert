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
  atrSeriesForward,
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

/**
 * Một điều kiện chỉ có ĐÚNG MỘT trong hai dạng, và dạng quyết định cách đọc:
 *   · `so` — có số đo và có ngưỡng → UI hiện số to kèm thước có vạch ngưỡng,
 *     nhìn là biết vượt qua bao xa chứ không phải đọc hai chuỗi rồi tự so.
 *   · `co` — chỉ có / không       → UI hiện dấu tick kèm một câu.
 * `say` viết bằng tiếng thường, KHÔNG nhắc tên tham số; tên tham số chỉ còn
 * trong `gateLabel`.
 */
export type EvidenceItem = {
  kind: "so" | "co";
  label: string;
  say: string;
  state: "pass" | "fail" | "info";
  /** Chỉ dạng `so`. */
  value?: string;
  actual?: number;
  gate?: number;
  gateLabel?: string;
  gateDir?: "gte" | "lte";
  chart?: EvidenceGeometry;
};

/** Bốn chặng của một lệnh, đúng thứ tự engine đi qua. */
export type EvidenceStage = {
  n: string;
  title: string;
  items: EvidenceItem[];
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
  /** THỜI ĐIỂM khớp vào lệnh: lúc nến bật ra khỏi hộp đóng (không phải giờ mở nến). */
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  target: number;
  /**
   * `open`: lệnh chưa thoát. `exitTime`/`exitPrice`/`resultR` khi đó là lúc đóng và
   * giá đóng của nến cuối — tạm tính, không phải kết quả.
   */
  status: "open" | "closed";
  /** Lúc nến thoát lệnh đóng — hộp lệnh phủ đúng `holdBars` nến. */
  exitTime: number;
  exitPrice: number;
  exitReason: KeyVolumeTrade["exitReason"];
  exitReasonLabel: string;
  /** R thuần của chính lệnh (gồm phần chốt sớm), KHÔNG trừ phí/trượt giá/funding — user 03/10/26. */
  resultR: number;
  holdBars: number;
  keyId: string | null;
  /** `null` với lệnh nhánh quét — nhánh đó không dùng key. */
  keyPrice: number | null;
  summary: string;
  /** Một câu kết luận đọc trước mọi thứ khác. */
  verdict: string;
  /** Chuỗi cơ chế của đúng lệnh này, dựng thành chip trên UI. */
  chain: string[];
  stages: EvidenceStage[];
  /** Phẳng hoá `stages` — bảng dưới chart chỉ cần đếm đạt/không đạt. */
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
  "positive-stop": "Chạm SL đã dời về giá vào (sau khi chốt một phần)",
  target: "Chạm mục tiêu cấu trúc",
  "entry-invalid": "Setup hỏng trước khi chạy",
  open: "Đang mở · R tạm tính theo giá hiện tại",
};

const BRANCH_LABELS: Record<KeyVolumeTrade["branch"], string> = {
  "sweep-reclaim": "quét thanh khoản rồi giành lại",
  "volume-reversal": "mô hình nến đảo chiều có volume",
  "key-trap": "trap qua key rồi quay về",
  "key-lower-high": "đỉnh thấp dần (đáy cao dần) sau phản ứng tại key",
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

/** Ngày dạng "1,09" cho câu kể. */
function days(ms: number): string {
  return String(round(ms / TF_MS["1d"], 2)).replace(".", ",");
}

function num(value: number, digits = 2): string {
  return String(round(value, digits)).replace(".", ",");
}

function holdText(bars: number): string {
  const minutes = bars * 15;
  if (minutes < 60) return `${minutes} phút`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}g${m < 10 ? "0" : ""}${m}` : `${h} giờ`;
}

/** Hộp bao quanh một dải nến — dùng làm vùng sáng khi soi một điều kiện. */
function barsZone(m15: Candle[], i1: number, i2: number): EvidenceGeometry | undefined {
  const a = Math.max(0, Math.min(i1, i2));
  const b = Math.min(m15.length - 1, Math.max(i1, i2));
  if (!(b >= a) || !m15[a] || !m15[b]) return undefined;
  let low = Infinity;
  let high = -Infinity;
  for (let i = a; i <= b; i++) {
    low = Math.min(low, m15[i].low);
    high = Math.max(high, m15[i].high);
  }
  return {
    kind: "zone",
    startTime: m15[a].openTime,
    endTime: m15[b].openTime,
    priceA: low,
    priceB: high,
  };
}

function makeSo(
  label: string,
  value: string,
  actual: number,
  gate: number,
  gateDir: "gte" | "lte",
  gateLabel: string,
  say: string,
  chart?: EvidenceGeometry,
): EvidenceItem {
  const pass = gateDir === "gte" ? actual >= gate : actual <= gate;
  return { kind: "so", label, value, actual, gate, gateDir, gateLabel, say, state: pass ? "pass" : "fail", chart };
}

function makeCo(
  label: string,
  state: "pass" | "fail" | "info",
  say: string,
  chart?: EvidenceGeometry,
): EvidenceItem {
  return { kind: "co", label, say, state, chart };
}

/**
 * Mức bị quét của nhánh 1 và độ "sạch" của nó về bên trái. Đây là TÍNH LẠI cho
 * mục đích kể chuyện, dùng đúng công thức engine dùng để chấm; nếu hai bên lệch
 * nhau thì lỗi nằm ở đây, không phải ở luật.
 */
function sweepFacts(
  m15: Candle[],
  breakIndex: number,
  direction: "long" | "short",
  lookback: number,
): { level: number; at: number; prominence: number; capped: boolean } {
  const start = Math.max(0, breakIndex - lookback);
  let level = direction === "long" ? Infinity : -Infinity;
  let at = start;
  for (let i = start; i < breakIndex; i++) {
    const value = direction === "long" ? m15[i].low : m15[i].high;
    if (direction === "long" ? value < level : value > level) {
      level = value;
      at = i;
    }
  }
  // Chặn ở đúng cửa sổ quét: một mức có thể sạch tới tận đầu dữ liệu, và con số
  // "sạch 4.000 nến" không nói thêm gì so với "sạch hết cửa sổ".
  let prominence = 0;
  for (let i = at - 1; i >= 0 && prominence < lookback; i--) {
    const value = direction === "long" ? m15[i].low : m15[i].high;
    if (direction === "long" ? value < level : value > level) break;
    prominence++;
  }
  return { level, at, prominence, capped: prominence >= lookback };
}

/** Khoảng cách XA NHẤT khỏi key trong cửa sổ "đã rời key", tính bằng ATR. */
function departureAtr(
  m15: Candle[],
  atr: number[],
  triggerIndex: number,
  keyPrice: number,
  lookback: number,
): number {
  const start = Math.max(0, triggerIndex - lookback);
  let best = 0;
  for (let i = start; i <= triggerIndex && i < m15.length; i++) {
    const unit = atr[i] > 0 ? atr[i] : 0;
    if (!(unit > 0)) continue;
    best = Math.max(best, Math.abs(m15[i].close - keyPrice) / unit);
  }
  return best;
}

/**
 * Bốn chặng của một lệnh. Thứ tự đúng thứ tự engine đi qua, nên đọc từ trên
 * xuống là đọc lại đúng quyết định: thấy dấu hiệu gì → dựng hộp và đi ba bước →
 * qua hai cửa cuối → kết thúc ra sao.
 */
function buildStages(
  trade: KeyVolumeTrade,
  plan: KeyVolumeEntryPlan | null,
  m15: Candle[],
  atr: number[],
  params: KeyVolumeParams,
): EvidenceStage[] {
  const key = plan?.key ?? null;
  const trap = plan?.branch === "key-trap";
  const lowerHigh = plan?.branch === "key-lower-high";
  const long = trade.dir === "long";
  const risk = Math.abs(trade.entryPrice - trade.initialSL);
  const riskPct = (risk / trade.entryPrice) * 100;
  const targetR = risk > 0 ? Math.abs(trade.target - trade.entryPrice) / risk : 0;
  const confirmMs = TF_MS[params.confirmTf];

  const entryIndex = firstIndexAtOrAfter(m15, trade.entryTime);
  const exitIndex = firstIndexAtOrAfter(m15, trade.exitTime);
  const triggerIndex = plan ? firstIndexAtOrAfter(m15, plan.triggerTime) : entryIndex;
  const retouchIndex = trade.retouchTime == null ? null : firstIndexAtOrAfter(m15, trade.retouchTime);

  const obLow = plan?.obLow ?? Math.min(trade.entryPrice, trade.initialSL);
  const obHigh = plan?.obHigh ?? Math.max(trade.entryPrice, trade.initialSL);
  const obZone: EvidenceGeometry = {
    kind: "zone",
    startTime: plan
      ? plan.triggerTime - (Math.max(1, plan.clusterBars) - 1) * confirmMs
      : trade.entryTime,
    endTime: trade.exitTime,
    priceA: obLow,
    priceB: obHigh,
  };
  // `trade.entryTime` là giờ MỞ của chính nến bật ra khỏi hộp — giá vào là giá
  // ĐÓNG của nến đó. Tô đúng nến này, không phải nến liền trước (luật cũ vào ở
  // giá mở của nến kế tiếp mới tô lùi một nến).
  const entryCandle: EvidenceGeometry = {
    kind: "candle",
    startTime: trade.entryTime,
    endTime: trade.entryTime,
    priceA: trade.entryPrice,
  };

  // `clusterBars` là số nến từ nến đầu của hộp tới nến bóp cò, tính cả hai đầu.
  const clusterBars = Math.max(2, plan?.clusterBars ?? 2);
  const clusterZone = barsZone(m15, triggerIndex - (clusterBars - 1), triggerIndex);
  const clusterNote = plan?.clusterShape === "v-spike"
    ? `Giá lao ${long ? "xuống" : "lên"} rồi bật ngược lại rất nhanh, tạo một mũi nhọn — chính cụm này dựng ra cái hộp.`
    : plan?.clusterShape === "long-wick"
      ? `Một nến đâm râu rất dài ${long ? "xuống" : "lên"} rồi đóng cửa kéo ngược lại — chính nến này dựng ra cái hộp.`
      : plan?.clusterShape === "two-candle"
        ? `Nến ${long ? "đỏ" : "xanh"} thân dài bị nến ${long ? "xanh" : "đỏ"} thân dài ngay sau lấy lại gần hết — chính cụm này dựng ra cái hộp.`
        : "Cụm nến đảo chiều ngay tại key — chính cụm này dựng ra cái hộp.";

  // ── chặng 1 · dấu hiệu ───────────────────────────────────────────────
  const signals: EvidenceItem[] = [];
  if (key) {
    const keyLine: EvidenceGeometry = {
      kind: "level",
      startTime: key.maturedAt,
      endTime: trade.entryTime,
      priceA: key.price,
    };
    const half = Math.floor(params.volumeLookback / 2);
    signals.push(makeSo(
      "Volume sinh key",
      `×${num(key.volumeRatio)}`,
      key.volumeRatio,
      params.volumeSpikeMult,
      "gte",
      `≥ ×${num(params.volumeSpikeMult, 1)}`,
      `Cây nến này có volume gấp ${num(key.volumeRatio)} lần trung vị ${half} nến trước và ${half} nến sau — đủ mạnh để thành một key ở ${fmtPrice(key.price)}.`,
      keyLine,
    ));

    if (params.requireKeyMaturation) {
      signals.push(makeCo(
        "Key đã chín",
        "pass",
        `Giá từng rời key ≥ ${num(params.keyMatureAwayAtr, 1)} ATR, quay lại chạm rồi đóng bật ra ≥ ${num(params.keyMatureBounceAtr, 1)} ATR trong ${params.keyMatureBars} nến — key có hiệu lực ${days(trade.entryTime - key.maturedAt)} ngày trước lúc vào. Cú chạm làm key chín không phải lệnh.`,
        keyLine,
      ));
    }

    if (!trap && !lowerHigh) {
      const gone = departureAtr(m15, atr, triggerIndex, key.price, params.keyDepartureLookback + params.sweepWaitBars);
      signals.push(makeSo(
        "Đã rời key rồi mới quay về",
        `${num(gone, 1)} ATR`,
        gone,
        params.keyDepartureAtr,
        "gte",
        `≥ ${num(params.keyDepartureAtr, 1)} ATR`,
        `Trước lúc chạm, giá từng đi xa key ${num(gone, 1)} ATR. Giá đi ngang đè lên key thì không tính là quay về.`,
        barsZone(m15, triggerIndex - params.keyDepartureLookback, triggerIndex),
      ));

      signals.push(makeCo(
        "Hướng lệnh",
        "pass",
        `Nến chạm đóng ${long ? "TRÊN" : "DƯỚI"} key ${fmtPrice(key.price)} → key đang làm ${long ? "đỡ" : "cản"} → đánh ${long ? "LONG" : "SHORT"}.`
          + (trade.approach === "breakout"
            ? ` Giá về từ phía ${long ? "dưới" : "trên"}: nến chạm vừa xuyên qua key — kiểu PHÁ VỠ, báo cáo tách riêng.`
            : trade.approach === "bounce"
              ? ` Giá về từ phía ${long ? "trên" : "dưới"} — kiểu QUAY VỀ.`
              : ""),
        keyLine,
      ));
    }

    const age = trade.entryTime - key.confirmedAt;
    signals.push(makeCo(
      "Key còn hiệu lực",
      age <= params.keyMaxAgeDays * TF_MS["1d"] ? "pass" : "fail",
      `Key ${days(age)} ngày tuổi lúc vào lệnh, trần là ${params.keyMaxAgeDays} ngày.`,
      keyLine,
    ));

    // Tín hiệu A có phép đo "tại key" riêng, không qua cửa volume và cửa "key trong
    // thân hộp" của cụm — hiện hai dòng đó cho nó là kể sai.
    const isStructure = plan?.clusterShape === "rsi-divergence";
    const divergence = plan?.divergence ?? null;
    if (plan?.clusterShape === "rsi-divergence" && divergence) {
      signals.push(makeCo(
        `Hai ${long ? "đáy" : "đỉnh"} tại key + RSI phân kỳ`,
        "pass",
        `${long ? "Đáy" : "Đỉnh"} thứ hai ${fmtPrice(divergence.secondPrice)} nằm ngay tại key, ${long ? "không cao hơn" : "không thấp hơn"} ${long ? "đáy" : "đỉnh"} trước ${fmtPrice(divergence.firstPrice)}, nhưng RSI(${params.rsiPeriod}) ${long ? "cao hơn" : "thấp hơn"}: ${num(divergence.firstRsi, 1)} → ${num(divergence.secondRsi, 1)}. Giá ${long ? "ép xuống" : "đẩy lên"} mà đà ${long ? "giảm" : "tăng"} đã yếu đi.`,
        barsZone(m15, firstIndexAtOrAfter(m15, divergence.firstTime), triggerIndex),
      ));
    }
    if (!isStructure && !trap && !lowerHigh) {
      signals.push(makeCo("Cụm nến đảo chiều", "pass", clusterNote, clusterZone));
      signals.push(makeSo(
        "Volume cây đảo chiều",
        `×${num(trade.triggerVolumeRatio)}`,
        trade.triggerVolumeRatio,
        params.reversalVolumeMult,
        "gte",
        `≥ ×${num(params.reversalVolumeMult, 1)}`,
        "Chỉ cần nhỉnh hơn vài cây quanh nó, không đòi đột biến như lúc sinh key.",
        barsZone(m15, triggerIndex, triggerIndex),
      ));
    }

    if (params.requireKeyInsideBlock && !isStructure && !trap && !lowerHigh) {
      signals.push(makeCo(
        "Đảo chiều xảy ra ngay tại key",
        key.price >= obLow && key.price <= obHigh ? "pass" : "fail",
        `Đường key ${fmtPrice(key.price)} chạy xuyên thân hộp ${fmtPrice(obLow)} – ${fmtPrice(obHigh)}, không nằm lệch hẳn một bên.`,
        obZone,
      ));
    }

    if (lowerHigh && plan) {
      const top = long ? "đáy" : "đỉnh";
      const priorIndex = plan.priorExtremeTime != null ? firstIndexAtOrAfter(m15, plan.priorExtremeTime) : triggerIndex;
      const tipIndex = firstIndexAtOrAfter(m15, plan.triggerTime) - params.lowerHighPivotBars;
      const tipPrice = long ? m15[tipIndex]?.low : m15[tipIndex]?.high;
      signals.push(makeCo(
        `${long ? "Đáy" : "Đỉnh"} trước`,
        "pass",
        `${long ? "Đáy" : "Đỉnh"} swing ${fmtPrice(plan.structuralStop)} — hoặc là ${top} phản ứng ngay tại key (có nến chạm key trong ${params.lowerHighTouchBars} nến tới nó), hoặc là ${top} liền trước trong chuỗi ${long ? "đáy cao dần" : "đỉnh thấp dần"} bắt đầu từ đó.`,
        barsZone(m15, priorIndex, priorIndex),
      ));
      signals.push(makeCo(
        `${long ? "Đáy cao hơn" : "Đỉnh thấp hơn"}`,
        "pass",
        `${long ? "Đáy" : "Đỉnh"} ${tipPrice == null ? "" : `${fmtPrice(tipPrice)} `}${long ? "cao" : "thấp"} hơn ${top} trước ${fmtPrice(plan.structuralStop)} — cấu trúc đã ${long ? "đi lên" : "đi xuống"}. Pivot ${params.lowerHighPivotBars} nến mỗi bên, xác nhận khi nến bên phải đóng.`,
        barsZone(m15, priorIndex, triggerIndex),
      ));
    }

    if (trap && plan) {
      // Tính lại đúng phép đo engine dùng để chấm trap, chỉ để kể chuyện.
      const breakIndex = plan.sweepBreakTime != null ? firstIndexAtOrAfter(m15, plan.sweepBreakTime) : triggerIndex;
      // Những cây chỉ thò qua key bằng râu ngay trước nến phá cũng thuộc đoạn trap.
      let excursionStart = breakIndex;
      while (
        excursionStart > 0
        && (long
          ? m15[excursionStart - 1].low < key.price && m15[excursionStart - 1].close >= key.price
          : m15[excursionStart - 1].high > key.price && m15[excursionStart - 1].close <= key.price)
      ) excursionStart--;
      const beyond = triggerIndex - breakIndex;
      const unit = atr[triggerIndex] > 0 ? atr[triggerIndex] : 0;
      const backAtr = unit > 0 ? Math.abs(trade.entryPrice - key.price) / unit : 0;
      const pokeAtr = unit > 0 ? Math.abs(plan.structuralStop - key.price) / unit : 0;
      const away = long ? "dưới" : "trên";
      signals.push(makeCo(
        `Phá ${long ? "xuống" : "lên"} qua key`,
        "pass",
        `Nến đóng ${away} key ${fmtPrice(key.price)} trong khi nến trước còn đóng ${long ? "trên" : "dưới"} — cú phá bắt đầu.`
          + (excursionStart < breakIndex ? ` Ngay trước đó đã có ${breakIndex - excursionStart} cây thò qua key bằng râu, tính chung vào đoạn trap.` : "")
          + ` Xa nhất tới ${fmtPrice(plan.structuralStop)}, cách key ${num(pokeAtr, 1)} ATR.`,
        barsZone(m15, excursionStart, triggerIndex - 1),
      ));
      signals.push(makeSo(
        "Nằm bên kia key bao lâu",
        `${beyond} nến`,
        beyond,
        params.keyTrapMaxBars,
        "lte",
        `≤ ${params.keyTrapMaxBars} nến`,
        `Từ nến phá tới nến quay về là ${beyond} nến (${holdText(beyond)}). Nằm bên kia quá ${params.keyTrapMaxBars} nến thì cú phá là thật, không còn là trap.`,
        barsZone(m15, breakIndex, triggerIndex),
      ));
      signals.push(makeSo(
        "Đóng quay về cách key",
        `${num(backAtr, 2)} ATR`,
        backAtr,
        params.keyTrapCloseAtr,
        "gte",
        `≥ ${num(params.keyTrapCloseAtr, 1)} ATR`,
        `Nến quay về đóng ở ${fmtPrice(trade.entryPrice)}, ${long ? "trên" : "dưới"} key ${num(backAtr, 2)} ATR. Đóng sát key thì chưa tính — phải quay về một đoạn.`,
        barsZone(m15, triggerIndex, triggerIndex),
      ));
    }
  } else {
    // Mức bị quét lấy từ cửa sổ trước NẾN THỦNG: ở kiểu chạy từ từ lại, cửa sổ
    // trước nến bóp cò đã chứa chính đoạn vượt mức nên sẽ ra một mức khác.
    const breakIndex = plan?.sweepBreakTime != null
      ? firstIndexAtOrAfter(m15, plan.sweepBreakTime)
      : triggerIndex;
    const swept = sweepFacts(m15, breakIndex, trade.dir, params.sweepLookback);
    // Nến ĐÓNG LẠI vào trong mức. Ở `order-block` nến bóp cò là cuối cụm đảo chiều,
    // muộn hơn nến này, nên phải tìm lại chứ không lấy `triggerIndex`.
    let reclaimIndex = breakIndex;
    while (
      reclaimIndex < triggerIndex
      && (long ? m15[reclaimIndex].close <= swept.level : m15[reclaimIndex].close >= swept.level)
    ) reclaimIndex++;
    const slow = reclaimIndex > breakIndex;
    const sweptLabel = long ? "đáy" : "đỉnh";
    signals.push(makeCo(
      `${long ? "Đáy" : "Đỉnh"} bị quét`,
      "pass",
      `${fmtPrice(swept.level)} là ${sweptLabel} ${long ? "thấp" : "cao"} nhất của ${params.sweepLookback} nến trước nến thủng — chỗ đọng stop của người khác.`,
      { kind: "level", startTime: m15[Math.max(0, breakIndex - params.sweepLookback)].openTime, endTime: trade.entryTime, priceA: swept.level },
    ));
    signals.push(makeSo(
      "Mức bị quét nổi bật cỡ nào",
      `${swept.capped ? "≥ " : ""}${swept.prominence} nến`,
      swept.prominence,
      params.sweepProminenceBars,
      "gte",
      `≥ ${params.sweepProminenceBars} nến`,
      swept.capped
        ? `Lùi hết ${swept.prominence} nến của cửa sổ quét vẫn chưa có cây nào vượt qua mức này.`
        : `Phải lùi ${swept.prominence} nến mới có cây vượt qua mức này — không phải mút của một đoạn đang trôi.`,
      barsZone(m15, swept.at - params.sweepProminenceBars, swept.at),
    ));
    const wick = plan?.structuralStop ?? swept.level;
    signals.push(makeCo(
      slow ? "Thủng rồi chạy từ từ lại" : "Thủng rồi rút râu lại",
      "pass",
      slow
        ? `Giá thủng mức, đóng ${long ? "dưới" : "trên"} mức ${reclaimIndex - breakIndex} nến (xa nhất ${fmtPrice(wick)}), rồi một nến đóng lại ${long ? "trên" : "dưới"} mức — trong hạn ${params.sweepMaxOutsideBars} nến.`
        : `Râu tới ${fmtPrice(wick)} nhưng chính nến đó đóng lại ${long ? "trên" : "dưới"} hẳn mức bị quét — quét xong trả giá về.`,
      barsZone(m15, breakIndex, reclaimIndex),
    ));
    if (plan?.clusterShape) {
      const tip = long ? clusterZone?.priceA : clusterZone?.priceB;
      signals.push(makeCo(
        "Order block sau cú quét",
        "pass",
        `${clusterNote} Mũi nhọn ${tip == null ? "" : `${fmtPrice(tip)} `}chạm lại mức bị quét ${fmtPrice(swept.level)} mà không vượt râu ${fmtPrice(wick)}; cụm xong ${triggerIndex - reclaimIndex} nến sau cú quét (hạn ${params.sweepObWaitBars}). Chính cây râu quét không tính là order block.`,
        clusterZone,
      ));
    }
    signals.push(makeCo(
      "Nhánh này không dùng key",
      "info",
      plan?.clusterShape
        ? "Không key, không volume. Lệnh này không nói gì về key của FX Dream — nó nói về cú quét và cụm đảo chiều."
        : "Không key, không volume, không mô hình nến. Lệnh này không nói gì về FX Dream — nó chỉ nói về cú quét.",
    ));
    signals.push(makeSo(
      "Volume cây bóp cò",
      `×${num(trade.triggerVolumeRatio)}`,
      trade.triggerVolumeRatio,
      params.touchVolumeSpikeMult,
      "gte",
      "không bắt buộc",
      "Ghi lại để tham khảo; nhánh quét không đặt ngưỡng volume nào.",
      barsZone(m15, triggerIndex, triggerIndex),
    ));
  }

  // ── chặng 2 · hộp và ba bước ─────────────────────────────────────────
  // Nhánh quét `reclaim-close` không có hộp: vào ngay ở giá đóng nến đóng lại.
  // Nhánh quét `order-block` không đi ba bước: đặt lệnh chờ ở mép order block.
  const sweepDirect = !key && params.sweepEntry === "reclaim-close";
  const sweepLimit = !key && params.sweepEntry === "order-block";
  const lowerHighLimit = plan?.branch === "key-lower-high";
  const slowSweep = plan?.sweepBreakTime != null && plan.sweepBreakTime < plan.triggerTime;
  const steps: EvidenceItem[] = [];
  if (sweepLimit) {
    const edge = plan?.obEntryEdge ?? trade.entryPrice;
    steps.push(makeCo(
      "Hộp order block",
      "pass",
      `${fmtPrice(obLow)} – ${fmtPrice(obHigh)}, chỉ tính thân nến, bỏ râu. Đặt lệnh chờ ${long ? "mua" : "bán"} ở mép ${long ? "trên" : "dưới"} ${fmtPrice(edge)}, SL ngay ngoài râu quét ${fmtPrice(plan?.structuralStop ?? trade.initialSL)}.`,
      obZone,
    ));
    steps.push(makeCo(
      "Lệnh chờ khớp ở mép",
      "pass",
      `${entryIndex - triggerIndex} nến sau khi cụm đóng, giá ${long ? "lùi xuống" : "hồi lên"} chạm mép → khớp ở ${fmtPrice(trade.entryPrice)}`
        + (trade.entryPrice !== edge ? " (nến mở cửa đã vượt qua mép nên khớp ở giá mở)" : "")
        + `. Lệnh chờ sống tối đa ${params.obLimitBars} nến.`,
      entryCandle,
    ));
  } else if (lowerHighLimit) {
    const edge = plan?.obEntryEdge ?? trade.entryPrice;
    steps.push(makeCo(
      "Order block",
      "pass",
      `Thân cây nến ${long ? "đỏ" : "xanh"} cuối cùng của nhịp ${long ? "lùi xuống" : "hồi lên"} ${long ? "đáy" : "đỉnh"} đó: ${fmtPrice(obLow)} – ${fmtPrice(obHigh)}. Đặt lệnh chờ ${long ? "mua" : "bán"} ở mép ${long ? "trên" : "dưới"} ${fmtPrice(edge)}, SL ngoài ${long ? "đáy" : "đỉnh"} trước ${fmtPrice(plan?.structuralStop ?? trade.initialSL)}.`,
      obZone,
    ));
    steps.push(makeCo(
      "Lệnh chờ khớp ở mép",
      "pass",
      `${entryIndex - triggerIndex} nến sau khi ${long ? "đáy" : "đỉnh"} được xác nhận, giá ${long ? "lùi xuống" : "hồi lên"} chạm mép → khớp ở ${fmtPrice(trade.entryPrice)}. Lệnh chờ sống tối đa ${params.obLimitBars} nến.`,
      entryCandle,
    ));
  } else if (sweepDirect) {
    steps.push(makeCo(
      "Vào ngay khi nến đóng lại",
      "pass",
      `Vào ở giá đóng ${fmtPrice(trade.entryPrice)} của chính nến ${slowSweep ? "đóng trở lại vào trong mức" : "rút râu"} — không chờ hộp. SL ngay ngoài điểm xa nhất ${fmtPrice(plan?.structuralStop ?? trade.initialSL)}, đệm ${num(params.stopBufferAtr, 2)}×ATR.`,
      entryCandle,
    ));
  } else if (trap) {
    steps.push(makeCo(
      "Vào ngay khi nến quay về đóng",
      "pass",
      `Vào ở giá đóng ${fmtPrice(trade.entryPrice)} của chính nến quay về — không chờ hộp hay retest. SL ngay ngoài cực trị cú phá ${fmtPrice(plan?.structuralStop ?? trade.initialSL)}, đệm ${num(params.stopBufferAtr, 2)}×ATR.`,
      entryCandle,
    ));
  } else {
    steps.push(makeCo(
      key ? "Hộp order block" : "Hộp = thân cây nến quét",
      "pass",
      `${fmtPrice(obLow)} – ${fmtPrice(obHigh)}, chỉ tính thân nến, bỏ râu. Vào ở mép ${long ? "trên" : "dưới"}, `
        + (key ? "SL đặt ngay ngoài mép kia." : `SL đặt ngay ngoài râu quét ${fmtPrice(plan?.structuralStop ?? trade.initialSL)}.`),
      obZone,
    ));
    steps.push(makeSo(
      "Bước 1 · rời hộp",
      `${params.obDepartBars} nến`,
      params.obDepartBars,
      params.obDepartBars,
      "gte",
      `cần ${params.obDepartBars}`,
      `${params.obDepartBars} nến liên tiếp đóng cửa ${long ? "trên" : "dưới"} mép hộp. Râu thò lại vào hộp vẫn được.`,
      barsZone(m15, triggerIndex + 1, triggerIndex + params.obDepartBars),
    ));
    steps.push(makeCo(
      "Bước 2 · quay lại hộp",
      retouchIndex == null ? "info" : "pass",
      retouchIndex == null
        ? "Engine không ghi lại nến quay lại cho lệnh này."
        : `${Math.max(1, entryIndex - retouchIndex)} nến trước khi vào, giá chạm lại hộp — vẫn trong hạn canh ${num(params.boxWaitBars / 96, 1)} ngày.`,
      retouchIndex == null ? undefined : barsZone(m15, retouchIndex, retouchIndex),
    ));
    steps.push(makeCo(
      "Bước 3 · nến bật ra khỏi hộp",
      "pass",
      `Nến ${long ? "xanh" : "đỏ"} còn dính hộp và đóng ở ${fmtPrice(trade.entryPrice)}, ra ngoài hộp → vào ngay tại giá đóng đó.`,
      entryCandle,
    ));
  }
  if (key && !trap && !lowerHighLimit && params.requireSwingConfirmation) {
    steps.push(makeCo(
      `Hai ${long ? "đỉnh" : "đáy"} swing ${long ? "tăng" : "giảm"} dần`,
      "pass",
      `Từ sau nến đáy tới lúc vào, đã có hai ${long ? "đỉnh" : "đáy"} swing liền nhau, ${long ? "đỉnh sau cao hơn" : "đáy sau thấp hơn"} — cấu trúc M15 đã đổi chiều.`,
      barsZone(m15, triggerIndex, entryIndex),
    ));
  }

  // ── chặng 3 · hai cửa cuối ───────────────────────────────────────────
  const gates: EvidenceItem[] = [
    makeSo(
      "Rủi ro mỗi lệnh",
      `${num(riskPct)}%`,
      riskPct,
      params.maxStopPct * 100,
      "lte",
      `trần ${num(params.maxStopPct * 100, 1)}%`,
      `SL ở ${fmtPrice(trade.initialSL)}, ngay ngoài ${trap ? "cực trị cú phá" : lowerHighLimit ? `${long ? "đáy" : "đỉnh"} trước` : key ? `mép ${long ? "dưới" : "trên"} hộp` : "râu quét"}, đệm ${num(params.stopBufferAtr, 2)}×ATR.`,
      { kind: "level", startTime: trade.entryTime, endTime: trade.exitTime, priceA: trade.initialSL },
    ),
    makeSo(
      "Dư địa tới mục tiêu",
      `${num(targetR)}R`,
      targetR,
      lowerHighLimit ? 0 : params.minRR,
      "gte",
      lowerHighLimit ? "không đòi tối thiểu" : `≥ ${num(params.minRR, 1)}R`,
      key
        ? `Mục tiêu là key đối diện gần nhất, ${fmtPrice(trade.target)}. Không có key đối diện thì bỏ setup.`
        : `Quét thanh khoản bên này thì chạy sang cụm bên kia — ${fmtPrice(trade.target)}.`,
      { kind: "level", startTime: trade.entryTime, endTime: trade.exitTime, priceA: trade.target },
    ),
  ];

  // ── chặng 4 · kết thúc ───────────────────────────────────────────────
  const held = holdText(trade.holdBars);
  const span = barsZone(m15, entryIndex, exitIndex);
  const ending: EvidenceItem[] = [];
  const partialPct = Math.round(params.partialFraction * 100);
  if (trade.partialTaken) {
    const partialPrice = trade.entryPrice + (long ? 1 : -1) * params.partialAtR * risk;
    ending.push(makeCo(
      `Chốt ${partialPct}% ở ${num(params.partialAtR, 1)}R`,
      "pass",
      `Giá chạm ${fmtPrice(partialPrice)} → chốt ${partialPct}% khối lượng, dời SL phần còn lại về giá vào ${fmtPrice(trade.entryPrice)}. Phần còn lại gồng tới mục tiêu.`,
      { kind: "level", startTime: trade.entryTime, endTime: trade.exitTime, priceA: partialPrice },
    ));
  }
  if (trade.exitReason === "open") {
    const stopNow = trade.partialTaken ? trade.entryPrice : trade.initialSL;
    ending.push(makeCo(
      "Lệnh đang mở",
      "info",
      `Chưa chạm SL ${fmtPrice(stopNow)} hay mục tiêu ${fmtPrice(trade.target)} sau ${trade.holdBars} nến (${held}). Giá đóng nến cuối ${fmtPrice(trade.exitPrice)} → tạm tính ${num(trade.grossR)}R. Đang giữ lệnh này thì engine bỏ qua mọi setup mới.`,
      span,
    ));
  } else if (trade.exitReason === "target") {
    ending.push(makeCo(
      "Chạm mục tiêu",
      "pass",
      `Giá tới ${fmtPrice(trade.exitPrice)} sau ${trade.holdBars} nến (${held}).`,
      span,
    ));
  } else if (trade.exitReason === "positive-stop") {
    ending.push(makeCo(
      trade.partialTaken ? "Quay về giá vào sau khi chốt" : "Stop dương",
      "pass",
      trade.partialTaken
        ? `Phần còn lại ${100 - partialPct}% bị chạm SL ở giá vào ${fmtPrice(trade.exitPrice)} sau ${held} — hoà vốn phần đó, giữ lãi phần đã chốt.`
        : `Stop đã dời lên vùng dương rồi mới bị chạm, ở ${fmtPrice(trade.exitPrice)} sau ${held}.`,
      span,
    ));
  } else {
    ending.push(makeCo(
      trade.exitReason === "stop" ? "Chạm SL" : "Setup hỏng trước khi chạy",
      "fail",
      trade.exitReason === "stop"
        ? `Giá chạm ${fmtPrice(trade.exitPrice)} sau ${trade.holdBars} nến (${held}). Cùng một nến chạm cả SL lẫn mục tiêu thì luôn tính SL trước.`
        : `Giá đóng ngược qua hộp trước khi chạy → thoát ở ${fmtPrice(trade.exitPrice)} sau ${held}.`,
      span,
    ));
  }

  return [
    { n: "1", title: "Dấu hiệu", items: signals },
    {
      n: "2",
      title: sweepDirect || trap ? "Vào lệnh" : sweepLimit || lowerHighLimit ? "Order block và lệnh chờ" : "Hộp và ba bước",
      items: steps,
    },
    { n: "3", title: "Hai cửa cuối", items: gates },
    { n: "4", title: "Kết thúc", items: ending },
  ];
}

/** Một câu đọc trước mọi thứ khác. */
function verdictOf(trade: KeyVolumeTrade, plan: KeyVolumeEntryPlan | null, params: KeyVolumeParams): string {
  const key = plan?.key;
  if (!key) {
    const what = trade.dir === "long" ? "đáy" : "đỉnh";
    const daysWindow = num(params.sweepLookback / 96, 0);
    if (plan?.clusterShape) {
      return `Giá quét ${what} ${daysWindow} ngày, rồi một order block chạm lại mức bị quét — lệnh chờ ở mép order block khớp.`;
    }
    return `Một nến thủng ${what} ${daysWindow} ngày rồi đóng lại trong biên — râu ăn hết stop rồi trả giá về.`;
  }
  if (plan?.branch === "key-lower-high") {
    return trade.dir === "long"
      ? `Giá phản ứng tại key ${fmtPrice(key.price)} rồi tạo đáy cao hơn — lệnh chờ mua ở mép order block của đáy đó khớp.`
      : `Giá phản ứng tại key ${fmtPrice(key.price)} rồi tạo đỉnh thấp hơn — lệnh chờ bán ở mép order block của đỉnh đó khớp.`;
  }
  if (plan?.branch === "key-trap") {
    return `Giá phá ${trade.dir === "long" ? "xuống" : "lên"} qua key ${fmtPrice(key.price)} rồi đóng quay về trong ${params.keyTrapMaxBars} nến — cú phá là bẫy, vào ngược chiều ngay ở giá đóng.`;
  }
  return `Giá quay về key ${fmtPrice(key.price)}, đảo chiều ngay tại đó, rồi bật ra khỏi hộp order block.`;
}

/** Chuỗi cơ chế của đúng lệnh này. */
function chainOf(trade: KeyVolumeTrade, plan: KeyVolumeEntryPlan | null, params: KeyVolumeParams): string[] {
  const key = plan?.key;
  const tail = ["Hộp", `Rời ${params.obDepartBars} nến`, "Quay lại", "Bật ra"];
  if (!key) {
    const swept = [`Quét ${trade.dir === "long" ? "đáy" : "đỉnh"}`, "Đóng lại trong biên"];
    if (plan?.clusterShape) return [...swept, "Order block chạm lại mức", "Lệnh chờ ở mép"];
    return params.sweepEntry === "reclaim-close" ? [...swept, "Vào ngay"] : [...swept, ...tail];
  }
  if (plan?.branch === "key-lower-high") {
    const long = trade.dir === "long";
    return [`Key ×${num(key.volumeRatio)}`, `${long ? "Đáy" : "Đỉnh"} phản ứng tại key`, long ? "Đáy cao hơn" : "Đỉnh thấp hơn", "Lệnh chờ ở mép OB"];
  }
  if (plan?.branch === "key-trap") {
    return [`Key ×${num(key.volumeRatio)}`, "Phá qua key", `Quay về ≤${params.keyTrapMaxBars} nến`, "Vào ngay"];
  }
  return [`Key ×${num(key.volumeRatio)}`, "Rời rồi quay về", "Nến đảo chiều", ...tail];
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
      + (plan?.clusterShape ? " vào bằng lệnh chờ ở mép order block chạm lại mức bị quét;" : "")
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
    params.enableKeyTrapBranch ? `trap qua key ≤${params.keyTrapMaxBars} nến, quay về ≥${params.keyTrapCloseAtr}ATR` : null,
    params.enableLowerHighBranch ? `đỉnh thấp dần sau key (pivot ${params.lowerHighPivotBars}), lệnh chờ ở mép OB, không đòi minRR` : null,
  ].filter(Boolean).join(" | ");
  return [
    `luật + mô phỏng trọn trên ${params.confirmTf}`,
    `key ×${params.volumeSpikeMult} / ${params.volumeLookback} nến xung quanh`,
    `hướng theo vị trí giá so với key`,
    `quét ${params.sweepLookback} nến (${round(params.sweepLookback / 96, 1)}d), không cần key · nhánh key chờ ${params.sweepWaitBars}`,
    `nhánh ${branches || "—"}`,
    `stop ${params.stopMode} +${params.stopBufferAtr}ATR ≤${round(params.maxStopPct * 100, 1)}%`,
    `minRR ${params.minRR} · target ${params.targetMode}`
      + (params.partialFraction > 0
        ? ` · chốt ${Math.round(params.partialFraction * 100)}% ở ${params.partialAtR}R rồi SL về entry`
        : "")
      + " · không có trần giữ lệnh",
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
  // ATR dùng cho câu kể "đã rời key bao xa" — cùng chuỗi engine dùng.
  const atr = atrSeriesForward(m15);
  const confirmMs = TF_MS[params.confirmTf];

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

  // Lệnh đang mở đi chung danh sách: engine giữ một vị thế mỗi lúc, nên giấu nó
  // đi thì mọi setup bị nó chặn trông như tự biến mất.
  const entries: KeyVolumeEntryView[] = [...result.trades, ...(result.openTrade ? [result.openTrade] : [])]
    .filter((trade) => trade.entryTime >= displayStart)
    .map((trade) => {
      const plan = matchPlan(trade, result.plans);
      const key = plan?.key;
      const stages = buildStages(trade, plan, m15, atr, params);
      return {
        id: `kv-${trade.entryTime}-${trade.dir}`,
        dir: trade.dir,
        branch: trade.branch,
        // Engine ghi giờ MỞ của nến vào lệnh, nhưng khớp ở giá ĐÓNG của nến đó.
        // Chart cần THỜI ĐIỂM khớp thật: lúc nến vào lệnh đóng. Riêng lệnh chờ ở
        // mép order block khớp TRONG nến, nên hộp lệnh bắt đầu từ lúc nến mở.
        entryTime: trade.entryTime
          + ((!key && params.sweepEntry === "order-block") || trade.branch === "key-lower-high" ? 0 : confirmMs),
        entryPrice: trade.entryPrice,
        initialSL: trade.initialSL,
        target: trade.target,
        status: trade.exitReason === "open" ? ("open" as const) : ("closed" as const),
        // Thoát ở giá đóng (không chạy, phá key) thì khớp lúc nến thoát đóng;
        // chạm SL/mục tiêu thì khớp đâu đó TRONG nến thoát — lấy lúc nến đó đóng
        // để hộp phủ trọn cây nến đã thoát. Nhờ vậy độ dài hộp = đúng `holdBars` nến.
        exitTime: trade.exitTime + confirmMs,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        exitReasonLabel: EXIT_LABELS[trade.exitReason],
        resultR: round(trade.grossR, 3),
        holdBars: trade.holdBars,
        keyId: key?.id ?? null,
        keyPrice: trade.keyPrice,
        summary: summarize(trade, plan),
        verdict: verdictOf(trade, plan, params),
        chain: chainOf(trade, plan, params),
        stages,
        evidence: stages.flatMap((stage) => stage.items),
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
