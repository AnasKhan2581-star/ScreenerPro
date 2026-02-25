// core/sessionEngine.js

export const SESSIONS = {
  ASIAN:  { name: 'Asian',  start: 0,  end: 8,  color: '#9b5cf6' },
  LONDON: { name: 'London', start: 8,  end: 12, color: '#00d4ff' },
  NY:     { name: 'NY',     start: 13, end: 17, color: '#00e87a' },
  OFF:    { name: 'Off',    start: 17, end: 24, color: '#3d5169' }
};

export function getCurrentSession(date = new Date()) {
  const hour = date.getUTCHours();
  if (hour >= 0  && hour < 8)  return SESSIONS.ASIAN;
  if (hour >= 8  && hour < 12) return SESSIONS.LONDON;
  if (hour >= 13 && hour < 17) return SESSIONS.NY;
  return SESSIONS.OFF;
}

export function isValidSession(settings) {
  if (!settings.sessionFilter) return true;
  const s = getCurrentSession();
  return s !== SESSIONS.OFF;
}

export function getSessionName() {
  return getCurrentSession().name;
}

export function isLondonOrNY() {
  const s = getCurrentSession();
  return s === SESSIONS.LONDON || s === SESSIONS.NY;
}

export function getAsianRange(candles) {
  const now = Date.now();
  const asianStart = new Date(now);
  asianStart.setUTCHours(0, 0, 0, 0);
  const asianEnd = new Date(now);
  asianEnd.setUTCHours(8, 0, 0, 0);

  const asianCandles = candles.filter(c => {
    const t = c.time;
    return t >= asianStart.getTime() && t < asianEnd.getTime();
  });

  if (!asianCandles.length) return null;

  const high = Math.max(...asianCandles.map(c => c.high));
  const low = Math.min(...asianCandles.map(c => c.low));
  return { high, low };
}
