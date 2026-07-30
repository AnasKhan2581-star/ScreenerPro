# ScreenerPro (SmartMoneyBOS)

Long-only daily **crypto investment advisor webapp**. Fully static — no build step, no deps.

## Files
- `index.html` — UI: two tabs (Chart / **Compare** — all strategies × the 7-coin universe), strategy dropdown, Advisor panel, equity backtest, mobile-responsive (media query at END of `<style>` so it wins the cascade). Fetches Binance spot klines client-side (`api.binance.com`, fallback `data-api.binance.vision`).
- Universe: **BTC ZEC SOL XRP XMR SUI LINK** only (XMR delisted Feb 2024, historical). Any Binance pair still works via free-text search.
- Lookbacks are **day-denominated** and scaled to bars per TF in `runQuant` (stop mults × √(bars/day), floor 0.8) — that's what makes strategies consistent across 4h/1d/1w. Don't add bar-count params. **One documented exception**: `zecdiv` is TF-locked to ZEC 15m and its params (`zd*`) are bar-denominated by design.
- `detector.js` — the engine (`window.SMC` / Node module). Quant strategies live in `runQuant`; `runZecDiv` is the separate intraday fixed-R engine; legacy SMC structure code (pivots/FVG/liquidity/walkStructure) remains for chart context and hidden params.
- `ALGORITHM.md` — **single source of truth** for strategy rules, tuned defaults, and benchmark results (including rejected ideas — read before re-testing anything).

## Strategies (dropdown → `strategy` param)
- `cycle` (default) — BTC halving playbook: two-tranche accumulation at the 200-week MA (zone A + deep zone B, harmonic avg entry, stop 0.65×200w), Pi-Cycle / 40-week exits. See ALGORITHM.md for the validated cycle signals.
- `tsmom`, `donch` — pure CTA trend / turtle breakout.
- `zecdiv` — **ZEC 15m only**, the one intraday/fixed-R strategy. Price lower high + MACD higher high (absorption) → limit at 0.6 of the unmitigated-candle/FVG band, fixed 1% SL / 5% TP. Selecting it snaps the symbol+TF. Edge lives in the MACD extension cap (`zdCapPct`), NOT the SMC gates — read the ALGORITHM.md plateau table and the inert-gate list before touching it.
- Removed July 2026 (user decision): `composite`, `meanrev` (git history has them). Hidden legacy params: `fvg`, `scalp`, `momo`, `regime`.

## Conventions
- Run locally: `python -m http.server 8910` (or preview config `bos-backtester` in `.claude/launch.json`).
- Benchmarks: Node scripts that `require('./detector.js')`, fetch Binance daily klines, compute all-in equity with 0.1%/side fees, marked-to-market daily drawdown. Always compare vs buy & hold and report WR/DD/CAGR per symbol.
- The user judges strategies by: win rate ≥30%, drawdown, consistency across ≥5 symbols. Don't overfit weak assets (XRP/LINK fail deliberately).
- Equity panel is exposure-based (`Invest %` of equity per hold, 100% = all-in), NOT risk-per-trade sizing.
- If a rule changes, change `ALGORITHM.md` first.
