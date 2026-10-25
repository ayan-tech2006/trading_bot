// Historical download + trade simulation, shared by backtest.ts and tune.ts.
import { klines } from './binance.js';
import { outcome, type Candle, type Signal } from './strategy.js';

export const FEE = 0.001; // 0.1% per side
export const SLIPPAGE = 0.0005; // 0.05% per side
export const COST = 2 * (FEE + SLIPPAGE); // round trip, as a fraction of entry

/** Net return of one trade as a fraction (0.01 = +1%), after fees and slippage. Used by backtests and the live bot. */
export const netPnl = (side: 'BUY' | 'SELL', entry: number, exit: number) =>
  ((side === 'BUY' ? 1 : -1) * (exit - entry)) / entry - COST;

export type Trade ={ entryTime: number; exitTime: number; result: 'win' | 'loss'; pnl: number };

/** All closed candles from startTime until now. */
export async function history(pair: string, timeframe: string, startTime: number): Promise<Candle[]> {
  const all: Candle[] = [];
  for (let start = startTime; ; ) {
    const rows = await klines(pair, timeframe, start);
    all.push(...rows.filter((c) => c.closeTime < Date.now()));
    if (rows.length < 1000) return all;
    start = rows.at(-1)!.closeTime + 1;
  }
}

/** Each signal is tracked on its own, same as the live bot (overlapping signals allowed). */
export function simulate(candles: Candle[], signals: Signal[]): { trades: Trade[]; stillOpen: number } {
  const index = new Map(candles.map((c, i) => [c.openTime, i]));
  const trades: Trade[] = [];
  let stillOpen = 0;
  for (const s of signals) {
    let closed = false;
    for (let i = index.get(s.openTime)! + 1; i < candles.length && !closed; i++) {
      const result = outcome(s, candles[i].high, candles[i].low);
      if (!result) continue;
      const exit = result === 'win' ? s.tp : s.sl;
      trades.push({ entryTime: s.openTime, exitTime: candles[i].openTime, result, pnl: netPnl(s.side, s.entry, exit) });
      closed = true;
    }
    if (!closed) stillOpen++;
  }
  return { trades, stillOpen };
}

export function stats(trades: Trade[]) {
  const wins = trades.filter((t) => t.result === 'win');
  const losses = trades.filter((t) => t.result === 'loss');
  const avg = (xs: Trade[]) => (xs.length ? xs.reduce((a, t) => a + t.pnl, 0) / xs.length : 0);

  // Equity = running sum of per-trade % returns (1 unit per trade, no compounding), ordered by exit time.
  let total = 0, peak = 0, maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    total += t.pnl;
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, peak - total);
  }
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    total,
    maxDd,
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
