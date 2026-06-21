/**
 * Fetch nến Binance có phân trang, song song + cache đĩa (tăng tốc backtest/chart).
 *
 * KLINE_CACHE=0     — tắt cache
 * KLINE_FETCH_CONCURRENCY=4 — số request song song (mặc định 4)
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { Candle, TF_MS } from "./strategy";

type KlineSource = { url: string; maxLimit: number };
const KLINE_SOURCES: KlineSource[] = [
  { url: "https://fapi.binance.com/fapi/v1/klines", maxLimit: 1500 },
  { url: "https://data-api.binance.vision/api/v3/klines", maxLimit: 1000 },
];

const CACHE_DIR = path.join(process.cwd(), ".cache", "klines");
const CACHE_ENABLED = process.env.KLINE_CACHE !== "0";
/** Giữ tối đa ~2 năm 5m hoặc tương đương — tránh file cache phình vô hạn. */
const CACHE_MAX_BARS = 220_000;

function parseKlineBatch(data: unknown[]): Candle[] {
  return (data as any[]).map((k: any[]) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    quoteVolume: parseFloat(k[7]),
    takerBuyVolume: parseFloat(k[9]),
  }));
}

function mergeDedupeSort(a: Candle[], b: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.openTime, c);
  for (const c of b) map.set(c.openTime, c);
  return [...map.values()].sort((x, y) => x.openTime - y.openTime);
}

function cacheFilePath(symbol: string, tf: string): string {
  return path.join(CACHE_DIR, `${symbol.toLowerCase()}_${tf}.json`);
}

function readCache(symbol: string, tf: string): Candle[] {
  if (!CACHE_ENABLED) return [];
  try {
    const p = cacheFilePath(symbol, tf);
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Candle[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeCache(symbol: string, tf: string, candles: Candle[]): void {
  if (!CACHE_ENABLED || candles.length === 0) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const trimmed =
      candles.length > CACHE_MAX_BARS ? candles.slice(candles.length - CACHE_MAX_BARS) : candles;
    fs.writeFileSync(cacheFilePath(symbol, tf), JSON.stringify(trimmed));
  } catch {
    /* cache best-effort */
  }
}

async function fetchOnePage(
  src: KlineSource,
  symbol: string,
  tf: string,
  limit: number,
  endTime?: number,
  startTime?: number,
): Promise<Candle[]> {
  const params: Record<string, string | number> = {
    symbol: symbol.toUpperCase(),
    interval: tf,
    limit: Math.min(limit, src.maxLimit),
  };
  if (endTime != null) params.endTime = endTime;
  if (startTime != null) params.startTime = startTime;
  const res = await axios.get(src.url, { params, timeout: 15000 });
  return parseKlineBatch(res.data as unknown[]);
}

function fetchConcurrency(): number {
  const n = parseInt(process.env.KLINE_FETCH_CONCURRENCY ?? "4", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 4;
}

/** Lấy đủ totalBars nến lùi từ now — nhiều trang song song. */
async function fetchKlinesFromSourceParallel(
  src: KlineSource,
  symbol: string,
  tf: string,
  totalBars: number,
): Promise<Candle[]> {
  const tfMs = TF_MS[tf];
  if (!tfMs) throw new Error(`TF không hỗ trợ: ${tf}`);

  const pages = Math.ceil(totalBars / src.maxLimit);
  const endTimes: number[] = [];
  let end = Date.now();
  for (let p = 0; p < pages; p++) {
    endTimes.push(end);
    end -= src.maxLimit * tfMs;
  }

  const conc = fetchConcurrency();
  const chunks: Candle[][] = [];
  for (let i = 0; i < endTimes.length; i += conc) {
    const slice = endTimes.slice(i, i + conc);
    const batch = await Promise.all(
      slice.map((et) => fetchOnePage(src, symbol, tf, src.maxLimit, et)),
    );
    chunks.push(...batch);
    const soFar = mergeDedupeSort([], chunks.flat()).length;
    process.stdout.write(`\r[Fetch ${symbol.toUpperCase()}] ~${Math.min(soFar, totalBars)}/${totalBars} nến ${tf}...`);
  }
  process.stdout.write("\n");

  const merged = mergeDedupeSort([], chunks.flat());
  if (merged.length <= totalBars) return merged;
  return merged.slice(merged.length - totalBars);
}

/** Bù nến cũ hơn openTime đầu tiên (tuần tự — ít request). */
async function backfillOlder(
  src: KlineSource,
  symbol: string,
  tf: string,
  existing: Candle[],
  oldestNeeded: number,
): Promise<Candle[]> {
  let merged = existing;
  let guard = 0;
  while (merged.length > 0 && merged[0].openTime > oldestNeeded && guard++ < 500) {
    const need = src.maxLimit;
    const batch = await fetchOnePage(src, symbol, tf, need, merged[0].openTime - 1);
    if (batch.length === 0) break;
    merged = mergeDedupeSort(batch, merged);
    process.stdout.write(
      `\r[Fetch ${symbol.toUpperCase()}] cache+ ${merged.length} nến ${tf} (bù lịch sử)...`,
    );
  }
  process.stdout.write("\n");
  return merged;
}

/** Cập nhật nến mới nhất từ startTime. */
async function fetchForward(
  src: KlineSource,
  symbol: string,
  tf: string,
  startTime: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  let start = startTime;
  let guard = 0;
  while (guard++ < 200) {
    const batch = await fetchOnePage(src, symbol, tf, src.maxLimit, undefined, start);
    if (batch.length === 0) break;
    all.push(...batch);
    const last = batch[batch.length - 1].openTime;
    start = last + 1;
    if (batch.length < src.maxLimit) break;
  }
  return all;
}

async function fetchWithSource(
  src: KlineSource,
  symbol: string,
  tf: string,
  totalBars: number,
): Promise<Candle[]> {
  const tfMs = TF_MS[tf];
  if (!tfMs) throw new Error(`TF không hỗ trợ: ${tf}`);

  const oldestNeeded = Date.now() - totalBars * tfMs;
  let cached = readCache(symbol, tf);

  if (cached.length > 0) {
    const last = cached[cached.length - 1].openTime;
    const stale = Date.now() - last >= tfMs * 2;
    if (stale) {
      const forward = await fetchForward(src, symbol, tf, last + 1);
      cached = mergeDedupeSort(cached, forward);
    }
    if (cached.length > 0 && cached[0].openTime > oldestNeeded) {
      cached = await backfillOlder(src, symbol, tf, cached, oldestNeeded);
    }
    writeCache(symbol, tf, cached);
    if (cached.length >= totalBars) {
      return cached.slice(cached.length - totalBars);
    }
    const missing = totalBars - cached.length;
    const older = await fetchKlinesFromSourceParallel(src, symbol, tf, missing + src.maxLimit);
    const merged = mergeDedupeSort(older, cached);
    writeCache(symbol, tf, merged);
    return merged.length <= totalBars ? merged : merged.slice(merged.length - totalBars);
  }

  const fresh = await fetchKlinesFromSourceParallel(src, symbol, tf, totalBars);
  writeCache(symbol, tf, fresh);
  return fresh;
}

export async function fetchKlinesPaged(symbol: string, tf: string, totalBars: number): Promise<Candle[]> {
  let lastErr: unknown;
  for (const src of KLINE_SOURCES) {
    try {
      return await fetchWithSource(src, symbol, tf, totalBars);
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      console.warn(`[Fetch] ${src.url} lỗi${status ? ` (HTTP ${status})` : ""}, thử nguồn kế tiếp...`);
    }
  }
  throw lastErr;
}
