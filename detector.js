/*
 * SMC BOS trend engine — single source of truth. Implements ALGORITHM.md.
 * Works in the browser (window.SMC) and Node (module.exports).
 *
 * Input candles: [{ time, open, high, low, close }, ...] ascending, time in UNIX seconds.
 *
 * MODEL (user's spec): one evolving structure walked chronologically from the first major low.
 *  - BULLISH: track a STRONG LOW. A close above the SuperSaiyyan high = BOS↑ (continuation) →
 *    the Strong Low TRAILS UP to the low of that new up-move. A close below the Strong Low =
 *    CHoCH↓ → the SuperSaiyyan HIGH becomes the STRONG HIGH and we flip bearish. BEARISH mirrors.
 *
 * TRADE PLAYBOOK (manipulation → displacement FVG → confirmation → tap):
 *  1. MANIPULATION — price sweeps a resting liquidity pool (SSL below lows for longs, BSL above
 *     highs for shorts) and reverses: the sweep extreme is the Strong Low / Strong High.
 *  2. DISPLACEMENT — the impulsive leg away from the sweep leaves a major FVG. That imbalance is
 *     the footprint of big players' resting orders: they couldn't fill everything at the extreme.
 *  3. CONFIRMATION — the leg closes through structure (BOS or CHoCH). Only now do we trust the
 *     move; a resting limit order goes INSIDE the displacement FVG (fibLevel deep, 0.5 = CE).
 *  4. TAP — the retrace into the FVG fills us. FIRST tap only: once mitigated, the orders are
 *     gone, so a tap that arrives while we're busy or against HTF bias just cancels the order.
 *     Orders also expire (poiHorizon bars) and die on any structure flip.
 *  Stop hides below the sweep wick (beyond the manipulated pool); target is the nearest UNSWEPT
 *  opposite pool that still pays ≥ minRR — the closest magnet, for the highest hit-rate that
 *  keeps positive expectancy. No pool ⇒ major-FVG target fallback; still short of minRR ⇒ skip.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    strategy: 'cycle', // quant: 'cycle' = BTC halving playbook | 'tsmom' = CTA trend | 'donch' = turtle breakout
                     //        'liqbrk' = buy-side liquidity continuation (intraday-first)
                     // smc: 'regime' | 'fvg' | 'momo' | 'scalp' (kept for reference/experiments)
    cyclePersist: 5, // cycle: days beyond the 40w band before a trend entry/exit confirms
    volTarget: 0.3,  // advisor sizing suggestion: annualized vol target / realized vol, capped at 1
    persist: 3,      // tsmom: entry signal must hold this many consecutive days (whipsaw filter)
    tsmomMa: 200,    // tsmom: long-term trend filter, close > SMA(n)
    tsmomLook: 90,   // tsmom: momentum lookback — n-day return must also be positive
    donchIn: 55,     // donch: entry = close above the n-day high (Turtle S2)
    donchOut: 20,    // donch: exit = close below the n-day low
    qStop: 2.0,      // tsmom/donch: initial stop ×ATR below entry (risk unit for R accounting)
    // --- liqbrk: buy-side liquidity continuation (intraday-first, works on any TF) ---
    lbBreak: 2,      // entry = close above the prior n-DAY high (the BSL pool being raided)
    lbExit: 1,       // trail exit = close below the prior n-day low
    lbTrend: 5,      // regime gate: only long while close > the n-day SMA
    lbStop: 3.0,     // initial stop = n × ATR of the TRADING timeframe (bar-native on purpose:
                     // ZEC ran $21→$750, so the stop must breathe with realized volatility)
    lbRelVol: 1.3,   // the breakout must trade ≥ this × its 1-day average volume
    longOnly: false, // investment/spot mode: never short (structure is still tracked both ways)
    regimeExit: 'daily', // 'daily' = exit on base-TF CHoCH too (benched: best drawdown control) | 'weekly' = HTF flip only
    momoBosOnly: false, // momentum: true = continuation breaks only, skip CHoCH reversal entries
    eqTol: 0.5,      // equal highs/lows merge tolerance, ×ATR (0 = every pivot is its own pool)
    atrLen: 14,
    extMult: 4.0,    // major (external) swing sensitivity, × ATR — defines the structure
    intMult: 1.5,    // minor swing sensitivity (kept for reference dots)
    requireClose: true,
    unmitiLookback: 400,
    maxUnmitMarks: 40,
    fibLevel: 0.5,   // depth of the limit order inside the displacement FVG (0.5 = consequent encroachment)
    fvgMult: 0.5,    // a "major" FVG = gap height ≥ fvgMult × ATR
    poiHorizon: 200, // bars a resting order stays valid after confirmation (then orders are stale)
    discount: 1.0,   // entry must sit in this sweep-side fraction of the leg (1 = off; minRR already gates quality)
    htfMult: 1,      // higher-timeframe confluence multiplier (1 = off; ×7 on 1d = weekly context)
    htfExtMult: 0,   // structure sensitivity OF THE HTF walk, ×ATR (0 = same as extMult; lower = faster regime flips)
    reqSweep: true,  // require the manipulation: Strong Low must have swept an SSL pool (BSL for shorts)
    minRR: 1.5,      // a trade must pay at least this reward:risk or it is skipped
    useLiq: true,     // compute Coinglass-style estimated liquidation clusters (chart context)
    liqSweep: false,  // let liq bands validate the manipulation — benched WORSE (51.6% vs 66.7% WR), off by default
    liqTargets: false,// let liq bands serve as trade targets — benched worse (60.6% WR), off by default
  };

  // ---- helpers -------------------------------------------------------------
  function trueRange(c, i) {
    if (i === 0) return c[0].high - c[0].low;
    return Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  function atr(c, len) {
    const out = new Array(c.length).fill(0);
    if (!c.length) return out;
    let sum = 0;
    for (let i = 0; i < c.length; i++) {
      const tr = trueRange(c, i);
      out[i] = i < len ? (sum += tr) / (i + 1) : (out[i - 1] * (len - 1) + tr) / len;
    }
    return out;
  }

  // ATR-filtered zigzag: a reversal is confirmed only when it exceeds mult×ATR.
  function detectPivots(c, mult, a) {
    const piv = [];
    if (c.length < 3) return piv;
    let trend = null, hi = { price: c[0].high, i: 0 }, lo = { price: c[0].low, i: 0 };
    for (let i = 1; i < c.length; i++) {
      const noise = mult * a[i];
      if (trend === null) {
        if (c[i].high > hi.price) hi = { price: c[i].high, i };
        if (c[i].low < lo.price) lo = { price: c[i].low, i };
        if (hi.price - c[i].low > noise) { trend = 'down'; piv.push({ kind: 'H', i: hi.i, price: hi.price }); lo = { price: c[i].low, i }; }
        else if (c[i].high - lo.price > noise) { trend = 'up'; piv.push({ kind: 'L', i: lo.i, price: lo.price }); hi = { price: c[i].high, i }; }
        continue;
      }
      if (trend === 'up') {
        if (c[i].high > hi.price) hi = { price: c[i].high, i };
        if (hi.price - c[i].low > noise) { piv.push({ kind: 'H', i: hi.i, price: hi.price }); trend = 'down'; lo = { price: c[i].low, i }; }
      } else {
        if (c[i].low < lo.price) lo = { price: c[i].low, i };
        if (c[i].high - lo.price > noise) { piv.push({ kind: 'L', i: lo.i, price: lo.price }); trend = 'up'; hi = { price: c[i].high, i }; }
      }
    }
    return piv;
  }

  function labelStructure(piv) {
    let lastH = null, lastL = null;
    return piv.map((p) => {
      let label = p.kind;
      if (p.kind === 'H') { label = lastH == null ? 'H' : (p.price > lastH ? 'HH' : 'LH'); lastH = p.price; }
      else { label = lastL == null ? 'L' : (p.price > lastL ? 'HL' : 'LL'); lastL = p.price; }
      return Object.assign({}, p, { label });
    });
  }

  // ---- FVG (3-candle imbalance) --------------------------------------------
  function detectFVG(c) {
    const out = [];
    for (let i = 1; i < c.length - 1; i++) {
      if (c[i - 1].high < c[i + 1].low) out.push({ i, type: 'bull', bottom: c[i - 1].high, top: c[i + 1].low });
      else if (c[i - 1].low > c[i + 1].high) out.push({ i, type: 'bear', top: c[i - 1].low, bottom: c[i + 1].high });
    }
    for (const g of out) {
      g.filled = false;
      for (let j = g.i + 2; j < c.length; j++) if (c[j].low <= g.top && c[j].high >= g.bottom) { g.filled = true; break; }
    }
    return out;
  }

  // ---- liquidity pools: BSL (above swing/equal highs) & SSL (below swing/equal lows) ----
  // Quant/SMC view: stops rest just beyond swing pivots; equal highs/lows = magnet pools. We
  // build them from price (Coinglass heatmaps mostly visualise these same clusters). A pool is
  // "swept" at the first later candle whose wick pierces it. eqTol = fraction of ATR for grouping
  // near-equal pivots into one pool (a stronger magnet).
  function detectLiquidity(c, piv, a, eqTol) {
    const pools = [];
    const mk = (side, pv) => {
      const tol = eqTol * a[pv.i];
      // merge into an existing same-side pool if within tol (equal highs/lows cluster) and the
      // level wasn't already raided between the two touches (a swept level is spent, not equal)
      const near = pools.find((q) => {
        if (q.side !== side || Math.abs(q.price - pv.price) > tol || pv.i <= q.i) return false;
        for (let j = q.i + 1; j < pv.i; j++) if (side === 'BSL' ? c[j].high > q.price + tol : c[j].low < q.price - tol) return false;
        return true;
      });
      if (near) { near.touches++; near.i = pv.i; near.price = (side === 'BSL') ? Math.max(near.price, pv.price) : Math.min(near.price, pv.price); return near; }
      const pool = { side, i: pv.i, price: pv.price, touches: 1, sweptIdx: -1 };
      pools.push(pool); return pool;
    };
    for (const pv of piv) mk(pv.kind === 'H' ? 'BSL' : 'SSL', pv);
    // mark sweeps (first later wick beyond the level)
    for (const q of pools) {
      q.weight = q.touches;
      for (let j = q.i + 1; j < c.length; j++) {
        if (q.side === 'BSL' ? c[j].high > q.price : c[j].low < q.price) { q.sweptIdx = j; break; }
      }
    }
    return pools;
  }

  // ---- estimated liquidation clusters (Coinglass-style heat) ----------------
  // Leveraged entries pile in at swing points and their forced exits sit a fixed fraction
  // away: a long opened at P dies at ~P×(1−1/L). We synthesize the bands a Coinglass heatmap
  // shows from pivots + volume: pivot HIGHS spawn long-liquidation levels BELOW price
  // (SSL-type magnets), pivot LOWS spawn short-liquidation levels ABOVE (BSL-type). Nearby
  // levels merge into one band; band weight = the volume that entered at the source pivots
  // (the chart encodes weight as heat — faint bands are visible but obviously weak).
  function detectLiqClusters(c, piv, a, p) {
    const tiers = [100, 50, 25];               // popular leverage tiers (10x sits too far to matter)
    const raw = [];
    for (const pv of piv) {
      let vol = 0;
      for (let j = Math.max(0, pv.i - 2); j <= Math.min(c.length - 1, pv.i + 2); j++) vol += (c[j].volume || 1);
      for (const L of tiers) {
        if (pv.kind === 'H') raw.push({ side: 'SSL', price: pv.price * (1 - 1 / L), i: pv.i, w: vol / tiers.length, lev: L });
        else raw.push({ side: 'BSL', price: pv.price * (1 + 1 / L), i: pv.i, w: vol / tiers.length, lev: L });
      }
    }
    raw.sort((x, y) => x.price - y.price);
    const out = [];
    for (const r of raw) {
      const tol = 0.25 * a[r.i];
      const near = out.find((q) => q.side === r.side && Math.abs(q.price - r.price) <= tol);
      if (near) { near.weight += r.w; near.touches++; near.i = Math.min(near.i, r.i); near.price = (near.price + r.price) / 2; }
      else out.push({ side: r.side, price: r.price, i: r.i, weight: r.w, touches: 1, sweptIdx: -1, liq: true, lev: r.lev });
    }
    for (const q of out) {
      for (let j = q.i + 1; j < c.length; j++) if (q.side === 'BSL' ? c[j].high > q.price : c[j].low < q.price) { q.sweptIdx = j; break; }
    }
    return out;
  }

  // ---- unmitigated candles (untouched even by wick), for display -----------
  function detectUnmitigated(c, p) {
    const start = Math.max(0, c.length - p.unmitiLookback);
    const res = [];
    for (let k = c.length - 1; k >= start; k--) {
      const hi = c[k].high, lo = c[k].low;
      let leftIdx = -1, leftAbove = false;
      for (let j = k + 1; j < c.length; j++) {
        if (c[j].low > hi) { leftIdx = j; leftAbove = true; break; }
        if (c[j].high < lo) { leftIdx = j; leftAbove = false; break; }
      }
      if (leftIdx === -1) continue;
      let mitigated = false;
      for (let j = leftIdx; j < c.length; j++) if (c[j].low <= hi && c[j].high >= lo) { mitigated = true; break; }
      if (!mitigated) {
        res.push({ i: k, high: hi, low: lo, bull: c[k].close >= c[k].open, side: leftAbove ? 'demand' : 'supply' });
        if (res.length >= p.maxUnmitMarks) break;
      }
    }
    return res.reverse();
  }

  // ---- trade target = the MAJOR FVG near the top of the SuperSaiyyan (fallback) ----
  // long: nearest major bullish FVG (formed by entry, unfilled, above entry) to the SS high;
  // short: mirror with bearish FVGs. Fallback = the SS extreme, then a 2R projection.
  function pickTarget(c, fvgs, p, a, dir, entry, entryIdx, ssPrice, stop) {
    if (dir === 'long') {
      const cands = fvgs.filter((g) => g.type === 'bull' && g.i <= entryIdx && (g.top - g.bottom) >= p.fvgMult * a[g.i] && g.bottom > entry);
      if (cands.length) {
        const below = cands.filter((g) => g.bottom <= ssPrice);        // major FVG near the SS top
        const pool = below.length ? below : cands;
        return Math.max.apply(null, pool.map((g) => g.bottom));
      }
      return ssPrice > entry ? ssPrice : entry + 2 * (entry - stop);
    }
    const cands = fvgs.filter((g) => g.type === 'bear' && g.i <= entryIdx && (g.top - g.bottom) >= p.fvgMult * a[g.i] && g.top < entry);
    if (cands.length) {
      const above = cands.filter((g) => g.top >= ssPrice);
      const pool = above.length ? above : cands;
      return Math.min.apply(null, pool.map((g) => g.top));
    }
    return ssPrice < entry ? ssPrice : entry - 2 * (stop - entry);
  }
  // Forward-simulate the trade to a real outcome (stop checked before target on a tie).
  function simTrade(c, entryIdx, dir, stop, target) {
    for (let j = entryIdx; j < c.length; j++) {
      if (dir === 'long') { if (c[j].low <= stop) return { outcome: 'loss', exitIdx: j }; if (c[j].high >= target) return { outcome: 'win', exitIdx: j }; }
      else { if (c[j].high >= stop) return { outcome: 'loss', exitIdx: j }; if (c[j].low <= target) return { outcome: 'win', exitIdx: j }; }
    }
    return { outcome: 'open', exitIdx: c.length - 1 };
  }

  // ---- quant investment strategies (no SMC structure involved) --------------
  // The three systems the big systematic firms actually run, long-only spot, daily bars:
  //  tsmom   — time-series momentum / CTA trend (AQR, Man AHL): long while close > SMA(200)
  //            AND the 90d return is positive; flat the moment either fails.
  //  meanrev — short-term mean reversion (Connors-style stat-arb): in an uptrend, buy panic
  //            (z-score of close vs SMA20 < −1.5), sell the bounce back to the mean.
  //  donch   — Donchian channel breakout, the original Turtle/managed-futures system:
  //            buy a close above the 55d high, trail out on a close below the 20d low.
  // Every trade carries rMult (realized R vs the initial stop) so the risk-model equity and
  // the all-in compounding both work from the same records.
  //  composite — the pro build: an ENSEMBLE of the three trend signals (200d MA, 90d momentum,
  //            55d channel mid) with VOLATILITY TARGETING (exposure = volTarget/realizedVol) and
  //            a hard stop. Signal blending + vol targeting are the two techniques that define
  //            institutional CTA books. Each hold carries `frac` = the vol-sized exposure.
  // Optional liquidity gate (`liqTargets`): only enter when the estimated liquidation fuel
  // resting ABOVE price (within ±25%) outweighs the fuel below — the Coinglass-style magnet map.
  function runQuant(c, p, a, pools) {
    const n = c.length, trades = [];
    // TIMEFRAME SCALING: every lookback param is denominated in DAYS and converted to bars,
    // so "SMA200" is 200 days on any TF (1200 bars on 4h, ~29 bars on 1w) — the same economic
    // signal everywhere. Stop multiples scale by √(bars/day) so stop DISTANCES stay constant
    // in daily-vol terms (per-bar ATR shrinks ~√bpd on lower TFs).
    const dt = n > 1 ? Math.max(60, c[1].time - c[0].time) : 86400;
    const bpd = 86400 / dt;
    const S = (days) => Math.max(2, Math.round(days * bpd));
    const sf = Math.max(0.8, Math.sqrt(bpd));   // floor: above-daily TFs keep a workable stop distance
    const maLen = S(p.tsmomMa), lookLen = S(p.tsmomLook), inLen = S(p.donchIn), outLen = S(p.donchOut),
      w20 = S(20), volWin = S(30);
    // Warm-up is PER STRATEGY. maLen is the 200-day MA — on 15m that is 19,200 bars, so guarding
    // every strategy with it silently returned zero trades for the intraday systems on any window
    // shorter than 200 days (liqbrk needs 5 days, not 200).
    const warm = p.strategy === 'liqbrk' ? Math.max(S(p.lbTrend), S(p.lbBreak), S(1)) + 2 : maLen;
    if (n < warm + 2) return { trades, advice: null };
    const closes = c.map((x) => x.close);
    const sma = (len) => {
      const out = new Array(n).fill(NaN);
      let s = 0;
      for (let i = 0; i < n; i++) { s += closes[i]; if (i >= len) s -= closes[i - len]; if (i >= len - 1) out[i] = s / len; }
      return out;
    };
    const maL = sma(maLen), ma20 = sma(w20);
    const std20 = new Array(n).fill(NaN);
    for (let i = w20 - 1; i < n; i++) {
      let s = 0;
      for (let j = i - w20 + 1; j <= i; j++) { const d = closes[j] - ma20[i]; s += d * d; }
      std20[i] = Math.sqrt(s / w20);
    }
    const hiN = new Array(n).fill(Infinity), loN = new Array(n).fill(-Infinity), loIn = new Array(n).fill(Infinity);
    for (let i = 1; i < n; i++) {                                  // prior n-day extremes (exclusive of today)
      let h = -Infinity, l = Infinity, li = Infinity;
      for (let j = Math.max(0, i - inLen); j < i; j++) { if (c[j].high > h) h = c[j].high; if (c[j].low < li) li = c[j].low; }
      for (let j = Math.max(0, i - outLen); j < i; j++) if (c[j].low < l) l = c[j].low;
      hiN[i] = h; loN[i] = l; loIn[i] = li;
    }
    // realized 30d volatility, annualized — the denominator of vol targeting
    const volA = new Array(n).fill(0);
    {
      const lr = new Array(n).fill(0);
      const ann = Math.sqrt(365 * bpd);
      for (let i = 1; i < n; i++) lr[i] = Math.log(closes[i] / closes[i - 1]);
      for (let i = volWin + 1; i < n; i++) {
        let m = 0;
        for (let j = i - volWin + 1; j <= i; j++) m += lr[j];
        m /= volWin;
        let s = 0;
        for (let j = i - volWin + 1; j <= i; j++) { const d = lr[j] - m; s += d * d; }
        volA[i] = Math.sqrt(s / (volWin - 1)) * ann;
      }
    }
    const volFrac = (i) => Math.min(1, Math.max(0.15, p.volTarget / (volA[i] || 1)));
    // liquidation-magnet balance around price (context gate; pools may be empty)
    const liqBal = (i, px) => {
      let up = 0, dn = 0, nearUp = null, nearDn = null;
      for (const q of (pools || [])) {
        if (!q.liq || q.i >= i || !(q.sweptIdx === -1 || q.sweptIdx > i)) continue;
        if (q.price > px && q.price < px * 1.25) { up += q.weight; if (nearUp == null || q.price < nearUp) nearUp = q.price; }
        else if (q.price < px && q.price > px * 0.75) { dn += q.weight; if (nearDn == null || q.price > nearDn) nearDn = q.price; }
      }
      return { up, dn, nearUp, nearDn };
    };
    const magnetOK = (i, px) => !p.liqTargets || !(pools && pools.length) || (() => { const b = liqBal(i, px); return b.up >= b.dn; })();
    const compScore = (i, px) => (px > maL[i] ? 1 : 0) + (i >= lookLen && px > closes[i - lookLen] ? 1 : 0) + (px > (hiN[i] + loIn[i]) / 2 ? 1 : 0);

    // LIQBRK precompute — a breakout IS a liquidity event: the stops of shorts plus resting
    // breakout orders sit above the prior n-day high, and taking them is what fuels continuation.
    // Benched on ZEC 15m (69k bars): the forward-return scan showed top-of-range / above-VWAP /
    // high-RSI states return 2–3× baseline MONOTONICALLY, while "discount" states returned LESS
    // than random. So we join the raid instead of fading it. See ALGORITHM.md.
    let lb = null;
    if (p.strategy === 'liqbrk') {
      const bL = S(p.lbBreak), eL = S(p.lbExit), vL = Math.max(2, S(1));
      const hiB = new Array(n).fill(Infinity), loE = new Array(n).fill(-Infinity), rv = new Array(n).fill(1);
      for (let i = 1; i < n; i++) {
        let h = -Infinity, l = Infinity;
        for (let j = Math.max(0, i - bL); j < i; j++) if (c[j].high > h) h = c[j].high;
        for (let j = Math.max(0, i - eL); j < i; j++) if (c[j].low < l) l = c[j].low;
        hiB[i] = h; loE[i] = l;
      }
      let vs = 0;
      for (let i = 0; i < n; i++) {
        const v = c[i].volume || 0;
        vs += v; if (i >= vL) vs -= (c[i - vL].volume || 0);
        const avg = vs / Math.min(i + 1, vL);
        rv[i] = avg > 0 ? v / avg : 1;
      }
      lb = { hiB, loE, rv, maT: sma(S(p.lbTrend)) };
    }

    let pos = null, sigRun = 0;
    const close = (i, exit, why) => {
      const risk0 = pos.entry - pos.stop;
      const rMult = (isFinite(risk0) && risk0 > 0) ? (exit - pos.entry) / risk0 : (exit / pos.entry - 1);
      trades.push({ dir: 'long', poiIdx: pos.entryIdx, fvgIdx: -1, zoneLow: pos.stop, zoneTop: pos.entry,
        sweepIdx: -1, targetPool: why, entry: pos.entry, stop: pos.stop, target: exit, exitPrice: exit,
        tp: pos.tp || null, entryIdx: pos.entryIdx, exitIdx: i, outcome: rMult >= 0 ? 'win' : 'loss', frac: pos.frac || 1,
        rr: +rMult.toFixed(2), rMult: +rMult.toFixed(4) });
      pos = null;
    };
    // CYCLE (BTC halving playbook) precomputes — validated 2018→2026: +3535% vs B&H +767%,
    // maxDD 59%, 7 positions. BUY ZONE = ≥2 of {price<1.1×200w MA, Mayer<0.8, weekly RSI<35}
    // + confirmation (sweep-reclaim of a major low, or a 20d-high breakout). SELL = Pi-Cycle
    // cross (111d MA crossing 2×350d MA — sold 2017-12-17 and 2021-04-12 to the day) or a
    // persistent 40-week MA break. Zone entries hold WITHOUT the trend stop (accumulation).
    let cy = null;
    if (p.strategy === 'cycle') {
      const ma111 = sma(S(111)), ma350 = sma(S(350)), ma280 = sma(S(280)), ma1400 = sma(S(1400));
      const step = Math.max(1, S(7)), wRSI = new Array(n).fill(NaN);
      let g = 0, ls = 0, k = 0, lastR = NaN;
      for (let i = step; i < n; i += step) {
        const ch = closes[i] - closes[i - step];
        g = (g * 13 + Math.max(ch, 0)) / 14; ls = (ls * 13 + Math.max(-ch, 0)) / 14; k++;
        if (k >= 14) lastR = 100 - 100 / (1 + (ls > 0 ? g / ls : 100));
        for (let j = i; j < Math.min(i + step, n); j++) wRSI[j] = lastR;
      }
      const swp = new Array(n).fill(false), h20 = new Array(n).fill(Infinity);
      const wA = S(120), wB = S(10), w20 = S(20);
      for (let i = wA + wB; i < n; i++) {
        let prior = Infinity;
        for (let j = i - wA; j < i - wB; j++) if (c[j].low < prior) prior = c[j].low;
        if (c[i].low < prior && c[i].close > prior) swp[i] = true;
      }
      for (let i = 1; i < n; i++) { let h = 0; for (let j = Math.max(0, i - w20); j < i; j++) if (c[j].high > h) h = c[j].high; h20[i] = h; }
      cy = { ma111, ma350, ma280, ma1400, wRSI, swp, h20,
        zone: (i) => ((closes[i] < 1.1 * ma1400[i]) ? 1 : 0) + ((closes[i] / maL[i] < 0.8) ? 1 : 0) + ((wRSI[i] < 35) ? 1 : 0),
        pi: (i) => i > 0 && ma111[i] > 2 * ma350[i] && ma111[i - 1] <= 2 * ma350[i - 1] };
    }
    let cyUp = 0, cyDn = 0, cyCool = false, cyMode = null;
    const cyPersist = Math.max(1, S(p.cyclePersist));

    const persistN = Math.max(1, S(p.persist));                   // persistence is day-denominated too
    for (let i = warm; i < n; i++) {
      const px = closes[i];
      if (p.strategy === 'cycle') {
        const above = px > cy.ma280[i] * 1.02, below = px < cy.ma280[i] * 0.97;
        cyUp = above ? cyUp + 1 : 0; cyDn = below ? cyDn + 1 : 0;
        if (cyCool && px < cy.ma280[i]) cyCool = false;            // top has played out → normal rules
        // ZONE A = 200w MA → ×1.1 (classic). ZONE B = 0.72–1.0 ×200w MA: every real bottom
        // PIERCES the 200w (2020 −30%, 2022 −31%, 2026 −8%), so accumulation is TWO tranches —
        // half in zone A, half on the zone-B recovery, entry = the tranche average (harmonic:
        // equal dollars), stop below zone B at 0.65×200w (under the deepest pierce on record).
        // DEPLOYMENT PROGRAM (institutional ladder): 40% at zone A, 40% at zone B, 20% reserve
        // on trend confirmation. BULLISH COMPLETION: if B never fills and price reclaims the
        // 40-week MA, every unfilled tranche deploys at that confirmation — the program never
        // gets left behind. Entry = equal-dollar (harmonic) weighted average of fills.
        const zoneB = px < 0.97 * cy.ma1400[i];
        const fill = (w, price) => { pos.invSum += w / price; pos.fracSum += w; pos.entry = pos.fracSum / pos.invSum; pos.frac = pos.fracSum; };
        if (pos) {
          if (cy.pi(i)) { close(i, px, 'PI-TOP'); cyCool = true; cyMode = null; }
          else if (cyMode === 'ACCUM') {
            if (!pos.t2 && zoneB && (cy.swp[i] || px > closes[i - 1])) {        // tranche 2: deep-zone recovery day
              fill(0.4, px); pos.t2 = true; pos.stop = isFinite(cy.ma1400[i]) ? 0.65 * cy.ma1400[i] : px * 0.72;
            }
            if (c[i].low <= pos.stop) { close(i, pos.stop, 'STOP'); cyMode = null; }
            else if (px > cy.ma280[i]) {
              if (pos.fracSum < 1) fill(1 - pos.fracSum, px);                   // bullish completion: deploy the rest
              cyMode = 'TREND';
            }
          }
          else if (cyDn >= cyPersist) { close(i, px, 'TREND'); cyMode = null; }
        } else if (cy.zone(i) >= 2 && (cy.swp[i] || px > cy.h20[i])) {
          // stop fallback: early in a dataset the 200w MA doesn't exist yet → fixed −28% program stop
          pos = { invSum: 0, fracSum: 0, entry: px, stop: isFinite(cy.ma1400[i]) ? 0.65 * cy.ma1400[i] : px * 0.72,
            entryIdx: i, tp: 1.85 * maL[i], t2: zoneB };
          fill(zoneB ? 0.8 : 0.4, px);                                          // straight into the deep zone = A+B at once
          cyMode = 'ACCUM';
        } else if (!cyCool && cyUp >= cyPersist) {
          pos = { entry: px, stop: cy.ma280[i] * 0.97, entryIdx: i, tp: 1.85 * maL[i], frac: 1 }; cyMode = 'TREND';
        }
      } else if (p.strategy === 'tsmom') {
        const on = px > maL[i] && i >= lookLen && px > closes[i - lookLen];
        sigRun = on ? sigRun + 1 : 0;
        if (!pos && sigRun >= persistN && magnetOK(i, px)) pos = { entry: px, stop: px - p.qStop * sf * a[i], entryIdx: i };
        else if (pos && !on) close(i, px, 'TREND');
      } else if (p.strategy === 'liqbrk') {
        if (pos) {
          if (c[i].low <= pos.stop) close(i, pos.stop, 'STOP');
          else if (px < lb.loE[i]) close(i, px, 'TRAIL');
        } else if (px > lb.hiB[i] && closes[i - 1] <= lb.hiB[i - 1]   // FIRST close through the pool
                   && px > lb.maT[i] && lb.rv[i] >= p.lbRelVol && magnetOK(i, px)) {
          pos = { entry: px, stop: px - p.lbStop * a[i], entryIdx: i };
        }
      } else {                                                     // donch
        if (pos) {
          if (c[i].low <= pos.stop) close(i, pos.stop, 'STOP');
          else if (px < loN[i]) close(i, px, 'TRAIL');
        } else if (px > hiN[i] && magnetOK(i, px)) {
          pos = { entry: px, stop: px - p.qStop * sf * a[i], entryIdx: i };
        }
      }
    }
    if (pos) {
      const last = closes[n - 1], risk0 = pos.entry - pos.stop;
      trades.push({ dir: 'long', poiIdx: pos.entryIdx, fvgIdx: -1, zoneLow: pos.stop, zoneTop: pos.entry,
        sweepIdx: -1, targetPool: 'OPEN', entry: pos.entry, stop: pos.stop, target: last, exitPrice: last,
        tp: pos.tp || null, entryIdx: pos.entryIdx, exitIdx: n - 1, outcome: 'open', frac: pos.frac || 1,
        rr: +(risk0 > 0 ? (last - pos.entry) / risk0 : 0).toFixed(2) });
    }
    // the ADVISOR read: what the context says right now, at the last closed candle
    const i = n - 1, px = closes[i];
    const b = liqBal(i, px);
    const advice = {
      px, stance: (trades.length && trades[trades.length - 1].outcome === 'open') ? 'IN' : 'CASH',
      signals: lb ? [
        { name: `Above the ${p.lbTrend}-day trend average`, ok: px > lb.maT[i] },
        { name: `Broke the ${p.lbBreak}-day high (liquidity taken)`, ok: px > lb.hiB[i] },
        { name: `Volume ≥ ${p.lbRelVol}× its daily average`, ok: lb.rv[i] >= p.lbRelVol },
      ] : [
        { name: 'Above 200-day average', ok: px > maL[i] },
        { name: '90-day momentum positive', ok: px > closes[i - lookLen] },
        { name: 'Above 55-day channel mid', ok: px > (hiN[i] + loIn[i]) / 2 },
      ],
      z: std20[i] > 0 ? +((px - ma20[i]) / std20[i]).toFixed(2) : 0,
      volAnn: +volA[i].toFixed(2), alloc: +volFrac(i).toFixed(2),
      liqUp: b.up, liqDn: b.dn, nearUp: b.nearUp, nearDn: b.nearDn,
    };
    let cycleLines = null;
    if (cy) {
      advice.cycle = { mayer: +(px / maL[i]).toFixed(2), d200w: +((px / cy.ma1400[i] - 1) * 100).toFixed(1),
        wRSI: +(cy.wRSI[i] || 0).toFixed(0), zone: cy.zone(i), piRatio: +(cy.ma111[i] / (2 * cy.ma350[i])).toFixed(2),
        mode: cyMode, cooldown: cyCool,
        // the live deployment schedule (institutional ladder), all prices as-of the last close
        plan: { aLo: cy.ma1400[i], aHi: 1.1 * cy.ma1400[i], bLo: 0.72 * cy.ma1400[i], bHi: cy.ma1400[i],
          reserveTrig: cy.ma280[i] * 1.02, sl: 0.65 * cy.ma1400[i], tpLo: 1.85 * maL[i], tpHi: 2.4 * maL[i],
          alloc: [40, 40, 20], fracNow: pos ? (pos.fracSum != null ? pos.fracSum : pos.frac || 1) : 0,
          avgNow: pos ? pos.entry : null } };
      cycleLines = { zLo: cy.ma1400, trend: cy.ma280, ma200: maL };   // UI projects buy band (200w→×1.1) and sell band (1.85–2.4×200d)
    }
    return { trades, advice, cycleLines };
  }

  // ---- arm a resting order after a confirmed break --------------------------
  // Called at the confirmation candle (BOS or CHoCH). strong = the sweep extreme the displacement
  // left from; extreme = the current SS price (for the FVG-target fallback). Returns the pending
  // order (limit inside the manipulation FVG) or null when the playbook conditions aren't met.
  function armOrder(c, dir, bosIdx, strongPrice, strongIdx, extreme, pools, fvgs, p, a) {
    const long = dir === 'long';
    // 1) MANIPULATION — the sweep extreme must have run a resting pool (took stops, then reversed)
    let sweepPool = null;
    const from = Math.max(0, strongIdx - p.poiHorizon);
    for (const q of pools) {
      if (q.liq && !p.liqSweep) continue;                       // liq bands as targets only
      if (q.side !== (long ? 'SSL' : 'BSL') || q.sweptIdx < from || q.sweptIdx > bosIdx) continue;
      if (long ? strongPrice <= q.price : strongPrice >= q.price) { sweepPool = q; break; }
    }
    if (p.reqSweep && !sweepPool) return null;
    // stop hides beyond the sweep wick, shared by every candidate zone of this leg
    const stop = long
      ? (sweepPool ? Math.min(strongPrice, sweepPool.price) : strongPrice) - 0.1 * a[strongIdx]
      : (sweepPool ? Math.max(strongPrice, sweepPool.price) : strongPrice) + 0.1 * a[strongIdx];
    const range = long ? c[bosIdx].close - strongPrice : strongPrice - c[bosIdx].close;
    if (range <= 0) return null;

    // grade one candidate zone: entry fibLevel deep, target = nearest unswept opposite pool
    // paying ≥ minRR (closest magnet = highest hit-rate); FVG fallback; under minRR ⇒ reject
    const grade = (zLow, zTop, zIdx) => {
      const entry = long ? zTop - p.fibLevel * (zTop - zLow) : zLow + p.fibLevel * (zTop - zLow);
      if (long ? entry > strongPrice + p.discount * range : entry < strongPrice - p.discount * range) return null;
      const risk = long ? entry - stop : stop - entry;
      if (risk <= 0) return null;
      let target = null, targetPool = long ? 'BSL' : 'SSL';
      const cands = pools
        .filter((q) => (!q.liq || p.liqTargets) && q.side === targetPool && (q.sweptIdx === -1 || q.sweptIdx > bosIdx) && (long ? q.price > entry : q.price < entry))
        .sort((u, v) => (long ? u.price - v.price : v.price - u.price));
      for (const q of cands) {
        const rr = (long ? q.price - entry : entry - q.price) / risk;
        if (rr >= p.minRR) { target = q.price; break; }
      }
      if (target == null) {
        const t2 = pickTarget(c, fvgs, p, a, dir, entry, bosIdx, extreme, stop);
        if ((long ? t2 - entry : entry - t2) / risk >= p.minRR) { target = t2; targetPool = 'FVG'; }
      }
      if (target == null) return null;
      return { dir, fvgIdx: zIdx, zoneLow: zLow, zoneTop: zTop, entry, stop, target, targetPool,
        sweepIdx: sweepPool ? sweepPool.sweptIdx : -1, bosIdx, expiry: bosIdx + p.poiHorizon };
    };

    // FVG mode — every fresh major FVG of the displacement leg is a valid footprint. Grade
    // each and keep the SHALLOWEST survivor: the zone price retraces into most often, so the
    // highest fill-rate that still clears the quality bar.
    let best = null;
    for (const x of fvgs) {
      if (x.type !== (long ? 'bull' : 'bear') || x.i <= strongIdx || x.i > bosIdx) continue;
      if ((x.top - x.bottom) < p.fvgMult * a[x.i]) continue;
      let fresh = true;
      for (let j = x.i + 2; j <= bosIdx; j++) if (c[j].low <= x.top && c[j].high >= x.bottom) { fresh = false; break; }
      if (!fresh) continue;
      const g = grade(x.bottom, x.top, x.i);
      if (g && (!best || (long ? g.entry > best.entry : g.entry < best.entry))) best = g;
    }
    return best;
  }

  // ---- the state machine ---------------------------------------------------
  // htfBias: optional per-candle 'bull'/'bear' array — only take with-bias trades.
  // biasOnly: skip liquidity/trade work (used when we just need this timeframe's trend series).
  function walkStructure(c, extPiv, fvgs, p, a, htfBias, biasOnly, poolsIn) {
    const n = c.length;
    const highs = extPiv.filter((x) => x.kind === 'H');
    const lows = extPiv.filter((x) => x.kind === 'L');
    const legs = [], events = [], trades = [], trendAt = new Array(n).fill('bull');
    if (lows.length < 1 || highs.length < 1) return { legs, events, trades, trendAt, trend: null };

    const pools = poolsIn || (biasOnly ? [] : detectLiquidity(c, extPiv, a, p.eqTol));

    // last confirmed swing high/low strictly before candle i (pointer walk)
    let hp = 0, lp = 0;
    const lastHigh = (i) => { while (hp < highs.length && highs[hp].i < i) hp++; return hp > 0 ? highs[hp - 1] : null; };
    const lastLow = (i) => { while (lp < lows.length && lows[lp].i < i) lp++; return lp > 0 ? lows[lp - 1] : null; };

    // init: bull from the first major low ("start marking from that major low")
    let trend = 'bull';
    let strong = { i: lows[0].i, price: lows[0].price };          // Strong Low (bull) / Strong High (bear)
    let refHigh = highs.find((h) => h.i > strong.i) || null;      // high to close above for BOS↑
    let refLow = null;                                            // low to close below for BOS↓
    let ssIdx = refHigh ? refHigh.i : strong.i;                   // SuperSaiyyan extreme index
    let ssPrice = refHigh ? refHigh.price : c[strong.i].high;     // SS high (bull) / SS low (bear)
    let segStart = strong.i, busyUntil = -1;                       // one position at a time
    let pending = null;                                            // the resting limit order (see armOrder)
    const majorLowIdx = strong.i;

    const fill = (t, i) => {
      const sim = simTrade(c, i, t.dir, t.stop, t.target);
      trades.push({ dir: t.dir, poiIdx: t.fvgIdx, fvgIdx: t.fvgIdx, zoneLow: t.zoneLow, zoneTop: t.zoneTop,
        sweepIdx: t.sweepIdx, targetPool: t.targetPool, entry: t.entry, stop: t.stop, target: t.target,
        entryIdx: i, exitIdx: sim.exitIdx, outcome: sim.outcome,
        rr: +(Math.abs(t.target - t.entry) / Math.abs(t.entry - t.stop)).toFixed(2) });
      busyUntil = sim.exitIdx;
    };

    // nearest unswept opposite pool paying ≥ minRR (shared by soup & momo entries)
    const pickPoolTarget = (long, entry, risk, i) => {
      const cands = pools
        .filter((x) => (!x.liq || p.liqTargets) && x.side === (long ? 'BSL' : 'SSL') && (x.sweptIdx === -1 || x.sweptIdx > i) && (long ? x.price > entry : x.price < entry))
        .sort((u, v) => (long ? u.price - v.price : v.price - u.price));
      for (const x of cands) { const rr = (long ? x.price - entry : entry - x.price) / risk; if (rr >= p.minRR) return x.price; }
      return null;
    };
    // MOMO: market entry at the structure-breaking close, stop beyond the move's origin
    const momoEntry = (long, i, stopBase) => {
      if (i <= busyUntil) return;
      if (htfBias && htfBias[i] !== (long ? 'bull' : 'bear')) return;   // HTF context must agree
      const entry = c[i].close;
      const stop = long ? stopBase - 0.1 * a[i] : stopBase + 0.1 * a[i];
      const risk = long ? entry - stop : stop - entry;
      if (risk <= 0) return;
      const target = pickPoolTarget(long, entry, risk, i);
      if (target == null) return;
      const sim = simTrade(c, i + 1, long ? 'long' : 'short', stop, target);
      trades.push({ dir: long ? 'long' : 'short', poiIdx: i, fvgIdx: -1,
        zoneLow: long ? stopBase : entry, zoneTop: long ? entry : stopBase,
        sweepIdx: -1, targetPool: long ? 'BSL' : 'SSL', entry, stop, target,
        entryIdx: i, exitIdx: sim.exitIdx, outcome: sim.outcome,
        rr: +(Math.abs(target - entry) / risk).toFixed(2) });
      busyUntil = sim.exitIdx;
    };
    const zoneStrat = p.strategy === 'fvg' || p.strategy === 'scalp';  // retrace-zone strategies use pendings
    let pos = null;                                                    // regime strategy: the open position

    for (let i = strong.i + 1; i < n; i++) {
      const lh = lastHigh(i), ll = lastLow(i);

      // REGIME (trend hold): fully invested while structure AND the HTF context are bullish,
      // fully out otherwise. Entry/exit at the close of the candle that changes the answer.
      // (Uses the previous candle's trend state — no lookahead into this candle's flip.)
      if (p.strategy === 'regime' && !biasOnly) {
        const biasOK = !htfBias || htfBias[i] === 'bull';
        const exitNow = p.regimeExit === 'weekly' && htfBias ? !biasOK : (trend !== 'bull' || !biasOK);
        if (!pos && trend === 'bull' && biasOK) {
          pos = { entry: c[i].close, stop: strong.price - 0.1 * a[strong.i], entryIdx: i };
        } else if (pos && exitNow) {
          const exit = c[i].close, risk0 = pos.entry - pos.stop;
          const rMult = risk0 > 0 ? (exit - pos.entry) / risk0 : 0;
          trades.push({ dir: 'long', poiIdx: pos.entryIdx, fvgIdx: -1, zoneLow: pos.stop, zoneTop: pos.entry,
            sweepIdx: -1, targetPool: 'TRAIL', entry: pos.entry, stop: pos.stop, target: exit, exitPrice: exit,
            entryIdx: pos.entryIdx, exitIdx: i, outcome: rMult >= 0 ? 'win' : 'loss',
            rr: +rMult.toFixed(2), rMult: +rMult.toFixed(4) });
          pos = null;
        }
      }


      if (trend === 'bull') {
        if (c[i].high > ssPrice) { ssPrice = c[i].high; ssIdx = i; }
        if (lh && lh.i > strong.i && (!refHigh || lh.i > refHigh.i)) refHigh = lh;

        // resting long taps: FIRST touch fills (or burns the zone if we can't take it)
        if (pending && pending.dir === 'long') {
          if (c[i].low <= pending.entry) {
            const t = pending; pending = null;
            if (i > busyUntil) fill(t, i);
          } else if (i > pending.expiry) pending = null;           // stale — orders likely pulled
        }

        if (c[i].close < strong.price) {                         // CHoCH↓ → flip bearish
          legs.push({ trend: 'bull', startIdx: segStart, endIdx: i, strongIdx: strong.i, strongPrice: strong.price, ssIdx, ssPrice });
          events.push({ i, type: 'CHoCH↓', price: strong.price, note: 'close below Strong Low → BEARISH' });
          // the SS high was the manipulation (BSL sweep); this down-leg is the displacement.
          // Top-down: HTF must agree at setup time, else no order for this leg.
          pending = (!zoneStrat || biasOnly || p.longOnly || (htfBias && htfBias[i] !== 'bear')) ? null
            : armOrder(c, 'short', i, ssPrice, ssIdx, c[i].low, pools, fvgs, p, a);
          if (p.strategy === 'momo' && !biasOnly && !p.momoBosOnly && !p.longOnly) momoEntry(false, i, ssPrice);   // reversal momentum, stop above the SS high
          trend = 'bear'; strong = { i: ssIdx, price: ssPrice };  // SS high becomes the Strong High
          segStart = ssIdx; ssPrice = c[i].low; ssIdx = i; refLow = ll || null; refHigh = null;
          continue;
        }
        if (refHigh && c[i].close > refHigh.price) {             // BOS↑ → trail the Strong Low
          const newSL = (ll && ll.i > strong.i) ? { i: ll.i, price: ll.price } : strong;
          legs.push({ trend: 'bull', startIdx: segStart, endIdx: i, strongIdx: strong.i, strongPrice: strong.price, ssIdx, ssPrice });
          events.push({ i, type: 'BOS↑', price: refHigh.price, note: 'close above high → Strong Low shifts up' });
          if (zoneStrat && !biasOnly && (!htfBias || htfBias[i] === 'bull')) {
            const armed = armOrder(c, 'long', i, strong.price, strong.i, ssPrice, pools, fvgs, p, a);
            if (armed) pending = armed;                          // fresh setup replaces the old order
          }
          if (p.strategy === 'momo' && !biasOnly) momoEntry(true, i, newSL.price); // continuation, stop below the trailing low
          strong = newSL; segStart = i; ssPrice = c[i].high; ssIdx = i; refHigh = null;
        }
      } else {                                                    // ---- BEARISH (mirror) ----
        if (c[i].low < ssPrice) { ssPrice = c[i].low; ssIdx = i; }
        if (ll && ll.i > strong.i && (!refLow || ll.i > refLow.i)) refLow = ll;

        if (pending && pending.dir === 'short') {
          if (c[i].high >= pending.entry) {
            const t = pending; pending = null;
            if (i > busyUntil) fill(t, i);
          } else if (i > pending.expiry) pending = null;
        }

        if (c[i].close > strong.price) {                         // CHoCH↑ → flip bullish
          legs.push({ trend: 'bear', startIdx: segStart, endIdx: i, strongIdx: strong.i, strongPrice: strong.price, ssIdx, ssPrice });
          events.push({ i, type: 'CHoCH↑', price: strong.price, note: 'close above Strong High → BULLISH' });
          // the SS low was the manipulation (SSL sweep); this up-leg is the displacement
          pending = (!zoneStrat || biasOnly || (htfBias && htfBias[i] !== 'bull')) ? null
            : armOrder(c, 'long', i, ssPrice, ssIdx, c[i].high, pools, fvgs, p, a);
          if (p.strategy === 'momo' && !biasOnly && !p.momoBosOnly) momoEntry(true, i, ssPrice);   // reversal momentum, stop below the SS low
          trend = 'bull'; strong = { i: ssIdx, price: ssPrice };  // SS low becomes the new Strong Low
          segStart = ssIdx; ssPrice = c[i].high; ssIdx = i; refHigh = lh || null; refLow = null;
          continue;
        }
        if (refLow && c[i].close < refLow.price) {               // BOS↓ → trail the Strong High
          const newSH = (lh && lh.i > strong.i) ? { i: lh.i, price: lh.price } : strong;
          legs.push({ trend: 'bear', startIdx: segStart, endIdx: i, strongIdx: strong.i, strongPrice: strong.price, ssIdx, ssPrice });
          events.push({ i, type: 'BOS↓', price: refLow.price, note: 'close below low → Strong High shifts down' });
          if (zoneStrat && !biasOnly && !p.longOnly && (!htfBias || htfBias[i] === 'bear')) {
            const armed = armOrder(c, 'short', i, strong.price, strong.i, ssPrice, pools, fvgs, p, a);
            if (armed) pending = armed;
          }
          if (p.strategy === 'momo' && !biasOnly && !p.longOnly) momoEntry(false, i, newSH.price); // continuation, stop above the trailing high
          strong = newSH; segStart = i; ssPrice = c[i].low; ssIdx = i; refLow = null;
        }
      }
    }
    if (pos) {                                                       // regime position still on at end of data
      const last = c[n - 1].close, risk0 = pos.entry - pos.stop;
      trades.push({ dir: 'long', poiIdx: pos.entryIdx, fvgIdx: -1, zoneLow: pos.stop, zoneTop: pos.entry,
        sweepIdx: -1, targetPool: 'TRAIL', entry: pos.entry, stop: pos.stop, target: last, exitPrice: last,
        entryIdx: pos.entryIdx, exitIdx: n - 1, outcome: 'open',
        rr: +(risk0 > 0 ? (last - pos.entry) / risk0 : 0).toFixed(2) });
    }
    legs.push({ trend, startIdx: segStart, endIdx: n - 1, strongIdx: strong.i, strongPrice: strong.price, ssIdx, ssPrice });
    // per-candle trend series (as-of that candle's flip), for HTF confluence use
    const flipEv = events.filter((e) => e.type.indexOf('CHoCH') === 0);
    let cur = 'bull', ei = 0;
    for (let i = 0; i < n; i++) { while (ei < flipEv.length && flipEv[ei].i <= i) { cur = flipEv[ei].type === 'CHoCH↑' ? 'bull' : 'bear'; ei++; } trendAt[i] = cur; }
    return { legs, events, trades, trendAt, trend, strong, ssIdx, ssPrice, majorLowIdx };
  }

  // ---- higher-timeframe confluence -----------------------------------------
  // Aggregate the base candles into HTF candles (group every `mult`), run the same trend
  // machine on them, and expand the HTF trend back to a per-base-candle bias — using only
  // the LAST CLOSED HTF candle for each base candle (no lookahead).
  function aggregateHTF(c, mult) {
    const out = [];
    for (let i = 0; i < c.length; i += mult) {
      let hi = -Infinity, lo = Infinity;
      const end = Math.min(c.length, i + mult);
      for (let j = i; j < end; j++) { if (c[j].high > hi) hi = c[j].high; if (c[j].low < lo) lo = c[j].low; }
      out.push({ time: c[i].time, open: c[i].open, close: c[end - 1].close, high: hi, low: lo });
    }
    return out;
  }
  function computeHtfBias(c, p) {
    const mult = Math.max(1, Math.round(p.htfMult || 1));
    if (mult <= 1) return null;
    const hc = aggregateHTF(c, mult);
    if (hc.length < 6) return null;
    const ha = atr(hc, p.atrLen);
    const hExt = labelStructure(detectPivots(hc, p.htfExtMult > 0 ? p.htfExtMult : p.extMult, ha));
    const hw = walkStructure(hc, hExt, detectFVG(hc), p, ha, null, true);   // biasOnly
    if (!hw.trendAt) return null;
    const bias = new Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) {
      const k = Math.floor(i / mult) - 1;                                    // last CLOSED HTF bar
      bias[i] = (k >= 0 && k < hw.trendAt.length) ? hw.trendAt[k] : null;
    }
    return bias;
  }

  // ---- main -----------------------------------------------------------------
  function detectAll(candles, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    if (params && params.largeMult != null && params.intMult == null) p.intMult = params.largeMult;
    // SCALPER = the fvg playbook on finer structure: 3×ATR swings unless the user tuned ext
    if (p.strategy === 'scalp' && (!params || params.extMult == null || +params.extMult === DEFAULTS.extMult)) p.extMult = 3.0;
    // REGIME reads its HTF context at 2×ATR (faster flips) unless the user tuned it
    if (p.strategy === 'regime' && (!params || !params.htfExtMult)) p.htfExtMult = 2.0;
    if (p.extMult <= p.intMult) p.extMult = p.intMult * 2.5;
    const c = candles, a = atr(c, p.atrLen);

    const intPiv = detectPivots(c, p.intMult, a);
    const extPiv = labelStructure(detectPivots(c, p.extMult, a));
    const fvgs = detectFVG(c);
    const unmitigated = detectUnmitigated(c, p);
    const htfBias = computeHtfBias(c, p);
    const pools = detectLiquidity(c, extPiv, a, p.eqTol);
    if (p.useLiq) pools.push.apply(pools, detectLiqClusters(c, intPiv, a, p));
    const ws = walkStructure(c, extPiv, fvgs, p, a, htfBias, false, pools);

    // quant strategies replace the SMC trade stream; structure/pools remain as chart context
    const quant = ['cycle', 'tsmom', 'donch', 'liqbrk'].indexOf(p.strategy) >= 0;
    const rq = quant ? runQuant(c, p, a, pools) : null;
    const trades = quant ? rq.trades : ws.trades;
    const longs = trades.filter((t) => t.dir === 'long'), shorts = trades.filter((t) => t.dir === 'short');
    const wins = trades.filter((t) => t.outcome === 'win').length;
    const losses = trades.filter((t) => t.outcome === 'loss').length;
    // quant stats over closed trades, in R units (win = +rr, loss = −1)
    const rs = trades.filter((t) => t.outcome !== 'open').sort((x, y) => x.entryIdx - y.entryIdx)
      .map((t) => (t.rMult != null ? t.rMult : (t.outcome === 'win' ? (t.rr || 0) : -1)));
    const expectancy = rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : 0;
    const stdR = rs.length > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - expectancy) * (x - expectancy), 0) / (rs.length - 1)) : 0;
    let streak = 0, maxLossStreak = 0;
    for (const x of rs) { streak = x < 0 ? streak + 1 : 0; if (streak > maxLossStreak) maxLossStreak = streak; }
    const summary = {
      trades: trades.length, longs: longs.length, shorts: shorts.length,
      wins, losses, open: trades.filter((t) => t.outcome === 'open').length,
      flips: ws.events.filter((e) => e.type.indexOf('CHoCH') === 0).length,
      winRate: (wins + losses) ? wins / (wins + losses) : 0,
      expectancy, stdR, sqn: stdR > 0 ? (expectancy / stdR) * Math.sqrt(rs.length) : 0, maxLossStreak,
    };

    return { params: p, atr: a, intPivots: intPiv, extPivots: extPiv, fvgs, unmitigated, htfBias, pools,
      legs: ws.legs, events: ws.events, trades, trend: ws.trend, strong: ws.strong,
      ssIdx: ws.ssIdx, ssPrice: ws.ssPrice, majorLowIdx: ws.majorLowIdx, summary,
      advice: quant ? rq.advice : null, cycleLines: quant ? rq.cycleLines : null };
  }

  const api = { detectAll, detectPivots, labelStructure, detectFVG, detectUnmitigated, detectLiquidity, detectLiqClusters, armOrder, pickTarget, simTrade, runQuant, walkStructure, aggregateHTF, computeHtfBias, atr, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SMC = api;
})(typeof window !== 'undefined' ? window : globalThis);
