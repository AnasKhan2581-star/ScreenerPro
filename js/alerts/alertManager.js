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
    const { strategy, direction, entry, sl, tp, rr, winRate, tf } = signal;
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
      time: new Date().toLocaleTimeString(),
      msg: `${strategy} ${direction.toUpperCase()} ${symbol} | E:${entry?.toFixed(2)} SL:${sl?.toFixed(2)} TP:${tp?.toFixed(2)} | ${rr}R`
    };

    this.log.unshift(msg);
    if (this.log.length > this.maxLog) this.log.pop();

    if (onToast) onToast(msg);
    if (this._soundEnabled) this._playSound();
    if (this._pushEnabled && this._pushGranted) this._sendPush(msg);
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
