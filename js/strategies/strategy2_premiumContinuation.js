// strategies/strategy2_premiumContinuation.js
import { getDealingRange, getPremiumDiscount } from '../utils/range.js';
import { isDisplacement, detectFVG, detectOB } from '../core/displacementEngine.js';
import { getEntryZone } from '../core/entryEngine.js';
import { calcTP, calcRR } from '../core/riskEngine.js';
import { detectSwings } from '../utils/swings.js';
import { getLatestATR } from '../utils/atr.js';

export const STRATEGY_2_ID = 'S2';
export const STRATEGY_2_NAME = 'Premium/Discount';

/**
 * Strategy 2:
 * 1. Define dealing range
 * 2. LONG only in discount, SHORT only in premium
 * 3. Confirm continuation displacement
 * 4. Entry at OB/FVG retracement
 */
export function scan_S2(candles15m, candles1H, settings) {
  if (!settings.enableS2) return null;
  if (candles1H.length < 30) return null;

  const range = getDealingRange(candles1H, 50);
  const currentPrice = candles15m[candles15m.length - 1]?.close;
  if (!currentPrice) return null;

  const zone = getPremiumDiscount(currentPrice, range);

  // Direction based on zone
  const direction = zone === 'discount' ? 'long' : 'short';

  // Check displacement in the continuation direction
  let dispIdx = -1;
  for (let j = candles15m.length - 1; j >= candles15m.length - 8; j--) {
    if (j < 0) break;
    if (isDisplacement(candles15m[j], candles15m.slice(0, j), settings)) {
      const disp = candles15m[j];
      const dispBull = disp.close > disp.open;
      if (direction === 'long' && dispBull) { dispIdx = j; break; }
      if (direction === 'short' && !dispBull) { dispIdx = j; break; }
    }
  }

  if (dispIdx < 0) return null;

  // Check we haven't crossed equilibrium against us
  if (direction === 'long' && currentPrice > range.eq * 1.005) return null;
  if (direction === 'short' && currentPrice < range.eq * 0.995) return null;

  const entry = getEntryZone(candles15m, dispIdx, direction);
  const atr = getLatestATR(candles15m);
  const slBuffer = atr * (settings.slBuffer || 0.3);

  // SL: beyond dealing range boundary
  let sl, tp;
  if (direction === 'long') {
    sl = range.low - slBuffer;
    tp = calcTP(entry, sl, settings.targetRR || 3, 'long');
    // TP shouldn't exceed range high
    if (tp > range.high) tp = range.high;
  } else {
    sl = range.high + slBuffer;
    tp = calcTP(entry, sl, settings.targetRR || 3, 'short');
    if (tp < range.low) tp = range.low;
  }

  const rr = calcRR(entry, sl, tp);
  if (rr < (settings.minRR || 2)) return null;

  return {
    strategy: STRATEGY_2_ID,
    strategyName: STRATEGY_2_NAME,
    direction,
    entry,
    sl,
    tp,
    rr,
    range,
    zone,
    atr,
    time: Date.now(),
    winRate: 0.62,
    tf: '15m'
  };
}
