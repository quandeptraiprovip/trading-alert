/**
 * fxdream-live.ts — FX Dream (key-volume.ts) chạy THẬT trên Binance Futures, CÓ HỎI Ý trước khi vào.
 *
 * Luồng (user 04/10/26):
 *   1. Mỗi nến M15 đóng: chạy engine trên cửa sổ nến gần nhất, lấy tín hiệu Ở ĐÚNG nến vừa đóng.
 *      Hai loại: vào ở GIÁ ĐÓNG (trap, key + cụm) và LỆNH CHỜ ở mép order block (nhánh quét,
 *      nhánh đỉnh thấp dần). SL/TP/cửa vào lệnh tính bằng `resolveEntryLevels` — đúng hàm backtest.
 *   2. Gửi ẢNH + ba nút ✅/✏️/❌. Bạn bấm ✅ thì mới đặt lệnh. ✏️ cho gõ giá entry/SL/TP mới
 *      (sửa entry của lệnh vào ở giá đóng thì thành LIMIT), bot vẽ lại ảnh rồi hỏi lại.
 *        · Vào ở giá đóng: chỉ trong 15 phút sau khi nến đóng, giá chưa vượt SL/TP (user 07/10/26: bỏ trần
 *          lệch 0,3R). Khối lượng + đòn bẩy tính lại theo khoảng SL từ giá thật, rủi ro vẫn giữ `riskUsd`.
 *        · Lệnh chờ: đồng ý lúc nào cũng được trong thời gian sống của lệnh chờ (16 nến), giá chưa
 *          vượt SL/TP thì đặt LIMIT ở mép.
 *      00:00–06:00 (giờ VN, tính theo lúc nến tín hiệu đóng): TỰ VÀO, không hỏi, rồi báo.
 *   3. Khớp xong: SL (STOP_MARKET closePosition), TP ở mục tiêu (closePosition), chốt 33% ở +1R
 *      (reduceOnly) nếu mục tiêu xa hơn 1R. Chốt 33% khớp thì dời SL về giá vào.
 *   4. Rủi ro cố định `riskUsd` mỗi lệnh bạn duyệt; lệnh TỰ VÀO ban đêm chỉ một nửa. Một lệnh mỗi lúc: đang có vị thế hoặc lệnh chờ thì tín
 *      hiệu mới chỉ báo chữ.
 *
 * AN TOÀN:
 *   · Không bao giờ để vị thế trần: đặt SL lỗi → đóng khẩn cấp.
 *   · Không replay nến cũ khi khởi động — chỉ xét tín hiệu ở nến đóng SAU lúc bot chạy.
 *   · Trên sàn có vị thế/lệnh của mã mà state không biết (vd Turtle cũ) → KHOÁ, báo, không đụng tới.
 *
 * Nhiều mã (user 06/10/26: thêm vàng XAUUSDT): mỗi mã một instance, state/journal riêng
 * (`stateName`), id đề nghị mang tiền tố mã (`owns`). Vàng bỏ nến lúc thị trường thật đóng cửa
 * (`marketClosed`) và giờ đầu sau khi mở lại luôn hỏi ý.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { atomicWriteFileSync } from "./atomic-file";
import { TF_MS } from "./strategy";
import type { Candle } from "./strategy";
import type { NewOrderResult, OrderSide, PositionRisk, SymbolFilters, UserTrade } from "./binance-futures";
import {
  KEY_VOLUME_CONFIG,
  KeyVolumeEntryPlan,
  KeyVolumeParams,
  atrSeriesForward,
  isKeyVolumeLevelActive,
  resolveEntryLevels,
  runKeyVolumeCandidates,
} from "./key-volume";
import {
  InlineButton,
  TelegramCallback,
  TelegramConfig,
  answerTelegramCallback,
  editTelegramCaption,
  sendTelegram,
  sendTelegramPhoto,
} from "./telegram";
import { buildProposalSvg, renderPng, ProposalMark } from "./fxdream-image";

/** Phần BinanceFutures mà module dùng — test thay bằng sàn giả. */
export interface FxVenue {
  getFilters(symbol: string): SymbolFilters;
  roundQty(symbol: string, qty: number): number;
  roundPrice(symbol: string, price: number): number;
  getEquity(): Promise<{ walletBalance: number; available: number }>;
  getPosition(symbol: string): Promise<PositionRisk>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  marketOrder(symbol: string, side: OrderSide, qty: number, clientId?: string): Promise<NewOrderResult>;
  marketClose(symbol: string, side: OrderSide, qty: number, clientId?: string): Promise<NewOrderResult>;
  limitOrder(symbol: string, side: OrderSide, qty: number, price: number, clientId?: string): Promise<NewOrderResult>;
  getOrder(symbol: string, orderId: number): Promise<NewOrderResult>;
  cancelOrder(symbol: string, orderId: number): Promise<void>;
  stopMarketClose(symbol: string, side: OrderSide, stopPrice: number, clientId?: string): Promise<number>;
  takeProfitMarketClose(symbol: string, side: OrderSide, stopPrice: number, clientId?: string): Promise<number>;
  takeProfitMarketReduce(symbol: string, side: OrderSide, stopPrice: number, qty: number, clientId?: string): Promise<number>;
  cancelAlgoOrder(algoId: number): Promise<void>;
  cancelAllOpenOrders(symbol: string): Promise<void>;
  cancelAllAlgoOpenOrders(symbol: string): Promise<void>;
  getOpenOrders(symbol: string): Promise<any[]>;
  getOpenAlgoOrders(symbol: string): Promise<any[]>;
  getUserTrades(symbol: string, startTime: number, limit?: number): Promise<UserTrade[]>;
}

type Dir = "long" | "short";
type Kind = "market" | "limit";
type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "failed" | "skipped";

export interface FxProposal {
  id: string;
  planId: string;
  kind: Kind;
  dir: Dir;
  branch: KeyVolumeEntryPlan["branch"];
  keyPrice: number | null;
  entry: number;
  stop: number;
  target: number;
  /** Giá chốt 33% (+1R), null khi mục tiêu không xa hơn 1R. */
  partial: number | null;
  /** Lúc nến tín hiệu ĐÓNG. */
  createdAt: number;
  expiresAt: number;
  auto: boolean;
  messageId: number | null;
  status: ProposalStatus;
  note?: string;
  /** Giá bạn đã sửa tay trước khi duyệt. */
  edited?: ("entry" | "sl" | "tp")[];
  /** Thất bại vì sàn báo lỗi (không phải vì luật) — còn hạn thì được bấm 🔁 Thử lại. */
  retryable?: boolean;
}

interface FxWorking {
  proposalId: string;
  orderId: number;
  dir: Dir;
  qty: number;
  edge: number;
  stop: number;
  target: number;
  partial: number | null;
  expiresAt: number;
  placedAt: number;
  riskUsd: number;
}

interface FxPosition {
  proposalId: string;
  dir: Dir;
  qty: number;
  entry: number;
  stop: number;
  /** SL ĐANG đặt trên sàn (= stop, hoặc = entry sau khi chốt 33%). */
  slNow: number;
  target: number;
  partial: number | null;
  partialQty: number;
  partialDone: boolean;
  slAlgoId: number | null;
  openedAt: number;
  riskUsd: number;
  branch: KeyVolumeEntryPlan["branch"];
}

interface FxState {
  lastBarTime: number;
  /** Đề nghị đang chờ bạn gõ giá mới sau khi bấm ✏️ Sửa. */
  editingId?: string | null;
  proposals: FxProposal[];
  working: FxWorking | null;
  position: FxPosition | null;
}

export interface FxDreamLiveOptions {
  symbol: string;
  venue: FxVenue | null;
  telegram: TelegramConfig;
  riskUsd: number;
  /** Trần đòn bẩy; mỗi lệnh tự chọn đòn bẩy ≤ trần này theo khoảng SL — xem `pickLeverage`. */
  maxLeverage: number;
  dataDir: string;
  isTradingReady: () => boolean;
  params?: KeyVolumeParams;
  now?: () => number;
  /** Nến M15 ĐÃ ĐÓNG gần nhất, cũ → mới. Mặc định gọi fapi public. */
  fetchClosed?: (bars: number) => Promise<Candle[]>;
  /** Tiền tố file state/journal. Mặc định "fxdream" (tên file cũ của BTC). */
  stateName?: string;
  /** true nếu nến mở lúc `ms` rơi vào giờ thị trường đóng cửa — nến đó bị bỏ. Mặc định: không bao giờ. */
  marketClosed?: (ms: number) => boolean;
}

const M15 = TF_MS["15m"];
const WINDOW_BARS = 45 * 96 + 600;
const MARKET_APPROVAL_MS = 15 * 60_000;
/** Giá sửa tay lệch quá mức này so với giá hiện tại thì coi là gõ nhầm (vd thừa/thiếu một chữ số). */
const MAX_EDIT_DEVIATION = 0.2;
/** Sau khi thị trường mở lại, tín hiệu trong khoảng này luôn hỏi ý (không tự vào ban đêm). */
const REOPEN_ASK_MS = 60 * 60_000;
const PARTIAL_FRACTION = 0.33;
/** Giá thanh lý phải cách entry ít nhất gấp này lần khoảng SL, để SL luôn chạm trước thanh lý. */
const LIQ_BUFFER = 1.5;
/** Phần ký quỹ duy trì + phí bị trừ khỏi khoảng thanh lý (ISOLATED ≈ 1/đòn bẩy − tỉ lệ này); để rộng cho chắc. */
const MAINT_MARGIN = 0.01;

const BRANCH_LABEL: Record<KeyVolumeEntryPlan["branch"], string> = {
  "sweep-reclaim": "Quét thanh khoản (không dùng key)",
  "volume-reversal": "Key + cụm nến đảo chiều",
  "key-trap": "Trap qua key",
  "key-lower-high": "Đỉnh thấp dần sau key",
};

function closeSide(dir: Dir): OrderSide {
  return dir === "long" ? "SELL" : "BUY";
}
function openSide(dir: Dir): OrderSide {
  return dir === "long" ? "BUY" : "SELL";
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** BTC ~86.000 → 1 số lẻ; vàng ~4.180 → 2 số lẻ (bước giá 0,01). */
function fmt(n: number): string {
  const digits = Math.abs(n) >= 10_000 ? 1 : 2;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
/** Giá để gõ lại (không phân cách nghìn), làm ví dụ cú pháp sửa. */
function plain(n: number): string {
  return String(Number(n.toFixed(Math.abs(n) >= 10_000 ? 1 : 2)));
}
function vnTime(ms: number): string {
  return new Date(ms).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false,
  });
}
/** 00:00–06:00 giờ Việt Nam: tự vào, không hỏi. */
/**
 * Đòn bẩy cho một lệnh (user 06/10/26): khối lượng đã do $rủi ro ÷ khoảng SL quyết, nên đòn bẩy
 * chỉ đổi số tiền bị giữ làm ký quỹ. Chọn mức CAO nhất (ký quỹ nhỏ nhất) mà thanh lý vẫn cách entry
 * ≥ LIQ_BUFFER × khoảng SL, không vượt `maxLeverage`. `stopFrac` = |entry − SL| / entry.
 */
export function pickLeverage(stopFrac: number, maxLeverage: number): number {
  return Math.max(1, Math.min(Math.floor(maxLeverage), Math.floor(1 / (LIQ_BUFFER * stopFrac + MAINT_MARGIN))));
}

export function isNightVn(ms: number): boolean {
  const hour = Number(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }));
  return hour % 24 < 6;
}

async function fetchClosedFapi(symbol: string, bars: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let endTime: number | undefined;
  while (out.size < bars) {
    const res = await axios.get("https://fapi.binance.com/fapi/v1/klines", {
      params: { symbol: symbol.toUpperCase(), interval: "15m", limit: 1500, ...(endTime ? { endTime } : {}) },
      timeout: 20_000,
    });
    const rows = res.data as any[];
    if (!rows.length) break;
    for (const k of rows) {
      out.set(k[0], {
        openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
        volume: +k[5], quoteVolume: +k[7], takerBuyVolume: +k[9],
      });
    }
    endTime = rows[0][0] - 1;
    if (rows.length < 1500) break;
  }
  const now = Date.now();
  return [...out.values()].filter((c) => c.openTime + M15 <= now).sort((a, b) => a.openTime - b.openTime).slice(-bars);
}

/** "78900" · "78,900.5" · "78.900,5" · "78900,5" → số. Null nếu không đọc được. */
export function parsePrice(raw: string): number | null {
  let t = raw.trim();
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Dấu xuất hiện SAU CÙNG là dấu thập phân, dấu kia là phân cách nghìn.
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = t.split(sep);
    // Một dấu, đúng 3 chữ số sau mỗi dấu → phân cách nghìn; ngược lại là thập phân.
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3);
    t = thousands ? parts.join("") : parts.join(".");
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Đọc "entry 78900 sl 79400 tp 78300" (có thể thiếu bớt, dùng "vào"/":"/"="). */
export function parseEditText(text: string): { entry?: number; stop?: number; target?: number } | null {
  const out: { entry?: number; stop?: number; target?: number } = {};
  const re = /(entry|vào|vao|sl|tp)\s*[:=]?\s*([0-9][0-9.,]*)/giu;
  for (const m of text.matchAll(re)) {
    const value = parsePrice(m[2]);
    if (value == null) continue;
    const field = m[1].toLowerCase();
    if (field === "sl") out.stop = value;
    else if (field === "tp") out.target = value;
    else out.entry = value;
  }
  return Object.keys(out).length ? out : null;
}

export class FxDreamLive {
  private readonly o: Required<Omit<FxDreamLiveOptions, "venue">> & { venue: FxVenue | null };
  private readonly stateFile: string;
  private readonly journalFile: string;
  private state: FxState;
  private candles: Candle[] = [];
  private lock: Promise<void> = Promise.resolve();
  /** Nến/key/kế hoạch của từng đề nghị để vẽ lại ảnh khi bạn sửa giá. Mất khi khởi động lại. */
  private readonly visuals = new Map<string, { bars: Candle[]; keys: number[]; plan: KeyVolumeEntryPlan }>();
  /** Lý do khoá giao dịch (vị thế/lệnh lạ trên sàn). null = không khoá. */
  blocked: string | null = null;
  lastDataAt = 0;
  private saveFailing = false;
  /** Tiền tố id đề nghị theo mã ("btc", "xau") — hai mã ra tín hiệu cùng nến không trùng id. */
  private readonly idPrefix: string;

  constructor(opts: FxDreamLiveOptions) {
    // `??` chứ không trải `...opts` đè lên mặc định: bot truyền `marketClosed: undefined` cho BTC,
    // trải object sẽ ghi đè mặc định bằng undefined và bot sập lúc khởi động.
    this.o = {
      ...opts,
      params: opts.params ?? KEY_VOLUME_CONFIG,
      now: opts.now ?? (() => Date.now()),
      fetchClosed: opts.fetchClosed ?? ((bars) => fetchClosedFapi(opts.symbol, bars)),
      stateName: opts.stateName ?? "fxdream",
      marketClosed: opts.marketClosed ?? (() => false),
    };
    this.idPrefix = opts.symbol.toLowerCase().replace(/usdt$/, "");
    this.stateFile = path.join(opts.dataDir, `${this.o.stateName}-state.json`);
    this.journalFile = path.join(opts.dataDir, `${this.o.stateName}-trades.jsonl`);
    this.state = this.load();
  }

  // ── state ──────────────────────────────────────────────────────────────
  private load(): FxState {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
        return { lastBarTime: 0, proposals: [], working: null, position: null, ...raw };
      }
    } catch (err) {
      console.error("[FX Dream] đọc state lỗi — bắt đầu state rỗng:", errMsg(err));
    }
    return { lastBarTime: 0, proposals: [], working: null, position: null };
  }

  /**
   * Ghi state lỗi (vd ổ đầy 06/10/26) KHÔNG được ném: ném giữa chừng làm vòng tick bỏ dở
   * (huỷ lệnh trên sàn xong mà không báo, không xét tín hiệu). Bot chạy tiếp bằng state trong
   * RAM và báo Telegram một lần cho tới khi ghi lại được.
   */
  private save(): void {
    this.state.proposals = this.state.proposals.slice(-50);
    try {
      atomicWriteFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
      if (this.saveFailing) {
        this.saveFailing = false;
        void sendTelegram(this.o.telegram, "✅ FX Dream: ghi state lại được rồi.", undefined);
      }
    } catch (err) {
      console.error("[FX Dream] ghi state lỗi:", errMsg(err));
      if (this.saveFailing) return;
      this.saveFailing = true;
      void sendTelegram(
        this.o.telegram,
        `🚨 FX Dream: KHÔNG ghi được state (${errMsg(err)}). Bot vẫn chạy bằng bộ nhớ, nhưng nếu khởi động lại sẽ mất trạng thái mới nhất. Kiểm tra ổ đĩa máy bot (df -h).`,
        undefined,
      );
    }
  }

  private journal(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, JSON.stringify({ at: this.o.now(), ...entry }) + "\n");
    } catch (err) {
      console.error("[FX Dream] ghi journal lỗi:", errMsg(err));
    }
  }

  /** Mọi thao tác đổi state chạy tuần tự — tick nến và lượt bấm nút không chen nhau. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  snapshot(): Readonly<FxState> {
    return this.state;
  }

  /** Id đề nghị (nút bấm, /yes_<id>…) thuộc mã này không. */
  owns(id: string): boolean {
    return id.startsWith(this.idPrefix);
  }

  /** Nến lúc thị trường đóng cửa bị bỏ hẳn, như dữ liệu FX (backtest scripts/exp-keyvol-gold.ts). */
  private tradable(candles: Candle[]): Candle[] {
    return candles.filter((c) => !this.o.marketClosed(c.openTime));
  }

  private canTrade(): boolean {
    return this.o.venue != null && this.o.isTradingReady() && this.blocked == null;
  }

  // ── khởi động ──────────────────────────────────────────────────────────
  async start(): Promise<void> {
    this.candles = this.tradable(await this.o.fetchClosed(WINDOW_BARS));
    this.lastDataAt = this.o.now();
    const last = this.candles.at(-1);
    // KHÔNG replay: tín hiệu chỉ xét từ nến đóng SAU lúc khởi động (bẫy deploy 09/08).
    if (last) this.state.lastBarTime = last.openTime;
    for (const p of this.state.proposals) {
      if (p.status === "pending") {
        p.status = "expired";
        p.note = "bot khởi động lại";
        if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n⌛ Hết hiệu lực (bot khởi động lại).`);
      }
    }
    this.save();
    if (this.o.venue && this.o.isTradingReady()) await this.serial(() => this.reconcile());
  }

  /** Đối soát state ↔ sàn. Gọi lúc khởi động và mỗi khi đang bị khoá. */
  private async reconcile(): Promise<void> {
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    const pos = await venue.getPosition(sym);
    const amt = pos.positionAmt;
    const st = this.state;

    if (st.working) await this.manageWorking();
    if (st.position) {
      if (amt === 0) {
        await this.finishPosition("đóng trong lúc bot tắt");
      } else {
        await this.ensureStop();
      }
      this.blocked = null;
      return;
    }
    if (amt !== 0 && !st.working) {
      this.blocked = `Sàn đang có vị thế ${sym.toUpperCase()} ${amt > 0 ? "LONG" : "SHORT"} ${Math.abs(amt)} mà bot FX Dream không mở. Đóng tay trên Binance (hoặc gõ /status sau khi đóng).`;
      return;
    }
    if (!st.working) {
      const [orders, algos] = await Promise.all([venue.getOpenOrders(sym), venue.getOpenAlgoOrders(sym)]);
      if (orders.length + algos.length > 0) {
        this.blocked = `Sàn còn ${orders.length + algos.length} lệnh chờ/SL/TP ${sym.toUpperCase()} không phải của FX Dream (vd SL Turtle cũ). Huỷ tay trên Binance — một SL closePosition lạ sẽ đóng luôn lệnh FX Dream.`;
        return;
      }
    }
    this.blocked = null;
  }

  // ── vòng chính ─────────────────────────────────────────────────────────
  /** Gọi định kỳ (~10 giây). */
  tick(): Promise<void> {
    return this.serial(async () => {
      // Quản lý lệnh TRƯỚC khi xét tín hiệu: lệnh chạm TP/SL trong nến vừa đóng phải được
      // ghi nhận đóng, nếu không tín hiệu ở chính nến đó bị bỏ vì "đang có vị thế".
      if (this.o.venue && this.o.isTradingReady()) {
        if (this.blocked) await this.reconcile();
        if (this.state.working) await this.manageWorking();
        if (this.state.position) await this.managePosition();
      }
      await this.pullCandles();
      await this.expireProposals();
    });
  }

  private async pullCandles(): Promise<void> {
    let fresh: Candle[];
    try {
      fresh = this.tradable(await this.o.fetchClosed(5));
    } catch (err) {
      console.error("[FX Dream] lấy nến lỗi:", errMsg(err));
      return;
    }
    this.lastDataAt = this.o.now();
    const lastKnown = this.candles.at(-1)?.openTime ?? 0;
    const added = fresh.filter((c) => c.openTime > lastKnown);
    if (!added.length) return;
    if (added[0].openTime - lastKnown > M15 && lastKnown > 0) {
      // Lỡ nến (mạng) hoặc vừa mở cửa sau cuối tuần: nạp lại đủ cửa sổ cho engine không bị lủng.
      this.candles = this.tradable(await this.o.fetchClosed(WINDOW_BARS));
    } else {
      this.candles.push(...added);
      if (this.candles.length > WINDOW_BARS) this.candles = this.candles.slice(-WINDOW_BARS);
    }
    const last = this.candles.at(-1)!;
    if (last.openTime <= this.state.lastBarTime) return;
    if (added.length > 1) console.warn(`[FX Dream] lỡ ${added.length - 1} nến — chỉ xét tín hiệu ở nến mới nhất.`);
    this.state.lastBarTime = last.openTime;
    this.save();
    await this.onBar();
  }

  /** Tín hiệu ở đúng nến vừa đóng. */
  private async onBar(): Promise<void> {
    const params = this.o.params;
    const run = runKeyVolumeCandidates(this.o.symbol, this.candles, params);
    const bars = run.candles;
    const L = bars.length - 1;
    if (L < 1) return;
    const closeTime = bars[L].openTime + M15;
    const atr = atrSeriesForward(bars);

    type Signal = { plan: KeyVolumeEntryPlan; kind: Kind; entry: number; stop: number; target: number; expiresAt: number };
    const signals: Signal[] = [];
    for (const c of run.candidates) {
      if (c.index !== L || c.viaLimit) continue;
      signals.push({ plan: c.plan, kind: "market", entry: c.entry, stop: c.stop, target: c.target, expiresAt: closeTime + MARKET_APPROVAL_MS });
    }
    for (const plan of run.plans) {
      const isLimit = plan.branch === "key-lower-high" || (plan.branch === "sweep-reclaim" && params.sweepEntry === "order-block");
      if (!isLimit || plan.readyIndex !== L + 1) continue;
      if (plan.key && !isKeyVolumeLevelActive(plan.key, closeTime)) continue;
      const gate = resolveEntryLevels(plan, run.levels, plan.obEntryEdge, atr[L], closeTime, params);
      if (!gate.ok) continue;
      signals.push({
        plan, kind: "limit", entry: plan.obEntryEdge, stop: gate.stop, target: gate.target,
        expiresAt: closeTime + Math.max(1, params.obLimitBars) * M15,
      });
    }
    if (!signals.length) return;
    // Nhiều tín hiệu một lúc: lấy điểm cao nhất, đúng cách engine chọn.
    const best = signals.sort((a, b) => b.plan.score - a.plan.score)[0];
    const risk = Math.abs(best.entry - best.stop);
    const partialPrice = best.plan.direction === "long" ? best.entry + risk : best.entry - risk;
    const night = isNightVn(closeTime);
    // User 06/10/26: ban đêm chỉ TỰ VÀO khi TP ≥ 1R; dưới 1R (vd 0,21R lúc 01:15) thì hỏi như ban ngày.
    const thinTarget = Math.abs(best.target - best.entry) < risk;
    // Vàng vừa mở cửa lại (giờ đầu, vd 05:00 sáng thứ Hai VN) — volume bùng lên dễ sinh key giả: luôn hỏi.
    const justOpened = this.o.marketClosed(bars[L].openTime - REOPEN_ASK_MS);
    const proposal: FxProposal = {
      id: `${this.idPrefix}${closeTime.toString(36)}${best.plan.branch.length}`,
      planId: best.plan.id,
      kind: best.kind,
      dir: best.plan.direction,
      branch: best.plan.branch,
      keyPrice: best.plan.key?.price ?? null,
      entry: best.entry,
      stop: best.stop,
      target: best.target,
      partial: Math.abs(best.target - best.entry) > risk ? partialPrice : null,
      createdAt: closeTime,
      expiresAt: best.expiresAt,
      auto: night && !thinTarget && !justOpened,
      messageId: null,
      status: "pending",
    };

    const busy = this.state.position ? "đang có vị thế" : this.state.working ? "đang có lệnh chờ" : null;
    const keys = run.levels.filter((k) => isKeyVolumeLevelActive(k, closeTime)).map((k) => k.price);
    this.visuals.set(proposal.id, { bars, keys, plan: best.plan });
    for (const id of [...this.visuals.keys()].slice(0, -20)) this.visuals.delete(id);
    const png = this.render(proposal);

    if (busy || !this.canTrade()) {
      proposal.status = "skipped";
      proposal.note = busy ?? (this.blocked ? "bot đang khoá" : "chưa bật giao dịch thật");
      this.state.proposals.push(proposal);
      this.save();
      const why = busy
        ? `⏸ Không hỏi: ${busy} (một lệnh mỗi lúc).`
        : this.blocked
          ? `⛔ Bot đang KHOÁ: ${this.blocked}`
          : "ℹ️ ALERT-ONLY: bot chưa bật giao dịch thật, chỉ báo.";
      const caption = `${this.caption(proposal)}\n\n${why}`;
      if (png) await sendTelegramPhoto(this.o.telegram, png, caption);
      else await sendTelegram(this.o.telegram, caption, undefined);
      return;
    }

    this.state.proposals.push(proposal);
    this.save();
    if (proposal.auto) {
      const result = await this.execute(proposal);
      const caption = `${this.caption(proposal)}\n\n🌙 00:00–06:00 — TỰ VÀO, không hỏi.\n${result}`;
      proposal.messageId = png
        ? await sendTelegramPhoto(this.o.telegram, png, caption, this.retryButtons(proposal))
        : (await sendTelegram(this.o.telegram, caption + this.retryHint(proposal), undefined), null);
      this.save();
      return;
    }
    const why = justOpened
      ? "thị trường vừa mở cửa lại"
      : `TP chỉ ${(Math.abs(best.target - best.entry) / risk).toFixed(2)}R (< 1R)`;
    await this.sendAsk(proposal, png, night ? `🌙 Giờ đêm nhưng ${why} — KHÔNG tự vào, hỏi ý bạn.\n` : "");
  }

  private render(p: FxProposal): Buffer | null {
    const v = this.visuals.get(p.id);
    return v ? renderPng(buildProposalSvg(this.imageInput(p, v.bars, v.keys, v.plan))) : null;
  }

  /** Gửi ảnh hỏi ý kèm ba nút ✅ / ✏️ / ❌. */
  private async sendAsk(p: FxProposal, png: Buffer | null, prefix = ""): Promise<void> {
    const buttons = [
      { text: "✅ Vào lệnh", data: `fx:y:${p.id}` },
      { text: "✏️ Sửa", data: `fx:e:${p.id}` },
      { text: "❌ Bỏ qua", data: `fx:n:${p.id}` },
    ];
    const caption = `${prefix}${this.caption(p)}\n\n${p.kind === "market"
      ? `Bấm trong 15 phút (tới ${vnTime(p.expiresAt)}); giá đã vượt SL/TP thì huỷ.`
      : `Đồng ý trước ${vnTime(p.expiresAt)} thì đặt LIMIT ở ${fmt(p.entry)}.`}`;
    if (png) {
      p.messageId = await sendTelegramPhoto(this.o.telegram, png, caption, buttons);
    } else {
      // Không vẽ được ảnh: vẫn phải hỏi được — gửi chữ kèm hướng dẫn.
      p.messageId = null;
      await sendTelegram(this.o.telegram, `${caption}\n\n(Không vẽ được ảnh. Gõ /yes_${p.id}, /edit_${p.id} hoặc /no_${p.id})`, undefined);
    }
    this.save();
  }

  private imageInput(p: FxProposal, bars: Candle[], keys: number[], plan: KeyVolumeEntryPlan) {
    const view = bars.slice(-96);
    const marks: ProposalMark[] = [];
    const tip = bars[plan.tipIndex];
    if (plan.branch === "key-lower-high" && tip) {
      if (plan.priorExtremeTime != null) {
        marks.push({ time: plan.priorExtremeTime, price: plan.structuralStop, label: p.dir === "short" ? "Đỉnh trước" : "Đáy trước" });
      }
      marks.push({ time: tip.openTime, price: p.dir === "short" ? tip.high : tip.low, label: p.dir === "short" ? "Đỉnh thấp hơn" : "Đáy cao hơn" });
    } else if (plan.branch === "sweep-reclaim" && plan.sweepBreakTime != null) {
      marks.push({ time: plan.sweepBreakTime, price: plan.structuralStop, label: "Râu quét" });
    } else if (plan.branch === "key-trap") {
      marks.push({ time: bars[plan.tipIndex]?.openTime ?? plan.triggerTime, price: plan.structuralStop, label: "Cực trị trap" });
    }
    const visibleMarks = marks.filter((m) => m.time >= view[0].openTime);
    const showBox = p.kind === "limit" || plan.branch === "volume-reversal";
    return {
      candles: view,
      dir: p.dir,
      title: `${p.dir === "long" ? "LONG" : "SHORT"} ${this.o.symbol.toUpperCase()} · ${BRANCH_LABEL[p.branch]}`,
      subtitle: `Nến tín hiệu đóng ${vnTime(p.createdAt)} · ${p.kind === "market"
        ? "vào MARKET ở giá hiện tại"
        : `LIMIT ${p.edited?.includes("entry") ? "ở giá bạn đặt" : "ở mép order block"}, sống tới ${vnTime(p.expiresAt)}`}`,
      keyPrice: p.keyPrice,
      otherKeys: keys,
      box: showBox
        ? { low: plan.obLow, high: plan.obHigh, startTime: plan.triggerTime - (Math.max(1, plan.clusterBars) - 1) * M15, endTime: plan.triggerTime }
        : null,
      entry: p.entry,
      stop: p.stop,
      target: p.target,
      partial: p.partial,
      marks: visibleMarks,
      signalTime: plan.triggerTime,
      footer: this.footer(p),
    };
  }

  /** Rủi ro $ của đề nghị: tự vào ban đêm chỉ dùng một nửa (user 05/10/26). */
  private riskUsdFor(p: Pick<FxProposal, "auto">): number {
    return p.auto ? this.o.riskUsd / 2 : this.o.riskUsd;
  }

  private footer(p: FxProposal): string[] {
    const risk = Math.abs(p.entry - p.stop);
    const riskUsd = this.riskUsdFor(p);
    const qty = this.o.venue ? this.o.venue.roundQty(this.o.symbol, riskUsd / risk) : riskUsd / risk;
    const rr = Math.abs(p.target - p.entry) / risk;
    const lev = pickLeverage(risk / p.entry, this.o.maxLeverage);
    return [
      `Rủi ro $${riskUsd}${p.auto ? " (nửa — tự vào ban đêm)" : ""} · khối lượng ~${qty} ${this.o.symbol.replace(/usdt$/i, "").toUpperCase()} · notional ~$${fmt(qty * p.entry)} · SL cách ${((risk / p.entry) * 100).toFixed(2)}%`,
      `Đòn bẩy ${lev}x · ký quỹ ~$${fmt((qty * p.entry) / lev)} (tự tính lại khi sửa giá, rủi ro giữ $${riskUsd})`,
      `Mục tiêu ${rr.toFixed(2)}R (${p.edited?.includes("tp") ? "bạn đặt" : "key đối diện"})${p.partial ? " · chốt 33% ở 1R rồi dời SL về giá vào" : " · mục tiêu dưới 1R nên không chốt một phần"}`,
      p.edited?.length
        ? `Bạn đã sửa tay: ${p.edited.map((f) => f.toUpperCase()).join(", ")} (khác đề xuất của engine).`
        : `Backtest ${this.o.symbol.toUpperCase()} chưa cho thấy lợi thế sau phí — bạn là bộ lọc cuối cùng.`,
    ];
  }

  private caption(p: FxProposal): string {
    const risk = Math.abs(p.entry - p.stop);
    const rr = Math.abs(p.target - p.entry) / risk;
    return [
      `${p.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} ${this.o.symbol.toUpperCase()} — ${BRANCH_LABEL[p.branch]}`,
      p.keyPrice != null ? `Key ${fmt(p.keyPrice)}` : "Không dùng key",
      `${p.kind === "market" ? "Vào (giá đóng)" : "LIMIT"} ${fmt(p.entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)} (${rr.toFixed(2)}R)`,
      `Rủi ro $${this.riskUsdFor(p)}${p.auto ? " (nửa, tự vào)" : ""} · nến ${vnTime(p.createdAt - M15)}`,
      ...(p.edited?.length ? [`✏️ Đã sửa tay: ${p.edited.map((f) => f.toUpperCase()).join(", ")}`] : []),
    ].join("\n");
  }

  // ── bấm nút ────────────────────────────────────────────────────────────
  /** Trả true nếu callback thuộc FX Dream (đã xử lý). */
  async handleCallback(cb: TelegramCallback): Promise<boolean> {
    const m = /^fx:(y|n|e):(\w+)$/.exec(cb.data);
    if (!m || !this.owns(m[2])) return false;
    if (m[1] === "e") await this.startEdit(m[2], cb.id);
    else await this.decide(m[2], m[1] === "y", cb.id);
    return true;
  }

  /** Bấm ✏️ Sửa: chờ bạn gõ giá mới cho đề nghị này. */
  startEdit(id: string, callbackId?: string): Promise<void> {
    return this.serial(async () => {
      const p = this.state.proposals.find((x) => x.id === id);
      const answer = (text: string) => (callbackId ? answerTelegramCallback(this.o.telegram, callbackId, text) : Promise.resolve());
      if (!p || p.status !== "pending" || this.o.now() > p.expiresAt) {
        await answer("Đề nghị không còn sửa được.");
        return;
      }
      this.state.editingId = id;
      this.save();
      await answer("Gõ giá mới vào khung chat.");
      await sendTelegram(this.o.telegram, [
        `✏️ Sửa ${p.dir === "long" ? "LONG" : "SHORT"} — hiện tại: ${p.kind === "market" ? "vào" : "LIMIT"} ${fmt(p.entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)}`,
        "Gõ một hoặc nhiều giá, ví dụ:",
        `sl ${plain(p.stop)} tp ${plain(p.target)}`,
        `entry ${plain(p.entry)}`,
        p.kind === "market" ? "Sửa entry thì lệnh thành LIMIT ở giá đó (sống 4 giờ)." : "",
        "Gõ huỷ để thôi sửa.",
      ].filter(Boolean).join("\n"), undefined);
    });
  }

  /** Thôi sửa im lặng — bot gọi khi bạn bấm ✏️ ở đề nghị của MÃ KHÁC, để giá gõ vào không lạc mã. */
  cancelEdit(): Promise<void> {
    return this.serial(async () => {
      if (!this.state.editingId) return;
      this.state.editingId = null;
      this.save();
    });
  }

  /** Tin nhắn chữ không phải lệnh. Trả true nếu FX Dream đã dùng nó (đang ở chế độ sửa). */
  handleText(text: string): Promise<boolean> {
    return this.serial(async () => {
      const id = this.state.editingId;
      if (!id) return false;
      const p = this.state.proposals.find((x) => x.id === id);
      if (!p || p.status !== "pending" || this.o.now() > p.expiresAt) {
        this.state.editingId = null;
        this.save();
        await sendTelegram(this.o.telegram, "Đề nghị đã hết hạn hoặc đã xử lý — không sửa nữa.", undefined);
        return true;
      }
      if (/^\s*(huỷ|hủy|huy|cancel)\s*$/iu.test(text)) {
        this.state.editingId = null;
        this.save();
        await sendTelegram(this.o.telegram, "Đã thôi sửa. Đề nghị giữ nguyên, các nút vẫn dùng được.", undefined);
        return true;
      }
      const edit = parseEditText(text);
      if (!edit) {
        await sendTelegram(this.o.telegram, `Không đọc được giá. Ví dụ: sl ${plain(p.stop)} tp ${plain(p.target)} — hoặc gõ huỷ.`, undefined);
        return true;
      }
      const why = this.applyEdit(p, edit);
      if (why) {
        await sendTelegram(this.o.telegram, `⚠️ Không sửa: ${why}\nGõ lại, hoặc gõ huỷ.`, undefined);
        return true;
      }
      this.state.editingId = null;
      this.save();
      if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n✏️ Đã sửa — xem ảnh mới bên dưới.`);
      const last = this.candles.at(-1)?.close;
      const crossed = p.kind === "limit" && last != null
        && (p.dir === "short" ? last > p.entry : last < p.entry);
      await this.sendAsk(p, this.render(p), crossed ? `⚠️ Giá hiện tại ${fmt(last!)} đã qua mức LIMIT — đồng ý là khớp ngay ở giá thị trường.\n\n` : "");
      return true;
    });
  }

  /** Áp giá sửa tay lên đề nghị. Trả lý do từ chối, hoặc null khi hợp lệ. */
  private applyEdit(p: FxProposal, edit: { entry?: number; stop?: number; target?: number }): string | null {
    const entry = edit.entry ?? p.entry;
    const stop = edit.stop ?? p.stop;
    const target = edit.target ?? p.target;
    const long = p.dir === "long";
    const ref = this.candles.at(-1)?.close ?? p.entry;
    for (const [name, value] of [["Entry", edit.entry], ["SL", edit.stop], ["TP", edit.target]] as const) {
      if (value != null && Math.abs(value - ref) / ref > MAX_EDIT_DEVIATION) {
        return `${name} ${fmt(value)} lệch ${((Math.abs(value - ref) / ref) * 100).toFixed(0)}% so với giá hiện tại ${fmt(ref)} — gõ nhầm?`;
      }
    }
    if (long ? !(stop < entry && entry < target) : !(target < entry && entry < stop)) {
      return long ? "LONG cần SL < entry < TP" : "SHORT cần TP < entry < SL";
    }
    const risk = Math.abs(entry - stop);
    if (risk / entry > 0.1) return `SL cách entry ${((risk / entry) * 100).toFixed(1)}% — quá 10%`;
    if (this.o.venue) {
      const f = this.o.venue.getFilters(this.o.symbol);
      const qty = this.o.venue.roundQty(this.o.symbol, this.riskUsdFor(p) / risk);
      if (qty < f.minQty) return `SL quá xa: khối lượng cho $${this.riskUsdFor(p)} chỉ ${qty} < tối thiểu ${f.minQty}`;
      if (qty * entry < f.minNotional) return `SL quá xa: notional $${fmt(qty * entry)} < tối thiểu $${f.minNotional}`;
    }
    const fields = new Set(p.edited ?? []);
    if (edit.entry != null && edit.entry !== p.entry) {
      fields.add("entry");
      if (p.kind === "market") {
        // Vào ở giá bạn chọn chứ không phải giá hiện tại → thành lệnh chờ, sống như lệnh chờ của engine.
        p.kind = "limit";
        p.expiresAt = Math.max(p.expiresAt, p.createdAt + Math.max(1, this.o.params.obLimitBars) * M15);
      }
    }
    if (edit.stop != null && edit.stop !== p.stop) fields.add("sl");
    if (edit.target != null && edit.target !== p.target) fields.add("tp");
    p.entry = entry;
    p.stop = stop;
    p.target = target;
    p.partial = Math.abs(target - entry) > risk ? (long ? entry + risk : entry - risk) : null;
    p.edited = [...fields];
    return null;
  }

  /** Dùng chung cho nút bấm và lệnh chữ /yes_<id> /no_<id>. */
  decide(id: string, approve: boolean, callbackId?: string): Promise<void> {
    return this.serial(async () => {
      const p = this.state.proposals.find((x) => x.id === id);
      const answer = (text: string) => (callbackId ? answerTelegramCallback(this.o.telegram, callbackId, text) : sendTelegram(this.o.telegram, text, undefined));
      if (!p) return void (await answer("Không tìm thấy đề nghị này."));
      const retrying = p.status === "failed" && p.retryable === true;
      if (p.status !== "pending" && !retrying) return void (await answer(`Đề nghị đã ${p.status}.`));
      if (this.o.now() > p.expiresAt) {
        p.status = "expired";
        p.retryable = false;
        this.save();
        await answer("Đã hết hạn.");
        if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n⌛ Hết hạn — không vào.`);
        return;
      }
      if (!approve) {
        p.status = "rejected";
        p.retryable = false;
        this.save();
        await answer("Đã bỏ qua.");
        if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n❌ Bạn đã bỏ qua.`);
        return;
      }
      await answer(retrying ? "Đang thử lại…" : "Đang đặt lệnh…");
      const result = await this.execute(p, retrying);
      if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n${result}`, this.retryButtons(p));
      else await sendTelegram(this.o.telegram, result + this.retryHint(p), undefined);
    });
  }

  /** Lỗi sàn còn trong hạn → nút 🔁 Thử lại (gửi lại qua `decide`) / ❌ Bỏ qua. */
  private retryButtons(p: FxProposal): InlineButton[] | undefined {
    if (p.status !== "failed" || !p.retryable) return undefined;
    return [
      { text: "🔁 Thử lại", data: `fx:y:${p.id}` },
      { text: "❌ Bỏ qua", data: `fx:n:${p.id}` },
    ];
  }

  private retryHint(p: FxProposal): string {
    return this.retryButtons(p) ? `\nGõ /yes_${p.id} để thử lại (tới ${vnTime(p.expiresAt)}) hoặc /no_${p.id} để bỏ.` : "";
  }

  // ── đặt lệnh ───────────────────────────────────────────────────────────
  /** Thực thi đề nghị đã được đồng ý (hoặc tự vào ban đêm). Trả một dòng kết quả cho caption. */
  private async execute(p: FxProposal, retrying = false): Promise<string> {
    const fail = (why: string, retryable = false) => {
      p.status = "failed";
      p.note = why;
      p.retryable = retryable;
      this.save();
      this.journal({ event: "rejected", proposal: p.id, why });
      return `⚠️ Không vào: ${why}`;
    };
    if (!this.canTrade()) return fail(this.blocked ?? "giao dịch thật chưa sẵn sàng");
    if (this.state.position || this.state.working) return fail("đang có lệnh khác");
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    try {
      if (retrying) {
        // Lần trước báo lỗi nhưng lệnh vẫn có thể đã lọt lên sàn (timeout) → đối soát trước,
        // thấy vị thế/lệnh lạ thì KHOÁ chứ không đặt thêm lệnh thứ hai.
        await this.reconcile();
        if (this.blocked) return fail(this.blocked);
      }
      const venuePos = await venue.getPosition(sym);
      if (venuePos.positionAmt !== 0) {
        await this.reconcile();
        return fail("sàn đang có vị thế không phải của FX Dream");
      }
      const price = venuePos.markPrice;
      const long = p.dir === "long";
      if (long ? price <= p.stop || price >= p.target : price >= p.stop || price <= p.target) {
        return fail(`giá ${fmt(price)} đã vượt SL hoặc TP`);
      }
      const plannedEntry = p.kind === "market" ? price : p.entry;
      const f = venue.getFilters(sym);
      const stopDist = Math.abs(plannedEntry - venue.roundPrice(sym, p.stop));
      const qty = venue.roundQty(sym, this.riskUsdFor(p) / stopDist);
      if (!(qty >= f.minQty)) return fail(`khối lượng ${qty} < tối thiểu ${f.minQty}`);
      if (qty * plannedEntry < f.minNotional) return fail(`notional $${fmt(qty * plannedEntry)} < tối thiểu $${f.minNotional}`);
      const eq = await venue.getEquity();
      const leverage = pickLeverage(stopDist / plannedEntry, this.o.maxLeverage);
      const margin = (qty * plannedEntry) / leverage;
      if (margin > eq.available * 0.95) {
        return fail(`cần ký quỹ $${fmt(margin)} (đòn bẩy ${leverage}x) > khả dụng $${fmt(eq.available)}`);
      }
      await venue.setLeverage(sym, leverage);
      const levNote = ` · ${leverage}x, ký quỹ ~$${fmt(margin)}`;

      if (p.kind === "limit") {
        const order = await venue.limitOrder(sym, openSide(p.dir), qty, p.entry, `fx${p.id}`);
        p.status = "approved";
        this.state.working = {
          proposalId: p.id, orderId: order.orderId, dir: p.dir, qty, edge: p.entry, stop: p.stop,
          target: p.target, partial: p.partial, expiresAt: p.expiresAt, placedAt: this.o.now(), riskUsd: qty * stopDist,
        };
        this.closeOtherPending(p.id);
        this.save();
        this.journal({ event: "limit-placed", proposal: p.id, orderId: order.orderId, qty, price: p.entry, leverage });
        if (order.status === "FILLED") {
          await this.manageWorking();
          return `✅ LIMIT khớp ngay ${qty} @ ${fmt(order.avgPrice || p.entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)}${levNote}`;
        }
        return `✅ Đã đặt LIMIT ${qty} @ ${fmt(p.entry)}${levNote} — tự huỷ lúc ${vnTime(p.expiresAt)} nếu chưa khớp.`;
      }

      const fill = await venue.marketOrder(sym, openSide(p.dir), qty, `fx${p.id}`);
      if (!(fill.executedQty > 0)) return fail(`MARKET không khớp (${fill.status})`, true);
      p.status = "approved";
      const avg = fill.avgPrice || price;
      this.closeOtherPending(p.id);
      const protectedMsg = await this.openPosition(p, fill.executedQty, avg);
      return protectedMsg + levNote;
    } catch (err) {
      return fail(`lỗi sàn: ${errMsg(err)}`, true);
    }
  }

  private closeOtherPending(keepId: string): void {
    for (const other of this.state.proposals) {
      if (other.id === keepId || other.status !== "pending") continue;
      other.status = "skipped";
      other.note = "đã có lệnh khác";
      if (other.messageId) void editTelegramCaption(this.o.telegram, other.messageId, `${this.caption(other)}\n\n⏸ Bỏ qua — đã vào lệnh khác.`);
    }
  }

  /** Khớp xong: đặt SL (bắt buộc), TP, chốt 33%. Trả dòng kết quả. */
  private async openPosition(p: Pick<FxProposal, "id" | "dir" | "stop" | "target" | "partial" | "branch">, qty: number, entry: number): Promise<string> {
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    let slAlgoId: number;
    try {
      slAlgoId = await this.retry(() => venue.stopMarketClose(sym, closeSide(p.dir), p.stop));
    } catch (err) {
      await this.emergencyClose(p.dir, qty);
      this.journal({ event: "emergency-close", proposal: p.id, why: errMsg(err) });
      return `🚨 Đặt SL lỗi → ĐÃ ĐÓNG KHẨN CẤP (${errMsg(err)})`;
    }
    let tpNote = "";
    try {
      await this.retry(() => venue.takeProfitMarketClose(sym, closeSide(p.dir), p.target));
    } catch (err) {
      tpNote = ` · ⚠️ TP chưa đặt được (${errMsg(err)})`;
    }
    const f = venue.getFilters(sym);
    let partialQty = 0;
    let partialNote = "";
    if (p.partial != null) {
      partialQty = venue.roundQty(sym, qty * PARTIAL_FRACTION);
      if (partialQty >= f.minQty && partialQty < qty) {
        try {
          await this.retry(() => venue.takeProfitMarketReduce(sym, closeSide(p.dir), p.partial!, partialQty));
        } catch (err) {
          partialQty = 0;
          partialNote = ` · ⚠️ chốt 33% chưa đặt được (${errMsg(err)})`;
        }
      } else {
        partialQty = 0;
        partialNote = " · khối lượng quá nhỏ để chốt 33%";
      }
    }
    const riskUsd = qty * Math.abs(entry - p.stop);
    this.state.working = null;
    this.state.position = {
      proposalId: p.id, dir: p.dir, qty, entry, stop: p.stop, slNow: p.stop, target: p.target,
      partial: partialQty > 0 ? p.partial : null, partialQty, partialDone: false, slAlgoId,
      openedAt: this.o.now(), riskUsd, branch: p.branch,
    };
    this.save();
    this.journal({ event: "opened", proposal: p.id, dir: p.dir, qty, entry, stop: p.stop, target: p.target, riskUsd });
    return `✅ ĐÃ VÀO ${p.dir === "long" ? "LONG" : "SHORT"} ${qty} @ ${fmt(entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)} · rủi ro thật $${riskUsd.toFixed(2)}${tpNote}${partialNote}`;
  }

  // ── quản lý ────────────────────────────────────────────────────────────
  private async manageWorking(): Promise<void> {
    const w = this.state.working;
    if (!w) return;
    const venue = this.o.venue!;
    const order = await venue.getOrder(this.o.symbol, w.orderId);
    const p = this.state.proposals.find((x) => x.id === w.proposalId);
    const base = { id: w.proposalId, dir: w.dir, stop: w.stop, target: w.target, partial: w.partial, branch: p?.branch ?? "key-lower-high" as const };
    if (order.status === "FILLED") {
      const msg = await this.openPosition(base, order.executedQty, order.avgPrice || w.edge);
      await sendTelegram(this.o.telegram, `📥 LIMIT ĐÃ KHỚP\n${msg}`, undefined);
      await this.markPhoto(p, `📥 LIMIT ĐÃ KHỚP\n${msg}`);
      return;
    }
    const expired = this.o.now() >= w.expiresAt;
    if (order.status === "PARTIALLY_FILLED" && expired) {
      await venue.cancelOrder(this.o.symbol, w.orderId);
      const msg = await this.openPosition(base, order.executedQty, order.avgPrice || w.edge);
      await sendTelegram(this.o.telegram, `📥 LIMIT khớp MỘT PHẦN rồi hết hạn — giữ phần đã khớp\n${msg}`, undefined);
      await this.markPhoto(p, `📥 LIMIT khớp MỘT PHẦN rồi hết hạn\n${msg}`);
      return;
    }
    if (order.status === "NEW" && expired) {
      await venue.cancelOrder(this.o.symbol, w.orderId);
      const after = await venue.getOrder(this.o.symbol, w.orderId);
      if (after.executedQty > 0) {
        const msg = await this.openPosition(base, after.executedQty, after.avgPrice || w.edge);
        await sendTelegram(this.o.telegram, `📥 LIMIT khớp ngay lúc huỷ — giữ phần đã khớp\n${msg}`, undefined);
        await this.markPhoto(p, `📥 LIMIT khớp ngay lúc huỷ\n${msg}`);
        return;
      }
      this.state.working = null;
      this.save();
      this.journal({ event: "limit-expired", proposal: w.proposalId });
      await sendTelegram(this.o.telegram, `⌛ LIMIT ${fmt(w.edge)} hết hạn, giá không quay lại — đã huỷ.`, undefined);
      await this.markPhoto(p, `⌛ Hết hạn lúc ${vnTime(w.expiresAt)}, giá không quay lại — ĐÃ HUỶ LIMIT.`);
      return;
    }
    if (order.status === "CANCELED" || order.status === "EXPIRED" || order.status === "REJECTED") {
      this.state.working = null;
      this.save();
      if (order.executedQty > 0) {
        const msg = await this.openPosition(base, order.executedQty, order.avgPrice || w.edge);
        await sendTelegram(this.o.telegram, `📥 LIMIT bị huỷ ngoài bot nhưng đã khớp một phần\n${msg}`, undefined);
        await this.markPhoto(p, `📥 LIMIT bị huỷ ngoài bot, đã khớp một phần\n${msg}`);
        return;
      }
      await sendTelegram(this.o.telegram, `ℹ️ LIMIT ${fmt(w.edge)} bị huỷ/từ chối ngoài bot (${order.status}).`, undefined);
      await this.markPhoto(p, `ℹ️ LIMIT bị huỷ/từ chối ngoài bot (${order.status}).`);
    }
  }

  /** Kết cục của lệnh chờ ghi luôn vào ảnh gốc — ảnh không còn nói "tự huỷ lúc …" sau khi đã huỷ. */
  private async markPhoto(p: FxProposal | undefined, line: string): Promise<void> {
    if (p?.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n${line}`);
  }

  private async managePosition(): Promise<void> {
    const pos = this.state.position;
    if (!pos) return;
    const venue = this.o.venue!;
    const venuePos = await venue.getPosition(this.o.symbol);
    const amt = Math.abs(venuePos.positionAmt);
    if (amt === 0) {
      await this.finishPosition();
      return;
    }
    // Chốt 33% đã khớp (khối lượng giảm) → dời SL về giá vào.
    if (!pos.partialDone && pos.partialQty > 0 && amt <= pos.qty - pos.partialQty * 0.99) {
      pos.partialDone = true;
      this.save();
      const moved = await this.moveStop(pos.entry);
      await sendTelegram(
        this.o.telegram,
        `💰 Đã chốt 33% ở ${fmt(pos.partial!)} (+1R). ${moved ? `SL phần còn lại dời về giá vào ${fmt(pos.entry)}.` : "⚠️ Dời SL lỗi — kiểm tra sàn!"}`,
        undefined,
      );
      return;
    }
    await this.ensureStop();
  }

  /** Còn vị thế mà mất SL trên sàn (bị huỷ tay, lỗi) → đặt lại. */
  private async ensureStop(): Promise<void> {
    const pos = this.state.position;
    if (!pos) return;
    const venue = this.o.venue!;
    const algos = await venue.getOpenAlgoOrders(this.o.symbol);
    if (algos.some((o) => o.orderType === "STOP_MARKET")) return;
    try {
      pos.slAlgoId = await this.retry(() => venue.stopMarketClose(this.o.symbol, closeSide(pos.dir), pos.slNow));
      this.save();
      await sendTelegram(this.o.telegram, `🛡 SL ${fmt(pos.slNow)} không còn trên sàn — đã đặt lại.`, undefined);
    } catch (err) {
      await this.emergencyClose(pos.dir, pos.qty);
      await sendTelegram(this.o.telegram, `🚨 Không đặt lại được SL → ĐÃ ĐÓNG KHẨN CẤP (${errMsg(err)})`, undefined);
    }
  }

  /** Huỷ SL cũ rồi đặt SL mới (Binance không cho hai STOP closePosition cùng phía). */
  private async moveStop(price: number): Promise<boolean> {
    const pos = this.state.position!;
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    const old = pos.slNow;
    const stops = (await venue.getOpenAlgoOrders(sym)).filter((o) => o.orderType === "STOP_MARKET");
    for (const s of stops) await venue.cancelAlgoOrder(s.algoId);
    try {
      pos.slAlgoId = await this.retry(() => venue.stopMarketClose(sym, closeSide(pos.dir), price));
      pos.slNow = price;
      this.save();
      return true;
    } catch {
      try {
        pos.slAlgoId = await this.retry(() => venue.stopMarketClose(sym, closeSide(pos.dir), old));
        this.save();
      } catch (restoreErr) {
        await this.emergencyClose(pos.dir, pos.qty);
        this.journal({ event: "emergency-close", proposal: pos.proposalId, why: errMsg(restoreErr) });
      }
      return false;
    }
  }

  private async finishPosition(note?: string): Promise<void> {
    const pos = this.state.position!;
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    try {
      await venue.cancelAllAlgoOpenOrders(sym);
      await venue.cancelAllOpenOrders(sym);
    } catch (err) {
      console.error("[FX Dream] dọn lệnh sau khi đóng lỗi:", errMsg(err));
    }
    let pnl: number | null = null;
    let fee = 0;
    let exitPrice: number | null = null;
    try {
      const fills = await venue.getUserTrades(sym, pos.openedAt - 60_000);
      const closing = fills.filter((t) => t.realizedPnl !== 0);
      pnl = closing.reduce((s, t) => s + t.realizedPnl, 0);
      fee = fills.reduce((s, t) => s + t.commission, 0);
      const q = closing.reduce((s, t) => s + t.qty, 0);
      exitPrice = q > 0 ? closing.reduce((s, t) => s + t.price * t.qty, 0) / q : null;
    } catch (err) {
      console.error("[FX Dream] đọc fill lỗi:", errMsg(err));
    }
    const grossR = pnl != null ? pnl / pos.riskUsd : null;
    const reason = exitPrice == null
      ? "đã đóng"
      : Math.abs(exitPrice - pos.target) < Math.abs(exitPrice - pos.slNow)
        ? "chạm TP"
        : pos.partialDone && pos.slNow === pos.entry
          ? "SL về giá vào sau khi chốt 33%"
          : "chạm SL";
    this.state.position = null;
    this.save();
    this.journal({ event: "closed", proposal: pos.proposalId, pnl, fee, grossR, exitPrice, reason, note });
    await sendTelegram(
      this.o.telegram,
      [
        `${grossR != null && grossR > 0 ? "🏁✅" : "🏁"} ĐÃ ĐÓNG ${pos.dir === "long" ? "LONG" : "SHORT"} ${sym.toUpperCase()} — ${reason}${note ? ` (${note})` : ""}`,
        `Vào ${fmt(pos.entry)}${exitPrice != null ? ` → ra ${fmt(exitPrice)}` : ""}`,
        grossR != null
          ? `R thuần ${grossR >= 0 ? "+" : ""}${grossR.toFixed(2)}R ($${pnl!.toFixed(2)}) · phí $${fee.toFixed(2)} · sau phí $${(pnl! - fee).toFixed(2)}`
          : "Không đọc được kết quả từ sàn — xem lịch sử lệnh Binance.",
      ].join("\n"),
      undefined,
    );
  }

  private async expireProposals(): Promise<void> {
    const now = this.o.now();
    const editing = this.state.proposals.find((x) => x.id === this.state.editingId);
    if (this.state.editingId && (!editing || editing.status !== "pending" || now > editing.expiresAt)) {
      this.state.editingId = null;
      this.save();
    }
    for (const p of this.state.proposals) {
      if (p.status === "failed" && p.retryable && now > p.expiresAt) {
        p.retryable = false;
        this.save();
        if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n⚠️ Không vào: ${p.note}\n⌛ Hết hạn thử lại.`);
        continue;
      }
      if (p.status !== "pending" || now <= p.expiresAt) continue;
      p.status = "expired";
      this.save();
      if (p.messageId) await editTelegramCaption(this.o.telegram, p.messageId, `${this.caption(p)}\n\n⌛ Hết hạn — bạn chưa trả lời, không vào.`);
    }
  }

  private async emergencyClose(dir: Dir, fallbackQty: number): Promise<void> {
    const venue = this.o.venue!;
    const sym = this.o.symbol;
    try { await venue.cancelAllOpenOrders(sym); } catch { /* vẫn cố đóng */ }
    try { await venue.cancelAllAlgoOpenOrders(sym); } catch { /* vẫn cố đóng */ }
    try {
      const p = await venue.getPosition(sym);
      const amt = Math.abs(p.positionAmt);
      if (amt > 0) await venue.marketClose(sym, closeSide(dir), venue.roundQty(sym, amt));
    } catch {
      await venue.marketClose(sym, closeSide(dir), fallbackQty);
    }
    this.state.position = null;
    this.state.working = null;
    this.save();
  }

  private async retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw last;
  }

  // ── báo cáo ────────────────────────────────────────────────────────────
  statusText(): string {
    const st = this.state;
    const lines = [`🎯 FX Dream · ${this.o.symbol.toUpperCase()} · rủi ro $${this.o.riskUsd}/lệnh, tự vào ban đêm $${this.o.riskUsd / 2}`];
    lines.push(this.blocked ? `⛔ KHOÁ: ${this.blocked}` : this.canTrade() ? "Giao dịch thật: BẬT" : "ALERT-ONLY (chưa bật giao dịch thật)");
    lines.push(`Nến cuối đã xét: ${st.lastBarTime ? vnTime(st.lastBarTime) : "—"}`);
    if (st.position) {
      const p = st.position;
      lines.push(`Vị thế: ${p.dir.toUpperCase()} ${p.qty} @ ${fmt(p.entry)} · SL ${fmt(p.slNow)} · TP ${fmt(p.target)}${p.partialDone ? " · đã chốt 33%" : ""}`);
    } else if (st.working) {
      lines.push(`Lệnh chờ: ${st.working.dir.toUpperCase()} ${st.working.qty} @ ${fmt(st.working.edge)} · hết hạn ${vnTime(st.working.expiresAt)}`);
    } else {
      lines.push("Không có vị thế / lệnh chờ.");
    }
    const pending = st.proposals.filter((p) => p.status === "pending");
    if (pending.length) lines.push(`Đang chờ bạn duyệt: ${pending.length}`);
    return lines.join("\n");
  }
}
