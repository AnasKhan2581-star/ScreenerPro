// main.js — SMC Prop Engine
import { candleStore } from './data/candleStore.js';
import { fetchMultiTF, fetchHistorical, fetchCurrentPrice } from './data/restLoader.js';
import { BinanceWS } from './data/websocket.js';
import { getBiasAllTF, getAlignedBias } from './core/biasEngine.js';
import { mapLiquidityPools } from './core/liquidityEngine.js';
import { getCurrentSession } from './core/sessionEngine.js';
import { scan_S1 } from './strategies/strategy1_sweepMSS.js';
import { scan_S2 } from './strategies/strategy2_premiumContinuation.js';
import { scan_S3 } from './strategies/strategy3_HL_sweep.js';
import { RiskTracker, calcPositionSize } from './core/riskEngine.js';
import { runBacktest } from './backtest/simulator.js';
import { calcMetrics } from './backtest/metrics.js';
import { runMonteCarlo } from './backtest/monteCarlo.js';
import { alertManager } from './alerts/alertManager.js';
import { formatPrice, formatPct, round } from './utils/math.js';

// ── DEFAULT SETTINGS ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  symbol: 'BTCUSDT',
  riskPct: 1,
  minRR: 2,
  targetRR: 3,
  partialRR: 1.5,
  atrMultiplier: 1.5,
  volumeMultiplier: 1.5,
  slBuffer: 0.3,
  maxDailyRisk: 5,
  maxConcurrentTrades: 3,
  maxDrawdownStop: 10,
  sessionFilter: true,
  enableS1: true,
  enableS2: true,
  enableS3: true,
  liquidityTolerance: 0.0015,
  mcIterations: 1000,
  maxTradesPerDay: 3,
  initialEquity: 10000,
};

// ── STATE ──────────────────────────────────────────────────────────
const state = {
  settings: { ...DEFAULT_SETTINGS },
  activeView: 'live',
  activeTF: '15m',
  signals: [],
  biases: { '15m': 'neutral', '1H': 'neutral', '4H': 'neutral' },
  session: null,
  ws: null,
  riskTracker: null,
  btResults: null,
  mcResults: null,
  scanning: false,
  lastPrice: 0,
};

// ── LOAD/SAVE SETTINGS ────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem('smc_settings');
    if (saved) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch (e) {}
}

function saveSettings() {
  try {
    localStorage.setItem('smc_settings', JSON.stringify(state.settings));
  } catch (e) {}
}

// ── DOM HELPERS ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function el(id) { return document.getElementById(id); }

// ── INIT ──────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  state.riskTracker = new RiskTracker(state.settings.initialEquity, state.settings);
  await alertManager.init();

  renderSettingsPanel();
  bindNavTabs();
  bindSettings();
  renderSidebar();
  updateHeaderEquity();
  startLiveMode();
  showView('live');
}

// ── VIEW SWITCHING ────────────────────────────────────────────────
function bindNavTabs() {
  $$('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showView(btn.dataset.view);
    });
  });
}

function showView(view) {
  state.activeView = view;
  $$('.view-panel').forEach(p => p.classList.remove('active'));
  const panel = el(`view-${view}`);
  if (panel) panel.classList.add('active');
}

// ── LIVE MODE ─────────────────────────────────────────────────────
async function startLiveMode() {
  const sym = state.settings.symbol;
  showLoading('main-canvas-container', true);

  try {
    const data = await fetchMultiTF(sym);
    candleStore.set(sym, '15m', data['15m']);
    candleStore.set(sym, '1H',  data['1H']);
    candleStore.set(sym, '4H',  data['4H']);

    state.lastPrice = data['15m'].slice(-1)[0]?.close || 0;
    updatePriceDisplay();
    runAnalysis();
    renderChart();

    // Connect WebSocket
    if (state.ws) state.ws.disconnect();
    state.ws = new BinanceWS(sym, ['15m', '1H', '4H'], onWsUpdate);
    state.ws.connect();

    // Scan every 30s
    setInterval(() => { runAnalysis(); renderChart(); }, 30000);
    setInterval(updateHeaderEquity, 5000);
    setInterval(updateSessionDisplay, 60000);
  } catch (e) {
    console.error('Live mode error:', e);
    showToast({ strategy: 'SYS', msg: 'Live data error — check connection', time: new Date().toLocaleTimeString() });
  }

  showLoading('main-canvas-container', false);
}

function onWsUpdate(symbol, tf, candle) {
  state.lastPrice = candle.close;
  updatePriceDisplay();

  if (tf === '15m' && candle.closed) {
    runAnalysis();
    if (state.activeView === 'live') renderChart();
  }
}

// ── ANALYSIS ENGINE ───────────────────────────────────────────────
function runAnalysis() {
  if (state.scanning) return;
  state.scanning = true;

  const sym = state.settings.symbol;
  const c15m = candleStore.get(sym, '15m');
  const c1H  = candleStore.get(sym, '1H');
  const c4H  = candleStore.get(sym, '4H');

  if (!c15m.length) { state.scanning = false; return; }

  // Bias
  state.biases = getBiasAllTF(c1H, c4H, c15m);
  state.session = getCurrentSession();

  // Liquidity
  state.liquidityPools = mapLiquidityPools(c1H, state.settings.liquidityTolerance);

  // Scan strategies
  const newSignals = [];

  const s1 = scan_S1(c15m, c1H, c4H, state.settings);
  if (s1) { s1.symbol = sym; newSignals.push(s1); }

  const s2 = scan_S2(c15m, c1H, state.settings);
  if (s2) { s2.symbol = sym; newSignals.push(s2); }

  const s3 = scan_S3(c15m, state.settings);
  if (s3) { s3.symbol = sym; newSignals.push(s3); }

  // Add new signals
  for (const sig of newSignals) {
    const isDup = state.signals.some(s => s.strategy === sig.strategy && Math.abs(s.time - sig.time) < 300000);
    if (!isDup) {
      state.signals.unshift({ ...sig, status: 'live' });
      alertManager.fire(sig, showToast);
    }
  }

  state.signals = state.signals.slice(0, 20);

  updateSidebarBias();
  updateSidebarLiquidity();
  renderSignals();
  updateStatsBar();
  renderAlertLog();

  state.scanning = false;
}

// ── CHART RENDERING ───────────────────────────────────────────────
function renderChart() {
  const canvas = el('main-canvas');
  if (!canvas) return;

  const sym = state.settings.symbol;
  const candles = candleStore.get(sym, state.activeTF);
  if (!candles.length) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();

  canvas.width  = rect.width * dpr;
  canvas.height = (rect.height - 44) * dpr;
  canvas.style.width  = rect.width + 'px';
  canvas.style.height = (rect.height - 44) + 'px';
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height - 44;
  const PAD = { top: 20, right: 60, bottom: 30, left: 12 };

  const display = candles.slice(-80);
  const prices = display.flatMap(c => [c.high, c.low]);
  let hi = Math.max(...prices);
  let lo = Math.min(...prices);
  const margin = (hi - lo) * 0.08;
  hi += margin; lo -= margin;

  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barW = chartW / display.length;
  const candleW = Math.max(2, barW * 0.6);

  const toX = (i) => PAD.left + i * barW + barW / 2;
  const toY = (p) => PAD.top + chartH - ((p - lo) / (hi - lo)) * chartH;

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = '#1f2d42';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const y = PAD.top + (chartH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    const price = hi - ((hi - lo) / 5) * i;
    ctx.fillStyle = '#3d5169';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillText(formatPrice(price), W - PAD.right + 4, y + 3);
  }

  // Draw liquidity pools
  if (state.liquidityPools) {
    for (const pool of state.liquidityPools.slice(0, 10)) {
      if (pool.price < lo || pool.price > hi) continue;
      const y = toY(pool.price);
      ctx.strokeStyle = (pool.type === 'BSL' || pool.type === 'PDH' || pool.type === 'SH')
        ? 'rgba(255,61,90,0.35)' : 'rgba(0,232,122,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = '8px JetBrains Mono';
      ctx.fillText(pool.type, W - PAD.right - 30, y - 2);
    }
  }

  // Draw signal levels
  for (const sig of state.signals.slice(0, 3)) {
    if (!sig.entry) continue;
    const colors = { entry: '#00d4ff', sl: '#ff3d5a', tp: '#00e87a' };
    for (const [key, color] of Object.entries(colors)) {
      const price = sig[key];
      if (!price || price < lo || price > hi) continue;
      const y = toY(price);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(key === 'entry' ? [] : [3, 3]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }
  }

  // Draw candles
  for (let i = 0; i < display.length; i++) {
    const c = display[i];
    const x = toX(i);
    const isBull = c.close >= c.open;
    const color = isBull ? '#00e87a' : '#ff3d5a';
    const bodyColor = isBull ? '#00e87a' : '#ff3d5a';

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(c.high));
    ctx.lineTo(x, toY(c.low));
    ctx.stroke();

    // Body
    const openY = toY(c.open);
    const closeY = toY(c.close);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(1, Math.abs(openY - closeY));

    ctx.fillStyle = bodyColor;
    ctx.globalAlpha = isBull ? 0.85 : 0.75;
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyHeight);
    ctx.globalAlpha = 1;
  }

  // Current price line
  if (state.lastPrice > lo && state.lastPrice < hi) {
    const y = toY(state.lastPrice);
    ctx.strokeStyle = '#f5c842';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#f5c842';
    ctx.fillRect(W - PAD.right, y - 7, PAD.right - 2, 14);
    ctx.fillStyle = '#080a0e';
    ctx.font = 'bold 9px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(formatPrice(state.lastPrice), W - PAD.right / 2, y + 3);
  }

  // Draw equity mini
  renderEquityMini();
}

function renderEquityMini() {
  const canvas = el('equity-mini-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;

  const closedTrades = state.riskTracker.trades.filter(t => t.status === 'closed');
  if (closedTrades.length < 2) {
    ctx.fillStyle = '#111620';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3d5169';
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('No trades yet', W / 2, H / 2 + 3);
    return;
  }

  const curve = [state.settings.initialEquity];
  for (const t of closedTrades) curve.push(t.equity || curve[curve.length - 1]);

  drawEquityCurve(ctx, W, H, curve, '#00e87a');
}

function drawEquityCurve(ctx, W, H, curve, color) {
  const pad = 8;
  const hi = Math.max(...curve);
  const lo = Math.min(...curve);
  const range = hi - lo || 1;

  const toX = (i) => pad + (i / (curve.length - 1)) * (W - pad * 2);
  const toY = (v) => H - pad - ((v - lo) / range) * (H - pad * 2);

  ctx.fillStyle = '#111620';
  ctx.fillRect(0, 0, W, H);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad, 0, H - pad);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(curve[0]));
  for (let i = 1; i < curve.length; i++) ctx.lineTo(toX(i), toY(curve[i]));
  ctx.lineTo(toX(curve.length - 1), H);
  ctx.lineTo(toX(0), H);
  ctx.closePath();
  ctx.fill();

  // Line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    if (i === 0) ctx.moveTo(toX(i), toY(curve[i]));
    else ctx.lineTo(toX(i), toY(curve[i]));
  }
  ctx.stroke();
}

// ── SIDEBAR ───────────────────────────────────────────────────────
function renderSidebar() {
  updateSidebarBias();
  updateSidebarLiquidity();
  updateSessionDisplay();
  renderStrategyToggles();
}

function updateSidebarBias() {
  const biasHtml = Object.entries(state.biases).map(([tf, bias]) => `
    <div class="bias-card">
      <div class="bias-tf">${tf}</div>
      <div class="bias-val ${bias === 'bullish' ? 'bull' : bias === 'bearish' ? 'bear' : 'neutral'}">
        ${bias === 'bullish' ? '▲' : bias === 'bearish' ? '▼' : '◆'} ${bias.toUpperCase()}
      </div>
    </div>
  `).join('');

  const container = el('bias-container');
  if (container) container.innerHTML = biasHtml;

  const aligned = getAlignedBias(state.biases);
  const alignedEl = el('aligned-bias');
  if (alignedEl) {
    alignedEl.className = `bias-val ${aligned === 'bullish' ? 'bull' : aligned === 'bearish' ? 'bear' : 'neutral'}`;
    alignedEl.textContent = `${aligned === 'bullish' ? '▲' : aligned === 'bearish' ? '▼' : '◆'} ${aligned.toUpperCase()}`;
  }
}

function updateSidebarLiquidity() {
  if (!state.liquidityPools) return;
  const container = el('liquidity-container');
  if (!container) return;

  const recent = state.liquidityPools.slice(0, 6);
  container.innerHTML = recent.map(p => `
    <div class="liquidity-item ${p.type === 'BSL' || p.type === 'PDH' ? 'high' : 'low'}">
      <span>${p.type}</span>
      <span class="highlight-${p.type === 'BSL' || p.type === 'PDH' ? 'red' : 'green'}">${formatPrice(p.price)}</span>
    </div>
  `).join('');
}

function updateSessionDisplay() {
  const sess = getCurrentSession();
  const container = el('session-display');
  if (!container) return;

  const cls = { 'Asian': 'asian', 'London': 'london', 'NY': 'ny', 'Off': 'off' };
  const icons = { 'Asian': '🌏', 'London': '🇬🇧', 'NY': '🇺🇸', 'Off': '💤' };
  container.innerHTML = `
    <div class="session-badge ${cls[sess.name] || 'off'}">
      ${icons[sess.name] || '⏸'} ${sess.name} Session
    </div>
    <div style="font-size:9px;color:var(--text-3);">${new Date().toUTCString().slice(17, 22)} UTC</div>
  `;
}

function renderStrategyToggles() {
  const container = el('strategy-toggles');
  if (!container) return;

  const strategies = [
    { key: 'enableS1', name: 'S1 Sweep→MSS', color: '#1e7fff', cls: 's1' },
    { key: 'enableS2', name: 'S2 Prem/Disc', color: '#9b5cf6', cls: 's2' },
    { key: 'enableS3', name: 'S3 HL Sweep', color: '#00e87a', cls: 's3' },
  ];

  container.innerHTML = strategies.map(s => `
    <div class="strategy-toggle">
      <div class="strat-info">
        <div class="strat-dot" style="background:${s.color}"></div>
        <span class="strat-name">${s.name}</span>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="toggle_${s.key}" ${state.settings[s.key] ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
  `).join('');

  strategies.forEach(s => {
    const inp = el(`toggle_${s.key}`);
    if (inp) {
      inp.addEventListener('change', () => {
        state.settings[s.key] = inp.checked;
        saveSettings();
      });
    }
  });
}

// ── SIGNALS ───────────────────────────────────────────────────────
function renderSignals() {
  const container = el('signals-container');
  if (!container) return;

  if (!state.signals.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🔍</div>
        <p>Scanning for setups...<br>Waiting for liquidity sweep + displacement + structure confirmation</p>
      </div>`;
    return;
  }

  container.innerHTML = state.signals.slice(0, 6).map(sig => `
    <div class="signal-card ${sig.status || 'pending'}">
      <div class="signal-header">
        <div class="signal-strategy ${sig.strategy.toLowerCase()}">${sig.strategyName || sig.strategy}</div>
        <div class="signal-dir ${sig.direction}">${sig.direction === 'long' ? '▲ LONG' : '▼ SHORT'}</div>
      </div>
      <div class="signal-symbol">${sig.symbol || state.settings.symbol}</div>
      <div class="signal-tf">${sig.tf || '15m'} | ${new Date(sig.time).toLocaleTimeString()}</div>
      <div class="signal-levels">
        <div class="level-item">
          <div class="level-label">Entry</div>
          <div class="level-val entry">${formatPrice(sig.entry)}</div>
        </div>
        <div class="level-item">
          <div class="level-label">SL</div>
          <div class="level-val sl">${formatPrice(sig.sl)}</div>
        </div>
        <div class="level-item">
          <div class="level-label">TP</div>
          <div class="level-val tp">${formatPrice(sig.tp)}</div>
        </div>
      </div>
      <div class="signal-rr">
        <span class="rr-badge">${sig.rr}R</span>
        <span class="signal-wr">Win Rate: ${((sig.winRate || 0.65) * 100).toFixed(0)}%</span>
        <span class="signal-time">${sig.tf}</span>
      </div>
    </div>
  `).join('');
}

// ── STATS BAR ─────────────────────────────────────────────────────
function updateStatsBar() {
  const rt = state.riskTracker;
  const closedTrades = rt.trades.filter(t => t.status === 'closed');
  const wins = closedTrades.filter(t => t.r > 0).length;
  const wr = closedTrades.length ? ((wins / closedTrades.length) * 100).toFixed(1) : '--';
  const dd = rt.getDrawdown();

  const vals = {
    'stat-equity':   `$${rt.equity.toLocaleString()}`,
    'stat-wr':       wr + '%',
    'stat-trades':   closedTrades.length,
    'stat-dd':       dd + '%',
    'stat-session':  getCurrentSession().name,
    'stat-signals':  state.signals.filter(s => s.status === 'live').length,
  };

  for (const [id, val] of Object.entries(vals)) {
    const el2 = el(id);
    if (el2) el2.textContent = val;
  }
}

// ── HEADER ────────────────────────────────────────────────────────
function updateHeaderEquity() {
  const rt = state.riskTracker;
  const headerEq = el('header-equity');
  if (headerEq) {
    const pnl = rt.equity - rt.initialEquity;
    const sign = pnl >= 0 ? '+' : '';
    headerEq.innerHTML = `<span>$${rt.equity.toLocaleString()}</span> &nbsp;<span style="color:${pnl >= 0 ? '#00e87a' : '#ff3d5a'};font-size:10px">${sign}${formatPct((pnl / rt.initialEquity) * 100)}</span>`;
  }
}

function updatePriceDisplay() {
  const el2 = el('header-price');
  if (el2) el2.textContent = formatPrice(state.lastPrice);
}

// ── ALERT LOG ────────────────────────────────────────────────────
function renderAlertLog() {
  const container = el('alert-log');
  if (!container) return;

  const log = alertManager.getLog();
  if (!log.length) {
    container.innerHTML = '<div style="font-size:9px;color:var(--text-3);text-align:center;padding:16px">No alerts yet</div>';
    return;
  }

  const stratClass = { S1: 's1', S2: 's2', S3: 's3' };
  container.innerHTML = log.slice(0, 10).map(a => `
    <div class="alert-item ${stratClass[a.strategy] || ''}">
      <div class="alert-icon">🔔</div>
      <div class="alert-text">${a.msg}</div>
      <div class="alert-time">${a.time}</div>
    </div>
  `).join('');
}

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(alert) {
  const container = el('toast-container');
  if (!container) return;

  const stratClass = { S1: 's1', S2: 's2', S3: 's3' };
  const icons = { S1: '🔵', S2: '🟣', S3: '🟢' };

  const toast = document.createElement('div');
  toast.className = `toast ${stratClass[alert.strategy] || ''}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[alert.strategy] || '🔔'}</div>
    <div class="toast-body">
      <div class="toast-title">${alert.strategy} Signal Detected</div>
      <div class="toast-msg">${alert.msg}</div>
    </div>
    <button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ── SETTINGS ─────────────────────────────────────────────────────
function renderSettingsPanel() {
  const panel = el('settings-panel');
  if (!panel) return;

  const groups = [
    {
      title: 'Risk Management',
      fields: [
        { key: 'riskPct', label: 'Risk per trade (%)', desc: '% of equity risked per trade' },
        { key: 'maxDailyRisk', label: 'Max daily risk (%)', desc: 'Kill switch daily loss %' },
        { key: 'maxDrawdownStop', label: 'Max drawdown stop (%)', desc: 'Stop trading at this DD' },
        { key: 'maxConcurrentTrades', label: 'Max concurrent trades', desc: 'Open positions limit' },
        { key: 'maxTradesPerDay', label: 'Max trades per day', desc: 'Daily trade limit' },
        { key: 'initialEquity', label: 'Account equity ($)', desc: 'Starting equity for calculations' },
      ]
    },
    {
      title: 'Entry & R:R',
      fields: [
        { key: 'minRR', label: 'Min R:R', desc: 'Minimum risk:reward to take trade' },
        { key: 'targetRR', label: 'Target R:R', desc: 'Full TP R multiple' },
        { key: 'partialRR', label: 'Partial TP R:R', desc: 'First partial take profit' },
        { key: 'slBuffer', label: 'SL buffer (ATR mult)', desc: 'Extra buffer beyond sweep wick' },
      ]
    },
    {
      title: 'Detection Engine',
      fields: [
        { key: 'atrMultiplier', label: 'ATR multiplier', desc: 'Min body size in ATR units' },
        { key: 'volumeMultiplier', label: 'Volume multiplier', desc: 'Min volume vs avg' },
        { key: 'liquidityTolerance', label: 'Liquidity tolerance', desc: 'Equal level tolerance (0.001 = 0.1%)' },
      ]
    },
    {
      title: 'Simulation',
      fields: [
        { key: 'mcIterations', label: 'Monte Carlo runs', desc: '# of simulation iterations' },
      ]
    },
  ];

  panel.innerHTML = `
    <div class="settings-grid">
      ${groups.map(g => `
        <div class="settings-section">
          <div class="settings-section-title">${g.title}</div>
          ${g.fields.map(f => `
            <div class="setting-row">
              <div>
                <div class="setting-label">${f.label}</div>
                <div class="setting-desc">${f.desc}</div>
              </div>
              <input class="setting-input" type="number" id="setting_${f.key}" value="${state.settings[f.key]}" step="any">
            </div>
          `).join('')}
        </div>
      `).join('')}
      <div class="settings-section">
        <div class="settings-section-title">Filters</div>
        <div class="setting-row">
          <div><div class="setting-label">Session filter</div><div class="setting-desc">Only trade London/NY sessions</div></div>
          <label class="toggle-switch">
            <input type="checkbox" id="setting_sessionFilter" ${state.settings.sessionFilter ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn-primary" id="save-settings-btn">Save Settings</button>
          <button class="btn-secondary" id="reset-settings-btn">Reset</button>
        </div>
      </div>
    </div>
  `;

  bindSettings();
}

function bindSettings() {
  const saveBtn = el('save-settings-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      $$('[id^=setting_]').forEach(inp => {
        const key = inp.id.replace('setting_', '');
        if (inp.type === 'checkbox') state.settings[key] = inp.checked;
        else state.settings[key] = parseFloat(inp.value) || inp.value;
      });
      state.riskTracker.settings = state.settings;
      saveSettings();
      showToast({ strategy: 'SYS', msg: 'Settings saved ✓', time: new Date().toLocaleTimeString() });
    });
  }

  const resetBtn = el('reset-settings-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      state.settings = { ...DEFAULT_SETTINGS };
      saveSettings();
      renderSettingsPanel();
    });
  }

  // Symbol selector
  const symSel = el('symbol-select');
  if (symSel) {
    symSel.value = state.settings.symbol;
    symSel.addEventListener('change', () => {
      state.settings.symbol = symSel.value;
      saveSettings();
      if (state.ws) state.ws.disconnect();
      startLiveMode();
    });
  }
}

// ── BACKTEST ─────────────────────────────────────────────────────
function initBacktest() {
  const runBtn = el('run-backtest-btn');
  if (!runBtn) return;

  runBtn.addEventListener('click', runBT);
}

async function runBT() {
  const sym    = el('bt-symbol')?.value || 'BTCUSDT';
  const strat  = el('bt-strategy')?.value || 'all';
  const from   = new Date(el('bt-from')?.value).getTime();
  const to     = new Date(el('bt-to')?.value).getTime();
  const riskPct = parseFloat(el('bt-risk')?.value) || 1;
  const minRR   = parseFloat(el('bt-minrr')?.value) || 2;

  if (!from || !to) {
    showToast({ strategy: 'SYS', msg: 'Please select a date range', time: '' }); return;
  }

  el('bt-progress-wrap').style.display = 'block';

  const btSettings = { ...state.settings, riskPct, minRR, strategy: strat, enableS1: true, enableS2: true, enableS3: true };

  try {
    const [c15m, c1H, c4H] = await Promise.all([
      fetchHistorical(sym, '15m', from, to),
      fetchHistorical(sym, '1h', from, to),
      fetchHistorical(sym, '4h', from, to),
    ]);

    const { trades, equityCurve, dailyStats } = await runBacktest(c15m, c1H, c4H, btSettings, (pct) => {
      el('bt-progress-fill').style.width = pct + '%';
      el('bt-status').textContent = `Simulating... ${pct}%`;
    });

    const metrics = calcMetrics(trades, equityCurve, btSettings.initialEquity);
    const mc = runMonteCarlo(trades, btSettings.initialEquity, btSettings.mcIterations || 1000);

    state.btResults = { trades, equityCurve, metrics, dailyStats };
    state.mcResults = mc;

    renderBTResults(metrics, trades, equityCurve, dailyStats, mc);
  } catch (e) {
    console.error('Backtest error', e);
    showToast({ strategy: 'SYS', msg: 'Backtest error: ' + e.message, time: '' });
  }

  el('bt-progress-wrap').style.display = 'none';
}

function renderBTResults(m, trades, equityCurve, dailyStats, mc) {
  if (!m) return;

  // Metrics grid
  const resultsEl = el('bt-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = `
    <div class="bt-results-grid">
      <div class="bt-metric"><div class="bt-metric-label">Win Rate</div><div class="bt-metric-val highlight-${m.winRate >= 0.55 ? 'green' : 'red'}">${(m.winRate * 100).toFixed(1)}%</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Profit Factor</div><div class="bt-metric-val highlight-${m.profitFactor >= 1.5 ? 'green' : 'red'}">${m.profitFactor}</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Expectancy</div><div class="bt-metric-val highlight-${m.expectancy >= 0 ? 'green' : 'red'}">${m.expectancy}R</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Max Drawdown</div><div class="bt-metric-val highlight-red">${m.maxDrawdown}%</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Total Return</div><div class="bt-metric-val highlight-${m.totalReturn >= 0 ? 'green' : 'red'}">${m.totalReturn}%</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Sharpe</div><div class="bt-metric-val">${m.sharpe}</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Sortino</div><div class="bt-metric-val">${m.sortino}</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Total Trades</div><div class="bt-metric-val">${m.totalTrades}</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Avg R:R</div><div class="bt-metric-val highlight-gold">${m.avgRR}</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Long WR</div><div class="bt-metric-val">${(m.longWR * 100).toFixed(1)}%</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Short WR</div><div class="bt-metric-val">${(m.shortWR * 100).toFixed(1)}%</div></div>
      <div class="bt-metric"><div class="bt-metric-label">Final Equity</div><div class="bt-metric-val highlight-green">$${m.finalEquity.toLocaleString()}</div></div>
    </div>

    <div class="equity-chart-full">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-2);">EQUITY CURVE</div>
      <canvas id="bt-equity-canvas"></canvas>
    </div>

    ${mc ? `
    <div class="mc-section">
      <div class="mc-title">🎲 Monte Carlo Simulation (${mc.iterations} runs)</div>
      <div class="mc-stats">
        <div class="mc-stat"><div class="mc-stat-label">Worst Drawdown</div><div class="mc-stat-val highlight-red">${mc.worstDD}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">Median Drawdown</div><div class="mc-stat-val">${mc.medianDD}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">Risk of Ruin</div><div class="mc-stat-val highlight-${mc.riskOfRuin > 5 ? 'red' : 'green'}">${mc.riskOfRuin}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">Median Outcome</div><div class="mc-stat-val">$${mc.medianFinal.toLocaleString()}</div></div>
      </div>
      <canvas id="bt-mc-canvas"></canvas>
    </div>` : ''}

    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:12px">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-2);">TRADE LOG</div>
      <div style="overflow-x:auto">
      <table class="trade-table">
        <thead><tr>
          <th>#</th><th>Time</th><th>Strat</th><th>Dir</th><th>Entry</th><th>Exit</th><th>R</th><th>P&L</th><th>Equity</th>
        </tr></thead>
        <tbody>
          ${trades.slice(-50).reverse().map((t, i) => `
            <tr class="${t.outcome}">
              <td>${trades.length - i}</td>
              <td>${new Date(t.time).toLocaleDateString()}</td>
              <td><span class="badge ${t.strategy === 'S1' ? 'blue' : t.strategy === 'S2' ? '' : 'green'}">${t.strategy}</span></td>
              <td>${t.direction === 'long' ? '▲' : '▼'} ${t.direction}</td>
              <td>${formatPrice(t.entry)}</td>
              <td>${formatPrice(t.exitPrice)}</td>
              <td style="color:${t.r >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${t.r > 0 ? '+' : ''}${t.r}R</td>
              <td style="color:${t.pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">${t.pnl > 0 ? '+' : ''}$${t.pnl}</td>
              <td>$${t.equity.toLocaleString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    </div>
  `;

  // Render charts after DOM update
  setTimeout(() => {
    renderBTEquityChart(equityCurve);
    if (mc) renderMCChart(mc);
  }, 50);
}

function renderBTEquityChart(curve) {
  const canvas = el('bt-equity-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = 200 * dpr;
  ctx.scale(dpr, dpr);
  drawEquityCurve(ctx, canvas.offsetWidth, 200, curve, '#00e87a');
}

function renderMCChart(mc) {
  const canvas = el('bt-mc-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = 200 * dpr;
  ctx.scale(dpr, dpr);

  const W = canvas.offsetWidth;
  const H = 200;
  const pad = 10;

  ctx.fillStyle = '#111620';
  ctx.fillRect(0, 0, W, H);

  const allValues = [...mc.curves.p10, ...mc.curves.p90];
  const hi = Math.max(...allValues);
  const lo = Math.min(...allValues);
  const range = hi - lo || 1;
  const len = mc.curves.p50.length;

  const toX = (i) => pad + (i / (len - 1)) * (W - pad * 2);
  const toY = (v) => H - pad - ((v - lo) / range) * (H - pad * 2);

  // Draw bands
  const bands = [
    { top: mc.curves.p90, bot: mc.curves.p10, color: '#1e7fff', alpha: 0.08 },
    { top: mc.curves.p75, bot: mc.curves.p25, color: '#1e7fff', alpha: 0.15 },
  ];

  for (const band of bands) {
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(band.top[0]));
    for (let i = 1; i < len; i++) ctx.lineTo(toX(i), toY(band.top[i] || band.top[band.top.length - 1]));
    for (let i = len - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(band.bot[i] || band.bot[band.bot.length - 1]));
    ctx.closePath();
    ctx.fillStyle = band.color + Math.round(band.alpha * 255).toString(16).padStart(2, '0');
    ctx.fill();
  }

  // Median line
  ctx.strokeStyle = '#1e7fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  mc.curves.p50.forEach((v, i) => {
    if (i === 0) ctx.moveTo(toX(i), toY(v));
    else ctx.lineTo(toX(i), toY(v));
  });
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#6a7e94';
  ctx.font = '8px JetBrains Mono';
  ctx.fillText('P90', W - pad - 20, toY(mc.curves.p90[mc.curves.p90.length - 1]) + 3);
  ctx.fillText('P50', W - pad - 20, toY(mc.curves.p50[mc.curves.p50.length - 1]) + 3);
  ctx.fillText('P10', W - pad - 20, toY(mc.curves.p10[mc.curves.p10.length - 1]) + 3);
}

// ── HELPERS ───────────────────────────────────────────────────────
function showLoading(containerId, show) {
  const el2 = el(containerId);
  if (!el2) return;
  let overlay = el2.querySelector('.loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'loading-overlay';
      overlay.innerHTML = `<div style="text-align:center"><div class="loading-spinner"></div><div class="loading-text">Loading market data...</div></div>`;
      el2.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();
  initBacktest();

  // TF buttons
  $$('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTF = btn.dataset.tf;
      renderChart();
    });
  });

  // Window resize
  window.addEventListener('resize', () => {
    if (state.activeView === 'live') renderChart();
  });
});
