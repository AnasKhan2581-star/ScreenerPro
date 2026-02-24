// utils/range.js

export function getDealingRange(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  let high = -Infinity, low = Infinity;
  let highIdx = 0, lowIdx = 0;

  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > high) { high = slice[i].high; highIdx = i; }
    if (slice[i].low < low) { low = slice[i].low; lowIdx = i; }
  }

  const eq = (high + low) / 2;
  return { high, low, eq, highIdx, lowIdx, premium: high, discount: low };
}

export function getPremiumDiscount(price, range) {
  const { high, low, eq } = range;
  if (price >= eq) return 'premium';
  return 'discount';
}

export function getFibLevel(range, fib) {
  return range.low + (range.high - range.low) * fib;
}
