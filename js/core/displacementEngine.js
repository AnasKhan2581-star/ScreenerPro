// core/displacementEngine.js
import { getLatestATR } from '../utils/atr.js';
import { isVolumeSpike } from '../utils/volume.js';

/**
 * Detect displacement candles — large body, high volume, strong close
 */
export function isDisplacement(candle, candles, settings) {
  const atr = getLatestATR(candles);
  if (!atr) return false;

  const body = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;

  // Body must be >= ATR multiplier
  if (body < atr * (settings.atrMultiplier || 1.5)) return false;

  // Close must be in top/bottom 20% of candle range
  const closePosition = (candle.close - candle.low) / totalRange;
  const bullish = candle.close > candle.open;
  if (bullish && closePosition < 0.8) return false;
  if (!bullish && closePosition > 0.2) return false;

  // Volume check
  if (!isVolumeSpike(candle, candles, settings.volumeMultiplier || 1.5)) return false;

  return true;
}

/**
 * Detect FVG (Fair Value Gap) left by displacement
 */
export function detectFVG(candles, idx) {
  if (idx < 1 || idx >= candles.length - 1) return null;
  const prev = candles[idx - 1];
  const curr = candles[idx];
  const next = candles[idx + 1];

  // Bullish FVG: gap between prev.high and next.low
  if (curr.close > curr.open) {
    if (next.low > prev.high) {
      return {
        type: 'bullish',
        top: next.low,
        bottom: prev.high,
        mid: (next.low + prev.high) / 2,
        time: curr.time,
        filled: false
      };
    }
  }
  // Bearish FVG: gap between prev.low and next.high
  else {
    if (next.high < prev.low) {
      return {
        type: 'bearish',
        top: prev.low,
        bottom: next.high,
        mid: (prev.low + next.high) / 2,
        time: curr.time,
        filled: false
      };
    }
  }
  return null;
}

/**
 * Detect Order Block preceding displacement
 */
export function detectOB(candles, dispIdx) {
  if (dispIdx < 1) return null;
  const disp = candles[dispIdx];
  const bullish = disp.close > disp.open;

  // Look back 1-3 candles for OB (last opposing candle before displacement)
  for (let i = dispIdx - 1; i >= Math.max(0, dispIdx - 3); i--) {
    const c = candles[i];
    if (bullish && c.close < c.open) {
      return {
        type: 'bullish',
        top: c.open,    // OB = body of bearish candle before bull move
        bottom: c.close,
        mid: (c.open + c.close) / 2,
        time: c.time
      };
    }
    if (!bullish && c.close > c.open) {
      return {
        type: 'bearish',
        top: c.close,
        bottom: c.open,
        mid: (c.close + c.open) / 2,
        time: c.time
      };
    }
  }
  return null;
}

export function getAllFVGs(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const fvg = detectFVG(candles, i);
    if (fvg) fvgs.push(fvg);
  }
  // Mark filled FVGs
  for (const fvg of fvgs) {
    for (const c of candles) {
      if (c.time <= fvg.time) continue;
      if (fvg.type === 'bullish' && c.low <= fvg.bottom) { fvg.filled = true; break; }
      if (fvg.type === 'bearish' && c.high >= fvg.top) { fvg.filled = true; break; }
    }
  }
  return fvgs.filter(f => !f.filled).slice(-10);
}
