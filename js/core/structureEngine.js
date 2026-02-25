// core/structureEngine.js
import { detectSwings } from '../utils/swings.js';

/**
 * Detect Change of Character (CHoCH) / Market Structure Shift (MSS)
 * CHoCH = first break of structure after sweep
 * MSS = confirmed structural reversal
 */
export function detectMSS(candles, direction, lookback = 20) {
  const slice = candles.slice(-lookback);
  const { highs, lows } = detectSwings(slice, 2, 2);

  if (direction === 'long') {
    // For long: need to see bearish structure then a bullish break
    if (lows.length < 2) return null;
    const lastLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];

    // MSS: last low is higher than previous (higher low formed)
    if (lastLow.price > prevLow.price) {
      // Confirm body close above any prior swing high
      const lastHighInRange = highs.slice(-1)[0];
      if (lastHighInRange) {
        const latestCandle = slice[slice.length - 1];
        if (latestCandle.close > lastHighInRange.price) {
          return {
            type: 'MSS_LONG',
            breakLevel: lastHighInRange.price,
            swingLow: lastLow.price,
            confirmTime: latestCandle.time
          };
        }
      }
      return {
        type: 'CHoCH_LONG',
        swingLow: lastLow.price,
        confirmTime: lastLow.time
      };
    }
  }

  if (direction === 'short') {
    if (highs.length < 2) return null;
    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];

    if (lastHigh.price < prevHigh.price) {
      const lastLowInRange = lows.slice(-1)[0];
      if (lastLowInRange) {
        const latestCandle = slice[slice.length - 1];
        if (latestCandle.close < lastLowInRange.price) {
          return {
            type: 'MSS_SHORT',
            breakLevel: lastLowInRange.price,
            swingHigh: lastHigh.price,
            confirmTime: latestCandle.time
          };
        }
      }
      return {
        type: 'CHoCH_SHORT',
        swingHigh: lastHigh.price,
        confirmTime: lastHigh.time
      };
    }
  }

  return null;
}

/**
 * Confirm body close breaks structure — NO wick-only breaks
 */
export function confirmBodyClose(candle, level, direction) {
  if (direction === 'long') return candle.close > level;  // body closes above
  if (direction === 'short') return candle.close < level; // body closes below
  return false;
}

/**
 * Get last swing high / low
 */
export function getLastSwingHigh(candles, lookback = 30) {
  const { highs } = detectSwings(candles.slice(-lookback), 2, 2);
  return highs.slice(-1)[0] || null;
}

export function getLastSwingLow(candles, lookback = 30) {
  const { lows } = detectSwings(candles.slice(-lookback), 2, 2);
  return lows.slice(-1)[0] || null;
}
