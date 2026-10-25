// Live paper-testing bot: watches closed candles, saves signals to Supabase, marks them win/loss.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { klines } from './binance.js';
import { netPnl } from './sim.js';
import { findSignals, outcome, type Candle } from './strategy.js';

const PAIR = process.env.PAIR ?? 'BTCUSDT';
const TIMEFRAME = '15m';
const HISTORY = 500; // enough candles for the EMAs to settle
const WS_URL = process.env.BINANCE_WS ?? 'wss://stream.binance.com:9443/ws';

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

let candles: Candle[] = [];

/** Run the strategy on the newest closed candle and save a signal if it fires there. */
async function evaluateLatest() {
  const last = candles.at(-1);
  const signal = findSignals(candles).at(-1);
  if (!last || !signal || signal.openTime !== last.openTime) return;

  const { data, error } = await db.from('signals').upsert(
    {
      pair: PAIR,
      timeframe: TIMEFRAME,
      candle_open_time: new Date(signal.openTime).toISOString(),
      side: signal.side,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      rsi: signal.rsi,
      ema_fast: signal.emaFast,
      ema_slow: signal.emaSlow,
    },
    { onConflict: 'pair,timeframe,candle_open_time', ignoreDuplicates: true },
  ).select('id');
  if (error) return logError('insert signal', error.message);
  if (!data.length) return; // already saved (e.g. reconnect within the same candle): don't alert twice

  log(`SIGNAL #${data[0].id} ${signal.side} ${PAIR} entry=${signal.entry} sl=${signal.sl.toFixed(2)} tp=${signal.tp.toFixed(2)}`);
  await notify(
    `${signal.side === 'BUY' ? '📈' : '📉'} ${signal.side} ${PAIR} ${TIMEFRAME}  #${data[0].id}\n` +
      `Entry: ${fmt(signal.entry)}\nSL: ${fmt(signal.sl)}\nTP: ${fmt(signal.tp)}\n(paper signal, not advice)`,
  );
}

/** (Re)load history from REST. Called on every (re)connect so gaps while offline are filled. */
async function loadHistory() {
  const rows = await klines(PAIR, TIMEFRAME, undefined, HISTORY + 1);
  candles = rows.filter((c) => c.closeTime < Date.now()); // drop the still-forming candle
  log(`loaded ${candles.length} closed ${TIMEFRAME} candles`);
  await evaluateLatest();
}

function connect() {
  const ws = new WebSocket(`${WS_URL}/${PAIR.toLowerCase()}@kline_${TIMEFRAME}`);

  ws.on('open', () => {
    log('websocket connected');
    loadHistory().catch((e) => logError('load history', e));
  });

  ws.on('message', (raw) => {
    const k = JSON.parse(raw.toString()).k;
    if (!k?.x) return; // only act when the candle CLOSES
    const c: Candle = { openTime: k.t, high: Number(k.h), low: Number(k.l), close: Number(k.c) };
    if (candles.at(-1)?.openTime === c.openTime) return;
    candles = [...candles, c].slice(-HISTORY);
    evaluateLatest().catch((e) => logError('evaluate', e));
  });

  ws.on('error', (e) => logError('websocket', e.message));
  ws.on('close', () => {
    log('websocket closed, reconnecting in 5s');
    setTimeout(connect, 5000);
  });
}

/** Walk 1m candles since the signal's entry; the first SL/TP touch decides it. */
async function resolve(s: { id: number; side: 'BUY' | 'SELL'; entry: number; sl: number; tp: number; candle_open_time: string }) {
  let start = new Date(s.candle_open_time).getTime() + 15 * 60_000; // entry = close of the signal candle
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

      log(`CLOSED #${s.id} ${result.toUpperCase()} net ${net.toFixed(2)}%`);
      await notify(
        `${result === 'win' ? '✅ WIN' : '❌ LOSS'}  #${s.id} ${s.side} ${PAIR}\n` +
          `Entry: ${fmt(s.entry)} → ${result === 'win' ? 'TP' : 'SL'} ${fmt(closePrice)}\n` +
          `Net: ${net >= 0 ? '+' : ''}${net.toFixed(2)}% after fees`,
      );
      return;
    }
    if (rows.length < 1000) return; // reached the present, still open
    start = rows.at(-1)!.openTime + 60_000;
  }
}

async function trackOutcomes() {
  const { error: hbError } = await db.from('bot_status').upsert({ id: 1, last_heartbeat: new Date().toISOString() });
  if (hbError) logError('heartbeat', hbError.message);

  const { data, error } = await db.from('signals').select('id, side, entry, sl, tp, candle_open_time').eq('status', 'open').eq('pair', PAIR);
  if (error) return logError('load open signals', error.message);
  for (const s of data) await resolve(s);
}

log(`starting ${PAIR} ${TIMEFRAME} paper bot (no trading)`);
connect();
trackOutcomes().catch((e) => logError('tracker', e));
setInterval(() => trackOutcomes().catch((e) => logError('tracker', e)), 60_000);
