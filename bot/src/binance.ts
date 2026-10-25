// Binance public market data (no API key). Read-only: this project never places orders.
import type { Candle } from './strategy.js';

export const REST = process.env.BINANCE_REST ?? 'https://api.binance.com';

/** Up to 1000 klines starting at startTime (or the latest 1000). Includes the still-forming candle. */
export async function klines(symbol: string, interval: string, startTime?: number, limit = 1000): Promise<(Candle & { closeTime: number })[]> {
  const url = new URL('/api/v3/klines', REST);
  url.search = new URLSearchParams({ symbol, interval, limit: String(limit), ...(startTime ? { startTime: String(startTime) } : {}) }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({
    openTime: Number(r[0]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    closeTime: Number(r[6]),
  }));
}
