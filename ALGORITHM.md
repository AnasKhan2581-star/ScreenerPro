# SMC Trend Engine — Algorithm Spec (single source of truth)

Canonical definition of the detection + entry logic. The backtester (`detector.js`), the
TradingView Pine indicator, and the Node bot must all follow this. If a rule changes, change
it here first. Trades **both directions** on Binance **global spot** data.

## Universe & timeframe scaling (July 2026)

The app universe is 7 coins: **BTC ZEC SOL XRP XMR SUI LINK** (XMR delisted from Binance
Feb 2024 — historical backtest only). All quant lookback params are denominated in **days**
and converted to bars per timeframe (`SMA200` = 200 days on 4h, 1d and 1w alike); stop
multiples scale by `√(bars/day)` floored at 0.8 so stop distances stay constant in daily-vol
terms. Result: `composite` is profitable on 6/7 coins on 4h and 1d and 5/6 on 1w (only the
dead XMR listing is mixed) — same economic strategy on every TF. The Compare page runs all
4 strategies × 7 coins (daily, all-in, 0.1% fees/side) with 6M/1Y/CAGR/DD/WR/Sharpe.

## `zecdiv` — ZEC 15m MACD absorption divergence (July 2026)

The one **intraday, fixed-R** strategy in the app, and the only TF-locked one: **ZECUSDT, 15m,
long only**. Everything else here is day-denominated; this is a documented exception (see
CLAUDE.md) because the setup lives on 15m structure and does not translate to other bars.

**The idea.** Price prints a *lower high* while the MACD line prints a *higher high* — momentum
building underneath a capped price, i.e. someone absorbing supply. The last leg up into that
capped high carries the footprint; we buy the retrace into it.

**Rules** (validated 2024-08 → 2026-07, 69,120 bars, all numbers **net of 0.1%/side**):

1. **Divergence.** `P2` = a price swing high (4-bar fractal). `P1` = the most recent swing high
   at least `minDropPct` **0.5%** above `P2` (without this a 5-cent "lower high" counts as a
   divergence — it is the second-biggest edge carrier). Separation ≥ `minSep` **32 bars**.
   `M1`/`M2` = max MACD within ±`pairWin` **6** bars of each high. Require `macd[M2] > macd[M1]`.
2. **Extension cap — the biggest edge carrier.** `macd/close×100` at `M2` must be ≤ `capPct`
   **0.05%** (≈ raw MACD **0.25** at ZEC $500). Expressed as % of price because MACD scales with
   price and ZEC ranged $27→$700 over the sample.
3. **The leg.** `Y = P2`; `X` = lowest low between `P1` and `Y`. Scan `X → Y` forward from its
   first candle.
4. **POI.** Candle `k` with `low(k+2) > high(k)`; `k+1` is the displacement, so
   **FVG = [open(k+1) → low(k+2)]**. *Purity*: nothing from `k+2` onward re-enters
   `[low(k), high(k)]`. A candidate failing a gate is skipped and the next is tested.
5. **Zone frozen at `Y`.** `top` = lowest low over `[k+2, Y]`, floored at `open(k+1)`. Measuring
   to the trigger bar instead counts the entry retrace itself as mitigation and kills every valid
   setup (benched: expR 0.210 vs 0.759).
6. **Entry** `top − 0.6 × (top − low(k))`, rounded to the 0.01 tick (orders rest on ticks, not on
   raw fib maths — an unrounded level missed a real fill by 0.2 of a cent).
   **SL** `entry × 0.99`, **TP** `entry × 1.05` — fixed 1:5. Trigger `t = P2 + 4`; fill from `t+1`
   when `low ≤ entry`; cancel after **36 bars** unfilled. One position at a time.

**Benchmark:** n=46, **WR 32.6%**, expectancy **+0.759R**, PF 1.88, **+39.1% net**, maxDD 8.1%,
6/9 quarters positive, worst quarter −4.7%, positive in all 3 chronological folds
(0.47 / 1.21 / 0.65). Breakeven WR at 1:5 is 16.7% gross, **~20% net** — fees are ~20% of risk
when the stop is 1%, so gross figures are meaningless for this strategy.

**Cap calibration & the plateau.** The user's chart rule was "MACD peak below 1.05". Swept as a
% of price the result is monotone and the optimum is *far tighter*:

| cap (% of px) | ≈ raw @ $495 | n | WR | expR | net | maxDD |
|---|---|---|---|---|---|---|
| 0.2118 (=1.05) | 1.05 | 118 | 22.9% | 0.174 | +18.4% | 18.3% |
| 0.15 | 0.74 | 85 | 23.5% | 0.213 | +16.7% | 17.9% |
| 0.075 | 0.37 | 52 | 30.8% | 0.649 | +37.3% | 7.0% |
| **0.05** | **0.25** | **46** | **32.6%** | **0.759** | **+39.1%** | **8.1%** |
| 0.025 | 0.12 | 41 | 34.1% | 0.851 | +39.3% | 7.0% |
| 0.0 | 0.00 | 37 | 29.7% | 0.587 | +22.5% | 7.0% |
| −0.05 | −0.25 | 25 | 24.0% | 0.245 | +5.5% | 10.3% |

A flat **plateau from 0.0 to 0.075** with sharp falloff both sides — a plateau, not a fitted
spike. The real rule: *the MACD higher high must still be at or barely above the zero line.*
User chose 0.05 (July 2026), accepting that it rejects their own charted Jul-20 winner
(M2 = 0.1435%). Do not re-tune this without re-running the fold test.

**Rejected / inert — do not re-test without new evidence:**
- **Freshness gate (`minFresh`)** — provably inert: disabling it produced a *bit-identical* trade
  list. Winners average fresh 0.911 vs losers 0.941 (no separation).
- **FVG size gate (`minFvgPct`)** — near-inert (+57.1% vs +60.9% at the stage-1 optimum).
  Both kept as loose, non-binding inputs (0.3 / 0.10%) so the rule stays expressible.
- **Purity gate** — *costs* ~10 points of return (+39.1% with vs +49.1% without) and does not
  separate winners from losers. **Kept deliberately** (user decision, July 2026): it is what makes
  the POI a footprint rather than any gap.
- **Re-arming the next POI after an expiry** — worse (expR 0.279 vs 0.360).
- **Consecutive-MACD-pivot pairing and a ±3-bar pair window** — missed the user's own setups; the
  MACD peak lags the price high by up to 5 bars and intervening minor pivots break consecutiveness.
- **HTF liquidity bias** — deferred by the user, not yet benched. `runZecDiv` keeps the hook.

**Chart timezone note.** The user's screenshots are IST (UTC+5:30); Binance klines are UTC.
Bars were matched by OHLC fingerprint before any rule was trusted.

## `cycle` — the BTC halving playbook (July 2026)

BTC-specific full-cycle machine built from the signals that repeated at every cycle turn
in-data (2015→2026; 2013 supported by documented history only — no keyless source reaches it):

- **Bottom signals (all four fired at every cycle low, incl. Feb–Jun 2026):** price at the
  200-week MA (×1.1), Mayer multiple < 0.8, weekly RSI < 35, and SMC sweep-reclaim of a major
  low (fired 3 days before the exact FTX bottom).
- **Top signals diminish each cycle:** Pi-Cycle (111d MA × 2 > 350d MA) sold 2017-12-17 and
  2021-04-12 to the day but did NOT fire at the Oct 2025 top; Mayer > 2.4 and weekly RSI > 84
  fire too early mid-bull. So the sell side is Pi-Cycle when it fires, else a persistent
  (5-day, `cyclePersist`) 40-week MA break.
- **Deployment ladder (July 2026):** every real bottom PIERCES the 200w MA (2020 −30%,
  2022 −31%, 2026 −8%), so accumulation is a staged program: **40% at zone A** (200w→×1.1),
  **40% on a zone-B recovery day** (zone B = 0.72–1.0×200w), **20% reserve on the 40-week
  reclaim** — and the **bullish-completion clause**: any unfilled tranche deploys at that
  reclaim, so the program is never left behind. Entry = equal-dollar (harmonic) weighted
  average of fills; **SL 0.65×200w** for all tranches — under the deepest pierce on record
  (the 2022 program survived the $15.5k FTX wick by 3% by design); TP display = the euphoria
  zone (1.85×200d). The Advisor panel prints the live ladder with exact prices and the
  deployed fraction; every trade row carries Buy @ / SL / Exit-TP prices.
- **Machine:** CASH → ACCUM (zone entries, zone-based stop) → TREND (price > 40w MA) → exit
  on Pi or persistent 40w break; post-Pi cooldown until price < 40w MA. Full-run 2015→2026
  all-in with fees: 10 positions, the 2015 $262→Pi-2017 $18,860 and 2022 avg-$22.2k→$92.2k
  holds carry it; maxDD 56%.
- Chart draws the live zones: green buy band A, faint deep band B, red euphoria band
  (1.85–2.4 × 200d MA), blue dashed 40w line. Zone prices at the right edge are TODAY'S
  actionable levels and drift with the MAs.

**Removed from the app (July 2026, user decision — history in git):** `composite` and
`meanrev`. The universe strategy set is now `cycle` / `tsmom` / `donch`.

## The flagship: `composite` — vol-targeted ensemble (tuned July 2026)

Blends the three trend signals (close > SMA200, 90d return > 0, close > 55d-channel mid):
**invests after the score holds ≥2 for `persist`=3 straight days** (whipsaw filter), **exits
when the score drops to `compExit`=0 or on the `chandMult`=2.5×ATR chandelier trail** from the
highest close since entry (plus the initial 2×ATR hard stop), and sizes each hold by
**volatility targeting** — exposure = `volTarget` 30% annualized / realized 30d vol, capped
at 1. Signal blending + persistence + vol targeting + trailed exits are the defining
techniques of institutional CTA books.

Validation (all-in, **0.1% fees per side**, tuned on BTC/ETH/BNB/SOL/LINK, then run on
XRP/DOGE/ADA unseen): BTC 23% CAGR/dd33/WR38 · ETH 20/30/39 · SOL 27/36/35 · DOGE 19/38/46 ·
ADA 33/39/37 · BNB 21/58/35 · XRP 11/52/25 ✗ · LINK 7/52/32 ✗. Six of eight pass
(CAGR ≥ 15%, dd ≤ 60%, WR ≥ 30%); buy & hold drawdowns on the same coins are 80–96%. The two
failures (XRP, LINK) are the weakest structural trenders — no timing system fixed them
without overfitting, and we don't overfit.

**Liquidity gate** (`liqTargets` / UI "Trade on it"): entries also require the estimated
liquidation fuel resting above price (±25% band) to outweigh the fuel below. Helps BTC
(+1277→+1348%), hurts ETH — ships as an option, default is context-display only.

**Equity model (UI):** `Invest %` of current equity per hold × the strategy's vol-sizing
`frac`, compounded, marked to market daily inside holds. Invest 100% = genuine all-in.

## Investment mode: the three quant strategies (`strategy` param / UI dropdown)

The tool is a long-only spot **investment backtester** on daily bars. The dropdown ships the
three systems the big systematic firms actually run (no SMC rules involved — the structure
drawing stays as chart context only). All-in compounding vs buy & hold, full listed history
(≈6–8y, BTC/ETH/BNB/SOL):

| strategy | rule | BTC | ETH | BNB | SOL |
|---|---|---|---|---|---|
| `tsmom` **Trend Follow (CTA)** | long while close > SMA200 AND 90d return > 0, flat otherwise | **+2152%** dd48% | **+1084%** dd71% | +2979% dd80% | +1066% dd72% |
| `meanrev` **Dip Buyer** | in uptrend (close > SMA200), buy z-score ≤ −2.5 panic vs SMA20, sell the bounce at the mean (stop 3×ATR, 10d timeout) | +24% dd24% | +52% dd20% | +17% dd35% | +32% dd23% |
| `donch` **Turtle Breakout** | buy a close above the 55d high, exit on a close below the 20d low (stop 2×ATR) | +552% dd46% | **+1269%** dd52% | +3272% dd57% | +1039% dd57% |
| — buy & hold | | +609% dd77% | +181% dd90% | +4283% dd76% | +2249% dd96% |

Read it honestly: **trend following and turtle breakout beat or match buy & hold with roughly
half the drawdown** (tsmom 3.5×'s BTC, donch 7×'s ETH); mean reversion is the small-but-steady
leg — positive on all four coins with the shallowest drawdowns, sized for many assets at once.
No strategy beats BNB's one-way grind — nothing times a market that never dips.

The SMC strategies (`regime` / `fvg` / `momo` / `scalp`) remain available as params for
experiments; earlier benchmarks (intraday + weekly-context) are in git history. Tested and
REJECTED: turtle-soup sweep fades (PF < 1 everywhere) and order-block taps (22% WR).

---

## 0. Inputs / outputs / parameters

- Input: candles ascending in time `{ time, open, high, low, close }` (UNIX seconds).
- Output of `detectAll`: `{ trades[], legs[], events[], summary, extPivots, intPivots, fvgs, unmitigated, htfBias, trend, strong, ssIdx, ssPrice, majorLowIdx }`.

| param | default | meaning |
|---|---|---|
| `strategy` | `fvg` | `regime` / `fvg` / `momo` (see table above; `scalp` = intraday variant) |
| `longOnly` | false | spot/investment mode — never short (the UI always sets true) |
| `regimeExit` | `daily` | trend-hold exit: `daily` = base-TF CHoCH too (best DD control) / `weekly` = HTF flip only |
| `htfExtMult` | 0 | structure sensitivity of the HTF context walk (0 = same as `extMult`; `regime` auto-uses 2.0) |
| `momoBosOnly` | false | momentum: take only continuation breaks (skip CHoCH reversals) |
| `eqTol` | 0.5 | equal highs/lows merge tolerance, ×ATR (unraided near-equal pivots pool together) |
| `atrLen` | 14 | ATR length (noise scale) |
| `extMult` | 4.0 | external/major pivot threshold, ×ATR — defines the structure (`scalp` forces 3.0 unless user-tuned) |
| `intMult` | 1.5 | internal pivot threshold (display dots only) |
| `fvgMult` | 0.5 | "major" FVG = gap height ≥ `fvgMult × ATR` |
| `fibLevel` | 0.5 | depth of the limit order inside the displacement FVG (0.5 = consequent encroachment) |
| `minRR` | 1.5 | minimum reward:risk — trades that can't pay this are skipped |
| `poiHorizon` | 200 | bars a resting order stays valid after confirmation |
| `discount` | 1.0 | entry must sit in this sweep-side fraction of the leg (1 = off; `minRR` already gates quality) |
| `htfMult` | 1 | higher-timeframe confluence (1 = off; the trailing HTF trend lags too much to help — sweep-tested) |
| `reqSweep` | true | the manipulation is mandatory: the Strong point must have swept a liquidity pool |
| `useLiq` | true | compute Coinglass-style estimated liquidation clusters (chart context) |
| `liqSweep` | false | liq bands may validate the manipulation — benched worse (51.6% vs 66.7% WR), off |
| `liqTargets` | false | liq bands may serve as targets — benched worse (60.6% WR), off |

## 1. Structure: one evolving trend walked from the first major low

External pivots come from an ATR-zigzag (`extMult × ATR` reversal filter).

- **BULLISH:** track a **Strong Low**. A candle **close** above the last external high =
  **BOS↑** → the Strong Low trails up to the most recent external low. A close below the
  Strong Low = **CHoCH↓** → the SuperSaiyyan high becomes the **Strong High**, flip bearish.
- **BEARISH:** mirror. Close below the last external low = **BOS↓** (Strong High trails
  down); close above the Strong High = **CHoCH↑** → flip bullish.
- The **SuperSaiyyan (SS)** extreme is the running high (bull) / low (bear) of the current leg.
- Wick-only breaks never count; every break needs a **close** through the level.

## 2. Liquidity pools (the fuel)

Stops rest just beyond swing pivots. Every external high spawns a **BSL** pool (buy-side
liquidity above it), every external low an **SSL** pool. Near-equal pivots (within 0.5×ATR)
merge into one stronger pool. A pool is **swept** at the first later wick through it.

**Estimated liquidation clusters (Coinglass-style, context only).** Leveraged entries pile in
at swing points; a long opened at `P` with leverage `L` is force-closed at `≈ P×(1−1/L)`.
From every internal pivot we project 25×/50×/100× liquidation levels (pivot highs → long-liq
bands below price, SSL-type; pivot lows → short-liq bands above, BSL-type), merge bands within
0.25×ATR, weight by the volume that entered at the source pivots, and keep the heavy half.
They are drawn as heat bands and returned in `pools` (flag `liq: true`), but they do **not**
drive entries or targets by default: benchmarks showed the synthetic bands dilute the clean
swing-pool sweep signal (WR 66.7% → 51.6% when trusted for sweeps). `liqSweep` / `liqTargets`
exist to re-test that choice as data changes.

## 3. The trade playbook: manipulation → displacement FVG → confirmation → tap

Big players sweep resting liquidity to fill size, leave with displacement, and their unfilled
orders sit in the imbalance that leg leaves behind. So:

1. **MANIPULATION** — the Strong point must have **swept a pool** (SSL below for longs, BSL
   above for shorts) within `poiHorizon` bars before it. No sweep ⇒ no trade (`reqSweep`).
2. **DISPLACEMENT** — the leg away from the sweep must leave at least one **major FVG**
   (gap ≥ `fvgMult×ATR`), still **fresh** (never traded into) as-of the confirmation.
3. **CONFIRMATION** — the leg **closes** through structure: BOS (continuation) or CHoCH
   (reversal). Only now is an order armed — never before the break.
4. **THE ORDER** — a limit rests `fibLevel` deep inside the FVG. Of all fresh major FVGs of
   the leg, take the **shallowest one that still pays ≥ `minRR`** — the zone price retraces
   into most often, i.e. the highest fill-rate that clears the quality bar.
5. **TAP** — the first candle whose wick reaches the entry fills it. **First tap only**: if
   the tap arrives while a position is open, the zone is mitigated and the order dies. Orders
   also expire after `poiHorizon` bars and are cancelled by any structure flip (CHoCH).
6. **STOP** — beyond the sweep wick: `min(strong, sweptPool) − 0.1×ATR` for longs (mirror for
   shorts). The manipulated pool's far side is where the idea is wrong.
7. **TARGET** — the **nearest unswept opposite pool** (BSL for longs / SSL for shorts) that
   still pays ≥ `minRR`: the closest magnet gives the highest hit-rate with positive
   expectancy. No such pool ⇒ major-FVG fallback (`pickTarget`); still under `minRR` ⇒ skip.
8. **OUTCOME** — forward simulation, stop checked before target on the same candle
   (conservative). `win / loss / open`.

## 4. Rejection rules

- No structure break (close through the level) → nothing is ever armed.
- `reqSweep` and no pool swept into the Strong point → no trade (no manipulation, no edge).
- No fresh major FVG in the displacement leg → no trade (no big-player footprint to join).
- No target paying ≥ `minRR` from the entry → no trade (bad math beats good stories).
- Tap while busy / after expiry / after a flip → order cancelled, zone burned.

## 5. Other definitions

- **FVG (3-candle):** bullish at `i` when `high[i-1] < low[i+1]`; filled once later price
  trades back into the gap. **Fresh** = unfilled as-of a given candle.
- **Unmitigated candle (display only):** price impulsively left its range and never returned
  (even by wick) — demand if left above, supply if left below.
- **HTF bias (off by default):** aggregate candles ×`htfMult`, run this same engine, expand
  the trend back per base candle using only the last *closed* HTF bar (no lookahead).
