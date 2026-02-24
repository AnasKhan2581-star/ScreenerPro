// data/restLoader.js

const BINANCE_BASE = 'https://api.binance.com/api/v3';

function parseCandle(raw) {
  return {
    time:   raw[0],
    open:   parseFloat(raw[1]),
    high:   parseFloat(raw[2]),
    low:    parseFloat(raw[3]),
    close:  parseFloat(raw[4]),
    volume: parseFloat(raw[5])
  };
}

export async function fetchKlines(symbol, interval, limit = 300, startTime, endTime) {
  const params = new URLSearchParams({ symbol, interval, limit: Math.min(limit, 1000) });
  if (startTime) params.append('startTime', startTime);
  if (endTime) params.append('endTime', endTime);

  const res = await fetch(`${BINANCE_BASE}/klines?${params}`);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map(parseCandle);
}

export async function fetchMultiTF(symbol) {
  const [c15m, c1H, c4H] = await Promise.all([
    fetchKlines(symbol, '15m', 300),
    fetchKlines(symbol, '1h',  200),
    fetchKlines(symbol, '4h',  100)
  ]);
  return { '15m': c15m, '1H': c1H, '4H': c4H };
}

export async function fetchHistorical(symbol, interval, startTime, endTime) {
  const candles = [];
  let current = startTime;
  const batchSize = 1000;

  while (current < endTime) {
    const batch = await fetchKlines(symbol, interval, batchSize, current, endTime);
    if (!batch.length) break;
    candles.push(...batch);
    current = batch[batch.length - 1].time + 1;
    if (batch.length < batchSize) break;
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  return candles;
}

export async function fetchCurrentPrice(symbol) {
  const res = await fetch(`${BINANCE_BASE}/ticker/price?symbol=${symbol}`);
  const data = await res.json();
  return parseFloat(data.price);
}
