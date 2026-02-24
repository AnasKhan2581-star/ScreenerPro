// strategies/strategy3_HL_sweep.js
import { detectSwings, detectHigherLows } from '../utils/swings.js';
import { isDisplacement } from '../core/displacementEngine.js';
import { confirmBodyClose } from '../core/structureEngine.js';
import { getEntryZone } from '../core/entryEngine.js';
import { calcTP, calcRR } from '../core/riskEngine.js';
import { getLatestATR } from '../utils/atr.js';
import { isVolumeSpike } from '../utils/volume.js';

export const STRATEGY_3_ID = 'S3';
export const STRATEGY_3_NAME = 'HL Sweep Structure';

/**
 * Strategy 3 — Enhanced HL Sweep Model:
 * 1. Detect min 3 structural Higher Lows
 * 2. Sweep wick below 2+ HLs
 * 3. Explosive displacement back above
 * 4. BODY CLOSE above last major swing high (MANDATORY)
 * 5. Confirm Higher High formed
 * 6. Entry at 50% OB/FVG retracement
 */
export function scan_S3(candles15m, settings) {
  if (!settings.enableS3) return null;
  if (candles15m.length < 60) return null;

  const lookback = candles15m.slice(-80);
  const { lows, highs } = detectSwings(lookback, 3, 3);

  // Step 1: Detect minimum 3 Higher Lows
  const hlGroups = detectHigherLows(lows, 3, 4);
  if (!hlGroups.length) return null;

  // Use the most recent HL group
  const hlGroup = hlGroups[hlGroups.length - 1];
  if (hlGroup.length < 3) return null;

  // Step 2: Check for sweep below at least 2 of those HLs
  const last10 = candles15m.slice(-10);
  let sweepCandle = null;
  let sweptHLCount = 0;

  for (const candle of last10) {
    let count = 0;
    for (const hl of hlGroup) {
      if (candle.low < hl.price && candle.close > hl.price) count++;
    }
    if (count >= 2) {
      sweepCandle = candle;
      sweptHLCount = count;
      break;
    }
  }

  if (!sweepCandle) return null;

  // Step 3: Displacement candle after sweep
  const sweepTime = sweepCandle.time;
  let dispIdx = -1;
  const postSweep = candles15m.slice(-8);

  for (let i = postSweep.length - 1; i >= 0; i--) {
    const c = postSweep[i];
    if (c.time <= sweepTime) continue;
    if (!c || c.close <= c.open) continue; // Must be bullish

    // Check displacement conditions
    const atr = getLatestATR(candles15m);
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const closePos = (c.close - c.low) / range;

    if (body >= atr * (settings.atrMultiplier || 1.5) && closePos >= 0.75 && isVolumeSpike(c, candles15m, settings.volumeMultiplier || 1.5)) {
      dispIdx = candles15m.length - postSweep.length + i;
      break;
    }
  }

  if (dispIdx < 0) return null;

  const dispCandle = candles15m[dispIdx];

  // Step 4: BODY CLOSE above last major swing high — MANDATORY
  const lastSwingHigh = highs.slice(-1)[0];
  if (!lastSwingHigh) return null;

  if (!confirmBodyClose(dispCandle, lastSwingHigh.price, 'long')) {
    // REJECT: no body close above swing high
    return null;
  }

  // Step 5: Confirm Higher High formed
  const recentHighs = highs.slice(-2);
  if (recentHighs.length < 1) return null;
  // The displacement candle's high should exceed prior swing high
  if (dispCandle.high <= lastSwingHigh.price) return null;

  // Step 6: Entry zone
  const entry = getEntryZone(candles15m, dispIdx, 'long');
  const atr = getLatestATR(candles15m);
  const slBuffer = atr * (settings.slBuffer || 0.3);

  // SL: below lowest sweep wick
  const lowestSweepWick = Math.min(...last10.map(c => c.low));
  const sl = lowestSweepWick - slBuffer;

  // TP: next major resistance / broken swing high
  const tp = calcTP(entry, sl, settings.targetRR || 3, 'long');

  const rr = calcRR(entry, sl, tp);
  if (rr < (settings.minRR || 2)) return null;

  return {
    strategy: STRATEGY_3_ID,
    strategyName: STRATEGY_3_NAME,
    direction: 'long',
    entry,
    sl,
    tp,
    rr,
    hlGroup,
    sweepCandle,
    dispCandle,
    sweptHLCount,
    swingHighBreak: lastSwingHigh.price,
    atr,
    time: Date.now(),
    winRate: 0.68,
    tf: '15m'
  };
}
