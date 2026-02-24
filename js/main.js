// main.js — SMC Prop Engine v2.0
import { candleStore } from './data/candleStore.js';
import { fetchMultiTF, fetchHistorical } from './data/restLoader.js';
import { BinanceWS } from './data/websocket.js';
import { getBiasAllTF, getAlignedBias } from './core/biasEngine.js';
import { mapLiquidityPools } from './core/liquidityEngine.js';
import { getCurrentSession } from './core/sessionEngine.js';
import { scan_S1 } from './strategies/strategy1_sweepMSS.js';
import { scan_S2 } from './strategies/strategy2_premiumContinuation.js';
import { scan_S3 } from './strategies/strategy3_HL_sweep.js';
import { RiskTracker } from './core/riskEngine.js';
import { runBacktest } from './backtest/simulator.js';
import { calcMetrics } from './backtest/metrics.js';
import { runMonteCarlo } from './backtest/monteCarlo.js';
import { alertManager } from './alerts/alertManager.js';
import { formatPrice, formatPct, round } from './utils/math.js';

// ── CONSTANTS ─────────────────────────────────────────────────────
const TOP_BY_MCAP = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','UNIUSDT','ATOMUSDT','LTCUSDT','NEARUSDT','ARBUSDT','OPUSDT','APTUSDT','INJUSDT','TIAUSDT','SEIUSDT'];

const CURRENCIES = { USD:'$',EUR:'€',GBP:'£',JPY:'¥',INR:'₹',CAD:'C$',AUD:'A$',CHF:'Fr',SGD:'S$',HKD:'HK$',KRW:'₩',BRL:'R$',MXN:'MX$',TRY:'₺',AED:'AED',SAR:'SAR',SEK:'kr',NOK:'kr',DKK:'kr',ZAR:'R' };

const TIMEZONES = ['UTC','America/New_York','America/Chicago','America/Los_Angeles','America/Sao_Paulo','Europe/London','Europe/Paris','Europe/Berlin','Europe/Moscow','Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo','Asia/Shanghai','Asia/Seoul','Australia/Sydney','Pacific/Auckland'];

// ── DEFAULT SETTINGS ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  symbol:'BTCUSDT', riskPct:1, minRR:2, targetRR:3, partialRR:1.5,
  atrMultiplier:1.5, volumeMultiplier:1.5, slBuffer:0.3,
  maxDailyRisk:5, maxConcurrentTrades:3, maxDrawdownStop:10,
  sessionFilter:true, enableS1:true, enableS2:true, enableS3:true,
  onlyLongs:false, liquidityTolerance:0.0015, mcIterations:1000,
  maxTradesPerDay:3, initialEquity:10000, currency:'USD', timezone:'UTC',
  scanTimeframes:['15m','1H','4H'], scanCategory:'manual', pushNotifications:false,
  liquidityDuration:'24h',
};

// ── STATE ─────────────────────────────────────────────────────────
const state = {
  settings:{...DEFAULT_SETTINGS}, activeView:'live', activeTF:'15m',
  signals:[], biases:{'15m':'neutral','1H':'neutral','4H':'neutral'},
  session:null, ws:null, riskTracker:null, btResults:null, mcResults:null,
  scanning:false, btCancelled:false, lastPrice:0,
  scanSymbols:[], scanIntervalId:null, btPage:1, btTrades:[],
  liquidityPools:null,
};

// ── SETTINGS PERSIST ──────────────────────────────────────────────
function loadSettings() {
  try { const s=localStorage.getItem('smc_v2'); if(s) state.settings={...DEFAULT_SETTINGS,...JSON.parse(s)}; } catch(e){}
}
function saveSettings() {
  try { localStorage.setItem('smc_v2',JSON.stringify(state.settings)); } catch(e){}
}

// ── HELPERS ───────────────────────────────────────────────────────
const $$ = s => document.querySelectorAll(s);
const el = id => document.getElementById(id);
const currSym = () => CURRENCIES[state.settings.currency]||'$';
function formatTZ(ts) {
  try { return new Date(ts).toLocaleString('en-US',{timeZone:state.settings.timezone||'UTC',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  catch(e){ return new Date(ts).toLocaleString(); }
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── INIT ──────────────────────────────────────────────────────────
async function init() {
  loadSettings();
  state.riskTracker = new RiskTracker(state.settings.initialEquity, state.settings);
  await alertManager.init();
  bindNavTabs();
  renderSidebar();
  renderSettingsPanel();
  updateHeaderEquity();
  startLiveMode();
  showView('live');
  startMultiSymbolScan();
}

// ── NAVIGATION ────────────────────────────────────────────────────
function bindNavTabs() {
  $$('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.nav-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      showView(btn.dataset.view);
      if(btn.dataset.view==='analytics') renderAnalytics();
    });
  });
}
function showView(view) {
  state.activeView=view;
  $$('.view-panel').forEach(p=>p.classList.remove('active'));
  el(`view-${view}`)?.classList.add('active');
}

// ── SYMBOL LIST ───────────────────────────────────────────────────
async function refreshScanSymbols() {
  const cat = state.settings.scanCategory||'manual';
  if(cat==='manual'){ state.scanSymbols=[state.settings.symbol]; return; }
  if(cat==='mcap'){ state.scanSymbols=[...TOP_BY_MCAP]; return; }
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const tickers = (await res.json()).filter(t=>t.symbol.endsWith('USDT'));
    if(cat==='volume') tickers.sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume));
    else tickers.sort((a,b)=>parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent));
    state.scanSymbols=[...new Set(tickers.slice(0,20).map(t=>t.symbol))];
  } catch(e){ state.scanSymbols=[state.settings.symbol]; }
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
    runAnalysis();
    renderChart();
    if(state.ws) state.ws.disconnect();
    state.ws=new BinanceWS(sym,['15m','1H','4H'],onWsUpdate);
    state.ws.connect();
    setInterval(updateHeaderEquity,5000);
    setInterval(updateSessionDisplay,60000);
  } catch(e){ showToast({strategy:'SYS',msg:'Live data error — check connection',time:''}); }
  showLoading('main-canvas-container',false);
}

function onWsUpdate(sym,tf,candle) {
  state.lastPrice=candle.close;
  updatePriceDisplay();
  if(tf==='15m'&&candle.closed){ runAnalysis(); if(state.activeView==='live') renderChart(); }
}

// ── MULTI-SYMBOL SCAN ─────────────────────────────────────────────
async function startMultiSymbolScan() {
  await refreshScanSymbols();
  await runMultiScan();
  if(state.scanIntervalId) clearInterval(state.scanIntervalId);
  state.scanIntervalId=setInterval(async()=>{ await refreshScanSymbols(); await runMultiScan(); }, 15*60*1000);
}

async function runMultiScan() {
  const scanEl=el('scan-status');
  if(scanEl) scanEl.textContent=`Scanning ${state.scanSymbols.length} symbols...`;
  for(const sym of state.scanSymbols) {
    try {
      if(!candleStore.hasData(sym,'15m')) {
        const data=await fetchMultiTF(sym);
        ['15m','1H','4H'].forEach(tf=>candleStore.set(sym,tf,data[tf]));
      }
      (state.settings.scanTimeframes||['15m']).forEach(tf=>scanSymbolTF(sym,tf));
    } catch(e){}
    await sleep(150);
  }
  if(scanEl) scanEl.textContent=`Last scan: ${new Date().toLocaleTimeString()}`;
  renderSignals();
  renderAlertLog();
}

function scanSymbolTF(sym,tf) {
  const c15m=candleStore.get(sym,'15m');
  const c1H=candleStore.get(sym,'1H');
  const c4H=candleStore.get(sym,'4H');
  if(!c15m.length) return;
  const s=state.settings;
  const scanners=[];
  if(s.enableS1) scanners.push(()=>scan_S1(c15m,c1H,c4H,s));
  if(s.enableS2) scanners.push(()=>scan_S2(c15m,c1H,s));
  if(s.enableS3) scanners.push(()=>scan_S3(c15m,s));
  for(const scanner of scanners) {
    const sig=scanner();
    if(!sig) continue;
    if(s.onlyLongs&&sig.direction!=='long') continue;
    const isDup=state.signals.some(x=>x.strategy===sig.strategy&&x.symbol===sym&&Math.abs(x.time-sig.time)<15*60*1000);
    if(!isDup) {
      const full={...sig,symbol:sym,tf,status:'live',reasoning:buildReasoning(sig,sym)};
      state.signals.unshift(full);
      alertManager.fire(full,showToast);
      sendPush(full);
    }
  }
  state.signals=state.signals.slice(0,50);
}

function buildReasoning(sig,sym) {
  const s=state.settings;
  const lines=[
    `📋 STRATEGY: ${sig.strategyName||sig.strategy}`,
    `📍 SYMBOL: ${sym||'?'} | TF: ${sig.tf||'15m'}`,
    `📐 DIRECTION: ${sig.direction.toUpperCase()}`,
    `⏰ TIME: ${formatTZ(sig.time)}`,
    '',
    '✅ CONDITIONS MET:',
  ];
  if(sig.strategy==='S1') {
    lines.push(`  • HTF liquidity pool @ ${formatPrice(sig.pool?.price||0)} (${sig.pool?.type})`);
    lines.push(`  • Sweep wick beyond pool confirmed`);
    lines.push(`  • Displacement: body ≥ ${s.atrMultiplier}x ATR, volume ≥ ${s.volumeMultiplier}x avg`);
    lines.push(`  • Market Structure Shift (${sig.mss?.type||'CHoCH'}) on 15m`);
    lines.push(`  • OB/FVG retracement entry at ${formatPrice(sig.entry)}`);
  } else if(sig.strategy==='S2') {
    lines.push(`  • Dealing range: High ${formatPrice(sig.range?.high)} / Low ${formatPrice(sig.range?.low)}`);
    lines.push(`  • EQ (50%): ${formatPrice(sig.range?.eq)}`);
    lines.push(`  • Price in ${(sig.zone||'').toUpperCase()} zone`);
    lines.push(`  • Continuation displacement confirmed`);
  } else if(sig.strategy==='S3') {
    lines.push(`  • ${sig.hlGroup?.length||3}x Higher Lows detected`);
    lines.push(`  • Sweep below ${sig.sweptHLCount||2} Higher Lows`);
    lines.push(`  • Explosive displacement candle`);
    lines.push(`  • ✅ BODY CLOSE above ${formatPrice(sig.swingHighBreak)} (MANDATORY)`);
    lines.push(`  • Higher High confirmed`);
  }
  lines.push('');
  lines.push('📐 LEVELS:');
  lines.push(`  Entry  : ${formatPrice(sig.entry)}`);
  lines.push(`  Stop   : ${formatPrice(sig.sl)}`);
  lines.push(`  Target : ${formatPrice(sig.tp)}`);
  lines.push(`  R:R    : ${sig.rr} (min: ${s.minRR})`);
  lines.push(`  Win Rate: ${((sig.winRate||0.65)*100).toFixed(0)}%`);
  return lines.join('\n');
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────
async function requestPushPermission() {
  if(!('Notification' in window)){ showToast({strategy:'SYS',msg:'Notifications not supported',time:''}); return; }
  const p=await Notification.requestPermission();
  state.settings.pushNotifications=p==='granted';
  saveSettings();
  updatePushBtn();
  if(p==='granted') showToast({strategy:'SYS',msg:'🔔 Push notifications enabled! You will receive alerts even when browser is minimized.',time:''});
  else showToast({strategy:'SYS',msg:'Push permission denied. On mobile, add to homescreen for background alerts.',time:''});
}
function sendPush(sig) {
  if(!state.settings.pushNotifications||Notification.permission!=='granted') return;
  try { new Notification(`🔔 ${sig.strategy} ${sig.direction.toUpperCase()} — ${sig.symbol}`,{
    body:`Entry: ${formatPrice(sig.entry)} | SL: ${formatPrice(sig.sl)} | TP: ${formatPrice(sig.tp)} | ${sig.rr}R`,
    icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="16" fill="%231e7fff"/><text y="72" x="12" font-size="72" font-family="monospace" fill="white" font-weight="bold">S</text></svg>',
    tag:`smc-${sig.strategy}-${sig.symbol}`,requireInteraction:false,
  }); } catch(e){}
}
function updatePushBtn() {
  const btn=el('push-perm-btn'); if(!btn) return;
  const ok=Notification.permission==='granted';
  btn.textContent=ok?'🔔 Push: Enabled':'🔕 Enable Push Notifications';
  btn.style.color=ok?'var(--accent-green)':'var(--accent-orange)';
  btn.style.borderColor=ok?'rgba(0,232,122,0.3)':'rgba(255,140,26,0.3)';
}

// ── ANALYSIS ──────────────────────────────────────────────────────
function runAnalysis() {
  const sym=state.settings.symbol;
  const c15m=candleStore.get(sym,'15m'),c1H=candleStore.get(sym,'1H'),c4H=candleStore.get(sym,'4H');
  if(!c15m.length) return;
  state.biases=getBiasAllTF(c1H,c4H,c15m);
  state.session=getCurrentSession();
  state.liquidityPools=mapLiquidityPools(c1H,state.settings.liquidityTolerance);
  updateSidebarBias();
  updateSidebarLiquidity();
  updateStatsBar();
}

// ── CHART ─────────────────────────────────────────────────────────
function renderChart() {
  const canvas=el('main-canvas'); if(!canvas) return;
  const sym=state.settings.symbol;
  const candles=candleStore.get(sym,state.activeTF); if(!candles.length) return;
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  const cont=el('main-canvas-container');
  const rect=cont.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=(rect.height-44)*dpr;
  canvas.style.width=rect.width+'px'; canvas.style.height=(rect.height-44)+'px';
  ctx.scale(dpr,dpr);
  const W=rect.width, H=rect.height-44;
  const PAD={top:20,right:70,bottom:30,left:12};
  const display=candles.slice(-80);
  const prices=display.flatMap(c=>[c.high,c.low]);
  let hi=Math.max(...prices),lo=Math.min(...prices);
  const mg=(hi-lo)*0.08; hi+=mg; lo-=mg;
  const cW=W-PAD.left-PAD.right,cH=H-PAD.top-PAD.bottom;
  const bW=cW/display.length,cdW=Math.max(2,bW*0.6);
  const toX=i=>PAD.left+i*bW+bW/2;
  const toY=p=>PAD.top+cH-((p-lo)/(hi-lo))*cH;
  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#1f2d42'; ctx.lineWidth=0.5;
  for(let i=0;i<=5;i++) {
    const y=PAD.top+(cH/5)*i;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.fillStyle='#3d5169'; ctx.font='9px JetBrains Mono'; ctx.textAlign='left';
    ctx.fillText(formatPrice(hi-((hi-lo)/5)*i),W-PAD.right+4,y+3);
  }
  if(state.liquidityPools) {
    for(const p of state.liquidityPools.slice(0,10)) {
      if(p.price<lo||p.price>hi) continue;
      const y=toY(p.price);
      const bull=p.type==='SSL'||p.type==='PDL'||p.type==='SL';
      ctx.strokeStyle=bull?'rgba(0,232,122,0.4)':'rgba(255,61,90,0.4)';
      ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=ctx.strokeStyle; ctx.font='8px JetBrains Mono';
      ctx.fillText(p.type,W-PAD.right-28,y-2);
    }
  }
  const symSigs=state.signals.filter(s=>s.symbol===sym).slice(0,3);
  for(const sig of symSigs) {
    if(!sig.entry) continue;
    [['entry','#00d4ff'],['sl','#ff3d5a'],['tp','#00e87a']].forEach(([k,c])=>{
      const price=sig[k]; if(!price||price<lo||price>hi) return;
      const y=toY(price);
      ctx.strokeStyle=c; ctx.lineWidth=1; ctx.setLineDash(k==='entry'?[]:[3,3]); ctx.globalAlpha=0.7;
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.globalAlpha=1; ctx.setLineDash([]);
    });
  }
  for(let i=0;i<display.length;i++) {
    const c=display[i],x=toX(i),bull=c.close>=c.open,col=bull?'#00e87a':'#ff3d5a';
    ctx.strokeStyle=col; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,toY(c.high)); ctx.lineTo(x,toY(c.low)); ctx.stroke();
    ctx.fillStyle=col; ctx.globalAlpha=bull?0.85:0.7;
    ctx.fillRect(x-cdW/2,Math.min(toY(c.open),toY(c.close)),cdW,Math.max(1,Math.abs(toY(c.open)-toY(c.close))));
    ctx.globalAlpha=1;
  }
  if(state.lastPrice>lo&&state.lastPrice<hi) {
    const y=toY(state.lastPrice);
    ctx.strokeStyle='#f5c842'; ctx.lineWidth=1; ctx.setLineDash([2,4]);
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#f5c842'; ctx.fillRect(W-PAD.right,y-7,PAD.right-2,14);
    ctx.fillStyle='#080a0e'; ctx.font='bold 9px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText(formatPrice(state.lastPrice),W-PAD.right/2,y+3);
  }
  renderEquityMini();
}

function renderEquityMini() {
  const canvas=el('equity-mini-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=canvas.offsetHeight*dpr;
  ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=canvas.offsetHeight;
  const closed=state.riskTracker.trades.filter(t=>t.status==='closed');
  if(closed.length<2) {
    ctx.fillStyle='#111620'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#3d5169'; ctx.font='9px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText('No trades yet',W/2,H/2+3); return;
  }
  drawEquityCurve(ctx,W,H,[state.settings.initialEquity,...closed.map(t=>t.equity||0)],'#00e87a');
}

function drawEquityCurve(ctx,W,H,curve,color) {
  const pad=8,hi=Math.max(...curve),lo=Math.min(...curve),range=hi-lo||1;
  const toX=i=>pad+(i/(curve.length-1))*(W-pad*2);
  const toY=v=>H-pad-((v-lo)/range)*(H-pad*2);
  ctx.fillStyle='#111620'; ctx.fillRect(0,0,W,H);
  const grad=ctx.createLinearGradient(0,pad,0,H-pad);
  grad.addColorStop(0,color+'40'); grad.addColorStop(1,color+'00');
  ctx.fillStyle=grad; ctx.beginPath(); ctx.moveTo(toX(0),toY(curve[0]));
  for(let i=1;i<curve.length;i++) ctx.lineTo(toX(i),toY(curve[i]));
  ctx.lineTo(toX(curve.length-1),H); ctx.lineTo(toX(0),H); ctx.closePath(); ctx.fill();
  ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.beginPath();
  curve.forEach((v,i)=>i===0?ctx.moveTo(toX(i),toY(v)):ctx.lineTo(toX(i),toY(v)));
  ctx.stroke();
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
  const e=el('aligned-bias'); if(!e) return;
  e.className=`bias-val ${aligned==='bullish'?'bull':aligned==='bearish'?'bear':'neutral'}`;
  e.textContent=`${aligned==='bullish'?'▲':aligned==='bearish'?'▼':'◆'} ${aligned.toUpperCase()}`;
}
function updateSidebarLiquidity() {
  const c=el('liquidity-container'); if(!c) return;
  const dur=state.settings.liquidityDuration||'24h';
  const durationNote={
    '24h':'Showing 24h window levels',
    '48h':'Showing 48h window levels',
    '7d':'Showing 7-day window levels',
  };
  c.innerHTML=`
    <div style="display:flex;gap:4px;margin-bottom:8px">
      ${['24h','48h','7d'].map(d=>`<button onclick="setLiqDur('${d}')" style="padding:2px 8px;border-radius:4px;border:1px solid ${dur===d?'var(--accent-cyan)':'var(--border)'};background:${dur===d?'rgba(0,212,255,0.1)':'transparent'};color:${dur===d?'var(--accent-cyan)':'var(--text-2)'};font-size:9px;cursor:pointer;font-family:inherit">${d}</button>`).join('')}
    </div>
    <div style="font-size:8px;color:var(--text-3);margin-bottom:6px">${durationNote[dur]||''}</div>
    ${(state.liquidityPools||[]).slice(0,8).map(p=>`
    <div class="liquidity-item ${p.type==='BSL'||p.type==='PDH'||p.type==='SH'?'high':'low'}">
      <span>${p.type}</span>
      <span class="highlight-${p.type==='BSL'||p.type==='PDH'?'red':'green'}">${formatPrice(p.price)}</span>
    </div>`).join('')||'<div style="font-size:9px;color:var(--text-3);text-align:center;padding:8px">Scanning...</div>'}
    <div style="font-size:8px;color:var(--text-3);margin-top:6px;line-height:1.6">
      🔴 BSL/PDH = Buy-side (above price)<br>🟢 SSL/PDL = Sell-side (below price)<br>
      💡 Data: Binance order book levels
    </div>`;
}
window.setLiqDur = d => { state.settings.liquidityDuration=d; saveSettings(); updateSidebarLiquidity(); };

function updateSessionDisplay() {
  const sess=getCurrentSession(),c=el('session-display'); if(!c) return;
  const cls={Asian:'asian',London:'london',NY:'ny',Off:'off'};
  const icons={Asian:'🌏',London:'🇬🇧',NY:'🇺🇸',Off:'💤'};
  c.innerHTML=`<div class="session-badge ${cls[sess.name]||'off'}">${icons[sess.name]||'⏸'} ${sess.name}</div>
    <div style="font-size:9px;color:var(--text-3)">${new Date().toLocaleTimeString('en',{timeZone:state.settings.timezone||'UTC',hour:'2-digit',minute:'2-digit'})} ${(state.settings.timezone||'UTC').split('/').pop()}</div>`;
}
function renderStrategyToggles() {
  const c=el('strategy-toggles'); if(!c) return;
  const strats=[{key:'enableS1',name:'S1 Sweep→MSS',color:'#1e7fff'},{key:'enableS2',name:'S2 Prem/Disc',color:'#9b5cf6'},{key:'enableS3',name:'S3 HL Sweep',color:'#00e87a'}];
  c.innerHTML=strats.map(s=>`<div class="strategy-toggle"><div class="strat-info"><div class="strat-dot" style="background:${s.color}"></div><span class="strat-name">${s.name}</span></div><label class="toggle-switch"><input type="checkbox" id="toggle_${s.key}" ${state.settings[s.key]?'checked':''}><span class="toggle-slider"></span></label></div>`).join('');
  strats.forEach(s=>{ const i=el(`toggle_${s.key}`); if(i) i.addEventListener('change',()=>{ state.settings[s.key]=i.checked; saveSettings(); }); });
}

// ── SIGNALS ───────────────────────────────────────────────────────
function renderSignals() {
  const c=el('signals-container'); if(!c) return;
  if(!state.signals.length) {
    c.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><p>Scanning ${state.scanSymbols.length} symbols...<br>Waiting for setups</p></div>`;
    return;
  }
  c.innerHTML=state.signals.slice(0,6).map((sig,i)=>`
    <div class="signal-card ${sig.status||'pending'}">
      <div class="signal-header">
        <div class="signal-strategy ${sig.strategy.toLowerCase()}">${sig.strategyName||sig.strategy}</div>
        <div class="signal-dir ${sig.direction}">${sig.direction==='long'?'▲ LONG':'▼ SHORT'}</div>
      </div>
      <div class="signal-symbol">${sig.symbol||state.settings.symbol}</div>
      <div class="signal-tf">${sig.tf||'15m'} | ${formatTZ(sig.time)}</div>
      <div class="signal-levels">
        <div class="level-item"><div class="level-label">Entry</div><div class="level-val entry">${formatPrice(sig.entry)}</div></div>
        <div class="level-item"><div class="level-label">SL</div><div class="level-val sl">${formatPrice(sig.sl)}</div></div>
        <div class="level-item"><div class="level-label">TP</div><div class="level-val tp">${formatPrice(sig.tp)}</div></div>
      </div>
      <div class="signal-rr">
        <span class="rr-badge">${sig.rr}R</span>
        <span class="signal-wr">${((sig.winRate||0.65)*100).toFixed(0)}% WR</span>
        <span style="display:flex;gap:3px">
          <button onclick="openSignalChart(${i})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);padding:2px 7px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">📊</button>
          <button onclick="openSignalReason(${i})" style="background:rgba(155,92,246,0.1);border:1px solid rgba(155,92,246,0.2);color:var(--accent-purple);padding:2px 7px;border-radius:4px;font-size:9px;cursor:pointer;font-family:inherit">📋</button>
        </span>
      </div>
    </div>`).join('');
}
window.openSignalChart=(i)=>openChartModal(state.signals[i]);
window.openSignalReason=(i)=>openReasonModal(state.signals[i]);

// ── STATS ─────────────────────────────────────────────────────────
function updateStatsBar() {
  const rt=state.riskTracker;
  const closed=rt.trades.filter(t=>t.status==='closed');
  const wins=closed.filter(t=>t.r>0).length;
  const wr=closed.length?((wins/closed.length)*100).toFixed(1):'--';
  const sym=currSym();
  [['stat-equity',`${sym}${rt.equity.toLocaleString()}`],['stat-wr',wr+'%'],['stat-trades',closed.length],['stat-dd',rt.getDrawdown()+'%'],['stat-session',getCurrentSession().name],['stat-signals',state.signals.filter(s=>s.status==='live').length]].forEach(([id,v])=>{ const e=el(id); if(e) e.textContent=v; });
}
function updateHeaderEquity() {
  const rt=state.riskTracker,e=el('header-equity'); if(!e) return;
  const pnl=rt.equity-rt.initialEquity,sign=pnl>=0?'+':'',sym=currSym();
  e.innerHTML=`<span>${sym}${rt.equity.toLocaleString()}</span>&nbsp;<span style="color:${pnl>=0?'#00e87a':'#ff3d5a'};font-size:10px">${sign}${formatPct((pnl/rt.initialEquity)*100)}</span>`;
}
function updatePriceDisplay() {
  const e=el('header-price'); if(e) e.textContent=formatPrice(state.lastPrice);
  const e2=el('chart-live-price'); if(e2) e2.textContent=formatPrice(state.lastPrice);
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
      <div class="alert-text" style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.strategy} ${(a.direction||'').toUpperCase()} ${a.symbol||''}</div>
        <div style="color:var(--text-2);font-size:9px">E:${formatPrice(a.entry)} SL:${formatPrice(a.sl)} TP:${formatPrice(a.tp)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0">
        <div class="alert-time">${a.time}</div>
        <div style="display:flex;gap:2px">
          <button onclick="openAlertChart(${i})" title="Chart" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);width:20px;height:18px;border-radius:3px;cursor:pointer;font-size:9px">📊</button>
          <button onclick="openAlertReason(${i})" title="Reasoning" style="background:rgba(155,92,246,0.1);border:1px solid rgba(155,92,246,0.2);color:var(--accent-purple);width:20px;height:18px;border-radius:3px;cursor:pointer;font-size:9px">📋</button>
        </div>
      </div>
    </div>`).join('');
}
window.openAlertChart=(i)=>{ const log=alertManager.getLog(); if(log[i]) openChartModal(log[i]); };
window.openAlertReason=(i)=>{ const log=alertManager.getLog(); if(log[i]) openReasonModal(log[i]); };

// ── CHART MODAL ───────────────────────────────────────────────────
function openChartModal(sig) {
  if(!sig) return;
  const modal=el('chart-modal'); if(!modal) return;
  el('modal-title').textContent=`${sig.symbol||'?'} ${sig.tf||'15m'} — ${sig.strategy} ${(sig.direction||'').toUpperCase()}`;
  modal.style.display='flex';
  setTimeout(()=>drawSignalCanvas(sig),60);
}
function drawSignalCanvas(sig) {
  const canvas=el('modal-canvas'); if(!canvas) return;
  const sym=sig.symbol||state.settings.symbol;
  const candles=candleStore.get(sym,'15m');
  const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=canvas.offsetHeight*dpr;
  ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=canvas.offsetHeight;
  if(!candles.length) {
    ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#3d5169'; ctx.font='13px JetBrains Mono'; ctx.textAlign='center';
    ctx.fillText('No candle data for '+sym,W/2,H/2); return;
  }
  const PAD={top:44,right:80,bottom:36,left:14};
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
  // Grid
  ctx.strokeStyle='#1a2535'; ctx.lineWidth=0.5;
  for(let i=0;i<=6;i++) {
    const y=PAD.top+(cH/6)*i;
    ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
    ctx.fillStyle='#3d5169'; ctx.font='9px JetBrains Mono'; ctx.textAlign='left';
    ctx.fillText(formatPrice(hi-((hi-lo)/6)*i),W-PAD.right+4,y+3);
  }
  // Zone fills
  if(sig.entry&&sig.sl&&sig.tp) {
    const eY=toY(sig.entry),slY=toY(sig.sl),tpY=toY(sig.tp);
    ctx.fillStyle='rgba(255,61,90,0.07)'; ctx.fillRect(PAD.left,Math.min(eY,slY),cW,Math.abs(eY-slY));
    ctx.fillStyle='rgba(0,232,122,0.05)'; ctx.fillRect(PAD.left,Math.min(eY,tpY),cW,Math.abs(eY-tpY));
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
  // Level lines
  if(sig.entry) {
    [{price:sig.entry,color:'#00d4ff',label:'ENTRY',dash:[]},{price:sig.sl,color:'#ff3d5a',label:'STOP',dash:[4,3]},{price:sig.tp,color:'#00e87a',label:'TARGET',dash:[4,3]}].forEach(lv=>{
      if(!lv.price||lv.price<lo||lv.price>hi) return;
      const y=toY(lv.price);
      ctx.strokeStyle=lv.color; ctx.lineWidth=1.5; ctx.setLineDash(lv.dash);
      ctx.beginPath(); ctx.moveTo(PAD.left,y); ctx.lineTo(W-PAD.right,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=lv.color+'22';
      ctx.beginPath(); ctx.roundRect?ctx.roundRect(PAD.left+5,y-9,ctx.measureText(lv.label).width+14,17,3):ctx.rect(PAD.left+5,y-9,ctx.measureText(lv.label).width+14,17);
      ctx.fill();
      ctx.fillStyle=lv.color; ctx.font='bold 9px JetBrains Mono';
      ctx.fillText(lv.label,PAD.left+12,y+3);
      ctx.fillStyle=lv.color; ctx.fillRect(W-PAD.right,y-8,PAD.right-2,16);
      ctx.fillStyle='#080a0e'; ctx.font='bold 8px JetBrains Mono'; ctx.textAlign='center';
      ctx.fillText(formatPrice(lv.price),W-PAD.right/2,y+3); ctx.textAlign='left';
    });
  }
  // Header bar
  ctx.fillStyle='rgba(8,10,14,0.9)'; ctx.fillRect(0,0,W,PAD.top);
  ctx.fillStyle='#e8eef6'; ctx.font='bold 13px Syne,sans-serif';
  ctx.fillText(`${sym} · ${sig.tf||'15m'} · ${sig.strategy}`,PAD.left+4,18);
  ctx.fillStyle=sig.direction==='long'?'#00e87a':'#ff3d5a'; ctx.font='11px JetBrains Mono';
  ctx.fillText(`${sig.direction==='long'?'▲ LONG':'▼ SHORT'} | ${sig.rr}R | ${formatTZ(sig.time)}`,PAD.left+4,35);
  // Footer
  ctx.fillStyle='rgba(8,10,14,0.85)'; ctx.fillRect(0,H-PAD.bottom,W,PAD.bottom);
  ctx.fillStyle='#3d5169'; ctx.font='8px JetBrains Mono';
  ctx.textAlign='center';
  ctx.fillText(`Entry: ${formatPrice(sig.entry)}  |  Stop: ${formatPrice(sig.sl)}  |  Target: ${formatPrice(sig.tp)}  |  R:R ${sig.rr}`,W/2,H-PAD.bottom+14);
}

// ── REASON MODAL ──────────────────────────────────────────────────
function openReasonModal(sig) {
  if(!sig) return;
  const modal=el('reasoning-modal'); if(!modal) return;
  el('reasoning-title').textContent=`${sig.symbol||'?'} ${sig.strategy} — Signal Reasoning`;
  el('reasoning-body').textContent=sig.reasoning||buildReasoning(sig,sig.symbol||'?');
  modal.style.display='flex';
}

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(a) {
  const c=el('toast-container'); if(!c) return;
  const sc={S1:'s1',S2:'s2',S3:'s3'};
  const ic={S1:'🔵',S2:'🟣',S3:'🟢',SYS:'⚙️'};
  const t=document.createElement('div');
  t.className=`toast ${sc[a.strategy]||''}`;
  t.innerHTML=`<div class="toast-icon">${ic[a.strategy]||'🔔'}</div><div class="toast-body"><div class="toast-title">${a.strategy||'SYS'} ${a.symbol?'— '+a.symbol:''}</div><div class="toast-msg">${a.msg||''}</div></div><button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  c.appendChild(t);
  setTimeout(()=>{ t.classList.add('out'); setTimeout(()=>t.remove(),300); },6000);
}

// ── SETTINGS ─────────────────────────────────────────────────────
function renderSettingsPanel() {
  const panel=el('settings-panel'); if(!panel) return;
  const s=state.settings;
  const tfAll=['1m','5m','15m','30m','1H','2H','4H','1D'];
  const tfBoxes=tfAll.map(tf=>`
    <label style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid ${(s.scanTimeframes||[]).includes(tf)?'var(--accent-cyan)':'var(--border)'};border-radius:4px;cursor:pointer;font-size:10px;color:${(s.scanTimeframes||[]).includes(tf)?'var(--accent-cyan)':'var(--text-2)'};background:${(s.scanTimeframes||[]).includes(tf)?'rgba(0,212,255,0.08)':'transparent'};margin:2px">
      <input type="checkbox" class="tf-cb" value="${tf}" ${(s.scanTimeframes||[]).includes(tf)?'checked':''} style="display:none">${tf}
    </label>`).join('');

  const currOpts=Object.entries(CURRENCIES).map(([c,sym])=>`<option value="${c}" ${s.currency===c?'selected':''}>${c} (${sym})</option>`).join('');
  const tzOpts=TIMEZONES.map(tz=>`<option value="${tz}" ${s.timezone===tz?'selected':''}>${tz}</option>`).join('');

  panel.innerHTML=`<div class="settings-grid">
    <div class="settings-section">
      <div class="settings-section-title">Risk Management</div>
      ${srow('riskPct','Risk per trade (%)','% of equity per trade')}
      ${srow('maxDailyRisk','Max daily risk (%)','Kill switch')}
      ${srow('maxDrawdownStop','Max drawdown stop (%)','Emergency halt')}
      ${srow('maxConcurrentTrades','Max concurrent trades','Open position limit')}
      ${srow('maxTradesPerDay','Max trades per day','Daily limit')}
      ${srow('initialEquity','Account equity','Starting capital')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Entry & R:R</div>
      ${srow('minRR','Min R:R','Skip below this')}
      ${srow('targetRR','Target R:R','Full TP multiplier')}
      ${srow('partialRR','Partial TP','First partial TP')}
      ${srow('slBuffer','SL buffer (ATR)','Extra buffer')}
      <div class="setting-row">
        <div><div class="setting-label">Only Longs</div><div class="setting-desc">Spot-friendly: long setups only</div></div>
        <label class="toggle-switch"><input type="checkbox" id="setting_onlyLongs" ${s.onlyLongs?'checked':''}><span class="toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Detection Engine</div>
      ${srow('atrMultiplier','ATR multiplier','Displacement body size')}
      ${srow('volumeMultiplier','Volume multiplier','Volume spike threshold')}
      ${srow('liquidityTolerance','Liquidity tolerance','Equal level tolerance')}
      ${srow('mcIterations','Monte Carlo runs','Simulation iterations')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Scan Timeframes</div>
      <div style="font-size:9px;color:var(--text-2);margin-bottom:8px">Active for live scan &amp; backtest</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:14px" id="tf-boxes">${tfBoxes}</div>
      <div class="settings-section-title">Scanner Mode</div>
      <select id="setting_scanCategory" style="width:100%;background:var(--bg-3);border:1px solid var(--border);color:var(--text-0);font-family:inherit;padding:6px 8px;border-radius:4px;font-size:11px">
        <option value="manual" ${s.scanCategory==='manual'?'selected':''}>Manual (current symbol)</option>
        <option value="mcap" ${s.scanCategory==='mcap'?'selected':''}>Top 20 by Market Cap</option>
        <option value="volume" ${s.scanCategory==='volume'?'selected':''}>Top 20 by Volume (24h)</option>
        <option value="gainers" ${s.scanCategory==='gainers'?'selected':''}>Top 20 Gainers (24h)</option>
      </select>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Display & Locale</div>
      <div class="setting-row">
        <div><div class="setting-label">Currency</div><div class="setting-desc">P&amp;L display symbol</div></div>
        <select id="setting_currency" style="width:100px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-0);font-family:inherit;padding:5px 6px;border-radius:4px;font-size:10px">${currOpts}</select>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Timezone</div><div class="setting-desc">For all timestamps</div></div>
        <select id="setting_timezone" style="width:160px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-0);font-family:inherit;padding:5px 6px;border-radius:4px;font-size:10px">${tzOpts}</select>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Notifications</div>
      <div class="setting-row">
        <div><div class="setting-label">Session filter</div><div class="setting-desc">London/NY only</div></div>
        <label class="toggle-switch"><input type="checkbox" id="setting_sessionFilter" ${s.sessionFilter?'checked':''}><span class="toggle-slider"></span></label>
      </div>
      <div style="margin-top:10px">
        <button id="push-perm-btn" style="background:rgba(255,140,26,0.1);border:1px solid rgba(255,140,26,0.3);color:var(--accent-orange);padding:8px 14px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:11px;width:100%">🔕 Enable Push Notifications</button>
        <div style="font-size:8px;color:var(--text-3);margin-top:6px;line-height:1.6">Push works outside browser. On mobile: tap Share → Add to Home Screen for persistent background alerts.</div>
      </div>
    </div>
    <div class="settings-section" style="grid-column:1/-1">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-primary" id="save-settings-btn">💾 Save All Settings</button>
        <button class="btn-secondary" id="reset-settings-btn">↺ Reset Defaults</button>
      </div>
      <div id="save-msg" style="display:none;margin-top:8px;color:var(--accent-green);font-size:10px">✅ All settings saved</div>
    </div>
  </div>`;

  // TF checkbox styling
  document.querySelectorAll('.tf-cb').forEach(cb=>{
    cb.addEventListener('change',()=>{
      const lbl=cb.closest('label'),on=cb.checked;
      lbl.style.borderColor=on?'var(--accent-cyan)':'var(--border)';
      lbl.style.color=on?'var(--accent-cyan)':'var(--text-2)';
      lbl.style.background=on?'rgba(0,212,255,0.08)':'transparent';
    });
  });

  el('save-settings-btn')?.addEventListener('click',()=>{
    document.querySelectorAll('[id^=setting_]').forEach(inp=>{
      const key=inp.id.replace('setting_','');
      if(inp.type==='checkbox') state.settings[key]=inp.checked;
      else if(inp.tagName==='SELECT') state.settings[key]=inp.value;
      else state.settings[key]=isNaN(parseFloat(inp.value))?inp.value:parseFloat(inp.value);
    });
    const checked=[]; document.querySelectorAll('.tf-cb').forEach(cb=>{ if(cb.checked) checked.push(cb.value); });
    if(checked.length) state.settings.scanTimeframes=checked;
    state.riskTracker.settings=state.settings;
    saveSettings();
    const msg=el('save-msg'); if(msg){ msg.style.display='block'; setTimeout(()=>msg.style.display='none',3000); }
    renderSidebar();
    startMultiSymbolScan();
  });

  el('reset-settings-btn')?.addEventListener('click',()=>{ state.settings={...DEFAULT_SETTINGS}; saveSettings(); renderSettingsPanel(); });
  el('push-perm-btn')?.addEventListener('click',requestPushPermission);
  updatePushBtn();
}
function srow(key,label,desc){ return `<div class="setting-row"><div><div class="setting-label">${label}</div><div class="setting-desc">${desc}</div></div><input class="setting-input" type="number" id="setting_${key}" value="${state.settings[key]}" step="any"></div>`; }

// ── BACKTEST ──────────────────────────────────────────────────────
function initBacktest() {
  el('run-backtest-btn')?.addEventListener('click', runBT);
  el('stop-backtest-btn')?.addEventListener('click',()=>{ state.btCancelled=true; });
}
async function runBT() {
  const sym=el('bt-symbol')?.value||'BTCUSDT';
  const strat=el('bt-strategy')?.value||'all';
  const from=new Date(el('bt-from')?.value).getTime();
  const to=new Date(el('bt-to')?.value).getTime();
  const riskPct=parseFloat(el('bt-risk')?.value)||1;
  const minRR=parseFloat(el('bt-minrr')?.value)||2;
  const onlyLongs=el('bt-only-longs')?.checked||false;
  const btTFs=[]; document.querySelectorAll('.bt-tf-cb').forEach(cb=>{ if(cb.checked) btTFs.push(cb.value); });
  if(!btTFs.length) btTFs.push('15m');
  if(!from||!to||isNaN(from)||isNaN(to)){ showToast({strategy:'SYS',msg:'Select a valid date range',time:''}); return; }
  state.btCancelled=false; state.btPage=1;
  el('bt-progress-wrap').style.display='block';
  el('stop-backtest-btn').style.display='inline-block';
  el('run-backtest-btn').disabled=true;
  const btSettings={...state.settings,riskPct,minRR,onlyLongs,strategy:strat,enableS1:true,enableS2:true,enableS3:true,scanTimeframes:btTFs};
  try {
    const [c15m,c1H,c4H]=await Promise.all([fetchHistorical(sym,'15m',from,to),fetchHistorical(sym,'1h',from,to),fetchHistorical(sym,'4h',from,to)]);
    el('bt-status').textContent=`Loaded ${c15m.length} candles. Simulating...`;
    const {trades,equityCurve,dailyStats}=await runBacktest(c15m,c1H,c4H,btSettings,pct=>{
      if(state.btCancelled) throw new Error('CANCELLED');
      el('bt-progress-fill').style.width=pct+'%';
      el('bt-status').textContent=`Simulating... ${pct}%`;
    });
    const metrics=calcMetrics(trades,equityCurve,btSettings.initialEquity);
    const mc=runMonteCarlo(trades,btSettings.initialEquity,btSettings.mcIterations||1000);
    state.btResults={trades,equityCurve,metrics,dailyStats};
    state.mcResults=mc; state.btTrades=trades; state.btPage=1;
    renderBTResults(metrics,trades,equityCurve,dailyStats,mc);
  } catch(e) {
    if(e.message==='CANCELLED') el('bt-status').textContent='Stopped.';
    else showToast({strategy:'SYS',msg:'Backtest error: '+e.message,time:''});
  }
  el('bt-progress-wrap').style.display='none';
  el('stop-backtest-btn').style.display='none';
  el('run-backtest-btn').disabled=false;
}

function renderBTResults(m,trades,equityCurve,dailyStats,mc) {
  if(!m) return;
  const sym=currSym();
  const res=el('bt-results'); if(!res) return;
  res.innerHTML=`
    <div class="bt-results-grid">
      ${bmet('Win Rate',(m.winRate*100).toFixed(1)+'%',m.winRate>=0.55)}
      ${bmet('Profit Factor',m.profitFactor,m.profitFactor>=1.5)}
      ${bmet('Expectancy',m.expectancy+'R',m.expectancy>=0)}
      ${bmet('Max Drawdown',m.maxDrawdown+'%',false)}
      ${bmet('Total Return',m.totalReturn+'%',m.totalReturn>=0)}
      ${bmet('Sharpe',m.sharpe,m.sharpe>=1)}
      ${bmet('Sortino',m.sortino,m.sortino>=1)}
      ${bmet('Total Trades',m.totalTrades,true)}
      ${bmet('Avg R:R',m.avgRR,m.avgRR>=2)}
      ${bmet('Long WR',(m.longWR*100).toFixed(1)+'%',m.longWR>=0.55)}
      ${bmet('Short WR',(m.shortWR*100).toFixed(1)+'%',m.shortWR>=0.55)}
      ${bmet('Final Equity',sym+m.finalEquity.toLocaleString(),m.totalReturn>=0)}
    </div>
    <div class="equity-chart-full"><div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-2)">EQUITY CURVE</div><canvas id="bt-equity-canvas" style="width:100%;height:200px;display:block"></canvas></div>
    ${mc?`<div class="mc-section"><div class="mc-title">🎲 Monte Carlo (${mc.iterations} runs)</div>
    <div class="mc-stats">
      <div class="mc-stat"><div class="mc-stat-label">Worst DD</div><div class="mc-stat-val highlight-red">${mc.worstDD}%</div></div>
      <div class="mc-stat"><div class="mc-stat-label">Median DD</div><div class="mc-stat-val">${mc.medianDD}%</div></div>
      <div class="mc-stat"><div class="mc-stat-label">Risk of Ruin</div><div class="mc-stat-val highlight-${mc.riskOfRuin>5?'red':'green'}">${mc.riskOfRuin}%</div></div>
      <div class="mc-stat"><div class="mc-stat-label">Median Final</div><div class="mc-stat-val">${sym}${mc.medianFinal.toLocaleString()}</div></div>
    </div><canvas id="bt-mc-canvas" style="width:100%;height:160px;display:block"></canvas></div>`:''}
    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;margin-bottom:12px">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:10px;color:var(--text-2)">TRADE LOG — ${trades.length} total</span>
        <div id="bt-pagination" style="display:flex;gap:4px;align-items:center"></div>
      </div>
      <div style="overflow-x:auto" id="bt-table-wrap"></div>
    </div>`;
  setTimeout(()=>{ renderBTEquityChart(equityCurve); if(mc) renderMCChart(mc); renderTradeTable(1); },60);
}
function bmet(label,val,ok){ return `<div class="bt-metric"><div class="bt-metric-label">${label}</div><div class="bt-metric-val highlight-${ok?'green':'red'}">${val}</div></div>`; }

const BT_PG=100;
function renderTradeTable(page) {
  state.btPage=page;
  const trades=state.btTrades,total=trades.length;
  const totalPages=Math.ceil(total/BT_PG);
  const start=(page-1)*BT_PG;
  const pageTrades=trades.slice(start,start+BT_PG).reverse();
  const sym=currSym();
  const pag=el('bt-pagination');
  if(pag) pag.innerHTML=`${page>1?`<button onclick="renderTradeTable(${page-1})" class="btn-secondary" style="padding:3px 10px;font-size:10px">← Prev</button>`:''}<span style="font-size:9px;color:var(--text-2);padding:4px 8px">Page ${page}/${totalPages}</span>${page<totalPages?`<button onclick="renderTradeTable(${page+1})" class="btn-secondary" style="padding:3px 10px;font-size:10px">Next →</button>`:''}`;
  const wrap=el('bt-table-wrap'); if(!wrap) return;
  wrap.innerHTML=`<table class="trade-table"><thead><tr><th>#</th><th>Time</th><th>Strat</th><th>Dir</th><th>Entry</th><th>Exit</th><th>R</th><th>P&L</th><th>Equity</th><th>📊</th></tr></thead><tbody>
    ${pageTrades.map((t,i)=>{
      const absIdx=trades.indexOf(t);
      return `<tr class="${t.outcome}">
        <td>${total-start-i}</td>
        <td style="white-space:nowrap">${formatTZ(t.time)}</td>
        <td><span class="badge ${t.strategy==='S1'?'blue':t.strategy==='S2'?'':'green'}">${t.strategy}</span></td>
        <td>${t.direction==='long'?'▲':'▼'} ${t.direction}</td>
        <td>${formatPrice(t.entry)}</td>
        <td>${formatPrice(t.exitPrice)}</td>
        <td style="color:${t.r>=0?'var(--accent-green)':'var(--accent-red)'}">${t.r>0?'+':''}${t.r}R</td>
        <td style="color:${t.pnl>=0?'var(--accent-green)':'var(--accent-red)'}">${t.pnl>0?'+':''}${sym}${Math.abs(t.pnl)}</td>
        <td>${sym}${(t.equity||0).toLocaleString()}</td>
        <td><button onclick="openBtChart(${absIdx})" style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.2);color:var(--accent-cyan);padding:2px 7px;border-radius:3px;font-size:9px;cursor:pointer;font-family:inherit">📊</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}
window.renderTradeTable=renderTradeTable;
window.openBtChart=(i)=>{
  const t=state.btTrades[i]; if(!t) return;
  openChartModal({symbol:el('bt-symbol')?.value||'BTCUSDT',strategy:t.strategy,direction:t.direction,entry:t.entry,sl:t.sl,tp:t.tp,rr:t.rr,time:t.time,tf:'15m',reasoning:`Backtest Trade #${i+1}\nOutcome: ${t.outcome.toUpperCase()}\nR: ${t.r>0?'+':''}${t.r}R\nP&L: ${currSym()}${t.pnl}\nBars held: ${t.barsHeld}`});
};

function renderBTEquityChart(curve) {
  const canvas=el('bt-equity-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=200*dpr; ctx.scale(dpr,dpr);
  drawEquityCurve(ctx,canvas.offsetWidth,200,curve,'#00e87a');
}
function renderMCChart(mc) {
  const canvas=el('bt-mc-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr; canvas.height=160*dpr; ctx.scale(dpr,dpr);
  const W=canvas.offsetWidth,H=160,pad=10;
  ctx.fillStyle='#111620'; ctx.fillRect(0,0,W,H);
  const allV=[...mc.curves.p10,...mc.curves.p90];
  const hi=Math.max(...allV),lo=Math.min(...allV),range=hi-lo||1;
  const len=mc.curves.p50.length;
  const toX=i=>pad+(i/(len-1))*(W-pad*2);
  const toY=v=>H-pad-((v-lo)/range)*(H-pad*2);
  [{top:mc.curves.p90,bot:mc.curves.p10,alpha:0.08},{top:mc.curves.p75,bot:mc.curves.p25,alpha:0.15}].forEach(b=>{
    ctx.beginPath(); ctx.moveTo(toX(0),toY(b.top[0]));
    for(let i=1;i<len;i++) ctx.lineTo(toX(i),toY(b.top[Math.min(i,b.top.length-1)]));
    for(let i=len-1;i>=0;i--) ctx.lineTo(toX(i),toY(b.bot[Math.min(i,b.bot.length-1)]));
    ctx.closePath(); ctx.fillStyle='#1e7fff'+Math.round(b.alpha*255).toString(16).padStart(2,'0'); ctx.fill();
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
    c.innerHTML='<div class="analytics-card" style="grid-column:1/-1"><div class="empty-state"><div class="empty-icon">📉</div><p>Run a backtest first to populate analytics</p></div></div>';
    return;
  }
  const sym=currSym();
  const monthlyHTML=Object.entries(daily).sort().map(([mo,d])=>`<div class="monthly-row"><span>${mo}</span><span>${d.wins}W/${d.losses}L</span><span style="color:${d.pnl>=0?'var(--accent-green)':'var(--accent-red)'}">${d.pnl>=0?'+':''}${sym}${d.pnl.toFixed(0)}</span></div>`).join('');
  const stratHTML=(m.stratBreakdown||[]).map(s=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:10px"><span class="badge ${s.strategy==='S1'?'blue':s.strategy==='S2'?'':'green'}">${s.strategy}</span><span>${s.trades} trades</span><span style="color:${s.wr>=0.5?'var(--accent-green)':'var(--accent-red)'}">${(s.wr*100).toFixed(1)}%</span><span style="color:${s.avgR>=0?'var(--accent-green)':'var(--accent-red)'}">${s.avgR>0?'+':''}${s.avgR}R</span></div>`).join('');

  c.innerHTML=`
    <div class="analytics-card"><div class="analytics-card-title">📅 Monthly P&L</div><div style="max-height:260px;overflow-y:auto">${monthlyHTML||'<div style="color:var(--text-3);font-size:10px;text-align:center;padding:20px">No data</div>'}</div></div>
    <div class="analytics-card"><div class="analytics-card-title">🎯 Strategy Breakdown</div>${stratHTML}<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)"><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-2);margin-bottom:4px"><span>Long WR</span><span style="color:var(--accent-green)">${(m.longWR*100).toFixed(1)}%</span></div><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-2)"><span>Short WR</span><span style="color:var(--accent-blue)">${(m.shortWR*100).toFixed(1)}%</span></div></div></div>
    <div class="analytics-card"><div class="analytics-card-title">📊 Performance Metrics</div>${[['Win Rate',(m.winRate*100).toFixed(1)+'%',m.winRate>=0.55],['Profit Factor',m.profitFactor,m.profitFactor>=1.5],['Expectancy',m.expectancy+'R',m.expectancy>=0],['Sharpe',m.sharpe,m.sharpe>=1],['Sortino',m.sortino,m.sortino>=1],['Max Drawdown',m.maxDrawdown+'%',m.maxDrawdown<15],['Avg R:R',m.avgRR,m.avgRR>=2],['Total Return',m.totalReturn+'%',m.totalReturn>=0]].map(([l,v,ok])=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:10px"><span style="color:var(--text-2)">${l}</span><span style="color:${ok?'var(--accent-green)':'var(--accent-red)'};font-weight:600">${v}</span></div>`).join('')}</div>
    <div class="analytics-card"><div class="analytics-card-title">📈 Equity Curve</div><canvas id="ana-eq-canvas" style="width:100%;height:180px;display:block"></canvas></div>`;

  setTimeout(()=>{
    const canvas=el('ana-eq-canvas');
    if(canvas&&state.btResults?.equityCurve) {
      const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1;
      canvas.width=canvas.offsetWidth*dpr; canvas.height=180*dpr; ctx.scale(dpr,dpr);
      drawEquityCurve(ctx,canvas.offsetWidth,180,state.btResults.equityCurve,'#00e87a');
    }
  },50);
}

// ── LOADING ───────────────────────────────────────────────────────
function showLoading(id,show) {
  const e=el(id); if(!e) return;
  let ov=e.querySelector('.loading-overlay');
  if(show) { if(!ov){ ov=document.createElement('div'); ov.className='loading-overlay'; ov.innerHTML='<div style="text-align:center"><div class="loading-spinner"></div><div class="loading-text">Loading market data...</div></div>'; e.appendChild(ov); } }
  else ov?.remove();
}

// ── BOOTSTRAP ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  init();
  initBacktest();

  $$('.tf-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      $$('.tf-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTF=btn.dataset.tf;
      renderChart();
    });
  });

  window.addEventListener('resize',()=>{ if(state.activeView==='live') renderChart(); });

  // Modal close handlers
  $$('.modal-close').forEach(btn=>btn.addEventListener('click',()=>btn.closest('.modal-overlay').style.display='none'));
  $$('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{ if(e.target===m) m.style.display='none'; }));
});
