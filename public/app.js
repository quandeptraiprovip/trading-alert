/* global LightweightCharts */

const STORAGE_KEY = "btc-perp-playbook.orders.v1";
const DRAFT_STORAGE_KEY = "btc-perp-playbook.drafts.v2";
const DRAWING_STORAGE_KEY = "btc-perp-playbook.drawings.v1";
const USER_FEEDBACK_STORAGE_KEY = "btc-perp-playbook.user-feedback.v1";
const KEY_VERDICT_STORAGE_KEY = "btc-perp-playbook.key-verdicts.v1";
const KEY_VERDICT_LABELS = { untrusted: "✗ Không đáng tin", trusted: "✓ Đáng tin" };
const LEGACY_BOT_FEEDBACK_STORAGE_KEY = "btc-perp-playbook.bot-feedback.v1";
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const CHART_TIME_ZONE = "Asia/Ho_Chi_Minh";
const CHART_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHART_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const CHART_TICK_MARK = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 };
const ORDER_OVERLAY = 1;
const STRATEGY_OVERLAY = 2;
const DRAWING_OVERLAY = 4;
const KEYVOL_OVERLAY = 8;
const EVIDENCE_OVERLAY = 16;
const ALL_OVERLAYS = ORDER_OVERLAY | STRATEGY_OVERLAY | DRAWING_OVERLAY | KEYVOL_OVERLAY | EVIDENCE_OVERLAY;
// Cùng màu với --green/--red/--blue/--amber và màu nguồn của .readonly-position-tool.
const AXIS_LEVEL_COLORS = { tp: "#089981", sl: "#f23645", entry: "#2962ff", turtle: "#f3ba63", fast: "#a98bff" };
// Bảng màu nến/volume kiểu TradingView — cùng giá trị với --green/--red trong styles.css.
const CANDLE_UP = "#089981";
const CANDLE_DOWN = "#f23645";
/** Chart chỉ hỗ trợ hai mã này; server vẫn có thể trả rổ bot rộng hơn. */
const SUPPORTED_SYMBOLS = ["BTCUSDT", "XAUUSDT"];
const WATCHLIST_REFRESH_MS = 15_000;
/** Kéo/zoom như TradingView: lăn chuột zoom, kéo trục giá/thời gian để co giãn, kéo chart theo cả hai chiều. */
const CHART_NAVIGATION = {
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
  handleScale: {
    axisPressedMouseMove: { time: true, price: true },
    axisDoubleClickReset: { time: true, price: true },
    mouseWheel: true,
    pinch: true,
  },
};
const CHART_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const KEYVOL_TF_LABEL = { "15m": "M15" };
const KEYVOL_MAX_DRAWN = 240;
/**
 * Vạch ngưỡng của mọi thước điều kiện đứng ở đúng một vị trí (% bề rộng), nên
 * quét dọc một cột là so được ngay cái nào vượt xa, cái nào vừa đủ.
 */
const EVIDENCE_GATE_AT = 45;

/** Nhánh nào sinh ra lệnh. Nhánh quét KHÔNG dùng key ở khâu nào — phải nói rõ. */
const FXDREAM_BRANCH_META = {
  "sweep-reclaim": { tag: "NHÁNH QUÉT · KHÔNG KEY", cls: "is-sweep", usesKey: false },
  "volume-reversal": { tag: "KEY + HỘP · RETEST", cls: "is-key", usesKey: true },
  "key-trap": { tag: "KEY · TRAP QUAY VỀ", cls: "is-key", usesKey: true },
  "key-lower-high": { tag: "KEY · ĐỈNH THẤP DẦN · LỆNH CHỜ", cls: "is-key", usesKey: true },
};

/** Trần dư địa vẽ được trên thước R; vượt trần thì nén về mép + dấu ngắt "≫". */
const FXDREAM_RULER_MAX_R = 6;

function fxCount(value) {
  return Number(value || 0).toLocaleString("vi-VN");
}

function fxDiff(a, b) {
  return Math.max(0, Number(a || 0) - Number(b || 0));
}

/** Cụm đảo chiều DỰNG ĐƯỢC = cụm hợp lệ + hai loại bị loại ở cửa tiền đề. */
function fxClustersBuilt(d) {
  return Number(d.candlePatterns || 0)
    + Number(d.rejectedKeyOutsideBlock || 0)
    + Number(d.rejectedNoDeparture || 0);
}

/**
 * Phễu FX Dream — chuỗi cửa ĐÚNG như key-volume.ts đếm, không phải chuỗi đẹp.
 * Ba điều đã kiểm trong code trước khi dựng bảng này, vì đoán sai là ra số vô nghĩa:
 *  1. `rejectedDepart` và toàn bộ `boxes*` được CẢ HAI NHÁNH dùng chung, nên từ
 *     bậc "hộp chờ retest" trở đi không tách được riêng nhánh key → gắn nhãn scope.
 *  2. `boxesRetouched` KHÔNG phân hoạch với `boxesBroken`: một hộp có thể quay lại
 *     rồi vẫn vỡ. Nó là thống kê bên lề, không phải một bậc.
 *  3. Hộp: `boxesArmed` = lệnh vào từ hộp + `boxesBroken` + `boxesExpired` +
 *     `boxesUnresolved`, còn `rejectedRisk`/`rejectedRoom` nằm BÊN TRONG các bucket
 *     đó (nến xác nhận bị từ chối, hộp vẫn còn sống) → ghi ở dòng giải thích, không
 *     trừ. Lệnh chờ nhánh quét: `limitsPlaced` = khớp + bị loại lúc khớp +
 *     `limitsExpired` + `limitsUnresolved`.
 */
const FXDREAM_FUNNEL_STAGES = [
  {
    key: "keys",
    label: "key M15",
    scope: "key",
    value: (d) => Number(d.m15Levels || 0),
    leaks: () => [],
    detail: (d) => `Detector sinh ${fxCount(d.m15Levels)} key trong cửa sổ này — mẫu số của mọi tỉ lệ bên dưới. Mật độ này dày gấp 20–30 lần thang key vẽ tay, nên một bậc rơi mạnh không có nghĩa là luật khắt khe.`,
  },
  {
    key: "keyTouches",
    label: "chạm key",
    scope: "key",
    value: (d) => Number(d.keyTouches || 0),
    leaks: () => [{ text: "một key bị chạm nhiều lần", warn: true }],
    detail: (d) => `${fxCount(d.keyTouches)} lần giá chạm lại một key còn hiệu lực. Số này LỚN HƠN số key vì nó đếm SỰ KIỆN chạm, không phải key — đừng đọc hai bậc đầu như tỉ lệ phần trăm của nhau.`,
  },
  {
    key: "touchVolumeConfirmed",
    label: "chạm có volume",
    scope: "key",
    value: (d) => Number(d.touchVolumeConfirmed || 0),
    leaks: (d) => {
      const out = [];
      if (Number(d.rejectedFirstTouch || 0) > 0) out.push({ text: `−${fxCount(d.rejectedFirstTouch)} mới là lần chạm đầu` });
      out.push({ text: `−${fxCount(fxDiff(fxDiff(d.keyTouches, d.rejectedFirstTouch), d.touchVolumeConfirmed))} cây chạm không đủ volume` });
      return out;
    },
    detail: (d) => `${fxCount(d.touchVolumeConfirmed)} cú chạm có volume vượt ngưỡng. Đây là cửa cắt mạnh nhất và rẻ nhất của cả phễu — đổi ngưỡng volume ở đây là đòn bẩy lớn nhất.`,
  },
  {
    key: "setups",
    label: "mở setup",
    scope: "key",
    value: (d) => fxDiff(d.touchVolumeConfirmed, d.rejectedNoDeparture),
    leaks: (d) => [{ text: `−${fxCount(d.rejectedNoDeparture)} giá chưa từng RỜI key` }],
    detail: (d) => `${fxCount(fxDiff(d.touchVolumeConfirmed, d.rejectedNoDeparture))} setup được mở. Chạm key mà trước đó giá chưa từng rời nó thì đây không phải cú QUAY VỀ, chỉ là giá đi ngang đè lên mức — cửa này là phần "đúng phương pháp" nhất.`,
  },
  {
    key: "candlePatterns",
    label: "tín hiệu hợp lệ",
    scope: "key",
    value: (d) => Number(d.candlePatterns || 0),
    leaks: (d) => {
      const setups = fxDiff(d.touchVolumeConfirmed, d.rejectedNoDeparture);
      const noCluster = fxDiff(fxDiff(setups, d.rejectedKeyOutsideBlock), d.candlePatterns);
      return [
        { text: `−${fxCount(noCluster)} không dựng được cụm đảo` },
        { text: `−${fxCount(d.rejectedKeyOutsideBlock)} key nằm NGOÀI thân hộp` },
      ];
    },
    detail: (d) => `${fxCount(d.candlePatterns)} tín hiệu bóp cò hợp lệ, trong đó ${fxCount(d.structureSignals)} là tín hiệu A (hai đáy/đỉnh tại key + RSI phân kỳ). Phần còn lại là cụm mũi nhọn: dựng được hộp (lấy THÂN nến, bỏ râu) VÀ đường key chạy xuyên thân hộp. Tín hiệu A có phép đo "tại key" riêng nên không qua cửa key-trong-hộp.`,
  },
  {
    key: "volumeBranchPlans",
    label: "kế hoạch key",
    scope: "key",
    value: (d) => Number(d.volumeBranchPlans || 0),
    leaks: (d) => [{ text: `−${fxCount(fxDiff(d.candlePatterns, d.volumeBranchPlans))} loại ở volume / phiên / rời hộp` }],
    detail: (d) => `${fxCount(d.volumeBranchPlans)} kế hoạch nhánh key. Bốn cửa cắt ở đây: volume cây bóp cò, hai đỉnh/hai đáy, phiên, và cửa rời hộp — cửa rời hộp phải đo bằng GIÁ ĐÓNG, đo bằng cả cây nến từng làm hệ tắt hẳn.`,
  },
  {
    key: "boxesArmed",
    label: "hộp / lệnh chờ",
    scope: "both",
    value: (d) => Number(d.boxesArmed || 0) + Number(d.limitsPlaced || 0) + Number(d.keyTrapPlans || 0),
    leaks: (d) => [
      { text: `+${fxCount(d.limitsPlaced)} lệnh chờ nhánh quét`, warn: true },
      { text: `+${fxCount(d.keyTrapPlans)} trap qua key vào ngay`, warn: true },
    ],
    detail: (d) => `${fxCount(d.boxesArmed)} hộp được trang bị để canh giá quay lại, ${fxCount(d.limitsPlaced)} lệnh chờ ở mép order block của nhánh quét, và ${fxCount(d.keyTrapPlans)} trap qua key (vào ngay ở giá đóng nến quay về, bị chặn là mất luôn) — từ đây engine mô phỏng chung một sổ. Trong số hộp, ${fxCount(d.boxesRetouched)} hộp thấy giá quay lại chạm ít nhất một nến — nhưng chạm rồi vẫn vỡ được, nên đó là thống kê bên lề chứ không phải một bậc.`,
  },
  {
    key: "entries",
    label: "VÀO LỆNH",
    scope: "both",
    final: true,
    value: (d) => Number(d.entries || 0),
    leaks: (d) => [
      { text: `−${fxCount(d.boxesBroken)} vỡ hộp` },
      { text: `−${fxCount(d.boxesExpired)} hộp hết hạn chờ` },
      { text: `−${fxCount(d.limitsExpired)} lệnh chờ không khớp` },
      { text: `−${fxCount(Number(d.boxesUnresolved || 0) + Number(d.limitsUnresolved || 0))} hết dữ liệu`, warn: true },
    ],
    detail: (d, ctx) => `${fxCount(d.entries)} lệnh mở, trong đó ${fxCount(ctx.keyBranchEntries)} thuộc nhánh key. ${fxCount(d.rejectedRoom)} lần bị loại vì dư địa dưới minRR và ${fxCount(d.rejectedRisk)} lần vì rủi ro vượt trần: với hộp, nến xác nhận bị từ chối nhưng hộp vẫn sống nên không trừ thêm; với lệnh chờ, khớp mà trượt cửa thì lệnh rời sổ luôn.`,
  },
];

/** Năm lớp SVG thật đang xếp chồng trên chart, theo đúng thứ tự z-index trong CSS. */
const CHART_LAYER_DEFS = [
  { key: "position", label: "Vị thế đang chọn", hint: "vùng vị thế · chỉ ghi số R" },
  { key: "keys", label: "Vùng key volume", hint: "đường key và nhãn ×volume" },
  { key: "evidence", label: "Soi bằng chứng", hint: "sáng lên khi rê chuột ở bảng phải" },
  { key: "context", label: "Ngữ cảnh Turtle/Fast", hint: "kênh breakout của sổ bot khác" },
  { key: "draw", label: "Hình vẽ tay", hint: "vùng phản ứng và đường tự vẽ" },
  { key: "rsi", label: "RSI 14", hint: "RSI Wilder dưới volume · mốc 30/70" },
];
// Cùng chu kỳ với tín hiệu A của engine (KEY_VOLUME_CONFIG.rsiPeriod).
const RSI_PERIOD = 14;
const MIN_POSITION_WIDTH = 28;
const COIN_META = {
  BTC: { name: "Bitcoin", mark: "₿", markClass: "is-btc" },
  XAU: { name: "Vàng", mark: "Au", markClass: "is-xau" },
};
const FEEDBACK_LABELS = {
  approved: "✓ Đúng phương pháp",
  review: "! Cần xem lại",
  rejected: "× Không nên vào",
};

const dom = {
  chart: document.querySelector("#price-chart"),
  chartWrap: document.querySelector("#chart-wrap"),
  chartLoading: document.querySelector("#chart-loading"),
  strategyContextLayer: document.querySelector("#strategy-context-layer"),
  drawingLayer: document.querySelector("#drawing-layer"),
  positionPlacementLayer: document.querySelector("#position-placement-layer"),
  positionPlacementHint: document.querySelector("#position-placement-hint"),
  positionPlacementTitle: document.querySelector("#position-placement-title"),
  chartViewButtons: [...document.querySelectorAll("[data-chart-view]")],
  chartViewSummary: document.querySelector("#chart-view-summary"),
  bottomDock: document.querySelector("#bottom-dock"),
  dockPanelButtons: [...document.querySelectorAll(".dock-tab[data-dock-panel]")],
  dockControls: [...document.querySelectorAll("[data-dock-panel]")],
  strategyPanel: document.querySelector("#strategy-audit"),
  journalPanel: document.querySelector("#journal-section"),
  drawingModeButtons: [...document.querySelectorAll("[data-drawing-mode]")],
  deleteDrawing: document.querySelector("#delete-drawing"),
  drawingCount: document.querySelector("#drawing-count"),
  sourceState: document.querySelector("#source-state"),
  sourceLabel: document.querySelector("#source-label"),
  sourceDetail: document.querySelector("#source-detail"),
  reloadChart: document.querySelector("#reload-chart"),
  fitChart: document.querySelector("#fit-chart"),
  historyButtons: [...document.querySelectorAll("[data-history-days]")],
  symbolSearchWrap: document.querySelector("#symbol-search-wrap"),
  symbolButton: document.querySelector("#symbol-button"),
  symbolButtonMark: document.querySelector("#symbol-button-mark"),
  symbolButtonLabel: document.querySelector("#symbol-button-label"),
  symbolMenu: document.querySelector("#symbol-menu"),
  symbolSearch: document.querySelector("#symbol-search"),
  symbolOptions: [...document.querySelectorAll(".symbol-option[data-symbol]")],
  symbolMenuEmpty: document.querySelector("#symbol-menu-empty"),
  watchlistRows: [...document.querySelectorAll(".watchlist-row[data-symbol]")],
  sideViewButtons: [...document.querySelectorAll("[data-side-view]")],
  sidePanels: [...document.querySelectorAll("[data-side-panel]")],
  chartNavButtons: [...document.querySelectorAll("[data-chart-nav]")],
  chartRealtime: document.querySelector("#chart-realtime"),
  chartClock: document.querySelector("#chart-clock"),
  chartFullscreen: document.querySelector("#chart-fullscreen"),
  scaleAuto: document.querySelector("#scale-auto"),
  scaleLog: document.querySelector("#scale-log"),
  scalePercent: document.querySelector("#scale-percent"),
  legendMark: document.querySelector("#legend-mark"),
  legendChange: document.querySelector("#legend-change"),
  legendOhlc: document.querySelector(".legend-ohlc"),
  symbolMethods: document.querySelector("#symbol-methods"),
  coinAvatar: document.querySelector("#coin-avatar"),
  instrumentType: document.querySelector("#instrument-type"),
  instrumentVenue: document.querySelector("#instrument-venue"),
  instrumentSymbol: document.querySelector("#instrument-symbol"),
  instrumentDescription: document.querySelector("#instrument-description"),
  lastPrice: document.querySelector("#last-price"),
  change24h: document.querySelector("#change-24h"),
  high24h: document.querySelector("#high-24h"),
  low24h: document.querySelector("#low-24h"),
  volume24h: document.querySelector("#volume-24h"),
  volume24hLabel: document.querySelector("#volume-24h-label"),
  legendOpen: document.querySelector("#legend-open"),
  legendHigh: document.querySelector("#legend-high"),
  legendLow: document.querySelector("#legend-low"),
  legendClose: document.querySelector("#legend-close"),
  legendVolume: document.querySelector("#legend-volume"),
  legendRsi: document.querySelector("#legend-rsi"),
  legendRsiWrap: document.querySelector(".legend-rsi"),
  legendSymbol: document.querySelector("#legend-symbol"),
  chartLoadingText: document.querySelector("#chart-loading-text"),
  strategyAuditTitle: document.querySelector("#strategy-audit-title"),
  strategyTableCaption: document.querySelector("#strategy-table-caption"),
  journalTitle: document.querySelector("#journal-title"),
  strategyAuditNote: document.querySelector("#strategy-audit-note"),
  strategyBody: document.querySelector("#strategy-orders-body"),
  strategyEmpty: document.querySelector("#strategy-empty"),
  strategyFilterButtons: [...document.querySelectorAll("[data-strategy-filter]")],
  turtleConfig: document.querySelector("#turtle-config"),
  fastConfig: document.querySelector("#fast-config"),
  auditTotal: document.querySelector("#audit-total"),
  auditOpen: document.querySelector("#audit-open"),
  auditNetR: document.querySelector("#audit-net-r"),
  auditRangeLabel: document.querySelector("#audit-range-label"),
  orderForm: document.querySelector("#order-form"),
  entryInput: document.querySelector("#entry-price"),
  slInput: document.querySelector("#sl-price"),
  tpInput: document.querySelector("#tp-price"),
  priceUnits: [...document.querySelectorAll("[data-price-unit]")],
  noteInput: document.querySelector("#trade-note"),
  sideButtons: [...document.querySelectorAll("[data-side]")],
  orderLevels: document.querySelector("#order-levels"),
  addLongPlan: document.querySelector("#add-long-plan"),
  addShortPlan: document.querySelector("#add-short-plan"),
  draftOrderList: document.querySelector("#draft-order-list"),
  draftEmpty: document.querySelector("#draft-empty"),
  draftCount: document.querySelector("#draft-count"),
  selectedPlanLabel: document.querySelector("#selected-plan-label"),
  selectedEntryTime: document.querySelector("#selected-entry-time"),
  planEditor: document.querySelector("#plan-editor"),
  rrValue: document.querySelector("#rr-value"),
  rewardR: document.querySelector("#reward-r"),
  rewardRSecondary: document.querySelector("#reward-r-secondary"),
  riskPercent: document.querySelector("#risk-percent"),
  rewardPercent: document.querySelector("#reward-percent"),
  rewardSegment: document.querySelector("#reward-segment"),
  validationMessage: document.querySelector("#validation-message"),
  saveOrder: document.querySelector("#save-order"),
  saveRewardPreview: document.querySelector("#save-reward-preview"),
  resetPlan: document.querySelector("#reset-plan"),
  ordersBody: document.querySelector("#orders-body"),
  emptyJournal: document.querySelector("#empty-journal"),
  closedCount: document.querySelector("#closed-count"),
  winRate: document.querySelector("#win-rate"),
  netR: document.querySelector("#net-r"),
  expectancy: document.querySelector("#expectancy"),
  methodInsight: document.querySelector("#method-insight"),
  toast: document.querySelector("#toast"),
  feedbackDialog: document.querySelector("#feedback-dialog"),
  feedbackForm: document.querySelector("#feedback-form"),
  feedbackTradeSummary: document.querySelector("#feedback-trade-summary"),
  feedbackTradeId: document.querySelector("#feedback-trade-id"),
  feedbackNote: document.querySelector("#feedback-note"),
  feedbackDelete: document.querySelector("#feedback-delete"),
  feedbackClose: document.querySelector("#feedback-close"),
  feedbackCancel: document.querySelector("#feedback-cancel"),
  keyvolLayer: document.querySelector("#keyvol-layer"),
  evidenceLayer: document.querySelector("#evidence-layer"),
  keyvolPanel: document.querySelector("#keyvol-section"),
  keyvolPower: document.querySelector("#keyvol-power"),
  keyvolTfButtons: [...document.querySelectorAll("[data-keyvol-tf]")],
  keyvolMinRatio: document.querySelector("#keyvol-min-ratio"),
  keyvolMinRatioOut: document.querySelector("#keyvol-min-ratio-out"),
  keyvolUnbroken: document.querySelector("#keyvol-unbroken"),
  keyvolCount: document.querySelector("#keyvol-count"),
  keyvolBody: document.querySelector("#keyvol-body"),
  keyvolEmpty: document.querySelector("#keyvol-empty"),
  keyvolFunnel: document.querySelector("#keyvol-funnel"),
  keyvolConfig: document.querySelector("#keyvol-config"),
  keyvolTotal: document.querySelector("#keyvol-total"),
  keyvolUnbrokenCount: document.querySelector("#keyvol-unbroken-count"),
  keyvolEntryCount: document.querySelector("#keyvol-entry-count"),
  keyvolRangeLabel: document.querySelector("#keyvol-range-label"),
  keyvolNoteText: document.querySelector("#keyvol-note-text"),
  evidenceCard: document.querySelector("#evidence-card"),
  evidenceEmpty: document.querySelector("#evidence-empty"),
  evidenceBody: document.querySelector("#evidence-body"),
  evidenceWhen: document.querySelector("#evidence-when"),
  evidenceVerdict: document.querySelector("#evidence-verdict-text"),
  evidenceChain: document.querySelector("#evidence-chain"),
  evidenceList: document.querySelector("#evidence-list"),
  evidenceClear: document.querySelector("#evidence-clear"),
  keyvolJudged: document.querySelector("#keyvol-judged"),
  keyjudgeCard: document.querySelector("#keyjudge-card"),
  keyjudgeEmpty: document.querySelector("#keyjudge-empty"),
  keyjudgeProgress: document.querySelector("#keyjudge-progress"),
  keyjudgeBody: document.querySelector("#keyjudge-body"),
  keyjudgeHeadline: document.querySelector("#keyjudge-headline"),
  keyjudgeFacts: document.querySelector("#keyjudge-facts"),
  keyjudgeVerdicts: [...document.querySelectorAll("[data-key-verdict]")],
  keyjudgeNote: document.querySelector("#keyjudge-note-input"),
  keyjudgeDelete: document.querySelector("#keyjudge-delete"),
  keyjudgeSaved: document.querySelector("#keyjudge-saved"),
  keyjudgeClear: document.querySelector("#keyjudge-clear"),
  fxdreamRail: document.querySelector("#fxdream-rail"),
  fxdreamCardList: document.querySelector("#fxdream-card-list"),
  fxdreamRailEmpty: document.querySelector("#fxdream-rail-empty"),
  fxdreamCount: document.querySelector("#fxdream-count"),
  fxdreamFilterButtons: [...document.querySelectorAll("[data-fxdream-filter]")],
  keyvolFunnelDetail: document.querySelector("#keyvol-funnel-detail"),
  layerMenu: document.querySelector("#layer-menu"),
  layerMenuButton: document.querySelector("#layer-menu-button"),
  layerMenuList: document.querySelector("#layer-menu-list"),
  layerMenuCount: document.querySelector("#layer-menu-count"),
  evidenceIdentity: document.querySelector("#evidence-identity"),
  evidenceSide: document.querySelector("#evidence-side"),
  evidenceR: document.querySelector("#evidence-r"),
  evidenceMetrics: document.querySelector("#evidence-metrics"),
  evidenceRisk: document.querySelector("#evidence-risk"),
  evidenceRoom: document.querySelector("#evidence-room"),
  evidenceHold: document.querySelector("#evidence-hold"),
};

const state = {
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  rsiSeries: null,
  candles: [],
  candleIndexByTime: new Map(),
  volumeByTime: new Map(),
  rsiByTime: new Map(),
  axisPriceLines: new Map(),
  strategyTrades: [],
  strategyFilter: "all",
  strategyAuditLoaded: false,
  activeMethods: ["turtle", "fast"],
  botUniverse: [],
  marketMeta: { venue: "BINANCE", sourceLabel: "Binance Futures · 15m", instrumentType: "PERP", volumeUnit: "USDT" },
  userFeedback: [],
  symbol: "BTCUSDT",
  historyDays: 120,
  plans: [],
  selectedPlanId: null,
  selectedOverlayId: null,
  chartView: "clean",
  positionPlacement: null,
  dockPanel: "closed",
  drawings: [],
  drawingMode: "select",
  selectedDrawingId: null,
  drawingDraft: null,
  suppressDrawingClick: false,
  plansInitialized: false,
  orders: [],
  dragging: null,
  widthDragging: null,
  marketController: null,
  marketRequestId: 0,
  playbookSaveQueue: Promise.resolve(),
  overlayFrame: null,
  overlayMask: 0,
  draftPersistTimer: null,
  levelDragFrame: null,
  pendingLevelDrag: null,
  drawingFrame: null,
  pendingDrawingMove: null,
  toastTimer: null,
  keyVolume: null,
  keyvolFilters: { enabled: true, tfs: new Set(["15m"]), minRatio: 3, unbrokenOnly: true },
  evidenceTrade: null,
  evidenceHover: null,
  evidencePinned: null,
  keyVerdicts: [],
  selectedKeyId: null,
  keyNoteTimer: null,
  fxdreamFilter: "all",
  funnelStage: FXDREAM_FUNNEL_STAGES.length - 1,
  chartLayers: { position: true, keys: true, evidence: true, context: true, draw: true, rsi: true },
  layerMenuOpen: false,
  symbolMenuOpen: false,
  sideView: "fxdream",
  tickers: new Map(),
};

function scheduleOverlayRender(mask = ALL_OVERLAYS) {
  state.overlayMask |= mask;
  if (state.overlayFrame !== null) return;
  state.overlayFrame = window.requestAnimationFrame(() => {
    const pendingMask = state.overlayMask;
    state.overlayFrame = null;
    state.overlayMask = 0;
    if (pendingMask & ORDER_OVERLAY) renderOrderLevels();
    if (pendingMask & STRATEGY_OVERLAY) renderStrategyContexts();
    if (pendingMask & DRAWING_OVERLAY) renderDrawings();
    if (pendingMask & KEYVOL_OVERLAY) renderKeyVolumeLayer();
    if (pendingMask & EVIDENCE_OVERLAY) renderEvidenceHighlight();
  });
}

function scopedStorageKey(baseKey) {
  return `${baseKey}.${state.symbol.toLowerCase()}`;
}

function readScopedStorage(baseKey, fallback) {
  const scopedKey = scopedStorageKey(baseKey);
  let value = localStorage.getItem(scopedKey);
  if (value === null && state.symbol === "BTCUSDT") {
    value = localStorage.getItem(baseKey);
    if (value !== null) localStorage.setItem(scopedKey, value);
  }
  return value ?? fallback;
}

function loadUserFeedback() {
  try {
    const canonicalKey = scopedStorageKey(USER_FEEDBACK_STORAGE_KEY);
    let serialized = localStorage.getItem(canonicalKey);
    if (serialized === null) {
      serialized = readScopedStorage(LEGACY_BOT_FEEDBACK_STORAGE_KEY, "[]");
      localStorage.setItem(canonicalKey, serialized);
    }
    const stored = JSON.parse(serialized);
    state.userFeedback = Array.isArray(stored)
      ? stored.filter((item) => item?.key && ["approved", "review", "rejected"].includes(item.verdict))
      : [];
  } catch {
    state.userFeedback = [];
  }
}

function persistUserFeedback() {
  try {
    localStorage.setItem(scopedStorageKey(USER_FEEDBACK_STORAGE_KEY), JSON.stringify(state.userFeedback));
  } catch {
    showToast("Trình duyệt không cho phép lưu góp ý local.");
  }
}

function leftEdgeEntryTime(position) {
  const startTime = Number(position?.startTime);
  if (Number.isFinite(startTime) && startTime > 0) return startTime;
  const entryTime = Number(position?.entryTime);
  return Number.isFinite(entryTime) && entryTime > 0 ? entryTime : null;
}

function ordersForPlaybookFile() {
  return state.orders.map((order) => {
    const drawings = Array.isArray(order.drawings)
      ? order.drawings
      : state.drawings.filter((drawing) => order.drawingIds?.includes(drawing.id));
    const entryTime = leftEdgeEntryTime(order);
    return { ...order, entryTime, startTime: entryTime, drawings };
  });
}

/**
 * Mọi lần lưu đều GHI ĐÈ cả file playbook bằng dữ liệu trong localStorage. Mở app
 * ở trình duyệt/profile khác (localStorage rỗng) rồi lưu bất cứ thứ gì là xoá sạch
 * lệnh mẫu đã có trong file. Nạp file về trước, và chỉ nhận khi phía local đang rỗng.
 */
async function hydrateFromPlaybookFile() {
  const symbol = state.symbol;
  try {
    const response = await fetch(`/api/playbook?symbol=${encodeURIComponent(symbol.toLowerCase())}`, {
      headers: { Accept: "application/json" },
    });
    const document_ = await response.json();
    if (!response.ok || symbol !== state.symbol) return;

    if (!state.orders.length && Array.isArray(document_.sampleOrders) && document_.sampleOrders.length) {
      state.orders = document_.sampleOrders.filter((order) => order && order.id);
      persistOrders();
      renderOrders();
    }
    if (!state.userFeedback.length && Array.isArray(document_.userFeedback) && document_.userFeedback.length) {
      state.userFeedback = document_.userFeedback.filter((item) => item?.key && FEEDBACK_LABELS[item.verdict]);
      persistUserFeedback();
      renderStrategyAudit();
    }
    if (!state.keyVerdicts.length && Array.isArray(document_.keyVerdicts) && document_.keyVerdicts.length) {
      state.keyVerdicts = document_.keyVerdicts.filter((item) => item?.keyId && KEY_VERDICT_LABELS[item.verdict]);
      persistKeyVerdicts();
      renderKeyJudgeCard();
      scheduleOverlayRender(KEYVOL_OVERLAY);
    }
  } catch {
    showToast("Chưa đọc được playbook JSON trên máy chủ; đang dùng dữ liệu local.");
  }
}

function persistPlaybookJson({ successMessage = "" } = {}) {
  const symbol = state.symbol;
  const body = JSON.stringify({
    symbol,
    sampleOrders: ordersForPlaybookFile(),
    userFeedback: state.userFeedback,
    keyVerdicts: state.keyVerdicts,
  });
  const save = async () => {
    try {
      const response = await fetch("/api/playbook", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (successMessage && symbol === state.symbol) {
        showToast(`${successMessage} · ${payload.file}`);
      }
      return true;
    } catch {
      if (symbol === state.symbol) showToast("Đã giữ dữ liệu local nhưng chưa ghi được file JSON.");
      return false;
    }
  };
  state.playbookSaveQueue = state.playbookSaveQueue.then(save, save);
  return state.playbookSaveQueue;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  const digits = value >= 1000 ? 1 : value >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function dateTimeParts(milliseconds) {
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(
    CHART_DATE_TIME_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function chartTimeToMilliseconds(time) {
  if (typeof time === "number" && Number.isFinite(time)) return time * 1000;
  if (time && typeof time === "object") {
    return Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day));
  }
  if (typeof time === "string") {
    const businessDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time);
    if (businessDay) return Date.UTC(Number(businessDay[1]), Number(businessDay[2]) - 1, Number(businessDay[3]));
    return Date.parse(time);
  }
  return NaN;
}

function formatChartTickMark(time, tickMarkType) {
  const parts = dateTimeParts(chartTimeToMilliseconds(time));
  if (!parts) return null;
  if (tickMarkType === CHART_TICK_MARK.Year) return parts.year;
  if (tickMarkType === CHART_TICK_MARK.Month) return `${parts.month}-${parts.year.slice(-2)}`;
  if (tickMarkType === CHART_TICK_MARK.DayOfMonth) return `${parts.day}-${parts.month}`;
  if (tickMarkType === CHART_TICK_MARK.TimeWithSeconds) return `${parts.hour}:${parts.minute}:${parts.second}`;
  return `${parts.hour}:${parts.minute}`;
}

function formatChartCrosshairTime(time) {
  const parts = dateTimeParts(chartTimeToMilliseconds(time));
  return parts ? `${parts.day}-${parts.month} ${parts.hour}:${parts.minute}` : "—";
}

function formatInputPrice(value) {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(value >= 1000 ? 1 : value >= 1 ? 2 : 4);
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toString();
}

function formatR(value, includePlus = true) {
  if (!Number.isFinite(value)) return "—";
  const prefix = includePlus && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}R`;
}

function roundPrice(value) {
  if (!Number.isFinite(value)) return value;
  const step = value >= 1000 ? 0.1 : value >= 1 ? 0.01 : 0.0001;
  return Math.round(value / step) * step;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  state.toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 2600);
}

function baseAsset(symbol = state.symbol) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function defaultMarketMeta() {
  return { venue: "BINANCE", sourceLabel: "Binance Futures · 15m", instrumentType: "PERP", volumeUnit: "USDT" };
}

function marketVolumeUnit() {
  return state.marketMeta.volumeUnit === "ticks" ? "ticks" : "USDT";
}

function methodLabel(methods) {
  if (methods.includes("turtle") && methods.includes("fast")) return "Turtle + Fast";
  if (methods.includes("turtle")) return "Turtle";
  if (methods.includes("fast")) return "Fast";
  return "Ngoài rổ bot";
}

function methodsForSymbol(symbol = state.symbol) {
  return state.botUniverse.find((item) => item.symbol === symbol)?.strategies || state.activeMethods;
}

function setSymbolMark(node, meta) {
  if (!node) return;
  node.textContent = meta.mark;
  node.classList.remove("is-btc", "is-xau");
  if (meta.markClass) node.classList.add(meta.markClass);
}

function updateInstrumentUi() {
  const base = baseAsset();
  const meta = COIN_META[base] || { name: base, mark: base.slice(0, 1) };
  const methods = methodsForSymbol();
  const inBotUniverse = methods.length > 0;
  dom.coinAvatar.textContent = meta.mark;
  setSymbolMark(dom.symbolButtonMark, meta);
  setSymbolMark(dom.legendMark, meta);
  dom.symbolButtonLabel.textContent = state.symbol;
  dom.instrumentType.textContent = state.marketMeta.instrumentType;
  dom.instrumentVenue.textContent = state.marketMeta.venue;
  dom.instrumentSymbol.textContent = state.symbol;
  dom.instrumentDescription.textContent = `${meta.name} / TetherUS · USDⓈ-M Futures`;
  dom.legendSymbol.textContent = `${meta.name} / TetherUS · 15 · Binance`;
  dom.strategyAuditTitle.textContent = `Lệnh ${methodLabel(methods)} trên ${state.symbol}`;
  dom.strategyTableCaption.textContent = `Tất cả entry ${methodLabel(methods)} được replay trên ${state.symbol}`;
  dom.journalTitle.textContent = `Lệnh mẫu ${state.symbol} đã lưu`;
  dom.chart.setAttribute("aria-label", `Biểu đồ nến ${state.symbol} và volume Binance`);
  dom.symbolMethods.textContent = methodLabel(methods);
  dom.strategyAuditNote.innerHTML = inBotUniverse
    ? '<span aria-hidden="true">ⓘ</span> Đây là lệnh mô phỏng theo đúng rule production trên Binance Futures 4h, không phải lịch sử fill thật của tài khoản. Trên chart, vùng lợi nhuận của Turtle/Fast kéo tới mốc tham chiếu +2R để đọc vị thế; thực tế vẫn thoát bằng midpoint, Chandelier hoặc SL. “Đang mở” dùng giá nến mới nhất để tính MTM R.'
    : `<span aria-hidden="true">ⓘ</span> ${state.symbol} không thuộc rổ Turtle/Fast nên bảng này để trống; lệnh FX Dream nằm ở bảng bên phải và tab Key Volume.`;
  for (const option of dom.symbolOptions) {
    option.setAttribute("aria-current", String(option.dataset.symbol === state.symbol));
  }
  for (const row of dom.watchlistRows) {
    const active = row.dataset.symbol === state.symbol;
    row.classList.toggle("is-active", active);
    row.setAttribute("aria-pressed", String(active));
  }
  document.title = `${state.symbol} · Market Playbook`;
}

function syncBotUniverse(rawUniverse) {
  const universe = Array.isArray(rawUniverse)
    ? rawUniverse
      .map((item) => ({
        symbol: String(item?.symbol || "").toUpperCase(),
        venue: String(item?.venue || "BINANCE").toUpperCase(),
        strategies: Array.isArray(item?.strategies)
          ? item.strategies.filter((method) => ["turtle", "fast"].includes(method))
          : [],
      }))
      .filter((item) => SUPPORTED_SYMBOLS.includes(item.symbol))
    : [];
  if (!universe.length) return;
  state.botUniverse = universe;
  updateInstrumentUi();
}

function setSourceState(source, detail) {
  dom.sourceState.dataset.state = source;
  if (source === "live") {
    dom.sourceLabel.textContent = "Đã đồng bộ";
    dom.sourceDetail.textContent = detail || "Binance Futures";
  } else if (source === "demo") {
    dom.sourceLabel.textContent = "Dữ liệu xem trước";
    dom.sourceDetail.textContent = detail || "Chờ Binance Futures";
  } else if (source === "error") {
    dom.sourceLabel.textContent = "Chưa đồng bộ";
    dom.sourceDetail.textContent = detail || "Nguồn dữ liệu lỗi";
  } else {
    dom.sourceLabel.textContent = "Đang đồng bộ";
    dom.sourceDetail.textContent = detail || "Binance Futures";
  }
}

function generatePreviewCandles(count = 320) {
  const candles = [];
  const end = Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
  let previous = 117800;

  for (let index = 0; index < count; index += 1) {
    const wave = Math.sin(index / 10) * 135 + Math.sin(index / 31) * 280;
    const impulse = Math.sin(index * 1.73) * 86;
    const drift = index * 4.4;
    const open = previous;
    const close = 117800 + drift + wave + impulse;
    const spread = 95 + Math.abs(Math.sin(index * 0.81)) * 165;
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread * 0.82;
    const quoteVolume = 520e6 + Math.abs(close - open) * 1.1e6 + Math.abs(Math.sin(index / 7)) * 430e6;

    candles.push({
      t: end - (count - 1 - index) * FIFTEEN_MINUTES,
      o: open,
      h: high,
      l: low,
      c: close,
      q: quoteVolume,
      v: quoteVolume / close,
    });
    previous = close;
  }

  return candles;
}

function initChart() {
  if (!window.LightweightCharts) {
    dom.chartLoading.classList.add("is-visible");
    dom.chartLoading.lastElementChild.textContent = "Không tải được thư viện biểu đồ.";
    return false;
  }

  const { createChart, CrosshairMode, ColorType, LineStyle } = window.LightweightCharts;
  state.chart = createChart(dom.chart, {
    width: dom.chart.clientWidth,
    height: dom.chart.clientHeight,
    layout: {
      background: { type: ColorType.Solid, color: "#131722" },
      textColor: "#b2b5be",
      fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
      fontSize: 12,
    },
    grid: {
      vertLines: { color: "rgba(42, 46, 57, 0.6)", style: LineStyle.Solid },
      horzLines: { color: "rgba(42, 46, 57, 0.6)", style: LineStyle.Solid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "#758696", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#363a45" },
      horzLine: { color: "#758696", width: 1, style: LineStyle.LargeDashed, labelBackgroundColor: "#363a45" },
    },
    rightPriceScale: {
      borderColor: "#2a2e39",
      scaleMargins: { top: 0.07, bottom: 0.27 },
      entireTextOnly: true,
    },
    timeScale: {
      borderColor: "#2a2e39",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 10,
      barSpacing: 6,
      minBarSpacing: 0.5,
      tickMarkFormatter: formatChartTickMark,
    },
    ...CHART_NAVIGATION,
    kineticScroll: { mouse: false, touch: true },
    localization: {
      locale: "vi-VN",
      priceFormatter: formatPrice,
      timeFormatter: formatChartCrosshairTime,
    },
  });

  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: CANDLE_UP,
    downColor: CANDLE_DOWN,
    borderUpColor: CANDLE_UP,
    borderDownColor: CANDLE_DOWN,
    wickUpColor: CANDLE_UP,
    wickDownColor: CANDLE_DOWN,
    priceLineVisible: true,
    priceLineStyle: LineStyle.Dotted,
    lastValueVisible: true,
  });

  state.volumeSeries = state.chart.addHistogramSeries({
    priceScaleId: "volume",
    priceFormat: { type: "custom", formatter: formatVolume },
    priceLineVisible: false,
    lastValueVisible: false,
  });
  state.chart.priceScale("volume").applyOptions({ borderVisible: false });

  state.rsiSeries = state.chart.addLineSeries({
    priceScaleId: "rsi",
    color: "#7e57c2",
    lineWidth: 1,
    priceFormat: { type: "custom", formatter: (value) => value.toFixed(1), minMove: 0.1 },
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  state.chart.priceScale("rsi").applyOptions({ borderVisible: false });
  for (const price of [70, 30]) {
    state.rsiSeries.createPriceLine({
      price,
      color: "rgba(120, 123, 134, 0.6)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });
  }
  applyRsiLayout();

  state.chart.subscribeCrosshairMove((param) => {
    const candle = param.seriesData.get(state.candleSeries);
    const volume = param.seriesData.get(state.volumeSeries);
    const rsi = param.seriesData.get(state.rsiSeries);
    if (candle && "open" in candle) updateLegend(candle, volume?.value, rsi?.value);
    else updateLegend(state.candles.at(-1));
  });

  state.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    scheduleOverlayRender();
    updateRealtimeButton();
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!state.chart) return;
    state.chart.applyOptions({ width: dom.chart.clientWidth, height: dom.chart.clientHeight });
    scheduleOverlayRender();
  });
  resizeObserver.observe(dom.chartWrap);

  dom.chartWrap.addEventListener("wheel", () => scheduleOverlayRender(), { passive: true });
  // Kéo dọc chart hoặc kéo trục giá không đổi khoảng thời gian, nên không có sự kiện
  // nào của thư viện báo — vẽ lại lớp phủ theo chính con trỏ đang giữ chuột.
  dom.chartWrap.addEventListener("pointermove", (event) => {
    if (event.buttons) scheduleOverlayRender();
  });
  dom.chartWrap.addEventListener("pointerup", () => {
    scheduleOverlayRender();
    syncScaleButtons();
  });
  dom.chartWrap.addEventListener("dblclick", () => {
    window.requestAnimationFrame(() => {
      scheduleOverlayRender();
      syncScaleButtons();
    });
  });
  return true;
}

function priceAxisWidth() {
  return state.chart?.priceScale("right").width() || 61;
}

/* ── Điều hướng chart kiểu TradingView ──────────────────────────────────── */

function zoomChart(factor) {
  const timeScale = state.chart?.timeScale();
  const range = timeScale?.getVisibleLogicalRange();
  if (!range) return;
  // Neo mép phải như TradingView: nến mới nhất đứng yên, phóng/thu về phía quá khứ.
  const span = Math.max(10, (range.to - range.from) * factor);
  timeScale.setVisibleLogicalRange({ from: range.to - span, to: range.to });
}

function panChart(direction) {
  const timeScale = state.chart?.timeScale();
  const range = timeScale?.getVisibleLogicalRange();
  if (!range) return;
  const shift = (range.to - range.from) * 0.2 * direction;
  timeScale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
}

function resetChartView() {
  if (!state.chart) return;
  state.chart.priceScale("right").applyOptions({ autoScale: true });
  const from = Math.max(0, state.candles.length - 185);
  state.chart.timeScale().setVisibleLogicalRange({ from, to: state.candles.length + 8 });
  syncScaleButtons();
  scheduleOverlayRender();
}

function handleChartNav(action) {
  if (action === "zoom-in") zoomChart(0.8);
  else if (action === "zoom-out") zoomChart(1.25);
  else if (action === "left") panChart(-1);
  else if (action === "right") panChart(1);
}

function updateRealtimeButton() {
  const range = state.chart?.timeScale().getVisibleLogicalRange();
  dom.chartRealtime.hidden = !range || !state.candles.length || range.to >= state.candles.length - 1;
}

function syncScaleButtons() {
  if (!state.chart) return;
  const { autoScale, mode } = state.chart.priceScale("right").options();
  const { PriceScaleMode } = window.LightweightCharts;
  const flags = [
    [dom.scaleAuto, autoScale],
    [dom.scaleLog, mode === PriceScaleMode.Logarithmic],
    [dom.scalePercent, mode === PriceScaleMode.Percentage],
  ];
  for (const [button, on] of flags) {
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

function togglePriceScaleMode(target) {
  const { PriceScaleMode } = window.LightweightCharts;
  const scale = state.chart?.priceScale("right");
  if (!scale) return;
  const wanted = target === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Percentage;
  scale.applyOptions({ mode: scale.options().mode === wanted ? PriceScaleMode.Normal : wanted });
  syncScaleButtons();
  scheduleOverlayRender();
}

function toggleAutoScale() {
  const scale = state.chart?.priceScale("right");
  if (!scale) return;
  scale.applyOptions({ autoScale: !scale.options().autoScale });
  syncScaleButtons();
  scheduleOverlayRender();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => showToast("Trình duyệt không cho phép toàn màn hình."));
}

function tickChartClock() {
  dom.chartClock.textContent = CHART_CLOCK_FORMATTER.format(new Date());
}

/* ── Chọn mã, danh sách theo dõi, bảng bên phải ──────────────────────────── */

function setSymbolMenuOpen(open) {
  state.symbolMenuOpen = open;
  dom.symbolMenu.hidden = !open;
  dom.symbolButton.setAttribute("aria-expanded", String(open));
  if (!open) return;
  dom.symbolSearch.value = "";
  filterSymbolOptions();
  dom.symbolSearch.focus();
}

function filterSymbolOptions() {
  const query = dom.symbolSearch.value.trim().toLowerCase();
  let shown = 0;
  for (const option of dom.symbolOptions) {
    const match = !query || option.dataset.search.includes(query);
    option.hidden = !match;
    if (match) shown += 1;
  }
  dom.symbolMenuEmpty.hidden = shown > 0;
}

function pickSymbol(symbol) {
  setSymbolMenuOpen(false);
  changeSymbol(symbol);
}

function setSideView(view) {
  if (!dom.sidePanels.some((panel) => panel.dataset.sidePanel === view)) return;
  state.sideView = view;
  for (const panel of dom.sidePanels) panel.hidden = panel.dataset.sidePanel !== view;
  for (const button of dom.sideViewButtons) {
    const active = button.dataset.sideView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function formatSignedPrice(value) {
  return `${value >= 0 ? "+" : "−"}${formatPrice(Math.abs(value))}`;
}

function renderWatchlist() {
  for (const row of dom.watchlistRows) {
    const ticker = state.tickers.get(row.dataset.symbol);
    if (!ticker) continue;
    const up = ticker.change >= 0;
    row.querySelector('[data-field="last"]').textContent = formatPrice(ticker.last);
    for (const field of ["change", "pct"]) {
      const cell = row.querySelector(`[data-field="${field}"]`);
      cell.textContent = field === "change"
        ? formatSignedPrice(ticker.change)
        : `${up ? "+" : "−"}${Math.abs(ticker.changePct).toFixed(2)}%`;
      cell.classList.toggle("is-positive", up);
      cell.classList.toggle("is-negative", !up);
    }
  }
}

async function loadTickers() {
  try {
    const response = await fetch("/api/tickers", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const payload = await response.json();
    for (const ticker of payload.tickers || []) {
      if (SUPPORTED_SYMBOLS.includes(ticker.symbol) && Number.isFinite(ticker.last)) state.tickers.set(ticker.symbol, ticker);
    }
    renderWatchlist();
  } catch {
    // Danh sách theo dõi chỉ là phần phụ: lỗi mạng thì giữ số cũ, lần sau thử lại.
  }
}

function normalizeCandles(rawCandles) {
  return rawCandles
    .map((candle) => ({
      t: Number(candle.t),
      o: Number(candle.o),
      h: Number(candle.h),
      l: Number(candle.l),
      c: Number(candle.c),
      v: Number(candle.v || 0),
      q: Number(candle.q || Number(candle.v || 0) * Number(candle.c)),
    }))
    .filter((candle) => [candle.t, candle.o, candle.h, candle.l, candle.c, candle.q].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
}

function setChartData(rawCandles, source) {
  if (!state.candleSeries || !state.volumeSeries) return;
  const candles = normalizeCandles(rawCandles);
  if (!candles.length) return;

  state.candles = candles;
  state.candleIndexByTime = new Map(candles.map((candle, index) => [Math.floor(candle.t / 1000), index]));
  state.volumeByTime.clear();
  const candleData = candles.map((candle) => ({
    time: Math.floor(candle.t / 1000),
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
  }));
  const volumeData = candles.map((candle) => {
    const point = {
      time: Math.floor(candle.t / 1000),
      value: candle.q,
      color: candle.c >= candle.o ? "rgba(8, 153, 129, 0.5)" : "rgba(242, 54, 69, 0.5)",
    };
    state.volumeByTime.set(point.time, point.value);
    return point;
  });

  const rsi = rsiSeries(candles, RSI_PERIOD);
  state.rsiByTime.clear();
  const rsiData = [];
  candles.forEach((candle, i) => {
    if (!Number.isFinite(rsi[i])) return;
    const time = Math.floor(candle.t / 1000);
    state.rsiByTime.set(time, rsi[i]);
    rsiData.push({ time, value: rsi[i] });
  });

  state.candleSeries.setData(candleData);
  state.volumeSeries.setData(volumeData);
  state.rsiSeries?.setData(rsiData);
  updateMarketTape();
  updateLegend(candles.at(-1));

  if (!state.plansInitialized) {
    state.plansInitialized = true;
  }
  if (source === "live") {
    let recentered = false;
    for (const plan of state.plans) {
      if (!plan.auto) continue;
      placePlanAroundMarket(plan);
      plan.auto = false;
      recentered = true;
    }
    if (recentered) persistDraftPlans();
  }
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();

  const from = Math.max(0, candles.length - 185);
  state.chart.timeScale().setVisibleLogicalRange({ from, to: candles.length + 8 });
  updateRealtimeButton();
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => scheduleOverlayRender()));

  if (source === "live") setSourceState("live", state.marketMeta.sourceLabel);
}

function visibleStrategyTrades() {
  if (state.strategyFilter === "all") return state.strategyTrades;
  return state.strategyTrades.filter((trade) => trade.strategy === state.strategyFilter);
}

function strategyTradesForChart() {
  const trades = visibleStrategyTrades();
  if (state.chartView === "clean") return [];
  if (state.chartView !== "selected") return trades;
  if (!state.selectedOverlayId?.startsWith("strategy:")) return [];
  const selectedId = state.selectedOverlayId.slice("strategy:".length);
  return trades.filter((trade) => trade.id === selectedId);
}

function setStrategyEmpty(title, detail, loading = false) {
  const mark = dom.strategyEmpty.querySelector(".loading-mark");
  mark.hidden = !loading;
  dom.strategyEmpty.querySelector("strong").textContent = title;
  dom.strategyEmpty.querySelector("p").textContent = detail;
  dom.strategyEmpty.hidden = false;
}

function feedbackKey(trade) {
  return `${trade.strategy}:${trade.symbol}:${trade.entryTime}:${trade.unit}`;
}

function userFeedbackForTrade(trade) {
  const key = feedbackKey(trade);
  return state.userFeedback.find((item) => item.key === key || item.tradeId === trade.id) || null;
}

function openUserFeedback(trade) {
  const feedback = userFeedbackForTrade(trade);
  dom.feedbackTradeId.value = trade.id;
  dom.feedbackTradeSummary.textContent = `${trade.strategy.toUpperCase()} · ${trade.symbol} · ${trade.dir.toUpperCase()} · Entry ${formatPrice(Number(trade.entryPrice))} · ${formatOrderTime(trade.entryTime)}`;
  dom.feedbackNote.value = feedback?.note || "";
  const verdict = feedback?.verdict || "review";
  for (const radio of dom.feedbackForm.elements.verdict) radio.checked = radio.value === verdict;
  dom.feedbackDelete.hidden = !feedback;
  dom.feedbackDialog.showModal();
  window.requestAnimationFrame(() => dom.feedbackForm.querySelector(`input[name="verdict"][value="${verdict}"]`)?.focus());
}

function closeUserFeedback() {
  if (dom.feedbackDialog.open) dom.feedbackDialog.close();
}

function saveUserFeedback(event) {
  event.preventDefault();
  const trade = state.strategyTrades.find((candidate) => candidate.id === dom.feedbackTradeId.value);
  const verdict = new FormData(dom.feedbackForm).get("verdict");
  if (!trade || !["approved", "review", "rejected"].includes(verdict)) return;
  const record = {
    key: feedbackKey(trade),
    tradeId: trade.id,
    symbol: state.symbol,
    verdict,
    note: dom.feedbackNote.value.trim(),
    updatedAt: new Date().toISOString(),
    trade: { ...trade },
  };
  const index = state.userFeedback.findIndex((item) => item.key === record.key || item.tradeId === trade.id);
  if (index >= 0) state.userFeedback[index] = record;
  else state.userFeedback.unshift(record);
  persistUserFeedback();
  closeUserFeedback();
  renderStrategyAudit();
  persistPlaybookJson({ successMessage: `Đã lưu góp ý của người dùng ${FEEDBACK_LABELS[verdict]}` });
}

function deleteUserFeedback() {
  const trade = state.strategyTrades.find((candidate) => candidate.id === dom.feedbackTradeId.value);
  if (!trade) return;
  const key = feedbackKey(trade);
  state.userFeedback = state.userFeedback.filter((item) => item.key !== key && item.tradeId !== trade.id);
  persistUserFeedback();
  closeUserFeedback();
  renderStrategyAudit();
  persistPlaybookJson({ successMessage: "Đã xóa góp ý khỏi JSON" });
}

function setActiveMethods(methods) {
  state.activeMethods = methods;
  if (state.strategyFilter !== "all" && !methods.includes(state.strategyFilter)) {
    state.strategyFilter = "all";
  }
  for (const button of dom.strategyFilterButtons) {
    const method = button.dataset.strategyFilter;
    button.disabled = method !== "all" && !methods.includes(method);
    const active = method === state.strategyFilter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setStrategyAudit(audit) {
  state.strategyAuditLoaded = true;
  setActiveMethods(Array.isArray(audit?.methods)
    ? audit.methods.filter((method) => ["turtle", "fast"].includes(method))
    : ["turtle", "fast"]);
  state.strategyTrades = Array.isArray(audit?.trades) ? audit.trades : [];
  if (state.selectedOverlayId?.startsWith("strategy:") && !allReadOnlyPositions().some((position) => position.id === state.selectedOverlayId)) {
    state.selectedOverlayId = null;
    if (state.chartView === "selected") state.chartView = "clean";
  }
  dom.turtleConfig.textContent = audit?.turtleConfig || "Không đọc được cấu hình Turtle.";
  dom.fastConfig.textContent = audit?.fastConfig || "Không đọc được cấu hình Fast.";
  updateInstrumentUi();
  renderStrategyAudit();
}

function renderStrategyAudit() {
  const trades = visibleStrategyTrades();
  const openCount = trades.filter((trade) => trade.status === "open").length;
  const netR = trades.reduce((total, trade) => total + Number(trade.resultR || 0), 0);
  dom.auditTotal.textContent = String(trades.length);
  dom.auditOpen.textContent = String(openCount);
  dom.auditNetR.textContent = formatR(netR);
  dom.auditNetR.classList.toggle("is-positive", netR > 0);
  dom.auditNetR.classList.toggle("is-negative", netR < 0);

  if (!trades.length) {
    dom.strategyBody.innerHTML = "";
    const outsideBot = state.activeMethods.length === 0;
    const label = state.strategyFilter === "all" ? "Turtle/Fast" : state.strategyFilter === "turtle" ? "Turtle" : "Fast";
    setStrategyEmpty(
      outsideBot ? `${state.symbol} không thuộc rổ bot Turtle/Fast`
        : state.strategyAuditLoaded ? `Không có lệnh ${label} trong khoảng này` : "Đang replay Turtle và Fast…",
      state.strategyAuditLoaded
        ? outsideBot
          ? "Chart vẫn hỗ trợ đầy đủ lệnh mẫu, Entry/SL/TP, hình vẽ và lưu JSON."
          : "Thử tải khoảng dữ liệu dài hơn hoặc chọn phương pháp khác."
        : "Chỉ tính từ nến 4h đã đóng; không khởi động bot và không gửi lệnh.",
      !state.strategyAuditLoaded && !outsideBot,
    );
  } else {
    dom.strategyEmpty.hidden = true;
    dom.strategyBody.innerHTML = trades
      .map((trade) => {
        const strategyLabel = trade.strategy === "turtle" ? "TURTLE" : "FAST";
        const badgeClass = trade.strategy === "turtle" ? "turtle-badge" : "fast-badge";
        const sideLabel = trade.dir === "long" ? "LONG" : "SHORT";
        const exitPrice = trade.exitPrice === null ? "Giá hiện tại" : formatPrice(Number(trade.exitPrice));
        const statusClass = trade.status === "open" ? "open-status" : "closed-status";
        const statusLabel = trade.status === "open" ? "● Đang mở · MTM" : `Đã đóng · ${escapeHtml(trade.exitReason || "exit")}`;
        const feedback = userFeedbackForTrade(trade);
        const feedbackSummary = feedback
          ? `${FEEDBACK_LABELS[feedback.verdict]}${feedback.note ? ` · ${feedback.note}` : ""}`
          : "";
        return `
          <tr data-audit-id="${escapeHtml(trade.id)}" class="${state.selectedOverlayId === `strategy:${trade.id}` ? "is-chart-active" : ""}">
            <td>${formatOrderTime(trade.entryTime)}</td>
            <td>
              <span class="strategy-badge ${badgeClass}">${strategyLabel}</span>
              <span class="audit-strategy-name">Position #${trade.positionId}</span>
            </td>
            <td class="audit-order-cell">
              <span class="side-pill ${trade.dir}">${sideLabel}</span>
              <small>Unit ${trade.unit}</small>
            </td>
            <td class="audit-price-stack">
              <strong>${formatPrice(Number(trade.entryPrice))}</strong>
              <span>SL ${formatPrice(Number(trade.initialSL))}</span>
            </td>
            <td class="audit-result">
              <strong class="${Number(trade.resultR) >= 0 ? "is-positive" : "is-negative"}">${formatR(Number(trade.resultR))}</strong>
              <span>${exitPrice}</span>
              <span class="${statusClass}">${statusLabel}</span>
            </td>
            <td class="audit-reason">
              <strong>${escapeHtml(trade.entryReason)}</strong>
              <span>Thoát: ${escapeHtml(trade.exitReasonLabel)}</span>
              ${feedback ? `<span class="audit-feedback-summary" title="${escapeHtml(feedbackSummary)}">${escapeHtml(feedbackSummary)}</span>` : ""}
            </td>
            <td>
              <div class="audit-row-actions">
                <button class="audit-focus-button" type="button" data-audit-action="focus">Xem riêng</button>
                <button class="audit-focus-button audit-feedback-button${feedback ? " has-feedback" : ""}" type="button" data-audit-action="feedback">${feedback ? "Sửa góp ý" : "Góp ý"}</button>
              </div>
            </td>
          </tr>`;
      })
      .join("");
  }
  renderStrategyMarkers();
  renderStrategyContexts();
  renderPlanTools();
  renderDrawings();
  updateChartViewControls();
}

function renderStrategyMarkers() {
  if (!state.candleSeries) return;
  const firstTime = state.candles[0]?.t ?? -Infinity;
  const lastTime = state.candles.at(-1)?.t ?? Infinity;
  const markers = [];
  for (const trade of strategyTradesForChart()) {
    // Trên chart chỉ đọc số R: điểm vào là mũi tên trơn (màu = Turtle/Fast), điểm thoát ghi R.
    const color = trade.strategy === "turtle" ? "#f3ba63" : "#a98bff";
    if (trade.entryTime >= firstTime && trade.entryTime <= lastTime) {
      markers.push({
        time: Math.floor(trade.entryTime / 1000),
        position: trade.dir === "long" ? "belowBar" : "aboveBar",
        color,
        shape: trade.dir === "long" ? "arrowUp" : "arrowDown",
      });
    }
    if (trade.exitTime && trade.exitTime >= firstTime && trade.exitTime <= lastTime) {
      markers.push({
        time: Math.floor(trade.exitTime / 1000),
        position: trade.dir === "long" ? "aboveBar" : "belowBar",
        color,
        shape: "circle",
        text: formatR(Number(trade.resultR)),
      });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  state.candleSeries.setMarkers(markers);
}

function renderStrategyContexts() {
  const layer = dom.strategyContextLayer;
  if (!layer || !state.chart || !state.candleSeries || !state.candles.length) {
    if (layer) layer.innerHTML = "";
    return;
  }

  const width = dom.chartWrap.clientWidth;
  const height = dom.chartWrap.clientHeight;
  const plotRight = Math.max(80, width - priceAxisWidth());
  const plotBottom = height * 0.77;
  layer.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const candidates = strategyTradesForChart()
    .filter((trade) => trade.chartContext && Number.isFinite(Number(trade.chartContext.level)))
    .sort((a, b) => {
      const aSelected = state.selectedOverlayId === `strategy:${a.id}` ? 1 : 0;
      const bSelected = state.selectedOverlayId === `strategy:${b.id}` ? 1 : 0;
      return bSelected - aSelected || a.entryTime - b.entryTime;
    });
  const occupiedLabels = [];
  const groups = [];

  for (const trade of candidates) {
    const context = trade.chartContext;
    const rawX1 = state.chart.timeScale().timeToCoordinate(Math.floor(Number(context.startTime) / 1000));
    const rawX2 = state.chart.timeScale().timeToCoordinate(Math.floor(Number(context.endTime) / 1000));
    const levelY = state.candleSeries.priceToCoordinate(Number(context.level));
    const entryY = state.candleSeries.priceToCoordinate(Number(trade.entryPrice));
    if (![rawX1, rawX2, levelY, entryY].every(Number.isFinite)) continue;
    if (rawX2 < 0 || rawX1 > plotRight || levelY < -20 || levelY > plotBottom + 20) continue;

    const x1 = Math.max(0, Math.min(plotRight, rawX1));
    const x2 = Math.max(0, Math.min(plotRight, rawX2));
    if (x2 - x1 < 3) continue;
    const zoneTop = Math.max(0, Math.min(levelY, entryY) - 2);
    const zoneBottom = Math.min(plotBottom, Math.max(levelY, entryY) + 2);
    const zoneHeight = Math.max(4, zoneBottom - zoneTop);
    const selected = state.selectedOverlayId === `strategy:${trade.id}`;
    const tagWidth = Math.min(78, Math.max(48, context.label.length * 4.6 + 9));
    const tagHeight = 14;
    const tagX = Math.max(2, Math.min(plotRight - tagWidth - 2, x2 - tagWidth));
    const tagY = Math.max(2, Math.min(plotBottom - tagHeight - 2, levelY - tagHeight - 4));
    const tagBox = { left: tagX, right: tagX + tagWidth, top: tagY, bottom: tagY + tagHeight };
    const labelCollides = occupiedLabels.some((box) =>
      tagBox.left < box.right + 4 && tagBox.right + 4 > box.left && tagBox.top < box.bottom + 3 && tagBox.bottom + 3 > box.top,
    );
    const showLabel = selected || !labelCollides;
    if (showLabel) occupiedLabels.push(tagBox);

    groups.push(`
      <g class="strategy-context source-${trade.strategy} kind-${context.kind}${selected ? " is-selected" : ""}">
        <title>${escapeHtml(context.detail)}</title>
        <rect class="strategy-context-window" x="${x1.toFixed(1)}" y="${zoneTop.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${zoneHeight.toFixed(1)}"></rect>
        <line class="strategy-context-line" x1="${x1.toFixed(1)}" y1="${levelY.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${levelY.toFixed(1)}"></line>
        <line class="strategy-context-line" x1="${x2.toFixed(1)}" y1="${(levelY - 3).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${(levelY + 3).toFixed(1)}"></line>
        ${showLabel ? `<rect class="strategy-context-tag" x="${tagX.toFixed(1)}" y="${tagY.toFixed(1)}" width="${tagWidth.toFixed(1)}" height="${tagHeight}" rx="3" ry="3"></rect><text class="strategy-context-tag-text" x="${(tagX + 5).toFixed(1)}" y="${(tagY + 9.5).toFixed(1)}">${escapeHtml(context.label)}</text>` : ""}
      </g>`);
  }
  layer.innerHTML = groups.join("");
}

/* ── Key Volume: lớp key trên chart + bảng lệnh + phễu ───────────────────── */

function chartPlotBox() {
  const width = dom.chartWrap.clientWidth;
  const height = dom.chartWrap.clientHeight;
  return { width, height, right: Math.max(80, width - priceAxisWidth()), bottom: height * 0.77 };
}

/**
 * Mốc thời gian của key có thể rơi ngoài cửa sổ chart đang vẽ, khi đó
 * timeToCoordinate trả null. Nắn về nến gần nhất và kẹp vào hai đầu dữ liệu để
 * vùng key vẫn kéo ra tới mép phải.
 */
function snapChartTime(milliseconds) {
  const candles = state.candles;
  if (!candles.length) return null;
  const first = candles[0].t;
  const last = candles[candles.length - 1].t;
  const clamped = Math.max(first, Math.min(last, Number(milliseconds)));
  return candles[Math.round(candleLogicalAt(clamped))].t;
}

/**
 * Vị trí nến (logical, có phần lẻ) của một mốc thời gian, tìm theo thời gian THẬT chứ
 * không chia cho 15 phút: XAUUSDT bỏ nến cuối tuần nên chuỗi nến có khoảng trống.
 * Ngoài hai đầu dữ liệu thì ngoại suy theo bước nến.
 */
function candleLogicalAt(milliseconds) {
  const candles = state.candles;
  const interval = candleIntervalMs();
  const last = candles.length - 1;
  if (milliseconds <= candles[0].t) return (milliseconds - candles[0].t) / interval;
  if (milliseconds >= candles[last].t) return last + (milliseconds - candles[last].t) / interval;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= milliseconds) lo = mid;
    else hi = mid;
  }
  return lo + Math.min(1, (milliseconds - candles[lo].t) / interval);
}

/** Ngược lại của candleLogicalAt. */
function candleTimeAtLogical(logical) {
  const candles = state.candles;
  const interval = candleIntervalMs();
  const last = candles.length - 1;
  if (logical <= 0) return candles[0].t + logical * interval;
  if (logical >= last) return candles[last].t + (logical - last) * interval;
  const index = Math.floor(logical);
  return candles[index].t + (logical - index) * interval;
}

function geometryToPixels(geometry, plot) {
  if (!geometry || !state.chart || !state.candleSeries) return null;
  const scale = state.chart.timeScale();
  const startTime = snapChartTime(geometry.startTime);
  const endTime = snapChartTime(geometry.endTime);
  if (startTime == null || endTime == null) return null;
  const rawX1 = scale.timeToCoordinate(Math.floor(startTime / 1000));
  const rawX2 = scale.timeToCoordinate(Math.floor(endTime / 1000));
  const yA = state.candleSeries.priceToCoordinate(Number(geometry.priceA));
  const yB = geometry.priceB == null ? yA : state.candleSeries.priceToCoordinate(Number(geometry.priceB));
  if (![rawX1, rawX2, yA, yB].every(Number.isFinite)) return null;
  if (rawX2 < 0 || rawX1 > plot.right) return null;
  const top = Math.min(yA, yB);
  const bottom = Math.max(yA, yB);
  if (bottom < -40 || top > plot.bottom + 40) return null;
  return {
    x1: Math.max(0, Math.min(plot.right, rawX1)),
    x2: Math.max(0, Math.min(plot.right, rawX2)),
    yA,
    yB,
    top: Math.max(-20, top),
    bottom: Math.min(plot.bottom + 20, bottom),
  };
}

function visibleKeyLevels() {
  const kv = state.keyVolume;
  if (!kv || !state.keyvolFilters.enabled) return [];
  const filters = state.keyvolFilters;
  return kv.levels.filter((level) =>
    filters.tfs.has(level.sourceTf)
    && level.volumeRatio >= filters.minRatio
    && (!filters.unbrokenOnly || level.crossCount === 0));
}

function updateKeyVolumeCount(matched, drawn) {
  if (!dom.keyvolCount) return;
  if (!state.keyVolume) {
    dom.keyvolCount.textContent = "— key";
    return;
  }
  if (!state.keyvolFilters.enabled) {
    dom.keyvolCount.textContent = "lớp đang tắt";
    return;
  }
  const total = state.keyVolume.levels.length;
  dom.keyvolCount.textContent = drawn < matched
    ? `${drawn}/${matched} key (mạnh nhất) · ${total} tổng`
    : `${matched}/${total} key`;
}

function renderKeyVolumeLayer() {
  const layer = dom.keyvolLayer;
  if (!layer) return;
  if (!state.chart || !state.candleSeries || !state.candles.length) {
    layer.innerHTML = "";
    return;
  }
  const plot = chartPlotBox();
  layer.setAttribute("viewBox", `0 0 ${plot.width} ${plot.height}`);
  const matched = visibleKeyLevels();
  const drawn = matched.slice(0, KEYVOL_MAX_DRAWN);
  updateKeyVolumeCount(matched.length, drawn.length);

  // Key của lệnh đang chọn, key đang chấm và mọi key ĐÃ CHẤM NHÃN luôn được vẽ,
  // kể cả khi bộ lọc đang loại chúng.
  const activeKeyId = state.evidenceTrade?.keyId ?? null;
  const pinned = new Set([activeKeyId, state.selectedKeyId, ...state.keyVerdicts.map((item) => item.keyId)]);
  for (const keyId of pinned) {
    if (keyId == null || drawn.some((level) => level.id === keyId)) continue;
    const extra = state.keyVolume?.levels.find((level) => level.id === keyId);
    if (extra) drawn.push(extra);
  }
  const occupied = [];
  const groups = [];
  for (const level of drawn) {
    const box = geometryToPixels(
      { startTime: level.confirmedAt, endTime: level.endTime, priceA: level.zoneLow, priceB: level.zoneHigh },
      plot,
    );
    if (!box) continue;
    const width = Math.max(2, box.x2 - box.x1);
    const height = Math.max(1.5, box.bottom - box.top);
    const priceY = state.candleSeries.priceToCoordinate(Number(level.price));
    if (Number.isFinite(priceY) && (priceY < -10 || priceY > plot.bottom + 10)) continue;
    const selected = activeKeyId != null && level.id === activeKeyId;
    const picked = state.selectedKeyId === level.id;
    const verdict = keyVerdictFor(level.id)?.verdict ?? null;
    // Key càng đột biến càng đậm; chặn trên ×8 để một cây volume dị thường
    // không làm mọi key khác biến mất.
    const strength = Math.min(1, Math.max(0, (level.volumeRatio - 2) / 6));
    const mark = verdict === "untrusted" ? "✗ " : verdict === "trusted" ? "✓ " : "";
    const label = `${mark}${KEYVOL_TF_LABEL[level.sourceTf] || level.sourceTf} ×${level.volumeRatio} · ${formatPrice(level.price)}`;
    const tagWidth = Math.min(132, Math.max(58, label.length * 5.1 + 10));
    // Nhãn bám mép PHẢI (sát trục giá) để không bị thanh công cụ vẽ che.
    const tagX = Math.max(2, Math.min(plot.right - tagWidth - 3, box.x2 - tagWidth - 3));
    const anchorY = Number.isFinite(priceY) ? priceY : box.top;
    const tagY = Math.max(2, Math.min(plot.bottom - 13, anchorY - 12));
    const tagBox = { left: tagX, right: tagX + tagWidth, top: tagY, bottom: tagY + 11 };
    const collides = occupied.some((other) =>
      tagBox.left < other.right + 3 && tagBox.right + 3 > other.left
      && tagBox.top < other.bottom + 2 && tagBox.bottom + 2 > other.top);
    const showLabel = selected || picked || verdict != null || !collides;
    if (showLabel) occupied.push(tagBox);
    groups.push(`
      <g class="keyvol-level tf-${level.sourceTf.replace(".", "")}${selected ? " is-selected" : ""}${picked ? " is-picked" : ""}${verdict ? ` verdict-${verdict}` : ""}${level.crossCount === 0 ? " is-unbroken" : ""}" style="--keyvol-strength:${strength.toFixed(2)}">
        <title>${escapeHtml(`${KEYVOL_TF_LABEL[level.sourceTf]} · ${formatPrice(level.price)} · volume ×${level.volumeRatio} · ${level.ageDays} ngày tuổi · chạm ${level.touchCount} · đóng xuyên ${level.crossCount} lần`)}</title>
        <rect class="keyvol-zone" x="${box.x1.toFixed(1)}" y="${box.top.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}"></rect>
        ${Number.isFinite(priceY) ? `<line class="keyvol-price" x1="${box.x1.toFixed(1)}" y1="${priceY.toFixed(1)}" x2="${box.x2.toFixed(1)}" y2="${priceY.toFixed(1)}"></line>
        <rect class="keyvol-hit" data-key-id="${escapeHtml(level.id)}" x="${box.x1.toFixed(1)}" y="${(priceY - 7).toFixed(1)}" width="${width.toFixed(1)}" height="14"></rect>` : ""}
        ${showLabel ? `<rect class="keyvol-tag" data-key-id="${escapeHtml(level.id)}" x="${tagX.toFixed(1)}" y="${tagY.toFixed(1)}" width="${tagWidth.toFixed(1)}" height="11" rx="2.5" ry="2.5"></rect><text class="keyvol-tag-text" x="${(tagX + 4).toFixed(1)}" y="${(tagY + 8).toFixed(1)}">${escapeHtml(label)}</text>` : ""}
      </g>`);
  }
  layer.innerHTML = groups.join("");
}

/**
 * Dải phễu FX Dream. Khác bản cũ ở hai chỗ có thật:
 *  - thêm các cửa mà bản cũ bỏ lọt (hộp trang bị, giá quay lại, vỡ hộp, rời hộp,
 *    key ngoài thân hộp, chưa rời key) — đó mới là chỗ setup chết;
 *  - mỗi bậc kèm chip số setup CHẾT ở đúng cửa đó, bấm được để đọc giải thích.
 * Bề rộng bar theo thang log: 1.266 key và 3 lệnh không thể cùng nằm trên thang
 * tuyến tính mà vẫn thấy được bậc cuối.
 */
function renderKeyVolumeFunnel() {
  if (!dom.keyvolFunnel) return;
  const kv = state.keyVolume;
  if (!kv) {
    dom.keyvolFunnel.innerHTML = "";
    if (dom.keyvolFunnelDetail) dom.keyvolFunnelDetail.textContent = "Nhấp một bậc để xem setup chết ở cửa nào.";
    return;
  }
  const diagnostics = kv.diagnostics || {};
  const ctx = {
    keyBranchEntries: kv.entries.filter((entry) => FXDREAM_BRANCH_META[entry.branch]?.usesKey).length,
  };
  const values = FXDREAM_FUNNEL_STAGES.map((stage) => stage.value(diagnostics, ctx));
  const max = Math.max(1, ...values);
  const logMax = Math.log(max + 1);
  // Bậc rụng nhiều nhất là câu trả lời cho "setup chết ở cửa nào" — để mọi bậc
  // ngang nhau thì phải tự trừ bằng mắt.
  let worst = -1;
  let worstDrop = 0;
  for (let i = 1; i < values.length; i++) {
    const drop = values[i - 1] - values[i];
    if (drop > worstDrop) {
      worstDrop = drop;
      worst = i;
    }
  }
  dom.keyvolFunnel.innerHTML = FXDREAM_FUNNEL_STAGES
    .map((stage, index) => {
      const value = values[index];
      const share = Math.max(10, Math.round((Math.log(value + 1) / logMax) * 100));
      const leaks = stage.leaks(diagnostics, ctx)
        .map((leak) => `<i class="keyvol-leak${leak.warn ? " is-warn" : ""}">${escapeHtml(leak.text)}</i>`)
        .join("");
      return `
        <li class="keyvol-funnel-step${stage.final ? " is-final" : ""}${index === worst ? " is-worst" : ""}${index === state.funnelStage ? " is-active" : ""}" style="--keyvol-share:${share}%">
          <button type="button" data-funnel-stage="${index}" aria-pressed="${index === state.funnelStage}">
            <b>${fxCount(value)}</b>
            <span>${escapeHtml(stage.label)}</span>
            <em class="keyvol-scope${stage.scope === "both" ? " is-both" : ""}">${stage.scope === "both" ? "cả 2 nhánh" : "nhánh key"}</em>
            ${index === worst ? `<span class="keyvol-worst">rụng nhiều nhất · −${fxCount(worstDrop)}</span>` : ""}
          </button>
          <span class="keyvol-leaks">${leaks}</span>
        </li>`;
    })
    .join("");
  renderFunnelDetail(diagnostics, ctx);
}

function renderFunnelDetail(diagnostics, ctx) {
  if (!dom.keyvolFunnelDetail) return;
  const stage = FXDREAM_FUNNEL_STAGES[state.funnelStage] || FXDREAM_FUNNEL_STAGES.at(-1);
  dom.keyvolFunnelDetail.classList.toggle("is-final", !!stage.final);
  dom.keyvolFunnelDetail.textContent = stage.detail(diagnostics, ctx);
}

function setFunnelStage(index) {
  if (!Number.isInteger(index) || index < 0 || index >= FXDREAM_FUNNEL_STAGES.length) return;
  state.funnelStage = index;
  renderKeyVolumeFunnel();
}

/* ── Quản lý lớp vẽ trên chart ───────────────────────────────────────────── */

/** Năm lớp SVG thật trong DOM. Tắt lớp = ẩn đúng node đó, không có lớp giả. */
function chartLayerNode(key) {
  if (key === "position") return dom.orderLevels;
  if (key === "keys") return dom.keyvolLayer;
  if (key === "evidence") return dom.evidenceLayer;
  if (key === "context") return dom.strategyContextLayer;
  if (key === "draw") return dom.drawingLayer;
  return null;
}

/**
 * Lightweight Charts 4 không có pane riêng: nến, volume và RSI chia nhau một pane
 * theo scaleMargins. Tắt RSI thì trả chỗ lại cho nến như bố cục cũ.
 */
function applyRsiLayout() {
  if (!state.chart || !state.rsiSeries) return;
  const on = !!state.chartLayers.rsi;
  state.rsiSeries.applyOptions({ visible: on });
  state.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.07, bottom: on ? 0.42 : 0.27 } });
  state.chart.priceScale("volume").applyOptions({ scaleMargins: on ? { top: 0.6, bottom: 0.22 } : { top: 0.79, bottom: 0 } });
  state.chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.81, bottom: 0.02 } });
  if (dom.legendRsiWrap) dom.legendRsiWrap.style.display = on ? "" : "none";
}

/** RSI Wilder, cùng công thức với `rsiSeries` ở key-volume.ts. NaN ở `period` nến đầu. */
function rsiSeries(candles, period) {
  const out = new Array(candles.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].c - candles[i - 1].c;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i < period) continue;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    out[i] = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function applyChartLayers() {
  for (const def of CHART_LAYER_DEFS) {
    chartLayerNode(def.key)?.classList.toggle("is-layer-off", !state.chartLayers[def.key]);
  }
  const on = CHART_LAYER_DEFS.filter((def) => state.chartLayers[def.key]).length;
  if (dom.layerMenuCount) dom.layerMenuCount.textContent = `${on}/${CHART_LAYER_DEFS.length}`;
}

function renderLayerMenu() {
  if (!dom.layerMenuList) return;
  dom.layerMenuList.innerHTML = CHART_LAYER_DEFS
    .map((def) => {
      const on = !!state.chartLayers[def.key];
      return `
        <button class="layer-row${on ? " is-on" : ""}" type="button" data-chart-layer="${def.key}" aria-pressed="${on}">
          <span class="layer-switch" aria-hidden="true"><i></i></span>
          <span class="layer-text">
            <b>${escapeHtml(def.label)}</b>
            <small>${escapeHtml(def.hint)}</small>
          </span>
        </button>`;
    })
    .join("");
  applyChartLayers();
}

function toggleChartLayer(key) {
  if (!(key in state.chartLayers)) return;
  state.chartLayers[key] = !state.chartLayers[key];
  renderLayerMenu();
  if (key === "position") scheduleOverlayRender(ORDER_OVERLAY);
  if (key === "rsi") {
    applyRsiLayout();
    scheduleOverlayRender();
  }
}

function setLayerMenuOpen(open) {
  state.layerMenuOpen = open;
  if (dom.layerMenuList) dom.layerMenuList.hidden = !open;
  if (dom.layerMenuButton) {
    dom.layerMenuButton.classList.toggle("is-open", open);
    dom.layerMenuButton.setAttribute("aria-expanded", String(open));
  }
}

function handleFunnelClick(event) {
  const button = event.target.closest("[data-funnel-stage]");
  if (button) setFunnelStage(Number(button.dataset.funnelStage));
}

/**
 * Bốn thanh "chặng" thay cho một dải chấm. Một dãy 13 chấm không nói được setup
 * chết ở khâu nào; bốn thanh theo đúng bốn chặng thì nhìn là biết.
 * Lệnh Turtle/Fast không có `stages` nên trả về một thanh duy nhất.
 */
function evidenceSegments(entry) {
  const stages = Array.isArray(entry.stages) && entry.stages.length
    ? entry.stages
    : [{ title: "Điều kiện", items: entry.evidence || [] }];
  return stages.map((stage) => ({
    title: stage.title,
    bad: stage.items.some((item) => item.state === "fail"),
  }));
}

function evidenceSegmentsHtml(entry) {
  return evidenceSegments(entry)
    .map((seg) => `<i class="${seg.bad ? "is-fail" : "is-pass"}" title="${escapeHtml(seg.title)}"></i>`)
    .join("");
}

function renderKeyVolumeTable() {
  const kv = state.keyVolume;
  const entries = kv?.entries ?? [];
  const levels = kv?.levels ?? [];
  if (dom.keyvolTotal) dom.keyvolTotal.textContent = kv ? levels.length.toLocaleString("vi-VN") : "—";
  if (dom.keyvolUnbrokenCount) {
    dom.keyvolUnbrokenCount.textContent = kv
      ? levels.filter((level) => level.crossCount === 0).length.toLocaleString("vi-VN")
      : "—";
  }
  if (dom.keyvolEntryCount) dom.keyvolEntryCount.textContent = kv ? String(entries.length) : "—";
  if (dom.keyvolConfig) dom.keyvolConfig.textContent = kv?.configLine || "Chưa đọc được cấu hình Key Volume.";
  if (dom.keyvolRangeLabel && kv) dom.keyvolRangeLabel.textContent = `${kv.days} ngày`;
  if (dom.keyvolNoteText && kv?.note) dom.keyvolNoteText.textContent = kv.note;
  renderKeyVolumeFunnel();

  if (!dom.keyvolBody || !dom.keyvolEmpty) return;
  if (!entries.length) {
    dom.keyvolBody.innerHTML = "";
    dom.keyvolEmpty.hidden = false;
    const rejected = Number(kv?.diagnostics?.rejectedRoom || 0) + Number(kv?.diagnostics?.rejectedRisk || 0);
    dom.keyvolEmpty.innerHTML = kv
      ? `<div><strong>Không có lệnh Key Volume nào trong cửa sổ này</strong>
           <p>${kv.diagnostics.plans} kế hoạch đã hình thành nhưng ${rejected} bị loại ở khâu dư địa/rủi ro. Lớp key trên chart vẫn hoạt động.</p></div>`
      : `<span class="loading-mark" aria-hidden="true"></span>
         <div><strong>Đang replay Key Volume…</strong><p>Chỉ đọc; không khởi động bot và không gửi lệnh.</p></div>`;
    return;
  }
  dom.keyvolEmpty.hidden = true;
  dom.keyvolBody.innerHTML = entries
    .map((entry) => {
      const usesKey = !!FXDREAM_BRANCH_META[entry.branch]?.usesKey;
      const cue = usesKey && entry.keyPrice != null
        ? `key ${formatPrice(Number(entry.keyPrice))}`
        : `quét ${entry.dir === "long" ? "đáy" : "đỉnh"}`;
      return `
        <tr data-keyvol-id="${escapeHtml(entry.id)}" class="${state.evidenceTrade?.id === entry.id ? "is-chart-active" : ""}">
          <td>${formatOrderTime(entry.entryTime)}</td>
          <td class="audit-order-cell">
            <span class="side-pill ${entry.dir}">${entry.dir === "long" ? "LONG" : "SHORT"}</span>
          </td>
          <td class="keyvol-cue">
            <span class="branch-chip ${usesKey ? "is-key" : "is-sweep"}">${escapeHtml(FXDREAM_BRANCH_META[entry.branch]?.tag || entry.branch)}</span>
            <em>${escapeHtml(cue)}</em>
          </td>
          <td class="keyvol-levels">${formatPrice(Number(entry.entryPrice))} → ${formatPrice(Number(entry.initialSL))}</td>
          <td class="keyvol-exit">
            <i class="${entry.resultR >= 0 ? "is-win" : "is-loss"}"></i>${escapeHtml(entry.exitReasonLabel)}
          </td>
          <td class="keyvol-hold">${escapeHtml(fxdreamHoldLabel(entry))}</td>
          <td><span class="evidence-segs">${evidenceSegmentsHtml(entry)}</span></td>
          <td class="keyvol-result ${entry.resultR >= 0 ? "is-positive" : "is-negative"}">${escapeHtml(fxdreamResultText(entry))}</td>
        </tr>`;
    })
    .join("");
}

/* ── Cột lệnh FX Dream: đọc một lệnh trong hai giây ──────────────────────── */

/** Số phút một nến của engine — engine đã rút về M15, đừng hardcode 5 phút. */
function fxdreamBarMinutes() {
  const match = /^(\d+)([mh])$/.exec(state.keyVolume?.baseTf || "15m");
  if (!match) return 15;
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
}

/** R của lệnh; lệnh đang mở chỉ có R TẠM TÍNH theo giá đóng nến cuối, ghi "≈". */
function fxdreamResultText(entry) {
  return `${entry.status === "open" ? "≈ " : ""}${formatR(Number(entry.resultR))}`;
}

function fxdreamHoldLabel(entry) {
  const bars = Number(entry.holdBars || 0);
  if (bars === 0) return "thoát trong nến vào";
  const hours = (bars * fxdreamBarMinutes()) / 60;
  return `giữ ${bars} nến (${hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`})`;
}

function visibleFxdreamEntries() {
  const entries = state.keyVolume?.entries ?? [];
  if (state.fxdreamFilter === "key") return entries.filter((entry) => FXDREAM_BRANCH_META[entry.branch]?.usesKey);
  if (state.fxdreamFilter === "sweep") return entries.filter((entry) => !FXDREAM_BRANCH_META[entry.branch]?.usesKey);
  return entries;
}

/** Mẫu số R là khoảng cách entry→SL BAN ĐẦU, đúng như engine dùng. */
function fxdreamRisk(entry) {
  return Math.abs(Number(entry.entryPrice) - Number(entry.initialSL));
}

function fxdreamTargetR(entry) {
  const risk = fxdreamRisk(entry);
  return risk > 0 ? Math.abs(Number(entry.target) - Number(entry.entryPrice)) / risk : 0;
}

/**
 * R GROSS tại điểm thoát — vị trí hình học của chấm thoát trên thước.
 * Khác `resultR` (R của cả lệnh, gồm phần chốt sớm) và đó là chủ ý: thước nói hình học, chip nói kết quả.
 */
function fxdreamExitR(entry) {
  const risk = fxdreamRisk(entry);
  if (!(risk > 0)) return 0;
  const sign = entry.dir === "long" ? 1 : -1;
  return ((Number(entry.exitPrice) - Number(entry.entryPrice)) / risk) * sign;
}

/**
 * Thước R: SL ở −1R, entry ở 0, mục tiêu ở +targetR, chấm tròn ở chỗ lệnh THẬT SỰ
 * kết thúc. Trục là R chứ không phải giá, nên mọi lệnh của mọi mã nằm trên cùng
 * một thang và so được bằng mắt — đây là thứ thay cho bốn cột giá của bảng cũ.
 */
function fxdreamRulerSvg(entry) {
  const targetR = fxdreamTargetR(entry);
  const exitR = fxdreamExitR(entry);
  // Dư địa nhánh quét là cụm thanh khoản ĐỐI DIỆN nên có thể tới 80R. Vẽ đúng
  // tỉ lệ thì entry dồn hết về mép trái và thước thành vô dụng: nén phần vượt
  // trần về mép và vẽ dấu ngắt, còn con số trong nhãn vẫn là số thật.
  const clipped = targetR > FXDREAM_RULER_MAX_R;
  const visTarget = Math.min(targetR, FXDREAM_RULER_MAX_R);
  const visExit = Math.max(Math.min(exitR, FXDREAM_RULER_MAX_R), -1.2);
  const rMin = -1.35;
  const rMax = Math.max(visTarget, visExit) + 0.35;
  const span = rMax - rMin;
  const x = (r) => 8 + ((r - rMin) / (span || 1)) * 252;
  const win = Number(entry.resultR) >= 0;
  const breakMark = clipped
    ? `<text class="ruler-break" x="${(x(visTarget) - 5).toFixed(1)}" y="22" text-anchor="end">≫</text>`
    : "";
  return `
    <svg class="fxdream-ruler" viewBox="0 0 268 40" aria-hidden="true">
      <rect class="ruler-risk" x="${x(-1).toFixed(1)}" y="15" width="${(x(0) - x(-1)).toFixed(1)}" height="7" rx="1.5"></rect>
      <rect class="ruler-reward" x="${x(0).toFixed(1)}" y="15" width="${Math.max(0, x(visTarget) - x(0)).toFixed(1)}" height="7" rx="1.5"></rect>
      <line class="ruler-sl" x1="${x(-1).toFixed(1)}" y1="10" x2="${x(-1).toFixed(1)}" y2="27"></line>
      <line class="ruler-target" x1="${x(visTarget).toFixed(1)}" y1="10" x2="${x(visTarget).toFixed(1)}" y2="27"></line>
      <line class="ruler-entry" x1="${x(0).toFixed(1)}" y1="8" x2="${x(0).toFixed(1)}" y2="29"></line>
      <circle class="ruler-exit ${win ? "is-win" : "is-loss"}" cx="${x(visExit).toFixed(1)}" cy="18.5" r="4.2"></circle>
      ${breakMark}
      <text class="ruler-tag is-sl" x="${x(-1).toFixed(1)}" y="36">SL ${escapeHtml(formatPrice(Number(entry.initialSL)))}</text>
      <text class="ruler-tag is-entry" x="${x(0).toFixed(1)}" y="6" text-anchor="middle">${escapeHtml(formatPrice(Number(entry.entryPrice)))}</text>
      <text class="ruler-tag is-target" x="${x(visTarget).toFixed(1)}" y="36" text-anchor="end">${targetR.toFixed(2)}R ${escapeHtml(formatPrice(Number(entry.target)))}</text>
    </svg>`;
}

function fxdreamKeyLine(entry) {
  const meta = FXDREAM_BRANCH_META[entry.branch];
  if (!meta?.usesKey || entry.keyPrice == null) return "không dùng key ở bất kỳ khâu nào";
  const level = state.keyVolume?.levels.find((candidate) => candidate.id === entry.keyId);
  const ratio = level ? ` ×${level.volumeRatio}` : "";
  const age = level ? ` · ${level.ageDays} ngày tuổi` : "";
  return `key M15 ${formatPrice(Number(entry.keyPrice))}${ratio}${age}`;
}

function renderFxdreamCard(entry) {
  const meta = FXDREAM_BRANCH_META[entry.branch] || { tag: entry.branch, cls: "", usesKey: false };
  const selected = state.evidenceTrade?.id === entry.id;
  const win = Number(entry.resultR) >= 0;
  const segments = evidenceSegments(entry);
  const failedStage = segments.find((seg) => seg.bad);
  const segs = segments
    .map((seg) => `<i class="${seg.bad ? "is-fail" : "is-pass"}" title="${escapeHtml(seg.title)}"></i>`)
    .join("");
  return `
    <button class="fxdream-card is-${entry.dir} ${meta.cls}${entry.status === "open" ? " is-open" : ""}${selected ? " is-selected" : ""}" type="button" role="listitem" data-fxdream-id="${escapeHtml(entry.id)}" aria-pressed="${selected}">
      <span class="fxdream-card-top">
        <span class="fxdream-side">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="${entry.dir === "long" ? "M10 16V5m-4 4 4-4 4 4" : "M10 4v11m-4-4 4 4 4-4"}" /></svg>
          ${entry.dir === "long" ? "LONG" : "SHORT"}
        </span>
        <span class="fxdream-branch">${escapeHtml(meta.tag)}</span>
        <span class="fxdream-r ${win ? "is-win" : "is-loss"}">${escapeHtml(formatR(Number(entry.resultR)))}</span>
      </span>
      <span class="fxdream-when">${entry.status === "open" ? '<b class="fxdream-open">● ĐANG MỞ</b> · ' : ""}${escapeHtml(formatOrderTime(entry.entryTime))} · ${escapeHtml(fxdreamHoldLabel(entry))}</span>
      ${fxdreamRulerSvg(entry)}
      <span class="fxdream-key">${escapeHtml(fxdreamKeyLine(entry))}</span>
      <span class="fxdream-exit ${win ? "is-win" : "is-loss"}">${escapeHtml(entry.exitReasonLabel)}</span>
      <span class="fxdream-dots"><span class="evidence-segs">${segs}</span><em>${failedStage ? `hỏng ở ${escapeHtml(failedStage.title.toLowerCase())}` : "đủ bốn chặng"}</em></span>
    </button>`;
}

function renderFxdreamRail() {
  if (!dom.fxdreamCardList || !dom.fxdreamRailEmpty) return;
  const kv = state.keyVolume;
  const entries = visibleFxdreamEntries();
  if (dom.fxdreamCount) {
    dom.fxdreamCount.textContent = kv ? `${entries.length} lệnh · ${kv.days} ngày` : "— lệnh";
  }
  dom.fxdreamCardList.innerHTML = entries.map(renderFxdreamCard).join("");
  if (entries.length) {
    dom.fxdreamRailEmpty.hidden = true;
    return;
  }
  dom.fxdreamRailEmpty.hidden = false;
  if (!kv) {
    dom.fxdreamRailEmpty.innerHTML = '<span class="loading-mark" aria-hidden="true"></span>Đang replay Key Volume…';
    return;
  }
  const total = kv.entries.length;
  dom.fxdreamRailEmpty.innerHTML = total
    ? `Không có lệnh nào ở nhánh này. Bộ lọc đang ẩn ${total} lệnh — bấm <b>Tất cả</b> để xem lại.`
    : `Không lệnh nào đi hết phễu trong ${kv.days} ngày. Xem dải phễu dưới chart để biết setup chết ở cửa nào.`;
}

function setFxdreamFilter(filter) {
  if (!["all", "key", "sweep"].includes(filter)) return;
  state.fxdreamFilter = filter;
  for (const button of dom.fxdreamFilterButtons) {
    const active = button.dataset.fxdreamFilter === filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  // Lệnh đang soi mà bị bộ lọc ẩn đi thì phải nhả cả overlay lẫn thẻ bằng chứng,
  // nếu không chart giữ lại một vị thế không còn nằm trong danh sách nào.
  const stillVisible = visibleFxdreamEntries().some((entry) => entry.id === state.evidenceTrade?.id);
  if (state.evidenceTrade?.kind === "keyvol" && !stillVisible) {
    clearEvidence();
    if (state.selectedOverlayId?.startsWith("keyvol:")) {
      state.selectedOverlayId = null;
      if (state.chartView === "selected") state.chartView = "clean";
    }
  }
  renderFxdreamRail();
  renderPlanTools();
  scheduleOverlayRender();
}

function handleFxdreamRailClick(event) {
  const card = event.target.closest("[data-fxdream-id]");
  if (!card) return;
  const entry = state.keyVolume?.entries.find((candidate) => candidate.id === card.dataset.fxdreamId);
  if (entry) focusKeyVolumeEntry(entry);
}

function setKeyVolume(keyVolume) {
  state.keyVolume = keyVolume && Array.isArray(keyVolume.levels) ? keyVolume : null;
  if (state.evidenceTrade?.kind === "keyvol") clearEvidence();
  // Cửa sổ dữ liệu vừa đổi: vị thế keyvol cũ không còn tồn tại, phải nhả overlay
  // trước khi render lại, nếu không chart giữ một lệnh không còn trong danh sách.
  if (state.selectedOverlayId?.startsWith("keyvol:")) {
    state.selectedOverlayId = null;
    if (state.chartView === "selected") state.chartView = "clean";
  }
  const available = !!state.keyVolume;
  for (const button of [dom.keyvolPower, ...dom.keyvolTfButtons]) {
    if (button) button.disabled = !available;
  }
  if (dom.keyvolMinRatio) dom.keyvolMinRatio.disabled = !available;
  if (dom.keyvolUnbroken) dom.keyvolUnbroken.disabled = !available;
  renderKeyVolumeTable();
  renderFxdreamRail();
  renderKeyJudgeCard();
  renderPlanTools();
  scheduleOverlayRender(KEYVOL_OVERLAY | ORDER_OVERLAY);
}

function focusKeyVolumeEntry(entry) {
  const meta = FXDREAM_BRANCH_META[entry.branch] || { tag: entry.branch, usesKey: false };
  const risk = fxdreamRisk(entry);
  showEvidence({
    id: entry.id,
    kind: "keyvol",
    keyId: entry.keyId,
    when: `${formatOrderTime(entry.entryTime)} · M15`,
    verdict: entry.verdict || entry.summary,
    chain: entry.chain || [],
    stages: entry.stages || null,
    summary: entry.summary,
    evidence: entry.evidence,
    side: entry.dir,
    branchTag: meta.tag,
    usesKey: meta.usesKey,
    // Lệnh đang mở: thẻ bằng chứng ghi "đang mở", R tạm tính nằm ở chặng Kết thúc.
    resultR: entry.status === "open" ? null : Number(entry.resultR),
    riskPct: risk > 0 ? (risk / Number(entry.entryPrice)) * 100 : null,
    targetR: fxdreamTargetR(entry),
    holdLabel: fxdreamHoldLabel(entry),
  });
  renderFxdreamRail();
  selectReadOnlyOverlay(`keyvol:${entry.id}`);
  if (!state.chart) return;
  const padding = 12 * 60 * 60;
  state.chart.timeScale().setVisibleRange({
    from: Math.floor(entry.entryTime / 1000) - padding,
    to: Math.floor(entry.exitTime / 1000) + padding,
  });
  document.querySelector("#chart-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  scheduleOverlayRender();
}

function handleKeyVolumeTableClick(event) {
  const row = event.target.closest("[data-keyvol-id]");
  if (!row) return;
  const entry = state.keyVolume?.entries.find((candidate) => candidate.id === row.dataset.keyvolId);
  if (entry) focusKeyVolumeEntry(entry);
}

/* ── Chấm nhãn Key: đáng tin / không đáng tin ────────────────────────────── */

function loadKeyVerdicts() {
  try {
    const stored = JSON.parse(readScopedStorage(KEY_VERDICT_STORAGE_KEY, "[]"));
    state.keyVerdicts = Array.isArray(stored)
      ? stored.filter((item) => item?.keyId && KEY_VERDICT_LABELS[item.verdict])
      : [];
  } catch {
    state.keyVerdicts = [];
  }
}

function persistKeyVerdicts() {
  try {
    localStorage.setItem(scopedStorageKey(KEY_VERDICT_STORAGE_KEY), JSON.stringify(state.keyVerdicts));
  } catch {
    showToast("Trình duyệt không cho phép lưu nhãn key local.");
  }
}

function keyVerdictFor(keyId) {
  return state.keyVerdicts.find((item) => item.keyId === keyId) || null;
}

function selectedKeyLevel() {
  if (state.selectedKeyId == null) return null;
  return state.keyVolume?.levels.find((level) => level.id === state.selectedKeyId) || null;
}

// Chọn chứ KHÔNG bật/tắt: đường key và nhãn của nó là hai chỗ bấm khác nhau, nên
// bấm cái thứ hai sẽ bỏ chọn ngay key vừa chọn và nút tick im lặng không làm gì.
// Muốn bỏ chọn thì dùng nút × trên thẻ.
function selectKeyLevel(keyId) {
  if (state.selectedKeyId === keyId) return;
  state.selectedKeyId = keyId;
  setSideView("fxdream");
  renderKeyJudgeCard();
  scheduleOverlayRender(KEYVOL_OVERLAY);
}

/**
 * Ghi nhãn cho một key. Chụp luôn đặc trưng của key vào bản ghi — sau này đọc
 * lại file JSON vẫn biết người dùng đang chấm cái gì, kể cả khi cửa sổ dữ liệu
 * đã trôi qua và detector không còn sinh ra key đó nữa.
 */
function saveKeyVerdict(verdict) {
  const level = selectedKeyLevel();
  if (!level || !KEY_VERDICT_LABELS[verdict]) {
    showToast("Chưa chọn key nào — nhấp vào một đường key trên chart trước.");
    return;
  }
  const existing = keyVerdictFor(level.id);
  const record = {
    keyId: level.id,
    symbol: state.symbol,
    verdict,
    note: dom.keyjudgeNote.value.trim(),
    updatedAt: new Date().toISOString(),
    key: {
      sourceTf: level.sourceTf,
      price: level.price,
      zoneLow: level.zoneLow,
      zoneHigh: level.zoneHigh,
      eventTime: level.eventTime,
      confirmedAt: level.confirmedAt,
      volumeRatio: level.volumeRatio,
      ageDays: level.ageDays,
      touchCount: level.touchCount,
      crossCount: level.crossCount,
    },
  };
  const index = state.keyVerdicts.findIndex((item) => item.keyId === level.id);
  if (index >= 0) state.keyVerdicts[index] = record;
  else state.keyVerdicts.unshift(record);
  persistKeyVerdicts();
  renderKeyJudgeCard();
  scheduleOverlayRender(KEYVOL_OVERLAY);
  persistPlaybookJson({
    successMessage: `${KEY_VERDICT_LABELS[verdict]} · ${KEYVOL_TF_LABEL[level.sourceTf]} ${formatPrice(level.price)}`,
  });
  if (!existing) showKeyJudgeProgress();
}

function updateKeyVerdictNote() {
  const level = selectedKeyLevel();
  const record = level && keyVerdictFor(level.id);
  if (!record) return;
  record.note = dom.keyjudgeNote.value.trim();
  record.updatedAt = new Date().toISOString();
  persistKeyVerdicts();
  persistPlaybookJson({});
  dom.keyjudgeSaved.textContent = "Đã lưu ghi chú";
}

function deleteKeyVerdict() {
  const level = selectedKeyLevel();
  if (!level) return;
  state.keyVerdicts = state.keyVerdicts.filter((item) => item.keyId !== level.id);
  persistKeyVerdicts();
  dom.keyjudgeNote.value = "";
  renderKeyJudgeCard();
  scheduleOverlayRender(KEYVOL_OVERLAY);
  persistPlaybookJson({ successMessage: "Đã xoá nhãn key" });
}

function showKeyJudgeProgress() {
  const untrusted = state.keyVerdicts.filter((item) => item.verdict === "untrusted").length;
  const trusted = state.keyVerdicts.length - untrusted;
  const total = state.keyVerdicts.length;
  dom.keyjudgeProgress.textContent = total === 0
    ? "Chưa chấm key nào."
    : `Đã chấm ${total} key: ${trusted} đáng tin, ${untrusted} không đáng tin.`;
  if (dom.keyvolJudged) dom.keyvolJudged.textContent = `${total} đã chấm`;
}

function renderKeyJudgeCard() {
  if (!dom.keyjudgeCard) return;
  showKeyJudgeProgress();
  const level = selectedKeyLevel();
  dom.keyjudgeCard.classList.toggle("is-empty", !level);
  dom.keyjudgeEmpty.hidden = !!level;
  dom.keyjudgeBody.hidden = !level;
  dom.keyjudgeClear.hidden = !level;
  if (!level) return;

  const record = keyVerdictFor(level.id);
  dom.keyjudgeHeadline.textContent =
    `${KEYVOL_TF_LABEL[level.sourceTf]} · ${formatPrice(level.price)} · ${formatOrderTime(level.eventTime)}`;
  dom.keyjudgeFacts.innerHTML = [
    ["Volume nến key", `×${level.volumeRatio} so với trung vị`],
    ["Tuổi key", `${level.ageDays} ngày`],
    ["Số nến M15 chạm lại", String(level.touchCount)],
    ["Số lần bị đóng xuyên", level.crossCount === 0 ? "0 — chưa lần nào" : String(level.crossCount)],
    ["Biên vùng", `${formatPrice(level.zoneLow)} – ${formatPrice(level.zoneHigh)}`],
  ]
    .map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");

  for (const button of dom.keyjudgeVerdicts) {
    const active = record?.verdict === button.dataset.keyVerdict;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (document.activeElement !== dom.keyjudgeNote) dom.keyjudgeNote.value = record?.note || "";
  dom.keyjudgeDelete.hidden = !record;
  dom.keyjudgeSaved.textContent = record
    ? `${KEY_VERDICT_LABELS[record.verdict]} · lưu lúc ${formatOrderTime(Date.parse(record.updatedAt))}`
    : "";
}

/* ── Thẻ "Vì sao vào lệnh" ───────────────────────────────────────────────── */

function showEvidence(trade) {
  setSideView("fxdream");
  state.evidencePinned = null;
  state.evidenceTrade = trade;
  state.evidenceHover = null;
  renderEvidenceCard();
  renderKeyVolumeTable();
  scheduleOverlayRender(KEYVOL_OVERLAY | EVIDENCE_OVERLAY);
}

function clearEvidence() {
  state.evidenceTrade = null;
  state.evidenceHover = null;
  renderEvidenceCard();
  scheduleOverlayRender(KEYVOL_OVERLAY | EVIDENCE_OVERLAY);
}

/**
 * Phiếu đọc một lệnh. Một câu kết luận trước, rồi chuỗi cơ chế, rồi bốn chặng.
 * Mỗi điều kiện chỉ có một trong hai dạng và hai dạng trông KHÁC hẳn nhau:
 *   · `so` — số đo to bên phải + thước có vạch ngưỡng, thấy ngay vượt bao xa;
 *   · `co` — dấu tick + một câu.
 * `data-evidence-index` vẫn đánh số PHẲNG qua mọi chặng vì lớp soi trên chart
 * tra theo mảng `trade.evidence` đã phẳng hoá.
 */
function evidenceMeter(item) {
  if (item.kind !== "so" || !(Number(item.gate) > 0)) return "";
  const gateDir = item.gateDir === "lte" ? "lte" : "gte";
  const fill = Math.max(3, Math.min(100, Math.round((Number(item.actual) / Number(item.gate)) * EVIDENCE_GATE_AT)));
  // Vạch ngưỡng luôn đứng ở cùng một chỗ nên quét dọc một cột là so được ngay;
  // dải đỏ là vùng KHÔNG ĐẠT — bên trái vạch với "≥", bên phải với "trần".
  const zoneLeft = gateDir === "gte" ? 0 : EVIDENCE_GATE_AT;
  const zoneWidth = gateDir === "gte" ? EVIDENCE_GATE_AT : 100 - EVIDENCE_GATE_AT;
  return `
    <span class="evidence-meter">
      <i class="evidence-meter-bad" style="left:${zoneLeft}%;width:${zoneWidth}%"></i>
      <i class="evidence-meter-fill" style="width:${fill}%"></i>
      <i class="evidence-meter-gate" style="left:${EVIDENCE_GATE_AT}%"></i>
      <i class="evidence-meter-gate-label" style="left:${EVIDENCE_GATE_AT}%">${escapeHtml(item.gateLabel || "")}</i>
    </span>`;
}

function renderEvidenceItem(item, index) {
  const state = item.state === "fail" ? "fail" : item.state === "info" ? "info" : "pass";
  const mark = state === "pass" ? "✓" : state === "fail" ? "✗" : "·";
  const right = item.kind === "so"
    ? `<span class="evidence-value">${escapeHtml(item.value || "")}</span>`
    : `<span class="evidence-tick">${mark}</span>`;
  // Điều kiện dạng `co` của Turtle/Fast vẫn có ngưỡng bằng chữ — giữ lại dưới
  // câu kể thay vì vứt đi, nhưng để nhỏ hẳn xuống.
  const hint = item.kind === "co" && item.gateLabel
    ? `<span class="evidence-hintline">ngưỡng: ${escapeHtml(item.gateLabel)}</span>`
    : "";
  return `
    <button class="evidence-row is-${state}${item.chart ? " has-chart" : ""}" type="button" data-evidence-index="${index}">
      <span class="evidence-row-top">
        <b>${escapeHtml(item.label)}</b>
        ${right}
      </span>
      ${evidenceMeter(item)}
      <span class="evidence-say">${escapeHtml(item.say || "")}</span>
      ${hint}
    </button>`;
}

function renderEvidenceCard() {
  if (!dom.evidenceCard) return;
  const trade = state.evidenceTrade;
  dom.evidenceCard.classList.toggle("is-empty", !trade);
  dom.evidenceEmpty.hidden = !!trade;
  dom.evidenceBody.hidden = !trade;
  dom.evidenceClear.hidden = !trade;
  if (dom.evidenceWhen) dom.evidenceWhen.textContent = trade?.when || "";
  if (!trade) {
    dom.evidenceList.innerHTML = "";
    if (dom.evidenceIdentity) dom.evidenceIdentity.hidden = true;
    if (dom.evidenceMetrics) dom.evidenceMetrics.hidden = true;
    if (dom.evidenceChain) dom.evidenceChain.hidden = true;
    return;
  }
  renderEvidenceIdentity(trade);

  // Không có chặng (lệnh Turtle/Fast) thì dồn hết vào một chặng không tên —
  // một đường vẽ duy nhất, không rẽ nhánh trong template.
  const stages = Array.isArray(trade.stages) && trade.stages.length
    ? trade.stages
    : [{ n: "", title: "", items: trade.evidence || [] }];
  let index = 0;
  dom.evidenceList.innerHTML = stages
    .map((stage) => {
      let pass = 0;
      let total = 0;
      for (const item of stage.items) {
        if (item.state === "info") continue;
        total += 1;
        if (item.state !== "fail") pass += 1;
      }
      const rows = stage.items.map((item) => renderEvidenceItem(item, index++)).join("");
      const head = stage.title
        ? `<div class="evidence-stage-head">
             <span class="evidence-stage-n">${escapeHtml(stage.n)}</span>
             <h4>${escapeHtml(stage.title)}</h4>
             <em class="${pass === total ? "is-all" : "is-bad"}">${pass}/${total}</em>
           </div>`
        : "";
      return `<div class="evidence-stage">${head}${rows}</div>`;
    })
    .join("");
}

/**
 * Câu kết luận, chuỗi cơ chế và ba con số. Lệnh Turtle/Fast không có `chain`
 * nên dải chip tự ẩn đi chứ không hiện một dải rỗng.
 */
function renderEvidenceIdentity(trade) {
  const hasMeta = !!trade.branchTag;
  if (dom.evidenceIdentity) {
    dom.evidenceIdentity.hidden = false;
    dom.evidenceSide.textContent = trade.side === "long" ? "LONG" : "SHORT";
    dom.evidenceSide.className = `evidence-side is-${trade.side}`;
    if (dom.evidenceVerdict) dom.evidenceVerdict.textContent = trade.verdict || trade.summary || "";
    // Vị thế còn mở chưa có R — nói thẳng "đang mở" chứ không in 0,00R.
    const open = trade.resultR == null || !Number.isFinite(Number(trade.resultR));
    dom.evidenceR.textContent = open ? "đang mở" : formatR(Number(trade.resultR));
    dom.evidenceR.className = `evidence-r ${open ? "is-open" : Number(trade.resultR) >= 0 ? "is-win" : "is-loss"}`;
  }
  if (dom.evidenceChain) {
    const chain = Array.isArray(trade.chain) ? trade.chain : [];
    dom.evidenceChain.hidden = !chain.length;
    dom.evidenceChain.innerHTML = chain
      .map((text, i) => {
        const cls = i === chain.length - 1 ? " is-last" : i === 0 && trade.usesKey ? " is-key" : "";
        return `<span class="evidence-chip${cls}">${escapeHtml(text)}</span>`;
      })
      .join("");
  }
  if (!dom.evidenceMetrics) return;
  dom.evidenceMetrics.hidden = !hasMeta;
  if (!hasMeta) return;
  dom.evidenceRisk.textContent = trade.riskPct == null ? "—" : `${trade.riskPct.toFixed(2)}%`;
  dom.evidenceRoom.textContent = `${Number(trade.targetR || 0).toFixed(2)}R`;
  dom.evidenceHold.textContent = trade.holdLabel || "—";
}

/** Bấm một dòng để GHIM nó lại; bấm lần nữa để nhả. */
function toggleEvidencePin(index) {
  state.evidencePinned = state.evidencePinned === index ? null : index;
  setEvidenceHover(state.evidencePinned == null ? null : index);
  for (const node of dom.evidenceList.querySelectorAll("[data-evidence-index]")) {
    node.classList.toggle("is-pinned", Number(node.dataset.evidenceIndex) === state.evidencePinned);
  }
}

function setEvidenceHover(index) {
  if (state.evidenceHover === index) return;
  state.evidenceHover = index;
  for (const node of dom.evidenceList.querySelectorAll("[data-evidence-index]")) {
    node.classList.toggle("is-hovered", Number(node.dataset.evidenceIndex) === index);
  }
  scheduleOverlayRender(EVIDENCE_OVERLAY);
}

function renderEvidenceHighlight() {
  const layer = dom.evidenceLayer;
  if (!layer) return;
  const trade = state.evidenceTrade;
  const item = trade && state.evidenceHover != null ? trade.evidence[state.evidenceHover] : null;
  // Đang soi một điều kiện thì MỜ mọi lớp khác đi, chỉ chừa đúng vùng đang soi.
  // Vẽ thêm một hình lên trên mà không mờ nền thì hình đó lẫn vào chính đống
  // key/hộp/SL đang vẽ sẵn — đúng chỗ khó đọc của bản cũ.
  // Tắt lớp "Soi bằng chứng" thì đừng mờ gì cả — nếu không chart mờ đi mà
  // chẳng có vùng sáng nào thay thế.
  const focusOn = !!item?.chart && state.chartLayers.evidence !== false;
  dom.chartWrap?.classList.toggle("is-evidence-focus", focusOn);
  if (!item?.chart || !state.chart || !state.candleSeries) {
    layer.innerHTML = "";
    return;
  }
  const plot = chartPlotBox();
  layer.setAttribute("viewBox", `0 0 ${plot.width} ${plot.height}`);
  const box = geometryToPixels(item.chart, plot);
  if (!box) {
    layer.innerHTML = `<text class="evidence-offscreen" x="12" y="20">${escapeHtml(item.label)} nằm ngoài khung nhìn</text>`;
    return;
  }
  const kind = item.chart.kind;
  let shape = "";
  if (kind === "zone") {
    shape = `<rect class="evidence-shape" x="${box.x1.toFixed(1)}" y="${box.top.toFixed(1)}" width="${Math.max(2, box.x2 - box.x1).toFixed(1)}" height="${Math.max(2, box.bottom - box.top).toFixed(1)}"></rect>`;
  } else if (kind === "candle") {
    const centre = (box.x1 + box.x2) / 2;
    shape = `<rect class="evidence-shape" x="${(centre - 7).toFixed(1)}" y="0" width="14" height="${plot.bottom.toFixed(1)}"></rect>`;
  } else if (kind === "segment") {
    shape = `<line class="evidence-line" x1="${box.x1.toFixed(1)}" y1="${box.yA.toFixed(1)}" x2="${box.x2.toFixed(1)}" y2="${box.yB.toFixed(1)}"></line>`;
  } else {
    shape = `<line class="evidence-line" x1="${box.x1.toFixed(1)}" y1="${box.yA.toFixed(1)}" x2="${box.x2.toFixed(1)}" y2="${box.yA.toFixed(1)}"></line>`;
  }
  const labelY = Math.max(12, Math.min(plot.bottom - 4, (kind === "zone" ? box.top : box.yA) - 6));
  const labelX = Math.max(4, Math.min(plot.right - 150, box.x1 + 4));
  layer.innerHTML = `
    <g class="evidence-highlight kind-${kind}">
      ${shape}
      <text class="evidence-shape-label" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}">${escapeHtml(item.label)}</text>
    </g>`;
}

function setStrategyFilter(filter) {
  state.strategyFilter = filter;
  for (const button of dom.strategyFilterButtons) {
    const active = button.dataset.strategyFilter === filter;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (state.selectedOverlayId?.startsWith("strategy:") && !allReadOnlyPositions().some((position) => position.id === state.selectedOverlayId)) {
    state.selectedOverlayId = null;
    if (state.chartView === "selected") state.chartView = "clean";
  }
  renderStrategyAudit();
}

function focusStrategyTrade(trade) {
  showEvidence({
    when: formatOrderTime(trade.entryTime),
    id: trade.id,
    kind: "bot",
    keyId: null,
    headline: `${trade.strategy === "turtle" ? "TURTLE" : "FAST"} · ${trade.dir === "long" ? "LONG" : "SHORT"} unit ${trade.unit} · ${formatOrderTime(trade.entryTime)}`,
    verdict: trade.entryReason,
    chain: [],
    stages: null,
    summary: trade.entryReason,
    side: trade.dir,
    resultR: trade.resultR,
    evidence: Array.isArray(trade.evidence) ? trade.evidence : [],
  });
  if (!state.chart) return;
  selectReadOnlyOverlay(`strategy:${trade.id}`);
  const padding = 2 * 24 * 60 * 60;
  const from = Math.floor(trade.entryTime / 1000) - padding;
  const naturalTo = trade.exitTime ? Math.floor(trade.exitTime / 1000) : Math.floor(trade.entryTime / 1000) + 7 * 24 * 60 * 60;
  state.chart.timeScale().setVisibleRange({ from, to: naturalTo + padding });
  document.querySelector("#chart-section").scrollIntoView({ behavior: "smooth", block: "start" });
  scheduleOverlayRender();
}

function handleStrategyTableClick(event) {
  const row = event.target.closest("[data-audit-id]");
  if (!row) return;
  const trade = state.strategyTrades.find((candidate) => candidate.id === row?.dataset.auditId);
  if (!trade) return;
  const action = event.target.closest("[data-audit-action]")?.dataset.auditAction;
  if (action === "feedback") openUserFeedback(trade);
  else focusStrategyTrade(trade);
}

function updateMarketTape() {
  const last = state.candles.at(-1);
  if (!last) return;
  const dayCandles = state.candles.slice(-96);
  const first = dayCandles[0] || last;
  const change = ((last.c - first.o) / first.o) * 100;
  const high = Math.max(...dayCandles.map((candle) => candle.h));
  const low = Math.min(...dayCandles.map((candle) => candle.l));
  const volume = dayCandles.reduce((total, candle) => total + candle.q, 0);

  dom.lastPrice.textContent = formatPrice(last.c);
  dom.change24h.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
  dom.change24h.classList.toggle("is-positive", change >= 0);
  dom.change24h.classList.toggle("is-negative", change < 0);
  dom.high24h.textContent = formatPrice(high);
  dom.low24h.textContent = formatPrice(low);
  dom.volume24h.textContent = `${formatVolume(volume)} ${marketVolumeUnit()}`;
}

function updateLegend(candle, volumeValue, rsiValue) {
  if (!candle) return;
  const open = Number(candle.o ?? candle.open);
  const high = Number(candle.h ?? candle.high);
  const low = Number(candle.l ?? candle.low);
  const close = Number(candle.c ?? candle.close);
  const time = Number(candle.t ? Math.floor(candle.t / 1000) : candle.time);
  const volume = Number.isFinite(volumeValue) ? volumeValue : state.volumeByTime.get(time) ?? candle.q;
  const previous = state.candles[(state.candleIndexByTime.get(time) ?? 0) - 1];

  dom.legendOpen.textContent = formatPrice(open);
  dom.legendHigh.textContent = formatPrice(high);
  dom.legendLow.textContent = formatPrice(low);
  dom.legendClose.textContent = formatPrice(close);
  // Như TradingView: O/H/L/C tô màu theo cây nến, kèm thay đổi so với giá đóng cây trước.
  dom.legendOhlc.classList.toggle("is-up", close >= open);
  dom.legendOhlc.classList.toggle("is-down", close < open);
  dom.legendChange.textContent = previous
    ? `${formatSignedPrice(close - previous.c)} (${close >= previous.c ? "+" : "−"}${Math.abs(((close - previous.c) / previous.c) * 100).toFixed(2)}%)`
    : "";
  dom.legendVolume.textContent = `${formatVolume(Number(volume))} ${marketVolumeUnit()}`;
  if (dom.legendRsi) {
    const rsi = Number.isFinite(rsiValue) ? rsiValue : state.rsiByTime.get(time);
    dom.legendRsi.textContent = Number.isFinite(rsi) ? rsi.toFixed(1) : "—";
  }
}

async function loadMarketData({ notify = false } = {}) {
  state.marketController?.abort();
  const requestId = ++state.marketRequestId;
  const requestedSymbol = state.symbol;
  const requestedMarket = defaultMarketMeta();
  dom.chartLoading.classList.add("is-visible");
  dom.chartLoadingText.textContent = `Đang lấy nến ${requestedSymbol} từ Binance Futures…`;
  dom.reloadChart.classList.add("is-loading");
  dom.reloadChart.disabled = true;
  setSourceState("loading", requestedMarket.sourceLabel);

  const controller = new AbortController();
  state.marketController = controller;
  const timer = window.setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(`/api/chart?days=${state.historyDays}&symbol=${encodeURIComponent(requestedSymbol.toLowerCase())}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json();
    if (requestId !== state.marketRequestId) return;
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (!Array.isArray(payload.candles) || !payload.candles.length) throw new Error("Không có dữ liệu nến");
    state.marketMeta = {
      venue: String(payload.venue || requestedMarket.venue),
      sourceLabel: String(payload.sourceLabel || requestedMarket.sourceLabel),
      instrumentType: String(payload.instrumentType || requestedMarket.instrumentType),
      volumeUnit: String(payload.volumeUnit || requestedMarket.volumeUnit),
    };
    syncBotUniverse(payload.botUniverse);
    updateInstrumentUi();
    setChartData(payload.candles, "live");
    setStrategyAudit(payload.strategyAudit);
    setKeyVolume(payload.keyVolume);
    if (notify) showToast(`Đã cập nhật ${payload.candles.length.toLocaleString("vi-VN")} nến ${requestedSymbol}.`);
  } catch (error) {
    if (requestId !== state.marketRequestId) return;
    const message = error?.name === "AbortError" ? "Hết thời gian chờ" : String(error?.message || "API chưa sẵn sàng");
    setSourceState("error", message);
    state.strategyAuditLoaded = true;
    state.strategyTrades = [];
    setKeyVolume(null);
    dom.turtleConfig.textContent = "Chưa tải được cấu hình.";
    dom.fastConfig.textContent = "Chưa tải được cấu hình.";
    setStrategyEmpty(
      "Chưa tải được Strategy Audit",
      `${message}. Không tự động đổi sang nguồn dữ liệu khác.`,
      false,
    );
    renderStrategyMarkers();
    if (notify) showToast("Chưa lấy được Binance; không đổi nguồn dữ liệu.");
  } finally {
    window.clearTimeout(timer);
    if (requestId !== state.marketRequestId) return;
    state.marketController = null;
    dom.chartLoading.classList.remove("is-visible");
    dom.reloadChart.classList.remove("is-loading");
    dom.reloadChart.disabled = false;
  }
}

function estimateAtr() {
  const sample = state.candles.slice(-20);
  if (!sample.length) return 800;
  return sample.reduce((sum, candle) => sum + (candle.h - candle.l), 0) / sample.length;
}

function currentPlan() {
  return state.plans.find((plan) => plan.id === state.selectedPlanId) || null;
}

function getPlanLabel(plan) {
  const prefix = plan.side === "long" ? "L" : "S";
  const ordinal = state.plans
    .slice(0, state.plans.indexOf(plan) + 1)
    .filter((item) => item.side === plan.side).length;
  return `${prefix}${Math.max(1, ordinal)}`;
}

function candleIntervalMs() {
  if (state.candles.length < 2) return FIFTEEN_MINUTES;
  const interval = state.candles[1].t - state.candles[0].t;
  return Number.isFinite(interval) && interval > 0 ? interval : FIFTEEN_MINUTES;
}

function positionTimeAtCoordinate(x) {
  const logical = state.chart?.timeScale().coordinateToLogical(x);
  if (!Number.isFinite(logical) || !state.candles.length) return null;
  return candleTimeAtLogical(logical);
}

function snapToCandleTime(time) {
  if (!Number.isFinite(time) || !state.candles.length) return null;
  return candleTimeAtLogical(Math.round(candleLogicalAt(time)));
}

function positionCoordinateAtTime(time) {
  if (!state.chart || !state.candles.length || !Number.isFinite(time)) return null;
  return state.chart.timeScale().logicalToCoordinate(candleLogicalAt(time));
}

/**
 * Toạ độ x của một THỜI ĐIỂM, khác `positionCoordinateAtTime` trả TÂM cây nến:
 * giờ mở của một nến nằm ở MÉP TRÁI cây nến đó, nên lúc nến 10:00 đóng (10:15)
 * rơi đúng ranh giới giữa nến 10:00 và nến 10:15. Ngoài vùng dữ liệu vẫn ngoại
 * suy được.
 */
function momentCoordinate(milliseconds) {
  const centre = positionCoordinateAtTime(milliseconds);
  if (!Number.isFinite(centre)) return null;
  const scale = state.chart.timeScale();
  const spacing = scale.logicalToCoordinate(1) - scale.logicalToCoordinate(0);
  return Number.isFinite(spacing) ? centre - spacing / 2 : centre;
}

function buildPlan(side, source = null, entryPrice = null, startTime = null, endTime = null, entryTime = null) {
  if (source) {
    const sourceStart = leftEdgeEntryTime(source);
    const sourceEnd = Number(source.endTime ?? source.exitTime);
    return {
      id: makeOrderId(),
      side,
      entry: Number(source.entry),
      sl: Number(source.sl),
      tp: Number(source.tp),
      note: String(source.note || ""),
      auto: false,
      entryTime: sourceStart,
      startTime: sourceStart,
      endTime: Number.isFinite(sourceEnd) && sourceEnd > 0 ? sourceEnd : null,
    };
  }

  const placedOnChart = Number.isFinite(entryPrice) && entryPrice > 0;
  const market = placedOnChart ? entryPrice : state.candles.at(-1)?.c || 118000;
  const risk = Math.max(estimateAtr() * 1.15, market * 0.0045);
  const offsetStep = Math.max(estimateAtr() * 0.18, market * 0.0007);
  const offsetUnits = Math.ceil(state.plans.length / 2);
  const entry = placedOnChart ? market : market + (side === "long" ? -1 : 1) * offsetStep * offsetUnits;
  const canonicalStartTime = Number.isFinite(startTime) ? startTime : Number.isFinite(entryTime) ? entryTime : null;
  return {
    id: makeOrderId(),
    side,
    entry: roundPrice(entry),
    sl: roundPrice(side === "long" ? entry - risk : entry + risk),
    tp: roundPrice(side === "long" ? entry + risk * 2.2 : entry - risk * 2.2),
    note: "",
    auto: false,
    entryTime: canonicalStartTime,
    startTime: canonicalStartTime,
    endTime: Number.isFinite(endTime) ? endTime : null,
  };
}

function addPlan(side, { source = null, silent = false, entryPrice = null, startTime = null, endTime = null, entryTime = null } = {}) {
  cancelPositionPlacement();
  const plan = buildPlan(side, source, entryPrice, startTime, endTime, entryTime);
  plan.auto = silent && !source && !Number.isFinite(entryPrice);
  state.plans.push(plan);
  state.selectedPlanId = plan.id;
  state.selectedOverlayId = null;
  if (!silent || source) state.chartView = "selected";
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
  if (!silent) showToast(Number.isFinite(entryPrice)
    ? `Đã đặt ${getPlanLabel(plan)} tại ${formatPrice(plan.entry)} · ${formatOrderTime(leftEdgeEntryTime(plan))}. Kéo các mức giá hoặc hai mép ngang để chỉnh.`
    : `Đã thêm vị thế ${getPlanLabel(plan)} · ${side.toUpperCase()}.`);
  return plan;
}

function updatePositionPlacementControls() {
  const side = state.positionPlacement;
  for (const button of [dom.addLongPlan, dom.addShortPlan]) {
    const active = side === (button === dom.addLongPlan ? "long" : "short");
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  dom.chartWrap.classList.toggle("is-position-placement", Boolean(side));
  dom.positionPlacementLayer.hidden = !side;
  dom.positionPlacementHint.hidden = !side;
  if (side) {
    const label = side === "long" ? "Long Position" : "Short Position";
    dom.positionPlacementTitle.textContent = label;
    dom.positionPlacementLayer.setAttribute("aria-label", `${label}: nhấp vào vùng nến để đặt Entry`);
  }
}

function cancelPositionPlacement() {
  if (!state.positionPlacement) return;
  state.positionPlacement = null;
  restoreChartNavigation();
  updatePositionPlacementControls();
}

function armPositionPlacement(side) {
  if (!state.chart || !state.candleSeries || !state.candles.length) {
    showToast("Chart chưa sẵn sàng để đặt position.");
    return;
  }
  if (state.positionPlacement === side) {
    cancelPositionPlacement();
    return;
  }
  if (state.drawingMode !== "select") setDrawingMode("select");
  setSideView("plan");
  state.positionPlacement = side;
  state.selectedDrawingId = null;
  state.chart.applyOptions({ handleScroll: false, handleScale: false });
  updatePositionPlacementControls();
  updateDrawingControls();
  dom.positionPlacementLayer.focus({ preventScroll: true });
}

function placePositionOnChart(event) {
  const keyboardActivation = event.type === "keydown" && ["Enter", " "].includes(event.key);
  if (!state.positionPlacement || (!keyboardActivation && event.button !== 0)) return;
  const rect = dom.chartWrap.getBoundingClientRect();
  const y = keyboardActivation || event.detail === 0 ? rect.height * 0.38 : event.clientY - rect.top;
  const plotRight = Math.max(120, rect.width - priceAxisWidth());
  const defaultWidth = Math.min(180, Math.max(84, plotRight * 0.18));
  const clickX = Math.max(0, Math.min(plotRight, keyboardActivation || event.detail === 0 ? plotRight * 0.42 : event.clientX - rect.left));
  let startX = clickX;
  startX = Math.max(8, Math.min(plotRight - MIN_POSITION_WIDTH, startX));
  let endX = Math.min(plotRight, startX + defaultWidth);
  if (endX - startX < defaultWidth) startX = Math.max(8, endX - defaultWidth);
  const entryPrice = state.candleSeries?.coordinateToPrice(y);
  const startTime = snapToCandleTime(positionTimeAtCoordinate(startX));
  const endTime = positionTimeAtCoordinate(endX);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return;
  event.preventDefault();
  event.stopPropagation();
  const side = state.positionPlacement;
  cancelPositionPlacement();
  addPlan(side, { entryPrice: roundPrice(entryPrice), entryTime: startTime, startTime, endTime });
}

function loadDraftPlans() {
  try {
    const stored = JSON.parse(readScopedStorage(DRAFT_STORAGE_KEY, "null"));
    const rawPlans = Array.isArray(stored) ? stored : stored?.plans;
    state.plans = Array.isArray(rawPlans)
      ? rawPlans
        .filter((plan) => plan?.id && ["long", "short"].includes(plan.side))
        .map((plan) => ({
          id: String(plan.id),
          side: plan.side,
          entry: Number(plan.entry),
          sl: Number(plan.sl),
          tp: Number(plan.tp),
          note: String(plan.note || ""),
          auto: Boolean(plan.auto),
          entryTime: leftEdgeEntryTime(plan),
          startTime: leftEdgeEntryTime(plan),
          endTime: Number.isFinite(Number(plan.endTime)) && Number(plan.endTime) > 0 ? Number(plan.endTime) : null,
        }))
        .filter((plan) => [plan.entry, plan.sl, plan.tp].every(Number.isFinite))
      : [];
    state.selectedPlanId = state.plans.some((plan) => plan.id === stored?.selectedPlanId)
      ? stored.selectedPlanId
      : state.plans[0]?.id || null;
  } catch {
    state.plans = [];
    state.selectedPlanId = null;
  }
}

function persistDraftPlans() {
  if (state.draftPersistTimer !== null) {
    window.clearTimeout(state.draftPersistTimer);
    state.draftPersistTimer = null;
  }
  try {
    localStorage.setItem(scopedStorageKey(DRAFT_STORAGE_KEY), JSON.stringify({
      selectedPlanId: state.selectedPlanId,
      plans: state.plans,
    }));
  } catch {
    showToast("Trình duyệt không cho phép lưu các vị thế nháp.");
  }
}

function scheduleDraftPlanPersistence() {
  if (state.draftPersistTimer !== null) window.clearTimeout(state.draftPersistTimer);
  state.draftPersistTimer = window.setTimeout(persistDraftPlans, 160);
}

function flushDraftPlanPersistence() {
  if (state.draftPersistTimer !== null) persistDraftPlans();
}

function renderDraftPlans() {
  dom.draftCount.textContent = `${state.plans.length} lệnh`;
  dom.draftEmpty.hidden = state.plans.length > 0;
  dom.draftOrderList.innerHTML = state.plans.map((plan) => {
    const label = getPlanLabel(plan);
    const calculation = calculatePlan(plan);
    const selected = plan.id === state.selectedPlanId;
    return `
      <li class="draft-order-card${selected ? " is-selected" : ""}" data-plan-id="${escapeHtml(plan.id)}">
        <button class="draft-select" type="button" data-action="select-plan" data-plan-id="${escapeHtml(plan.id)}" aria-pressed="${selected}" aria-keyshortcuts="Delete">
          <span class="draft-code ${plan.side}">${label}</span>
          <span class="draft-copy">
            <strong>${plan.side.toUpperCase()} <em data-draft-r>${calculation.valid ? `1:${calculation.rewardR.toFixed(2)}` : "chưa hợp lệ"}</em></strong>
            <small>Entry <b data-draft-entry>${formatPrice(plan.entry)}</b> · <time>${formatOrderTime(leftEdgeEntryTime(plan))}</time></small>
          </span>
        </button>
        <button class="draft-delete" type="button" data-action="delete-plan" data-plan-id="${escapeHtml(plan.id)}" aria-label="Xóa vị thế ${label}">×</button>
      </li>`;
  }).join("");
  updateChartViewControls();
  renderPlanTools();
  updateSelectionState();
}

function strategyReferenceTP(trade) {
  const entry = Number(trade.entryPrice);
  const risk = Math.abs(entry - Number(trade.initialSL));
  return roundPrice(trade.dir === "long" ? entry + risk * 2 : entry - risk * 2);
}

function allReadOnlyPositions() {
  const draftPlanIds = new Set(state.plans.map((plan) => plan.id));
  const saved = state.orders
    .filter((order) => !draftPlanIds.has(order.sourcePlanId))
    .map((order, index) => {
      const entryTime = leftEdgeEntryTime(order);
      return {
        id: `saved:${order.id}`,
        source: "saved",
        label: `M${index + 1}`,
        side: order.side,
        entry: Number(order.entry),
        sl: Number(order.sl),
        tp: Number(order.tp),
        exit: null,
        resultR: Number(order.rewardR),
        entryTime,
        startTime: entryTime,
        endTime: Number.isFinite(Number(order.endTime)) && Number(order.endTime) > 0 ? Number(order.endTime) : null,
        exitTime: null,
        description: order.note || "Lệnh mẫu đã lưu",
      };
    });
  const strategies = visibleStrategyTrades().map((trade) => ({
    id: `strategy:${trade.id}`,
    source: trade.strategy,
    label: `${trade.strategy === "turtle" ? "T" : "F"}${trade.positionId}.${trade.unit}`,
    side: trade.dir,
    entry: Number(trade.entryPrice),
    sl: Number(trade.initialSL),
    tp: strategyReferenceTP(trade),
    exit: trade.exitPrice === null ? null : Number(trade.exitPrice),
    resultR: Number(trade.resultR),
    entryTime: Number(trade.entryTime),
    exitTime: trade.exitTime === null ? null : Number(trade.exitTime),
    description: trade.entryReason,
  }));
  // Lệnh FX Dream trước đây KHÔNG có vị thế nào trên chart: bấm "xem riêng" chỉ
  // zoom và hiện bằng chứng, không có entry/SL/mục tiêu nào được vẽ.
  const fxdream = visibleFxdreamEntries().map((entry, index) => ({
    id: `keyvol:${entry.id}`,
    source: "keyvol",
    label: `K${index + 1}`,
    side: entry.dir,
    entry: Number(entry.entryPrice),
    sl: Number(entry.initialSL),
    tp: Number(entry.target),
    exit: Number(entry.exitPrice),
    open: entry.status === "open",
    resultR: Number(entry.resultR),
    targetR: fxdreamTargetR(entry),
    entryTime: Number(entry.entryTime),
    exitTime: Number(entry.exitTime),
    description: entry.summary,
  }));
  return [...saved, ...strategies, ...fxdream];
}

function readOnlyPositionsForChart() {
  const positions = allReadOnlyPositions();
  if (state.chartView === "clean") return [];
  if (state.chartView !== "selected") return positions;
  return positions.filter((position) => position.id === state.selectedOverlayId);
}

function plansForChart() {
  if (state.chartView === "clean") return [];
  if (state.chartView !== "selected") return state.plans;
  if (state.selectedOverlayId) return [];
  return state.plans.filter((plan) => plan.id === state.selectedPlanId);
}

function drawingsForChart() {
  if (state.chartView === "all") return state.drawings;
  if (state.chartView === "clean") return state.drawings.filter((drawing) => !drawing.linkedPlanId);
  if (state.selectedOverlayId?.startsWith("saved:")) {
    const orderId = state.selectedOverlayId.slice("saved:".length);
    const order = state.orders.find((candidate) => candidate.id === orderId);
    if (Array.isArray(order?.drawings)) return order.drawings;
    const drawingIds = new Set(order?.drawingIds || []);
    return state.drawings.filter((drawing) => drawingIds.has(drawing.id));
  }
  if (state.selectedOverlayId) return [];
  return state.drawings.filter((drawing) => !drawing.linkedPlanId || drawing.linkedPlanId === state.selectedPlanId);
}

function selectedChartItem() {
  if (state.selectedOverlayId) {
    const position = allReadOnlyPositions().find((candidate) => candidate.id === state.selectedOverlayId);
    return position ? { id: position.id, label: position.label } : null;
  }
  const plan = state.plans.find((candidate) => candidate.id === state.selectedPlanId);
  return plan ? { id: plan.id, label: getPlanLabel(plan) } : null;
}

function updateChartViewControls() {
  const selected = selectedChartItem();
  if (state.chartView === "selected" && !selected) state.chartView = "clean";
  for (const button of dom.chartViewButtons) {
    const active = button.dataset.chartView === state.chartView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    if (button.dataset.chartView === "selected") {
      button.disabled = !selected;
      button.setAttribute("aria-label", selected ? `Chỉ hiện ${selected.label} trên biểu đồ` : "Chưa có lệnh để xem riêng");
    }
  }
  if (!dom.chartViewSummary) return;
  dom.chartViewSummary.textContent = state.chartView === "clean"
    ? "Không hiện lệnh · sẵn sàng thêm mẫu"
    : state.chartView === "selected"
      ? `Chỉ hiện ${selected?.label || "1 lệnh"}`
      : "Hiện tất cả lệnh";
}

function setChartView(view) {
  if (!["all", "selected", "clean"].includes(view)) return;
  if (view === "selected" && !selectedChartItem()) return;
  state.chartView = view;
  const visibleDrawingIds = new Set(drawingsForChart().map((drawing) => drawing.id));
  if (state.selectedDrawingId && !visibleDrawingIds.has(state.selectedDrawingId)) state.selectedDrawingId = null;
  updateChartViewControls();
  renderStrategyMarkers();
  renderPlanTools();
  renderStrategyContexts();
  renderDrawings();
}

function setDockPanel(panel) {
  if (!["strategy", "keyvol", "journal", "closed"].includes(panel)) return;
  state.dockPanel = panel;
  dom.bottomDock.dataset.panel = panel;
  dom.bottomDock.classList.toggle("is-collapsed", panel === "closed");
  dom.strategyPanel.hidden = panel !== "strategy";
  dom.keyvolPanel.hidden = panel !== "keyvol";
  dom.journalPanel.hidden = panel !== "journal";
  for (const button of dom.dockPanelButtons) {
    const active = button.dataset.dockPanel === panel;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  window.requestAnimationFrame(() => scheduleOverlayRender());
}

/** % giá từ entry tới một mức, có dấu: "+1.85%" / "−0.79%". */
function formatPriceChangePct(entry, price) {
  const pct = ((price - entry) / entry) * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}

/**
 * Vị thế chỉ-đọc trên chart: R kết quả ở điểm thoát; số R kế hoạch (khoảng
 * entry→TP chia khoảng entry→SL) giữa đường entry; % giá tới TP/SL ở mép hộp.
 * Không nhãn chữ entry/SL/mục tiêu/hướng — các mức đó nằm trong aria-label.
 */
function renderReadOnlyTool(position, index) {
  const selected = position.id === state.selectedOverlayId;
  const sourceLabel = position.source === "saved" ? "MẪU" : position.source === "keyvol" ? "FX DREAM" : position.source.toUpperCase();
  // Turtle/Fast thoát bằng midpoint/Chandelier nên mốc TP chỉ là tham chiếu +2R;
  // FX Dream thì có mục tiêu cấu trúc thật.
  const tpLabel = position.source === "saved" ? "TP" : position.source === "keyvol" ? "mục tiêu" : "TP tham chiếu";
  // Lệnh đang mở: R tạm tính theo giá hiện tại, không phải điểm thoát.
  const resultText = `${position.open ? "≈ " : ""}${formatR(position.resultR)}`;
  const exitLine = Number.isFinite(position.exit)
    ? `<button class="readonly-price-level readonly-exit-level${position.resultR >= 0 ? " is-win" : " is-loss"}" type="button" data-overlay-id="${escapeHtml(position.id)}" data-readonly-level="exit" aria-pressed="${selected}" aria-label="${position.label}: ${position.open ? "giá hiện tại" : "thoát"} ${formatPrice(position.exit)}, kết quả ${resultText}"></button>`
    : "";
  const risk = Math.abs(position.entry - position.sl);
  const plannedR = risk > 0 && Number.isFinite(position.tp) ? Math.abs(position.tp - position.entry) / risk : null;
  const tpPct = Number.isFinite(position.tp) && position.entry > 0 ? formatPriceChangePct(position.entry, position.tp) : "";
  const slPct = Number.isFinite(position.sl) && position.entry > 0 ? formatPriceChangePct(position.entry, position.sl) : "";
  return `
    <div class="readonly-position-tool source-${position.source}${selected ? " is-selected" : ""}" data-overlay-id="${escapeHtml(position.id)}" data-position-index="${index}">
      <button class="readonly-position-zone readonly-reward-zone" type="button" data-overlay-id="${escapeHtml(position.id)}" aria-pressed="${selected}" aria-label="Chọn ${position.label}, vùng lợi nhuận đến ${tpLabel} ${formatPrice(position.tp)} (${tpPct})"></button>
      <button class="readonly-position-zone readonly-risk-zone" type="button" data-overlay-id="${escapeHtml(position.id)}" aria-pressed="${selected}" aria-label="Chọn ${position.label}, vùng rủi ro đến Stop Loss ${formatPrice(position.sl)} (${slPct})"></button>
      <button class="readonly-price-level readonly-tp-level" type="button" data-overlay-id="${escapeHtml(position.id)}" data-readonly-level="tp" aria-pressed="${selected}" aria-label="${position.label}: ${tpLabel} ${formatPrice(position.tp)}"></button>
      <button class="readonly-price-level readonly-entry-level" type="button" data-overlay-id="${escapeHtml(position.id)}" data-readonly-level="entry" aria-pressed="${selected}" aria-label="${position.label}: Entry ${formatPrice(position.entry)}, ${sourceLabel}"></button>
      <button class="readonly-price-level readonly-sl-level" type="button" data-overlay-id="${escapeHtml(position.id)}" data-readonly-level="sl" aria-pressed="${selected}" aria-label="${position.label}: Stop Loss ${formatPrice(position.sl)}"></button>
      ${exitLine}
      <span class="readonly-r-tag${position.resultR >= 0 ? " is-win" : " is-loss"}" aria-hidden="true">${escapeHtml(resultText)}</span>
      ${plannedR == null ? "" : `<span class="readonly-planned-r" aria-hidden="true"><b>${plannedR.toFixed(2)}R</b></span>`}
      ${tpPct ? `<span class="readonly-pct-tag is-tp" data-pct-level="tp" aria-hidden="true"><b>${tpPct}</b></span>` : ""}
      ${slPct ? `<span class="readonly-pct-tag is-sl" data-pct-level="sl" aria-hidden="true"><b>${slPct}</b></span>` : ""}
    </div>`;
}

function renderPlanTools() {
  updateChartViewControls();
  const readOnlyTools = readOnlyPositionsForChart().map(renderReadOnlyTool).join("");
  const draftTools = plansForChart().map((plan, index) => {
    const label = getPlanLabel(plan);
    const calculation = calculatePlan(plan);
    const rewardText = calculation.valid ? formatR(calculation.rewardR) : "—";
    const selected = !state.selectedOverlayId && plan.id === state.selectedPlanId;
    return `
      <div class="position-tool ${plan.side}-tool${selected ? " is-selected" : ""}" data-plan-id="${escapeHtml(plan.id)}" data-position-index="${index}">
        <button class="position-zone reward-zone" type="button" data-action="select-tool" data-plan-id="${escapeHtml(plan.id)}" aria-pressed="${selected}" aria-keyshortcuts="Delete Backspace" aria-label="Chọn ${label} từ vùng lợi nhuận">
          <span>${rewardText}</span>
        </button>
        <button class="position-zone risk-zone" type="button" data-action="select-tool" data-plan-id="${escapeHtml(plan.id)}" aria-pressed="${selected}" aria-keyshortcuts="Delete Backspace" aria-label="Chọn ${label} từ vùng rủi ro"></button>
        <button class="price-level tp-level" data-level="tp" data-plan-id="${escapeHtml(plan.id)}" type="button" aria-label="${label}: kéo Take Profit; dùng phím mũi tên để tinh chỉnh"></button>
        <button class="price-level entry-level" data-level="entry" data-plan-id="${escapeHtml(plan.id)}" type="button" aria-label="${label}: kéo toàn bộ vị thế từ Entry; dùng phím mũi tên để tinh chỉnh"></button>
        <button class="price-level sl-level" data-level="sl" data-plan-id="${escapeHtml(plan.id)}" type="button" aria-label="${label}: kéo Stop Loss; dùng phím mũi tên để tinh chỉnh"></button>
        <button class="position-width-handle position-width-start" data-width-edge="start" data-plan-id="${escapeHtml(plan.id)}" type="button" aria-label="${label}: kéo mép trái để thay đổi chiều ngang"></button>
        <button class="position-width-handle position-width-end" data-width-edge="end" data-plan-id="${escapeHtml(plan.id)}" type="button" aria-label="${label}: kéo mép phải để thay đổi chiều ngang"></button>
        <div class="position-start-time" aria-label="${label}: bắt đầu ${formatOrderTime(leftEdgeEntryTime(plan))}">
          <time data-position-entry-time>${formatOrderTime(leftEdgeEntryTime(plan))}</time><kbd aria-hidden="true">Delete / ⌫</kbd>
        </div>
      </div>`;
  }).join("");
  dom.orderLevels.innerHTML = `${readOnlyTools}${draftTools}`;
  updateSelectionState();
  scheduleOverlayRender(ORDER_OVERLAY);
}

function updateSelectionState() {
  const ordersById = new Map(state.orders.map((order) => [order.id, order]));
  for (const card of dom.draftOrderList.children) {
    const selected = card.dataset.planId === state.selectedPlanId;
    card.classList.toggle("is-selected", selected);
    card.querySelector(".draft-select")?.setAttribute("aria-pressed", String(selected));
  }
  for (const tool of dom.orderLevels.children) {
    if (!tool.dataset.planId) continue;
    const selected = !state.selectedOverlayId && tool.dataset.planId === state.selectedPlanId;
    tool.classList.toggle("is-selected", selected);
    for (const zone of tool.querySelectorAll(".position-zone")) zone.setAttribute("aria-pressed", String(selected));
  }
  for (const tool of dom.orderLevels.querySelectorAll(".readonly-position-tool")) {
    const selected = tool.dataset.overlayId === state.selectedOverlayId;
    tool.classList.toggle("is-selected", selected);
    for (const control of tool.querySelectorAll("button")) control.setAttribute("aria-pressed", String(selected));
  }
  for (const row of dom.ordersBody.children) {
    const order = ordersById.get(row.dataset.orderId);
    const active = `saved:${row.dataset.orderId}` === state.selectedOverlayId ||
      (!state.selectedOverlayId && order?.sourcePlanId === state.selectedPlanId);
    row.classList.toggle("is-chart-active", active);
  }
  for (const row of dom.strategyBody.children) {
    row.classList.toggle("is-chart-active", `strategy:${row.dataset.auditId}` === state.selectedOverlayId);
  }
}

function selectPlan(planId) {
  if (!state.plans.some((plan) => plan.id === planId)) return;
  cancelPositionPlacement();
  setSideView("plan");
  state.selectedPlanId = planId;
  state.selectedOverlayId = null;
  state.selectedDrawingId = null;
  persistDraftPlans();
  syncPlanInputs();
  setChartView("selected");
  updatePlanVisuals();
}

function selectReadOnlyOverlay(overlayId) {
  if (!allReadOnlyPositions().some((position) => position.id === overlayId)) return;
  cancelPositionPlacement();
  state.selectedOverlayId = overlayId;
  state.selectedDrawingId = null;
  setChartView("selected");
}

function deletePlan(planId) {
  const index = state.plans.findIndex((plan) => plan.id === planId);
  if (index < 0) return;
  const [removed] = state.plans.splice(index, 1);
  if (state.selectedPlanId === planId) {
    state.selectedPlanId = state.plans[Math.min(index, state.plans.length - 1)]?.id || null;
    if (state.chartView === "selected" && !state.selectedOverlayId && !state.selectedPlanId) state.chartView = "clean";
  }
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
  showToast(`Đã xóa vị thế ${removed.side.toUpperCase()} khỏi chart.`);
}

function resetPlanAroundMarket() {
  const plan = currentPlan();
  if (!plan) return;
  placePlanAroundMarket(plan);
  plan.auto = false;
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
}

function placePlanAroundMarket(plan) {
  const market = state.candles.at(-1)?.c || plan.entry || 118000;
  const risk = Math.max(estimateAtr() * 1.15, market * 0.0045);
  plan.entry = roundPrice(market);
  plan.sl = roundPrice(plan.side === "long" ? market - risk : market + risk);
  plan.tp = roundPrice(plan.side === "long" ? market + risk * 2.2 : market - risk * 2.2);
}

function syncPlanInputs() {
  const plan = currentPlan();
  const disabled = !plan;
  dom.planEditor.hidden = disabled;
  for (const input of [dom.entryInput, dom.slInput, dom.tpInput, dom.noteInput]) input.disabled = disabled;
  for (const button of dom.sideButtons) button.disabled = disabled;
  dom.resetPlan.disabled = disabled;

  syncPlanPriceInputs(plan);
  dom.noteInput.value = plan?.note || "";
  dom.selectedPlanLabel.textContent = plan ? `${getPlanLabel(plan)} · ${plan.side.toUpperCase()}` : "—";
  const entryTime = leftEdgeEntryTime(plan);
  dom.selectedEntryTime.textContent = plan ? `Entry ${formatOrderTime(entryTime)}` : "—";
  dom.selectedEntryTime.dateTime = entryTime ? new Date(entryTime).toISOString() : "";
  for (const button of dom.sideButtons) {
    const active = plan?.side === button.dataset.side;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function syncPlanPriceInputs(plan = currentPlan()) {
  dom.entryInput.value = plan ? formatInputPrice(plan.entry) : "";
  dom.slInput.value = plan ? formatInputPrice(plan.sl) : "";
  dom.tpInput.value = plan ? formatInputPrice(plan.tp) : "";
}

function readPlanInputs() {
  const plan = currentPlan();
  if (!plan) return;
  plan.entry = Number.parseFloat(dom.entryInput.value);
  plan.sl = Number.parseFloat(dom.slInput.value);
  plan.tp = Number.parseFloat(dom.tpInput.value);
  plan.auto = false;
  scheduleDraftPlanPersistence();
  updatePlanVisuals();
}

function calculatePlan(plan = currentPlan()) {
  if (!plan) return { valid: false, message: "Thêm một vị thế LONG hoặc SHORT để bắt đầu." };
  const { entry, sl, tp } = plan;
  if (![entry, sl, tp].every(Number.isFinite) || entry <= 0 || sl <= 0 || tp <= 0) {
    return { valid: false, message: "Nhập đủ ba mức giá hợp lệ." };
  }

  if (plan.side === "long" && sl >= entry) {
    return { valid: false, message: "Lệnh LONG cần Stop Loss thấp hơn Entry." };
  }
  if (plan.side === "long" && tp <= entry) {
    return { valid: false, message: "Lệnh LONG cần Take Profit cao hơn Entry." };
  }
  if (plan.side === "short" && sl <= entry) {
    return { valid: false, message: "Lệnh SHORT cần Stop Loss cao hơn Entry." };
  }
  if (plan.side === "short" && tp >= entry) {
    return { valid: false, message: "Lệnh SHORT cần Take Profit thấp hơn Entry." };
  }

  const riskDistance = Math.abs(entry - sl);
  const rewardDistance = Math.abs(tp - entry);
  const rewardR = rewardDistance / riskDistance;
  return {
    valid: Number.isFinite(rewardR) && rewardR > 0,
    message: "SL luôn được chuẩn hóa thành −1R; kéo TP để đổi mức R kỳ vọng.",
    riskDistance,
    rewardDistance,
    rewardR,
    riskPercent: (riskDistance / entry) * 100,
    rewardPercent: (rewardDistance / entry) * 100,
  };
}

function updatePlanVisuals() {
  const plan = currentPlan();
  const calculation = calculatePlan(plan);
  const valid = calculation.valid;
  const rewardText = valid ? formatR(calculation.rewardR) : "—";

  dom.rrValue.textContent = valid ? `1 : ${calculation.rewardR.toFixed(2)}` : "1 : —";
  dom.rewardR.textContent = rewardText;
  dom.rewardRSecondary.textContent = rewardText;
  dom.riskPercent.textContent = valid ? `${calculation.riskPercent.toFixed(2)}% giá` : "—";
  dom.rewardPercent.textContent = valid ? `${calculation.rewardPercent.toFixed(2)}% giá` : "—";
  dom.validationMessage.textContent = calculation.message;
  dom.validationMessage.classList.toggle("is-valid", valid);
  dom.saveOrder.disabled = !valid || !plan;
  dom.saveRewardPreview.textContent = valid ? rewardText : "—";
  dom.rewardSegment.parentElement.style.setProperty("--reward-track", valid ? String(Math.min(4, Math.max(0.25, calculation.rewardR))) : "1");

  if (plan) {
    const card = [...dom.draftOrderList.children].find((item) => item.dataset.planId === plan.id);
    if (card) {
      card.querySelector("[data-draft-entry]").textContent = formatPrice(plan.entry);
      card.querySelector("[data-draft-r]").textContent = valid ? `1:${calculation.rewardR.toFixed(2)}` : "chưa hợp lệ";
    }
  }
  scheduleOverlayRender(ORDER_OVERLAY);
}

function renderChartOverlays() {
  renderOrderLevels();
  renderStrategyContexts();
  renderDrawings();
}

/**
 * Giá Entry/TP/SL/Exit của lệnh ĐANG CHỌN nằm trên cột giá bên phải thay vì
 * thẻ nổi trong vùng nến. Chỉ lệnh đang chọn, để cột giá không thành bãi nhãn
 * khi xem tất cả lệnh. `lineVisible: false` vì vạch trong hộp vị thế đã có.
 */
function syncAxisPriceLines(levels) {
  const wanted = new Map(
    (state.chartLayers.position ? levels : [])
      .filter((level) => Number.isFinite(level.price))
      .map((level) => [level.key, level]),
  );
  for (const [key, entry] of state.axisPriceLines) {
    if (wanted.has(key)) continue;
    state.candleSeries.removePriceLine(entry.line);
    state.axisPriceLines.delete(key);
  }
  for (const [key, level] of wanted) {
    const options = {
      price: level.price,
      color: level.color,
      title: level.title,
      lineVisible: false,
      axisLabelVisible: true,
      axisLabelColor: level.color,
      axisLabelTextColor: "#05090c",
    };
    const existing = state.axisPriceLines.get(key);
    if (!existing) {
      state.axisPriceLines.set(key, { line: state.candleSeries.createPriceLine(options), level });
    } else if (existing.level.price !== level.price || existing.level.color !== level.color || existing.level.title !== level.title) {
      existing.line.applyOptions(options);
      existing.level = level;
    }
  }
}

function renderOrderLevels() {
  if (!state.candleSeries) return;
  const axisLevels = [];
  const chartHeight = dom.chartWrap.clientHeight * 0.77;
  const chartWidth = dom.chartWrap.clientWidth;
  const plotRight = Math.max(120, chartWidth - priceAxisWidth());
  const draftTools = new Map();
  const readOnlyTools = new Map();
  for (const tool of dom.orderLevels.children) {
    if (tool.dataset.planId) draftTools.set(tool.dataset.planId, tool);
    if (tool.dataset.overlayId) readOnlyTools.set(tool.dataset.overlayId, tool);
  }
  const visiblePlans = plansForChart();
  for (const [index, plan] of visiblePlans.entries()) {
    const tool = draftTools.get(plan.id);
    if (!tool) continue;
    const coordinates = Object.fromEntries(["entry", "sl", "tp"].map((level) => [
      level,
      state.candleSeries.priceToCoordinate(plan[level]),
    ]));
    const startCoordinate = positionCoordinateAtTime(plan.startTime);
    const endCoordinate = positionCoordinateAtTime(plan.endTime);
    const fallbackWidth = Math.min(220, Math.max(110, plotRight * 0.22));
    let left;
    let right;
    if (Number.isFinite(startCoordinate)) {
      const rawLeft = startCoordinate;
      const rawRight = Number.isFinite(endCoordinate)
        ? Math.max(startCoordinate + MIN_POSITION_WIDTH, endCoordinate)
        : startCoordinate + fallbackWidth;
      if (rawRight < 0 || rawLeft > plotRight) {
        tool.hidden = true;
        continue;
      }
      left = Math.max(0, Math.min(plotRight - MIN_POSITION_WIDTH, rawLeft));
      right = Math.min(plotRight, Math.max(left + MIN_POSITION_WIDTH, rawRight));
    } else {
      left = Math.max(8, Math.min(plotRight - MIN_POSITION_WIDTH, chartWidth * (0.41 + (index % 4) * 0.04)));
      right = Math.min(plotRight, left + fallbackWidth);
    }

    tool.hidden = !Object.values(coordinates).some(Number.isFinite) || right <= left;
    if (tool.hidden) continue;
    tool.style.setProperty("--tool-left", `${left}px`);
    tool.style.setProperty("--tool-right", `${Math.max(priceAxisWidth(), chartWidth - right)}px`);
    const startTimeTag = tool.querySelector(".position-start-time");
    if (startTimeTag) startTimeTag.hidden = !Number.isFinite(coordinates.entry);
    if (Number.isFinite(coordinates.entry)) tool.style.setProperty("--tool-entry-y", `${coordinates.entry}px`);
    tool.dataset.leftPx = String(left);
    tool.dataset.rightPx = String(right);

    const verticalCoordinates = [coordinates.entry, coordinates.sl, coordinates.tp].filter(Number.isFinite);
    const toolTop = Math.max(0, Math.min(...verticalCoordinates));
    const toolBottom = Math.min(chartHeight, Math.max(...verticalCoordinates));
    tool.style.setProperty("--tool-top", `${toolTop}px`);
    tool.style.setProperty("--tool-height", `${Math.max(18, toolBottom - toolTop)}px`);

    for (const button of tool.querySelectorAll("[data-level]")) {
      const coordinate = coordinates[button.dataset.level];
      const visible = Number.isFinite(coordinate) && coordinate >= -20 && coordinate <= chartHeight + 20;
      button.hidden = !visible;
      if (visible) button.style.top = `${coordinate}px`;
    }
    // Lệnh đang kéo vẫn cần thấy giá trên trục, nhưng không gắn chữ TP/SL/ENTRY.
    if (!state.selectedOverlayId && plan.id === state.selectedPlanId) {
      axisLevels.push(
        { key: `${plan.id}:tp`, price: plan.tp, color: AXIS_LEVEL_COLORS.tp, title: "" },
        { key: `${plan.id}:entry`, price: plan.entry, color: AXIS_LEVEL_COLORS.entry, title: "" },
        { key: `${plan.id}:sl`, price: plan.sl, color: AXIS_LEVEL_COLORS.sl, title: "" },
      );
    }

    const calculation = calculatePlan(plan);
    const rewardLabel = tool.querySelector(".reward-zone span");
    if (rewardLabel) rewardLabel.textContent = calculation.valid ? formatR(calculation.rewardR) : "—";

    const positionZone = (selector, first, second) => {
      const zone = tool.querySelector(selector);
      if (!zone || !Number.isFinite(first) || !Number.isFinite(second)) {
        if (zone) zone.hidden = true;
        return;
      }
      const top = Math.max(0, Math.min(first, second));
      const bottom = Math.min(chartHeight, Math.max(first, second));
      zone.hidden = bottom - top < 2;
      zone.style.top = `${top}px`;
      zone.style.height = `${Math.max(2, bottom - top)}px`;
    };
    positionZone(".reward-zone", coordinates.entry, coordinates.tp);
    positionZone(".risk-zone", coordinates.entry, coordinates.sl);
  }

  const positions = readOnlyPositionsForChart();
  let savedIndex = 0;
  for (const position of positions) {
    const tool = readOnlyTools.get(position.id);
    if (!tool) continue;

    let left;
    let right;
    if (position.source === "saved") {
      const savedStart = positionCoordinateAtTime(position.startTime);
      const savedEnd = positionCoordinateAtTime(position.endTime);
      if (Number.isFinite(savedStart)) {
        const naturalEnd = Number.isFinite(savedEnd) ? Math.max(savedStart + 28, savedEnd) : savedStart + 145;
        if (naturalEnd < 0 || savedStart > plotRight) {
          tool.hidden = true;
          continue;
        }
        left = Math.max(8, Math.min(plotRight - 28, savedStart));
        right = Math.min(plotRight, Math.max(left + 28, naturalEnd));
      } else {
        left = chartWidth * (0.34 + (savedIndex % 5) * 0.035);
        right = plotRight;
      }
      savedIndex += 1;
    } else if (position.source === "keyvol") {
      // Lệnh Key Volume mang THỜI ĐIỂM khớp (lúc nến vào/thoát đóng), không phải
      // giờ mở nến: mép hộp nằm đúng ranh giới hai cây nến. Không ép bề rộng tối
      // thiểu và không dời mép trái — lệnh 2 nến phải trông đúng là 2 nến, nhãn
      // giá có min-width riêng nên vẫn đọc được khi hộp hẹp.
      const start = momentCoordinate(position.entryTime);
      const naturalEnd = momentCoordinate(position.exitTime);
      if (!Number.isFinite(start) || !Number.isFinite(naturalEnd) || naturalEnd < 0 || start > plotRight) {
        tool.hidden = true;
        continue;
      }
      left = Math.max(0, start);
      right = Math.min(plotRight, Math.max(naturalEnd, start + 2));
    } else {
      const start = state.chart.timeScale().timeToCoordinate(Math.floor(position.entryTime / 1000));
      const naturalEnd = position.exitTime
        ? state.chart.timeScale().timeToCoordinate(Math.floor(position.exitTime / 1000))
        : plotRight;
      if (!Number.isFinite(start) || !Number.isFinite(naturalEnd) || naturalEnd < 0 || start > plotRight) {
        tool.hidden = true;
        continue;
      }
      left = Math.max(8, Math.min(plotRight - 70, start));
      right = Math.min(plotRight, Math.max(naturalEnd, start + 145));
      if (right - left < 70) left = Math.max(8, right - 70);
    }

    const coordinates = Object.fromEntries(["entry", "sl", "tp", "exit"].map((level) => [
      level,
      Number.isFinite(position[level]) ? state.candleSeries.priceToCoordinate(position[level]) : null,
    ]));
    const hasVisiblePrice = Object.values(coordinates).some(Number.isFinite);
    tool.hidden = !hasVisiblePrice || right <= left;
    if (tool.hidden) continue;
    tool.style.setProperty("--readonly-left", `${left}px`);
    tool.style.setProperty("--readonly-right", `${Math.max(priceAxisWidth(), chartWidth - right)}px`);

    for (const button of tool.querySelectorAll("[data-readonly-level]")) {
      const coordinate = coordinates[button.dataset.readonlyLevel];
      const visible = Number.isFinite(coordinate) && coordinate >= -20 && coordinate <= chartHeight + 20;
      button.hidden = !visible;
      if (visible) button.style.top = `${coordinate}px`;
    }
    // Số R đứng ở điểm thoát (lệnh mở: giá hiện tại); chưa có điểm thoát thì đứng ở entry.
    const rTag = tool.querySelector(".readonly-r-tag");
    const rTagY = Number.isFinite(coordinates.exit) ? coordinates.exit : coordinates.entry;
    if (rTag) {
      rTag.hidden = !Number.isFinite(rTagY) || rTagY < -20 || rTagY > chartHeight + 20;
      if (!rTag.hidden) rTag.style.top = `${rTagY}px`;
    }
    // Số R kế hoạch nằm giữa đường entry — chỗ vùng TP và vùng SL gặp nhau.
    const plannedTag = tool.querySelector(".readonly-planned-r");
    if (plannedTag) {
      plannedTag.hidden = !Number.isFinite(coordinates.entry) || coordinates.entry < -20 || coordinates.entry > chartHeight + 20;
      if (!plannedTag.hidden) plannedTag.style.top = `${coordinates.entry}px`;
    }
    // % TP/SL đứng ngay ngoài mép hộp: mức nằm trên entry thì nhãn ở trên đường, dưới thì ở dưới.
    for (const pctTag of tool.querySelectorAll("[data-pct-level]")) {
      const y = coordinates[pctTag.dataset.pctLevel];
      pctTag.hidden = !Number.isFinite(y) || !Number.isFinite(coordinates.entry) || y < -20 || y > chartHeight + 20;
      if (pctTag.hidden) continue;
      pctTag.style.top = `${y}px`;
      pctTag.classList.toggle("is-above", y < coordinates.entry);
    }
    // Hộp hẹp thì nhãn giữa che nhãn kết quả ở mép phải: đẩy nhãn kết quả ra ngay
    // bên phải nhãn giữa. Bề rộng nhãn giữa không đổi theo zoom nên chỉ đo một lần.
    if (rTag) {
      const pillHalf = plannedTag && !plannedTag.hidden
        ? Number(tool.dataset.pillHalf ||= String(plannedTag.firstElementChild.offsetWidth / 2))
        : 0;
      const narrow = pillHalf > 0 && (right - left) / 2 < pillHalf + 70;
      rTag.style.left = narrow ? `${(left + right) / 2 + pillHalf + 4}px` : "";
      rTag.style.right = narrow ? "auto" : "";
    }

    const positionZone = (selector, first, second) => {
      const zone = tool.querySelector(selector);
      if (!zone || !Number.isFinite(first) || !Number.isFinite(second)) {
        if (zone) zone.hidden = true;
        return;
      }
      const top = Math.max(0, Math.min(first, second));
      const bottom = Math.min(chartHeight, Math.max(first, second));
      zone.hidden = bottom - top < 2;
      zone.style.top = `${top}px`;
      zone.style.height = `${Math.max(2, bottom - top)}px`;
    };
    positionZone(".readonly-reward-zone", coordinates.entry, coordinates.tp);
    positionZone(".readonly-risk-zone", coordinates.entry, coordinates.sl);
  }
  syncAxisPriceLines(axisLevels);
}

function loadDrawings() {
  try {
    const stored = JSON.parse(readScopedStorage(DRAWING_STORAGE_KEY, "[]"));
    state.drawings = Array.isArray(stored)
      ? stored
        .filter((drawing) => drawing?.id && ["rectangle", "line"].includes(drawing.type))
        .map((drawing) => ({
          id: String(drawing.id),
          type: drawing.type,
          startTime: Number(drawing.startTime),
          endTime: Number(drawing.endTime),
          startPrice: Number(drawing.startPrice),
          endPrice: Number(drawing.endPrice),
          linkedPlanId: drawing.linkedPlanId ? String(drawing.linkedPlanId) : null,
          contextLabel: String(drawing.contextLabel || ""),
          purpose: drawing.type === "rectangle" ? "reaction-entry-zone" : "analysis-line",
          createdAt: String(drawing.createdAt || ""),
        }))
        .filter((drawing) => [drawing.startTime, drawing.endTime, drawing.startPrice, drawing.endPrice].every(Number.isFinite))
      : [];
  } catch {
    state.drawings = [];
  }
  updateDrawingControls();
}

function persistDrawings() {
  try {
    localStorage.setItem(scopedStorageKey(DRAWING_STORAGE_KEY), JSON.stringify(state.drawings));
  } catch {
    showToast("Trình duyệt không cho phép lưu hình vẽ local.");
  }
  updateDrawingControls();
  if (state.orders.length || state.userFeedback.length) persistPlaybookJson();
}

function updateDrawingControls() {
  dom.drawingCount.textContent = `${state.drawings.length} hình · lưu local`;
  dom.deleteDrawing.disabled = !state.selectedDrawingId;
  for (const button of dom.drawingModeButtons) {
    const active = button.dataset.drawingMode === state.drawingMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  dom.drawingLayer.classList.toggle("is-drawing-mode", state.drawingMode !== "select");
}

function setDrawingMode(mode) {
  if (!["select", "rectangle", "line"].includes(mode)) return;
  cancelPositionPlacement();
  state.drawingMode = mode;
  if (mode !== "select") state.selectedDrawingId = null;
  if (state.drawingDraft) cancelDrawingDraft();
  updateDrawingControls();
  renderDrawings();
}

function drawingPointFromEvent(event, rect = dom.chartWrap.getBoundingClientRect()) {
  if (!state.chart || !state.candleSeries || !state.candles.length) return null;
  const x = Math.max(0, Math.min(rect.width - priceAxisWidth(), event.clientX - rect.left));
  const y = Math.max(4, Math.min(rect.height * 0.77, event.clientY - rect.top));
  const logical = state.chart.timeScale().coordinateToLogical(x);
  const price = state.candleSeries.coordinateToPrice(y);
  if (!Number.isFinite(logical) || !Number.isFinite(price)) return null;
  return {
    time: candleTimeAtLogical(logical),
    price: roundPrice(price),
    x,
    y,
  };
}

function drawingTimeToCoordinate(time) {
  if (!state.chart || !state.candles.length || !Number.isFinite(time)) return null;
  const logical = candleLogicalAt(time);
  return state.chart.timeScale().logicalToCoordinate(logical);
}

function drawingContextLabel(drawing) {
  if (drawing.contextLabel) return drawing.contextLabel;
  const plan = state.plans.find((candidate) => candidate.id === drawing.linkedPlanId);
  return plan ? getPlanLabel(plan) : "";
}

function renderDrawingShape(drawing, preview = false) {
  const x1 = drawingTimeToCoordinate(drawing.startTime);
  const x2 = drawingTimeToCoordinate(drawing.endTime);
  const y1 = state.candleSeries?.priceToCoordinate(drawing.startPrice);
  const y2 = state.candleSeries?.priceToCoordinate(drawing.endPrice);
  if (![x1, x2, y1, y2].every(Number.isFinite)) return "";
  const selected = !preview && drawing.id === state.selectedDrawingId;
  const context = drawingContextLabel(drawing);
  const selectedClass = selected ? " is-selected" : "";
  const previewClass = preview ? " drawing-preview" : "";
  const common = `class="chart-drawing${selectedClass}${previewClass}" data-drawing-id="${escapeHtml(drawing.id)}"${preview ? "" : ` tabindex="0" role="button" aria-pressed="${selected}"`}`;

  if (drawing.type === "rectangle") {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.max(1, Math.abs(x2 - x1));
    const height = Math.max(1, Math.abs(y2 - y1));
    const label = `${context ? `${context} · ` : ""}VÙNG PHẢN ỨNG · ENTRY TIỀM NĂNG`;
    const labelWidth = Math.min(202, Math.max(128, label.length * 4.7));
    const accessibility = preview
      ? " aria-hidden=\"true\""
      : ` aria-label="${escapeHtml(label)}, từ ${formatPrice(drawing.startPrice)} đến ${formatPrice(drawing.endPrice)}"`;
    return `<g ${common}${accessibility}>
      <title>${escapeHtml(label)}</title>
      <rect class="drawing-rectangle-hit" x="${left}" y="${top}" width="${width}" height="${height}" rx="2" />
      <rect class="drawing-rectangle" x="${left}" y="${top}" width="${width}" height="${height}" rx="2" />
      <rect class="drawing-label-bg" x="${left + 5}" y="${top + 5}" width="${labelWidth}" height="17" rx="3" />
      <text class="drawing-label" x="${left + 11}" y="${top + 16}">${escapeHtml(label)}</text>
    </g>`;
  }

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const label = `${context ? `${context} · ` : ""}ĐƯỜNG PHÂN TÍCH`;
  const accessibility = preview
    ? " aria-hidden=\"true\""
    : ` aria-label="${escapeHtml(label)}, từ ${formatPrice(drawing.startPrice)} đến ${formatPrice(drawing.endPrice)}"`;
  return `<g ${common}${accessibility}>
    <title>${escapeHtml(label)}</title>
    <line class="drawing-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    <line class="drawing-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />
    <text class="drawing-label drawing-line-label" x="${midX + 6}" y="${midY - 6}">${escapeHtml(label)}</text>
  </g>`;
}

function renderDrawings() {
  if (!dom.drawingLayer || !state.candleSeries) {
    updateDrawingControls();
    return;
  }
  const width = dom.chartWrap.clientWidth;
  const height = dom.chartWrap.clientHeight;
  dom.drawingLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const saved = drawingsForChart().map((drawing) => renderDrawingShape(drawing)).join("");
  const preview = state.drawingDraft ? renderDrawingShape(state.drawingDraft, true) : "";
  dom.drawingLayer.innerHTML = `<rect class="drawing-hit-area" x="0" y="0" width="${Math.max(0, width - priceAxisWidth())}" height="${height * 0.77}" />${saved}${preview}`;
  updateDrawingControls();
}

function restoreChartNavigation() {
  state.chart?.applyOptions(CHART_NAVIGATION);
  document.body.classList.remove("is-drawing-shape");
}

function beginDrawing(event) {
  if (state.drawingMode === "select" || event.button !== 0) return;
  const chartRect = dom.chartWrap.getBoundingClientRect();
  const point = drawingPointFromEvent(event, chartRect);
  if (!point) return;
  event.preventDefault();
  event.stopPropagation();
  state.drawingDraft = {
    id: "drawing-preview",
    type: state.drawingMode,
    startTime: point.time,
    endTime: point.time,
    startPrice: point.price,
    endPrice: point.price,
    startClientX: event.clientX,
    startClientY: event.clientY,
    pointerId: event.pointerId,
    chartRect,
  };
  state.chart.applyOptions({ handleScroll: false, handleScale: false });
  document.body.classList.add("is-drawing-shape");
  renderDrawings();
}

function applyDrawingMove(event) {
  if (!state.drawingDraft || event.pointerId !== state.drawingDraft.pointerId) return;
  const point = drawingPointFromEvent(event, state.drawingDraft.chartRect);
  if (!point) return;
  state.drawingDraft.endTime = point.time;
  state.drawingDraft.endPrice = point.price;
  scheduleOverlayRender(DRAWING_OVERLAY);
}

function moveDrawing(event) {
  if (!state.drawingDraft || event.pointerId !== state.drawingDraft.pointerId) return;
  state.pendingDrawingMove = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
  if (state.drawingFrame !== null) return;
  state.drawingFrame = window.requestAnimationFrame(() => {
    state.drawingFrame = null;
    const pending = state.pendingDrawingMove;
    state.pendingDrawingMove = null;
    if (pending) applyDrawingMove(pending);
  });
}

function flushDrawingMove() {
  if (state.drawingFrame !== null) window.cancelAnimationFrame(state.drawingFrame);
  state.drawingFrame = null;
  const pending = state.pendingDrawingMove;
  state.pendingDrawingMove = null;
  if (pending) applyDrawingMove(pending);
}

function finishDrawing(event) {
  if (!state.drawingDraft || event.pointerId !== state.drawingDraft.pointerId) return;
  if (event.type === "pointerup") {
    state.pendingDrawingMove = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
  }
  flushDrawingMove();
  const draft = state.drawingDraft;
  const distance = Math.hypot(event.clientX - draft.startClientX, event.clientY - draft.startClientY);
  state.drawingDraft = null;
  state.suppressDrawingClick = true;
  restoreChartNavigation();

  if (distance >= 7) {
    const plan = state.chartView === "selected" && !state.selectedOverlayId ? currentPlan() : null;
    const drawing = {
      id: makeOrderId(),
      type: draft.type,
      startTime: draft.startTime,
      endTime: draft.endTime,
      startPrice: draft.startPrice,
      endPrice: draft.endPrice,
      linkedPlanId: plan?.id || null,
      contextLabel: plan ? getPlanLabel(plan) : "",
      purpose: draft.type === "rectangle" ? "reaction-entry-zone" : "analysis-line",
      createdAt: new Date().toISOString(),
    };
    state.drawings.push(drawing);
    state.selectedDrawingId = drawing.id;
    persistDrawings();
    showToast(drawing.type === "rectangle"
      ? "Đã lưu vùng phản ứng · Entry tiềm năng."
      : "Đã lưu đường phân tích trên chart.");
  }
  state.drawingMode = "select";
  scheduleOverlayRender(DRAWING_OVERLAY);
}

function cancelDrawingDraft() {
  if (state.drawingFrame !== null) window.cancelAnimationFrame(state.drawingFrame);
  state.drawingFrame = null;
  state.pendingDrawingMove = null;
  state.drawingDraft = null;
  restoreChartNavigation();
  renderDrawings();
}

function selectDrawing(drawingId, focus = false) {
  if (!state.drawings.some((drawing) => drawing.id === drawingId)) return;
  state.selectedDrawingId = drawingId;
  renderDrawings();
  if (focus) {
    window.requestAnimationFrame(() => {
      [...dom.drawingLayer.querySelectorAll("[data-drawing-id]")]
        .find((element) => element.dataset.drawingId === drawingId)?.focus();
    });
  }
}

function deleteSelectedDrawing() {
  const index = state.drawings.findIndex((drawing) => drawing.id === state.selectedDrawingId);
  if (index < 0) return;
  const [removed] = state.drawings.splice(index, 1);
  state.selectedDrawingId = null;
  persistDrawings();
  renderDrawings();
  showToast(removed.type === "rectangle" ? "Đã xóa vùng phản ứng." : "Đã xóa đường phân tích.");
}

function handleDrawingClick(event) {
  if (state.suppressDrawingClick) {
    state.suppressDrawingClick = false;
    return;
  }
  if (state.drawingMode !== "select") return;
  const drawing = event.target.closest("[data-drawing-id]");
  if (drawing) selectDrawing(drawing.dataset.drawingId);
}

function handleDrawingKeyDown(event) {
  const drawing = event.target.closest("[data-drawing-id]");
  if (drawing && event.key === "Enter") selectDrawing(drawing.dataset.drawingId, true);
  if (drawing && event.key === " ") event.preventDefault();
}

function handleDrawingKeyUp(event) {
  const drawing = event.target.closest("[data-drawing-id]");
  if (drawing && event.key === " ") selectDrawing(drawing.dataset.drawingId, true);
}

function handleGlobalDrawingKey(event) {
  const isEditing = event.target.matches?.("input, textarea, select, [contenteditable=true]");
  if (event.key === "Escape" && state.positionPlacement) {
    event.preventDefault();
    cancelPositionPlacement();
    return;
  }
  if (event.key === "Escape" && (state.drawingDraft || state.drawingMode !== "select")) {
    event.preventDefault();
    state.drawingMode = "select";
    cancelDrawingDraft();
    updateDrawingControls();
  }
  if (!isEditing && ["Delete", "Backspace"].includes(event.key) && state.selectedDrawingId) {
    event.preventDefault();
    deleteSelectedDrawing();
    return;
  }
  if (!isEditing && !event.repeat && ["Delete", "Backspace"].includes(event.key) && state.chartView === "selected" && state.selectedPlanId && !state.selectedOverlayId) {
    event.preventDefault();
    deletePlan(state.selectedPlanId);
  }
}

function setSide(nextSide) {
  const plan = currentPlan();
  if (!plan || nextSide === plan.side) return;
  const previousCalculation = calculatePlan(plan);
  const entry = Number.isFinite(plan.entry) ? plan.entry : state.candles.at(-1)?.c || 118000;
  const risk = previousCalculation.valid ? previousCalculation.riskDistance : estimateAtr();
  const rewardR = previousCalculation.valid ? previousCalculation.rewardR : 2.2;
  plan.side = nextSide;
  plan.auto = false;
  plan.entry = entry;
  plan.sl = roundPrice(nextSide === "long" ? entry - risk : entry + risk);
  plan.tp = roundPrice(nextSide === "long" ? entry + risk * rewardR : entry - risk * rewardR);
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
}

function initializePlanTimeRangeFromTool(plan, tool) {
  if (Number.isFinite(plan.startTime) && Number.isFinite(plan.endTime)) return true;
  const left = Number(tool?.dataset.leftPx);
  const right = Number(tool?.dataset.rightPx);
  const startTime = snapToCandleTime(positionTimeAtCoordinate(left));
  const endTime = positionTimeAtCoordinate(right);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return false;
  plan.startTime = startTime;
  plan.endTime = endTime;
  plan.entryTime = startTime;
  return true;
}

function beginPositionWidthDrag(event) {
  if (!state.chart) return;
  const handle = event.target.closest("[data-width-edge][data-plan-id]");
  if (!handle || event.button !== 0) return;
  const plan = state.plans.find((item) => item.id === handle.dataset.planId);
  const tool = handle.closest(".position-tool");
  if (!plan || !tool || !initializePlanTimeRangeFromTool(plan, tool)) return;

  event.preventDefault();
  event.stopPropagation();
  plan.auto = false;
  state.selectedPlanId = plan.id;
  state.selectedOverlayId = null;
  state.chartView = "selected";
  updateChartViewControls();
  updateSelectionState();
  handle.setPointerCapture?.(event.pointerId);
  handle.classList.add("is-dragging");
  document.body.classList.add("is-width-dragging");
  state.widthDragging = {
    edge: handle.dataset.widthEdge,
    handle,
    planId: plan.id,
    pointerId: event.pointerId,
    chartRect: dom.chartWrap.getBoundingClientRect(),
  };
  state.chart.applyOptions({ handleScroll: false, handleScale: false });
}

function movePositionWidthDrag(event) {
  if (!state.widthDragging || event.pointerId !== state.widthDragging.pointerId) return;
  const { edge, planId, chartRect } = state.widthDragging;
  const plan = state.plans.find((item) => item.id === planId);
  const tool = [...dom.orderLevels.children].find((item) => item.dataset.planId === planId);
  if (!plan || !tool) return;

  const plotRight = Math.max(120, chartRect.width - priceAxisWidth());
  const otherX = Number(tool.dataset[edge === "start" ? "rightPx" : "leftPx"]);
  let x = Math.max(0, Math.min(plotRight, event.clientX - chartRect.left));
  x = edge === "start"
    ? Math.min(x, otherX - MIN_POSITION_WIDTH)
    : Math.max(x, otherX + MIN_POSITION_WIDTH);
  const time = positionTimeAtCoordinate(x);
  if (!Number.isFinite(time)) return;
  if (edge === "start") {
    plan.startTime = snapToCandleTime(time);
    plan.entryTime = plan.startTime;
    dom.selectedEntryTime.textContent = `Entry ${formatOrderTime(plan.entryTime)}`;
    dom.selectedEntryTime.dateTime = new Date(plan.entryTime).toISOString();
    const chartTime = tool.querySelector("[data-position-entry-time]");
    if (chartTime) chartTime.textContent = formatOrderTime(plan.entryTime);
  } else {
    plan.endTime = time;
  }
  scheduleOverlayRender(ORDER_OVERLAY);
}

function endPositionWidthDrag(event) {
  if (!state.widthDragging) return;
  if (event.pointerId !== undefined && event.pointerId !== state.widthDragging.pointerId) return;
  state.widthDragging.handle.classList.remove("is-dragging");
  state.widthDragging.handle.releasePointerCapture?.(state.widthDragging.pointerId);
  document.body.classList.remove("is-width-dragging");
  state.widthDragging = null;
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  restoreChartNavigation();
}

function adjustPositionWidthWithKeyboard(event) {
  const handle = event.target.closest("[data-width-edge][data-plan-id]");
  if (!handle || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const plan = state.plans.find((item) => item.id === handle.dataset.planId);
  const tool = handle.closest(".position-tool");
  if (!plan || !tool || !initializePlanTimeRangeFromTool(plan, tool)) return;
  event.preventDefault();
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  const delta = candleIntervalMs() * direction * (event.shiftKey ? 5 : 1);
  if (handle.dataset.widthEdge === "start") {
    plan.startTime = Math.min(plan.endTime - candleIntervalMs(), plan.startTime + delta);
    plan.entryTime = plan.startTime;
  } else {
    plan.endTime = Math.max(plan.startTime + candleIntervalMs(), plan.endTime + delta);
  }
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  scheduleOverlayRender(ORDER_OVERLAY);
}

function beginLevelDrag(event) {
  if (!state.candleSeries) return;
  const button = event.target.closest("[data-level][data-plan-id]");
  if (!button) return;
  const plan = state.plans.find((item) => item.id === button.dataset.planId);
  if (!plan) return;
  plan.auto = false;
  state.selectedPlanId = plan.id;
  state.selectedOverlayId = null;
  state.chartView = "selected";
  updateChartViewControls();
  syncPlanInputs();
  updateSelectionState();
  updatePlanVisuals();
  const rect = dom.chartWrap.getBoundingClientRect();
  const y = Math.min(rect.height * 0.75, Math.max(8, event.clientY - rect.top));
  const startPrice = state.candleSeries.coordinateToPrice(y);
  if (!Number.isFinite(startPrice)) return;

  event.preventDefault();
  event.stopPropagation();
  button.setPointerCapture?.(event.pointerId);
  button.classList.add("is-dragging");
  document.body.classList.add("is-dragging");
  state.dragging = {
    level: button.dataset.level,
    button,
    planId: plan.id,
    pointerId: event.pointerId,
    startPrice,
    chartRect: rect,
    startPlan: { entry: plan.entry, sl: plan.sl, tp: plan.tp },
  };
  state.chart.applyOptions({ handleScroll: false, handleScale: false });
}

function applyLevelDrag(event) {
  if (!state.dragging || !state.candleSeries) return;
  const rect = state.dragging.chartRect;
  const y = Math.min(rect.height * 0.75, Math.max(8, event.clientY - rect.top));
  const price = state.candleSeries.coordinateToPrice(y);
  if (!Number.isFinite(price)) return;

  const { level, planId, startPrice, startPlan } = state.dragging;
  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) return;
  if (level === "entry") {
    const delta = price - startPrice;
    plan.entry = roundPrice(startPlan.entry + delta);
    plan.sl = roundPrice(startPlan.sl + delta);
    plan.tp = roundPrice(startPlan.tp + delta);
  } else {
    plan[level] = roundPrice(price);
  }
  syncPlanPriceInputs(plan);
  updatePlanVisuals();
}

function moveLevelDrag(event) {
  if (!state.dragging || event.pointerId !== state.dragging.pointerId) return;
  state.pendingLevelDrag = { clientY: event.clientY, pointerId: event.pointerId };
  if (state.levelDragFrame !== null) return;
  state.levelDragFrame = window.requestAnimationFrame(() => {
    state.levelDragFrame = null;
    const pending = state.pendingLevelDrag;
    state.pendingLevelDrag = null;
    if (pending) applyLevelDrag(pending);
  });
}

function flushLevelDrag() {
  if (state.levelDragFrame !== null) window.cancelAnimationFrame(state.levelDragFrame);
  state.levelDragFrame = null;
  const pending = state.pendingLevelDrag;
  state.pendingLevelDrag = null;
  if (pending) applyLevelDrag(pending);
}

function endLevelDrag(event) {
  if (!state.dragging) return;
  if (event.pointerId !== undefined && event.pointerId !== state.dragging.pointerId) return;
  if (event.type === "pointerup" && Number.isFinite(event.clientY)) {
    state.pendingLevelDrag = { clientY: event.clientY, pointerId: state.dragging.pointerId };
  }
  flushLevelDrag();
  state.dragging.button.classList.remove("is-dragging");
  state.dragging.button.releasePointerCapture?.(state.dragging.pointerId);
  document.body.classList.remove("is-dragging");
  state.dragging = null;
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
  state.chart.applyOptions({
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });
}

function adjustLevelWithKeyboard(event) {
  const button = event.target.closest("[data-level][data-plan-id]");
  if (!button || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  const plan = state.plans.find((item) => item.id === button.dataset.planId);
  if (!plan) return;
  event.preventDefault();
  plan.auto = false;
  state.selectedPlanId = plan.id;
  state.selectedOverlayId = null;
  state.chartView = "selected";
  const direction = event.key === "ArrowUp" ? 1 : -1;
  const step = Math.max(0.1, Math.abs(plan.entry) * 0.00025);
  const delta = direction * step;
  if (button.dataset.level === "entry") {
    plan.entry = roundPrice(plan.entry + delta);
    plan.sl = roundPrice(plan.sl + delta);
    plan.tp = roundPrice(plan.tp + delta);
  } else {
    plan[button.dataset.level] = roundPrice(plan[button.dataset.level] + delta);
  }
  persistDraftPlans();
  renderDraftPlans();
  syncPlanInputs();
  updatePlanVisuals();
  const tool = [...dom.orderLevels.children].find((item) => item.dataset.planId === plan.id);
  tool?.querySelector(`[data-level="${button.dataset.level}"]`)?.focus();
}

function loadOrders() {
  try {
    const stored = JSON.parse(readScopedStorage(STORAGE_KEY, "[]"));
    state.orders = Array.isArray(stored)
      ? stored
        .filter((order) => order && order.id)
        .map((order) => {
          const entryTime = leftEdgeEntryTime(order);
          return { ...order, entryTime, startTime: entryTime };
        })
      : [];
  } catch {
    state.orders = [];
  }
  renderOrders();
}

function persistOrders() {
  try {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY), JSON.stringify(state.orders));
  } catch {
    showToast("Trình duyệt không cho phép lưu local ở chế độ hiện tại.");
  }
}

function makeOrderId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function snapshotDrawingsForPlan(plan) {
  const planStart = Math.min(plan.startTime ?? plan.entryTime, plan.endTime ?? plan.entryTime);
  const planEnd = Math.max(plan.startTime ?? plan.entryTime, plan.endTime ?? plan.entryTime);
  return state.drawings
    .filter((drawing) => {
      if (drawing.linkedPlanId) return drawing.linkedPlanId === plan.id;
      if (drawing.type !== "rectangle") return false;
      const drawingStart = Math.min(drawing.startTime, drawing.endTime);
      const drawingEnd = Math.max(drawing.startTime, drawing.endTime);
      const priceLow = Math.min(drawing.startPrice, drawing.endPrice);
      const priceHigh = Math.max(drawing.startPrice, drawing.endPrice);
      return drawingStart <= planEnd && drawingEnd >= planStart && plan.entry >= priceLow && plan.entry <= priceHigh;
    })
    .map((drawing) => ({ ...drawing }));
}

function saveOrder(event) {
  event.preventDefault();
  const plan = currentPlan();
  const calculation = calculatePlan(plan);
  if (!plan || !calculation.valid) return;
  const drawings = snapshotDrawingsForPlan(plan);
  const entryTime = leftEdgeEntryTime(plan);

  state.orders.unshift({
    id: makeOrderId(),
    symbol: state.symbol,
    createdAt: new Date().toISOString(),
    entryTime,
    startTime: entryTime,
    endTime: plan.endTime,
    side: plan.side,
    entry: plan.entry,
    sl: plan.sl,
    tp: plan.tp,
    rewardR: Number(calculation.rewardR.toFixed(4)),
    riskPercent: Number(calculation.riskPercent.toFixed(4)),
    sourcePlanId: plan.id,
    drawingIds: drawings.map((drawing) => drawing.id),
    drawings,
    note: plan.note.trim(),
    status: "planned",
  });
  persistOrders();
  renderOrders();
  const entryZoneCount = drawings.filter((drawing) => drawing.type === "rectangle").length;
  persistPlaybookJson({
    successMessage: `Đã lưu ${getPlanLabel(plan)} · ${plan.side.toUpperCase()} · TP ${formatR(calculation.rewardR)} · SL −1R${entryZoneCount ? ` · ${entryZoneCount} vùng entry` : ""}`,
  });
}

function formatOrderTime(isoTime) {
  if (isoTime === null || isoTime === undefined || isoTime === "") return "—";
  const date = new Date(isoTime);
  const parts = dateTimeParts(date.getTime());
  return parts ? `${parts.hour}:${parts.minute} ${parts.day}-${parts.month}` : "—";
}

function orderResultOptions(order) {
  const options = [
    ["planned", "Kế hoạch"],
    ["open", "Đang mở"],
    ["tp", `TP ${formatR(order.rewardR)}`],
    ["sl", "SL −1.00R"],
    ["be", "Hòa vốn"],
    ["canceled", "Đã hủy"],
  ];
  return options
    .map(([value, label]) => `<option value="${value}"${order.status === value ? " selected" : ""}>${label}</option>`)
    .join("");
}

function renderOrders() {
  dom.emptyJournal.hidden = state.orders.length > 0;
  dom.ordersBody.innerHTML = state.orders
    .map((order) => {
      const sideLabel = order.side === "long" ? "LONG" : "SHORT";
      const note = order.note ? ` aria-label="${escapeHtml(order.note)}"` : "";
      const chartActive = state.selectedOverlayId === `saved:${order.id}` ||
        (!state.selectedOverlayId && order.sourcePlanId === state.selectedPlanId);
      return `
        <tr data-order-id="${escapeHtml(order.id)}" class="${chartActive ? "is-chart-active" : ""}"${note}>
          <td>${formatOrderTime(leftEdgeEntryTime(order))}</td>
          <td><span class="side-pill ${order.side}">${sideLabel}</span></td>
          <td>${formatPrice(Number(order.entry))}</td>
          <td>${formatPrice(Number(order.sl))}</td>
          <td>${formatPrice(Number(order.tp))}</td>
          <td>1:${Number(order.rewardR).toFixed(2)}</td>
          <td>
            <select class="result-select status-${escapeHtml(order.status)}" data-action="status" aria-label="Kết quả lệnh ${sideLabel}">
              ${orderResultOptions(order)}
            </select>
          </td>
          <td>
            <div class="row-actions">
              <button class="row-action" type="button" data-action="focus-saved">Xem riêng</button>
              <button class="row-action" type="button" data-action="load">Sửa</button>
              <button class="row-action delete" type="button" data-action="delete">Xóa</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
  updateJournalMetrics();
  renderPlanTools();
}

function resultR(order) {
  if (order.status === "tp") return Number(order.rewardR);
  if (order.status === "sl") return -1;
  if (order.status === "be") return 0;
  return null;
}

function updateJournalMetrics() {
  const closed = state.orders
    .map((order) => ({ ...order, resultR: resultR(order) }))
    .filter((order) => order.resultR !== null);
  const wins = closed.filter((order) => order.resultR > 0);
  const netR = closed.reduce((total, order) => total + order.resultR, 0);
  const expectancy = closed.length ? netR / closed.length : null;

  dom.closedCount.textContent = String(closed.length);
  dom.winRate.textContent = closed.length ? `${((wins.length / closed.length) * 100).toFixed(0)}%` : "—";
  dom.netR.textContent = formatR(netR);
  dom.netR.classList.toggle("is-positive", netR > 0);
  dom.netR.classList.toggle("is-negative", netR < 0);
  dom.expectancy.textContent = expectancy === null ? "—" : `${formatR(expectancy)}/lệnh`;
  dom.expectancy.classList.toggle("is-positive", expectancy > 0);
  dom.expectancy.classList.toggle("is-negative", expectancy < 0);
  updateMethodInsight(closed, expectancy);
}

function updateMethodInsight(closed, expectancy) {
  if (closed.length === 0) {
    dom.methodInsight.textContent = "Hãy lưu kế hoạch và đánh dấu TP/SL. Sau một mẫu lệnh đủ lớn, khu vực này sẽ so sánh kỳ vọng R và hướng giao dịch.";
    return;
  }
  if (closed.length < 10) {
    dom.methodInsight.textContent = `Đã có ${closed.length} lệnh đóng. Cần thêm ${10 - closed.length} lệnh để có tín hiệu sơ bộ; chưa nên thay đổi phương pháp từ mẫu nhỏ này.`;
    return;
  }

  const sideAverage = (side) => {
    const sample = closed.filter((order) => order.side === side);
    if (sample.length < 3) return null;
    return sample.reduce((sum, order) => sum + order.resultR, 0) / sample.length;
  };
  const longAverage = sideAverage("long");
  const shortAverage = sideAverage("short");
  let comparison = "Chưa đủ dữ liệu cân bằng để so LONG với SHORT.";
  if (longAverage !== null && shortAverage !== null) {
    const stronger = longAverage >= shortAverage ? "LONG" : "SHORT";
    const spread = Math.abs(longAverage - shortAverage);
    comparison = spread >= 0.2
      ? `${stronger} đang có expectancy tốt hơn ${spread.toFixed(2)}R/lệnh.`
      : "Expectancy LONG và SHORT hiện khá sát nhau.";
  }
  dom.methodInsight.textContent = `Mẫu ${closed.length} lệnh có expectancy ${formatR(expectancy)}/lệnh. ${comparison} Tiếp tục thu thập ít nhất 30 lệnh trước khi chốt rule.`;
}

function handleOrderTableChange(event) {
  const select = event.target.closest('[data-action="status"]');
  if (!select) return;
  const row = select.closest("[data-order-id]");
  const order = state.orders.find((item) => item.id === row?.dataset.orderId);
  if (!order) return;
  order.status = select.value;
  select.className = `result-select status-${select.value}`;
  persistOrders();
  updateJournalMetrics();
  renderPlanTools();
  persistPlaybookJson();
}

function focusSavedOrder(order) {
  const sourcePlan = state.plans.find((plan) => plan.id === order.sourcePlanId);
  if (sourcePlan) selectPlan(sourcePlan.id);
  else selectReadOnlyOverlay(`saved:${order.id}`);
  const startTime = leftEdgeEntryTime(sourcePlan || order);
  const endTime = Number(sourcePlan?.endTime ?? order.endTime);
  if (state.chart && Number.isFinite(startTime)) {
    const visibleEnd = Number.isFinite(endTime) && endTime > startTime
      ? endTime
      : startTime + candleIntervalMs() * 24;
    const padding = Math.max(candleIntervalMs() * 12, (visibleEnd - startTime) * 0.2);
    state.chart.timeScale().setVisibleRange({
      from: Math.floor((startTime - padding) / 1000),
      to: Math.ceil((visibleEnd + padding) / 1000),
    });
  } else {
    const from = Math.max(0, state.candles.length - 185);
    state.chart?.timeScale().setVisibleLogicalRange({ from, to: state.candles.length + 8 });
  }
  document.querySelector("#chart-section").scrollIntoView({ behavior: "smooth", block: "start" });
  scheduleOverlayRender();
}

function handleOrderTableClick(event) {
  const action = event.target.closest("[data-action]");
  if (action?.matches("select")) return;
  const row = event.target.closest("[data-order-id]");
  const index = state.orders.findIndex((item) => item.id === row?.dataset.orderId);
  if (index < 0) return;
  const order = state.orders[index];

  if (!action || action.dataset.action === "focus-saved") {
    focusSavedOrder(order);
    return;
  }

  if (action.dataset.action === "load") {
    addPlan(order.side, { source: order, silent: true });
    document.querySelector("#chart-section").scrollIntoView({ behavior: "smooth", block: "start" });
    showToast("Đã thêm lệnh đã lưu thành một vị thế mới trên biểu đồ.");
  }

  if (action.dataset.action === "delete") {
    if (state.selectedOverlayId === `saved:${order.id}`) {
      state.selectedOverlayId = null;
      if (state.chartView === "selected") state.chartView = "clean";
    }
    state.orders.splice(index, 1);
    persistOrders();
    renderOrders();
    persistPlaybookJson();
    showToast("Đã xóa lệnh mẫu và cập nhật JSON.");
  }
}

function handleDraftListClick(event) {
  const action = event.target.closest("[data-action][data-plan-id]");
  if (!action) return;
  if (action.dataset.action === "select-plan") selectPlan(action.dataset.planId);
  if (action.dataset.action === "delete-plan") deletePlan(action.dataset.planId);
}

function handleOrderToolClick(event) {
  const overlay = event.target.closest("[data-overlay-id]");
  if (overlay) {
    selectReadOnlyOverlay(overlay.dataset.overlayId);
    return;
  }
  const control = event.target.closest("[data-plan-id]");
  if (control) selectPlan(control.dataset.planId);
}

function changeSymbol(nextSymbol) {
  const next = String(nextSymbol || "").trim().toUpperCase();
  if (!SUPPORTED_SYMBOLS.includes(next) || next === state.symbol) return;

  flushDraftPlanPersistence();
  state.marketController?.abort();
  state.symbol = next;
  state.marketMeta = defaultMarketMeta();
  state.candles = [];
  state.candleIndexByTime = new Map();
  state.volumeByTime.clear();
  state.strategyTrades = [];
  state.strategyAuditLoaded = false;
  state.userFeedback = [];
  state.keyVerdicts = [];
  state.selectedKeyId = null;
  state.plans = [];
  state.orders = [];
  state.drawings = [];
  state.plansInitialized = false;
  state.selectedPlanId = null;
  state.selectedOverlayId = null;
  state.positionPlacement = null;
  if (state.chartView === "selected") state.chartView = "clean";
  state.selectedDrawingId = null;
  state.drawingDraft = null;
  state.dragging = null;

  state.candleSeries?.setData([]);
  state.candleSeries?.setMarkers([]);
  state.volumeSeries?.setData([]);
  state.rsiSeries?.setData([]);
  setActiveMethods(methodsForSymbol(next));
  updateInstrumentUi();
  loadDraftPlans();
  loadDrawings();
  loadOrders();
  loadUserFeedback();
  loadKeyVerdicts();
  renderKeyJudgeCard();
  state.playbookSaveQueue = hydrateFromPlaybookFile();
  renderDraftPlans();
  renderDrawings();
  updatePositionPlacementControls();
  updateChartViewControls();
  syncPlanInputs();
  updatePlanVisuals();
  setStrategyEmpty(
    `Đang replay ${methodLabel(state.activeMethods)}…`,
    `Đang tải nến ${next} và tính lại toàn bộ entry.`,
    true,
  );
  loadMarketData({ notify: true });
}

function bindEvents() {
  dom.feedbackForm.addEventListener("submit", saveUserFeedback);
  dom.feedbackClose.addEventListener("click", closeUserFeedback);
  dom.feedbackCancel.addEventListener("click", closeUserFeedback);
  dom.feedbackDelete.addEventListener("click", deleteUserFeedback);
  for (const input of [dom.entryInput, dom.slInput, dom.tpInput]) {
    input.addEventListener("input", readPlanInputs);
    input.addEventListener("change", () => {
      readPlanInputs();
      syncPlanInputs();
    });
  }

  for (const button of dom.sideButtons) {
    button.addEventListener("click", () => setSide(button.dataset.side));
  }

  for (const button of dom.chartViewButtons) {
    button.addEventListener("click", () => setChartView(button.dataset.chartView));
  }

  for (const button of dom.dockControls) {
    button.addEventListener("click", () => {
      const panel = button.dataset.dockPanel;
      setDockPanel(panel !== "closed" && state.dockPanel === panel ? "closed" : panel);
    });
  }

  dom.addLongPlan.addEventListener("click", () => armPositionPlacement("long"));
  dom.addShortPlan.addEventListener("click", () => armPositionPlacement("short"));
  dom.positionPlacementLayer.addEventListener("click", placePositionOnChart);
  dom.positionPlacementLayer.addEventListener("keydown", placePositionOnChart);
  dom.draftOrderList.addEventListener("click", handleDraftListClick);
  dom.orderLevels.addEventListener("click", handleOrderToolClick);
  dom.orderLevels.addEventListener("pointerover", (event) => {
    const tool = event.target.closest(".readonly-position-tool, .position-tool");
    if (tool) tool.classList.add("is-hovered");
  });
  dom.orderLevels.addEventListener("pointerout", (event) => {
    const tool = event.target.closest(".readonly-position-tool, .position-tool");
    if (tool && (!event.relatedTarget || !tool.contains(event.relatedTarget))) {
      tool.classList.remove("is-hovered");
    }
  });
  dom.orderLevels.addEventListener("pointerdown", beginLevelDrag);
  dom.orderLevels.addEventListener("pointerdown", beginPositionWidthDrag);
  dom.orderLevels.addEventListener("keydown", adjustLevelWithKeyboard);
  dom.orderLevels.addEventListener("keydown", adjustPositionWidthWithKeyboard);
  for (const button of dom.drawingModeButtons) {
    button.addEventListener("click", () => setDrawingMode(button.dataset.drawingMode));
  }
  dom.deleteDrawing.addEventListener("click", deleteSelectedDrawing);
  dom.drawingLayer.addEventListener("pointerdown", beginDrawing);
  dom.drawingLayer.addEventListener("click", handleDrawingClick);
  dom.drawingLayer.addEventListener("keydown", handleDrawingKeyDown);
  dom.drawingLayer.addEventListener("keyup", handleDrawingKeyUp);
  window.addEventListener("pointermove", moveLevelDrag);
  window.addEventListener("pointermove", movePositionWidthDrag);
  window.addEventListener("pointermove", moveDrawing);
  window.addEventListener("pointerup", endLevelDrag);
  window.addEventListener("pointerup", endPositionWidthDrag);
  window.addEventListener("pointerup", finishDrawing);
  window.addEventListener("pointercancel", endLevelDrag);
  window.addEventListener("pointercancel", endPositionWidthDrag);
  window.addEventListener("pointercancel", cancelDrawingDraft);
  document.addEventListener("keydown", handleGlobalDrawingKey, { capture: true });

  dom.orderForm.addEventListener("submit", saveOrder);
  dom.resetPlan.addEventListener("click", resetPlanAroundMarket);
  dom.noteInput.addEventListener("input", () => {
    const plan = currentPlan();
    if (!plan) return;
    plan.note = dom.noteInput.value;
    plan.auto = false;
    scheduleDraftPlanPersistence();
  });
  dom.fitChart.addEventListener("click", resetChartView);
  dom.reloadChart.addEventListener("click", () => loadMarketData({ notify: true }));
  for (const button of dom.historyButtons) {
    button.addEventListener("click", () => setHistoryDays(Number(button.dataset.historyDays)));
  }
  bindTerminalChrome();
  dom.ordersBody.addEventListener("change", handleOrderTableChange);
  dom.ordersBody.addEventListener("click", handleOrderTableClick);
  dom.strategyBody.addEventListener("click", handleStrategyTableClick);
  dom.keyvolBody.addEventListener("click", handleKeyVolumeTableClick);

  dom.fxdreamCardList?.addEventListener("click", handleFxdreamRailClick);
  for (const button of dom.fxdreamFilterButtons) {
    button.addEventListener("click", () => setFxdreamFilter(button.dataset.fxdreamFilter));
  }
  dom.keyvolFunnel?.addEventListener("click", handleFunnelClick);
  dom.layerMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    setLayerMenuOpen(!state.layerMenuOpen);
  });
  dom.layerMenuList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-chart-layer]");
    if (!row) return;
    // Phải chặn nổi bọt: `renderLayerMenu` thay innerHTML ngay trong lượt click này,
    // nên khi event lên tới document thì node đã rời DOM và handler "bấm ra ngoài"
    // tưởng là click bên ngoài rồi đóng bảng — không tắt được lớp thứ hai.
    event.stopPropagation();
    toggleChartLayer(row.dataset.chartLayer);
  });
  // Bấm ra ngoài thì đóng bảng lớp; không có cái này thì nó che mất chart.
  document.addEventListener("click", (event) => {
    if (!state.layerMenuOpen) return;
    if (dom.layerMenu?.contains(event.target)) return;
    setLayerMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.layerMenuOpen) setLayerMenuOpen(false);
  });

  dom.keyvolPower.addEventListener("click", () => {
    state.keyvolFilters.enabled = !state.keyvolFilters.enabled;
    dom.keyvolPower.classList.toggle("is-active", state.keyvolFilters.enabled);
    dom.keyvolPower.setAttribute("aria-pressed", String(state.keyvolFilters.enabled));
    scheduleOverlayRender(KEYVOL_OVERLAY);
  });
  for (const button of dom.keyvolTfButtons) {
    button.addEventListener("click", () => {
      const tf = button.dataset.keyvolTf;
      if (state.keyvolFilters.tfs.has(tf)) state.keyvolFilters.tfs.delete(tf);
      else state.keyvolFilters.tfs.add(tf);
      const active = state.keyvolFilters.tfs.has(tf);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      scheduleOverlayRender(KEYVOL_OVERLAY);
    });
  }
  dom.keyvolMinRatio.addEventListener("input", () => {
    state.keyvolFilters.minRatio = Number(dom.keyvolMinRatio.value);
    dom.keyvolMinRatioOut.textContent = String(state.keyvolFilters.minRatio);
    scheduleOverlayRender(KEYVOL_OVERLAY);
  });
  dom.keyvolUnbroken.addEventListener("change", () => {
    state.keyvolFilters.unbrokenOnly = dom.keyvolUnbroken.checked;
    scheduleOverlayRender(KEYVOL_OVERLAY);
  });

  dom.keyvolLayer.addEventListener("click", (event) => {
    const hit = event.target.closest("[data-key-id]");
    if (hit) selectKeyLevel(hit.dataset.keyId);
  });
  for (const button of dom.keyjudgeVerdicts) {
    button.addEventListener("click", () => saveKeyVerdict(button.dataset.keyVerdict));
  }
  dom.keyjudgeNote.addEventListener("input", () => {
    window.clearTimeout(state.keyNoteTimer);
    dom.keyjudgeSaved.textContent = "Đang gõ…";
    state.keyNoteTimer = window.setTimeout(updateKeyVerdictNote, 700);
  });
  dom.keyjudgeDelete.addEventListener("click", deleteKeyVerdict);
  dom.keyjudgeClear.addEventListener("click", () => {
    state.selectedKeyId = null;
    renderKeyJudgeCard();
    scheduleOverlayRender(KEYVOL_OVERLAY);
  });

  dom.evidenceClear.addEventListener("click", clearEvidence);
  dom.evidenceList.addEventListener("pointerover", (event) => {
    const item = event.target.closest("[data-evidence-index]");
    if (item) setEvidenceHover(Number(item.dataset.evidenceIndex));
  });
  dom.evidenceList.addEventListener("focusin", (event) => {
    const item = event.target.closest("[data-evidence-index]");
    if (item) setEvidenceHover(Number(item.dataset.evidenceIndex));
  });
  dom.evidenceList.addEventListener("pointerleave", () => setEvidenceHover(state.evidencePinned));
  dom.evidenceList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-evidence-index]");
    if (item) toggleEvidencePin(Number(item.dataset.evidenceIndex));
  });

  for (const button of dom.strategyFilterButtons) {
    button.addEventListener("click", () => setStrategyFilter(button.dataset.strategyFilter));
  }

  window.addEventListener("pagehide", flushDraftPlanPersistence);
}

function setHistoryDays(days) {
  if (!Number.isFinite(days) || days === state.historyDays) return;
  state.historyDays = days;
  for (const button of dom.historyButtons) {
    const active = Number(button.dataset.historyDays) === days;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  dom.auditRangeLabel.textContent = `${state.historyDays} ngày`;
  state.strategyAuditLoaded = false;
  setStrategyEmpty("Đang replay Turtle và Fast…", `Đang tải ${state.historyDays} ngày nến và tính lại toàn bộ entry.`, true);
  loadMarketData({ notify: true });
}

/** Thanh trên, thanh dưới chart, danh sách theo dõi và dải nút bảng phải. */
function bindTerminalChrome() {
  dom.symbolButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setSymbolMenuOpen(!state.symbolMenuOpen);
  });
  dom.symbolSearch.addEventListener("input", filterSymbolOptions);
  dom.symbolSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = dom.symbolOptions.find((option) => !option.hidden);
    if (first) pickSymbol(first.dataset.symbol);
  });
  for (const option of dom.symbolOptions) {
    option.addEventListener("click", () => pickSymbol(option.dataset.symbol));
  }
  document.addEventListener("click", (event) => {
    if (state.symbolMenuOpen && !dom.symbolSearchWrap.contains(event.target)) setSymbolMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.symbolMenuOpen) {
      setSymbolMenuOpen(false);
      dom.symbolButton.focus();
    }
    // Alt+R: đặt lại chart như TradingView. Bỏ qua khi đang gõ trong ô nhập.
    if (event.altKey && event.code === "KeyR" && !event.target.closest?.("input, textarea, select")) {
      event.preventDefault();
      resetChartView();
    }
  });

  for (const row of dom.watchlistRows) {
    row.addEventListener("click", () => changeSymbol(row.dataset.symbol));
  }
  for (const button of dom.sideViewButtons) {
    button.addEventListener("click", () => setSideView(button.dataset.sideView));
  }

  for (const button of dom.chartNavButtons) {
    button.addEventListener("click", () => handleChartNav(button.dataset.chartNav));
  }
  dom.chartRealtime.addEventListener("click", () => {
    state.chart?.timeScale().scrollToRealTime();
    scheduleOverlayRender();
  });
  dom.scaleAuto.addEventListener("click", toggleAutoScale);
  dom.scaleLog.addEventListener("click", () => togglePriceScaleMode("log"));
  dom.scalePercent.addEventListener("click", () => togglePriceScaleMode("percent"));
  dom.chartFullscreen.addEventListener("click", toggleFullscreen);

  tickChartClock();
  window.setInterval(tickChartClock, 1000);
  loadTickers();
  window.setInterval(loadTickers, WATCHLIST_REFRESH_MS);
}

function bootstrap() {
  updateInstrumentUi();
  loadDraftPlans();
  loadDrawings();
  loadUserFeedback();
  loadKeyVerdicts();
  renderKeyJudgeCard();
  state.playbookSaveQueue = hydrateFromPlaybookFile();
  bindEvents();
  renderLayerMenu();
  renderFxdreamRail();
  loadOrders();
  updateChartViewControls();
  updatePositionPlacementControls();
  syncPlanInputs();
  if (!initChart()) return;
  syncScaleButtons();
  setSourceState("demo", "Chờ Binance Futures");
  setChartData(generatePreviewCandles(), "demo");
  loadMarketData();
}

bootstrap();
