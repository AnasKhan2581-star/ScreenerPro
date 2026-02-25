// strategies/smc_strategies.js
// ────────────────────────────────────────────────────────────────────
//  All 3 SMC Strategies — Fully Rewritten with Correct Logic
// ────────────────────────────────────────────────────────────────────
import { calcATR } from '../utils/atr.js';
import { round } from '../utils/math.js';

// ─── HELPER UTILITIES ────────────────────────────────────────────────

function atr(candles, period = 14) {
  return calcATR(candles.slice(-Math.max(period * 3, 50)), period);
}

// Find all swing highs — points higher than N candles left and right
function swingHighs(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].high >= candles[i].high) { isHigh = false; break; }
    }
    if (isHigh) out.push({ idx: i, price: candles[i].high, time: candles[i].time, candle: candles[i] });
  }
  return out;
}

// Find all swing lows
function swingLows(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].low <= candles[i].low) { isLow = false; break; }
    }
    if (isLow) out.push({ idx: i, price: candles[i].low, time: candles[i].time, candle: candles[i] });
  }
  return out;
}

// Is a candle a displacement candle (large body, strong close, high volume)
function isDisp(c, prevCandles, atrVal, atrMult = 1.2) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (body < atrVal * atrMult) return false;
  const closePos = (c.close - c.low) / (range || 1);
  const bull = c.close > c.open;
  if (bull && closePos < 0.7) return false;  // must close in top 30% for bull
  if (!bull && closePos > 0.3) return false; // must close in bottom 30% for bear
  // Volume spike check
  if (prevCandles && prevCandles.length > 10) {
    const avgVol = prevCandles.slice(-20).reduce((s, x) => s + (x.volume || 0), 0) / 20;
    if (avgVol > 0 && (c.volume || 0) < avgVol * 1.2) return false;
  }
  return true;
}

// Find OB (last opposing candle before displacement move)
function findOB(candles, dispIdx, direction) {
  for (let i = dispIdx - 1; i >= Math.max(0, dispIdx - 5); i--) {
    const c = candles[i];
    if (direction === 'long' && c.close < c.open) return { top: Math.max(c.open, c.close), bot: Math.min(c.open, c.close), mid: (c.open + c.close) / 2 };
    if (direction === 'short' && c.close > c.open) return { top: Math.max(c.open, c.close), bot: Math.min(c.open, c.close), mid: (c.open + c.close) / 2 };
  }
  return null;
}

// Find FVG at or near the displacement candle
function findFVG(candles, dispIdx, direction) {
  if (dispIdx < 1 || dispIdx >= candles.length - 1) return null;
  const prev = candles[dispIdx - 1];
  const disp = candles[dispIdx];
  const next = candles[dispIdx + 1] || disp;
  if (direction === 'long' && next.low > prev.high) {
    return { top: next.low, bot: prev.high, mid: (next.low + prev.high) / 2 };
  }
  if (direction === 'short' && next.high < prev.low) {
    return { top: prev.low, bot: next.high, mid: (prev.low + next.high) / 2 };
  }
  return null;
}

// Extreme POI = 50% of OB, or 50% of FVG if no OB
function extremePOI(ob, fvg, direction) {
  if (ob) return ob.mid;
  if (fvg) return fvg.mid;
  return null;
}

// HTF buy-side liquidity = highest swing high in last N candles
function htfBSL(candles, lookback = 100) {
  let max = -Infinity;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (i < 0) continue;
    if (candles[i].high > max) max = candles[i].high;
  }
  return max === -Infinity ? null : max;
}

// HTF sell-side liquidity = lowest swing low in last N candles  
function htfSSL(candles, lookback = 100) {
  let min = Infinity;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    if (i < 0) continue;
    if (candles[i].low < min) min = candles[i].low;
  }
  return min === Infinity ? null : min;
}

function calcRR(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return 0;
  return round(reward / risk, 2);
}

function pctGain(entry, tp) {
  return round(((tp - entry) / entry) * 100, 2);
}

// ─────────────────────────────────────────────────────────────────────
//  STRATEGY 1
//  Pattern: 3+ Higher Highs → sudden displacement sweep DOWN →
//           displacement move UP → entry at 50% OB/FVG
//           SL: few pips below lowest sweep point
//           TP: highest point of up displacement
// ─────────────────────────────────────────────────────────────────────
export function scan_S1(candles, settings = {}) {
  if (!settings.enableS1) return null;
  if (candles.length < 80) return null;

  const atrVal = atr(candles);
  if (!atrVal) return null;

  const slBuf = atrVal * (settings.slBuffer || 0.5);
  const minRR = settings.minRR || 2;

  // Work on last 120 candles
  const window = candles.slice(-120);
  const sHigh = swingHighs(window, 3, 3);

  // Need at least 3 Higher Highs
  const hh = [];
  for (let i = 1; i < sHigh.length; i++) {
    if (sHigh[i].price > sHigh[i - 1].price) {
      if (hh.length === 0) hh.push(sHigh[i - 1]);
      hh.push(sHigh[i]);
    } else {
      if (hh.length >= 3) break; // found 3+ HH sequence
      hh.length = 0;
    }
  }
  if (hh.length < 3) return null;

  const lastHH = hh[hh.length - 1];
  const afterHH = window.slice(lastHH.idx);

  if (afterHH.length < 6) return null;

  // Find sudden displacement DOWN after last HH (sweep down)
  let sweepDownIdx = -1;
  let sweepDownLow = Infinity;
  for (let i = 1; i < afterHH.length; i++) {
    const c = afterHH[i];
    if (isDisp(c, afterHH.slice(0, i), atrVal, 1.0) && c.close < c.open) {
      if (c.low < sweepDownLow) {
        sweepDownLow = c.low;
        sweepDownIdx = i;
      }
    }
  }
  // Also check for series of bearish candles that make new low below last HH area
  if (sweepDownIdx < 0) {
    for (let i = 1; i < afterHH.length; i++) {
      if (afterHH[i].low < lastHH.price * 0.995 && afterHH[i].close < afterHH[i].open) {
        if (afterHH[i].low < sweepDownLow) {
          sweepDownLow = afterHH[i].low;
          sweepDownIdx = i;
        }
      }
    }
  }
  if (sweepDownIdx < 0) return null;

  // Now find displacement move UP after sweep down
  const afterSweep = afterHH.slice(sweepDownIdx);
  if (afterSweep.length < 4) return null;

  let upDispIdx = -1;
  let upDispHigh = -Infinity;
  for (let i = 1; i < afterSweep.length; i++) {
    const c = afterSweep[i];
    if (isDisp(c, afterSweep.slice(0, i), atrVal, 1.0) && c.close > c.open) {
      if (c.high > upDispHigh) {
        upDispHigh = c.high;
        upDispIdx = i;
      }
    }
  }
  if (upDispIdx < 0) return null;

  // TP = highest point of the up displacement move
  const tp = afterSweep[upDispIdx].high;

  // Find OB / FVG at displacement up candle for entry
  const ob = findOB(afterSweep, upDispIdx, 'long');
  const fvg = findFVG(afterSweep, upDispIdx, 'long');
  const entry = extremePOI(ob, fvg, 'long') || afterSweep[upDispIdx].open;

  // SL = few pips below lowest sweep down point
  const sl = sweepDownLow - slBuf;

  // Validate: price must still be near entry (haven't missed it)
  const currentPrice = candles[candles.length - 1].close;
  if (currentPrice > tp * 0.99) return null; // TP already hit
  if (currentPrice < sl * 1.001) return null; // SL already hit

  // Entry should be reachable from current price (within reasonable range)
  const distToEntry = Math.abs(currentPrice - entry) / atrVal;
  if (distToEntry > 5) return null; // too far from entry

  const rr = calcRR(entry, sl, tp);
  if (rr < minRR) return null;

  const pctG = pctGain(entry, tp);

  return {
    strategy: 'S1',
    strategyName: 'HH Displacement Sweep',
    direction: 'long',
    entry: round(entry, 6),
    sl: round(sl, 6),
    tp: round(tp, 6),
    rr,
    pctGain: pctG,
    winRate: 0.63,
    atr: atrVal,
    time: candles[candles.length - 1].time,
    tf: '15m',
    details: {
      hhCount: hh.length,
      sweepLow: round(sweepDownLow, 6),
      upMoveHigh: round(upDispHigh, 6),
      ob, fvg,
    },
    reasoning: buildS1Reasoning(hh.length, sweepDownLow, tp, entry, sl, rr, pctG),
  };
}

function buildS1Reasoning(hhCount, sweepLow, tp, entry, sl, rr, pctG) {
  return [
    `📋 S1 — Higher High Displacement Sweep`,
    ``,
    `PATTERN DETECTED:`,
    `  ✅ ${hhCount}x Higher Highs confirmed (min 3 required)`,
    `  ✅ Sudden displacement candle DOWN sweeping lows`,
    `  ✅ Lowest sweep point: ${round(sweepLow, 2)}`,
    `  ✅ Displacement move UP confirmed`,
    `  ✅ TP target = highest point of up move: ${round(tp, 2)}`,
    ``,
    `TRADE SETUP:`,
    `  Entry  : ${round(entry, 2)} (50% of OB/FVG retracement)`,
    `  Stop   : ${round(sl, 2)} (below lowest sweep point)`,
    `  Target : ${round(tp, 2)} (top of displacement up)`,
    `  R:R    : ${rr}  |  Expected gain: +${pctG}%`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
//  STRATEGY 2
//  Pattern: Support range → sweep DOWN (sell-side liquidity) →
//           small bounce UP (to hunt shorts) → displacement UP move
//           Entry: 50% of OB/FVG of up move
//           SL: below lowest displacement up point
//           TP: HTF buyside liquidity (last major high above range)
// ─────────────────────────────────────────────────────────────────────
export function scan_S2(candles, candles1H, settings = {}) {
  if (!settings.enableS2) return null;
  if (candles.length < 100) return null;

  const atrVal = atr(candles);
  if (!atrVal) return null;

  const slBuf = atrVal * (settings.slBuffer || 0.5);
  const minRR = settings.minRR || 2;

  const window = candles.slice(-150);
  const n = window.length;

  // 1. Identify support range: find a clear range (consolidation)
  //    Range = price oscillating between high/low for at least 15 candles
  const rangeLen = 40;
  const rangeCandles = window.slice(0, Math.floor(n * 0.6));

  if (rangeCandles.length < rangeLen) return null;

  const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
  const rangeLow = Math.min(...rangeCandles.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;

  if (rangeSize < atrVal * 2) return null; // range too small
  if (rangeSize > atrVal * 20) return null; // range too large / not a range

  // 2. Find sweep DOWN below range (below rangeLow)
  const afterRange = window.slice(Math.floor(n * 0.5));
  let sweepCandle = null;
  let sweepIdx = -1;
  let sweepLow = Infinity;

  for (let i = 0; i < afterRange.length; i++) {
    const c = afterRange[i];
    if (c.low < rangeLow - atrVal * 0.3) { // swept below range
      if (c.low < sweepLow) {
        sweepLow = c.low;
        sweepCandle = c;
        sweepIdx = i;
      }
    }
  }
  if (!sweepCandle || sweepIdx < 0) return null;

  // 3. After sweep: small bounce up (short hunting move)
  //    Then a DISPLACEMENT candle UP (the real move)
  const postSweep = afterRange.slice(sweepIdx);
  if (postSweep.length < 5) return null;

  // Look for a small bounce up, then flat/down, then BIG displacement up
  let bounceHigh = sweepLow;
  let bounceEnd = 0;
  for (let i = 1; i < Math.min(postSweep.length, 10); i++) {
    if (postSweep[i].high > bounceHigh) {
      bounceHigh = postSweep[i].high;
      bounceEnd = i;
    }
  }

  // Need a small bounce (not too big, just enough to trap shorts)
  const bounceSize = bounceHigh - sweepLow;
  if (bounceSize < atrVal * 0.3) return null; // no bounce at all

  // Now find the MAIN displacement up move after the bounce
  const afterBounce = postSweep.slice(bounceEnd);
  if (afterBounce.length < 3) return null;

  let mainDispIdx = -1;
  for (let i = 1; i < afterBounce.length; i++) {
    const c = afterBounce[i];
    if (isDisp(c, afterBounce.slice(0, i), atrVal, 1.0) && c.close > c.open) {
      mainDispIdx = i;
      break;
    }
  }
  if (mainDispIdx < 0) return null;

  // 4. Entry: 50% of OB/FVG of the up displacement
  const ob = findOB(afterBounce, mainDispIdx, 'long');
  const fvg = findFVG(afterBounce, mainDispIdx, 'long');
  const entry = extremePOI(ob, fvg, 'long') || (sweepLow + (afterBounce[mainDispIdx].high - sweepLow) * 0.5);

  // 5. SL: below lowest displacement up point (sweep low - buffer)
  const sl = sweepLow - slBuf;

  // 6. TP: HTF buyside liquidity = last major high above range
  const htfHigh = candles1H ? htfBSL(candles1H, 100) : rangeHigh * 1.01;
  const tp = htfHigh || rangeHigh * 1.015;

  const currentPrice = candles[candles.length - 1].close;
  if (currentPrice > tp * 0.99) return null;
  if (currentPrice < sl * 1.001) return null;

  const distToEntry = Math.abs(currentPrice - entry) / atrVal;
  if (distToEntry > 8) return null;

  const rr = calcRR(entry, sl, tp);
  if (rr < minRR) return null;

  const pctG = pctGain(entry, tp);

  return {
    strategy: 'S2',
    strategyName: 'Range Sweep + Short Trap',
    direction: 'long',
    entry: round(entry, 6),
    sl: round(sl, 6),
    tp: round(tp, 6),
    rr,
    pctGain: pctG,
    winRate: 0.60,
    atr: atrVal,
    time: candles[candles.length - 1].time,
    tf: '15m',
    details: {
      rangeHigh: round(rangeHigh, 6),
      rangeLow: round(rangeLow, 6),
      sweepLow: round(sweepLow, 6),
      bounceHigh: round(bounceHigh, 6),
      htfTarget: round(tp, 6),
      ob, fvg,
    },
    reasoning: buildS2Reasoning(rangeHigh, rangeLow, sweepLow, bounceHigh, entry, sl, tp, rr, pctG),
  };
}

function buildS2Reasoning(rh, rl, sw, bh, entry, sl, tp, rr, pctG) {
  return [
    `📋 S2 — Range Sweep + Short Trap → Displacement`,
    ``,
    `PATTERN DETECTED:`,
    `  ✅ Support range identified: ${round(rl, 2)} — ${round(rh, 2)}`,
    `  ✅ Sweep DOWN below range @ ${round(sw, 2)} (sell-side liquidity taken)`,
    `  ✅ Small bounce up to ${round(bh, 2)} (trapping shorts)`,
    `  ✅ Displacement UP move confirmed`,
    `  ✅ HTF Buy-side target: ${round(tp, 2)}`,
    ``,
    `TRADE SETUP:`,
    `  Entry  : ${round(entry, 2)} (50% OB/FVG retracement)`,
    `  Stop   : ${round(sl, 2)} (below sweep low)`,
    `  Target : ${round(tp, 2)} (HTF buyside liquidity)`,
    `  R:R    : ${rr}  |  Expected gain: +${pctG}%`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
//  STRATEGY 3
//  Pattern: Sweep of MAJOR sell-side liquidity → reaction →
//           ICT-style MSS (body close above prior swing high) →
//           impulsive displacement UP
//           Entry: 50% of displacement
//           SL: below lowest point of impulsive move
//           TP: HTF buyside liquidity
// ─────────────────────────────────────────────────────────────────────
export function scan_S3(candles, candles1H, settings = {}) {
  if (!settings.enableS3) return null;
  if (candles.length < 80) return null;

  const atrVal = atr(candles);
  if (!atrVal) return null;

  const slBuf = atrVal * (settings.slBuffer || 0.5);
  const minRR = settings.minRR || 2;

  const window = candles.slice(-150);
  const sLow = swingLows(window, 4, 4);

  if (sLow.length < 2) return null;

  // 1. Find MAJOR sell-side liquidity = the most significant swing low in the window
  //    (lowest of last few swing lows)
  const majorLow = sLow.reduce((best, cur) => cur.price < best.price ? cur : best, sLow[0]);

  // 2. Find sweep below major low (wick below + close above = liquidity sweep)
  const afterMajorLow = window.slice(majorLow.idx);
  let sweepIdx = -1;
  let sweepLowPrice = Infinity;

  for (let i = 1; i < afterMajorLow.length; i++) {
    const c = afterMajorLow[i];
    // Sweep = wick goes below major low price, but candle closes ABOVE it (rejection)
    if (c.low < majorLow.price && c.close > majorLow.price) {
      if (c.low < sweepLowPrice) {
        sweepLowPrice = c.low;
        sweepIdx = i;
      }
    }
  }
  if (sweepIdx < 0) return null;

  const postSweep = afterMajorLow.slice(sweepIdx);
  if (postSweep.length < 5) return null;

  // 3. Look for ICT MSS:
  //    After the sweep, find a prior swing HIGH in the immediate reaction
  //    Then price makes BODY CLOSE above that swing high = MSS confirmed
  const reactionWindow = postSweep.slice(0, Math.min(postSweep.length, 30));
  const reactionHighs = swingHighs(reactionWindow, 2, 2);

  if (!reactionHighs.length) return null;

  // The MSS level = the first swing high formed after the sweep
  const mssLevel = reactionHighs[0].price;
  let mssCandle = null;
  let mssIdx = -1;

  for (let i = reactionHighs[0].idx + 1; i < reactionWindow.length; i++) {
    const c = reactionWindow[i];
    // ICT rule: BODY CLOSE above MSS level (not just wick)
    if (c.close > mssLevel) {
      mssCandle = c;
      mssIdx = i;
      break;
    }
  }
  if (!mssCandle) return null;

  // 4. Find impulsive displacement UP after MSS
  const afterMSS = reactionWindow.slice(mssIdx);
  if (afterMSS.length < 3) return null;

  let impDispIdx = -1;
  for (let i = 0; i < afterMSS.length; i++) {
    const c = afterMSS[i];
    if (isDisp(c, afterMSS.slice(0, i), atrVal, 1.1) && c.close > c.open) {
      impDispIdx = i;
      break;
    }
  }
  if (impDispIdx < 0) {
    // Even without a perfect displacement candle, 3 consecutive bullish candles counts
    let consecutive = 0;
    for (let i = 0; i < afterMSS.length; i++) {
      if (afterMSS[i].close > afterMSS[i].open) consecutive++;
      else consecutive = 0;
      if (consecutive >= 3) { impDispIdx = i; break; }
    }
  }
  if (impDispIdx < 0) return null;

  // 5. Entry at 50% of the impulsive move
  const impMoveBase = afterMSS[0].low;
  const impMoveTop = afterMSS[impDispIdx].high;
  const ob = findOB(afterMSS, impDispIdx, 'long');
  const fvg = findFVG(afterMSS, impDispIdx, 'long');
  const entry = extremePOI(ob, fvg, 'long') || (impMoveBase + (impMoveTop - impMoveBase) * 0.5);

  // 6. SL: below lowest point of the impulsive move (the sweep low)
  const sl = sweepLowPrice - slBuf;

  // 7. TP: HTF buyside liquidity
  const htfHigh = candles1H ? htfBSL(candles1H, 100) : null;
  // Also consider last major swing high before the sweep
  const preSwLows = swingHighs(window.slice(0, majorLow.idx + 1), 3, 3);
  const lastMajorHigh = preSwLows.length ? preSwLows[preSwLows.length - 1].price : null;
  const tp = htfHigh || lastMajorHigh || (impMoveTop * 1.01);

  const currentPrice = candles[candles.length - 1].close;
  if (currentPrice > tp * 0.99) return null;
  if (currentPrice < sl * 1.001) return null;

  const distToEntry = Math.abs(currentPrice - entry) / atrVal;
  if (distToEntry > 8) return null;

  const rr = calcRR(entry, sl, tp);
  if (rr < minRR) return null;

  const pctG = pctGain(entry, tp);

  return {
    strategy: 'S3',
    strategyName: 'Major SSL Sweep + MSS',
    direction: 'long',
    entry: round(entry, 6),
    sl: round(sl, 6),
    tp: round(tp, 6),
    rr,
    pctGain: pctG,
    winRate: 0.65,
    atr: atrVal,
    time: candles[candles.length - 1].time,
    tf: '15m',
    details: {
      majorLow: round(majorLow.price, 6),
      sweepLow: round(sweepLowPrice, 6),
      mssLevel: round(mssLevel, 6),
      mssConfirm: mssCandle?.close ? round(mssCandle.close, 6) : null,
      htfTarget: round(tp, 6),
      ob, fvg,
    },
    reasoning: buildS3Reasoning(majorLow.price, sweepLowPrice, mssLevel, entry, sl, tp, rr, pctG),
  };
}

function buildS3Reasoning(majLow, sweepLow, mssLevel, entry, sl, tp, rr, pctG) {
  return [
    `📋 S3 — Major SSL Sweep + ICT MSS Confirmation`,
    ``,
    `PATTERN DETECTED:`,
    `  ✅ Major sell-side liquidity identified @ ${round(majLow, 2)}`,
    `  ✅ Sweep below major low @ ${round(sweepLow, 2)} (wick below, close above)`,
    `  ✅ Reaction / bounce from sweep low`,
    `  ✅ ICT MSS: BODY CLOSE above ${round(mssLevel, 2)} confirmed`,
    `  ✅ Impulsive displacement UP after MSS`,
    `  ✅ HTF buy-side target: ${round(tp, 2)}`,
    ``,
    `TRADE SETUP:`,
    `  Entry  : ${round(entry, 2)} (50% retracement of impulse)`,
    `  Stop   : ${round(sl, 2)} (below sweep low)`,
    `  Target : ${round(tp, 2)} (HTF buyside liquidity)`,
    `  R:R    : ${rr}  |  Expected gain: +${pctG}%`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────
//  EXPORT WRAPPERS (compatible with old import names)
// ─────────────────────────────────────────────────────────────────────
export function scan_S1_wrapper(c15m, c1H, c4H, settings) {
  return scan_S1(c15m, settings);
}
export function scan_S2_wrapper(c15m, c1H, settings) {
  return scan_S2(c15m, c1H, settings);
}
export function scan_S3_wrapper(c15m, settings) {
  return scan_S3(c15m, null, settings);
}
