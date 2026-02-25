// backtest/simulator.js — Spot-Only, Correct SMC Backtest Engine
import { scan_S1, scan_S2, scan_S3 } from '../strategies/smc_strategies.js';
import { round } from '../utils/math.js';

/**
 * Candle-by-candle replay backtest. SPOT ONLY.
 * No leverage, no margin, no shorts (all SMC setups here are LONG).
 * Position size = (riskAmt / (entry - sl)) in base asset units.
 * P&L = (exitPrice - entry) * qty — only what you can lose is what you risk.
 */
export async function runBacktest(candles15m, candles1H, candles4H, settings, onProgress) {
  const trades = [];
  let equity = parseFloat(settings.initialEquity) || 10000;
  const initialEquity = equity;
  const equityCurve = [equity];
  const dailyStats = {};

  const totalCandles = candles15m.length;
  const warmup = 120; // need enough data for strategy detection
  let openTrade = null; // only 1 trade at a time (spot, realistic)

  for (let i = warmup; i < totalCandles; i++) {
    const slice15m = candles15m.slice(0, i + 1);
    const slice1H  = candles1H  ? candles1H.slice(0,  Math.round(i * candles1H.length  / totalCandles)) : [];
    const curCandle = candles15m[i];

    // ── CHECK OPEN TRADE FIRST ──
    if (openTrade) {
      const { entry, sl, tp, qty, riskAmt, strategy, direction, time: tradeTime, rr } = openTrade;
      let outcome = null;
      let exitPrice = null;

      // Spot long: check SL and TP hit
      if (curCandle.low <= sl) {
        outcome = 'loss';
        exitPrice = sl;
      } else if (curCandle.high >= tp) {
        outcome = 'win';
        exitPrice = tp;
      } else {
        openTrade.barsHeld = (openTrade.barsHeld || 0) + 1;
        // Max hold = 100 candles = ~25 hours on 15m
        if (openTrade.barsHeld >= 100) {
          outcome = curCandle.close > entry ? 'win' : 'loss';
          exitPrice = curCandle.close;
        }
      }

      if (outcome) {
        const grossPnl = (exitPrice - entry) * qty;
        const pnlUSD = round(grossPnl, 2);
        const pnlPct = round((pnlUSD / (entry * qty)) * 100, 2); // % of position
        const rVal = round(pnlUSD / riskAmt, 2);
        equity = round(equity + pnlUSD, 4);
        equityCurve.push(equity);

        const monthKey = new Date(tradeTime).toISOString().slice(0, 7);
        if (!dailyStats[monthKey]) dailyStats[monthKey] = { pnl: 0, wins: 0, losses: 0, trades: 0 };
        dailyStats[monthKey].pnl += pnlUSD;
        dailyStats[monthKey].trades++;
        if (outcome === 'win') dailyStats[monthKey].wins++;
        else dailyStats[monthKey].losses++;

        const entryPct = round(((entry - openTrade.signalPrice) / openTrade.signalPrice) * 100, 2);
        const gainPct = round(((exitPrice - entry) / entry) * 100, 2);

        trades.push({
          idx: openTrade.idx,
          time: tradeTime,
          exitTime: curCandle.time,
          strategy,
          direction,
          entry: round(entry, 6),
          sl: round(sl, 6),
          tp: round(tp, 6),
          exitPrice: round(exitPrice, 6),
          qty: round(qty, 6),
          outcome,
          r: rVal,
          pnl: pnlUSD,
          pnlPct,
          gainPct,
          equity: round(equity, 2),
          equityPct: round(((equity - initialEquity) / initialEquity) * 100, 2),
          barsHeld: openTrade.barsHeld || 1,
          rr,
        });

        openTrade = null;
      }
      // skip signal scanning when in a trade
      if (openTrade) {
        if (onProgress && i % 50 === 0) onProgress(Math.round((i / totalCandles) * 100));
        await yieldToUI(i);
        continue;
      }
    }

    // ── SCAN FOR SIGNAL ──
    if (!openTrade && equity > initialEquity * 0.5) { // stop if blew up
      let signal = null;
      const strat = settings.strategy || 'all';

      try {
        if ((strat === 'all' || strat === 'S1') && settings.enableS1 !== false) {
          signal = scan_S1(slice15m, settings);
        }
        if (!signal && (strat === 'all' || strat === 'S2') && settings.enableS2 !== false) {
          signal = scan_S2(slice15m, slice1H.length > 20 ? slice1H : null, settings);
        }
        if (!signal && (strat === 'all' || strat === 'S3') && settings.enableS3 !== false) {
          signal = scan_S3(slice15m, slice1H.length > 20 ? slice1H : null, settings);
        }
      } catch (e) {
        // strategy scan error — skip candle
      }

      if (signal && signal.direction === 'long') {
        // Spot only: apply only-longs filter
        if (settings.onlyLongs === false) { /* allow all */ }

        const entry = signal.entry;
        const sl = signal.sl;
        const tp = signal.tp;

        if (sl >= entry || tp <= entry) {
          // Invalid trade levels
        } else {
          const riskPct = parseFloat(settings.riskPct) || 1;
          const riskAmt = equity * (riskPct / 100);
          const riskPerUnit = entry - sl;
          const qty = riskAmt / riskPerUnit; // how many coins we buy
          const positionCost = qty * entry; // total capital deployed

          // Spot check: can't spend more than equity
          if (positionCost > equity) {
            // Scale down qty to fit available equity
            const adjQty = equity / entry;
            const adjRisk = (entry - sl) * adjQty;
            openTrade = {
              idx: i,
              time: curCandle.time,
              signalPrice: curCandle.close,
              strategy: signal.strategy,
              direction: signal.direction,
              entry, sl, tp,
              qty: adjQty,
              riskAmt: adjRisk,
              rr: signal.rr,
              barsHeld: 0,
            };
          } else {
            openTrade = {
              idx: i,
              time: curCandle.time,
              signalPrice: curCandle.close,
              strategy: signal.strategy,
              direction: signal.direction,
              entry, sl, tp,
              qty,
              riskAmt,
              rr: signal.rr,
              barsHeld: 0,
            };
          }
        }
      }
    }

    if (onProgress && i % 100 === 0) onProgress(Math.round((i / totalCandles) * 100));
    await yieldToUI(i);
  }

  // Close any still-open trade at last price
  if (openTrade) {
    const lastCandle = candles15m[candles15m.length - 1];
    const exitPrice = lastCandle.close;
    const pnlUSD = round((exitPrice - openTrade.entry) * openTrade.qty, 2);
    const outcome = pnlUSD >= 0 ? 'win' : 'loss';
    const pnlPct = round(((exitPrice - openTrade.entry) / openTrade.entry) * 100, 2);
    equity = round(equity + pnlUSD, 4);
    equityCurve.push(equity);
    trades.push({
      idx: openTrade.idx,
      time: openTrade.time,
      exitTime: lastCandle.time,
      strategy: openTrade.strategy,
      direction: openTrade.direction,
      entry: openTrade.entry,
      sl: openTrade.sl,
      tp: openTrade.tp,
      exitPrice: round(exitPrice, 6),
      qty: round(openTrade.qty, 6),
      outcome,
      r: round(pnlUSD / openTrade.riskAmt, 2),
      pnl: pnlUSD,
      pnlPct,
      gainPct: pnlPct,
      equity: round(equity, 2),
      equityPct: round(((equity - initialEquity) / initialEquity) * 100, 2),
      barsHeld: openTrade.barsHeld || 1,
      rr: openTrade.rr,
    });
  }

  onProgress && onProgress(100);
  return { trades, equityCurve, dailyStats };
}

let lastYield = 0;
async function yieldToUI(i) {
  if (i - lastYield > 200) {
    lastYield = i;
    await new Promise(r => setTimeout(r, 0));
  }
}
