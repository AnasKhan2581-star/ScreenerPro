// utils/volume.js

export function avgVolume(candles, period = 20) {
  const slice = candles.slice(-period);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
}

export function isVolumeSpike(candle, candles, multiplier = 1.5, period = 20) {
  const avg = avgVolume(candles, period);
  if (!avg) return true; // no volume data, pass through
  return (candle.volume || 0) >= avg * multiplier;
}
