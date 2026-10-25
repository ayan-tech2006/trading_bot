// Final, pre-registered validation round. Settings and tests are fixed in this file; don't change after seeing results.
// 2 base strategies x {base, V1, V2, T1, F1} x 5 coins x 2 windows. Run: npm run prereg
import 'dotenv/config';
import { ATR } from 'technicalindicators';
import { fundingRates, type Kline } from './binance.js';
import { applyFilter, type FilterName, type Funding } from './filters.js';
import { history, pct, simulate, stats, type Trade } from './sim.js';
import { findSignals, RULES, type Options, type Side, type Signal } from './strategy.js';

const BASES: { name: string; timeframe: string; opts: Options; sl: number; tp: number }[] = [
  { name: 'cross_15m', timeframe: '15m', opts: {}, sl: 1.5, tp: 3 },
  { name: 'breakout_4h', timeframe: '4h', opts: { strategy: 'breakout', param: 100, adxMin: 25, slAtr: 1.5, tpAtr: 2 }, sl: 1.5, tp: 2 },
];
const FILTERS: FilterName[] = ['V1', 'V2', 'T1', 'F1'];
const VARIANTS = ['base', ...FILTERS] as const;
type Variant = (typeof VARIANTS)[number];
const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const RUNS = 2000;
// "Promising" (decided before running): beats its own baseline net PnL in >= 8 of its 10 coin/window combos
// AND is itself net positive in >= 7 of 10. Only promising variants get the randomness test.
const PROMISING_BEAT = 8;
const PROMISING_POSITIVE = 7;

const DAY = 24 * 60 * 60_000;
const now = Date.now();
const WINDOWS = [
  { name: 'Oct22-Oct24', from: now - 1460 * DAY, to: now - 730 * DAY },
  { name: 'Oct24-Oct26', from: now - 730 * DAY, to: now },
];
type Win = (typeof WINDOWS)[number];
const inWin = (w: Win) => (t: { entryTime?: number; openTime?: number }) => {
  const x = t.entryTime ?? t.openTime!;
  return x >= w.from && x < w.to;
};

type Stats = ReturnType<typeof stats>;
type Result = { base: string; variant: Variant; coin: string; window: string; s: Stats; signals: Signal[] };
const results: Result[] = [];
const candleStore = new Map<string, Kline[]>(); // `${coin} ${timeframe}` → candles, kept for the randomness test

const pf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const line = (r: Result) =>
  `${r.base.padEnd(11)} ${r.variant.padEnd(4)} ${r.coin.padEnd(8)} ${r.window}  ${String(r.s.count).padStart(5)}  ${pct(r.s.winRate).padStart(7)}  ${pct(r.s.total).padStart(9)}  ${pct(r.s.maxDd).padStart(8)}  ${pf(r.s.profitFactor).padStart(5)}`;

console.log('\nPre-registered validation. Costs 0.1% fee + 0.05% slippage per side.\n');
console.log('base        var  coin     window        trades  win rate    net PnL    max DD     PF');

for (const coin of COINS) {
  const funding: Funding = await fundingRates(coin, WINDOWS[0].from - 140 * DAY); // 90-day lookback + margin
  for (const base of BASES) {
    const candles = await history(coin, base.timeframe, WINDOWS[0].from - 40 * DAY);
    candleStore.set(`${coin} ${base.timeframe}`, candles);
    const baseSignals = findSignals(candles, base.opts);
    for (const variant of VARIANTS) {
      const signals = variant === 'base' ? baseSignals : applyFilter(variant, candles, baseSignals, funding);
      const { trades } = simulate(candles, signals);
      for (const w of WINDOWS) {
        const r: Result = { base: base.name, variant, coin, window: w.name, s: stats(trades.filter(inWin(w))), signals: signals.filter(inWin(w)) };
        results.push(r);
        console.log(line(r));
      }
    }
    console.log();
  }
}

// ---- 1. Filter vs its own unfiltered baseline ----
const baselineOf = (r: Result) => results.find((b) => b.variant === 'base' && b.base === r.base && b.coin === r.coin && b.window === r.window)!;
const expectancy = (s: Stats) => (s.count ? s.total / s.count : 0);
console.log('1) Filter vs its own baseline (20 combos per filter = 2 bases x 5 coins x 2 windows)');
console.log('filter  beats base net PnL   (cross_15m / breakout_4h)   beats base per-trade avg   filtered net > 0');
for (const f of FILTERS) {
  const rows = results.filter((r) => r.variant === f);
  const beat = rows.filter((r) => r.s.total > baselineOf(r).s.total);
  const beatExp = rows.filter((r) => r.s.count > 0 && expectancy(r.s) > expectancy(baselineOf(r).s));
  const byBase = BASES.map((b) => beat.filter((r) => r.base === b.name).length).join(' / ');
  console.log(`${f.padEnd(6)}  ${String(beat.length).padStart(2)}/20               (${byBase})                     ${String(beatExp.length).padStart(2)}/20                     ${rows.filter((r) => r.s.total > 0).length}/20`);
}
const baseRows = results.filter((r) => r.variant === 'base');
console.log(`baselines net > 0: ${baseRows.filter((r) => r.s.total > 0).length}/${baseRows.length} combos`);

// ---- 2. Randomness test for promising variants only ----
console.log(`\n2) Promising = beats baseline in >= ${PROMISING_BEAT}/10 AND net > 0 in >= ${PROMISING_POSITIVE}/10 (per base x filter)`);
const promising = BASES.flatMap((b) =>
  FILTERS.map((f) => {
    const rows = results.filter((r) => r.base === b.name && r.variant === f);
    const beat = rows.filter((r) => r.s.total > baselineOf(r).s.total).length;
    const positive = rows.filter((r) => r.s.total > 0).length;
    console.log(`  ${b.name} + ${f}: beats baseline ${beat}/10, net > 0 ${positive}/10 → ${beat >= PROMISING_BEAT && positive >= PROMISING_POSITIVE ? 'PROMISING' : 'not promising'}`);
    return { b, f, rows, ok: beat >= PROMISING_BEAT && positive >= PROMISING_POSITIVE };
  }),
).filter((p) => p.ok);

let seed = 42; // fixed seed: reproducible
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

/** Random entries in the same window: same trade count, same BUY/SELL mix, same SL/TP x ATR, same costs. */
function randomTotals(candles: Kline[], real: Signal[], w: Win, sl: number, tp: number): number[] {
  const atr = ATR.calculate({ period: RULES.atr, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const off = candles.length - atr.length;
  const pool = candles.map((_, i) => i).filter((i) => i >= off && candles[i].openTime >= w.from && candles[i].openTime < w.to);
  const sides: Side[] = real.map((s) => s.side);
  return Array.from({ length: RUNS }, () => {
    const picks = new Set<number>();
    while (picks.size < sides.length) picks.add(pool[Math.floor(rand() * pool.length)]);
    const signals: Signal[] = [...picks].sort((a, b) => a - b).map((i, k) => {
      const side = sides[k], entry = candles[i].close, dir = side === 'BUY' ? 1 : -1, a = atr[i - off];
      return { openTime: candles[i].openTime, side, entry, sl: entry - dir * sl * a, tp: entry + dir * tp * a, rsi: NaN, emaFast: NaN, emaSlow: NaN };
    });
    return stats(simulate(candles, signals).trades).total;
  });
}

if (!promising.length) console.log('  → no promising variant, randomness test not run (as pre-registered)');
for (const p of promising) {
  console.log(`\n  Randomness test: ${p.b.name} + ${p.f} (${RUNS} runs per combo)`);
  for (const r of p.rows.filter((x) => x.s.count > 0)) {
    const w = WINDOWS.find((x) => x.name === r.window)!;
    const totals = randomTotals(candleStore.get(`${r.coin} ${p.b.timeframe}`)!, r.signals, w, p.b.sl, p.b.tp);
    const beat = totals.filter((t) => t >= r.s.total).length / RUNS;
    console.log(`    ${r.coin.padEnd(8)} ${r.window}  real ${pct(r.s.total).padStart(9)}  random >= real: ${(beat * 100).toFixed(1)}%`);
  }
}
console.log();
