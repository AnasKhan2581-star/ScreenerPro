// core/entryEngine.js
import { detectOB, detectFVG } from './displacementEngine.js';

/**
 * Find the optimal entry zone from OB or FVG retracement
 */
export function getEntryZone(candles, dispIdx, direction) {
  const fvg = detectFVG(candles, dispIdx);
  const ob = detectOB(candles, dispIdx);

  if (direction === 'long') {
    // Entry at OB top or FVG bottom — whichever is higher (better fill)
    const obEntry = ob?.top || null;
    const fvgEntry = fvg?.bottom || null;

    if (obEntry && fvgEntry) return Math.max(obEntry, fvgEntry);
    return obEntry || fvgEntry || candles[dispIdx].close;
  }

  if (direction === 'short') {
    const obEntry = ob?.bottom || null;
    const fvgEntry = fvg?.top || null;

    if (obEntry && fvgEntry) return Math.min(obEntry, fvgEntry);
    return obEntry || fvgEntry || candles[dispIdx].close;
  }

  return candles[dispIdx].close;
}

/**
 * Determine if price has retraced to entry zone
 */
export function hasRetracedToEntry(currentCandle, entryZone, direction, tolerance = 0.001) {
  if (direction === 'long') {
    return currentCandle.low <= entryZone * (1 + tolerance);
  }
  if (direction === 'short') {
    return currentCandle.high >= entryZone * (1 - tolerance);
  }
  return false;
}

/**
 * Check if entry is still valid (SL not hit)
 */
export function isEntryValid(currentCandle, sl, direction) {
  if (direction === 'long') return currentCandle.low > sl;
  if (direction === 'short') return currentCandle.high < sl;
  return false;
}
