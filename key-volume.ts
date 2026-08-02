/**
 * Key Volume — bản số hoá có truy vết nguồn từ FX Dream Trading.
 *
 * `volume-retest` (mặc định) là phần có thể lượng hoá của video live-trade:
 *   chuỗi nến Daily xác lập bias -> H1 key-volume
 *   -> M15 volume đúng vị trí tại key
 *   -> sweep/reclaim cuối -> phá cấu trúc -> vào ở open kế tiếp.
 * Bias chỉ đổi khi chuỗi ngược chiều phá cực trị nến đối diện gần nhất. Sau
 * entry, SL bám swing M5 đã xác nhận; chỉ tái vào cùng key sau stop dương và
 * một cú sweep sâu hơn.
 * Trigger M15 chỉ cần không thấp hơn median trước đó: video #23 nói rõ volume
 * lần sau có thể nhỏ hơn, miễn xuất hiện đúng vị trí đang chờ.
 *
 * `document-v1` giữ pipeline của planning/fxdream-keyvolume-method.md để có thể
 * tái lập benchmark cũ:
 *   H1/H4 key -> Daily/Weekly bias -> M15 sweep + 2 BOS
 *   -> M5 OB/FTR + cạnh HVN proxy.
 *
 * Không model nào được gọi là bản sao 100%: việc chọn key từ lịch sử giá/trap,
 * đọc bối cảnh/macro và "phản ứng tốt" trên kênh là discretionary. Binance
 * kline cũng không có volume-at-price thật; HVN chỉ là proxy OHLCV.
 */
import { Candle, CONFIG, TF_MS, aggregate, findSwings, Swing } from "./strategy";

export type KeyVolumeDirection = "long" | "short";
export type KeyVolumeLevelType = "demand" | "supply";
export type KeyVolumeEntryModel = "volume-retest" | "document-v1";
export type KeyVolumeSourceTf = "15m" | "1h" | "4h";
export type KeyVolumeTargetMode = "nearest-structure" | "capped-r";
/**
 * `sweep-window`: SL ở cực trị cả cửa sổ touch->sweep trên M15 (bản cũ).
 * `confirmation`: SL ngay sau nến xác nhận — "stop rất là ngắn... sau cái mô hình đó".
 * `key`: SL ngay ngoài vùng key — "stop l ở dưới ky này thôi, không cần quá xa" (#22).
 */
export type KeyVolumeStopMode = "sweep-window" | "confirmation" | "key";
/**
 * `bos`: chờ phá cấu trúc rồi vào ở open kế tiếp (bản cũ).
 * `candle-pattern`: sau stop-hunt, vào ngay theo mô hình nến đảo chiều —
 * đúng `#50 SFP` và `Q&A 003` ("SFP nè, Quasimodo nè, hai cái mô hình đó là
 * dư sức xài rồi"), và cho stop ngắn hơn hẳn vì không phải chờ hết cú phá.
 */
export type KeyVolumeEntryTrigger = "bos" | "candle-pattern";
/**
 * `deeper-sweep`: chỉ vào lại sau stop dương + cú quét sâu hơn (bản cũ, từ `#26`).
 * `volume-retouch`: vào lại khi giá chạm key lần nữa và kích volume lần nữa —
 * `#23` và `#43` mô tả đây là thao tác thường quy sau stop dương.
 */
export type KeyVolumeReentryMode = "deeper-sweep" | "volume-retouch";

export interface KeyVolumeParams {
  entryModel: KeyVolumeEntryModel;
  baseTf: "5m";
  confirmTf: "15m";
  keyTf: "1h";
  confluenceTf: "4h";
  dailyTf: "1d";
  weeklyTf: "1w";
  volumeLookback: number;
  volumeSpikeMult: number;
  reactionLookback: number;
  reactionBars: number;
  reactionAtr: number;
  invalidationAtr: number;
  keyHistoryDays: number;
  minKeyReactions: number;
  keyReactionAtr: number;
  keyMaxAgeDays: number;
  confluenceAtr: number;
  keyTouchAtr: number;
  requireHigherKey: boolean;
  dailyBiasBars: number;
  persistDailyBias: boolean;
  weeklyBiasBars: number;
  touchVolumeLookback: number;
  touchVolumeSpikeMult: number;
  sweepLookback: number;
  sweepWaitBars: number;
  bosPivotLeft: number;
  bosPivotRight: number;
  bosSwingLookback: number;
  bosExpiryBars: number;
  entryExpiryBars: number;
  profileBins: number;
  hvnThreshold: number;
  profileEdgeAtr: number;
  stopBufferAtr: number;
  maxStopPct: number;
  minRR: number;
  targetMode: KeyVolumeTargetMode;
  /**
   * Khung của các level được coi là "vùng cấu trúc đối diện" khi đo dư địa và
   * TP. #10/#22 đo dư địa tới kháng cự Daily và TP theo vùng quan trọng của
   * M15, không phải tới level gần nhất trong toàn bộ rổ level.
   */
  targetSourceTfs: KeyVolumeSourceTf[];
  stopMode: KeyVolumeStopMode;
  finalTargetR: number;
  partialAtR: number;
  partialFraction: number;
  followThroughBars: number;
  minFollowThroughR: number;
  /**
   * "Lon xong là giá sẽ chạy. Giá không chạy nữa là các bạn phải bỏ ngay lập
   * tức" (LiveTrade +50R) và "nó không sập liền mà nó còn quay lên nữa thì
   * mình phải thoát ra liền" (#26) — phát biểu cho đúng model này.
   */
  requireFollowThrough: boolean;
  /**
   * Kênh dời stop "đúng cấu trúc của nó" (#23) và gồng phần còn lại. Bám swing
   * M5 siết quá chặt so với phát biểu đó nên phải kiểm chứng riêng.
   */
  trailMode: "m5-swing" | "none";
  pressureBars: number;
  maxHoldBars: number;
  cooldownBars: number;
  allowKeyReentry: boolean;
  entryTrigger: KeyVolumeEntryTrigger;
  reentryMode: KeyVolumeReentryMode;
  /** `#22`: "cái phát đầu tiên là không thể nào mà tray được". */
  requireSecondTouch: boolean;
  /** `#22`/`#23`: chờ mô hình hai đỉnh / hai đáy tại key. */
  requireDoubleTopBottom: boolean;
  doubleTolAtr: number;
  doubleLookbackBars: number;
  /** `#31`: ba câu hỏi khung Daily (chuỗi / chưa đóng qua / đã trap). */
  requireDailyTrapGate: boolean;
  /** `Q&A 006`: ưu tiên phiên Mỹ. `null` = không lọc phiên. */
  sessionHoursUtc: [number, number] | null;
}

export const KEY_VOLUME_CONFIG: KeyVolumeParams = {
  entryModel: "volume-retest",
  baseTf: "5m",
  confirmTf: "15m",
  keyTf: "1h",
  confluenceTf: "4h",
  dailyTf: "1d",
  weeklyTf: "1w",
  volumeLookback: 96,
  volumeSpikeMult: 2,
  reactionLookback: 12,
  reactionBars: 6,
  reactionAtr: 0.75,
  invalidationAtr: 0.25,
  keyHistoryDays: 90,
  // #10 chọn key có "3 điểm xoay chiều" và loại thẳng mức "không có lịch sử
  // giá"; #26 loại mức "không có phản ứng". 0 = không có ràng buộc nào.
  minKeyReactions: 1,
  keyReactionAtr: 0.5,
  keyMaxAgeDays: 180,
  confluenceAtr: 0.75,
  keyTouchAtr: 0.2,
  requireHigherKey: false,
  dailyBiasBars: 3,
  persistDailyBias: true,
  weeklyBiasBars: 3,
  touchVolumeLookback: 96,
  touchVolumeSpikeMult: 1,
  sweepLookback: 12,
  sweepWaitBars: 4,
  bosPivotLeft: 2,
  bosPivotRight: 2,
  bosSwingLookback: 40,
  bosExpiryBars: 48,
  entryExpiryBars: 24,
  profileBins: 24,
  hvnThreshold: 0.6,
  profileEdgeAtr: 0.2,
  stopBufferAtr: 0.15,
  maxStopPct: 0.03,
  minRR: 3,
  targetMode: "nearest-structure",
  targetSourceTfs: ["1h", "4h"],
  // Với entry ngay sau mô hình nến, cực trị cửa sổ touch->sweep CHÍNH LÀ đáy cú
  // trap và nằm sát entry — đúng #31 ("stop l của mình sẽ đặt ở dưới cái Trap
  // này"). Cùng giá trị này khi chờ BOS lại thành stop rất rộng.
  stopMode: "sweep-window",
  finalTargetR: 5,
  partialAtR: 2,
  partialFraction: 0.5,
  followThroughBars: 6,
  minFollowThroughR: 0.5,
  requireFollowThrough: true,
  trailMode: "m5-swing",
  pressureBars: 3,
  maxHoldBars: 7 * 24 * 12,
  cooldownBars: 12,
  allowKeyReentry: true,
  // Q&A003 trả lời thẳng câu "dấu hiệu vào lệnh tại key là gì": "SFP nè,
  // Quasimodo nè". #50 nói sau stop-hunt thì vào theo mô hình nến. Chờ BOS là
  // gate code tự thêm, và nó đẩy entry ra xa cú trap nên stop bị giãn gấp ~6x.
  entryTrigger: "candle-pattern",
  reentryMode: "volume-retouch",
  // Hai luật dưới có nguồn rõ nhưng ablation cho thấy không cải thiện; bật được
  // qua tham số, không bật mặc định.
  requireSecondTouch: false,
  requireDoubleTopBottom: false,
  doubleTolAtr: 0.5,
  doubleLookbackBars: 40,
  requireDailyTrapGate: true,
  sessionHoursUtc: null,
};

export const KEY_VOLUME_DOCUMENT_V1_CONFIG: KeyVolumeParams = {
  ...KEY_VOLUME_CONFIG,
  entryModel: "document-v1",
  touchVolumeSpikeMult: 2,
  targetMode: "capped-r",
  stopMode: "sweep-window",
  // Giữ nguyên để tái lập benchmark cũ, không nhận mặc định mới.
  minKeyReactions: 0,
  entryTrigger: "bos",
  reentryMode: "deeper-sweep",
  requireDailyTrapGate: false,
  partialFraction: 0.5,
  maxHoldBars: 288,
};

export interface KeyVolumeLevel {
  id: string;
  sourceTf: KeyVolumeSourceTf;
  type: KeyVolumeLevelType;
  direction: KeyVolumeDirection;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  eventTime: number;
  confirmedAt: number;
  invalidatedAt?: number;
  expiresAt: number;
  volumeRatio: number;
  reactionAtr: number;
}

export interface KeyVolumeEntryPlan {
  id: string;
  model: KeyVolumeEntryModel;
  direction: KeyVolumeDirection;
  readyIndex: number;
  expiresIndex: number;
  key: KeyVolumeLevel;
  higherKey?: KeyVolumeLevel;
  obLow: number;
  obHigh: number;
  hvnEdge?: number;
  structuralStop?: number;
  /** Cực trị nến xác nhận — cơ sở cho SL "ngay sau mô hình". */
  patternStop?: number;
  triggerVolumeRatio?: number;
  enterNextOpen?: boolean;
  score: number;
}

export type KeyVolumeExitReason =
  | "stop"
  | "positive-stop"
  | "target"
  | "entry-invalid"
  | "key-invalid"
  | "no-follow-through"
  | "opposite-pressure"
  | "time";

export interface KeyVolumeTrade {
  symbol: string;
  dir: KeyVolumeDirection;
  entryTime: number;
  entryPrice: number;
  initialSL: number;
  target: number;
  exitTime: number;
  exitPrice: number;
  exitReason: KeyVolumeExitReason;
  grossR: number;
  costR: number;
  netR: number;
  holdBars: number;
  partialTaken: boolean;
  keyPrice: number;
  keyVolumeRatio: number;
  higherVolumeRatio?: number;
  triggerVolumeRatio?: number;
  model: KeyVolumeEntryModel;
}

export interface KeyVolumeDiagnostics {
  m15Levels: number;
  h1Levels: number;
  h4Levels: number;
  confluentTouches: number;
  touchVolumeConfirmed: number;
  sweeps: number;
  firstBos: number;
  secondBos: number;
  candlePatterns: number;
  profileAccepted: number;
  plans: number;
  entries: number;
  rejectedRisk: number;
  rejectedRoom: number;
  rejectedFirstTouch: number;
  rejectedDailyTrap: number;
  rejectedDouble: number;
  rejectedSession: number;
}

export interface KeyVolumeResult {
  trades: KeyVolumeTrade[];
  plans: KeyVolumeEntryPlan[];
  levels: KeyVolumeLevel[];
  diagnostics: KeyVolumeDiagnostics;
}

interface ConfirmationSetup {
  direction: KeyVolumeDirection;
  key: KeyVolumeLevel;
  higherKey: KeyVolumeLevel;
  touchIndex: number;
  phase: "sweep" | "bos";
  sweepIndex?: number;
  firstBosIndex?: number;
}

interface VolumeRetestSetup {
  direction: KeyVolumeDirection;
  key: KeyVolumeLevel;
  higherKey?: KeyVolumeLevel;
  touchIndex: number;
  triggerVolumeRatio: number;
  sweepIndex?: number;
}

interface OpenPosition {
  plan: KeyVolumeEntryPlan;
  entryIndex: number;
  entry: number;
  initialStop: number;
  stop: number;
  target: number;
  risk: number;
  partialPrice: number;
  partialR: number;
  remaining: number;
  realizedR: number;
  partialIndex?: number;
  maxFavorable: number;
}

const FUNDING_INTERVAL_MS = 8 * TF_MS["1h"];

function quoteVolume(candle: Candle): number {
  return candle.quoteVolume != null && candle.quoteVolume > 0
    ? candle.quoteVolume
    : candle.volume * candle.close;
}

function prefix(values: number[]): number[] {
  const out = Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i] + values[i];
  return out;
}

function rangeMax(candles: Candle[], start: number, endExclusive: number, field: "high" | "close"): number {
  let value = -Infinity;
  for (let i = start; i < endExclusive; i++) value = Math.max(value, candles[i][field]);
  return value;
}

function rangeMin(candles: Candle[], start: number, endExclusive: number, field: "low" | "close"): number {
  let value = Infinity;
  for (let i = start; i < endExclusive; i++) value = Math.min(value, candles[i][field]);
  return value;
}

export function medianPrior(values: number[], endExclusive: number, lookback: number): number {
  const start = endExclusive - lookback;
  if (start < 0 || lookback <= 0) return 0;
  const sample = values.slice(start, endExclusive).sort((a, b) => a - b);
  if (!sample.length) return 0;
  const middle = Math.floor(sample.length / 2);
  return sample.length % 2 === 0
    ? (sample[middle - 1] + sample[middle]) / 2
    : sample[middle];
}

export function atrSeriesForward(candles: Candle[], period = 20): number[] {
  const out = Array<number>(candles.length).fill(0);
  let smoothed = 0;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = i > 0 ? candles[i - 1].close : candle.open;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (i < period) {
      smoothed += tr;
      out[i] = smoothed / (i + 1);
      if (i === period - 1) smoothed = out[i];
    } else {
      smoothed = (smoothed * (period - 1) + tr) / period;
      out[i] = smoothed;
    }
  }
  return out;
}

/**
 * Bias "chuỗi nến": đa số nến cùng màu và cả chuỗi phải có dịch chuyển
 * cùng hướng. Không MA, không dùng nến sau atIndex.
 */
export function candleChainBias(
  candles: Candle[],
  atIndex: number,
  bars: number,
): "bull" | "bear" | "neutral" {
  if (bars < 1 || atIndex < bars - 1 || atIndex >= candles.length) return "neutral";
  const start = atIndex - bars + 1;
  let green = 0;
  let red = 0;
  for (let i = start; i <= atIndex; i++) {
    if (candles[i].close > candles[i].open) green++;
    else if (candles[i].close < candles[i].open) red++;
  }
  const required = Math.floor(bars / 2) + 1;
  const net = candles[atIndex].close - candles[start].open;
  if (green >= required && net > 0) return "bull";
  if (red >= required && net < 0) return "bear";
  return "neutral";
}

/**
 * Bản strict dùng cho `volume-retest`: video nguồn phát biểu trực tiếp "ba nến
 * xanh thì đi Long" / chuỗi đỏ thì đi Short, không phải đa số 2/3.
 */
export function strictCandleChainBias(
  candles: Candle[],
  atIndex: number,
  bars: number,
): "bull" | "bear" | "neutral" {
  if (bars < 1 || atIndex < bars - 1 || atIndex >= candles.length) return "neutral";
  const start = atIndex - bars + 1;
  let bull = true;
  let bear = true;
  for (let i = start; i <= atIndex; i++) {
    bull = bull && candles[i].close > candles[i].open;
    bear = bear && candles[i].close < candles[i].open;
  }
  if (bull && candles[atIndex].close > candles[start].open) return "bull";
  if (bear && candles[atIndex].close < candles[start].open) return "bear";
  return "neutral";
}

/**
 * Một chuỗi nến xác lập bias, sau đó bias được giữ cho tới khi xuất hiện chuỗi
 * ngược chiều. Đây là cách dùng "chuỗi nến" làm bối cảnh trong các video:
 * không bắt buộc đúng ba nến gần nhất phải cùng màu tại chính thời điểm entry.
 */
export function persistentCandleChainBias(
  candles: Candle[],
  atIndex: number,
  bars: number,
): "bull" | "bear" | "neutral" {
  if (bars < 1 || atIndex < bars - 1 || atIndex >= candles.length) return "neutral";
  for (let end = atIndex; end >= bars - 1; end--) {
    const bias = strictCandleChainBias(candles, end, bars);
    if (bias !== "neutral") return bias;
  }
  return "neutral";
}

/**
 * Chuỗi Daily chỉ xác lập/đảo bias khi phá cực trị của nến ngược màu gần nhất.
 * Video #26 dùng đúng ví dụ: chuỗi đỏ phá low nến xanh cuối cùng thì chuỗi
 * xanh cũ mới bị gãy. Sau đó bias được giữ đến một structural chain ngược lại.
 */
export function structuralCandleChainBias(
  candles: Candle[],
  atIndex: number,
  bars: number,
): "bull" | "bear" | "neutral" {
  if (bars < 1 || atIndex < bars - 1 || atIndex >= candles.length) return "neutral";
  for (let end = atIndex; end >= bars - 1; end--) {
    const bias = strictCandleChainBias(candles, end, bars);
    if (bias === "neutral") continue;
    const start = end - bars + 1;
    let opposite = start - 1;
    while (opposite >= 0) {
      const candle = candles[opposite];
      const isOpposite = bias === "bull"
        ? candle.close < candle.open
        : candle.close > candle.open;
      if (isOpposite) break;
      opposite--;
    }
    if (opposite < 0) continue;
    const brokeOpposite = bias === "bull"
      ? candles[end].close > candles[opposite].high
      : candles[end].close < candles[opposite].low;
    if (brokeOpposite) return bias;
  }
  return "neutral";
}

function directionFor(type: KeyVolumeLevelType): KeyVolumeDirection {
  return type === "demand" ? "long" : "short";
}

/**
 * Volume spike chỉ trở thành key sau displacement + BOS. `confirmedAt` là
 * thời điểm BOS đóng, nên caller có thể replay mà không nhìn trước.
 */
export function detectKeyVolumeLevels(
  candles: Candle[],
  sourceTf: KeyVolumeSourceTf,
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
): KeyVolumeLevel[] {
  const tfMs = TF_MS[sourceTf];
  const volumes = candles.map(quoteVolume);
  const atr = atrSeriesForward(candles);
  const swings = findSwings(candles, params.bosPivotLeft, params.bosPivotRight);
  const levels: KeyVolumeLevel[] = [];

  for (let event = params.volumeLookback; event < candles.length; event++) {
    const baseline = medianPrior(volumes, event, params.volumeLookback);
    if (!(baseline > 0)) continue;
    const volumeRatio = volumes[event] / baseline;
    if (volumeRatio < params.volumeSpikeMult || !(atr[event] > 0)) continue;

    const structureStart = Math.max(0, event - params.reactionLookback);
    const priorHigh = rangeMax(candles, structureStart, event, "high");
    const priorLow = rangeMin(candles, structureStart, event, "low");
    const bodyLow = Math.min(candles[event].open, candles[event].close);
    const bodyHigh = Math.max(candles[event].open, candles[event].close);
    const fallbackLow = candles[event].low;
    const fallbackHigh = candles[event].high;
    const zoneLow = bodyHigh > bodyLow ? bodyLow : fallbackLow;
    const zoneHigh = bodyHigh > bodyLow ? bodyHigh : fallbackHigh;
    const responseEnd = Math.min(candles.length - 1, event + params.reactionBars);

    let confirmedIndex = -1;
    let type: KeyVolumeLevelType | null = null;
    let reaction = 0;
    for (let i = event; i <= responseEnd; i++) {
      const upDistance = candles[i].close - zoneLow;
      const downDistance = zoneHigh - candles[i].close;
      const brokeUp = candles[i].close > priorHigh && upDistance >= params.reactionAtr * atr[event];
      const brokeDown = candles[i].close < priorLow && downDistance >= params.reactionAtr * atr[event];
      if (brokeUp || brokeDown) {
        confirmedIndex = i;
        type = brokeUp ? "demand" : "supply";
        reaction = (brokeUp ? upDistance : downDistance) / atr[event];
        break;
      }
    }
    if (confirmedIndex < 0 || !type) continue;

    const price = type === "demand" ? zoneLow : zoneHigh;
    const historyBars = Math.ceil(params.keyHistoryDays * TF_MS["1d"] / tfMs);
    const reactionType = type === "demand" ? "low" : "high";
    const historicalReactions = swings.filter((swing) =>
      swing.type === reactionType
      && swing.index < event
      && swing.index >= event - historyBars
      && swing.confirmIndex <= event
      && Math.abs(swing.price - price) <= params.keyReactionAtr * atr[event],
    ).length;
    if (historicalReactions < params.minKeyReactions) continue;

    const confirmedAt = candles[confirmedIndex].openTime + tfMs;
    const expiresAt = confirmedAt + params.keyMaxAgeDays * TF_MS["1d"];
    let currentType = type;
    let currentConfirmedAt = confirmedAt;
    let role = 0;
    for (let i = confirmedIndex + 1; i < candles.length; i++) {
      if (candles[i].openTime + tfMs > expiresAt) break;
      const invalid = currentType === "demand"
        ? candles[i].close < zoneLow - params.invalidationAtr * atr[event]
        : candles[i].close > zoneHigh + params.invalidationAtr * atr[event];
      if (!invalid) continue;
      const invalidatedAt = candles[i].openTime + tfMs;
      levels.push({
        id: `${sourceTf}:${candles[event].openTime}:${currentType}:role-${role}`,
        sourceTf,
        type: currentType,
        direction: directionFor(currentType),
        price: currentType === "demand" ? zoneLow : zoneHigh,
        zoneLow,
        zoneHigh,
        eventTime: candles[event].openTime,
        confirmedAt: currentConfirmedAt,
        invalidatedAt,
        expiresAt,
        volumeRatio,
        reactionAtr: reaction,
      });
      currentType = currentType === "demand" ? "supply" : "demand";
      currentConfirmedAt = invalidatedAt;
      role++;
      if (currentConfirmedAt > expiresAt) break;
    }
    if (currentConfirmedAt <= expiresAt) {
      levels.push({
        id: `${sourceTf}:${candles[event].openTime}:${currentType}:role-${role}`,
        sourceTf,
        type: currentType,
        direction: directionFor(currentType),
        price: currentType === "demand" ? zoneLow : zoneHigh,
        zoneLow,
        zoneHigh,
        eventTime: candles[event].openTime,
        confirmedAt: currentConfirmedAt,
        expiresAt,
        volumeRatio,
        reactionAtr: reaction,
      });
    }
  }
  return levels;
}

export function isKeyVolumeLevelActive(level: KeyVolumeLevel, time: number): boolean {
  return level.confirmedAt <= time
    && time <= level.expiresAt
    && (level.invalidatedAt == null || time < level.invalidatedAt);
}

function intervalDistance(aLow: number, aHigh: number, bLow: number, bHigh: number): number {
  if (aHigh < bLow) return bLow - aHigh;
  if (bHigh < aLow) return aLow - bHigh;
  return 0;
}

function touchesLevel(candle: Candle, level: KeyVolumeLevel, tolerance: number): boolean {
  return candle.low <= level.zoneHigh + tolerance && candle.high >= level.zoneLow - tolerance;
}

function latestClosedIndex(candles: Candle[], closeTime: number, tfMs: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTime + tfMs <= closeTime) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function higherTimeframeBias(
  daily: Candle[],
  weekly: Candle[],
  closeTime: number,
  params: KeyVolumeParams,
): KeyVolumeDirection | null {
  const dailyIndex = latestClosedIndex(daily, closeTime, TF_MS[params.dailyTf]);
  const weeklyIndex = latestClosedIndex(weekly, closeTime, TF_MS[params.weeklyTf]);
  if (params.entryModel === "volume-retest") {
    const day = params.persistDailyBias
      ? structuralCandleChainBias(daily, dailyIndex, params.dailyBiasBars)
      : strictCandleChainBias(daily, dailyIndex, params.dailyBiasBars);
    const week = candleChainBias(weekly, weeklyIndex, params.weeklyBiasBars);
    if (day === "bull" && week !== "bear") return "long";
    if (day === "bear" && week !== "bull") return "short";
    return null;
  }
  const day = candleChainBias(daily, dailyIndex, params.dailyBiasBars);
  const week = candleChainBias(weekly, weeklyIndex, params.weeklyBiasBars);
  if (day === "bull" && week === "bull") return "long";
  if (day === "bear" && week === "bear") return "short";
  return null;
}

function selectConfluentTouch(
  candle: Candle,
  time: number,
  direction: KeyVolumeDirection,
  atr: number,
  h1Levels: KeyVolumeLevel[],
  h4Levels: KeyVolumeLevel[],
  used: Set<string>,
  params: KeyVolumeParams,
): { key: KeyVolumeLevel; higherKey: KeyVolumeLevel; score: number } | null {
  const touchTolerance = params.keyTouchAtr * atr;
  const confluenceTolerance = params.confluenceAtr * atr;
  let best: { key: KeyVolumeLevel; higherKey: KeyVolumeLevel; score: number } | null = null;

  for (const key of h1Levels) {
    if (used.has(key.id) || key.direction !== direction || !isKeyVolumeLevelActive(key, time)) continue;
    if (!touchesLevel(candle, key, touchTolerance)) continue;
    for (const higherKey of h4Levels) {
      if (higherKey.direction !== direction || !isKeyVolumeLevelActive(higherKey, time)) continue;
      const distance = intervalDistance(
        key.zoneLow,
        key.zoneHigh,
        higherKey.zoneLow,
        higherKey.zoneHigh,
      );
      if (distance > confluenceTolerance) continue;
      const score = key.volumeRatio + higherKey.volumeRatio
        + key.reactionAtr + higherKey.reactionAtr
        - distance / Math.max(atr, Number.EPSILON);
      if (!best || score > best.score) best = { key, higherKey, score };
    }
  }
  return best;
}

function selectKeyTouch(
  candle: Candle,
  time: number,
  direction: KeyVolumeDirection,
  atr: number,
  h1Levels: KeyVolumeLevel[],
  h4Levels: KeyVolumeLevel[],
  used: Set<string>,
  params: KeyVolumeParams,
): { key: KeyVolumeLevel; higherKey?: KeyVolumeLevel; score: number } | null {
  const touchTolerance = params.keyTouchAtr * atr;
  const confluenceTolerance = params.confluenceAtr * atr;
  let best: { key: KeyVolumeLevel; higherKey?: KeyVolumeLevel; score: number } | null = null;

  for (const key of h1Levels) {
    if (used.has(key.id) || key.direction !== direction || !isKeyVolumeLevelActive(key, time)) continue;
    if (!touchesLevel(candle, key, touchTolerance)) continue;
    const higherKey = h4Levels
      .filter((candidate) =>
        candidate.direction === direction
        && isKeyVolumeLevelActive(candidate, time)
        && intervalDistance(
          key.zoneLow,
          key.zoneHigh,
          candidate.zoneLow,
          candidate.zoneHigh,
        ) <= confluenceTolerance,
      )
      .sort((a, b) => b.volumeRatio + b.reactionAtr - a.volumeRatio - a.reactionAtr)[0];
    if (params.requireHigherKey && !higherKey) continue;
    const score = key.volumeRatio + key.reactionAtr
      + (higherKey ? higherKey.volumeRatio + higherKey.reactionAtr : 0);
    if (!best || score > best.score) best = { key, higherKey, score };
  }
  return best;
}

/**
 * `#50 SFP`: sau stop-hunt thì "vào lệnh theo cái mô hình nến hoặc là vào luôn
 * cũng được", và tác giả nói rõ "mình chỉ sử dụng ba mô hình nến thôi: nhấn
 * chìm, in3 và 3 bar reversal". Đây là ba mô hình đó, không thêm.
 */
export function isEngulfing(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
): boolean {
  if (index < 1) return false;
  const previous = candles[index - 1];
  const current = candles[index];
  const previousLow = Math.min(previous.open, previous.close);
  const previousHigh = Math.max(previous.open, previous.close);
  return direction === "long"
    ? previous.close < previous.open
      && current.close > current.open
      && current.close >= previousHigh
      && current.open <= previousLow
    : previous.close > previous.open
      && current.close < current.open
      && current.close <= previousLow
      && current.open >= previousHigh;
}

/** In3 / inside bar: nến nằm trọn trong nến mẹ. */
export function isInsideBar(candles: Candle[], index: number): boolean {
  if (index < 1) return false;
  return candles[index].high <= candles[index - 1].high
    && candles[index].low >= candles[index - 1].low;
}

/** 3-bar reversal: nến giữa tạo cực trị, nến thứ ba đóng ngược lại qua nến đầu. */
export function isThreeBarReversal(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
): boolean {
  if (index < 2) return false;
  const [first, middle, last] = [candles[index - 2], candles[index - 1], candles[index]];
  return direction === "long"
    ? middle.low < first.low && middle.low < last.low && last.close > first.high
    : middle.high > first.high && middle.high > last.high && last.close < first.low;
}

export function hasReversalCandlePattern(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
): boolean {
  return isEngulfing(candles, index, direction)
    || isInsideBar(candles, index)
    || isThreeBarReversal(candles, index, direction);
}

/**
 * "Mô hình hai đỉnh hai đáy là đủ tray rồi" (`#23`) và `#22` nhấn mạnh phải chờ
 * đủ hai đáy mới đẩy được giá lên. Hai swing cùng loại, giá xấp xỉ nhau.
 */
export function hasDoubleTopBottom(
  swings: Swing[],
  index: number,
  direction: KeyVolumeDirection,
  tolerance: number,
  lookback: number,
): boolean {
  if (!(tolerance > 0)) return false;
  const type = direction === "long" ? "low" : "high";
  const recent = swings
    .filter((swing) =>
      swing.type === type
      && swing.confirmIndex <= index
      && swing.index >= index - lookback)
    .sort((a, b) => b.index - a.index);
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      if (Math.abs(recent[i].price - recent[j].price) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * `Q&A 006`: "thời gian tốt để trade là phiên Mỹ, phiên Mỹ là chạy mạnh".
 * Tác giả nói rõ đây là chuyện biến động chứ không phải phiên nào "đúng" hơn
 * ("phiên nào nó cũng chuẩn, tại vì nó biến động ít thôi"), nên đây là bộ lọc
 * chất lượng tuỳ chọn, không phải luật cứng của phương pháp.
 */
export function isWithinSession(
  openTime: number,
  fromHourUtc: number,
  toHourUtc: number,
): boolean {
  const hour = new Date(openTime).getUTCHours();
  return fromHourUtc <= toHourUtc
    ? hour >= fromHourUtc && hour < toHourUtc
    : hour >= fromHourUtc || hour < toHourUtc;
}

/**
 * `#31` phát biểu thành ba câu hỏi trên khung Daily:
 *   1. chuỗi nến đang là chuỗi gì,
 *   2. low của cây nến xanh cuối cùng (chuỗi tăng) đã bị ĐÓNG qua chưa — phải chưa,
 *   3. low đó đã bị TRAP (thọt râu) chưa — phải rồi.
 * Đối xứng cho chuỗi giảm với high của cây nến đỏ cuối cùng.
 */
export function dailyTrapGate(
  candles: Candle[],
  atIndex: number,
  direction: KeyVolumeDirection,
): boolean {
  if (atIndex < 1) return false;
  const wantGreen = direction === "long";
  let anchor = -1;
  for (let i = atIndex; i >= 0; i--) {
    const isGreen = candles[i].close > candles[i].open;
    if (isGreen === wantGreen && candles[i].close !== candles[i].open) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0 || anchor === atIndex) return false;
  const level = wantGreen ? candles[anchor].low : candles[anchor].high;
  let trapped = false;
  for (let i = anchor + 1; i <= atIndex; i++) {
    // Đóng qua mức đó là chuỗi đã gãy -> câu hỏi 2 trả lời "rồi" -> loại.
    if (wantGreen ? candles[i].close < level : candles[i].close > level) return false;
    if (wantGreen ? candles[i].low < level : candles[i].high > level) trapped = true;
  }
  return trapped;
}

export function sweptAndReclaimed(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  lookback: number,
): boolean {
  if (index < lookback) return false;
  if (direction === "long") {
    const priorLow = rangeMin(candles, index - lookback, index, "low");
    return candles[index].low < priorLow && candles[index].close > priorLow;
  }
  const priorHigh = rangeMax(candles, index - lookback, index, "high");
  return candles[index].high > priorHigh && candles[index].close < priorHigh;
}

function crossedSwing(
  candles: Candle[],
  swings: Swing[],
  index: number,
  direction: KeyVolumeDirection,
  predicate: (swing: Swing) => boolean,
): Swing | null {
  if (index <= 0) return null;
  const type = direction === "long" ? "high" : "low";
  const candidates = swings
    .filter((swing) => swing.type === type && swing.confirmIndex <= index && predicate(swing))
    .sort((a, b) => b.index - a.index);
  for (const swing of candidates) {
    const crossed = direction === "long"
      ? candles[index - 1].close <= swing.price && candles[index].close > swing.price
      : candles[index - 1].close >= swing.price && candles[index].close < swing.price;
    if (crossed) return swing;
  }
  return null;
}

function lowerBoundTime(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].openTime < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findEntryOrderBlock(
  candles: Candle[],
  start: number,
  end: number,
  direction: KeyVolumeDirection,
  key: KeyVolumeLevel,
  tolerance: number,
): { low: number; high: number } | null {
  for (let i = end - 1; i >= start; i--) {
    const candle = candles[i];
    const opposite = direction === "long"
      ? candle.close < candle.open
      : candle.close > candle.open;
    if (!opposite) continue;
    const low = Math.min(candle.open, candle.close);
    const high = Math.max(candle.open, candle.close);
    const zoneLow = high > low ? low : candle.low;
    const zoneHigh = high > low ? high : candle.high;
    if (intervalDistance(zoneLow, zoneHigh, key.zoneLow, key.zoneHigh) <= tolerance) {
      return { low: zoneLow, high: zoneHigh };
    }
  }
  return null;
}

/**
 * Cạnh HVN proxy từ OHLCV. Volume mỗi nến được chia đều cho các bin mà range
 * của nến cắt qua; cluster HVN là cụm quanh bin lớn nhất có volume >= threshold.
 */
export function approximateHvnEdge(
  candles: Candle[],
  start: number,
  endInclusive: number,
  direction: KeyVolumeDirection,
  bins: number,
  threshold: number,
): number | null {
  if (start < 0 || endInclusive < start || endInclusive >= candles.length || bins < 2) return null;
  const low = rangeMin(candles, start, endInclusive + 1, "low");
  const high = rangeMax(candles, start, endInclusive + 1, "high");
  if (!(high > low)) return null;
  const width = (high - low) / bins;
  const volume = Array<number>(bins).fill(0);

  for (let i = start; i <= endInclusive; i++) {
    const first = Math.max(0, Math.min(bins - 1, Math.floor((candles[i].low - low) / width)));
    const last = Math.max(0, Math.min(bins - 1, Math.floor((candles[i].high - low) / width)));
    const count = last - first + 1;
    const share = quoteVolume(candles[i]) / count;
    for (let bin = first; bin <= last; bin++) volume[bin] += share;
  }

  let poc = 0;
  for (let i = 1; i < bins; i++) if (volume[i] > volume[poc]) poc = i;
  if (!(volume[poc] > 0)) return null;
  const cutoff = volume[poc] * threshold;
  let clusterLow = poc;
  let clusterHigh = poc;
  while (clusterLow > 0 && volume[clusterLow - 1] >= cutoff) clusterLow--;
  while (clusterHigh < bins - 1 && volume[clusterHigh + 1] >= cutoff) clusterHigh++;
  return direction === "long"
    ? low + clusterLow * width
    : low + (clusterHigh + 1) * width;
}

function invalidatedByClose(candle: Candle, level: KeyVolumeLevel): boolean {
  return level.direction === "long"
    ? candle.close < level.zoneLow
    : candle.close > level.zoneHigh;
}

function buildVolumeRetestPlans(
  base: Candle[],
  h1Levels: KeyVolumeLevel[],
  h4Levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeEntryPlan[] {
  const confirm = aggregate(base, params.confirmTf, params.baseTf);
  const daily = aggregate(base, params.dailyTf, params.baseTf);
  const weekly = aggregate(base, params.weeklyTf, params.baseTf);
  const atr15 = atrSeriesForward(confirm);
  const volumes = confirm.map(quoteVolume);
  const swings = findSwings(confirm, params.bosPivotLeft, params.bosPivotRight);
  const used = new Set<string>();
  const touchCounts = new Map<string, number>();
  const plans: KeyVolumeEntryPlan[] = [];
  let setup: VolumeRetestSetup | null = null;
  const lastClosedBaseTime = base.length
    ? base[base.length - 1].openTime + TF_MS[params.baseTf]
    : 0;
  const startIndex = Math.max(params.touchVolumeLookback, params.sweepLookback, 1);

  for (let i = startIndex; i < confirm.length; i++) {
    const closeTime = confirm[i].openTime + TF_MS[params.confirmTf];
    if (closeTime > lastClosedBaseTime) break;
    const bias = higherTimeframeBias(daily, weekly, closeTime, params);

    if (setup) {
      const expiredKey = !isKeyVolumeLevelActive(setup.key, closeTime);
      const expiredSweep = setup.sweepIndex == null
        ? i - setup.touchIndex > params.sweepWaitBars
        : i - setup.sweepIndex > params.bosExpiryBars;
      const invalidated = expiredKey || invalidatedByClose(confirm[i], setup.key);
      if (invalidated) {
        used.add(setup.key.id);
        setup = null;
      } else if (bias !== setup.direction || expiredSweep) {
        // Một lần volume/touch sai vị trí không làm key mất hiệu lực. Video #23
        // bỏ lần đầu và chờ lần sau kích volume đúng nơi cần.
        setup = null;
      }
    }

    if (!setup && bias) {
      const touch = selectKeyTouch(
        confirm[i],
        closeTime,
        bias,
        atr15[i],
        h1Levels,
        h4Levels,
        used,
        params,
      );
      if (touch) {
        diagnostics.confluentTouches++;
        const touchCount = (touchCounts.get(touch.key.id) ?? 0) + 1;
        touchCounts.set(touch.key.id, touchCount);
        const baseline = medianPrior(volumes, i, params.touchVolumeLookback);
        const triggerVolumeRatio = baseline > 0 ? volumes[i] / baseline : 0;
        // "Cái phát đầu tiên là không thể nào mà tray được" (#22).
        const secondTouchOk = !params.requireSecondTouch || touchCount >= 2;
        const dailyOk = !params.requireDailyTrapGate
          || dailyTrapGate(
            daily,
            latestClosedIndex(daily, closeTime, TF_MS[params.dailyTf]),
            bias,
          );
        if (!secondTouchOk) diagnostics.rejectedFirstTouch++;
        else if (!dailyOk) diagnostics.rejectedDailyTrap++;
        else if (triggerVolumeRatio >= params.touchVolumeSpikeMult) {
          diagnostics.touchVolumeConfirmed++;
          setup = {
            direction: bias,
            key: touch.key,
            higherKey: touch.higherKey,
            touchIndex: i,
            triggerVolumeRatio,
          };
        }
      }
    }
    if (!setup) continue;

    if (setup.sweepIndex == null) {
      if (!sweptAndReclaimed(confirm, i, setup.direction, params.sweepLookback)) continue;
      setup.sweepIndex = i;
      diagnostics.sweeps++;
      continue;
    }

    const sweepIndex = setup.sweepIndex;
    if (params.entryTrigger === "bos") {
      const structure = crossedSwing(
        confirm,
        swings,
        i,
        setup.direction,
        (swing) =>
          swing.index <= sweepIndex
          && swing.index >= sweepIndex - params.bosSwingLookback,
      );
      if (!structure) continue;
      diagnostics.firstBos++;
    } else {
      // #50: "sau khi stop hunt xong thì mình vào lệnh theo cái mô hình nến".
      if (!hasReversalCandlePattern(confirm, i, setup.direction)) continue;
      diagnostics.candlePatterns++;
    }

    if (
      params.requireDoubleTopBottom
      && !hasDoubleTopBottom(
        swings,
        i,
        setup.direction,
        params.doubleTolAtr * atr15[i],
        params.doubleLookbackBars,
      )
    ) {
      diagnostics.rejectedDouble++;
      continue;
    }

    if (
      params.sessionHoursUtc
      && !isWithinSession(
        confirm[i].openTime,
        params.sessionHoursUtc[0],
        params.sessionHoursUtc[1],
      )
    ) {
      diagnostics.rejectedSession++;
      continue;
    }

    const readyTime = confirm[i].openTime + TF_MS[params.confirmTf];
    const readyIndex = lowerBoundTime(base, readyTime);
    const confirmation = confirm[i];
    const bodyLow = Math.min(confirmation.open, confirmation.close);
    const bodyHigh = Math.max(confirmation.open, confirmation.close);
    const structuralStop = setup.direction === "long"
      ? rangeMin(confirm, setup.touchIndex, sweepIndex + 1, "low")
      : rangeMax(confirm, setup.touchIndex, sweepIndex + 1, "high");

    if (!params.allowKeyReentry) used.add(setup.key.id);
    if (readyIndex < base.length) {
      plans.push({
        id: `${setup.key.id}:volume-retest:${confirmation.openTime}`,
        model: "volume-retest",
        direction: setup.direction,
        readyIndex,
        expiresIndex: readyIndex,
        key: setup.key,
        higherKey: setup.higherKey,
        obLow: bodyLow,
        obHigh: bodyHigh,
        structuralStop,
        patternStop: setup.direction === "long" ? confirmation.low : confirmation.high,
        triggerVolumeRatio: setup.triggerVolumeRatio,
        enterNextOpen: true,
        score: setup.key.volumeRatio
          + setup.triggerVolumeRatio
          + (setup.higherKey?.volumeRatio ?? 0),
      });
    }
    setup = null;
  }

  diagnostics.plans = plans.length;
  return plans;
}

function buildDocumentEntryPlans(
  base: Candle[],
  h1Levels: KeyVolumeLevel[],
  h4Levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeEntryPlan[] {
  const confirm = aggregate(base, params.confirmTf, params.baseTf);
  const daily = aggregate(base, params.dailyTf, params.baseTf);
  const weekly = aggregate(base, params.weeklyTf, params.baseTf);
  const atr15 = atrSeriesForward(confirm);
  const swings = findSwings(confirm, params.bosPivotLeft, params.bosPivotRight);
  const used = new Set<string>();
  const plans: KeyVolumeEntryPlan[] = [];
  let setup: ConfirmationSetup | null = null;
  const lastClosedBaseTime = base.length
    ? base[base.length - 1].openTime + TF_MS[params.baseTf]
    : 0;

  for (let i = Math.max(params.sweepLookback, 1); i < confirm.length; i++) {
    const closeTime = confirm[i].openTime + TF_MS[params.confirmTf];
    if (closeTime > lastClosedBaseTime) break;
    const bias = higherTimeframeBias(daily, weekly, closeTime, params);

    if (setup) {
      const expiredKey = !isKeyVolumeLevelActive(setup.key, closeTime);
      if (bias !== setup.direction || expiredKey || invalidatedByClose(confirm[i], setup.key)) {
        used.add(setup.key.id);
        setup = null;
      }
    }

    if (!setup && bias) {
      const confluence = selectConfluentTouch(
        confirm[i],
        closeTime,
        bias,
        atr15[i],
        h1Levels,
        h4Levels,
        used,
        params,
      );
      if (confluence) {
        diagnostics.confluentTouches++;
        setup = {
          direction: bias,
          key: confluence.key,
          higherKey: confluence.higherKey,
          touchIndex: i,
          phase: "sweep",
        };
      }
    }
    if (!setup) continue;

    if (setup.phase === "sweep") {
      if (i - setup.touchIndex > params.sweepWaitBars) {
        used.add(setup.key.id);
        setup = null;
        continue;
      }
      if (!sweptAndReclaimed(confirm, i, setup.direction, params.sweepLookback)) continue;
      setup.phase = "bos";
      setup.sweepIndex = i;
      diagnostics.sweeps++;
      continue;
    }

    const sweepIndex = setup.sweepIndex!;
    if (i - sweepIndex > params.bosExpiryBars) {
      used.add(setup.key.id);
      setup = null;
      continue;
    }

    if (setup.firstBosIndex == null) {
      const first = crossedSwing(
        confirm,
        swings,
        i,
        setup.direction,
        (swing) =>
          swing.index <= sweepIndex
          && swing.index >= sweepIndex - params.bosSwingLookback,
      );
      if (!first) continue;
      setup.firstBosIndex = i;
      diagnostics.firstBos++;
      continue;
    }

    const second = crossedSwing(
      confirm,
      swings,
      i,
      setup.direction,
      (swing) => swing.index > setup!.firstBosIndex!,
    );
    if (!second) continue;
    diagnostics.secondBos++;

    const sweepStart = lowerBoundTime(base, confirm[sweepIndex].openTime);
    const bosClose = confirm[i].openTime + TF_MS[params.confirmTf];
    const afterBos = lowerBoundTime(base, bosClose);
    const bosEnd = afterBos - 1;
    const tolerance = params.keyTouchAtr * atr15[i];
    const ob = findEntryOrderBlock(
      base,
      sweepStart,
      bosEnd,
      setup.direction,
      setup.key,
      tolerance,
    );
    const hvnEdge = approximateHvnEdge(
      base,
      sweepStart,
      bosEnd,
      setup.direction,
      params.profileBins,
      params.hvnThreshold,
    );
    const profileAligned = ob != null
      && hvnEdge != null
      && hvnEdge >= ob.low - params.profileEdgeAtr * atr15[i]
      && hvnEdge <= ob.high + params.profileEdgeAtr * atr15[i];

    used.add(setup.key.id);
    if (ob && hvnEdge != null && profileAligned && afterBos < base.length) {
      diagnostics.profileAccepted++;
      plans.push({
        id: `${setup.key.id}:${confirm[i].openTime}`,
        model: "document-v1",
        direction: setup.direction,
        readyIndex: afterBos,
        expiresIndex: Math.min(base.length - 1, afterBos + params.entryExpiryBars),
        key: setup.key,
        higherKey: setup.higherKey,
        obLow: ob.low,
        obHigh: ob.high,
        hvnEdge,
        score: setup.key.volumeRatio + setup.higherKey.volumeRatio,
      });
    }
    setup = null;
  }

  diagnostics.plans = plans.length;
  return plans;
}

function buildEntryPlans(
  base: Candle[],
  h1Levels: KeyVolumeLevel[],
  h4Levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeEntryPlan[] {
  return params.entryModel === "volume-retest"
    ? buildVolumeRetestPlans(base, h1Levels, h4Levels, diagnostics, params)
    : buildDocumentEntryPlans(base, h1Levels, h4Levels, diagnostics, params);
}

function entryCandleMatches(
  candle: Candle,
  plan: KeyVolumeEntryPlan,
  atr: number,
  params: KeyVolumeParams,
): boolean {
  if (plan.enterNextOpen) return true;
  if (plan.hvnEdge == null) return false;
  const touchesOb = candle.low <= plan.obHigh && candle.high >= plan.obLow;
  const touchesHvn = candle.low <= plan.hvnEdge + params.profileEdgeAtr * atr
    && candle.high >= plan.hvnEdge - params.profileEdgeAtr * atr;
  const middle = (plan.obLow + plan.obHigh) / 2;
  const rejects = plan.direction === "long"
    ? candle.close > candle.open && candle.close >= middle
    : candle.close < candle.open && candle.close <= middle;
  return touchesOb && touchesHvn && rejects;
}

function nearestOpposingTarget(
  levels: KeyVolumeLevel[],
  time: number,
  direction: KeyVolumeDirection,
  entry: number,
  sourceTfs?: KeyVolumeSourceTf[],
  beyond?: number,
): number | null {
  const candidates = levels
    .filter((level) =>
      level.direction !== direction
      && isKeyVolumeLevelActive(level, time)
      && (!sourceTfs || sourceTfs.includes(level.sourceTf))
      && (direction === "long" ? level.price > entry : level.price < entry)
      && (beyond == null || (direction === "long" ? level.price > beyond : level.price < beyond))
    )
    .map((level) => level.price)
    .sort((a, b) => direction === "long" ? a - b : b - a);
  return candidates[0] ?? null;
}

export function resolveTargetR(
  opposingR: number | null,
  params: Pick<KeyVolumeParams, "targetMode" | "finalTargetR">,
): number {
  if (opposingR == null) return params.finalTargetR;
  return params.targetMode === "capped-r"
    ? Math.min(params.finalTargetR, opposingR)
    : opposingR;
}

export function canReenterKey(
  direction: KeyVolumeDirection,
  currentSweep: number | undefined,
  previousReason: KeyVolumeExitReason,
  previousSweep: number | undefined,
  enabled: boolean,
  mode: KeyVolumeReentryMode = "deeper-sweep",
): boolean {
  if (!enabled || previousReason !== "positive-stop") return false;
  // #23/#43: sau stop dương, giá chạm key lần nữa và kích volume lần nữa là vào
  // lại — tác giả coi đây là thao tác thường quy, không đòi cú quét sâu hơn.
  if (mode === "volume-retouch") return true;
  if (currentSweep == null || previousSweep == null) return false;
  return direction === "long"
    ? currentSweep < previousSweep
    : currentSweep > previousSweep;
}

function tradeCostR(
  entry: number,
  stop: number,
  entryTime: number,
  exitTime: number,
  partialTime?: number,
): number {
  if (!CONFIG.costs.enabled) return 0;
  const riskFraction = Math.abs(entry - stop) / entry;
  if (!(riskFraction > 0)) return 0;
  const feeFraction = ((CONFIG.costs.takerFeePct + CONFIG.costs.slippagePct) / 100) * 2;
  const periods = (from: number, to: number) =>
    Math.max(0, Math.floor(to / FUNDING_INTERVAL_MS) - Math.floor(from / FUNDING_INTERVAL_MS));
  const fundingPeriods = partialTime == null
    ? periods(entryTime, exitTime)
    : 0.5 * periods(entryTime, partialTime) + 0.5 * periods(entryTime, exitTime);
  const fundingFraction = fundingPeriods * (CONFIG.costs.fundingPer8hPct / 100);
  return (feeFraction + fundingFraction) / riskFraction;
}

export function hasShortHigherLowPressure(
  candles: Candle[],
  index: number,
  direction: KeyVolumeDirection,
  bars: number,
): boolean {
  // Tài liệu chỉ phát biểu rule này cho SHORT: higher-low liên tiếp đang dồn giá lên.
  // Không tự đối xứng hoá sang LONG vì đó sẽ là một luật mới chưa được đặc tả.
  if (direction !== "short" || bars < 2 || index < bars - 1) return false;
  const start = index - bars + 1;
  for (let i = start + 1; i <= index; i++) {
    if (candles[i].low <= candles[i - 1].low) return false;
  }
  return true;
}

function finishTrade(
  symbol: string,
  base: Candle[],
  position: OpenPosition,
  exitIndex: number,
  exitPrice: number,
  exitReason: KeyVolumeExitReason,
): KeyVolumeTrade {
  const direction = position.plan.direction;
  const finalR = direction === "long"
    ? (exitPrice - position.entry) / position.risk
    : (position.entry - exitPrice) / position.risk;
  const grossR = position.realizedR + position.remaining * finalR;
  const entryTime = base[position.entryIndex].openTime;
  const exitTime = base[exitIndex].openTime;
  const partialTime = position.partialIndex == null
    ? undefined
    : base[position.partialIndex].openTime;
  const costR = tradeCostR(position.entry, position.initialStop, entryTime, exitTime, partialTime);
  return {
    symbol,
    dir: direction,
    entryTime,
    entryPrice: position.entry,
    initialSL: position.initialStop,
    target: position.target,
    exitTime,
    exitPrice,
    exitReason,
    grossR,
    costR,
    netR: grossR - costR,
    holdBars: exitIndex - position.entryIndex,
    partialTaken: position.partialIndex != null,
    keyPrice: position.plan.key.price,
    keyVolumeRatio: position.plan.key.volumeRatio,
    higherVolumeRatio: position.plan.higherKey?.volumeRatio,
    triggerVolumeRatio: position.plan.triggerVolumeRatio,
    model: position.plan.model,
  };
}

function simulatePlans(
  symbol: string,
  base: Candle[],
  plans: KeyVolumeEntryPlan[],
  levels: KeyVolumeLevel[],
  diagnostics: KeyVolumeDiagnostics,
  params: KeyVolumeParams,
): KeyVolumeTrade[] {
  const trades: KeyVolumeTrade[] = [];
  const atr5 = atrSeriesForward(base);
  const trailSwings = findSwings(base, params.bosPivotLeft, params.bosPivotRight);
  const swingsConfirmedAt = new Map<number, Swing[]>();
  for (const swing of trailSwings) {
    const values = swingsConfirmedAt.get(swing.confirmIndex) ?? [];
    values.push(swing);
    swingsConfirmedAt.set(swing.confirmIndex, values);
  }
  const consumed = new Set<string>();
  const keyOutcomes = new Map<string, {
    reason: KeyVolumeExitReason;
    sweepExtreme?: number;
  }>();
  let position: OpenPosition | null = null;
  let cooldownUntil = -1;

  for (let i = 20; i < base.length; i++) {
    const candle = base[i];

    if (position) {
      const held = i - position.entryIndex;
      const direction = position.plan.direction;
      const stopHit = direction === "long" ? candle.low <= position.stop : candle.high >= position.stop;
      const targetHit = direction === "long" ? candle.high >= position.target : candle.low <= position.target;
      let exitPrice: number | null = null;
      let reason: KeyVolumeExitReason | null = null;

      if (stopHit) {
        exitPrice = position.stop;
        const isPositiveStop = direction === "long"
          ? position.stop > position.entry
            || (position.partialIndex != null && position.stop >= position.entry)
          : position.stop < position.entry
            || (position.partialIndex != null && position.stop <= position.entry);
        reason = isPositiveStop ? "positive-stop" : "stop";
      } else if (targetHit) {
        exitPrice = position.target;
        reason = "target";
      } else {
        const favorable = direction === "long"
          ? candle.high - position.entry
          : position.entry - candle.low;
        position.maxFavorable = Math.max(position.maxFavorable, favorable);

        const partialHit = direction === "long"
          ? candle.high >= position.partialPrice
          : candle.low <= position.partialPrice;
        if (params.partialFraction > 0 && position.partialIndex == null && partialHit) {
          position.realizedR += params.partialFraction * position.partialR;
          position.remaining -= params.partialFraction;
          position.partialIndex = i;
          // Sau TP1, phần còn lại không được quay về full initial risk. Đây là
          // cách tối thiểu để số hoá "chốt 1/2 rồi giữ bằng stop dương".
          position.stop = direction === "long"
            ? Math.max(position.stop, position.entry)
            : Math.min(position.stop, position.entry);
        }

        const entryInvalid = position.plan.model === "volume-retest"
          && (direction === "long"
            ? candle.close < position.plan.obLow
            : candle.close > position.plan.obHigh);
        if (entryInvalid) {
          exitPrice = candle.close;
          reason = "entry-invalid";
        } else if (invalidatedByClose(candle, position.plan.key)) {
          exitPrice = candle.close;
          reason = "key-invalid";
        } else if (
          params.requireFollowThrough
          && held >= params.followThroughBars
          && position.maxFavorable < params.minFollowThroughR * position.risk
        ) {
          exitPrice = candle.close;
          reason = "no-follow-through";
        } else if (
          position.plan.model === "document-v1"
          && held >= params.pressureBars
          && hasShortHigherLowPressure(base, i, direction, params.pressureBars)
        ) {
          exitPrice = candle.close;
          reason = "opposite-pressure";
        } else if (held >= params.maxHoldBars) {
          exitPrice = candle.close;
          reason = "time";
        }

        if (exitPrice == null && params.trailMode === "m5-swing") {
          for (const swing of swingsConfirmedAt.get(i) ?? []) {
            if (swing.index <= position.entryIndex) continue;
            const favorableSwing = direction === "long"
              ? swing.type === "low" && swing.price > position.entry
              : swing.type === "high" && swing.price < position.entry;
            if (!favorableSwing) continue;
            const candidate = direction === "long"
              ? swing.price - params.stopBufferAtr * atr5[i]
              : swing.price + params.stopBufferAtr * atr5[i];
            const valid = direction === "long"
              ? candidate > position.entry && candidate < candle.close
              : candidate < position.entry && candidate > candle.close;
            if (!valid) continue;
            position.stop = direction === "long"
              ? Math.max(position.stop, candidate)
              : Math.min(position.stop, candidate);
          }
        }
      }

      if (exitPrice != null && reason) {
        trades.push(finishTrade(symbol, base, position, i, exitPrice, reason));
        keyOutcomes.set(position.plan.key.id, {
          reason,
          sweepExtreme: position.plan.structuralStop,
        });
        position = null;
        cooldownUntil = i + params.cooldownBars;
      }
      continue;
    }

    if (i < cooldownUntil) continue;
    const candidates = plans
      .filter((plan) =>
        !consumed.has(plan.id)
        && plan.readyIndex <= i
        && i <= plan.expiresIndex
        && isKeyVolumeLevelActive(plan.key, candle.openTime + TF_MS[params.baseTf])
        && (() => {
          const previous = keyOutcomes.get(plan.key.id);
          if (!previous) return true;
          return canReenterKey(
            plan.direction,
            plan.structuralStop,
            previous.reason,
            previous.sweepExtreme,
            params.allowKeyReentry,
            params.reentryMode,
          );
        })()
        && entryCandleMatches(candle, plan, atr5[i], params),
      )
      .sort((a, b) => b.score - a.score);
    const plan = candidates[0];
    if (!plan) continue;
    consumed.add(plan.id);

    const entry = plan.enterNextOpen ? candle.open : candle.close;
    const fallbackStop = plan.direction === "long"
      ? Math.min(plan.obLow, plan.key.zoneLow)
      : Math.max(plan.obHigh, plan.key.zoneHigh);
    const modeStop = params.stopMode === "confirmation"
      ? plan.patternStop
      : params.stopMode === "key"
        ? (plan.direction === "long" ? plan.key.zoneLow : plan.key.zoneHigh)
        : plan.structuralStop;
    const stopReference = modeStop ?? plan.structuralStop ?? fallbackStop;
    const stop = plan.direction === "long"
      ? stopReference - params.stopBufferAtr * atr5[i]
      : stopReference + params.stopBufferAtr * atr5[i];
    const risk = Math.abs(entry - stop);
    const riskFraction = risk / entry;
    if (
      !(risk > 0)
      || riskFraction > params.maxStopPct
      || (plan.direction === "long" ? stop <= 0 || stop >= entry : stop <= entry)
    ) {
      diagnostics.rejectedRisk++;
      continue;
    }

    const opposing = nearestOpposingTarget(
      levels,
      candle.openTime + TF_MS[params.baseTf],
      plan.direction,
      entry,
      params.targetSourceTfs,
    );
    const opposingR = opposing == null
      ? Infinity
      : Math.abs(opposing - entry) / risk;
    if (opposingR < params.minRR) {
      diagnostics.rejectedRoom++;
      continue;
    }
    const targetR = resolveTargetR(opposing == null ? null : opposingR, params);
    const target = plan.direction === "long"
      ? entry + targetR * risk
      : entry - targetR * risk;
    const partialPrice = plan.direction === "long"
      ? entry + params.partialAtR * risk
      : entry - params.partialAtR * risk;

    position = {
      plan,
      entryIndex: i,
      entry,
      initialStop: stop,
      stop,
      target,
      risk,
      partialPrice,
      partialR: params.partialAtR,
      remaining: 1,
      realizedR: 0,
      maxFavorable: 0,
    };
    diagnostics.entries++;
  }

  return trades;
}

export function runKeyVolume(
  symbol: string,
  baseCandles: Candle[],
  params: KeyVolumeParams = KEY_VOLUME_CONFIG,
): KeyVolumeResult {
  const base = baseCandles
    .filter((candle) =>
      Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
      && candle.high >= candle.low,
    )
    .sort((a, b) => a.openTime - b.openTime);
  const keyCandles = aggregate(base, params.keyTf, params.baseTf);
  const confluenceCandles = aggregate(base, params.confluenceTf, params.baseTf);
  const targetCandles = aggregate(base, params.confirmTf, params.baseTf);
  const h1Levels = detectKeyVolumeLevels(keyCandles, params.keyTf, params);
  const h4Levels = detectKeyVolumeLevels(confluenceCandles, params.confluenceTf, params);
  const m15Levels = detectKeyVolumeLevels(targetCandles, params.confirmTf, params);
  const diagnostics: KeyVolumeDiagnostics = {
    m15Levels: new Set(m15Levels.map((level) => level.eventTime)).size,
    h1Levels: new Set(h1Levels.map((level) => level.eventTime)).size,
    h4Levels: new Set(h4Levels.map((level) => level.eventTime)).size,
    confluentTouches: 0,
    touchVolumeConfirmed: 0,
    sweeps: 0,
    firstBos: 0,
    secondBos: 0,
    candlePatterns: 0,
    profileAccepted: 0,
    plans: 0,
    entries: 0,
    rejectedRisk: 0,
    rejectedRoom: 0,
    rejectedFirstTouch: 0,
    rejectedDailyTrap: 0,
    rejectedDouble: 0,
    rejectedSession: 0,
  };
  const plans = buildEntryPlans(base, h1Levels, h4Levels, diagnostics, params);
  const levels = params.entryModel === "volume-retest"
    ? [...m15Levels, ...h1Levels, ...h4Levels]
    : [...h1Levels, ...h4Levels];
  const trades = simulatePlans(symbol, base, plans, levels, diagnostics, params);
  return { trades, plans, levels, diagnostics };
}
