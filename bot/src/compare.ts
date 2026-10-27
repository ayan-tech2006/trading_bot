// Cross-check our rsi30_1h signals against Freqtrade's SignalCompare trades, matched by signal candle.
//   Live (dry-run):  npx tsx src/compare.ts --sqlite ~/freqtrade/user_data/tradesv3.dryrun.sqlite [--since 2026-10-27]
//   Backtest:        npx tsx src/compare.ts --ft-json bt.json   (our side recomputed from Binance 1h history)
// Freqtrade enters on the NEXT candle's open, so its signal candle = entry candle - 1h.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@supabase/supabase-js';
import { history, simulate } from './sim.js';
import { findSignals } from './strategy.js';

const HOUR = 60 * 60_000;
type Result = 'win' | 'loss' | null;
type Row = { signal: number; confidence: string | null; result: Result; netPct: number | null; open?: number; close?: number | null };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const toMs = (d: string) => Date.parse(d.includes('T') ? d : `${d.replace(' ', 'T')}${/[+Z]/.test(d.slice(10)) ? '' : 'Z'}`);
const hour = (t: number) => Math.floor(t / HOUR) * HOUR;
const ftResult = (exit: string | null): Result =>
  exit === 'tp_atr' ? 'win' : exit && /stop/.test(exit) ? 'loss' : null; // stop_loss, trailing_stop_loss, stoploss_on_exchange

type FtTrade = { open_date: string; close_date: string | null; enter_tag: string | null; exit_reason: string | null; profit: number | null };
function ftRows(): Row[] {
  let trades: FtTrade[];
  const sqlite = arg('sqlite'), json = arg('ft-json');
  if (sqlite) {
    const db = new DatabaseSync(sqlite, { readOnly: true });
    trades = db
      .prepare("select open_date, close_date, enter_tag, exit_reason, close_profit as profit from trades where pair like 'BTC/USDT%' order by open_date")
      .all() as FtTrade[];
  } else if (json) {
    const bt = JSON.parse(readFileSync(json, 'utf8'));
    trades = bt.strategy.SignalCompare.trades.map((t: FtTrade & { profit_ratio: number }) => ({ ...t, profit: t.profit_ratio }));
  } else throw new Error('pass --sqlite <tradesv3.dryrun.sqlite> or --ft-json <backtest trades json>');
  return trades.map((t) => {
    const open = toMs(t.open_date);
    return {
      signal: hour(open) - HOUR,
      confidence: t.enter_tag,
      result: ftResult(t.exit_reason),
      netPct: t.close_date && t.profit != null ? t.profit * 100 : null,
      open,
      close: t.close_date ? toMs(t.close_date) : null,
    };
  });
}

async function ourRows(from: number, to: number): Promise<Row[]> {
  if (arg('sqlite')) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    const db = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data, error } = await db
      .from('signals')
      .select('candle_open_time, confidence, status, net_pnl_pct')
      .eq('strategy', 'rsi30_1h')
      .order('candle_open_time');
    if (error) throw new Error(error.message);
    return data.map((s) => ({
      signal: toMs(s.candle_open_time),
      confidence: s.confidence,
      result: s.status === 'open' ? null : s.status,
      netPct: s.net_pnl_pct,
    }));
  }
  const candles = await history('BTCUSDT', '1h', from - 60 * 24 * HOUR); // 60 days warm-up
  const signals = findSignals(candles, { strategy: 'rsi30', slAtr: 1.5, tpAtr: 3 });
  const trades = new Map(simulate(candles, signals).trades.map((t) => [t.entryTime, t]));
  return signals
    .filter((s) => s.openTime >= from && s.openTime <= to)
    .map((s) => {
      const t = trades.get(s.openTime);
      return { signal: s.openTime, confidence: s.confidence ?? null, result: t?.result ?? null, netPct: t ? t.pnl * 100 : null };
    });
}

function summary(name: string, rows: Row[]) {
  const closed = rows.filter((r) => r.result && r.netPct != null);
  const wins = closed.filter((r) => r.result === 'win').length;
  const exp = closed.length ? closed.reduce((a, r) => a + r.netPct!, 0) / closed.length : NaN;
  console.log(
    `${name.padEnd(10)} signals ${String(rows.length).padStart(4)}  closed ${String(closed.length).padStart(4)}  ` +
      `win rate ${closed.length ? ((wins / closed.length) * 100).toFixed(1) + '%' : 'n/a'}  ` +
      `expectancy ${Number.isNaN(exp) ? 'n/a' : exp.toFixed(3) + '% per trade'}`,
  );
}

const ft = ftRows();
const since = arg('since') ? toMs(arg('since')!) : ft.length ? ft[0].signal : 0;
const until = arg('until') ? toMs(arg('until')!) : Date.now();
const ours = (await ourRows(since, until)).filter((r) => r.signal >= since && r.signal <= until);
const ftIn = ft.filter((r) => r.signal >= since && r.signal <= until);
const ftBy = new Map(ftIn.map((r) => [r.signal, r]));
const oursBy = new Map(ours.map((r) => [r.signal, r]));

const matched = ours.filter((r) => ftBy.has(r.signal));
const oursOnly = ours.filter((r) => !ftBy.has(r.signal));
// Freqtrade holds at most one trade per pair, so it skips signals while a BTC/USDT trade is open
const busy = (t: number) => ft.some((f) => f.open! <= t + HOUR && (f.close == null || f.close > t + HOUR));
const oursOnlyBusy = oursOnly.filter((r) => busy(r.signal));
const ftOnly = ftIn.filter((r) => !oursBy.has(r.signal));

const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
console.log(`\nrsi30_1h vs Freqtrade SignalCompare, signal candles ${day(since)} → ${day(until)} UTC\n`);
console.log(`matched (same signal candle)             : ${matched.length}`);
console.log(`ours only, Freqtrade already in a trade  : ${oursOnlyBusy.length}  (expected: 1 trade per pair)`);
console.log(`ours only, otherwise                     : ${oursOnly.length - oursOnlyBusy.length}`);
console.log(`Freqtrade only                           : ${ftOnly.length}`);

const sameConf = matched.filter((r) => r.confidence === ftBy.get(r.signal)!.confidence).length;
const bothClosed = matched.filter((r) => r.result && ftBy.get(r.signal)!.result);
const sameResult = bothClosed.filter((r) => r.result === ftBy.get(r.signal)!.result).length;
console.log(`\nmatched: same confidence ${sameConf}/${matched.length}, same win/loss ${sameResult}/${bothClosed.length} (both closed)`);
for (const r of [...oursOnly.filter((x) => !busy(x.signal)), ...ftOnly].slice(0, 10))
  console.log(`  mismatch ${day(r.signal)}  ${oursBy.has(r.signal) ? 'ours only' : 'freqtrade only'}`);

console.log();
summary('ours', ours);
summary('freqtrade', ftIn);
console.log('\nnote: our net includes 0.1% fee + 0.05% slippage per side; Freqtrade dry-run includes fees only.\n');
