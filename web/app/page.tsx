import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type Signal = {
  id: number;
  strategy: string | null;
  pair: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  status: 'open' | 'win' | 'loss';
  created_at: string;
  close_price: number | null;
  net_pnl_pct: number | null;
};

const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

type Row = Pick<Signal, 'strategy' | 'status' | 'net_pnl_pct'>;
function summarize(rows: Row[]) {
  const w = rows.filter((r) => r.status === 'win').length;
  const l = rows.filter((r) => r.status === 'loss').length;
  const closed = rows.filter((r) => r.net_pnl_pct != null);
  return {
    total: rows.length,
    open: rows.length - w - l,
    w,
    l,
    winRate: w + l ? `${((w / (w + l)) * 100).toFixed(1)}%` : '—',
    net: closed.length ? signed(closed.reduce((sum, r) => sum + r.net_pnl_pct!, 0)) : '—',
  };
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const time = (t: string | null | undefined) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }) : '—');

export default async function Page() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const [list, all, status] = await Promise.all([
    db.from('signals').select('*').order('created_at', { ascending: false }).limit(200),
    // shortcut: Supabase returns at most 1000 rows; move the stats into SQL once there are more signals
    db.from('signals').select('strategy, status, net_pnl_pct'),
    db.from('bot_status').select('last_heartbeat').eq('id', 1).maybeSingle(),
  ]);
  const error = list.error ?? all.error ?? status.error;
  const signals = (list.data ?? []) as Signal[];
  const rows = (all.data ?? []) as Row[];
  const heartbeat = status.data?.last_heartbeat as string | undefined;
  const alive = heartbeat && Date.now() - new Date(heartbeat).getTime() < 3 * 60_000;

  const s = summarize(rows);
  const stats = [
    ['Total signals', s.total],
    ['Win rate', s.winRate],
    ['Open', s.open],
    ['W / L', `${s.w} / ${s.l}`],
    ['Net PnL (after fees)', s.net],
  ];
  const strategies = [...new Set(['cross_15m', 'breakout_4h', ...rows.map((r) => r.strategy ?? 'unknown')])];

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-8">
      <meta httpEquiv="refresh" content="30" />
      <h1 className="text-2xl font-semibold">Signal bot — paper testing</h1>
      <p className="mt-1 text-sm text-gray-500">No real trades. Refreshes every 30s. Times in PKT.</p>

      {error && <p className="mt-4 rounded bg-red-50 p-3 text-red-700">Supabase error: {error.message}</p>}

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          Bot: <b className={alive ? 'text-green-600' : 'text-red-600'}>{alive ? 'running' : 'no heartbeat'}</b>
        </span>
        <span>Last heartbeat: {time(heartbeat)}</span>
        <span>Last signal: {time(signals[0]?.created_at)}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <h2 className="mt-6 font-semibold">By strategy</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              {['Strategy', 'Signals', 'Open', 'W / L', 'Win rate', 'Net PnL (after fees)'].map((h) => (
                <th key={h} className="py-2 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strategies.map((name) => {
              const r = summarize(rows.filter((x) => (x.strategy ?? 'unknown') === name));
              return (
                <tr key={name} className="border-b">
                  <td className="py-2 pr-4 font-medium">{name}</td>
                  <td className="pr-4">{r.total}</td>
                  <td className="pr-4">{r.open}</td>
                  <td className="pr-4">{r.w} / {r.l}</td>
                  <td className="pr-4">{r.winRate}</td>
                  <td className="pr-4">{r.net}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 font-semibold">Signals</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              {['Time', 'Strategy', 'Pair', 'Side', 'Entry', 'SL', 'TP', 'Status', 'Net'].map((h) => (
                <th key={h} className="py-2 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2 pr-4 whitespace-nowrap">{time(s.created_at)}</td>
                <td className="pr-4">{s.strategy ?? '—'}</td>
                <td className="pr-4">{s.pair}</td>
                <td className={`pr-4 font-medium ${s.side === 'BUY' ? 'text-green-600' : 'text-red-600'}`}>{s.side}</td>
                <td className="pr-4">{fmt(s.entry)}</td>
                <td className="pr-4">{fmt(s.sl)}</td>
                <td className="pr-4">{fmt(s.tp)}</td>
                <td className="pr-4 capitalize">{s.status}</td>
                <td className={`pr-4 ${s.net_pnl_pct == null ? '' : s.net_pnl_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {s.net_pnl_pct == null ? '—' : signed(s.net_pnl_pct)}
                </td>
              </tr>
            ))}
            {!signals.length && (
              <tr>
                <td colSpan={9} className="py-6 text-center text-gray-500">No signals yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
