// core/riskEngine.js
import { round } from '../utils/math.js';

/**
 * Calculate position size based on risk %
 */
export function calcPositionSize(equity, riskPct, entry, sl) {
  const riskAmount = equity * (riskPct / 100);
  const priceDiff = Math.abs(entry - sl);
  if (!priceDiff) return 0;
  return round(riskAmount / priceDiff, 4);
}

/**
 * Calculate R:R ratio
 */
export function calcRR(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (!risk) return 0;
  return round(reward / risk, 2);
}

/**
 * Calculate target TP from entry/sl and desired R multiple
 */
export function calcTP(entry, sl, rrTarget, direction) {
  const riskDist = Math.abs(entry - sl);
  if (direction === 'long') return round(entry + riskDist * rrTarget, 6);
  return round(entry - riskDist * rrTarget, 6);
}

/**
 * Compute partial TP level
 */
export function calcPartialTP(entry, sl, partialRR, direction) {
  return calcTP(entry, sl, partialRR, direction);
}

export class RiskTracker {
  constructor(initialEquity, settings) {
    this.initialEquity = initialEquity;
    this.equity = initialEquity;
    this.settings = settings;
    this.dailyLoss = 0;
    this.dailyStart = initialEquity;
    this.trades = [];
    this.activeTrades = 0;
    this.peakEquity = initialEquity;
  }

  canTrade() {
    const dailyLossPct = (this.dailyLoss / this.dailyStart) * 100;
    if (dailyLossPct >= (this.settings.maxDailyRisk || 5)) return { ok: false, reason: 'Daily risk cap hit' };
    if (this.activeTrades >= (this.settings.maxConcurrentTrades || 3)) return { ok: false, reason: 'Max concurrent trades' };
    const drawdown = ((this.peakEquity - this.equity) / this.peakEquity) * 100;
    if (drawdown >= (this.settings.maxDrawdownStop || 10)) return { ok: false, reason: 'Max drawdown stop' };
    return { ok: true };
  }

  openTrade(size, entry, sl, tp, direction) {
    this.activeTrades++;
    const id = Date.now();
    this.trades.push({ id, size, entry, sl, tp, direction, status: 'open', r: 0 });
    return id;
  }

  closeTrade(id, closePrice) {
    const trade = this.trades.find(t => t.id === id);
    if (!trade) return 0;
    trade.status = 'closed';
    this.activeTrades = Math.max(0, this.activeTrades - 1);

    const pnl = trade.direction === 'long'
      ? (closePrice - trade.entry) * trade.size
      : (trade.entry - closePrice) * trade.size;

    const risk = Math.abs(trade.entry - trade.sl) * trade.size;
    trade.r = risk > 0 ? round(pnl / risk, 2) : 0;
    trade.pnl = round(pnl, 2);

    this.equity = round(this.equity + pnl, 2);
    if (pnl < 0) this.dailyLoss += Math.abs(pnl);
    if (this.equity > this.peakEquity) this.peakEquity = this.equity;

    return trade.r;
  }

  getDrawdown() {
    return round(((this.peakEquity - this.equity) / this.peakEquity) * 100, 2);
  }

  resetDay() {
    this.dailyLoss = 0;
    this.dailyStart = this.equity;
  }
}
