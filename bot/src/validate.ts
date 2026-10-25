// Validate the 4h Breakout pick WITHOUT re-tuning: fixed settings, other coins, and a randomness check on BTC.
// Run: npm run validate
import 'dotenv/config';
import { ATR } from 'technicalindicators';
import { history, pct, simulate, stats, type Trade } from './sim.js';
import { findSignals, RULES, type Candle, type Options, type Signal } from './strategy.js';

// Chosen by tune.ts on BTC 4h train data. Do not change after seeing results.
const PICK: Options = { strategy: 'breakout', param: 100, adxMin: 25, slAtr: 1.5, tpAtr: 2 };
const TIMEFRAME = '4h';
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const RUNS = 2000;
const DAY = 24 * 60 * 60_000;

const now = Date.now();
const WINDOWS = [
  { name: 'Oct22-Oct24', from: now - 1460 * DAY, to: now - 730 * DAY },
  { name: 'Oct24-Oct26', from: now - 730 * DAY, to: now },
];
const inWindow = (w: { from: number; to: number }) => (t: Trade) => t.entryTime >= w.from && t.entryTime < w.to;
const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');

// ---- 1. Same settings on other coins ----
console.log(`\n4h Breakout, fixed settings ${JSON.stringify(PICK)}, costs 0.3% per round trip\n`);
console.log('coin      window        trades  win rate   net PnL    max DD   profit factor');
const btc: { candles: Candle[]; signals: Signal[] } = { candles: [], signals: [] };
for (const coin of COINS) {
  const candles = await history(coin, TIMEFRAME, WINDOWS[0].from - 40 * DAY); // 40 days warm-up
  const signals = findSignals(candles, PICK);
  const { trades } = simulate(candles, signals);
  if (coin === 'BTCUSDT') Object.assign(btc, { candles, signals });
  for (const w of WINDOWS) {
    const s = stats(trades.filter(inWindow(w)));
    console.log(
      `${coin.padEnd(9)} ${w.name}  ${String(s.count).padStart(6)}  ${pct(s.winRate).padStart(8)}  ${pct(s.total).padStart(8)}  ${pct(s.maxDd).padStart(8)}  ${pf(s.profitFactor).padStart(6)}`,
    );
  }
}

// ---- 2. Randomness check on BTC, Oct22-Oct24 ----
// Random entries: same number of trades, same BUY/SELL mix, same SL/TP rule (1.5/2 x ATR), same costs.
// Only the entry timing is random, so this asks: does the breakout timing beat luck?
const w = WINDOWS[0];
const { candles } = btc;
const real = simulate(candles, btc.signals).trades.filter(inWindow(w));
const realTotal = stats(real).total;
const realSides = btc.signals.filter((s) => s.openTime >= w.from && s.openTime < w.to).map((s) => s.side);

const atr = ATR.calculate({ period: RULES.atr, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
const atrAt = (i: number) => atr[i - (candles.length - atr.length)];
const pool = candles.map((c, i) => i).filter((i) => candles[i].openTime >= w.from && candles[i].openTime < w.to);

let seed = 42; // fixed seed so the result is reproducible
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function randomRun(randomSide: boolean): number {
  const picks = new Set<number>();
  while (picks.size < realSides.length) picks.add(pool[Math.floor(rand() * pool.length)]);
  const signals: Signal[] = [...picks].sort((a, b) => a - b).map((i, k) => {
    const side = randomSide ? (rand() < 0.5 ? 'BUY' : 'SELL') : realSides[k % realSides.length];
    const entry = candles[i].close, dir = side === 'BUY' ? 1 : -1;
    return { openTime: candles[i].openTime, side, entry, sl: entry - dir * PICK.slAtr! * atrAt(i), tp: entry + dir * PICK.tpAtr! * atrAt(i), rsi: NaN, emaFast: NaN, emaSlow: NaN };
  });
  return stats(simulate(candles, signals).trades).total;
}

console.log(`\nRandomness check, BTC 4h ${w.name}: real = ${real.length} trades, net ${pct(realTotal)}`);
for (const [label, randomSide] of [['same BUY/SELL mix, random timing', false], ['random side, random timing', true]] as const) {
  const totals = Array.from({ length: RUNS }, () => randomRun(randomSide)).sort((a, b) => a - b);
  const beat = totals.filter((t) => t >= realTotal).length / RUNS;
  console.log(
    `  ${label.padEnd(34)} ${RUNS} runs: median ${pct(totals[RUNS / 2])}, 5%-95% ${pct(totals[RUNS * 0.05])} … ${pct(totals[RUNS * 0.95])}, random >= real: ${(beat * 100).toFixed(1)}%`,
  );
}
console.log();
