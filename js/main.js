// main.js — SMC Prop Engine v3.0
import { candleStore } from './data/candleStore.js';
import { fetchMultiTF, fetchHistorical, fetchAllSpotUSDTSymbols } from './data/restLoader.js';
import { BinanceWS } from './data/websocket.js';
import { getBiasAllTF, getAlignedBias } from './core/biasEngine.js';
import { mapLiquidityPools } from './core/liquidityEngine.js';
import { getCurrentSession } from './core/sessionEngine.js';
import { scan_S1, scan_S2, scan_S3 } from './strategies/smc_strategies.js';
import { RiskTracker } from './core/riskEngine.js';
import { runBacktest } from './backtest/simulator.js';
import { calcMetrics } from './backtest/metrics.js';
import { runMonteCarlo } from './backtest/monteCarlo.js';
import { alertManager } from './alerts/alertManager.js';
import { formatPrice, formatPct, round } from './utils/math.js';

// ── CURRENCIES / TIMEZONES ─────────────────────────────────────────
const CURRENCIES = { USD:'$',EUR:'€',GBP:'£',JPY:'¥',INR:'₹',CAD:'C$',AUD:'A$',CHF:'Fr',SGD:'S$',HKD:'HK$',KRW:'₩',BRL:'R$',MXN:'MX$',TRY:'₺',AED:'AED' };
const TIMEZONES = ['UTC','America/New_York','America/Chicago','America/Los_Angeles','Europe/London','Europe/Paris','Europe/Berlin','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo','Asia/Shanghai','Australia/Sydney'];

// ── DEFAULT SETTINGS ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  symbol:'BTCUSDT', riskPct:1, minRR:2, targetRR:3, slBuffer:0.5,
  atrMultiplier:1.2, volumeMultiplier:1.2,
  maxDailyRisk:5, maxConcurrentTrades:1, maxDrawdownStop:15,
  sessionFilter:false, enableS1:true, enableS2:true, enableS3:true,
  onlyLongs:true, liquidityTolerance:0.0015, mcIterations:500,
  initialEquity:10000, currency:'USD', timezone:'UTC',
  pushNotifications:false,
};

// ── STATE ─────────────────────────────────────────────────────────
const state = {
  settings:{...DEFAULT_SETTINGS},
  activeView:'live', activeTF:'15m',
  signals:[], biases:{'15m':'neutral','1H':'neutral','4H':'neutral'},
  ws:null, riskTracker:null,
  btResults:null, btTrades:[], btPage:1, btCancelled:false,
  lastPrice:0, liquidityPools:null,
  scanSymbols:[], scanIntervalId:null, scanRunning:false,
  manualTrades:[],  // user-entered trades
};

// ── PERSIST ───────────────────────────────────────────────────────
function loadSettings() {
  try { const s=localStorage.getItem('smc_v3'); if(s) state.settings={...DEFAULT_SETTINGS,...JSON.parse(s)}; } catch(e){}
}
function saveSettings() {
  try { localStorage.setItem('smc_v3',JSON.stringify(state.settings)); } catch(e){}
}
function loadManualTrades() {
  try { const t=localStorage.getItem('smc_manual_trades'); if(t) state.manualTrades=JSON.parse(t); } catch(e){}
}
function saveManualTrades() {
  try { localStorage.setItem('smc_manual_trades',JSON.stringify(state.manualTrades)); } catch(e){}
}

// ── HELPERS ───────────────────────────────────────────────────────
const $$ = s => document.querySelectorAll(s);
const el = id => document.getElementById(id);
const currSym = () => CURRENCIES[state.settings.currency]||'$';
function fmtTZ(ts) {
  try { return new Date(ts).toLocaleString('en-US',{timeZone:state.settings.timezone||'UTC',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  catch(e){ return new Date(ts).toLocaleString(); }
}
function fmtPct(v) { return (v>=0?'+':'')+round(v,2)+'%'; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── INIT ──────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  loadManualTrades();
  state.riskTracker = new RiskTracker(state.settings.initialEquity, state.settings);
  await alertManager.init();
  bindNavTabs();
  renderSidebar();
  renderSettingsPanel();
  updateHeaderEquity();
  await startLiveMode();
  showView('live');
  startScanLoop();
}

// ── VIEW SWITCHING ────────────────────────────────────────────────
function bindNavTabs() {
  $$('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.nav-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      showView(view);
      if(view==='analytics') renderAnalytics();
      if(view==='trades') renderManualTrades();
    });
  });
}
function showView(view) {
  state.activeView=view;
  $$('.view-panel').forEach(p=>p.classList.remove('active'));
  el(`view-${view}`)?.classList.add('active');
}

// ── LIVE MODE ─────────────────────────────────────────────────────
async function startLiveMode() {
  const sym=state.settings.symbol;
  showLoading('main-canvas-container',true);
  try {
    const data=await fetchMultiTF(sym);
    ['15m','1H','4H'].forEach(tf=>candleStore.set(sym,tf,data[tf]));
    state.lastPrice=data['15m'].slice(-1)[0]?.close||0;
    updatePriceDisplay();
    runLiveAnalysis();
    renderChart();
    if(state.ws) state.ws.disconnect();
    state.ws=new BinanceWS(sym,['15m','1H','4H'],onWsUpdate);
    state.ws.connect();
    setInterval(updateHeaderEquity,5000);
    setInterval(updateSessionDisplay,60000);
  } catch(e) {
    console.error('Live mode error:',e);
    showToast({strategy:'SYS',msg:'Data load error: '+e.message,time:''});
  }
  showLoading('main-canvas-container',false);
}
function onWsUpdate(sym,tf,candle) {
  state.lastPrice=candle.close;
  updatePriceDisplay();
  if(tf==='15m'&&candle.closed){ runLiveAnalysis(); if(state.activeView==='live') renderChart(); }
}

// ── SCAN LOOP (every 15 min, ALL spot USDT pairs) ─────────────────
async function startScanLoop() {
  await runFullScan();
  if(state.scanIntervalId) clearInterval(state.scanIntervalId);
  state.scanIntervalId = setInterval(runFullScan, 15 * 60 * 1000);
}

async function runFullScan() {
  if(state.scanRunning) return;
  state.scanRunning = true;
  setScanStatus('Fetching symbol list...');

  let symbols;
  try {
    const allSyms = await fetchAllSpotUSDTSymbols();
    // ALL symbols, refreshed every scan — deduplicated automatically
    symbols = allSyms.map(s=>s.symbol);
    state.scanSymbols = symbols;
  } catch(e) {
    symbols = [state.settings.symbol];
    state.scanSymbols = symbols;
  }

  setScanStatus(`Scanning ${symbols.length} spot pairs...`);

  let scanned = 0;
  let found = 0;

  for(const sym of symbols) {
    try {
      // Always refresh candles for every scan
      const data = await fetchMultiTF(sym);
      candleStore.set(sym,'15m',data['15m']);
      candleStore.set(sym,'1H', data['1H']);
      candleStore.set(sym,'4H', data['4H']);

      // Scan all 3 strategies
      const c15m = data['15m'];
      const c1H  = data['1H'];
      const results = [];

      if(state.settings.enableS1) { try { const s=scan_S1(c15m,state.settings); if(s) results.push(s); } catch(e){} }
      if(state.settings.enableS2) { try { const s=scan_S2(c15m,c1H,state.settings); if(s) results.push(s); } catch(e){} }
      if(state.settings.enableS3) { try { const s=scan_S3(c15m,c1H,state.settings); if(s) results.push(s); } catch(e){} }

      for(const sig of results) {
        if(state.settings.onlyLongs && sig.direction !== 'long') continue;
        const isDup = state.signals.some(x=>x.strategy===sig.strategy&&x.symbol===sym&&Math.abs(x.time-(sig.time||Date.now()))<15*60*1000);
        if(!isDup) {
          const full = {...sig, symbol:sym, status:'live', time:sig.time||Date.now()};
          state.signals.unshift(full);
          alertManager.fire({...full, msg:`${sig.strategyName} | ${sig.direction.toUpperCase()} | Entry:${formatPrice(sig.entry)} TP:${formatPrice(sig.tp)} (+${sig.pctGain}%)`}, showToast);
          sendPush(full);
          found++;
        }
      }
    } catch(e) { /* skip symbol */ }

    scanned++;
    if(scanned % 20 === 0) {
      setScanStatus(`Scanning... ${scanned}/${symbols.length} (${found} signals)`);
      await sleep(50);
    }
    await sleep(100); // rate limit: ~10 req/s
  }

  state.signals = state.signals.slice(0,100);
  setScanStatus(`Last scan: ${new Date().toLocaleTimeString()} — ${symbols.length} pairs, ${found} signals`);

  if(state.activeView==='live') { renderSignals(); renderAlertLog(); }
  state.scanRunning = false;
}

function setScanStatus(msg) {
  const e=el('scan-status'); if(e) e.textContent=msg;
}

// ── ANALYSIS ──────────────────────────────────────────────────────
function runLiveAnalysis() {
  const sym=state.settings.symbol;
  const c15m=candleStore.get(sym,'15m');
  const c1H=candleStore.get(sym,'1H');
  const c4H=candleStore.get(sym,'4H');
  if(!c15m.length) return;
  try { state.biases=getBiasAllTF(c1H,c4H,c15m); } catch(e){}
  try { state.liquidityPools=mapLiquidityPools(c1H,state.settings.liquidityTolerance); } catch(e){}
  updateSidebarBias();
  updateSidebarLiquidity();
  updateStatsBar();
  renderSignals();
}

// ── CHART ─────────────────────────────────────────────────────────
function renderChart() {
  const canvas=el('main-canvas'); if(!canvas) return;
  const sym=state.settings.symbol;
  const candles=candleStore.get(sym,state.activeTF); if(!candles.length) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  const cont=el('main-canvas-container');
  const rect=cont.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=(rect.height-44)*dpr;
  canvas.style.width=rect.width+'px'; canvas.style.height=(rect.height-44)+'px';
  ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height-44;
  const PAD={top:20,right:72,bottom:30,left:12};
  const display=candles.slice(-80);
  const prices=display.flatMap(c=>[c.high,c.low]);
  let hi=Math.max(...prices),lo=Math.min(...prices);
  const mg=(hi-lo)*0.08; hi+=mg; lo-=mg;
  const cW=W-PAD.left-PAD.right,cH=H-PAD.top-PAD.bottom;
  const bW=cW/display.length,cdW=Math.max(2,bW*0.65);
  const toX=i=>PAD.left+i*bW+bW/2;
  const toY=p=>PAD.top+cH-((p-lo)/(hi-lo))*cH;
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#1a2535'; ctx.lineWidth=0.5;
  for(let i=0;i<=6;i++) {
    const y=PAD.top+(cH/6)*i;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.fillStyle='#3d5169'; ctx.font='9px JetBrains Mono'; ctx.textAlign='left';
    ctx.fillText(formatPrice(hi-((hi-lo)/6)*i),W-PAD.right+4,y+3);
  }
  // Liquidity lines
  if(state.liquidityPools) {
    for(const p of state.liquidityPools.slice(0,12)) {
      if(p.price<lo||p.price>hi) continue;
      const y=toY(p.price),bull=p.type.startsWith('S')&&p.type!=='SH';
      ctx.strokeStyle=bull?'rgba(0,232,122,0.35)':'rgba(255,61,90,0.35)';
      ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=ctx.strokeStyle; ctx.font='8px JetBrains Mono';
      ctx.fillText(p.type,W-PAD.right-28,y-2);
    }
  }
  // Signal levels
  for(const sig of state.signals.filter(s=>s.symbol===sym).slice(0,3)) {
    if(!sig.entry) continue;
    [['entry','#00d4ff'],['sl','#ff3d5a'],['tp','#00e87a']].forEach(([k,c])=>{
      const price=sig[k]; if(!price||price<lo||price>hi) return;
      const y=toY(price); ctx.strokeStyle=c; ctx.lineWidth=1.5;
      ctx.setLineDash(k==='entry'?[]:[4,3]); ctx.globalAlpha=0.8;
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.globalAlpha=1; ctx.setLineDash([]);
    });
  }
  // Candles
  for(let i=0;i<display.length;i++) {
    const c=display[i],x=toX(i),bull=c.close>=c.open,col=bull?'#00e87a':'#ff3d5a';
    ctx.strokeStyle=col; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,toY(c.high)); ctx.lineTo(x,toY(c.low)); ctx.stroke();
    ctx.fillStyle=col; ctx.globalAlpha=bull?0.85:0.7;
    ctx.fillRect(x-cdW/2,Math.min(toY(c.open),toY(c.close)),cdW,Math.max(1,Math.abs(toY(c.open)-toY(c.close))));
    ctx.globalAlpha=1;
  }
  // Current price
  if(state.lastPrice>lo&&state.lastPrice<hi) {
    const y=toY(state.lastPrice);
    ctx.strokeStyle='#f5c842'; ctx.lineWidth=1; ctx.setLineDash([2,4]);
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#f5c842'; ctx.fillRect(W-PAD.right,y-7,PAD.right-2,14);
    ctx.fillStyle='#080a0e'; ctx.font='bold 9px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText(formatPrice(state.lastPrice),W-PAD.right/2,y+3); ctx.textAlign='left';
  }
}

// ── SIDEBAR ───────────────────────────────────────────────────────
function renderSidebar() {
  updateSidebarBias(); updateSidebarLiquidity(); updateSessionDisplay(); renderStrategyToggles();
}
function updateSidebarBias() {
  const c=el('bias-container'); if(!c) return;
  c.innerHTML=Object.entries(state.biases).map(([tf,bias])=>`
    <div class="bias-card"><div class="bias-tf">${tf}</div>
    <div class="bias-val ${bias==='bullish'?'bull':bias==='bearish'?'bear':'neutral'}">
      ${bias==='bullish'?'▲':bias==='bearish'?'▼':'◆'} ${bias.toUpperCase()}</div></div>`).join('');
  const aligned=getAlignedBias(state.biases);
  const e=el('aligned-bias'); if(e){
    e.className=`bias-val ${aligned==='bullish'?'bull':aligned==='bearish'?'bear':'neutral'}`;
    e.textContent=`${aligned==='bullish'?'▲':aligned==='bearish'?'▼':'◆'} ${aligned.toUpperCase()}`;
  }
}
function updateSidebarLiquidity() {
  const c=el('liquidity-container'); if(!c) return;
  c.innerHTML=`${(state.liquidityPools||[]).slice(0,8).map(p=>`
    <div class="liquidity-item ${p.type==='BSL'||p.type==='PDH'||p.type==='SH'?'high':'low'}">
      <span>${p.type}</span>
      <span class="highlight-${p.type==='BSL'||p.type==='PDH'?'red':'green'}">${formatPrice(p.price)}</span>
    </div>`).join('')||'<div style="font-size:9px;color:var(--text-3);text-align:center;padding:8px">Loading...</div>'}`;
}
function updateSessionDisplay() {
  const sess=getCurrentSession(),c=el('session-display'); if(!c) return;
  const cls={Asian:'asian',London:'london',NY:'ny',Off:'off'};
  const icons={Asian:'🌏',London:'🇬🇧',NY:'🇺🇸',Off:'💤'};
  c.innerHTML=`<div class="session-badge ${cls[sess.name]||'off'}">${icons[sess.name]||'⏸'} ${sess.name}</div>
    <div style="font-size:9px;color:var(--text-3)">${new Date().toLocaleTimeString('en',{timeZone:state.settings.timezone||'UTC',hour:'2-digit',minute:'2-digit'})} ${(state.settings.timezone||'UTC').split('/').pop()}</div>`;
}
function renderStrategyToggles() {
  const c=el('strategy-toggles'); if(!c) return;
  const strats=[{key:'enableS1',name:'S1 HH Sweep',color:'#1e7fff'},{key:'enableS2',name:'S2 Range Sweep',color:'#9b5cf6'},{key:'enableS3',name:'S3 SSL+MSS',color:'#00e87a'}];
  c.innerHTML=strats.map(s=>`<div class="strategy-toggle"><div class="strat-info"><div class="strat-dot" style="background:${s.color}"></div><span class="strat-name">${s.name}</span></div><label class="toggle-switch"><input type="checkbox" id="toggle_${s.key}" ${state.settings[s.key]?'checked':''}><span class="toggle-slider"></span></label></div>`).join('');
  strats.forEach(s=>{ const i=el(`toggle_${s.key}`); if(i) i.addEventListener('change',()=>{ state.settings[s.key]=i.checked; saveSettings(); }); });
}

// ── SIGNALS ───────────────────────────────────────────────────────
function renderSignals() {
  const c=el('signals-container'); if(!c) return;
  const symSigs = state.signals;
  if(!symSigs.length) {
    c.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>Scanning all Binance spot USDT pairs every 15 min<br>All 3 strategies running — waiting for setups</p></div>`;
    return;
  }
  c.innerHTML=symSigs.slice(0,6).map((sig,i)=>`
    <div class="signal-card ${sig.status||'pending'}">
      <div class="signal-header">
        <div class="signal-strategy ${sig.strategy.toLowerCase()}">${sig.strategyName||sig.strategy}</div>
        <div class="signal-dir ${sig.direction}">▲ LONG</div>
      </div>
      <div class="signal-symbol">${sig.symbol||'?'}</div>
      <div class="signal-tf">${sig.tf||'15m'} | ${fmtTZ(sig.time)}</div>
      <div class="signal-levels">
        <div class="level-item"><div class="level-label">Entry</div><div class="level-val entry">${formatPrice(sig.entry)}</div></div>
        <div class="level-item"><div class="level-label">SL</div><div class="level-val sl">${formatPrice(sig.sl)}</div></div>
        <div class="level-item"><div class="level-label">TP</div><div class="level-val tp">${formatPrice(sig.tp)}</div></div>
      </div>
      <div class="signal-rr">
        <span class="rr-badge">${sig.rr}R</span>
        <span style="color:var(--accent-green);font-weight:600;font-size:10px">+${sig.pctGain}%</span>
        <span style="display:flex;gap:3px">
          <button onclick="openSignalChart(${i})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);padding:2px 7px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">📊</button>
          <button onclick="openSignalReason(${i})" style="background:rgba(155,92,246,0.1);border:1px solid rgba(155,92,246,0.2);color:var(--accent-purple);padding:2px 7px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">📋</button>
          <button onclick="addToManual(${i})" style="background:rgba(0,232,122,0.1);border:1px solid rgba(0,232,122,0.2);color:var(--accent-green);padding:2px 7px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">➕</button>
        </span>
      </div>
    </div>`).join('');
}
window.openSignalChart=(i)=>openChartModal(state.signals[i]);
window.openSignalReason=(i)=>openReasonModal(state.signals[i]);
window.addToManual=(i)=>{
  const sig=state.signals[i]; if(!sig) return;
  openAddTradeModal(sig);
};

// ── MANUAL TRADE TRACKING ─────────────────────────────────────────
function openAddTradeModal(prefill) {
  const modal=el('add-trade-modal'); if(!modal) return;
  if(prefill) {
    el('mt-symbol').value=prefill.symbol||'';
    el('mt-strategy').value=prefill.strategy||'manual';
    el('mt-entry').value=prefill.entry||'';
    el('mt-sl').value=prefill.sl||'';
    el('mt-tp').value=prefill.tp||'';
    el('mt-size').value='';
  }
  modal.style.display='flex';
}
window.openAddTradeModal=openAddTradeModal;

function initManualTradeModal() {
  el('add-trade-btn')?.addEventListener('click',()=>openAddTradeModal(null));
  el('save-trade-btn')?.addEventListener('click',()=>{
    const symbol=(el('mt-symbol')?.value||'').toUpperCase().trim();
    const strategy=el('mt-strategy')?.value||'manual';
    const entry=parseFloat(el('mt-entry')?.value);
    const sl=parseFloat(el('mt-sl')?.value);
    const tp=parseFloat(el('mt-tp')?.value);
    const size=parseFloat(el('mt-size')?.value)||0;
    const status=el('mt-status')?.value||'open';
    const notes=el('mt-notes')?.value||'';
    const exitPrice=parseFloat(el('mt-exit')?.value)||null;

    if(!symbol||!entry||!sl||!tp) { showToast({strategy:'SYS',msg:'Fill in symbol, entry, SL, TP',time:''}); return; }

    const riskPerUnit=entry-sl;
    const rr=riskPerUnit>0?round(Math.abs(tp-entry)/riskPerUnit,2):0;
    const pctGain=round(((tp-entry)/entry)*100,2);
    const equity=state.settings.initialEquity;
    const riskAmt=size>0?(entry-sl)*size:(equity*(state.settings.riskPct/100));

    let pnl=null,outcome=null,actualPctGain=null;
    if(exitPrice&&status==='closed') {
      pnl=round((exitPrice-entry)*Math.max(size,riskAmt/Math.max(entry-sl,0.0001)),2);
      outcome=pnl>=0?'win':'loss';
      actualPctGain=round(((exitPrice-entry)/entry)*100,2);
    }

    const trade={
      id:Date.now(),
      time:Date.now(),
      symbol,strategy,entry,sl,tp,size,status,notes,
      exitPrice:exitPrice||null,
      rr,pctGain,riskAmt,pnl,outcome,actualPctGain,
      direction:'long',
    };

    state.manualTrades.unshift(trade);
    saveManualTrades();
    el('add-trade-modal').style.display='none';
    if(state.activeView==='trades') renderManualTrades();
    showToast({strategy:'SYS',msg:`Trade ${symbol} added to journal`,time:new Date().toLocaleTimeString()});
  });

  $$('.modal-close').forEach(btn=>btn.addEventListener('click',()=>btn.closest('.modal-overlay').style.display='none'));
  $$('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m) m.style.display='none';}));
}

function renderManualTrades() {
  const c=el('manual-trades-container'); if(!c) return;
  const trades=state.manualTrades;
  if(!trades.length) {
    c.innerHTML=`<div class="empty-state"><div class="empty-icon">📝</div><p>No trades logged yet.<br>Click "+ Add Trade" or use ➕ on any signal to log your setups.</p></div>`;
    renderTradeJournalStats([]);
    return;
  }
  renderTradeJournalStats(trades);
  const sym=currSym();
  c.innerHTML=`<div style="overflow-x:auto"><table class="trade-table">
    <thead><tr><th>Symbol</th><th>Strat</th><th>Entry</th><th>SL</th><th>TP</th><th>Status</th><th>R:R</th><th>Expected%</th><th>Exit</th><th>Actual%</th><th>P&L</th><th>Notes</th><th>Actions</th></tr></thead>
    <tbody>${trades.map((t,i)=>`<tr class="${t.outcome||''}">
      <td style="font-weight:700;color:var(--text-0)">${t.symbol}</td>
      <td><span class="badge ${t.strategy==='S1'?'blue':t.strategy==='S2'?'':'green'}">${t.strategy}</span></td>
      <td>${formatPrice(t.entry)}</td>
      <td style="color:var(--accent-red)">${formatPrice(t.sl)}</td>
      <td style="color:var(--accent-green)">${formatPrice(t.tp)}</td>
      <td><span style="padding:2px 7px;border-radius:12px;font-size:9px;background:${t.status==='open'?'rgba(0,212,255,0.1)':t.status==='closed'&&t.outcome==='win'?'rgba(0,232,122,0.1)':'rgba(255,61,90,0.1)'};color:${t.status==='open'?'var(--accent-cyan)':t.status==='closed'&&t.outcome==='win'?'var(--accent-green)':'var(--accent-red)'};">${t.status.toUpperCase()}</span></td>
      <td style="color:var(--accent-gold);font-weight:600">${t.rr}R</td>
      <td style="color:var(--accent-green);font-weight:600">+${t.pctGain}%</td>
      <td>${t.exitPrice?formatPrice(t.exitPrice):'—'}</td>
      <td style="color:${t.actualPctGain>=0?'var(--accent-green)':'var(--accent-red)'};font-weight:600">${t.actualPctGain!=null?fmtPct(t.actualPctGain):'—'}</td>
      <td style="color:${t.pnl>=0?'var(--accent-green)':'var(--accent-red)'}">${t.pnl!=null?sym+Math.abs(t.pnl):'—'}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2);font-size:9px">${t.notes||'—'}</td>
      <td>
        <button onclick="editTrade(${i})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);padding:2px 7px;border-radius:3px;font-size:9px;cursor:pointer;font-family:inherit;margin-right:3px">✏️</button>
        <button onclick="deleteTrade(${i})" style="background:rgba(255,61,90,0.1);border:1px solid rgba(255,61,90,0.2);color:var(--accent-red);padding:2px 7px;border-radius:3px;font-size:9px;cursor:pointer;font-family:inherit">🗑</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderTradeJournalStats(trades) {
  const c=el('journal-stats'); if(!c) return;
  const sym=currSym();
  const closed=trades.filter(t=>t.status==='closed'&&t.pnl!=null);
  const open=trades.filter(t=>t.status==='open');
  const wins=closed.filter(t=>t.pnl>0);
  const totalPnl=round(closed.reduce((s,t)=>s+t.pnl,0),2);
  const wr=closed.length?round((wins.length/closed.length)*100,1):0;
  const avgGain=wins.length?round(wins.reduce((s,t)=>s+(t.actualPctGain||0),0)/wins.length,2):0;
  const avgLoss=closed.filter(t=>t.pnl<0).length?round(Math.abs(closed.filter(t=>t.pnl<0).reduce((s,t)=>s+(t.actualPctGain||0),0)/closed.filter(t=>t.pnl<0).length),2):0;
  c.innerHTML=`
    <div class="jstat"><div class="jstat-label">Total Trades</div><div class="jstat-val">${trades.length}</div></div>
    <div class="jstat"><div class="jstat-label">Open</div><div class="jstat-val" style="color:var(--accent-cyan)">${open.length}</div></div>
    <div class="jstat"><div class="jstat-label">Win Rate</div><div class="jstat-val ${wr>=50?'green':'red'}">${wr}%</div></div>
    <div class="jstat"><div class="jstat-label">Total P&L</div><div class="jstat-val ${totalPnl>=0?'green':'red'}">${totalPnl>=0?'+':''}${sym}${Math.abs(totalPnl)}</div></div>
    <div class="jstat"><div class="jstat-label">Avg Win %</div><div class="jstat-val green">+${avgGain}%</div></div>
    <div class="jstat"><div class="jstat-label">Avg Loss %</div><div class="jstat-val red">-${avgLoss}%</div></div>`;
}

window.editTrade=(i)=>{
  const t=state.manualTrades[i]; if(!t) return;
  openAddTradeModal(t);
  el('save-trade-btn').onclick=()=>{
    const exit=parseFloat(el('mt-exit')?.value)||null;
    const status=el('mt-status')?.value||t.status;
    const notes=el('mt-notes')?.value||'';
    state.manualTrades[i]={...t,exitPrice:exit,status,notes};
    if(exit&&status==='closed') {
      state.manualTrades[i].pnl=round((exit-t.entry)*Math.max(t.size||0,(t.riskAmt||0)/Math.max(t.entry-t.sl,0.0001)),2);
      state.manualTrades[i].outcome=state.manualTrades[i].pnl>=0?'win':'loss';
      state.manualTrades[i].actualPctGain=round(((exit-t.entry)/t.entry)*100,2);
    }
    saveManualTrades();
    el('add-trade-modal').style.display='none';
    renderManualTrades();
  };
};
window.deleteTrade=(i)=>{
  if(confirm('Delete this trade?')) {
    state.manualTrades.splice(i,1);
    saveManualTrades();
    renderManualTrades();
  }
};

// ── STATS ─────────────────────────────────────────────────────────
function updateStatsBar() {
  const rt=state.riskTracker;
  const closed=rt.trades.filter(t=>t.status==='closed');
  const wins=closed.filter(t=>t.r>0);
  const wr=closed.length?((wins.length/closed.length)*100).toFixed(1):'--';
  const sym=currSym();
  [['stat-equity',`${sym}${rt.equity.toLocaleString()}`],['stat-wr',wr+'%'],['stat-trades',closed.length],['stat-dd',rt.getDrawdown()+'%'],['stat-session',getCurrentSession().name],['stat-signals',state.signals.length]].forEach(([id,v])=>{ const e=el(id); if(e) e.textContent=v; });
}
function updateHeaderEquity() {
  const rt=state.riskTracker,e=el('header-equity'); if(!e) return;
  const pnl=rt.equity-rt.initialEquity,sym=currSym();
  e.innerHTML=`<span>${sym}${rt.equity.toLocaleString()}</span>&nbsp;<span style="color:${pnl>=0?'#00e87a':'#ff3d5a'};font-size:10px">${pnl>=0?'+':''}${fmtPct((pnl/rt.initialEquity)*100)}</span>`;
}
function updatePriceDisplay() {
  const e=el('header-price'); if(e) e.textContent=formatPrice(state.lastPrice);
}

// ── ALERT LOG ─────────────────────────────────────────────────────
function renderAlertLog() {
  const c=el('alert-log'); if(!c) return;
  const log=alertManager.getLog();
  if(!log.length){ c.innerHTML='<div style="font-size:9px;color:var(--text-3);text-align:center;padding:16px">No alerts yet</div>'; return; }
  const sc={S1:'s1',S2:'s2',S3:'s3'};
  c.innerHTML=log.slice(0,20).map((a,i)=>`
    <div class="alert-item ${sc[a.strategy]||''}">
      <div class="alert-icon">🔔</div>
      <div class="alert-text" style="flex:1;min-width:0;overflow:hidden">
        <div style="font-weight:600;font-size:10px">${a.strategy} ${a.symbol||''} <span style="color:var(--accent-green)">+${a.pctGain||'?'}%</span></div>
        <div style="color:var(--text-2);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.msg||''}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">
        <div class="alert-time">${a.time}</div>
        <div style="display:flex;gap:2px">
          <button onclick="openAlertChart(${i})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);width:20px;height:18px;border-radius:3px;cursor:pointer;font-size:9px">📊</button>
          <button onclick="openAlertReason(${i})" style="background:rgba(155,92,246,0.1);border:1px solid rgba(155,92,246,0.2);color:var(--accent-purple);width:20px;height:18px;border-radius:3px;cursor:pointer;font-size:9px">📋</button>
        </div>
      </div>
    </div>`).join('');
}
window.openAlertChart=(i)=>{ const l=alertManager.getLog(); if(l[i]) openChartModal(l[i]); };
window.openAlertReason=(i)=>{ const l=alertManager.getLog(); if(l[i]) openReasonModal(l[i]); };

// ── PUSH ──────────────────────────────────────────────────────────
async function requestPushPermission() {
  if(!('Notification' in window)) return;
  const p=await Notification.requestPermission();
  state.settings.pushNotifications=p==='granted';
  saveSettings(); updatePushBtn();
}
function sendPush(sig) {
  if(!state.settings.pushNotifications||Notification.permission!=='granted') return;
  try { new Notification(`🔔 ${sig.strategy} LONG — ${sig.symbol} +${sig.pctGain}%`,{
    body:`Entry:${formatPrice(sig.entry)} | SL:${formatPrice(sig.sl)} | TP:${formatPrice(sig.tp)} | ${sig.rr}R`,
    tag:`smc-${sig.strategy}-${sig.symbol}`,requireInteraction:false,
  }); } catch(e){}
}
function updatePushBtn() {
  const btn=el('push-perm-btn'); if(!btn) return;
  const ok=Notification.permission==='granted';
  btn.textContent=ok?'🔔 Push: ON':'🔕 Enable Push';
  btn.style.color=ok?'var(--accent-green)':'var(--accent-orange)';
}

// ── CHART MODAL ───────────────────────────────────────────────────
function openChartModal(sig) {
  if(!sig) return;
  const modal=el('chart-modal'); if(!modal) return;
  el('modal-title').textContent=`${sig.symbol||'?'} — ${sig.strategyName||sig.strategy} LONG +${sig.pctGain}%`;
  modal.style.display='flex';
  setTimeout(()=>drawSignalCanvas(sig),60);
}
function drawSignalCanvas(sig) {
  const canvas=el('modal-canvas'); if(!canvas) return;
  const sym=sig.symbol||state.settings.symbol;
  const candles=candleStore.get(sym,'15m');
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=canvas.offsetHeight*dpr;
  ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=canvas.offsetHeight;
  if(!candles.length) {
    ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#3d5169'; ctx.font='13px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText('No candle data for '+sym,W/2,H/2); return;
  }
  const PAD={top:44,right:80,bottom:44,left:14};
  const display=candles.slice(-60);
  const allP=display.flatMap(c=>[c.high,c.low]);
  if(sig.entry) allP.push(sig.entry,sig.sl,sig.tp);
  let hi=Math.max(...allP),lo=Math.min(...allP);
  const mg=(hi-lo)*0.1; hi+=mg; lo-=mg;
  const cW=W-PAD.left-PAD.right,cH=H-PAD.top-PAD.bottom;
  const bW=cW/display.length,cdW=Math.max(2,bW*0.65);
  const toX=i=>PAD.left+i*bW+bW/2;
  const toY=p=>PAD.top+cH-((p-lo)/(hi-lo))*cH;
  ctx.fillStyle='#0a0d12'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#1a2535'; ctx.lineWidth=0.5;
  for(let i=0;i<=6;i++) {
    const y=PAD.top+(cH/6)*i;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.fillStyle='#3d5169'; ctx.font='9px JetBrains Mono'; ctx.textAlign='left';
    ctx.fillText(formatPrice(hi-((hi-lo)/6)*i),W-PAD.right+4,y+3);
  }
  if(sig.entry&&sig.sl&&sig.tp) {
    const eY=toY(sig.entry),slY=toY(sig.sl),tpY=toY(sig.tp);
    ctx.fillStyle='rgba(255,61,90,0.07)'; ctx.fillRect(PAD.left,Math.min(eY,slY),cW,Math.abs(eY-slY));
    ctx.fillStyle='rgba(0,232,122,0.06)'; ctx.fillRect(PAD.left,Math.min(eY,tpY),cW,Math.abs(eY-tpY));
  }
  for(let i=0;i<display.length;i++) {
    const c=display[i],x=toX(i),bull=c.close>=c.open,col=bull?'#00e87a':'#ff3d5a';
    ctx.strokeStyle=col; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,toY(c.high)); ctx.lineTo(x,toY(c.low)); ctx.stroke();
    ctx.fillStyle=col; ctx.globalAlpha=bull?0.85:0.7;
    ctx.fillRect(x-cdW/2,Math.min(toY(c.open),toY(c.close)),cdW,Math.max(1,Math.abs(toY(c.open)-toY(c.close))));
    ctx.globalAlpha=1;
  }
  if(sig.entry) {
    [{price:sig.entry,color:'#00d4ff',label:'ENTRY',dash:[]},{price:sig.sl,color:'#ff3d5a',label:'STOP',dash:[4,3]},{price:sig.tp,color:'#00e87a',label:'TARGET',dash:[4,3]}].forEach(lv=>{
      if(!lv.price||lv.price<lo||lv.price>hi) return;
      const y=toY(lv.price);
      ctx.strokeStyle=lv.color; ctx.lineWidth=1.5; ctx.setLineDash(lv.dash);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=lv.color+'20';
      ctx.fillRect(PAD.left+4,y-9,ctx.measureText(lv.label).width+14,17);
      ctx.fillStyle=lv.color; ctx.font='bold 9px JetBrains Mono';
      ctx.fillText(lv.label,PAD.left+11,y+3);
      ctx.fillStyle=lv.color; ctx.fillRect(W-PAD.right,y-8,PAD.right-2,16);
      ctx.fillStyle='#080a0e'; ctx.font='bold 8px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText(formatPrice(lv.price),W-PAD.right/2,y+3); ctx.textAlign='left';
    });
  }
  ctx.fillStyle='rgba(8,10,14,0.92)'; ctx.fillRect(0,0,W,PAD.top);
  ctx.fillStyle='#e8eef6'; ctx.font='bold 13px Syne,sans-serif'; ctx.textAlign='left';
  ctx.fillText(`${sym} · 15m · ${sig.strategyName||sig.strategy}`,PAD.left+4,18);
  ctx.fillStyle='#00e87a'; ctx.font='11px JetBrains Mono';
  ctx.fillText(`▲ LONG  |  ${sig.rr}R  |  +${sig.pctGain}%  |  ${fmtTZ(sig.time)}`,PAD.left+4,36);
  ctx.fillStyle='rgba(8,10,14,0.85)'; ctx.fillRect(0,H-PAD.bottom,W,PAD.bottom);
  ctx.fillStyle='#3d5169'; ctx.font='8px JetBrains Mono'; ctx.textAlign='center';
  ctx.fillText(`Entry: ${formatPrice(sig.entry)}  |  Stop: ${formatPrice(sig.sl)}  |  Target: ${formatPrice(sig.tp)}  |  Expected: +${sig.pctGain}%`,W/2,H-PAD.bottom+14);
  ctx.fillText(`SPOT TRADING ONLY — No leverage`,W/2,H-PAD.bottom+28);
}

// ── REASON MODAL ──────────────────────────────────────────────────
function openReasonModal(sig) {
  if(!sig) return;
  const modal=el('reasoning-modal'); if(!modal) return;
  el('reasoning-title').textContent=`${sig.symbol||'?'} ${sig.strategyName||sig.strategy}`;
  el('reasoning-body').textContent=sig.reasoning||'No reasoning available';
  modal.style.display='flex';
}

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(a) {
  const c=el('toast-container'); if(!c) return;
  const sc={S1:'s1',S2:'s2',S3:'s3'};
  const t=document.createElement('div');
  t.className=`toast ${sc[a.strategy]||''}`;
  t.innerHTML=`<div class="toast-icon">${a.strategy==='S1'?'🔵':a.strategy==='S2'?'🟣':a.strategy==='S3'?'🟢':'⚙️'}</div><div class="toast-body"><div class="toast-title">${a.strategy} ${a.symbol?'— '+a.symbol:''} ${a.pctGain?'<span style="color:var(--accent-green)">+'+a.pctGain+'%</span>':''}</div><div class="toast-msg">${a.msg||''}</div></div><button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('out'); setTimeout(()=>t.remove(),300); },7000);
}

// ── SETTINGS ─────────────────────────────────────────────────────
function renderSettingsPanel() {
  const panel=el('settings-panel'); if(!panel) return;
  const s=state.settings;
  const currOpts=Object.entries(CURRENCIES).map(([c,sym])=>`<option value="${c}" ${s.currency===c?'selected':''}>${c} (${sym})</option>`).join('');
  const tzOpts=TIMEZONES.map(tz=>`<option value="${tz}" ${s.timezone===tz?'selected':''}>${tz}</option>`).join('');
  panel.innerHTML=`<div class="settings-grid">
    <div class="settings-section">
      <div class="settings-section-title">Risk Management (SPOT)</div>
      ${sr('riskPct','Risk per trade (%)','% of capital risked')}
      ${sr('maxDailyRisk','Max daily risk (%)','Kill switch')}
      ${sr('maxDrawdownStop','Max drawdown stop (%)','Halt threshold')}
      ${sr('initialEquity','Account capital','Your spot capital')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Strategy Filters</div>
      ${sr('minRR','Min R:R','Skip below this')}
      ${sr('slBuffer','SL buffer (ATR mult)','Extra buffer beyond sweep')}
      ${sr('atrMultiplier','ATR multiplier','Displacement body threshold')}
      <div class="setting-row">
        <div><div class="setting-label">Only Long Trades</div><div class="setting-desc">Spot-only mode (no shorts)</div></div>
        <label class="toggle-switch"><input type="checkbox" id="setting_onlyLongs" ${s.onlyLongs?'checked':''}><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Display & Locale</div>
      <div class="setting-row">
        <div><div class="setting-label">Currency</div><div class="setting-desc">P&amp;L symbol</div></div>
        <select id="setting_currency" style="width:100px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-0);font-family:inherit;padding:5px 6px;border-radius:4px;font-size:10px">${currOpts}</select>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Timezone</div><div class="setting-desc">All timestamps</div></div>
        <select id="setting_timezone" style="width:160px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-0);font-family:inherit;padding:5px 6px;border-radius:4px;font-size:10px">${tzOpts}</select>
      </div>
      ${sr('mcIterations','Monte Carlo runs','Simulation iterations')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Notifications</div>
      <div class="setting-row">
        <div><div class="setting-label">Session filter</div><div class="setting-desc">London/NY only</div></div>
        <label class="toggle-switch"><input type="checkbox" id="setting_sessionFilter" ${s.sessionFilter?'checked':''}><span class="toggle-slider"></span></label>
      </div>
      <div style="margin-top:10px">
        <button id="push-perm-btn" style="background:rgba(255,140,26,0.1);border:1px solid rgba(255,140,26,0.3);color:var(--accent-orange);padding:8px 14px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;width:100%">🔕 Enable Push</button>
        <div style="font-size:8px;color:var(--text-3);margin-top:6px;line-height:1.6">On mobile: Add to Home Screen for persistent alerts even when browser is closed.</div>
      </div>
    </div>
    <div class="settings-section" style="grid-column:1/-1">
      <div class="settings-section-title" style="color:var(--accent-orange)">Scanner</div>
      <div style="font-size:10px;color:var(--text-1);line-height:1.8">
        The scanner automatically fetches <strong>ALL</strong> Binance Spot USDT pairs every 15 minutes.<br>
        All symbols are refreshed on every scan cycle.<br>
        Min daily volume: <strong>$500k</strong> (filters illiquid tokens)<br>
        Leveraged/margin tokens (3L, 3S, BULL, BEAR) are excluded automatically.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn-primary" id="save-settings-btn">💾 Save Settings</button>
        <button class="btn-secondary" id="reset-settings-btn">↺ Reset</button>
        <button class="btn-secondary" id="force-scan-btn" style="color:var(--accent-cyan);border-color:rgba(0,212,255,0.3)">🔄 Force Rescan Now</button>
      </div>
      <div id="save-msg" style="display:none;margin-top:8px;color:var(--accent-green);font-size:10px">✅ Settings saved</div>
    </div>
  </div>`;
  el('save-settings-btn')?.addEventListener('click',()=>{
    document.querySelectorAll('[id^=setting_]').forEach(inp=>{
      const k=inp.id.replace('setting_','');
      if(inp.type==='checkbox') state.settings[k]=inp.checked;
      else if(inp.tagName==='SELECT') state.settings[k]=inp.value;
      else state.settings[k]=isNaN(parseFloat(inp.value))?inp.value:parseFloat(inp.value);
    });
    saveSettings();
    const msg=el('save-msg'); if(msg){msg.style.display='block';setTimeout(()=>msg.style.display='none',3000);}
    renderSidebar();
  });
  el('reset-settings-btn')?.addEventListener('click',()=>{state.settings={...DEFAULT_SETTINGS};saveSettings();renderSettingsPanel();});
  el('force-scan-btn')?.addEventListener('click',()=>{ state.scanRunning=false; runFullScan(); });
  el('push-perm-btn')?.addEventListener('click',requestPushPermission);
  updatePushBtn();
}
function sr(key,label,desc){ return `<div class="setting-row"><div><div class="setting-label">${label}</div><div class="setting-desc">${desc}</div></div><input class="setting-input" type="number" id="setting_${key}" value="${state.settings[key]}" step="any"></div>`; }

// ── BACKTEST ──────────────────────────────────────────────────────
function initBacktest() {
  el('run-backtest-btn')?.addEventListener('click', runBT);
  el('stop-backtest-btn')?.addEventListener('click',()=>{ state.btCancelled=true; });
}

async function runBT() {
  const sym   = el('bt-symbol')?.value||'BTCUSDT';
  const strat = el('bt-strategy')?.value||'all';
  const from  = new Date(el('bt-from')?.value).getTime();
  const to    = new Date(el('bt-to')?.value).getTime();
  const riskPct = parseFloat(el('bt-risk')?.value)||1;
  const minRR   = parseFloat(el('bt-minrr')?.value)||2;

  if(!from||!to||isNaN(from)||isNaN(to)){showToast({strategy:'SYS',msg:'Select a valid date range',time:''});return;}
  state.btCancelled=false; state.btPage=1;
  el('bt-progress-wrap').style.display='block';
  el('stop-backtest-btn').style.display='inline-block';
  el('run-backtest-btn').disabled=true;
  el('bt-results').innerHTML='<div class="empty-state"><div class="loading-spinner"></div><div class="loading-text" style="margin-top:8px">Loading historical data...</div></div>';

  const btSettings={...state.settings,riskPct,minRR,strategy:strat,enableS1:true,enableS2:true,enableS3:true};

  try {
    el('bt-status').textContent='Fetching candles from Binance...';
    const [c15m,c1H,c4H]=await Promise.all([
      fetchHistorical(sym,'15m',from,to),
      fetchHistorical(sym,'1h', from,to),
      fetchHistorical(sym,'4h', from,to),
    ]);
    if(!c15m.length){showToast({strategy:'SYS',msg:'No historical data returned',time:''});el('run-backtest-btn').disabled=false;return;}
    el('bt-status').textContent=`${c15m.length} candles. Simulating...`;

    const {trades,equityCurve,dailyStats}=await runBacktest(c15m,c1H,c4H,btSettings,(pct)=>{
      if(state.btCancelled) throw new Error('CANCELLED');
      el('bt-progress-fill').style.width=pct+'%';
      el('bt-status').textContent=`Simulating... ${pct}%  (${trades?.length||0} trades found)`;
    });

    const metrics=calcMetrics(trades,equityCurve,btSettings.initialEquity);
    const mc=runMonteCarlo(trades,btSettings.initialEquity,btSettings.mcIterations||500);

    state.btResults={trades,equityCurve,metrics,dailyStats,sym};
    state.btTrades=trades; state.btPage=1;

    renderBTResults(metrics,trades,equityCurve,dailyStats,mc,sym,btSettings.initialEquity);
    if(state.activeView==='analytics') renderAnalytics();
  } catch(e) {
    if(e.message==='CANCELLED') el('bt-status').textContent='Stopped by user.';
    else { showToast({strategy:'SYS',msg:'BT error: '+e.message,time:''}); console.error(e); }
  }
  el('bt-progress-wrap').style.display='none';
  el('stop-backtest-btn').style.display='none';
  el('run-backtest-btn').disabled=false;
}

function renderBTResults(m,trades,equityCurve,dailyStats,mc,sym,initEq) {
  if(!m){ el('bt-results').innerHTML='<div class="empty-state"><div class="empty-icon">⚠️</div><p>No trades found in this range.<br>Try wider date range or lower min R:R.</p></div>'; return; }
  const cs=currSym();
  const totalReturnSign=m.totalReturn>=0?'+':'';

  el('bt-results').innerHTML=`
    <div style="background:var(--bg-3);border:1px solid rgba(0,232,122,0.2);border-radius:var(--radius-lg);padding:12px 16px;margin-bottom:12px;display:flex;gap:24px;flex-wrap:wrap;align-items:center">
      <div><div style="font-size:9px;color:var(--text-3);text-transform:uppercase">Symbol</div><div style="font-size:14px;font-weight:700;color:var(--text-0)">${sym}</div></div>
      <div><div style="font-size:9px;color:var(--text-3)">Initial Capital</div><div style="font-size:14px;font-weight:700">${cs}${initEq.toLocaleString()}</div></div>
      <div><div style="font-size:9px;color:var(--text-3)">Final Capital</div><div style="font-size:14px;font-weight:700;color:var(--accent-green)">${cs}${m.finalEquity.toLocaleString()}</div></div>
      <div><div style="font-size:9px;color:var(--text-3)">Total Return</div><div style="font-size:20px;font-weight:800;color:${m.totalReturn>=0?'var(--accent-green)':'var(--accent-red)'}">${totalReturnSign}${m.totalReturn}%</div></div>
      <div><div style="font-size:9px;color:var(--text-3)">Total Trades</div><div style="font-size:14px;font-weight:700">${m.totalTrades}</div></div>
      <div style="background:rgba(0,232,122,0.05);border:1px solid rgba(0,232,122,0.15);border-radius:8px;padding:8px 12px">
        <div style="font-size:9px;color:var(--text-3)">Avg Win / Trade</div>
        <div style="font-size:14px;font-weight:700;color:var(--accent-green)">+${m.avgPctGainPerWin}%</div>
      </div>
      <div style="background:rgba(255,61,90,0.05);border:1px solid rgba(255,61,90,0.15);border-radius:8px;padding:8px 12px">
        <div style="font-size:9px;color:var(--text-3)">Avg Loss / Trade</div>
        <div style="font-size:14px;font-weight:700;color:var(--accent-red)">-${m.avgPctLossPerLoss}%</div>
      </div>
    </div>
    <div class="bt-results-grid">
      ${bm('Win Rate',m.winRatePct+'%',m.winRate>=0.55)}
      ${bm('Profit Factor',m.profitFactor,m.profitFactor>=1.5)}
      ${bm('Expectancy',cs+m.expectancy,m.expectancy>=0)}
      ${bm('Max Drawdown',m.maxDrawdown+'%',m.maxDrawdown<15)}
      ${bm('Sharpe',m.sharpe,m.sharpe>=1)}
      ${bm('Sortino',m.sortino,m.sortino>=1)}
      ${bm('Avg R:R',m.avgRR,m.avgRR>=2)}
      ${bm('Gross Win',cs+m.grossWin,true)}
      ${bm('Gross Loss',cs+m.grossLoss,false)}
      ${bm('Long WR',m.longWR+'%',m.longWR>=55)}
    </div>

    <div class="equity-chart-full" style="margin-bottom:10px">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-2);display:flex;justify-content:space-between">
        <span>EQUITY CURVE</span>
        <span style="color:${m.totalReturn>=0?'var(--accent-green)':'var(--accent-red)'};font-weight:700">${totalReturnSign}${m.totalReturn}% total return</span>
      </div>
      <canvas id="bt-equity-canvas" style="width:100%;height:200px;display:block"></canvas>
    </div>

    ${mc?`<div class="mc-section">
      <div class="mc-title">🎲 Monte Carlo (${mc.iterations} shuffles)</div>
      <div class="mc-stats">
        <div class="mc-stat"><div class="mc-stat-label">Worst DD</div><div class="mc-stat-val highlight-red">${mc.worstDD}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">Median DD</div><div class="mc-stat-val">${mc.medianDD}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">Risk of Ruin</div><div class="mc-stat-val highlight-${mc.riskOfRuin>5?'red':'green'}">${mc.riskOfRuin}%</div></div>
        <div class="mc-stat"><div class="mc-stat-label">P50 Final</div><div class="mc-stat-val">${cs}${mc.medianFinal.toLocaleString()}</div></div>
        <div class="mc-stat"><div class="mc-stat-label">P10 Final</div><div class="mc-stat-val highlight-red">${cs}${mc.p10Final.toLocaleString()}</div></div>
        <div class="mc-stat"><div class="mc-stat-label">P90 Final</div><div class="mc-stat-val highlight-green">${cs}${mc.p90Final.toLocaleString()}</div></div>
      </div>
      <canvas id="bt-mc-canvas" style="width:100%;height:150px;display:block"></canvas>
    </div>`:''}

    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:12px">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <span style="font-size:10px;color:var(--text-2)">TRADE LOG — ${trades.length} trades | ${m.wins} wins ${m.losses} losses</span>
        <div id="bt-pagination" style="display:flex;gap:4px;align-items:center"></div>
      </div>
      <div style="overflow-x:auto" id="bt-table-wrap"></div>
    </div>`;

  setTimeout(()=>{ drawEquityCurveCanvas('bt-equity-canvas',equityCurve,200,'#00e87a'); drawMCCanvas(mc); renderTradeTable(1); },60);
}

function bm(label,val,ok){ return `<div class="bt-metric"><div class="bt-metric-label">${label}</div><div class="bt-metric-val highlight-${ok?'green':'red'}">${val}</div></div>`; }

const BT_PG=100;
function renderTradeTable(page) {
  state.btPage=page;
  const trades=state.btTrades,total=trades.length;
  const totalPages=Math.ceil(total/BT_PG);
  const start=(page-1)*BT_PG;
  const pageTrades=[...trades].slice(start,start+BT_PG).reverse();
  const cs=currSym();
  const pag=el('bt-pagination');
  if(pag) pag.innerHTML=`${page>1?`<button onclick="renderTradeTable(${page-1})" class="btn-secondary" style="padding:3px 10px;font-size:10px">← Prev</button>`:''}<span style="font-size:9px;color:var(--text-2);padding:0 8px">Page ${page}/${totalPages}</span>${page<totalPages?`<button onclick="renderTradeTable(${page+1})" class="btn-secondary" style="padding:3px 10px;font-size:10px">Next →</button>`:''}`;
  const wrap=el('bt-table-wrap'); if(!wrap) return;
  wrap.innerHTML=`<table class="trade-table"><thead><tr><th>#</th><th>Open Time</th><th>Close Time</th><th>Strat</th><th>Entry</th><th>Exit</th><th>SL</th><th>TP</th><th>R</th><th>P&L</th><th>Gain %</th><th>Equity</th><th>Equity %</th><th>📊</th></tr></thead><tbody>
    ${pageTrades.map((t,i)=>{
      const absIdx=trades.indexOf(t);
      const equityPct=round(((t.equity-(state.btResults?.metrics?.finalEquity||t.equity))/state.settings.initialEquity)*100,1);
      return `<tr class="${t.outcome}">
        <td>${total-start-i}</td>
        <td style="white-space:nowrap;font-size:9px">${fmtTZ(t.time)}</td>
        <td style="white-space:nowrap;font-size:9px">${fmtTZ(t.exitTime||t.time)}</td>
        <td><span class="badge ${t.strategy==='S1'?'blue':t.strategy==='S2'?'':'green'}">${t.strategy}</span></td>
        <td>${formatPrice(t.entry)}</td>
        <td>${formatPrice(t.exitPrice)}</td>
        <td style="color:var(--accent-red)">${formatPrice(t.sl)}</td>
        <td style="color:var(--accent-green)">${formatPrice(t.tp)}</td>
        <td style="color:${t.r>=0?'var(--accent-green)':'var(--accent-red)'};font-weight:600">${t.r>0?'+':''}${t.r}R</td>
        <td style="color:${t.pnl>=0?'var(--accent-green)':'var(--accent-red)'}">${t.pnl>0?'+':''}${cs}${Math.abs(t.pnl)}</td>
        <td style="color:${t.gainPct>=0?'var(--accent-green)':'var(--accent-red)'};font-weight:700">${t.gainPct>0?'+':''}${t.gainPct}%</td>
        <td>${cs}${t.equity?.toLocaleString()}</td>
        <td style="color:${t.equityPct>=0?'var(--accent-green)':'var(--accent-red)'}">${t.equityPct>0?'+':''}${t.equityPct}%</td>
        <td><button onclick="openBtChart(${absIdx})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);padding:2px 7px;border-radius:3px;font-size:9px;cursor:pointer;font-family:inherit">📊</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
window.renderTradeTable=renderTradeTable;
window.openBtChart=(i)=>{
  const t=state.btTrades[i]; if(!t) return;
  openChartModal({symbol:el('bt-symbol')?.value||'?',strategy:t.strategy,strategyName:t.strategy,direction:'long',entry:t.entry,sl:t.sl,tp:t.tp,rr:t.rr,time:t.time,pctGain:t.gainPct,reasoning:`Backtest Trade #${i+1}\nOutcome: ${t.outcome}\nGain: ${t.gainPct}%\nR: ${t.r}R\nP&L: ${currSym()}${t.pnl}`});
};

function drawEquityCurveCanvas(canvasId,curve,h,color) {
  const canvas=el(canvasId); if(!canvas) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=h*dpr; ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=h,pad=10;
  const hi=Math.max(...curve),lo=Math.min(...curve),range=hi-lo||1;
  const toX=i=>pad+(i/(curve.length-1))*(W-pad*2);
  const toY=v=>H-pad-((v-lo)/range)*(H-pad*2);
  ctx.fillStyle='#111620'; ctx.fillRect(0,0,W,H);
  // zero line
  const zeroY=toY(lo<0?0:lo);
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=0.5;
  ctx.beginPath(); ctx.moveTo(pad,zeroY); ctx.lineTo(W-pad,zeroY); ctx.stroke();
  const grad=ctx.createLinearGradient(0,pad,0,H-pad);
  grad.addColorStop(0,color+'40'); grad.addColorStop(1,color+'00');
  ctx.fillStyle=grad; ctx.beginPath(); ctx.moveTo(toX(0),toY(curve[0]));
  for(let i=1;i<curve.length;i++) ctx.lineTo(toX(i),toY(curve[i]));
  ctx.lineTo(toX(curve.length-1),H); ctx.lineTo(toX(0),H); ctx.closePath(); ctx.fill();
  ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath();
  curve.forEach((v,i)=>i===0?ctx.moveTo(toX(i),toY(v)):ctx.lineTo(toX(i),toY(v)));
  ctx.stroke();
}

function drawMCCanvas(mc) {
  if(!mc) return;
  const canvas=el('bt-mc-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=150*dpr; ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=150,pad=10;
  ctx.fillStyle='#111620'; ctx.fillRect(0,0,W,H);
  const allV=[...mc.curves.p10,...mc.curves.p90];
  const hi=Math.max(...allV),lo=Math.min(...allV),range=hi-lo||1;
  const len=mc.curves.p50.length;
  const toX=i=>pad+(i/(len-1))*(W-pad*2);
  const toY=v=>H-pad-((v-lo)/range)*(H-pad*2);
  [{top:mc.curves.p90,bot:mc.curves.p10,a:0.07},{top:mc.curves.p75,bot:mc.curves.p25,a:0.13}].forEach(b=>{
    ctx.beginPath(); ctx.moveTo(toX(0),toY(b.top[0]));
    for(let i=1;i<len;i++) ctx.lineTo(toX(i),toY(b.top[Math.min(i,b.top.length-1)]));
    for(let i=len-1;i>=0;i--) ctx.lineTo(toX(i),toY(b.bot[Math.min(i,b.bot.length-1)]));
    ctx.closePath(); ctx.fillStyle='#1e7fff'+Math.round(b.a*255).toString(16).padStart(2,'0'); ctx.fill();
  });
  ctx.strokeStyle='#1e7fff'; ctx.lineWidth=2; ctx.beginPath();
  mc.curves.p50.forEach((v,i)=>i===0?ctx.moveTo(toX(i),toY(v)):ctx.lineTo(toX(i),toY(v)));
  ctx.stroke();
  ctx.fillStyle='#6a7e94'; ctx.font='8px JetBrains Mono';
  ['p90','p50','p10'].forEach(k=>ctx.fillText(k.toUpperCase(),W-pad-22,toY(mc.curves[k][mc.curves[k].length-1])+3));
}

// ── ANALYTICS ─────────────────────────────────────────────────────
function renderAnalytics() {
  const c=el('analytics-content'); if(!c) return;
  const m=state.btResults?.metrics,trades=state.btTrades||[],daily=state.btResults?.dailyStats||{};
  if(!m||!trades.length) {
    c.innerHTML='<div class="analytics-card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-icon">📉</div><p>Run a backtest first</p></div></div>';
    return;
  }
  const cs=currSym();
  const mHTML=Object.entries(daily).sort().map(([mo,d])=>`<div class="monthly-row"><span>${mo}</span><span>${d.wins}W/${d.losses}L</span><span style="color:${d.pnl>=0?'var(--accent-green)':'var(--accent-red)'};font-weight:600">${d.pnl>=0?'+':''}${cs}${Math.abs(d.pnl.toFixed(0))}</span><span style="color:${d.pnl>=0?'var(--accent-green)':'var(--accent-red)'}">+${round((d.pnl/state.settings.initialEquity)*100,2)}%</span></div>`).join('');
  const sHTML=(m.stratBreakdown||[]).map(s=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:10px"><span class="badge ${s.strategy==='S1'?'blue':s.strategy==='S2'?'':'green'}">${s.strategy}</span><span>${s.trades} trades</span><span style="color:${s.wr>=0.5?'var(--accent-green)':'var(--accent-red)'}">${round(s.wr*100,1)}%</span><span style="color:var(--accent-gold)">${s.avgR>0?'+':''}${s.avgR}R</span><span style="color:${s.pctGain>=0?'var(--accent-green)':'var(--accent-red)'}">${s.pctGain>0?'+':''}${s.pctGain}%</span></div>`).join('');
  c.innerHTML=`
    <div class="analytics-card"><div class="analytics-card-title">📅 Monthly P&L</div><div style="max-height:250px;overflow-y:auto">${mHTML||'No data'}</div></div>
    <div class="analytics-card"><div class="analytics-card-title">🎯 Per Strategy</div>${sHTML}</div>
    <div class="analytics-card"><div class="analytics-card-title">📊 Statistics</div>${[['Win Rate',m.winRatePct+'%',m.winRate>=0.55],['Profit Factor',m.profitFactor,m.profitFactor>=1.5],['Expectancy',cs+m.expectancy,m.expectancy>=0],['Total Return',m.totalReturn+'%',m.totalReturn>=0],['Max Drawdown',m.maxDrawdown+'%',m.maxDrawdown<15],['Sharpe',m.sharpe,m.sharpe>=1],['Avg Win%','+'+m.avgPctGainPerWin+'%',true],['Avg Loss%','-'+m.avgPctLossPerLoss+'%',true]].map(([l,v,ok])=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:10px"><span style="color:var(--text-2)">${l}</span><span style="color:${ok?'var(--accent-green)':'var(--accent-red)'};font-weight:600">${v}</span></div>`).join('')}</div>
    <div class="analytics-card"><div class="analytics-card-title">📈 Equity</div><canvas id="ana-eq-canvas" style="width:100%;height:180px;display:block"></canvas></div>`;
  setTimeout(()=>{ drawEquityCurveCanvas('ana-eq-canvas',state.btResults.equityCurve,180,'#00e87a'); },50);
}

// ── LOADING ───────────────────────────────────────────────────────
function showLoading(id,show) {
  const e=el(id); if(!e) return;
  let ov=e.querySelector('.loading-overlay');
  if(show) { if(!ov){ov=document.createElement('div');ov.className='loading-overlay';ov.innerHTML='<div style="text-align:center"><div class="loading-spinner"></div><div class="loading-text">Loading market data...</div></div>';e.appendChild(ov);} }
  else ov?.remove();
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  init();
  initBacktest();
  initManualTradeModal();

  $$('.tf-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $$('.tf-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTF=btn.dataset.tf;
      renderChart();
    });
  });
  window.addEventListener('resize',()=>{ if(state.activeView==='live') renderChart(); });
});
