#!/usr/bin/env python3
"""
fetch-dukascopy.py — tải nến H1 lịch sử FX từ datafeed công khai của Dukascopy.

VÌ SAO NGUỒN NÀY: là feed của một BROKER THẬT, có cả BID và ASK nên spread (chi phí lớn nhất
của FX bán lẻ) được ĐO chứ không phải giả định; lịch sử tới 2003 cho major. Yahoo chỉ có ~2,8 năm
nến giờ và không có ask; FRED chỉ có 1 giá/ngày nên không dựng được ATR/Donchian.

Định dạng .bi5: LZMA (alone) → các bản ghi 24 byte big-endian `>5if`:
    uint32 offset giây kể từ đầu tháng, int32 open/close/low/high (đã nhân point), float32 volume.

Nến CUỐI TUẦN: Dukascopy vẫn phát nến giờ lúc thị trường đóng với volume 0 và OHLC bằng nhau.
Phải LOẠI (volume == 0), nếu không ~48 nến phẳng mỗi tuần sẽ bóp ATR và làm hỏng kênh Donchian.

Chạy:
    python3 fx/fetch-dukascopy.py                       # bộ mặc định, 2004→nay
    python3 fx/fetch-dukascopy.py EURUSD GBPUSD --from 2010
Ghi ra: .cache/fx/{symbol}_h1.json  — [{openTime, open, high, low, close, volume, spread}]
        (giá = MID, `spread` = ask−bid trung bình của giờ đó, cùng đơn vị giá)
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

# Bộ mặc định: 7 major + 4 cross thanh khoản nhất + 2 kim loại (mọi broker FX đều có).
DEFAULT_SYMBOLS = [
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    "EURJPY", "GBPJPY", "EURGBP", "AUDJPY",
    "XAUUSD", "XAGUSD",
]

REC = struct.Struct(">5if")


# Chỉ số + năng lượng: mọi công cụ đã kiểm đều dùng 3 chữ số thập phân; đồng dùng 4.
INDEX_CMD = ["USA500IDXUSD", "USATECHIDXUSD", "DEUIDXEUR", "JPNIDXJPY", "GBRIDXGBP",
             "LIGHTCMDUSD", "BRENTCMDUSD"]


def point_scale(symbol: str) -> float:
    """Ước số quy int → giá, xác định bằng cách đối chiếu giá thật của từng nhóm công cụ."""
    if symbol == "COPPERCMDUSD":
        return 1e4
    if symbol.endswith("JPY") or symbol in ("XAUUSD", "XAGUSD") or symbol in INDEX_CMD:
        return 1e3
    return 1e5


def http_get(url: str, tries: int = 6) -> Optional[bytes]:
    """404 = tháng không có dữ liệu (trả None). 503 = bị rate-limit → lùi dần rồi thử lại."""
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


def decode(blob: Optional[bytes], month_start_ms: int, scale: float) -> Dict[int, Tuple]:
    """→ {openTime_ms: (open, high, low, close, volume)}"""
    if not blob:
        return {}
    raw = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(blob)
    out = {}
    for i in range(len(raw) // REC.size):
        sec, o, c, lo, hi, vol = REC.unpack_from(raw, i * REC.size)
        out[month_start_ms + sec * 1000] = (o / scale, hi / scale, lo / scale, c / scale, vol)
    return out


def fetch_chunk(symbol: str, year: int, month: Optional[int], scale: float) -> List[dict]:
    """
    Một khối nến: BID + ASK ghép thành MID + spread đo được.
    month=None → file NĂM nến ngày (`{sym}/{yyyy}/…_day_1.bi5`, 1 request/năm).
    month=1..12 → file THÁNG nến giờ (`{sym}/{yyyy}/{mm-1}/…_hour_1.bi5`, 12 request/năm).
    """
    if month is None:
        start_ms = int(dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        path = f"{FEED}/{symbol}/{year}"
        kind = "day_1"
    else:
        start_ms = int(dt.datetime(year, month, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
        path = f"{FEED}/{symbol}/{year}/{month - 1:02d}"
        kind = "hour_1"
    bid = decode(http_get(f"{path}/BID_candles_{kind}.bi5"), start_ms, scale)
    ask = decode(http_get(f"{path}/ASK_candles_{kind}.bi5"), start_ms, scale)

    rows = []
    for ts in sorted(bid):
        b = bid[ts]
        if b[4] <= 0:  # volume 0 = thị trường đóng (cuối tuần / nghỉ lễ) → LOẠI
            continue
        a = ask.get(ts)
        if a is None or a[4] <= 0:
            continue
        rows.append({
            "openTime": ts,
            "open": (b[0] + a[0]) / 2,
            "high": (b[1] + a[1]) / 2,
            "low": (b[2] + a[2]) / 2,
            "close": (b[3] + a[3]) / 2,
            "volume": b[4] + a[4],
            # spread trung bình của giờ, xấp xỉ bằng chênh lệch giá đóng ask/bid
            "spread": max(0.0, a[3] - b[3]),
        })
    return rows


def fetch_symbol(symbol: str, years: List[int], workers: int, tf: str) -> List[dict]:
    scale = point_scale(symbol)
    now = dt.datetime.now(dt.timezone.utc)
    if tf == "day":
        chunks = [(y, None) for y in years]
    else:
        chunks = [(y, m) for y in years for m in range(1, 13) if (y, m) <= (now.year, now.month)]

    rows: List[dict] = []
    failed: List[str] = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_chunk, symbol, y, m, scale): (y, m) for (y, m) in chunks}
        for fut in cf.as_completed(futs):
            y, m = futs[fut]
            try:
                rows.extend(fut.result())
            except Exception as e:
                # KHÔNG được nuốt: một năm mất vì 503 từng làm biến mất trọn 2013 của XAUUSD —
                # đúng năm vàng sập 28%, tức là mất luôn cú trend lớn nhất của mẫu.
                failed.append(f"{y}-{m}: {e}")
            done += 1
            print(f"\r[{symbol}] {done}/{len(chunks)} khối, {len(rows)} nến {tf}...", end="", flush=True)
    print()
    if failed:
        raise RuntimeError(f"{symbol}: {len(failed)} khối tải hỏng — {'; '.join(failed[:5])}")
    rows.sort(key=lambda r: r["openTime"])
    return rows


def gap_years(rows: List[dict], max_gap_days: int = 5) -> set:
    """Năm chứa lỗ hổng > max_gap_days (cuối tuần dài nhất là 3 ngày, nghỉ lễ ~4)."""
    bad = set()
    for i in range(1, len(rows)):
        gap = (rows[i]["openTime"] - rows[i - 1]["openTime"]) / 86400_000
        if gap > max_gap_days:
            for r in (rows[i - 1], rows[i]):
                bad.add(dt.datetime.fromtimestamp(r["openTime"] / 1000, dt.timezone.utc).year)
    return bad


def drop_stub_days(rows: List[dict]) -> List[dict]:
    """
    Nến NGÀY của Dukascopy chia theo 00:00–24:00 UTC, nên mỗi tuần có một nến CHỦ NHẬT chỉ chứa
    2 giờ giao dịch (phiên FX mở 22:00 UTC), cộng các ngày nghỉ lễ nửa phiên. Những nến cụt đó có
    biên độ bé bất thường → làm ATR tụt và tạo tín hiệu phá kênh giả. Loại theo volume so với
    TRUNG VỊ TRƯỢT 60 nến (ngưỡng 20%: một ngày giao dịch thật chưa bao giờ xuống dưới, còn mẩu
    2/24 giờ ≈ 8% thì luôn rơi vào).
    """
    out = []
    for i, r in enumerate(rows):
        window = sorted(x["volume"] for x in rows[max(0, i - 60):i + 1])
        med = window[len(window) // 2]
        if med > 0 and r["volume"] < 0.20 * med:
            continue
        out.append(r)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("symbols", nargs="*", default=None)
    ap.add_argument("--from", dest="year_from", type=int, default=2004)
    ap.add_argument("--to", dest="year_to", type=int, default=dt.datetime.now(dt.timezone.utc).year)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--tf", choices=["day", "h1"], default="day")
    ap.add_argument("--repair", action="store_true",
                    help="tải lại những NĂM có lỗ hổng > 5 ngày trong cache (lỗi 503 bị nuốt)")
    ap.add_argument("--force", action="store_true", help="tải lại mọi năm trong khoảng, kệ cache")
    args = ap.parse_args()

    symbols = args.symbols or DEFAULT_SYMBOLS
    os.makedirs(CACHE, exist_ok=True)

    for symbol in symbols:
        out_path = os.path.join(CACHE, f"{symbol}_{args.tf}.json")
        have: List[dict] = []
        if os.path.exists(out_path):
            with open(out_path) as f:
                have = json.load(f)
        # Chỉ tải năm CÒN THIẾU, cộng năm mới nhất đã có (để bù nến vừa đóng).
        have_years = {dt.datetime.fromtimestamp(r["openTime"] / 1000, dt.timezone.utc).year for r in have}
        if args.repair:
            holes = gap_years(have)
            if holes:
                print(f"  {symbol}: vá năm có lỗ hổng {sorted(holes)}")
                have_years -= holes
                have = [r for r in have
                        if dt.datetime.fromtimestamp(r["openTime"] / 1000, dt.timezone.utc).year not in holes]
        newest = max(have_years) if have_years else None
        years = [y for y in range(args.year_from, args.year_to + 1)
                 if args.force or y not in have_years or y == newest]
        if not years:
            print(f"  {symbol}: cache đã đủ {args.year_from}–{args.year_to}, bỏ qua")
            continue

        fresh = fetch_symbol(symbol, years, args.workers, args.tf)
        merged = {r["openTime"]: r for r in have}
        merged.update({r["openTime"]: r for r in fresh})
        rows = [merged[k] for k in sorted(merged)]
        if args.tf == "day":
            rows = drop_stub_days(rows)

        with open(out_path, "w") as f:
            json.dump(rows, f)

        if rows:
            first = dt.datetime.fromtimestamp(rows[0]["openTime"] / 1000, dt.timezone.utc)
            last = dt.datetime.fromtimestamp(rows[-1]["openTime"] / 1000, dt.timezone.utc)
            px = sum(r["close"] for r in rows) / len(rows)
            sp = sum(r["spread"] for r in rows) / len(rows)
            print(f"  {symbol}: {len(rows)} nến {args.tf}  {first:%Y-%m-%d} → {last:%Y-%m-%d}  "
                  f"spread TB {sp / px * 100:.4f}% giá")


if __name__ == "__main__":
    main()
