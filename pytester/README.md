# ScreenerPro Desktop Tester

Python backtesting harness for the ScreenerPro strategies. Stdlib Tkinter + matplotlib —
**no extra installs** beyond what you already have (numpy, pandas, matplotlib, pyarrow, requests).

```bash
python -m pytester.app      # from the repo root
```

## Why this exists, and the rule that keeps it safe

`detector.js` is still the **single source of truth** for strategy rules — it ships in the
webapp and cannot be replaced. This is a second engine, and two engines that quietly disagree
are worse than one. So:

```bash
python pytester/verify.py
```

runs both engines on identical bars and fails loudly if any headline stat drifts. It must say
`ALL STRATEGIES MATCH detector.js` before you trust a number from here. It has already caught
three real bugs — exit-bar off-by-one, a stop applied to a strategy that has none, and
end-of-data positions scored as closed trades.

**If you change a strategy rule: change `ALGORITHM.md`, then `detector.js`, then here, then re-run
verify.**

## What it does that the webapp cannot

- **No 10,000-bar cap.** `BARS = 0` pulls the entire listed history (ZEC 15m goes back to
  2019-03-21, ~258k bars, ~82s cold; cached to parquet so re-runs are instant).
- **Equity curve with the drawdown shaded**, plus a per-trade ledger.
- **Chronological fold + quarterly tables** — the regime-stability check.
- **Parameter sweeps** with worst-fold expectancy, so you can see whether a setting is a
  plateau or a lucky cell.
- **Both sizing models**: risk % per trade (how intraday systems are actually run) and
  exposure % per hold (what the webapp panel shows).

## Honest limits

- Drawdown is measured **trade-to-trade**, not marked to market inside a trade — the drawdown
  you would live through is worse than the number shown.
- **Slippage is not modelled.** Breakout entries are market orders, which is exactly where
  slippage hurts most.
- Fills are the webapp's convention (signal bar's close) by default. Switch FILL to
  "next open (strict)" for the more conservative research assumption.

## Layout

| file | role |
|---|---|
| `data.py` | Binance klines, paged 1000/req, incremental parquet cache |
| `indicators.py` | ATR/SMA/EMA/rolling extremes/relvol/RSI — bit-compatible with detector.js |
| `engine.py` | position walk, fees, sizing, stats, folds, quarters |
| `strategies.py` | `liqbrk`, `tsmom`, `donch` ported 1:1, with a registry |
| `app.py` | Tkinter GUI (Backtest / Sweep / Folds) |
| `verify.py` | acceptance gate vs detector.js |
