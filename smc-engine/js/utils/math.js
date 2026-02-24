// utils/math.js

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function round(val, decimals = 2) {
  return Math.round(val * 10 ** decimals) / 10 ** decimals;
}

export function pct(val, total) {
  if (!total) return 0;
  return (val / total) * 100;
}

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

export function sharpe(returns, riskFreeRate = 0) {
  if (!returns.length) return 0;
  const excess = returns.map(r => r - riskFreeRate);
  const s = std(excess);
  if (!s) return 0;
  return round(mean(excess) / s * Math.sqrt(252), 2);
}

export function sortino(returns, riskFreeRate = 0) {
  if (!returns.length) return 0;
  const downside = returns.filter(r => r < riskFreeRate);
  if (!downside.length) return 0;
  const ds = std(downside);
  if (!ds) return 0;
  return round(mean(returns) / ds * Math.sqrt(252), 2);
}

export function maxDrawdown(equityCurve) {
  let peak = equityCurve[0] || 1;
  let maxDD = 0;
  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return round(maxDD * 100, 2);
}

export function profitFactor(wins, losses) {
  const totalWin = wins.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  if (!totalLoss) return totalWin > 0 ? 999 : 0;
  return round(totalWin / totalLoss, 2);
}

export function expectancy(wr, avgWin, avgLoss) {
  const lr = 1 - wr;
  return round(wr * avgWin - lr * Math.abs(avgLoss), 3);
}

export function formatPrice(price, decimals = 2) {
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (price >= 1) return price.toFixed(decimals);
  return price.toFixed(6);
}

export function formatPct(val, sign = true) {
  const s = sign && val > 0 ? '+' : '';
  return `${s}${val.toFixed(2)}%`;
}

export function formatR(val) {
  const s = val > 0 ? '+' : '';
  return `${s}${val.toFixed(2)}R`;
}
