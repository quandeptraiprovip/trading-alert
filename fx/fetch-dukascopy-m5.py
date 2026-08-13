#!/usr/bin/env python3
"""
fetch-dukascopy-m5.py — tải nến 5 PHÚT từ Dukascopy, cho phép chạy phương pháp Key+Volume
(FX Dream) ở ĐÚNG THANG GỐC của nó (nền 5m) thay vì thang đã dịch.

VÌ SAO CẦN FILE RIÊNG: `fetch-dukascopy.py` lấy nến ngày theo NĂM và nến giờ theo THÁNG. Nến phút
thì Dukascopy chỉ phục vụ theo NGÀY (`{sym}/{yyyy}/{mm-1}/{dd}/BID_candles_min_1.bi5`) — không có
file tháng, cũng không có min_5 (đã kiểm: trả 0 byte). Vòng lặp theo ngày là một cấu trúc khác nên
tách riêng, không sửa file đã dùng cho toàn bộ nghiên cứu trước.

Gộp 1m → 5m ngay lúc tải: giữ nguyên 1m sẽ tốn ~340MB/công cụ dưới dạng JSON, mà thang gốc của
phương pháp chỉ cần 5m.

BÀI HỌC ĐÃ TRẢ GIÁ: lỗi mạng bị nuốt từng làm mất trọn năm 2013 của XAUUSD — đúng năm vàng sập 28%.
Ở đây mọi khối tải hỏng đều NÉM EXCEPTION; thiếu dữ liệu phải làm chương trình dừng, không được
lặng lẽ cho ra một kết luận sai.

Chạy:
    python3 fx/fetch-dukascopy-m5.py XAUUSD EURUSD --from 2019 --to 2025
Ghi ra: .cache/fx/{symbol}_m5.json — [{openTime, open, high, low, close, volume, spread}]
"""

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import lzma
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple

FEED = "https://datafeed.dukascopy.com/datafeed"
CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache", "fx")
REC = struct.Struct(">5if")
INDEX_CMD = ["USA500IDXUSD", "USATECHIDXUSD", "DEUIDXEUR", "JPNIDXJPY", "GBRIDXGBP",
             "LIGHTCMDUSD", "BRENTCMDUSD"]


def point_scale(symbol: str) -> float:
    if symbol == "COPPERCMDUSD":
        return 1e4
    if symbol.endswith("JPY") or symbol in ("XAUUSD", "XAGUSD") or symbol in INDEX_CMD:
        return 1e3
    return 1e5


def http_get(url: str, tries: int = 6) -> Optional[bytes]:
    """404 = ngày không có dữ liệu (cuối tuần/nghỉ) → None. Còn lại: lùi dần rồi thử lại."""
    delay = 1.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            return urllib.request.urlopen(req, timeout=45).read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == tries - 1:
                raise
        except Exception:
            if attempt == tries - 1:
                raise
        time.sleep(delay)
        delay = min(delay * 2, 20)
    return None


def decode(blob: Optional[bytes], day_start_ms: int, scale: float) -> Dict[int, Tuple]:
    """→ {openTime_ms: (open, high, low, close, volume)}; offset là GIÂY kể từ đầu ngày."""
    if not blob:
        return {}
    raw = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(blob)
    out = {}
    for i in range(len(raw) // REC.size):
        sec, o, c, lo, hi, vol = REC.unpack_from(raw, i * REC.size)
        out[day_start_ms + sec * 1000] = (o / scale, hi / scale, lo / scale, c / scale, vol)
    return out


def fetch_day(symbol: str, day: dt.date, scale: float) -> List[dict]:
    """Một ngày nến 1m (BID+ASK → MID + spread đo được), đã gộp thành 5m."""
    start_ms = int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp() * 1000)
    path = f"{FEED}/{symbol}/{day.year}/{day.month - 1:02d}/{day.day:02d}"
    bid = decode(http_get(f"{path}/BID_candles_min_1.bi5"), start_ms, scale)
    if not bid:
        return []
    ask = decode(http_get(f"{path}/ASK_candles_min_1.bi5"), start_ms, scale)

    # Gộp 1m → 5m theo mốc tuyệt đối, chỉ giữ phút có giao dịch (volume > 0 = thị trường mở).
    buckets: Dict[int, List[Tuple]] = {}
    for ts in sorted(bid):
        b = bid[ts]
        if b[4] <= 0:
            continue
        a = ask.get(ts)
        if a is None or a[4] <= 0:
            continue
        buckets.setdefault(ts - (ts % 300_000), []).append((b, a))

    rows = []
    for bucket_ts in sorted(buckets):
        items = buckets[bucket_ts]
        bs = [x[0] for x in items]
        aks = [x[1] for x in items]
        mid = lambda b, a, i: (b[i] + a[i]) / 2  # noqa: E731
        rows.append({
            "openTime": bucket_ts,
            "open": mid(bs[0], aks[0], 0),
            "high": max(mid(b, a, 1) for b, a in items),
            "low": min(mid(b, a, 2) for b, a in items),
            "close": mid(bs[-1], aks[-1], 3),
            "volume": sum(b[4] + a[4] for b, a in items) / 2,
            "spread": sum(a[3] - b[3] for b, a in items) / len(items),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="+")
    ap.add_argument("--from", dest="y0", type=int, default=2019)
    ap.add_argument("--to", dest="y1", type=int, default=dt.date.today().year)
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    for symbol in args.symbols:
        scale = point_scale(symbol)
        days = []
        d = dt.date(args.y0, 1, 1)
        end = min(dt.date(args.y1, 12, 31), dt.date.today() - dt.timedelta(days=1))
        while d <= end:
            if d.weekday() < 5 or d.weekday() == 6:  # T7 đóng cửa hoàn toàn; CN có phiên mở lại
                days.append(d)
            d += dt.timedelta(days=1)

        rows: List[dict] = []
        failed: List[dt.date] = []
        t0 = time.time()
        with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(fetch_day, symbol, day, scale): day for day in days}
            done = 0
            for fut in cf.as_completed(futs):
                done += 1
                try:
                    rows.extend(fut.result())
                except Exception:
                    failed.append(futs[fut])
                if done % 250 == 0:
                    print(f"  {symbol}: {done}/{len(days)} ngày, {len(rows)} nến 5m", file=sys.stderr)

        if failed:
            raise RuntimeError(
                f"{symbol}: {len(failed)} ngày tải HỎNG ({failed[:5]}…) — "
                "KHÔNG ghi file, vì thiếu dữ liệu âm thầm từng làm sai cả một kết luận."
            )

        # GỘP với dữ liệu đã tải trước đó. Mỗi lần chạy chỉ lấy một dải năm (giới hạn thời gian
        # chạy), nên ghi đè sẽ âm thầm xoá các năm đã có — đúng họ lỗi "mất trọn năm 2013".
        path = os.path.join(CACHE, f"{symbol}_m5.json")
        if os.path.exists(path):
            with open(path) as f:
                old = json.load(f)
            have = {r["openTime"] for r in rows}
            rows.extend(r for r in old if r["openTime"] not in have)
        rows.sort(key=lambda r: r["openTime"])
        with open(path, "w") as f:
            json.dump(rows, f)
        span = ""
        if rows:
            a = dt.datetime.utcfromtimestamp(rows[0]["openTime"] / 1000).strftime("%Y-%m-%d")
            b = dt.datetime.utcfromtimestamp(rows[-1]["openTime"] / 1000).strftime("%Y-%m-%d")
            span = f" {a}→{b}"
        print(f"{symbol}: {len(rows)} nến 5m{span} → {path} "
              f"({os.path.getsize(path)/1e6:.1f} MB, {time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
