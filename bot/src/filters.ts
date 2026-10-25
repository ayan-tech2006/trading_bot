// Pre-registered signal filters (V1, V2, T1, F1). Each only looks at data known when the signal candle closes.
import type { Kline } from './binance.js';
import type { Side, Signal } from './strategy.js';

export type FilterName = 'V1' | 'V2' | 'T1' | 'F1';
export type Funding = { time: number; rate: number }[]; // oldest first
const DAY = 24 * 60 * 60_000;

/** Signal candle volume >= mult x the average volume of the 20 candles BEFORE it. */
export function volumeOk(candles: Kline[], i: number, mult: number): boolean {
  if (i < 20) return false;
  let sum = 0;
  for (let k = i - 20; k < i; k++) sum += candles[k].volume;
  return candles[i].volume >= (mult * sum) / 20;
}

/** Taker buy share of the signal candle: BUY needs >= 0.55, SELL needs <= 0.45. */
export function takerOk(c: Kline, side: Side): boolean {
  if (!c.volume) return false;
  const share = c.takerBuyVolume / c.volume;
  return side === 'BUY' ? share >= 0.55 : share <= 0.45;
}

/**
 * Latest funding known at time t vs the funding values of the 90 days up to t.
 * Skip BUY when it's in the top 10% (crowded longs), skip SELL when in the bottom 10% (crowded shorts).
 */
export function fundingOk(funding: Funding, t: number, side: Side): boolean {
  let lo = 0, hi = funding.length - 1, last = -1; // binary search: last index with time <= t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (funding[mid].time <= t) (last = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (last < 0) return true; // no funding known yet: filter can't judge, keep the signal
  const now = funding[last].rate;
  let n = 0, below = 0, above = 0;
  for (let k = last; k >= 0 && funding[k].time > t - 90 * DAY; k--) {
    n++;
    if (funding[k].rate < now) below++;
    if (funding[k].rate > now) above++;
  }
  return side === 'BUY' ? below / n < 0.9 : above / n < 0.9;
}

export function applyFilter(name: FilterName, candles: Kline[], signals: Signal[], funding: Funding): Signal[] {
  const index = new Map(candles.map((c, i) => [c.openTime, i]));
  return signals.filter((s) => {
    const i = index.get(s.openTime)!;
    if (name === 'V1') return volumeOk(candles, i, 1.5);
    if (name === 'V2') return volumeOk(candles, i, 2);
    if (name === 'T1') return takerOk(candles[i], s.side);
    return fundingOk(funding, candles[i].closeTime, s.side);
  });
}
