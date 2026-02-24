// backtest/simulator.js
import { scan_S1 } from '../strategies/strategy1_sweepMSS.js';
import { scan_S2 } from '../strategies/strategy2_premiumContinuation.js';
import { scan_S3 } from '../strategies/strategy3_HL_sweep.js';
import { calcPositionSize } from '../core/riskEngine.js';
import { round } from '../utils/math.js';

export async function runBacktest(candles15m, candles1H, candles4H, settings, onProgress) {
  const trades = [];
  let equity = settings.initialEquity || 10000;
  const equityCurve = [equity];
  const dailyStats = {};
  
  const totalCandles = candles15m.length;
  const warmup = 100;

  for (let i = warmup; i < totalCandles - 1; i++) {
    const slice15m = candles15m.slice(0, i + 1);
    const pct1H = Math.floor(i * (candles1H.length / totalCandles));
    const pct4H = Math.floor(i * (candles4H.length / totalCandles));
    const slice1H = candles1H.slice(0, Math.max(pct1H, 30));
    const slice4H = candles4H.slice(0, Math.max(pct4H, 20));

    // Simulate entries
    let signal = null;
    const stratId = settings.strategy || 'all';

    if (stratId === 'S1' || stratId === 'all') {
      signal = scan_S1(slice15m, slice1H, slice4H, settings);
    }
    if (!signal && (stratId === 'S2' || stratId === 'all')) {
      signal = scan_S2(slice15m, slice1H, settings);
    }
    if (!signal && (stratId === 'S3' || stratId === 'all')) {
      signal = scan_S3(slice15m, settings);
    }

    if (!signal) continue;

    // Simulate trade outcome on subsequent candles
    const entry = signal.entry;
    const sl = signal.sl;
    const tp = signal.tp;
    const direction = signal.direction;
    const riskAmt = equity * (settings.riskPct / 100);
    const size = calcPositionSize(equity, settings.riskPct, entry, sl);

    let outcome = null;
    let exitPrice = 0;
    let barsHeld = 0;

    for (let j = i + 1; j < Math.min(i + 50, totalCandles); j++) {
      const c = candles15m[j];
      barsHeld++;

      if (direction === 'long') {
        if (c.low <= sl) { outcome = 'loss'; exitPrice = sl; break; }
        if (c.high >= tp) { outcome = 'win'; exitPrice = tp; break; }
      } else {
        if (c.high >= sl) { outcome = 'loss'; exitPrice = sl; break; }
        if (c.low <= tp) { outcome = 'win'; exitPrice = tp; break; }
      }
    }

    if (!outcome) continue; // no outcome, skip

    const pnl = direction === 'long'
      ? (exitPrice - entry) * size
      : (entry - exitPrice) * size;

    const r = round(pnl / riskAmt, 2);
    equity = round(equity + pnl, 2);

    const dateKey = new Date(candles15m[i].time).toISOString().slice(0, 7);
    if (!dailyStats[dateKey]) dailyStats[dateKey] = { pnl: 0, wins: 0, losses: 0 };
    dailyStats[dateKey].pnl += pnl;
    if (outcome === 'win') dailyStats[dateKey].wins++;
    else dailyStats[dateKey].losses++;

    equityCurve.push(equity);

    trades.push({
      idx: i,
      time: candles15m[i].time,
      strategy: signal.strategy,
      direction,
      entry,
      sl,
      tp,
      exitPrice,
      outcome,
      r,
      pnl: round(pnl, 2),
      equity: round(equity, 2),
      barsHeld,
      rr: signal.rr
    });

    // skip ahead to avoid overlapping signals
    i += Math.max(barsHeld, 3);

    if (onProgress) {
      onProgress(Math.round((i / totalCandles) * 100));
    }

    await yieldToUI();
  }

  return { trades, equityCurve, dailyStats };
}

function yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
}
