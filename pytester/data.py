"""Binance kline fetching with an incremental local cache.

Binance serves at most 1000 candles per request (asking for more silently returns 1000),
so history is paged backwards with endTime. There is no total-history limit: ZECUSDT 15m
reaches back to 2019-03-21 (~258k bars, ~82s for a full cold fetch).

Cached to parquet per symbol/interval; later runs only fetch the new tail.
"""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests

ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision"]
CACHE = Path(__file__).parent / "cache"
MS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
      "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200, "1d": 86400, "1w": 604800}
COLS = ["time", "open", "high", "low", "close", "volume"]


def _get(params: dict) -> list:
    last = None
    for base in ENDPOINTS:
        try:
            r = requests.get(f"{base}/api/v3/klines", params=params, timeout=20)
            if r.status_code == 200:
                return r.json()
            last = f"{base} HTTP {r.status_code}: {r.text[:120]}"
        except Exception as e:                                    # noqa: BLE001
            last = f"{base}: {e}"
    raise RuntimeError(last or "fetch failed")


def _page(symbol: str, interval: str, total: int, end_ms: int | None = None,
          progress=None) -> pd.DataFrame:
    """Page backwards from end_ms until `total` bars are collected or history runs out."""
    rows: list[list] = []
    while len(rows) < total:
        params = {"symbol": symbol, "interval": interval,
                  "limit": min(1000, total - len(rows))}
        if end_ms is not None:
            params["endTime"] = end_ms
        got = _get(params)
        if not got:
            break
        rows = got + rows
        end_ms = got[0][0] - 1
        if progress:
            progress(len(rows), total)
        if len(got) < params["limit"]:
            break                                                  # start of listed history
        time.sleep(0.05)                                           # stay well inside 6000 wt/min
    if not rows:
        return pd.DataFrame(columns=COLS)
    df = pd.DataFrame([[int(r[0]) // 1000, float(r[1]), float(r[2]), float(r[3]),
                        float(r[4]), float(r[5])] for r in rows], columns=COLS)
    return df.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def load(symbol: str, interval: str, bars: int = 0, refresh: bool = True,
         progress=None) -> pd.DataFrame:
    """Return OHLCV for `symbol`/`interval`, using and updating the parquet cache.

    bars=0 means "everything available". Cached data is extended at the tail only, so
    repeat runs are near-instant.
    """
    symbol, interval = symbol.upper(), interval.lower()
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{symbol}_{interval}.parquet"
    have = pd.read_parquet(path) if path.exists() else pd.DataFrame(columns=COLS)

    want = bars if bars else 10 ** 9
    if len(have) < want and (bars == 0 or len(have) < bars):
        # extend backwards from the oldest cached bar (or from now if the cache is empty)
        need = want - len(have)
        end = int(have["time"].iloc[0]) * 1000 - 1 if len(have) else None
        older = _page(symbol, interval, min(need, 400_000), end, progress)
        if len(older):
            have = (pd.concat([older, have]).drop_duplicates("time")
                    .sort_values("time").reset_index(drop=True))

    if refresh and len(have):                                      # fetch the new tail
        newest = int(have["time"].iloc[-1])
        gap = int((time.time() - newest) // MS[interval])
        if gap > 1:
            tail = _page(symbol, interval, min(gap + 2, 100_000), None, progress)
            if len(tail):
                have = (pd.concat([have, tail]).drop_duplicates("time")
                        .sort_values("time").reset_index(drop=True))

    if len(have):
        have.to_parquet(path, index=False)
    return have.tail(bars).reset_index(drop=True) if bars else have


def describe(df: pd.DataFrame) -> str:
    if not len(df):
        return "no data"
    t0 = pd.to_datetime(df["time"].iloc[0], unit="s")
    t1 = pd.to_datetime(df["time"].iloc[-1], unit="s")
    return f"{len(df):,} bars  {t0:%Y-%m-%d %H:%M} -> {t1:%Y-%m-%d %H:%M} UTC"
