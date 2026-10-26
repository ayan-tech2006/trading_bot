// Live paper-testing bot: watches closed candles, saves signals to Supabase, marks them win/loss.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { klines, openInterest } from './binance.js';
import { netPnl } from './sim.js';
import { findSignals, outcome, type Candle, type Options } from './strategy.js';

const PAIR = process.env.PAIR ?? 'BTCUSDT';
const HISTORY = 500; // enough candles for the indicators to settle (breakout needs 100, ADX ~30)
const WS_URL = process.env.BINANCE_WS ?? 'wss://stream.binance.com:9443/ws';

// Each live strategy gets its own candle stream. Settings are fixed; don't tune them after seeing live results.
const STRATEGIES: { name: string; timeframe: '15m' | '1h' | '4h'; opts: Options; candles: Candle[] }[] = [
  { name: 'cross_15m', timeframe: '15m', opts: {}, candles: [] }, // original EMA 9/21 rules
  { name: 'breakout_4h', timeframe: '4h', opts: { strategy: 'breakout', param: 100, adxMin: 25, slAtr: 1.5, tpAtr: 2 }, candles: [] },
  // same rules as freqtrade/strategies/SignalCompare.py, to cross-check against Freqtrade's dry-run
  { name: 'rsi30_1h', timeframe: '1h', opts: { strategy: 'rsi30', slAtr: 1.5, tpAtr: 3 }, candles: [] },
];
type Strategy = (typeof STRATEGIES)[number];
const TF_MS: Record<string, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000 };

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in bot/.env');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const logError = (...a: unknown[]) => console.error(new Date().toISOString(), 'ERROR', ...a);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** Telegram alert. Skipped when not configured; never throws, so a Telegram outage can't stop the bot. */
async function notify(text: string) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) logError('telegram', res.status, await res.text());
  } catch (e) {
    logError('telegram', e);
  }
}

/** Run the strategy on the newest closed candle and save a signal if it fires there. */
async function evaluateLatest(st: Strategy) {
  const last = st.candles.at(-1);
  const signal = findSignals(st.candles, st.opts).at(-1);
  if (!last || !signal || signal.openTime !== last.openTime) return;

  const { data, error } = await db.from('signals').upsert(
    {
      strategy: st.name,
      pair: PAIR,
      timeframe: st.timeframe,
      candle_open_time: new Date(signal.openTime).toISOString(),
      side: signal.side,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      rsi: signal.rsi,
      ema_fast: signal.emaFast,
      ema_slow: signal.emaSlow,
      confidence: signal.confidence ?? null,
    },
    { onConflict: 'pair,timeframe,candle_open_time', ignoreDuplicates: true },
  ).select('id');
  if (error) return logError('insert signal', st.name, error.message);
  if (!data.length) return; // already saved (e.g. reconnect within the same candle): don't alert twice

  log(`SIGNAL #${data[0].id} ${st.name} ${signal.side} ${PAIR} entry=${signal.entry} sl=${signal.sl.toFixed(2)} tp=${signal.tp.toFixed(2)}`);
  await notify(
    `${signal.side === 'BUY' ? '📈' : '📉'} ${signal.side} ${PAIR}  [${st.name}${signal.confidence ? ` ${signal.confidence}` : ''}]  #${data[0].id}\n` +
      `Entry: ${fmt(signal.entry)}\nSL: ${fmt(signal.sl)}\nTP: ${fmt(signal.tp)}\n(paper signal, not advice)`,
  );
}

/** (Re)load history from REST. Called on every (re)connect so gaps while offline are filled. */
async function loadHistory(st: Strategy) {
  const rows = await klines(PAIR, st.timeframe, undefined, HISTORY + 1);
  st.candles = rows.filter((c) => c.closeTime < Date.now()); // drop the still-forming candle
  log(`${st.name}: loaded ${st.candles.length} closed ${st.timeframe} candles`);
  await evaluateLatest(st);
}

function connect(st: Strategy) {
  const ws = new WebSocket(`${WS_URL}/${PAIR.toLowerCase()}@kline_${st.timeframe}`);

  ws.on('open', () => {
    log(`${st.name}: websocket connected`);
    loadHistory(st).catch((e) => logError('load history', st.name, e));
  });

  ws.on('message', (raw) => {
    const k = JSON.parse(raw.toString()).k;
    if (!k?.x) return; // only act when the candle CLOSES
    const c: Candle = { openTime: k.t, high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) };
    if (st.candles.at(-1)?.openTime === c.openTime) return;
    st.candles = [...st.candles, c].slice(-HISTORY);
    evaluateLatest(st).catch((e) => logError('evaluate', st.name, e));
  });

  ws.on('error', (e) => logError('websocket', st.name, e.message));
  ws.on('close', () => {
    log(`${st.name}: websocket closed, reconnecting in 5s`);
    setTimeout(() => connect(st), 5000);
  });
}

type OpenSignal = { id: number; strategy: string | null; timeframe: string; side: 'BUY' | 'SELL'; entry: number; sl: number; tp: number; candle_open_time: string };

/** Walk 1m candles since the signal's entry; the first SL/TP touch decides it. */
async function resolve(s: OpenSignal) {
  let start = new Date(s.candle_open_time).getTime() + TF_MS[s.timeframe]; // entry = close of the signal candle
  for (;;) {
    const rows = await klines(PAIR, '1m', start);
    for (const c of rows) {
      const result = outcome(s, c.high, c.low);
      if (!result) continue;
      const closePrice = result === 'win' ? s.tp : s.sl;
      const net = netPnl(s.side, s.entry, closePrice) * 100;
      const { data, error } = await db
        .from('signals')
        .update({ status: result, closed_at: new Date(c.openTime).toISOString(), close_price: closePrice, net_pnl_pct: net })
        .eq('id', s.id)
        .eq('status', 'open') // only the first close counts, so the alert is sent once
        .select('id');
      if (error) return logError('close signal', error.message);
      if (!data.length) return;

      log(`CLOSED #${s.id} ${s.strategy} ${result.toUpperCase()} net ${net.toFixed(2)}%`);
      await notify(
        `${result === 'win' ? '✅ WIN' : '❌ LOSS'}  #${s.id} ${s.side} ${PAIR}  [${s.strategy}]\n` +
          `Entry: ${fmt(s.entry)} → ${result === 'win' ? 'TP' : 'SL'} ${fmt(closePrice)}\n` +
          `Net: ${net >= 0 ? '+' : ''}${net.toFixed(2)}% after fees`,
      );
      return;
    }
    if (rows.length < 1000) return; // reached the present, still open
    start = rows.at(-1)!.openTime + 60_000;
  }
}

// Open interest snapshot once per 15-minute slot, for testing an OI filter later on real forward data.
// Binance only keeps ~30 days of OI history, so we record our own. Not used by any strategy.
const OI_SLOT = 15 * 60_000;
let lastOiSlot = 0;
async function logOpenInterest() {
  const slot = Math.floor(Date.now() / OI_SLOT) * OI_SLOT;
  if (slot === lastOiSlot) return;
  const oi = await openInterest(PAIR);
  const { error } = await db
    .from('oi_snapshots')
    .upsert({ pair: PAIR, open_interest: oi.openInterest, ts: new Date(slot).toISOString() }, { onConflict: 'pair,ts', ignoreDuplicates: true });
  if (error) return logError('oi snapshot', error.message); // retried next minute
  lastOiSlot = slot;
}

async function trackOutcomes() {
  logOpenInterest().catch((e) => logError('oi snapshot', e));
  const { error: hbError } = await db.from('bot_status').upsert({ id: 1, last_heartbeat: new Date().toISOString() });
  if (hbError) logError('heartbeat', hbError.message);

  const { data, error } = await db
    .from('signals')
    .select('id, strategy, timeframe, side, entry, sl, tp, candle_open_time')
    .eq('status', 'open')
    .eq('pair', PAIR);
  if (error) return logError('load open signals', error.message);
  for (const s of data) await resolve(s);
}

log(`starting ${PAIR} paper bot (no trading): ${STRATEGIES.map((s) => s.name).join(', ')}`);
for (const st of STRATEGIES) connect(st);
trackOutcomes().catch((e) => logError('tracker', e));
setInterval(() => trackOutcomes().catch((e) => logError('tracker', e)), 60_000);
