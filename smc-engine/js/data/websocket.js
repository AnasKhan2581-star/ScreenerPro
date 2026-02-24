// data/websocket.js
import { candleStore } from './candleStore.js';

const WS_BASE = 'wss://stream.binance.com:9443/ws';
const TF_MAP = { '15m': '15m', '1H': '1h', '4H': '4h' };

export class BinanceWS {
  constructor(symbol, timeframes, onUpdate) {
    this.symbol = symbol.toLowerCase();
    this.timeframes = timeframes;
    this.onUpdate = onUpdate;
    this.sockets = {};
    this.active = false;
  }

  connect() {
    this.active = true;
    for (const tf of this.timeframes) {
      const stream = `${this.symbol}@kline_${TF_MAP[tf]}`;
      const ws = new WebSocket(`${WS_BASE}/${stream}`);

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          const k = msg.k;
          const candle = {
            time:   k.t,
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v),
            closed: k.x
          };
          candleStore.update(this.symbol.toUpperCase(), tf, candle);
          this.onUpdate(this.symbol.toUpperCase(), tf, candle);
        } catch (e) {
          console.warn('WS parse error', e);
        }
      };

      ws.onerror = (e) => console.warn('WS error', tf, e);
      ws.onclose = () => {
        if (this.active) {
          setTimeout(() => this._reconnect(tf), 3000);
        }
      };

      this.sockets[tf] = ws;
    }
  }

  _reconnect(tf) {
    if (!this.active) return;
    console.log('Reconnecting WS for', tf);
    const stream = `${this.symbol}@kline_${TF_MAP[tf]}`;
    const ws = new WebSocket(`${WS_BASE}/${stream}`);
    ws.onmessage = this.sockets[tf].onmessage;
    ws.onerror = this.sockets[tf].onerror;
    ws.onclose = this.sockets[tf].onclose;
    this.sockets[tf] = ws;
  }

  disconnect() {
    this.active = false;
    for (const ws of Object.values(this.sockets)) {
      ws.close();
    }
    this.sockets = {};
  }
}
