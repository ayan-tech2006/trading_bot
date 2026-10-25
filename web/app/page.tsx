import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type Signal = {
  id: number;
  pair: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  status: 'open' | 'win' | 'loss';
  created_at: string;
  close_price: number | null;
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const time = (t: string | null | undefined) => (t ? new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }) : '—');

export default async function Page() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const count = (status: string) => db.from('signals').select('*', { count: 'exact', head: true }).eq('status', status);

  const [list, wins, losses, open, status] = await Promise.all([
    db.from('signals').select('*').order('created_at', { ascending: false }).limit(200),
    count('win'),
    count('loss'),
    count('open'),
    db.from('bot_status').select('last_heartbeat').eq('id', 1).maybeSingle(),
  ]);
  const error = list.error ?? wins.error ?? status.error;
  const signals = (list.data ?? []) as Signal[];
  const w = wins.count ?? 0, l = losses.count ?? 0, o = open.count ?? 0;
  const heartbeat = status.data?.last_heartbeat as string | undefined;
  const alive = heartbeat && Date.now() - new Date(heartbeat).getTime() < 3 * 60_000;

  const stats = [
    ['Total signals', w + l + o],
    ['Win rate', w + l ? `${((w / (w + l)) * 100).toFixed(1)}%` : '—'],
    ['Open', o],
    ['W / L', `${w} / ${l}`],
  ];

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

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              {['Time', 'Pair', 'Side', 'Entry', 'SL', 'TP', 'Status'].map((h) => (
                <th key={h} className="py-2 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2 pr-4 whitespace-nowrap">{time(s.created_at)}</td>
                <td className="pr-4">{s.pair}</td>
                <td className={`pr-4 font-medium ${s.side === 'BUY' ? 'text-green-600' : 'text-red-600'}`}>{s.side}</td>
                <td className="pr-4">{fmt(s.entry)}</td>
                <td className="pr-4">{fmt(s.sl)}</td>
                <td className="pr-4">{fmt(s.tp)}</td>
                <td className="pr-4 capitalize">{s.status}</td>
              </tr>
            ))}
            {!signals.length && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-gray-500">No signals yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
