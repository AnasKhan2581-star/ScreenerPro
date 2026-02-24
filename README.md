# SMC Prop Engine — Institutional Grade Trading System

A modular, prop-firm grade Smart Money Concepts (SMC) trading engine deployable on **GitHub Pages** (fully static — no backend required).

## 🔵 Features

### 3 Strategies
- **S1 — HTF Sweep → LTF MSS**: 1H/4H liquidity sweep + 15m structure shift + OB/FVG entry
- **S2 — Premium/Discount Continuation**: Dealing range model, long discount / short premium only
- **S3 — Enhanced HL Sweep Structure**: 3+ Higher Lows → sweep → explosive displacement → body close above swing high (MANDATORY)

### Institutional Sequence Logic
```
BIAS → LIQUIDITY → SWEEP → DISPLACEMENT → STRUCTURE BREAK (BODY CLOSE) → RETRACEMENT → ENTRY → RISK
```

### Live Data
- Binance WebSocket (15m, 1H, 4H)
- Multi-timeframe synchronized candle cache
- Auto-reconnect

### Quant Backtesting
- Candle-by-candle simulation (no lookahead bias)
- Win rate, profit factor, expectancy, Sharpe, Sortino, max drawdown
- Strategy + long/short breakdown
- Monthly P&L breakdown

### Monte Carlo Simulation
- 1000+ iterations by default
- Worst-case drawdown, median outcome, risk of ruin
- Confidence band chart (P10/P25/P50/P75/P90)

### Risk Engine
- Dynamic position sizing
- Daily risk cap (kill switch)
- Max concurrent trades
- Max drawdown stop
- All parameters configurable

### Alert System
- Toast notifications
- Sound alerts (Web Audio API)
- Browser push notifications
- Per-symbol cooldown (no duplicate alerts)

---

## 🚀 Deploy to GitHub Pages

1. Fork or clone this repository
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/` (root)
4. Save — your engine is live at `https://yourusername.github.io/smc-engine`

**No build step, no npm install, no server needed.**

---

## 📁 Project Structure

```
/
├── index.html                    # Main app
├── css/
│   └── styles.css                # Institutional dark theme
└── js/
    ├── main.js                   # App controller
    ├── core/
    │   ├── biasEngine.js         # HTF bias from swing structure
    │   ├── liquidityEngine.js    # Equal highs/lows, PDH/PDL mapping
    │   ├── structureEngine.js    # CHoCH / MSS detection
    │   ├── displacementEngine.js # ATR-based displacement + FVG/OB
    │   ├── entryEngine.js        # OB/FVG retracement entry zones
    │   ├── riskEngine.js         # Position sizing, drawdown tracking
    │   └── sessionEngine.js      # Asian/London/NY session filter
    ├── strategies/
    │   ├── strategy1_sweepMSS.js
    │   ├── strategy2_premiumContinuation.js
    │   └── strategy3_HL_sweep.js
    ├── backtest/
    │   ├── simulator.js          # Candle-by-candle replay
    │   ├── metrics.js            # Full quant metrics
    │   └── monteCarlo.js         # Monte Carlo with equity bands
    ├── alerts/
    │   └── alertManager.js       # Toast + sound + push
    ├── data/
    │   ├── websocket.js          # Binance WS live feed
    │   ├── restLoader.js         # Binance REST historical data
    │   └── candleStore.js        # Multi-TF candle cache
    └── utils/
        ├── atr.js, swings.js, volume.js, range.js, math.js
```

---

## ⚙️ Settings

All configurable via the Settings panel (persisted to localStorage):

| Parameter | Default | Description |
|-----------|---------|-------------|
| Risk % per trade | 1% | Equity % risked per signal |
| Min R:R | 2 | Skip setups below this |
| Target R:R | 3 | Full TP multiplier |
| ATR Multiplier | 1.5 | Displacement body size |
| Volume Multiplier | 1.5 | Volume spike threshold |
| Max Daily Risk | 5% | Kill switch |
| Max Drawdown Stop | 10% | Emergency stop |
| Session Filter | ON | London/NY only |

---

## 🚫 What This Does NOT Do

- No random pattern matching
- No wick-only structure breaks (body close mandatory for Strategy 3)
- No mid-range entries
- No weak displacement entries
- No polling loops (pure event-driven WebSocket)

---

## ⚠️ Disclaimer

This tool is for educational and research purposes. Past backtested performance does not guarantee future results. Crypto trading involves substantial risk of loss.
