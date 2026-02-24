// backtest/metrics.js
import { round, mean, std, maxDrawdown, profitFactor, expectancy, sharpe, sortino } from '../utils/math.js';

export function calcMetrics(trades, equityCurve, initialEquity) {
  if (!trades.length) return null;

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');

  const wr = round(wins.length / trades.length, 3);
  const avgWinR = wins.length ? round(mean(wins.map(t => t.r)), 2) : 0;
  const avgLossR = losses.length ? round(mean(losses.map(t => Math.abs(t.r))), 2) : 0;

  const winPnls = wins.map(t => t.pnl);
  const lossPnls = losses.map(t => t.pnl);
  const pf = profitFactor(winPnls, lossPnls);
  const exp = expectancy(wr, avgWinR, avgLossR);
  const mdd = maxDrawdown(equityCurve);
  const finalEquity = equityCurve[equityCurve.length - 1] || initialEquity;
  const totalReturn = round(((finalEquity - initialEquity) / initialEquity) * 100, 2);
  const rReturns = trades.map(t => t.r);
  const sh = sharpe(rReturns);
  const so = sortino(rReturns);
  const avgRR = round(mean(trades.map(t => t.rr)), 2);

  // Strategy breakdown
  const byStrategy = {};
  for (const t of trades) {
    if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { wins: 0, losses: 0, r: [] };
    byStrategy[t.strategy][t.outcome === 'win' ? 'wins' : 'losses']++;
    byStrategy[t.strategy].r.push(t.r);
  }

  const stratBreakdown = Object.entries(byStrategy).map(([s, v]) => ({
    strategy: s,
    trades: v.wins + v.losses,
    wr: round(v.wins / (v.wins + v.losses), 3),
    avgR: round(mean(v.r), 2)
  }));

  // Long/short breakdown
  const longs = trades.filter(t => t.direction === 'long');
  const shorts = trades.filter(t => t.direction === 'short');

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wr,
    profitFactor: pf,
    expectancy: exp,
    maxDrawdown: mdd,
    totalReturn,
    finalEquity: round(finalEquity, 2),
    avgWinR,
    avgLossR,
    avgRR,
    sharpe: sh,
    sortino: so,
    stratBreakdown,
    longWR: longs.length ? round(longs.filter(t => t.outcome === 'win').length / longs.length, 3) : 0,
    shortWR: shorts.length ? round(shorts.filter(t => t.outcome === 'win').length / shorts.length, 3) : 0,
  };
}
