-- Paper-testing signal bot schema. Run once in the Supabase SQL editor.

create table if not exists signals (
  id bigint generated always as identity primary key,
  strategy text, -- e.g. cross_15m, breakout_4h
  pair text not null,
  timeframe text not null,
  candle_open_time timestamptz not null,
  side text not null check (side in ('BUY', 'SELL')),
  entry double precision not null,
  sl double precision not null,
  tp double precision not null,
  status text not null default 'open' check (status in ('open', 'win', 'loss')),
  rsi double precision,
  ema_fast double precision,
  ema_slow double precision,
  explanation text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  close_price double precision,
  net_pnl_pct double precision, -- % after 0.1% fee + 0.05% slippage per side, set on close
  -- one signal per candle, so bot restarts can't create duplicates
  unique (pair, timeframe, candle_open_time)
);

-- for projects created before these columns existed
alter table signals add column if not exists net_pnl_pct double precision;
alter table signals add column if not exists strategy text; -- e.g. cross_15m, breakout_4h
update signals set strategy = 'cross_15m' where strategy is null; -- rows from before the column, all from the 15m bot

create index if not exists signals_open_idx on signals (status) where status = 'open';

-- single row the bot updates every minute so the dashboard can show it's alive
create table if not exists bot_status (
  id int primary key default 1 check (id = 1),
  last_heartbeat timestamptz
);

-- BTCUSDT open interest every 15 min (forward data for a future OI filter; Binance keeps only ~30 days)
create table if not exists oi_snapshots (
  id bigint generated always as identity primary key,
  pair text not null,
  open_interest double precision not null, -- contracts = base asset units (BTC)
  ts timestamptz not null, -- start of the 15-minute slot
  unique (pair, ts)
);
alter table oi_snapshots enable row level security;
drop policy if exists "anon read oi_snapshots" on oi_snapshots;
create policy "anon read oi_snapshots" on oi_snapshots for select to anon using (true);

-- Anon key (web dashboard) can only read. The bot uses the service role key, which bypasses RLS.
alter table signals enable row level security;
alter table bot_status enable row level security;

drop policy if exists "anon read signals" on signals;
create policy "anon read signals" on signals for select to anon using (true);

drop policy if exists "anon read bot_status" on bot_status;
create policy "anon read bot_status" on bot_status for select to anon using (true);
