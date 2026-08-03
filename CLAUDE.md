# ScreenerPro (SmartMoneyBOS)

Long-only daily **crypto investment advisor webapp**. Fully static — no build step, no deps.

## Files
- `index.html` — UI: two tabs (Chart / **Compare** — all strategies × the 7-coin universe), strategy dropdown, Advisor panel, equity backtest, mobile-responsive (media query at END of `<style>` so it wins the cascade). Fetches Binance spot klines client-side (`api.binance.com`, fallback `data-api.binance.vision`).
- Universe: **BTC ZEC SOL XRP XMR SUI LINK** only (XMR delisted Feb 2024, historical). Any Binance pair still works via free-text search.
- Lookbacks are **day-denominated** and scaled to bars per TF in `runQuant` (stop mults × √(bars/day), floor 0.8) — that's what makes strategies consistent across 4h/1d/1w. Don't add bar-count params.
- `detector.js` — the engine (`window.SMC` / Node module). Quant strategies live in `runQuant`; legacy SMC structure code (pivots/FVG/liquidity/walkStructure) remains for chart context and hidden params.
- `ALGORITHM.md` — **single source of truth** for strategy rules, tuned defaults, and benchmark results (including rejected ideas — read before re-testing anything).

## Strategies (dropdown → `strategy` param)
- `cycle` (default) — BTC halving playbook: two-tranche accumulation at the 200-week MA (zone A + deep zone B, harmonic avg entry, stop 0.65×200w), Pi-Cycle / 40-week exits. See ALGORITHM.md for the validated cycle signals.
- `tsmom`, `donch` — pure CTA trend / turtle breakout.
- `liqbrk` — **buy-side liquidity continuation**. Runs on 15m but is a **SWING system** (holds ~30h, ~6 trades/mo) — do not call it intraday. First close above the 2-day high + above the 5-day SMA + volume ≥1.3× its daily average → long; stop 3×ATR; trail out below the 1-day low. Edge is the MECHANISM (plateau across every param), not a threshold. ZEC 15m **full history** (258k bars, 2019-2026): WR 24%, PF 1.39, +199%, maxDD **61%**, 15/31 losing quarters, and it loses for ~2.5 years through the 2022-24 bear. The often-quoted WR 34% / maxDD 13.5% came from a 2-year bull window only — see the CORRECTION in ALGORITHM.md. Treat it as a bull-regime system.
- Removed July 2026 (user decision): `composite`, `meanrev`, `zecdiv` (git history has them). Hidden legacy params: `fvg`, `scalp`, `momo`, `regime`.

## Conventions
- Run locally: `python -m http.server 8910` (or preview config `bos-backtester` in `.claude/launch.json`).
- Benchmarks: Node scripts that `require('./detector.js')`, fetch Binance daily klines, compute all-in equity with 0.1%/side fees, marked-to-market daily drawdown. Always compare vs buy & hold and report WR/DD/CAGR per symbol.
- The user judges strategies by: win rate ≥30%, drawdown, consistency across ≥5 symbols. Don't overfit weak assets (XRP/LINK fail deliberately).
- Equity panel is exposure-based (`Invest %` of equity per hold, 100% = all-in), NOT risk-per-trade sizing.
- If a rule changes, change `ALGORITHM.md` first.
- **Validate on ALL available history, not the cached window.** ZEC 15m reaches back to 2019-03-21 (~258k bars). A 2-year bull slice made `liqbrk` look like a 13.5%-drawdown system when it is really a 61%-drawdown one.
- `pytester/` — Python desktop tester (Tkinter, no extra deps, `python -m pytester.app`). No bar cap, parquet cache, sweeps, folds, equity curves. **`detector.js` stays the source of truth**; `python pytester/verify.py` must print `ALL STRATEGIES MATCH detector.js` before trusting a number from it.
- **Day trading is dead on this pair (tested July 2026).** Three day-trade variants (intraday breakout, momentum pullback, squeeze expansion) all lost to the swing system (best PF 1.28 vs 2.66). At a ~0.6% average move the 0.2% round-trip fee eats 34% of it, and a 12h hold cap destroys the fat tail that carries the edge (top-5 trades = 44% of gross profit). Don't retry without maker rebates or a proven higher-frequency edge.
- **ZEC 15m is a momentum market, not a mean-reversion one.** A forward-return scan (ALGORITHM.md `liqbrk`) shows top-of-range / above-VWAP / high-RSI states return 2–3× baseline monotonically, while buying "discount" returns *less than random*. Don't build dip-buying or sweep-fade intraday strategies here — three were built and all lost in every fold.
- Warm-up in `runQuant` is **per strategy** (`warm`). Don't reintroduce a global `maLen` guard: on 15m the 200-day MA is 19,200 bars, which silently zeroes out any intraday strategy.
- Advisor panel leads with plain language (% of capital deployed, entry price/date, live P/L); technical readouts live in the collapsed "Technical detail" section below.
