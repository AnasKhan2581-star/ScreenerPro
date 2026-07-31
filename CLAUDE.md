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
- `liqbrk` — **buy-side liquidity continuation**, the intraday-native one (built for ZEC 15m, runs on any TF). First close above the 2-day high + above the 5-day SMA + volume ≥1.3× its daily average → long; stop 3×ATR; trail out below the 1-day low. Edge is the MECHANISM (plateau across every param), not a threshold. ZEC 15m: WR 34%, PF 2.9, +304% at 1% risk, maxDD 13.5% vs buy&hold +1086%/74%.
- Removed July 2026 (user decision): `composite`, `meanrev`, `zecdiv` (git history has them). Hidden legacy params: `fvg`, `scalp`, `momo`, `regime`.

## Conventions
- Run locally: `python -m http.server 8910` (or preview config `bos-backtester` in `.claude/launch.json`).
- Benchmarks: Node scripts that `require('./detector.js')`, fetch Binance daily klines, compute all-in equity with 0.1%/side fees, marked-to-market daily drawdown. Always compare vs buy & hold and report WR/DD/CAGR per symbol.
- The user judges strategies by: win rate ≥30%, drawdown, consistency across ≥5 symbols. Don't overfit weak assets (XRP/LINK fail deliberately).
- Equity panel is exposure-based (`Invest %` of equity per hold, 100% = all-in), NOT risk-per-trade sizing.
- If a rule changes, change `ALGORITHM.md` first.
- **ZEC 15m is a momentum market, not a mean-reversion one.** A forward-return scan (ALGORITHM.md `liqbrk`) shows top-of-range / above-VWAP / high-RSI states return 2–3× baseline monotonically, while buying "discount" returns *less than random*. Don't build dip-buying or sweep-fade intraday strategies here — three were built and all lost in every fold.
- Warm-up in `runQuant` is **per strategy** (`warm`). Don't reintroduce a global `maLen` guard: on 15m the 200-day MA is 19,200 bars, which silently zeroes out any intraday strategy.
- Advisor panel leads with plain language (% of capital deployed, entry price/date, live P/L); technical readouts live in the collapsed "Technical detail" section below.
