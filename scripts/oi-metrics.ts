/**
 * oi-metrics.ts — tải và cache dữ liệu "metrics" của Binance USDⓈ-M (Open Interest, tỉ lệ long/short
 * của top trader, tỉ lệ taker) từ data.binance.vision, cộng lịch sử funding từ fapi.
 *
 * Protocol dùng các hàm này: planning/oi-footprint-preregistration-2026-09-28.md.
 *
 * Nguồn metrics chỉ có file THEO NGÀY (monthly trả 404), 288 dòng × 5 phút. CORE8 có từ 01/12/2021.
 * Cache: .cache/metrics/{symbol}/{YYYY-MM-DD}.csv (bản gọn 5 cột); ngày không có file ghi "MISSING"
 * để không tải lại. Funding: .cache/funding8h/{symbol}.json.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import axios from "axios";

export interface MetricRow {
  time: number;      // create_time (ms, UTC)
  oi: number;        // sum_open_interest — đơn vị COIN, không phải USD
  topPos: number;    // sum_toptrader_long_short_ratio (theo vị thế, top 20% số dư ký quỹ)
  allAcct: number;   // count_long_short_ratio (mọi tài khoản)
  taker: number;     // sum_taker_long_short_vol_ratio
}

const DAY = 86_400_000;
const FIVE_MIN = 300_000;
const METRICS_DIR = path.resolve(".cache", "metrics");
const FUNDING_DIR = path.resolve(".cache", "funding8h");

export const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Giải nén file zip MỘT tệp: đọc central directory rồi inflate đúng đoạn dữ liệu. */
function unzipSingle(buf: Buffer): string {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip hỏng: không thấy EOCD");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compSize);
  return (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
}

function parseCsv(text: string): MetricRow[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (name: string) => head.indexOf(name);
  const iT = col("create_time");
  const iOi = col("sum_open_interest");
  const iTop = col("sum_toptrader_long_short_ratio");
  const iAll = col("count_long_short_ratio");
  const iTk = col("sum_taker_long_short_vol_ratio");
  const rows: MetricRow[] = [];
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(",");
    const time = Date.parse(f[iT].replace(" ", "T") + "Z");
    const num = (i: number) => (i >= 0 && f[i] !== "" ? Number(f[i]) : NaN);
    if (!Number.isFinite(time)) continue;
    rows.push({ time, oi: num(iOi), topPos: num(iTop), allAcct: num(iAll), taker: num(iTk) });
  }
  return rows;
}

function cachePath(symbol: string, day: string): string {
  return path.join(METRICS_DIR, symbol.toLowerCase(), `${day}.csv`);
}

function readCache(file: string): MetricRow[] | null | undefined {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8");
  if (text.startsWith("MISSING")) return null;
  return text.trim().split("\n").map((line) => {
    const [t, oi, topPos, allAcct, taker] = line.split(",").map(Number);
    return { time: t * 60_000, oi, topPos, allAcct, taker };
  });
}

function writeCache(file: string, rows: MetricRow[] | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = rows === null
    ? "MISSING\n"
    : rows.map((r) => [r.time / 60_000, r.oi, r.topPos, r.allAcct, r.taker].join(",")).join("\n") + "\n";
  fs.writeFileSync(file, body);
}

async function fetchDay(symbol: string, day: string): Promise<MetricRow[] | null> {
  const file = cachePath(symbol, day);
  const cached = readCache(file);
  if (cached !== undefined) return cached;
  const sym = symbol.toUpperCase();
  const url = `https://data.binance.vision/data/futures/um/daily/metrics/${sym}/${sym}-metrics-${day}.zip`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer", timeout: 30_000, validateStatus: () => true });
      if (res.status === 404) { writeCache(file, null); return null; }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const rows = parseCsv(unzipSingle(Buffer.from(res.data)));
      writeCache(file, rows);
      return rows;
    } catch (e) {
      if (attempt === 3) throw new Error(`${sym} ${day}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

/** Tải (song song có giới hạn) mọi ngày yêu cầu. Trả về chỉ mục theo mốc 5 phút. */
export async function loadMetricsDays(
  symbol: string,
  days: Iterable<string>,
  concurrency = 12,
): Promise<{ byTime: Map<number, MetricRow>; missingDays: string[] }> {
  const list = [...new Set(days)].sort();
  const byTime = new Map<number, MetricRow>();
  const missingDays: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const day = list[next++];
      const rows = await fetchDay(symbol, day);
      if (rows === null) { missingDays.push(day); continue; }
      for (const r of rows) byTime.set(Math.round(r.time / FIVE_MIN) * FIVE_MIN, r);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { byTime, missingDays: missingDays.sort() };
}

export function daysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = Math.floor(from / DAY) * DAY; t <= to; t += DAY) out.push(dayStr(t));
  return out;
}

/** OI đúng tại mốc 5 phút `time` (không lùi). */
export function rowAt(byTime: Map<number, MetricRow>, time: number): MetricRow | undefined {
  return byTime.get(Math.round(time / FIVE_MIN) * FIVE_MIN);
}

/** Snapshot gần nhất có create_time ≤ `time`, lùi tối đa `maxBack` bước 5 phút. Không nhìn trước. */
export function rowAtOrBefore(byTime: Map<number, MetricRow>, time: number, maxBack = 12): MetricRow | undefined {
  const base = Math.floor(time / FIVE_MIN) * FIVE_MIN;
  for (let k = 0; k <= maxBack; k++) {
    const r = byTime.get(base - k * FIVE_MIN);
    if (r && Number.isFinite(r.oi) && r.oi > 0) return r;
  }
  return undefined;
}

export interface FundingPoint { time: number; rate8h: number }

/** Lịch sử funding, quy về đơn vị 8 giờ (rate × 8 / số giờ giữa hai kỳ). Có cache, tải thêm phần mới. */
export async function loadFunding8h(symbol: string, from: number): Promise<FundingPoint[]> {
  const file = path.join(FUNDING_DIR, `${symbol.toLowerCase()}.json`);
  let raw: { time: number; rate: number }[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  let start = raw.length && raw[0].time <= from ? raw[raw.length - 1].time + 1 : from;
  if (raw.length && raw[0].time > from) raw = [];
  for (;;) {
    const res = await axios.get("https://fapi.binance.com/fapi/v1/fundingRate", {
      params: { symbol: symbol.toUpperCase(), startTime: start, limit: 1000 },
      timeout: 30_000,
    });
    const page = (res.data as { fundingTime: number; fundingRate: string }[])
      .map((x) => ({ time: x.fundingTime, rate: Number(x.fundingRate) }));
    raw.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1].time + 1;
    await new Promise((r) => setTimeout(r, 250));
  }
  fs.mkdirSync(FUNDING_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw));
  const out: FundingPoint[] = [];
  for (let i = 1; i < raw.length; i++) {
    const hours = Math.round((raw[i].time - raw[i - 1].time) / 3_600_000);
    if (hours <= 0) continue;
    out.push({ time: raw[i].time, rate8h: (raw[i].rate * 8) / hours });
  }
  return out;
}
