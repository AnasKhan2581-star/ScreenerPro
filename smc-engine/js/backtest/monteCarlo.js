// backtest/monteCarlo.js
import { round, maxDrawdown, mean } from '../utils/math.js';

export function runMonteCarlo(trades, initialEquity, iterations = 1000) {
  if (!trades.length) return null;

  const rValues = trades.map(t => t.r);
  const riskPct = 0.01; // 1% risk per trade

  const simulations = [];

  for (let sim = 0; sim < iterations; sim++) {
    const shuffled = [...rValues].sort(() => Math.random() - 0.5);
    let equity = initialEquity;
    const curve = [equity];

    for (const r of shuffled) {
      const risk = equity * riskPct;
      equity += r * risk;
      curve.push(equity);
    }

    simulations.push({
      finalEquity: equity,
      maxDD: maxDrawdown(curve),
      curve
    });
  }

  simulations.sort((a, b) => a.finalEquity - b.finalEquity);

  const finals = simulations.map(s => s.finalEquity);
  const dds = simulations.map(s => s.maxDD);
  const ruined = simulations.filter(s => s.finalEquity <= initialEquity * 0.5).length;

  // Percentile curves for bands
  const p10idx = Math.floor(iterations * 0.1);
  const p25idx = Math.floor(iterations * 0.25);
  const p50idx = Math.floor(iterations * 0.5);
  const p75idx = Math.floor(iterations * 0.75);
  const p90idx = Math.floor(iterations * 0.9);

  return {
    iterations,
    worstDD: round(Math.max(...dds), 2),
    medianDD: round(dds[Math.floor(dds.length / 2)], 2),
    riskOfRuin: round((ruined / iterations) * 100, 2),
    medianFinal: round(finals[p50idx], 2),
    p10Final: round(finals[p10idx], 2),
    p90Final: round(finals[p90idx], 2),
    curves: {
      p10: simulations[p10idx].curve,
      p25: simulations[p25idx].curve,
      p50: simulations[p50idx].curve,
      p75: simulations[p75idx].curve,
      p90: simulations[p90idx].curve
    }
  };
}
