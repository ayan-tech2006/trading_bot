-- Paper-testing signal bot schema. Run once in the Supabase SQL editor.

create table if not exists signals (
  id bigint generated always as identity primary key,
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
  -- one signal per candle, so bot restarts can't create duplicates
  unique (pair, timeframe, candle_open_time)
);

create index if not exists signals_open_idx on signals (status) where status = 'open';

-- single row the bot updates every minute so the dashboard can show it's alive
create table if not exists bot_status (
  id int primary key default 1 check (id = 1),
  last_heartbeat timestamptz
);

-- Anon key (web dashboard) can only read. The bot uses the service role key, which bypasses RLS.
alter table signals enable row level security;
alter table bot_status enable row level security;

drop policy if exists "anon read signals" on signals;
create policy "anon read signals" on signals for select to anon using (true);

drop policy if exists "anon read bot_status" on bot_status;
create policy "anon read bot_status" on bot_status for select to anon using (true);
