"""Backtest core and statistics.

Semantics are deliberately identical to detector.js / the Node research harness:
  * a signal is decided on a CLOSED bar; fill is at that bar's close (fill="close",
    the webapp's convention) or at the next open (fill="open", stricter — used in research)
  * when a bar touches both the stop and the target, the STOP is taken (conservative)
  * fees are charged per side on notional, at entry and again at exit
  * ONE position at a time
  * drawdown is peak-to-trough on the TRADE-CLOSE equity curve, i.e. it does NOT mark to
    market inside a trade — the lived drawdown is worse. Stated, not hidden.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Trade:
    entry_i: int
    exit_i: int
    entry: float
    stop: float
    exit: float
    reason: str
    bars: int = 0
    net: float = 0.0
    r: float = 0.0
    equity: float = 1.0


@dataclass
class Result:
    trades: list = field(default_factory=list)
    n: int = 0
    wins: int = 0
    win_rate: float = 0.0
    profit_factor: float = 0.0
    expectancy_r: float = 0.0
    ret_pct: float = 0.0
    max_dd: float = 0.0
    fees_pct: float = 0.0
    time_in_market: float = 0.0
    avg_hold_h: float = 0.0
    trades_per_month: float = 0.0
    equity_curve: np.ndarray = field(default_factory=lambda: np.array([1.0]))
    buy_hold_pct: float = 0.0
    buy_hold_dd: float = 0.0

    def line(self) -> str:
        return (f"n={self.n:>4}  WR={self.win_rate:5.1f}%  PF={self.profit_factor:5.2f}  "
                f"expR={self.expectancy_r:6.3f}  ret={self.ret_pct:9.1f}%  "
                f"DD={self.max_dd:5.1f}%  {self.trades_per_month:.1f}/mo  hold={self.avg_hold_h:.1f}h")


def evaluate(trades: list, df: pd.DataFrame, fee_pct: float = 0.1,
             sizing: str = "risk", size_pct: float = 1.0) -> Result:
    """Turn raw trades into an equity curve and stats.

    sizing="risk"     -> notional sized so a stop-out costs exactly size_pct of equity
    sizing="exposure" -> invest size_pct of equity per hold (what the webapp panel shows)
    """
    f = fee_pct / 100.0
    k = size_pct / 100.0
    eq, peak, dd = 1.0, 1.0, 0.0
    wins = gp = gl = sum_r = fees = 0.0
    curve = [1.0]
    for t in trades:
        if t.reason == "open":                                # still holding: not a result yet
            continue
        if sizing == "risk":
            stop_frac = (t.entry - t.stop) / t.entry
            if stop_frac <= 0:
                continue
            notional = eq * k / stop_frac
        else:
            notional = eq * k
        gross = (t.exit - t.entry) / t.entry * notional
        fee = f * notional + f * notional * (t.exit / t.entry)
        net = gross - fee
        fees += fee
        risk_unit = eq * k if sizing == "risk" else eq * k * ((t.entry - t.stop) / t.entry)
        t.net, t.r = net, (net / risk_unit if risk_unit else 0.0)
        sum_r += t.r
        if net >= 0:
            wins += 1
            gp += net
        else:
            gl -= net
        eq += net
        t.equity = eq
        curve.append(eq)
        if eq > peak:
            peak = eq
        else:
            dd = max(dd, (peak - eq) / peak)

    closed = [t for t in trades if t.reason != "open"]
    n = len(closed)
    close = df["close"].to_numpy()
    bh_peak, bh_dd = close[0], 0.0
    for c in close:
        bh_peak = max(bh_peak, c)
        bh_dd = max(bh_dd, (bh_peak - c) / bh_peak)
    held = sum(t.bars for t in closed)
    span_s = int(df["time"].iloc[-1] - df["time"].iloc[0]) or 1
    bar_s = max(60, int(df["time"].iloc[1] - df["time"].iloc[0])) if len(df) > 1 else 86400
    return Result(
        trades=trades, n=n, wins=int(wins),
        win_rate=wins / n * 100 if n else 0.0,
        profit_factor=(gp / gl) if gl > 0 else (float("inf") if gp > 0 else 0.0),
        expectancy_r=sum_r / n if n else 0.0,
        ret_pct=(eq - 1) * 100, max_dd=dd * 100, fees_pct=fees * 100,
        time_in_market=held / len(df) * 100 if len(df) else 0.0,
        avg_hold_h=held * bar_s / 3600 / n if n else 0.0,
        trades_per_month=n / (span_s / 86400 / 30.4) if span_s else 0.0,
        equity_curve=np.array(curve),
        buy_hold_pct=(close[-1] / close[0] - 1) * 100, buy_hold_dd=bh_dd * 100)


def walk(df: pd.DataFrame, signals, exit_fn, fill: str = "close",
         max_bars: int = 0, use_stop: bool = True) -> list:
    """Drive signals through the market one position at a time.

    signals  : list of (i, stop_price) decided on the close of bar i
    exit_fn  : (j, entry, stop, state) -> (should_exit, price, reason) evaluated per bar
    use_stop : False for strategies whose stop is only an R-accounting unit and never an
               exit (tsmom in detector.js works this way) — getting this wrong invents exits
    """
    high = df["high"].to_numpy()
    low = df["low"].to_numpy()
    close = df["close"].to_numpy()
    op = df["open"].to_numpy()
    n = len(df)
    trades: list[Trade] = []
    busy = -1
    for i, stop in signals:
        if i <= busy or i + 2 >= n:
            continue
        if fill == "open":
            fi, fp = i + 1, op[i + 1]
        else:
            fi, fp = i, close[i]
        if not (stop < fp):
            continue
        # detector.js opens at bar i and only tests exits from i+1 onward, so a close-fill
        # entry is never stopped out on its own bar. An open-fill entry is already on the
        # next bar, so exit testing starts there. Getting this wrong shifts every exit.
        start = fi + 1 if fill == "close" else fi
        hard = fi + max_bars if max_bars else None            # a real time stop, if configured
        cap = min(n - 1, hard) if hard is not None else n - 1
        if start > cap:
            continue
        timed_out = hard is not None and cap == hard          # else we simply ran out of data
        reason, xi, xp = "open", cap, close[cap]
        state: dict = {}
        for j in range(start, cap + 1):
            if use_stop and low[j] <= stop:                 # stop first on a tie
                reason, xi, xp = "stop", j, stop
                break
            hit, price, why = exit_fn(j, fp, stop, state)
            if hit:
                reason, xi, xp = why, j, price
                break
            if j == cap:
                # "open" = still holding when the data ended; detector.js reports it the same
                # way and it must NOT be scored as a closed trade.
                reason, xi, xp = ("time" if timed_out else "open"), j, close[j]
        trades.append(Trade(entry_i=fi, exit_i=xi, entry=fp, stop=stop, exit=xp,
                            reason=reason, bars=xi - fi))
        busy = xi
    return trades


def folds(trades: list, df: pd.DataFrame, k: int = 3, **kw) -> list:
    """Split chronologically into k equal slices and score each independently."""
    n = len(df)
    edges = [int(n * j / k) for j in range(k + 1)]
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        sub = [t for t in trades if a <= t.entry_i < b]
        out.append(evaluate(sub, df.iloc[a:b] if b > a else df, **kw))
    return out


def quarterly(trades: list, df: pd.DataFrame, **kw) -> dict:
    t = pd.to_datetime(df["time"].to_numpy(), unit="s")
    groups: dict = {}
    for tr in trades:
        q = f"{t[tr.entry_i].year}Q{(t[tr.entry_i].month - 1) // 3 + 1}"
        groups.setdefault(q, []).append(tr)
    return {q: evaluate(v, df, **kw) for q, v in sorted(groups.items())}
