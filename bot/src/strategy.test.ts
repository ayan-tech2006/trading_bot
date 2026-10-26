// Self-check for the strategy rules. Run: npm test
import assert from 'node:assert/strict';
import { findSignals, outcome, type Candle } from './strategy.js';
import { fundingOk, takerOk, volumeOk } from './filters.js';
import type { Kline } from './binance.js';

// ---- filters ----
const k = (volume: number, takerBuyVolume = volume / 2): Kline => ({ openTime: 0, closeTime: 0, high: 1, low: 1, close: 1, volume, takerBuyVolume });
const vols = [...Array(20).fill(k(10)), k(15), k(20)];
assert.equal(volumeOk(vols, 20, 1.5), true); // 15 >= 1.5 x 10
assert.equal(volumeOk(vols, 20, 2), false);
assert.equal(volumeOk(vols, 19, 1.5), false, 'needs 20 earlier candles');
assert.equal(takerOk(k(100, 55), 'BUY'), true);
assert.equal(takerOk(k(100, 54), 'BUY'), false);
assert.equal(takerOk(k(100, 45), 'SELL'), true);
assert.equal(takerOk(k(100, 46), 'SELL'), false);
// funding every 8h; rates 1..100 over ~33 days, so the latest (100) is the top value
const H8 = 8 * 60 * 60_000;
const fund = [...Array(100)].map((_, i) => ({ time: i * H8, rate: i + 1 }));
assert.equal(fundingOk(fund, 99 * H8, 'BUY'), false, 'top 10% → skip BUY');
assert.equal(fundingOk(fund, 99 * H8, 'SELL'), true);
assert.equal(fundingOk(fund, 99 * H8 - 1, 'BUY'), false, 'uses value 99, known before t; still top 10%');
assert.equal(fundingOk(fund, 50 * H8, 'BUY'), false, 'future values (52..100) ignored: 51 is the max so far');
const falling = [...Array(100)].map((_, i) => ({ time: i * H8, rate: 100 - i }));
assert.equal(fundingOk(falling, 99 * H8, 'SELL'), false, 'bottom 10% → skip SELL');
assert.equal(fundingOk(falling, 99 * H8, 'BUY'), true);
// 90-day window: 30 old huge values (> 90 days back) must be ignored, then 270 rising values
const windowed = [...Array(300)].map((_, i) => ({ time: i * H8, rate: i < 30 ? 1000 : i }));
assert.equal(fundingOk(windowed, 299 * H8, 'BUY'), false, 'old values outside 90 days are not counted');

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

// ADX filter: the V-bottom BUY happens in a strong move (ADX high), so adx>=20 keeps it; ADX can't exceed 100
assert.equal(findSignals(candles, { adxMin: 20 }).filter((s) => s.side === 'BUY').length, 1);
assert.equal(findSignals(candles, { adxMin: 101 }).length, 0);

// rsi30 (SignalCompare mirror): the V-bottom pushes RSI to ~0, the climb crosses back above 30 once → one BUY,
// still under EMA50 → Medium. No volume → no signal (volume > 0 rule).
const withVol: Candle[] = candles.map((c) => ({ ...c, volume: 1 }));
const r30 = findSignals(withVol, { strategy: 'rsi30', slAtr: 1.5, tpAtr: 3 });
assert.deepEqual(r30.map((s) => [s.side, s.confidence]), [['BUY', 'Medium']]);
assert.equal(findSignals(candles, { strategy: 'rsi30' }).length, 0);

const buy = { side: 'BUY' as const, sl: 90, tp: 120 };
const sell = { side: 'SELL' as const, sl: 110, tp: 80 };
assert.equal(outcome(buy, 100, 95), null);
assert.equal(outcome(buy, 121, 95), 'win');
assert.equal(outcome(buy, 100, 89), 'loss');
assert.equal(outcome(buy, 121, 89), 'loss', 'both hit in one candle counts as loss');
assert.equal(outcome(sell, 111, 95), 'loss');
assert.equal(outcome(sell, 100, 79), 'win');

console.log('strategy self-check passed');
