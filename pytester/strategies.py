"""Strategy definitions, ported 1:1 from detector.js.

ALGORITHM.md remains the single source of truth for the RULES. This file must not invent
behaviour — verify.py asserts it reproduces detector.js on real data, because two engines
that quietly disagree are worse than one.

All lookbacks are day-denominated and converted with S(days, bpd), so a strategy means the
same thing on 15m, 4h or 1d.
"""
from __future__ import annotations

import numpy as np

from . import indicators as ind
from .engine import walk

REGISTRY: dict = {}


def strategy(key, label, params, blurb):
    def deco(fn):
        REGISTRY[key] = {"key": key, "label": label, "params": params,
                         "blurb": blurb, "fn": fn}
        return fn
    return deco


# --------------------------------------------------------------------------- liqbrk
@strategy(
    "liqbrk", "Liquidity Breakout (15m swing)",
    {"lbBreak": 2.0, "lbExit": 1.0, "lbTrend": 5.0, "lbStop": 3.0, "lbRelVol": 1.3,
     "atrLen": 14},
    "Buy-side liquidity — short stops and resting breakout orders — piles up above recent "
    "highs. The FIRST close above the 2-day high, in an uptrend, on above-average volume "
    "takes that pool and usually continues. Stop 3xATR; trail out below the 1-day low. "
    "A SWING system on 15m bars: holds ~30h, ~6 trades/month. Not day trading.")
def liqbrk(df, p, fill="close"):
    t = df["time"].to_numpy()
    high, low, close = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    vol = df["volume"].to_numpy()
    bpd = ind.bars_per_day(t)
    bL, eL, vL = ind.S(p["lbBreak"], bpd), ind.S(p["lbExit"], bpd), ind.S(1.0, bpd)
    a = ind.atr(high, low, close, int(p["atrLen"]))
    hiB = ind.roll_max(high, bL)
    loE = ind.roll_min(low, eL)
    maT = ind.sma(close, ind.S(p["lbTrend"], bpd))
    rv = ind.rel_volume(vol, vL)
    warm = max(ind.S(p["lbTrend"], bpd), bL, vL) + 2

    sigs = []
    for i in range(warm, len(df) - 1):
        if not (close[i] > hiB[i] and close[i - 1] <= hiB[i - 1]):
            continue                                          # FIRST close through the pool
        if not (close[i] > maT[i]):
            continue
        if rv[i] < p["lbRelVol"]:
            continue
        stop = close[i] - p["lbStop"] * a[i]
        if stop < close[i]:
            sigs.append((i, stop))

    def exit_fn(j, entry, stop, state):
        if close[j] < loE[j]:
            return True, close[j], "trail"
        return False, 0.0, ""

    return walk(df, sigs, exit_fn, fill=fill)


# --------------------------------------------------------------------------- tsmom
@strategy(
    "tsmom", "Trend Follow (CTA momentum)",
    {"tsmomMa": 200.0, "tsmomLook": 90.0, "persist": 3.0, "qStop": 2.0, "atrLen": 14},
    "Long while price closes above its 200-day average AND the 90-day return is positive; "
    "flat otherwise. The core system of trend funds — low win rate, very large winners.")
def tsmom(df, p, fill="close"):
    t = df["time"].to_numpy()
    high, low, close = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    bpd = ind.bars_per_day(t)
    maLen, look = ind.S(p["tsmomMa"], bpd), ind.S(p["tsmomLook"], bpd)
    persist = max(1, ind.S(p["persist"], bpd))
    sf = max(0.8, np.sqrt(bpd))
    a = ind.atr(high, low, close, int(p["atrLen"]))
    ma = ind.sma(close, maLen)

    on = np.zeros(len(df), dtype=bool)
    for i in range(maLen, len(df)):
        on[i] = close[i] > ma[i] and i >= look and close[i] > close[i - look]
    sigs, run = [], 0
    for i in range(maLen, len(df) - 1):
        run = run + 1 if on[i] else 0
        if run >= persist:
            sigs.append((i, close[i] - p["qStop"] * sf * a[i]))

    def exit_fn(j, entry, stop, state):
        if not on[j]:
            return True, close[j], "trend"
        return False, 0.0, ""

    # detector.js tsmom has NO stop exit: qStop only defines the R unit. Exit is trend loss.
    return walk(df, sigs, exit_fn, fill=fill, use_stop=False)


# --------------------------------------------------------------------------- donch
@strategy(
    "donch", "Turtle (channel breakout)",
    {"donchIn": 55.0, "donchOut": 20.0, "qStop": 2.0, "atrLen": 14},
    "Buy a close above the 55-day high, exit on a close below the 20-day low, 2xATR initial "
    "stop. The original managed-futures system: many small losses, a few enormous riders.")
def donch(df, p, fill="close"):
    t = df["time"].to_numpy()
    high, low, close = df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    bpd = ind.bars_per_day(t)
    inL, outL = ind.S(p["donchIn"], bpd), ind.S(p["donchOut"], bpd)
    sf = max(0.8, np.sqrt(bpd))
    a = ind.atr(high, low, close, int(p["atrLen"]))
    hiN, loN = ind.roll_max(high, inL), ind.roll_min(low, outL)
    warm = ind.S(200.0, bpd)                                   # detector.js warms on the 200d MA

    sigs = [(i, close[i] - p["qStop"] * sf * a[i])
            for i in range(warm, len(df) - 1) if close[i] > hiN[i]]

    def exit_fn(j, entry, stop, state):
        if close[j] < loN[j]:
            return True, close[j], "trail"
        return False, 0.0, ""

    return walk(df, sigs, exit_fn, fill=fill)


def run(key: str, df, params: dict | None = None, fill: str = "close"):
    spec = REGISTRY[key]
    p = dict(spec["params"])
    p.update(params or {})
    return spec["fn"](df, p, fill=fill), p
