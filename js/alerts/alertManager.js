// alerts/alertManager.js

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per symbol

export class AlertManager {
  constructor() {
    this.log = [];
    this.cooldowns = {};
    this.maxLog = 50;
    this._soundEnabled = true;
    this._pushEnabled = false;
    this._pushGranted = false;
  }

  async init() {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        this._pushGranted = true;
      }
    }
  }

  async requestPush() {
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      this._pushGranted = perm === 'granted';
    }
  }

  canAlert(symbol, strategy) {
    const key = `${symbol}_${strategy}`;
    const last = this.cooldowns[key] || 0;
    return Date.now() - last > COOLDOWN_MS;
  }

  fire(signal, onToast) {
    const { strategy, direction, entry, sl, tp, rr, winRate, tf, pctGain, reasoning } = signal;
    const symbol = signal.symbol || 'BTCUSDT';
    
    if (!this.canAlert(symbol, strategy)) return;

    const key = `${symbol}_${strategy}`;
    this.cooldowns[key] = Date.now();

    const msg = {
      id: Date.now(),
      strategy,
      direction,
      symbol,
      entry,
      sl,
      tp,
      rr,
      winRate,
      tf,
      pctGain,
      reasoning,
      time: new Date().toLocaleTimeString(),
      msg: `${strategy} ${(direction||'').toUpperCase()} ${symbol} | E:${entry?.toFixed?.(2)??entry} SL:${sl?.toFixed?.(2)??sl} TP:${tp?.toFixed?.(2)??tp} | ${rr}R${pctGain ? ' +'+pctGain+'%' : ''}`
    };

    this.log.unshift(msg);
    if (this.log.length > this.maxLog) this.log.pop();

    // ── Immediately update the alert log DOM ──
    this._renderLogDOM();

    if (onToast) onToast(msg);
    if (this._soundEnabled) this._playSound();
    if (this._pushEnabled && this._pushGranted) this._sendPush(msg);
  }

  _renderLogDOM() {
    const container = document.getElementById('alert-log');
    if (!container) return;

    if (!this.log.length) {
      container.innerHTML = '<div style="font-size:9px;color:var(--text-3);text-align:center;padding:16px">No alerts yet</div>';
      return;
    }

    const stratClass = { S1:'s1', S2:'s2', S3:'s3' };

    container.innerHTML = this.log.slice(0, 30).map((a, i) => `
      <div class="alert-item ${stratClass[a.strategy] || ''}" style="animation:alert-pop 0.3s ease">
        <div class="alert-icon">🔔</div>
        <div class="alert-text" style="flex:1;min-width:0;overflow:hidden">
          <div style="font-weight:600;font-size:10px;display:flex;align-items:center;gap:5px">
            <span class="badge ${a.strategy==='S1'?'blue':a.strategy==='S2'?'':'green'}">${a.strategy}</span>
            <span style="color:var(--text-0)">${a.symbol||''}</span>
            ${a.pctGain ? `<span style="color:var(--accent-green);font-weight:700">+${a.pctGain}%</span>` : ''}
          </div>
          <div style="color:var(--text-2);font-size:9px;margin-top:2px">E:${this._fp(a.entry)} SL:${this._fp(a.sl)} TP:${this._fp(a.tp)} · ${a.rr}R</div>
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

  _fp(v) {
    if (v == null) return '—';
    return typeof v === 'number' ? v.toFixed(v > 100 ? 2 : 4) : v;
  }

  _playSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.frequency.setValueAtTime(800, ctx.currentTime);
      oscillator.frequency.setValueAtTime(1200, ctx.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.4);
    } catch (e) { /* AudioContext may be blocked */ }
  }

  _sendPush(msg) {
    new Notification(`SMC Signal: ${msg.strategy} ${msg.direction}`, {
      body: msg.msg,
      icon: '/favicon.ico'
    });
  }

  getLog() {
    return this.log;
  }

  clearLog() {
    this.log = [];
  }

  setSoundEnabled(val) { this._soundEnabled = val; }
  setPushEnabled(val) { this._pushEnabled = val; }
}

export const alertManager = new AlertManager();
