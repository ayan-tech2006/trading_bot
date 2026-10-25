// Self-check for the strategy rules. Run: npm test
import assert from 'node:assert/strict';
import { findSignals, outcome, type Candle } from './strategy.js';

// 60 candles falling, then 60 rising: the 9 EMA must cross above the 21 EMA once → one BUY
const prices = [...Array(60)].map((_, i) => 100 - i * 0.5).concat([...Array(60)].map((_, i) => 70 + i * 0.5));
const candles: Candle[] = prices.map((p, i) => ({ openTime: i, high: p + 1, low: p - 1, close: p }));
const buys = findSignals(candles).filter((s) => s.side === 'BUY');
assert.equal(buys.length, 1);
const b = buys[0];
assert.ok(b.sl < b.entry && b.entry < b.tp, 'BUY: sl < entry < tp');
assert.ok(Math.abs((b.tp - b.entry) / (b.entry - b.sl) - 2) < 1e-9, 'TP is 2x the SL distance (3 vs 1.5 ATR)');

// RSI filter: a single +40 spike after a slow fall makes the EMAs cross, but RSI is ~86 (> 70) → no BUY
const spike: Candle[] = prices.slice(0, 60).concat(prices[59] + 40).map((p, i) => ({ openTime: i, high: p + 1, low: p - 1, close: p }));
assert.equal(findSignals(spike).length, 0);

// Trend filter: the same V-bottom BUY happens below a long falling EMA, so EMA 50 blocks it
assert.equal(findSignals(candles, { trendEma: 50 }).filter((s) => s.side === 'BUY').length, 0);

// Breakout: first close above the previous 20-candle high after the V-bottom → BUY, and only once in a row
const flat: Candle[] = prices.map((p, i) => ({ openTime: i, high: p, low: p - 0.1, close: p })); // no upper wick
const brk = findSignals(flat, { strategy: 'breakout', param: 20 }).filter((s) => s.side === 'BUY');
assert.equal(brk.length, 1);

// Bollinger: a close below the lower band, then back inside → BUY
const dip: Candle[] = [...Array(40).fill(100), 80, 99].map((p, i) => ({ openTime: i, high: p + 1, low: p - 1, close: p }));
assert.deepEqual(findSignals(dip, { strategy: 'bollinger', param: 2 }).map((s) => [s.openTime, s.side]), [[41, 'BUY']]);

// Pullback: RSI climbing back through 40 → BUY; the trend filter blocks it while price is under EMA 50
const pb = findSignals(candles, { strategy: 'pullback', param: 40 }).filter((s) => s.side === 'BUY');
assert.ok(pb.length >= 1);
assert.equal(findSignals(candles, { strategy: 'pullback', param: 40, trendEma: 50 }).filter((s) => s.side === 'BUY').length, 0);

const buy = { side: 'BUY' as const, sl: 90, tp: 120 };
const sell = { side: 'SELL' as const, sl: 110, tp: 80 };
assert.equal(outcome(buy, 100, 95), null);
assert.equal(outcome(buy, 121, 95), 'win');
assert.equal(outcome(buy, 100, 89), 'loss');
assert.equal(outcome(buy, 121, 89), 'loss', 'both hit in one candle counts as loss');
assert.equal(outcome(sell, 111, 95), 'loss');
assert.equal(outcome(sell, 100, 79), 'win');

console.log('strategy self-check passed');
