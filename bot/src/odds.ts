// Per-trade win chance for the signal card: how often similar past signals (same strategy, same side,
// same EMA 200 trend) hit TP before SL, plus the win rate this trade needs to break even after costs.
import { EMA } from 'technicalindicators';
import { COST, simulate } from './sim.js';
import { findSignals, type Candle, type Options, type Side, type Signal } from './strategy.js';

export type Trend = 'up' | 'down';
export type Odds = Map<string, { wins: number; n: number }>;

export const oddsKey = (side: Side, trend: Trend) => `${side} ${trend}`;

/** Trend at each candle: close above or below EMA 200 (undefined during the first 199 candles). */
export function trendOf(candles: Candle[]): (openTime: number) => Trend | undefined {
  const ema = EMA.calculate({ period: 200, values: candles.map((c) => c.close) });
  const off = candles.length - ema.length;
  const byTime = new Map(candles.slice(off).map((c, i) => [c.openTime, c.close > ema[i] ? 'up' : 'down'] as const));
  return (t) => byTime.get(t);
}

/** Win counts per side+trend bucket over the given history, with the same rules and outcome logic as the backtests. */
export function buildOdds(candles: Candle[], opts: Options): Odds {
  const signals = findSignals(candles, opts);
  const trend = trendOf(candles);
  const side = new Map(signals.map((s) => [s.openTime, s.side]));
  const odds: Odds = new Map();
  for (const t of simulate(candles, signals).trades) {
    const tr = trend(t.entryTime);
    if (!tr) continue;
    const k = oddsKey(side.get(t.entryTime)!, tr);
    const o = odds.get(k) ?? { wins: 0, n: 0 };
    o.n++;
    if (t.result === 'win') o.wins++;
    odds.set(k, o);
  }
  return odds;
}

/** Win rate at which this trade's TP/SL distances break even after fees and slippage. */
export const breakeven = (s: Pick<Signal, 'entry' | 'sl' | 'tp'>) => {
  const tp = Math.abs(s.tp - s.entry) / s.entry;
  const sl = Math.abs(s.sl - s.entry) / s.entry;
  return (sl + COST) / (tp + sl);
};
