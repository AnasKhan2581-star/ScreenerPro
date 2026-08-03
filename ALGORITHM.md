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

## REJECTED: `zecdiv` — ZEC 15m MACD absorption divergence (built & removed July 2026)

Built, benched, shipped, then **removed by the user** ("that strategy is not working"). Recorded
here so it is not rebuilt. Setup: price lower high + MACD line higher high (absorption), buy the
0.6 retrace into an unmitigated candle + its FVG, fixed 1% SL / 5% TP.

Backtest was *positive* on paper — 46 trades, WR 32.6%, +0.759R, PF 1.88, +39.1%, maxDD 8.1%,
2024-08→2026-07 net of fees, positive in all 3 chronological folds. It still failed the user's
real bar. Why it was dropped, and the lessons that carry forward:

- **Too few trades to trust.** 46 trades in two years on 15m is ~2/month. At a 32.6% win rate
  that is a long, demoralising losing run between wins — statistically fine, practically unusable.
- **All the edge sat in one knob.** The MACD extension cap; every SMC gate was inert or negative
  (freshness disabling produced a *bit-identical* trade list; purity cost ~10 points of return).
  A strategy resting on one threshold is a fitted threshold, not a mechanism.
- **Fixed 1% stop ignores ZEC's volatility regime.** ZEC ranged $27→$700 over the sample; a
  constant % stop is far too tight in high-vol regimes and too loose in quiet ones. **Any future
  ZEC intraday strategy must scale stops by ATR, not by a fixed percentage.**
- **Fees dominate tight stops.** 0.1%/side on a 1% stop is ~0.2R per trade — 20% of risk, which
  pushed breakeven WR from 16.7% to ~20%.

Do not rebuild it. If revisiting divergence on ZEC, the only reusable finding is that a MACD
higher high *far above the zero line* marks an exhausted leg — useful as a **filter inside another
strategy**, not as a strategy on its own.

## `liqbrk` - buy-side liquidity continuation (July 2026)

A **swing** system that runs on 15m bars: it holds ~30h and trades ~6x/month. It is **not** a
day-trading setup - three day-trade variants were built and all lost to it (see below). Built for
**ZEC 15m**, day-denominated so it runs on any TF. Long only.

**The finding that drove it.** Three original liquidity strategies were built and all three lost
money in *every* fold (see the rejection list below). A forward-return study explained why: on ZEC
15m the classic SMC premise is inverted. Measuring the +96-bar forward return from the next open,
against an unconditional baseline of **+0.647%**:

| feature | weakest bucket | strongest bucket |
|---|---|---|
| position in the 96-bar range | bottom 20% ("discount") **-0.022%** | top 20% (breakout) **+1.645%**, 54% up |
| distance from rolling VWAP | below VWAP +0.19% | > +3 ATR above **+1.501%**, 55% up |
| RSI(14) | 25-40 -> +0.31% | **>75 -> +1.867%**, 57% up |
| 96-bar momentum | -3...+3% -> +0.129% | **>+8% -> +1.932%** |
| ATR% of price | mid -> +0.30% | **>1.2% -> +2.218%** |
| hour of day (UTC) | 0.629% | 0.667% - **no session edge at all** |

Monotone in the same direction on every feature. **Buying "discount" on ZEC 15m returns less than a
random entry.** Strength continues; weakness does not revert. A breakout *is* a liquidity event -
short stops and resting breakout orders sit above the prior high - so the correct trade is to join
the raid, not fade it.

**Rules** (all params day-denominated; `S(d)` = d days in bars):
1. **Entry** - the FIRST close above the prior `lbBreak` **2-day** high (the BSL pool),
   **and** close > the `lbTrend` **5-day** SMA, **and** volume >= `lbRelVol` **1.3x** its 1-day average.
2. **Stop** - `lbStop` **3 x ATR** of the trading timeframe. Deliberately bar-native, not a fixed %:
   ZEC ran $21->$750 in the sample and a constant-% stop is the documented reason `zecdiv` failed.
3. **Exit** - trail out on a close below the prior `lbExit` **1-day** low, or the stop.

**Benchmark, ZEC 15m, 69,120 bars (2024-08 -> 2026-07), net of 0.1%/side:**

| model | trades | WR | PF | return | maxDD | time in market |
|---|---|---|---|---|---|---|
| risk-based (1% equity/trade) | 134 | 33.6% | 2.91 | **+304%** | **13.5%** | 24% |
| exposure, Invest 100% | 134 | 33.6% | 2.91 | +683% | 38.3% | 24% |
| buy & hold | - | - | - | +1086% | **74.0%** | 100% |

Positive in **all three chronological folds**; 6/9 quarters positive with the losing quarters
trivial (-1.0%, -2.2%, -0.6%) against wins of +86.8%, +39.5%, +39.8%.

**It is a plateau, not a fitted cell** - this is the key robustness evidence. Holding everything
else fixed: breakout length 96/144/192 bars all return 245-262%; stop 2.5-4 ATR all work (wider
stop => higher WR, lower DD, monotone); exit length 96/192 both ~250-284%; and the relVol and trend
filters change the result by only a few points. The **mechanism** carries the edge, not a threshold -
the opposite of `zecdiv`, where one knob carried everything.

**Cross-market check** (1% risk): positive on 4/6 coins at 1d (BTC 40% WR / PF 1.46 - ZEC 38%/2.59 -
SOL 44%/2.83 - XRP 28%/2.85 - SUI 35%/1.77 - LINK 41%/1.25) and 4/6 at 4h. Strongest where it was
designed, merely decent elsewhere - the signature of a real effect rather than a curve fit.

**REJECTED on the way here - do not rebuild** (all three lost in every fold, and the excursion study
showed their signal bars were statistically indistinguishable from random bars):
- **S1 stop-run reclaim** - SSL pool raided then reclaimed, bullish candle, volume >=1.5x, buy only
  in discount. n=643, WR 33.0%, PF 0.75, **9/9 losing quarters**. The discount filter was actively
  harmful.
- **S2 session liquidity** - Asian-range (00:00-08:00 UTC) low swept and reclaimed during the
  London/NY window. n=201, WR 45.8% but PF 0.66. Decent hit rate, negative expectancy, and the
  hour-of-day scan later showed **no session edge at all** on this pair.
- **S3 liquidation-cascade fade** - price >=2 ATR below rolling VWAP on a volume spike, reversal bar,
  target VWAP. n=435, WR 36.1%, PF 0.65, 9/9 losing quarters. Fading extension is backwards here.



### CORRECTION: the 13.5% drawdown was a test-window artifact (Aug 2026)

The benchmark above was run on **2024-08 -> 2026-07** because that was the cached window. The
Python desktop tester (`pytester/`, no 10k-bar cap) re-ran `liqbrk` on the **full listed ZEC 15m
history: 258,228 bars, 2019-03-21 -> 2026-08-03**. The result is materially worse and the earlier
"positive in all three folds" claim does NOT survive:

| window | n | WR | PF | net | maxDD | losing quarters |
|---|---|---|---|---|---|---|
| 2024-08 -> 2026-07 (as first reported) | 134 | 33.6% | 2.91 | +304% | **13.5%** | 3/9 |
| **2019-03 -> 2026-08 (full history)** | **553** | **23.9%** | **1.39** | **+199%** | **61.1%** | **15/31** |

Fold breakdown on full history: A +28.1% / **B -33.0% (55.4% drawdown)** / C +248.8%. Fold B spans
roughly 2021-09 -> 2024-01 - ZEC's grind from ~$200 to ~$20. The strategy bleeds for about two and
a half years: 22Q2 -13%, 23Q1 -10%, 23Q3 -21%, 23Q4 -13%, 24Q2 -14%.

**A stronger regime filter does not fix it.** Sweeping `lbTrend` from 5 to 200 days leaves fold B
negative at every setting (expR -0.21 to -0.41); the best it buys is drawdown 61% -> 52%. This is
structural: a long-only breakout system in a multi-year bear market has nothing to do but lose
slowly.

**What is still true:** over 7.4 years it is net positive (+199%) and its 61% drawdown beats buy &
hold's 96%. **What is not true:** that it is a low-drawdown system. Size it as a bull-regime
strategy that will go quiet-to-negative for years at a time, not as an all-weather one.

**Process lesson:** validate on ALL available history, not the window that happens to be cached.
Two years of a bull market flattered every statistic here.

### `liqbrk` is a SWING system, not day trading (recorded July 2026)

It runs on 15m bars but **holds ~1-2 days (avg 30.7h) and trades ~6x/month**. Labelling it
"intraday" was wrong and is corrected in the UI.

**Three genuine day-trading variants were built and ALL lost to it** (identical engine, next-open
fills, 0.1%/side, 1% risk; every candidate forced to avg hold <=12h and >=15 trades/month, and
required positive in all three chronological folds):

| system | n | WR | PF | net | maxDD | /mo | hold |
|---|---|---|---|---|---|---|---|
| **SWING liqbrk (kept)** | 136 | 34.6% | **2.66** | **+250.9%** | **13.3%** | 5.7 | 30.7h |
| DT1 intraday breakout (2h break / 6h trail / 12h cap) | 533 | 36.0% | 1.28 | +126.8% | 18.6% | 22.5 | 7.1h |
| DT2 momentum pullback (dip to fast EMA in uptrend) | 365 | 37.0% | 1.13 | +31.5% | 20.3% | 15.4 | 6.0h |
| DT3 squeeze expansion (range compression -> first break) | 360 | **43.3%** | 1.14 | +25.6% | 17.6% | 15.2 | 4.6h |

DT3 has the best win rate but PF 1.14 and a **negative first fold** - a coin flip after costs.

**Why day trading loses here, quantitatively:**

| | avg gross move/trade | 0.2% round-trip fee as % of that move | total fee drag | biggest winner | top-5 winners = % of gross profit |
|---|---|---|---|---|---|
| SWING | **2.179%** | **9%** | 28% of notional | **+147.9%** | **44%** |
| DT1 | 0.596% | **34%** | **103% of notional** | +49.4% | 15% |

Two independent killers. (1) **Fees**: a day trade's average move is 0.6%, so the round trip takes
34% of it, and across 517 trades the drag exceeds the entire notional. (2) **The fat tail is the
edge**: 44% of the swing system's gross profit comes from its top 5 trades, and its best ran +148%.
A 12h hold cap makes that structurally impossible - you cannot hold a +148% move for 12 hours.

**Do not retry day trading on this pair** unless fees drop by an order of magnitude (maker rebates)
or a genuinely different, higher-frequency edge is found and PROVEN against a random baseline first.

**Engine bug this exposed** (fixed July 2026): `runQuant` guarded *every* strategy with
`if (n < maLen + 2) return` and started its loop at `maLen`, where `maLen` is the **200-day** MA -
19,200 bars on 15m. Any intraday strategy therefore returned **zero trades** on windows shorter
than 200 days, silently. Warm-up is now per strategy.

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
