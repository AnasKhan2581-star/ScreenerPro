// core/liquidityEngine.js
import { detectSwings, detectEqualHighsLows } from '../utils/swings.js';

export function mapLiquidityPools(candles, tolerance = 0.0015) {
  const { highs, lows } = detectSwings(candles, 3, 3);
  const { equalHighs, equalLows } = detectEqualHighsLows(highs, lows, tolerance);

  const pools = [];

  // Equal highs = buy-side liquidity
  for (const pair of equalHighs) {
    pools.push({
      type: 'BSL', // buy-side
      price: Math.max(pair[0].price, pair[1].price),
      swept: false,
      strength: 'equal',
      indices: pair.map(p => p.index),
      time: pair[1].time
    });
  }

  // Equal lows = sell-side liquidity
  for (const pair of equalLows) {
    pools.push({
      type: 'SSL', // sell-side
      price: Math.min(pair[0].price, pair[1].price),
      swept: false,
      strength: 'equal',
      indices: pair.map(p => p.index),
      time: pair[1].time
    });
  }

  // Previous day high/low as liquidity
  if (candles.length > 96) { // ~1 day of 15m candles
    const prev24 = candles.slice(-96, -48);
    const pdh = Math.max(...prev24.map(c => c.high));
    const pdl = Math.min(...prev24.map(c => c.low));
    pools.push({ type: 'PDH', price: pdh, swept: false, strength: 'major' });
    pools.push({ type: 'PDL', price: pdl, swept: false, strength: 'major' });
  }

  // Swing highs/lows as liquidity
  for (const h of highs.slice(-5)) {
    pools.push({ type: 'SH', price: h.price, swept: false, strength: 'minor', time: h.time });
  }
  for (const l of lows.slice(-5)) {
    pools.push({ type: 'SL', price: l.price, swept: false, strength: 'minor', time: l.time });
  }

  return pools;
}

export function checkSweep(candle, pool) {
  if (pool.type === 'BSL' || pool.type === 'PDH' || pool.type === 'SH') {
    // Buy-side liquidity: sweep = wick above, close below
    return candle.high > pool.price && candle.close < pool.price;
  } else {
    // Sell-side liquidity: sweep = wick below, close above
    return candle.low < pool.price && candle.close > pool.price;
  }
}

export function getRecentSweeps(candles, pools, lookback = 5) {
  const recent = candles.slice(-lookback);
  const sweeps = [];

  for (const candle of recent) {
    for (const pool of pools) {
      if (!pool.swept && checkSweep(candle, pool)) {
        sweeps.push({ pool, candle, direction: pool.type === 'BSL' || pool.type === 'PDH' || pool.type === 'SH' ? 'short' : 'long' });
        pool.swept = true;
      }
    }
  }

  return sweeps;
}
