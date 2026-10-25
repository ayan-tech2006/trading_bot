// Backtest one strategy on Binance history. No API key, no Supabase needed.
// e.g. STRATEGY=breakout PARAM=50 TIMEFRAME=1h TREND_EMA=200 npm run backtest
import 'dotenv/config';
import { COST, FEE, SLIPPAGE, history, pct, simulate, stats } from './sim.js';
import { findSignals, type StrategyName } from './strategy.js';

const PAIR = process.env.PAIR ?? 'BTCUSDT';
const MONTHS = Number(process.env.MONTHS ?? 6);
const TIMEFRAME = process.env.TIMEFRAME ?? '15m';
const env = (k: string) => Number(process.env[k]) || undefined; // empty = strategy default
const opts = {
  strategy: (process.env.STRATEGY || 'cross') as StrategyName,
  param: env('PARAM'),
  trendEma: env('TREND_EMA'),
  slAtr: env('SL_ATR'),
  tpAtr: env('TP_ATR'),
};

const candles = await history(PAIR, TIMEFRAME, Date.now() - MONTHS * 30 * 24 * 60 * 60_000);
const signals = findSignals(candles, opts);
const { trades, stillOpen } = simulate(candles, signals);
const s = stats(trades);

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
console.log(`\n${PAIR} ${TIMEFRAME}  ${JSON.stringify(opts)}  ${day(candles[0].openTime)} → ${day(candles.at(-1)!.openTime)}  (${candles.length} candles)`);
console.log(`costs per trade: ${pct(COST)} (fees ${pct(FEE)} + slippage ${pct(SLIPPAGE)}, each side)\n`);
console.log(`total signals : ${signals.length}  (closed ${s.count}, still open ${stillOpen})`);
console.log(`win rate      : ${s.count ? pct(s.winRate) : 'n/a'}  (${s.wins} W / ${s.losses} L)`);
console.log(`avg win       : ${pct(s.avgWin)}`);
console.log(`avg loss      : ${pct(s.avgLoss)}`);
console.log(`total return  : ${pct(s.total)}  (sum of trades, 1 unit each)`);
console.log(`max drawdown  : ${pct(s.maxDd)}\n`);
