// utils/swings.js

export function detectSwings(candles, leftBars = 3, rightBars = 3) {
  const highs = [];
  const lows = [];
  const n = candles.length;

  for (let i = leftBars; i < n - rightBars; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, price: c.high, time: c.time });
    if (isLow) lows.push({ index: i, price: c.low, time: c.time });
  }

  return { highs, lows };
}

export function detectEqualHighsLows(swingHighs, swingLows, tolerance = 0.001) {
  const equalHighs = [];
  const equalLows = [];

  for (let i = 0; i < swingHighs.length - 1; i++) {
    for (let j = i + 1; j < swingHighs.length; j++) {
      const diff = Math.abs(swingHighs[i].price - swingHighs[j].price) / swingHighs[i].price;
      if (diff <= tolerance) {
        equalHighs.push([swingHighs[i], swingHighs[j]]);
      }
    }
  }

  for (let i = 0; i < swingLows.length - 1; i++) {
    for (let j = i + 1; j < swingLows.length; j++) {
      const diff = Math.abs(swingLows[i].price - swingLows[j].price) / swingLows[i].price;
      if (diff <= tolerance) {
        equalLows.push([swingLows[i], swingLows[j]]);
      }
    }
  }

  return { equalHighs, equalLows };
}

export function getLastNSwings(candles, n = 20, leftBars = 2, rightBars = 2) {
  const { highs, lows } = detectSwings(candles.slice(-Math.max(n * 5, 100)), leftBars, rightBars);
  return {
    highs: highs.slice(-n),
    lows: lows.slice(-n)
  };
}

export function detectHigherLows(lows, minCount = 3, minSpacing = 3) {
  if (lows.length < minCount) return [];
  const groups = [];
  let current = [lows[0]];

  for (let i = 1; i < lows.length; i++) {
    const last = current[current.length - 1];
    if (lows[i].price > last.price && (lows[i].index - last.index) >= minSpacing) {
      current.push(lows[i]);
      if (current.length >= minCount) {
        groups.push([...current]);
      }
    } else if (lows[i].price <= last.price) {
      current = [lows[i]];
    }
  }

  return groups;
}
