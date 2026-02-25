// backtest/metrics.js
import { round } from '../utils/math.js';

export function calcMetrics(trades, equityCurve, initialEquity) {
  if (!trades.length) return null;

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const winRate = wins.length / trades.length;

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? round(grossWin / grossLoss, 2) : (grossWin > 0 ? 99 : 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const finalEquity = initialEquity + totalPnl;
  const totalReturn = round(((finalEquity - initialEquity) / initialEquity) * 100, 2);

  const avgWin = wins.length ? round(grossWin / wins.length, 2) : 0;
  const avgLoss = losses.length ? round(grossLoss / losses.length, 2) : 0;
  const avgRR = trades.length ? round(trades.reduce((s, t) => s + t.rr, 0) / trades.length, 2) : 0;
  const expectancy = round(winRate * avgWin - (1 - winRate) * avgLoss, 2);

  // Max drawdown
  let peak = initialEquity, maxDD = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdown = round(maxDD * 100, 2);

  // Sharpe/Sortino (daily returns from equity curve)
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const avgRet = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returns.length || 1));
  const sharpe = stdDev > 0 ? round((avgRet / stdDev) * Math.sqrt(252), 2) : 0;

  const negReturns = returns.filter(r => r < 0);
  const downDev = negReturns.length > 0 ? Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / negReturns.length) : 0;
  const sortino = downDev > 0 ? round((avgRet / downDev) * Math.sqrt(252), 2) : 0;

  // Long / short breakdown (all should be long for spot)
  const longTrades = trades.filter(t => t.direction === 'long');
  const longWins = longTrades.filter(t => t.outcome === 'win');
  const longWR = longTrades.length ? round((longWins.length / longTrades.length) * 100, 2) : 0;
  const shortTrades = trades.filter(t => t.direction === 'short');
  const shortWins = shortTrades.filter(t => t.outcome === 'win');
  const shortWR = shortTrades.length ? round((shortWins.length / shortTrades.length) * 100, 2) : 0;

  // Per-strategy breakdown
  const stratKeys = [...new Set(trades.map(t => t.strategy))];
  const stratBreakdown = stratKeys.map(s => {
    const st = trades.filter(t => t.strategy === s);
    const sw = st.filter(t => t.outcome === 'win');
    const spnl = round(st.reduce((a, t) => a + t.pnl, 0), 2);
    const spctGain = round((spnl / initialEquity) * 100, 2);
    return {
      strategy: s,
      trades: st.length,
      wr: round(sw.length / st.length, 3),
      avgR: st.length ? round(st.reduce((a, t) => a + t.r, 0) / st.length, 2) : 0,
      pnl: spnl,
      pctGain: spctGain,
    };
  });

  // Average % gain per win
  const avgPctGainPerWin = wins.length ? round(wins.reduce((s, t) => s + (t.gainPct || 0), 0) / wins.length, 2) : 0;
  const avgPctLossPerLoss = losses.length ? round(losses.reduce((s, t) => s + Math.abs(t.gainPct || 0), 0) / losses.length, 2) : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 3),
    winRatePct: round(winRate * 100, 1),
    profitFactor,
    expectancy,
    totalReturn,
    finalEquity: round(finalEquity, 2),
    maxDrawdown,
    sharpe,
    sortino,
    avgRR,
    avgWin,
    avgLoss,
    avgPctGainPerWin,
    avgPctLossPerLoss,
    longWR,
    shortWR,
    stratBreakdown,
    grossWin: round(grossWin, 2),
    grossLoss: round(grossLoss, 2),
  };
}
