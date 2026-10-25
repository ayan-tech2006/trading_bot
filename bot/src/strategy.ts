// Shared by the live bot and the backtest, so both run exactly the same rules.
import { ATR, BollingerBands, EMA, RSI } from 'technicalindicators';

export type Candle = { openTime: number; high: number; low: number; close: number };
export type Side = 'BUY' | 'SELL';
export type Signal = {
  openTime: number;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  rsi: number;
  emaFast: number;
  emaSlow: number;
};

export const RULES = { emaFast: 9, emaSlow: 21, rsi: 14, atr: 14, slAtr: 1.5, tpAtr: 3 };

// technicalindicators returns arrays shorter than the input; pad the front so index i == candle i
const pad = (arr: number[], len: number) => [...Array<number>(len - arr.length).fill(NaN), ...arr];

export type StrategyName = 'cross' | 'pullback' | 'breakout' | 'bollinger';
export type Options = {
  strategy?: StrategyName;
  /** pullback: RSI level, breakout: lookback candles, bollinger: std devs. Unused by cross. */
  param?: number;
  /** Only BUY above this EMA and only SELL below it (e.g. 200). Off when not given. */
  trendEma?: number;
  slAtr?: number;
  tpAtr?: number;
};
const DEFAULT_PARAM: Record<StrategyName, number> = { cross: 0, pullback: 40, breakout: 20, bollinger: 2 };

type Ind = { candles: Candle[]; close: number[]; fast: number[]; slow: number[]; rsi: number[] };
// Each rule says BUY/SELL/null for candle i. Comparisons against NaN (indicator warm-up) are false, so no signal.
const RULE_FNS: Record<StrategyName, (ind: Ind, p: number) => (i: number) => Side | null> = {
  // EMA 9/21 crossover, skipped when RSI is already stretched in the trade direction
  cross: ({ fast, slow, rsi }) => (i) =>
    fast[i - 1] <= slow[i - 1] && fast[i] > slow[i] && rsi[i] < 70 ? 'BUY'
    : fast[i - 1] >= slow[i - 1] && fast[i] < slow[i] && rsi[i] > 30 ? 'SELL'
    : null,

  // RSI dips below p then climbs back above it (SELL: mirror at 100 - p). Use with trendEma to buy dips in an uptrend.
  pullback: ({ rsi }, p) => (i) =>
    rsi[i - 1] < p && rsi[i] >= p ? 'BUY'
    : rsi[i - 1] > 100 - p && rsi[i] <= 100 - p ? 'SELL'
    : null,

  // First close above the highest high (or below the lowest low) of the previous p candles
  breakout: ({ candles, close }, p) => {
    const hi = candles.map((_, i) => (i < p ? NaN : Math.max(...candles.slice(i - p, i).map((c) => c.high))));
    const lo = candles.map((_, i) => (i < p ? NaN : Math.min(...candles.slice(i - p, i).map((c) => c.low))));
    return (i) =>
      close[i] > hi[i] && !(close[i - 1] > hi[i - 1]) ? 'BUY'
      : close[i] < lo[i] && !(close[i - 1] < lo[i - 1]) ? 'SELL'
      : null;
  },

  // Close back inside Bollinger(20, p) after closing outside it: fade the move
  bollinger: ({ close }, p) => {
    const bb = BollingerBands.calculate({ period: 20, stdDev: p, values: close });
    const lower = pad(bb.map((b) => b.lower), close.length);
    const upper = pad(bb.map((b) => b.upper), close.length);
    return (i) =>
      close[i - 1] < lower[i - 1] && close[i] > lower[i] ? 'BUY'
      : close[i - 1] > upper[i - 1] && close[i] < upper[i] ? 'SELL'
      : null;
  },
};

/** Every signal in the series. Candles must be closed and in time order. Defaults = the live bot's rules. */
export function findSignals(candles: Candle[], opts: Options = {}): Signal[] {
  const { strategy = 'cross', trendEma, slAtr = RULES.slAtr, tpAtr = RULES.tpAtr } = opts;
  const n = candles.length;
  const close = candles.map((c) => c.close);
  const fast = pad(EMA.calculate({ period: RULES.emaFast, values: close }), n);
  const slow = pad(EMA.calculate({ period: RULES.emaSlow, values: close }), n);
  const trend = trendEma ? pad(EMA.calculate({ period: trendEma, values: close }), n) : null;
  const rsi = pad(RSI.calculate({ period: RULES.rsi, values: close }), n);
  const atr = pad(
    ATR.calculate({ period: RULES.atr, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close }),
    n,
  );
  const rule = RULE_FNS[strategy]({ candles, close, fast, slow, rsi }, opts.param ?? DEFAULT_PARAM[strategy]);

  const out: Signal[] = [];
  for (let i = 1; i < n; i++) {
    if (Number.isNaN(atr[i])) continue;
    const side = rule(i);
    if (!side || (trend && !(side === 'BUY' ? close[i] > trend[i] : close[i] < trend[i]))) continue;

    const entry = close[i];
    const dir = side === 'BUY' ? 1 : -1;
    out.push({
      openTime: candles[i].openTime,
      side,
      entry,
      sl: entry - dir * slAtr * atr[i],
      tp: entry + dir * tpAtr * atr[i],
      rsi: rsi[i],
      emaFast: fast[i],
      emaSlow: slow[i],
    });
  }
  return out;
}

/** Did this candle hit SL or TP? If both are inside one candle we can't know the order, so count it as a loss. */
export function outcome(s: { side: Side; sl: number; tp: number }, high: number, low: number): 'win' | 'loss' | null {
  const slHit = s.side === 'BUY' ? low <= s.sl : high >= s.sl;
  const tpHit = s.side === 'BUY' ? high >= s.tp : low <= s.tp;
  return slHit ? 'loss' : tpHit ? 'win' : null;
}
