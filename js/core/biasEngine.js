// core/biasEngine.js
import { detectSwings } from '../utils/swings.js';

/**
 * Determine market bias on a given timeframe
 * Based on swing structure: HH+HL = bull, LH+LL = bear
 */
export function calcBias(candles) {
  if (candles.length < 20) return 'neutral';

  const { highs, lows } = detectSwings(candles, 3, 3);
  if (highs.length < 2 || lows.length < 2) return 'neutral';

  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);

  const higherHighs = lastTwoHighs[1].price > lastTwoHighs[0].price;
  const higherLows = lastTwoLows[1].price > lastTwoLows[0].price;
  const lowerHighs = lastTwoHighs[1].price < lastTwoHighs[0].price;
  const lowerLows = lastTwoLows[1].price < lastTwoLows[0].price;

  if (higherHighs && higherLows) return 'bullish';
  if (lowerHighs && lowerLows) return 'bearish';
  return 'neutral';
}

export function getBiasAllTF(candles1H, candles4H, candles15m) {
  return {
    '15m': calcBias(candles15m),
    '1H':  calcBias(candles1H),
    '4H':  calcBias(candles4H),
  };
}

export function getAlignedBias(biases) {
  if (biases['4H'] === 'bullish' && biases['1H'] === 'bullish') return 'bullish';
  if (biases['4H'] === 'bearish' && biases['1H'] === 'bearish') return 'bearish';
  return 'neutral';
}
