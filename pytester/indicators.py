"""Indicators, deliberately bit-compatible with detector.js.

Every function here mirrors the JS in detector.js exactly, including its unusual seeding
(the ATR is seeded with a running mean, not a plain SMA). If these drift, the desktop
tester and the webapp silently disagree — which is the whole risk of a second engine, so
verify.py asserts they match on real data.
"""
from __future__ import annotations

import numpy as np


def atr(high, low, close, length: int) -> np.ndarray:
    """detector.js atr(): seeded with a running mean over the first `length` bars."""
    n = len(close)
    out = np.zeros(n)
    if n == 0:
        return out
    tr = np.empty(n)
    tr[0] = high[0] - low[0]
    tr[1:] = np.maximum.reduce([high[1:] - low[1:],
                                np.abs(high[1:] - close[:-1]),
                                np.abs(low[1:] - close[:-1])])
    run = 0.0
    for i in range(n):
        if i < length:
            run += tr[i]
            out[i] = run / (i + 1)
        else:
            out[i] = (out[i - 1] * (length - 1) + tr[i]) / length
    return out


def sma(v, length: int) -> np.ndarray:
    """Rolling mean, NaN until `length-1` — matches detector.js sma()."""
    v = np.asarray(v, dtype=float)
    n = len(v)
    out = np.full(n, np.nan)
    if length <= 0 or n < length:
        return out
    c = np.concatenate(([0.0], np.cumsum(v)))
    out[length - 1:] = (c[length:] - c[:-length]) / length
    return out


def ema(v, length: int) -> np.ndarray:
    """EMA seeded with SMA(length), matching Pine's ta.ema and detector.js."""
    v = np.asarray(v, dtype=float)
    n = len(v)
    out = np.full(n, np.nan)
    if n < length:
        return out
    a = 2.0 / (length + 1)
    out[length - 1] = v[:length].mean()
    for i in range(length, n):
        out[i] = v[i] * a + out[i - 1] * (1 - a)
    return out


def roll_max(v, length: int) -> np.ndarray:
    """Max of the `length` bars BEFORE i (exclusive of i) — causal, as in detector.js."""
    v = np.asarray(v, dtype=float)
    n = len(v)
    out = np.full(n, -np.inf)
    if n < 2:
        return out
    s = pd_rolling_max(v, length)
    out[1:] = s[:-1]
    return out


def roll_min(v, length: int) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    n = len(v)
    out = np.full(n, np.inf)
    if n < 2:
        return out
    s = pd_rolling_min(v, length)
    out[1:] = s[:-1]
    return out


def pd_rolling_max(v: np.ndarray, length: int) -> np.ndarray:
    import pandas as pd
    return pd.Series(v).rolling(length, min_periods=1).max().to_numpy()


def pd_rolling_min(v: np.ndarray, length: int) -> np.ndarray:
    import pandas as pd
    return pd.Series(v).rolling(length, min_periods=1).min().to_numpy()


def rel_volume(vol, length: int) -> np.ndarray:
    """volume / trailing mean INCLUDING the current bar — matches detector.js liqbrk."""
    vol = np.asarray(vol, dtype=float)
    n = len(vol)
    out = np.ones(n)
    c = np.concatenate(([0.0], np.cumsum(vol)))
    for i in range(n):
        lo = max(0, i + 1 - length)
        avg = (c[i + 1] - c[lo]) / min(i + 1, length)
        out[i] = vol[i] / avg if avg > 0 else 1.0
    return out


def rsi(close, length: int = 14) -> np.ndarray:
    close = np.asarray(close, dtype=float)
    n = len(close)
    out = np.full(n, np.nan)
    g = l = 0.0
    for i in range(1, n):
        ch = close[i] - close[i - 1]
        up, dn = max(ch, 0.0), max(-ch, 0.0)
        if i <= length:
            g += up / length
            l += dn / length
        else:
            g = (g * (length - 1) + up) / length
            l = (l * (length - 1) + dn) / length
        if i >= length:
            out[i] = 100 - 100 / (1 + (g / l if l > 0 else 100))
    return out


def bars_per_day(time_s) -> float:
    """Bars per day, from the actual spacing — the basis of day-denominated params."""
    t = np.asarray(time_s)
    dt = max(60, int(t[1] - t[0])) if len(t) > 1 else 86400
    return 86400.0 / dt


def S(days: float, bpd: float) -> int:
    """detector.js S(): days -> bars, floored at 2."""
    return max(2, int(round(days * bpd)))
