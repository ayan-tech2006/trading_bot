// Tune each strategy on the last 12 months (train), then check the winner on the 12 months before (test).
// The test year is never used to choose settings, so its result is the honest one.
import 'dotenv/config';
import { history, pct, simulate, stats, type Trade } from './sim.js';
import { findSignals, type Options, type StrategyName } from './strategy.js';

const PAIR = process.env.PAIR ?? 'BTCUSDT';
const TIMEFRAME = process.env.TIMEFRAME ?? '1h';
const MIN_TRADES = 30; // ignore configs with too few train trades to judge
const DAY = 24 * 60 * 60_000;

const now = Date.now();
const trainStart = now - 365 * DAY;
const testStart = now - 730 * DAY;

const GRID: Record<StrategyName, { param: number[]; trendEma: (number | undefined)[] }> = {
  cross: { param: [0], trendEma: [undefined, 200] },
  pullback: { param: [30, 35, 40, 45], trendEma: [200] },
  breakout: { param: [20, 50, 100], trendEma: [undefined, 200] },
  bollinger: { param: [2, 2.5], trendEma: [undefined, 200] },
};
const SL = [1, 1.5, 2];
const TP = [1, 2, 3];

const candles = await history(PAIR, TIMEFRAME, testStart - 40 * DAY); // extra 40 days so EMA 200 is warmed up
const split = (trades: Trade[]) => ({
  train: stats(trades.filter((t) => t.entryTime >= trainStart)),
  test: stats(trades.filter((t) => t.entryTime >= testStart && t.entryTime < trainStart)),
});
const row = (s: ReturnType<typeof stats>) =>
  `${String(s.count).padStart(4)} tr  ${pct(s.winRate).padStart(7)} win  ${pct(s.total).padStart(9)} ret  ${pct(s.maxDd).padStart(8)} dd`;
const label = (o: Options) =>
  `${o.strategy}${o.param ? ` p=${o.param}` : ''}${o.trendEma ? ` ema${o.trendEma}` : ''} sl=${o.slAtr} tp=${o.tpAtr}`;

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
console.log(`\n${PAIR} ${TIMEFRAME}  train ${day(trainStart)} → ${day(now)}  test ${day(testStart)} → ${day(trainStart)}`);
console.log('pick = best train return with at least', MIN_TRADES, 'train trades\n');

const baseline: Options = { strategy: 'cross', slAtr: 1.5, tpAtr: 3 };
const b = split(simulate(candles, findSignals(candles, baseline)).trades);
console.log(`baseline (live bot rules)  ${label(baseline)}`);
console.log(`  train ${row(b.train)}\n  test  ${row(b.test)}\n`);

for (const [strategy, g] of Object.entries(GRID) as [StrategyName, (typeof GRID)[StrategyName]][]) {
  const results = g.param.flatMap((param) =>
    g.trendEma.flatMap((trendEma) =>
      SL.flatMap((slAtr) =>
        TP.map((tpAtr) => {
          const opts: Options = { strategy, param: param || undefined, trendEma, slAtr, tpAtr };
          return { opts, ...split(simulate(candles, findSignals(candles, opts)).trades) };
        }),
      ),
    ),
  );
  const best = results.filter((r) => r.train.count >= MIN_TRADES).sort((a, b) => b.train.total - a.train.total)[0];
  const positive = (k: 'train' | 'test') => results.filter((r) => r[k].total > 0).length;

  console.log(`${strategy.toUpperCase()}  (${results.length} configs: ${positive('train')} positive on train, ${positive('test')} on test)`);
  if (!best) console.log('  no config with enough trades\n');
  else console.log(`  pick  ${label(best.opts)}\n  train ${row(best.train)}\n  test  ${row(best.test)}\n`);
}
