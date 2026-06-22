/**
 * live-state.ts — Lưu trạng thái bot live qua restart + nhật ký lệnh (journal).
 *
 * Lý do: livePos/cooldown chỉ ở RAM → pm2 restart (đổi CONFIG) / reboot VM / crash khi
 * đang giữ lệnh swing (1-7 ngày) làm MẤT vị thế (bot quên báo exit, /status hiện flat).
 * State file cho phép rehydrate vị thế + (kết hợp replay nến trong btc-alert-bot.ts) bắt
 * exit đã xảy ra trong lúc downtime.
 *
 * CHỈ persist vị thế ĐANG MỞ (giá trị tuyệt đối — không phụ thuộc index buffer). KHÔNG
 * persist pending ARM (chứa index buffer cũ, hết hạn 6h, rủi ro thấp): để tracker tự
 * re-arm sau restart.
 *
 * Journal (trades-live.jsonl) ghi mỗi entry/exit để đối chiếu live vs backtest.
 */
import fs from "fs";
import path from "path";

const STATE_FILE = path.join(process.cwd(), "bot-state.json");
const JOURNAL_FILE = path.join(process.cwd(), "trades-live.jsonl");

export type PersistedLivePos = {
  dir: "long" | "short";
  entryTime: number;
  entry: number;
  initialSL: number;
  sl: number;
  target: number;
  zoneDesc: string;
};

export type PersistedSymbol = {
  symbol: string;
  lastOpenTime: number;
  cooldownUntilTime: number;
  lastArmAlertAt: number;
  livePos: PersistedLivePos | null;
};

export function loadState(): Record<string, PersistedSymbol> {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const arr = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PersistedSymbol[];
    const map: Record<string, PersistedSymbol> = {};
    for (const s of arr) map[s.symbol] = s;
    return map;
  } catch (e) {
    console.error("[State] đọc bot-state.json lỗi, khởi động sạch:", e instanceof Error ? e.message : e);
    return {};
  }
}

export function saveState(states: PersistedSymbol[]): void {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(states, null, 2));
    fs.renameSync(tmp, STATE_FILE); // ghi atomic (tránh file rách nếu crash giữa chừng)
  } catch (e) {
    console.error("[State] ghi bot-state.json lỗi:", e instanceof Error ? e.message : e);
  }
}

export function appendJournal(record: Record<string, unknown>): void {
  try {
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(record) + "\n");
  } catch (e) {
    console.error("[Journal] ghi trades-live.jsonl lỗi:", e instanceof Error ? e.message : e);
  }
}
