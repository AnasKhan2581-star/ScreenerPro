// data/restLoader.js — Binance Spot API only
const BASE = 'https://api.binance.com/api/v3';

function parseCandle(raw) {
  return {
    time:   raw[0],
    open:   parseFloat(raw[1]),
    high:   parseFloat(raw[2]),
    low:    parseFloat(raw[3]),
    close:  parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
    closeTime: raw[6],
    trades: raw[8],
  };
}

export async function fetchKlines(symbol, interval, limit = 300, startTime, endTime) {
  const params = new URLSearchParams({ symbol, interval, limit: Math.min(limit, 1000) });
  if (startTime) params.append('startTime', startTime);
  if (endTime)   params.append('endTime',   endTime);
  const res = await fetch(`${BASE}/klines?${params}`);
  if (!res.ok) throw new Error(`Binance ${symbol} ${interval}: ${res.status}`);
  return (await res.json()).map(parseCandle);
}

export async function fetchMultiTF(symbol) {
  const [c15m, c1H, c4H] = await Promise.all([
    fetchKlines(symbol, '15m', 300),
    fetchKlines(symbol, '1h',  200),
    fetchKlines(symbol, '4h',  150),
  ]);
  return { '15m': c15m, '1H': c1H, '4H': c4H };
}

export async function fetchHistorical(symbol, interval, startTime, endTime) {
  const candles = [];
  let current = startTime;
  while (current < endTime) {
    const batch = await fetchKlines(symbol, interval, 1000, current, endTime);
    if (!batch.length) break;
    candles.push(...batch);
    current = batch[batch.length - 1].time + 1;
    if (batch.length < 1000) break;
    await new Promise(r => setTimeout(r, 250));
  }
  return candles;
}

// Fetch all SPOT USDT trading pairs from Binance exchange info
let _cachedSpotSymbols = null;
let _cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

export async function fetchAllSpotUSDTSymbols() {
  const now = Date.now();
  if (_cachedSpotSymbols && now - _cacheTime < CACHE_TTL) return _cachedSpotSymbols;
  try {
    // Use 24hr ticker for price change data (all USDT pairs)
    const res = await fetch(`${BASE}/ticker/24hr`);
    const tickers = await res.json();
    // Filter: USDT quote, positive volume, not a leveraged/margin token
    const blacklist = ['UP','DOWN','BULL','BEAR','3L','3S','2L','2S'];
    const symbols = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        if (parseFloat(t.quoteVolume) < 500000) return false; // min $500k daily volume
        const base = t.symbol.replace('USDT','');
        if (blacklist.some(b => base.endsWith(b))) return false;
        return true;
      })
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .map(t => ({
        symbol: t.symbol,
        volume: parseFloat(t.quoteVolume),
        change: parseFloat(t.priceChangePercent),
        price: parseFloat(t.lastPrice),
      }));
    _cachedSpotSymbols = symbols;
    _cacheTime = now;
    return symbols;
  } catch (e) {
    console.error('fetchAllSpotUSDTSymbols error:', e);
    // Fallback to major symbols if API fails
    return [
      { symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }, { symbol: 'BNBUSDT' },
      { symbol: 'SOLUSDT' }, { symbol: 'XRPUSDT' }, { symbol: 'ADAUSDT' },
      { symbol: 'AVAXUSDT' }, { symbol: 'DOTUSDT' }, { symbol: 'LINKUSDT' },
      { symbol: 'UNIUSDT' },
    ];
  }
}
