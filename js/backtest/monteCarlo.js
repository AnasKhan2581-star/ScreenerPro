// backtest/monteCarlo.js
import { round } from '../utils/math.js';

export function runMonteCarlo(trades, initialEquity, iterations = 1000) {
  if (trades.length < 5) return null;
  const pnls = trades.map(t => t.pnl);
  const curves = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  const finalEquities = [];
  let ruin = 0;

  const allCurves = [];

  for (let it = 0; it < iterations; it++) {
    const shuffled = shuffle([...pnls]);
    let eq = initialEquity;
    const curve = [eq];
    for (const pnl of shuffled) {
      eq += pnl;
      curve.push(Math.max(eq, 0));
    }
    finalEquities.push(curve[curve.length - 1]);
    if (curve[curve.length - 1] < initialEquity * 0.5) ruin++;
    allCurves.push(curve);
  }

  finalEquities.sort((a, b) => a - b);
  const len = trades.length + 1;

  for (let i = 0; i < len; i++) {
    const colVals = allCurves.map(c => c[Math.min(i, c.length - 1)]).sort((a, b) => a - b);
    curves.p10.push(colVals[Math.floor(iterations * 0.10)]);
    curves.p25.push(colVals[Math.floor(iterations * 0.25)]);
    curves.p50.push(colVals[Math.floor(iterations * 0.50)]);
    curves.p75.push(colVals[Math.floor(iterations * 0.75)]);
    curves.p90.push(colVals[Math.floor(iterations * 0.90)]);
  }

  const medDD = allCurves.map(curve => {
    let peak = initialEquity, dd = 0;
    for (const v of curve) { if (v > peak) peak = v; const d = (peak - v) / peak; if (d > dd) dd = d; }
    return dd;
  }).sort((a, b) => a - b);

  return {
    iterations,
    finalEquities,
    curves,
    medianFinal: round(finalEquities[Math.floor(iterations * 0.5)], 2),
    p10Final: round(finalEquities[Math.floor(iterations * 0.1)], 2),
    p90Final: round(finalEquities[Math.floor(iterations * 0.9)], 2),
    riskOfRuin: round((ruin / iterations) * 100, 1),
    worstDD: round(medDD[medDD.length - 1] * 100, 1),
    medianDD: round(medDD[Math.floor(iterations * 0.5)] * 100, 1),
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
