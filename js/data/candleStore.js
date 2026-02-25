// data/candleStore.js

export class CandleStore {
  constructor() {
    this.data = {};
    this.maxCandles = 500;
  }

  key(symbol, tf) {
    return `${symbol}_${tf}`;
  }

  set(symbol, tf, candles) {
    this.data[this.key(symbol, tf)] = candles.slice(-this.maxCandles);
  }

  get(symbol, tf) {
    return this.data[this.key(symbol, tf)] || [];
  }

  update(symbol, tf, candle) {
    const k = this.key(symbol, tf);
    if (!this.data[k]) this.data[k] = [];
    const arr = this.data[k];
    
    // Update last candle or append
    if (arr.length && arr[arr.length - 1].time === candle.time) {
      arr[arr.length - 1] = candle;
    } else {
      arr.push(candle);
      if (arr.length > this.maxCandles) arr.shift();
    }
  }

  hasData(symbol, tf) {
    return (this.data[this.key(symbol, tf)] || []).length > 0;
  }
}

export const candleStore = new CandleStore();
