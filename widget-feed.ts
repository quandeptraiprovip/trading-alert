/**
 * widget-feed.ts — Mô hình dữ liệu cho widget macOS. CHỈ ĐỌC.
 *
 * Gộp Binance + MEXC + state file của bot thành đúng những gì widget hiện:
 * máy còn chạy không → còn bao nhiêu tiền → đang mở gì → còn cách stop bao xa.
 *
 * KHÔNG import module đặt lệnh. Không ghi gì ngoài widget-equity-history.json
 * (mốc vốn đầu ngày để tính mức đổi trong ngày).
 *
 * Vị thế lấy từ SÀN (authoritative). State file của bot chỉ dùng để bổ sung
 * mức stop / R / ngày giữ — khớp theo symbol, không cần biết file nào của sàn nào.
 */
import "./load-env";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import net from "net";
import { promisify } from "util";
import { createBinanceFromEnv } from "./binance-futures";
import { createMexcFromEnv, toMexcSymbol } from "./mexc-futures";
import { getBotUniverse } from "./bot-universe";

const execFileAsync = promisify(execFile);

const DATA_DIR = path.resolve(process.env.TRADING_DATA_DIR?.trim() || process.cwd());
const HISTORY_FILE = path.join(DATA_DIR, "widget-equity-history.json");

/** State file của bot — mỗi file một sổ. Chỉ đọc để lấy stop / R / thời điểm vào. */
const STATE_FILES = [
  "bot-state.json",
  "turtle-state.json",
  "fast-trend-state.json",
  "fast-trend-mexc-state.json",
];

const BOT_CONTAINER = process.env.WIDGET_BOT_CONTAINER?.trim() || "swing-bot";
/** Nến chậm nhất trong hệ là 4h; quá 2 nến chưa nhích = trễ nhịp. */
const STALE_AFTER_MS = Number(process.env.WIDGET_STALE_MS ?? 2 * 4 * 60 * 60 * 1000);
const MAX_RISK_PCT = Number(process.env.MAX_PORTFOLIO_RISK_PCT ?? 20) / 100;

export type HealthState = "running" | "stale" | "stopped";

export interface WidgetPosition {
  symbol: string;
  dir: "long" | "short";
  units: number;
  entry: number;
  mark: number;
  stop: number | null;
  /** Stop lấy từ đâu: lệnh chờ trên sàn (đúng nhất) hay state của bot. null = KHÔNG có stop. */
  stopSource: "exchange" | "state" | null;
  r: number | null;
  pnl: number;
  riskUsd: number | null;
  heldDays: number | null;
  stopDistancePct: number | null;
}

export interface WidgetVenue {
  id: "binance" | "mexc";
  name: string;
  equity: number | null;
  ok: boolean;
  error: string | null;
  positions: WidgetPosition[];
}

export interface WidgetFeed {
  now: number;
  health: {
    state: HealthState;
    detail: string;
    lastWriteMs: number | null;
    lastBarMs: number | null;
    containerRunning: boolean | null;
  };
  totalEquity: number | null;
  dayChange: number | null;
  dayChangePct: number | null;
  openRiskUsd: number | null;
  openRiskPct: number | null;
  maxRiskPct: number;
  minStopDistancePct: number | null;
  totalR: number | null;
  positionCount: number;
  /** Vị thế đang mở mà KHÔNG tìm thấy stop ở đâu cả — cảnh báo quan trọng nhất. */
  unprotectedCount: number;
  /** Dashboard web có đang nghe không — để panel không mở ra một tab chết. */
  dashboardUp: boolean;
  venues: WidgetVenue[];
}

// ── State file của bot ──────────────────────────────────────────────────────

interface StateUnit {
  entry: number;
  initialSL: number;
  entryTime: number;
}

interface StateEntry {
  dir: "long" | "short";
  units: StateUnit[];
  sl: number | null;
}

/**
 * Đọc mọi state file, trả về map symbol → vị thế bot ghi nhận.
 * Hai schema cùng tồn tại: `pos` (turtle/fast, nhiều unit) và `livePos` (SMC, một unit).
 */
function readBotState(): { bySymbol: Map<string, StateEntry>; lastWrite: number | null; lastBar: number | null } {
  const bySymbol = new Map<string, StateEntry>();
  let lastWrite: number | null = null;
  let lastBar: number | null = null;

  for (const name of STATE_FILES) {
    const file = path.join(DATA_DIR, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
      const mtime = fs.statSync(file).mtimeMs;
      if (lastWrite === null || mtime > lastWrite) lastWrite = mtime;
    } catch {
      continue; // file chưa tồn tại — sổ đó chưa chạy bao giờ
    }

    let rows: any[];
    try {
      rows = JSON.parse(raw);
    } catch {
      continue; // đang ghi dở — bỏ qua vòng này
    }
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const symbol = String(row?.symbol ?? "").toLowerCase();
      if (!symbol) continue;

      for (const t of [row?.lastBarTime, row?.lastOpenTime]) {
        if (typeof t === "number" && (lastBar === null || t > lastBar)) lastBar = t;
      }

      const pos = row?.pos ?? row?.livePos;
      if (!pos || (pos.dir !== "long" && pos.dir !== "short")) continue;

      const units: StateUnit[] = Array.isArray(pos.units)
        ? pos.units
            .filter((u: any) => typeof u?.entry === "number" && typeof u?.initialSL === "number")
            .map((u: any) => ({ entry: u.entry, initialSL: u.initialSL, entryTime: Number(u.entryTime) || 0 }))
        : typeof pos.entry === "number" && typeof pos.initialSL === "number"
          ? [{ entry: pos.entry, initialSL: pos.initialSL, entryTime: Number(pos.entryTime) || 0 }]
          : [];
      if (units.length === 0) continue;

      bySymbol.set(symbol, { dir: pos.dir, units, sl: typeof pos.sl === "number" ? pos.sl : null });
    }
  }

  return { bySymbol, lastWrite, lastBar };
}

/** Dashboard web (mặc định 3848) có ai nghe không. Chỉ thử TCP, không gọi HTTP. */
async function dashboardListening(): Promise<boolean> {
  const url = process.env.DASHBOARD_URL?.trim() || "http://127.0.0.1:3848";
  let host = "127.0.0.1";
  let port = 3848;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    /* URL sai định dạng → giữ mặc định */
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** Container bot có chạy không. null = không hỏi được Docker (daemon tắt cũng tính là không chạy). */
async function containerRunning(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", BOT_CONTAINER], {
      timeout: 4000,
    });
    return stdout.trim() === "true";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Không có container / daemon tắt → bot chắc chắn không chạy.
    if (/No such object|Cannot connect|daemon|docker.sock|ENOENT/i.test(msg)) return false;
    return null;
  }
}

// ── Mốc vốn đầu ngày ────────────────────────────────────────────────────────

const vnDate = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // YYYY-MM-DD

/**
 * Ghi lần đọc ĐẦU TIÊN của mỗi ngày làm mốc, trả về mốc hôm nay.
 * Lưu ý: nếu server khởi động giữa ngày thì mốc là giữa ngày, mức đổi sẽ nhỏ hơn thực tế.
 */
function dayBaseline(equity: number, now: number): number | null {
  let history: Record<string, number> = {};
  try {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    /* chưa có lịch sử */
  }

  const today = vnDate(now);
  if (typeof history[today] !== "number") {
    history[today] = equity;
    const keep = Object.keys(history).sort().slice(-40);
    const trimmed: Record<string, number> = {};
    for (const k of keep) trimmed[k] = history[k];
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
    } catch {
      /* không ghi được thì thôi — chỉ mất mức đổi trong ngày */
    }
    return equity;
  }
  return history[today];
}

// ── Ghép vị thế sàn với state của bot ───────────────────────────────────────

function enrich(
  symbol: string,
  dir: "long" | "short",
  entry: number,
  mark: number,
  size: number,
  pnl: number,
  state: StateEntry | undefined,
  exchangeStop: number | null,
  now: number
): WidgetPosition {
  const sign = dir === "long" ? 1 : -1;
  let r: number | null = null;
  let heldDays: number | null = null;

  if (state && state.dir === dir) {
    let acc = 0;
    let ok = true;
    for (const u of state.units) {
      const risk = Math.abs(u.entry - u.initialSL);
      if (!(risk > 0)) {
        ok = false;
        break;
      }
      acc += ((mark - u.entry) * sign) / risk;
    }
    if (ok) r = acc;

    const first = state.units.map((u) => u.entryTime).filter((t) => t > 0);
    if (first.length > 0) heldDays = (now - Math.min(...first)) / 86_400_000;
  }

  // Lệnh chờ trên sàn là stop THẬT sẽ khớp; state của bot chỉ là ý định.
  const stop = exchangeStop ?? state?.sl ?? null;
  const stopSource: "exchange" | "state" | null =
    exchangeStop !== null ? "exchange" : state?.sl != null ? "state" : null;
  const stopDistancePct = stop !== null && mark > 0 ? Math.abs(mark - stop) / mark : null;
  const riskUsd = stop !== null ? Math.abs(mark - stop) * Math.abs(size) : null;

  return {
    symbol: symbol.replace(/usdt$/i, "").toUpperCase(),
    dir,
    units: state?.units.length ?? 1,
    entry,
    mark,
    stop,
    stopSource,
    r,
    pnl,
    riskUsd,
    heldDays,
    stopDistancePct,
  };
}

// ── Từng sàn ────────────────────────────────────────────────────────────────

/** Stop đang chờ trên Binance cho vị thế này. Long thoát bằng SELL, short bằng BUY. */
async function binanceStop(
  api: NonNullable<ReturnType<typeof createBinanceFromEnv>>,
  symbol: string,
  dir: "long" | "short"
): Promise<number | null> {
  const closingSide = dir === "long" ? "SELL" : "BUY";
  const prices: number[] = [];
  for (const fetch of [api.getOpenOrders.bind(api), api.getOpenAlgoOrders.bind(api)]) {
    try {
      for (const o of await fetch(symbol)) {
        // Lệnh thường dùng `type`; lệnh algo (CONDITIONAL) dùng `orderType`.
        const type = String(o.orderType ?? o.type ?? o.strategyType ?? "");
        if (!/STOP/i.test(type) || /TAKE_PROFIT/i.test(type)) continue;
        if (String(o.side) !== closingSide) continue;
        const price = parseFloat(o.stopPrice ?? o.triggerPrice ?? "0");
        if (price > 0) prices.push(price);
      }
    } catch {
      /* endpoint không có/không quyền → thử nguồn còn lại */
    }
  }
  if (prices.length === 0) return null;
  // Nhiều stop cùng lúc: lấy cái BẢO VỆ chặt nhất (gần giá nhất về phía thua).
  return dir === "long" ? Math.max(...prices) : Math.min(...prices);
}

async function readBinance(state: Map<string, StateEntry>, now: number): Promise<WidgetVenue> {
  const venue: WidgetVenue = { id: "binance", name: "BINANCE", equity: null, ok: false, error: null, positions: [] };
  const api = createBinanceFromEnv();
  if (!api) {
    venue.error = "Chưa có API key";
    return venue;
  }

  try {
    await api.syncTime();
    venue.equity = (await api.getEquity()).marginBalance;
    venue.ok = true;
  } catch (err) {
    venue.error = err instanceof Error ? err.message : String(err);
    return venue;
  }

  for (const symbol of getBotUniverse().all) {
    try {
      const p = await api.getPosition(symbol);
      if (Math.abs(p.positionAmt) === 0) continue;
      const dir = p.positionAmt > 0 ? "long" : "short";
      venue.positions.push(
        enrich(
          symbol,
          dir,
          p.entryPrice,
          p.markPrice,
          p.positionAmt,
          p.unrealizedProfit,
          state.get(symbol),
          await binanceStop(api, symbol, dir),
          now
        )
      );
    } catch {
      /* lỗi một symbol không được làm hỏng cả sàn */
    }
  }
  return venue;
}

async function readMexc(state: Map<string, StateEntry>, now: number): Promise<WidgetVenue> {
  const venue: WidgetVenue = { id: "mexc", name: "MEXC", equity: null, ok: false, error: null, positions: [] };
  const api = createMexcFromEnv();
  if (!api) {
    venue.error = "Chưa có API key";
    return venue;
  }

  try {
    await api.syncTime();
    venue.equity = (await api.getEquity()).equity;
    venue.ok = true;
  } catch (err) {
    venue.error = err instanceof Error ? err.message : String(err);
    return venue;
  }

  let open: Awaited<ReturnType<typeof api.getOpenPositions>>;
  try {
    open = await api.getOpenPositions();
  } catch (err) {
    venue.error = err instanceof Error ? err.message : String(err);
    return venue;
  }
  if (open.length === 0) return venue;

  // contractSize để quy hợp đồng về khối lượng cơ sở (risk = |mark−stop| × vol × contractSize).
  const symbols = open.map((p) => p.symbol.replace("_", "").toLowerCase());
  const sizeOf = new Map<string, number>();
  try {
    await api.loadContracts(symbols);
    for (const s of symbols) sizeOf.set(s, (api as any).contracts?.get(toMexcSymbol(s))?.contractSize ?? 1);
  } catch {
    /* thiếu contractSize → coi như 1, riskUsd có thể sai thang */
  }

  for (const p of open) {
    const symbol = p.symbol.replace("_", "").toLowerCase();
    const dir = p.positionType === 1 ? "long" : "short";
    let mark = p.holdAvgPrice;
    try {
      mark = (await api.getTicker(symbol)).fairPrice || p.holdAvgPrice;
    } catch {
      /* không lấy được mark thì dùng giá vào — R sẽ là 0 chứ không sai dấu */
    }
    let stop: number | null = null;
    try {
      const orders = await api.getOpenStopOrders(symbol);
      const live = orders.filter((o) => o.isFinished === 0 && o.stopLossPrice > 0);
      if (live.length > 0) stop = live[0].stopLossPrice;
    } catch {
      /* không đọc được lệnh chờ → rơi về state của bot */
    }
    const size = p.holdVol * (sizeOf.get(symbol) ?? 1);
    venue.positions.push(
      enrich(symbol, dir, p.holdAvgPrice, mark, size, p.unRealizedPnl, state.get(symbol), stop, now)
    );
  }
  return venue;
}

// ── Ghép lại ────────────────────────────────────────────────────────────────

export async function buildWidgetFeed(): Promise<WidgetFeed> {
  const now = Date.now();
  const { bySymbol, lastWrite, lastBar } = readBotState();

  const [running, dashboardUp, binance, mexc] = await Promise.all([
    containerRunning(),
    dashboardListening(),
    readBinance(bySymbol, now),
    readMexc(bySymbol, now),
  ]);

  let state: HealthState;
  let detail: string;
  if (running === false) {
    state = "stopped";
    detail = `Container ${BOT_CONTAINER} không chạy`;
  } else if (lastBar !== null && now - lastBar > STALE_AFTER_MS) {
    state = "stale";
    detail = "Quá hai nến chưa xử lý nến mới";
  } else if (running === null) {
    state = "stale";
    detail = "Không hỏi được trạng thái container";
  } else {
    state = "running";
    detail = "Bình thường";
  }

  const venues = [binance, mexc];
  const equities = venues.filter((v) => v.ok && v.equity !== null).map((v) => v.equity as number);
  const totalEquity = equities.length > 0 ? equities.reduce((a, b) => a + b, 0) : null;

  const positions = venues.flatMap((v) => v.positions);
  const stopDistances = positions.map((p) => p.stopDistancePct).filter((d): d is number => d !== null);
  const risks = positions.map((p) => p.riskUsd).filter((x): x is number => x !== null);
  const rs = positions.map((p) => p.r).filter((x): x is number => x !== null);

  const openRiskUsd = risks.length > 0 ? risks.reduce((a, b) => a + b, 0) : null;
  const baseline = totalEquity !== null ? dayBaseline(totalEquity, now) : null;

  return {
    now,
    health: { state, detail, lastWriteMs: lastWrite, lastBarMs: lastBar, containerRunning: running },
    totalEquity,
    dayChange: totalEquity !== null && baseline !== null ? totalEquity - baseline : null,
    dayChangePct:
      totalEquity !== null && baseline !== null && baseline > 0 ? (totalEquity - baseline) / baseline : null,
    openRiskUsd,
    openRiskPct: openRiskUsd !== null && totalEquity && totalEquity > 0 ? openRiskUsd / totalEquity : null,
    maxRiskPct: MAX_RISK_PCT,
    minStopDistancePct: stopDistances.length > 0 ? Math.min(...stopDistances) : null,
    totalR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) : null,
    unprotectedCount: positions.filter((p) => p.stop === null).length,
    dashboardUp,
    positionCount: positions.length,
    venues,
  };
}
