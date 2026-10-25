// Binance public market data (no API key). Read-only: this project never places orders.
import type { Candle } from './strategy.js';

export const REST = process.env.BINANCE_REST ?? 'https://api.binance.com';
export const FAPI = process.env.BINANCE_FAPI ?? 'https://fapi.binance.com'; // USDT-M futures: funding rate, open interest

export type Kline = Candle & { closeTime: number; volume: number; takerBuyVolume: number };

async function get<T>(base: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, base);
  url.search = new URLSearchParams(params).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Up to 1000 klines starting at startTime (or the latest 1000). Includes the still-forming candle. */
export async function klines(symbol: string, interval: string, startTime?: number, limit = 1000): Promise<Kline[]> {
  const rows = await get<unknown[][]>(REST, '/api/v3/klines', {
    symbol,
    interval,
    limit: String(limit),
    ...(startTime ? { startTime: String(startTime) } : {}),
  });
  return rows.map((r) => ({
    openTime: Number(r[0]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6]),
    takerBuyVolume: Number(r[9]), // taker buy base asset volume
  }));
}

/** All funding rates (every 8h) from startTime until now, oldest first. */
export async function fundingRates(symbol: string, startTime: number): Promise<{ time: number; rate: number }[]> {
  const all: { time: number; rate: number }[] = [];
  for (let start = startTime; ; ) {
    const rows = await get<{ fundingTime: number; fundingRate: string }[]>(FAPI, '/fapi/v1/fundingRate', {
      symbol,
      startTime: String(start),
      limit: '1000',
    });
    all.push(...rows.map((r) => ({ time: r.fundingTime, rate: Number(r.fundingRate) })));
    if (rows.length < 1000) return all;
    start = rows.at(-1)!.fundingTime + 1;
  }
}

/** Current open interest (in contracts = base asset units). */
export async function openInterest(symbol: string): Promise<{ openInterest: number; time: number }> {
  const r = await get<{ openInterest: string; time: number }>(FAPI, '/fapi/v1/openInterest', { symbol });
  return { openInterest: Number(r.openInterest), time: r.time };
}
