// strategies/strategy1_sweepMSS.js
import { mapLiquidityPools, checkSweep } from '../core/liquidityEngine.js';
import { isDisplacement, detectFVG, detectOB } from '../core/displacementEngine.js';
import { detectMSS, confirmBodyClose } from '../core/structureEngine.js';
import { getEntryZone } from '../core/entryEngine.js';
import { calcTP, calcRR } from '../core/riskEngine.js';
import { getLatestATR } from '../utils/atr.js';

export const STRATEGY_1_ID = 'S1';
export const STRATEGY_1_NAME = 'HTF Sweep → LTF MSS';

/**
 * Strategy 1: 
 * 1. Detect 1H/4H liquidity pool
 * 2. Sweep wick beyond it
 * 3. Displacement candle
 * 4. 15m CHoCH/MSS confirmation
 * 5. Entry at OB/FVG retracement
 */
export function scan_S1(candles15m, candles1H, candles4H, settings) {
  if (!settings.enableS1) return null;
  if (candles15m.length < 50) return null;

  // Map HTF liquidity pools
  const pools4H = mapLiquidityPools(candles4H, settings.liquidityTolerance || 0.0015);
  const pools1H = mapLiquidityPools(candles1H, settings.liquidityTolerance || 0.0015);

  const allPools = [...pools4H, ...pools1H];

  // Check recent 15m candles for sweep of HTF pools
  const recentCandles = candles15m.slice(-10);
  const latestCandle = candles15m[candles15m.length - 1];

  for (const pool of allPools) {
    for (let i = recentCandles.length - 1; i >= 0; i--) {
      const candle = recentCandles[i];
      const swept = checkSweep(candle, pool);
      if (!swept) continue;

      const direction = (pool.type === 'BSL' || pool.type === 'PDH' || pool.type === 'SH') ? 'short' : 'long';

      // Check displacement after sweep
      const postSweepCandles = candles15m.slice(-5);
      let dispIdx = -1;
      for (let j = candles15m.length - 1; j >= candles15m.length - 5; j--) {
        if (isDisplacement(candles15m[j], candles15m.slice(0, j), settings)) {
          dispIdx = j;
          break;
        }
      }
      if (dispIdx < 0) continue;

      const dispCandle = candles15m[dispIdx];

      // Verify displacement direction matches
      const dispBull = dispCandle.close > dispCandle.open;
      if (direction === 'long' && !dispBull) continue;
      if (direction === 'short' && dispBull) continue;

      // Confirm MSS on 15m
      const mss = detectMSS(candles15m, direction, 30);
      if (!mss) continue;

      // Get entry zone
      const entry = getEntryZone(candles15m, dispIdx, direction);
      const atr = getLatestATR(candles15m);

      // SL: beyond sweep wick + buffer
      const slBuffer = atr * (settings.slBuffer || 0.3);
      let sl, tp;
      if (direction === 'long') {
        sl = candle.low - slBuffer;
        tp = calcTP(entry, sl, settings.targetRR || 3, 'long');
      } else {
        sl = candle.high + slBuffer;
        tp = calcTP(entry, sl, settings.targetRR || 3, 'short');
      }

      const rr = calcRR(entry, sl, tp);
      if (rr < (settings.minRR || 2)) continue;

      return {
        strategy: STRATEGY_1_ID,
        strategyName: STRATEGY_1_NAME,
        direction,
        entry,
        sl,
        tp,
        rr,
        pool,
        mss,
        dispCandle,
        atr,
        time: Date.now(),
        winRate: 0.66,
        tf: '15m'
      };
    }
  }
  return null;
}
